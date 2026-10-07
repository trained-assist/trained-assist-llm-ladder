#!/usr/bin/env node
// Zen free — кривая «время ответа» и «% успеха» в зависимости от размера контекста.
//
// Задача Владельца (2026-10-07): «по каждой бесплатной zen модели построить зависимость времени
// и процента успеха от размера контекста», результат — разложить ПО КОРЗИНАМ.
//
// Путь вызова: напрямую в zen подписанным клиентом (scripts/zen-client.mjs), а не через лестницу.
// Причина: нас интересует модель, а не наш путь до неё; лестница вдобавок обрезает вход свыше
// 50 КБ (ZEN_MAX_INPUT_BYTES), поэтому через неё верхние корзины вообще не измеряются.
//
// Корзина = размер промпта в ТОКЕНАХ. Промпт собирается повтором одного предложения, ~4.2 символа
// на токен — та же калибровка, что в scripts/zen-limit-probe.mjs.
//
// Почему инкрементально: полный прогон — 15 моделей × 9 корзин × 10 вызовов = 1350 запросов и
// порядка часа. JSON переписывается после каждой ячейки, поэтому прогон можно оборвать и
// продолжить: уже измеренные ячейки пропускаются.
//
// Мёртвая модель (0 успехов в САМОЙ ПЕРВОЙ корзине) не гоняется по остальным — её кривая была бы
// плоским нулём, а9 корзин × 10 вызовов на каждый труп это90 лишних запросов. Флаг
// --no-skip-dead снимает это ограничение.
//
// Выход:
//   *.json   — сырые ячейки, инкрементальный
//   *.md     — две таблицы: % успеха и p50, строки = корзины, столбцы = модели
//
// Exit: 0 всегда — это измерение, а не ворота.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createZenClient, parseArgs } from './zen-client.mjs';

const HOME = os.homedir();
const ZEN_MODELS_URL = 'https://opencode.ai/zen/v1/models';
const FREE_SUFFIX = /-free$/;
const FREE_EXTRA = ['big-pickle'];

// Корзины в ТОКЕНАХ: «до 1K … 125–250K» — Владелец просил «по всем корзинам до 250».
const DEFAULT_BUCKETS = '1000,2000,4000,7000,15000,30000,60000,125000,250000';
const DEFAULT_LABELS = ['<1K', '1-2K', '2-4K', '4-7K', '7-15K', '15-30K', '30-60K', '60-125K', '125-250K'];

const parsed = parseArgs(process.argv.slice(2), {
  runs: 10,
  buckets: DEFAULT_BUCKETS,
  models: '',
  out: 'zen-context-curve.json',
  'summary-md': process.env.GITHUB_STEP_SUMMARY || '',
  'no-skip-dead': false,
  'delay-ms': 500,
}, { numeric: ['runs', 'delay-ms'] });
if (parsed.problems.length) {
  console.error('bad invocation:\n' + parsed.problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(2);
}
const cfg = parsed.values;

// Порядок берётся как задан: Владелец просит идти ОТ БОЛЬШИХ к малым — на малых отвечают
// все (включая платные), а информация только в больших корзинах.
const buckets = String(cfg.buckets).split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
// Подпись по ЗНАЧЕНИЮ корзины, а не по индексу: порядок корзин задаётся снаружи, и при
// обратном порядке (сначала большие — они и дают единственную информацию) индексные подписи
// поехали бы.
const LABEL_BY_VALUE = Object.fromEntries(DEFAULT_BUCKETS.split(',').map((b, i) => [Number(b), DEFAULT_LABELS[i]]));
const labelOf = (b) => LABEL_BY_VALUE[b] ?? `${Math.round(b / 1000)}K`;
const labels = buckets.map(labelOf);
if (!buckets.length) { console.error('no buckets'); process.exit(2); }

// ~4.2 символа на токен — калибровка zen-limit-probe.mjs против usage.prompt_tokens.
function filler(tokens) {
  const sentence = 'The ladder routes a request to the first model that answers. ';
  const chars = Math.round(tokens * 4.2);
  return (sentence.repeat(Math.ceil(chars / sentence.length)) + sentence).slice(0, chars);
}
const p50 = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const i = Math.floor(s.length / 2); return s.length % 2 ? s[i] : Math.round((s[i - 1] + s[i]) / 2); };
const sec = (v) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);

// ---------------------------------------------------------------- модели
async function discover() {
  const res = await fetch(ZEN_MODELS_URL, { headers: { 'user-agent': 'opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14' } });
  if (!res.ok) throw new Error(`GET /v1/models → ${res.status}`);
  const j = await res.json();
  return (j.data || []).map((m) => m.id).filter((id) => FREE_SUFFIX.test(id) || FREE_EXTRA.includes(id)).sort();
}
const models = cfg.models
  ? String(cfg.models).split(',').map((s) => s.trim()).filter(Boolean)
  : await discover();
if (!models.length) { console.error('no models discovered — pass --models'); process.exit(2); }

