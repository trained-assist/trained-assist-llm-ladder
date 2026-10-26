import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { orderBenchmarkedRungs, orderOpenrouterRungs } from '../src/go-routing.js';
import { benchmarkOpenrouterModel } from '../src/free-models.js';

const config = JSON.parse(fs.readFileSync(new URL('../config/ladders.json', import.meta.url)));

// A bench row of one OpenRouter free model: `p50_ms` per tier, plus the quality signals the
// fast lane uses (`correct` — did the model follow the instruction, `out_tokens` — did it fit
// into the budget).
function row(model_id, p50_ms, { correct = 2, context = 128_000, out_tokens = 24, truncated = false, tier = 'small' } = {}) {
  const t = { attempts: 2, successes: 2, correct, p50_ms, out_tokens, truncated };
  return {
    provider: 'openrouter',
    model_id,
    available: 1,
    bench_status: 'ready',
    context,
    benchmark: { tiers: { [tier]: t } },
  };
}

const LADDER = [
  'opencode-go/beam-free',
  'zen-rings/nemotron-3-ultra-free',
  'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
  'openrouter/cohere/north-mini-code:free',
  'opencode-go/mimo-v2.6-flash',
];

test('orderOpenrouterRungs: the free block is ordered by the measured answer time', () => {
  const rungs = [...LADDER];
  const rows = [
    row('openrouter/nvidia/nemotron-3-ultra-550b-a55b:free', 3_300),
    row('openrouter/cohere/north-mini-code:free', 1_600),
  ];
  assert.deepEqual(orderOpenrouterRungs(rungs, rows, 500), [
    'opencode-go/beam-free',
    'zen-rings/nemotron-3-ultra-free',
    'openrouter/cohere/north-mini-code:free',   // the fastest measured model leads the block
    'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
    'opencode-go/mimo-v2.6-flash',              // the paid tail stays where it was
  ]);
});

test('orderOpenrouterRungs: the block keeps its place — after the other free rungs, before the paid tail', () => {
  const rungs = [...LADDER];
  const rows = [row('openrouter/cohere/north-mini-code:free', 100)];
  const out = orderOpenrouterRungs(rungs, rows, 500);
  const block = out.filter((m) => m.startsWith('openrouter/'));
  const lastOtherFree = out.lastIndexOf('zen-rings/nemotron-3-ultra-free');
  assert.ok(out.indexOf(block[0]) > lastOtherFree, 'the free block stays behind the other free rungs');
  // the paid rung is still the last one of the ladder
  assert.equal(out[out.length - 1], 'opencode-go/mimo-v2.6-flash');
});

test('orderOpenrouterRungs: a near-tie is decided by quality, the fastest one becomes the reserve', () => {
  const rungs = ['openrouter/fast-but-blunt:free', 'openrouter/slow-but-good:free'];
  const rows = [
    row('openrouter/fast-but-blunt:free', 1_000, { correct: 0, context: 8_000 }),
    row('openrouter/slow-but-good:free', 1_100, { correct: 2, context: 200_000 }),
  ];
  const out = orderOpenrouterRungs(rungs, rows, 500);
  // The margin is small (100ms) → the quality wins the first slot, the fastest is the reserve.
  assert.equal(out[0], 'openrouter/slow-but-good:free');
  assert.equal(out[1], 'openrouter/fast-but-blunt:free');
});

test('orderOpenrouterRungs: a model outside the margin does not take the first slot', () => {
  const rungs = ['openrouter/fast:free', 'openrouter/much-slower:free'];
  const rows = [
    row('openrouter/fast:free', 1_000, { correct: 0 }),
    row('openrouter/much-slower:free', 6_000, { correct: 2, context: 200_000 }),
  ];
  const out = orderOpenrouterRungs(rungs, rows, 500);
  assert.equal(out[0], 'openrouter/fast:free');
  assert.equal(out[1], 'openrouter/much-slower:free');
});

