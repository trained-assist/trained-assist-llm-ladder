#!/usr/bin/env node
// fat-session-bench — жирные реальные сессии → разметка по толщине → прогон через лестницу → отчёт.
//
// Зачем: на жирных промптах из изолированного бенча (корпус писем, `fat% = 0 %`) ничего не
// видно. Реальные сессии рекрутинга — это 70K+ токенов и сообщения по 27K символов, и именно
// на них ломаются потолки, таймауты и ранги. Источник (ТЗ: docs/spec-fatness-labeling-and-prompt-sources.md §2Е):
//
//   gs://trained-assist-workspaces/profiles/<профиль>/sessions/*.json.gz
//
// Данные приватные: скрипт кладёт их в ~/.cache, в репозиторий ничего не коммитится,
// содержимое промптов не печатается — только размеры, метки и результаты.
//
// Использование:
//   node scripts/fat-session-bench.mjs --fetch                # скачать сессии
//   node scripts/fat-session-bench.mjs --label                # таблица разметки (ТЗ §5)
//   node scripts/fat-session-bench.mjs --run --limit 10       # прогнать через лестницу
//   node scripts/fat-session-bench.mjs --report               # аналитика по прошлому прогону
//   node scripts/fat-session-bench.mjs --fetch --run --report # всё сразу
//
// Полосы разметки — из ТЗ §1:
//   fat% = (tool + tool_calls + assistant) / все messages
//   <10 тонкий · 10-40 средний · 40-70 толстый · >=70 очень толстый

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
};
const has = (n) => process.argv.includes(`--${n}`);

const PROFILE = arg('profile', 'mbk_luda_recruiter');
const BUCKET = arg('bucket', 'gs://trained-assist-workspaces/profiles');
const GCP_PROJECT = arg('gcp-project', 'alesa-personal-assistent');
const GCP_ACCOUNT = arg('gcp-account', 'maryam12101953@gmail.com'); // kobzevvv не имеет доступа
const CACHE = arg('cache', path.join(os.homedir(), '.cache/llm-ladder-fat-bench', PROFILE));
const LIMIT = Number(arg('limit', 0));            // 0 = все
const BASE = String(arg('base', process.env.LADDER_BASE || 'https://llm-ladder.trainedassist.store')).replace(/\/+$/, '');
const LADDER = arg('ladder', 'service');
// --rung пинует ранг: единственный способ измерить «а что было бы, если бы бесплатного Go не было»
// на проде — конфиг мы не меняем, а пин заставляет лестницу пойти именно туда.
const RUNG = arg('rung', null);
const TOKEN = (process.env.LADDER_TOKEN
  || (() => { try { return fs.readFileSync(path.join(os.homedir(), '.llm-ladder-token'), 'utf8').trim(); } catch { return ''; } })()).trim();

const PREFIX = `${BUCKET}/${PROFILE}/sessions/`;
const gcloud = (...args) => execFileSync('gcloud', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const estTokens = (s) => Math.ceil(String(s).length / 4);

// ------------------------------------------------------------------ fetch
function fetchSessions() {
  fs.mkdirSync(CACHE, { recursive: true });
  // Рекурсивной копией, а не поштучно: 612 файлов по одному вызову — это ~10 минут.
  // gcloud сам распаковывает .gz, поэтому в кеше лежат уже обычные .json.
  const n = gcloud('storage', 'cp', '--recursive', PREFIX, `${CACHE}/`,
    '--project', GCP_PROJECT, '--account', GCP_ACCOUNT);
  const count = fs.readdirSync(CACHE).filter((f) => f.endsWith('.json')).length;
  console.log(`скачано в ${CACHE}: ${count} файлов`);
  return count;
}

// ------------------------------------------------------------------ load + label
function loadSessions() {
  if (!fs.existsSync(CACHE)) return [];
  // gcloud кладёт файлы в подпапку sessions/ и НЕ распаковывает .gz — обходим рекурсивно
  // и распаковываем сами.
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
  const out = [];
  for (const file of walk(CACHE)) {
    const base = path.basename(file);
    if (!/\.json(\.gz)?$/.test(base)) continue;
    let raw;
    try {
      raw = base.endsWith('.gz')
        ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')
        : fs.readFileSync(file, 'utf8');
    } catch { continue; }
    let d;
    try { d = JSON.parse(raw); } catch { continue; }
    const msgs = Array.isArray(d?.messages) ? d.messages : [];
    if (!msgs.length) continue;
    out.push({ id: base.replace(/\.json(\.gz)?$/, ''), session: d, messages: msgs });
  }
  return out;
}

function label(s) {
  const w = {};
  let total = 0;
  for (const m of s.messages) {
    if (!m || typeof m !== 'object') continue;
    const size = JSON.stringify(m).length;
    total += size;
    const role = m.role || '?';
    w[role] = (w[role] || 0) + size;
    if (m.tool_calls) w.tool_calls = (w.tool_calls || 0) + JSON.stringify(m.tool_calls).length;
  }
  const fatParts = (w.tool || 0) + (w.tool_calls || 0) + (w.assistant || 0);
  const fat = total ? fatParts / total : 0;
  const label = fat < 0.10 ? 'тонкий' : fat < 0.40 ? 'средний' : fat < 0.70 ? 'толстый' : 'очень толстый';
  const content = s.messages.map((m) => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? ''))).join('');
  return {
    id: s.id,
    size_bytes: total,
    size_tokens: estTokens(content),
    n_messages: s.messages.length,
    fat_pct: Math.round(fat * 100),
    label,
    roles: Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v])),
  };
}

