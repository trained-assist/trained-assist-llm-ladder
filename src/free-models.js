// Free-model inventory (issue #111): collect the free catalogs of every provider the ladder
// already talks to, probe availability lightly, and keep the history in one D1 table.
//
// The module is deliberately free of the Workerd runtime (same rule as src/handler.js) so
// `node --test` can drive it with a fake fetch and a fake D1, and the worker can import it
// for the /v1/free-models routes.
//
// Providers are keyed by the ladder rung prefix they own — config/ladders.json only ever uses
// these three, and test/free-models.test.js asserts that (a 4th prefix must get a collector
// before it can be silently missed, which is the "did we skip a service?" check from the issue).
//
// model_id is the FULL ladder rung id (e.g. `openrouter/xiaomi/mimo-v2.6-flash:free`), not the
// bare upstream id: that is the identity the rest of the repo already uses (config/prices.json,
// config/contexts.json, categoryOf()), so the inventory joins to them without a mapping table.
//
// `available` means "present in the latest catalog" — the issue's reconciliation rule. The probe
// is a separate, lighter signal (probe_status) and never decides availability: a 429 from a
// free tier is a limit, not a disappearance.

import { readPool } from './ladder.js';

export const OPENROUTER_CATALOG_URL = 'https://openrouter.ai/api/v1/models';
// The zen catalog is fetched DIRECTLY from opencode.ai, not through the GCP relay: the relay
// (scripts/zen-relay.mjs) only proxies POST /chat/completions, so /v1/models would 404 there.
export const ZEN_CATALOG_URL = 'https://opencode.ai/zen/v1/models';
export const GO_CATALOG_URL = 'https://opencode.ai/zen/go/v1/models';

// Providers are keyed by the ladder rung prefix they own — config/ladders.json only ever uses
// these three, and test/free-models.test.js asserts that (a new prefix must get a collector).
export const PROVIDERS = ['openrouter', 'opencode-zen', 'opencode-go'];

// The zen free tier is anonymous but validates the opencode-client fingerprint (issue #106 —
// captured live via mitmproxy, see scripts/zen-limit-probe.mjs for the full matrix). A probe
// without it gets a 403 and every zen model would look unavailable. The request/session header
// SHAPES are part of the validation: msg_<12 hex><12 alnum> and ses_<6 hex><14 alnum — the same
// ones scripts/zen-relay.mjs sends.
const ZEN_UA = 'opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14';
const ZEN_SHELL_TOOL = { type: 'function', function: { name: 'shell', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } } };
const ZEN_READ_TOOL = { type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } };
const ZEN_ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
// getRandomValues, not node:crypto — this module runs in the worker too, where the global crypto
// is the Web Crypto API.
const randBytes = (n) => {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
};
const randHex = (n) => [...randBytes(n)].map((b) => b.toString(16).padStart(2, '0')).join('');
const randAlnum = (n) => {
  const b = randBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ZEN_ALNUM[b[i] % ZEN_ALNUM.length];
  return s;
};

// Prices are stored PER 1M TOKENS, matching config/prices.json (costUsd divides by 1e6).
const PER_MILLION = 1e6;
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const perMillion = (v) => {
  const n = num(v);
  return n === null ? null : n * PER_MILLION;
};

// ── Catalog collection ──────────────────────────────────────────────────────────────

async function getJson(url, { fetchImpl, headers = {}, timeoutMs }) {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
  }
  return res.json();
}

function entriesOf(payload) {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.data) ? payload.data : [];
}

// OpenRouter: free = `:free` suffix, or both prices exactly 0 (the issue's two signals are
// equivalent there; a model with a paid output is NOT free even if the prompt is free).
function openRouterFree(e) {
  const inP = num(e?.pricing?.prompt);
  const outP = num(e?.pricing?.completion);
  return String(e?.id || '').endsWith(':free') || (inP === 0 && outP === 0);
}

function zenFree(e) {
  const id = String(e?.id || '');
  if (id.endsWith('-free')) return true;
  // `big-pickle` is a free-tier zen model without the suffix (it is a rung in the `free` ladder).
  if (id === 'big-pickle') return true;
  // A catalog that publishes pricing: free only when every published price is 0.
  const prices = Object.values(e?.pricing || {}).map(num).filter((v) => v !== null);
  return prices.length > 0 && prices.every((v) => v === 0);
}

function goFree(e) {
  return String(e?.id || '').endsWith('-free');
}

