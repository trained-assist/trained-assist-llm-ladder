import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { run, parseJson, upstreamRequest, sanitizeAppSlug, sanitizeAppTitle, MIN_TOKENS, REASONING_MIN_TOKENS, REASONING_MODELS, minTokensFor, keyFaultOf, KEY_QUOTA_TTL_MS, KEY_WEEKLY_TTL_MS, APP_REFERER_BASE, DEFAULT_APP_SLUG, DEFAULT_APP_TITLE, readOpenRouterKeys } from '../src/ladder.js';
import { handle } from '../src/handler.js';
import { memoryStore, backoffFor, rotateKey, emptyState, snapshot, resetKeys } from '../src/state.js';

const config = JSON.parse(fs.readFileSync(new URL('../config/ladders.json', import.meta.url)));
const LADDER = config.ladders.service.build; // primary key renamed in #49; 'deepseek' stays a legacy alias
const FREE = config.ladders.free.build;
const CONVERSATIONS = config.ladders.conversations.build;
const env = { OPENCODE_GO_API_KEYS: 'oc_a,oc_b', OPENROUTER_API_KEY: 'or_key' };
const short = m => m.replace(/^opencode-go\/|^openrouter\//, '');

// behaviour[model](ctx) → { status, content, finish?, usage? } | 'throw'
function fakeFetch(behaviour, calls) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const auth = init.headers.Authorization;
    calls.push({ url, model: body.model, auth, session: init.headers['x-opencode-session'], body });
    const r = (behaviour[body.model] || (() => ({ status: 200, content: 'ok' })))({ auth, body });
    if (r === 'throw') throw new Error('network down');
    const data = r.status === 200 ? { id: 'x', object: 'chat.completion', choices: [{ finish_reason: r.finish, message: { role: 'assistant', content: r.content } }], usage: r.usage || { prompt_tokens: 3 } } : null;
    return { ok: r.status === 200, status: r.status, json: async () => data, text: async () => r.error || '' };
  };
}
const msg = { model: 'deepseek', messages: [{ role: 'user', content: 'hi' }] };

// Floor/diag assertions are pinned to EXPLICIT rung ids — never to LADDER[0]: #39 reordered the
// real deepseek ladder (space-bunny-free first) and that alone turned the previous version of
// these tests red (#40 → CI fail), and #67 reordered it again (mimo first). DIAG_REASONING is
// measured reasoning → 3000 floor; DIAG_SECOND exists only so the failover half of the diag tests
// has a stable second rung.
const DIAG_REASONING = 'opencode-go/mimo-v2.6-flash';
const DIAG_SECOND = 'opencode-go/deepseek-v4.1-flash';
const DIAG_CFG = { ...config, ladders: { ...config.ladders, service: { build: [DIAG_REASONING, DIAG_SECOND] } } }; // keyed by the canonical name — rungsFor resolves 'deepseek' → 'service' (#49)

test('config: #67 Pareto-first — Go mimo opens, free ×8 in the tail, paid last (#36/#42 economics kept)', () => {
  assert.deepEqual(LADDER, [
    'opencode-go/mimo-v2.6-flash',
    'opencode-go/space-bunny-free',
    'opencode-go/longcat-2.5-preview-free',
    'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
    'openrouter/inclusionai/ling-3.0-flash-sante:free',
    'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
    'openrouter/cohere/north-mini-code:free',
    'openrouter/dots-studio/dots-3-note-preview:free',
    'openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    'openrouter/inclusionai/ling-3.0-flash',
    'openrouter/xiaomi/mimo-v2.6-flash',
  ]);
  assert.ok(LADDER.every(m => !m.startsWith('opencode-zen/')), 'zen rungs left deepseek for free (#42)');
  for (const role of ['build', 'plan', 'explore', 'general', 'review']) {
    assert.deepEqual(config.ladders.service[role], LADDER, role);
  }
  const paid = m => m.startsWith('openrouter/') && !m.endsWith(':free');
  const firstPaid = LADDER.findIndex(paid);
  assert.ok(firstPaid === 9, 'paid OpenRouter only after Go mimo and all eight free rungs');
  assert.ok(LADDER.slice(firstPaid).every(paid), 'paid OpenRouter rungs only at the tail');
  const firstGoPaid = LADDER.findIndex(m => m.startsWith('opencode-go/') && !m.endsWith('-free'));
  assert.ok(firstGoPaid === 0, 'Pareto-first: the Go subscription rung opens the ladder (#67)');
  const firstFree = LADDER.findIndex(m => m.endsWith('-free') || m.endsWith(':free'));
  assert.ok(firstFree === 1 && LADDER.slice(1, 9).every(m => m.endsWith('-free') || m.endsWith(':free')),
    'the eight free rungs sit in the tail before paid — a Go limit incident still stops there (#36)');
});

