import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/ladder.js';
import { handle } from '../src/handler.js';
import { memoryStore } from '../src/state.js';
import { estimateBudgetInput } from '../src/size-policy.js';
import {
  createBudgetTask,
  reconcileTokenBudget,
  reserveTokenBudget,
  signBudgetCapability,
  verifyBudgetCapability,
} from '../src/hard-budget.js';

const NOW = 1_800_000_000;
const SECRET = 'test-only-budget-secret-with-at-least-thirty-two-bytes';
export const budgetTestClaims = Object.freeze({
  v: 1, issuer: 'trained-assist-cp', audience: 'trained-assist-llm-ladder',
  taskId: 'task-1', runId: 'run-1', policyId: 'sandbox-v1', maxTokens: 1000,
  expiresAt: NOW + 300,
});

export function fakeD1() {
  const tasks = new Map();
  const reservations = new Map();
  let serial = Promise.resolve();
  let batchSerial = Promise.resolve();
  let priorChanges = 0;
  const key = (taskId, runId) => `${taskId}|${runId}`;
  return {
    _tasks: tasks,
    _reservations: reservations,
    prepare(sql) {
      let params = [];
      const statement = {
        bind(...values) { params = values; return statement; },
        async run() {
          const run = async () => {
            if (/INSERT INTO ladder_budget_tasks/.test(sql)) {
              const [taskId, runId, policyId, maxTokens, now] = params;
              const id = key(taskId, runId);
              if (!tasks.has(id)) tasks.set(id, { task_id: taskId, run_id: runId, policy_id: policyId, max_tokens: maxTokens, reserved_tokens: 0, spent_tokens: 0, status: 'active', updated_at: now });
              return { meta: { changes: 1 } };
            }
            if (/UPDATE ladder_budget_tasks SET reserved_tokens = reserved_tokens \+/.test(sql)) {
              const [taskId, runId, reservationId, amount, now] = params;
              const task = tasks.get(key(taskId, runId));
              const rid = `${key(taskId, runId)}|${reservationId}`;
              if (task && task.status === 'active' && !reservations.has(rid) && amount <= task.max_tokens - task.reserved_tokens) {
                task.reserved_tokens += amount;
                task.updated_at = now;
                priorChanges = 1;
                return { meta: { changes: 1 } };
              }
              priorChanges = 0;
              return { meta: { changes: 0 } };
            }
            if (/INSERT INTO ladder_budget_reservations/.test(sql)) {
              const [taskId, runId, reservationId, amount, now, policyId] = params;
              const id = key(taskId, runId);
              const rid = `${id}|${reservationId}`;
              const task = tasks.get(id);
              if (priorChanges === 1 && !reservations.has(rid) && task && task.status === 'active') {
                reservations.set(rid, { reserved_tokens: amount, status: 'reserved', created_at: now });
                priorChanges = 1;
                return { meta: { changes: 1 } };
              }
              priorChanges = 0;
              return { meta: { changes: 0 } };
            }
            if (/UPDATE ladder_budget_tasks/.test(sql)) {
              const [taskId, runId, reserved, charged, now] = params;
              const task = tasks.get(key(taskId, runId));
              if (priorChanges === 1 && task && task.reserved_tokens >= reserved) {
                task.reserved_tokens -= reserved;
                task.spent_tokens += charged;
                task.updated_at = now;
                priorChanges = 1;
                return { meta: { changes: 1 } };
              }
              priorChanges = 0;
              return { meta: { changes: 0 } };
            }
            if (/UPDATE ladder_budget_reservations/.test(sql)) {
              const [taskId, runId, reservationId, status, usageTokens] = params;
              const row = reservations.get(`${key(taskId, runId)}|${reservationId}`);
              if (row?.status === 'reserved') { row.status = status; row.usage_tokens = usageTokens; priorChanges = 1; return { meta: { changes: 1 } }; }
              priorChanges = 0;
              return { meta: { changes: 0 } };
            }
            return { meta: { changes: 0 } };
          };
          const next = serial.then(run, run);
          serial = next.then(() => {}, () => {});
          return next;
        },
        async first() {
          const [taskId, runId, reservationId] = params;
          if (/FROM ladder_budget_tasks/.test(sql)) return tasks.get(key(taskId, runId)) || null;
          if (/FROM ladder_budget_reservations/.test(sql)) return reservations.get(`${key(taskId, runId)}|${reservationId}`) || null;
          return null;
        },
      };
      return statement;
    },
    async batch(statements) {
      const execute = async () => {
        const beforeTasks = structuredClone([...tasks.entries()]);
        const beforeReservations = structuredClone([...reservations.entries()]);
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          return results;
        } catch (error) {
          tasks.clear();
          reservations.clear();
          for (const [id, value] of beforeTasks) tasks.set(id, value);
          for (const [id, value] of beforeReservations) reservations.set(id, value);
          throw error;
        }
      };
      const next = batchSerial.then(execute, execute);
      batchSerial = next.then(() => {}, () => {});
      return next;
    },
  };
}

