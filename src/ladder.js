// One chat completion walked down a named model ladder: OpenCode Go rungs first, paid OpenRouter
// last. Non-streaming, for small service calls (buttons, formatting, classifiers, summaries)
// where reliability beats everything else.
//
//   * model health — a flaky / limited rung is skipped for everyone (shared state in `store`);
//   * Go key pool — a key-level fault rotates to the spare key and the rung is retried; a rung
//     that fails for a NON-key reason also gets ONE spare-key probe per call before the ladder
//     leaves Go for paid OpenRouter (a silently throttled key looks like a slow model); once
//     every key is parked, all Go rungs are skipped until the earliest key heals;
//   * guard — empty content, or non-JSON when JSON was requested, fails the rung.
//
// Pure apart from `fetchImpl` and `store`, so it runs the same in the Worker (store = Durable
// Object) and in node:test (store = in-memory).

import { classifyError } from './classify.js';

// Go models reason before answering and max_tokens covers the reasoning too — a tight budget
// (e.g. 5 tokens for YES/NO) would otherwise come back empty.
export const MIN_TOKENS = 1500;
export const DEFAULT_LADDER = 'deepseek';
const DEFAULT_ROLE = 'build';
// Only KEY-level signals rotate a Go key; a 503 / Bad Request is about one model.
const KEY_QUOTA_RE = /usage limit|quota[^.]{0,20}exceeded|rate[_\s-]{0,5}limit|too many requests|\b429\b|more credits?/i;
const DEAD_KEY_RE = /invalid credential|invalid api key|\b401\b|unauthorized/i;
export const KEY_QUOTA_TTL_MS = 15 * 60 * 1000;
export const KEY_DEAD_TTL_MS = 60 * 60 * 1000;
// A WEEKLY Go allowance (the 429 body carries `"limitName":"weekly"`, seen live 2026-09-29) does
// not heal in 15 minutes: parking it for the rate-limit TTL means the next rotation immediately
// bounces back onto a key that is still limited for days. Park it for hours instead.
export const KEY_WEEKLY_TTL_MS = 6 * 60 * 60 * 1000;
const WEEKLY_LIMIT_RE = /limitName["'\s:]{0,6}weekly/i;

export function readPool(env) {
  return String(env.OPENCODE_GO_API_KEYS || env.OPENCODE_GO_API_KEY || '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
}

// "deepseek", "deepseek:review" or an alias ("free-ladder") → rungs, null for an unknown ladder.
export function rungsFor(config, name) {
  let [ladderName, role] = String(name || DEFAULT_LADDER).split(':');
  if (config.aliases && config.aliases[ladderName]) ladderName = config.aliases[ladderName];
  const l = config.ladders && config.ladders[ladderName];
  if (!l) return null;
  return l[role || DEFAULT_ROLE] || l[DEFAULT_ROLE] || null;
}

function stripFences(s) {
  return String(s || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

// Fenced or prose-wrapped JSON is common from small models. undefined = not JSON.
export function parseJson(content) {
  const raw = stripFences(content);
  try { return JSON.parse(raw); } catch { /* fall through */ }
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* not JSON */ } }
  return undefined;
}

export function keyFaultOf(errorText) {
  const t = String(errorText || '');
  if (DEAD_KEY_RE.test(t)) return { dead: true, ttlMs: KEY_DEAD_TTL_MS };
  if (KEY_QUOTA_RE.test(t)) return { dead: false, ttlMs: WEEKLY_LIMIT_RE.test(t) ? KEY_WEEKLY_TTL_MS : KEY_QUOTA_TTL_MS };
  return null;
}

function failureClass(errorText) {
  const v = classifyError(errorText);
  if (v && v.class === 'quota') return { cls: 'quota', retryAfterMs: v.ttlMs };
  if (v && v.class === 'config') return { cls: 'config' };
  return { cls: 'transient' };
}

// Streaming: a rung is chosen BEFORE the first token — if it doesn't produce one within this
// window (or errors), the next rung is tried; after the first token there is no failover.
export const TTFB_TIMEOUT_MS = 15000;
const RF_400_RE = /structured[-_ ]outputs?|response[_ ]?format|json_object|stream_options/i;

function upstreamRequest(env, model, body, keyIndex, { stream = false, stripRf = false } = {}) {
  const isGo = model.startsWith('opencode-go/');
  const pool = readPool(env);
  const key = isGo ? pool[keyIndex] : env.OPENROUTER_API_KEY;
  if (!key) return null;
  const headers = { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
  if (isGo) headers['x-opencode-session'] = `ladder-${crypto.randomUUID()}`; // Go 400s without it
  const upstream = {
    ...body,
    model: model.replace(/^opencode-go\/|^openrouter\//, ''),
    stream,
    max_tokens: Math.max(Number(body.max_tokens) || 0, MIN_TOKENS),
  };
  delete upstream.stream_options;
  if (stream && !isGo) upstream.stream_options = { include_usage: true };
  if (stripRf) { delete upstream.response_format; delete upstream.stream_options; }
  const base = isGo ? (env.OPENCODE_GO_BASE_URL || 'https://opencode.ai/zen/go/v1') : (env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1');
  return { url: `${base}/chat/completions`, headers, body: upstream };
}

async function post(fetchImpl, req, signal) {
  try {
    return { res: await fetchImpl(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal }) };
  } catch (e) {
    return { error: `fetch failed: ${e.message}` };
  }
}

// Non-streaming attempt. A tool-call answer with no text is a valid answer.
async function attemptJson(env, model, body, keyIndex, { timeoutMs, wantJson, fetchImpl }) {
  let stripRf = false;
  for (;;) {
    const req = upstreamRequest(env, model, body, keyIndex, { stripRf });
    if (!req) return { ok: false, skip: true, error: 'no key' };
    const { res, error } = await post(fetchImpl, req, AbortSignal.timeout(timeoutMs));
    if (error) return { ok: false, error };
    if (!res.ok) {
      const errText = String(await res.text().catch(() => ''));
      // Provider rejects response_format → retry the SAME rung once without it (prompt-only JSON).
      if (res.status === 400 && !stripRf && body.response_format && RF_400_RE.test(errText)) { stripRf = true; continue; }
      return { ok: false, error: `HTTP ${res.status}: ${errText.slice(0, 300)}` };
    }
    const data = await res.json().catch(() => null);
    const message = data?.choices?.[0]?.message || {};
    const content = String(message.content || '').trim();
    const hasTools = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
    if (!content && !hasTools) return { ok: false, error: 'empty answer' };
    if (wantJson && !hasTools && parseJson(content) === undefined) return { ok: false, error: 'invalid JSON' };
    return { ok: true, data, content };
  }
}

// True for an SSE event that carries real output (text, reasoning or a tool call) — not a bare
// role/keep-alive frame that a stalled provider can emit before failing.
function isOutputEvent(line) {
  if (!line.startsWith('data:')) return false;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return false;
  try {
    const d = JSON.parse(payload);
    if (d.error) return false;
    const delta = d.choices?.[0]?.delta || {};
    return !!(delta.content || delta.reasoning || delta.reasoning_content || (delta.tool_calls && delta.tool_calls.length));
  } catch { return false; }
}

// Streaming attempt: resolves once the first output event arrived (→ committed stream that
// replays the buffered bytes and pipes the rest), or fails before it (→ caller tries next rung).
async function attemptStream(env, model, body, keyIndex, { ttfbMs, fetchImpl }) {
  const req = upstreamRequest(env, model, body, keyIndex, { stream: true, stripRf: !!body._stripRf });
  if (!req) return { ok: false, skip: true, error: 'no key' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('no first token in time')), ttfbMs);
  const { res, error } = await post(fetchImpl, req, ctrl.signal);
  if (error) { clearTimeout(timer); return { ok: false, error }; }
  if (!res.ok) {
    clearTimeout(timer);
    const errText = String(await res.text().catch(() => ''));
    if (res.status === 400 && !body._stripRf && body.response_format && RF_400_RE.test(errText)) {
      return attemptStream(env, model, { ...body, _stripRf: true }, keyIndex, { ttfbMs, fetchImpl });
    }
    return { ok: false, error: `HTTP ${res.status}: ${errText.slice(0, 300)}` };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const buffered = [];
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { clearTimeout(timer); return { ok: false, error: 'stream ended before first token' }; }
      buffered.push(value);
      text += dec.decode(value, { stream: true });
      const lines = text.split('\n');
      text = lines.pop();
      const errLine = lines.find(l => l.startsWith('data:') && /"error"/.test(l));
      if (errLine && !lines.some(isOutputEvent)) { clearTimeout(timer); reader.cancel().catch(() => {}); return { ok: false, error: `stream error: ${errLine.slice(5, 300)}` }; }
      if (lines.some(isOutputEvent)) break;
    }
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: `stream failed before first token: ${e.message}` };
  }
  clearTimeout(timer);
  const stream = new ReadableStream({
    start(controller) { for (const chunk of buffered) controller.enqueue(chunk); },
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) controller.close(); else controller.enqueue(value);
      } catch (e) { controller.error(e); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return { ok: true, stream };
}

function attempt(env, model, body, keyIndex, opts) {
  return body.stream ? attemptStream(env, model, body, keyIndex, opts) : attemptJson(env, model, body, keyIndex, opts);
}

/**
 * @param {object} body   OpenAI chat.completions body; `model` = ladder name ("deepseek",
 *                        "deepseek:review", alias "free-ladder"). stream:true → SSE (rung chosen
 *                        before the first token); tools / tool_choice passed through as is.
 * @param {object} ctx    { env, config, store, fetchImpl, timeoutMs=20000, totalTimeoutMs, now }
 *   store (async): snapshot() → { health: {model: {skipUntil}}, keys: {active, exhausted: {i: until}} }
 *                  recordFailure(model, {cls, retryAfterMs}), recordSuccess(model),
 *                  rotateKey(poolSize, ttlMs) → {rotated, toIndex} | {rotated:false, retryAt},
 *                  park(models, untilMs)
 * @returns {Promise<{ok:true, model, data?, content?, stream?, attempts} | {ok:false, status, error, attempts}>}
 */
export async function run(body, { env, config, store, fetchImpl = fetch, timeoutMs = 20000, totalTimeoutMs = null, ttfbMs = TTFB_TIMEOUT_MS, pinRung = null } = {}) {
  let all = rungsFor(config, body && body.model);
  if (!all) return { ok: false, status: 404, error: `unknown ladder: ${body && body.model}`, attempts: [] };
  // Benchmarks: pin ONE rung of the ladder (health skips ignored, no failover) to measure it
  // through the worker without handing provider keys to the bench.
  if (pinRung) {
    if (!all.includes(pinRung)) return { ok: false, status: 400, error: `rung not in ladder: ${pinRung}`, attempts: [] };
    all = [pinRung];
  }
  const pool = readPool(env);
  const hasKey = m => (m.startsWith('opencode-go/') ? pool.length > 0 : !!env.OPENROUTER_API_KEY);
  const keyed = all.filter(hasKey);
  if (!keyed.length) return { ok: false, status: 503, error: 'no provider key configured', attempts: [] };

  const snap = await store.snapshot();
  const now = Date.now();
  // A TRANSIENT wobble on a Go rung (timeout / empty answer / 500 — the failure class behind the
  // 29.09 incident) must not keep the whole fleet on the paid tail for the full exponential
  // backoff (up to 5 min): cap it, so the Go tier is re-tested at least every 30s. Real limits
  // (quota parks from key exhaustion, 503, config) keep their own TTL — hammering them helps no
  // one.
  const GO_TRANSIENT_SKIP_CAP_MS = 30 * 1000;
  const skipped = m => {
    const h = snap.health[m];
    if (!h) return false;
    if (h.skipUntil === null) return true;
    let until = h.skipUntil;
    if (m.startsWith('opencode-go/') && h.class === 'transient' && h.lastFailureAt) {
      until = Math.min(until, h.lastFailureAt + GO_TRANSIENT_SKIP_CAP_MS);
    }
    return until > now;
  };
  // If health skips every keyed rung, try them all anyway — a stale skip must not black-hole it.
  const live = pinRung ? keyed : keyed.filter(m => !skipped(m));
  const rungs = live.length ? live : keyed;
  let keyIndex = Math.min(snap.keys.active || 0, Math.max(0, pool.length - 1));
  const exhaustedAtStart = new Set(Object.keys(snap.keys.exhausted || {}).map(Number));
  // One spare-key probe per call (owner 2026-09-29: «ключ залимитился → переключаем на другой,
  // всё»). A Go rung that fails for a NON-key reason (timeout, empty answer, 500) still gets one
  // attempt on the other provisioned key before the ladder leaves Go for paid OpenRouter — a
  // silently throttled key looks exactly like a slow model, and staying on Go costs nothing.
  // Bounded to ONE probe per call so a Go outage cannot double the failover latency.
  // pinRung (benchmarks) measures exactly ONE attempt on ONE rung — no probe there either.
  let probeBudget = pinRung ? 0 : 1;
  let goParked = false;

  const wantJson = body.response_format && body.response_format.type === 'json_object';
  const deadline = totalTimeoutMs ? now + totalTimeoutMs : Infinity;
  const attempts = [];
  for (const model of rungs) {
    const isGo = model.startsWith('opencode-go/');
    if (isGo && goParked) continue;
    const left = deadline - Date.now();
    if (left < 500) { attempts.push({ model, outcome: 'skipped', error: 'time budget spent' }); break; }
    const opts = { timeoutMs: Math.min(timeoutMs, left), ttfbMs: Math.min(ttfbMs, left), wantJson, fetchImpl };
    let key = keyIndex;
    const tried = new Set([key]);
    let r = await attempt(env, model, body, key, opts);
    if (r.skip) continue;
    while (!r.ok && isGo && !goParked) {
      const fault = keyFaultOf(r.error);
      if (fault) {
        const rot = await store.rotateKey(pool.length, fault.ttlMs);
        if (!rot.rotated) {
          await store.park(all.filter(m => m.startsWith('opencode-go/')), rot.retryAt);
          goParked = true;
          break;
        }
        attempts.push({ model, outcome: 'key-rotated', key, error: r.error });
        key = rot.toIndex;
        keyIndex = key; // rotation is shared state: the rest of this call rides the spare key too
        tried.add(key);
        r = await attempt(env, model, body, key, opts);
        continue;
      }
      // Not a key-level signal. Never probe for problems the spare key cannot change: a context
      // overflow or a config-class rejection is a property of the request / the model, not the key.
      const cls = classifyError(r.error)?.class || 'transient';
      const spare = pool.findIndex((_, i) => !tried.has(i) && !exhaustedAtStart.has(i));
      if (cls === 'context' || cls === 'config' || spare < 0 || probeBudget <= 0) break;
      probeBudget--;
      attempts.push({ model, outcome: 'key-probe', key, error: r.error });
      key = spare;
      tried.add(key);
      r = await attempt(env, model, body, key, opts);
      if (r.ok) keyIndex = key; // the spare answered — keep it for the rest of this call
    }
    if (r.ok) {
      await store.recordSuccess(model);
      attempts.push({ model, outcome: 'ok', key });
      return { ok: true, model, data: r.data, content: r.content, stream: r.stream, attempts };
    }
    attempts.push({ model, outcome: 'error', key, error: r.error });
    if (!goParked) await store.recordFailure(model, failureClass(r.error));
  }
  return { ok: false, status: 502, error: 'every rung failed', attempts };
}
