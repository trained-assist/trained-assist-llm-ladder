// #322 — the veto layer: run() skips rungs the checks' own tables confirm dead, so a retired
// slug stops costing a hop without editing config/ladders.json (the rejected #319 auto-PR
// tried to fix the config instead of reading the data that is already in D1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { run } from '../src/ladder.js';
import { deadRungs } from '../src/dead-rungs.js';
import { memoryStore } from '../src/state.js';

const config = JSON.parse(fs.readFileSync(new URL('../config/ladders.json', import.meta.url)));

// ── Fakes ────────────────────────────────────────────────────────────────────────

// A dispatching D1 fake: answers the veto SELECT with `dead`, everything else (bench rows,
// …) with an empty result. `state.fail` flips mid-test to simulate an outage.
function fakeD1(dead, state = {}) {
  const calls = [];
  const params = [];
  const db = {
    calls,
    params,
    prepare(sql) {
      calls.push(sql);
      const statement = {
        bind(...values) {
          params.push(values);
          return statement;
        },
        all: async () => {
          if (state.fail) throw new Error('d1 down');
          return { results: sql.includes('FROM free_models') ? dead.map((model_id) => ({ model_id })) : [] };
        },
        first: async () => null,
      };
      return statement;
    },
  };
  return db;
}

function fakeZenD1(dead, state = {}) {
  const calls = [];
  const params = [];
  return {
    calls,
    params,
    prepare(sql) {
      calls.push(sql);
      const statement = {
        bind(...values) {
          params.push(values);
          return statement;
        },
        all: async () => {
          if (state.fail) throw new Error('zen db down');
          return { results: sql.includes('zen_models') ? dead.map((model) => ({ model })) : [] };
        },
        first: async () => null,
      };
      return statement;
    },
  };
}

function fakeFetch(calls) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, model: body.model });
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'x', object: 'chat.completion', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 3 } }),
      text: async () => '',
    };
  };
}

// ── deadRungs() unit ─────────────────────────────────────────────────────────────

test('deadRungs: the free query is the fresh-gone predicate with the 24h bound', async () => {
  const now = 1_700_000_000_000;
  const db = fakeD1(['openrouter/x/gone:free']);
  const dead = await deadRungs({ LADDER_TRACE_DB: db }, now);
  assert.deepEqual([...dead], ['openrouter/x/gone:free']);
  assert.match(db.calls[0], /FROM free_models WHERE available = 0 AND last_seen >= \?1/);
  assert.deepEqual(db.params[0], [now - 24 * 60 * 60 * 1000], 'граница — подтверждённая смерть за последние сутки');
});

test('deadRungs: zen-rings mapping — opencode-zen catalog rows and bare zen models both hit the ring rung', async () => {
  const now = 1_700_000_000_000;
  const free = fakeD1(['opencode-zen/some-model-free']);
  const zen = fakeZenD1(['some-model-free']);
  const dead = await deadRungs({ LADDER_TRACE_DB: free, ZEN_DB: zen }, now);
  assert.ok(dead.has('opencode-zen/some-model-free'), 'каталожная строка остаётся как есть');
  assert.ok(dead.has('zen-rings/some-model-free'), 'opencode-zen/<id> → zen-rings/<id> (лестницы так и зовут)');
  assert.match(zen.calls[0], /FROM zen_models WHERE status = 'down'/);
  assert.match(zen.calls[0], /last_ok_at IS NULL OR last_ok_at <= \?1/);
  assert.match(zen.calls[0], /updated_at >= \?2/);
  assert.deepEqual(zen.params[0], [now - 3 * 24 * 60 * 60 * 1000, now - 24 * 60 * 60 * 1000],
    'down дольше 3 дней и сам сигнал не старше суток');
});

test('deadRungs: no inventory configured → empty set, no query', async () => {
  assert.equal((await deadRungs({}, Date.now())).size, 0);
  assert.equal((await deadRungs(undefined, Date.now())).size, 0);
});

