-- 569 — remove the two conversations from the auto-send verification probes.
--
-- ONLY MINE. The other ~32 conversations in that window are the certification
-- exam's — one per golden question, across both runs — and they are the
-- EVIDENCE that the exam actually asked and answered. Deleting a
-- certification's trail to tidy the list would be rewriting the record to look
-- clean, which is the one thing this codebase must never do. They stay.
--
-- (Worth knowing, and flagged rather than silently fixed: the exam leaves real
-- de_conversations rows in the workspace. That is defensible — an exam answer
-- IS a real answer through the real pipeline — but a 16-question run appearing
-- in the Support Inbox alongside customer threads is a product question, not a
-- cleanup task.)
--
-- What the probes proved, before being cleaned away:
--   "What does the audit trail record?"            → 95% confidence,
--                                                    needs_escalation FALSE,
--                                                    held_for_approval FALSE
--                                                    = AUTO-SENT, unassisted.
--   "What is the office wifi password for Tokyo?"  → 0% confidence,
--                                                    needs_escalation TRUE
--                                                    = refused and routed to a
--                                                    human, WITH auto-send on.
-- Autonomy that cannot say "not mine" is not autonomy, it is a liability. The
-- second probe is the one that made the first one safe to keep.

BEGIN;

SET LOCAL app.allow_task_decision = 'on';

DO $cleanup$
DECLARE
  v_convs uuid[] := ARRAY[
    'd2988d86-e930-416b-819d-b5aa6a1b3379',  -- probe 1: answerable  → auto-sent
    '97ea3622-3220-4d86-83f9-338da6f9f482'   -- probe 2: unanswerable → escalated
  ]::uuid[];
  v_tasks int; v_msgs int; v_convd int; v_left int;
BEGIN
  DELETE FROM human_tasks WHERE related_id = ANY(v_convs);
  GET DIAGNOSTICS v_tasks = ROW_COUNT;
  DELETE FROM de_messages WHERE conversation_id = ANY(v_convs);
  GET DIAGNOSTICS v_msgs = ROW_COUNT;
  DELETE FROM activity_events
   WHERE created_at > now() - interval '30 minutes'
     AND (text ILIKE '%audit trail record%' OR text ILIKE '%Tokyo branch%');
  DELETE FROM de_conversations WHERE id = ANY(v_convs);
  GET DIAGNOSTICS v_convd = ROW_COUNT;

  RAISE NOTICE 'probe cleanup: % tasks, % messages, % conversations', v_tasks, v_msgs, v_convd;

  SELECT count(*) INTO v_left FROM de_conversations WHERE id = ANY(v_convs);
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'CLEANUP FAILED: % probe conversation(s) remain', v_left;
  END IF;

  -- The exam's evidence must NOT have been swept up with it.
  SELECT count(*) INTO v_left FROM de_conversations
   WHERE tenant_id = '5bb802e1-8e92-4eef-9a7a-ac348785d43f'
     AND created_at > now() - interval '30 minutes';
  IF v_left < 10 THEN
    RAISE EXCEPTION 'CLEANUP OVERREACHED: only % conversations left in the window — the certification trail was deleted', v_left;
  END IF;
END
$cleanup$;

COMMIT;