// #42 (owner): zen lives in the free ladder only — and at its TAIL: the relay answers 404, so in
// front of the 14 working rungs it would poison the main free fallback (trained-assist-agent#1899)
// with four dead steps. This pin is what keeps zen out of deepseek and out of the free head.
test('config: free = 13 working rungs + zen tail (#42)', () => {
  assert.deepEqual(FREE, [
    'opencode-go/deepseek-v4-flash',
    'opencode-go/longcat-2.5-preview-free',
    'opencode-go/qwen3.8-flash',
    'opencode-go/mimo-v2.6-flash',
    'opencode-go/deepseek-flash',
    'opencode-go/glm-5.3-flash',
    'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
    'openrouter/inclusionai/ling-3.0-flash-sante:free',
    'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
    'openrouter/cohere/north-mini-code:free',
    'openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    'openrouter/poolside/laguna-xs-2.1:free',
    'openrouter/dots-studio/dots-3-note-preview:free',
    'opencode-zen/mimo-v2.6-flash-free',
    'opencode-zen/mimo-v2.5-free',
    'opencode-zen/big-pickle',
    'opencode-zen/nemotron-3.5-lightning-free',
  ]);
  assert.equal(FREE.length, 17, '13 working rungs + 4 zen');
  assert.deepEqual(FREE.slice(13), [
    'opencode-zen/mimo-v2.6-flash-free',
    'opencode-zen/mimo-v2.5-free',
    'opencode-zen/big-pickle',
    'opencode-zen/nemotron-3.5-lightning-free',
  ], 'zen is the tail — never ahead of a working rung while the relay is 404');
  assert.ok(FREE.slice(0, 13).every(m => !m.startsWith('opencode-zen/')), 'the working head stays zen-free');
  assert.deepEqual(config.ladders.free, { build: FREE }, 'free is the build-role ladder');
});

