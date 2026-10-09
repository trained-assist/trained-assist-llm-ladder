// HTTP route of the ladder worker — dependency-free of the Workerd runtime so it runs in plain
// `node --test` (the sandbox imports it), while src/index.js remains the Worker entry: it wraps this
// handler and exports the LadderState Durable Object for the platform binding.

import { run, readPool, fetchGoUsage, fetchOrUsage, DEFAULT_LADDER, sanitizeAppSlug, sanitizeAppSlugOrNull, sanitizeAppTitle } from './ladder.js';
import { makeTrace, logCall } from './trace.js';
import { collectFreeModels, readFreeModels, FREE_MODELS_TABLE, markdownReport, summarizeRun } from './free-models.js';
import * as zen from './zen-runner.js';
import * as ring from './zen-ring.js';
import config from '../config/ladders.json' with { type: 'json' };
import prices from '../config/prices.json' with { type: 'json' };

// GET /v1/analytics: both bind ?1 = since (ms). Aggregates per requested ladder name;
// the depth histogram is attempts-per-call from the attempts JSON (json_valid guards
// legacy rows). Keep the bind: an interpolated timestamp is an injection (query-trace
// guard tests the same rule for the python read path).
const ANALYTICS_AGG_SQL =
  'SELECT ladder, COUNT(*) AS calls, SUM(1 - ok) AS failed, '
  + 'SUM(COALESCE(tokens_in, 0)) AS tin, SUM(COALESCE(tokens_out, 0)) AS tout, '
  + 'SUM(CASE WHEN tokens_in IS NULL THEN 1 ELSE 0 END) AS no_usage '
  + 'FROM ladder_calls WHERE ts >= ?1 GROUP BY ladder';
// Per ladder × served model: calls + tokens (in / cached / out) so the caller can price each
// rung. Category is derived in JS (categoryOf) — the model already determines it.
const ANALYTICS_RUNGS_SQL =
  'SELECT ladder, model, COUNT(*) AS calls, '
  + 'SUM(COALESCE(tokens_in, 0)) AS tin, SUM(COALESCE(tokens_cached, 0)) AS tcached, '
  + 'SUM(COALESCE(tokens_out, 0)) AS tout '
  + 'FROM ladder_calls WHERE ts >= ?1 AND ok = 1 GROUP BY ladder, model ORDER BY ladder, calls DESC';
// Hourly cut (#93): the same ladder × model breakdown bucketed by UTC hour, so every cost
// cut the owner asked for is one row per hour, not a per-call dump.
const ANALYTICS_HOURLY_SQL =
  "SELECT strftime('%Y-%m-%dT%H:00Z', ts / 1000, 'unixepoch') AS hour, ladder, model, "
  + 'COUNT(*) AS calls, SUM(ok) AS ok_n, '
  + 'SUM(COALESCE(tokens_in, 0)) AS tin, SUM(COALESCE(tokens_cached, 0)) AS tcached, '
  + 'SUM(COALESCE(tokens_out, 0)) AS tout '
  + 'FROM ladder_calls WHERE ts >= ?1 GROUP BY hour, ladder, model ORDER BY hour DESC, calls DESC';
const ANALYTICS_DEPTH_SQL =
  'SELECT ladder, json_array_length(attempts) AS depth, COUNT(*) AS calls '
  + 'FROM ladder_calls WHERE ts >= ?1 AND attempts IS NOT NULL AND json_valid(attempts) '
  + 'GROUP BY ladder, depth';
// Per caller sub-task × ladder × served model (#107). The ladder name alone cannot answer
// "which sub-task burns the money": every one of the agent's ~20 service tools posts
// `model: "service"`, and the only thing that tells them apart is `x-ladder-app` (the caller's
// `source:`). Grouped by model as well so each row prices exactly like a rung row.
const ANALYTICS_APPS_SQL =
  'SELECT app, ladder, model, COUNT(*) AS calls, '
  + 'SUM(COALESCE(tokens_in, 0)) AS tin, SUM(COALESCE(tokens_cached, 0)) AS tcached, '
  + 'SUM(COALESCE(tokens_out, 0)) AS tout '
  + 'FROM ladder_calls WHERE ts >= ?1 AND ok = 1 AND app IS NOT NULL '
  + 'GROUP BY app, ladder, model ORDER BY calls DESC';
// Attribution coverage (#136): served calls that named no app. The apps cut skips these rows by
// construction (`app IS NOT NULL`), so without this number the digest's application block would
// quietly shrink the moment the 'llm-ladder' placeholder stopped being written — the reader could
// not tell "fewer callers" from "fewer callers admitting themselves". Counted over ok = 1 to
// match the cut: a failed call is not traffic anyone needs attributed.
const ANALYTICS_NO_APP_SQL =
  'SELECT COUNT(*) AS calls FROM ladder_calls WHERE ts >= ?1 AND ok = 1 AND app IS NULL';
// Raw error counts (top 100 by frequency, same as scripts/analytics.py). Grouping is on
// the RAW string — digit variants ('can only afford 499' / '776') are merged by
// normalizeError() below, mirroring analytics.py normalize_error.
const ANALYTICS_ERRORS_SQL =
  "SELECT json_extract(j.value, '$.error') AS err, COUNT(*) AS n "
  + 'FROM ladder_calls, json_each(ladder_calls.attempts) j '
  + "WHERE ts >= ?1 AND json_extract(j.value, '$.outcome') <> 'ok' "
  + "AND json_extract(j.value, '$.error') IS NOT NULL "
  + 'AND json_valid(ladder_calls.attempts) '
  + 'GROUP BY err ORDER BY n DESC LIMIT 100';