test('orderOpenrouterRungs: a measured model that is not in the config joins the block', () => {
  const rungs = ['openrouter/nvidia/nemotron-3-ultra-550b-a55b:free'];
  const rows = [
    row('openrouter/nvidia/nemotron-3-ultra-550b-a55b:free', 3_300),
    row('openrouter/newcomer:free', 900),
  ];
  const out = orderOpenrouterRungs(rungs, rows, 500);
  assert.deepEqual(out, ['openrouter/newcomer:free', 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free']);
});

test('orderOpenrouterRungs: a model that burns the whole budget does not join the ladder', () => {
  const rungs = ['openrouter/nvidia/nemotron-3-ultra-550b-a55b:free'];
  const rows = [
    row('openrouter/nvidia/nemotron-3-ultra-550b-a55b:free', 3_300),
    row('openrouter/reasoner:free', 900, { truncated: true }),
    row('openrouter/heavy:free', 800, { out_tokens: 1_500 }),
  ];
  const out = orderOpenrouterRungs(rungs, rows, 500);
  assert.deepEqual(out, ['openrouter/nvidia/nemotron-3-ultra-550b-a55b:free']);
});

test('orderOpenrouterRungs: unmeasured rungs keep their order behind the measured ones', () => {
  const rungs = ['openrouter/a:free', 'openrouter/b:free', 'openrouter/c:free'];
  const rows = [row('openrouter/b:free', 1_000)];
  const out = orderOpenrouterRungs(rungs, rows, 500);
  assert.deepEqual(out, ['openrouter/b:free', 'openrouter/a:free', 'openrouter/c:free']);
});

test('orderOpenrouterRungs: a model without a measurement for this tier stays unmeasured', () => {
  const rungs = ['openrouter/a:free', 'openrouter/b:free'];
  // 'b' was only measured on the small tier — a large prompt must not use that number.
  const rows = [row('openrouter/b:free', 1_000, { tier: 'small' })];
  assert.deepEqual(orderOpenrouterRungs(rungs, rows, 40_000), rungs);
});

test('orderOpenrouterRungs: a bench row stored as JSON text is read the same way', () => {
  const rungs = ['openrouter/a:free', 'openrouter/b:free'];
  const rows = [{ ...row('openrouter/b:free', 1_000), benchmark: JSON.stringify(row('openrouter/b:free', 1_000).benchmark) }];
  assert.deepEqual(orderOpenrouterRungs(rungs, rows, 500), ['openrouter/b:free', 'openrouter/a:free']);
});

test('orderBenchmarkedRungs: the Go block rules still apply and the OpenRouter block follows them', () => {
  const rungs = ['opencode-go/incumbent-free', 'openrouter/a:free', 'openrouter/b:free'];
  const rows = [
    { provider: 'opencode-go', model_id: 'opencode-go/incumbent-free', available: 1, bench_status: 'ready', benchmark: { tiers: { small: { attempts: 2, successes: 2, p50_ms: 400 } } } },
    { provider: 'opencode-go', model_id: 'opencode-go/new-free', available: 1, bench_status: 'ready', benchmark: { tiers: { small: { attempts: 2, successes: 2, p50_ms: 200 } } } },
    row('openrouter/b:free', 1_000),
    row('openrouter/a:free', 2_000),
  ];
  assert.deepEqual(orderBenchmarkedRungs(rungs, rows, 500), [
    'opencode-go/new-free',
    'opencode-go/incumbent-free',
    'openrouter/b:free',
    'openrouter/a:free',
  ]);
});

test('orderBenchmarkedRungs: a ladder without an OpenRouter free block is untouched', () => {
  const rungs = ['opencode-go/beam-free', 'opencode-go/mimo-v2.6-flash'];
  assert.deepEqual(orderBenchmarkedRungs(rungs, [row('openrouter/a:free', 100)], 500), rungs);
});

// ── The measurement itself ──────────────────────────────────────────────────────────

test('benchmarkOpenrouterModel: two real completions per tier, the speed and the quality signals', async () => {
  const seen = [];
  const result = await benchmarkOpenrouterModel({ provider: 'openrouter', model_id: 'openrouter/acme/fast:free' }, {}, {
    now: 1234,
    key: 'sk-or-test-key',
    fetchImpl: async (url, init) => {
      seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ready' }, finish_reason: 'stop' }],
        usage: { completion_tokens: 12 },
      }), { status: 200 });
    },
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.benchmark.measured_at, 1234);
  assert.equal(seen.length, 6, 'two actual completions per context tier');
  assert.equal(seen[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(seen[0].headers.Authorization, 'Bearer sk-or-test-key');
  assert.equal(seen[0].body.model, 'acme/fast:free', 'the provider id, not the ladder rung id');
  assert.equal(seen[0].body.max_tokens, 1500);
  for (const tier of ['small', 'medium', 'large']) {
    const t = result.benchmark.tiers[tier];
    assert.equal(t.attempts, 2);
    assert.equal(t.successes, 2);
    assert.equal(t.correct, 2);
    assert.equal(t.out_tokens, 12);
    assert.ok(Number.isFinite(t.p50_ms));
  }
});

test('benchmarkOpenrouterModel: the key never lands in the result', async () => {
  const result = await benchmarkOpenrouterModel({ provider: 'openrouter', model_id: 'openrouter/acme/fast:free' }, {}, {
    key: 'sk-or-secret-value',
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ready' } }] }), { status: 200 }),
  });
  assert.equal(JSON.stringify(result).includes('sk-or-secret-value'), false);
});

test('benchmarkOpenrouterModel: without a key the measurement is skipped, not failed', async () => {
  const result = await benchmarkOpenrouterModel({ provider: 'openrouter', model_id: 'openrouter/acme/fast:free' }, {}, { key: null });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'no key');
});

test('benchmarkOpenrouterModel: an empty answer fails the tier and is marked as truncated', async () => {
  const result = await benchmarkOpenrouterModel({ provider: 'openrouter', model_id: 'openrouter/acme/reasoner:free' }, {}, {
    key: 'sk-or-test-key',
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
      usage: { completion_tokens: 1500 },
    }), { status: 200 }),
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.benchmark.tiers.small.successes, 0);
  assert.equal(result.benchmark.tiers.small.truncated, true);
});

