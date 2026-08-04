-- 566 — remove the artifacts of the cache-write end-to-end probe (same pattern
-- and same justification as 557: the human_tasks guard's bypass is legitimate
-- only inside a migration, and probe rows must not become training signal).
--
-- What the probe proved before being cleaned away:
--   ask 1: answer at 85% confidence, HELD for review (floor 101 — delivery
--          unchanged) — and answer_cache went 0 → 1. The write that was
--          impossible under `!escalate` now happens.
--   ask 2: same question — the entry was FOUND, correctly NOT auto-served
--          (floor gate), and NOT duplicated (cacheAlreadyCovered). 1 row still.
--
-- The cache row itself is deleted too: it was authored by a probe, and a warm
-- cache should be earned by real traffic, not seeded by tests.

BEGIN;

SET LOCAL app.allow_task_decision = 'on';

DO $cleanup$
DECLARE
  v_convs uuid[] := ARRAY[
    '682aabfb-97f0-4402-bde4-66145ea7d49c',
    '43541cc9-62fd-4d01-a84b-e431f5196ca8'
  ]::uuid[];
  v_tasks int; v_msgs int; v_convd int; v_cache int; v_left int;
BEGIN
  DELETE FROM human_tasks WHERE related_id = ANY(v_convs);
  GET DIAGNOSTICS v_tasks = ROW_COUNT;
  DELETE FROM de_messages WHERE conversation_id = ANY(v_convs);
  GET DIAGNOSTICS v_msgs = ROW_COUNT;
  DELETE FROM activity_events
   WHERE created_at > now() - interval '30 minutes'
     AND text LIKE '%How do trust levels work for a digital employee%';
  DELETE FROM de_conversations WHERE id = ANY(v_convs);
  GET DIAGNOSTICS v_convd = ROW_COUNT;
  DELETE FROM answer_cache
   WHERE tenant_id = '5bb802e1-8e92-4eef-9a7a-ac348785d43f'
     AND question = 'How do trust levels work for a digital employee?';
  GET DIAGNOSTICS v_cache = ROW_COUNT;

  RAISE NOTICE 'probe cleanup: % tasks, % messages, % conversations, % cache row(s)',
               v_tasks, v_msgs, v_convd, v_cache;

  SELECT count(*) INTO v_left FROM de_conversations WHERE id = ANY(v_convs);
  IF v_left <> 0 THEN RAISE EXCEPTION 'CLEANUP FAILED: % probe conversation(s) remain', v_left; END IF;
  SELECT count(*) INTO v_left FROM answer_cache
   WHERE tenant_id = '5bb802e1-8e92-4eef-9a7a-ac348785d43f';
  IF v_left <> 0 THEN RAISE EXCEPTION 'CLEANUP FAILED: % probe cache row(s) remain', v_left; END IF;
END
$cleanup$;

COMMIT;
