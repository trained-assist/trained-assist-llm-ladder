-- Task-scoped reservations for the sandbox hard-budget path.
CREATE TABLE IF NOT EXISTS ladder_budget_tasks (
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  max_tokens INTEGER NOT NULL CHECK (max_tokens > 0),
  reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
  spent_tokens INTEGER NOT NULL DEFAULT 0 CHECK (spent_tokens >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, run_id)
);

CREATE TABLE IF NOT EXISTS ladder_budget_reservations (
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  reserved_tokens INTEGER NOT NULL CHECK (reserved_tokens > 0),
  usage_tokens INTEGER CHECK (usage_tokens >= 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'settled', 'unknown')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, run_id, reservation_id),
  FOREIGN KEY (task_id, run_id) REFERENCES ladder_budget_tasks (task_id, run_id)
);

CREATE INDEX IF NOT EXISTS idx_ladder_budget_task_status
  ON ladder_budget_tasks (status, updated_at);
