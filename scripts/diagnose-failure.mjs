#!/usr/bin/env node
// diagnose-failure.mjs — локальный разбор отказов лестницы: ГДЕ переполнение и ЧЕГО именно
// переполнение. Тянет строки `ladder_calls` из D1 трассы (читает только, ничего не пишет) и
// раскладывает каждый отказ по ступеням: у каждой — свой лимит, своя причина и своё число.
//
//   npm run diagnose                      # отказы за последний час
//   npm run diagnose -- --since 24h       # за сутки
//   npm run diagnose -- --trace <id>      # один вызов целиком
//   npm run diagnose -- --session <id>    # все вызовы одной сессии
//   npm run diagnose -- --ladder build --limit 50
//   npm run diagnose -- --json            # машинный вывод
//
// Доступ к D1: сам находит базу через `wrangler d1 list` и кэширует конфиг в
// ~/.cache/llm-ladder/trace-wrangler.toml (перетирается, если база пересоздана).
// Переопределение: LADDER_TRACE_CONFIG=/path/to/wrangler.toml.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DB_NAME = 'trained-assist-llm-ladder-trace';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(os.homedir(), '.cache', 'llm-ladder', 'trace-wrangler.toml');

// ─────────────────────────── доступ к D1 ───────────────────────────

// OAuth-сессия wrangler живёт ~1 час и иногда отваливается ДО expiration_time — тогда wrangler
// печатает `Authentication error [code: 10000]` / `Invalid access token [code: 9109]` и никак не
// говорит, что делать. Экспортируется, чтобы это лежало в тестах, а не в памяти.
export function authHint(raw) {
  const t = String(raw || '');
  if (/Authentication error|Invalid access token|code: 9109|code: 10000/i.test(t)) {
    return 'Авторизация Cloudflare истекла. Выполните `npx wrangler login` и повторите `npm run diagnose`.';
  }
  return null;
}

function wrangler(args) {
  try {
    return execFileSync('npx', ['--yes', 'wrangler', ...args], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    const raw = String(e.stdout || e.stderr || e.message || '');
    const hint = authHint(raw);
    if (hint) throw new Error(hint);
    // wrangler кладёт настоящую причину в notes[].text (например SQLITE_ERROR), а не в message.
    const notes = [...raw.matchAll(/"text":\s*"([^"]+)"/g)].map((m) => m[1]).filter(Boolean);
    const reason = notes.find((t) => !/^A request to the Cloudflare API/.test(t)) || notes[0];
    const err = new Error(reason || raw.trim().split('\n').slice(-6).join('\n'));
    err.transient = /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|10001/i.test(raw);
    throw err;
  }
}

function makeConfig() {
  const dbs = JSON.parse(wrangler(['d1', 'list', '--json']));
  const db = dbs.find((d) => d.name === DB_NAME);
  if (!db) throw new Error(`база ${DB_NAME} не найдена в \`wrangler d1 list\``);
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, [
    'name = "ladder-trace-cli"', 'compatibility_date = "2025-09-01"', '',
    '[[d1_databases]]', 'binding = "LADDER_TRACE_DB"',
    `database_name = "${DB_NAME}"`, `database_id = "${db.uuid}"`, '',
  ].join('\n'));
  return CACHE;
}

function resolveConfig() {
  if (process.env.LADDER_TRACE_CONFIG) return process.env.LADDER_TRACE_CONFIG;
  if (fs.existsSync(CACHE)) return CACHE;
  return makeConfig();
}

/** Один запрос к трассе. Пустой кэш конфига (базу пересоздали) → перестроить и повторить раз. */
function d1(sql, retry = true) {
  const cfg = resolveConfig();
  let out;
  try {
    out = wrangler(['d1', 'execute', DB_NAME, '--config', cfg, '--remote', '--json', '--command', sql]);
  } catch (e) {
    // Базу пересоздали → перестроить кэш конфига; сетевой сбой → один повтор.
    if (retry && /not found|unknown database|No such database/i.test(String(e.message))) {
      fs.rmSync(CACHE, { force: true });
      return d1(sql, false);
    }
    if (retry && e.transient) return d1(sql, false);
    throw e;
  }
  const start = out.indexOf('[');
  if (start < 0) return [];
  try { return JSON.parse(out.slice(start))?.[0]?.results ?? []; } catch { return []; }
}

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

