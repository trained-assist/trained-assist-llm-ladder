import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/handler.js';
import { run } from '../src/ladder.js';
import { memoryStore } from '../src/state.js';
import {
  clampWaitMs, clampPullHoldMs, pullDecision, leaseExpired, leaseUsable,
  lambdaPerMin, inflightFrom, desiredWorkers, scaleDecision, shouldRotateOnResult, shouldRotateOnLocalStop,
  DEFAULT_WAIT_MS, MIN_WAIT_MS, MAX_WAIT_MS, DEFAULT_PULL_HOLD_MS,
  RING_CEILING, RING_RESERVE, RING_TTL_MS, SERVICE_MS_DEFAULT, BOOT_MS, BACKLOG_FACTOR,
  ringCooldown, ringInvoke, zenRingRegister, runMaintenance, ZEN_MAX_INPUT_BYTES, ZEN_MODEL_MAX_INPUT_BYTES,
  ZEN_RACE_MAX_INPUT_BYTES, ZEN_RACE_MODELS, raceModelsFor,
} from '../src/zen-ring.js';
import { STALE_TASK_MS } from '../src/zen-runner.js';
import { classifyError } from '../src/classify.js';

const ENV = { ZEN_RUNNER_TOKEN: 'zen-tok' };
const NOW = Date.UTC(2026, 9, 4, 10, 0, 0);
const auth = { authorization: 'Bearer zen-tok' };

