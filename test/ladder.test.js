import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { run, parseJson, MIN_TOKENS, keyFaultOf, KEY_QUOTA_TTL_MS, KEY_WEEKLY_TTL_MS } from '../src/ladder.js';
import { memoryStore, backoffFor, rotateKey, emptyState, snapshot, resetKeys } from '../src/state.js';

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

test('config: Go mimo → Go deepseek-v4.1-flash → free OpenRouter tier → paid tail of three vendors', () => {
  assert.deepEqual(LADDER, ['opencode-go/mimo-v2.6-flash', 'opencode-go/deepseek-v4.1-flash',
    'openrouter/nvidia/nemotron-3-super-120b-a12b:free', 'openrouter/inclusionai/ling-3.0-flash-sante:free',
    'openrouter/deepseek/deepseek-v4-flash-0731', 'openrouter/inclusionai/ling-3.0-flash', 'openrouter/xiaomi/mimo-v2.6-flash']);
  const paid = m => m.startsWith('openrouter/') && !m.endsWith(':free');
  const firstPaid = LADDER.findIndex(paid);
  assert.ok(LADDER.slice(firstPaid).every(paid), 'paid OpenRouter rungs only at the tail');
});

test('first Go rung answers; Go gets the session header, non-stream, reasoning-safe max_tokens', async () => {
  const calls = [];
  const r = await run({ ...msg, max_tokens: 5 }, { env, config, store: memoryStore(2), fetchImpl: fakeFetch({}, calls) });
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
  assert.equal(r.attempts.find(a => a.outcome === 'key-rotated').key, 0, 'attempts name the key that failed');
});

test('spare key answers a non-key failure → the call STAYS on the same Go rung; one probe per call', async () => {
  // Key A is unhealthy for this model for a reason that never matches the quota/401 patterns
  // (silent throttle looks like a flaky model) — the probe keeps the call on Go instead of paying
  // for OpenRouter and resetting the caller's prompt cache.
  const store = memoryStore(2);
  const beh = { [short(LADDER[0])]: ({ auth }) => (auth === 'Bearer oc_a' ? { status: 500, error: 'boom' } : { status: 200, content: 'ok' }) };
  const calls = [];
  const r = await run(msg, { env, config, store, fetchImpl: fakeFetch(beh, calls) });
  assert.equal(r.ok, true);
  assert.equal(r.model, LADDER[0]);
  assert.deepEqual(calls.map(c => c.auth), ['Bearer oc_a', 'Bearer oc_b']);
  assert.equal(store.state.keys.active, 0, 'a probe is local — shared rotation state moves only on quota/401');
  assert.equal(r.attempts.filter(a => a.outcome === 'key-probe').length, 1);

  // Budget is ONE probe per call: the next failing Go rung must not probe again, so a Go outage
  // cannot double the failover latency.
  const beh2 = {
    [short(LADDER[0])]: () => ({ status: 500, error: 'boom' }),
    [short(LADDER[1])]: ({ auth }) => (auth === 'Bearer oc_a' ? { status: 500, error: 'boom' } : { status: 200, content: 'ok' }),
  };
  const calls2 = [];
  const r2 = await run(msg, { env, config, store: memoryStore(2), fetchImpl: fakeFetch(beh2, calls2) });
  assert.equal(r2.attempts.filter(a => a.outcome === 'key-probe').length, 1, 'exactly one probe per call');
  assert.equal(r2.model, LADDER.find(m => m.startsWith('openrouter/')), 'spare already used → the ladder moves on');
});

test('context overflow on a Go rung does NOT probe the spare key — the key cannot change it', async () => {
  const beh = { [short(LADDER[0])]: () => ({ status: 400, error: 'This request exceeds the context window of the model' }) };
  const calls = [];
  const r = await run(msg, { env, config, store: memoryStore(2), fetchImpl: fakeFetch(beh, calls) });
  assert.equal(r.attempts.filter(a => a.outcome === 'key-probe').length, 0);
  assert.deepEqual(calls.map(c => c.auth), ['Bearer oc_a', 'Bearer oc_a'], 'no probe: straight to the next rung');
  assert.equal(r.model, LADDER[1]);
});

test('a WEEKLY Go allowance parks the key for hours; a plain rate-limit hit keeps the15-minute TTL', () => {
  const weekly = 'HTTP 429: {"type":"error","error":{"type":"GoUsageLimitError","message":"Go usage limit exceeded"},'
    + '"metadata":{"workspace":"wrk_01KN4","limitName":"weekly"}}';
  assert.equal(keyFaultOf(weekly).ttlMs, KEY_WEEKLY_TTL_MS);
  assert.equal(keyFaultOf('HTTP 429: Go usage limit exceeded').ttlMs, KEY_QUOTA_TTL_MS);
  assert.equal(keyFaultOf('HTTP 401: invalid api key').dead, true);
});

