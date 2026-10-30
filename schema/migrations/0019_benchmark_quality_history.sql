-- Бенчмарк-история (временной ряд): p50, correct, качество (json_valid, task_pass), токены.
CREATE TABLE IF NOT EXISTS free_model_bench_history (
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  measured_at INTEGER NOT NULL,
  tier TEXT NOT NULL,
  p50_ms REAL,
  correct INTEGER,
  json_valid INTEGER,
  task_pass INTEGER,
  out_tokens INTEGER,
  truncated INTEGER
);

CREATE INDEX IF NOT EXISTS idx_bench_history_lookup
  ON free_model_bench_history (provider, model_id, measured_at DESC);

-- 0019: quality_summary on free_model_benchmarks (issue #337).
--
-- ADD COLUMN is not idempotent in SQLite; a duplicate-column error means it is already
-- applied. The deploy workflow runs this migration with `|| true`, same as 0002 / 0005 /
-- 0017, so a re-run is a no-op. The CREATE TABLE / INDEX above are additive and safe.
ALTER TABLE free_model_benchmarks ADD COLUMN quality_summary TEXT;
