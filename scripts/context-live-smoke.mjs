import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createCompressionSession, requestBytes } from '../src/context-compression.js';

const base = 'https://llm-ladder.trainedassist.store';
const expected = 'dispatch_' + randomBytes(16).toString('hex');
const messages = [{ role: 'system', content: 'Answer the latest user request from the recorded evidence. Use archived original data if an excerpt omits the requested value. Never invent a code.' }];
for (let batch = 0; batch < 24; batch++) {
  messages.push({ role: 'user', content: `Inspect build logs for batch ${batch}.` });
  messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `build-${batch}`, type: 'function', function: { name: 'read_build', arguments: JSON.stringify({ batch }) } }] });
  const line = `2026-10-09T12:00:00Z INFO batch=${batch} validation completed successfully, no errors reported.\n`;
  let content = line.repeat(550);
  if (batch === 7) content = content.slice(0, 22000) + '\nINFO DISPATCH_CODE=' + expected + '\n' + content.slice(22000);
  messages.push({ role: 'tool', tool_call_id: `build-${batch}`, content });
}
messages.push({ role: 'user', content: 'Return only the exact DISPATCH_CODE from the archived read_build reply for batch 7 (tool_call_id build-7). The value occurs around character offset 22000 in the original tool reply. If the excerpt omits it, retrieve the original content with read_context, offset 21000, limit 3000, or request that page with need_refs. Do not guess and do not execute read_build again. Return only the code as the final answer.' });
const body = { model: 'service', messages, max_tokens: 1024, ladder_timeout_ms: 120000, stream: false,
  tools: [{ type: 'function', function: { name: 'read_build', description: 'Read build logs for one batch.', parameters: { type: 'object', properties: { batch: { type: 'integer' } }, required: ['batch'] } } }] };
const session = createCompressionSession(body);
let prepared;
try {
  prepared = session.prepare('entry');
  assert.ok(requestBytes(body) > 350000);
  assert.ok(!JSON.stringify(prepared).includes(expected), 'The code must really be omitted from the first provider prompt');
} finally { session.close(); }
const health = await (await fetch(base + '/health', { signal: AbortSignal.timeout(15000) })).json();
const token = process.env.LADDER_TOKEN;
if (!token) throw new Error('LADDER_TOKEN is missing in GitHub Actions');
const started = Date.now();
const response = await fetch(base + '/v1/chat/completions', { method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-ladder-app': 'context-live-smoke' },
  body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
const data = await response.json();
const answer = data.choices?.[0]?.message?.content ?? null;
const report = { endpoint: base + '/v1/chat/completions', build: health.build, status: response.status,
  elapsedMs: Date.now() - started, inputBytes: requestBytes(body), staticPreviewBytes: requestBytes(prepared),
  hiddenCodeAbsentFromPreview: true, toolPairs: 24,
  compression: response.headers.get('x-ladder-compression'), model: data.model, usage: data.usage,
  expected, answer, recoveredExact: answer?.trim() === expected, error: data.error,
  ladderHeaders: Object.fromEntries([...response.headers].filter(([name]) => name.startsWith('x-ladder-'))) };
writeFileSync('context-live-smoke.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
assert.equal(response.status, 200, 'The live Ladder API must return HTTP 200');
assert.ok(report.compression, 'The deployed Ladder must confirm compression');
assert.ok(report.recoveredExact, 'The real model must recover the exact code omitted from the compressed prompt');
assert.ok(/steps=[2-4](?:;|$)/.test(report.compression), 'A real internal retrieval continuation must occur');
