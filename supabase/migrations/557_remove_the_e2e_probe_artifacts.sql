-- 557 — remove the artifacts the reply-mode end-to-end probe created.
--
-- Verifying 555/556 meant invoking the DEPLOYED de-answer for real, because
-- reading the code is what let four separate bugs survive in this feature for
-- months. Real invocations leave real rows. This removes exactly those rows and
-- nothing else.
--
-- WHY A MIGRATION AND NOT A QUERY. human_tasks is protected by
-- guard_human_task_decision: a PENDING approval cannot be deleted, on purpose,
-- so nobody can quietly make an awkward approval disappear. The guard has one
-- sanctioned escape (app.allow_task_decision), and the standing rule is that
-- using it is legitimate ONLY inside a migration — where the reason is on the
-- record and reviewable. That is what this file is.
--
-- WHY DELETED AND NOT REJECTED. Following mig 548: rejecting these would write
-- two rejections against an employee that answered both questions correctly, at
-- 98% and 100% confidence, from the product knowledge base. That is a false
-- training signal about a real employee's judgement. They were probe questions
-- from me, not customer questions, so they are removed rather than judged.
--
-- Ids are listed explicitly. No time-window delete, which could take a genuine
-- conversation with it if anyone was working while the probes ran.

BEGIN;

SET LOCAL app.allow_task_decision = 'on';

DO $cleanup$
DECLARE
  v_convs UUID[] := ARRAY[
    'bed0f0f8-f392-45e5-ae4d-29ee5742254e',  -- outsourcetel      (no_docs path)
    '3f3947bb-9bd2-4d77-95ba-c742b5bfa875',  -- staypineapple     (no_docs path)
    '67ebbb95-ceb9-4073-846c-35af01381c03',  -- staypineapple     (no_docs path)
    '0d4c4bb0-5336-4fdf-979b-e86e58ac9300',  -- outsourcetel-hq   (answered, 98%)
    '12fa4fd2-633a-4fef-b774-6218ce91f6f7'   -- outsourcetel-hq   (answered, 100%)
  ]::UUID[];
  v_tasks INT; v_msgs INT; v_evt INT; v_convd INT; v_cfg INT; v_left INT;
BEGIN
  DELETE FROM human_tasks WHERE related_id = ANY(v_convs);
  GET DIAGNOSTICS v_tasks = ROW_COUNT;

  DELETE FROM de_messages WHERE conversation_id = ANY(v_convs);
  GET DIAGNOSTICS v_msgs = ROW_COUNT;

  DELETE FROM activity_events
   WHERE created_at > now() - interval '2 hours'
     AND (text LIKE '%What is DreamTeam AI?%'
       OR text LIKE '%DreamTeam onboarding involve%'
       OR text LIKE '%E2E probe%');
  GET DIAGNOSTICS v_evt = ROW_COUNT;

  DELETE FROM de_conversations WHERE id = ANY(v_convs);
  GET DIAGNOSTICS v_convd = ROW_COUNT;

  -- Every probe config row goes. reply-mode stays OFF in every tenant: holding
  -- answers is only safe once someone has decided to let an employee auto-send
  -- in the first place, and that is the founder's call, not a side effect of a
  -- test. de_config had 0 rows before this work and has 0 rows after it.
  DELETE FROM de_config;
  GET DIAGNOSTICS v_cfg = ROW_COUNT;

  RAISE NOTICE 'probe cleanup: % tasks, % messages, % events, % conversations, % config rows',
               v_tasks, v_msgs, v_evt, v_convd, v_cfg;

  -- Assert the state we claim to have restored, rather than assuming it.
  SELECT count(*) INTO v_left FROM de_conversations WHERE id = ANY(v_convs);
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'CLEANUP FAILED: % probe conversation(s) still present', v_left;
  END IF;
  SELECT count(*) INTO v_left FROM de_config;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'CLEANUP FAILED: % de_config row(s) remain — reply-mode could still be on somewhere', v_left;
  END IF;
  SELECT count(*) INTO v_left FROM human_tasks WHERE related_id = ANY(v_convs);
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'CLEANUP FAILED: % probe task(s) remain', v_left;
  END IF;
END
$cleanup$;

COMMIT;