function normalize(provider, e, { inLadder }) {
  const id = String(e?.id || '');
  if (!id) return null;
  const rung = `${provider}/${id}`;
  const row = {
    provider,
    model_id: rung,
    name: String(e?.name || e?.id || ''),
    context: num(e?.context_length),
    price_in: 0,
    price_out: 0,
    price_cached: 0,
    owned_by: e?.architecture?.backend || e?.owned_by || null,
    description: typeof e?.description === 'string' ? e.description.slice(0, 500) : null,
    in_ladder: inLadder.has(rung) ? 1 : 0,
  };
  if (provider === 'openrouter') {
    row.price_in = perMillion(e?.pricing?.prompt) ?? 0;
    row.price_out = perMillion(e?.pricing?.completion) ?? 0;
    row.price_cached = perMillion(e?.pricing?.input_cache_read) ?? 0;
  }
  // zen and Go free tiers are subscription/unlimited — no per-token price is published.
  return row;
}

function ladderRungs(config) {
  const rungs = new Set();
  for (const roles of Object.values(config?.ladders || {})) {
    for (const list of Object.values(roles || {})) {
      for (const rung of list || []) {
        const id = String(rung);
        rungs.add(id);
        // `zen-rings/<model>` and `opencode-zen/<model>` are the same weights over different
        // transports (the SHARED mapping in test/free-models.test.js), but only `opencode-zen/*`
        // rows are ever emitted — the collector's prefix. A model served through the ring must
        // still read as in-ladder, or the inventory reports a model nobody uses while a rung
        // points straight at it.
        if (id.startsWith('zen-rings/')) rungs.add(`opencode-zen/${id.slice('zen-rings/'.length)}`);
      }
    }
  }
  return rungs;
}