test('first Go rung answers; Go gets the session header, non-stream, reasoning-safe max_tokens', async () => {
  const calls = [];
  const r = await run({ ...msg, max_tokens: 5 }, { env, config, store: memoryStore(2), fetchImpl: fakeFetch({}, calls) });
  assert.equal(r.ok, true);
  assert.equal(r.model, LADDER[0]);
  assert.match(calls[0].url, /opencode\.ai\/zen\/go\/v1\/chat\/completions$/);
  assert.ok(calls[0].session);
  assert.equal(calls[0].body.stream, false);
  // #38: the caller's 5 is raised to THIS rung's floor — assert the clamp logic, not the identity
  // of whatever the ladder orders first (identity is test 'reasoning-модель получает 3000…').
  assert.equal(calls[0].body.max_tokens, minTokensFor(LADDER[0]), 'floor follows the first rung class');
  assert.ok(calls[0].body.max_tokens >= MIN_TOKENS, 'caller max_tokens=5 is raised to at least the common floor');
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

// ── #34: guard failures carry finish_reason + usage so chronic empty answers are diagnosable ───
// usage mirrors the real failure at the #38 floor: reasoning ate all 3000 tokens, content empty.
const EMPTY_USAGE = { prompt_tokens: 840, completion_tokens: 3000, completion_tokens_details: { reasoning_tokens: 3000 } };
const EMPTY_DIAG = 'finish=length, out=3000, reasoning=3000, prompt=840, max_tokens=3000';

test('empty answer error carries finish_reason + usage — reasoning eating the floor is visible', async () => {
  const beh = { [short(DIAG_REASONING)]: () => ({ status: 200, content: '', finish: 'length', usage: EMPTY_USAGE }) };
  const r = await run(msg, { env, config: DIAG_CFG, store: memoryStore(2), fetchImpl: fakeFetch(beh, []) });
  assert.equal(r.ok, true, 'the ladder still fails over to the next rung');
  const err = r.attempts.find(a => a.outcome === 'error').error;
  assert.ok(err.startsWith(`empty answer (${EMPTY_DIAG})`), `prefix match on the diag, got: ${err}`);
});

test('invalid JSON error carries finish_reason + usage too (#34)', async () => {
  const beh = {
    [short(DIAG_REASONING)]: () => ({ status: 200, content: 'not json', finish: 'length', usage: EMPTY_USAGE }),
    [short(DIAG_SECOND)]: () => ({ status: 200, content: '```json\n{"ok":true}\n```' }),
  };
  const r = await run({ ...msg, response_format: { type: 'json_object' } }, { env, config: DIAG_CFG, store: memoryStore(2), fetchImpl: fakeFetch(beh, []) });
  assert.equal(r.ok, true);
  const err = r.attempts.find(a => a.outcome === 'error').error;
  assert.ok(err.startsWith(`invalid JSON (${EMPTY_DIAG})`), `prefix match on the diag, got: ${err}`);
});

test('#34: diag token counts are never read as key faults or quota — instrumentation cannot move the ladder', async () => {
  // usage numbers chosen to collide with the classifiers on purpose: 429/401/503
  const usage = { prompt_tokens: 429, completion_tokens: 401, completion_tokens_details: { reasoning_tokens: 503 } };
  const beh = { [short(DIAG_REASONING)]: () => ({ status: 200, content: '', finish: 'length', usage }) };
  const store = memoryStore(2);
  const r = await run(msg, { env, config: DIAG_CFG, store, fetchImpl: fakeFetch(beh, []) });
  assert.ok(r.attempts.find(a => a.outcome === 'error').error.includes('prompt=429'), 'the numbers are still logged');
  assert.equal(r.attempts.filter(a => a.outcome === 'key-rotated').length, 0, 'no key rotation from usage numbers');
  assert.equal(store.state.keys.active, 0, 'key state untouched');
  assert.equal(r.attempts.filter(a => a.outcome === 'key-probe').length, 1, 'still exactly one non-key probe');
  assert.equal(store.state.health[DIAG_REASONING].class, 'transient', 'empty answer stays transient, not quota');
});

// ── #45: a completed-but-guard-failed answer gets ONE same-rung retry before the ladder moves ──
test('guard-fail → one same-rung retry: recovery keeps the rung (no hop, no health-skip), a second fail moves down', async () => {
  // flake #1 only: the retry answers → the rung keeps serving, nothing is recorded against it
  let calls = 0;
  const store = memoryStore(2);
  const beh = { [short(LADDER[0])]: () => (++calls === 1
    ? { status: 200, content: '', finish: 'length', usage: EMPTY_USAGE }
    : { status: 200, content: '{"ok":true}' }) };
  const r = await run({ ...msg, response_format: { type: 'json_object' } }, { env, config, store, fetchImpl: fakeFetch(beh, []) });
  assert.equal(r.ok, true);
  assert.equal(r.model, LADDER[0], 'retried rung answered — no hop down the ladder');
  assert.ok(r.attempts.some(a => a.outcome === 'guard-retry'), 'the retry is visible in attempts (flake rate stays measurable)');
  assert.ok(!r.attempts.some(a => a.outcome === 'error'), 'a recovered flake never surfaces as an error');
  assert.equal(store.state.health[LADDER[0]], undefined, 'no health-skip — one flake must not punish other callers');

  // flake #2 both attempts empty → exactly one retry, then the ladder descends and the failure IS recorded
  const store2 = memoryStore(2);
  const beh2 = {
    [short(LADDER[0])]: () => ({ status: 200, content: '', finish: 'length', usage: EMPTY_USAGE }),
    [short(LADDER[1])]: () => ({ status: 200, content: '{"ok":true}' }),
  };
  const r2 = await run({ ...msg, response_format: { type: 'json_object' } }, { env, config, store: store2, fetchImpl: fakeFetch(beh2, []) });
  assert.equal(r2.ok, true);
  assert.equal(r2.model, LADDER[1], 'a persistent guard-fail still moves down the ladder');
  assert.equal(r2.attempts.filter(a => a.outcome === 'guard-retry').length, 1, 'exactly one retry per rung');
  assert.ok(r2.attempts.some(a => a.outcome === 'error'), 'the rung still reports the failure');
  assert.ok(store2.state.health[LADDER[0]], 'persistent guard-fail is recorded in shared health');
});

// ── #38: the max_tokens floor is per-rung — 3000 for the empirical REASONING_MODELS list, 1500 for the rest ─
test('reasoning-модель получает 3000, обычная — 1500', async () => {
  // every rung of the empirical list clamps to REASONING_MIN_TOKENS (caller asking for less is raised)
  // zen rungs build their request only with the relay token present (keyless → null), so give it one
  const envZ = { ...env, OPENCODE_ZEN_RELAY_TOKEN: 'zr_t' };
  for (const m of REASONING_MODELS) {
    assert.equal(upstreamRequest(envZ, m, { messages: [] }, 0).body.max_tokens, REASONING_MIN_TOKENS, m);
  }
  // #42: the four zen rungs are IN the list — the loop above only proves the list clamps, so pin
  // the zen ids explicitly; dropping one must fail here, not in prod
  for (const z of ['opencode-zen/mimo-v2.6-flash-free', 'opencode-zen/mimo-v2.5-free', 'opencode-zen/nemotron-3.5-lightning-free', 'opencode-zen/big-pickle']) {
    assert.ok(REASONING_MODELS.includes(z), `${z} must stay in REASONING_MODELS`);
    assert.equal(minTokensFor(z), REASONING_MIN_TOKENS, z);
    assert.equal(upstreamRequest(envZ, z, { messages: [] }, 0).body.max_tokens, REASONING_MIN_TOKENS, z);
  }
  // a rung outside the list keeps the common floor
  const plain = 'openrouter/google/gemini-2.5-flash-lite';
  assert.ok(!REASONING_MODELS.includes(plain));
  assert.equal(upstreamRequest(env, plain, { messages: [] }, 0).body.max_tokens, MIN_TOKENS);
  assert.equal(minTokensFor(plain), MIN_TOKENS);
  // a caller-supplied max_tokens higher than the rung floor still wins
  assert.equal(upstreamRequest(env, plain, { messages: [], max_tokens: 4000 }, 0).body.max_tokens, 4000);
  assert.equal(upstreamRequest(env, 'opencode-go/mimo-v2.6-flash', { messages: [], max_tokens: 4000 }, 0).body.max_tokens, 4000);

  // the #34 guard diagnostic prints the floor that ACTUALLY went upstream, per rung class
  const reasoningRung = await run(msg, { env, config: DIAG_CFG, store: memoryStore(2), fetchImpl: fakeFetch({ [short(DIAG_REASONING)]: () => ({ status: 200, content: '', finish: 'length', usage: EMPTY_USAGE }) }, []) });
  const rErr = reasoningRung.attempts.find(a => a.outcome === 'error').error;
  assert.ok(rErr.includes('max_tokens=3000'), `reasoning rung → max_tokens=3000 in the diag, got: ${rErr}`);
  const plainRung = await run({ ...msg, model: 'research:explore' }, {
    env, config, store: memoryStore(2), pinRung: plain,
    fetchImpl: fakeFetch({ 'google/gemini-2.5-flash-lite': () => ({ status: 200, content: '', finish: 'length', usage: { prompt_tokens: 9, completion_tokens: 1500 } }) }, []),
  });
  const pErr = plainRung.attempts.find(a => a.outcome === 'error').error;
  assert.ok(pErr.includes('max_tokens=1500'), `plain rung → max_tokens=1500 in the diag, got: ${pErr}`);
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
  assert.equal(r2.model, LADDER[2], 'spare already used → the ladder moves on to the next rung (no second probe)');
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

// #69: the weekly limit must NOT take the free Go rungs down with the paid ones — they don't
// consume the allowance, and the incident is exactly when the free head has to keep serving.
test('every key limited → paid Go rungs parked, free Go rungs keep serving (#69)', async () => {
  const beh = {};
  for (const m of LADDER) if (m.startsWith('opencode-go/') && !m.endsWith('-free')) beh[short(m)] = () => ({ status: 429, error: 'usage limit' });
  const store = memoryStore(2);
  const calls = [];
  const r = await run(msg, { env, config, store, fetchImpl: fakeFetch(beh, calls) });
  // service = [mimo, space-bunny, longcat, OR…]: mimo burns both keys → paid Go parked,
  // yet the free Go rung right behind it answers in the SAME call
  assert.equal(r.model, 'opencode-go/space-bunny-free', 'free Go serves while every key is limited');
  assert.ok(store.state.health['opencode-go/mimo-v2.6-flash'], 'paid Go rung is parked');
  assert.equal(store.state.health['opencode-go/space-bunny-free'], undefined, 'free Go rung is never parked');
  assert.deepEqual(calls.filter(c => c.url.includes('opencode.ai')).map(c => c.model),
    ['mimo-v2.6-flash', 'mimo-v2.6-flash', 'space-bunny-free'],
    'paid rung once per key, then the free rung on the last key');
  // next call: paid Go still parked → the free rung is the head that answers
  const calls2 = [];
  const r2 = await run(msg, { env, config, store, fetchImpl: fakeFetch({}, calls2) });
  assert.equal(r2.model, 'opencode-go/space-bunny-free');
  // window lapses → the normal head (paid Go) is back, without any manual step
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

test('config: research is split by role — Go reads first, paid Gemini tail (owner 2026-09-30, issue #28)', () => {
  const reader = ['opencode-go/mimo-v2.6-flash', 'opencode-go/deepseek-v4.1-flash', 'openrouter/google/gemini-2.5-flash-lite'];
  const thinker = ['opencode-go/mimo-v2.6-flash', 'opencode-go/deepseek-v4.1-flash', 'openrouter/xiaomi/mimo-v2.6-flash'];
  assert.deepEqual(config.ladders.research.explore, reader);
  for (const role of ['build', 'plan', 'general', 'review']) assert.deepEqual(config.ladders.research[role], thinker, role);
  assert.ok(!JSON.stringify(config.ladders.research).includes('gemini-2.5-pro'), 'no 2.5-pro in research');
});

test('config: conversations = hh-skill writing — gemini-3.1-flash-lite-preview first (owner 2026-10-01)', () => {
  const expected = [
    'openrouter/google/gemini-3.1-flash-lite-preview',
    'openrouter/google/gemini-2.5-flash',
    'opencode-go/mimo-v2.6-flash',
  ];
  assert.deepEqual(CONVERSATIONS, expected);
  assert.deepEqual(config.ladders.conversations, { build: expected }, 'conversations is the build-role ladder');
});

// #71 (owner 2026-10-02, уточнение №2): уровень = отдельная лестница, «нет эскалации — это не
// задача лестницы, задача лестницы ретраи». Лестницы-уровни: build (base free ×3 + платный хвост,
// без mimo), build advanced (mimo + платный хвост), plan/general/review = advanced-first,
// explore = big-ctx only, picture* = гемини-стек (multimodal 1M), free_100percent = только
// бесплатное ($0-потолок для тяжёлых тестов). Два конструктора: single-model профили API
// (service/conversations — как есть) и сборка из четырёх лестниц для opencode (профили
// free_100percent / master / advanced).
test('config: tier ladders — build=base, build advanced=mimo, picture gemini, free_100percent $0 (#71)', () => {
  const paid = [
    'openrouter/inclusionai/ling-3.0-flash',
    'openrouter/xiaomi/mimo-v2.6-flash',
  ];
  const base = [
    'opencode-go/space-bunny-free',
    'opencode-go/longcat-2.5-preview-free',
    'openrouter/inclusionai/ling-3.0-flash-sante:free',
  ];
  const advanced = ['opencode-go/mimo-v2.6-flash', ...paid];

  assert.deepEqual(config.ladders.build.build, [...base, ...paid], 'build = base free ×3 + платный хвост, без mimo');
  assert.deepEqual(config.ladders['build advanced'].build, advanced, 'build advanced = mimo + платный хвост');
  for (const role of ['plan', 'general', 'review']) {
    assert.deepEqual(config.ladders[role], { build: advanced }, `${role} advanced-first — роль=лестница (#71)`);
  }

  // explore: контексты замерены по OpenRouter /v1/models 2026-10-02 — mimo 1M,
  // gemini-2.5-flash-lite 1048576, xiaomi mimo 1050000; ling-3.0-flash = 262144 и не годится.
  const explore = config.ladders.explore.build;
  assert.deepEqual(explore, [
    'opencode-go/mimo-v2.6-flash',
    'openrouter/google/gemini-2.5-flash-lite',
    'openrouter/xiaomi/mimo-v2.6-flash',
  ], 'explore = big-ctx only (1M+), tail follows research:explore #28');
  assert.ok(!JSON.stringify(explore).includes('ling-3.0-flash'), 'ling 256k must not enter explore');

  // picture: всё multimodal image+text, 1M (замер архитектуры OpenRouter 02.10)
  assert.deepEqual(config.ladders.picture.build, [
    'openrouter/google/gemini-2.5-flash-lite',
    'openrouter/google/gemini-2.5-flash',
  ], 'picture = gemini base (0.10/0.40 → 0.30/2.50)');
  assert.deepEqual(config.ladders['picture advanced'].build, [
    'openrouter/google/gemini-2.5-flash',
    'openrouter/google/gemini-3.8-flash',
  ], 'picture advanced = gemini advanced (0.30/2.50 → 0.75/3.75)');

  // free_100percent: потолок $0 — ни подписки, ни платного (для тестов с объёмом/повторами)
  const f100 = config.ladders.free_100percent.build;
  assert.equal(f100.length, 8, 'eight free rungs');
  assert.ok(f100.every(m => m.endsWith('-free') || m.endsWith(':free')), 'every rung is $0');
  assert.ok(!f100.some(m => m === 'opencode-go/mimo-v2.6-flash'), 'no subscription rung');
  assert.ok(!f100.some(m => m.startsWith('openrouter/') && !m.endsWith(':free')), 'no paid rung');

  assert.ok(!JSON.stringify(config.ladders.build).includes('opencode-zen/'), 'zen stays out (#42)');
  assert.ok(!JSON.stringify(config.ladders.build).includes('nemotron-3-ultra'), 'ultra:free is flaky — not in build base');
  // контракт #67 не тронут
  assert.equal(config.ladders.service.build[0], 'opencode-go/mimo-v2.6-flash', 'service stays Pareto-first');
});

test('ladder: conversations walks top-down — 3.1-flash-lite-preview answers, 2.5-flash only on its failure', async () => {
  const calls = [];
  const beh = { [short(CONVERSATIONS[0])]: () => ({ status: 500, error: 'boom' }) };
  const r = await run({ model: 'conversations', messages: [{ role: 'user', content: 'hi' }] },
    { env, config, store: memoryStore(2), fetchImpl: fakeFetch(beh, calls) });
  assert.equal(r.ok, true);
  assert.equal(r.model, CONVERSATIONS[1]);
  // upstream sees the provider prefix stripped (openrouter/ is routing, not part of the id)
  assert.deepEqual(calls.map(c => c.model), [short(CONVERSATIONS[0]), short(CONVERSATIONS[1])]);
});

test('ladder: conversations ladder_rung pins the requested model without failover (model switch / bench)', async () => {
  const calls = [];
  const r = await run({ model: 'conversations', messages: [{ role: 'user', content: 'hi' }] },
    { env, config, store: memoryStore(2), fetchImpl: fakeFetch({}, calls), pinRung: CONVERSATIONS[1] });
  assert.equal(r.ok, true);
  assert.equal(r.model, CONVERSATIONS[1]);
  assert.equal(calls.length, 1, 'pinned rung, no walk');
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

// ── OpenRouter app attribution (#33) ───────────────────────────────────────────────────────────
test('upstreamRequest: HTTP-Referer / X-OpenRouter-Title / Visibility only on openrouter/* rungs', () => {
  const or = upstreamRequest(env, 'openrouter/deepseek/deepseek-v4-flash-0731', msg, 0, { appSlug: 'hh-messages', appTitle: 'HH Messages' });
  assert.equal(or.headers['HTTP-Referer'], `${APP_REFERER_BASE}/hh-messages`);
  assert.equal(or.headers['X-OpenRouter-Title'], 'HH Messages');
  assert.equal(or.headers['X-OpenRouter-App-Visibility'], 'hidden');

  const go = upstreamRequest(env, 'opencode-go/mimo-v2.6-flash', msg, 0, { appSlug: 'hh-messages', appTitle: 'HH Messages' });
  for (const h of ['HTTP-Referer', 'X-OpenRouter-Title', 'X-OpenRouter-App-Visibility']) {
    assert.equal(go.headers[h], undefined, `${h} must not be sent to Go`);
  }
});

test('app attribution defaults: no slug → llm-ladder, no title → Trained Assist (openrouter only)', () => {
  const or = upstreamRequest(env, 'openrouter/x/y', msg, 0, {});
  assert.equal(or.headers['HTTP-Referer'], `${APP_REFERER_BASE}/${DEFAULT_APP_SLUG}`);
  assert.equal(or.headers['X-OpenRouter-Title'], DEFAULT_APP_TITLE);
  assert.equal(or.headers['X-OpenRouter-App-Visibility'], 'hidden');
});

// ── OPENROUTER_KEYS_JSON — per-app key selection ────────────────────────────────────────
test('readOpenRouterKeys: returns null when env var absent', () => {
  assert.equal(readOpenRouterKeys({}), null);
});

test('readOpenRouterKeys: returns null on invalid JSON', () => {
  assert.equal(readOpenRouterKeys({ OPENROUTER_KEYS_JSON: 'not-json' }), null);
});

test('readOpenRouterKeys: parses valid JSON map', () => {
  const keys = readOpenRouterKeys({ OPENROUTER_KEYS_JSON: '{"hh-skill":"sk-hh","*":"sk-default"}' });
  assert.equal(keys['hh-skill'], 'sk-hh');
  assert.equal(keys['*'], 'sk-default');
});

test('upstreamRequest: picks key by appSlug from OPENROUTER_KEYS_JSON', () => {
  const keysEnv = { ...env, OPENROUTER_KEYS_JSON: '{"hh-skill":"sk-hh","agent":"sk-agent","*":"sk-default"}' };
  const r = upstreamRequest(keysEnv, 'openrouter/x/y', msg, 0, { appSlug: 'hh-skill' });
  assert.equal(r.headers.Authorization, 'Bearer sk-hh');
});

test('upstreamRequest: falls back to "*" default key when slug not in map', () => {
  const keysEnv = { ...env, OPENROUTER_KEYS_JSON: '{"hh-skill":"sk-hh","*":"sk-default"}' };
  const r = upstreamRequest(keysEnv, 'openrouter/x/y', msg, 0, { appSlug: 'unknown' });
  assert.equal(r.headers.Authorization, 'Bearer sk-default');
});

test('upstreamRequest: falls back to OPENROUTER_API_KEY when OPENROUTER_KEYS_JSON has no match and no "*"', () => {
  const keysEnv = { ...env, OPENROUTER_KEYS_JSON: '{"hh-skill":"sk-hh"}' };
  const r = upstreamRequest(keysEnv, 'openrouter/x/y', msg, 0, { appSlug: 'agent' });
  assert.equal(r.headers.Authorization, 'Bearer or_key');
});

test('upstreamRequest: OPENROUTER_KEYS_JSON does not affect Go or zen rungs', () => {
  const keysEnv = { ...env, OPENROUTER_KEYS_JSON: '{"hh-skill":"sk-hh"}' };
  const go = upstreamRequest(keysEnv, 'opencode-go/mimo-v2.6-flash', msg, 0, { appSlug: 'hh-skill' });
  assert.equal(go.headers.Authorization, 'Bearer oc_a');
  const zen = upstreamRequest({ ...keysEnv, OPENCODE_ZEN_RELAY_TOKEN: 'zr_t' }, 'opencode-zen/mimo-v2.6-flash-free', msg, 0, { appSlug: 'hh-skill' });
  assert.equal(zen.headers.Authorization, 'Bearer zr_t');
});

test('sanitize: garbage slug falls back to llm-ladder (never a half-repaired one)', () => {
  assert.equal(sanitizeAppSlug('gtd-intent'), 'gtd-intent');
  assert.equal(sanitizeAppSlug(' HH-Messages '), 'hh-messages');
  for (const junk of ['', '  ', 'привет', 'a b', 'a/b', '../../etc/passwd', 'a'.repeat(65), 'a_b', 'a\nb']) {
    assert.equal(sanitizeAppSlug(junk), DEFAULT_APP_SLUG, JSON.stringify(junk));
  }
  assert.equal(sanitizeAppSlug(null), DEFAULT_APP_SLUG);
  assert.equal(sanitizeAppTitle(''), DEFAULT_APP_TITLE);
  assert.equal(sanitizeAppTitle(null), DEFAULT_APP_TITLE);
  assert.equal(sanitizeAppTitle('My\x00Tool\n '), 'MyTool');
});

test('run() threads appSlug/appTitle down to the OpenRouter upstream; Go stays clean', async () => {
  const beh = { [short(LADDER[0])]: () => ({ status: 500, error: 'boom' }), [short(LADDER[1])]: () => ({ status: 500, error: 'boom' }) };
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const body = JSON.parse(init.body);
    return { ok: false, status: 500, text: async () => (beh[body.model] ? beh[body.model]().error : 'x') };
  };
  await run(msg, { env, config, store: memoryStore(2), fetchImpl: f, appSlug: 'gtd-intent', appTitle: 'GTD Intent' });
  const go = calls.filter(c => c.url.includes('opencode.ai'));
  const or = calls.filter(c => c.url.includes('openrouter.ai'));
  assert.ok(go.length >= 2 && or.length >= 1, 'walked Go rungs then OpenRouter');
  assert.equal(go[0].headers['HTTP-Referer'], undefined);
  assert.equal(or[0].headers['HTTP-Referer'], `${APP_REFERER_BASE}/gtd-intent`);
  assert.equal(or[0].headers['X-OpenRouter-Title'], 'GTD Intent');
  assert.equal(or[0].headers['X-OpenRouter-App-Visibility'], 'hidden');
});

// ── Zen free tier via relay (#36) ────────────────────────────────────────────────────────────────
const zenv = { ...env, OPENCODE_ZEN_RELAY_TOKEN: 'zr_t', OPENCODE_ZEN_BASE_URL: 'https://relay.test/zen' };

test('zen upstreamRequest: relay URL + relay token, no OpenRouter attribution, model prefix stripped', () => {
  const r = upstreamRequest(zenv, 'opencode-zen/mimo-v2.6-flash-free', { ...msg, response_format: { type: 'json_object' } }, 0, { appSlug: 'hh-messages' });
  assert.equal(r.url, 'https://relay.test/zen/chat/completions');
  assert.equal(r.headers.Authorization, 'Bearer zr_t');
  assert.equal(r.body.model, 'mimo-v2.6-flash-free');
  assert.equal(r.body.stream, false);
  for (const h of ['HTTP-Referer', 'X-OpenRouter-Title', 'X-OpenRouter-App-Visibility']) {
    assert.equal(r.headers[h], undefined, `${h} must not be sent to the zen relay`);
  }
  assert.equal(r.headers['x-opencode-session'], undefined, 'zen has its own session fingerprint');
  assert.ok(r.body.response_format, 'response_format passes through to the relay');

  const conv = upstreamRequest(zenv, 'opencode-zen/big-pickle', msg, 0, { conversation: 'conv-42' });
  assert.equal(conv.headers['x-session-id'], 'conv-42', 'conversation id goes to the relay for ses_ derivation');
});

// #42 (owner): zen left deepseek for the free ladder TAIL, so the live deepseek walk no longer
// contains a zen rung. The relay mechanics below are what matter here — pin them to an explicit
// config (the DIAG_CFG pattern) instead of to LADDER[0]/LADDER[1].
const ZEN_WALK = [
  'opencode-go/space-bunny-free',
  'opencode-go/longcat-2.5-preview-free',
  'opencode-zen/mimo-v2.6-flash-free',
  'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
];
const ZEN_CFG = { ...config, ladders: { ...config.ladders, service: { build: ZEN_WALK } } }; // canonical key — rungsFor resolves 'deepseek' → 'service' (#49)
const zenGoFail = () => ({
  [short(ZEN_WALK[0])]: () => ({ status: 500, error: 'boom' }),
  [short(ZEN_WALK[1])]: () => ({ status: 500, error: 'boom' }),
});

test('zen rung without OPENCODE_ZEN_RELAY_TOKEN is skipped; with it the relay answers', async () => {
  // no token → hasKey filters every zen rung out: the walk goes Go → (zen absent) → OpenRouter
  const beh = zenGoFail();
  const noTok = [];
  const r0 = await run(msg, { env, config: ZEN_CFG, store: memoryStore(2), fetchImpl: fakeFetch(beh, noTok) });
  assert.equal(r0.model, 'openrouter/nvidia/nemotron-3-super-120b-a12b:free', 'unconfigured zen → OpenRouter free tier');
  assert.ok(noTok.every(c => !c.url.includes('sslip.io')), 'no relay calls without the token');

  // token present → the third rung (first zen) serves after both Go-free rungs fail
  const calls = [];
  const r1 = await run(msg, { env: zenv, config: ZEN_CFG, store: memoryStore(2), fetchImpl: fakeFetch(beh, calls) });
  assert.equal(r1.ok, true);
  assert.equal(r1.model, 'opencode-zen/mimo-v2.6-flash-free');
  const zenCall = calls[calls.length - 1];
  assert.equal(zenCall.url, 'https://relay.test/zen/chat/completions');
  assert.equal(zenCall.auth, 'Bearer zr_t');
  assert.equal(zenCall.body.model, 'mimo-v2.6-flash-free');
});

test('zen failures skip the rung for everyone (shared health), same as any provider', async () => {
  const beh = {
    ...zenGoFail(),
    'mimo-v2.6-flash-free': () => ({ status: 429, error: 'Rate limit exceeded. Please try again later.' }),
  };
  const store = memoryStore(2);
  const r = await run(msg, { env: zenv, config: ZEN_CFG, store, fetchImpl: fakeFetch(beh, []) });
  assert.equal(r.ok, true, 'walked past the limited zen rung');
  assert.equal(r.model, 'openrouter/nvidia/nemotron-3-super-120b-a12b:free', 'the ladder continues past the parked zen rung');
  const h = store.state.health['opencode-zen/mimo-v2.6-flash-free'];
  assert.ok(h && h.skipUntil > Date.now(), 'the limited zen rung is parked in shared health');
});

test('route: x-ladder-app / x-ladder-app-title headers are sanitised and forwarded to run()', async () => {  const ENV = { LADDER_TOKEN: 't', OPENCODE_GO_API_KEYS: 'oc_a,oc_b', OPENROUTER_API_KEY: 'or_key' };
  const seen = [];
  const f = async (url, init) => {
    seen.push({ url, headers: init.headers });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }), text: async () => '' };
  };
  const post = (headers) => handle(new Request('https://l.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer t', ...headers },
    body: JSON.stringify({ model: 'deepseek', ladder_rung: 'openrouter/xiaomi/mimo-v2.6-flash', messages: [{ role: 'user', content: 'hi' }] }),
  }), ENV, { store: memoryStore(0), fetchImpl: f });

  await post({ 'x-ladder-app': 'bg-Playbooks', 'x-ladder-app-title': 'Background Playbooks' });
  assert.equal(seen[0].headers['HTTP-Referer'], `${APP_REFERER_BASE}/bg-playbooks`);
  assert.equal(seen[0].headers['X-OpenRouter-Title'], 'Background Playbooks');

  await post({ 'x-ladder-app': 'GTD Intent/../../etc' });
  assert.equal(seen[1].headers['HTTP-Referer'], `${APP_REFERER_BASE}/${DEFAULT_APP_SLUG}`, 'garbage slug → default, not forwarded as-is');
  assert.equal(seen[1].headers['X-OpenRouter-Title'], DEFAULT_APP_TITLE);

  await post({});
  assert.equal(seen[2].headers['HTTP-Referer'], `${APP_REFERER_BASE}/${DEFAULT_APP_SLUG}`, 'no header → default slug');
  assert.equal(seen[2].headers['X-OpenRouter-App-Visibility'], 'hidden');
});
