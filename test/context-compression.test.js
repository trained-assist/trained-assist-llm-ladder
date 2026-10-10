import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { run, resetFreeGoKeyCursor } from '../src/ladder.js';
import { handle } from '../src/handler.js';
import { memoryStore } from '../src/state.js';
import { requestBytes, paidRung, createCompressionSession, COMPRESSION_TARGET_RATIO } from '../src/context-compression.js';
import { compressRequest } from '../vendor/context-chunks-mcp/src/core.js';
import { isEmptyAnswer } from '../src/answer-guard.js';

const free = 'opencode-go/longcat-2.5-preview-free', paid = 'opencode-go/mimo-v2.6-flash';
const config = { ladders: { service: { build: [free, paid, 'openrouter/example/fallback:free'] } } };
const env = { OPENCODE_GO_API_KEYS: 'key-a', OPENROUTER_API_KEY: 'or-key' };

function sized(bytes, extra = {}) {
  const body = { model: 'service', messages: [{ role: 'assistant', content: '' }, { role: 'user', content: 'Check the earlier result.' }], ...extra };
  body.messages[0].content = 'x'.repeat(bytes - requestBytes(body));
  assert.equal(requestBytes(body), bytes); return body;
}
const completion = (content, extra = {}) => ({ id: 'test-id', object: 'chat.completion', created: 1,
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, ...extra });
function mockFetch(fn) {
  const calls = [];
  return { calls, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body), call = { url, body, auth: init.headers.Authorization };
    calls.push(call); const out = await fn(call, calls.length);
    return new Response(JSON.stringify(out?.data || completion(out?.content ?? '{"answer":"done"}')), { status: out?.status || 200 });
  } };
}
function options(mock, overrides = {}) { return { env, config, store: memoryStore(), fetchImpl: mock.fetchImpl, ...overrides }; }
function spyCompression() {
  const applications = [], snapshots = [];
  return { applications, snapshots, compressor: (body, opts) => {
    applications.push(requestBytes(body)); const result = compressRequest(body, opts); snapshots.push(result.snapshot); return result;
  } };
}
const firstRef = body => body.messages.find(m => typeof m.content === 'string' && /context ref=ctx:/.test(m.content)).content.match(/ref=([^;]+);/)[1];

test('vendored core matches its pinned upstream manifest exactly', () => {
  const base = new URL('../vendor/context-chunks-mcp/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', base)));
  assert.equal(manifest.repository, 'trained-assist/context-chunks-mcp');
  assert.equal(manifest.ref, '06804e05c8fe4ce4dace6d6deed43cc33ad7d132');
  for (const [path, hash] of Object.entries(manifest.files)) assert.equal(createHash('sha256').update(readFileSync(new URL(path, base))).digest('hex'), hash, path);
});

test('paid status comes from the canonical price table, including subscription Go', () => {
  assert.equal(paidRung(free), false); assert.equal(paidRung(paid), true);
  assert.equal(paidRung('zen-rings/big-pickle'), false);
  assert.equal(paidRung('openrouter/google/gemini-2.5-flash'), true);
  assert.equal(paidRung('custom/charged', { 'custom/charged': [1, 0, 0] }), true);
});

test('empty-answer guard rejects placeholders without rejecting useful short answers', () => {
  for (const value of ['', ' ', '.', '...', '?', '…']) assert.equal(isEmptyAnswer(value), true, value);
  for (const value of ['да', 'нет', 'OK', '0', '4', '👍', '{}', '[]']) assert.equal(isEmptyAnswer(value), false, value);
});

test('ordinary punctuation answer retries once and then descends to the next rung', async () => {
  const mock = mockFetch(({ body }) => ({ content: body.model === free.split('/')[1] ? '.' : 'done' }));
  const result = await run(sized(1000), options(mock));
  assert.ok(result.ok); assert.equal(result.content, 'done'); assert.equal(result.model, paid);
  assert.deepEqual(mock.calls.map(c => c.body.model), [free, free, paid].map(m => m.split('/')[1]));
  assert.equal(result.attempts.filter(a => a.outcome === 'guard-retry').length, 1);
});

