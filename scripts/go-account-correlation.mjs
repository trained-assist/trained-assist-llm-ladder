#!/usr/bin/env node
// Корреляция «одинаковый запрос × разные Go-аккаунты» — задача Владельца (2026-10-07):
// «запустить одновременно с разных go аккаунтов и посмотреть есть ли корреляция, если запрос
// одинаковый большой».
//
// Зачем: лестница крутит бесплатные Go-ранги каруселью (freeGoKeyCursor в src/ladder.js), так что
// одинаковые запросы уходят на РАЗНЫЕ ключи. Если ответ/время зависит от ключа — проблема в
// аккаунте (лимит, регион, состояние), а не в модели. Если не зависит — можно не думать про
// аккаунты и оптимизировать только модель и путь.
//
// Как устроен замер:
//   1. формируется ОДИН промпт нужного размера — все вызовы получают байт-в-байт одинаковый;
//   2. N вызовов уходят ОДНОВРЕМЕННО (Promise.all, без последовательного ожидания) с уникальным
//      x-ladder-trace на каждый — иначе ротация ключа успела бы закончиться между вызовами и
//      «одновременность» оказалась бы последовательностью;
//   3. ключ виден не в ответе, а в трейсе: GET /v1/calls?trace=… → attempts[].key — это единственное
//      место, где проставляется индекс ключа;
//   4. группировка по ключу: успех, p50, p95 — и вывод о наличии корреляции.
//
// pinRung обязателен: с failover'ом один вызов мог бы ответить НЕ longcat'ом, и сравнение шло бы
// уже между разными моделями, а не между аккаунтами.
//
// Выход: markdown + json. Exit 0 — это измерение, не ворота.
//
// Usage:
//   node scripts/go-account-correlation.mjs [--n 12] [--tokens 150] [--runs 1]
//       [--rung opencode-go/longcat-2.5-preview-free] [--ladder build]
//       [--out f.json] [--summary-md f.md]
//
// No dependencies (repo rule). Token: $LLM_LADDER_TOKEN | $LADDER_TOKEN | ~/.llm-ladder-token.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from './zen-client.mjs';

const HOME = os.homedir();
const BASE = (process.env.LADDER_BASE || 'https://llm-ladder.trainedassist.store').replace(/\/+$/, '');

const parsed = parseArgs(process.argv.slice(2), {
  n: 12,
  tokens: 150,
  runs: 1,
  rung: 'opencode-go/longcat-2.5-preview-free',
  ladder: 'build',
  out: 'go-account-correlation.json',
  'summary-md': process.env.GITHUB_STEP_SUMMARY || '',
}, { numeric: ['n', 'tokens', 'runs'] });
if (parsed.problems.length) {
  console.error('bad invocation:\n' + parsed.problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(2);
}
const cfg = parsed.values;

function readToken() {
  for (const c of [process.env.LLM_LADDER_TOKEN, process.env.LADDER_TOKEN]) if (c && c.trim()) return c.trim();
  for (const p of [path.join(HOME, '.llm-ladder-token'), path.join(HOME, 'agent-tokens/llm-ladder/token')]) {
    try { const v = fs.readFileSync(p, 'utf8').trim(); if (v) return v; } catch { /* next */ }
  }
  return null;
}
const token = readToken();
if (!token) { console.error('no token: set $LLM_LADDER_TOKEN or create ~/.llm-ladder-token (chmod 600)'); process.exit(2); }

// Один и тот же промпт для ВСЕХ вызовов — идентичность входа есть условие эксперимента.
// ~4.2 символа на токен (та же калибровка, что в zen-limit-probe / zen-context-curve).
function filler(tokens) {
  const sentence = 'The ladder routes a request to the first model that answers. ';
  const chars = Math.max(32, Math.round(tokens * 4.2));
  return (sentence.repeat(Math.ceil(chars / sentence.length)) + sentence).slice(0, chars);
}

const p50 = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const i = Math.floor(s.length / 2); return s.length % 2 ? s[i] : Math.round((s[i - 1] + s[i]) / 2); };
const sec = (v) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);

const content = filler(cfg.tokens);
const messages = [{ role: 'user', content }];
const stamp = Date.now().toString(36);
const runId = `${cfg.rung.split('/').pop()}-${cfg.tokens}t-${stamp}`;

