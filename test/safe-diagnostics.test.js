import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/handler.js';
import { memoryStore } from '../src/state.js';
import { safeAttemptDiagnostics } from '../src/diagnostics.js';

test('safe attempt diagnostics preserve provider source and status without provider text', () => {
  const diagnostics = safeAttemptDiagnostics([
    { model: 'openrouter/example/model:free', outcome: 'error', key: 2,
      error: 'HTTP 503: body contains private prompt and upstream details' },
    { model: 'opencode-go/model', outcome: 'error', error: 'fetch failed: request timed out with private context' },
    { model: 'zen-rings/model', outcome: 'error', error: 'zen-rings: warming up (3s left), private detail' },
  ]);
  assert.deepEqual(diagnostics, [
    { model: 'openrouter/example/model:free', outcome: 'error', source: 'provider',
      reason_code: 'provider_http_error', http_status: 503, error: 'provider returned HTTP 503' },
    { model: 'opencode-go/model', outcome: 'error', source: 'provider',
      reason_code: 'provider_timeout', error: 'provider timed out' },
    { model: 'zen-rings/model', outcome: 'error', source: 'zen_pool',
      reason_code: 'provider_capacity', error: 'Zen worker capacity unavailable' },
  ]);
  assert.equal(JSON.stringify(diagnostics).includes('private'), false);
  assert.equal(JSON.stringify(diagnostics).includes('key'), false);
});

test('real chat handler returns a stable provider outage and stores only sanitized diagnostics', async () => {
  const traceRows = [];
  const traceDb = { prepare() {
    const statement = { bind(...values) { statement.values = values; return statement; },
      async run() { traceRows.push(statement.values); return { success: true }; } };
    return statement;
  } };
  const env = { LADDER_TOKEN: 'ladder-test', OPENROUTER_API_KEY: 'not-a-real-key', LADDER_TRACE_DB: traceDb };
  const events = [];
  const log = console.log;
  const logged = [];
  console.log = (line) => logged.push(String(line));
  try {
    const response = await handle(new Request('https://ladder.test/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ladder-test', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'free',
        ladder_rung: 'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
        messages: [{ role: 'user', content: 'synthetic timeout check' }],
      }),
    }), env, {
      store: memoryStore(10),
      events: { publishError: async (event) => events.push(event) },
      fetchImpl: async () => {
        throw new Error('synthetic timeout after PRIVATE_UPSTREAM_BODY and synthetic timeout check');
      },
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error.message, 'every rung failed');
    assert.equal(body.error.reason_code, 'provider_unavailable');
    assert.equal(body.error.service_status, 'operational');
    assert.equal(body.error.attempts.length, 1, 'pinned verification measures exactly one provider attempt');
    assert.deepEqual(body.error.attempts.map((attempt) => attempt.outcome), ['error']);
    for (const attempt of body.error.attempts) assert.deepEqual(attempt, {
      model: 'openrouter/nvidia/nemotron-3-super-120b-a12b:free', outcome: attempt.outcome,
      source: 'provider', reason_code: 'provider_timeout', error: 'provider timed out',
    });
    const storedAttempts = JSON.parse(traceRows[0][10]);
    assert.deepEqual(storedAttempts, body.error.attempts, 'durable call traces get only safe diagnostics');
    const serialized = JSON.stringify({ body, logged, events, storedAttempts });
    assert.equal(serialized.includes('PRIVATE_UPSTREAM_BODY'), false);
    assert.equal(serialized.includes('synthetic timeout check'), false);
    assert.equal(serialized.includes('not-a-real-key'), false);
    assert.equal(logged.length, 1, 'one sanitized terminal record is emitted');
    assert.equal(JSON.parse(logged[0]).attempts[0].reason_code, 'provider_timeout');
  } finally {
    console.log = log;
  }
});
