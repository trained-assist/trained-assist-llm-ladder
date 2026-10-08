#!/usr/bin/env node
// embed-big-window-rungs — статический скрипт: найти бесплатные модели с большим контекстом и
// встроить их в лестницы, где такого окна не хватает.
//
// Зачем: у жирной сессии один ранг с большим окном — не резерв, а одиночная точка отказа.
// Замер 2026-10-08: payload дошёл до 298 988 реальных токенов (окно sante 262 144 не берёт),
// а единственный подходивший ранг в тот же момент отдавал `503 Service temporarily
// overloaded` → 5-мин пропуск → `every rung failed`. Второе большое окно (512K) снимает это.
//
// Что делает, по шагам:
//   1. читает инвентарь бесплатных моделей (GET /v1/free-models) — там уже есть context от
//      каталогов провайдеров и available/probe_status;
//   2. контекста в каталоге нет (все Go/zen-строки) → берёт из config/contexts.json (замеры
//      прошлых прогонов), а если и там нет и включён --measure → меряет сам, бинарным поиском
//      по размеру payload'а через пин в целевую лестницу;
//   3. считает, в каких не-фри лестницах мало больших окон (--min-windows, по умолчанию 2);
//   4. подбирает кандидатов (бесплатные, available, не стоящие уже в этой лестнице);
//   5. с --verify прогоняет каждого кандидата реальным жирным payload'ом (--verify-bytes) —
//      каталог врёт чаще, чем живой вызов; непрошедший выкидывается;
//   6. с --write вставляет выбранное ПОСЛЕ последнего большого окна этого сегмента.
//
// Без флагов — dry-run: печатает план и ничего не меняет.
//
// Usage:
//   npm run embed-rungs                     # план
//   npm run embed-rungs -- --verify --write # проверить живыми вызовами и записать
//   npm run embed-rungs -- --threshold 500000 --min-windows 2 --measure
//   npm run embed-rungs -- --only service:build --min-windows 3 --verify   # одна лестница
//
// Env: LLM_LADDER_TOKEN (или ~/.llm-ladder-token, chmod 600).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LADDERS_FILE = path.join(ROOT, 'config', 'ladders.json');
const CONTEXTS_FILE = path.join(ROOT, 'config', 'contexts.json');

// ── чистая логика (экспортируется ради тестов) ────────────────────────────────────────────

// Контекст модели: каталог инвентаря → собственный замер → null (неизвестно).
export function contextOf(modelId, catalog, measured = {}) {
  const c = catalog.get(modelId)?.context;
  if (Number.isFinite(c) && c > 0) return { context: c, source: 'catalog' };
  const m = measured[modelId]?.context;
  if (Number.isFinite(m) && m > 0) return { context: m, source: 'probe' };
  return { context: null, source: null };
}

// Ступени лестницы, окно которых ≥ threshold. Неизвестный контекст НЕ считается большим окном:
// надёжнее не иметь резерва, чем считать резервом то, что ещё не проверено.
export function bigWindows(rungs, catalog, measured, threshold) {
  return rungs.filter((m) => {
    const { context } = contextOf(m, catalog, measured);
    return context !== null && context >= threshold;
  });
}

// Кандидаты на встройку: только бесплатные и доступные, без уже стоящих в этой лестнице.
// Порядок — по убыванию надёжности: сначала каталог подтверждает большое окно, потом модель
// хотя бы раз успешно пинговалась, и только потом никогда не проверенные.
// Проба, которая уже ответила отказом ПО САМОЙ МОДЕЛИ (не временно): такую не предлагаем.
// `limited` (429) и `error` — временные, их решает --verify; `http_402` здесь важен отдельно:
// замер 2026-10-08 — OpenRouter без кредитов отдаёт 402 на всех платных, а в инвентаре это
// выглядит просто как available=1 с контекстом в мегатокены (lyria-3-clip: 1 048 576).
const DEAD_PROBE = /^(not_found|http_(400|401|402|403|404|410|451))$/;
export function isDeadProbe(status) {
  return DEAD_PROBE.test(String(status || ''));
}

