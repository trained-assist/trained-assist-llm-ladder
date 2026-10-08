import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, payloadFacts, authHint } from '../scripts/diagnose-failure.mjs';

// Каждый код отвечает на ровно один вопрос владельца — «чего переполнение» — и несёт своё число.

test('байтовый отказ зена: байты против лимита кольца', () => {
  const c = classify({
    model: 'zen-rings/nemotron-3-ultra-free',
    outcome: 'error',
    error: 'zen-rings: input is too long for the free tier: 559830 bytes, limit 50000 (max_tokens=32000)',
  });
  assert.equal(c.code, 'SIZE_BYTES');
  assert.match(c.fact, /559 ?830 байт > 50 ?000 байт/);
});

test('потолок Go: токены против потолка ранга', () => {
  const c = classify({ model: 'opencode-go/longcat-2.5-preview-free', outcome: 'skipped', error: 'input ~128948t above the rung ceiling' });
  assert.equal(c.code, 'TOKEN_CEILING');
  assert.match(c.fact, /128 ?948 токенов/);
});

test('контекст модели: запрошено против окна', () => {
  const c = classify({
    model: 'openrouter/inclusionai/ling-3.0-flash-sante:free',
    outcome: 'error',
    error: 'HTTP 400: {"error":{"message":"This endpoint\'s maximum context length is 262144 tokens. However, you requested about 1693039 tokens (1690039 of text input, 3000 in the output)"}}',
  });
  assert.equal(c.code, 'CONTEXT');
  assert.match(c.fact, /1 ?693 ?039/);
  assert.match(c.fact, /262 ?144/);
});

test('мёртвый платный хвост не выглядит как переполнение', () => {
  const c = classify({ model: 'openrouter/xiaomi/mimo-v2.6-flash', outcome: 'error', error: 'HTTP 402: {"error":{"message":"Insufficient credits. Add more using https://openrouter.ai/settings/credits"}}' });
  assert.equal(c.code, 'NO_CREDITS');
});

test('кольцо, таймаут и пустой ответ — свои коды', () => {
  assert.equal(classify({ error: 'zen-rings: pool_backlog (max_tokens=30)' }).code, 'RING');
  assert.equal(classify({ error: 'watchdog fired after 45000ms' }).code, 'TIMEOUT');
  assert.equal(classify({ error: 'guard failed: empty content' }).code, 'GUARD');
  assert.equal(classify({ error: 'HTTP 429: too many requests' }).code, 'RATE');
});

test('payloadFacts вытаскивает байты и токены из ПОПЫТОК, а не из фантазии', () => {
  const p = payloadFacts([
    { model: 'opencode-go/longcat-2.5-preview-free', error: 'input ~128948t above the rung ceiling' },
    { model: 'zen-rings/nemotron-3-ultra-free', error: 'input is too long for the free tier: 559830 bytes, limit 50000' },
    { model: 'ling', error: 'maximum context length is 262144 tokens. However, you requested about 1693039 tokens' },
  ]);
  assert.equal(p.bytes, 559830);
  assert.equal(p.tokens, 128948);
  assert.equal(p.requested, 1693039);
});

test('пустые попытки не роняют разбор', () => {
  assert.equal(payloadFacts([]).bytes, 0);
  assert.equal(payloadFacts(undefined).tokens, 0);
  assert.equal(classify({}).code, 'OTHER');
});

test('протухшая OAuth-сессия wrangler → подсказка про wrangler login, а не сырой code 10000', () => {
  const hint = authHint('Authentication error [code: 10000]\n\nGetting User settings...');
  assert.match(hint, /wrangler login/);
  assert.match(authHint('Invalid access token [code: 9109]'), /wrangler login/);
  assert.equal(authHint('LIKE or GLOB pattern too complex: SQLITE_ERROR'), null, 'не-авторизационные ошибки не маскируем');
  assert.equal(authHint('fetch failed'), null, 'сетевой сбой обрабатывается отдельно (ретрай)');
});