const rows = [];
for (let run = 0; run < cfg.runs; run++) {
  // Все вызовы одного батча стартуют ДО того, как ждём хоть один ответ: только так это
  // действительно одновременный запуск, а не последовательный с равномерной ротацией.
  const fired = [];
  for (let i = 0; i < cfg.n; i++) {
    const trace = `gocorr-${runId}-${run}-${i}`;
    const t0 = Date.now();
    fired.push(
      fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-ladder-trace': trace,
        },
        body: JSON.stringify({
          model: cfg.ladder, ladder_rung: cfg.rung, messages, max_tokens: 400,
        }),
        signal: AbortSignal.timeout(120_000),
      }).then(async (res) => {
        const data = await res.json().catch(() => null);
        return {
          i, trace, ms: Date.now() - t0,
          ok: res.status === 200 && data?.model === cfg.rung,
          status: res.status,
          error: res.status === 200 ? null : String(data?.error?.attempts?.map((a) => a.error).filter(Boolean).pop() || data?.error?.message || `HTTP ${res.status}`).slice(0, 90),
        };
      }).catch((e) => ({ i, trace, ms: Date.now() - t0, ok: false, status: 0, error: String(e?.message || e).slice(0, 90) })),
    );
  }
  const batch = await Promise.all(fired);

  // Ключ проставляется только в трейсе, не в ответе.
  for (const r of batch) {
    let key = null;
    try {
      const res = await fetch(`${BASE}/v1/calls?trace=${encodeURIComponent(r.trace)}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
      const j = await res.json();
      const call = (j.calls || [])[0];
      key = call?.attempts?.length ? call.attempts[call.attempts.length - 1].key : null;
      r.ladderMs = call?.ms ?? null;
      r.model = call?.model ?? null;
    } catch { /* ключ останется null — это тоже результат */ }
    r.key = key;
    rows.push(r);
  }
  process.stderr.write(`  батч ${run + 1}/${cfg.runs}: ${batch.filter((b) => b.ok).length}/${batch.length} ok, ключей ${new Set(rows.map((r) => r.key)).size}\n`);
}

// ---------------------------------------------------------------- разбор
const byKey = new Map();
for (const r of rows) {
  const k = r.key === null ? 'неизвестен' : `key#${r.key}`;
  if (!byKey.has(k)) byKey.set(k, { n: 0, ok: 0, ms: [] });
  const e = byKey.get(k);
  e.n += 1;
  if (r.ok) { e.ok += 1; e.ms.push(r.ms); }
}
const keys = [...byKey.keys()].sort();
const observed = keys.filter((k) => k !== 'неизвестен');

// Вердикт считаем, а не сочиняем: разница в успехе между ключами при одинаковом входе и есть
// корреляция с аккаунтом.
let verdict;
if (observed.length < 2) {
  verdict = `ключевой разброс не измерен: из ${rows.length} вызовов ключ определён в ${rows.length - (byKey.get('неизвестен')?.n || 0)}, набрано ${observed.length} ключ(а). Повторить с большим --n.`;
} else {
  const rates = observed.map((k) => byKey.get(k).ok / byKey.get(k).n);
  const spread = Math.max(...rates) - Math.min(...rates);
  const totalOk = rows.filter((r) => r.ok).length;
  if (totalOk === 0) {
    // Отдельный случай, который от «нет корреляции» отличать принципиально: упасть могут ВСЕ
    // ключи одинаково — и это значит, что виноват не аккаунт, а модель/апстрим на этом размере.
    verdict = `**корреляции с аккаунтом НЕТ**: упали **все** ${rows.length} вызовов на ${observed.length} ключах одинаково (${rows[0]?.error || 'см. пошагово'}). Одинаковый результат на разных аккаунтах → лимит сидит в модели/апстриме, а не в аккаунте.`;
  } else if (Math.min(...observed.map((k) => byKey.get(k).n)) < 5) {
    // На ключ пришлось <5 вызовов — разброс «0% против 100%» здесь почти всегда шум: один удачный
    // вызов уже даёт 100 п.п. Показываем цифры, но не называем это корреляцией.
    verdict = `пока **не решаемо**: разброс ${(spread * 100).toFixed(0)} п.п., но на ключ пришлось всего ${Math.min(...observed.map((k) => byKey.get(k).n))} выз. — при таком размере выборки один удачный вызов уже выглядит как 100 п.п. Нужен --n побольше (сейчас ${rows.length}).`;
  } else if (spread >= 0.3) {
    verdict = `**корреляция с аккаунтом ЕСТЬ**: разброс успеха между ключами ${(spread * 100).toFixed(0)} п.п. (${rates.map((r) => (r * 100).toFixed(0) + '%').join(' / ')}). Одинаковый вход, разный результат → проблема в аккаунте, а не в модели.`;
  } else {
    verdict = `корреляции с аккаунтом НЕ видно: разброс успеха ${(spread * 100).toFixed(0)} п.п. между ${observed.length} ключами при N=${rows.length}. Одинаковый вход даёт одинаковый результат независимо от аккаунта.`;
  }
}

const md = [
  `## 🔑 Корреляция ответа с Go-аккаунтом`,
  '',
  `ранг: \`${cfg.rung}\` · лестница: \`${cfg.ladder}\` · промпт: **${cfg.tokens} токенов** (${Math.round(cfg.tokens * 4.2)} симв.) · одновременно: **${cfg.n}** · батчей: ${cfg.runs} · вызовов: ${rows.length}`,
  '',
  'Все вызовы батча стартовали до первого ответа — это одновременный запуск, а не последовательный.',
  '',
  '| ключ | вызовов | успех | p50 | p95 |',
  '|---|---:|---:|---:|---:|',
  ...keys.map((k) => {
    const e = byKey.get(k);
    return `| \`${k}\` | ${e.n} | ${e.ok}/${e.n} (${((e.ok / e.n) * 100).toFixed(0)}%) | ${sec(p50(e.ms))} | ${e.ms.length ? sec(Math.max(...e.ms)) : '—'} |`;
  }),
  '',
  `**Вывод:** ${verdict}`,
  '',
  '### Пошагово',
  '',
  '| # | ключ | ok | время | ошибка |',
  '|---:|---|---|---:|---|',
  ...rows.map((r) => `| ${r.i} | \`${r.key === null ? '?' : 'key#' + r.key}\` | ${r.ok ? '✅' : '❌'} | ${sec(r.ms)} | ${r.error || '—'} |`),
  '',
].join('\n');

fs.writeFileSync(cfg.out, JSON.stringify({ generatedAt: new Date().toISOString(), config: cfg, rows, byKey: Object.fromEntries(byKey), verdict }, null, 1));
if (cfg['summary-md']) fs.appendFileSync(cfg['summary-md'], md + '\n');
console.log(md);
console.log(`\nreport: ${cfg.out}`);