test('real-case invalid envelope then dot in repair descends without restarting or recompressing', async () => {
  const spy = spyCompression();
  const mock = mockFetch(({ body }, n) => ({ content: body.model !== free.split('/')[1] ? '{"answer":"done"}'
    : n === 1 ? '{"context":"archived context"}' : '{"answer":"."}' }));
  const result = await run(sized(400000), options(mock, { contextCompression: spy }));
  assert.ok(result.ok); assert.equal(result.content, 'done'); assert.equal(result.model, paid);
  assert.deepEqual(mock.calls.map(c => c.body.model), [free, free, paid].map(m => m.split('/')[1]));
  assert.equal(result.attempts.filter(a => a.outcome === 'contract-retry').length, 1);
  assert.equal(spy.applications.length, 1);
  assert.ok(mock.calls[2].body.messages.some(m => typeof m.content === 'string' && m.content.includes('context ref=')));
});

test('punctuation from every compressed rung returns an error instead of HTTP success', async () => {
  const mock = mockFetch(() => ({ content: '{"answer":"."}' }));
  const result = await run(sized(400000), options(mock));
  assert.equal(result.ok, false); assert.equal(result.status, 502);
  assert.equal(result.error, 'every rung failed');
  assert.equal(mock.calls.length, 6); // one initial call + one repair per rung
});

test('75% savings is a soft target: protected context below the target still produces an answer', async () => {
  const body = { model: 'service', messages: [
    { role: 'system', content: 'Keep these instructions. ' + 'p'.repeat(180000) },
    { role: 'assistant', content: 'Earlier output. ' + 'x'.repeat(220000) },
    { role: 'user', content: 'Check the earlier result.' },
  ] };
  let receivedOptions;
  const mock = mockFetch(() => ({ content: '{"answer":"done"}' }));
  const result = await run(body, options(mock, { contextCompression: { compressor: (input, opts) => {
    receivedOptions = opts; return compressRequest(input, opts);
  } } }));
  assert.ok(result.ok);
  assert.equal(result.content, 'done');
  assert.equal(receivedOptions.targetRatio, 0.25);
  assert.equal(COMPRESSION_TARGET_RATIO, 0.25);
  assert.equal(result.compression.budget, Math.floor(requestBytes(body) * 0.25));
  assert.equal(result.compression.targetMet, false);
  assert.ok(result.compression.savings > 0 && result.compression.savings < 0.75);
  assert.equal(mock.calls.length, 1);
  assert.ok(mock.calls[0].body.messages.some(m => m.content === body.messages[0].content));
});

test('static CI fixture saves at least 75% including contract overhead and preserves tool pairs', () => {
  const messages = [
    { role: 'system', content: 'Investigate the reported failures and retain the evidence.' },
    { role: 'assistant', content: 'Unrelated old archive. ' + 'z'.repeat(1_200_000) },
  ];
  for (let n = 0; n < 24; n++) {
    messages.push({ role: 'user', content: `Inspect batch ${n} of build results.` });
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `batch-${n}`, type: 'function', function: { name: 'read_build', arguments: JSON.stringify({ batch: n }) } }] });
    messages.push({ role: 'tool', tool_call_id: `batch-${n}`, content: Array.from({ length: 300 }, (_, i) => `2026-10-09T12:00:00Z INFO batch=${n} check=${i} validation completed successfully`).join('\n') });
  }
  messages.push({ role: 'user', content: 'Summarize the failures across all batches.' });
  const original = { model: 'service', messages }, session = createCompressionSession(original);
  try {
    const prepared = session.prepare('entry');
    assert.ok(requestBytes(prepared) <= requestBytes(original) * 0.25);
    assert.equal(prepared.messages.filter(m => m.tool_calls?.length).length, 24);
    assert.equal(prepared.messages.filter(m => m.role === 'tool').length, 24);
    assert.ok(prepared.messages.some(m => m.content === messages.at(-1).content));
  } finally { session.close(); }
});