// One provider → its free rows. A thrown error becomes { ok:false, error } so one dead provider
// cannot take the whole run down (and cannot mark its models gone — see reconcileMissing).
async function collectProvider(provider, env, { fetchImpl, timeoutMs, inLadder }) {
  const one = async () => {
    if (provider === 'openrouter') {
      const payload = await getJson(OPENROUTER_CATALOG_URL, { fetchImpl, timeoutMs });
      return entriesOf(payload).filter(openRouterFree).map((e) => normalize('openrouter', e, { inLadder }));
    }
    if (provider === 'opencode-zen') {
      const payload = await getJson(ZEN_CATALOG_URL, { fetchImpl, timeoutMs });
      return entriesOf(payload).filter(zenFree).map((e) => normalize('opencode-zen', e, { inLadder }));
    }
    if (provider === 'opencode-go') {
      // GET /models is PUBLIC (answers 200 with no key) — try that first, so a missing pool key
      // degrades nothing. If Go ever locks the catalog behind auth, fall back to the pool in order.
      const attempts = [{}, ...readPool(env).map((key) => ({ Authorization: `Bearer ${key}` }))];
      let lastErr = null;
      for (const headers of attempts) {
        try {
          const payload = await getJson(GO_CATALOG_URL, { fetchImpl, timeoutMs, headers });
          return entriesOf(payload).filter(goFree).map((e) => normalize('opencode-go', e, { inLadder }));
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error('no Go pool key configured');
    }
    throw new Error(`unknown provider ${provider}`);
  };
  try {
    const models = (await one()).filter(Boolean);
    return { provider, ok: true, count: models.length, models };
  } catch (e) {
    return { provider, ok: false, error: String((e && e.message) || e), count: 0, models: [] };
  }
}

// All providers, in parallel. Returns { providers, rows } — rows is the flat free inventory.
// Rows are ordered by PROVIDERS order, then model_id: the inventory is a report, and a stable
// order keeps the diff readable (and the tests honest) regardless of which provider answered first.
export async function collectCatalogs(env, { fetchImpl = fetch, timeoutMs = 10_000, config } = {}) {
  const inLadder = ladderRungs(config);
  const providers = await Promise.all(PROVIDERS.map((p) => collectProvider(p, env, { fetchImpl, timeoutMs, inLadder })));
  const rank = new Map(PROVIDERS.map((p, i) => [p, i]));
  const rows = providers
    .flatMap((p) => p.models)
    .sort((a, b) => (rank.get(a.provider) - rank.get(b.provider)) || a.model_id.localeCompare(b.model_id));
  return { providers, rows };
}

// ── Availability probe ─────────────────────────────────────────────────────────────

// Which rows to probe this run: least-recently-probed first (NULLS FIRST), so a budget smaller
// than the inventory still rotates coverage instead of always hitting the same head.
export function planProbes(rows, { limit = 12 } = {}) {
  return [...rows]
    .sort((a, b) => (a.probed_at ?? 0) - (b.probed_at ?? 0))
    .slice(0, Math.max(0, limit));
}

function probeRequest(provider, modelId, env) {
  const bare = modelId.slice(modelId.indexOf('/') + 1);
  const base = provider === 'openrouter'
    ? 'https://openrouter.ai/api/v1'
    : provider === 'opencode-zen'
      ? ZEN_CATALOG_URL.replace('/models', '')
      : GO_CATALOG_URL.replace('/models', '');
  const headers = { 'content-type': 'application/json' };
  const body = { model: bare, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] };
  if (provider === 'openrouter') {
    if (!env.OPENROUTER_API_KEY) return { skip: 'no key' };
    headers.Authorization = `Bearer ${env.OPENROUTER_API_KEY}`;
  } else if (provider === 'opencode-zen') {
    // zen 403s without the fingerprint and without stream:true (issue #106). The status is the
    // whole answer we need, so the body is never consumed — the stream is cancelled on arrival.
    headers.Authorization = 'Bearer public';
    headers['user-agent'] = ZEN_UA;
    headers['x-opencode-client'] = 'cli';
    headers['x-opencode-project'] = 'global';
    headers['x-opencode-request'] = `msg_${randHex(12)}${randAlnum(12)}`;
    headers['x-opencode-session'] = `ses_${randHex(6)}${randAlnum(14)}`;
    body.stream = true;
    body.tools = [ZEN_SHELL_TOOL, ZEN_READ_TOOL];
  } else {
    const pool = readPool(env);
    if (!pool.length) return { skip: 'no key' };
    headers.Authorization = `Bearer ${pool[0]}`;
    // Go 400s a chat call without a session id (same rule the ladder applies in upstreamRequest).
    headers['x-opencode-session'] = `probe_${crypto.randomUUID().slice(0, 12)}`;
  }
  return { url: `${base}/chat/completions`, headers, body };
}

// A 200 means the model exists and answers. 429 is a free-tier limit (not a disappearance),
// 404/"model not found" is the only real "gone" signal, anything else is an error to look at.
function probeStatusOf(status, text) {
  if (status === 200) return 'ok';
  if (status === 429) return 'limited';
  if (status === 404 || /not found|unknown model|no such model/i.test(text)) return 'not_found';
  return `http_${status || 0}`;
}

// Light ping: one request per model, bounded by planProbes, never more often than the schedule.
// The key never travels further than the fetch headers — nothing here logs a request.
export async function probeRows(rows, env, { fetchImpl = fetch, timeoutMs = 15_000, concurrency = 4 } = {}) {
  const out = new Map();
  const queue = [...rows];
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), queue.length) }, async () => {
    for (;;) {
      const row = queue.shift();
      if (!row) return;
      const started = Date.now();
      const req = probeRequest(row.provider, row.model_id, env);
      if (req.skip) { out.set(row.model_id, { probe_status: 'skipped', probe_reason: req.skip, probed_at: started }); continue; }
      let status = 0, text = '';
      try {
        const res = await fetchImpl(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(timeoutMs) });
        status = res.status;
        text = await res.text().catch(() => '');
        if (res.body) await res.body.cancel().catch(() => {});
      } catch (e) {
        out.set(row.model_id, { probe_status: 'error', probe_reason: String((e && e.message) || e).slice(0, 120), probed_at: started });
        continue;
      }
      out.set(row.model_id, { probe_status: probeStatusOf(status, text), probed_at: started });
    }
  });
  await Promise.all(workers);
  return out;
}

// ── Diff ───────────────────────────────────────────────────────────────────────────