// In-memory D1 double for the pool tables (plus the model/budget rows the invoke path touches).
// The claim UPDATE is guarded by `state='queued'` exactly like the real statement, so a racing
// poller that loses the race sees changes = 0 and gets no task.
function fakeD1(seed = {}) {
  const workers = new Map();
  const tasks = new Map();
  const models = new Map((seed.models || []).map((m) => [m.model, m]));
  const budget = new Map((seed.budget || []).map((b) => [`${b.scope}|${b.model}`, b]));
  const repos = new Map((seed.repos || []).map((r) => [r.repo, { enabled: 1, location: '', ...r }]));
  const dispatches = new Map();
  const meta = new Map(Object.entries(seed.meta || {}));

  const api = {
    _workers: workers, _tasks: tasks, _models: models, _budget: budget,
    _repos: repos, _dispatches: dispatches, _meta: meta,
    prepare(sql) {
      let bound = [];
      const stmt = {
        first: async () => first(sql, bound),
        all: async () => ({ results: all(sql, bound) }),
        run: async () => { return run_(sql, bound); },
        bind(...p) { bound = p; return stmt; },
      };
      return stmt;
    },
  };

  function first(sql, p) {
    if (/FROM zen_pool_workers WHERE id = \?1/.test(sql)) return workers.get(p[0]) || null;
    if (/FROM zen_pool_tasks WHERE id = \?1/.test(sql)) return tasks.get(p[0]) || null;
    if (/SELECT id FROM zen_pool_tasks WHERE state/.test(sql)) {
      const q = [...tasks.values()].filter((t) => t.state === p[0]).sort((a, b) => a.enqueued_at - b.enqueued_at)[0];
      return q ? { id: q.id } : null;
    }
    if (/FROM zen_models WHERE model = \?1/.test(sql)) return models.get(p[0]) || null;
    if (/FROM zen_budget WHERE scope/.test(sql)) return budget.get(`${p[0]}|${p[1]}`) || null;
    if (/COUNT\(\*\) AS n FROM zen_pool_tasks WHERE state = \?1 AND enqueued_at >= \?2/.test(sql)) {
      return { n: [...tasks.values()].filter((t) => t.state === p[0] && t.enqueued_at >= p[1]).length };
    }
    if (/COUNT\(\*\) AS n FROM zen_pool_tasks WHERE state/.test(sql)) return { n: [...tasks.values()].filter((t) => t.state === p[0]).length };
    if (/COUNT\(\*\) AS n FROM zen_pool_tasks WHERE enqueued_at/.test(sql)) return { n: [...tasks.values()].filter((t) => t.enqueued_at > p[0]).length };
    if (/COUNT\(\*\) AS n FROM zen_pool_dispatches/.test(sql)) return { n: [...dispatches.values()].filter((d) => d.requested_at > p[0]).length };
    if (/COUNT\(\*\) AS n FROM zen_pool_workers WHERE registered_at/.test(sql)) return { n: [...workers.values()].filter((w) => w.registered_at > p[0]).length };
    if (/FROM zen_meta WHERE k = \?1/.test(sql)) { const v = meta.get(p[0]); return v === undefined ? null : { v }; }
    return null;
  }
  function all(sql, p) {
    if (/FROM zen_pool_workers WHERE state = \?1 AND lease_expires_at/.test(sql)) {
      return [...workers.values()].filter((w) => w.state === p[0] && w.lease_expires_at > p[1]);
    }
    if (/FROM zen_repos WHERE enabled = 1/.test(sql)) return [...repos.values()].filter((r) => r.enabled);
    if (/FROM zen_pool_dispatches ORDER BY requested_at DESC/.test(sql)) {
      return [...dispatches.values()].sort((a, b) => b.requested_at - a.requested_at).slice(0, p[0]);
    }
    return [];
  }
  function run_(sql, p) {
    if (/DELETE FROM zen_pool_tasks WHERE state IN/.test(sql)) {
      const before = tasks.size;
      for (const [k, t] of [...tasks]) {
        if ((t.state === 'queued' || t.state === 'claimed') && t.enqueued_at < p[0]) tasks.delete(k);
      }
      return { success: true, meta: { changes: before - tasks.size } };
    }
    if (/INSERT INTO zen_pool_workers/.test(sql)) {
      const [id, workerId, repo, runId, attempt, egress, runner, node, idleExit, leaseExp, now] = p;
      workers.set(id, {
        id, worker_id: workerId, repo, run_id: runId, run_attempt: attempt, egress_ip: egress,
        runner_name: runner, node, state: 'live', tasks_served: 0, idle_exit_ms: idleExit,
        lease_expires_at: leaseExp, registered_at: now, last_seen_at: now,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (/UPDATE zen_pool_workers SET lease_expires_at/.test(sql)) {
      const w = workers.get(p[2]); if (w) { w.lease_expires_at = p[0]; w.last_seen_at = p[1]; }
      return { success: true, meta: { changes: w ? 1 : 0 } };
    }
    if (/UPDATE zen_pool_workers SET state = \?1, stop_reason/.test(sql)) {
      const w = workers.get(p[3]); if (w) { w.state = p[0]; w.stop_reason = p[1]; w.exited_at = p[2]; }
      return { success: true, meta: { changes: w ? 1 : 0 } };
    }
    if (/UPDATE zen_pool_workers SET tasks_served/.test(sql)) {
      const w = workers.get(p[1]); if (w) { w.tasks_served += 1; w.last_seen_at = p[0]; }
      return { success: true, meta: { changes: w ? 1 : 0 } };
    }
    if (/UPDATE zen_pool_workers SET state = 'stopping'/.test(sql)) {
      let n = 0;
      for (const w of workers.values()) if (w.worker_id === p[0] && w.state === 'live') { w.state = 'stopping'; n++; }
      return { success: true, meta: { changes: n } };
    }
    if (/UPDATE zen_pool_tasks SET state = \?1, worker_id = NULL/.test(sql)) {
      let n = 0;
      for (const t of tasks.values()) if (t.state === p[1] && t.claimed_at < p[2]) { t.state = p[0]; t.worker_id = null; t.lease_id = null; n++; }
      return { success: true, meta: { changes: n } };
    }
    if (/UPDATE zen_pool_tasks SET state = \?1, worker_id = \?2, lease_id = \?3, claimed_at/.test(sql)) {
      const t = tasks.get(p[4]);
      if (!t || t.state !== p[5]) return { success: true, meta: { changes: 0 } };
      t.state = p[0]; t.worker_id = p[1]; t.lease_id = p[2]; t.claimed_at = p[3];
      return { success: true, meta: { changes: 1 } };
    }
    if (/UPDATE zen_pool_tasks SET state = \?1, ok = \?2, text/.test(sql)) {
      const t = tasks.get(p[11]);
      if (t) { t.state = p[0]; t.ok = p[1]; t.text = p[2]; t.kind = p[3]; t.error = p[4]; t.provider_ms = p[5]; t.served_ms = p[6]; t.finished_at = p[7]; t.tool_calls = p[8]; t.usage = p[9]; t.finish_reason = p[10]; }
      return { success: true, meta: { changes: t ? 1 : 0 } };
    }
    if (/INSERT INTO zen_pool_tasks/.test(sql)) {
      const [id, model, prompt, messages, tools, maxTokens, waitMs, state, enqueued] = p;
      tasks.set(id, { id, model, prompt, messages, tools, max_tokens: maxTokens, wait_ms: waitMs, state, enqueued_at: enqueued });
      return { success: true, meta: { changes: 1 } };
    }
    if (/UPDATE zen_pool_tasks SET wait_returned_at/.test(sql)) {
      const t = tasks.get(p[1]); if (t) t.wait_returned_at = p[0];
      return { success: true, meta: { changes: t ? 1 : 0 } };
    }
    if (/UPDATE zen_pool_tasks SET state = 'abandoned'/.test(sql)) {
      const t = tasks.get(p[1]);
      if (t && t.state === 'queued') { t.state = 'abandoned'; return { success: true, meta: { changes: 1 } }; }
      return { success: true, meta: { changes: 0 } };
    }
    if (/INSERT INTO zen_models/.test(sql)) {
      const [model, status, failures, successes, err, kind, okAt, firstFailed, next, updated] = p;
      models.set(model, { model, status, failures, successes, last_error: err, last_error_kind: kind,
        last_ok_at: okAt, first_failed_at: firstFailed, next_check_at: next, updated_at: updated });
      return { success: true, meta: { changes: 1 } };
    }
    if (/INSERT INTO zen_budget/.test(sql)) {
      const [scope, model, now, d] = p;
      const prev = budget.get(`${scope}|${model}`);
      const freshMin = prev && now - prev.minute_at < 60_000;
      const sameDay = prev && prev.day === d;
      budget.set(`${scope}|${model}`, {
        scope, model,
        minute_count: freshMin ? prev.minute_count + 1 : 1,
        minute_at: freshMin ? prev.minute_at : now,
        day_count: sameDay ? prev.day_count + 1 : 1,
        day: d,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (/INSERT INTO zen_pool_dispatches/.test(sql)) {
      const [id, repo, reason, requestedAt, state] = p;
      dispatches.set(id, { id, repo, reason, requested_at: requestedAt, worker_id: null, state });
      return { success: true, meta: { changes: 1 } };
    }
    if (/INSERT INTO zen_meta/.test(sql)) {
      meta.set(p[0], p[1]);
      return { success: true, meta: { changes: 1 } };
    }
    return { success: true, meta: { changes: 0 } };
  }
  return api;
}

const env = (d1, extra = {}) => ({ ...ENV, ZEN_DB: d1, ZEN_NOW_MS: NOW, ...extra });
const post = (path, body, d1, extra = {}) =>
  handle(new Request(`https://l.test${path}`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), env(d1, extra));
const get = (path, d1, headers = auth) =>
  handle(new Request(`https://l.test${path}`, { headers }), env(d1));

test('rotation rule: only a spent address rotates; a transient one keeps the worker', () => {
  // daily = the ~1000-request per-IP quota is gone, provider = the bare 429 burst wall,
  // rate = the same wall without the provider marker. All three mean "this address is done".
  for (const kind of ['daily', 'provider', 'rate']) assert.equal(shouldRotateOnResult(kind), true);
  // timeout/error/context are transient or local: the address is still good, the worker stays.
  for (const kind of ['timeout', 'error', 'context', 'fingerprint', 'cooldown']) assert.equal(shouldRotateOnResult(kind), false);
  assert.equal(shouldRotateOnResult(null), false);
  assert.equal(shouldRotateOnLocalStop('local-budget'), true);
  assert.equal(shouldRotateOnLocalStop('local-rate'), false);
  assert.equal(shouldRotateOnLocalStop(null), false);
});

test('watchdog: default 30 s, caller-supplied, clamped to [1 s, 90 s]', () => {
  assert.equal(clampWaitMs(undefined), DEFAULT_WAIT_MS);
  assert.equal(DEFAULT_WAIT_MS, 30_000);
  assert.equal(clampWaitMs(500), MIN_WAIT_MS);
  assert.equal(clampWaitMs(600_000), MAX_WAIT_MS);
  assert.equal(clampWaitMs(45_000), 45_000);
  assert.equal(clampWaitMs('nonsense'), DEFAULT_WAIT_MS);
  assert.equal(clampPullHoldMs(undefined), DEFAULT_PULL_HOLD_MS);
  assert.equal(clampPullHoldMs(10), 5_000);
  assert.equal(clampPullHoldMs(999_999), 25_000);
});

test('pull decision: task wins, then stop, then idle, then wait, then a dead lease exits', () => {
  const task = { id: 't1' };
  assert.deepEqual(pullDecision({ leaseValid: true, stopRequested: false, idleMs: 0, idleExitMs: 600_000, task }),
    { action: 'task', task });
  assert.deepEqual(pullDecision({ leaseValid: true, stopRequested: true, idleMs: 0, idleExitMs: 600_000, task: null }),
    { action: 'exit', reason: 'stop_requested' });
  assert.deepEqual(pullDecision({ leaseValid: false, stopRequested: true, idleMs: 0, idleExitMs: 600_000 }),
    { action: 'exit', reason: 'stop_requested' });
  assert.deepEqual(pullDecision({ leaseValid: true, stopRequested: false, idleMs: 601_000, idleExitMs: 600_000 }),
    { action: 'exit', reason: 'idle_ttl' });
  assert.deepEqual(pullDecision({ leaseValid: true, stopRequested: false, idleMs: 10, idleExitMs: 600_000 }),
    { action: 'wait' });
  assert.deepEqual(pullDecision({ leaseValid: false, stopRequested: false, idleMs: 0, idleExitMs: 600_000 }),
    { action: 'exit', reason: 'lease_expired' });
});

test('lease expiry: a job that stopped pulling is gone, a stopped one is not silently reused', () => {
  assert.equal(leaseExpired(null, NOW), true);
  assert.equal(leaseExpired({ state: 'live', lease_expires_at: NOW - 1 }, NOW), true);
  assert.equal(leaseExpired({ state: 'live', lease_expires_at: NOW + 1 }, NOW), false);
  assert.equal(leaseUsable({ state: 'live', lease_expires_at: NOW + 1 }, NOW), true);
  assert.equal(leaseUsable({ state: 'stopping', lease_expires_at: NOW + 1 }, NOW), false);
  assert.equal(leaseUsable({ state: 'live', lease_expires_at: NOW - 1 }, NOW), false);
});

test('register -> pull -> result -> invoke: one job serves a call and the answer comes back in the HTTP response', async () => {
  const d1 = fakeD1();
  const reg = await post('/zen/pool/register', { worker_id: 'LLM-test:1:1', repo: 'vovalikessmoothy-png/LLM-test' }, d1);
  assert.equal(reg.status, 200);
  const lease = await reg.json();
  assert.ok(lease.lease_id);
  assert.equal(lease.pull_hold_ms, DEFAULT_PULL_HOLD_MS);

  // Nobody registered at all: the caller is told there is no warm runner instead of hanging.
  const empty = await post('/zen/pool/invoke', { model: 'nemotron-3.5-lightning-free', prompt: '2+4?' }, fakeD1());
  assert.equal(empty.status, 503);
  assert.match((await empty.json()).error, /no warm runner/);

  // The caller's request stays open while the job pulls — that is the whole protocol.
  const pending = post('/zen/pool/invoke', { model: 'nemotron-3.5-lightning-free', prompt: '2+4?' }, d1);
  await new Promise((r) => setTimeout(r, 50));
  const pulled = await get(`/zen/pool/pull?lease=${lease.lease_id}&hold_ms=5000`, d1);
  assert.equal(pulled.status, 200);
  const task = (await pulled.json()).task;
  assert.equal(task.model, 'nemotron-3.5-lightning-free');

  const health = await get('/zen/pool/health', d1, {});
  assert.equal(health.status, 200);
  assert.equal((await health.json()).workers_live, 1);

  const res = await post('/zen/pool/result', { task_id: task.id, ok: true, text: 'six', provider_ms: 2100, served_ms: 2300 }, d1);
  assert.equal(res.status, 200);

  const again = await pending;
  assert.equal(again.status, 200);
  const body = await again.json();
  assert.equal(body.text, 'six');
  assert.equal(body.ok, true);
  assert.equal(body.wait_ms, DEFAULT_WAIT_MS);
  assert.equal(body.served_ms, 2300);
});

test('watchdog: a slow answer returns 504 with a task_id, and the late answer is still fetchable', async () => {
  const d1 = fakeD1();
  const reg = await post('/zen/pool/register', { worker_id: 'LLM-test:2:1' }, d1);
  const lease = await reg.json();
  const pending = post('/zen/pool/invoke', { model: 'mimo-v2.6-flash-free', prompt: 'slow', wait_ms: 1000 }, d1);
  await new Promise((r) => setTimeout(r, 50));
  const pulled = await get(`/zen/pool/pull?lease=${lease.lease_id}&hold_ms=5000`, d1);
  const task = (await pulled.json()).task;

  const timedOut = await pending;
  assert.equal(timedOut.status, 504);
  const body = await timedOut.json();
  assert.equal(body.wait_ms, 1000);
  assert.equal(body.task_id, task.id);

  const res = await post('/zen/pool/result', { task_id: task.id, ok: true, text: 'finally', provider_ms: 40000 }, d1);
  assert.equal(res.status, 200);
  const late = await get(`/zen/pool/result/${task.id}`, d1);
  assert.equal(late.status, 200);
  assert.equal((await late.json()).text, 'finally');
});

// A FAILED answer is exactly the case that needs diagnosing — it was 45 % of production tasks and
// used to be written down as four NULLs (text/usage/finish_reason/tool_calls were all conditioned
// on `body.ok`), which is why `zen-rings: ok` could not be explained. The pool must hand the
// explanation to whoever asked, whether or not the answer counted as a success.
test('a failed result still carries finish_reason + usage + tool_calls — the diagnosis survives ok=false', async () => {
  const d1 = fakeD1();
  const reg = await post('/zen/pool/register', { worker_id: 'LLM-test:diag:1' }, d1);
  const lease = await reg.json();
  const pending = post('/zen/pool/invoke', { model: 'mimo-v2.6-flash-free', prompt: 'why empty?', wait_ms: 5000 }, d1);
  await new Promise((r) => setTimeout(r, 50));
  const pulled = await get(`/zen/pool/pull?lease=${lease.lease_id}&hold_ms=5000`, d1);
  const task = (await pulled.json()).task;

  const res = await post('/zen/pool/result', {
    task_id: task.id, ok: false, kind: 'ok',
    finish_reason: 'length', usage: { prompt_tokens: 840, completion_tokens: 0 },
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{}' } }],
    provider_ms: 900, error: '',
  }, d1);
  assert.equal(res.status, 200);

  const answer = await pending;
  assert.equal(answer.status, 502, 'a failed task still fails the invoke — this is not a success');
  const data = (await answer.json());
  assert.equal(data.ok, false);
  assert.equal(data.finish_reason, 'length', 'finish_reason reaches the ladder even though ok=false');
  assert.deepEqual(data.usage, { prompt_tokens: 840, completion_tokens: 0 }, 'usage reaches the ladder too');
  assert.equal(data.tool_calls[0].function.name, 'shell', 'a tool call is not thrown away with the failure');

  const late = await get(`/zen/pool/result/${task.id}`, d1);
  const row = await late.json();
  assert.equal(row.state, 'failed');
  assert.equal(row.finish_reason, 'length', 'the late-read path keeps the diagnosis as well');
  assert.deepEqual(row.usage, { prompt_tokens: 840, completion_tokens: 0 });
  assert.equal(row.tool_calls[0].function.name, 'shell');
});

test('stop: POST /zen/pool/stop makes the next pull say bye, so the job exits instead of idling', async () => {
  const d1 = fakeD1();
  const reg = await post('/zen/pool/register', { worker_id: 'LLM-test:3:1' }, d1);
  const lease = await reg.json();
  await get(`/zen/pool/pull?lease=${lease.lease_id}&hold_ms=5000`, d1);

  const stop = await post('/zen/pool/stop', { worker_id: 'LLM-test:3:1' }, d1);
  assert.equal(stop.status, 200);
  assert.equal((await stop.json()).stopped, true);

  const after = await get(`/zen/pool/pull?lease=${lease.lease_id}&hold_ms=5000`, d1);
  assert.equal(after.status, 200);
  const bye = await after.json();
  assert.deepEqual(bye.bye, true);
  assert.equal(bye.reason, 'stop_requested');
});

test('an explicit call is NOT blocked by the quarantine — only the budget is', async () => {
  // The quarantine answers "should we probe this model on a schedule", not "a caller named it
  // explicitly". Blocking the second call to a model that just answered is what made the live
  // smoke fail: one success put the model in `skip` for 6h and the pool refused the next call.
  const d1 = fakeD1({ models: [{ model: 'jev-1.13-free', status: 'down', failures: 5, next_check_at: NOW + 3_600_000 }] });
  const reg = await post('/zen/pool/register', { worker_id: 'LLM-test:4:1' }, d1);
  const lease = await reg.json();
  await get(`/zen/pool/pull?lease=${lease.lease_id}&hold_ms=5000`, d1);
  const q = await post('/zen/pool/invoke', { model: 'jev-1.13-free', prompt: 'x', wait_ms: 1000 }, d1);
  assert.equal(q.status, 504);   // accepted and waiting — NOT 409

  const full = fakeD1({ budget: [{ scope: '*', model: '*', minute_count: 50, minute_at: NOW, day_count: 1, day: '2026-10-04' }] });

  const reg2 = await post('/zen/pool/register', { worker_id: 'LLM-test:5:1' }, full);
  await get(`/zen/pool/pull?lease=${(await reg2.json()).lease_id}&hold_ms=5000`, full);
  const b = await post('/zen/pool/invoke', { model: 'nemotron-3.5-lightning-free', prompt: 'x' }, full);
  assert.equal(b.status, 429);
  assert.match((await b.json()).error, /budget/);
});

// ---- autoscaling (Ф8: scale up the moment the queue is not empty) -----------------------------

test('lambda: arrivals per minute from a window count', () => {
  assert.equal(lambdaPerMin(0), 0);
  assert.equal(lambdaPerMin(5, 60_000), 5);
  assert.equal(lambdaPerMin(225, 5 * 60_000), 45);   // the measured λ≈45/min at a 5-min window
  assert.equal(lambdaPerMin(10, 0), 0);              // a zero window is not a measurement
});

test('inflight: dispatches in the boot window minus workers that already registered, never negative', () => {
  assert.equal(inflightFrom({ recentDispatches: 3, recentRegistrations: 1 }), 2);
  assert.equal(inflightFrom({ recentDispatches: 1, recentRegistrations: 2 }), 0);
  assert.equal(inflightFrom({}), 0);
});

test('desired workers: Ф8 boots one on a cold queue, Little law sizes a sustained λ, the ceiling holds', () => {
  // a cold ring with one call: one worker, not the whole reserve
  assert.equal(desiredWorkers({ queued: 0, demand: 1, live: 0 }), 1);
  // a non-empty queue always adds a worker (Ф8), even if one is already live
  assert.equal(desiredWorkers({ queued: 1, live: 1 }), 2);
  // λ=45/min, τ=10 s -> N=ceil(450/60)=8 (the reserve is headroom under the ceiling, not a floor)
  assert.equal(desiredWorkers({ queued: 1, lambdaPerMin: 45, serviceMs: SERVICE_MS_DEFAULT }), 8);
  // never above ceiling minus reserve: the account has 20 job slots, two stay for ordinary CI
  assert.equal(desiredWorkers({ queued: 100, lambdaPerMin: 10_000 }), RING_CEILING - RING_RESERVE);
  // an empty queue never scales up
  assert.equal(desiredWorkers({ queued: 0, live: 3 }), 3);
});

test('scale decision: names why it dispatches, and nothing boots while a worker is in flight', () => {
  const cold = scaleDecision({ queued: 0, demand: 1, live: 0 });
  assert.equal(cold.toDispatch, 1);
  assert.equal(cold.reason, 'queue_not_empty');
  const inflight = scaleDecision({ queued: 1, live: 0, inflight: 1 });
  assert.equal(inflight.toDispatch, 0);
  const atCeiling = scaleDecision({ queued: 50, live: RING_CEILING - RING_RESERVE });
  assert.equal(atCeiling.toDispatch, 0);
  assert.equal(atCeiling.reason, 'at_ceiling');
});

const RING = { repo: 'ring/one', token_ref: 'env:RING_TOKEN' };
function fakeGithub(status = 204) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return status === 204
      ? new Response(null, { status: 204 })   // 204 must carry a null body
      : new Response('nope', { status });
  };
  return { calls, fetchImpl };
}
const postF = (path, body, d1, fetchImpl, extra = {}) =>
  handle(new Request(`https://l.test${path}`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), env(d1, extra), { fetchImpl });

test('scale: dispatches zen-rings into a ring repo, records it, and does not double-dispatch while it boots', async () => {
  const d1 = fakeD1({ repos: [RING] });
  const gh = fakeGithub();
  const extra = { RING_TOKEN: 'gh-tok' };

  const res = await postF('/zen/pool/scale', { demand: 1 }, d1, gh.fetchImpl, extra);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.dispatched.length, 1);
  assert.equal(out.dispatched[0].repo, 'ring/one');
  assert.equal(out.ttl_ms, RING_TTL_MS);
  assert.equal(gh.calls.length, 1);
  assert.match(gh.calls[0].url, /repos\/ring\/one\/dispatches$/);
  // The repository_dispatch type is frozen, NOT part of the "pool" rename: every ring repo's
  // workflow declares `on: repository_dispatch: types: [zen-pool]`, so renaming this string
  // silently stops all 8 repos from ever receiving a boot.
  assert.equal(gh.calls[0].body.event_type, 'zen-pool');
  assert.equal(gh.calls[0].body.client_payload.idle_exit_ms, RING_TTL_MS);

  // the worker is booting: a second call inside the boot window must dispatch nothing
  const again = await postF('/zen/pool/scale', { demand: 1 }, d1, gh.fetchImpl, extra);
  const out2 = await again.json();
  assert.equal(out2.dispatched.length, 0);
  assert.equal(out2.inflight, 1);
  assert.equal(gh.calls.length, 1);
});

test('scale: with no ring repo it says so instead of pretending to boot', async () => {
  const d1 = fakeD1();
  const gh = fakeGithub();
  const res = await postF('/zen/pool/scale', { demand: 1 }, d1, gh.fetchImpl);
  assert.equal(res.status, 503);
  const out = await res.json();
  assert.equal(out.reason, 'no_ring_repo');
  assert.equal(gh.calls.length, 0);
});

test('metrics: λ from the task table, the ceiling and the verdict, in one answer', async () => {
  const d1 = fakeD1({ repos: [RING] });
  for (let i = 0; i < 3; i++) d1._tasks.set(`t${i}`, { id: `t${i}`, state: 'queued', enqueued_at: NOW - 1000 });
  const res = await get('/zen/pool/metrics', d1);
  assert.equal(res.status, 200);
  const m = await res.json();
  assert.equal(m.lambda_count, 3);
  assert.equal(m.lambda_per_min, 0.6);   // 3 arrivals over the 5-min window
  assert.equal(m.queued, 3);
  assert.equal(m.ceiling, RING_CEILING);
  assert.equal(m.reserve, RING_RESERVE);
  assert.equal(m.autoscale, true);
  assert.equal(m.toDispatch, 1);         // Ф8: the queue is not empty and nothing is live
});

test('rotation: a spent address hands its lease back, so the ring boots a fresh run on a new one', async () => {
  const d1 = fakeD1({ repos: [RING] });
  const gh = fakeGithub();
  const extra = { RING_TOKEN: 'gh-tok' };

  const reg = await post('/zen/pool/register', { worker_id: 'ring/one:9:1', repo: 'ring/one' }, d1, extra);
  const lease = await reg.json();
  const pending = postF('/zen/pool/invoke', { model: 'nemotron-3.5-lightning-free', prompt: '2+4?', wait_ms: 5000 }, d1, gh.fetchImpl, extra);
  await new Promise((r) => setTimeout(r, 60));
  const pulled = await get(`/zen/pool/pull?lease=${lease.lease_id}&hold_ms=5000`, d1);
  const task = (await pulled.json()).task;
  assert.ok(task);

  // The provider answers 429 with a retry-after that lands on midnight UTC: the address is spent.
  const res = await post('/zen/pool/result', { task_id: task.id, ok: false, kind: 'daily', error: 'Rate limit exceeded' }, d1, extra);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.rotate, true);
  assert.equal(body.bye, true);
  assert.match(body.rotate_reason, /address spent/);

  // The lease is gone immediately — not after the 90 s TTL — so the pool sees the hole at once.
  const health = await get('/zen/pool/health', d1, {});
  assert.equal((await health.json()).workers_live, 0);

  // And the next scale tick boots a replacement, which is the whole point: a new run = a new
  // egress address = a fresh ~1000-request daily quota.
  const scale = await postF('/zen/pool/scale', { demand: 1 }, d1, gh.fetchImpl, extra);
  const sb = await scale.json();
  assert.equal(sb.toDispatch, 1);
  assert.equal(gh.calls.length, 1);
  assert.equal(gh.calls[0].url, 'https://api.github.com/repos/ring/one/dispatches');

  // The caller whose task failed is told so, not left hanging.
  const failed = await pending;
  assert.equal(failed.status, 502);
  assert.equal((await failed.json()).kind, 'daily');
});

test('rotation: a transient failure does NOT give the lease back — the address is still good', async () => {
  const d1 = fakeD1();
  const reg = await post('/zen/pool/register', { worker_id: 'LLM-test:3:1' }, d1);
  const lease = await reg.json();
  const pending = post('/zen/pool/invoke', { model: 'mimo-v2.6-flash-free', prompt: '2+4?', wait_ms: 5000 }, d1);
  await new Promise((r) => setTimeout(r, 60));
  const pulled = await get(`/zen/pool/pull?lease=${lease.lease_id}&hold_ms=5000`, d1);
  const task = (await pulled.json()).task;

  // Three separate tasks: a result is accepted once per task, so each failure needs its own.
  for (const kind of ['timeout', 'error', 'context']) {
    const pend = post('/zen/pool/invoke', { model: 'mimo-v2.6-flash-free', prompt: '2+4?', wait_ms: 5000 }, d1);
    await new Promise((r) => setTimeout(r, 60));
    const pl = await get(`/zen/pool/pull?lease=${lease.lease_id}&hold_ms=5000`, d1);
    const t = (await pl.json()).task;
    assert.ok(t);
    const res = await post('/zen/pool/result', { task_id: t.id, ok: false, kind, error: 'transient' }, d1);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).rotate, false);
    const failed = await pend;
    assert.equal(failed.status, 502);
  }
  const health = await get('/zen/pool/health', d1, {});
  assert.equal((await health.json()).workers_live, 1);
});