export function pickCandidates(catalogRows, rungs, { threshold, probeOkFirst = true } = {}) {
  const have = new Set(rungs);
  // catalogRows — массив строк инвентаря; contextOf работает с Map по model_id.
  const byId = catalogRows instanceof Map ? catalogRows : new Map(catalogRows.map((r) => [r.model_id, r]));
  const score = (r) => {
    const { context, source } = contextOf(r.model_id, byId, {});
    const big = source === 'catalog' && context >= threshold ? 2 : 0;
    const probed = r.probe_status === 'ok' ? 1 : 0;
    const never = r.probe_status == null || r.probe_status === 'skipped' ? 0.5 : 0;
    return probeOkFirst ? big + probed + never : big;
  };
  return catalogRows
    .filter((r) => r.available && Number(r.price_out) === 0 && !have.has(r.model_id))
    .filter((r) => !isDeadProbe(r.probe_status))
    .filter((r) => {
      const { context, source } = contextOf(r.model_id, byId, {});
      return source === 'catalog' ? context >= threshold : true; // без инфы — оставляем, проверит --verify
    })
    .sort((a, b) => score(b) - score(a) || (b.context || 0) - (a.context || 0));
}

// Куда вставлять: сразу после последнего большого окна; больших окон нет — в конец
// бесплатного сегмента (перед платным), а не в голову: голова отвечает на обычных запросах.
export function insertAt(rungs, candidate, catalog, measured, threshold) {
  const idx = rungs.reduce((last, m, i) => {
    const { context } = contextOf(m, catalog, measured);
    return context !== null && context >= threshold ? i : last;
  }, -1);
  return idx >= 0 ? [...rungs.slice(0, idx + 1), candidate, ...rungs.slice(idx + 1)] : [...rungs, candidate];
}

// ── инфраструктура ───────────────────────────────────────────────────────────────────────

const readArg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
};
const has = (name) => process.argv.includes(`--${name}`);

function token() {
  if (process.env.LLM_LADDER_TOKEN) return process.env.LLM_LADDER_TOKEN.trim();
  const p = path.join(os.homedir(), '.llm-ladder-token');
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; }
}

