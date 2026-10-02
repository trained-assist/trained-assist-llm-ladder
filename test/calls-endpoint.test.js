import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/handler.js';

const ENV = { LADDER_TOKEN: 't' };

// Fake D1: records the SQL + bound params of every .all() and answers with canned rows.
function fakeD1({ rows = [], fail = false } = {}) {
  const calls = [];
  return {
    _calls: calls,
    prepare(sql) {
      return { bind: (...params) => { calls.push({ sql, params }); return { all: async () => {
        if (fail) throw new Error('d1 down');
        return { results: rows };
      } }; } };
    },
  };
}

const authed = (qs) => new Request(`https://l.test/v1/calls${qs}`, { headers: { authorization: 'Bearer t' } });

// One real row out of ladder_calls, as D1 hands it over.
const ROW = {
  ts: 1759400000000, trace_id: 'task-7', run_id: null, user_id: 'kobzevvv', chat_id: '1714048',
  session_id: 'sess-42', ladder: 'deepseek', ok: 1, model: 'opencode-go/mimo-v2.6-flash',
  ms: 1844, tokens_in: 97, tokens_out: 42,
  attempts: '[{"model":"opencode-go/mimo-v2.6-flash","outcome":"ok","key":0}]',
};

test('GET /v1/calls: requires auth — trace ids are not public', async () => {
  assert.equal((await handle(new Request('https://l.test/v1/calls?trace=t'), ENV, {})).status, 401);
  const bad = await handle(new Request('https://l.test/v1/calls?trace=t', {
    headers: { authorization: 'Bearer nope' },
  }), ENV, {});
  assert.equal(bad.status, 401);
});

test('GET /v1/calls: needs at least one filter (an unfiltered read is what /v1/analytics is for)', async () => {
  const r = await handle(authed(''), { ...ENV, LADDER_TRACE_DB: fakeD1() }, {});
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error.message, /trace, user, chat, session/);
});

test('GET /v1/calls: filters are BOUND, never interpolated into the SQL', async () => {
  const d1 = fakeD1({ rows: [ROW] });
  const r = await handle(authed("?trace=task'--"), { ...ENV, LADDER_TRACE_DB: d1 }, {});
  assert.equal(r.status, 200);
  const { sql, params } = d1._calls[0];
  assert.ok(!sql.includes('task'), 'the caller-supplied id must not appear in the statement');
  assert.ok(sql.includes('?2 IS NULL OR trace_id = ?2'), 'one placeholder per optional filter');
  assert.equal(params[1], "task'--", 'the id travels as a bound value');
});

test('GET /v1/calls: returns the per-call rung trace with attempts already parsed', async () => {
  const d1 = fakeD1({ rows: [ROW] });
  const r = await handle(authed('?trace=task-7'), { ...ENV, LADDER_TRACE_DB: d1 }, {});
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.count, 1);
  const c = b.calls[0];
  assert.equal(c.ok, true, 'ok comes back as a boolean, not 0/1');
  assert.equal(c.user_id, 'kobzevvv');
  assert.equal(c.chat_id, '1714048');
  assert.deepEqual(c.attempts, [{ model: 'opencode-go/mimo-v2.6-flash', outcome: 'ok', key: 0 }]);
});

test('GET /v1/calls: all four filters combine; a blank one is treated as absent', async () => {
  const d1 = fakeD1({ rows: [] });
  await handle(authed('?user=kobzevvv&chat=&session=sess-42'), { ...ENV, LADDER_TRACE_DB: d1 }, {});
  const { params } = d1._calls[0];
  assert.equal(params[1], null, 'trace not asked for → null so the OR-branch is inert');
  assert.equal(params[2], 'kobzevvv');
  assert.equal(params[3], '');
  assert.equal(params[4], 'sess-42');
});

test('GET /v1/calls: window and limit are clamped', async () => {
  const d1 = fakeD1({ rows: [] });
  const now = Date.now();
  await handle(authed(`?user=u&limit=99999&since_ms=${now + 60_000}`), { ...ENV, LADDER_TRACE_DB: d1 }, {});
  const { sql, params } = d1._calls[0];
  assert.match(sql, /LIMIT \?6/, 'limit stays a bound parameter');
  assert.equal(params[5], 200, 'limit clamped to 200');
  assert.ok(params[0] < now + 60_000, 'a since_ms in the future is pulled back to now');
  assert.ok(params[0] <= Date.now(), 'clamped to handler time, never past it');
});

test('GET /v1/calls: no trace database → 503; a D1 failure → 500, never a throw', async () => {
  const no = await handle(authed('?user=u'), ENV, {});
  assert.equal(no.status, 503);
  const bad = await handle(authed('?user=u'), { ...ENV, LADDER_TRACE_DB: fakeD1({ fail: true }) }, {});
  assert.equal(bad.status, 500);
  assert.match((await bad.json()).error.message, /d1 down/);
});
