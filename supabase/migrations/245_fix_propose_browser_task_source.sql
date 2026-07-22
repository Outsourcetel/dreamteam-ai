-- 245_fix_propose_browser_task_source.sql
-- ============================================================================
-- BUGFIX (found by the first live E2E run, 2026-07-22): propose_browser_task
-- (mig 241) inserts human_tasks.source = 'human', but mig 011's constraint only
-- allows ('de','chat','system') → admin-launched browser tasks fail with
-- human_tasks_source_check. 'human' is a legitimate source (a person launched
-- it from the UI) — widen the vocabulary rather than mislabel the row.
-- GLOBAL, additive, idempotent.
-- ============================================================================
ALTER TABLE human_tasks DROP CONSTRAINT IF EXISTS human_tasks_source_check;
ALTER TABLE human_tasks ADD CONSTRAINT human_tasks_source_check
  CHECK (source in ('de', 'chat', 'system', 'human'));