// Per-model latency + context percentiles. The digest's "top models" block (owner request
// 2026-10-05): mean latency hides the tail, so the block needs the distribution's shape —
// p50/p95 of ms and p20/p50/p80 of the prompt size actually sent.
//
// SQLite has no percentile() and D1 has no extension to add one, so the percentile is picked
// by rank: ROW_NUMBER() over each model's rows ordered by the metric, then the outer
// MAX(CASE …) keeps the value at the nearest-rank index ceil(p·n). Nearest-rank (not
// interpolation) because a percentile here is an OBSERVED call, not a synthetic one —
// "the 95th-percentile call took 16.1s" should name a call that really happened.
//
// Two rank tracks, two denominators:
//   · ms     — every ok call, `n` = all calls of the model. Latency exists for streams too.
//   · tokens_in — only calls that carried usage. Stream rows log NULL (#22), so ranking them
//     would put 40% of the model at the bottom of the prompt-size distribution and make p20
//     read like "tiny prompts". Hence the explicit `(tokens_in IS NULL)` sort key to push
//     NULLs past the real values, and `n_tin` = COUNT(tokens_in) as the denominator.
//     `with_usage` ships alongside so the reporter can say how much of the model it saw.
const pct = (p, nCol) =>
  `MAX(1, MIN(${nCol}, CAST(${p} * ${nCol} AS INTEGER) + CASE WHEN ${p} * ${nCol} > CAST(${p} * ${nCol} AS INTEGER) THEN 1 ELSE 0 END))`;
const ANALYTICS_MODELS_SQL =
  'WITH ranked AS (SELECT model, ms, tokens_in, '
  + 'ROW_NUMBER() OVER (PARTITION BY model ORDER BY ms) AS rms, '
  + 'COUNT(*) OVER (PARTITION BY model) AS n, '
  + 'ROW_NUMBER() OVER (PARTITION BY model ORDER BY (tokens_in IS NULL), tokens_in) AS rtin, '
  + 'COUNT(tokens_in) OVER (PARTITION BY model) AS n_tin '
  + 'FROM ladder_calls WHERE ts >= ?1 AND ok = 1 AND model IS NOT NULL) '
  + 'SELECT model, COUNT(*) AS calls, '
  + 'SUM(CASE WHEN tokens_in IS NOT NULL THEN 1 ELSE 0 END) AS with_usage, '
  + `MAX(CASE WHEN rms = ${pct(0.5, 'n')} THEN ms END) AS ms_p50, `
  + `MAX(CASE WHEN rms = ${pct(0.95, 'n')} THEN ms END) AS ms_p95, `
  + `MAX(CASE WHEN rtin = ${pct(0.2, 'n_tin')} THEN tokens_in END) AS tin_p20, `
  + `MAX(CASE WHEN rtin = ${pct(0.5, 'n_tin')} THEN tokens_in END) AS tin_p50, `
  + `MAX(CASE WHEN rtin = ${pct(0.8, 'n_tin')} THEN tokens_in END) AS tin_p80 `
  + 'FROM ranked GROUP BY model ORDER BY calls DESC LIMIT 12';

// Same models, but only the upstream prefix (the text before the first `/`) and the call
// share — the "разбивка по источникам" line of the digest's top-models block. A separate
// query rather than a rollup of ANALYTICS_MODELS_SQL: that one is LIMIT 12, so folding it
// would silently price the source split on the head of the distribution only.
const ANALYTICS_SOURCES_SQL =
  "SELECT CASE WHEN instr(model, '/') > 0 THEN substr(model, 1, instr(model, '/') - 1) "
  + "ELSE '(без префикса)' END AS source, COUNT(*) AS calls "
  + 'FROM ladder_calls WHERE ts >= ?1 AND ok = 1 AND model IS NOT NULL '
  + 'GROUP BY source ORDER BY calls DESC LIMIT 8';

// Port of analytics.py normalize_error: keep the 'HTTP <status>:' head, mask digits in
// the payload so one failure with varying counts stays one bucket; cap at 160 chars.
// Truncation gets an ellipsis — without it the digest shows a raw mid-JSON cut
// ('…-flash-fin","c — 34') that reads as corruption.
export function normalizeError(err) {
  if (!err) return '(no message)';
  const clip = (s) => s.length > 160 ? s.slice(0, 159).trimEnd() + '…' : s;
  const s = String(err);
  const i = s.indexOf(': ');
  if (i !== -1 && /^HTTP \d+$/.test(s.slice(0, i).trim())) {
    const body = s.slice(i + 2).replace(/\d+/g, '#');
    return clip((s.slice(0, i + 2) + body).replace(/\s+/g, ' ').trim());
  }
  return clip(s.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim());
}

// Rung category — which free/paid tier a served model belongs to (#80). Derived in JS now
// that the rung query returns the model itself.
export function categoryOf(model) {
  if (!model) return 'other';
  if (model.startsWith('opencode-go/')) return model.endsWith('-free') ? 'go_free' : 'go_sub';
  if (model.startsWith('opencode-zen/')) return 'zen';
  if (model.startsWith('openrouter/')) return model.endsWith(':free') ? 'or_free' : 'or_paid';
  return 'other';
}