// prev/next are maps of model_id → row. `changed` covers the fields the issue names (context,
// price) plus name/owned_by, which are the other things a benchmark would care about.
// okProviders (optional): the providers whose fetch SUCCEEDED this run. A model whose provider
// did not answer is UNKNOWN, not gone — reporting it as gone would turn every provider outage
// into a false "model left" in the diff. Without the option every provider is assumed ok.
export function diffRows(prev, next, { okProviders } = {}) {
  const appeared = [], gone = [], changed = [];
  for (const [id, row] of next) {
    const before = prev.get(id);
    if (!before) { appeared.push(row); continue; }
    const fields = [];
    for (const f of ['context', 'price_in', 'price_out', 'price_cached', 'name', 'owned_by']) {
      if (before[f] !== row[f]) fields.push({ field: f, from: before[f] ?? null, to: row[f] ?? null });
    }
    if (fields.length) changed.push({ model_id: id, provider: row.provider, fields });
  }
  for (const [id, row] of prev) {
    if (next.has(id)) continue;
    if (okProviders && !okProviders.has(row.provider)) continue;
    gone.push(row);
  }
  const byId = (r) => r.model_id;
  return {
    appeared: appeared.sort((a, b) => byId(a).localeCompare(byId(b))),
    gone: gone.sort((a, b) => byId(a).localeCompare(byId(b))),
    changed: changed.sort((a, b) => a.model_id.localeCompare(b.model_id)),
  };
}

// ── D1 ─────────────────────────────────────────────────────────────────────────────

export const FREE_MODELS_TABLE = 'free_models';

export const UPSERT_SQL = `INSERT INTO ${FREE_MODELS_TABLE}
  (provider, model_id, name, context, price_in, price_out, price_cached, owned_by, description,
   in_ladder, first_seen, last_seen, available, probe_status, probed_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, ?13, ?14)
  ON CONFLICT(provider, model_id) DO UPDATE SET
    name = excluded.name, context = excluded.context,
    price_in = excluded.price_in, price_out = excluded.price_out, price_cached = excluded.price_cached,
    owned_by = excluded.owned_by, description = excluded.description, in_ladder = excluded.in_ladder,
    last_seen = excluded.last_seen, available = 1,
    probe_status = excluded.probe_status, probed_at = excluded.probed_at`;

export const GONE_SQL = `UPDATE ${FREE_MODELS_TABLE} SET available = 0, last_seen = ?1 WHERE provider = ?2 AND model_id = ?3`;

export const READ_SQL =
  'SELECT provider, model_id, name, context, price_in, price_out, price_cached, owned_by, description, '
  + 'in_ladder, first_seen, last_seen, available, probe_status, probed_at '
  + `FROM ${FREE_MODELS_TABLE} ORDER BY provider, model_id`;

export function upsertStatement(row, now) {
  return {
    sql: UPSERT_SQL,
    params: [
      row.provider, row.model_id, row.name, row.context,
      row.price_in, row.price_out, row.price_cached, row.owned_by, row.description, row.in_ladder,
      row.first_seen ?? now, now, row.probe_status ?? null, row.probed_at ?? null,
    ],
  };
}

export function goneStatement(row, now) {
  return { sql: GONE_SQL, params: [now, row.provider, row.model_id] };
}

// D1 has no multi-row VALUES insert; batch in chunks (db.batch is one round trip per chunk).
// A fake D1 without .batch falls back to sequential .run() so tests can assert per statement.
export async function runStatements(db, statements, { chunk = 50 } = {}) {
  if (!statements.length) return;
  if (typeof db.batch === 'function') {
    for (let i = 0; i < statements.length; i += chunk) {
      await db.batch(statements.slice(i, i + chunk).map((s) => db.prepare(s.sql).bind(...s.params)));
    }
    return;
  }
  for (const s of statements) await db.prepare(s.sql).bind(...s.params).run();
}

export async function readFreeModels(db) {
  const { results = [] } = await db.prepare(READ_SQL).all();
  return results;
}

// ── The whole run ──────────────────────────────────────────────────────────────────

