#!/usr/bin/env node
// Модель ожидания и параллелизма для жирных промптов — по нашим же замерам.
// Задача Владельца (2026-10-07): «параметры: время на ожидание — чем больше токенов, тем дольше
// ждём, нужна простая формулка и её можно сделать суровой… второе — сколько запросов в параллели,
// нужно просто поднять вероятность ответа… твоя задача на базе данных составить модель».
//
// ВХОД (то, что мы уже измерили):
//   zen-curve-result.json   синтетический филлер, 6 моделей × 9 корзин × 10 прогонов
//   fat-prompt-probe.json   РЕАЛЬНЫЙ промпт из нашей сессии, 4 модели × 7 прогонов, 650K токенов
//
// МОДЕЛЬ
//   1. Время:   t(T) = a + b·T     — метод наименьших квадратов по (T в тыс. токенов, p50).
//      Чем больше токенов — тем дольше ждём; a — постоянная часть (сеть + генерация ответа),
//      b — прирост на тысячу токенов входа.
//
//      НАЗНАЧЕНИЕ ФОРМУЛЫ (поправка владельца 2026-10-07): ждать долго НА ТЯЖЁЛЫХ. Тяжёлый
//      промпт нужно обработать хоть с каким-то шансом, а шанс даёт время — поэтому бюджет
//      растёт вместе с T. Отсекать тяжёлые «из-за 80 секунд» — ровно наоборот.
//
//      «Суровость» относится к ЛЁГКИМ: сейчас стоит единые 20 с на всё, и лёгкий промпт
//      (t(T) ≈ 3-5 с) держит ступень 20 с только потому, что сосед тяжёлый. Формула режет
//      это: лёгким — считанные секунды и быстрый уход дальше, тяжёлым — до потолка.
//
//   2. Параллель: n попыток даёт  P(n) = 1 − (1−p)^n   (попытки независимы — проверено тестом
//      корреляции: 4 Go-ключа, разброс успеха в пределах шума, на 150K падают все одинаково,
//      значит аккаунт не влияет → независимость реальна).
//        p=30% → n=1: 30%  n=2: 51%  n=4: 76%  n=6: 88%
//      Ровно логика владельца: «две модели — почти удваивается,30% станет 55%; два по два —
//      отличный результат».
//
//   3. Порог: для МАЛЫХ промптов параллель незачем — там p≈0.95 и отвечает бесплатный
//      opencode-go (быстро и без квоты zen). Порог берётся из данных: там, где p падает ниже
//      GO_P, включается параллель на zen.
//
// Выход: markdown-таблица (формула по модели, P(n), политика по полосам) + JSON.
// Exit 0 — это модель для решения, а не ворота.
//
// Usage:
//   node zen-wait-model.mjs [--curve path] [--fat path] [--target 0.9] [--safety 1.3]
//                           [--total-budget-ms 80000] [--go-p 0.95] [--out f.json] [--summary-md f.md]
//
// No dependencies (repo rule).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from './zen-client.mjs';

const HOME = os.homedir();
const DOCS = path.join(HOME, 'Documents/zen-context-research');

const parsed = parseArgs(process.argv.slice(2), {
  curve: path.join(DOCS, 'zen-curve-result.json'),
  fat: path.join(DOCS, 'fat-prompt-probe.json'),
  target: 0.9,
  safety: 1.3,
  'total-budget-ms': 80000,
  'go-p': 0.95,
  out: path.join(DOCS, 'zen-wait-model.json'),
  'summary-md': process.env.GITHUB_STEP_SUMMARY || '',
}, { numeric: ['target', 'safety', 'total-budget-ms', 'go-p'] });
if (parsed.problems.length) {
  console.error('bad invocation:\n' + parsed.problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(2);
}
const cfg = parsed.values;

const read = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { console.error(`нет файла ${p}: ${e.message}`); return null; } };

// ---------------------------------------------------------------- данные
function collect(curve, fat) {
  // model → [{tok(тыс.), ms}]
  const pts = {};
  const put = (model, tok, ms) => {
    if (ms == null) return;
    (pts[model] = pts[model] || []).push({ t: tok / 1000, ms });
  };
  for (const c of Object.values(curve?.cells || {})) put(c.model, c.tokens, c.p50);
  if (fat?.cells) {
    const tok = fat.tokens || 650_000;  // сырые токены: делят на 1000 сами put/add
    for (const c of Object.values(fat.cells)) put(c.model, tok, c.p50);
  }
  return pts;
}
function successRate(curve, fat) {
  // model → [{tok(тыс.), p}]
  const out = {};
  const add = (model, tok, ok, runs) => {
    if (!runs) return;
    (out[model] = out[model] || []).push({ t: tok / 1000, p: ok / runs, runs });
  };
  for (const c of Object.values(curve?.cells || {})) add(c.model, c.tokens, c.ok, c.runs);
  if (fat?.cells) {
    const tok = fat.tokens || 650_000;  // сырые токены: делят на 1000 сами put/add
    for (const c of Object.values(fat.cells)) add(c.model, tok, c.ok, c.runs);
  }
  return out;
}