test('rotation: the local daily budget also rotates — a worker with no quota left must not idle', async () => {
  const d1 = fakeD1();
  const reg = await post('/zen/pool/register', { worker_id: 'LLM-test:4:1' }, d1);
  const lease = await reg.json();
  const pending = post('/zen/pool/invoke', { model: 'mimo-v2.6-flash-free', prompt: '2+4?', wait_ms: 5000 }, d1);
  await new Promise((r) => setTimeout(r, 60));
  const pulled = await get(`/zen/pool/pull?lease=${lease.lease_id}&hold_ms=5000`, d1);
  const task = (await pulled.json()).task;

  const res = await post('/zen/pool/result', { task_id: task.id, ok: false, kind: 'cooldown', stopped_by: 'local-budget', error: 'daily budget spent on this model' }, d1);
  assert.equal((await res.json()).rotate, true);
  const health = await get('/zen/pool/health', d1, {});
  assert.equal((await health.json()).workers_live, 0);
});

test('cold start: invoke on an empty ring boots a worker and the answer still lands in the same call', async () => {
  const d1 = fakeD1({ repos: [RING] });
  const gh = fakeGithub();
  const extra = { RING_TOKEN: 'gh-tok' };
  const pending = postF('/zen/pool/invoke', { model: 'nemotron-3.5-lightning-free', prompt: '2+4?', wait_ms: 5000 }, d1, gh.fetchImpl, extra);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(gh.calls.length, 1);   // the cold call itself triggered the boot

  // the booted worker registers and pulls the task the cold call enqueued
  const reg = await post('/zen/pool/register', { worker_id: 'ring/one:9:1', repo: 'ring/one' }, d1, extra);
  const lease = await reg.json();
  const pulled = await get(`/zen/pool/pull?lease=${lease.lease_id}&hold_ms=5000`, d1);
  const task = (await pulled.json()).task;
  assert.ok(task);
  await post('/zen/pool/result', { task_id: task.id, ok: true, text: 'six', provider_ms: 2100, served_ms: 2300 }, d1, extra);

  const res = await pending;
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.text, 'six');
  assert.equal(body.cold_start.dispatched[0], 'ring/one');
});

