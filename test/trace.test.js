import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTrace, logCall } from '../src/trace.js';

function call(extraHeaders = {}) {
  return new Request('https://llm-ladder.trainedassist.store/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: '{}',
  });
}

// Fake D1: captures every INSERT's bound params and lets us toggle a throw.
function fakeD1() {
  const rows = [];
  return {
    _rows: rows,
    _fail: false,
    prepare() {
      const d1 = this;
      return {
        bind(...values) {
          d1._pending = values;
          return this;
        },
        async run() {
          if (d1._fail) throw new Error('db down');
          rows.push(d1._pending);
          return { success: true };
        },
      };
    },
  };
}

function row(r) {
  const cols = ['ts', 'trace_id', 'run_id', 'user_id', 'chat_id', 'session_id', 'ladder', 'ok', 'model', 'ms', 'attempts', 'tokens_in', 'tokens_out', 'tokens_cached', 'app'];
  return Object.fromEntries(cols.map((c, i) => [c, r[i]]));
}

test('makeTrace: extracts all five headers, capped', () => {
  assert.deepEqual(makeTrace(call({
    'x-ladder-trace': 'task-123', 'x-ladder-run': 'run-1', 'x-ladder-user': 'u7',
    'x-ladder-chat': 'c42', 'x-ladder-session': 's-99',
  })), { traceId: 'task-123', runId: 'run-1', userId: 'u7', chatId: 'c42', sessionId: 's-99', app: null });
  assert.deepEqual(makeTrace(call()), { traceId: null, runId: null, userId: null, chatId: null, sessionId: null, app: null });
  assert.equal(makeTrace(call({ 'x-ladder-trace': '  ' })).traceId, null);
  assert.equal(makeTrace(call({ 'x-ladder-trace': 'x'.repeat(500) })).traceId.length, 200);
});

test('makeTrace: x-ladder-app (the caller sub-task tag) is read and capped like the ids', () => {
  // #107: this is the only thing that tells apart the ~20 service tools that all post
  // model="service" — without it the cost cut cannot answer "which sub-task spends".
  assert.equal(makeTrace(call({ 'x-ladder-app': 'tg-format' })).app, 'tg-format');
  assert.equal(makeTrace(call({ 'x-ladder-app': '  ' })).app, null);
  assert.equal(makeTrace(call({ 'x-ladder-app': 'y'.repeat(500) })).app.length, 200);
});

test('logCall: no D1 binding → no-op, no throw; db error swallowed', async () => {
  const tracer = { traceId: 't1', runId: null, userId: 'u1', chatId: null, sessionId: null };
  const okRun = { ok: true, model: 'opencode-go/x', data: { usage: { prompt_tokens: 5, completion_tokens: 2 } } };
  await logCall({}, tracer, 'deepseek', okRun, Date.now());
  const d1 = fakeD1();
  d1._fail = true;
  await logCall({ LADDER_TRACE_DB: d1 }, tracer, 'deepseek', okRun, Date.now());
  assert.equal(d1._rows.length, 0);
});

test('logCall: writes a row with trace ids, ladder, attempts, and non-stream usage tokens', async () => {
  const d1 = fakeD1();
  const tracer = { traceId: 'task-777', runId: 'run-2', userId: 'user-alpha', chatId: 'chat-5', sessionId: 'ses-1' };
  const started = Date.now();
  await logCall({ LADDER_TRACE_DB: d1 }, tracer, 'deepseek', {
    ok: true, model: 'opencode-go/mimo', data: { usage: { prompt_tokens: 11, completion_tokens: 4 } },
    attempts: [{ model: 'opencode-go/mimo', outcome: 'ok' }],
  }, started);
  assert.equal(d1._rows.length, 1);
  const r = row(d1._rows[0]);
  assert.equal(r.trace_id, 'task-777');
  assert.equal(r.run_id, 'run-2');
  assert.equal(r.user_id, 'user-alpha');
  assert.equal(r.chat_id, 'chat-5');
  assert.equal(r.session_id, 'ses-1');
  assert.equal(r.ladder, 'deepseek');
  assert.equal(r.ok, 1);
  assert.equal(r.model, 'opencode-go/mimo');
  assert.equal(r.tokens_in, 11);
  assert.equal(r.tokens_out, 4);
  assert.equal(r.app, null, 'no x-ladder-app → null, the analytics cut skips the row');
  assert.ok(r.ts >= started);
  assert.equal(JSON.parse(r.attempts)[0].outcome, 'ok');
});

test('logCall: the caller sub-task tag lands in the row (#107)', async () => {
  const d1 = fakeD1();
  // The handler overwrites the raw header with the sanitised slug it sends to OpenRouter, so
  // the D1 cut and the OpenRouter "Application" cut can never name the same call differently.
  const tracer = { traceId: null, runId: null, userId: null, chatId: null, sessionId: null, app: 'session-summary' };
  await logCall({ LADDER_TRACE_DB: d1 }, tracer, 'service', {
    ok: true, model: 'opencode-go/mimo-v2.6-flash', data: { usage: { prompt_tokens: 9, completion_tokens: 3 } }, attempts: [],
  }, Date.now());
  assert.equal(row(d1._rows[0]).app, 'session-summary');
});

test('logCall: no trace ids → row still written with nulls; stream call has no usage → null tokens', async () => {
  const d1 = fakeD1();
  const tracer = { traceId: null, runId: null, userId: null, chatId: null, sessionId: null };
  await logCall({ LADDER_TRACE_DB: d1 }, tracer, 'free', {
    ok: true, model: 'opencode-go/mimo', stream: {}, data: undefined, attempts: [],
  }, Date.now());
  assert.equal(d1._rows.length, 1);
  const r = row(d1._rows[0]);
  for (const k of ['trace_id', 'run_id', 'user_id', 'chat_id', 'session_id', 'tokens_in', 'tokens_out']) assert.equal(r[k], null, k);
  assert.equal(r.ok, 1);
});