test('budget capability is signed, short-lived and bound to task/run/policy', async () => {
  const token = await signBudgetCapability(budgetTestClaims, SECRET, NOW);
  assert.deepEqual(await verifyBudgetCapability(token, SECRET, { taskId: 'task-1', runId: 'run-1', policyId: 'sandbox-v1' }, NOW), budgetTestClaims);
  await assert.rejects(verifyBudgetCapability(token, SECRET, { runId: 'other-run' }, NOW), /mismatch/);
  await assert.rejects(verifyBudgetCapability(token, `${SECRET}!`, {}, NOW), /signature/);
  await assert.rejects(verifyBudgetCapability(token, SECRET, {}, NOW + 301), /expired/);
  const malformed = await signBudgetCapability({ ...budgetTestClaims, maxTokens: 0 }, SECRET, NOW).catch((error) => error);
  assert.match(malformed.message, /token ceiling/);
});

test('concurrent reservations cannot exceed the task ceiling and denied reservations invoke no provider', async () => {
  const db = fakeD1();
  await createBudgetTask(db, budgetTestClaims);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => reserveTokenBudget(db, budgetTestClaims, `attempt-${i}`, 100)));
  assert.equal(results.filter((result) => result.reserved).length, 10);
  assert.equal(results.filter((result) => result.reason === 'budget_exhausted').length, 2);
  assert.equal(db._tasks.get('task-1|run-1').reserved_tokens, 1000);
});

test('retries reserve separately; idempotent reservation cannot inflate or change its amount', async () => {
  const db = fakeD1();
  await createBudgetTask(db, budgetTestClaims);
  assert.equal((await reserveTokenBudget(db, budgetTestClaims, 'attempt-1', 250)).reserved, true);
  const replay = await reserveTokenBudget(db, budgetTestClaims, 'attempt-1', 250);
  assert.equal(replay.replay, true);
  assert.equal(replay.reserved, false, 'an existing attempt must never be invoked a second time');
  await assert.rejects(reserveTokenBudget(db, budgetTestClaims, 'attempt-1', 251), /different amount/);
  assert.equal((await reserveTokenBudget(db, budgetTestClaims, 'attempt-2', 250)).reserved, true);
  assert.equal(db._tasks.get('task-1|run-1').reserved_tokens, 500);
});

test('unknown provider outcome retains the full reservation; measured usage settles it', async () => {
  const db = fakeD1();
  await createBudgetTask(db, budgetTestClaims);
  await reserveTokenBudget(db, budgetTestClaims, 'unknown-attempt', 400);
  assert.deepEqual(await reconcileTokenBudget(db, budgetTestClaims, 'unknown-attempt', null, 'unknown'), { status: 'unknown', chargedTokens: 400 });
  assert.equal(db._tasks.get('task-1|run-1').reserved_tokens, 0);
  assert.equal(db._tasks.get('task-1|run-1').spent_tokens, 400);

  await reserveTokenBudget(db, budgetTestClaims, 'known-attempt', 300);
  assert.deepEqual(await reconcileTokenBudget(db, budgetTestClaims, 'known-attempt', 120, 'settled'), { status: 'settled', chargedTokens: 120 });
  assert.equal(db._tasks.get('task-1|run-1').reserved_tokens, 0);
  assert.equal(db._tasks.get('task-1|run-1').spent_tokens, 520);
});

test('usage above reservation fails closed and leaves the reservation charged', async () => {
  const db = fakeD1();
  await createBudgetTask(db, budgetTestClaims);
  await reserveTokenBudget(db, budgetTestClaims, 'overspend-attempt', 100);
  await assert.rejects(reconcileTokenBudget(db, budgetTestClaims, 'overspend-attempt', 101, 'settled'), /exceeded reservation/);
  assert.equal(db._tasks.get('task-1|run-1').reserved_tokens, 100);
  assert.equal(db._tasks.get('task-1|run-1').spent_tokens, 0);
});

test('ledger outage fails before a provider attempt', async () => {
  await assert.rejects(reserveTokenBudget(null, budgetTestClaims, 'attempt-1', 100), /unavailable/);
});