// ─────────────────────────── разбор попыток ───────────────────────────

// Коды — это и есть ответ на «чего переполнение»: каждый несёт своё число и свой лимит.
const CODES = {
  SIZE_BYTES: 'ПЕРЕПОЛНЕНИЕ ПО БАЙТАМ',
  TOKEN_CEILING: 'ПОТОЛОК РАНГА',
  CONTEXT: 'ПЕРЕПОЛНЕНИЕ КОНТЕКСТА МОДЕЛИ',
  NO_CREDITS: 'НЕТ КРЕДИТОВ',
  RATE: 'RATE LIMIT',
  KEY: 'КЛЮЧ',
  TIMEOUT: 'ТАЙМАУТ',
  RING: 'КОЛЬЦО ЗЕНА',
  GUARD: 'ПУСТОЙ/НЕ-JSON ОТВЕТ',
  CONFIG: 'ОТКАЗ КОНФИГУРАЦИИ',
  OTHER: 'ПРОЧЕЕ',
};

/**
 * Одна попытка ступени → { code, fact, ru }.
 * `fact` — измеримое число из самой ошибки (байты/токены/код), лимит не выдумываем:
 * в сообщениях отказа шлюз и кольцо сами печатают свой предел.
 */
export function classify(a) {
  const e = String(a.error || '');
  const outcome = String(a.outcome || '');

  let m = /input is too long for the free tier: (\d+) bytes, limit (\d+)/.exec(e);
  if (m) return { code: 'SIZE_BYTES', fact: `${fmt(+m[1])} байт > ${fmt(+m[2])} байт` };

  m = /input ~(\d+)t above the rung ceiling/.exec(e);
  if (m) return { code: 'TOKEN_CEILING', fact: `~${fmt(+m[1])} токенов > потолок` };

  m = /maximum context length is (\d+) tokens.*?about (\d+) tokens/.exec(e.replace(/\\"/g, '"'));
  if (m) return { code: 'CONTEXT', fact: `запрошено ${fmt(+m[2])} > контекст ${fmt(+m[1])}` };

  if (/402|Insufficient credits/i.test(e)) return { code: 'NO_CREDITS', fact: 'HTTP 402' };
  if (/429|rate-?limited|temporarily rate-limited/i.test(e)) return { code: 'RATE', fact: 'HTTP 429' };
  if (/watchdog fired|timed out|timeout|TTFB/i.test(e)) return { code: 'TIMEOUT', fact: 'таймаут' };
  if (/pool_backlog|no warm runner|cold boot|queue_not_empty/i.test(e)) return { code: 'RING', fact: 'нет свободного раннера' };
  if (/empty content|non-JSON|guard/i.test(e)) return { code: 'GUARD', fact: 'пустой ответ' };
  if (/401|invalid.*key|rejected key|unauthorized/i.test(e)) return { code: 'KEY', fact: 'HTTP 401' };
  if (/above the rung ceiling|HTTP 400/i.test(e)) return { code: 'CONFIG', fact: 'HTTP 400' };
  if (outcome === 'skipped' && e.includes('time budget spent')) return { code: 'TIMEOUT', fact: 'бюджет вызова израсходован' };
  return { code: 'OTHER', fact: e.slice(0, 120) || outcome || 'без причины' };
}

const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** payload из всех попыток одного вызова: байты и токены, где их назначает сама лестница. */
export function payloadFacts(attempts) {
  let bytes = 0, tokens = 0, requested = 0;
  for (const a of attempts || []) {
    const e = String(a.error || '').replace(/\\"/g, '"');
    let m = /(\d+) bytes, limit/.exec(e); if (m) bytes = Math.max(bytes, +m[1]);
    m = /input ~(\d+)t above/.exec(e); if (m) tokens = Math.max(tokens, +m[1]);
    m = /about (\d+) tokens/.exec(e); if (m) requested = Math.max(requested, +m[1]);
  }
  return { bytes, tokens, requested };
}

// ─────────────────────────── запросы ───────────────────────────

function parseSince(s) {
  const m = /^(\d+)\s*([mhd]?)$/i.exec(String(s || '60m'));
  if (!m) throw new Error(`--since понимает 30m / 12h / 7d, получено: ${s}`);
  const n = +m[1], unit = (m[2] || 'm').toLowerCase();
  return n * (unit === 'd' ? 86400 : unit === 'h' ? 3600 : 60) * 1000;
}

const parseArgs = (argv) => {
  const o = { since: '60m', limit: 20, json: false, ok: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--since') { o.since = v; i++; }
    else if (k === '--limit') { o.limit = +v; i++; }
    else if (k === '--trace') { o.trace = v; i++; }
    else if (k === '--session') { o.session = v; i++; }
    else if (k === '--ladder') { o.ladder = v; i++; }
    else if (k === '--json') o.json = true;
    else if (k === '--ok') o.ok = true;
    else if (k === '-h' || k === '--help') o.help = true;
    else throw new Error(`неизвестный флаг: ${k}`);
  }
  return o;
};

function configuredRungs(ladder) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'ladders.json'), 'utf8'));
    const entry = cfg.ladders?.[ladder];
    // Значение лестницы — объект вида {"build": [ … ]} (по нему же читает сам роутер),
    // но плоский массив в конфиге тоже не ругаемся.
    if (Array.isArray(entry)) return entry;
    if (entry && typeof entry === 'object') return Object.values(entry).find(Array.isArray) || [];
    return [];
  } catch { return []; }
}

