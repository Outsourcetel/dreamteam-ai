-- 524_a_goal_is_only_blocked_if_something_blocks_it.sql
-- ============================================================================
-- After 523 cleared the obsolete and retryable escalations, 32 remained across
-- 16 goals still marked 'blocked'. Looking at what those goals actually
-- contain: NOT ONE of them has a step waiting on a human.
--
--   · several have every step 'queued'          — ready to run right now
--   · several have every step 'cancelled'       — the work was dropped
--   · one has 'cancelled,done'                  — it finished
--
-- The block was real once and was never cleared. Nothing in the system moves a
-- goal out of 'blocked' when the thing blocking it goes away, so the status is
-- a permanent scar. Each day's sweep then opens a fresh goal, inherits the same
-- fate, and escalates again: SIX separate "Daily AR sweep" goals, two
-- escalations each, none of them waiting on anything.
--
-- Note the queued case is not a work stoppage — claim_de_work_items does not
-- filter on objective status, so those steps were always claimable. What the
-- stale status produced was noise: a person being asked, every day, to unblock
-- work that nothing was blocking.
--
-- ── THE RULE ───────────────────────────────────────────────────────────────
-- A goal is blocked only while something is actually blocking it. Reconciled
-- from the goal's OWN steps, never guessed:
--
--   any step waiting on a human      -> leave it blocked. It really is.
--   every step finished or cancelled -> it is over: achieved if any step
--                                       completed, abandoned if none did
--   steps queued or running, none    -> in_progress. Nothing is blocking it.
--     waiting on a human
--   no steps at all                  -> leave alone. Nothing to infer from.
--
-- Escalations resolve themselves from there: the 523 trigger closes them when a
-- goal ends, and the resume case closes its own with an explicit note. No
-- escalation is silently deleted and none is marked 'answered' — nobody
-- answered anything.
--
-- Runs every 30 minutes so this cannot silently re-accumulate.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reconcile_blocked_goals(p_tenant_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE
  g record;
  v_resumed int := 0; v_finished int := 0; v_dropped int := 0; v_left int := 0;
BEGIN
  PERFORM set_config('app.allow_task_decision', 'on', true);  -- mig 487 sanctioned path

  FOR g IN
    SELECT o.id, o.tenant_id,
           count(w.id)                                            AS n_items,
           count(*) FILTER (WHERE w.status = 'waiting_human')      AS n_waiting,
           count(*) FILTER (WHERE w.status IN ('queued','running'))AS n_live,
           count(*) FILTER (WHERE w.status = 'done')               AS n_done
      FROM de_objectives o
      LEFT JOIN de_work_items w ON w.objective_id = o.id
     WHERE o.status = 'blocked'
       AND (p_tenant_id IS NULL OR o.tenant_id = p_tenant_id)
       AND tenant_is_operational(o.tenant_id)
     GROUP BY o.id, o.tenant_id
  LOOP
    -- Genuinely blocked, or nothing to reason from. Leave both alone.
    IF g.n_waiting > 0 OR g.n_items = 0 THEN
      v_left := v_left + 1;
      CONTINUE;
    END IF;

    IF g.n_live > 0 THEN
      -- Work is sitting there ready. This goal is not blocked.
      UPDATE de_objectives SET status = 'in_progress', updated_at = now() WHERE id = g.id;
      UPDATE human_tasks
         SET status = 'rejected', disposition = 'cancelled',
             decision_note = 'Closed automatically: nothing is blocking this goal any more — its remaining steps are queued and will run. No human ruling was made.',
             decided_at = now(), updated_at = now()
       WHERE related_table = 'de_objectives' AND related_id = g.id AND status = 'pending';
      v_resumed := v_resumed + 1;

    ELSIF g.n_done > 0 THEN
      -- Every step is terminal and at least one completed. The 523 trigger
      -- closes the escalations off the back of this status change.
      UPDATE de_objectives SET status = 'achieved', updated_at = now() WHERE id = g.id;
      v_finished := v_finished + 1;

    ELSE
      UPDATE de_objectives SET status = 'abandoned', updated_at = now() WHERE id = g.id;
      v_dropped := v_dropped + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'resumed', v_resumed, 'finished', v_finished,
    'dropped', v_dropped, 'genuinely_blocked', v_left);
END $fn$;

COMMENT ON FUNCTION public.reconcile_blocked_goals(uuid) IS
  'A goal is blocked only while a step is actually waiting on a human. Reconciles stale blocked goals from their own steps: resume if work is queued, close if every step is terminal, leave alone if genuinely waiting or if there are no steps to reason from.';

REVOKE ALL ON FUNCTION public.reconcile_blocked_goals(uuid) FROM PUBLIC;

SELECT cron.schedule('reconcile-blocked-goals-30min', '*/30 * * * *',
                     $c$select reconcile_blocked_goals()$c$);

notify pgrst, 'reload schema';

DO $a$
DECLARE
  v_tenant uuid; v_res jsonb;
  n_before int; n_after int; n_esc_before int; n_esc_after int; n_liars int;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'outsourcetel-hq';

  SELECT count(*) INTO n_before FROM de_objectives WHERE tenant_id = v_tenant AND status = 'blocked';
  SELECT count(*) INTO n_esc_before FROM human_tasks
   WHERE tenant_id = v_tenant AND status = 'pending' AND related_table = 'de_objectives';

  v_res := reconcile_blocked_goals(v_tenant);

  SELECT count(*) INTO n_after FROM de_objectives WHERE tenant_id = v_tenant AND status = 'blocked';
  SELECT count(*) INTO n_esc_after FROM human_tasks
   WHERE tenant_id = v_tenant AND status = 'pending' AND related_table = 'de_objectives';

  -- Would this pass if the change were a no-op? No — 16 goals were blocked with
  -- nothing waiting on a human, and all 16 must be reclassified.
  IF n_after >= n_before THEN
    RAISE EXCEPTION '524: % goal(s) blocked before, % after — nothing was reconciled', n_before, n_after;
  END IF;

  -- THE INVARIANT, and the whole point: no goal may claim to be blocked while
  -- it has steps and none of them is waiting on a human.
  SELECT count(*) INTO n_liars FROM (
    SELECT o.id
      FROM de_objectives o JOIN de_work_items w ON w.objective_id = o.id
     WHERE o.status = 'blocked' AND o.tenant_id = v_tenant
     GROUP BY o.id
    HAVING count(*) FILTER (WHERE w.status = 'waiting_human') = 0) x;
  IF n_liars > 0 THEN
    RAISE EXCEPTION '524: % goal(s) still say blocked with nothing blocking them', n_liars;
  END IF;

  -- A resumed goal must not have been quietly marked answered by anyone.
  IF EXISTS (SELECT 1 FROM human_tasks WHERE tenant_id = v_tenant
              AND disposition = 'answered' AND decided_by IS NULL
              AND decided_at > now() - interval '5 minutes') THEN
    RAISE EXCEPTION '524: something was recorded as answered without a human answering it';
  END IF;

  RAISE NOTICE '524: blocked goals % -> % (resumed %, finished %, dropped %, genuinely blocked %); goal escalations % -> %',
    n_before, n_after, v_res->>'resumed', v_res->>'finished', v_res->>'dropped',
    v_res->>'genuinely_blocked', n_esc_before, n_esc_after;
END $a$;
