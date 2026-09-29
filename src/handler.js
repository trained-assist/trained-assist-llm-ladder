// HTTP route of the ladder worker — dependency-free of the Workerd runtime so it runs in plain
// `node --test` (the sandbox imports it), while src/index.js remains the Worker entry: it wraps this
// handler and exports the LadderState Durable Object for the platform binding.

import { run, readPool, DEFAULT_LADDER } from './ladder.js';
import { makeTrace, logCall } from './trace.js';
import config from '../config/ladders.json' with { type: 'json' };

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
    rotateKey: (size, ttlMs) => stub.rotateKey(size, ttlMs),
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

  if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let body;
    try { body = await request.json(); } catch { return oaError(400, 'bad json', 'invalid_request_error'); }
    if (!body || !Array.isArray(body.messages) || !body.messages.length) return oaError(400, 'messages required', 'invalid_request_error');
    const { ladder_timeout_ms: perRung, ladder_total_timeout_ms: total, ladder_ttfb_ms: ttfb, ladder_rung: pinRung, ladder_conversation: _ladderConversation, ...chat } = body;
    if (!chat.model) chat.model = DEFAULT_LADDER;
    const conversation = await conversationKey(request, body, env);
    const started = Date.now();
    const r = await run(chat, {
      env, config, store: store || makeStore(env), fetchImpl,
      timeoutMs: Math.min(Number(perRung) || 20000, 60000),
      totalTimeoutMs: Number(total) ? Math.min(Number(total), 120000) : null,
      ...(Number(ttfb) ? { ttfbMs: Math.min(Number(ttfb), 60000) } : {}),
      ...(pinRung ? { pinRung: String(pinRung) } : {}),
      conversation,
    });
    const pinTag = conversation ? ` pin=${r.pin || 'none'}` : '';
    const attemptsHeader = r.attempts.map(a => `${a.model}=${a.outcome}`).join(', ').slice(0, 900);
    const attemptsHeaderWithPin = conversation ? attemptsHeader + `, pin=${r.pin || 'none'}` : attemptsHeader;
    const trace = makeTrace(request);
    console.log(JSON.stringify({ ladder: chat.model, ok: r.ok, model: r.model || null, ms: Date.now() - started, conversation: conversation ? conversation.slice(0, 8) : null, pin: r.pin || null, attempts: r.attempts, trace }));
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