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
  return { health: {}, keys: { active: 0, exhausted: {} } };
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

// Park the active key for ttlMs and move to the next usable one.
// → { rotated: true, fromIndex, toIndex } | { rotated: false, retryAt }
export function rotateKey(state, poolSize, ttlMs, now = Date.now()) {
  const exhausted = state.keys.exhausted || {};
  for (const k of Object.keys(exhausted)) if (!(exhausted[k] > now)) delete exhausted[k];
  const from = Math.min(state.keys.active || 0, Math.max(0, poolSize - 1));
  exhausted[from] = now + ttlMs;
  state.keys.exhausted = exhausted;
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

// In-memory store with the same async interface as the Durable Object — tests, local runs.
export function memoryStore(poolSize = 0, initial = emptyState()) {
  const state = initial;
  return {
    state,
    async snapshot() { return snapshot(state, poolSize); },
    async recordFailure(model, f) { recordFailure(state, model, f); },
    async recordSuccess(model) { recordSuccess(state, model); },
    async rotateKey(size, ttlMs) { return rotateKey(state, size, ttlMs); },
    async park(models, untilMs) { park(state, models, untilMs); },
  };
}