// ---- the ladder calls the ring in-process (no token, no HTTP hop) --------------------------

test('the ladder calls the ring in-process: a zen-rings rung answers a build-ladder call', async () => {
  const d1 = fakeD1();
  const cfg = { ladders: { build: { build: ['zen-rings/mimo-v2.6-flash-free', 'openrouter/xiaomi/mimo-v2.6-flash'] } } };
  const env = { ...ENV, ZEN_DB: d1, ZEN_NOW_MS: NOW, OPENROUTER_API_KEY: 'or_key' };
  // The pool answers from the DB, so the fallback rung's HTTP is never reached — and if it ever
  // were, this fetch fails loudly instead of silently passing.
  const fetchImpl = async () => { throw new Error('a zen-rings rung must not reach the network'); };

  const reg = await post('/zen/pool/register', { worker_id: 'ring/one:1:1', repo: 'ring/one' }, d1);
  const lease = await reg.json();

  const pending = run({
    model: 'build',
    messages: [{ role: 'system', content: 'you are build' }, { role: 'user', content: 'edit main.js' }],
    tools: [{ type: 'function', function: { name: 'shell', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } }],
  }, { env, config: cfg, store: memoryStore(1), fetchImpl });

  await new Promise((r) => setTimeout(r, 30));
  const pulled = await get(`/zen/pool/pull?lease=${lease.lease_id}&hold_ms=5000`, d1);
  const task = (await pulled.json()).task;

  // What the runner received is the caller's full request, not a flattened one-line prompt.
  assert.deepEqual(task.messages, [
    { role: 'system', content: 'you are build' },
    { role: 'user', content: 'edit main.js' },
  ]);
  assert.equal(task.tools.length, 1);
  assert.equal(task.tools[0].function.name, 'shell');

  await post('/zen/pool/result', {
    task_id: task.id, ok: true, text: 'on it',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } }],
    usage: { completion_tokens: 7 }, finish_reason: 'tool_calls',
    provider_ms: 900, served_ms: 1000,
  }, d1);

  const r = await pending;
  assert.equal(r.ok, true);
  assert.equal(r.model, 'zen-rings/mimo-v2.6-flash-free');
  assert.equal(r.data.choices[0].message.content, 'on it');
  assert.equal(r.data.choices[0].message.tool_calls[0].function.name, 'shell');
  assert.equal(r.data.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(r.data.usage, { completion_tokens: 7 });
});