test('the latest user turn preserves its full bash command and completed result', () => {
  const old = Array.from({ length: 30 }, (_, n) => ({ role: 'tool', tool_call_id: `old-${n}`, content: `old output ${n} ` + 'x'.repeat(22000) }));
  const command = 'cd /workspace/context-chunks-mcp && git remote add origin git@github.com:trained-assist/context-chunks-mcp.git 2>/dev/null || git remote set-url origin git@github.com:trained-assist/context-chunks-mcp.git';
  const active = [
    { role: 'user', content: 'Push this script to main and give me the link.' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'set-origin', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } }] },
    { role: 'tool', tool_call_id: 'set-origin', content: '(no output)' },
    { role: 'assistant', content: '' },
  ];
  const original = { model: 'service', tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }], messages: [
    { role: 'system', content: "Complete the user's task." },
    ...old, ...active,
  ] };
  const result = compressRequest(original, { targetRatio: 0.25 });
  assert.ok(result.compressed);
  assert.ok(result.stats.savings >= 0.75);
  assert.deepEqual(result.request.messages.slice(-active.length), active);
  assert.deepEqual(result.request.tools[0], original.tools[0]);
  assert.ok(result.request.messages.slice(0, -active.length).some(m => typeof m.content === 'string' && m.content.includes('context ref=')));
  assert.match(result.request.messages[0].content, /selected as relevant/);
});

test('compression always keeps the latest five user messages verbatim', () => {
  const users = Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: `Recent request ${i}: ` + 'detail '.repeat(80) }));
  const original = { model: 'service', messages: [
    { role: 'system', content: 'Follow the conversation.' },
    { role: 'tool', tool_call_id: 'old-output', content: 'unrelated tool output '.repeat(15000) },
    ...users,
  ] };
  const result = compressRequest(original, { targetRatio: 0.4 });
  assert.ok(result.compressed);
  for (const user of users.slice(-5)) assert.ok(result.request.messages.some(m => m.role === 'user' && m.content === user.content));
  assert.deepEqual(result.history.selected.slice(-4).map(m => m.sequence), [9, 10, 11, 12]);
  assert.ok(result.request.messages.find(m => m.tool_call_id === 'old-output').content.includes('context ref='));
});

test('a selected older user request keeps its full tool command and answer', () => {
  const command = 'git remote add origin git@github.com:trained-assist/context-chunks-mcp.git';
  const messages = [
    { role: 'system', content: 'Complete the current task.' },
    { role: 'tool', tool_call_id: 'large-old-output', content: 'irrelevant output '.repeat(20000) },
    { role: 'user', content: 'Push this repository to main and give me the GitHub link.' },
    { role: 'assistant', content: 'I will configure the remote and push it.' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'set-origin', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } }] },
    { role: 'tool', tool_call_id: 'set-origin', content: '(no output)' },
    { role: 'assistant', content: 'The origin remote is configured.' },
    { role: 'user', content: 'Unrelated old topic.' },
    { role: 'user', content: 'Can you finish pushing this repository and give me its link?' },
  ];
  const result = compressRequest({ model: 'service', messages }, { targetRatio: 0.4 });
  const start = messages.findIndex(m => m.role === 'user');
  const retainedStart = result.request.messages.findIndex(m => m.role === 'user' && m.content === messages[start].content);
  const retainedEnd = result.request.messages.findIndex((m, i) => i > retainedStart && m.role === 'user');
  const originalEnd = messages.findIndex((m, i) => i > start && m.role === 'user');
  assert.ok(result.history.selected.some(m => m.sequence === start));
  assert.deepEqual(result.request.messages.slice(retainedStart, retainedEnd), messages.slice(start, originalEnd));
  assert.ok(result.request.messages.find(m => m.tool_call_id === 'large-old-output').content.includes('context ref='));
  assert.ok(result.stats.savings >= 0.6);
});