test('provider boundary reserves before fetch and settles reported usage', async () => {
  const db = fakeD1();
  await createBudgetTask(db, budgetTestClaims);
  const model = 'openrouter/inclusionai/ling-3.0-flash-sante:free';
  const body = { model: 'budget-test', messages: [{ role: 'user', content: 'sandbox hello' }], max_tokens: 80, max_completion_tokens: 900 };
  const result = await run(body, {
    env: { OPENROUTER_API_KEY: 'test-key' },
    config: { ladders: { 'budget-test': { build: [model] } } },
    store: memoryStore(0),
    budget: { db, claims: budgetTestClaims, outputTokens: 100 },
    fetchImpl: async (_url, init) => {
      assert.equal(db._reservations.size, 1, 'ledger reservation must exist before provider fetch');
      const sent = JSON.parse(init.body);
      assert.equal(sent.max_tokens, 80, 'budget mode must not raise the caller ceiling to the model floor');
      assert.equal(sent.max_completion_tokens, undefined, 'a second output-limit field cannot bypass the hard cap');
      return Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 22, completion_tokens: 3 } });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(db._tasks.get('task-1|run-1').reserved_tokens, 0);
  assert.equal(db._tasks.get('task-1|run-1').spent_tokens, 25);
  assert.equal([...db._reservations.values()][0].status, 'settled');
});

