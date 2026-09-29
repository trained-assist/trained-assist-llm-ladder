-- One row per /v1/chat/completions call, keyed by the caller's trace ids.
-- All trace columns are nullable — callers that send no trace headers are still logged.
CREATE TABLE IF NOT EXISTS ladder_calls (
  ts INTEGER NOT NULL,
  trace_id TEXT,
  run_id TEXT,
  user_id TEXT,
  chat_id TEXT,
  session_id TEXT,
  ladder TEXT NOT NULL,
  ok INTEGER NOT NULL,
  model TEXT,
  ms INTEGER NOT NULL,
  attempts TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ladder_calls_trace ON ladder_calls (trace_id, ts);
CREATE INDEX IF NOT EXISTS idx_ladder_calls_user ON ladder_calls (user_id, ts);
CREATE INDEX IF NOT EXISTS idx_ladder_calls_session ON ladder_calls (session_id, ts);