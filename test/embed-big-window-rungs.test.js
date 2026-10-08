import test from 'node:test';
import assert from 'node:assert/strict';
import { contextOf, bigWindows, pickCandidates, insertAt, fatPayload, measureContext, isDeadProbe } from '../scripts/embed-big-window-rungs.mjs';

// Инвентарь отдаётся массивом строк; contextOf живёт на Map по model_id.
const row = (model_id, context, extra = {}) => ({ model_id, context, available: 1, price_out: 0, probe_status: null, ...extra });
const asMap = (rows) => new Map(rows.map((r) => [r.model_id, r]));

const CATALOG = [
  row('openrouter/dots-studio/dots-3-note-preview:free', 512_000, { probe_status: 'ok' }),
  row('openrouter/nvidia/nemotron-3-ultra-550b-a55b:free', 1_000_000),
  row('openrouter/inclusionai/ling-3.0-flash-sante:free', 262_144, { probe_status: 'ok' }),
  row('opencode-go/longcat-2.5-preview-free', null),
];
const MAP = asMap(CATALOG);

test('contextOf: каталог важнее своего замера, неизвестно — это null', () => {
  assert.deepEqual(contextOf('openrouter/dots-studio/dots-3-note-preview:free', MAP, { 'openrouter/dots-studio/dots-3-note-preview:free': { context: 1 } }),
    { context: 512_000, source: 'catalog' }, 'каталог не перетирается локальным замером');
  assert.deepEqual(contextOf('opencode-go/longcat-2.5-preview-free', MAP, { 'opencode-go/longcat-2.5-preview-free': { context: 131_072 } }),
    { context: 131_072, source: 'probe' }, 'нет в каталоге → берём свой замер');
  assert.deepEqual(contextOf('opencode-go/longcat-2.5-preview-free', MAP), { context: null, source: null }, 'нет нигде → null');
});

test('bigWindows: неизвестный контекст не считается большим окном', () => {
  const rungs = ['opencode-go/longcat-2.5-preview-free', 'openrouter/inclusionai/ling-3.0-flash-sante:free',
    'openrouter/dots-studio/dots-3-note-preview:free'];
  assert.deepEqual(bigWindows(rungs, MAP, {}, 300_000), ['openrouter/dots-studio/dots-3-note-preview:free'],
    '262K < 300K не проходит, unknown — тем более');
  assert.deepEqual(bigWindows(rungs, MAP, { 'opencode-go/longcat-2.5-preview-free': { context: 400_000 } }, 300_000),
    ['opencode-go/longcat-2.5-preview-free', 'openrouter/dots-studio/dots-3-note-preview:free'],
    'собственный замер делает ранг полноценным окном');
});

test('pickCandidates: только бесплатные и доступные, уже стоящие — не предлагаем снова', () => {
  const rows = [
    row('openrouter/dots-studio/dots-3-note-preview:free', 512_000, { probe_status: 'ok' }),
    row('openrouter/nvidia/nemotron-3-ultra-550b-a55b:free', 1_000_000),
    row('openrouter/inclusionai/ling-3.0-flash-sante:free', 262_144),   // контекст ниже порога
    { ...row('openrouter/x/paid:free', 1_000_000), price_out: 0.5 },      // платная
    { ...row('openrouter/x/gone:free', 1_000_000), available: 0 },        // недоступная
    row('opencode-go/longcat-2.5-preview-free', null),                     // без инфы — остаётся кандидатом
  ];
  const picked = pickCandidates(rows, ['openrouter/dots-studio/dots-3-note-preview:free'], { threshold: 300_000 });
  const ids = picked.map((r) => r.model_id);
  assert.ok(!ids.includes('openrouter/dots-studio/dots-3-note-preview:free'), 'уже в лестнице — не предлагаем');
  assert.ok(!ids.includes('openrouter/x/paid:free'), 'платная не попадает в бесплатную лестницу');
  assert.ok(!ids.includes('openrouter/x/gone:free'), 'недоступная не попадает');
  assert.ok(!ids.includes('openrouter/inclusionai/ling-3.0-flash-sante:free'), 'контекст ниже порога отбрасывается');
  assert.deepEqual(ids[0], 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
    '1M из каталога идёт первым — надёжнее всего');
  assert.ok(ids.includes('opencode-go/longcat-2.5-preview-free'), 'без инфы кандидат остаётся: решит --verify');
});

test('insertAt: вставляем сразу после последнего большого окна, а не в голову', () => {
  const rungs = ['a-free', 'b-big', 'c-mid', 'd', 'e-big', 'f'];
  const cat = asMap([row('b-big', 400_000), row('e-big', 500_000), row('c-mid', 100_000)]);
  const out = insertAt([...rungs], 'new', cat, {}, 300_000);
  assert.deepEqual(out, ['a-free', 'b-big', 'c-mid', 'd', 'e-big', 'new', 'f'],
    'после последнего большого окна');
  const none = insertAt(['x', 'y'], 'new', asMap([row('x', 1_000)]), {}, 300_000);
  assert.deepEqual(none, ['x', 'y', 'new'], 'больших окон нет — в конец, всё равно перед платным по построению');
});

test('fatPayload: размер близок к запрошенному (в байтах UTF-8)', () => {
  const p = fatPayload(1_000_000);
  const bytes = Buffer.byteLength(JSON.stringify(p), 'utf8');
  assert.ok(bytes > 900_000 && bytes < 1_150_000, `ожидали ≈1 МБ, получили ${bytes}`);
  assert.equal(p.at(-1).content, 'Ответь одним словом: готово', 'явный финальный вопрос — пустой ответ виден сразу');
});

test('measureContext: бинарный поиск находит границу за ~логарифмическое число вызовов', async () => {
  const LIMIT = 700_000;
  let calls = 0;
  const ok = await measureContext({ verify: async (bytes) => { calls++; return { ok: bytes <= LIMIT }; }, lo: 32_000, hi: 2_000_000 });
  assert.ok(ok >= LIMIT - 32_768 && ok <= LIMIT, `граница ≈${LIMIT}, получили ${ok}`);
  assert.ok(calls <= 12, `вызовов ${calls} — логарифм, а не перебор`);
});

test('isDeadProbe: мёртвую пробу не предлагаем, временную — предлагаем (решит --verify)', () => {
  for (const st of ['not_found', 'http_402', 'http_401', 'http_403', 'http_404']) {
    assert.equal(isDeadProbe(st), true, `${st} — отказ самой модели`);
  }
  for (const st of ['ok', 'limited', 'error', 'skipped', null, undefined, 'http_503']) {
    assert.equal(isDeadProbe(st), false, `${st} — временный или ещё не проверен`);
  }
  // Замер 2026-10-08: lyria-3-clip в инвентаре выглядел как живой кандидат — 1 048 576 контекста,
  // available=1, но probe=http_402 (OpenRouter без кредитов) и это музыкальная модель.
  const rows = [
    row('openrouter/google/lyria-3-clip-preview', 1_048_576, { probe_status: 'http_402' }),
    row('openrouter/thinkingmachines/inkling:free', 1_048_576),
  ];
  const picked = pickCandidates(rows, [], { threshold: 300_000 }).map((r) => r.model_id);
  assert.ok(picked.includes('openrouter/thinkingmachines/inkling:free'));
  assert.ok(!picked.includes('openrouter/google/lyria-3-clip-preview'), '402-модель не предлагаем вообще');
});
