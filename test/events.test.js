// Error-event publisher tests for trained-assist-error-watcher integration.
// https://github.com/trained-assist/trained-agent-architecture/blob/main/OBSERVABILITY-AND-ERROR-CONTRACT.md

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createErrorPublisher, resolveErrorPublisher, buildErrorEvent } from '../src/events.js';

test('createErrorPublisher returns no-op publisher without config', () => {
  const pub = createErrorPublisher({});
  assert.equal(typeof pub.publishError, 'function');
  assert.equal(pub.getDroppedCount(), 0);
  assert.equal(pub.getSpool().length, 0);
});

test('resolveErrorPublisher returns null without env vars', () => {
  assert.equal(resolveErrorPublisher({}), null);
  assert.equal(resolveErrorPublisher({ ERROR_WATCHER_URL: 'https://example.com' }), null);
  assert.equal(resolveErrorPublisher({ ERROR_WATCHER_KEY: 'secret' }), null);
});

test('resolveErrorPublisher returns publisher with both env vars', () => {
  const pub = resolveErrorPublisher({
    ERROR_WATCHER_URL: 'https://watcher.example.com',
    ERROR_WATCHER_KEY: 'secret',
  });
  assert.ok(pub);
  assert.equal(typeof pub.publishError, 'function');
});

test('buildErrorEvent returns valid C12 ErrorEvent', () => {
  const event = buildErrorEvent({
    trace: { traceId: 'TR1', runId: 'R1', userId: 'U1' },
    ladder: 'service',
    error: 'every rung failed',
  });
  assert.equal(event.schemaVersion, 1);
  assert.match(event.eventId, /^ladder_/);
  assert.ok(event.occurredAt);
  assert.equal(event.source.service, 'trained-assist-llm-ladder');
  assert.equal(event.scope.kind, 'profile');
  assert.equal(event.scope.profileId, 'U1');
  assert.equal(event.correlation.runId, 'R1');
  assert.equal(event.correlation.traceId, 'TR1');
  assert.equal(event.error.code, 'LADDER_ERROR');
  assert.equal(event.error.operation, 'service');
  assert.equal(event.error.severity, 'error');
  assert.equal(event.error.outcome, 'failed');
  assert.equal(event.error.safeSummary, 'every rung failed');
  assert.equal(event.origin.kind, 'application');
  assert.equal(event.origin.diagnosticDepth, 0);
});

test('buildErrorEvent uses platform scope without userId', () => {
  const event = buildErrorEvent({
    trace: { traceId: null, runId: null, userId: null },
    ladder: 'service',
    error: 'fail',
  });
  assert.equal(event.scope.kind, 'platform');
  assert.equal(event.scope.profileId, null);
});

test('buildErrorEvent truncates and redacts safeSummary', () => {
  const event = buildErrorEvent({
    trace: {},
    ladder: 'service',
    error: 'Authorization: Bearer sk-secret123 ' + 'x'.repeat(300),
  });
  assert.ok(event.error.safeSummary.length <= 240);
  assert.ok(!event.error.safeSummary.includes('sk-secret123'));
  assert.ok(event.error.safeSummary.includes('[redacted]'));
});

test('buildErrorEvent redacts bearer tokens and sk- keys', () => {
  const event = buildErrorEvent({
    trace: {},
    ladder: 'service',
    error: 'upstream rejected Bearer abc123 and sk-openaikey',
  });
  assert.ok(!event.error.safeSummary.includes('abc123'));
  assert.ok(!event.error.safeSummary.includes('sk-openaikey'));
  assert.ok(event.error.safeSummary.includes('[redacted]'));
});

test('createErrorPublisher spools on network failure', async () => {
  const pub = createErrorPublisher({
    watcherUrl: 'https://nonexistent.invalid',
    watcherKey: 'secret',
  });
  const event = buildErrorEvent({ trace: {}, ladder: 'service', error: 'fail' });
  await pub.publishError(event);
  assert.ok(pub.getDroppedCount() > 0);
  assert.ok(pub.getSpool().length > 0);
  assert.equal(pub.getSpool()[0].eventId, event.eventId);
});

test('spool is capped at 100 entries', async () => {
  const pub = createErrorPublisher({
    watcherUrl: 'https://nonexistent.invalid',
    watcherKey: 'secret',
  });
  for (let i = 0; i < 105; i += 1) {
    const event = buildErrorEvent({ trace: {}, ladder: 'service', error: `fail ${i}` });
    await pub.publishError(event);
  }
  assert.ok(pub.getSpool().length <= 100);
  assert.ok(pub.getDroppedCount() >= 105);
});