test('sandbox provider Service Binding is used instead of public-network fetch', async () => {
  const db = fakeD1();
  await createBudgetTask(db, budgetTestClaims);
  let serviceCalls = 0;
  let publicCalls = 0;
  const service = { fetch: async (_url, init) => {
    serviceCalls++;
    assert.equal(JSON.parse(init.body).max_tokens, 80);
    return Response.json({ choices: [{ message: { content: 'private mock' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2 } });
  } };
  const result = await run({ model: 'budget-test', messages: [{ role: 'user', content: 'private service binding' }] }, {
    env: { OPENROUTER_API_KEY: 'test-key', BUDGET_PROVIDER_MOCK: service },
    config: { ladders: { 'budget-test': { build: ['openrouter/inclusionai/ling-3.0-flash-sante:free'] } } },
    store: memoryStore(0), budget: { db, claims: budgetTestClaims, outputTokens: 80 },
    fetchImpl: async () => { publicCalls++; throw new Error('public fetch must not run'); },
  });
  assert.equal(result.ok, true);
  assert.equal(serviceCalls, 1);
  assert.equal(publicCalls, 0);
});

test('parallel hedge provider calls reserve independently before either provider fetch', async () => {
  const db = fakeD1();
  const claims = { ...budgetTestClaims, taskId: 'hedge-task', runId: 'hedge-run', maxTokens: 20_000 };
  await createBudgetTask(db, claims);
  let calls = 0;
  const result = await run({ model: 'budget-test', messages: [{ role: 'user', content: 'x'.repeat(12_000) }] }, {
    env: { OPENCODE_GO_API_KEYS: 'go-a,go-b' },
    config: { ladders: { 'budget-test': { build: ['opencode-go/test-free'] } } },
    store: memoryStore(2), budget: { db, claims, outputTokens: 80 },
    fetchImpl: async (_url, init) => {
      calls++;
      assert.ok(db._reservations.size >= calls, 'each hedge lane reserves before its own provider call');
      assert.equal(JSON.parse(init.body).max_tokens, 80);
      return Response.json({ choices: [{ message: { content: 'hedge answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1 } });
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.equal(db._reservations.size, 2);
  assert.deepEqual([...db._reservations.values()].map((row) => row.status).sort(), ['settled', 'settled']);
  assert.equal(db._tasks.get('hedge-task|hedge-run').spent_tokens, 22);
});

test('provider boundary denies before fetch when aggregate allowance is exhausted', async () => {
  const db = fakeD1();
  await createBudgetTask(db, budgetTestClaims);
  await reserveTokenBudget(db, budgetTestClaims, 'already-used', 990);
  let calls = 0;
  const result = await run({ model: 'budget-test', messages: [{ role: 'user', content: 'hello' }] }, {
    env: { OPENROUTER_API_KEY: 'test-key' },
    config: { ladders: { 'budget-test': { build: ['openrouter/inclusionai/ling-3.0-flash-sante:free'] } } },
    store: memoryStore(0), budget: { db, claims: budgetTestClaims, outputTokens: 100 },
    fetchImpl: async () => { calls++; return Response.json({}); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 429);
  assert.equal(calls, 0);
});

test('response-format retry reserves a distinct attempt and settles unknown first outcome', async () => {
  const db = fakeD1();
  await createBudgetTask(db, budgetTestClaims);
  let calls = 0;
  const result = await run({ model: 'budget-test', response_format: { type: 'json_object' }, messages: [{ role: 'user', content: 'return json' }] }, {
    env: { OPENROUTER_API_KEY: 'test-key' },
    config: { ladders: { 'budget-test': { build: ['openrouter/inclusionai/ling-3.0-flash-sante:free'] } } },
    store: memoryStore(0), budget: { db, claims: budgetTestClaims, outputTokens: 100 },
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return new Response('response_format unsupported', { status: 400 });
      return Response.json({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5 } });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.equal(db._reservations.size, 2);
  assert.deepEqual([...db._reservations.values()].map((row) => row.status).sort(), ['settled', 'unknown']);
  const inputEstimate = estimateBudgetInput({ model: 'budget-test', response_format: { type: 'json_object' }, messages: [{ role: 'user', content: 'return json' }] }).estimatedTokens;
  assert.equal(db._tasks.get('task-1|run-1').spent_tokens, inputEstimate + 100 + 25);
});

test('network-unknown outcome retains the provider attempt reservation', async () => {
  const db = fakeD1();
  await createBudgetTask(db, budgetTestClaims);
  const result = await run({ model: 'budget-test', messages: [{ role: 'user', content: 'maybe sent' }] }, {
    env: { OPENROUTER_API_KEY: 'test-key' },
    config: { ladders: { 'budget-test': { build: ['openrouter/inclusionai/ling-3.0-flash-sante:free'] } } },
    store: memoryStore(0), budget: { db, claims: budgetTestClaims, outputTokens: 100 },
    fetchImpl: async () => { throw new Error('connection reset after send'); },
  });
  assert.equal(result.ok, false);
  assert.equal([...db._reservations.values()][0].status, 'unknown');
  assert.equal(db._tasks.get('task-1|run-1').spent_tokens, [...db._reservations.values()][0].reserved_tokens);
});

test('streaming provider boundary settles usage from the terminal SSE event', async () => {
  const db = fakeD1();
  await createBudgetTask(db, budgetTestClaims);
  const model = 'openrouter/inclusionai/ling-3.0-flash-sante:free';
  const body = { model: 'budget-test', stream: true, messages: [{ role: 'user', content: 'stream it' }], max_tokens: 70 };
  const result = await run(body, {
    env: { OPENROUTER_API_KEY: 'test-key' },
    config: { ladders: { 'budget-test': { build: [model] } } },
    store: memoryStore(0), budget: { db, claims: budgetTestClaims, outputTokens: 100 },
    fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: {"choices":[],"usage":{"prompt_tokens":18,"completion_tokens":2}}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } }),
  });
  assert.equal(result.ok, true);
  await new Response(result.stream).text();
  assert.equal(db._tasks.get('task-1|run-1').spent_tokens, 20);
  assert.equal([...db._reservations.values()][0].status, 'settled');
});

test('HTTP route requires and verifies the internal capability when sandbox policy is enabled', async () => {
  const db = fakeD1();
  const secret = 'sandbox-only-budget-secret-with-32-bytes-minimum';
  let calls = 0;
  const env = {
    LADDER_TOKEN: 'ladder-test-token', OPENROUTER_API_KEY: 'provider-test-key',
    HARD_BUDGET_REQUIRED: 'true', HARD_BUDGET_DB: db,
    HARD_BUDGET_HMAC_SECRET: secret, HARD_BUDGET_POLICY_ID: 'sandbox-v1',
    HARD_BUDGET_MAX_OUTPUT_TOKENS: '120', HARD_BUDGET_MAX_TASK_TOKENS: '10000',
  };
  const fetchImpl = async () => {
    calls++;
    return Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 2 } });
  };
  const request = (body, capability) => handle(new Request('https://ladder.test/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ladder-test-token', 'content-type': 'application/json', ...(capability ? { 'x-ladder-budget-capability': capability } : {}) },
    body: JSON.stringify(body),
  }), env, { store: memoryStore(0), fetchImpl });
  const body = { model: 'service', messages: [{ role: 'user', content: 'sandbox capability test' }], max_tokens: 80 };

  const missing = await request(body);
  assert.equal(missing.status, 401);
  assert.equal(calls, 0);
  const signed = await signBudgetCapability({ ...budgetTestClaims, expiresAt: Math.floor(Date.now() / 1000) + 300 }, secret);
  const accepted = await request(body, signed);
  assert.equal(accepted.status, 200);
  assert.equal(calls, 1);
  assert.equal(db._tasks.get('task-1|run-1').spent_tokens, 14);
  const forged = await request({ ...body, model: 'service' }, `${signed.slice(0, -2)}xx`);
  assert.equal(forged.status, 403);
  assert.equal(calls, 1, 'invalid capability is rejected before any provider call');
});
