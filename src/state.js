// Ladder state transitions — pure functions over a plain object, shared by the Durable Object
// (src/state-do.js) and the in-memory store used in tests.
//
//   state = {
//     health: { [model]: { failures, firstFailureAt, lastFailureAt, class, skipUntil } },
//                          // skipUntil: epoch ms, or null = config-class (never auto-clears)
//     keys:   { active: <pool index>, exhausted: { [index]: <epoch ms until usable> } },
//   }
//
// Backoff mirrors trained-assist-agent's model-health.js: transient failures skip a model for
// base × multiplier^(n-1) (15s → 30s → 60s … cap 5 min) — counted PER MODEL, so every rung starts
// its own 15s-first schedule; failures older than the window stop counting.

export const DEFAULT_BACKOFF = Object.freeze({ baseMs: 15000, multiplier: 2, capMs: 300000, failureWindowMs: 900000 });

export function emptyState() {
  return { health: {}, keys: { active: 0, exhausted: {} }, pins: {} };
}

export function backoffFor(failures, policy = DEFAULT_BACKOFF) {
  const n = Math.max(1, Number(failures) || 1);
  return Math.min(policy.baseMs * Math.pow(policy.multiplier, n - 1), policy.capMs);
}

export function recordFailure(state, model, { cls = 'transient', retryAfterMs } = {}, now = Date.now(), policy = DEFAULT_BACKOFF) {
  let e = state.health[model];
  if (!e || (e.firstFailureAt && now - e.firstFailureAt > policy.failureWindowMs)) e = { failures: 0, firstFailureAt: now };
  e.failures += 1;
  e.lastFailureAt = now;
  e.class = cls;
  if (cls === 'config') e.skipUntil = null;
  else if (cls === 'transient') e.skipUntil = now + backoffFor(e.failures, policy);
  else e.skipUntil = now + (Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : backoffFor(e.failures, policy));
  state.health[model] = e;
  return state;
}

export function recordSuccess(state, model) {
  delete state.health[model];
  return state;
}

// Skip `models` until `untilMs` (all Go keys parked). At least a minute, so a key whose TTL is
// about to lapse doesn't bounce the ladder straight back onto a gateway that just failed.
export function park(state, models, untilMs, now = Date.now()) {
  const until = Math.max(untilMs, now + 60 * 1000);
  for (const m of models) {
    const e = state.health[m] || { failures: 0, firstFailureAt: now };
    state.health[m] = { ...e, failures: e.failures + 1, lastFailureAt: now, class: 'quota', skipUntil: until };
  }
  return state;
}

// Park the key that FAILED (`failedIndex`, default: the active one) for ttlMs and move to the next
// usable one. → { rotated: true, fromIndex, toIndex } | { rotated: false, retryAt }
//
// Concurrency (incident 2026-09-29): calls A and B both start on key 0; A hits the weekly limit and
// rotates to key 1; B then hits the same limit on key 0. Parking "the active key" at that point
// parked the HEALTHY key 1 for 6h and took Go down for the whole fleet with a working key in the
// pool. The failed key is what gets parked; if another call already moved `active` onto a usable
// key, that counts as rotated.
export function rotateKey(state, poolSize, ttlMs, now = Date.now(), failedIndex = null) {
  const exhausted = state.keys.exhausted || {};
  for (const k of Object.keys(exhausted)) if (!(exhausted[k] > now)) delete exhausted[k];
  const last = Math.max(0, poolSize - 1);
  const active = Math.min(state.keys.active || 0, last);
  const from = Number.isInteger(failedIndex) && failedIndex >= 0 && failedIndex <= last ? failedIndex : active;
  exhausted[from] = now + ttlMs;
  state.keys.exhausted = exhausted;
  if (active !== from && !(exhausted[active] > now)) return { rotated: true, fromIndex: from, toIndex: active };
  for (let step = 1; step < poolSize; step++) {
    const i = (from + step) % poolSize;
    if (!(exhausted[i] > now)) {
      state.keys.active = i;
      return { rotated: true, fromIndex: from, toIndex: i };
    }
  }
  let retryAt = Infinity;
  for (let i = 0; i < poolSize; i++) retryAt = Math.min(retryAt, exhausted[i] || now);
  return { rotated: false, retryAt: Number.isFinite(retryAt) ? retryAt : now + ttlMs };
}