for (const bytes of [349000, 350000, 350001, 351000]) test(`entry boundary ${bytes} bytes of full request`, async () => {
  const spy = spyCompression(), mock = mockFetch(() => ({ content: bytes > 350000 ? '{"answer":"done"}' : 'done' }));
  const result = await run(sized(bytes), options(mock, { contextCompression: spy }));
  assert.ok(result.ok); assert.equal(spy.applications.length, bytes > 350000 ? 1 : 0);
  assert.equal(mock.calls.length, 1);
  if (bytes > 350000) assert.equal(result.compression.trigger, 'entry');
});

for (const bytes of [99000, 99999, 100000, 101000, 200000]) test(`paid boundary ${bytes} bytes after free failure`, async () => {
  const spy = spyCompression(), mock = mockFetch(({ body }) => body.model === free.split('/')[1]
    ? { status: 503 } : { content: bytes >= 100000 ? '{"answer":"done"}' : 'done' });
  const result = await run(sized(bytes), options(mock, { contextCompression: spy }));
  assert.ok(result.ok); assert.equal(result.model, paid);
  assert.equal(spy.applications.length, bytes >= 100000 ? 1 : 0);
  if (bytes >= 100000) { assert.equal(result.compression.trigger, 'paid'); assert.ok(requestBytes(mock.calls.at(-1).body) < bytes); }
});

test('free success never triggers paid compression; entry compression is not repeated', async () => {
  const spy = spyCompression(), mock = mockFetch(() => ({ content: 'done' }));
  assert.ok((await run(sized(200000), options(mock, { contextCompression: spy }))).ok);
  assert.equal(spy.applications.length, 0);
  const largeSpy = spyCompression(), second = mockFetch(({ body }) => body.model === free.split('/')[1] ? { status: 503 } : { content: '{"answer":"done"}' });
  const result = await run(sized(400000), options(second, { contextCompression: largeSpy }));
  assert.ok(result.ok); assert.equal(largeSpy.applications.length, 1);
});

test('full UTF-8 request includes tool schemas and non-message fields in the threshold', async () => {
  const body = sized(349000); body.metadata = { extra: 'я'.repeat(1000) };
  const spy = spyCompression(), mock = mockFetch(() => ({ content: '{"answer":"done"}' }));
  assert.ok((await run(body, options(mock, { contextCompression: spy }))).ok);
  assert.equal(spy.applications.length, 1);
  const schema = sized(99000); schema.tools = [{ type: 'function', function: { name: 'external', description: 'д'.repeat(1000), parameters: { type: 'object' } } }];
  const secondSpy = spyCompression(), second = mockFetch(({ body }) => body.model === free.split('/')[1] ? { status: 503 } : { content: '{"answer":"done"}' });
  assert.ok((await run(schema, options(second, { contextCompression: secondSpy }))).ok);
  assert.equal(secondSpy.applications.length, 1);
});

test('one ref read reveals exact originals and continues on the paid winner without ladder restart', async () => {
  const body = sized(400000), spy = spyCompression();
  const mock = mockFetch(({ body: outgoing }, n) => {
    if (outgoing.model === free.split('/')[1]) return { status: 503 };
    if (n === 2) return { content: JSON.stringify({ need_refs: [{ ref: firstRef(outgoing), offset: 123, limit: 111 }] }) };
    const pages = JSON.parse(outgoing.messages.at(-1).content.split('\n')[1]);
    assert.equal(pages[0].text, body.messages[0].content.slice(123, 234));
    assert.equal(pages[0].nextOffset, 234);
    return { content: '{"answer":"checked"}' };
  });
  const result = await run(body, options(mock, { contextCompression: spy }));
  assert.ok(result.ok); assert.equal(result.content, 'checked'); assert.equal(mock.calls.length, 3);
  assert.equal(mock.calls[1].body.model, mock.calls[2].body.model); assert.equal(mock.calls[1].auth, mock.calls[2].auth);
  assert.equal(spy.applications.length, 1); assert.equal(result.compression.refRounds, 1);
  assert.throws(() => spy.snapshots[0].read(firstRef(mock.calls[1].body)), /closed/);
});

