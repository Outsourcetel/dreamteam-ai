-- 564 — gate the playbook dispatcher. And an honest finding: the work-source
-- poll cannot be gated, so it is left alone rather than given a gate that never
-- skips.
--
-- ── playbook-execute: FOUR work sources, not one ───────────────────────────
-- Reading the whole dispatch branch rather than its first line, it does:
--   1. dispatch_due_triggers()  — turns due schedules + matched events into
--                                 pending fires. THIS IS SQL.
--   2. playbook_trigger_fires   status='pending_start'
--   3. playbook_runs            waiting AND resume_at <= now()      (due waits)
--   4. playbook_runs            waiting AND resume_at IS NULL
--                               AND waiting_task_id IS NOT NULL     (agentic gates)
--
-- A gate reproducing (1)'s matching logic — schedules, renewal windows, invoice
-- / ticket / opportunity event rules — would be a second implementation of a
-- large predicate, and the first one to drift would silently stop playbooks.
--
-- SO THE GATE DOES NOT REPRODUCE IT. It RUNS it. dispatch_due_triggers is SQL
-- and already executed every 5 minutes; calling it here instead of one hop later
-- costs nothing and means any newly-due schedule or matched event has ALREADY
-- become a pending fire BEFORE we decide whether to dispatch. That is what makes
-- the remaining predicate a provable superset: after step 1, all new work is
-- visible in the three tables of steps 2-4.
--
-- Calling it twice is safe — it selects FOR UPDATE SKIP LOCKED and advances
-- next_fire_at, so the edge function's own call finds nothing left to claim.
--
-- FAIL OPEN: if the evaluation throws we dispatch anyway. Not knowing whether
-- there is work must never be read as "there is none".
--
-- ── work-source-poll: NOT GATED, and this is the reason ────────────────────
-- poll_de_work_sources_targets() returns 15 live targets right now — connector
-- × grant pairs across operational tenants. Its whole purpose is to ASK those
-- external systems whether anything new arrived; whether a helpdesk has a new
-- ticket is not knowable from this database at any price. A gate on "are there
-- targets" would be true on every tick and save nothing while adding a moving
-- part. The only real lever there is frequency, and 561 already took the safe
-- part of it (*/5 → */10). Slowing it further trades away inbound
-- responsiveness, which is the wrong trade.

BEGIN;

-- ── Predicate: pure, no side effects, exactly the three queues the edge ─────
-- function drains after its own trigger evaluation.
CREATE OR REPLACE FUNCTION public._pending_playbook_work() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT EXISTS (SELECT 1 FROM playbook_trigger_fires WHERE status = 'pending_start')
      OR EXISTS (SELECT 1 FROM playbook_runs
                  WHERE status = 'waiting' AND resume_at IS NOT NULL AND resume_at <= now())
      -- Broader than the worker, deliberately: it additionally checks whether
      -- the gating task was decided. Over-dispatching is the safe direction.
      OR EXISTS (SELECT 1 FROM playbook_runs
                  WHERE status = 'waiting' AND resume_at IS NULL AND waiting_task_id IS NOT NULL)
$$;

REVOKE ALL ON FUNCTION public._pending_playbook_work() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.invoke_playbook_execute()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_evaluated boolean := true;
  v_req bigint;
BEGIN
  -- Step 1 of the edge function's own work, run here so the gate can see what
  -- it produces. Fails OPEN.
  BEGIN
    PERFORM public.dispatch_due_triggers(NULL);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'dispatch_due_triggers failed (%), dispatching anyway', SQLERRM;
    v_evaluated := false;
  END;

  IF v_evaluated
     AND NOT public._pending_playbook_work()
     AND NOT public._dispatch_overdue('playbook-execute') THEN
    RETURN 'idle';
  END IF;

  RETURN coalesce('dispatched:' || public._dispatch_fn('/functions/v1/playbook-execute',
                                                       '{"action":"dispatch"}'::jsonb)::text,
                  'skipped');
END;
$function$;

REVOKE ALL ON FUNCTION public.invoke_playbook_execute() FROM PUBLIC, anon, authenticated;

-- ── Asserts ────────────────────────────────────────────────────────────────
-- 563 taught the missing lesson: a predicate proven correct can still be bolted
-- to the wrong function, so these call the dispatcher THE WAY THE CRON DOES.
DO $probe$
DECLARE
  v_n    int;
  v_fire uuid;
  v_res  text;
BEGIN
  -- I1: one signature. A defaulted-parameter twin is what broke the conflict
  -- drain; check before trusting the bare call.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'invoke_playbook_execute';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'I1 FAILED: % overloads of invoke_playbook_execute', v_n;
  END IF;

  -- I2 (negative): every queue is empty, so the predicate must be false.
  IF public._pending_playbook_work() THEN
    RAISE EXCEPTION 'I2 FAILED: predicate TRUE with 0 pending fires, 0 due waits, 0 gated runs';
  END IF;

  -- I3 (positive): THE ANTI-STARVATION PROOF. One real fire flipped to
  -- pending_start must wake it. Rolled back.
  SELECT id INTO v_fire FROM playbook_trigger_fires LIMIT 1;
  IF v_fire IS NULL THEN
    RAISE EXCEPTION 'ASSERT SETUP FAILED: no playbook_trigger_fires row to test against';
  END IF;
  BEGIN
    UPDATE playbook_trigger_fires SET status = 'pending_start' WHERE id = v_fire;
    IF NOT public._pending_playbook_work() THEN
      RAISE EXCEPTION 'I3 FAILED: a pending_start fire did NOT wake the dispatcher — playbooks would stop firing';
    END IF;
    RAISE EXCEPTION 'rollback_i3';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'rollback_i3' THEN RAISE; END IF;
  END;

  -- I4: the probe left nothing behind.
  IF public._pending_playbook_work() THEN
    RAISE EXCEPTION 'I4 FAILED: the probe write survived its rollback';
  END IF;

  -- I5: THE CHECK 562 LACKED — run the cron's own statement. It must resolve
  -- and, with everything empty, skip. This also proves running
  -- dispatch_due_triggers inline did not itself manufacture work.
  EXECUTE 'select invoke_playbook_execute()' INTO v_res;
  IF v_res <> 'idle' THEN
    RAISE EXCEPTION 'I5 FAILED: the cron call returned % with no work pending, expected idle', v_res;
  END IF;

  -- I6: the work-source poll is untouched and still scheduled. Leaving it
  -- ungated was a decision; a silently disabled poll is not.
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'work-source-poll-10min' AND active) THEN
    RAISE EXCEPTION 'I6 FAILED: work-source-poll-10min is not active';
  END IF;

  RAISE NOTICE '564 asserts passed: playbook gate skips when idle, wakes on one real fire, cron call resolves.';
END
$probe$;

COMMIT;
