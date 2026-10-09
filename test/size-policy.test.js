import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, estimateBudgetInput, BUDGET_ESTIMATOR_VERSION, BUDGET_INPUT_MAX_BYTES, ceilingFor, fits, hedgePlan, ttfbFactor, INPUT_CEILING_TOKENS } from '../src/size-policy.js';

// The ceilings are measurements, not guesses — see src/size-policy.js for where each number came
// from. A wrong ceiling either wastes a hop (too low) or burns 48 s and three keys (too high),
// so both directions are pinned here.

test('estimateTokens: a token count without talking to a provider', () => {
  assert.equal(estimateTokens(undefined), 0, 'no messages → 0, and it must not throw');
  assert.equal(estimateTokens({ messages: [] }), 0, 'empty array → 0');
  // оценка считает JSON целиком, а не только content — поэтому немного больше, чем длина текста
  const t400 = estimateTokens({ messages: [{ role: 'user', content: 'x'.repeat(400) }] });
  assert.ok(t400 >= 100 && t400 <= 115, `400 символов ≈ 100-115 токенов, получили ${t400}`);
  // the estimate is on the JSON, so history, roles and tool schemas all count
  const withHistory = estimateTokens({ messages: [{ role: 'system', content: 'a' }, { role: 'user', content: 'b'.repeat(400) }] });
  assert.ok(withHistory > 100, 'more messages → more tokens, not fewer');

  // Ключевой случай: кириллица занимает 2 байта на символ, поэтому оценка ПО БАЙТАМ даёт
  // почти вдвое больше, чем len/4 по символам. Если считать по символам — 523 КБ русского
  // текста выглядят как «~80K токенов» (в потолке) и уходят в шлюз, который отвечает 429.
  const cyr = { messages: [{ role: 'user', content: 'я'.repeat(4000) }] };
  const byChars = Math.ceil(JSON.stringify(cyr.messages).length / 4);
  const byBytes = estimateTokens(cyr);
  assert.ok(byBytes > byChars * 1.5, `по байтам должно быть заметно больше: ${byBytes} против ${byChars}`);
  assert.ok(withHistory > 100, 'more messages → more tokens, not fewer');
});

test('budget estimate is versioned UTF-8 text quota with a 30% margin', () => {
  const en = estimateBudgetInput({ messages: [{ role: 'user', content: 'hello '.repeat(100) }] });
  const ru = estimateBudgetInput({ messages: [{ role: 'user', content: 'привет '.repeat(100) }] });
  assert.equal(en.ok, true);
  assert.equal(ru.ok, true);
  assert.equal(en.version, BUDGET_ESTIMATOR_VERSION);
  assert.ok(ru.inputBytes > en.inputBytes);
  assert.equal(ru.estimatedTokens, Math.ceil((ru.inputBytes / 3) * 1.3));
});

test('budget estimate accepts assistant tool-call history with null content', () => {
  const result = estimateBudgetInput({ messages: [
    { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: 'done' },
  ] });
  assert.equal(result.ok, true);
});

test('budget estimate rejects oversized input before provider dispatch', () => {
  const result = estimateBudgetInput({ messages: [{ role: 'user', content: 'x'.repeat(BUDGET_INPUT_MAX_BYTES) }] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'input_too_large');
});

test('ceilingFor: only rungs with a measured ceiling refuse', () => {
  assert.equal(ceilingFor('opencode-go/longcat-2.5-preview-free'), INPUT_CEILING_TOKENS['opencode-go/']);
  assert.equal(ceilingFor('opencode-go/mimo-v2.6-flash'), INPUT_CEILING_TOKENS['opencode-go/']);
  assert.equal(ceilingFor('zen-rings/nemotron-3-ultra-free'), null, 'the ring gates at 50 KB before this ever matters');
  assert.equal(ceilingFor('openrouter/inclusionai/ling-3.0-flash:free'), null, 'unknown → do not refuse');
  assert.equal(ceilingFor(undefined), null);
});

test('fits: 98K passes and 123K does not — the measured Go boundary', () => {
  const GO = 'opencode-go/longcat-2.5-preview-free';
  assert.equal(fits(GO, 98_000), true, 'measured 2026-10-07: 98K answered 200');
  assert.equal(fits(GO, 100_000), true, 'the ceiling itself is inclusive');
  assert.equal(fits(GO, 123_000), false, 'measured 2026-10-07: 123K → 429 + 3-key rotation');
  assert.equal(fits('zen-rings/mimo-v2.6-flash-free', 10_000_000), true, 'no ceiling → never refused here');
});

// The owner's bands (2026-10-07): a small context gets a small budget, a mid-size request is
// raced twice, a large one three times. The bands are declared here so the wiring in run() and
// the second step (the race itself) read from one place.
test('hedgePlan: bands by token count — 1 / 2 / 3 / 1', () => {
  assert.deepEqual(hedgePlan(0), { count: 1, timeoutFactor: 0.6 }, 'a tiny prompt gets a short budget');
  assert.deepEqual(hedgePlan(1_999), { count: 1, timeoutFactor: 0.6 });
  assert.deepEqual(hedgePlan(2_000), { count: 2, timeoutFactor: 1 }, 'bands are exclusive at the top');
  assert.deepEqual(hedgePlan(31_999), { count: 2, timeoutFactor: 1 });
  assert.deepEqual(hedgePlan(32_000), { count: 3, timeoutFactor: 1 });
  assert.deepEqual(hedgePlan(127_999), { count: 3, timeoutFactor: 1 });
  assert.deepEqual(hedgePlan(128_000), { count: 1, timeoutFactor: 1 }, 'past the ceiling band it is one rung again');
  assert.deepEqual(hedgePlan(5_000_000), { count: 1, timeoutFactor: 1 }, 'and it never throws');
});

// Замер 2026-10-08 (трасса за сутки): 21 из 28 отказов `no first token in time` — на payload
// ≥ 100 КБ, медиана 978 830 байт. Жирный промпт имеет префилл, 15 с ему не хватает.
test('ttfbFactor: окно первого токена растёт вместе с промптом', () => {
  assert.equal(ttfbFactor(0), 1, 'пустой запрос — как просили');
  assert.equal(ttfbFactor(31_999), 1, 'до 32K — без надбавки');
  assert.equal(ttfbFactor(32_000), 2, '32K — двойное окно (15 с → 30 с)');
  assert.equal(ttfbFactor(127_999), 2, '128K — всё ещё двойное');
  assert.equal(ttfbFactor(128_000), 3, '>128K — тройное (15 с → 45 с)');
  assert.equal(ttfbFactor(248_678), 3, 'медиана инцидента — на максимуме');
  assert.ok(ttfbFactor(1_000_000) <= 3, 'надбавка ограничена: failover не должен виснуть');
});