test('the ladder gets a real SSE stream from a zen-rings rung (agent roles stream)', async () => {
  const d1 = fakeD1();
  const cfg = { ladders: { build: { build: ['zen-rings/nemotron-3.5-lightning-free'] } } };
  const env = { ...ENV, ZEN_DB: d1, ZEN_NOW_MS: NOW };
  const fetchImpl = async () => { throw new Error('a zen-rings rung must not reach the network'); };

  const reg = await post('/zen/pool/register', { worker_id: 'ring/one:2:1', repo: 'ring/one' }, d1);
  const lease = await reg.json();
  const pending = run({ model: 'build', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    { env, config: cfg, store: memoryStore(1), fetchImpl });

  await new Promise((r) => setTimeout(r, 30));
  const pulled = await get(`/zen/pool/pull?lease=${lease.lease_id}&hold_ms=5000`, d1);
  await post('/zen/pool/result', { task_id: (await pulled.json()).task.id, ok: true, text: 'pong', finish_reason: 'stop' }, d1);

  const r = await pending;
  assert.equal(r.ok, true);
  const text = await new Response(r.stream).text();
  assert.match(text, /^data: /);
  assert.match(text, /pong/);
  assert.match(text, /data: \[DONE\]/);
});

test('a zen-rings rung without ZEN_DB is skipped, not failed — the ladder walks down', async () => {
  const cfg = { ladders: { build: { build: ['zen-rings/mimo-v2.6-flash-free', 'openrouter/xiaomi/mimo-v2.6-flash'] } } };
  const env = { OPENROUTER_API_KEY: 'or_key' };  // no ZEN_DB
  const r = await run({ model: 'build', messages: [{ role: 'user', content: 'hi' }] }, {
    env, config: cfg, store: memoryStore(1),
    fetchImpl: async (_url, init) => {
      const model = JSON.parse(init.body).model;
      return { ok: true, status: 200, json: async () => ({ id: 'x', object: 'chat.completion', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'from openrouter' } }], usage: { prompt_tokens: 2 } }), text: async () => '' };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.model, 'openrouter/xiaomi/mimo-v2.6-flash');
});

test('a 504 is not a failure: the ladder waits for the in-flight task instead of starting a second one', async () => {
  const d1 = fakeD1();
  const cfg = { ladders: { build: { build: ['zen-rings/mimo-v2.6-flash-free'] } } };
  const env = { ...ENV, ZEN_DB: d1, ZEN_NOW_MS: NOW };
  const fetchImpl = async () => { throw new Error('a zen-rings rung must not reach the network'); };

  const reg = await post('/zen/pool/register', { worker_id: 'ring/one:3:1', repo: 'ring/one' }, d1);
  const lease = await reg.json();
  // wait_ms 1000 → the invoke gives up early, exactly like a caller with a short watchdog.
  // ladder_timeout_ms 1000 → the pool watchdog fires at 1 s, long before the answer exists.
  const pending = run({ model: 'build', messages: [{ role: 'user', content: 'hi' }], ladder_timeout_ms: 1000 },
    { env, config: cfg, store: memoryStore(1), fetchImpl });

  await new Promise((r) => setTimeout(r, 30));
  const pulled = await get(`/zen/pool/pull?lease=${lease.lease_id}&hold_ms=5000`, d1);
  const task = (await pulled.json()).task;
  // The answer lands AFTER the invoke gave up — the ladder must still collect it.
  await new Promise((r) => setTimeout(r, 1400));
  await post('/zen/pool/result', { task_id: task.id, ok: true, text: 'late but fine', finish_reason: 'stop' }, d1);

  const r = await pending;
  assert.equal(r.ok, true);
  assert.equal(r.data.choices[0].message.content, 'late but fine');
});

test('a budget refusal walks straight down the ladder (no retry, no second task)', async () => {
  const full = fakeD1({ budget: [{ scope: '*', model: '*', minute_count: 50, minute_at: NOW, day_count: 1, day: '2026-10-04' }] });
  const cfg = { ladders: { build: { build: ['zen-rings/mimo-v2.6-flash-free', 'openrouter/xiaomi/mimo-v2.6-flash'] } } };
  const env = { ...ENV, ZEN_DB: full, ZEN_NOW_MS: NOW, OPENROUTER_API_KEY: 'or_key' };
  await post('/zen/pool/register', { worker_id: 'ring/one:4:1', repo: 'ring/one' }, full);
  const r = await run({ model: 'build', messages: [{ role: 'user', content: 'hi' }] }, {
    env, config: cfg, store: memoryStore(1),
    fetchImpl: async () => ({
      ok: true, status: 200,
      json: async () => ({ id: 'x', object: 'chat.completion', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'fallback' } }], usage: { prompt_tokens: 2 } }),
      text: async () => '',
    }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.model, 'openrouter/xiaomi/mimo-v2.6-flash');
  assert.equal(r.attempts.find((a) => a.model.startsWith('zen-rings/')).outcome, 'error');
  assert.match(r.attempts.find((a) => a.model.startsWith('zen-rings/')).error, /budget exhausted/);
});

