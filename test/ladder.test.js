import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { run, parseJson, MIN_TOKENS } from '../src/ladder.js';
import { memoryStore, backoffFor, rotateKey, emptyState, snapshot } from '../src/state.js';

const config = JSON.parse(fs.readFileSync(new URL('../config/ladders.json', import.meta.url)));
const LADDER = config.ladders.deepseek.build;
const env = { OPENCODE_GO_API_KEYS: 'oc_a,oc_b', OPENROUTER_API_KEY: 'or_key' };
const short = m => m.replace(/^opencode-go\/|^openrouter\//, '');

// behaviour[model](ctx) → { status, content } | 'throw'
function fakeFetch(behaviour, calls) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const auth = init.headers.Authorization;
    calls.push({ url, model: body.model, auth, session: init.headers['x-opencode-session'], body });
    const r = (behaviour[body.model] || (() => ({ status: 200, content: 'ok' })))({ auth, body });
    if (r === 'throw') throw new Error('network down');
    const data = r.status === 200 ? { id: 'x', object: 'chat.completion', choices: [{ message: { role: 'assistant', content: r.content } }], usage: { prompt_tokens: 3 } } : null;
    return { ok: r.status === 200, status: r.status, json: async () => data, text: async () => r.error || '' };
  };
}
const msg = { model: 'deepseek', messages: [{ role: 'user', content: 'hi' }] };

test('config: owner order — mimo → deepseek-v4.1-flash → muse-spark → OpenRouter last', () => {
  assert.deepEqual(LADDER, ['opencode-go/mimo-v2.6-flash', 'opencode-go/deepseek-v4.1-flash', 'opencode-go/muse-spark-1.3-contributor', 'openrouter/deepseek/deepseek-v4-flash-0731']);
});

test('first Go rung answers; Go gets the session header, non-stream, reasoning-safe max_tokens', async () => {
  const calls = [];
  const r = await run({ ...msg, max_tokens: 5, stream: true }, { env, config, store: memoryStore(2), fetchImpl: fakeFetch({}, calls) });
  assert.equal(r.ok, true);
  assert.equal(r.model, LADDER[0]);
  assert.match(calls[0].url, /opencode\.ai\/zen\/go\/v1\/chat\/completions$/);
  assert.ok(calls[0].session);
  assert.equal(calls[0].body.stream, false);
  assert.ok(calls[0].body.max_tokens >= MIN_TOKENS);
  assert.equal(calls[0].auth, 'Bearer oc_a');
});

test('failing rung → next rung; the failed one is skipped on the next call', async () => {
  const store = memoryStore(2);
  const beh = { [short(LADDER[0])]: () => ({ status: 500, error: 'boom' }) };
  const r = await run(msg, { env, config, store, fetchImpl: fakeFetch(beh, []) });
  assert.equal(r.model, LADDER[1]);
  const calls = [];
  await run(msg, { env, config, store, fetchImpl: fakeFetch(beh, calls) });
  assert.equal(calls[0].model, short(LADDER[1]));
});

test('json guard: non-JSON fails the rung, fenced JSON is accepted', async () => {
  const beh = {
    [short(LADDER[0])]: () => ({ status: 200, content: 'sure thing' }),
    [short(LADDER[1])]: () => ({ status: 200, content: '```json\n{"kind":"none"}\n```' }),
  };
  const r = await run({ ...msg, response_format: { type: 'json_object' } }, { env, config, store: memoryStore(2), fetchImpl: fakeFetch(beh, []) });
  assert.equal(r.model, LADDER[1]);
  assert.deepEqual(parseJson(r.content), { kind: 'none' });
});

test('Go key limit → rotate to spare key, retry SAME rung', async () => {
  const calls = [];
  const beh = { [short(LADDER[0])]: ({ auth }) => (auth === 'Bearer oc_a' ? { status: 429, error: 'Go usage limit exceeded' } : { status: 200, content: 'ok' }) };
  const store = memoryStore(2);
  const r = await run(msg, { env, config, store, fetchImpl: fakeFetch(beh, calls) });
  assert.equal(r.model, LADDER[0]);
  assert.deepEqual(calls.map(c => c.auth), ['Bearer oc_a', 'Bearer oc_b']);
  assert.equal(store.state.keys.active, 1, 'next call starts on the spare key');
});