test('both keys limited → all Go rungs parked, OpenRouter answers, Go comes back after the window', async () => {
  const beh = {};
  for (const m of LADDER) if (m.startsWith('opencode-go/')) beh[short(m)] = () => ({ status: 429, error: 'usage limit' });
  const store = memoryStore(2);
  const calls = [];
  const r = await run(msg, { env, config, store, fetchImpl: fakeFetch(beh, calls) });
  assert.equal(r.model, LADDER.find(m => m.startsWith('openrouter/')));
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

test('non-key failure on a Go rung probes the spare key once, but never burns shared state', async () => {
  const beh = { [short(LADDER[0])]: () => ({ status: 503, error: 'temporarily overloaded' }) };
  const store = memoryStore(2);
  const calls = [];
  const r = await run(msg, { env, config, store, fetchImpl: fakeFetch(beh, calls) });
  assert.equal(store.state.keys.active, 0, 'a model-level fault never moves shared key state');
  assert.deepEqual(calls.map(c => c.auth), ['Bearer oc_a', 'Bearer oc_b', 'Bearer oc_a'],
    'same rung retried on the spare key, then failover to rung 2 on the active key');
  assert.equal(r.model, LADDER[1]);
  assert.equal(r.attempts.filter(a => a.outcome === 'key-probe').length, 1);
});

test('no Go keys → OpenRouter only; no keys → 503; unknown ladder → 404', async () => {
  const calls = [];
  const r = await run(msg, { env: { OPENROUTER_API_KEY: 'k' }, config, store: memoryStore(0), fetchImpl: fakeFetch({}, calls) });
  assert.equal(r.model, LADDER.find(m => m.startsWith('openrouter/')));
  assert.equal((await run(msg, { env: {}, config, store: memoryStore(0), fetchImpl: fakeFetch({}, []) })).status, 503);
  assert.equal((await run({ ...msg, model: 'nope' }, { env, config, store: memoryStore(2), fetchImpl: fakeFetch({}, []) })).status, 404);
});

test('stale skip on every rung does not black-hole the call', async () => {
  const store = memoryStore(2);
  for (const m of LADDER) store.state.health[m] = { failures: 9, firstFailureAt: Date.now(), skipUntil: Date.now() + 60000 };
  const r = await run(msg, { env, config, store, fetchImpl: fakeFetch({}, []) });
  assert.equal(r.ok, true);
});

test('a transient Go skip is capped at 30s after the last failure (fleet returns to Go); real limits keep their TTL', async () => {
  const old = { failures: 5, firstFailureAt: Date.now() - 60000, lastFailureAt: Date.now() - 31000, skipUntil: Date.now() + 240000 };
  const store = memoryStore(2);
  store.state.health[LADDER[0]] = { ...old, class: 'transient' };
  const calls = [];
  await run(msg, { env, config, store, fetchImpl: fakeFetch({}, calls) });
  assert.equal(calls[0].model, short(LADDER[0]), 'a transient skip older than 30s is ignored — Go is re-tested');

  const fresh = memoryStore(2);
  fresh.state.health[LADDER[0]] = { ...old, lastFailureAt: Date.now() - 10000, class: 'transient' };
  const calls2 = [];
  await run(msg, { env, config, store: fresh, fetchImpl: fakeFetch({}, calls2) });
  assert.equal(calls2[0].model, short(LADDER[1]), 'a fresh transient skip is honoured');

  const quota = memoryStore(2);
  quota.state.health[LADDER[0]] = { ...old, class: 'quota' };
  const calls3 = [];
  await run(msg, { env, config, store: quota, fetchImpl: fakeFetch({}, calls3) });
  assert.equal(calls3[0].model, short(LADDER[1]), 'a quota park is never capped');
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

// ── Streaming (opencode as a client of the free ladder) ────────────────────────────────────────
const enc = new TextEncoder();
function sseBody(events, { delayFirstMs = 0, endWithoutOutput = false } = {}) {
  return new ReadableStream({
    async start(c) {
      if (delayFirstMs) await new Promise(r => setTimeout(r, delayFirstMs));
      for (const e of events) c.enqueue(enc.encode(`data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`));
      c.close();
    },
  });
}
const delta = (d) => ({ choices: [{ delta: d }] });
function streamFetch(behaviour, calls) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, model: body.model, body });
    const b = (behaviour[body.model] || (() => ({ events: [delta({ role: 'assistant' }), delta({ content: 'hi' }), '[DONE]'] })))({ body, signal: init.signal });
    if (b.status && b.status !== 200) return { ok: false, status: b.status, text: async () => b.error || '' };
    // honour abort (ttfb timeout)
    const bodyStream = sseBody(b.events, b);
    return { ok: true, status: 200, body: bodyStream };
  };
}
async function readAll(stream) {
  const r = stream.getReader(); const dec = new TextDecoder(); let out = '';
  for (;;) { const { value, done } = await r.read(); if (done) return out; out += dec.decode(value); }
}
const FREE = config.ladders.free.build;

