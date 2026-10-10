-- Quick real-response measurements for free OpenCode Go rungs. A model is selectable for a
-- context tier only after two non-empty completions succeeded at that tier.
CREATE TABLE IF NOT EXISTS free_model_benchmarks (
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  bench_status TEXT NOT NULL,
  benchmark TEXT,
  measured_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model_id)
);

CREATE INDEX IF NOT EXISTS idx_go_free_bench_status
  ON free_model_benchmarks (provider, bench_status, measured_at DESC);
