import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/handler.js';

const ENV = { LADDER_TOKEN: 't' };

// Fake D1: captures the SQL + bound params of every .all() and answers with the
// canned rows for that statement (first call → aggRows, second → depthRows).
function fakeD1({ aggRows = [], depthRows = [], fail = false } = {}) {
  const calls = [];
  let n = 0;
  return {
    _calls: calls,
    prepare(sql) {
      const stmt = {
        bind(...params) {
          calls.push({ sql, params });
          return { all: async () => {
            if (fail) throw new Error('d1 down');
            return { results: n++ === 0 ? aggRows : depthRows };
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

test('GET /v1/analytics: aggregates per ladder, aliases merged, depth sorted', async () => {
  const d1 = fakeD1({
    aggRows: [
      // service → deepseek (alias), free-ladder → free, deepseek:build → deepseek (default role)
      { ladder: 'deepseek', calls: 10, failed: 1, tin: 1000, tout: 50, no_usage: 0 },
      { ladder: 'service', calls: 5, failed: 0, tin: 500, tout: 25, no_usage: 2 },
      { ladder: 'deepseek:build', calls: 7, failed: 0, tin: 700, tout: 35, no_usage: 0 },
      { ladder: 'free-ladder', calls: 3, failed: 3, tin: 0, tout: 0, no_usage: 3 },
      { ladder: 'deepseek:review', calls: 2, failed: 0, tin: 200, tout: 10, no_usage: 0 },
    ],
    depthRows: [
      { ladder: 'deepseek', depth: 3, calls: 1 },
      { ladder: 'deepseek', depth: 1, calls: 9 },
      { ladder: 'deepseek:build', depth: 1, calls: 7 },
      { ladder: 'service', depth: 1, calls: 5 },
      { ladder: 'free-ladder', depth: 2, calls: 2 },
      { ladder: 'free-ladder', depth: 1, calls: 1 },
    ],
  });
  const r = await get({ ...ENV, LADDER_TRACE_DB: d1 }, '?hours=1');
  assert.equal(r.status, 200);
  const b = await r.json();

  assert.equal(b.hours, 1);
  assert.ok(Date.now() - b.since_ms <= 3_600_000 + 5_000, 'since covers ~1h');
  assert.ok(b.generated_ms <= Date.now() + 5_000);

  // aliases merged: service → deepseek, free-ladder → free; the default role
  // (deepseek:build) collapses into 'deepseek'; a non-default role stays separate.
  const names = b.ladders.map(l => l.ladder);
  assert.deepEqual(names.sort(), ['deepseek', 'deepseek:review', 'free']);
  const ds = b.ladders.find(l => l.ladder === 'deepseek');
  assert.equal(ds.calls, 22, 'service + deepseek:build merged into deepseek');
  assert.equal(ds.failed, 1);
  assert.equal(ds.tokens_in, 2200);
  assert.equal(ds.no_usage, 2);
  assert.deepEqual(ds.depth, [{ depth: 1, calls: 21 }, { depth: 3, calls: 1 }], 'depth sorted asc, per-bucket summed');

  const free = b.ladders.find(l => l.ladder === 'free');
  assert.equal(free.calls, 3);
  assert.deepEqual(free.depth, [{ depth: 1, calls: 1 }, { depth: 2, calls: 2 }]);

  assert.deepEqual(b.totals, { calls: 27, failed: 4, tokens_in: 2400, tokens_out: 120, no_usage: 5 });
  // ladders sorted by calls desc
  assert.equal(b.ladders[0].ladder, 'deepseek');
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
  assert.equal(d1._calls.length, 2, 'both queries issued');
  for (const { sql, params } of d1._calls) {
    assert.match(sql, /\?1/, 'must bind ?1');
    assert.deepEqual(params, [since]);
    assert.ok(!sql.includes(String(since)), 'must not interpolate the timestamp');
  }
  assert.match(d1._calls[0].sql, /FROM ladder_calls WHERE ts >= \?1 GROUP BY ladder/);
  assert.match(d1._calls[1].sql, /json_array_length\(attempts\)/);
  assert.match(d1._calls[1].sql, /json_valid\(attempts\)/);
});

test('GET /v1/analytics: empty window → zero totals, no ladders', async () => {
  const r = await get({ ...ENV, LADDER_TRACE_DB: fakeD1() }, '?hours=1');
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.deepEqual(b.totals, { calls: 0, failed: 0, tokens_in: 0, tokens_out: 0, no_usage: 0 });
  assert.deepEqual(b.ladders, []);
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
    aggRows: [{ ladder: 'deepseek', calls: '10', failed: '2', tin: '1000', tout: '50', no_usage: '0' }],
    depthRows: [{ ladder: 'deepseek', depth: '1', calls: '10' }],
  });
  const r = await get({ ...ENV, LADDER_TRACE_DB: d1 }, '?hours=1');
  const b = await r.json();
  assert.equal(b.totals.calls, 10);
  assert.equal(b.totals.tokens_in, 1000);
  assert.deepEqual(b.ladders[0].depth, [{ depth: 1, calls: 10 }]);
});
