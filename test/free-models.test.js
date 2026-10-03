import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectCatalogs, planProbes, probeRows, diffRows, collectFreeModels,
  upsertStatement, goneStatement, readFreeModels, markdownReport, summarizeRun, PROVIDERS,
} from '../src/free-models.js';
import { readPool } from '../src/ladder.js';
import config from '../config/ladders.json' with { type: 'json' };

// ── Fakes ──────────────────────────────────────────────────────────────────────────

// fetchImpl that answers only the URLs in `routes`; anything else is a 404 (a provider being
// unreachable must look like a provider being unreachable, not like an empty catalog).
function fakeFetch(routes, { seen = [] } = {}) {
  return async (url, init) => {
    seen.push({ url, headers: init?.headers || {} });
    const hit = routes[url];
    if (!hit) return new Response('not found', { status: 404 });
    const [status, payload] = hit;
    return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

const OR_MODELS = 'https://openrouter.ai/api/v1/models';
const ZEN_MODELS = 'https://opencode.ai/zen/v1/models';
const GO_MODELS = 'https://opencode.ai/zen/go/v1/models';

const OR_FREE = {
  data: [
    { id: 'xiaomi/mimo-v2.6-flash:free', name: 'MiMo V2.6 Flash', context_length: 1050000, pricing: { prompt: '0', completion: '0', input_cache_read: '0' } },
    { id: 'acme/paid-model', name: 'Paid', context_length: 128000, pricing: { prompt: '0.000001', completion: '0.000002' } },
    { id: 'acme/zero-priced', name: 'Zero', context_length: 64000, pricing: { prompt: '0', completion: '0' } },
  ],
};

const ZEN_MODELS_PAYLOAD = {
  data: [
    { id: 'mimo-v2.6-flash-free', name: 'MiMo v2.6 flash (free)' },
    { id: 'big-pickle', name: 'Big Pickle' },
    { id: 'mimo-v2.6-flash', name: 'MiMo v2.6 flash (paid)' },
  ],
};

const GO_MODELS_PAYLOAD = {
  data: [
    { id: 'space-bunny-free', name: 'Space Bunny' },
    { id: 'mimo-v2.6-flash', name: 'MiMo (paid)' },
  ],
};

const CATALOGS = {
  [OR_MODELS]: [200, OR_FREE],
  [ZEN_MODELS]: [200, ZEN_MODELS_PAYLOAD],
  [GO_MODELS]: [200, GO_MODELS_PAYLOAD],
  // Probe targets: a 200 everywhere means "the model answers".
  'https://openrouter.ai/api/v1/chat/completions': [200, { choices: [{ message: { content: 'pong' } }] }],
  'https://opencode.ai/zen/v1/chat/completions': [200, { choices: [{ message: { content: 'pong' } }] }],
  'https://opencode.ai/zen/go/v1/chat/completions': [200, { choices: [{ message: { content: 'pong' } }] }],
};

const ENV = {
  OPENROUTER_API_KEY: 'or-key',
  OPENCODE_GO_API_KEYS: 'go-key-1, go-key-2',
};

// Fake D1: records every statement, answers reads from a mutable row set. Prepared statements
// work both bare (.all()) and bound (.bind(...).all()), like the real D1 API.
function fakeD1(rows = []) {
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

// ── Catalog collection ─────────────────────────────────────────────────────────────

test('collectCatalogs: free models from all three providers, normalized to ladder rung ids', async () => {
  const { providers, rows } = await collectCatalogs(ENV, { fetchImpl: fakeFetch(CATALOGS), config });
  assert.deepEqual(providers.map((p) => p.provider), PROVIDERS);
  assert.ok(providers.every((p) => p.ok));
  // PROVIDERS order, then model_id — the inventory is a report, so the order is stable
  // regardless of which provider answered first.
  assert.deepEqual(rows.map((r) => r.model_id), [
    'openrouter/acme/zero-priced',
    'openrouter/xiaomi/mimo-v2.6-flash:free',
    'opencode-zen/big-pickle',
    'opencode-zen/mimo-v2.6-flash-free',
    'opencode-go/space-bunny-free',
  ]);
  const mimo = rows.find((r) => r.model_id === 'openrouter/xiaomi/mimo-v2.6-flash:free');
  assert.equal(mimo.context, 1050000);
  assert.equal(mimo.price_in, 0);
  assert.equal(mimo.price_out, 0);
  assert.equal(mimo.owned_by, null);
  assert.equal(mimo.in_ladder, 0, 'xiaomi/mimo-v2.6-flash:free is not a rung (the paid variant is)');
  assert.equal(rows.find((r) => r.model_id === 'opencode-zen/big-pickle').in_ladder, 1, 'a rung in config/ladders.json is flagged');
  assert.equal(rows.find((r) => r.model_id === 'openrouter/acme/zero-priced').in_ladder, 0);
});

test('collectCatalogs: a paid model is excluded even when the prompt is free', async () => {
  const { rows } = await collectCatalogs(ENV, { fetchImpl: fakeFetch(CATALOGS), config });
  assert.ok(!rows.some((r) => r.model_id === 'openrouter/acme/paid-model'));
  assert.ok(!rows.some((r) => r.model_id === 'opencode-zen/mimo-v2.6-flash'));
  assert.ok(!rows.some((r) => r.model_id === 'opencode-go/mimo-v2.6-flash'));
});

test('collectCatalogs: a provider that fails is reported, not fatal — and its models stay put', async () => {
  const routes = { ...CATALOGS, [GO_MODELS]: [500, { error: 'boom' }] };
  const { providers, rows } = await collectCatalogs(ENV, { fetchImpl: fakeFetch(routes), config });
  const go = providers.find((p) => p.provider === 'opencode-go');
  assert.equal(go.ok, false);
  assert.match(go.error, /HTTP 500/);
  assert.equal(go.count, 0);
  assert.equal(rows.length, 4, 'the healthy providers still collect');
});

test('collectCatalogs: the Go catalog walks the pool until a key answers', async () => {
  const seen = [];
  const routes = {
    ...CATALOGS,
    [GO_MODELS]: [401, { error: 'invalid credential' }],
  };
  // First key rejected, second accepted — the collector must not stop at the first.
  let n = 0;
  const fetchImpl = async (url, init) => {
    if (url !== GO_MODELS) return fakeFetch(CATALOGS)(url, init);
    n += 1;
    seen.push(init.headers.Authorization);
    return n === 1
      ? new Response('nope', { status: 401 })
      : new Response(JSON.stringify(GO_MODELS_PAYLOAD), { status: 200 });
  };
  const { providers } = await collectCatalogs(ENV, { fetchImpl, config });
  assert.equal(providers.find((p) => p.provider === 'opencode-go').ok, true);
  assert.deepEqual(seen, ['Bearer go-key-1', 'Bearer go-key-2']);
});

test('collectCatalogs: no Go key configured → the provider reports it, others continue', async () => {
  const { providers } = await collectCatalogs({ OPENROUTER_API_KEY: 'k' }, { fetchImpl: fakeFetch(CATALOGS), config });
  const go = providers.find((p) => p.provider === 'opencode-go');
  assert.equal(go.ok, false);
  assert.match(go.error, /no Go pool key/);
});

test('collectCatalogs: every rung prefix in ladders.json has a collector (no service skipped)', () => {
  const prefixes = new Set();
  for (const roles of Object.values(config.ladders)) {
    for (const list of Object.values(roles)) {
      for (const rung of list) prefixes.add(String(rung).split('/')[0]);
    }
  }
  const owned = new Set(PROVIDERS);
  const missing = [...prefixes].filter((p) => !owned.has(p));
  assert.deepEqual(missing, [], `a ladder rung prefix without a free-model collector: ${missing}`);
});

// ── Probe ─────────────────────────────────────────────────────────────────────────

test('planProbes: least-recently-probed first, bounded by the limit', () => {
  const rows = [
    { model_id: 'a', probed_at: 5000 },
    { model_id: 'b', probed_at: 1000 },
    { model_id: 'c', probed_at: null },
    { model_id: 'd', probed_at: 9000 },
  ];
  assert.deepEqual(planProbes(rows, { limit: 2 }).map((r) => r.model_id), ['c', 'b']);
  assert.equal(planProbes(rows, { limit: 0 }).length, 0);
});

// Capture everything the module prints; a key must never reach the log.
async function captureConsole(fn) {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.map(String).join(' '));
  try { await fn(); } finally { Object.assign(console, orig); }
  return lines.join('\n');
}

test('probeRows: one light request per model; 200/429/404 classified; keys never logged', async () => {
  const seen = [];
  const routes = {
    'https://openrouter.ai/api/v1/chat/completions': [200, { choices: [{ message: { content: 'pong' } }] }],
    'https://opencode.ai/zen/v1/chat/completions': [429, { error: { type: 'FreeUsageLimitError' } }],
    'https://opencode.ai/zen/go/v1/chat/completions': [404, { error: 'model not found' }],
  };
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return fakeFetch(routes)(url, init);
  };
  const rows = [
    { provider: 'openrouter', model_id: 'openrouter/x:free' },
    { provider: 'opencode-zen', model_id: 'opencode-zen/y-free' },
    { provider: 'opencode-go', model_id: 'opencode-go/z-free' },
  ];
  let probes;
  const logged = await captureConsole(async () => {
    probes = await probeRows(rows, ENV, { fetchImpl, concurrency: 3 });
  });
  assert.equal(probes.get('openrouter/x:free').probe_status, 'ok');
  assert.equal(probes.get('opencode-zen/y-free').probe_status, 'limited');
  assert.equal(probes.get('opencode-go/z-free').probe_status, 'not_found');
  assert.equal(seen.length, 3, 'exactly one request per model — the probe must not burn limits');
  for (const s of seen) {
    assert.equal(s.body.max_tokens, 8, 'a ping, not a real call');
    assert.equal(s.body.messages[0].content, 'ping');
  }
  assert.ok(!logged.includes('go-key'), 'the Go key must not be logged');
  assert.ok(!logged.includes('or-key'), 'the OpenRouter key must not be logged');
  const zen = seen.find((s) => s.url.includes('opencode.ai/zen/v1'));
  assert.equal(zen.body.stream, true, 'zen 403s a non-stream probe');
  assert.equal(zen.headers['x-opencode-client'], 'cli');
  const go = seen.find((s) => s.url.includes('/zen/go/v1'));
  assert.ok(go.headers['x-opencode-session'], 'Go 400s a chat call without a session id');
});

test('probeRows: a provider with no key is skipped, not failed', async () => {
  const probes = await probeRows([{ provider: 'openrouter', model_id: 'openrouter/x:free' }], {}, { fetchImpl: fakeFetch({}) });
  assert.equal(probes.get('openrouter/x:free').probe_status, 'skipped');
  assert.equal(probes.get('openrouter/x:free').probe_reason, 'no key');
});

// ── Diff ──────────────────────────────────────────────────────────────────────────

const ROW = (over) => ({
  provider: 'openrouter', model_id: 'openrouter/x:free', name: 'X', context: 128000,
  price_in: 0, price_out: 0, price_cached: 0, owned_by: null, description: null, in_ladder: 0,
  first_seen: 1, last_seen: 2, available: 1, probe_status: 'ok', probed_at: 3, ...over,
});

test('diffRows: a provider outage does not report its models as gone', () => {
  const prev = new Map([['opencode-go/space-bunny-free', ROW({ model_id: 'opencode-go/space-bunny-free', provider: 'opencode-go' })]]);
  const next = new Map();
  assert.deepEqual(diffRows(prev, next).gone.map((r) => r.model_id), ['opencode-go/space-bunny-free']);
  assert.deepEqual(diffRows(prev, next, { okProviders: new Set(['openrouter']) }).gone, []);
});

test('diffRows: appeared / gone / changed — and nothing on an identical re-run', () => {
  const prev = new Map([['openrouter/gone:free', ROW({ model_id: 'openrouter/gone:free' })]]);
  const next = new Map([
    ['openrouter/x:free', ROW({})],
    ['openrouter/y:free', ROW({ model_id: 'openrouter/y:free', context: 256000 })],
  ]);
  const d = diffRows(prev, next);
  assert.deepEqual(d.appeared.map((r) => r.model_id), ['openrouter/x:free', 'openrouter/y:free']);
  assert.deepEqual(d.gone.map((r) => r.model_id), ['openrouter/gone:free']);
  assert.deepEqual(d.changed, []);

  const d2 = diffRows(next, next);
  assert.deepEqual(d2, { appeared: [], gone: [], changed: [] }, 'idempotent: same catalog twice = no diff');
});

test('diffRows: a context or price change is reported with from → to', () => {
  const prev = new Map([['openrouter/x:free', ROW({})]]);
  const next = new Map([['openrouter/x:free', ROW({ context: 256000, price_out: 2 })]]);
  const d = diffRows(prev, next);
  assert.equal(d.changed.length, 1);
  assert.deepEqual(d.changed[0].fields, [
    { field: 'context', from: 128000, to: 256000 },
    { field: 'price_out', from: 0, to: 2 },
  ]);
});

// ── The whole pass ─────────────────────────────────────────────────────────────────

test('collectFreeModels: upsert preserves first_seen, marks the missing gone, writes the probe', async () => {
  const db = fakeD1();
  const run = await collectFreeModels(ENV, db, {
    fetchImpl: fakeFetch(CATALOGS), config, probe: true, probeLimit: 10, now: 5000,
  });
  assert.equal(run.collected, 5);
  const upserts = db._stmts.filter((s) => s.sql.startsWith('INSERT INTO free_models'));
  assert.equal(upserts.length, 5);
  const mimo = upserts.find((s) => s.params[1] === 'openrouter/xiaomi/mimo-v2.6-flash:free');
  assert.equal(mimo.params[10], 5000, 'first_seen = now on a first sighting');
  assert.equal(mimo.params[11], 5000, 'last_seen = now');
  assert.equal(mimo.params[12], 'ok', 'probe status rides the same row');
  assert.ok(mimo.params[13] > 0, 'probed_at is set');
  assert.match(mimo.sql, /available = 1/, 'an upserted row is available');
  assert.equal(db._stmts.filter((s) => s.sql.startsWith('UPDATE free_models')).length, 0, 'nothing to reconcile');
  assert.equal(run.diff.appeared.length, 5, 'first run: everything is new');
  assert.match(markdownReport(run), /New \(5\)/);
});

test('collectFreeModels: a model that left the catalog is marked gone, not deleted', async () => {
  const gone = ROW({ model_id: 'opencode-zen/old-free', provider: 'opencode-zen', last_seen: 1000 });
  const db = fakeD1([gone]);
  const routes = { ...CATALOGS, [ZEN_MODELS]: [200, { data: [{ id: 'mimo-v2.6-flash-free' }] }] };
  const run = await collectFreeModels(ENV, db, { fetchImpl: fakeFetch(routes), config, probe: false, now: 9000 });
  const updates = db._stmts.filter((s) => s.sql.startsWith('UPDATE free_models'));
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].params, [9000, 'opencode-zen', 'opencode-zen/old-free']);
  assert.equal(run.diff.gone.length, 1);
  assert.match(markdownReport(run), /Gone \(1\)/);
});

