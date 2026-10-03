-- 0003: free-model inventory (issue #111). One row per (provider, model_id) — the full ladder rung
-- id, so the row joins to config/prices.json / config/contexts.json without a mapping table.
-- `available` = present in the latest catalog (0 = gone, kept for history — never deleted).
-- Prices are per 1M tokens, matching config/prices.json. probe_status/probed_at are the light
-- availability ping (ok | limited | not_found | http_<n> | error | skipped).
CREATE TABLE IF NOT EXISTS free_models (
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  name TEXT,
  context INTEGER,
  price_in REAL NOT NULL DEFAULT 0,
  price_out REAL NOT NULL DEFAULT 0,
  price_cached REAL NOT NULL DEFAULT 0,
  owned_by TEXT,
  description TEXT,
  in_ladder INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  available INTEGER NOT NULL DEFAULT 1,
  probe_status TEXT,
  probed_at INTEGER,
  PRIMARY KEY (provider, model_id)
);

CREATE INDEX IF NOT EXISTS idx_free_models_last_seen ON free_models (last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_free_models_available ON free_models (available, provider);
