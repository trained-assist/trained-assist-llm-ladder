// Sticky rung per conversation (epic #17, plan 4bc36b06). Unit + integration for the pin layer
// (state.js), the routing policy (ladder.js run()), the route (handler.js) and observability.
// The full acceptance scenario lives in test/sandbox/ (run via `npm run test:sandbox`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { run } from '../src/ladder.js';
import { memoryStore, pinFresh, pinDirty, pinStats, emptyState } from '../src/state.js';

const config = JSON.parse(fs.readFileSync(new URL('../config/ladders.json', import.meta.url)));
const LADDER = config.ladders.deepseek.build;
const short = m => m.replace(/^opencode-go\/|^openrouter\//, '');
const env = { OPENCODE_GO_API_KEYS: 'oc_a,oc_b', OPENROUTER_API_KEY: 'or_key' };
const msg = { model: 'deepseek', messages: [{ role: 'user', content: 'hi' }] };
const Kh = 'a'.repeat(64); // any sha256-shaped key

// ── S1: pure pin layer ──────────────────────────────────────────────────────────────────────────
test('pin layer: freshness by TTL, dirty-write throttle, stats prune', () => {
  const t0 = 1_000_000_000;
  const p = { rung: 'opencode-go/m', lastUsedAt: t0 };
  assert.equal(pinFresh(p, t0 + 1000), true);
  assert.equal(pinFresh(p, t0 + 30 * 60 * 1000 + 1), false, 'expired past the pin TTL');
  assert.equal(pinFresh(null), false);

  assert.equal(pinDirty(null, 'opencode-go/m', t0).rung, 'opencode-go/m', 'first write always persists');
  const freshHit = pinDirty(p, 'opencode-go/m', t0 + 10_000);
  assert.equal(freshHit, null, 'hit on the same rung inside ttl/2 is throttled — no storage write');
  const staleHit = pinDirty(p, 'opencode-go/m', t0 + 1_000_000);
  assert.equal(staleHit.lastUsedAt, t0 + 1_000_000, 'hit older than ttl/2 refreshes lastUsedAt');
  const moved = pinDirty(p, 'opencode-go/other', t0 + 10_000);
  assert.equal(moved.rung, 'opencode-go/other', 'a rung change always persists');
});

test('memoryStore: snapshot returns the pinned rung, recordSuccess persists it, recordFailure drops it', async () => {
  const store = memoryStore(2);
  assert.equal((await store.snapshot(undefined, Kh)).pin, null, 'no pin yet');

  await store.recordSuccess('opencode-go/m', { pin: { pinKey: Kh, rung: 'opencode-go/m' } });
  const s1 = await store.snapshot(undefined, Kh);
  assert.equal(s1.pin.rung, 'opencode-go/m');
  assert.equal((await store.snapshot(undefined, 'other-key')).pin, null, 'other conversations see nothing');

  await store.recordSuccess('opencode-go/m', { pin: { pinKey: Kh, rung: 'openrouter/x/y' } });
  assert.equal((await store.snapshot(undefined, Kh)).pin.rung, 'openrouter/x/y', 're-pin on a new rung');

  await store.recordFailure('opencode-go/m', { cls: 'transient' }, { pinRemove: { pinKey: Kh, model: 'opencode-go/m' } });
  assert.equal((await store.snapshot(undefined, Kh)).pin, null, 'pinRemove deletes the conversation pin');
  assert.deepEqual(await store.pinStats(), { count: 0, byRung: {} });
});

test('pinStats groups by rung and prunes expired entries', () => {
  const pins = {
    [Kh]: { rung: 'opencode-go/m', lastUsedAt: Date.now() },
    ['b'.repeat(64)]: { rung: 'opencode-go/m', lastUsedAt: Date.now() },
    ['c'.repeat(64)]: { rung: 'openrouter/x/y', lastUsedAt: Date.now() - 31 * 60 * 1000 }, // expired
  };
  assert.deepEqual(pinStats(pins), { count: 2, byRung: { 'opencode-go/m': 2 } }, 'expired rung pruned, not counted');
  assert.equal(pins['c'.repeat(64)], undefined, 'expired entry pruned in place');
});