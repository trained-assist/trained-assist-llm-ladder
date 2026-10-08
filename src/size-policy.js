// Size policy — how big the request is, what a rung may take, and how many to race.
//
// Everything here is measured, not guessed; the numbers say where and when.
//
// ── Ceilings ────────────────────────────────────────────────────────────────────────────────
// A rung whose window is smaller than the request cannot answer, and the refusal is NOT cheap:
// `opencode-go/*` at ~98K tokens answers 200, at ~123K answers
// `429 "Upstream request failed: Endpoint is unavailable."` and rotates through every key —
// 48 s of wall clock, three keys burned, and the caller still has no answer (measured
// 2026-10-07). So the ladder must not try it in the first place.
//
// zen-rings is governed by a much earlier gate — `ZEN_MAX_INPUT_BYTES` (50 KB) in the ring —
// so its window never comes into play here; `opencode-zen` is retired (README) and keeps its
// entry only so a revived relay is still measured correctly.
export const INPUT_CEILING_TOKENS = {
  'opencode-go/': 100_000,
  'opencode-zen/': 1_000_000,
};

// Anything not named above: no ceiling enforced. Unknown is the safe answer — a wrongly refusing
// rung costs a hop, a wrongly accepting one costs the whole watchdog.
export const NO_CEILING = null;

// ── Bands ───────────────────────────────────────────────────────────────────────────────────
// The owner's plan (2026-10-07): a small context deserves a small budget and a fast kill; a
// mid-size request is raced twice; a large one three times. Tokens, because that is what the
// provider counts and what every cap above is expressed in.
export const BANDS = Object.freeze([
  // <2K — один ранг, короткий бюджет. 0.4 (= 8 с при дефолтных 20) оказался впритык: замер
  // 2026-10-08 на естественном промпте дал longcat 7.0 / 8.6 с, и одна попытка из трёх
  // обрывалась ровно на потолке. 0.6 (= 12 с) остаётся на 40 % короче дефолта, но уже выше
  // наблюдаемой латентности — «убить быстро» имеет смысл только если модель успевает ответить
  // здоровой.
  { max: 2_000, count: 1, timeoutFactor: 0.6 },
  { max: 32_000, count: 2, timeoutFactor: 1 },    //  2–32K — гоним две
  { max: 128_000, count: 3, timeoutFactor: 1 },   // 32–128K — гоним три
  { max: Infinity, count: 1, timeoutFactor: 1 },  //  >128K — один (потолки выше уже отсекли лишнее)
]);

// Cheap pre-flight estimate: 4 chars/token is the usual English ratio and the same pessimism
// `estTokens` in scripts/zen-client.mjs uses (there /3.5 for a pre-flight cap check — over-
// estimating only ever sends a slightly-too-big budget, never a400 after the wait).
export function estimateTokens(body) {
  const m = body?.messages;
  if (!Array.isArray(m) || !m.length) return 0;
  try { return Math.ceil(JSON.stringify(m).length / 4); } catch { return 0; }
}

// Operational sandbox quota estimate (v1). This is deliberately distinct from estimateTokens,
// which selects latency/context bands and retains its existing behavior. Count UTF-8 bytes in the
// exact serialized message array, convert at 3 bytes/token (conservative for mixed English/Russian
// prose), then add a 30% safety margin. This is a quota estimate, not provider billing telemetry.
export const BUDGET_ESTIMATOR_VERSION = 'utf8-3bytes-plus-30pct-v1';
export const BUDGET_INPUT_MAX_BYTES = 256 * 1024;
export const BUDGET_INPUT_MARGIN = 1.3;

export function estimateBudgetInput(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return { ok: false, reason: 'messages_required' };
  let serialized;
  try { serialized = JSON.stringify(messages); } catch { return { ok: false, reason: 'invalid_messages' }; }
  if (typeof serialized !== 'string') return { ok: false, reason: 'invalid_messages' };
  const inputBytes = new TextEncoder().encode(serialized).byteLength;
  if (inputBytes > BUDGET_INPUT_MAX_BYTES) return { ok: false, reason: 'input_too_large', inputBytes, maxBytes: BUDGET_INPUT_MAX_BYTES };
  const estimatedTokens = Math.ceil((inputBytes / 3) * BUDGET_INPUT_MARGIN);
  return { ok: true, version: BUDGET_ESTIMATOR_VERSION, inputBytes, estimatedTokens };
}

// Ceiling for this rung, or null when nothing is known.
export function ceilingFor(model) {
  for (const [prefix, cap] of Object.entries(INPUT_CEILING_TOKENS)) {
    if (String(model).startsWith(prefix)) return cap;
  }
  return NO_CEILING;
}

export function fits(model, tokens) {
  const cap = ceilingFor(model);
  return cap === null || tokens <= cap;
}

// The band for a token count: { count, timeoutFactor }.
export function hedgePlan(tokens) {
  const band = BANDS.find((b) => tokens < b.max) || BANDS[BANDS.length - 1];
  return { count: band.count, timeoutFactor: band.timeoutFactor };
}
