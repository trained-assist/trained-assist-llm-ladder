-- Keep bounded status observations so free-model availability can be measured over time.
-- Provider response bodies, prompts, keys and probe reasons are intentionally not retained.
CREATE TABLE IF NOT EXISTS free_model_probe_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  status TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_free_model_probe_history_window
  ON free_model_probe_history (checked_at, provider, model_id);

CREATE INDEX IF NOT EXISTS idx_free_model_probe_history_model
  ON free_model_probe_history (provider, model_id, checked_at DESC);
