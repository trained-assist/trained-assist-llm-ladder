import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBudgetTask,
  reconcileTokenBudget,
  reserveTokenBudget,
  signBudgetCapability,
  verifyBudgetCapability,
} from '../src/hard-budget.js';

const NOW = 1_800_000_000;
const SECRET = 'test-only-budget-secret-with-at-least-thirty-two-bytes';
const claims = Object.freeze({
  v: 1, issuer: 'trained-assist-cp', audience: 'trained-assist-llm-ladder',
  taskId: 'task-1', runId: 'run-1', policyId: 'sandbox-v1', maxTokens: 1000,
  expiresAt: NOW + 300,
});

function fakeD1() {
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
  const token = await signBudgetCapability(claims, SECRET, NOW);
  assert.deepEqual(await verifyBudgetCapability(token, SECRET, { taskId: 'task-1', runId: 'run-1', policyId: 'sandbox-v1' }, NOW), claims);
  await assert.rejects(verifyBudgetCapability(token, SECRET, { runId: 'other-run' }, NOW), /mismatch/);
  await assert.rejects(verifyBudgetCapability(token, `${SECRET}!`, {}, NOW), /signature/);
  await assert.rejects(verifyBudgetCapability(token, SECRET, {}, NOW + 301), /expired/);
  const malformed = await signBudgetCapability({ ...claims, maxTokens: 0 }, SECRET, NOW).catch((error) => error);
  assert.match(malformed.message, /token ceiling/);
});

test('concurrent reservations cannot exceed the task ceiling and denied reservations invoke no provider', async () => {
  const db = fakeD1();
  await createBudgetTask(db, claims);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => reserveTokenBudget(db, claims, `attempt-${i}`, 100)));
  assert.equal(results.filter((result) => result.reserved).length, 10);
  assert.equal(results.filter((result) => result.reason === 'budget_exhausted').length, 2);
  assert.equal(db._tasks.get('task-1|run-1').reserved_tokens, 1000);
});

test('retries reserve separately; idempotent reservation cannot inflate or change its amount', async () => {
  const db = fakeD1();
  await createBudgetTask(db, claims);
  assert.equal((await reserveTokenBudget(db, claims, 'attempt-1', 250)).reserved, true);
  const replay = await reserveTokenBudget(db, claims, 'attempt-1', 250);
  assert.equal(replay.replay, true);
  assert.equal(replay.reserved, false, 'an existing attempt must never be invoked a second time');
  await assert.rejects(reserveTokenBudget(db, claims, 'attempt-1', 251), /different amount/);
  assert.equal((await reserveTokenBudget(db, claims, 'attempt-2', 250)).reserved, true);
  assert.equal(db._tasks.get('task-1|run-1').reserved_tokens, 500);
});

test('unknown provider outcome retains the full reservation; measured usage settles it', async () => {
  const db = fakeD1();
  await createBudgetTask(db, claims);
  await reserveTokenBudget(db, claims, 'unknown-attempt', 400);
  assert.deepEqual(await reconcileTokenBudget(db, claims, 'unknown-attempt', null, 'unknown'), { status: 'unknown', chargedTokens: 400 });
  assert.equal(db._tasks.get('task-1|run-1').reserved_tokens, 0);
  assert.equal(db._tasks.get('task-1|run-1').spent_tokens, 400);

  await reserveTokenBudget(db, claims, 'known-attempt', 300);
  assert.deepEqual(await reconcileTokenBudget(db, claims, 'known-attempt', 120, 'settled'), { status: 'settled', chargedTokens: 120 });
  assert.equal(db._tasks.get('task-1|run-1').reserved_tokens, 0);
  assert.equal(db._tasks.get('task-1|run-1').spent_tokens, 520);
});

test('usage above reservation fails closed and leaves the reservation charged', async () => {
  const db = fakeD1();
  await createBudgetTask(db, claims);
  await reserveTokenBudget(db, claims, 'overspend-attempt', 100);
  await assert.rejects(reconcileTokenBudget(db, claims, 'overspend-attempt', 101, 'settled'), /exceeded reservation/);
  assert.equal(db._tasks.get('task-1|run-1').reserved_tokens, 100);
  assert.equal(db._tasks.get('task-1|run-1').spent_tokens, 0);
});

test('ledger outage fails before a provider attempt', async () => {
  await assert.rejects(reserveTokenBudget(null, claims, 'attempt-1', 100), /unavailable/);
});