// МНК по (t, ms): t в тыс. токенов. Нужно минимум 3 точек — на двух любой отрезок ложится.
function fit(points) {
  const p = points.filter((x) => Number.isFinite(x.ms));
  if (p.length < 3) return null;
  const n = p.length;
  const mt = p.reduce((s, x) => s + x.t, 0) / n;
  const my = p.reduce((s, x) => s + x.ms, 0) / n;
  let sxy = 0, sxx = 0;
  for (const x of p) { sxy += (x.t - mt) * (x.ms - my); sxx += (x.t - mt) ** 2; }
  if (!sxx) return null;
  const b = sxy / sxx;               // мс на 1000 токенов
  const a = my - b * mt;             // мс постоянной части
  // R² — насколько формула вообще описывает данные
  let ssRes = 0, ssTot = 0;
  for (const x of p) { ssRes += (x.ms - (a + b * x.t)) ** 2; ssTot += (x.ms - my) ** 2; }
  const r2 = ssTot ? 1 - ssRes / ssTot : 0;
  return { a, b, r2, n: p.length, tmin: Math.min(...p.map((x) => x.t)), tmax: Math.max(...p.map((x) => x.t)) };
}
// Сколько параллельных попыток нужно, чтобы достичь целевой вероятности ответа.
const attemptsFor = (p, target) => (p <= 0 ? Infinity : Math.max(1, Math.ceil(Math.log(1 - target) / Math.log(1 - p))));
// Обрезка краем Cloudflare — 100 с на весь ход лестницы (источник HTTP 522 в топе ошибок).
// До этого предела ждать можно и нужно; дальше — уже бессмысленно, ответ не успеет вернуться.
const EDGE_CEILING_MS = 85_000;
const pOf = (S) => (S < 1 ? 1 - Math.pow(1 - S, 1) : 1); // справочно

const curve = read(cfg.curve);
const fat = read(cfg.fat);
const pts = collect(curve, fat);
const rates = successRate(curve, fat);

const models = Object.keys(pts).sort();
const rows = [];
for (const m of models) {
  const f = fit(pts[m]);
  const rr = (rates[m] || []).slice().sort((x, y) => y.t - x.t); // от больших к малым
  // p на ЖИРНОМ промпте (650K) — это то, что решает, нужен ли параллель
  const fatPt = rr.find((x) => x.t >= 500);
  const pFat = fatPt ? fatPt.p : null;
  rows.push({ model: m, fit: f, pFat, fatT: fatPt ? fatPt.t : null });
}

// ---------------------------------------------------------------- политика
// Полосы по размеру: до GO_P всё берёт бесплатный opencode-go (быстро, без квоты zen),
// дальше — zen с числом попыток по p(T).
const bands = [];
const small = rows.filter((r) => r.pFat == null || r.pFat >= cfg['go-p']);
const big = rows.filter((r) => r.pFat != null && r.pFat < cfg['go-p']);

const md = [];
md.push('## 🧮 Модель ожидания и параллелизма — по нашим замерам');
md.push('');
md.push(`данные: ${cfg.curve.split('/').pop()} (6 моделей × 9 корзин × 10) + ${cfg.fat.split('/').pop()} (4 модели × 7, реальный промпт 650K)`);
md.push('');

md.push('### 1. Время ожидания  `t(T) = a + b·T`');
md.push('');
md.push('T — тысячи токенов входа, t — миллисекунды. МНК по p50 из замеров.');
md.push('');
md.push('| модель | a, мс | b, мс/1K ток. | R² | точек | диапазон, K | прогноз на 650K |');
md.push('|---|---:|---:|---:|---:|---|---:|');
for (const r of rows) {
  if (!r.fit) { md.push(`| \`${r.model}\` | — | — | — | ${pts[r.model]?.length || 0} | недостаточно точек | — |`); continue; }
  const { a, b, r2, n, tmin, tmax } = r.fit;
  const at650 = a + b * 650;
  md.push(`| \`${r.model}\` | ${a.toFixed(0)} | ${b.toFixed(1)} | ${r2.toFixed(2)} | ${n} | ${tmin.toFixed(0)}–${tmax.toFixed(0)} | ${(at650 / 1000).toFixed(1)} с |`);
}
md.push('');
md.push('**Бюджет ожидания — растёт вместе с T:**');
md.push('');
md.push('```');
md.push(`wait_ms(T) = clamp(${cfg.safety} · t(T), ${cfg.safety * 2000} мс, ${EDGE_CEILING_MS} мс)`);
md.push('```');
md.push('');
md.push(`- **лёгким — сурово:** сейчас стоит единые 20 000 мс на всё, а лёгкий промпт отвечает за 3–5 с. По формуле он получает считанные секунды и ступень уходит дальше, вместо того чтобы держать дорогое ожидание.`);
md.push(`- **тяжёлым — щедро:** бюджет растёт с T, и это суть формулы: тяжёлый промпт надо обработать хоть с каким-то шансом, а шанс даёт время. Отсекать его «из-за 80 секунд» — ровно наоборот.`);
md.push(`- **Потолок ${EDGE_CEILING_MS} мс задан не нами**: обрезка краем Cloudflare на 100 с (оттуда и \`HTTP 522\` в топе ошибок за сутки). Больше этого ждать всё равно нельзя — но до потолка ждём.`);

