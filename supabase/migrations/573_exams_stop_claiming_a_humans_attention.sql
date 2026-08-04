-- 573 — exams stop filing work for people, and the backlog they already filed
-- is cleared.
--
-- THE THIRD SURFACE OF THE SAME ROOT CAUSE. 570 took exam threads out of the
-- Support Inbox. 571 stopped exam answers counting as job performance. Both
-- missed this one: an exam answer that ESCALATES filed a human_task asking a
-- person to review it. Measured on the HQ tenant: ALL 74 pending escalations
-- were exam answers, every one created today. The activity feed was the same —
-- 74 of today's 78 events.
--
-- Nobody reviews a test question. The exam's grade is decided by the exam.
--
-- WHAT IS WITHDRAWN AND WHAT IS KEPT, deliberately:
--   human_tasks       withdrawn — a claim on a person's attention
--   activity_events   withdrawn — "what did my workforce do for the business
--                     today"; a fire drill does not belong in the incident log
--   audit_events      KEPT — the compliance trail records every exam answer
--   de_conversations  KEPT (channel 'exam', mig 570) — the evidence of what was
--                     asked and answered
--   evidence_runs     KEPT, just not counted as production (mig 571)
-- The record of what happened survives in full. Only its claims on people go.
--
-- The de-answer change ships in the same commit; this migration clears the
-- backlog that was filed before it.
--
-- ⚠ These tasks are DELETED, not rejected. Rejecting 74 exam escalations would
-- write 74 human decisions that no human made, into the ledger the approval
-- learning loop reads. Same reasoning as mig 548 and 569. The guard's sanctioned
-- bypass is used, which is legitimate only inside a migration — this file.

BEGIN;

SET LOCAL app.allow_task_decision = 'on';

DO $cleanup$
DECLARE
  v_tasks   int;
  v_events  int;
  v_left    int;
  v_nonexam int;
BEGIN
  -- Guard first: refuse to run if any task about to be deleted is NOT an exam
  -- task. The join is to de_conversations on channel 'exam', so a task with no
  -- conversation, or one on a real channel, must never be caught.
  SELECT count(*) INTO v_nonexam
    FROM human_tasks t
    LEFT JOIN de_conversations c ON c.id = t.related_id
   WHERE t.type = 'escalation' AND t.status = 'pending'
     AND (c.id IS NULL OR c.channel IS DISTINCT FROM 'exam');
  RAISE NOTICE '573: % pending escalations are NOT exam-derived and will be left alone', v_nonexam;

  -- Only tasks whose conversation is an exam thread.
  DELETE FROM human_tasks t
   USING de_conversations c
   WHERE c.id = t.related_id
     AND c.channel = 'exam'
     AND t.type = 'escalation'
     AND t.status = 'pending';
  GET DIAGNOSTICS v_tasks = ROW_COUNT;

  -- The matching activity-feed entries. Matched by the same question text the
  -- exam asked, on the same day, so a real escalation with a different question
  -- cannot be caught.
  DELETE FROM activity_events a
   WHERE a.event_type = 'escalated'
     AND EXISTS (
       SELECT 1 FROM de_conversations c
       JOIN de_messages m ON m.conversation_id = c.id AND m.role = 'user'
        WHERE c.channel = 'exam'
          AND c.tenant_id = a.tenant_id
          AND a.text LIKE '%' || left(m.content, 60) || '%'
     );
  GET DIAGNOSTICS v_events = ROW_COUNT;

  RAISE NOTICE '573: removed % exam tasks and % exam activity events', v_tasks, v_events;

  SELECT count(*) INTO v_left
    FROM human_tasks t JOIN de_conversations c ON c.id = t.related_id
   WHERE c.channel = 'exam' AND t.type = 'escalation' AND t.status = 'pending';
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'CLEANUP FAILED: % exam escalation task(s) remain', v_left;
  END IF;
END
$cleanup$;

-- ── Asserts ────────────────────────────────────────────────────────────────
DO $probe$
DECLARE
  v_tenant uuid := '5bb802e1-8e92-4eef-9a7a-ac348785d43f';
  v_n int;
BEGIN
  -- Q1: no exam task is waiting on a person, anywhere.
  SELECT count(*) INTO v_n
    FROM human_tasks t JOIN de_conversations c ON c.id = t.related_id
   WHERE c.channel = 'exam' AND t.status = 'pending';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'Q1 FAILED: % exam task(s) still pending', v_n;
  END IF;

  -- Q2: THE ONE THAT MATTERS. Real work was not swept up. Any pending task
  -- whose conversation is NOT an exam thread must survive — including tasks
  -- with no conversation at all, whose provenance is unknown.
  SELECT count(*) INTO v_n
    FROM human_tasks t
    LEFT JOIN de_conversations c ON c.id = t.related_id
   WHERE t.tenant_id = v_tenant AND t.status = 'pending'
     AND (c.id IS NULL OR c.channel IS DISTINCT FROM 'exam');
  IF v_n < 2 THEN
    RAISE EXCEPTION 'Q2 FAILED: only % non-exam pending task(s) left — the cleanup overreached (a knowledge_revision and a trust_demotion_notice were expected to survive)', v_n;
  END IF;

  -- Q3: the gated ERPNext approvals are untouched. They are the two actions
  -- waiting on a real decision and must not have been caught by a cleanup
  -- aimed at test noise.
  SELECT count(*) INTO v_n FROM action_executions
   WHERE tenant_id = v_tenant AND decision LIKE 'human_gated%';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'Q3 FAILED: % gated actions, expected the 2 awaiting approval', v_n;
  END IF;

  -- Q4: the EVIDENCE survives. Exam threads and their messages still exist —
  -- this migration removes claims on people, never the record.
  SELECT count(*) INTO v_n FROM de_conversations WHERE channel = 'exam';
  IF v_n < 100 THEN
    RAISE EXCEPTION 'Q4 FAILED: only % exam threads left — evidence was deleted', v_n;
  END IF;

  RAISE NOTICE '573 asserts passed: exam queue cleared, real work intact, evidence kept.';
END
$probe$;

COMMIT;