async function api(base, pathname, init = {}, tok = null) {
  const res = await fetch(base + pathname, {
    ...init,
    headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(init.headers || {}) },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* текст — тоже ответ */ }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${String(json?.error?.message || text).slice(0, 200)}`);
  return json;
}

// Жирный payload для проверки: финальный явный вопрос, чтобы пустой ответ был виден сразу.
export function fatPayload(bytes, word = 'готово') {
  const unit = 'Parser reads the config, checks the module registry and reports missing entries in order. ';
  const n = Math.max(1, Math.floor(bytes / unit.length));
  return [
    { role: 'system', content: 'Ты — ассистент по разбору кода. Отвечай одним коротким словом.' },
    { role: 'user', content: unit.repeat(n) },
    { role: 'user', content: `Ответь одним словом: ${word}` },
  ];
}

// Проверка идёт через POST /v1/free-models/probe — воркер сам делает настоящий вызов модели.
// Через /v1/chat/completions это сделать нельзя: пин принимает только уже ЗАДЕПЛОЕННЫЙ ранг,
// а кандидата ещё ни в одной лестнице нет (правка локального config серверу не видна).
async function verifyRung({ base, tok, rung, bytes }) {
  try {
    const j = await api(base, '/v1/free-models/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: rung, bytes, timeout_ms: 90_000 }),
    }, tok);
    return { ok: !!j.ok, ms: j.ms ?? 0, note: j.ok ? '' : (j.note || 'отказ') };
  } catch (e) {
    return { ok: false, ms: 0, note: e.message };
  }
}

// Измерение контекста: бинарный поиск по размеру payload'а. Каждый шаг — реальный вызов с пином,
// поэтому модель должна уже стоять в лестнице (скрипт вставляет её перед замером).
export async function measureContext({ verify, lo = 32_000, hi = 2_000_000 }) {
  let best = 0;
  let low = lo;
  let high = hi;
  // Шаг не фиксирован: граница уточняется до 16 КБ, вызовов ≈ log2(range/step) ≈ 7–8.
  while (low <= high && high - low > 16_384) {
    const mid = Math.floor((low + high) / 2);
    const r = await verify(mid);
    if (r.ok) { best = mid; low = mid + 1; } else { high = mid - 1; }
  }
  return best;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// ── main ─────────────────────────────────────────────────────────────────────────────────

async function main() {
  const base = readArg('base', 'https://llm-ladder.trainedassist.store');
  const threshold = Number(readArg('threshold', 300_000));
  const minWindows = Number(readArg('min-windows', 2));
  const verifyBytes = Number(readArg('verify-bytes', 1_000_000));
  const doVerify = has('verify') || has('write');
  const doMeasure = has('measure');
  const doWrite = has('write');
  const jsonOut = has('json');
  const only = readArg('only', null); // 'service:build' — проверять одну лестницу, а не все

  const tok = token();
  if (!tok) { console.error('нет токена: LLM_LADDER_TOKEN или ~/.llm-ladder-token'); process.exit(2); }

  const inv = await api(base, '/v1/free-models', {}, tok);
  const rows = inv?.models || inv?.rows || (Array.isArray(inv) ? inv : []);
  const catalog = new Map(rows.map((r) => [r.model_id, r]));
  const measured = readJson(CONTEXTS_FILE, {});
  const cfg = JSON.parse(fs.readFileSync(LADDERS_FILE, 'utf8'));
  const SKIP = new Set(['free', 'vision', 'vision advanced']); // $0-потолок и multimodal-only

  const plan = [];
  for (const [name, roles] of Object.entries(cfg.ladders)) {
    if (SKIP.has(name)) continue;
    for (const role of Object.keys(roles)) {
      const key = `${name}:${role}`;
      if (only && key !== only) continue;
      const rungs = roles[role];
      const windows = bigWindows(rungs, catalog, measured, threshold);
      if (windows.length >= minWindows) continue;

      const wanted = minWindows - windows.length;
      const picks = [];
      for (const cand of pickCandidates(rows, rungs, { threshold })) {
        if (picks.length >= wanted) break;
        let keep = true;
        let note = '';
        if (doVerify) {
          const v = await verifyRung({ base, tok, rung: cand.model_id, bytes: verifyBytes });
          keep = v.ok;
          note = v.ok ? `${(v.ms / 1000).toFixed(1)} с` : `отказ: ${v.note}`;
          if (v.ok && doMeasure && !catalog.get(cand.model_id)?.context) {
            const ctx = await measureContext({ verify: (b) => verifyRung({ base, tok, rung: cand.model_id, bytes: b }) });
            if (ctx) { measured[cand.model_id] = { context: ctx, measured_at: new Date().toISOString(), source: 'probe' }; note += `, контекст ≈${ctx}`; }
          }
        }
        if (!keep) { plan.push({ ladder: key, model: cand.model_id, action: 'отклонён', note }); continue; }
        picks.push(cand.model_id);
        plan.push({ ladder: key, model: cand.model_id, action: doWrite ? 'вставлен' : 'вставить', note });
      }
      if (doWrite && picks.length) {
        let next = [...rungs];
        for (const c of picks) next = insertAt(next, c, catalog, measured, threshold);
        roles[role] = next;
      } else {
        roles[role] = rungs;
      }
    }
  }

  if (doWrite) {
    fs.writeFileSync(LADDERS_FILE, JSON.stringify(cfg, null, 2) + '\n');
    fs.writeFileSync(CONTEXTS_FILE, JSON.stringify(measured, null, 2) + '\n');
  }

  if (jsonOut) { console.log(JSON.stringify(plan, null, 2)); return; }
  if (!plan.length) {
    console.log(`всё в порядке: в каждой не-фри лестнице ≥ ${minWindows} окон ≥ ${threshold} токенов`);
    return;
  }
  console.log(`план (порог ${threshold}, минимум окон: ${minWindows}, проверка: ${doVerify ? `${verifyBytes} байт` : 'нет'}):\n`);
  for (const p of plan) console.log(`  ${p.action.padEnd(10)} ${p.ladder.padEnd(22)} ← ${p.model}  ${p.note}`);
  if (!doWrite) console.log('\nсухой прогон: добавьте --verify для живой проверки и --write для записи.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}