// Ops lever: clear every Go key park and every Go rung skip (e.g. a key was parked by mistake or a
// limit was lifted early). OpenRouter health and conversation pins are left alone.
export function resetKeys(state) {
  state.keys = { active: 0, exhausted: {} };
  for (const m of Object.keys(state.health)) if (m.startsWith('opencode-go/')) delete state.health[m];
  return state;
}

// Read view: expired key exhaustion cleared; the active key moved off a parked one if another is
// usable (e.g. after its TTL lapsed).
export function snapshot(state, poolSize, now = Date.now()) {
  const exhausted = { ...(state.keys.exhausted || {}) };
  for (const k of Object.keys(exhausted)) if (!(exhausted[k] > now)) delete exhausted[k];
  let active = state.keys.active || 0;
  if (poolSize > 0 && exhausted[active] > now) {
    for (let i = 0; i < poolSize; i++) if (!(exhausted[i] > now)) { active = i; break; }
  }
  return { health: state.health, keys: { active, exhausted } };
}

// ── Sticky rung pins (epic #17) ───────────────────────────────────────────────
// A pin remembers the rung that served ONE conversation (keyed by Kh = sha256(conversation id))
// so that rung's provider-side prompt cache keeps working turn after turn. One conversation, one
// pin; the pin lives separately from the health blob and only expires by TTL / context overflow.
//
//   pin = { rung: <full rung id>, lastUsedAt: <epoch ms> }
//   state.pins = { [Kh]: pin }                    // in-memory view (tests)
//   storage key 'pin:<Kh>' → pin                  // Durable Object (src/state-do.js)
export const PIN_TTL_MS = 30 * 60 * 1000; // ≥ 10-min idle window of the OpenRouter prompt cache
export const PIN_CAP = 5000; // safety net — TTL is the real limiter

// A pin VALUE is alive while its last touch is within the TTL window.
export function pinFresh(p, now = Date.now(), ttl = PIN_TTL_MS) {
  return !!(p && p.rung && now - p.lastUsedAt <= ttl);
}

// Next pin value for a write, or null when the write is throttled away: a hit on the SAME rung
// within ttl/2 refreshes nothing, so a healthy success costs no storage write (today's hot path
// does not write on a healthy first-rung answer and must not start now).
export function pinDirty(prev, rung, now = Date.now(), ttl = PIN_TTL_MS, throttleMs = null) {
  const t = throttleMs ?? Math.max(1, Math.floor(ttl / 2));
  if (prev && prev.rung === rung && now - prev.lastUsedAt < t) return null;
  return { rung, lastUsedAt: now };
}

// Count and group a pins map, pruning expired entries in place (used by memoryStore and the DO
// sweep). Returns { count, byRung: { [rung]: n } }.
export function pinStats(pins, now = Date.now(), ttl = PIN_TTL_MS) {
  const byRung = {};
  let count = 0;
  if (pins) for (const [k, p] of Object.entries(pins)) {
    if (!pinFresh(p, now, ttl)) { delete pins[k]; continue; }
    count++;
    byRung[p.rung] = (byRung[p.rung] || 0) + 1;
  }
  return { count, byRung };
}

// In-memory store with the same async interface as the Durable Object — tests, local runs.
export function memoryStore(poolSize = 0, initial = emptyState()) {
  const state = initial;
  return {
    state,
    async snapshot(poolSizeArg, pinKey) {
      const s = snapshot(state, poolSizeArg ?? poolSize);
      const p = pinKey ? state.pins[String(pinKey)] : null;
      return { ...s, pin: pinFresh(p) ? p : null };
    },
    async recordFailure(model, f, extra) {
      recordFailure(state, model, f);
      if (extra && extra.pinRemove) delete state.pins[String(extra.pinRemove.pinKey)];
    },
    async recordSuccess(model, extra) {
      recordSuccess(state, model);
      if (extra && extra.pin) {
        const k = String(extra.pin.pinKey);
        const v = pinDirty(state.pins[k], extra.pin.rung);
        if (v) state.pins[k] = v;
      }
    },
    async rotateKey(size, ttlMs, failedIndex) { return rotateKey(state, size, ttlMs, Date.now(), failedIndex); },
    async resetKeys() { resetKeys(state); },
    async park(models, untilMs) { park(state, models, untilMs); },
    async pinStats() { return pinStats(state.pins); },
  };
}
