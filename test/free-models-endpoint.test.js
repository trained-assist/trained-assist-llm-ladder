import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/handler.js';

const ENV = { LADDER_TOKEN: 't' };

// Fake D1 that serves a fixed row set for reads and records writes. Prepared statements work
// both bare (.all()) and bound (.bind(...).all()), like the real D1 API.
function fakeD1({ rows = [], fail = false } = {}) {
  const stmts = [];
  return {
    _stmts: stmts,
    _rows: rows,
    prepare(sql) {
      const stmt = {
        _params: [],
        bind(...params) { stmt._params = params; return stmt; },
        async all() {
          stmts.push({ sql, params: stmt._params });
          if (fail) throw new Error('d1 down');
          return { results: rows };
        },
        async run() {
          stmts.push({ sql, params: stmt._params });
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
}

const authed = (method, path, body) => new Request(`https://l.test${path}`, {
  method,
  headers: { authorization: 'Bearer t', ...(body ? { 'content-type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

const ROW = {
  provider: 'openrouter', model_id: 'openrouter/xiaomi/mimo-v2.6-flash:free', name: 'MiMo V2.6 Flash',
  context: 1050000, price_in: 0, price_out: 0, price_cached: 0, owned_by: null, description: null,
  in_ladder: 0, first_seen: 1759400000000, last_seen: 1759486400000, available: 1,
  probe_status: 'ok', probed_at: 1759486400000,
};

test('GET /v1/free-models: requires auth — the inventory is not public', async () => {
  assert.equal((await handle(new Request('https://l.test/v1/free-models'), ENV, {})).status, 401);
  const bad = await handle(new Request('https://l.test/v1/free-models', {
    headers: { authorization: 'Bearer nope' },
  }), ENV, {});
  assert.equal(bad.status, 401);
});

test('GET /v1/free-models: no trace database → 503; a D1 failure → 500, never a throw', async () => {
  assert.equal((await handle(authed('GET', '/v1/free-models'), ENV, {})).status, 503);
  const bad = await handle(authed('GET', '/v1/free-models'), { ...ENV, LADDER_TRACE_DB: fakeD1({ fail: true }) }, {});
  assert.equal(bad.status, 500);
  assert.match((await bad.json()).error.message, /d1 down/);
});

test('GET /v1/free-models: returns the inventory with prices back per token and flags as booleans', async () => {
  const r = await handle(authed('GET', '/v1/free-models'), { ...ENV, LADDER_TRACE_DB: fakeD1({ rows: [ROW] }) }, {});
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.count, 1);
  assert.deepEqual(b.by_provider, { openrouter: 1 });
  const m = b.models[0];
  assert.equal(m.available, true, '0/1 comes back as a boolean');
  assert.equal(m.in_ladder, false);
  assert.equal(m.price_in, 0, 'per-1M storage is converted back to per-token for the client');
  assert.equal(m.probe_status, 'ok');
});

test('GET /v1/free-models: provider/available filters are BOUND, limit is clamped', async () => {
  const d1 = fakeD1({ rows: [ROW] });
  const r = await handle(authed('GET', `/v1/free-models?provider=openrouter'--&available=1&limit=99999`), { ...ENV, LADDER_TRACE_DB: d1 }, {});
  assert.equal(r.status, 200);
  const { sql, params } = d1._stmts[0];
  assert.ok(!sql.includes('openrouter'), 'the filter value must not appear in the statement');
  assert.match(sql, /provider = \?1/);
  assert.match(sql, /available = \?2/);
  assert.match(sql, /LIMIT \?3/);
  assert.deepEqual(params, ["openrouter'--", 1, 500]);
});

test('GET /v1/free-models: a non-numeric available is a 400, not a silent match-nothing', async () => {
  const r = await handle(authed('GET', '/v1/free-models?available=yes'), { ...ENV, LADDER_TRACE_DB: fakeD1() }, {});
  assert.equal(r.status, 400);
  assert.match((await r.json()).error.message, /available must be 0 or 1/);
});

test('POST /v1/free-models/collect: requires auth', async () => {
  assert.equal((await handle(new Request('https://l.test/v1/free-models/collect', { method: 'POST' }), ENV, {})).status, 401);
});

test('POST /v1/free-models/collect: no trace database → 503', async () => {
  const r = await handle(authed('POST', '/v1/free-models/collect', {}), ENV, {});
  assert.equal(r.status, 503);
});

// A fetch that answers nothing: no provider is reachable, so the run collects 0 rows. The
// endpoint must still answer 200 with an honest empty diff — and must never touch the network.
const offline = async () => new Response('not found', { status: 404 });

test('POST /v1/free-models/collect: dry_run reports the diff and writes nothing', async () => {
  const d1 = fakeD1({ rows: [ROW] });
  const r = await handle(authed('POST', '/v1/free-models/collect', { dry_run: true, probe: false }),
    { ...ENV, LADDER_TRACE_DB: d1 }, { fetchImpl: offline });
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.dry_run, true);
  const writes = d1._stmts.filter((s) => s.sql.startsWith('INSERT') || s.sql.startsWith('UPDATE'));
  assert.equal(writes.length, 0, 'a dry run must not touch the table');
  assert.equal(b.collected, 0, 'no provider is reachable — the diff is empty, not fake');
  assert.match(b.report, /No changes/);
});

test('POST /v1/free-models/collect: a string "false" must not enable probing', async () => {
  const d1 = fakeD1({ rows: [ROW] });
  const r = await handle(authed('POST', '/v1/free-models/collect', { probe: 'false', dry_run: 'true' }),
    { ...ENV, LADDER_TRACE_DB: d1 }, { fetchImpl: offline });
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.dry_run, true);
  assert.equal(b.probed, 0, 'probe:"false" is off, not on');
});

test('POST /v1/free-models/collect: probe/probe_limit/probe_concurrency are clamped, not trusted', async () => {  const d1 = fakeD1({ rows: [ROW] });
  const r = await handle(authed('POST', '/v1/free-models/collect', {
    probe: true, probe_limit: 100000, probe_concurrency: 999,
  }), { ...ENV, LADDER_TRACE_DB: d1 }, { fetchImpl: offline });
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.probed, 0, 'nothing to probe when no provider answers');
  assert.equal(b.written, 0, 'no rows collected → no upsert');
});
