-- User-owned OAuth connections for the shared identity plane.
-- Credential payloads are envelope-encrypted by the MCP Worker before storage.
CREATE TABLE IF NOT EXISTS identity_oauth_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES identity_users(user_id),
  provider TEXT NOT NULL,
  verifier_ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_identity_oauth_states_expiry
  ON identity_oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS identity_user_credentials (
  user_id TEXT NOT NULL REFERENCES identity_users(user_id),
  profile_id TEXT NOT NULL DEFAULT 'default',
  provider TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  key_version TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, profile_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_identity_user_credentials_user
  ON identity_user_credentials(user_id, provider);
