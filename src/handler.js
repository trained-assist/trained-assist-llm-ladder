// HTTP route of the ladder worker — dependency-free of the Workerd runtime so it runs in plain
// `node --test` (the sandbox imports it), while src/index.js remains the Worker entry: it wraps this
// handler and exports the LadderState Durable Object for the platform binding.

import { run, readPool, DEFAULT_LADDER, sanitizeAppSlug, sanitizeAppTitle } from './ladder.js';
import { makeTrace, logCall } from './trace.js';
import config from '../config/ladders.json' with { type: 'json' };

// GET /v1/analytics: both bind ?1 = since (ms). Aggregates per requested ladder name;
// the depth histogram is attempts-per-call from the attempts JSON (json_valid guards
// legacy rows). Keep the bind: an interpolated timestamp is an injection (query-trace
// guard tests the same rule for the python read path).
const ANALYTICS_AGG_SQL =
  'SELECT ladder, COUNT(*) AS calls, SUM(1 - ok) AS failed, '
  + 'SUM(COALESCE(tokens_in, 0)) AS tin, SUM(COALESCE(tokens_out, 0)) AS tout, '
  + 'SUM(CASE WHEN tokens_in IS NULL THEN 1 ELSE 0 END) AS no_usage '
  + 'FROM ladder_calls WHERE ts >= ?1 GROUP BY ladder';
const ANALYTICS_DEPTH_SQL =
  'SELECT ladder, json_array_length(attempts) AS depth, COUNT(*) AS calls '
  + 'FROM ladder_calls WHERE ts >= ?1 AND attempts IS NOT NULL AND json_valid(attempts) '
  + 'GROUP BY ladder, depth';

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

function authorized(request, env) {
  if (!env.LADDER_TOKEN) return false;
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
  return !!m && timingSafeEqual(m[1].trim(), env.LADDER_TOKEN);
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

export async function handle(request, env, { store, fetchImpl = fetch } = {}) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') {
    return json(200, { ok: true, ladders: Object.keys(config.ladders), build: env.BUILD_SHA || null });
  }
  if (!authorized(request, env)) return oaError(401, 'unauthorized', 'auth_error');

  if (request.method === 'GET' && url.pathname === '/v1/models') {
    const data = [];
    for (const [name, roles] of Object.entries(config.ladders)) {
      data.push({ id: name, object: 'model', owned_by: 'trained-assist-llm-ladder', rungs: roles.build || [] });
      for (const role of Object.keys(roles)) if (role !== 'build') data.push({ id: `${name}:${role}`, object: 'model', owned_by: 'trained-assist-llm-ladder', rungs: roles[role] });
    }
    return json(200, { object: 'list', data });
  }

  if (request.method === 'GET' && url.pathname === '/v1/state') {
    const s = await (store || makeStore(env)).snapshot();
    s.pins = await (store || makeStore(env)).pinStats();
    return json(200, s);
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
      const depthRows = (await db.prepare(ANALYTICS_DEPTH_SQL).bind(since).all()).results || [];
      const num = (v) => Number(v) || 0;
      const ladders = new Map();
      const entry = (raw) => {
        // Group the requested names by ladder: 'deepseek'→'service', 'free-ladder'→'free'
        // (config.aliases: deepseek → service, #49), so the digest shows one line per ladder, not per alias.
        // The default role is not a distinction: rungFor('deepseek:build') === rungFor('deepseek'),
        // so 'X:build' collapses to 'X' — otherwise every default-role caller splits the
        // ladder's numbers across two rows. Non-default roles (:review, :explore — different
        // rung lists) stay separate.
        const [base, role] = String(raw || '').split(':');
        const canon = config.aliases[base] || base;
        const ladder = !role || role === 'build' ? canon : `${canon}:${role}`;
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
      const totals = { calls: 0, failed: 0, tokens_in: 0, tokens_out: 0, no_usage: 0 };
      const out = [...ladders.values()].sort((a, b) => b.calls - a.calls);
      for (const e of out) {
        e.depth.sort((a, b) => a.depth - b.depth);
        for (const k of Object.keys(totals)) totals[k] += e[k];
      }
      return json(200, { hours, since_ms: since, generated_ms: Date.now(), totals, ladders: out });
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
    const appSlug = sanitizeAppSlug(request.headers.get('x-ladder-app'));
    const appTitle = sanitizeAppTitle(request.headers.get('x-ladder-app-title'));
    const started = Date.now();
    const r = await run(chat, {
      env, config, store: store || makeStore(env), fetchImpl,
      timeoutMs: Math.min(Number(perRung) || 20000, 60000),
      totalTimeoutMs: Number(total) ? Math.min(Number(total), 120000) : null,
      ...(Number(ttfb) ? { ttfbMs: Math.min(Number(ttfb), 60000) } : {}),
      ...(pinRung ? { pinRung: String(pinRung) } : {}),
      conversation, appSlug, appTitle,
    });
    const pinTag = conversation ? ` pin=${r.pin || 'none'}` : '';
    const attemptsHeader = r.attempts.map(a => `${a.model}=${a.outcome}`).join(', ').slice(0, 900);
    const attemptsHeaderWithPin = conversation ? attemptsHeader + `, pin=${r.pin || 'none'}` : attemptsHeader;
    const trace = makeTrace(request);
    // usage: non-stream answers only (stream usage arrives after the relay → D1 trace has the same gap, #22).
    console.log(JSON.stringify({ ladder: chat.model, ok: r.ok, model: r.model || null, app: appSlug, ms: Date.now() - started, usage: (r.data && r.data.usage) || null, conversation: conversation ? conversation.slice(0, 8) : null, pin: r.pin || null, attempts: r.attempts, trace }));
    await logCall(env, trace, chat.model, r, started);
    if (!r.ok) return oaError(r.status, r.error, 'ladder_error', { attempts: r.attempts }, { 'x-ladder-attempts': attemptsHeaderWithPin });
    if (r.stream) {
      return new Response(r.stream, { status: 200, headers: {
        'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache',
        'x-ladder-model': r.model, 'x-ladder-attempts': attemptsHeaderWithPin,
      } });
    }
    const out = { ...r.data, model: r.model };
    return json(200, out, { 'x-ladder-model': r.model, 'x-ladder-attempts': attemptsHeaderWithPin });
  }

  return oaError(404, 'not found', 'invalid_request_error');
}