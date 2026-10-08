import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyError } from '../src/classify.js';

// Инцидент 2026-10-08: два реальных сообщения, которые классифицировались не в ту сторону.
// Оба воспроизведены слово в слово из трассы (D1 ladder_calls.attempts).

const OR_UPSTREAM_429 = 'HTTP 429: {"error":{"message":"Provider returned error","code":429,'
  + '"metadata":{"raw":"inclusionai/ling-3.0-flash-sante:free is temporarily rate-limited upstream. '
  + 'Please retry your request after a short wait."}}}';

const OR_NO_CREDITS = 'HTTP 402: {"error":{"message":"Insufficient credits. Add more using '
  + 'https://openrouter.ai/settings/credits","code":402,"metadata":{"limit_source":"openrouter"}}}';

test('занятый апстрим → 5 минут, а не час', () => {
  const c = classifyError(OR_UPSTREAM_429);
  assert.equal(c.class, 'quota');
  assert.equal(c.ttlMs, 5 * 60 * 1000, '«temporarily rate-limited upstream» — про провайдера сейчас, не про часовой лимит');
});

test('402 без кредитов → часовой пропуск, а не transient-ретрай каждые 2 с', () => {
  const c = classifyError(OR_NO_CREDITS);
  assert.equal(c.class, 'quota');
  assert.equal(c.ttlMs, 60 * 60 * 1000);
});

test('специальное правило побеждает общее: обычный 429 остаётся часом', () => {
  const c = classifyError('HTTP 429: too many requests');
  assert.equal(c.class, 'quota');
  assert.equal(c.ttlMs, 60 * 60 * 1000, 'нижняя общая строка 429 не изменилась');
});

test('config-правило про нехватку средств по-прежнему впереди', () => {
  const c = classifyError('insufficient account funds on this account');
  assert.equal(c.class, 'config');
  assert.equal(c.ttlMs, null);
});

test('отказы по размеру остаются context-классом (не травят health)', () => {
  for (const msg of [
    'zen-rings: input is too long for the free tier: 559830 bytes, limit 50000',
    "HTTP 400: This endpoint's maximum context length is 262144 tokens.",
    'prompt is too long: 200000 tokens > 128000',
  ]) {
    assert.equal(classifyError(msg).class, 'context', msg);
  }
});

test('прочие классы не задеты', () => {
  assert.equal(classifyError('Service temporarily overloaded').ttlMs, 5 * 60 * 1000);
  assert.equal(classifyError('model is unavailable for free').ttlMs, 30 * 24 * 60 * 60 * 1000);
  assert.equal(classifyError('что-то совсем незнакомое'), null, 'неизвестное → transient у вызывающего');
});