test('unknown ref is explicit and independent runs cannot read previous refs', async () => {
  let oldRef;
  const first = mockFetch(({ body }, n) => { oldRef = firstRef(body); return { content: '{"answer":"first"}' }; });
  await run(sized(400000), options(first));
  const second = mockFetch(({ body }, n) => {
    if (n === 1) return { content: JSON.stringify({ need_refs: [oldRef] }) };
    const pages = JSON.parse(body.messages.at(-1).content.split('\n')[1]);
    assert.equal(pages[0].error, 'ref_not_found_or_invalid_page');
    return { content: '{"answer":"second"}' };
  });
  assert.equal((await run(sized(400000), options(second))).content, 'second');
});

test('contract repair after retrieval keeps the full conversation on the same winner', async () => {
  const mock = mockFetch(({ body }, n) => {
    if (n === 1) return { content: JSON.stringify({ need_refs: [firstRef(body)] }) };
    if (n === 2) return { content: 'not JSON' };
    const repair = JSON.parse(body.messages.at(-1).content);
    assert.match(repair.error, /valid JSON/); assert.equal(repair.previous_output.content, 'not JSON');
    assert.ok(body.messages.length > 2);
    assert.ok(body.messages.some(m => m.role === 'user' && m.content.includes('Check the earlier result.')));
    assert.ok(body.messages.some(m => typeof m.content === 'string' && m.content.includes('context ref=')));
    assert.deepEqual(body.tools, []);
    assert.ok(requestBytes(body) > 5000);
    return { content: '{"answer":"fixed"}' };
  });
  const result = await run(sized(400000), options(mock));
  assert.equal(result.content, 'fixed'); assert.equal(mock.calls.length, 3);
  assert.ok(result.compression.contractRetry); assert.equal(result.compression.refRounds, 1);
});

test('missing envelope field retries once, then fails instead of falling back or looping', async () => {
  const mock = mockFetch(() => ({ content: '{"other":"value"}' }));
  const result = await run(sized(400000), options(mock));
  assert.equal(result.ok, false); assert.match(result.error, /still invalid/); assert.equal(mock.calls.length, 2);
  assert.ok(mock.calls.every(c => c.body.model === free.split('/')[1]));
});

test('two retrieval rounds plus Lfix are at most four model steps', async () => {
  const mock = mockFetch(({ body }, n) => n < 3 ? { content: JSON.stringify({ need_refs: [firstRef(body)] }) }
    : n === 3 ? { content: '{}' } : { content: '{"answer":"fourth"}' });
  const result = await run(sized(400000), options(mock));
  assert.equal(result.content, 'fourth'); assert.equal(mock.calls.length, 4);
  const repeated = mockFetch(({ body }) => ({ content: JSON.stringify({ need_refs: [firstRef(body)] }) }));
  const stopped = await run(sized(400000), options(repeated));
  assert.equal(stopped.ok, false); assert.equal(repeated.calls.length, 3);
});

test('internal tool reads preserve ids and original external tools; external calls return to client', async () => {
  const external = { type: 'function', function: { name: 'write', parameters: { type: 'object' } } };
  const mock = mockFetch(({ body }, n) => {
    assert.deepEqual(body.tools[0], external);
    if (n === 1) return { data: completion(null, { choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'internal-1', type: 'function', function: { name: 'read_context', arguments: JSON.stringify({ ref: firstRef(body), limit: 30 }) } }] } }] }) };
    assert.equal(body.messages.at(-1).tool_call_id, 'internal-1');
    assert.equal(JSON.parse(body.messages.at(-1).content).text, 'x'.repeat(30));
    return { data: completion(null, { choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'external-1', type: 'function', function: { name: 'write', arguments: '{"path":"result.js"}' } }] } }] }) };
  });
  const result = await run(sized(400000, { tools: [external] }), options(mock));
  assert.ok(result.ok); assert.equal(result.data.choices[0].message.tool_calls[0].id, 'external-1');
  assert.equal(mock.calls.length, 2);
});

