import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, normalizeError } from '../src/handler.js';

const ENV = { LADDER_TOKEN: 't' };

// Fake D1: captures the SQL + bound params of every .all() and answers with the
// canned rows for that statement — routed by SQL shape (agg / depth / errors), not
// by call order, so the queries can be reordered or extended freely.
function fakeD1({ aggRows = [], rungRows = [], hourlyRows = [], appRows = [], noAppRows = [], depthRows = [], errorRows = [], modelRows = [], sourceRows = [], fail = false } = {}) {
  const calls = [];
  return {
    _calls: calls,
    prepare(sql) {
      const stmt = {
        bind(...params) {
          calls.push({ sql, params });
          return { all: async () => {
            if (fail) throw new Error('d1 down');
            if (sql.includes('json_array_length')) return { results: depthRows };
            if (sql.includes('json_each')) return { results: errorRows };
            if (sql.includes('AS hour')) return { results: hourlyRows };
            if (sql.includes('GROUP BY app, ladder, model')) return { results: appRows };
            if (sql.includes('app IS NULL')) return { results: noAppRows };
            if (sql.includes('ROW_NUMBER()')) return { results: modelRows };
            if (sql.includes('instr(model')) return { results: sourceRows };
            if (sql.includes('GROUP BY ladder, model')) return { results: rungRows };
            return { results: aggRows };
          } };
        },
      };
      return stmt;
    },
  };
}

const get = (env, qs = '') =>
  handle(new Request(`https://l.test/v1/analytics${qs}`, { headers: { authorization: 'Bearer t' } }), env);

test('GET /v1/analytics: requires auth', async () => {
  const r = await handle(new Request('https://l.test/v1/analytics'), ENV, {});
  assert.equal(r.status, 401);
  const r2 = await handle(new Request('https://l.test/v1/analytics', {
    headers: { authorization: 'Bearer nope' },
  }), ENV, {});
  assert.equal(r2.status, 401);
});