test('a transient ring fault is retried exactly once, then the ladder walks down', async () => {
  // Cold pool + a ring repo whose dispatch is refused: the first invoke cannot get a worker.
  // One retry means exactly two boot attempts — never a third.
  const d1 = fakeD1({ repos: [RING] });
  // The dispatch is refused (so the pool can never get a worker), but the fallback rung answers.
  const gh = fakeGithub(500);
  const origFetch = gh.fetchImpl;
  gh.fetchImpl = async (url, init) => (String(url).includes('api.github.com') ? origFetch(url, init) : new Response(JSON.stringify({
    id: 'x', object: 'chat.completion', created: 1, model: 'xiaomi/mimo-v2.6-flash',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'fallback' } }],
    usage: { prompt_tokens: 2, completion_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const cfg = { ladders: { build: { build: ['zen-rings/mimo-v2.6-flash-free', 'openrouter/xiaomi/mimo-v2.6-flash'] } } };
  const env = { ...ENV, ZEN_DB: d1, ZEN_NOW_MS: NOW, RING_TOKEN: 'gh-tok', OPENROUTER_API_KEY: 'or_key' };
  const r = await run({ model: 'build', messages: [{ role: 'user', content: 'hi' }], ladder_timeout_ms: 1000 }, {
    env, config: cfg, store: memoryStore(1), fetchImpl: gh.fetchImpl,
  });
  assert.equal(r.ok, true);
  assert.equal(r.model, 'openrouter/xiaomi/mimo-v2.6-flash');
  // boot (1) + the invoke's own cold-start dispatch (2) + the retry's (3)
  assert.equal(gh.calls.length, 3, 'boot + invoke + one retry');
});

test('a cold ring boots in the background and fails over immediately (no waiting on the boot)', async () => {
  const d1 = fakeD1({ repos: [RING] });
  const gh = fakeGithub(204);
  const cfg = { ladders: { build: { build: ['zen-rings/mimo-v2.6-flash-free', 'openrouter/xiaomi/mimo-v2.6-flash'] } } };
  const env = { ...ENV, ZEN_DB: d1, ZEN_NOW_MS: NOW, RING_TOKEN: 'gh-tok', OPENROUTER_API_KEY: 'or_key' };
  const origFetch = gh.fetchImpl;
  gh.fetchImpl = async (url, init) => (String(url).includes('api.github.com')
    ? origFetch(url, init)
    : new Response(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 1, model: 'xiaomi/mimo-v2.6-flash',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'fallback' } }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const r = await run({ model: 'build', messages: [{ role: 'user', content: 'hi' }] }, {
    env, config: cfg, store: memoryStore(1), fetchImpl: gh.fetchImpl,
  });
  assert.equal(r.ok, true);
  assert.equal(r.model, 'openrouter/xiaomi/mimo-v2.6-flash');
  assert.equal(gh.calls.length, 1, 'the cold call booted exactly one worker, then failed over');
  const ringAttempt = r.attempts.find((a) => a.model.startsWith('zen-rings/'));
  assert.match(ringAttempt.error, /cold ring/);
});

test('the ring is skipped for 60s after a cold start (cooldown)', async () => {
  const d1 = fakeD1({ repos: [RING] });
  const gh = fakeGithub(204);
  const cfg = { ladders: { build: { build: ['zen-rings/mimo-v2.6-flash-free', 'openrouter/xiaomi/mimo-v2.6-flash'] } } };
  const env = { ...ENV, ZEN_DB: d1, ZEN_NOW_MS: NOW, RING_TOKEN: 'gh-tok', OPENROUTER_API_KEY: 'or_key' };
  const origFetch = gh.fetchImpl;
  gh.fetchImpl = async (url, init) => (String(url).includes('api.github.com')
    ? origFetch(url, init)
    : new Response(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 1, model: 'xiaomi/mimo-v2.6-flash',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'fallback' } }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));

  // First call: cold ring → boots one worker, fails over.
  const r1 = await run({ model: 'build', messages: [{ role: 'user', content: 'hi' }] },
    { env, config: cfg, store: memoryStore(1), fetchImpl: gh.fetchImpl });
  assert.equal(r1.model, 'openrouter/xiaomi/mimo-v2.6-flash');
  assert.equal(gh.calls.length, 1);

  // Second call right after: the pool is in cooldown → skipped without even trying to boot.
  const r2 = await run({ model: 'build', messages: [{ role: 'user', content: 'hi' }] },
    { env, config: cfg, store: memoryStore(1), fetchImpl: gh.fetchImpl });
  assert.equal(r2.model, 'openrouter/xiaomi/mimo-v2.6-flash');
  assert.equal(gh.calls.length, 1, 'no second boot during the cooldown');
  assert.match(r2.attempts.find((a) => a.model.startsWith('zen-rings/')).error, /warming up/);
});


// #138, the architectural side: the pool refuses AT THE DOOR instead of taking work it cannot
// serve. A task that never enters the queue costs no quota and has no answer to go unread.
test('a saturated ring refuses before queueing: no task row, no budget spent (#138)', async () => {
  const d1 = fakeD1({ repos: [RING] });
  const extra = { RING_TOKEN: 'gh-tok' };
  const env2 = { ...ENV, ZEN_DB: d1, ZEN_NOW_MS: NOW, ...extra };
  const gh = fakeGithub(204);

  // one live worker → cap = 2 × 1 = 2; fill the queue to the cap
  await zenRingRegister(new Request('https://l.test/x', {
    method: 'POST', headers: { authorization: 'Bearer zen-tok' }, body: JSON.stringify({ worker_id: 'w:1' }),
  }), env2);
  d1._tasks.set('q1', { id: 'q1', model: 'm', state: 'queued', enqueued_at: NOW - 5 });
  d1._tasks.set('q2', { id: 'q2', model: 'm', state: 'queued', enqueued_at: NOW - 4 });
  const budgetBefore = JSON.stringify([...d1._budget.values()]);

  const r = await ringInvoke(env2, { model: 'nemotron-3-ultra-free', prompt: '2+4?' }, gh.fetchImpl);
  assert.equal(r.status, 503);
  assert.equal(r.data.error, 'pool_backlog');
  assert.equal(d1._tasks.size, 2, 'the refused task must NOT be queued');
  assert.equal(JSON.stringify([...d1._budget.values()]), budgetBefore, 'and it must not spend provider quota');
});

test('a cold ring (no workers) still admits one task — otherwise it could never start', async () => {
  const d1 = fakeD1({ repos: [RING] });
  const env2 = { ...ENV, ZEN_DB: d1, ZEN_NOW_MS: NOW, RING_TOKEN: 'gh-tok' };
  const gh = fakeGithub(204);   // dispatch succeeds → a worker is booting, not yet registered
  const r = await ringInvoke(env2, { model: 'nemotron-3-ultra-free', prompt: '2+4?' }, gh.fetchImpl);
  assert.equal(r.status, 504, 'admitted, then the watchdog fired with nobody serving yet');
  assert.equal(d1._tasks.size, 1);
  assert.ok([...d1._budget.values()].length > 0, 'quota counted for the admitted task');
});

// The 70-second incident: the ladder sat on a saturated pool until its watchdog expired, then
// failed over — burning the caller's whole rung budget for nothing. A saturated pool must be
// detected on the way IN, so the ladder walks down immediately.
test('a saturated ring fails the caller over at once instead of holding it for the watchdog', async () => {
  const d1 = fakeD1({ repos: [RING] });
  const cfg = { ladders: { build: { build: ['zen-rings/mimo-v2.6-flash-free', 'openrouter/xiaomi/mimo-v2.6-flash'] } } };
  const env2 = { ...ENV, ZEN_DB: d1, ZEN_NOW_MS: NOW, RING_TOKEN: 'gh-tok', OPENROUTER_API_KEY: 'k' };
  await zenRingRegister(new Request('https://l.test/x', {
    method: 'POST', headers: { authorization: 'Bearer zen-tok' }, body: JSON.stringify({ worker_id: 'w:1' }),
  }), env2);
  // fill past the cap (2 × 1 live worker)
  d1._tasks.set('q1', { id: 'q1', model: 'm', state: 'queued', enqueued_at: NOW - 5 });
  d1._tasks.set('q2', { id: 'q2', model: 'm', state: 'queued', enqueued_at: NOW - 4 });
  d1._tasks.set('q3', { id: 'q3', model: 'm', state: 'queued', enqueued_at: NOW - 3 });

  const started = Date.now();
  const r = await run({ model: 'build', messages: [{ role: 'user', content: 'hi' }] }, {
    env: env2, config: cfg, store: memoryStore(1),
    fetchImpl: async () => ({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: 'from openrouter' } }] }),
      text: async () => '',
    }),
  });
  const elapsed = Date.now() - started;

  assert.equal(r.ok, true);
  assert.equal(r.model, 'openrouter/xiaomi/mimo-v2.6-flash', 'the caller walks down to the next rung');
  assert.ok(elapsed < 5_000, `must not hold the caller for the watchdog (took ${elapsed}ms)`);
  const ringAttempt = r.attempts.find((a) => a.model.startsWith('zen-rings/'));
  assert.match(ringAttempt.error, /pool_backlog/, 'and must say why, without a status-code digit');
  assert.equal(d1._tasks.size, 3, 'the refused task was never queued');
});

