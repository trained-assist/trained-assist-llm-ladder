-- Zen Pool payload columns — the ladder calls the pool in-process with a full OpenAI request
-- (system + history + tools), not just a one-line prompt. Stored as JSON so the runner receives
-- exactly what the caller sent. ADD COLUMN is not idempotent in SQLite; a duplicate-column error
-- means it is already applied, so ci.yml runs this with `|| true`.
ALTER TABLE zen_pool_tasks ADD COLUMN messages TEXT;
ALTER TABLE zen_pool_tasks ADD COLUMN tools TEXT;
ALTER TABLE zen_pool_tasks ADD COLUMN tool_calls TEXT;
ALTER TABLE zen_pool_tasks ADD COLUMN usage TEXT;
ALTER TABLE zen_pool_tasks ADD COLUMN finish_reason TEXT;
