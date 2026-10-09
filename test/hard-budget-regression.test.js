import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createBudgetTask, reserveTokenBudget, reconcileTokenBudget } from '../src/hard-budget.js';
import { run } from '../src/ladder.js';
import { estimateBudgetInput } from '../src/size-policy.js';
import { memoryStore } from '../src/state.js';

// Execute the production SQL rather than duplicating its admission predicate in fakeD1.
// D1 batches are transactional; this adapter preserves that and SQLite's changes() semantics.
function sqliteD1(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema/migrations/0006_hard_budget.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  return {
    prepare(sql) {
      const query = sqlite.prepare(sql);
      let bindings = {};
      const statement = {
        bind(...values) {
          bindings = Object.fromEntries(values.map((value, i) => [`?${i + 1}`, value]));
          return statement;
        },
        execute() { return { meta: { changes: Number(query.run(bindings).changes) } }; },
        async run() { return statement.execute(); },
        async first() { return query.get(bindings) ?? null; },
      };
      return statement;
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

const claims = { taskId: 'regression-task', runId: 'run-1', policyId: 'sandbox-v1', maxTokens: 1000 };
const model = 'openrouter/inclusionai/ling-3.0-flash-sante:free';
const config = { ladders: { 'budget-regression': { build: [model] } } };
const taskRow = (db, scope = claims) => db.prepare('SELECT * FROM ladder_budget_tasks WHERE task_id = ?1 AND run_id = ?2')
  .bind(scope.taskId, scope.runId).first();
const reservationRows = (db, scope = claims) => db.prepare('SELECT COUNT(*) AS n FROM ladder_budget_reservations WHERE task_id = ?1 AND run_id = ?2')
  .bind(scope.taskId, scope.runId).first();

test('settled usage remains charged when admitting the next attempt in the same run', async (t) => {
  const db = sqliteD1(t);
  await createBudgetTask(db, claims);
  assert.equal((await reserveTokenBudget(db, claims, 'first', 800)).reserved, true);
  await reconcileTokenBudget(db, claims, 'first', 700, 'settled');
  assert.equal((await reserveTokenBudget(db, claims, 'over-limit', 301)).reserved, false);
  assert.equal((await reserveTokenBudget(db, claims, 'exact-remainder', 300)).reserved, true);
  const row = await taskRow(db);
  assert.equal(row.spent_tokens + row.reserved_tokens, claims.maxTokens);
});

test('unknown outcomes retain their entire charge for subsequent attempts in the same run', async (t) => {
  const db = sqliteD1(t);
  await createBudgetTask(db, claims);
  await reserveTokenBudget(db, claims, 'unknown', 600);
  await reconcileTokenBudget(db, claims, 'unknown', null, 'unknown');
  const denied = await reserveTokenBudget(db, claims, 'next', 401);
  assert.equal(denied.reserved, false);
  assert.equal(denied.reason, 'budget_exhausted');
  assert.equal((await taskRow(db)).spent_tokens, 600);
  assert.equal((await reservationRows(db)).n, 1);
});

test('concurrent admissions respect the remaining allowance after settlement', async (t) => {
  const db = sqliteD1(t);
  await createBudgetTask(db, claims);
  await reserveTokenBudget(db, claims, 'spent', 600);
  await reconcileTokenBudget(db, claims, 'spent', 600, 'settled');
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => reserveTokenBudget(db, claims, `hedge-${i}`, 100)));
  assert.equal(results.filter((result) => result.reserved).length, 4);
  assert.equal(results.filter((result) => result.reason === 'budget_exhausted').length, 6);
  const row = await taskRow(db);
  assert.equal(row.spent_tokens + row.reserved_tokens, claims.maxTokens);
});

test('a new run gets an independent allowance; revalidating the same run does not reset it', async (t) => {
  const db = sqliteD1(t);
  await createBudgetTask(db, claims);
  await reserveTokenBudget(db, claims, 'exhausted', 1000);
  await reconcileTokenBudget(db, claims, 'exhausted', null, 'unknown');
  await createBudgetTask(db, claims);
  assert.equal((await taskRow(db)).spent_tokens, 1000);
  const nextRun = { ...claims, runId: 'run-2' };
  await createBudgetTask(db, nextRun);
  assert.equal((await reserveTokenBudget(db, nextRun, 'exhausted', 1000)).reserved, true);
  assert.equal((await taskRow(db, nextRun)).spent_tokens, 0);
  assert.equal((await taskRow(db, nextRun)).reserved_tokens, 1000);
  assert.equal((await taskRow(db)).spent_tokens, 1000);
});

test('failover cannot invoke another provider after an unknown attempt consumes the run allowance', async (t) => {
  const db = sqliteD1(t);
  const body = { model: 'budget-regression', messages: [{ role: 'user', content: 'hello' }], max_tokens: 80 };
  const scope = { ...claims, maxTokens: estimateBudgetInput(body).estimatedTokens + 80 };
  await createBudgetTask(db, scope);
  let calls = 0;
  const result = await run(body, {
    env: { OPENROUTER_API_KEY: 'synthetic-key' },
    config: { ladders: { 'budget-regression': { build: [model, 'openrouter/google/gemini-2.5-flash-lite'] } } },
    store: memoryStore(0), budget: { db, claims: scope, outputTokens: 80 },
    fetchImpl: async () => { calls++; throw new Error('connection reset after send'); },
  });
  assert.equal(calls, 1, 'failover must be denied before its provider fetch');
  assert.equal(result.status, 429);
  assert.equal((await reservationRows(db)).n, 1);
});

for (const exhausted of [false, true]) {
  test(`stream response-format retry ${exhausted ? 'is denied before fetch when the run is exhausted' : 'reserves separately and preserves the strict output cap'}`, async (t) => {
    const db = sqliteD1(t);
    const body = {
      model: 'budget-regression', stream: true, max_tokens: 80,
      response_format: { type: 'json_object' }, messages: [{ role: 'user', content: 'return json' }],
    };
    const firstAmount = estimateBudgetInput(body).estimatedTokens + 80;
    const scope = { ...claims, maxTokens: exhausted ? firstAmount : 1000 };
    await createBudgetTask(db, scope);
    const calls = [];
    const result = await run(body, {
      env: { OPENROUTER_API_KEY: 'synthetic-key' }, config, store: memoryStore(0),
      budget: { db, claims: scope, outputTokens: 100 },
      fetchImpl: async (_url, init) => {
        calls.push({ body: JSON.parse(init.body), reservations: (await reservationRows(db)).n });
        if (calls.length === 1) return new Response('response_format unsupported', { status: 400 });
        return new Response([
          'data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"}}]}',
          'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":5}}',
          'data: [DONE]', '',
        ].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    if (exhausted) {
      if (result.stream) await new Response(result.stream).text();
      assert.equal(calls.length, 1, 'an exhausted run must not send the response-format retry');
      assert.equal(result.status, 429);
      assert.equal((await reservationRows(db)).n, 1);
    } else {
      assert.equal(result.ok, true);
      await new Response(result.stream).text();
      assert.equal(calls.length, 2);
      assert.deepEqual(calls.map((call) => call.reservations), [1, 2], 'each fetch must have its own reservation');
      assert.deepEqual(calls.map((call) => call.body.max_tokens), [80, 80]);
      assert.equal(calls[1].body.response_format, undefined);
      const row = await taskRow(db);
      assert.equal(row.reserved_tokens, 0);
      assert.equal(row.spent_tokens, firstAmount + 25);
    }
  });
}
