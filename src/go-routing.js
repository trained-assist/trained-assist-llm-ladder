// Context-aware ordering for benchmarked free Go models and round-robin account selection.
// Kept separate from request execution so routing policy can evolve without changing retries.

let freeGoKeyCursor = 0;
let benchCache = { db: null, expires: 0, rows: [] };

function goBenchTier(tokens) {
  return tokens < 2_048 ? 'small' : tokens < 16_384 ? 'medium' : 'large';
}

function benchTierResult(row, tier) {
  try {
    const b = typeof row.benchmark === 'string' ? JSON.parse(row.benchmark) : row.benchmark;
    const s = b?.tiers?.[tier];
    return row.bench_status === 'ready' && row.available && s?.attempts >= 2 && s?.successes >= 2
      && Number.isFinite(s.p50_ms) ? s : null;
  } catch { return null; }
}

export function orderBenchmarkedGoRungs(rungs, rows, tokens) {
  const tier = goBenchTier(tokens);
  const first = rungs.findIndex((m) => m.startsWith('opencode-go/') && m.endsWith('-free'));
  if (first < 0) return rungs;
  const existing = new Set(rungs);
  const base = benchTierResult(rows.find((r) => r.model_id === rungs[first]), tier);
  // Fallback: when the incumbent has no valid benchmark for this tier, treat it as
  // "unmeasured" (infinite slowness) so measured candidates are still promoted
  // ahead of it instead of being blocked. The incumbent stays in the ladder as a
  // fallback (it is never removed here) — only its anchor strength is dropped.
  // See issue review: "нет бенчмарка → считать неизмеренным и пропускать".
  const baseP50 = base ? base.p50_ms : Infinity;
  const candidates = rows
    .filter((r) => !existing.has(r.model_id) && r.model_id.startsWith('opencode-go/') && r.model_id.endsWith('-free'))
    .map((r) => ({ id: r.model_id, score: benchTierResult(r, tier) }))
    .filter((r) => r.score)
    .sort((a, b) => a.score.p50_ms - b.score.p50_ms || a.id.localeCompare(b.id));
  const before = [], after = [];
  for (const c of candidates) (c.score.p50_ms < baseP50 ? before : after).push(c.id);
  return [...rungs.slice(0, first), ...before, rungs[first], ...after, ...rungs.slice(first + 1)];
}

// ── OpenRouter fast lane ──────────────────────────────────────────────────────────
// The OpenRouter free block is ordered by MEASURED speed, the same idea as the Go block: the
// fastest measured model leads and the next one is the reserve. When two models answer within a
// small margin the speed is a tie, so the more capable one takes the first slot.
//
// "More capable" is a PROXY, not a quality benchmark: the bench counts how often the model
// followed the instruction (answered "ready" when asked), and the catalog context window is the
// second signal. A model that has to burn the whole token budget to answer is never put in
// front of the ladder — its reasoning floor is unknown there (issue #38).
export const OR_TIE_RATIO = 1.25;
export const OR_TIE_MS = 500;
export const BENCH_MAX_TOKENS = 1500;

const isOpenrouterFree = (m) => String(m || '').startsWith('openrouter/') && String(m || '').endsWith(':free');

function benchCorrect(score) {
  const attempts = Number(score?.attempts) || 0;
  const correct = Number(score?.correct) || 0;
  return attempts ? correct / attempts : 0;
}

// A model may only JOIN the ladder (it is not in config/ladders.json) when its answer fits into
// the token budget comfortably — a model that eats the whole budget is a reasoning model and
// would come back empty on the ladder's floor.
function benchInjectable(score) {
  if (score?.truncated) return false;
  const out = Number(score?.out_tokens);
  if (Number.isFinite(out) && out >= 0.8 * BENCH_MAX_TOKENS) return false;
  return true;
}

