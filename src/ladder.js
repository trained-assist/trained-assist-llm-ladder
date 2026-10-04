// Round-robin counter for Go free-tier rungs: even though they are Unlimited
// they share the same key pool, so cycling distributes load across accounts
// and prevents one key from being hammered while others sit idle.
let freeGoKeyCursor = 0;

export function resetFreeGoKeyCursor() { freeGoKeyCursor = 0; }

export function nextFreeGoKeyIndex(poolSize) {
  if (poolSize <= 0) return 0;
  const i = freeGoKeyCursor % poolSize; // return current, then advance — so the first call uses key 0
  freeGoKeyCursor = (freeGoKeyCursor + 1) % poolSize;
  return i;
}
// last. Non-streaming, for small service calls (buttons, formatting, classifiers, summaries)
// where reliability beats everything else.
//
//   * model health — a flaky / limited rung is skipped for everyone (shared state in `store`);
//   * Go key pool — a key-level fault rotates to the spare key and the rung is retried; a rung
//     that fails for a NON-key reason also gets ONE spare-key probe per call before the ladder
//     leaves Go for paid OpenRouter (a silently throttled key looks like a slow model); once
//     every key is parked, the PAID Go rungs are skipped until the earliest key heals — free
//     Go rungs (`*-free`) keep serving, they do not eat the allowance (#69, #36);
//   * guard — empty content, or non-JSON when JSON was requested, fails the rung.
//
// Pure apart from `fetchImpl` and `store`, so it runs the same in the Worker (store = Durable
// Object) and in node:test (store = in-memory).

import { classifyError } from './classify.js';
import { poolInvoke } from './zen-pool.js';

// Go models reason before answering and max_tokens covers the reasoning too — a tight budget
// (e.g. 5 tokens for YES/NO) would otherwise come back empty.
export const MIN_TOKENS = 1500;
// #38 (owner decision, variant 2): 1500 is not enough for rungs whose chain-of-thought eats the
// whole floor — prod showed `empty answer (finish=length, out=1500, reasoning=1500, prompt=97,
// max_tokens=1500)`, i.e. the reasoning consumed every token, content came back empty, the guard
// failed the rung (chronic 1–25 empty answers/hour). Reasoning rungs get a higher floor instead
// of raising it for everyone.
//
// REASONING_MODELS is empirical, not guessed from names (issue #38): every unique rung of
// config/ladders.json was pinned through the live worker (ladder_rung) and read
// `usage.completion_tokens_details.reasoning_tokens` — nonzero → reasoning. Two Go rungs report
// no details (deepseek-v4-flash) or 0 (glm-5.3-flash) while returning a long
// `message.reasoning_content` (855ch / 517ch against 2ch of content) — reasoning that the usage
// counter does not count, so they are in. Excluded: openrouter/google/gemini-2.5-flash-lite
// (reasoning_tokens=0 twice, works in visible content). ling-3.0-flash-fin:free had no data
// either and is gone from the ladder (dead 404, removed 2026-09-30). See the PR for the full per-rung table.
//
// Added after #39 reordered deepseek: opencode-go/space-bunny-free measured reasoning_tokens=32
// (+ reasoning_content 100ch) through the live worker. The four opencode-zen/* rungs (now the tail
// of the free ladder, #43) were measured 30.09 through the live worker once the relay was up —
// mimo-v2.6-flash-free 17, mimo-v2.5-free 15, nemotron-3.5-lightning-free 255, big-pickle 43 —
// and are added (#42).
export const REASONING_MIN_TOKENS = 3000;
export const REASONING_MODELS = [
  'opencode-go/space-bunny-free',
  'opencode-go/mimo-v2.6-flash',
  'opencode-go/deepseek-v4.1-flash',
  'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
  'openrouter/inclusionai/ling-3.0-flash-sante:free',
  'openrouter/inclusionai/ling-3.0-flash',
  'openrouter/xiaomi/mimo-v2.6-flash',
  'opencode-go/deepseek-v4-flash',
  'opencode-go/longcat-2.5-preview-free',
  'opencode-go/qwen3.8-flash',
  'opencode-go/deepseek-flash',
  'opencode-go/glm-5.3-flash',
  'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
  'openrouter/cohere/north-mini-code:free',
  'openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'openrouter/poolside/laguna-xs-2.1:free',
  'openrouter/dots-studio/dots-3-note-preview:free',
  'opencode-go/qwen3.7-plus',
  'opencode-go/deepseek-v4-pro',
  'opencode-zen/mimo-v2.6-flash-free',
  'opencode-zen/mimo-v2.5-free',
  'opencode-zen/nemotron-3.5-lightning-free',
  'opencode-zen/big-pickle',
];
const REASONING = new Set(REASONING_MODELS);