// ------------------------------------------------------------------ run
async function runOne(session) {
  const body = {
    model: LADDER,
    messages: session.messages,
    max_tokens: 64,
    ladder_timeout_ms: 120_000,
    'x-ladder-app': 'fat-session-bench',
    ...(RUNG ? { ladder_rung: RUNG } : {}),
  };
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(240_000),
    });
    const ms = Date.now() - t0;
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* не-JSON */ }
    if (j && !j.error) {
      return { ok: true, status: res.status, ms, rung: j.model, answer: String(j.choices?.[0]?.message?.content ?? '').slice(0, 60) };
    }
    const ats = (j?.error?.attempts) || [];
    const reasons = ats.map((a) => `${String(a.model || '').split('/').pop()}: ${a.error || a.outcome}`);
    return { ok: false, status: res.status, ms, reasons: reasons.length ? reasons : [String(j?.error?.message || text.slice(0, 140))] };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, reasons: [String(e?.message || e).slice(0, 140)] };
  }
}

// ------------------------------------------------------------------ report
function report(rows) {
  const done = rows.filter((r) => r.result);
  const ok = done.filter((r) => r.result.ok);
  console.log(`\nпрогнано ${rows.length}, ответило ${ok.length} (${rows.length ? Math.round(100 * ok.length / rows.length) : 0} %)`);
  const byLabel = new Map();
  for (const r of rows) {
    const L = r.label.label;
    const e = byLabel.get(L) || { n: 0, ok: 0, ms: [] };
    e.n++;
    if (r.result?.ok) { e.ok++; e.ms.push(r.result.ms); }
    byLabel.set(L, e);
  }
  console.log(`\n  ${'метка'.padEnd(16)} ${'шт'.padStart(4)} ${'успех'.padStart(7)} ${'медиана_мс'.padStart(11)}`);
  for (const [L, e] of [...byLabel.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const med = e.ms.length ? e.ms.sort((a, b) => a - b)[Math.floor(e.ms.length / 2)] : 0;
    console.log(`  ${L.padEnd(16)} ${String(e.n).padStart(4)} ${(String(e.ok) + '/' + e.n).padStart(7)} ${String(med).padStart(11)}`);
  }
  const byRung = new Map();
  for (const r of ok) byRung.set(r.result.rung, (byRung.get(r.result.rung) || 0) + 1);
  console.log('\n  какие ранги ответили:');
  for (const [m, n] of [...byRung.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${m}`);
  const fails = new Map();
  for (const r of rows) if (!r.result?.ok) for (const reason of r.result?.reasons || []) {
    const key = reason.replace(/\d+/g, '#').slice(0, 90);
    fails.set(key, (fails.get(key) || 0) + 1);
  }
  if (fails.size) {
    console.log('\n  почему НЕ ответили:');
    for (const [m, n] of [...fails.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`    ${String(n).padStart(4)}  ${m}`);
  }
}

// ------------------------------------------------------------------ main
async function main() {
  if (has('fetch')) fetchSessions();
  const sessions = loadSessions();
  if (!sessions.length) {
    console.log('сессий нет — запустите --fetch (или проверьте --cache)');
    return;
  }
  const labels = sessions.map((s) => ({ s, label: label(s) }));
  labels.sort((a, b) => b.label.size_bytes - a.label.size_bytes);
  if (LIMIT) labels.length = Math.min(labels.length, LIMIT);

  if (has('label')) {
    console.log('\nразметка (ТЗ §5):');
    console.log(`  ${'id'.padEnd(38)} ${'байт'.padStart(9)} ${'токенов'.padStart(8)} ${'сообщ'.padStart(5)} ${'fat%'.padStart(5)}  метка`);
    for (const { label: l } of labels) {
      console.log(`  ${l.id.slice(0, 38).padEnd(38)} ${String(l.size_bytes).padStart(9)} ${String(l.size_tokens).padStart(8)} ${String(l.n_messages).padStart(5)} ${String(l.fat_pct).padStart(4)}%  ${l.label}`);
    }
    const cnt = {};
    for (const { label: l } of labels) cnt[l.label] = (cnt[l.label] || 0) + 1;
    console.log('\n  по меткам:', cnt);
    return;
  }

  if (has('run')) {
    const results = [];
    for (const { s, label: l } of labels) {
      process.stdout.write(`  ${l.id.slice(0, 34)} ${String(l.size_bytes).padStart(7)}б ${String(l.fat_pct).padStart(3)}% → `);
      const r = await runOne(s);
      results.push({ label: l, result: r });
      console.log(r.ok ? `OK ${r.rung} ${r.ms}мс` : `FAIL ${r.ms}мс ${String(r.reasons?.[0] || '').slice(0, 70)}`);
      // пишем после КАЖДОГО зова: прогон на десятки минут, и прерванный не должен теряться
      const outFile = path.join(CACHE, 'last-run.json');
      fs.writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), profile: PROFILE, results }, null, 2));
    }
    const outFile = path.join(CACHE, 'last-run.json');
    console.log(`результаты: ${outFile}`);
    if (has('report')) report(results);
    return;
  }

  if (has('report')) {
    const outFile = path.join(CACHE, 'last-run.json');
    if (!fs.existsSync(outFile)) { console.log('нет last-run.json — сначала --run'); return; }
    report(JSON.parse(fs.readFileSync(outFile, 'utf8')).results);
    return;
  }

  console.log(`загружено сессий: ${sessions.length}`);
  console.log('флаги: --fetch | --label | --run [--limit N] | --report');
}

main().catch((e) => { console.error(e); process.exit(1); });
