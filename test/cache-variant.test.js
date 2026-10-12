import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, cacheScopeFor } from '../src/ladder.js';
import { handle } from '../src/handler.js';
import { memoryStore } from '../src/state.js';

const free = 'opencode-go/example-free';
const paid = 'opencode-go/example-paid';
const config = { ladders: { service: { build: [free, paid] } } };
const env = { OPENCODE_GO_API_KEYS: 'key-a,key-b', LADDER_TOKEN: 'test-token' };
const compact = [{ role: 'user', content: 'compact' }];
const masked = [{ role: 'user', content: 'masked-prefix' }];

function fakeFetch(seen, behaviour = {}) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ body, key: init.headers.Authorization });
    const status = behaviour[body.model]?.(init.headers.Authorization) ?? 200;
    if (status !== 200) return new Response('provider unavailable', { status });
    if (body.stream) return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 2 } });
  };
}

test('a masked variant is used only for its rung and cache scope after failover', async () => {
  const seen = [];
  const scope = await cacheScopeFor(env, paid, 0, 'conv-a');
  const result = await run({ model: 'service', messages: compact }, {
    env, config, store: memoryStore(2), fetchImpl: fakeFetch(seen, { 'example-free': () => 503 }),
    conversation: 'conv-a', cacheVariant: { rung: paid, cache_scope: scope, messages: masked },
  });
  assert.equal(result.ok, true);
  assert.equal(result.model, paid);
  assert.equal(result.cacheScope, scope);
  assert.equal(result.cacheVariant, 'masked');
  assert.deepEqual(seen.map((call) => call.body.messages), [compact, compact, masked]);
  assert.ok(seen.every((call) => !Object.hasOwn(call.body, 'ladder_cache_variant')));
});

test('a changed provider key or conversation uses the default projection', async () => {
  const oldScope = await cacheScopeFor(env, paid, 0, 'conv-a');
  const changedKeyEnv = { ...env, OPENCODE_GO_API_KEYS: 'key-b' };
  const seen = [];
  const result = await run({ model: 'service', messages: compact }, {
    env: changedKeyEnv, config: { ladders: { service: { build: [paid] } } },
    store: memoryStore(1), fetchImpl: fakeFetch(seen), conversation: 'conv-a',
    cacheVariant: { rung: paid, cache_scope: oldScope, messages: masked },
  });
  assert.equal(result.ok, true);
  assert.equal(result.cacheVariant, 'default');
  assert.deepEqual(seen[0].body.messages, compact);
  assert.notEqual(result.cacheScope, oldScope);
  assert.notEqual(await cacheScopeFor(env, paid, 0, 'conv-b'), oldScope);
  assert.equal(await cacheScopeFor(env, paid, 0, null), null);
  assert.equal(await cacheScopeFor(env, 'zen-rings/example-free', 0, 'conv-a'), null);
});

test('a large masked projection reaches its matching provider scope unchanged', async () => {
  const seen = [];
  const scope = await cacheScopeFor(env, paid, 0, 'conv-a');
  const large = [{ role: 'user', content: 'x'.repeat(450_000) }];
  const result = await run({ model: 'service', messages: compact }, {
    env, config: { ladders: { service: { build: [paid] } } }, store: memoryStore(2),
    fetchImpl: fakeFetch(seen), conversation: 'conv-a',
    cacheVariant: { rung: paid, cache_scope: scope, messages: large },
  });
  assert.equal(result.ok, true);
  assert.equal(result.cacheVariant, 'masked');
  assert.deepEqual(seen[0].body.messages, large);
});

test('Go key rotation selects the projection again for the new cache scope', async () => {
  const seen = [];
  const scope = await cacheScopeFor(env, paid, 0, 'conv-a');
  const result = await run({ model: 'service', messages: compact }, {
    env, config: { ladders: { service: { build: [paid] } } }, store: memoryStore(2),
    fetchImpl: fakeFetch(seen, { 'example-paid': (key) => key === 'Bearer key-a' ? 429 : 200 }),
    conversation: 'conv-a', cacheVariant: { rung: paid, cache_scope: scope, messages: masked },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(seen.map((call) => call.body.messages), [masked, compact]);
  assert.equal(result.cacheVariant, 'default');
  assert.equal(result.cacheScope, await cacheScopeFor(env, paid, 1, 'conv-a'));
});

test('HTTP accepts a bounded variant, strips it upstream and reports selection for streams', async () => {
  const seen = [];
  const httpPaid = 'opencode-go/mimo-v2.6-flash';
  const scope = await cacheScopeFor(env, httpPaid, 0, await hashedConversation('session-a'));
  const request = new Request('https://ladder.test/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json', 'x-session-id': 'session-a' },
    body: JSON.stringify({ model: 'service', ladder_rung: httpPaid, stream: true, messages: compact,
      ladder_cache_variant: { rung: httpPaid, cache_scope: scope, messages: masked } }),
  });
  const response = await handle(request, env, { store: memoryStore(2), fetchImpl: fakeFetch(seen) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-ladder-model'), httpPaid);
  assert.equal(response.headers.get('x-ladder-cache-scope'), scope);
  assert.equal(response.headers.get('x-ladder-cache-variant'), 'masked');
  assert.deepEqual(seen[0].body.messages, masked);
  assert.equal(Object.hasOwn(seen[0].body, 'ladder_cache_variant'), false);
});

async function hashedConversation(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

test('invalid variants are rejected before a provider request', async () => {
  const seen = [];
  const result = await run({ model: 'service', messages: compact }, {
    env, config, store: memoryStore(2), fetchImpl: fakeFetch(seen),
    cacheVariant: { rung: 'openrouter/other', cache_scope: 'bad', messages: masked },
  });
  assert.equal(result.status, 400);
  assert.equal(seen.length, 0);
});