// The failure this pins (measured 2026-10-07): the head rung refused EVERY call with
// pool_backlog for 17 h while the worker itself was fine — `claimed`/`queued` held 139 rows whose
// enqueued_at was up to 45 h old. A caller's watchdog is <= 90 s, so nobody is ever waiting for a
// row that old: it is litter, and litter must not ration the door.
test('dead rows do not hold the door: a 45h-old queued backlog is not counted against the cap', async () => {
  const d1 = fakeD1({ repos: [RING] });
  const env2 = { ...ENV, ZEN_DB: d1, ZEN_NOW_MS: NOW, RING_TOKEN: 'gh-tok', OPENROUTER_API_KEY: 'k' };
  const gh = fakeGithub(204);

  await zenRingRegister(new Request('https://l.test/x', {
    method: 'POST', headers: { authorization: 'Bearer zen-tok' }, body: JSON.stringify({ worker_id: 'w:1' }),
  }), env2);   // one live worker → cap = 2

  for (let i = 0; i < 5; i++) {
    d1._tasks.set(`stale${i}`, { id: `stale${i}`, model: 'm', state: 'queued', enqueued_at: NOW - 45 * 3_600_000 });
  }

  const r = await ringInvoke(env2, { model: 'nemotron-3-ultra-free', prompt: '2+4?', wait_ms: 1_000 }, gh.fetchImpl);
  assert.notEqual(r.data?.error, 'pool_backlog',
    'a row nobody can be waiting for must not refuse the call');
  assert.ok([...d1._tasks.values()].some((t) => t.enqueued_at >= NOW),
    'the call itself was admitted');
});

// The same litter, removed where it is born: the poll loop reaps before it requeues orphans,
// otherwise every pull recycles the dead row (claimed → queued → claimed) forever.
test('the poll loop buries the dead: stale rows are reaped before orphans are requeued', async () => {
  const d1 = fakeD1();
  const reg = await post('/zen/pool/register', { worker_id: 'LLM-t:1:1', repo: 'o/r' }, d1);
  assert.equal(reg.status, 200);
  const lease = await reg.json();

  for (let i = 0; i < 3; i++) {
    d1._tasks.set(`oldq${i}`, { id: `oldq${i}`, model: 'm', state: 'queued', enqueued_at: NOW - 45 * 3_600_000 });
  }
  d1._tasks.set('oldc', { id: 'oldc', model: 'm', state: 'claimed', enqueued_at: NOW - 45 * 3_600_000, claimed_at: NOW - 45 * 3_600_000 });
  d1._tasks.set('live1', { id: 'live1', model: 'm', state: 'queued', enqueued_at: NOW - 5 });

  const pulled = await get(`/zen/pool/pull?lease=${lease.lease_id}&hold_ms=5000`, d1);
  assert.equal(pulled.status, 200);
  const task = (await pulled.json()).task;
  assert.equal(task.id, 'live1', 'the still-useful task is what the worker gets');

  const stale = [...d1._tasks.values()].filter((t) => t.enqueued_at < NOW - STALE_TASK_MS);
  assert.deepEqual(stale, [], 'the 45h-old rows are gone, not recycled');
  assert.ok(d1._tasks.has('live1'));
});

// Refusing is only half the answer: a queue full under a single worker means the ring is too
// small, so the refusal must also try to grow it. The scheduled autoscaler cannot (its config was
// missing from the repository), so the hot path is where growth has to come from.
test('a full queue also grows the ring: refusing dispatches a worker, not just a 503', async () => {
  const d1 = fakeD1({ repos: [RING] });
  const env2 = { ...ENV, ZEN_DB: d1, ZEN_NOW_MS: NOW, RING_TOKEN: 'gh-tok', OPENROUTER_API_KEY: 'k' };
  const gh = fakeGithub(204);

  await zenRingRegister(new Request('https://l.test/x', {
    method: 'POST', headers: { authorization: 'Bearer zen-tok' }, body: JSON.stringify({ worker_id: 'w:1' }),
  }), env2);
  d1._tasks.set('q1', { id: 'q1', model: 'm', state: 'queued', enqueued_at: NOW - 5 });
  d1._tasks.set('q2', { id: 'q2', model: 'm', state: 'queued', enqueued_at: NOW - 4 });

  const before = gh.calls.length;
  const r = await ringInvoke(env2, { model: 'nemotron-3-ultra-free', prompt: '2+4?' }, gh.fetchImpl);
  assert.equal(r.status, 503);
  assert.equal(r.data.error, 'pool_backlog', 'the caller still fails over — no task, no quota');
  assert.ok(gh.calls.length > before, 'but the ring was asked to grow');
  assert.ok(d1._dispatches.size >= 1, 'and a dispatch was recorded');
});

// The cadence has to live in the worker: GitHub's own */2 schedule delivered runs 4-7 hours apart
// (every one of them failing with SCALE_CONFIG_MISSING), so the ring was never grown on a
// schedule. One tick must both grow the ring and clean up, without depending on any GitHub secret.
test('one cron tick grows the ring and cleans up — no GitHub workflow involved', async () => {
  const d1 = fakeD1({ repos: [RING] });
  const env2 = { ...ENV, ZEN_DB: d1, ZEN_NOW_MS: NOW, RING_TOKEN: 'gh-tok', OPENROUTER_API_KEY: 'k' };
  const gh = fakeGithub(204);

  // a queue nobody is serving + no live worker: the tick must decide to dispatch
  d1._tasks.set('q1', { id: 'q1', model: 'm', state: 'queued', enqueued_at: NOW - 5 });

  const out = await runMaintenance(env2, { fetchImpl: gh.fetchImpl });
  assert.ok(out.scale.ok !== false, 'scale half answers');
  assert.ok(out.summary.dispatched >= 1, `a worker was dispatched (got ${out.summary.dispatched})`);
  assert.equal(d1._dispatches.size, 1);
  assert.ok(Object.hasOwn(out.summary, 'reaped'), 'the reap/sweep half reports too');

  // second tick inside the boot window must not double-dispatch
  const again = await runMaintenance(env2, { fetchImpl: gh.fetchImpl });
  assert.equal(again.summary.dispatched, 0, 'idempotent within BOOT_MS');
});