// The floor for this rung — what upstreamRequest clamps to and what the #34 guard diagnostic
// prints, so the diag always shows the max_tokens that actually went out.
export function minTokensFor(model) {
  return REASONING.has(model) ? REASONING_MIN_TOKENS : MIN_TOKENS;
}

export const DEFAULT_LADDER = 'service'; // legacy alias 'deepseek' resolves here (issue #49)
const DEFAULT_ROLE = 'build';
// OpenRouter app attribution (#33): HTTP-Referer URL *is* the application identity in the
// OpenRouter dashboard ("Application" cut), Title is its display name, hidden keeps our internal
// tools out of public rankings while keeping the analytics.
export const DEFAULT_APP_SLUG = 'llm-ladder';
export const DEFAULT_APP_TITLE = 'Trained Assist';
export const APP_REFERER_BASE = 'https://recruiter-assistant.ru/app';
const SLUG_RE = /^[a-z0-9-]{1,64}$/;

// Caller-supplied slug → a clean URL segment, or the generic default. Anything that is not a
// slug already (Cyrillic, spaces, path traversal, overlong) falls back to llm-ladder instead of
// being repaired — a half-sanitised slug would silently become a DIFFERENT application upstream.
export function sanitizeAppSlug(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  return SLUG_RE.test(s) ? s : DEFAULT_APP_SLUG;
}

// Display name for X-OpenRouter-Title: strip control characters (header safety), cap the length,
// blank → the default title.
export function sanitizeAppTitle(raw) {
  const s = String(raw ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 64);
  return s || DEFAULT_APP_TITLE;
}
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

