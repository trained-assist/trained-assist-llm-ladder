import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/handler.js';
import { memoryStore } from '../src/state.js';
import ladders from '../config/ladders.json' with { type: 'json' };

const rung = ladders.ladders.service.build.find(model => model.startsWith('openrouter/'));
const encoder = new TextEncoder();
const first = encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
const tail = 'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":4}}}\n\ndata: [DONE]\n\n';

function fixture() {
  const rows = [];
  const background = [];
  const db = { prepare() { return { bind(...values) { return { async run() { rows.push(values); } }; } }; } };
  let upstream;
  let cancelled = false;
  const source = new ReadableStream({
    start(controller) { upstream = controller; controller.enqueue(first); },
    cancel() { cancelled = true; },
  });
  const request = new Request('https://fixture.test/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer fixture', 'content-type': 'application/json', 'x-ladder-trace': 'stream-fixture' },
    body: JSON.stringify({ model: 'service', ladder_rung: rung, stream: true, messages: [{ role: 'user', content: 'fixture' }] }),
  });
  const serve = () => handle(request, { LADDER_TOKEN: 'fixture', OPENROUTER_API_KEY: 'synthetic', LADDER_TRACE_DB: db }, {
    store: memoryStore(1), waitUntil: promise => background.push(promise),
    fetchImpl: async () => new Response(source, { headers: { 'content-type': 'text/event-stream' } }),
  });
  return { serve, rows, background, get upstream() { return upstream; }, get cancelled() { return cancelled; } };
}

test('stream trace waits for [DONE], preserves bytes, and records final usage once', async () => {
  const f = fixture();
  const response = await f.serve();
  assert.equal(response.status, 200);
  assert.equal(f.rows.length, 0, 'first token is not a completed call');
  const reader = response.body.getReader();
  const chunks = [];
  chunks.push((await reader.read()).value);
  assert.equal(f.rows.length, 0, 'first delivered bytes do not settle the trace');
  f.upstream.enqueue(encoder.encode(tail.slice(0, 22)));
  f.upstream.enqueue(encoder.encode(tail.slice(22, -5)));
  f.upstream.enqueue(encoder.encode(tail.slice(-5)));
  f.upstream.close();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  await Promise.all(f.background);
  const actual = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString();
  assert.equal(actual, new TextDecoder().decode(first) + tail);
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0][7], 1, 'ok only after terminal frame and EOF');
  assert.equal(f.rows[0][11], 7);
  assert.equal(f.rows[0][12], 3);
  assert.equal(f.rows[0][13], 4);
});

test('EOF without [DONE] records an incomplete stream with unknown usage', async () => {
  const f = fixture();
  const response = await f.serve();
  f.upstream.close();
  await response.text();
  await Promise.all(f.background);
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0][7], 0);
  assert.equal(f.rows[0][11], null);
  assert.equal(JSON.parse(f.rows[0][10]).at(-1).outcome, 'stream_incomplete');
});

test('an SSE error after first output is not counted as success even with [DONE]', async () => {
  const f = fixture();
  const response = await f.serve();
  f.upstream.enqueue(encoder.encode('event: error\ndata: {"error":{"type":"upstream"}}\n\ndata: [DONE]\n\n'));
  f.upstream.close();
  await response.text();
  await Promise.all(f.background);
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0][7], 0);
});

test('client cancellation settles once as incomplete and cancels upstream', async () => {
  const f = fixture();
  const response = await f.serve();
  await response.body.cancel('client left');
  await Promise.all(f.background);
  assert.equal(f.cancelled, true);
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0][7], 0);
});