// One collection pass: catalogs → probe → upsert → reconcile → diff. `prev` is the table as it
// was BEFORE this pass (read by the caller, so the read and the write share one transaction
// boundary in the handler). Returns everything the report needs.
export async function collectFreeModels(env, db, {
  fetchImpl = fetch, timeoutMs = 10_000, probe = true, probeLimit = 12, probeConcurrency = 4,
  config, write = true, now = Date.now(),
} = {}) {
  const prevRows = await readFreeModels(db);
  const prev = new Map(prevRows.map((r) => [r.model_id, r]));

  const { providers, rows } = await collectCatalogs(env, { fetchImpl, timeoutMs, config });
  const next = new Map(rows.map((r) => [r.model_id, r]));

  // Probe only what is in the catalog now — a model that left is not worth a request.
  const probeTargets = probe ? planProbes(rows, { limit: probeLimit }) : [];
  const probes = await probeRows(probeTargets, env, { fetchImpl, timeoutMs: 15_000, concurrency: probeConcurrency });
  for (const row of rows) {
    const p = probes.get(row.model_id);
    if (p) { row.probe_status = p.probe_status; row.probe_reason = p.probe_reason ?? null; row.probed_at = p.probed_at; }
  }

  const statements = rows.map((r) => upsertStatement({ ...r, first_seen: prev.get(r.model_id)?.first_seen ?? now }, now));

  // Reconcile ONLY the providers whose fetch succeeded: a dead provider must not mark its whole
  // catalog gone (that would be a false "model left" in every diff until it recovers).
  const okProviders = new Set(providers.filter((p) => p.ok).map((p) => p.provider));
  const seen = new Set(rows.map((r) => r.model_id));
  for (const row of prevRows) {
    if (!seen.has(row.model_id) && okProviders.has(row.provider)) statements.push(goneStatement(row, now));
  }

  const written = write ? statements.length : 0;
  if (write) await runStatements(db, statements);

  const diff = diffRows(prev, next, { okProviders });
  return {
    started_at: new Date(now).toISOString(),
    finished_at: new Date().toISOString(),
    now,
    providers,
    collected: rows.length,
    probed: probeTargets.length,
    probes: Object.fromEntries([...probes.entries()].map(([k, v]) => [k, v])),
    written,
    diff,
    rows,
  };
}

// ── Report ─────────────────────────────────────────────────────────────────────────

const fmtPrice = (v) => (v === null || v === undefined ? '—' : `$${(v / PER_MILLION).toFixed(4)}`);
const fmtCtx = (v) => (v === null || v === undefined ? '—' : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1000)}k`);
const ago = (ms, now) => {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

export function summarizeRun(run) {
  const byProvider = {};
  for (const p of run.providers) {
    byProvider[p.provider] = { ok: p.ok, count: p.count, error: p.error ?? null };
  }
  const probeCounts = {};
  for (const v of Object.values(run.probes)) probeCounts[v.probe_status] = (probeCounts[v.probe_status] || 0) + 1;
  return {
    collected: run.collected,
    by_provider: byProvider,
    probed: run.probed,
    probe_counts: probeCounts,
    written: run.written,
    appeared: run.diff.appeared.length,
    gone: run.diff.gone.length,
    changed: run.diff.changed.length,
  };
}

// Markdown for the Actions step summary / the CLI. Kept in the module so the endpoint, the
// script and the tests all render the same report.
export function markdownReport(run) {
  const s = summarizeRun(run);
  const L = [];
  L.push(`## Free-model inventory — ${run.started_at}`);
  L.push('');
  const prov = run.providers.map((p) => `${p.ok ? '' : '⚠ '}${p.provider} ${p.count}${p.ok ? '' : ` (${p.error})`}`).join(' · ');
  L.push(`**${s.collected} free models** — ${prov}`);
  L.push(`probed ${s.probed} · written ${s.written} rows · appeared ${s.appeared} · gone ${s.gone} · changed ${s.changed}`);
  const pc = Object.entries(s.probe_counts).map(([k, v]) => `${k} ${v}`).join(', ');
  if (pc) L.push(`probe: ${pc}`);
  if (s.appeared) {
    L.push('', `### New (${s.appeared})`, '');
    for (const r of run.diff.appeared) {
      L.push(`- \`${r.model_id}\` — ${r.name} · ctx ${fmtCtx(r.context)} · ${fmtPrice(r.price_in)}/${fmtPrice(r.price_out)} per 1M${r.in_ladder ? '' : ' · **not in a ladder**'}`);
    }
  }
  if (s.gone) {
    L.push('', `### Gone (${s.gone})`, '');
    for (const r of run.diff.gone) {
      L.push(`- \`${r.model_id}\` — last seen ${ago(r.last_seen, run.now)}`);
    }
  }
  if (s.changed) {
    L.push('', `### Changed (${s.changed})`, '');
    for (const c of run.diff.changed) {
      const parts = c.fields.map((f) => `${f.field} ${f.from ?? '—'} → ${f.to ?? '—'}`);
      L.push(`- \`${c.model_id}\` — ${parts.join(', ')}`);
    }
  }
  if (!s.appeared && !s.gone && !s.changed) L.push('', '_No changes since the previous run._');
  return L.join('\n');
}