// Remaining Go allowance per pool key: GET /zen/go/v1/usage returns ONE unified percent per
// window — rolling (~5h) / weekly / monthly — not a per-model breakdown (owner observation
// 2026-10-03, issue #91). The raw key never leaves this function: callers see only the pool index.
export async function fetchGoUsage(env, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const pool = readPool(env);
  const base = env.OPENCODE_GO_BASE_URL || 'https://opencode.ai/zen/go/v1';
  const one = async (key, keyIndex) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}/usage`, { headers: { Authorization: `Bearer ${key}` }, signal: ctrl.signal });
      if (!res.ok) return { keyIndex, error: `HTTP ${res.status}` };
      const u = (await res.json()).usage || {};
      const win = (w) => (w ? { status: w.status ?? null, percent: w.percent ?? null, resetsAt: w.resetsAt ?? null } : null);
      return { keyIndex, rolling: win(u.rolling), weekly: win(u.weekly), monthly: win(u.monthly) };
    } catch (e) {
      return { keyIndex, error: e && e.name === 'AbortError' ? 'timeout' : String((e && e.message) || e) };
    } finally {
      clearTimeout(timer);
    }
  };
  return Promise.all(pool.map(one));
}

// "service" (legacy alias "deepseek"), "service:review" or an alias ("free-ladder") → rungs, null if unknown.
export function rungsFor(config, name) {
  const [ladderName, role] = String(name || DEFAULT_LADDER).split(':');
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

// #34 diagnostics ride INSIDE the error string (attempts → console.log / D1). Classification
// must not see them: a token count of 401/429/503 would otherwise rotate/park a healthy Go key
// or class the rung as quota — instrumentation must not move the ladder.
const GUARD_DIAG_RE = /\s*\((?:finish|out|reasoning|prompt|max_tokens)=[^()]*\)$/;
function classSignal(errorText) {
  return String(errorText || '').replace(GUARD_DIAG_RE, '');
}

// classify + strip in one step — every error-class decision must go through here so the #34
// diagnostic can never reach the CLASSIFIERS.
function errorClass(errorText) {
  return classifyError(classSignal(errorText));
}

export function keyFaultOf(errorText) {
  const t = classSignal(errorText);
  if (DEAD_KEY_RE.test(t)) return { dead: true, ttlMs: KEY_DEAD_TTL_MS };
  if (KEY_QUOTA_RE.test(t)) return { dead: false, ttlMs: WEEKLY_LIMIT_RE.test(t) ? KEY_WEEKLY_TTL_MS : KEY_QUOTA_TTL_MS };
  return null;
}

function failureClass(errorText) {
  const v = errorClass(errorText);
  if (v && v.class === 'quota') return { cls: 'quota', retryAfterMs: v.ttlMs };
  if (v && v.class === 'config') return { cls: 'config' };
  return { cls: 'transient' };
}

// Streaming: a rung is chosen BEFORE the first token — if it doesn't produce one within this
// window (or errors), the next rung is tried; after the first token there is no failover.
export const TTFB_TIMEOUT_MS = 15000;
const RF_400_RE = /structured[-_ ]outputs?|response[_ ]?format|json_object|stream_options/i;

export function upstreamRequest(env, model, body, keyIndex, { stream = false, stripRf = false, conversation = null, appSlug = null, appTitle = null } = {}) {
  const isGo = model.startsWith('opencode-go/');
  const isZen = model.startsWith('opencode-zen/');
  const pool = readPool(env);
  // Zen (#36): single shared relay token — no key pool, no rotation. Missing token → null →
  // the rung is treated as keyless and skipped, so an unconfigured worker just skips zen.
  const key = isGo ? pool[keyIndex] : isZen ? env.OPENCODE_ZEN_RELAY_TOKEN : env.OPENROUTER_API_KEY;
  if (!key) return null;
  const headers = { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
  // Keyed calls carry a stable per-conversation id so the provider-side prompt cache survives
  // turn after turn (epic #17, S7). Unkeyed calls keep the random session (Go 400s without it).
  // The zen relay turns x-session-id into its ses_/msg_ fingerprint (deterministic per conv).
  if (isGo) headers['x-opencode-session'] = `ladder-${conversation || crypto.randomUUID()}`;
  else if (conversation) headers['x-session-id'] = conversation;
  // App attribution (#33): only OpenRouter understands these — Go and zen rungs must not get them.
  if (!isGo && !isZen) {
    headers['HTTP-Referer'] = `${APP_REFERER_BASE}/${sanitizeAppSlug(appSlug)}`;
    headers['X-OpenRouter-Title'] = sanitizeAppTitle(appTitle);
    headers['X-OpenRouter-App-Visibility'] = 'hidden';
  }
  const upstream = {
    ...body,
    model: model.replace(/^opencode-go\/|^opencode-zen\/|^openrouter\//, ''),
    stream,
    max_tokens: Math.max(Number(body.max_tokens) || 0, minTokensFor(model)),
  };
  delete upstream.stream_options;
  if (stream && !isGo && !isZen) upstream.stream_options = { include_usage: true };
  if (stripRf) { delete upstream.response_format; delete upstream.stream_options; }
  const base = isGo
    ? (env.OPENCODE_GO_BASE_URL || 'https://opencode.ai/zen/go/v1')
    : isZen
      ? (env.OPENCODE_ZEN_BASE_URL || 'https://136-65-7-197.sslip.io/zen')
      : (env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1');
  return { url: `${base}/chat/completions`, headers, body: upstream };
}

async function post(fetchImpl, req, signal) {
  try {
    return { res: await fetchImpl(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal }) };
  } catch (e) {
    return { error: `fetch failed: ${e.message}` };
  }
}

// #34: guard failures say WHY the answer is empty — finish_reason + usage (did reasoning eat the
// whole floor?) travel inside the error string itself → attempts → console.log and D1
// ladder_calls.attempts, no new columns. Missing parts are simply omitted.
function guardDiag(data, req) {
  const parts = [];
  const finish = data?.choices?.[0]?.finish_reason;
  if (finish) parts.push(`finish=${finish}`);
  const usage = data?.usage || {};
  if (usage.completion_tokens != null) parts.push(`out=${usage.completion_tokens}`);
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  if (reasoning != null) parts.push(`reasoning=${reasoning}`);
  if (usage.prompt_tokens != null) parts.push(`prompt=${usage.prompt_tokens}`);
  if (req?.body?.max_tokens != null) parts.push(`max_tokens=${req.body.max_tokens}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

