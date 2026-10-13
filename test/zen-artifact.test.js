import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePoolArtifact } from '../scripts/zen-artifact.mjs';

test('pool artifact retains operations metadata and strips request and response payloads', () => {
  const safe = sanitizePoolArtifact({
    ok: true, model: 'example-free', kind: 'ok', status: 200, provider_ms: 12, served_ms: 18,
    usage: { prompt_tokens: 42, completion_tokens: 5 }, finish_reason: 'stop',
    runner: { run_id: '123', egress_ip: '192.0.2.10' }, marks: [{ event: 'request_sent' }],
    prompt: 'private prompt', messages: [{ role: 'system', content: 'private system context' }],
    text: 'private model answer', tool_calls: [{ function: { arguments: 'private args' } }],
    error: 'private provider body',
  });
  assert.deepEqual(safe, {
    ok: true, model: 'example-free', kind: 'ok', status: 200, provider_ms: 12, served_ms: 18,
    usage: { prompt_tokens: 42, completion_tokens: 5 }, finish_reason: 'stop',
    runner: { run_id: '123', egress_ip: '192.0.2.10' }, marks: [{ event: 'request_sent' }],
  });
  const serialized = JSON.stringify(safe);
  for (const value of ['private prompt', 'private system context', 'private model answer', 'private args', 'private provider body']) {
    assert.equal(serialized.includes(value), false);
  }
});