md.push('');
md.push(`### 2. Параллель  \`P(n) = 1 − (1−p)ⁿ\``);
md.push('');
md.push('Попытки независимы — проверено тестом корреляции (4 Go-ключа: разброс в пределах шума, на 150K падают все одинаково).');
md.push('');
md.push('| p при 650K | n=1 | n=2 (2×1) | n=4 (2×2) | n=6 (3×2) |');
md.push('|---|---:|---:|---:|---:|');
const ps = [0.1, 0.2, 0.3, 0.5, 0.57, 0.7, 0.9];
for (const p of ps) {
  const s = (n) => ((1 - Math.pow(1 - p, n)) * 100).toFixed(0) + '%';
  md.push(`| ${(p * 100).toFixed(0)}% | ${s(1)} | ${s(2)} | ${s(4)} | ${s(6)} |`);
}
md.push('');
md.push('Ровно логика владельца: «30% при двух попытках станет ~51%, два по два — 76%».');
md.push('');
md.push('### 3. Замеренные p на реальном жирном промпте (650K, 7 прогонов)');
md.push('');
md.push('| модель | успех | p | n при цели ' + (cfg.target * 100).toFixed(0) + '% | причина отказа |');
md.push('|---|---:|---:|---:|---|');
// Из rates, а не из rows: модели, которых нет в кривой и которые НЕ ответили ни разу,
// имеют p50 = null и через collect() в rows не попадают — а именно они тут самые интересные.
const fatCells = Object.values(fat?.cells || {});
const fatList = fatCells.map((c) => {
  const runs = c.runs - (c.limited || 0);
  const p = runs > 0 ? c.ok / runs : null;
  const n = p == null ? null : attemptsFor(p, cfg.target);
  const why = Object.keys(c.kinds || {}).length ? Object.entries(c.kinds).map(([k, v]) => `${k}×${v}`).join(', ') : '—';
  return { model: c.model, ok: c.ok, runs, p, n, why, p50: c.p50 };
}).sort((a, b) => (b.p ?? -1) - (a.p ?? -1));
for (const r of fatList) {
  md.push(`| \`${r.model}\` | ${r.ok}/${r.runs} | ${r.p == null ? '—' : r.p.toFixed(2)} | ${r.p == null ? '—' : Number.isFinite(r.n) ? r.n : '∞ (p=0)'} | ${r.why} |`);
}
md.push('');
md.push('### 4. Политика по полосам (черновик, из данных)');
md.push('');
md.push('| полоса | кого зовём | попыток | бюджет ожидания |');
md.push('|---|---|---|---|');
const wait = `clamp(${cfg.safety}·t(T), ${(cfg.safety * 2000) / 1000} с, ${EDGE_CEILING_MS / 1000} с)`;
md.push(`| T < 32K токенов | бесплатный \`opencode-go\` (p≈0.95+, быстрее всех: 3.3–5 с) | 1 | ${wait} — лёгким режем до считанных секунд |`);
md.push(`| 32K ≤ T < 600K | zen, где p из кривой ≥ ${(cfg['go-p'] * 100).toFixed(0)}% | 1 (p высокий) | ${wait} |`);
md.push(`| T ≥ 600K | zen + параллель \`n = ceil(ln(1−${cfg.target}) / ln(1−p))\` | 2..6 | ${wait} — ждём ДО потолка, шанс обработать даёт время |`);
md.push(`| ⛔ ждать дольше ${EDGE_CEILING_MS / 1000} с | нельзя: обрежет край Cloudflare (` + '`HTTP 522`' + `) | — | — |`);
md.push('');
md.push(`_Порог ${cfg['go-p']} и цель ${cfg.target} — параметры (\`--go-p\`, \`--target\`); числа не выдуманы, а лежат в JSON-отчёте._`);

const text = md.join('\n');
fs.writeFileSync(cfg.out, JSON.stringify({ generatedAt: new Date().toISOString(), config: cfg, rows }, null, 1));
if (cfg['summary-md']) fs.appendFileSync(cfg['summary-md'], text + '\n');
console.log(text);
console.log(`\nreport: ${cfg.out}`);