// Non-streaming attempt. A tool-call answer with no text is a valid answer.
async function attemptJson(env, model, body, keyIndex, { timeoutMs, wantJson, fetchImpl, conversation = null, appSlug = null, appTitle = null }) {
  let stripRf = false;
  for (;;) {
    const req = upstreamRequest(env, model, body, keyIndex, { stripRf, conversation, appSlug, appTitle });
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
    // #45 (owner): a COMPLETED answer that fails the guard is flagged, not fatal — run() gives
    // the rung ONE same-rung retry before moving down (guardTried there bounds it).
    if (!content && !hasTools) return { ok: false, guard: true, error: `empty answer${guardDiag(data, req)}` };
    if (wantJson && !hasTools && parseJson(content) === undefined) return { ok: false, guard: true, error: `invalid JSON${guardDiag(data, req)}` };
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
async function attemptStream(env, model, body, keyIndex, { ttfbMs, fetchImpl, conversation = null, appSlug = null, appTitle = null }) {
  const req = upstreamRequest(env, model, body, keyIndex, { stream: true, stripRf: !!body._stripRf, conversation, appSlug, appTitle });
  if (!req) return { ok: false, skip: true, error: 'no key' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('no first token in time')), ttfbMs);
  const { res, error } = await post(fetchImpl, req, ctrl.signal);
  if (error) { clearTimeout(timer); return { ok: false, error }; }
  if (!res.ok) {
    clearTimeout(timer);
    const errText = String(await res.text().catch(() => ''));
    if (res.status === 400 && !body._stripRf && body.response_format && RF_400_RE.test(errText)) {
      return attemptStream(env, model, { ...body, _stripRf: true }, keyIndex, { ttfbMs, fetchImpl, conversation, appSlug, appTitle });
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
  // Zen Pool rung — in-process, no HTTP and no token: the pool lives in this same worker, so the
  // ladder calls its core directly. A cold pool boots a runner (~10-13 s) and the caller's own
  // watchdog covers it; a warm one answers in ~3 s.
  if (model.startsWith('zen-pool/')) return attemptPool(env, model, body, opts);
  return body.stream ? attemptStream(env, model, body, keyIndex, opts) : attemptJson(env, model, body, keyIndex, opts);
}

// The pool's answer is one blob from a long-lived GitHub Actions job, so a streaming call gets a
// synthesised SSE stream — the ladder's TTFB path only needs the first output event, and the
// client sees a normal stream.
async function attemptPool(env, model, body, { fetchImpl, timeoutMs }) {
  const rung = model.replace(/^zen-pool\//, '');
  const { status, data } = await poolInvoke(env, {
    model: rung,
    messages: body.messages,
    tools: body.tools,
    max_tokens: body.max_tokens,
    // A cold pool needs the boot window; a warm one answers long before this. Capped at the
    // pool's own watchdog ceiling.
    wait_ms: Math.min(Math.max(timeoutMs || 0, 30_000), 90_000),
  }, fetchImpl);
  if (status !== 200 || !data.ok) {
    // No status code in the message on purpose: '429'/'503' would classify as a quota skip (up to
    // 1h), and a pool that is merely cold or briefly over its per-minute cap is transient.
    return { ok: false, error: `zen-pool: ${data.error || data.kind || 'no answer'}` };
  }
  const content = String(data.text || '').trim();
  const hasTools = Array.isArray(data.tool_calls) && data.tool_calls.length > 0;
  if (!content && !hasTools) return { ok: false, guard: true, error: 'empty answer' };
  const message = { role: 'assistant', content };
  if (hasTools) message.tool_calls = data.tool_calls;
  const finish = data.finish_reason || (hasTools ? 'tool_calls' : 'stop');
  const completion = {
    id: `zen-pool-${data.task_id || crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: rung,
    choices: [{ index: 0, message, finish_reason: finish }],
    ...(data.usage ? { usage: data.usage } : {}),
  };
  if (!body.stream) return { ok: true, data: completion, content };
  const enc = new TextEncoder();
  const head = { ...completion, choices: [{ index: 0, delta: message, finish_reason: null }] };
  const tail = { choices: [{ index: 0, delta: {}, finish_reason: finish }] };
  const sse = `data: ${JSON.stringify(head)}\n\ndata: ${JSON.stringify(tail)}\n\ndata: [DONE]\n\n`;
  const stream = new ReadableStream({ start(c) { c.enqueue(enc.encode(sse)); c.close(); } });
  return { ok: true, stream };
}

/**
 * @param {object} body   OpenAI chat.completions body; `model` = ladder name ("service",
 *                        legacy alias "deepseek", "service:review", alias "free-ladder"). stream:true → SSE (rung chosen
 *                        before the first token); tools / tool_choice passed through as is.
 * @param {object} ctx    { env, config, store, fetchImpl, timeoutMs=20000, totalTimeoutMs, now,
 *                          pinRung, conversation, appSlug, appTitle }
 *   appSlug / appTitle: OpenRouter app attribution (#33) — slug for HTTP-Referer (default
 *                 'llm-ladder'), display name for X-OpenRouter-Title (default 'Trained Assist').
 *   conversation: stable per-conversation id (Kh from the route) — enables the sticky rung
 *                 (epic #17): the conversation sticks to ONE rung so its provider-side prompt
 *                 cache survives turn after turn. null/undefined → byte-for-byte today.
 *   store (async): snapshot(poolSize?, pinKey?) → { health, keys, pin }
 *                  recordFailure(model, {cls, retryAfterMs}, {pinRemove}),
 *                  recordSuccess(model, {pin}), rotateKey(poolSize, ttlMs, failedIndex), park(models, untilMs),
 *                  pinStats() → {count, byRung}
 * @returns {Promise<{ok:true, model, data?, content?, stream?, attempts, pin?} |
 *                   {ok:false, status, error, attempts, pin?}>}
 *   pin: 'new' | 'hit' | 'moved' | 'gone' | null — only set for keyed calls.
 */
export async function run(body, { env, config, store, fetchImpl = fetch, timeoutMs = 20000, totalTimeoutMs = null, ttfbMs = TTFB_TIMEOUT_MS, pinRung = null, conversation = null, appSlug = null, appTitle = null } = {}) {
  let all = rungsFor(config, body && body.model);
  if (!all) return { ok: false, status: 404, error: `unknown ladder: ${body && body.model}`, attempts: [] };
  // Benchmarks: pin ONE rung of the ladder (health skips ignored, no failover) to measure it
  // through the worker without handing provider keys to the bench.
  if (pinRung) {
    if (!all.includes(pinRung)) return { ok: false, status: 400, error: `rung not in ladder: ${pinRung}`, attempts: [] };
    all = [pinRung];
  }
  const pool = readPool(env);
  const hasKey = m => (m.startsWith('opencode-go/') ? pool.length > 0
    : m.startsWith('opencode-zen/') ? !!env.OPENCODE_ZEN_RELAY_TOKEN
    : m.startsWith('zen-pool/') ? !!env.ZEN_DB
    : !!env.OPENROUTER_API_KEY);
  const keyed = all.filter(hasKey);
  if (!keyed.length) return { ok: false, status: 503, error: 'no provider key configured', attempts: [] };

  const snap = await store.snapshot(undefined, conversation);
  const now = Date.now();
  // A TRANSIENT wobble on a Go rung (timeout / empty answer / 500 — the failure class behind the
  // 29.09 incident) must not keep the whole fleet on the paid tail for the full exponential
  // backoff (up to 5 min): cap it, so the Go tier is re-tested at least every 30s. Real limits
  // (quota parks from key exhaustion, 503, config) keep their own TTL — hammering them helps no
  // one. Zen rungs (#36) get the same cap: they sit in the free segment, and a long skip there
  // pushes calls onto the rate-limited OpenRouter free pool and then the paid tail.
  const GO_TRANSIENT_SKIP_CAP_MS = 30 * 1000;
  const skipped = m => {
    const h = snap.health[m];
    if (!h) return false;
    if (h.skipUntil === null) return true;
    let until = h.skipUntil;
    if ((m.startsWith('opencode-go/') || m.startsWith('opencode-zen/')) && h.class === 'transient' && h.lastFailureAt) {
      until = Math.min(until, h.lastFailureAt + GO_TRANSIENT_SKIP_CAP_MS);
    }
    return until > now;
  };

  // ── Sticky rung (epic #17) ─────────────────────────────────────────────────────────────────
  // A valid pin = the conversation already served from a rung that is still part of THIS ladder
  // and has a key. The pinned rung then goes FIRST and is tried despite the global skipUntil
  // (another conversation's failure must not reset this one's prompt cache); other rungs keep
  // today's `!skipped` filter with the all-keyed fallback.
  const pinned = pinRung ? null : (snap.pin && all.includes(snap.pin.rung) && hasKey(snap.pin.rung) ? snap.pin : null);
  const goHealthy = keyed.some(m => m.startsWith('opencode-go/') && !skipped(m));
  // R6 — return from the paid tail: a pin parked on an OpenRouter rung must NOT keep this
  // conversation on the paid tier while any healthy Go rung is standing by. Skip the pin's
  // rung-first order for THIS call; if Go answers, the pin moves back to Go.
  const preferGoOverPin = pinned && pinned.rung.startsWith('openrouter/') && goHealthy;
  let pinState = conversation ? (pinned && !preferGoOverPin ? 'hit' : 'new') : null;
  // ONE same-rung retry budget for the pinned rung (S5): a transient 5xx/timeout/empty on the
  // rung we are caching on is retried once before the ladder moves — an "at most one switch" rule.
  let pinRetryLeft = pinned && !preferGoOverPin ? 1 : 0;

  const live = pinRung ? keyed : keyed.filter(m => !skipped(m));
  let rungs;
  if (pinned && !preferGoOverPin) {
    const rest = live.filter(m => m !== pinned.rung);
    rungs = [pinned.rung, ...(rest.length ? rest : keyed.filter(m => m !== pinned.rung))];
  } else {
    rungs = live.length ? live : keyed;
  }
  let keyIndex = Math.min(snap.keys.active || 0, Math.max(0, pool.length - 1));
  // Free Go rungs rotate across the pool (owner 2026-10-03: «го фрии модели шли каруселью всё
  // время по одному запросу по очереди перебирая аккаунты»). When the ladder OPENS on a free rung
  // (build, free), the starting key comes from the round-robin cursor, so consecutive free calls
  // land on different accounts instead of all hammering the active one. Single-key pool → no-op.
  const head = rungs[0];
  if (pool.length > 1 && head && head.startsWith('opencode-go/') && head.endsWith('-free')) {
    keyIndex = nextFreeGoKeyIndex(pool.length);
  }
  const exhaustedAtStart = new Set(Object.keys(snap.keys.exhausted || {}).map(Number));
  // One spare-key probe per call (owner 2026-09-29: «ключ залимитился → переключаем на другой,
  // всё»). A Go rung that fails for a NON-key reason (timeout, empty answer, 500) still gets one
  // attempt on the other provisioned key before the ladder leaves Go for paid OpenRouter — a
  // silently throttled key looks exactly like a slow model, and staying on Go costs nothing.
  // Bounded to ONE probe per call so a Go outage cannot double the failover latency.
  // pinRung (benchmarks) measures exactly ONE attempt on ONE rung — no probe there either.
  let probeBudget = pinRung ? 0 : 1;
  // #45: one same-rung retry per rung for a completed-but-guard-failed answer (empty / non-JSON).
  const guardTried = new Set();
  let goParked = false;

  const wantJson = body.response_format && body.response_format.type === 'json_object';
  const deadline = totalTimeoutMs ? now + totalTimeoutMs : Infinity;
  const attempts = [];
  for (const model of rungs) {
    const isGo = model.startsWith('opencode-go/');
    // #69: a full-key park (weekly limit on every key) skips only the PAID Go rungs — a free
     // Go rung keeps serving, it does not consume the allowance and must not die in the incident.
     if (isGo && goParked && !model.endsWith('-free')) continue;
     const left = deadline - Date.now();
    if (left < 500) { attempts.push({ model, outcome: 'skipped', error: 'time budget spent' }); break; }
    const opts = { timeoutMs: Math.min(timeoutMs, left), ttfbMs: Math.min(ttfbMs, left), wantJson, fetchImpl, conversation, appSlug, appTitle };
    let key = keyIndex;
    const tried = new Set([key]);
    let r = await attempt(env, model, body, key, opts);
    if (r.skip) continue;
    // #45 (owner «если ошибка то ретрай и далее потом по лесенке»): a guard-failed answer ALREADY
    // arrived — retrying the same rung costs a fraction of one ladder hop, while today's straight
    // descent pays double: a hop to a possibly pricier rung PLUS a health-skip that punishes every
    // other caller for 15s+ over one cheap flake (measured: an empty gpt-oss JSON in 285ms).
    // Bounded to ONE retry per rung; success records no failure at all. Visible in attempts as
    // outcome 'guard-retry' so flake rates stay measurable. Streams are excluded — a retry there
    // costs a full TTFB window, and the no-first-token path is not a guard failure.
    if (r.guard && !guardTried.has(model)) {
      guardTried.add(model);
      attempts.push({ model, outcome: 'guard-retry', key, error: r.error });
      r = await attempt(env, model, body, key, opts);
    }
    while (!r.ok && isGo && !goParked) {
      const fault = keyFaultOf(r.error);
      if (fault) {
        const rot = await store.rotateKey(pool.length, fault.ttlMs, key);
        if (!rot.rotated) {
          // #69: never park free Go rungs here — the allowance they don't consume is exactly
          // what the ladder must fall back on while every key is limited.
          await store.park(all.filter(m => m.startsWith('opencode-go/') && !m.endsWith('-free')), rot.retryAt);
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
      const cls = errorClass(r.error)?.class || 'transient';
      const spare = pool.findIndex((_, i) => !tried.has(i) && !exhaustedAtStart.has(i));
      if (cls === 'context' || cls === 'config' || spare < 0 || probeBudget <= 0) break;
      probeBudget--;
      attempts.push({ model, outcome: 'key-probe', key, error: r.error });
      key = spare;
      tried.add(key);
      r = await attempt(env, model, body, key, opts);
      if (r.ok) keyIndex = key; // the spare answered — keep it for the rest of this call
    }
    // Sticky same-rung retry (S5): the pinned rung on a paid (non-Go) rung gets ONE more chance on
    // a transient error before the ladder moves — Go already gets its spare-key probe above.
    if (!r.ok && !r.skip && !isGo && pinRetryLeft > 0 && pinned && model === pinned.rung) {
      const cls = errorClass(r.error)?.class || 'transient';
      if (cls === 'transient') {
        pinRetryLeft = 0;
        attempts.push({ model, outcome: 'pin-retry', key, error: r.error });
        r = await attempt(env, model, body, key, opts);
      }
    }
    if (r.ok) {
      if (conversation && !pinRung) {
        pinState = model === (pinned && pinned.rung) ? 'hit' : (pinned ? 'moved' : 'new');
        await store.recordSuccess(model, { pin: { pinKey: conversation, rung: model } });
      } else {
        await store.recordSuccess(model);
      }
       attempts.push({ model, outcome: 'ok', key });
       return { ok: true, model, data: r.data, content: r.content, stream: r.stream, attempts, pin: pinState };
    }
    attempts.push({ model, outcome: 'error', key, error: r.error });
    if (!goParked) {
      const cls = errorClass(r.error)?.class || 'transient';
      // ⚫-1 resolution (step 3): a context-class overflow while STUCK on the pinned rung returns
      // the error as-is (the same request would overflow every lower rung — a retry loop cannot
      // help) and INVALIDATES the pin, so the next turn picks fresh instead of dying on the model.
      if (conversation && cls === 'context' && pinned && model === pinned.rung) {
        await store.recordFailure(model, failureClass(r.error), { pinRemove: { pinKey: conversation, model } });
        pinState = 'gone';
        const m2 = /^HTTP[^\s]* (\d+)/.exec(r.error);
        return { ok: false, status: m2 ? Number(m2[1]) : 502, error: r.error, attempts, pin: 'gone' };
      }
      await store.recordFailure(model, failureClass(r.error));
    }
  }
  return { ok: false, status: 502, error: 'every rung failed', attempts, pin: conversation ? pinState : null };
}