test('free-ladder alias resolves; stream answered by the first rung with output, bytes replayed intact', async () => {
  const calls = [];
  const r = await run({ model: 'free-ladder', stream: true, messages: [{ role: 'user', content: 'hi' }] }, { env, config, store: memoryStore(2), fetchImpl: streamFetch({}, calls) });
  assert.equal(r.ok, true);
  assert.equal(r.model, FREE[0]);
  assert.equal(calls[0].body.stream, true);
  const text = await readAll(r.stream);
  assert.match(text, /"role":"assistant"/, 'the buffered role frame is replayed');
  assert.match(text, /"content":"hi"/);
  assert.match(text, /\[DONE\]/);
});

test('stream: a rung that ends / errors before the first token fails over; role-only frame does not commit', async () => {
  const beh = {
    [short(FREE[0])]: () => ({ events: [delta({ role: 'assistant' })] }),                       // ends with no output
    [short(FREE[1])]: () => ({ events: [{ error: { message: 'upstream overloaded' } }] }),       // in-stream error
    [short(FREE[2])]: () => ({ status: 503, error: 'busy' }),
  };
  const calls = [];
  const r = await run({ model: 'free', stream: true, messages: [{ role: 'user', content: 'hi' }] }, { env, config, store: memoryStore(2), fetchImpl: streamFetch(beh, calls) });
  assert.equal(r.model, FREE[3]);
  assert.deepEqual(r.attempts.map(a => a.outcome), ['key-probe', 'error', 'error', 'error', 'ok'],
    'the first Go rung also gets the one spare-key probe; the rest fail over rung by rung');
});

test('stream: tool_calls delta counts as the first token (tools passed through)', async () => {
  const tools = [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }];
  const beh = { [short(FREE[0])]: ({ body }) => { assert.deepEqual(body.tools, tools); return { events: [delta({ tool_calls: [{ index: 0, function: { name: 'bash', arguments: '{}' } }] }), '[DONE]'] }; } };
  const r = await run({ model: 'free', stream: true, tools, messages: [{ role: 'user', content: 'ls' }] }, { env, config, store: memoryStore(2), fetchImpl: streamFetch(beh, []) });
  assert.equal(r.model, FREE[0]);
  assert.match(await readAll(r.stream), /tool_calls/);
});

test('non-stream: tool_calls with empty content is a valid answer', async () => {
  const f = async (url, init) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: null, tool_calls: [{ id: 't', type: 'function', function: { name: 'bash', arguments: '{}' } }] } }] }), text: async () => '' });
  const r = await run({ model: 'free', messages: [{ role: 'user', content: 'ls' }], tools: [{ type: 'function', function: { name: 'bash' } }] }, { env, config, store: memoryStore(2), fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(r.model, FREE[0]);
});

test('provider rejects response_format (400) → same rung retried once without it', async () => {
  const seen = [];
  const f = async (url, init) => {
    const body = JSON.parse(init.body); seen.push(!!body.response_format);
    if (body.response_format) return { ok: false, status: 400, text: async () => 'response_format is not supported by this model' };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }), text: async () => '' };
  };
  const r = await run({ model: 'free', response_format: { type: 'json_object' }, messages: [{ role: 'user', content: 'json' }] }, { env, config, store: memoryStore(2), fetchImpl: f });
  assert.equal(r.model, FREE[0]);
  assert.deepEqual(seen, [true, false]);
});

test('ladder_rung pins one rung: no failover, health skip ignored, foreign rung rejected', async () => {
  const store = memoryStore(2);
  store.state.health[LADDER[1]] = { failures: 3, firstFailureAt: Date.now(), skipUntil: Date.now() + 60000 };
  const calls = [];
  const r = await run(msg, { env, config, store, fetchImpl: fakeFetch({}, calls), pinRung: LADDER[1] });
  assert.equal(r.model, LADDER[1]);
  assert.equal(calls.length, 1);
  const beh = { [short(LADDER[1])]: () => ({ status: 500, error: 'boom' }) };
  const r2 = await run(msg, { env, config, store: memoryStore(2), fetchImpl: fakeFetch(beh, []), pinRung: LADDER[1] });
  assert.equal(r2.ok, false);
  assert.equal(r2.attempts.length, 1);
  assert.equal((await run(msg, { env, config, store: memoryStore(2), fetchImpl: fakeFetch({}, []), pinRung: 'openrouter/x/y' })).status, 400);
});