test('collectFreeModels: a FAILED provider does not mark its models gone', async () => {
  const stale = ROW({ model_id: 'opencode-go/space-bunny-free', provider: 'opencode-go', last_seen: 1000 });
  const db = fakeD1([stale]);
  const routes = { ...CATALOGS, [GO_MODELS]: [500, { error: 'boom' }] };
  const run = await collectFreeModels(ENV, db, { fetchImpl: fakeFetch(routes), config, probe: false, now: 9000 });
  const writes = db._stmts.filter((s) => s.sql.startsWith('INSERT') || s.sql.startsWith('UPDATE'));
  assert.equal(writes.filter((s) => s.sql.startsWith('UPDATE free_models')).length, 0,
    'a provider error must not read as "every model left"');
  assert.equal(run.diff.gone.length, 0,
    'and the diff stays quiet about it — an outage is not a disappearance');
  assert.equal(run.providers.find((p) => p.provider === 'opencode-go').ok, false);
});

test('collectFreeModels: dry_run reports the diff without writing', async () => {
  const db = fakeD1();
  const run = await collectFreeModels(ENV, db, {
    fetchImpl: fakeFetch(CATALOGS), config, probe: false, write: false, now: 5000,
  });
  const writes = db._stmts.filter((s) => s.sql.startsWith('INSERT') || s.sql.startsWith('UPDATE'));
  assert.equal(writes.length, 0, 'dry run writes nothing (the SELECT for the diff is not a write)');
  assert.equal(run.written, 0);
  assert.equal(run.diff.appeared.length, 5);
});

