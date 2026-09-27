// trained-assist-llm-ladder — OpenAI-compatible chat completions over a model ladder
// (OpenCode Go → paid OpenRouter last) for small service LLM calls across trained-assist repos.
//
//   GET  /health                 liveness + ladder names (no auth)
//   GET  /v1/models              ladders as model ids (auth)
//   GET  /v1/state               model health + key rotation snapshot (auth)
//   POST /v1/chat/completions    body.model = ladder ("deepseek", "deepseek:review") (auth)
//
// Auth: `Authorization: Bearer <LADDER_TOKEN>`. Non-streaming → a normal chat.completion whose
// `model` is the rung that answered (also in `x-ladder-model`). stream:true → SSE relayed from
// the chosen rung (chosen before the first token; no failover after it) — how opencode uses the
// `free-ladder` model. Tools pass through as is. Optional body fields: ladder_timeout_ms (per
// rung, non-stream), ladder_ttfb_ms (stream: first-token window), ladder_total_timeout_ms,
// ladder_rung (benchmarks: pin one rung of the ladder, no failover).

import { run, readPool, DEFAULT_LADDER } from './ladder.js';
import config from '../config/ladders.json';

export { LadderState } from './state-do.js';

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function oaError(status, message, type, extra = {}) {
  return json(status, { error: { message, type, ...extra } });
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

export function makeStore(env) {
  const stub = env.LADDER_STATE.get(env.LADDER_STATE.idFromName('global'));
  const poolSize = readPool(env).length;
  return {
    snapshot: () => stub.snapshot(poolSize),
    recordFailure: (model, f) => stub.recordFailure(model, f),
    recordSuccess: (model) => stub.recordSuccess(model),
    rotateKey: (size, ttlMs) => stub.rotateKey(size, ttlMs),
    park: (models, untilMs) => stub.park(models, untilMs),
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
    return json(200, await (store || makeStore(env)).snapshot());
  }

  if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let body;
    try { body = await request.json(); } catch { return oaError(400, 'bad json', 'invalid_request_error'); }
    if (!body || !Array.isArray(body.messages) || !body.messages.length) return oaError(400, 'messages required', 'invalid_request_error');
    const { ladder_timeout_ms: perRung, ladder_total_timeout_ms: total, ladder_ttfb_ms: ttfb, ladder_rung: pinRung, ...chat } = body;
    if (!chat.model) chat.model = DEFAULT_LADDER;
    const started = Date.now();
    const r = await run(chat, {
      env, config, store: store || makeStore(env), fetchImpl,
      timeoutMs: Math.min(Number(perRung) || 20000, 60000),
      totalTimeoutMs: Number(total) ? Math.min(Number(total), 120000) : null,
      ...(Number(ttfb) ? { ttfbMs: Math.min(Number(ttfb), 60000) } : {}),
      ...(pinRung ? { pinRung: String(pinRung) } : {}),
    });
    const attemptsHeader = r.attempts.map(a => `${a.model}=${a.outcome}`).join(', ').slice(0, 900);
    console.log(JSON.stringify({ ladder: chat.model, ok: r.ok, model: r.model || null, ms: Date.now() - started, attempts: r.attempts }));
    if (!r.ok) return oaError(r.status, r.error, 'ladder_error', { attempts: r.attempts });
    if (r.stream) {
      return new Response(r.stream, { status: 200, headers: {
        'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache',
        'x-ladder-model': r.model, 'x-ladder-attempts': attemptsHeader,
      } });
    }
    const out = { ...r.data, model: r.model };
    return json(200, out, { 'x-ladder-model': r.model, 'x-ladder-attempts': attemptsHeader });
  }

  return oaError(404, 'not found', 'invalid_request_error');
}

export default {
  fetch(request, env) {
    return handle(request, env);
  },
};
