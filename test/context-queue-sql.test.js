import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { ringInvoke, zenRingRegister, zenRingPull, zenRingResult } from '../src/zen-ring.js';

test('real SQLite queue migrations preserve options and large JSON results through D1 calls', async () => {
  const sql = new DatabaseSync(':memory:');
  for (const path of ['schema/zen.sql', 'schema/zen-pool.sql', 'schema/migrations/0004_zen_pool_payload.sql', 'schema/migrations/0008_zen_pool_options.sql']) {
    sql.exec(readFileSync(new URL('../' + path, import.meta.url), 'utf8'));
  }
  const d1 = { prepare(query) {
    let args = [];
    const stmt = { bind(...values) { args = values; return stmt; },
      async first() { return sql.prepare(query).get(...args) ?? null; },
      async all() { return { results: sql.prepare(query).all(...args) }; },
      async run() { const r = sql.prepare(query).run(...args); return { meta: { changes: r.changes } }; },
    }; return stmt;
  } };
  const env = { ZEN_DB: d1, ZEN_RUNNER_TOKEN: 'test-token' };
  const request = (path, body) => new Request('https://test' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer test-token' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    const lease = (await (await zenRingRegister(request('/zen/pool/register', { worker_id: 'sql-worker' }), env)).json()).lease_id;
    const controls = { response_format: { type: 'json_object' }, tool_choice: 'none' };
    const pending = ringInvoke(env, { model: 'big-pickle', messages: [{ role: 'user', content: 'Read original' }], ...controls, wait_ms: 1000 });
    await new Promise(resolve => setTimeout(resolve, 20));
    const task = (await (await zenRingPull(request(`/zen/pool/pull?lease=${lease}&hold_ms=5000`), env)).json()).task;
    assert.deepEqual(task.options, controls);
    const text = JSON.stringify({ answer: 'answer'.repeat(3000) });
    const call = { id: 'call', type: 'function', function: { name: 'write', arguments: JSON.stringify({ code: 'x'.repeat(12000) }) } };
    const response = await zenRingResult(request('/zen/pool/result', { task_id: task.id, ok: true, text, tool_calls: [call] }), env);
    assert.equal(response.status, 200);
    const result = await pending;
    assert.equal(result.status, 200); assert.equal(result.data.text, text); assert.deepEqual(result.data.tool_calls, [call]);
  } finally { sql.close(); }
});
