import { orderBenchmarkedGoRungs, readGoBenchRows, nextFreeGoKeyIndex } from './go-routing.js';
export { orderBenchmarkedGoRungs, readGoBenchRows, nextFreeGoKeyIndex, resetFreeGoKeyCursor } from './go-routing.js';
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
import { estimateTokens, fits, hedgePlan, ttfbFactor } from './size-policy.js';
import { ringInvoke, ringWaitForTask, ringBoot, ringCooldown } from './zen-ring.js';
import { createCompressionSession } from './context-compression.js';
import { isEmptyAnswer } from './answer-guard.js';

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

// The same rule, but "no app" stays a VALUE instead of becoming a name (#136).
//
// sanitizeAppSlug's default is right for the OpenRouter headers (#33): HTTP-Referer must name
// something, so a caller with no `x-ladder-app` is honestly the generic proxy — 'llm-ladder' IS
// what that request is upstream. It is the wrong value for the D1 attribution column: there
// DEFAULT_APP_SLUG is written as if a tool had claimed it, and no caller ever does (the slug comes
// from our own constant), so the apps cut cannot tell "unknown caller" from a real app and the
// router's own traffic outranks every real one — 264 of 466 attributed calls in the first hour
// after the column landed (2026-10-05).
//
// Same regex on purpose: the two must agree on WHICH strings are slugs, so a D1 row and the
// OpenRouter view of one call can never name it differently. They differ only in what happens
// when the answer is "not a slug".
export function sanitizeAppSlugOrNull(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  return SLUG_RE.test(s) ? s : null;
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

// OpenRouter: сколько ключу разрешено и сколько осталось на аккаунте — зеркало /v1/go-usage.
//
// Зачем: платный хвост умирает на `402 insufficient credits` (с 2026-10-04, 2833 отказа в
// трассе), а бесплатные `:free`-модели едут на ОТДЕЛЬНОМ дневном разрешении — и до сих пор
// ни то, ни другое не было видно без консоли OpenRouter. Замер 2026-10-08: за сутки лестница
// отдала 348 ответов через `:free`-ранги, дневной потолок по замеру из #86 — около 1000.
//
// Два запроса, потому что они отвечают на разные вопросы:
//   GET /api/v1/auth/key  — лимит/расход ИМЕННО этого ключа (limit, usage, is_free_tier);
//   GET /api/v1/credits   — баланс аккаунта (total_credits, total_usage) — на него смотрит
//                           платный хвост, ключ может быть вообще без своего лимита.
// Сырые объекты возвращаются как есть: поля OpenRouter — это ответ API, а не наш контракт.
// Ключ в ответ не попадает никогда (как и в /v1/go-usage).
export async function fetchOrUsage(env, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const key = env.OPENROUTER_API_KEY;
  if (!key) return { key: null, credits: null, error: 'OPENROUTER_API_KEY not configured' };
  const base = env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
  const one = async (pathname) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}${pathname}`, { headers: { Authorization: `Bearer ${key}` }, signal: ctrl.signal });
      const text = await res.text();
      if (!res.ok) return { error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      try { return JSON.parse(text); } catch { return { error: `non-JSON: ${text.slice(0, 120)}` }; }
    } catch (e) {
      return { error: e && e.name === 'AbortError' ? 'timeout' : String((e && e.message) || e) };
    } finally {
      clearTimeout(timer);
    }
  };
  const [authKey, credits] = await Promise.all([one('/auth/key'), one('/credits')]);
  return { key: authKey, credits };
}

// "service" (legacy alias "deepseek"), "service:review" or an alias ("free-ladder") → rungs, null if unknown.
// Aliases resolve on READ only (never written back), so stored state keeps working after a rename.
export function rungsFor(config, name) {
  const [ladderName, role] = String(name || DEFAULT_LADDER).split(':');
  const resolved = (config.aliases && config.aliases[ladderName]) || ladderName;
  const l = config.ladders && config.ladders[resolved];
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
  // The request did not fit this rung's window. classify.js is explicit that this must NOT become
  // a shared exhaustion — «the next task on this rung (from any user) is very likely a normal-sized
  // prompt that would work fine» — but collapsing it to 'transient' did exactly that: every fat
  // prompt put the rung into shared health for 2 s → 4 s → … (capped at 30 s for zen), and one
  // 1.1 MB agent prompt was disabling the head rung for EVERY other caller ~24×/hour. The request
  // is wrong, the rung is fine.
  if (v && v.class === 'context') return { cls: 'context' };
  return { cls: 'transient' };
}

// Streaming: a rung is chosen BEFORE the first token — if it doesn't produce one within this
// window (or errors), the next rung is tried; after the first token there is no failover.
export const TTFB_TIMEOUT_MS = 15000;

// Сколько лестница готова ждать КОЛЬЦО, если вызывающий не попросил больше. Пол, а не замена:
// `Math.max(timeoutMs, RING_WAIT_MS)` в attemptRing. Выведено из замера на здоровом окне
// (2026-10-07 09:00 →, 1599 успешных задач): сервис zen p50 = 33 с, p90 = 63 с, при том что
// бюджет был 20 с + 15 с grace = 35 с, то есть САМА МОДЕЛЬ не влезала в свой бюджет.
//
//   бюджет 35 с от постановки → доставлено 41.4 %  (было)
//   бюджет 60 с               → доставлено 74.8 %
//   бюджет 90 с               → доставлено 92.4 %
//
// 45 с + grace 15 с = 60 с — это 74.8 % при максимально допустимом для интерактива ожидании.
// Дальше выгода падает (60→90 с даёт +18 п.п., а ожидание полторы минуты), а «опенкод зависает»
// было главной жалобой.
export const RING_WAIT_MS = 45_000;

// Правило — отдельно и явно, чтобы его можно было проверить без 45-секундного ожидания:
// пол только поднимает, никогда не опускает. Вызывающий, попросивший больше, больше и получит;
// попросивший меньше всё равно не получит меньше того, что модели нужно, чтобы ответить.
export function ringWaitMs(timeoutMs) {
  return Math.max(Number(timeoutMs) || 0, RING_WAIT_MS);
}
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
  // flat shape too: a pool/ring answer carries finish_reason at the top level, not under
  // choices[0], so the same sentence explains an empty body from either transport.
  const finish = data?.choices?.[0]?.finish_reason ?? data?.finish_reason;
  if (finish) parts.push(`finish=${finish}`);
  const usage = data?.usage || {};
  if (usage.completion_tokens != null) parts.push(`out=${usage.completion_tokens}`);
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  if (reasoning != null) parts.push(`reasoning=${reasoning}`);
  if (usage.prompt_tokens != null) parts.push(`prompt=${usage.prompt_tokens}`);
  if (req?.body?.max_tokens != null) parts.push(`max_tokens=${req.body.max_tokens}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

// #45 (повтор для кольца): ретрай имеет смысл, только если вторая попытка МОЖЕТ отличаться от
// первой. Ответ с `finish=tool_calls` и без ни текста, ни самого tool_calls — структурный отказ:
// модель захотела вызвать инструмент, а кольцевой воркер (старая версия, без фикса от 07.10)
// записал задачу неудачной, не приложив tool_calls. Повтор по тому же запросу даёт тот же
// результат — замер за сутки: 74 таких отказа, дошёл до ответа 8 (и то другой ступенью),
// суммарно 35 минут стенда. Лестница уходит на следующую ступень сразу.
//
// Возвращается в отдельной функции, чтобы правило жило рядом с guardDiag и проверялось само.
export function ringGuardRetry(data, body) {
  if (body?.stream) return false;                       // стрим уже оплатил всё окно
  if (!(data?.kind === 'ok' && !data?.ok)) return false; // это вообще не guard-случай
  const finish = data?.choices?.[0]?.finish_reason ?? data?.finish_reason;
  return finish !== 'tool_calls';
}

// Non-streaming attempt. A tool-call answer with no text is a valid answer.
async function attemptJson(env, model, body, keyIndex, { timeoutMs, wantJson, fetchImpl, conversation = null, appSlug = null, appTitle = null, rawAnswer = false }) {
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
    const provider = model.slice(0, model.indexOf('/'));
    const actualModel = typeof data?.model === 'string' && data.model
      ? (data.model.startsWith(`${provider}/`) ? data.model : `${provider}/${data.model}`) : model;
    const message = data?.choices?.[0]?.message || {};
    const content = String(message.content || '').trim();
    const hasTools = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
    if (rawAnswer && data?.choices?.[0]?.message) return { ok: true, data, content, winner: { model: actualModel, keyIndex } };
    // #45 (owner): a COMPLETED answer that fails the guard is flagged, not fatal — run() gives
    // the rung ONE same-rung retry before moving down (guardTried there bounds it).
    if (isEmptyAnswer(content) && !hasTools) return { ok: false, guard: true, error: `empty answer${guardDiag(data, req)}` };
    if (wantJson && !hasTools && parseJson(content) === undefined) return { ok: false, guard: true, error: `invalid JSON${guardDiag(data, req)}` };
    return { ok: true, data, content, winner: { model: actualModel, keyIndex } };
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
  // Zen Ring rung — in-process, no HTTP and no token: the pool lives in this same worker, so the
  // ladder calls its core directly. A cold ring boots a runner (~10-13 s) and the caller's own
  // watchdog covers it; a warm one answers in ~3 s.
  if (model.startsWith('zen-rings/')) return attemptRing(env, model, body, opts);
  return body.stream ? attemptStream(env, model, body, keyIndex, opts) : attemptJson(env, model, body, keyIndex, opts);
}

// The owner's race (2026-10-07): «два запуска одной модели на разных аккаунтах го» — the SAME
// model fired on DIFFERENT keys at once, first answer wins. Free Go has four keys, no allowance
// to protect and no per-token cost, so the race buys tail latency and immunity to one throttled
// or slow key for the price of wall clock alone.
//
// The primary key (the one the round-robin picked) is the one whose failure the caller sees, so
// key rotation and the spare-key probe below behave exactly as they do for a single attempt —
// a race that silently returned some other key's error would make #45/#69 reason about the wrong
// account. Every raced key is recorded in `tried` so the probe cannot land on one already burnt.
async function raceGoKeys(env, model, body, primaryKey, count, opts, poolSize, tried) {
  const n = Math.max(2, Math.min(count, poolSize));
  const keys = [...new Set(Array.from({ length: n }, (_, i) => (primaryKey + i) % poolSize))];
  for (const k of keys) tried.add(k);
  if (keys.length < 2) return attempt(env, model, body, primaryKey, opts);
  return new Promise((resolve) => {
    let pending = keys.length;
    let primaryResult = null;
    let done = false;
    const settle = (r) => { if (!done) { done = true; resolve(r); } };
    const lose = (r, isPrimary) => {
      if (isPrimary && !primaryResult) primaryResult = r;
      if (--pending === 0) settle(primaryResult || r);
    };
    for (const k of keys) {
      const isPrimary = k === primaryKey;
      attempt(env, model, body, k, opts).then(
        (r) => (r.ok ? settle({ ...r, winner: { model: r.winner?.model || model, keyIndex: k } }) : lose(r, isPrimary)),
        (e) => lose({ ok: false, error: String(e?.message || e) }, isPrimary),
      );
    }
  });
}

// The pool's answer is one blob from a long-lived GitHub Actions job, so a streaming call gets a
// synthesised SSE stream — the ladder's TTFB path only needs the first output event, and the
// client sees a normal stream.
// One pool call: invoke, and if the caller's watchdog fired while the job is still working, wait a
// short grace for the answer that is already in flight rather than starting a duplicate task. The
// grace is bounded — the task already had the caller's whole rung budget, so a longer wait would
// only delay the failover.
async function ringCall(env, payload, fetchImpl, graceMs = 15_000) {
  let r = await ringInvoke(env, payload, fetchImpl);
  if (r.status === 504 && r.data?.task_id) {
    const w = await ringWaitForTask(env, r.data.task_ids || r.data.task_id, { deadlineMs: graceMs });
    if (w.ok) return { status: 200, data: w.data };
  }
  return r;
}

async function attemptRing(env, model, body, { fetchImpl, timeoutMs, exactModel = false, rawAnswer = false }) {
  const rung = model.replace(/^zen-rings\//, '');
  // Right after a cold start the runner is still settling — skip the ring for a cooldown window
  // so a call doesn't land on a half-warmed worker.
  const cooldown = await ringCooldown(env);
  if (cooldown > 0) {
    return { ok: false, error: `zen-rings: warming up (${Math.ceil(cooldown / 1000)}s left), try the next rung` };
  }
  // Cold ring: boot a worker in the background and fail over NOW. Waiting here would burn the
  // caller's whole rung budget on a one-time ~10-13 s boot; the ring is warm for the next call.
  const boot = await ringBoot(env, { fetchImpl });
  if (boot.booted) {
    return { ok: false, error: `zen-rings: cold ring — booting (${boot.reason}), try the next rung` };
  }
  const payload = {
    model: rung,
    messages: body.messages,
    tools: body.tools,
    max_tokens: rawAnswer ? Math.max(Number(body.max_tokens) || 0, minTokensFor(`opencode-zen/${rung}`)) : body.max_tokens,
    response_format: body.response_format,
    tool_choice: body.tool_choice,
    ...(exactModel ? { exact_model: true } : {}),
    // The caller's per-rung budget IS the pool watchdog (clamped to the pool's [1s, 90s]) — но для
    // ЗЕНА этого бюджета не хватало. Замер на здоровом окне (с 2026-10-07 09:00, 1599 задач):
    // очередь p50 = 0 с, сервис zen p50 = 33 с, p90 = 63 с, а старые 20 с + 15 с grace доставляли
    // лишь 41 % ответов — бюджет был меньше самой модели. Окно в 45 с (+15 с grace = 60 с)
    // доставляет 74.8 % (замер: total ≤60 с → 1196/1599).
    //
    // Пол только ПОДНИМАЕТ: вызывающий, попросивший больше (`ladder_timeout_ms`), больше и получит.
    // Холодный или мёртвый кольцо сюда не попадает — эти ветки возвращаются до постановки задачи,
    // поэтому 45 с не превращают отказ в ожидание.
    wait_ms: ringWaitMs(timeoutMs),
  };
  let r = await ringCall(env, payload, fetchImpl);
  // ONE retry for a transient fault (a cold ring that just booted, a provider 5xx). A budget
  // refusal (429) is not retried — the cap is real and retrying inside the same minute is wasted.
  // 413 (input too long for the free tier) is decided locally before anything is queued: the same
  // payload cannot fit on a second attempt either, so there is nothing to retry — unlike a transient
  // fault or a cold ring, where a second look genuinely can succeed.
  if (!exactModel && !(rawAnswer && r.data?.kind === 'ok') && r.status !== 200 && r.status !== 429 && r.status !== 413) r = await ringCall(env, payload, fetchImpl);
  const completedInvalid = rawAnswer && r.data?.kind === 'ok' && typeof r.data?.model === 'string';
  if (!completedInvalid && (r.status !== 200 || !r.data?.ok)) {
    // No status code in the message on purpose: '429'/'503' would classify as a quota skip (up to
    // 1h), and a pool that is merely cold or briefly over its per-minute cap is transient.
    const base = r.data?.error || r.data?.kind || 'no answer';
    // #34 for the ring path: the pool keeps finish_reason/usage on a failure too, so an empty
    // body can say WHY — finish=length, out=0, reasoning=N instead of an opaque `zen-rings: ok`.
    const diag = guardDiag(r.data, { body });
    // #45 — ONE same-rung retry, but only for the case it was built for: the model answered and
    // we judged that answer empty. A budget refusal or a cooldown must not be retried (the cap
    // is real), and a stream caller already paid the whole watchdog for a synthesised stream, so
    // paying it twice is exactly what the guard-retry comment excludes.
    const emptyOk = r.data?.kind === 'ok' && !r.data?.ok;
    return {
      ok: false,
      ...(ringGuardRetry(r.data, body) ? { guard: true } : {}),
      error: `zen-rings: ${base}${diag}`,
    };
  }
  const content = String(r.data.text || '').trim();
  const hasTools = Array.isArray(r.data.tool_calls) && r.data.tool_calls.length > 0;
  if (!rawAnswer && isEmptyAnswer(content) && !hasTools) return { ok: false, guard: true, error: `empty answer${guardDiag(r.data, { body })}` };
  const actualModel = `zen-rings/${r.data.model || rung}`;
  const message = { role: 'assistant', content };
  if (hasTools) message.tool_calls = r.data.tool_calls;
  const finish = r.data.finish_reason || (hasTools ? 'tool_calls' : 'stop');
  const completion = {
    id: `zen-rings-${r.data.task_id || crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: actualModel,
    choices: [{ index: 0, message, finish_reason: finish }],
    ...(r.data.usage ? { usage: r.data.usage } : {}),
  };
  if (!body.stream) return { ok: true, data: completion, content, winner: { model: actualModel, keyIndex: 0 } };
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
async function runLadder(body, { context, env, config, store, fetchImpl = fetch, timeoutMs = 20000, totalTimeoutMs = null, ttfbMs = TTFB_TIMEOUT_MS, pinRung = null, conversation = null, appSlug = null, appTitle = null } = {}) {
  let all = rungsFor(config, body && body.model);
  if (!all) return { ok: false, status: 404, error: `unknown ladder: ${body && body.model}`, attempts: [] };
  // Benchmarks: pin ONE rung of the ladder (health skips ignored, no failover) to measure it
  // through the worker without handing provider keys to the bench.
  if (pinRung) {
    if (!all.includes(pinRung)) return { ok: false, status: 400, error: `rung not in ladder: ${pinRung}`, attempts: [] };
    all = [pinRung];
  }
  if (!pinRung && env?.LADDER_TRACE_DB) {
    try { all = orderBenchmarkedGoRungs(all, await readGoBenchRows(env.LADDER_TRACE_DB), estimateTokens(body)); }
    catch { /* benchmark inventory outages must not interrupt ladder calls */ }
  }
  const pool = readPool(env);
  const hasKey = m => (m.startsWith('opencode-go/') ? pool.length > 0
    : m.startsWith('opencode-zen/') ? !!env.OPENCODE_ZEN_RELAY_TOKEN
    : m.startsWith('zen-rings/') ? !!env.ZEN_DB
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

  let wantJson = body.response_format && body.response_format.type === 'json_object';
  const deadline = totalTimeoutMs ? now + totalTimeoutMs : Infinity;
  // Size gate (owner 2026-10-07): a rung whose window is smaller than this request cannot answer,
  // and its refusal is expensive — measured the same day, opencode-go takes ~98K tokens and at
  // ~123K answers `429 Endpoint is unavailable` while rotating through every key: 48 s of wall
  // clock, three keys burned, still no answer. Refusing BEFORE the attempt is pure win; the
  // attempt record stays so /v1/calls shows why the rung was not tried.
  let inputTokens = estimateTokens(body);
  const attempts = [];
  for (const model of rungs) {
    const isGo = model.startsWith('opencode-go/');
    // #69: a full-key park (weekly limit on every key) skips only the PAID Go rungs — a free
     // Go rung keeps serving, it does not consume the allowance and must not die in the incident.
     if (isGo && goParked && !model.endsWith('-free')) continue;
    try { body = context.prepare('paid', model); }
    catch (error) { return { ok: false, status: 400, error: `Context compression failed: ${error.message}`, attempts }; }
    inputTokens = estimateTokens(body);
    wantJson = !context.active && body.response_format?.type === 'json_object';
    const left = Math.min(deadline, context.deadline) - Date.now();
    if (left < 500) { attempts.push({ model, outcome: 'skipped', error: 'time budget spent' }); break; }
    // Skipped, not failed: the request is wrong for THIS rung, exactly like a context overflow —
    // recording a failure would health-skip a perfectly good model for every other caller.
    if (!fits(model, inputTokens)) {
      attempts.push({ model, outcome: 'skipped', error: `input ~${inputTokens}t above the rung ceiling` });
      continue;
    }
    const isFreeGo = isGo && model.endsWith('-free');
    const plan = hedgePlan(inputTokens);
    const rungBudget = Math.min(timeoutMs, left);
    // A SMALL context gets a SMALL budget — but only on the fast rung. Cutting zen to 0.4× would
    // destroy exactly what it is there for: a <2K prompt needs ~20 s there (9.4 s of zen + ~10 s
    // of queue), so the short budget must not leak onto the rung we fall back TO.
    const opts = {
      timeoutMs: isFreeGo ? Math.max(1_000, Math.round(rungBudget * plan.timeoutFactor)) : rungBudget,
      // Окно первого токена растёт с промптом (ttfbFactor): жирный запрос имеет префилл, и
      // фиксированные 15 с резали его до первого токена — см. замер и инцидент в size-policy.js.
      ttfbMs: Math.min(ttfbMs * ttfbFactor(inputTokens), left),
      wantJson, fetchImpl, conversation, appSlug, appTitle, rawAnswer: context.active,
    };
    let key = keyIndex;
    const tried = new Set([key]);
    // Гоним только бесплатный Go: у него четыре ключа, нет надбавки и нет дневной квоты, то есть
    // параллельный зов стоит только времени. Пин и стрим исключены — бенчмарк меряет один ранг,
    // а стрим закрепляет ранг на первом токене и отмена потерь тут отдельная история.
    const race = isFreeGo && plan.count > 1 && !pinRung && !body.stream && pool.length > 1;
    let r = race
      ? await raceGoKeys(env, model, body, key, plan.count, opts, pool.length, tried)
      : await attempt(env, model, body, key, opts);
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
      }
       const winner = r.winner || { model, keyIndex: key };
       attempts.push({ model: context.active ? winner.model : model, outcome: 'ok', key: context.active ? winner.keyIndex : key });
       const result = { ok: true, model: context.active ? winner.model : model, data: r.data, content: r.content, stream: r.stream, attempts, pin: pinState, winner };
       const finished = await context.finish(result, async (nextBody, receipt, remaining) => {
         if (!fits(receipt.model, estimateTokens(nextBody))) return { ok: false, error: 'expanded context exceeds the winner ceiling' };
         const next = await attempt(env, receipt.model, nextBody, receipt.keyIndex, {
           ...opts, timeoutMs: Math.min(timeoutMs, remaining), wantJson: false, rawAnswer: true, exactModel: true,
         });
         return next;
       });
       if (finished.ok) {
         await store.recordSuccess(model, conversation && !pinRung ? { pin: { pinKey: conversation, rung: model } } : {});
         return finished;
       }
       // The compressed path already used its single same-winner repair. Empty
       // answers now follow the ordinary descent policy, without another retry
       // or a restart from the ladder head. Other contract errors stay terminal.
       if (!finished.guard) return finished;
       attempts.splice(0, attempts.length, ...finished.attempts);
       r = finished;
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

// One immutable archive per independent API run, alive through retrieval and repair only.
export async function run(body, options = {}) {
  const context = createCompressionSession(body, {
    enabled: options.env?.CONTEXT_COMPRESSION_ENABLED !== 'false',
    ...(options.contextCompression || {}),
    ...(options.inputBytes !== undefined ? { inputBytes: options.inputBytes } : {}),
    totalTimeoutMs: options.totalTimeoutMs,
  });
  try {
    let prepared;
    try { prepared = context.prepare('entry'); }
    catch (error) { return { ok: false, status: 400, error: `Context compression failed: ${error.message}`, attempts: [] }; }
    const result = await runLadder(prepared, { ...options, context });
    // Receipts are internal; API callers must not see provider-key indexes.
    const { winner: _winner, ...publicResult } = result;
    return { ...publicResult, ...(result.compression || context.stats ? { compression: result.compression || context.stats } : {}) };
  } finally { context.close(); }
}
