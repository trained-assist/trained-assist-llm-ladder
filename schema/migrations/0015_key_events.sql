CREATE TABLE IF NOT EXISTS identity_key_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor_user_id TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  key_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  previous_status TEXT NOT NULL,
  new_status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_identity_key_events_key ON identity_key_events (key_hash, ts);