test('GET /v1/analytics: aggregates per ladder, depth sorted', async () => {
  const d1 = fakeD1({
    aggRows: [
      // no aliases: every row carries a canonical ladder name (2026-10-03 refactor)
      { ladder: 'service', calls: 10, failed: 1, tin: 1000, tout: 50, no_usage: 0 },
      { ladder: 'service', calls: 5, failed: 0, tin: 500, tout: 25, no_usage: 2 },
      { ladder: 'service:build', calls: 7, failed: 0, tin: 700, tout: 35, no_usage: 0 },
      { ladder: 'free', calls: 3, failed: 3, tin: 0, tout: 0, no_usage: 3 },
      { ladder: 'service:review', calls: 2, failed: 0, tin: 200, tout: 10, no_usage: 0 },
    ],
    rungRows: [
      { ladder: 'service', model: 'opencode-go/mimo-v2.6-flash', calls: 10, tin: 1000, tcached: 400, tout: 50 },
      { ladder: 'service', model: 'openrouter/nvidia/nemotron-3-super-120b-a12b:free', calls: 5, tin: 200, tcached: 0, tout: 10 },
      { ladder: 'free', model: 'opencode-go/space-bunny-free', calls: 3, tin: 300, tcached: 0, tout: 15 },
      { ladder: 'free', model: 'openrouter/inclusionai/ling-3.0-flash', calls: 2, tin: 150, tcached: 0, tout: 40 },
    ],
    hourlyRows: [
      { hour: '2026-10-02T22:00Z', ladder: 'service', model: 'opencode-go/mimo-v2.6-flash', calls: 10, ok_n: 10, tin: 1000, tcached: 400, tout: 50 },
      { hour: '2026-10-02T21:00Z', ladder: 'free', model: 'opencode-go/space-bunny-free', calls: 3, ok_n: 3, tin: 300, tcached: 0, tout: 15 },
    ],
    depthRows: [
      { ladder: 'service', depth: 3, calls: 1 },
      { ladder: 'service', depth: 1, calls: 9 },
      { ladder: 'service:build', depth: 1, calls: 7 },
      { ladder: 'service', depth: 1, calls: 5 },
      { ladder: 'free', depth: 2, calls: 2 },
      { ladder: 'free', depth: 1, calls: 1 },
    ],
  });
  const r = await get({ ...ENV, LADDER_TRACE_DB: d1 }, '?hours=1');
  assert.equal(r.status, 200);
  const b = await r.json();

  assert.equal(b.hours, 1);
  assert.ok(Date.now() - b.since_ms <= 3_600_000 + 5_000, 'since covers ~1h');
  assert.ok(b.generated_ms <= Date.now() + 5_000);

  // canonical names only; the default role (X:build) collapses into 'X', a non-default role stays separate.
  const names = b.ladders.map(l => l.ladder);
  assert.deepEqual(names.sort(), ['free', 'service', 'service:review']);
  const ds = b.ladders.find(l => l.ladder === 'service');
  assert.equal(ds.calls, 22, 'service + service:build default-role rows sum together');
  assert.equal(ds.failed, 1);
  assert.equal(ds.tokens_in, 2200);
  assert.equal(ds.no_usage, 2);
  assert.deepEqual(ds.depth, [{ depth: 1, calls: 21 }, { depth: 3, calls: 1 }], 'depth sorted asc, per-bucket summed');

  const free = b.ladders.find(l => l.ladder === 'free');
  assert.equal(free.calls, 3);
  assert.deepEqual(free.depth, [{ depth: 1, calls: 1 }, { depth: 2, calls: 2 }]);
  // rung breakdown is per served model now (#94): category derived, tokens split fresh/cached,
  // and cost from config/prices.json — the owner's "ladder×model: $X" view (#93).
  const sb = free.rungs.find(r => r.model === 'opencode-go/space-bunny-free');
  assert.deepEqual(sb, { ladder: 'free', model: 'opencode-go/space-bunny-free', category: 'go_free', calls: 3, tokens_in: 300, tokens_cached: 0, tokens_out: 15, cost_usd: 0 });
  const ling = free.rungs.find(r => r.model === 'openrouter/inclusionai/ling-3.0-flash');
  assert.equal(ling.category, 'or_paid');
  assert.ok(Math.abs(ling.cost_usd - (150 * 0.021 / 1e6 + 40 * 0.063 / 1e6)) < 1e-12, 'or_paid priced from the config map');
  assert.equal(free.cost_usd, ling.cost_usd, 'ladder cost = sum of its rungs');

  // hourly cut: one row per hour × ladder × model, aliased and priced
  const h = b.hourly.find(x => x.hour === '2026-10-02T22:00Z');
  assert.equal(h.ladder, 'service', 'canonical ladder name in the hourly cut');
  assert.equal(h.model, 'opencode-go/mimo-v2.6-flash');
  assert.ok(Math.abs(h.cost_usd - ((1000 - 400) * 0.14 / 1e6 + 50 * 0.28 / 1e6 + 400 * 0.0028 / 1e6)) < 1e-12, 'fresh+cached+out priced');

  assert.deepEqual({ ...b.totals, cost_usd: undefined }, { calls: 27, failed: 4, tokens_in: 2400, tokens_out: 120, no_usage: 5, cost_usd: undefined });
  assert.ok(b.totals.cost_usd > 0, 'totals carry an estimated $');
  // ladders sorted by calls desc
  assert.equal(b.ladders[0].ladder, 'service');
});