export function orderOpenrouterRungs(rungs, rows, tokens) {
  const tier = goBenchTier(tokens);
  const slots = rungs.filter(isOpenrouterFree);
  if (!slots.length) return rungs;
  const block = new Set(slots);

  const candidates = [];
  for (const row of rows) {
    if (row.provider !== 'openrouter' || !isOpenrouterFree(row.model_id)) continue;
    const score = benchTierResult(row, tier);
    if (!score) continue;
    if (!block.has(row.model_id) && !benchInjectable(score)) continue;
    candidates.push({ model: row.model_id, score, context: Number(row.context) || 0, correct: benchCorrect(score) });
  }
  if (!candidates.length) return rungs;

  const fastest = Math.min(...candidates.map((c) => c.score.p50_ms));
  const band = fastest * OR_TIE_RATIO + OR_TIE_MS;
  const near = candidates.filter((c) => c.score.p50_ms <= band);
  const byQuality = (a, b) => (b.correct - a.correct) || (b.context - a.context)
    || (a.score.p50_ms - b.score.p50_ms) || a.model.localeCompare(b.model);
  const primary = [...near].sort(byQuality)[0];
  const rest = candidates.filter((c) => c !== primary)
    .sort((a, b) => (a.score.p50_ms - b.score.p50_ms) || a.model.localeCompare(b.model));

  const ordered = [primary.model, ...rest.map((c) => c.model)];
  const measured = new Set(ordered);
  const blockModels = [...ordered, ...slots.filter((m) => !measured.has(m))];

  // The block keeps its place in the ladder: the free OpenRouter rungs stay where they are, so
  // they remain AFTER the other free providers and BEFORE the paid tail.
  const out = [];
  let inserted = false;
  for (const model of rungs) {
    if (isOpenrouterFree(model)) {
      if (!inserted) { out.push(...blockModels); inserted = true; }
      continue;
    }
    out.push(model);
  }
  return out;
}

// Go block first (unchanged rules), then the OpenRouter fast lane.
export function orderBenchmarkedRungs(rungs, rows, tokens) {
  return orderOpenrouterRungs(orderBenchmarkedGoRungs(rungs, rows, tokens), rows, tokens);
}

export async function readBenchRows(db) {
  if (!db) return [];
  const now = Date.now();
  if (benchCache.db === db && benchCache.expires > now) return benchCache.rows;
  const { results = [] } = await db.prepare(
    "SELECT b.provider, b.model_id, b.bench_status, b.benchmark, f.available, f.context "
      + "FROM free_model_benchmarks b "
      + "JOIN free_models f ON f.provider = b.provider AND f.model_id = b.model_id "
      + "WHERE b.provider IN ('opencode-go', 'openrouter')",
  ).all();
  benchCache = { db, expires: now + 60_000, rows: results };
  return results;
}

export async function readGoBenchRows(db) {
  const rows = await readBenchRows(db);
  return rows.filter((r) => r.provider === 'opencode-go' && r.available);
}

export function resetFreeGoKeyCursor() { freeGoKeyCursor = 0; }

export function nextFreeGoKeyIndex(poolSize) {
  if (poolSize <= 0) return 0;
  const i = freeGoKeyCursor % poolSize;
  freeGoKeyCursor = (freeGoKeyCursor + 1) % poolSize;
  return i;
}

// Round-robin cursor over the OpenRouter credential pool. Several OpenRouter keys share one
// account, so spreading the paid tail across them evens the per-key rate limit; with a single
// key this is always 0 (the previous single-key behaviour).
let openrouterKeyCursor = 0;

export function nextOpenrouterKeyIndex(poolSize) {
  if (poolSize <= 0) return 0;
  const i = openrouterKeyCursor % poolSize;
  openrouterKeyCursor = (openrouterKeyCursor + 1) % poolSize;
  return i;
}

export function resetOpenrouterKeyCursor() { openrouterKeyCursor = 0; }

// Next OpenRouter account that is NOT parked by its own limit (issue #297).
//
// The free allowance is counted per account, so a capped account must be stepped over until its
// reset instead of being asked again. The round-robin cursor only provides the STARTING point —
// parked accounts are skipped, and the result is -1 when every account of the pool is parked
// (the ladder then skips the rung without a provider request).
//
// @param {number} poolSize size of the OpenRouter credential pool
// @param {number} cursor   starting index (the round-robin position)
// @param {object} parked   { [index]: <epoch ms until usable> } — live parks only
// @param {number} now      epoch ms
// @returns {number} usable account index, or -1 when the whole pool is parked
export function nextUsableOpenrouterIndex(poolSize, cursor, parked, now = Date.now()) {
  if (poolSize <= 0) return -1;
  const map = parked || {};
  const start = Number.isInteger(cursor) ? cursor : 0;
  for (let step = 0; step < poolSize; step++) {
    const i = ((start + step) % poolSize + poolSize) % poolSize;
    if (!(map[i] > now)) return i;
  }
  return -1;
}