// ---------------------------------------------------------------- состояние (возобновляемо)
function load(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { cells: {}, models, buckets, labels, runs: cfg.runs }; }
}
const out = load(cfg.out);
out.models = models; out.buckets = buckets; out.labels = labels; out.runs = cfg.runs;
out.generatedAt = new Date().toISOString();
const save = () => fs.writeFileSync(cfg.out, JSON.stringify(out, null, 1));
const key = (m, b) => `${m}|${b}`;

// 50/мин — с запасом под измеренный лимит zen ~90–95/мин, иначе 10 быстрых вызовов подряд
// упираются в 429, и он попадает в данные как «модель не ответила», хотя виноват наш темп.
const zen = createZenClient({ ratePerMin: 50, dailyBudget: 800 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DELAY = Number(cfg['delay-ms']) || 0;
const dead = new Set();

console.error(`корзин: ${buckets.length}  моделей: ${models.length}  прогонов на ячейку: ${cfg.runs}`);
console.error(`ожидаемо запросов: ${buckets.length * models.length * cfg.runs}\n`);

// Корзина снаружи — так каждая модель получает 10 вызовов на корзину и не упирается в rate-limit.
for (let bi = 0; bi < buckets.length; bi++) {
  const tokens = buckets[bi];
  const content = filler(tokens);
  const messages = [{ role: 'user', content }];

  for (const model of models) {
    if (dead.has(model)) continue;
    const k = key(model, tokens);
    if (out.cells[k]) continue;

    const ms = [];
    const kinds = {};
    for (let r = 0; r < cfg.runs; r++) {
      const t0 = Date.now();
      const res = await zen.chat({ model, messages, maxTokens: 300 });
      const took = Date.now() - t0;
      if (res.ok) { ms.push(took); }
      else { kinds[res.kind || 'error'] = (kinds[res.kind || 'error'] || 0) + 1; }
      if (DELAY && r + 1 < cfg.runs) await sleep(DELAY);
    }
    const ok = ms.length;
    out.cells[k] = { model, tokens, runs: cfg.runs, ok, pct: ok / cfg.runs * 100, p50: p50(ms), ms, kinds };
    save();

    // 0 во первой корзине = модель мертва, кривая дальше бессмысленна
    if (!ok && bi === 0 && !cfg['no-skip-dead']) { dead.add(model); out.dead = [...dead]; save(); }

    process.stderr.write(
      `  [${String(bi + 1).padStart(2)}/${buckets.length}] ${model.padEnd(32)} ${labels[bi].padEnd(9)} `
      + `${String(ok).padStart(2)}/${cfg.runs} ${ok ? `p50=${sec(p50(ms))}` : 'МЕРТВА'}`
      + `${Object.keys(kinds).length ? ` (${Object.entries(kinds).map(([n, c]) => `${n}×${c}`).join(', ')})` : ''}\n`,
    );
  }
  if (dead.size) console.error(`             мёртвые (пропущены): ${[...dead].join(', ')}`);
}

// ---------------------------------------------------------------- отчёт: строки = корзины
const active = models.filter((m) => !dead.has(m));
const pctTable = ['### % успеха', '', `| корзина | ${active.map((m) => `\`${m}\``).join(' | ')} |`, `|---|${active.map(() => '---:').join('|')}|`];
const timeTable = ['### Время ответа (p50)', '', `| корзина | ${active.map((m) => `\`${m}\``).join(' | ')} |`, `|---|${active.map(() => '---:').join('|')}|`];
for (let bi = 0; bi < buckets.length; bi++) {
  const t = buckets[bi];
  const pr = active.map((m) => { const c = out.cells[key(m, t)]; return c ? `${c.pct.toFixed(0)}%` : '—'; });
  const tm = active.map((m) => { const c = out.cells[key(m, t)]; return c && c.ok ? sec(c.p50) : '—'; });
  pctTable.push(`| **${labels[bi]}** | ${pr.join(' | ')} |`);
  timeTable.push(`| **${labels[bi]}** | ${tm.join(' | ')} |`);
}
if (dead.size) { pctTable.push('', `мертвые (0 из ${cfg.runs} уже в <1K): ${[...dead].map((m) => `\`${m}\``).join(', ')}`); }

const md = [
  `## 📊 zen free — время и % успеха от размера контекста`,
  '',
  `корзин по токенам: ${buckets.length} (до ${Math.round(buckets[buckets.length - 1] / 1000)}K) · прогонов на ячейку: ${cfg.runs} · прямые вызовы в zen (без лестницы)`,
  '',
  ...pctTable, '',
  ...timeTable, '',
  '_p50 — медиана по успешным вызовам; «—» = ни одного ответа в этой ячейке._',
].join('\n');

fs.writeFileSync(cfg.out, JSON.stringify(out, null, 1));
if (cfg['summary-md']) fs.appendFileSync(cfg['summary-md'], md + '\n');
console.log(md);
console.log(`\nreport: ${cfg.out}`);
