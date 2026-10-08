import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, estimateBudgetInput, BUDGET_ESTIMATOR_VERSION, BUDGET_INPUT_MAX_BYTES, ceilingFor, fits, hedgePlan, INPUT_CEILING_TOKENS } from '../src/size-policy.js';

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
});

test('budget estimate is versioned, UTF-8 based, and includes a 30% margin', () => {
  const english = estimateBudgetInput({ messages: [{ role: 'user', content: 'hello '.repeat(100) }] });
  const russian = estimateBudgetInput({ messages: [{ role: 'user', content: 'привет '.repeat(100) }] });
  assert.equal(english.ok, true);
  assert.equal(russian.ok, true);
  assert.equal(english.version, BUDGET_ESTIMATOR_VERSION);
  assert.equal(russian.version, BUDGET_ESTIMATOR_VERSION);
  assert.ok(russian.inputBytes > english.inputBytes, 'UTF-8 accounts for Cyrillic byte width');
  assert.equal(english.estimatedTokens, Math.ceil((english.inputBytes / 3) * 1.3));
  assert.equal(russian.estimatedTokens, Math.ceil((russian.inputBytes / 3) * 1.3));
  assert.ok(english.estimatedTokens >= 260, 'fixture estimate covers text and serialized message structure');
});

test('budget estimate rejects oversized serialized input before provider dispatch', () => {
  const result = estimateBudgetInput({ messages: [{ role: 'user', content: 'x'.repeat(BUDGET_INPUT_MAX_BYTES) }] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'input_too_large');
  assert.ok(result.inputBytes > BUDGET_INPUT_MAX_BYTES);
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
