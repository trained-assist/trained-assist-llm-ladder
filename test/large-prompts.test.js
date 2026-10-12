import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/ladder.js';
import { handle } from '../src/handler.js';
import { memoryStore } from '../src/state.js';

const free = 'opencode-go/longcat-2.5-preview-free';
const paid = 'opencode-go/mimo-v2.6-flash';
const fallback = 'openrouter/example/fallback:free';
const config = { ladders: { service: { build: [free, paid, fallback] } } };
const env = { OPENCODE_GO_API_KEYS: 'test-go-key', OPENROUTER_API_KEY: 'test-router-key' };

function bodyOfSize(bytes) {
  const body = { model: 'service', messages: [
    { role: 'system', content: 'Keep the full context.' },
    { role: 'user', content: '' },
  ] };
  const size = value => new TextEncoder().encode(JSON.stringify(value)).length;
  body.messages[1].content = 'x'.repeat(bytes - size(body));
  assert.equal(size(body), bytes);
  return body;
}

function completion(content = 'done') {
  return { id: 'test-id', object: 'chat.completion', created: 1,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] };
}

test('large requests pass unchanged through free and paid rungs', async () => {
  for (const bytes of [100_000, 350_001]) {
    const input = bodyOfSize(bytes);
    const calls = [];
    const result = await run(input, { env, config, store: memoryStore(), fetchImpl: async (_url, init) => {
      const outgoing = JSON.parse(init.body);
      calls.push(outgoing);
      return new Response(JSON.stringify(completion()), { status: calls.length === 1 ? 503 : 200 });
    } });
    assert.equal(result.ok, true);
    assert.equal(result.model, paid);
    assert.deepEqual(calls.map(call => call.model), [free, paid].map(model => model.split('/')[1]));
    for (const call of calls) assert.deepEqual(call.messages, input.messages);
    assert.equal(Object.hasOwn(result, 'compression'), false);
  }
});

test('450 KB Go request is sent unchanged instead of skipped by a local ceiling', async () => {
  const input = bodyOfSize(450_000);
  const calls = [];
  const result = await run(input, { env, config, store: memoryStore(), fetchImpl: async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify(completion()));
  } });
  assert.equal(result.ok, true);
  assert.equal(result.model, free);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].messages, input.messages);
  assert.deepEqual(result.attempts.map(attempt => attempt.outcome), ['ok']);
});

test('HTTP endpoint drops the retired compression flag and returns no compression header', async () => {
  const input = { ...bodyOfSize(350_001), ladder_rung: free, ladder_context_compression: true };
  const calls = [];
  const response = await handle(new Request('https://ladder.example/v1/chat/completions', {
    method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json', 'x-ladder-context-compression': 'on' },
    body: JSON.stringify(input),
  }), { ...env, LADDER_TOKEN: 'test-token' }, { store: memoryStore(), fetchImpl: async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify(completion()));
  } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-ladder-compression'), null);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].messages, input.messages);
  assert.equal(Object.hasOwn(calls[0], 'ladder_context_compression'), false);
});