test('deadRungs: one fetch per binding per 15 min, then a refresh', async () => {
  const t0 = 1_700_000_000_000;
  const db = fakeD1(['openrouter/x/gone:free']);
  const env = { LADDER_TRACE_DB: db };
  await deadRungs(env, t0);
  await deadRungs(env, t0 + 14 * 60_000);
  assert.equal(db.calls.length, 1, 'в пределах TTL повторных запросов нет');
  await deadRungs(env, t0 + 16 * 60_000);
  assert.equal(db.calls.length, 2, 'после TTL — новый запрос');
});

test('deadRungs: a failed fetch rethrows with no cache and falls back to the stale verdict with one', async () => {
  const t0 = 1_700_000_000_000;
  const state = { fail: false };
  const db = fakeD1(['openrouter/x/gone:free'], state);
  const env = { LADDER_TRACE_DB: db };

  state.fail = true;
  await assert.rejects(() => deadRungs(env, t0), /d1 down/, 'без кэша ошибка уходит наверх — run() там её гасит');

  state.fail = false;
  await deadRungs(env, t0); // populate the cache
  state.fail = true;
  const stale = await deadRungs(env, t0 + 60_000);
  assert.ok(stale.has('openrouter/x/gone:free'), 'свежий кэш переживает падение базы');
});

// ── run() integration ────────────────────────────────────────────────────────────

const DEAD = 'opencode-go/dead-free';
const LIVE1 = 'opencode-go/live-one';
const LIVE2 = 'opencode-go/live-two';
const CFG = { ...config, ladders: { service: { build: [DEAD, LIVE1, LIVE2] } }, providers: {} };
const msg = { model: 'service', messages: [{ role: 'user', content: 'hi' }] };
const baseEnv = { OPENCODE_GO_API_KEYS: 'oc_a,oc_b' };

test('veto: a freshly-gone rung is skipped — the walk starts at the next live rung', async () => {
  const env = { ...baseEnv, LADDER_TRACE_DB: fakeD1([DEAD]) };
  const calls = [];
  const r = await run(msg, { env, config: CFG, store: memoryStore(2), fetchImpl: fakeFetch(calls) });
  assert.equal(r.ok, true);
  assert.equal(r.model, LIVE1, 'мёртвый ранг не получает ни одной попытки');
  assert.equal(calls[0].model, LIVE1.replace(/^opencode-go\//, ''));
});

test('veto: fail-open — if the filter would empty the ladder, the original walk stands', async () => {
  const env = { ...baseEnv, LADDER_TRACE_DB: fakeD1([DEAD, LIVE1, LIVE2]) };
  const r = await run(msg, { env, config: CFG, store: memoryStore(2), fetchImpl: fakeFetch([]) });
  assert.equal(r.ok, true);
  assert.equal(r.model, DEAD, 'пустой после фильтра список = не фильтруем вовсе');
});

test('veto: a D1 outage does not interrupt the call', async () => {
  const env = { ...baseEnv, LADDER_TRACE_DB: fakeD1([], { fail: true }) };
  const r = await run(msg, { env, config: CFG, store: memoryStore(2), fetchImpl: fakeFetch([]) });
  assert.equal(r.ok, true);
  assert.equal(r.model, DEAD, 'без вердикта — без вето');
});

test('veto: no inventory in env → no filter (the pre-#322 behaviour)', async () => {
  const r = await run(msg, { env: baseEnv, config: CFG, store: memoryStore(2), fetchImpl: fakeFetch([]) });
  assert.equal(r.ok, true);
  assert.equal(r.model, DEAD);
});

test('veto: a pin is an explicit request — the pinned dead rung is served, not filtered', async () => {
  const env = { ...baseEnv, LADDER_TRACE_DB: fakeD1([DEAD]) };
  const r = await run(msg, { env, config: CFG, store: memoryStore(2), fetchImpl: fakeFetch([]), pinRung: DEAD });
  assert.equal(r.ok, true);
  assert.equal(r.model, DEAD, 'пин (и probe-эндпоинт, что им пользуется) вето не проходит');
});
