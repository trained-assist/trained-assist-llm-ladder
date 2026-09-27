// One chat completion walked down a named model ladder: OpenCode Go rungs first, paid OpenRouter
// last. Non-streaming, for small service calls (buttons, formatting, classifiers, summaries)
// where reliability beats everything else.
//
//   * model health — a flaky / limited rung is skipped for everyone (shared state in `store`);
//   * Go key pool — a key-level fault rotates to the spare key and the rung is retried; once
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

export function readPool(env) {
  return String(env.OPENCODE_GO_API_KEYS || env.OPENCODE_GO_API_KEY || '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
}

// "deepseek" or "deepseek:review" → rungs, null for an unknown ladder.
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

export function keyFaultOf(errorText) {
  const t = String(errorText || '');
  if (DEAD_KEY_RE.test(t)) return { dead: true, ttlMs: KEY_DEAD_TTL_MS };
  if (KEY_QUOTA_RE.test(t)) return { dead: false, ttlMs: KEY_QUOTA_TTL_MS };
  return null;
}

function failureClass(errorText) {
  const v = classifyError(errorText);
  if (v && v.class === 'quota') return { cls: 'quota', retryAfterMs: v.ttlMs };
  if (v && v.class === 'config') return { cls: 'config' };
  return { cls: 'transient' };
}

function upstreamRequest(env, model, body, keyIndex) {
  const isGo = model.startsWith('opencode-go/');
  const pool = readPool(env);
  const key = isGo ? pool[keyIndex] : env.OPENROUTER_API_KEY;
  if (!key) return null;
  const headers = { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
  if (isGo) headers['x-opencode-session'] = `ladder-${crypto.randomUUID()}`; // Go 400s without it
  const upstream = {
    ...body,
    model: model.replace(/^opencode-go\/|^openrouter\//, ''),
    stream: false,
    max_tokens: Math.max(Number(body.max_tokens) || 0, MIN_TOKENS),
  };
  delete upstream.stream_options;
  const base = isGo ? (env.OPENCODE_GO_BASE_URL || 'https://opencode.ai/zen/go/v1') : (env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1');
  return { url: `${base}/chat/completions`, headers, body: upstream };
}

async function attempt(env, model, body, keyIndex, { timeoutMs, wantJson, fetchImpl }) {
  const req = upstreamRequest(env, model, body, keyIndex);
  if (!req) return { ok: false, skip: true, error: 'no key' };
  let res;
  try {
    res = await fetchImpl(req.url, {
      method: 'POST', headers: req.headers, body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, error: `fetch failed: ${e.message}` };
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status}: ${String(errText).slice(0, 300)}` };
  }
  const data = await res.json().catch(() => null);
  const content = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!content) return { ok: false, error: 'empty answer' };
  if (wantJson && parseJson(content) === undefined) return { ok: false, error: 'invalid JSON' };
  return { ok: true, data, content };
}

/**
 * @param {object} body   OpenAI chat.completions body; `model` = ladder name ("deepseek",
 *                        "deepseek:review"). Always answered non-streaming.
 * @param {object} ctx    { env, config, store, fetchImpl, timeoutMs=20000, totalTimeoutMs, now }
 *   store (async): snapshot() → { health: {model: {skipUntil}}, keys: {active, exhausted: {i: until}} }
 *                  recordFailure(model, {cls, retryAfterMs}), recordSuccess(model),
 *                  rotateKey(poolSize, ttlMs) → {rotated, toIndex} | {rotated:false, retryAt},
 *                  park(models, untilMs)
 * @returns {Promise<{ok:true, model, data, content, attempts} | {ok:false, status, error, attempts}>}
 */
export async function run(body, { env, config, store, fetchImpl = fetch, timeoutMs = 20000, totalTimeoutMs = null } = {}) {
  const all = rungsFor(config, body && body.model);
  if (!all) return { ok: false, status: 404, error: `unknown ladder: ${body && body.model}`, attempts: [] };
  const pool = readPool(env);
  const hasKey = m => (m.startsWith('opencode-go/') ? pool.length > 0 : !!env.OPENROUTER_API_KEY);
  const keyed = all.filter(hasKey);
  if (!keyed.length) return { ok: false, status: 503, error: 'no provider key configured', attempts: [] };

  const snap = await store.snapshot();
  const now = Date.now();
  const skipped = m => { const h = snap.health[m]; return !!h && (h.skipUntil === null || h.skipUntil > now); };
  // If health skips every keyed rung, try them all anyway — a stale skip must not black-hole it.
  const live = keyed.filter(m => !skipped(m));
  const rungs = live.length ? live : keyed;
  let keyIndex = Math.min(snap.keys.active || 0, Math.max(0, pool.length - 1));
  let goParked = false;

  const wantJson = body.response_format && body.response_format.type === 'json_object';
  const deadline = totalTimeoutMs ? now + totalTimeoutMs : Infinity;
  const attempts = [];
  for (const model of rungs) {
    const isGo = model.startsWith('opencode-go/');
    if (isGo && goParked) continue;
    const left = deadline - Date.now();
    if (left < 500) { attempts.push({ model, outcome: 'skipped', error: 'time budget spent' }); break; }
    const opts = { timeoutMs: Math.min(timeoutMs, left), wantJson, fetchImpl };
    let r = await attempt(env, model, body, keyIndex, opts);
    if (r.skip) continue;
    for (let k = 0; !r.ok && isGo && k < pool.length; k++) {
      const fault = keyFaultOf(r.error);
      if (!fault) break;
      const rot = await store.rotateKey(pool.length, fault.ttlMs);
      if (!rot.rotated) {
        await store.park(all.filter(m => m.startsWith('opencode-go/')), rot.retryAt);
        goParked = true;
        break;
      }
      attempts.push({ model, outcome: 'key-rotated', error: r.error });
      keyIndex = rot.toIndex;
      r = await attempt(env, model, body, keyIndex, opts);
    }
    if (r.ok) {
      await store.recordSuccess(model);
      attempts.push({ model, outcome: 'ok' });
      return { ok: true, model, data: r.data, content: r.content, attempts };
    }
    attempts.push({ model, outcome: 'error', error: r.error });
    if (!goParked) await store.recordFailure(model, failureClass(r.error));
  }
  return { ok: false, status: 502, error: 'every rung failed', attempts };
}