test('collectFreeModels: probe budget is respected', async () => {
  const db = fakeD1();
  const run = await collectFreeModels(ENV, db, {
    fetchImpl: fakeFetch(CATALOGS), config, probe: true, probeLimit: 2, now: 5000,
  });
  assert.equal(run.probed, 2);
  assert.equal(Object.keys(run.probes).length, 2);
});

test('readFreeModels: reads the whole inventory ordered by provider, model', async () => {
  const rows = [ROW({})];
  const db = fakeD1(rows);
  const out = await readFreeModels(db);
  assert.equal(out.length, 1);
  assert.match(db._stmts[0].sql, /FROM free_models ORDER BY provider, model_id/);
});

test('markdownReport: a degraded provider is visible in the summary line', async () => {
  const routes = { ...CATALOGS, [GO_MODELS]: [500, { error: 'boom' }] };
  const run = await collectFreeModels(ENV, fakeD1(), { fetchImpl: fakeFetch(routes), config, probe: false, now: 5000 });
  const md = markdownReport(run);
  assert.match(md, /⚠ opencode-go 0 \(HTTP 500/);
  const s = summarizeRun(run);
  assert.equal(s.by_provider['opencode-go'].ok, false);
  assert.equal(s.collected, 4);
});

test('readPool: the Go pool is read from the worker secret, order preserved', () => {
  assert.deepEqual(readPool(ENV), ['go-key-1', 'go-key-2']);
  assert.deepEqual(readPool({}), []);
});