test('compressed streaming buffers internal reads and exposes only final client SSE', async () => {
  const mock = mockFetch(({ body }, n) => {
    assert.equal(body.stream, false);
    return { content: n === 1 ? JSON.stringify({ need_refs: [firstRef(body)] }) : '{"answer":"final text"}' };
  });
  const result = await run(sized(400000, { stream: true, stream_options: { include_usage: true } }), options(mock));
  const text = await new Response(result.stream).text();
  assert.match(text, /final text/); assert.doesNotMatch(text, /need_refs|ctx:/);
  assert.match(text, /\[DONE\]/); assert.match(text, /"total_tokens":30/);
});

test('continuation keeps the actual winning Go key from a raced initial call', async () => {
  resetFreeGoKeyCursor();
  const body = sized(400000); body.messages.unshift({ role: 'system', content: 'rules '.repeat(2000) });
  const mock = mockFetch(async ({ body, auth }, n) => {
    if (n <= 2) {
      if (auth.endsWith('key-a')) { await new Promise(resolve => setTimeout(resolve, 15)); return { content: '{"answer":"late"}' }; }
      return { content: JSON.stringify({ need_refs: [firstRef(body)] }) };
    }
    assert.equal(auth, 'Bearer key-b'); return { content: '{"answer":"winner"}' };
  });
  const result = await run(body, options(mock, { env: { ...env, OPENCODE_GO_API_KEYS: 'key-a,key-b' } }));
  assert.equal(result.content, 'winner'); assert.equal(mock.calls.length, 3);
});

test('actual provider model outside configured ladder is used for continuation', async () => {
  const mock = mockFetch(({ body }, n) => {
    if (n === 1) return { data: completion(JSON.stringify({ need_refs: [firstRef(body)] }), { model: 'actual-free-model' }) };
    assert.equal(body.model, 'actual-free-model');
    return { data: completion('{"answer":"same actual model"}', { model: 'actual-free-model' }) };
  });
  const result = await run(sized(400000), options(mock));
  assert.equal(result.model, 'opencode-go/actual-free-model'); assert.equal(mock.calls.length, 2);
});

test('pinned continuation failure terminates and does not restart paid/free routing', async () => {
  const mock = mockFetch(({ body }, n) => n === 1 ? { content: JSON.stringify({ need_refs: [firstRef(body)] }) } : { status: 503 });
  const result = await run(sized(400000), options(mock));
  assert.equal(result.ok, false); assert.match(result.error, /continuation failed/); assert.equal(mock.calls.length, 2);
});

test('caller JSON schema required field is checked after unwrapping answer', async () => {
  const mock = mockFetch((c, n) => ({ content: n === 1 ? '{"answer":{}}' : '{"answer":{"result":"yes"}}' }));
  const result = await run(sized(400000, { response_format: { type: 'json_schema', json_schema: { schema: { type: 'object', required: ['result'] } } } }), options(mock));
  assert.equal(result.content, '{"result":"yes"}'); assert.equal(mock.calls.length, 2);
});

test('native caller JSON schema and local refs survive the retrieval envelope', async () => {
  const schema = { type: 'object', required: ['result'], properties: { result: { $ref: '#/$defs/value' } }, $defs: { value: { type: 'string', enum: ['yes'] } } };
  const mock = mockFetch(({ body }) => {
    assert.equal(body.response_format.type, 'json_schema');
    const wrapped = body.response_format.json_schema.schema;
    assert.deepEqual(wrapped.$defs.caller_answer.$defs, schema.$defs);
    assert.equal(wrapped.$defs.caller_answer.properties.result.$ref, '#/$defs/caller_answer/$defs/value');
    assert.equal(wrapped.properties.answer.anyOf[0].$ref, '#/$defs/caller_answer');
    return { content: '{"answer":{"result":"yes"},"need_refs":null}' };
  });
  const result = await run(sized(400000, { response_format: { type: 'json_schema', json_schema: { name: 'client', strict: true, schema } } }), options(mock));
  assert.equal(result.content, '{"result":"yes"}');
});