test('benchmarkOpenrouterModel: a throttled key is not the model\'s verdict — the pool answers', async () => {
  const seen = [];
  const result = await benchmarkOpenrouterModel({ provider: 'openrouter', model_id: 'openrouter/acme/fast:free' }, {}, {
    keys: ['sk-or-throttled', 'sk-or-good'],
    fetchImpl: async (url, init) => {
      seen.push(init.headers.Authorization);
      if (init.headers.Authorization === 'Bearer sk-or-throttled') {
        return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ready' } }] }), { status: 200 });
    },
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.benchmark.tiers.small.successes, 2);
  assert.ok(seen.includes('Bearer sk-or-good'), 'the second key of the pool was used');
});

test('benchmarkOpenrouterModel: every key throttled → the model is not measured', async () => {
  const result = await benchmarkOpenrouterModel({ provider: 'openrouter', model_id: 'openrouter/acme/fast:free' }, {}, {
    keys: ['sk-or-a', 'sk-or-b'],
    fetchImpl: async () => new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 }),
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.benchmark.tiers.small.successes, 0);
  assert.equal(result.benchmark.tiers.small.last_error, 'http_429');
});

test('benchmarkOpenrouterModel: a paid model is not measured', async () => {
  assert.equal(await benchmarkOpenrouterModel({ provider: 'openrouter', model_id: 'openrouter/acme/paid' }, {}, { key: 'k' }), null);
});

// ── The config invariant ────────────────────────────────────────────────────────────

const isOpenrouterFree = (m) => m.startsWith('openrouter/') && m.endsWith(':free');
const isFree = (m) => isOpenrouterFree(m)
  || ((m.startsWith('opencode-go/') || m.startsWith('zen-rings/')) && m.endsWith('-free'));
// The zen ring tail (owner 2026-10-09) rides the ring behind every working free rung — it is the
// deliberate dead-head fallback, so it sits AFTER the OpenRouter free block, not before it.
const isZenTail = (m) => m === 'zen-rings/nemotron-3.5-lightning-free' || m === 'zen-rings/big-pickle';

test('every ladder: the OpenRouter free block comes after the free rungs of the other providers', () => {
  for (const [name, roles] of Object.entries(config.ladders)) {
    for (const [role, rungs] of Object.entries(roles)) {
      const block = rungs.filter(isOpenrouterFree);
      const others = rungs.filter((m) => isFree(m) && !isOpenrouterFree(m) && !isZenTail(m));
      if (!block.length) continue;
      const lastOther = rungs.lastIndexOf(others[others.length - 1]);
      const firstBlock = rungs.indexOf(block[0]);
      assert.ok(lastOther < firstBlock,
        `${name}.${role}: the free OpenRouter rungs must come after the other free rungs`);
      // the block is contiguous — the fast lane reorders it as one piece
      const indexes = rungs.map((m, i) => (isOpenrouterFree(m) ? i : -1)).filter((i) => i >= 0);
      assert.deepEqual(indexes, indexes.map((_, k) => indexes[0] + k), `${name}.${role}: the free OpenRouter block is split`);
      // the zen ring tail rides behind the whole working free segment (owner 2026-10-09)
      const tail = rungs.filter(isZenTail);
      if (tail.length) {
        assert.ok(rungs.indexOf(tail[0]) > indexes[indexes.length - 1],
          `${name}.${role}: the zen ring tail sits behind the OpenRouter free block`);
      }
    }
  }
});