// Measured 2026-10-07 over 2497 production tasks: success collapses past 50 KB of input (64 % at
// <5 KB, 48 % at 20-50 KB, then 9-20 %), and zen answers those with HTTP 200 and an EMPTY body —
// 1073 calls, 100 % empty text — so the caller still fails over, only after 7-12 s of zen time, a
// task row and a budget bump. Refusing at the door must be strictly better than that.
// Деградированная полоса (замер 2026-10-08): одиночный вызов в ней выигрывает в 9–20 %,
// четыре параллельных — 1 − (1−p)^4 ≈ 50–60 %. Жирный промпт и так не имеет дешёвой
// альтернативы, поэтому вместо отказа гоним несколько моделей.
test('жирный вход гонится по нескольким моделям; отказ остаётся только выше жёсткого потолка', async () => {
  const d1 = fakeD1({ repos: [RING] });
  const env2 = { ...ENV, ZEN_DB: d1, ZEN_NOW_MS: NOW, RING_TOKEN: 'gh-tok', OPENROUTER_API_KEY: 'k' };
  const gh = fakeGithub(204);
  const budgetBefore = JSON.stringify([...d1._budget.values()]);
  await registerWorkers(d1, 3, { RING_TOKEN: 'gh-tok' });

  const r = await ringInvoke(env2, {
    model: 'nemotron-3-ultra-free',
    messages: [{ role: 'user', content: 'x'.repeat(ZEN_MAX_INPUT_BYTES + 1_000) }],
    wait_ms: 1_000,
  }, gh.fetchImpl);
  assert.notEqual(r.status, 413, 'в деградированной полосе не отказываем');
  assert.ok(d1._tasks.size >= 2, `поставлено задач: ${d1._tasks.size} — минимум две модели гонки`);
  assert.ok(d1._tasks.size <= ZEN_RACE_MODELS.length, 'но не больше списка гонки');
  assert.ok(JSON.stringify([...d1._budget.values()]).length > budgetBefore.length, 'квота списана по каждой модели');
  assert.equal(gh.calls.length, 0, 'кольцо уже тёплое (3 раннера) — dispatch не нужен');

  const tooBig = await ringInvoke(env2, {
    model: 'nemotron-3-ultra-free',
    messages: [{ role: 'user', content: 'x'.repeat(ZEN_RACE_MAX_INPUT_BYTES + 1_000) }],
    wait_ms: 1_000,
  }, gh.fetchImpl);
  assert.equal(tooBig.status, 413, 'выше потолка гонки — отказ, как раньше');
  assert.ok(tooBig.data.bytes > ZEN_RACE_MAX_INPUT_BYTES, 'и в сообщении честный размер');
  assert.equal(classifyError(tooBig.data.error).class, 'context',
    'wording keeps the refusal out of the quota/config classes');

  const small = await ringInvoke(env2, { model: 'nemotron-3-ultra-free', prompt: '2+4?', wait_ms: 1_000 }, gh.fetchImpl);
  assert.notEqual(small.status, 413, 'обычные запросы не задеты');
});

// Гонке нужны живые раннеры: cap = BACKLOG_FACTOR × live, и на пустом кольце (live = 0) слот
// ровно один — гонка схлопнется до одиночного вызова. Три раннера дают cap = 6.
const registerWorkers = async (d1, n = 3, envBase = {}) => {
  for (let i = 0; i < n; i++) {
    await zenRingRegister(new Request('https://l.test/x', {
      method: 'POST', headers: { authorization: 'Bearer zen-tok' },
      body: JSON.stringify({ worker_id: `w:${i}`, repo: RING.repo }),
    }), { ...ENV, ZEN_DB: d1, ZEN_NOW_MS: NOW, ...envBase });
  }
};

// Один потолок на всех был ошибкой: модели держат разный размер. Замер 2026-10-08 (5394 задачи,
// байты JSON messages): в полосе 20–50 KB nemotron держит 62 % (661/1072), а mimo — 18 % (33/186).
// В полосе ГОНКИ свой потолок больше не отказывает: mimo участвует как одна из моделей, и её
// вероятный провал перекрывают соседи — вместо «отказ и уходим в никуда» получаем шанс ответа.
test('в полосе гонки модельный потолок не отказывает: mimo участвует как одна из гонки', async () => {
  const d1 = fakeD1({ repos: [RING] });
  const env2 = { ...ENV, ZEN_DB: d1, ZEN_NOW_MS: NOW, RING_TOKEN: 'gh-tok', OPENROUTER_API_KEY: 'k' };
  const gh = fakeGithub(204);
  await registerWorkers(d1, 3, { RING_TOKEN: 'gh-tok' });
  const MIMO = ZEN_MODEL_MAX_INPUT_BYTES['mimo-v2.6-flash-free'];
  assert.equal(MIMO, 20_000, 'the measured ceiling for mimo');
  const mid = { role: 'user', content: 'x'.repeat(MIMO + 5_000) };   // ~25 KB

  const m = await ringInvoke(env2, { model: 'mimo-v2.6-flash-free', messages: [mid], wait_ms: 1_000 }, gh.fetchImpl);
  assert.notEqual(m.status, 413, 'свой потолок больше не отказывает — это полоса гонки');
  const models = [...d1._tasks.values()].map((t) => t.model);
  assert.ok(models.includes('mimo-v2.6-flash-free'), 'mimo всё равно участвует');
  assert.ok(models.length >= 2, 'и рядом с ним гонятся соседи');

  // тот же кусок для nemotron — он весь диапазон держит, поэтому задача создаётся
  const n = await ringInvoke(env2, { model: 'nemotron-3-ultra-free', messages: [mid], wait_ms: 1_000 }, gh.fetchImpl);
  assert.notEqual(n.status, 413, '25 KB is inside the race band for every model');
});

// ── гонка моделей: кто выигрывает ──────────────────────────────────────────────────────────
// Пустое тело — основной вид проигрыша в деградированной полосе (замер: 1073 вызова, 100 %
// пустого текста), поэтому «задача выполнена» без текста выиграть не может.
test('гонка: пустой ответ не побеждает — возвращается первый НЕПУСТОЙ', async () => {
  const d1 = fakeD1({ repos: [RING] });
  const env2 = { ...ENV, ZEN_DB: d1, ZEN_NOW_MS: NOW, RING_TOKEN: 'gh-tok', OPENROUTER_API_KEY: 'k' };
  const gh = fakeGithub(204);
  await registerWorkers(d1, 3, { RING_TOKEN: 'gh-tok' });
  // nemotron завершается первым, но пустым; big-pickle отвечает позже и текстом
  setTimeout(() => {
    for (const [id, row] of d1._tasks) {
      if (row.model === 'nemotron-3-ultra-free') {
        d1._tasks.set(id, { ...row, state: 'done', ok: false, kind: 'ok', finish_reason: 'stop' });
      }
      if (row.model === 'big-pickle') {
        d1._tasks.set(id, { ...row, state: 'done', ok: true, text: 'готово', kind: 'ok', finish_reason: 'stop' });
      }
    }
  }, 80);
  const r = await ringInvoke(env2, {
    model: 'nemotron-3-ultra-free',
    messages: [{ role: 'user', content: 'x'.repeat(ZEN_MAX_INPUT_BYTES + 1_000) }],
    wait_ms: 8_000,
  }, gh.fetchImpl);
  assert.equal(r.status, 200, 'гонка дошла до ответа');
  assert.equal(r.data.model, 'big-pickle', 'побеждает тот, кто написал текст');
  assert.equal(r.data.text, 'готово');
  assert.ok(Array.isArray(r.data.raced) && r.data.raced.length >= 2, 'в ответе видно, кого гоняли');
});

test('гонка: если никто не ответил непустым — отказ с перечнем моделей', async () => {
  const d1 = fakeD1({ repos: [RING] });
  const env2 = { ...ENV, ZEN_DB: d1, ZEN_NOW_MS: NOW, RING_TOKEN: 'gh-tok', OPENROUTER_API_KEY: 'k' };
  const gh = fakeGithub(204);
  await registerWorkers(d1, 3, { RING_TOKEN: 'gh-tok' });
  setTimeout(() => {
    for (const [id, row] of d1._tasks) d1._tasks.set(id, { ...row, state: 'done', ok: false, kind: 'ok', finish_reason: 'stop' });
  }, 80);
  const r = await ringInvoke(env2, {
    model: 'nemotron-3-ultra-free',
    messages: [{ role: 'user', content: 'x'.repeat(ZEN_MAX_INPUT_BYTES + 1_000) }],
    wait_ms: 8_000,
  }, gh.fetchImpl);
  assert.equal(r.status, 502, 'все пустые — это отказ');
  assert.ok(Array.isArray(r.data.raced) && r.data.raced.length >= 2, 'видно, кого гоняли');
  assert.ok(r.data.raced.every((m) => ZEN_RACE_MODELS.includes(m)), 'гоняются только модели списка гонки');
});

test('raceModelsFor: запрошенная первой, остальные из списка, env переопределяет', () => {
  assert.deepEqual(raceModelsFor({}, 'nemotron-3-ultra-free')[0], 'nemotron-3-ultra-free', 'запрошенная идёт первой');
  assert.ok(raceModelsFor({}).length <= ZEN_RACE_MODELS.length, 'не больше списка');
  assert.deepEqual(raceModelsFor({ ZEN_RACE_MODELS: 'big-pickle, nemotron-3.5-lightning-free' }, 'big-pickle'),
    ['big-pickle', 'nemotron-3.5-lightning-free'], 'env задаёт состав');
  assert.deepEqual(raceModelsFor({ ZEN_RACE_MAX: '2' }, 'nemotron-3-ultra-free').length, 2, 'ZEN_RACE_MAX режет');
});
