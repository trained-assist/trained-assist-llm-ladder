// Context-aware ordering for benchmarked free Go models and round-robin account selection.
// Kept separate from request execution so routing policy can evolve without changing retries.

let freeGoKeyCursor = 0;
let goBenchCache = { db: null, expires: 0, rows: [] };

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
  const candidates = rows
    .filter((r) => !existing.has(r.model_id) && r.model_id.startsWith('opencode-go/') && r.model_id.endsWith('-free'))
    .map((r) => ({ id: r.model_id, score: benchTierResult(r, tier) }))
    .filter((r) => r.score)
    .sort((a, b) => a.score.p50_ms - b.score.p50_ms || a.id.localeCompare(b.id));
  const before = [], after = [];
  for (const c of candidates) (base && c.score.p50_ms < base.p50_ms ? before : after).push(c.id);
  return [...rungs.slice(0, first), ...before, rungs[first], ...after, ...rungs.slice(first + 1)];
}

export async function readGoBenchRows(db) {
  if (!db) return [];
  const now = Date.now();
  if (goBenchCache.db === db && goBenchCache.expires > now) return goBenchCache.rows;
  const { results = [] } = await db.prepare(
    "SELECT b.model_id, b.bench_status, b.benchmark, f.available FROM free_model_benchmarks b "
      + "JOIN free_models f ON f.provider = b.provider AND f.model_id = b.model_id "
      + "WHERE b.provider = 'opencode-go' AND f.available = 1",
  ).all();
  goBenchCache = { db, expires: now + 60_000, rows: results };
  return results;
}

export function resetFreeGoKeyCursor() { freeGoKeyCursor = 0; }

export function nextFreeGoKeyIndex(poolSize) {
  if (poolSize <= 0) return 0;
  const i = freeGoKeyCursor % poolSize;
  freeGoKeyCursor = (freeGoKeyCursor + 1) % poolSize;
  return i;
}