test('GET /v1/analytics: per-sub-task cut — cost by caller app, ladder name collapsed (#107)', async () => {
  // Every one of the agent's ~20 service tools posts model="service", so the ladder name alone
  // cannot say which sub-task spends. x-ladder-app (the caller's `source:`) is the only
  // discriminator, and this is the cut that makes it usable.
  const d1 = fakeD1({
    appRows: [
      // two sub-tasks on the same ladder+model — they must stay separate rows
      { app: 'gtd-intent', ladder: 'service', model: 'opencode-go/mimo-v2.6-flash', calls: 100, tin: 100_000, tcached: 0, tout: 2_000 },
      { app: 'tg-format', ladder: 'service', model: 'opencode-go/mimo-v2.6-flash', calls: 10, tin: 20_000, tcached: 0, tout: 8_000 },
      // the paid tail of one sub-task: this is where money actually goes
      { app: 'tg-format', ladder: 'service', model: 'openrouter/inclusionai/ling-3.0-flash', calls: 3, tin: 5_000, tcached: 0, tout: 1_000 },
      // the default role collapses: 'service:build' is the same ladder as 'service'
      { app: 'hh-conversation', ladder: 'service:build', model: 'openrouter/google/gemini-3.1-flash-lite-preview', calls: 7, tin: 30_000, tcached: 0, tout: 900 },
      { app: 'hh-conversation', ladder: 'service', model: 'openrouter/google/gemini-3.1-flash-lite-preview', calls: 2, tin: 10_000, tcached: 0, tout: 300 },
      // a $0 rung: calls, but no money
      { app: 'session-summary', ladder: 'service', model: 'opencode-go/space-bunny-free', calls: 40, tin: 90_000, tcached: 0, tout: 5_000 },
    ],
  });
  const r = await get({ ...ENV, LADDER_TRACE_DB: d1 }, '?hours=6');
  assert.equal(r.status, 200);
  const b = await r.json();

  // Sorted by cost desc, and this IS the point of the cut: 100 cheap gtd-intent calls on the
  // $0.14/$0.28 rung ($0.0146) cost MORE than 7 conversation calls ($0.0089). Before it, both sat
  // inside one "service"/"conversation" bucket and neither was visible.
  assert.deepEqual(b.apps.map(a => a.app), ['gtd-intent', 'hh-conversation', 'tg-format', 'session-summary']);

  const hh = b.apps.find(a => a.app === 'hh-conversation');
  assert.equal(hh.calls, 9, "'service' + 'service:build' rows of one sub-task land in one rung row");
  assert.equal(hh.rungs.length, 1);
  assert.equal(hh.rungs[0].ladder, 'service', 'default role collapsed');
  assert.equal(hh.rungs[0].category, 'or_paid');
  assert.equal(hh.rungs[0].tokens_in, 40_000, 'tokens summed across the raw names');
  assert.ok(Math.abs(hh.cost_usd - (40_000 * 0.25 / 1e6 + 1_200 * 1.50 / 1e6)) < 1e-12, 'priced from the config map');

  const fmt = b.apps.find(a => a.app === 'tg-format');
  assert.equal(fmt.calls, 13, 'two rungs of one sub-task sum into one row');
  assert.equal(fmt.rungs.length, 2);
  assert.equal(fmt.rungs[0].calls, 10, 'rungs sorted by calls desc');
  assert.ok(Math.abs(fmt.cost_usd - ((20_000 * 0.14 / 1e6 + 8_000 * 0.28 / 1e6) + (5_000 * 0.021 / 1e6 + 1_000 * 0.063 / 1e6))) < 1e-12,
    'go_sub rung + or_paid rung priced together');

  const gtd = b.apps.find(a => a.app === 'gtd-intent');
  assert.ok(gtd.cost_usd > hh.cost_usd, '100 cheap classify calls out-cost 9 conversation calls');

  const sess = b.apps.find(a => a.app === 'session-summary');
  assert.equal(sess.cost_usd, 0, '$0 rung: calls counted, no money');
  assert.equal(sess.calls, 40);
});

test('GET /v1/analytics: hours param clamped to [1,168], default 24', async () => {
  const d1 = fakeD1();
  await get({ ...ENV, LADDER_TRACE_DB: d1 }, '?hours=9999');
  let h = Math.round((Date.now() - d1._calls[0].params[0]) / 3_600_000);
  assert.equal(h, 168);

  const d1b = fakeD1();
  await get({ ...ENV, LADDER_TRACE_DB: d1b }, '?hours=0');
  h = Math.round((Date.now() - d1b._calls[0].params[0]) / 3_600_000);
  assert.equal(h, 24, '0/absent → default 24');

  const d1c = fakeD1();
  await get({ ...ENV, LADDER_TRACE_DB: d1c }, '?hours=-5');
  h = Math.round((Date.now() - d1c._calls[0].params[0]) / 3_600_000);
  assert.equal(h, 1, 'negative clamped to 1');
});