/** Ступени, которых НЕ было в обходе: их health-skipped выкинул до старта. */
function skippedRungs(ladder, attempted) {
  const all = configuredRungs(ladder);
  const set = new Set(attempted);
  return all.filter((m) => !set.has(m));
}

// История одной лестницы за сутки — ОДИН запрос на лестницу на весь прогон. Тянем строки и
// ищем нужные ступени в JS: SQL LIKE по attempts в D1 падает с SQLITE_ERROR «LIKE or GLOB
// pattern too complex» на некоторых именах моделей, а точность здесь нужна именно по model.
const historyCache = new Map();

function ladderHistory(ladder) {
  if (historyCache.has(ladder)) return historyCache.get(ladder);
  const rows = d1(`SELECT ts, attempts FROM ladder_calls WHERE ladder = ${q(ladder)}
                   AND ts > ${Date.now() - 86400000} ORDER BY ts DESC LIMIT 200`);
  const byModel = new Map(); // model → { last, lastFail } — строки приходят DESC, первая и есть самая свежая
  for (const r of rows) {
    let ats; try { ats = JSON.parse(r.attempts || '[]'); } catch { continue; }
    for (const a of ats) {
      if (!a?.model) continue;
      let m = byModel.get(a.model);
      if (!m) { m = { last: null, lastFail: null }; byModel.set(a.model, m); }
      if (!m.last) m.last = { ts: r.ts, ...a };
      if (!m.lastFail && a.outcome !== 'ok') m.lastFail = { ts: r.ts, ...a };
    }
  }
  historyCache.set(ladder, byModel);
  return byModel;
}

/** Почему ступень не попала в обход: её последний ОТКАЗ за сутки (успешная попытка не считается). */
function lastReason(ladder, model) {
  return ladderHistory(ladder).get(model) || null;
}

// ─────────────────────────── вывод ───────────────────────────

