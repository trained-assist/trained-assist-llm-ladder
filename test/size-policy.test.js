import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, hedgePlan, ttfbFactor } from '../src/size-policy.js';

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