test('config: doctor = Go MiMo first, then stronger Go models, paid OpenRouter mimo last (owner 2026-09-28)', () => {
  const expected = ['opencode-go/mimo-v2.6-flash', 'opencode-go/qwen3.7-plus',
    'opencode-go/deepseek-v4-pro', 'openrouter/xiaomi/mimo-v2.6-flash'];
  for (const role of ['build', 'plan', 'explore', 'general', 'review']) assert.deepEqual(config.ladders.doctor[role], expected, role);
});

test('config: research is split by role — Gemini reads (explore), Go MiMo thinks (owner 2026-09-28)', () => {
  const reader = ['openrouter/google/gemini-2.5-flash-lite', 'openrouter/google/gemini-3.1-flash-lite', 'opencode-go/mimo-v2.6-flash'];
  const thinker = ['opencode-go/mimo-v2.6-flash', 'opencode-go/deepseek-v4.1-flash', 'openrouter/xiaomi/mimo-v2.6-flash'];
  assert.deepEqual(config.ladders.research.explore, reader);
  for (const role of ['build', 'plan', 'general', 'review']) assert.deepEqual(config.ladders.research[role], thinker, role);
  assert.ok(!JSON.stringify(config.ladders.research).includes('gemini-2.5-pro'), 'no 2.5-pro in research');
});

// Incident 2026-09-29: two concurrent calls both started on key 0; A hit the weekly limit and
// rotated to key 1, then B hit the same limit on key 0 and parked the HEALTHY key 1 for 6h —
// "every rung failed" fleet-wide while key 1 still had allowance.
test('state: a late failure on an already-rotated key parks THAT key, not the healthy active one', () => {
  const st = emptyState();
  assert.deepEqual(rotateKey(st, 2, 6 * 3600e3, 0, 0), { rotated: true, fromIndex: 0, toIndex: 1 });
  const late = rotateKey(st, 2, 6 * 3600e3, 5, 0);
  assert.deepEqual(late, { rotated: true, fromIndex: 0, toIndex: 1 });
  assert.equal(st.keys.exhausted[1], undefined, 'key 1 was never failed — must stay usable');
  assert.equal(snapshot(st, 2, 10).keys.active, 1);
});

test('ladder: concurrent weekly-limit on key 0 keeps Go serving on key 1', async () => {
  const env = { LADDER_TOKEN: 't', OPENCODE_GO_API_KEYS: 'oc_a, oc_b', OPENROUTER_API_KEY: 'or' };
  const cfg = { ladders: { deepseek: { build: ['opencode-go/mimo', 'openrouter/x'] } } };
  const store = memoryStore(2);
  const weekly = () => new Response('{"type":"error","error":{"type":"GoUsageLimitError","message":"Go usage limit exceeded"},"metadata":{"limitName":"weekly"}}', { status: 429 });
  const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  let gate; const held = new Promise(r => { gate = r; });
  let firstA = true;
  const fetchImpl = async (u, init) => {
    const auth = init.headers.Authorization;
    if (String(u).includes('openrouter')) return new Response('down', { status: 500 });
    if (auth === 'Bearer oc_a') {
      if (firstA) { firstA = false; await held; } // B's key-0 failure lands AFTER A rotated
      return weekly();
    }
    return ok();
  };
  const body = { model: 'deepseek', messages: [{ role: 'user', content: 'hi' }] };
  const pB = run(body, { env, config: cfg, store, fetchImpl });
  await new Promise(r => setTimeout(r, 10));
  const a = await run(body, { env, config: cfg, store, fetchImpl });
  gate();
  const b = await pB;
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  const snap = await store.snapshot(2);
  assert.equal(snap.keys.exhausted[1], undefined);
  assert.equal(snap.keys.active, 1);
  const c = await run(body, { env, config: cfg, store, fetchImpl });
  assert.equal(c.ok, true);
  assert.equal(c.model, 'opencode-go/mimo');
});

test('state: resetKeys clears Go key parks and Go rung skips, keeps OpenRouter health', () => {
  const st = emptyState();
  st.keys = { active: 1, exhausted: { 0: 9e15, 1: 9e15 } };
  st.health = { 'opencode-go/mimo': { skipUntil: 9e15 }, 'openrouter/x': { skipUntil: 9e15 } };
  resetKeys(st);
  assert.deepEqual(st.keys, { active: 0, exhausted: {} });
  assert.deepEqual(Object.keys(st.health), ['openrouter/x']);
});
