-- 0002: cached input tokens (issue #94). D1/SQLite has no ADD COLUMN IF NOT EXISTS, so the
-- deploy job runs this with an error-tolerant step; a duplicate-column error means it is
-- already applied and must not fail the deploy.
ALTER TABLE ladder_calls ADD COLUMN tokens_cached INTEGER;