// Estimated $ for one ladder×model row: (in - cached)×in + out×out + cached×cachedRead, all
// per 1M tokens (config/prices.json). null = unknown price and not an obvious $0 rung.
export function costUsd(model, tin, tcached, tout) {
  if (!model) return null;
  const p = prices[model];
  if (!p) return (model.startsWith('opencode-zen/') || model.startsWith('zen-rings/') || model.endsWith('-free') || model.endsWith(':free')) ? 0 : null;
  const fresh = Math.max(0, (tin || 0) - (tcached || 0));
  return (fresh * p[0] + (tout || 0) * p[1] + (tcached || 0) * p[2]) / 1e6;
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function oaError(status, message, type, extra = {}, headers = {}) {
  return json(status, { error: { message, type, ...extra } }, headers);
}

function timingSafeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function bearerToken(request) {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
  return m ? m[1].trim() : null;
}

function authorized(request, env) {
  const token = bearerToken(request);
  if (!token) return false;
  const additional = typeof env.LADDER_TOKENS === 'string' ? env.LADDER_TOKENS.split(',').map((token) => token.trim()) : [];
  const accepted = [env.LADDER_TOKEN, env.LADDER_TOKEN_PREVIOUS, ...additional]
    .filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
  let matches = false;
  for (const candidate of accepted) matches = timingSafeEqual(token, candidate) || matches;
  return matches;
}

// Pin kill-switch: LADDER_PIN_ENABLED=false/0/off disables sticky rungs entirely (no pin
// read/write, byte-for-byte today's behaviour). Default is enabled.
function pinEnabled(env) {
  return !/^(false|0|off)$/i.test(String(env.LADDER_PIN_ENABLED ?? ''));
}

async function sha256hex(s) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

// Extract a stable conversation id from the request (x-session-affinity → x-session-id →
// body.ladder_conversation), cap it at 256 chars, SHA-256 hash it. Returns null for
// unkeyed callers (service-llm, pr-autofix, bench) so the hot path is untouched.
export async function conversationKey(request, body, env) {
  if (!pinEnabled(env)) return null;
  const raw = String(
    request.headers.get('x-session-affinity') ||
    request.headers.get('x-session-id') ||
    (body && body.ladder_conversation) ||
    ''
  ).slice(0, 256).trim();
  return raw ? sha256hex(raw) : null;
}

export function makeStore(env) {
  const stub = env.LADDER_STATE.get(env.LADDER_STATE.idFromName('global'));
  const poolSize = readPool(env).length;
  return {
    snapshot: (poolSizeArg, pinKey) => stub.snapshot(poolSizeArg ?? poolSize, pinKey),
    recordFailure: (model, f, extra) => stub.recordFailure(model, f, extra),
    recordSuccess: (model, extra) => stub.recordSuccess(model, extra),
    rotateKey: (size, ttlMs, failedIndex) => stub.rotateKey(size, ttlMs, failedIndex),
    resetKeys: () => stub.resetKeys(),
    park: (models, untilMs) => stub.park(models, untilMs),
    pinStats: () => stub.pinStats(),
  };
}

// ── Pool endpoints (owner decision 2026-10-01): the control-plane tail for the runs pool.
// Only metadata + references travel through here: a task string ≤ 4000 chars and optional
// pointers. Gigabytes NEVER go through this API — big payloads move presigned-URL direct
// between the client and object storage, and `artifactRef` is just the reference: the worker
// never downloads it, only relays it in the dispatch.
const POOL_DISPATCH_URL = 'https://api.github.com/repos/vovalikessmoothy-png/ai-agent-runs-pool/dispatches';
const POOL_DISPATCH_TIMEOUT_MS = 10_000;
const POOL_BODY_MAX_BYTES = 8 * 1024;
const POOL_TASK_MAX_CHARS = 4000;
// location (epic ai-agent-run-api#1, Ф1): "" = наш пул; ru/eu/us зарезервированы под
// региональные пулы (вне скоупа) — принимаются, но помечаются reserved и не исполняются.
const POOL_LOCATIONS = ['', 'ru', 'eu', 'us'];
const RING_RESERVED_LOCATIONS = new Set(['ru', 'eu', 'us']);

// POST /pool/trigger — own token (POOL_TRIGGER_TOKEN, independent from LADDER_TOKEN),
// timing-safe compare; env not set → 503 CONFIG. Body ≤ 8 KB → one GitHub
// repository_dispatch (10 s cap) → 202 {queued:true, location}. Logs metadata only (task
// length, location, statuses) — never the task text or any token.
async function poolTrigger(request, env, fetchImpl) {
  if (!env.POOL_TRIGGER_TOKEN || !env.GITHUB_AI_AGENT_RUNS_POOL) {
    return oaError(503, 'pool trigger not configured', 'CONFIG');
  }
  const presented = bearerToken(request);
  if (!presented || !timingSafeEqual(presented, String(env.POOL_TRIGGER_TOKEN).trim())) {
    return oaError(401, 'unauthorized', 'auth_error');
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > POOL_BODY_MAX_BYTES) {
    return oaError(413, `body too large (max ${POOL_BODY_MAX_BYTES} bytes)`, 'invalid_request_error');
  }
  let body;
  try { body = JSON.parse(raw); } catch { return oaError(400, 'bad json', 'invalid_request_error'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return oaError(400, 'json object required', 'invalid_request_error');
  const { task, repo, profile, artifactRef, location } = body;
  if (typeof task !== 'string' || !task.trim()) return oaError(400, 'task required', 'invalid_request_error');
  if (task.length > POOL_TASK_MAX_CHARS) return oaError(400, `task too long (max ${POOL_TASK_MAX_CHARS} chars)`, 'invalid_request_error');
  for (const [field, value] of Object.entries({ repo, profile, artifactRef })) {
    if (value !== undefined && typeof value !== 'string') return oaError(400, `${field} must be a string`, 'invalid_request_error');
  }
  // absent field == empty location (D4); anything else outside the enum → 400 naming the field (D3)
  if (location !== undefined && typeof location !== 'string') {
    return oaError(400, 'location must be a string (one of "", "ru", "eu", "us")', 'invalid_request_error');
  }
  const loc = location === undefined ? '' : location;
  if (!POOL_LOCATIONS.includes(loc)) {
    return oaError(400, `location: expected one of "", "ru", "eu", "us", got ${JSON.stringify(String(loc).slice(0, 50))}`, 'invalid_request_error');
  }
  const reserved = RING_RESERVED_LOCATIONS.has(loc);
  const started = Date.now();
  const meta = { route: 'pool/trigger', task_len: task.length, location: loc };
  let res;
  try {
    res = await fetchImpl(POOL_DISPATCH_URL, {
      method: 'POST',
      headers: {
        authorization: `token ${env.GITHUB_AI_AGENT_RUNS_POOL}`,
        'content-type': 'application/json',
        accept: 'application/vnd.github+json',
        'user-agent': 'trained-assist-llm-ladder',
      },
      // undefined optionals are dropped by JSON.stringify; artifactRef rides along untouched.
      // location is always present (normalized) so the receiver never has to guess D4.
      body: JSON.stringify({ event_type: 'agent-task', client_payload: { task, repo, profile, artifactRef, location: loc, ts: new Date().toISOString() } }),
      signal: AbortSignal.timeout(POOL_DISPATCH_TIMEOUT_MS),
    });
  } catch (e) {
    console.log(JSON.stringify({ ...meta, ok: false, err: (e && e.name) || 'Error', ms: Date.now() - started }));
    return json(502, { error: 'dispatch_failed', gh_status: null });
  }
  console.log(JSON.stringify({ ...meta, ok: res.ok, gh_status: res.status, ms: Date.now() - started }));
  if (!res.ok) return json(502, { error: 'dispatch_failed', gh_status: res.status });
  return json(202, { queued: true, location: loc, ...(reserved ? { reserved: true } : {}) });
}

export async function handle(request, env, { store, fetchImpl = fetch, events } = {}) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') {
    return json(200, { ok: true, ladders: Object.keys(config.ladders), build: env.BUILD_SHA || null });
  }
  // Pool control-plane: its own token and no-auth health — both sit BEFORE the LADDER_TOKEN
  // gate below, so the ladder routes are untouched.
  if (request.method === 'GET' && url.pathname === '/pool/health') {
    return json(200, { service: 'pool', ok: true });
  }
  if (request.method === 'POST' && url.pathname === '/pool/trigger') {
    return poolTrigger(request, env, fetchImpl);
  }

  // Zen Runner control plane: its own token (ZEN_RUNNER_TOKEN), before the LADDER_TOKEN gate —
  // same placement as the pool routes, so nothing in the ladder call path changes.
  if (request.method === 'GET' && url.pathname === '/zen/health') return zen.zenHealth(request, env);
  if (request.method === 'GET' && url.pathname === '/zen/models') return zen.zenModels(request, env);
  if (request.method === 'POST' && url.pathname === '/zen/run') return zen.zenRun(request, env, fetchImpl);
  if (request.method === 'POST' && url.pathname === '/zen/report') return zen.zenReport(request, env);
  if (request.method === 'GET' && url.pathname.startsWith('/zen/result/')) return zen.zenResult(request, env, url.pathname.slice('/zen/result/'.length));
  if (request.method === 'POST' && url.pathname === '/zen/repos') return zen.zenRepos(request, env);
  if (request.method === 'GET' && url.pathname === '/zen/ring/payload') return zen.zenRingPayload(request, env);
  // Zen Ring — a long-lived job as an API. Same token, same placement, before the ladder gate.
  if (request.method === 'GET' && url.pathname === '/zen/pool/health') return ring.zenRingHealth(request, env);
  if (request.method === 'POST' && url.pathname === '/zen/pool/register') return ring.zenRingRegister(request, env);
  if (request.method === 'GET' && url.pathname === '/zen/pool/pull') return ring.zenRingPull(request, env);
  if (request.method === 'POST' && url.pathname === '/zen/pool/result') return ring.zenRingResult(request, env);
  if (request.method === 'POST' && url.pathname === '/zen/pool/stop') return ring.zenRingStop(request, env);
  if (request.method === 'POST' && url.pathname === '/zen/pool/invoke') return ring.zenRingInvoke(request, env, fetchImpl);
  if (request.method === 'GET' && url.pathname === '/zen/pool/metrics') return ring.zenRingMetrics(request, env);
  if (request.method === 'POST' && url.pathname === '/zen/pool/scale') return ring.zenRingScale(request, env, fetchImpl);
  const mResult = /^\/zen\/pool\/result\/([A-Za-z0-9._-]{1,80})$/.exec(url.pathname);
  if (request.method === 'GET' && mResult) return ring.zenRingResultById(request, env, mResult[1]);

  if (!authorized(request, env)) return oaError(401, 'unauthorized', 'auth_error');

  if (request.method === 'GET' && url.pathname === '/v1/models') {
    const data = [];
    for (const [name, roles] of Object.entries(config.ladders)) {
      data.push({ id: name, object: 'model', owned_by: 'trained-assist-llm-ladder', rungs: roles.build || [] });
      for (const role of Object.keys(roles)) if (role !== 'build') data.push({ id: `${name}:${role}`, object: 'model', owned_by: 'trained-assist-llm-ladder', rungs: roles[role] });
    }
    return json(200, { object: 'list', data });
  }

  // GET /v1/state
  if (request.method === 'GET' && url.pathname === '/v1/state') {
    const s = await (store || makeStore(env)).snapshot();
    s.pins = await (store || makeStore(env)).pinStats();
    return json(200, s);
  }

  // GET /v1/go-usage — remaining Go allowance per pool key (unified rolling/weekly/monthly
  // percent, issue #91). The raw key never appears in the response or the logs.
  if (request.method === 'GET' && url.pathname === '/v1/go-usage') {
    return json(200, { keys: await fetchGoUsage(env, { fetchImpl }) });
  }

  // GET /v1/or-usage — зеркало /v1/go-usage для OpenRouter: лимит ключа + баланс аккаунта.
  // Платный хвост живёт на балансе (402 с 04.10), бесплатные `:free` — на дневном разрешении;
  // раньше ни то, ни другое было не видно. Сырые поля провайдера, ключ в ответ не попадает.
  if (request.method === 'GET' && url.pathname === '/v1/or-usage') {
    return json(200, await fetchOrUsage(env, { fetchImpl }));
  }

  // GET /v1/free-models — the free-model inventory (issue #111): every free model the ladder's
  // providers publish, with context/price and the last availability probe. Filters are bound,
  // never interpolated; `available` is 1/0 (a string 'true'/'false' would silently match
  // nothing, so it is parsed to a number first).
  if (request.method === 'GET' && url.pathname === '/v1/free-models') {
    const db = env.LADDER_TRACE_DB;
    if (!db) return oaError(503, 'trace database not configured', 'unavailable');
    const q = url.searchParams;
    const provider = q.get('provider');
    const available = q.get('available');
    const limit = Math.min(Math.max(Number(q.get('limit')) || 100, 1), 500);
    const where = [];
    const params = [];
    if (provider) { where.push('provider = ?1'); params.push(String(provider).slice(0, 40)); }
    if (available !== null && available !== '') {
      const avail = Number(available);
      if (!Number.isFinite(avail)) return oaError(400, 'available must be 0 or 1', 'invalid_request_error');
      where.push(`available = ?${params.length + 1}`);
      params.push(avail ? 1 : 0);
    }
    const sql = 'SELECT provider, model_id, name, context, price_in, price_out, price_cached, owned_by, '
      + 'description, in_ladder, first_seen, last_seen, available, probe_status, probed_at '
      + `FROM ${FREE_MODELS_TABLE}`
      + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
      + ` ORDER BY provider, model_id LIMIT ?${params.length + 1}`;
    try {
      const { results = [] } = await db.prepare(sql).bind(...params, limit).all();
      const models = results.map((r) => ({
        ...r,
        available: !!r.available,
        in_ladder: !!r.in_ladder,
        price_in: r.price_in === null ? null : r.price_in / 1e6,
        price_out: r.price_out === null ? null : r.price_out / 1e6,
        price_cached: r.price_cached === null ? null : r.price_cached / 1e6,
      }));
      const counts = {};
      for (const m of models) counts[m.provider] = (counts[m.provider] || 0) + 1;
      return json(200, { models, count: models.length, by_provider: counts, generated_ms: Date.now() });
    } catch (e) {
      return oaError(500, `free-models query failed: ${e.message}`, 'server_error');
    }
  }

  // POST /v1/free-models/collect — one collection pass (issue #111): fetch every provider's free
  // catalog, probe availability lightly, upsert into free_models, mark the missing ones gone.
  // This is the ONLY writer: the Go catalog needs a pool key, and the key lives in the worker
  // secret OPENCODE_GO_API_KEYS — it never leaves the worker and is never logged. The cron
  // (collect-free-models.yml) calls this; `dry_run` skips the write (and the reconcile) so a
  // manual run can preview the diff without touching the table.
  if (request.method === 'POST' && url.pathname === '/v1/free-models/collect') {
    const db = env.LADDER_TRACE_DB;
    if (!db) return oaError(503, 'trace database not configured', 'unavailable');
    let body = {};
    try { body = await request.json(); } catch { /* empty body = defaults */ }
    // A string "false"/"0" from a curl --data must not turn probing on.
    const flag = (v, def) => (v === undefined ? def : !/^(false|0|off)$/i.test(String(v)));
    const dryRun = flag(body.dry_run, false);
    const probe = flag(body.probe, true);
    const probeLimit = Math.min(Math.max(Number(body.probe_limit) || 12, 0), 100);
    const probeConcurrency = Math.min(Math.max(Number(body.probe_concurrency) || 4, 1), 16);
    try {
      const run = await collectFreeModels(env, db, {
        fetchImpl, config, probe, probeLimit, probeConcurrency,
        ...(dryRun ? { write: false } : {}),
      });
      // dry_run: the diff is computed against the table as it stands — nothing was written.
      return json(200, { ...(dryRun ? { dry_run: true } : {}), ...summarizeRun(run), diff: run.diff, report: markdownReport(run) });
    } catch (e) {
      return oaError(500, `free-models collect failed: ${e.message}`, 'server_error');
    }
  }

  // GET /v1/calls — the per-CALL trace log, the read side /v1/analytics has no counterpart for.
  //
  // /v1/analytics answers "how did the ladder do"; this answers "what happened to THIS request":
  // which rungs were walked, in what order, what each one said, how long the whole thing took.
  // Until now the only way to get that was scripts/query-trace.py from a laptop with a Cloudflare
  // token — so a dead ladder call was unreadable for anyone but the operator holding that token.
  //
  // Every filter is bound (?1..?5), never interpolated: a trace id is caller-supplied. Requires at
  // least one filter — an unfiltered read of the whole log is what the analytics endpoint is for,
  // and it would page through rows nobody asked for. `attempts` comes back as parsed JSON so the
  // caller does not have to re-implement the parser.
  if (request.method === 'GET' && url.pathname === '/v1/calls') {
    const db = env.LADDER_TRACE_DB;
    if (!db) return oaError(503, 'trace database not configured', 'unavailable');
    const q = url.searchParams;
    const since = Math.min(Number(q.get('since_ms')) || Date.now() - 24 * 3600_000, Date.now());
    const limit = Math.min(Math.max(Number(q.get('limit')) || 20, 1), 200);
    const trace = q.get('trace'), user = q.get('user'), chat = q.get('chat'), session = q.get('session');
    if (!trace && !user && !chat && !session) {
      return oaError(400, 'one of trace, user, chat, session is required', 'invalid_request_error');
    }
    const CALLS_SQL =
      'SELECT ts, trace_id, run_id, user_id, chat_id, session_id, ladder, ok, model, ms, '
      + 'tokens_in, tokens_out, '
      // json_valid in SQL, not in JS: one legacy row with a non-JSON blob must not be able to
      // throw the whole read away (same guard the two analytics queries use).
      + "CASE WHEN attempts IS NOT NULL AND json_valid(attempts) THEN attempts ELSE NULL END AS attempts "
      + 'FROM ladder_calls WHERE ts >= ?1 '
      + 'AND (?2 IS NULL OR trace_id = ?2) AND (?3 IS NULL OR user_id = ?3) '
      + 'AND (?4 IS NULL OR chat_id = ?4) AND (?5 IS NULL OR session_id = ?5) '
      + 'ORDER BY ts DESC LIMIT ?6';
    try {
      const { results = [] } = await db.prepare(CALLS_SQL)
        .bind(since, trace, user, chat, session, limit).all();
      const calls = results.map((r) => ({ ...r, ok: !!r.ok, attempts: r.attempts ? JSON.parse(r.attempts) : null }));
      return json(200, { calls, count: calls.length, filters: { trace, user, chat, session }, since_ms: since });
    } catch (e) {
      return oaError(500, `calls query failed: ${e.message}`, 'server_error');
    }
  }

  // Aggregates over the D1 trace for the hourly Telegram digest (vm-telegram-monitor):
  // per-ladder calls / failures / tokens + the attempts-depth histogram the reporter turns
  // into a retry funnel. Read-only; window is whole hours 1..168 (default 24).
  if (request.method === 'GET' && url.pathname === '/v1/analytics') {
    const db = env.LADDER_TRACE_DB;
    if (!db) return oaError(503, 'trace database not configured', 'unavailable');
    const hours = Math.min(168, Math.max(1, Math.floor(Number(url.searchParams.get('hours')) || 24)));
    const since = Date.now() - hours * 3_600_000;
    try {
      const aggRows = (await db.prepare(ANALYTICS_AGG_SQL).bind(since).all()).results || [];
      const rungRows = (await db.prepare(ANALYTICS_RUNGS_SQL).bind(since).all()).results || [];
      const hourlyRows = (await db.prepare(ANALYTICS_HOURLY_SQL).bind(since).all()).results || [];
      const appRows = (await db.prepare(ANALYTICS_APPS_SQL).bind(since).all()).results || [];
      const noAppRows = (await db.prepare(ANALYTICS_NO_APP_SQL).bind(since).all()).results || [];
      const depthRows = (await db.prepare(ANALYTICS_DEPTH_SQL).bind(since).all()).results || [];
      const errRows = (await db.prepare(ANALYTICS_ERRORS_SQL).bind(since).all()).results || [];
      const modelRows = (await db.prepare(ANALYTICS_MODELS_SQL).bind(since).all()).results || [];
      const sourceRows = (await db.prepare(ANALYTICS_SOURCES_SQL).bind(since).all()).results || [];
      const num = (v) => Number(v) || 0;
      // Canonical ladder names only (no aliases since 2026-10-03). The default role
      // 'X:build' collapses to 'X'; non-default roles (:review, :explore) stay separate.
      const canonName = (raw) => {
        const [base, role] = String(raw || '').split(':');
        return !role || role === 'build' ? base : `${base}:${role}`;
      };
      const ladders = new Map();
      const entry = (raw) => {
        const ladder = canonName(raw);
        let e = ladders.get(ladder);
        if (!e) { e = { ladder, calls: 0, failed: 0, tokens_in: 0, tokens_out: 0, no_usage: 0, depth: [] }; ladders.set(ladder, e); }
        return e;
      };
      for (const r of aggRows) {
        const e = entry(r.ladder);
        e.calls += num(r.calls); e.failed += num(r.failed);
        e.tokens_in += num(r.tin); e.tokens_out += num(r.tout); e.no_usage += num(r.no_usage);
      }
      // depth histogram: attempts per call (key-rotation retries included — it counts
      // HTTP attempts, which is what the digest labels "retries"). Rows arrive per raw
      // ladder name, so after the alias merge two raw names can map to one (depth, ladder)
      // bucket — sum, don't push duplicates (the reporter sums by depth anyway, but a
      // clean histogram keeps the payload self-describing).
      for (const r of depthRows) {
        const e = entry(r.ladder);
        const depth = num(r.depth), calls = num(r.calls);
        const hit = e.depth.find(x => x.depth === depth);
        if (hit) hit.calls += calls;
        else e.depth.push({ depth, calls });
      }
      const rungGroups = new Map();
      for (const r of rungRows) {
        const ladder = canonName(r.ladder); // alias-merge rung rows the same way as agg rows
        const model = r.model || null;
        const key = `${ladder}|${model}`;
        let e = rungGroups.get(key);
        if (!e) { e = { ladder, model, category: categoryOf(model), calls: 0, tokens_in: 0, tokens_cached: 0, tokens_out: 0 }; rungGroups.set(key, e); }
        e.calls += num(r.calls); e.tokens_in += num(r.tin); e.tokens_cached += num(r.tcached); e.tokens_out += num(r.tout);
      }
      for (const e of rungGroups.values()) e.cost_usd = costUsd(e.model, e.tokens_in, e.tokens_cached, e.tokens_out);
      const rungsByLadder = new Map();
      for (const e of rungGroups.values()) {
        if (!rungsByLadder.has(e.ladder)) rungsByLadder.set(e.ladder, []);
        rungsByLadder.get(e.ladder).push(e);
      }
// Hourly cut (#93): one row per UTC hour × ladder × model, with cost — the owner's
      // "master-plan-mimo: $X" view. Merged by canonical name: 'deepseek', 'deepseek:build'
      // and 'service' are the same ladder and must land in ONE row per hour.
      const hourlyGroups = new Map();
      for (const r of hourlyRows) {
        const hour = r.hour, ladder = canonName(r.ladder), model = r.model || null;
        const key = `${hour}|${ladder}|${model}`;
        let e = hourlyGroups.get(key);
        if (!e) { e = { hour, ladder, model, category: categoryOf(model), calls: 0, ok: 0, tokens_in: 0, tokens_cached: 0, tokens_out: 0 }; hourlyGroups.set(key, e); }
        e.calls += num(r.calls); e.ok += num(r.ok_n);
        e.tokens_in += num(r.tin); e.tokens_cached += num(r.tcached); e.tokens_out += num(r.tout);
      }
      const hourly = [...hourlyGroups.values()].map((e) => ({ ...e, cost_usd: costUsd(e.model, e.tokens_in, e.tokens_cached, e.tokens_out) }));
      const totals = { calls: 0, failed: 0, tokens_in: 0, tokens_out: 0, no_usage: 0, cost_usd: 0 };
      const out = [...ladders.values()].sort((a, b) => b.calls - a.calls);
      for (const e of out) {
        e.depth.sort((a, b) => a.depth - b.depth);
        e.rungs = rungsByLadder.get(e.ladder) || [];
        e.cost_usd = e.rungs.reduce((s, r) => s + (r.cost_usd || 0), 0);
        for (const k of Object.keys(totals)) totals[k] += e[k];
      }
      // Top errors, merged across all ladders: normalize first (digits masked), then
      // re-sum — 'can only afford 499' / '776' become one row. Top 20 with headroom;
      // the digest shows top 5. Rows arrive already frequency-ordered, but the merge
      // can promote a variant, so re-sort after grouping.
      const errGroups = new Map();
      for (const r of errRows) {
        const key = normalizeError(r.err);
        errGroups.set(key, (errGroups.get(key) || 0) + num(r.n));
      }
      const errors = [...errGroups.entries()]
        .map(([error, calls]) => ({ error, calls }))
        .sort((a, b) => b.calls - a.calls)
        .slice(0, 20);
// Per-sub-task cut (#107): which of the caller's tools actually spends. Same ladder collapse as
      // the other cuts, so `deepseek` + `service` land together; per-row cost is priced exactly
      // like a rung row. `apps` is empty for callers that send no x-ladder-app (the bench, one-off
      // curls) — the ladder name stays the coarse view, this is the fine one.
      const appGroups = new Map();
      for (const r of appRows) {
        const app = r.app, ladder = canonName(r.ladder), model = r.model || null;
        const key = `${app}|${ladder}|${model}`;
        let e = appGroups.get(key);
        if (!e) { e = { app, ladder, model, category: categoryOf(model), calls: 0, tokens_in: 0, tokens_cached: 0, tokens_out: 0 }; appGroups.set(key, e); }
        e.calls += num(r.calls); e.tokens_in += num(r.tin); e.tokens_cached += num(r.tcached); e.tokens_out += num(r.tout);
      }
      const appsByName = new Map();
      for (const e of appGroups.values()) {
        e.cost_usd = costUsd(e.model, e.tokens_in, e.tokens_cached, e.tokens_out);
        let a = appsByName.get(e.app);
        if (!a) { a = { app: e.app, calls: 0, tokens_in: 0, tokens_cached: 0, tokens_out: 0, cost_usd: 0, rungs: [] }; appsByName.set(e.app, a); }
        a.calls += e.calls; a.tokens_in += e.tokens_in; a.tokens_cached += e.tokens_cached;
        a.tokens_out += e.tokens_out; a.cost_usd += e.cost_usd || 0; a.rungs.push(e);
      }
      for (const a of appsByName.values()) {
        a.rungs.sort((x, y) => y.calls - x.calls);
        a.cost_usd = a.rungs.reduce((s, r) => s + (r.cost_usd || 0), 0);
      }
      const apps = [...appsByName.values()].sort((a, b) => b.cost_usd - a.cost_usd || b.calls - a.calls);
      // Coverage, not a cut: served calls with no app, same window as `apps`. Without it the
      // application block would read as complete while quietly covering half the traffic (#136).
      const noApp = num(noAppRows[0] && noAppRows[0].calls);
      // Per-model distribution cut: latency p50/p95 + prompt-size p20/p50/p80, with the source
      // split as call shares. `with_usage` matters to the reader, not just to the maths — a
      // model whose percentiles rest on a third of its calls says so rather than implying
      // the numbers cover the whole model.
      const models = modelRows.map((r) => ({
        model: r.model,
        category: categoryOf(r.model),
        calls: num(r.calls),
        with_usage: num(r.with_usage),
        ms_p50: r.ms_p50 === null ? null : num(r.ms_p50),
        ms_p95: r.ms_p95 === null ? null : num(r.ms_p95),
        tin_p20: r.tin_p20 === null ? null : num(r.tin_p20),
        tin_p50: r.tin_p50 === null ? null : num(r.tin_p50),
        tin_p80: r.tin_p80 === null ? null : num(r.tin_p80),
      }));
      // Source shares are computed against ALL ok calls in the window, not the sum of the
      // returned rows: ANALYTICS_SOURCES_SQL is its own aggregate, so a tail source still
      // shows its true share instead of being normalised against the head.
      const sourceCalls = sourceRows.reduce((s, r) => s + num(r.calls), 0);
      const sources = sourceRows.map((r) => ({
        source: r.source,
        calls: num(r.calls),
        pct: sourceCalls ? +(num(r.calls) / sourceCalls * 100).toFixed(1) : 0,
      }));
      return json(200, {
        hours, since_ms: since, generated_ms: Date.now(), totals, ladders: out,
        hourly, apps, no_app: { calls: noApp }, models, sources, errors,
      });
    } catch (e) {
      return oaError(500, `analytics query failed: ${e.message}`, 'server_error');
    }
  }

  // Ops: unpark all Go keys and Go rungs (a wrongly parked key, a limit lifted early).
  if (request.method === 'POST' && url.pathname === '/v1/state/reset-keys') {
    const st = store || makeStore(env);
    await st.resetKeys();
    return json(200, await st.snapshot());
  }

  // POST /v1/free-models/probe — один НАСТОЯЩИЙ вызов произвольной модели, чтобы измерить её
  // окно ДО встройки в лестницу (scripts/embed-big-window-rungs.mjs).
  //
  // Почему не через /v1/chat/completions + ladder_rung: пин принимает только ранг, который уже
  // есть в ЗАДЕПЛОЕННОЙ лестнице — правка локального config серверу не видна, и кандидат, ещё
  // не стоящий ни в одной лестнице, пинуется как `rung not in ladder`. Здесь модель на время
  // вызова получает собственную одноступенчатую лестницу: потолок ранга, размерный гейт, гард
  // и запись health работают как обычно, а публичный список лестниц не меняется (ключ
  // `__probe` живёт только в этом вызове и в /health не попадает — тот читает config.ladders).
  //
  // Тело: { model, bytes?, timeout_ms? }. Ответ всегда 200 (иначе400 на кривой model): у
  // скрипта цикл бинарного поиска, исключение на каждый отказ ему не нужно — важен { ok }.
  if (request.method === 'POST' && url.pathname === '/v1/free-models/probe') {
    let body;
    try { body = await request.json(); } catch { body = {}; }
    const model = String(body.model || '').trim();
    // Разрешён и `:free`-суффикс — он часть model_id инвентаря (`openrouter/x/y:free`).
    if (!/^[a-z0-9][a-z0-9._/:-]*$/i.test(model)) return oaError(400, 'model is required', 'invalid_request_error');
    const bytes = Math.min(Math.max(Number(body.bytes) || 1_000_000, 1024), 2_000_000);
    const timeoutMs = Math.min(Math.max(Number(body.timeout_ms) || 90_000, 5_000), 120_000);
    const unit = 'Parser reads the config, checks the module registry and reports missing entries in order. ';
    const messages = [
      { role: 'system', content: 'Ты — ассистент по разбору кода. Отвечай одним коротким словом.' },
      { role: 'user', content: unit.repeat(Math.max(1, Math.floor(bytes / unit.length))) },
      { role: 'user', content: 'Ответь одним словом: готово' },
    ];
    const probeConfig = { ...config, ladders: { ...config.ladders, __probe: { build: [model] } } };
    const started = Date.now();
    const r = await run(
      // `ladder_rung` в теле НЕ кладём: тело уходит провайдеру как есть (upstreamRequest
      // разворачивает body), а закрепление идёт через pinRung в опциях ниже.
      { model: '__probe:build', messages, max_tokens: 40 },
      {
        env, config: probeConfig, store: store || makeStore(env), fetchImpl,
        timeoutMs, totalTimeoutMs: timeoutMs + 30_000, pinRung: model, appSlug: 'free-models-probe',
      },
    );
    const content = String(r.data?.choices?.[0]?.message?.content ?? '').trim();
    return json(200, {
      model, bytes, ok: !!(r.ok && content), ms: Date.now() - started,
      served: r.model || null,
      // Причина — из ПЕРВОЙ попытки: `every rung failed` ничего не говорит скрипту, а в
      // одноступенчатой probe-лестнице там всегда конкретика (`empty answer (out=0, …)`).
      note: r.ok
        ? (content ? '' : 'пустой ответ')
        : String(r.attempts?.find((a) => a.error)?.error || r.error || '').slice(0, 300),
      attempts: (r.attempts || []).map((a) => ({ model: a.model, outcome: a.outcome, error: a.error || null })),
    });
  }

  if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let body;
    try { body = await request.json(); } catch { return oaError(400, 'bad json', 'invalid_request_error'); }
    if (!body || !Array.isArray(body.messages) || !body.messages.length) return oaError(400, 'messages required', 'invalid_request_error');
    const { ladder_timeout_ms: perRung, ladder_total_timeout_ms: total, ladder_ttfb_ms: ttfb, ladder_rung: pinRung, ladder_conversation: _ladderConversation, ...chat } = body;
    if (!chat.model) chat.model = DEFAULT_LADDER;
    const conversation = await conversationKey(request, body, env);
    // OpenRouter app attribution (#33): which of our tools eats this call, for the OpenRouter
    // "Application" analytics cut. Both values are sanitised here (slug → [a-z0-9-]{1,64},
    // default 'llm-ladder') so the ladder itself only ever sees clean values.
    const appRaw = request.headers.get('x-ladder-app');
    const appSlug = sanitizeAppSlug(appRaw);
    const appTitle = sanitizeAppTitle(request.headers.get('x-ladder-app-title'));
    const started = Date.now();
    const r = await run(chat, {
      env, config, store: store || makeStore(env), fetchImpl,
      timeoutMs: Math.min(Number(perRung) || 20000, 60000),
      totalTimeoutMs: Number(total) ? Math.min(Number(total), 120000) : null,
      ...(Number(ttfb) ? { ttfbMs: Math.min(Number(ttfb), 60000) } : {}),
      ...(pinRung ? { pinRung: String(pinRung) } : {}),
      conversation, appSlug, appTitle, inputBytes: new TextEncoder().encode(JSON.stringify(body)).length,
    });
    const pinTag = conversation ? ` pin=${r.pin || 'none'}` : '';
    const attemptsHeader = r.attempts.map(a => `${a.model}=${a.outcome}`).join(', ').slice(0, 900);
    const attemptsHeaderWithPin = conversation ? attemptsHeader + `, pin=${r.pin || 'none'}` : attemptsHeader;
    const trace = makeTrace(request);
    // The D1 row carries the SAME slug as the OpenRouter "Application" cut (#107) — the sanitised
    // value, not the raw header, so the two views of one call can never disagree.
    //
    // …but only when there WAS a slug to sanitise (#136). appSlug's 'llm-ladder' default is the
    // right name upstream and the wrong name here: no caller ever sends that slug (it comes from
    // our own constant), so writing it into `app` let the router's own unattributed traffic —
    // calls with no x-ladder-app at all — file itself as the biggest "application" in the cut.
    // Null keeps "unknown caller" unknown; /v1/analytics reports those rows as `no_app` so the
    // coverage is visible instead of silently missing.
    trace.app = sanitizeAppSlugOrNull(appRaw);
    // usage: non-stream answers only (stream usage arrives after the relay → D1 trace has the same gap, #22).
console.log(JSON.stringify({ ladder: chat.model, ok: r.ok, model: r.model || null, app: appSlug, ms: Date.now() - started, usage: (r.data && r.data.usage) || null, conversation: conversation ? conversation.slice(0, 8) : null, pin: r.pin || null, attempts: r.attempts, trace }));
     await logCall(env, trace, chat.model, r, started, { events });
    const compressionHeaders = r.compression ? { 'x-ladder-compression': `unit=bytes;in=${r.compression.originalSize};out=${r.compression.outputSize};target=${r.compression.targetMet};trigger=${r.compression.trigger};steps=${r.compression.steps || 0}` } : {};
    if (!r.ok) return oaError(r.status, r.error, 'ladder_error', { attempts: r.attempts }, { 'x-ladder-attempts': attemptsHeaderWithPin, ...compressionHeaders });
    if (r.stream) {
      return new Response(r.stream, { status: 200, headers: {
        'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache',
        'x-ladder-model': r.model, 'x-ladder-attempts': attemptsHeaderWithPin,
        ...compressionHeaders,
      } });
    }
    const out = { ...r.data, model: r.model };
    return json(200, out, { 'x-ladder-model': r.model, 'x-ladder-attempts': attemptsHeaderWithPin, ...compressionHeaders });
  }

  return oaError(404, 'not found', 'invalid_request_error');
}
