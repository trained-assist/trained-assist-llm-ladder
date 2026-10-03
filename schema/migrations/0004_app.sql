-- 0004: caller-side sub-task tag (issue #107). `x-ladder-app` (the agent's `source:` value —
-- gtd-intent, tg-format, session-summary, failure-classifier, …) is what says WHICH concrete
-- sub-task a service call belongs to. Until now it went only into OpenRouter attribution
-- headers, so our own log could not answer "which sub-task burns the money" — the ladder
-- name is only `service` for all ~20 of them. Same ALTER-only shape as 0002 (0003 is the free_models table, a parallel change): the deploy job
-- runs it error-tolerantly (duplicate-column error = already applied).
ALTER TABLE ladder_calls ADD COLUMN app TEXT;