test('GET /v1/analytics: SQL binds since as ?1, never interpolates it', async () => {
  const d1 = fakeD1();
  await get({ ...ENV, LADDER_TRACE_DB: d1 }, '?hours=3');
  const since = d1._calls[0].params[0];
  assert.equal(d1._calls.length, 9, 'all nine queries issued');
  for (const { sql, params } of d1._calls) {
    assert.match(sql, /\?1/, 'must bind ?1');
    assert.deepEqual(params, [since]);
    assert.ok(!sql.includes(String(since)), 'must not interpolate the timestamp');
  }
  assert.match(d1._calls[0].sql, /FROM ladder_calls WHERE ts >= \?1 GROUP BY ladder/);
  assert.match(d1._calls[1].sql, /GROUP BY ladder, model/, 'ladder × model rungs');
  assert.match(d1._calls[1].sql, /tokens_cached/, 'cache split in the rung cut');
  assert.match(d1._calls[2].sql, /AS hour/, 'hourly cut');
  assert.match(d1._calls[3].sql, /GROUP BY app, ladder, model/, 'per-sub-task cut');
  assert.match(d1._calls[3].sql, /app IS NOT NULL/);
  assert.match(d1._calls[3].sql, /ok = 1/, 'only served calls are priced');
  assert.match(d1._calls[4].sql, /app IS NULL/, 'coverage count, not a grouped cut');
  assert.match(d1._calls[4].sql, /COUNT\(\*\)/, 'one row, no GROUP BY');
  assert.match(d1._calls[4].sql, /ok = 1/, 'counted over served calls, to match the apps cut it complements');
  assert.match(d1._calls[5].sql, /json_array_length\(attempts\)/);
  assert.match(d1._calls[5].sql, /json_valid\(attempts\)/);
  assert.match(d1._calls[6].sql, /json_each\(ladder_calls\.attempts\)/);
  assert.match(d1._calls[6].sql, /GROUP BY err/);
  assert.match(d1._calls[7].sql, /ROW_NUMBER\(\) OVER \(PARTITION BY model/, 'model percentile cut');
  assert.match(d1._calls[8].sql, /instr\(model, '\/'\)/, 'source-prefix cut');
});

test('GET /v1/analytics: no_app is reported alongside apps — coverage is visible (#136)', async () => {
  // The bug this exists for: `llm-ladder` (sanitizeAppSlug's default) was written as an app name,
  // so unattributed traffic outranked every real application and the block looked complete.
  // With the placeholder gone those rows leave `apps`; without `no_app` the block would just look
  // smaller, and "fewer callers" would be indistinguishable from "fewer callers admitting it".
  const d1 = fakeD1({
    appRows: [{ app: 'tg-format', ladder: 'service', model: 'opencode-go/mimo-v2.6-flash', calls: 30, tin: 3000, tcached: 0, tout: 300 }],
    noAppRows: [{ calls: 264 }],
  });
  const b = await (await get({ ...ENV, LADDER_TRACE_DB: d1 }, '?hours=1')).json();
  assert.equal(b.no_app.calls, 264);
  assert.deepEqual(b.apps.map(a => a.app), ['tg-format'], 'the unattributed calls are NOT listed as an app');
  assert.ok(!JSON.stringify(b.apps).includes('llm-ladder'), 'the router never appears as an application');
});

test('GET /v1/analytics: no D1 rows → no_app is 0, not NaN/undefined', async () => {
  const b = await (await get({ ...ENV, LADDER_TRACE_DB: fakeD1() }, '?hours=1')).json();
  assert.deepEqual(b.no_app, { calls: 0 });
});

test('GET /v1/analytics: empty window → zero totals, no ladders', async () => {
  const r = await get({ ...ENV, LADDER_TRACE_DB: fakeD1() }, '?hours=1');
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.deepEqual(b.totals, { calls: 0, failed: 0, tokens_in: 0, tokens_out: 0, no_usage: 0, cost_usd: 0 });
  assert.deepEqual(b.ladders, []);
  assert.deepEqual(b.hourly, []);
  assert.deepEqual(b.apps, []);
  assert.deepEqual(b.models, []);
  assert.deepEqual(b.sources, []);
});

test('GET /v1/analytics: no D1 binding → 503; D1 failure → 500 (never throws out of handle)', async () => {
  const noDb = await get(ENV, '?hours=1');
  assert.equal(noDb.status, 503);
  const body = await noDb.json();
  assert.equal(body.error.type, 'unavailable');

  const broken = await get({ ...ENV, LADDER_TRACE_DB: fakeD1({ fail: true }) }, '?hours=1');
  assert.equal(broken.status, 500);
  const b2 = await broken.json();
  assert.equal(b2.error.type, 'server_error');
  assert.match(b2.error.message, /d1 down/);
});

test('GET /v1/analytics: SUM/COUNT arrive as strings from SQLite — coerced to numbers', async () => {
  // D1 JSON-encodes aggregates; a defensive reporter must never see "10" as a string.
  const d1 = fakeD1({
    aggRows: [{ ladder: 'service', calls: '10', failed: '2', tin: '1000', tout: '50', no_usage: '0' }],
    depthRows: [{ ladder: 'service', depth: '1', calls: '10' }],
    modelRows: [{ model: 'opencode-go/mimo-v2.6-flash', calls: '10', with_usage: '6', ms_p50: '900', ms_p95: '4200', tin_p20: '300', tin_p50: '900', tin_p80: '2600' }],
    sourceRows: [{ source: 'opencode-go', calls: '10' }],
  });
  const r = await get({ ...ENV, LADDER_TRACE_DB: d1 }, '?hours=1');
  const b = await r.json();
  assert.equal(b.totals.calls, 10);
  assert.equal(b.totals.tokens_in, 1000);
  assert.deepEqual(b.ladders[0].depth, [{ depth: 1, calls: 10 }]);
  assert.equal(b.models[0].calls, 10);
  assert.equal(b.models[0].with_usage, 6);
  assert.equal(b.models[0].ms_p50, 900);
  assert.equal(b.models[0].tin_p80, 2600);
  assert.equal(b.sources[0].calls, 10);
});

test('GET /v1/analytics: models carry percentiles + category; a NULL percentile stays null', async () => {
  const d1 = fakeD1({
    modelRows: [
      { model: 'opencode-go/space-bunny-free', calls: 18328, with_usage: 11282, ms_p50: 3339, ms_p95: 16082, tin_p20: 342, tin_p50: 2657, tin_p80: 2673 },
      // A model whose every call was a stream: tokens_in NULL everywhere → no context
      // percentile at all. It must read as "no data", not as 0 — the digest prints 0 otherwise.
      { model: 'openrouter/some-model:free', calls: 12, with_usage: 0, ms_p50: 900, ms_p95: 4000, tin_p20: null, tin_p50: null, tin_p80: null },
    ],
  });
  const r = await get({ ...ENV, LADDER_TRACE_DB: d1 }, '?hours=1');
  const b = await r.json();
  assert.equal(b.models.length, 2);
  assert.equal(b.models[0].model, 'opencode-go/space-bunny-free');
  assert.equal(b.models[0].category, 'go_free', '-free suffix under opencode-go/');
  assert.equal(b.models[0].ms_p95, 16082);
  assert.equal(b.models[1].tin_p50, null, 'all-stream model → null context percentile, not 0');
  assert.equal(b.models[1].ms_p50, 900, 'latency still present without usage');
});

test('GET /v1/analytics: sources carry call share over the whole window', async () => {
  const d1 = fakeD1({
    sourceRows: [
      { source: 'opencode-go', calls: 28686 },
      { source: 'openrouter', calls: 1436 },
      { source: 'opencode-zen', calls: 1396 },
      { source: 'zen-pool', calls: 157 },
    ],
  });
  const r = await get({ ...ENV, LADDER_TRACE_DB: d1 }, '?hours=1');
  const b = await r.json();
  assert.deepEqual(b.sources.map(s => s.source), ['opencode-go', 'openrouter', 'opencode-zen', 'zen-pool']);
  const total = b.sources.reduce((s, x) => s + x.calls, 0);
  assert.equal(total, 31675);
  // Shares must sum to ~100 — a reporter can print the row as-is.
  const pctSum = b.sources.reduce((s, x) => s + x.pct, 0);
  assert.ok(Math.abs(pctSum - 100) < 0.5, `pct sums to ${pctSum}`);
  assert.ok(b.sources[0].pct > 90 && b.sources[0].pct < 91, `head source share ${b.sources[0].pct}`);
});

test('GET /v1/analytics: sources empty → no division by zero', async () => {
  const r = await get({ ...ENV, LADDER_TRACE_DB: fakeD1() }, '?hours=1');
  const b = await r.json();
  assert.deepEqual(b.sources, []);
  assert.deepEqual(b.models, []);
});

test('GET /v1/analytics: errors — digit variants merged, re-sorted, capped at 20', async () => {
  const d1 = fakeD1({
    // Raw rows arrive frequency-ordered; after normalize+merge the order can change.
    errorRows: [
      { err: 'HTTP 402: {"error":{"message":"can only afford 499"}}', n: 40 },
      { err: 'HTTP 500: upstream exploded', n: 30 },
      { err: 'HTTP 402: {"error":{"message":"can only afford 776"}}', n: 25 },
      { err: 'empty answer (finish=length, out=1500, reasoning=1500, prompt=840, max_tokens=1500)', n: 12 },
      { err: 'no first token in time', n: 5 },
    ],
  });
  const r = await get({ ...ENV, LADDER_TRACE_DB: d1 }, '?hours=6');
  const b = await r.json();

  assert.ok(Array.isArray(b.errors), 'errors array present');
  assert.equal(b.errors[0].error, 'HTTP 402: {"error":{"message":"can only afford #"}}', 'digit variants merged into one bucket');
  assert.equal(b.errors[0].calls, 65, '40 + 25 summed');
  assert.deepEqual(b.errors.map(e => e.calls), [65, 30, 12, 5], 're-sorted by merged count');
  // #34 diagnostics: digits masked so one failure with varying token counts is one row
  const guard = b.errors.find(e => e.error.startsWith('empty answer'));
  assert.ok(guard, 'guard error present');
  assert.equal(guard.error, 'empty answer (finish=length, out=#, reasoning=#, prompt=#, max_tokens=#)');
  assert.match(b.errors[1].error, /^HTTP 500: upstream exploded$/);
});

test('GET /v1/analytics: errors — empty window → empty array, not missing key', async () => {
  const r = await get({ ...ENV, LADDER_TRACE_DB: fakeD1() }, '?hours=1');
  const b = await r.json();
  assert.deepEqual(b.errors, []);
});

test('normalizeError: HTTP head kept, digits masked; non-HTTP masked wholesale; junk → (no message)', () => {
  // Same contract as scripts/analytics.py normalize_error — the two must group alike.
  assert.equal(
    normalizeError('HTTP 402: {"error":{"message":"can only afford 499"}}'),
    normalizeError('HTTP 402: {"error":{"message":"can only afford 776"}}'));
  assert.equal(normalizeError('HTTP 402: x'), 'HTTP 402: x');
  assert.equal(normalizeError('rate limited for 60s'), 'rate limited for #s');
  assert.equal(normalizeError(''), '(no message)');
  assert.equal(normalizeError(null), '(no message)');
  // 160-char cap, ellipsis marks the cut (no raw mid-JSON truncation in the digest)
  const long = normalizeError('x'.repeat(300));
  assert.equal(long.length, 160);
  assert.ok(long.endsWith('…'));
  assert.equal(normalizeError('y'.repeat(160)).length, 160, 'exactly 160 stays untouched');
  assert.ok(!normalizeError('y'.repeat(160)).endsWith('…'), 'exactly 160 gets no ellipsis');
  // multi-space collapse
  assert.equal(normalizeError('too    many\nspaces 42'), 'too many spaces #');
});