test('cached and reasoning usage details are aggregated across retrieval steps', async () => {
  const mock = mockFetch(({ body }, n) => ({ data: completion(n === 1 ? JSON.stringify({ need_refs: [firstRef(body)] }) : '{"answer":"done"}',
    { usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, prompt_tokens_details: { cached_tokens: 10 }, completion_tokens_details: { reasoning_tokens: 3 } } }) }));
  const result = await run(sized(400000), options(mock));
  assert.deepEqual(result.data.usage, { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50,
    prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 6 } });
});

test('expanded context too large for the winner fails before spending another attempt', async () => {
  const input = sized(3000000); input.messages.unshift({ role: 'system', content: 'rules'.repeat(78000) });
  const mock = mockFetch(({ body }) => ({ content: JSON.stringify({ need_refs: [firstRef(body)] }) }));
  const result = await run(input, options(mock));
  assert.equal(result.ok, false); assert.match(result.error, /winner ceiling/);
  assert.equal(mock.calls.length, 1);
});

test('HTTP route counts ladder controls in the full input and preserves the client response', async () => {
  const body = sized(350001, { ladder_timeout_ms: 20000 });
  const mock = mockFetch(({ body }) => { assert.equal(body.response_format.type, 'json_object'); return { content: '{"answer":"http result"}' }; });
  const response = await handle(new Request('https://test/v1/chat/completions', {
    method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), { ...env, LADDER_TOKEN: 'test-token' }, { store: memoryStore(), fetchImpl: mock.fetchImpl });
  assert.equal(response.status, 200); const out = await response.json();
  assert.equal(out.choices[0].message.content, 'http result'); assert.equal(out.model, free);
  assert.equal(mock.calls.length, 1); assert.equal(mock.calls[0].body.ladder_timeout_ms, undefined);
  assert.match(response.headers.get('x-ladder-compression'), /unit=bytes;in=350001/);
});

test('compression collision fails explicitly before spending a provider attempt', async () => {
  const mock = mockFetch(() => ({ content: 'unused' }));
  const result = await run(sized(400000, { tools: [{ type: 'function', function: { name: 'read_context', parameters: {} } }] }), options(mock));
  assert.equal(result.ok, false); assert.equal(result.status, 400); assert.match(result.error, /Reserved tool name/);
  assert.equal(mock.calls.length, 0);
});

test('server kill switch bypasses compression without trusting a caller request flag', async () => {
  const spy = spyCompression(), mock = mockFetch(() => ({ content: 'original mode' }));
  const result = await run(sized(351000), options(mock, { contextCompression: spy, env: { ...env, CONTEXT_COMPRESSION_ENABLED: 'false' } }));
  assert.equal(result.content, 'original mode'); assert.equal(spy.applications.length, 0);
});

test('HTTP caller can opt into the standard ladder without either compression threshold', async () => {
  for (const scenario of [
    { bytes: 351000, failFree: false, expectedModel: free, bodyFlag: false },
    { bytes: 100000, failFree: true, expectedModel: paid, headerFlag: 'off' },
  ]) {
    const body = sized(scenario.bytes, scenario.bodyFlag === false ? { ladder_context_compression: false } : {});
    const mock = mockFetch(({ body: outgoing }) => {
      assert.equal(outgoing.ladder_context_compression, undefined, 'control must not reach the provider');
      if (scenario.failFree && outgoing.model === free.split('/')[1]) return { status: 503 };
      return { content: 'standard ladder response' };
    });
    const response = await handle(new Request('https://test/v1/chat/completions', {
      method: 'POST', headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
        ...(scenario.headerFlag ? { 'x-ladder-context-compression': scenario.headerFlag } : {}),
      }, body: JSON.stringify(body),
    }), { ...env, LADDER_TOKEN: 'test-token' }, { store: memoryStore(), fetchImpl: mock.fetchImpl });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, 'standard ladder response');
    assert.equal(mock.calls.at(-1).body.model, scenario.expectedModel.split('/')[1]);
    assert.equal(response.headers.get('x-ladder-compression'), null);
  }
});
