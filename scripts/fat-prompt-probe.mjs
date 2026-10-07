#!/usr/bin/env node
// Жирный РЕАЛЬНЫЙ промпт → скольких модели его переваривают. Задача Владельца (2026-10-07):
// «сделай расчёт для 600-900K токенов, нужно четырём моделям которые поддерживают, по 7 раз
// отправить жирный промпт отсюда и посмотреть проценты успеха».
//
// Промпт НЕ синтетический: собран из нашей же сессии opencode (ses_eef35af…), 139 сообщений,
// 4 597 887 байт ≈ 865 892 токенов — то есть реальная форма запроса: system+история, вызовы
// инструментов (67 % объёма), рассуждения, обмен с пользователем. Синтетический филлер из
// zen-context-curve не воспроизводит ни структуру, ни разметку — он меряет размер, а не сложность.
//
// Капаситы взяты из CONTEXT (scripts/zen-client.mjs), измеренных --fill-tokens:
//   mimo-v2.6-flash-free  1 048 576   nemotron-3.5-lightning-free 1 000 000
//   mimo-v2.5-free        1 048 576   exo-free                    1 000 000
// big-pickle (262 139) в выборку не попадает — под 600-900K он заведомо не влезает.
//
// Выход: % успеха и p50 на модель; JSON инкрементально (прогон можно оборвать).
// Exit 0 — измерение, не ворота.
//
// Usage:
//   node fat-prompt-probe.mjs [--runs 7] [--messages path.json] [--models a,b,c] [--out f.json]
//                             [--summary-md f.md]
//
// No dependencies (repo rule). Token не нужен: tier анонимный.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, createZenClient } from './zen-client.mjs';

const HOME = os.homedir();
const DEFAULT_MESSAGES = path.join(HOME, 'Documents/zen-context-research/fat-prompt-from-our-chat.json');
const DEFAULT_MODELS = 'mimo-v2.6-flash-free,mimo-v2.5-free,nemotron-3.5-lightning-free,exo-free';

const parsed = parseArgs(process.argv.slice(2), {
  runs: 7,
  messages: DEFAULT_MESSAGES,
  models: DEFAULT_MODELS,
  out: 'fat-prompt-probe.json',
  'summary-md': process.env.GITHUB_STEP_SUMMARY || '',
}, { numeric: ['runs'] });
if (parsed.problems.length) {
  console.error('bad invocation:\n' + parsed.problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(2);
}
const cfg = parsed.values;

let messages;
try {
  messages = JSON.parse(fs.readFileSync(cfg.messages, 'utf8'));
} catch (e) { console.error(`не прочитать промпт ${cfg.messages}: ${e.message}`); process.exit(2); }

const bytes = JSON.stringify(messages).length;
const tokens = Math.round(bytes / 5.31); // калибровка этой сессии: 4.86 МБ ↔ 915.8K токенов
const models = String(cfg.models).split(',').map((s) => s.trim()).filter(Boolean);

// Свежий egress на каждый прогон не нужен — важен сам факт ответа, а не бюджет лимита.
const zen = createZenClient({ ratePerMin: 40, dailyBudget: 900 });
const p50 = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const i = Math.floor(s.length / 2); return s.length % 2 ? s[i] : Math.round((s[i - 1] + s[i]) / 2); };
const sec = (v) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);

function load() {
  try { return JSON.parse(fs.readFileSync(cfg.out, 'utf8')); } catch { return { cells: {} }; }
}
const out = load();
out.messages = cfg.messages;
out.bytes = bytes;
out.tokens = tokens;
out.runs = cfg.runs;
out.generatedAt = new Date().toISOString();
const save = () => fs.writeFileSync(cfg.out, JSON.stringify(out, null, 1));

console.error(`промпт: ${cfg.messages}`);
console.error(`размер: ${bytes.toLocaleString('ru-RU')} байт ≈ ${tokens.toLocaleString('ru-RU')} токенов`);
console.error(`моделей: ${models.length}  прогонов на каждую: ${cfg.runs}  всего вызовов: ${models.length * cfg.runs}\n`);

for (const model of models) {
  if (out.cells[model]) { console.error(`  ${model} — уже измерена, пропуск`); continue; }
  const ms = []; const kinds = {}; let limited = 0;
  for (let i = 0; i < cfg.runs; i++) {
    const t0 = Date.now();
    const res = await zen.chat({ model, messages, maxTokens: 300 });
    const took = Date.now() - t0;
    if (res.ok) { ms.push(took); continue; }
    // Лимит нашего клиента — не показатель модели
    if (res.kind === 'cooldown' || res.kind === 'daily' || res.kind === 'rate') { limited += 1; continue; }
    kinds[res.kind || 'error'] = (kinds[res.kind || 'error'] || 0) + 1;
    if (res.kind === 'fingerprint') break; // дальше бессмысленно
  }
  const runs = cfg.runs - limited;
  out.cells[model] = { model, runs, requested: cfg.runs, limited, ok: ms.length,
    pct: runs > 0 ? ms.length / runs * 100 : null, p50: p50(ms), ms, kinds };
  save();
  const c = out.cells[model];
  console.error(`  ${model.padEnd(34)} ${String(c.ok).padStart(2)}/${runs} = ${c.pct == null ? 'н/и' : c.pct.toFixed(0) + '%'}  p50=${sec(c.p50)}${Object.keys(kinds).length ? '  ' + JSON.stringify(kinds) : ''}${limited ? `  (лимитов: ${limited})` : ''}`);
}

const cells = Object.values(out.cells);
const md = [
  `## 🧱 Жирный реальный промпт — переваривают ли модели`,
  '',
  `промпт из нашей сессии opencode · **${bytes.toLocaleString('ru-RU')} байт ≈ ${tokens.toLocaleString('ru-RU')} токенов** · прогонов на модель: ${cfg.runs}`,
  '',
  '| модель | капасит | успех | % | p50 | причины отказов |',
  '|---|---:|---:|---:|---:|---|',
  ...cells.map((c) => {
    const cap = { 'mimo-v2.6-flash-free': '1 048 576', 'mimo-v2.5-free': '1 048 576', 'nemotron-3.5-lightning-free': '1 000 000', 'exo-free': '1 000 000' }[c.model] || '—';
    return `| \`${c.model}\` | ${cap} | ${c.ok}/${c.runs} | ${c.pct == null ? '—' : c.pct.toFixed(0) + '%'} | ${sec(c.p50)} | ${Object.keys(c.kinds).length ? JSON.stringify(c.kinds) : '—'} |`;
  }),
  '',
  '_«успех» = модель вернула содержательный ответ. Отказ по лимиту нашего клиента не считается отказом модели и вычитается из знаменателя._',
].join('\n');

fs.writeFileSync(cfg.out, JSON.stringify(out, null, 1));
if (cfg['summary-md']) fs.appendFileSync(cfg['summary-md'], md + '\n');
console.log(md);
console.log(`\nreport: ${cfg.out}`);