function report(row, { withSkip = true } = {}) {
  const attempts = JSON.parse(row.attempts || '[]');
  const p = payloadFacts(attempts);
  const at = new Date(row.ts);
  const head = `${at.toISOString().slice(0, 19).replace('T', ' ')}  ladder=${row.ladder}  ${row.ms} мс`
    + (row.trace_id ? `  trace=${row.trace_id}` : '');

  const lines = [`\n${'─'.repeat(Math.min(110, head.length))}\n${head}`];
  const bits = [];
  if (p.bytes) bits.push(`payload ${fmt(p.bytes)} байт`);
  if (p.tokens) bits.push(`~${fmt(p.tokens)} токенов`);
  if (!p.bytes && !p.tokens) bits.push('payload не назван в причинах');
  if (row.app) bits.push(`app=${row.app}`);
  if (row.session_id) bits.push(`session=${row.session_id}`);
  lines.push(`  ${bits.join('  ·  ')}`);

  const summary = new Map();
  for (const a of attempts) {
    const { code, fact } = classify(a);
    summary.set(code, (summary.get(code) || 0) + 1);
    const mark = a.outcome === 'ok' ? '✅' : a.outcome === 'skipped' ? '⏭' : '⛔';
    const who = String(a.model || '?').split('/').slice(-1)[0];
    lines.push(`  ${mark} ${who.padEnd(38)} ${CODES[code].padEnd(30)} ${fact}`);
    if (a.outcome !== 'ok' && code === 'OTHER') lines.push(`     ↳ ${String(a.error || '').slice(0, 200)}`);
  }

  if (withSkip) {
    const missing = skippedRungs(row.ladder, attempts.map((a) => a.model));
    for (const m of missing) {
      const h = lastReason(row.ladder, m);
      const who = m.split('/').slice(-1)[0];
      const suffix = h?.lastFail
        ? (() => { const { code, fact } = classify(h.lastFail); return `${CODES[code]}: ${fact}`; })()
        : h?.last
          ? 'последняя попытка успешна — причину skip искать раньше (200 строк не хватило)'
          : 'за 24 ч ни одной попытки';
      lines.push(`  ⏭  ${who.padEnd(38)} ВНЕ ОБХОДА (health-skip)  ↳ ${suffix}`);
    }
  }

  const onlySize = [...summary.keys()].every((c) => ['SIZE_BYTES', 'TOKEN_CEILING', 'CONTEXT', 'CONFIG'].includes(c));
  if (onlySize) {
    const size = p.requested || p.tokens;
    lines.push(`  ⟹ ПЕРЕПОЛНЕНИЕ: ${size ? `${fmt(size)} токенов` : 'payload'} — ни одна ступень не влезает.
      Это не поломка лестницы: вызывающий обязан чанковать/компактить промпт (см.
      docs/spec-chunking-fat-prompts-for-free-tiers.md).`);
  } else if (summary.get('NO_CREDITS')) {
    lines.push('  ⟹ МЁРТВЫЙ ХВОСТ: платные ступени OpenRouter без кредитов (HTTP 402) — бесплатные должны покрывать.');
  } else if (summary.get('SIZE_BYTES') || summary.get('TOKEN_CEILING')) {
    lines.push('  ⟹ СМЕШАННЫЙ ОТКАЗ: payload переполняет бесплатные ступени, а оставшиеся упали по своей причине.');
  }
  return { head, lines, summary, payload: p };
}

function printSummary(results) {
  const agg = new Map();
  for (const r of results) for (const [c, n] of r.summary) agg.set(c, (agg.get(c) || 0) + n);
  if (!agg.size) return;
  console.log(`\n${'═'.repeat(60)}\nИТОГО по ${results.length} отказ(ам):`);
  for (const [c, n] of [...agg].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${CODES[c].padEnd(32)} ${String(n).padStart(5)} попыток`);
  }
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log('Usage: node scripts/diagnose-failure.mjs [--since 60m|12h|7d] [--limit 20]'
      + ' [--trace ID] [--session ID] [--ladder NAME] [--ok] [--json]');
    return;
  }
  const since = parseSince(o.since);
  const where = [`ts > ${since}`, ...(o.ok ? [] : ['ok = 0'])];
  if (o.trace) where.push(`trace_id = ${q(o.trace)}`);
  if (o.session) where.push(`session_id = ${q(o.session)}`);
  if (o.ladder) where.push(`ladder = ${q(o.ladder)}`);
  const rows = d1(`SELECT ts, trace_id, run_id, session_id, ladder, ok, model, ms, attempts, app
                   FROM ladder_calls WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ${o.limit | 0}`);
  if (!rows.length) { console.log('отказов за выбранный период нет'); return; }

  const results = rows.map((r) => report(r));
  if (o.json) {
    console.log(JSON.stringify(rows.map((r, i) => ({
      ts: r.ts, ladder: r.ladder, ok: r.ok, ms: r.ms, trace: r.trace_id, app: r.app,
      payload: results[i].payload,
      attempts: JSON.parse(r.attempts || '[]').map((a) => ({ model: a.model, outcome: a.outcome, ...classify(a) })),
    })), null, 2));
    return;
  }
  for (const r of results) r.lines.forEach((l) => console.log(l));
  printSummary(results);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(String(e.message || e)); process.exit(1); }
}