test('both keys limited → all Go rungs parked, OpenRouter answers, Go comes back after the window', async () => {
  const beh = {};
  for (const m of LADDER) if (m.startsWith('opencode-go/')) beh[short(m)] = () => ({ status: 429, error: 'usage limit' });
  const store = memoryStore(2);
  const calls = [];
  const r = await run(msg, { env, config, store, fetchImpl: fakeFetch(beh, calls) });
  assert.equal(r.model, LADDER[3]);
  assert.equal(calls.filter(c => c.url.includes('opencode.ai')).length, 2, 'first Go rung once per key, rest parked');
  // next call goes straight to OpenRouter
  const calls2 = [];
  await run(msg, { env, config, store, fetchImpl: fakeFetch({}, calls2) });
  assert.ok(calls2[0].url.includes('openrouter.ai'));
  // window lapses → Go again, without any manual step
  for (const m of Object.keys(store.state.health)) store.state.health[m].skipUntil = Date.now() - 1;
  for (const k of Object.keys(store.state.keys.exhausted)) store.state.keys.exhausted[k] = Date.now() - 1;
  const calls3 = [];
  const r3 = await run(msg, { env, config, store, fetchImpl: fakeFetch({}, calls3) });
  assert.equal(r3.model, LADDER[0]);
});

test('503 / Bad Request on a Go rung does NOT burn a key', async () => {
  const beh = { [short(LADDER[0])]: () => ({ status: 503, error: 'temporarily overloaded' }) };
  const store = memoryStore(2);
  const calls = [];
  await run(msg, { env, config, store, fetchImpl: fakeFetch(beh, calls) });
  assert.equal(store.state.keys.active, 0);
  assert.equal(calls[1].auth, 'Bearer oc_a');
});

test('no Go keys → OpenRouter only; no keys → 503; unknown ladder → 404', async () => {
  const calls = [];
  const r = await run(msg, { env: { OPENROUTER_API_KEY: 'k' }, config, store: memoryStore(0), fetchImpl: fakeFetch({}, calls) });
  assert.equal(r.model, LADDER[3]);
  assert.equal((await run(msg, { env: {}, config, store: memoryStore(0), fetchImpl: fakeFetch({}, []) })).status, 503);
  assert.equal((await run({ ...msg, model: 'nope' }, { env, config, store: memoryStore(2), fetchImpl: fakeFetch({}, []) })).status, 404);
});

test('stale skip on every rung does not black-hole the call', async () => {
  const store = memoryStore(2);
  for (const m of LADDER) store.state.health[m] = { failures: 9, firstFailureAt: Date.now(), skipUntil: Date.now() + 60000 };
  const r = await run(msg, { env, config, store, fetchImpl: fakeFetch({}, []) });
  assert.equal(r.ok, true);
});

test('totalTimeoutMs stops walking the ladder', async () => {
  const beh = {};
  for (const m of LADDER) beh[short(m)] = () => ({ status: 500, error: 'boom' });
  const slow = fakeFetch(beh, []);
  const fetchImpl = async (u, i) => { await new Promise(r => setTimeout(r, 300)); return slow(u, i); };
  const r = await run(msg, { env, config, store: memoryStore(2), fetchImpl, totalTimeoutMs: 700 });
  assert.equal(r.ok, false);
  assert.ok(r.attempts.filter(a => a.outcome === 'error').length < LADDER.length);
});

test('state: per-model exponential backoff restarts for every model; key rotation + snapshot heal', () => {
  assert.deepEqual([1, 2, 3, 4, 10].map(n => backoffFor(n)), [15000, 30000, 60000, 120000, 300000]);
  const st = emptyState();
  assert.deepEqual(rotateKey(st, 2, 1000, 0), { rotated: true, fromIndex: 0, toIndex: 1 });
  const r = rotateKey(st, 2, 1000, 10);
  assert.equal(r.rotated, false);
  assert.equal(r.retryAt, 1000);
  assert.equal(snapshot(st, 2, 2000).keys.active, 1, 'healed keys: active stays usable');
});
