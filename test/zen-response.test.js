import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeZenResponse } from '../scripts/zen-response.mjs';

test('provider HTTP 200 with no text or tool calls is a diagnosed empty failure', () => {
  const result = normalizeZenResponse({ ok: true, message: { content: '' }, finish_reason: 'stop' }, 'nemotron-free');
  assert.deepEqual(result, {
    ok: false, text: '', kind: 'empty',
    error: 'empty answer from nemotron-free (0 text chars, no tool calls)',
    tool_calls: null,
  });
});

test('a tool-call-only completion remains a successful answer', () => {
  const toolCalls = [{ id: 'call-1', function: { name: 'lookup', arguments: '{}' } }];
  const result = normalizeZenResponse({ ok: true, message: { content: null, tool_calls: toolCalls } }, 'model');
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'ok');
  assert.deepEqual(result.tool_calls, toolCalls);
});

test('a provider error keeps its concrete kind and safe message', () => {
  const result = normalizeZenResponse({ ok: false, kind: 'timeout', error: 'deadline exceeded' }, 'model');
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'timeout');
  assert.equal(result.error, 'deadline exceeded');
});
