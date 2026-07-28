-- 527_an_alert_nobody_clears_is_noise.sql
-- ============================================================================
-- ops_alerts has ONE thing that resolves an alert: a dismiss button in
-- OpsAlertsBanner.tsx. Nothing closes an alert when its condition clears, so
-- they accumulate until a person clicks each one individually. Today: 35 open,
-- of which 15 dispatch_failure alerts are older than two hours and most of the
-- 18 wake-spin alerts name goals that have since moved or ended.
--
-- That directly undermines migrations 522/525/526. Those added
-- workforce_claim_broken — the alert that means NO EMPLOYEE CAN WORK — and it
-- would arrive into a list of 35 stale entries. Migration 526 was careful not
-- to alarm on a condition the operator already has a queue for, precisely so
-- the channel stays worth reading; an unbounded pile of history defeats that
-- the same way, just through a different door.
--
-- ── THE RULES, AND WHY EACH IS SAFE ────────────────────────────────────────
-- dispatch_failure   check_dispatch_failures runs hourly and re-raises while
--                    the problem persists (raise_ops_alert only suppresses a
--                    duplicate for one hour). So an alert older than two hours
--                    is history: if it were still happening there would be a
--                    newer one. Resolving it cannot hide a live failure.
--
-- wake_spin          the detail names the objective. Resolve when that goal is
--                    no longer live, when its work has moved since the alert
--                    was raised, or when the stall sweep's own attention_flag
--                    has already cleared — all three mean the spin stopped.
--                    A goal still spinning keeps its alert.
--
-- workforce_*        cleared when the heartbeat that raised them reports the
--                    bucket empty. The heartbeat now both raises and clears,
--                    which makes it a control loop rather than a one-way siren.
--
-- ── EVERYTHING ELSE IS LEFT ALONE, DELIBERATELY ────────────────────────────
-- No catch-all age-out. erp_ar_drift belongs to another workstream and has its
-- own clear path; silently closing an alert whose meaning this migration does
-- not model would hide exactly the kind of problem the table exists to surface.
-- An unknown kind stays open until a human dismisses it, and the assert below
-- proves this migration did not touch one.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.resolve_cleared_ops_alerts(p_heartbeat jsonb DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE n_dispatch int := 0; n_spin int := 0; n_workforce int := 0; n int := 0; k text;
BEGIN
  -- ── dispatch_failure: older than the re-check interval is history ────────
  UPDATE ops_alerts SET resolved_at = now()
   WHERE kind = 'dispatch_failure' AND resolved_at IS NULL
     AND created_at < now() - interval '2 hours';
  GET DIAGNOSTICS n_dispatch = ROW_COUNT;

  -- ── wake_spin: the goal stopped spinning, one way or another ─────────────
  UPDATE ops_alerts a SET resolved_at = now()
   WHERE a.kind = 'de_objective_wake_spin' AND a.resolved_at IS NULL
     AND EXISTS (
       SELECT 1 FROM de_objectives o
        WHERE o.id = (a.detail->>'objective_id')::uuid
          AND (o.status NOT IN ('open', 'in_progress', 'blocked')
            OR o.attention_flag IS DISTINCT FROM 'wake_spin'
            OR EXISTS (SELECT 1 FROM de_work_items w
                        WHERE w.objective_id = o.id AND w.updated_at > a.created_at)));
  GET DIAGNOSTICS n_spin = ROW_COUNT;

  -- ── workforce_*: cleared when the heartbeat says the bucket is empty ─────
  IF p_heartbeat IS NOT NULL THEN
    FOREACH k IN ARRAY ARRAY['claim_broken', 'stalled', 'deadlocked'] LOOP
      IF jsonb_array_length(coalesce(p_heartbeat->k, '[]'::jsonb)) = 0 THEN
        UPDATE ops_alerts SET resolved_at = now()
         WHERE resolved_at IS NULL
           AND kind = CASE k WHEN 'claim_broken' THEN 'workforce_claim_broken'
                             WHEN 'stalled'      THEN 'workforce_stalled'
                             ELSE                     'workforce_deadlocked' END;
        GET DIAGNOSTICS n = ROW_COUNT;
        n_workforce := n_workforce + n;
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('ok', true, 'dispatch_failure', n_dispatch,
    'wake_spin', n_spin, 'workforce', n_workforce);
END $fn$;

COMMENT ON FUNCTION public.resolve_cleared_ops_alerts(jsonb) IS
  'Closes ops_alerts whose condition no longer holds, so a real alert is not buried under history. Only kinds whose clear-condition is modelled here are touched; anything else stays open for a human. Called by check_workforce_heartbeat, which therefore both raises and clears.';

REVOKE ALL ON FUNCTION public.resolve_cleared_ops_alerts(jsonb) FROM PUBLIC;

-- ── the heartbeat becomes a control loop ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.check_workforce_heartbeat(p_stall_minutes integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  t record;
  v_due int; v_claimable int; v_recent int; v_awaiting_human int; v_probe_err text;
  v_checked int := 0;
  v_stalled    jsonb := '[]'::jsonb;
  v_broken     jsonb := '[]'::jsonb;
  v_deadlock   jsonb := '[]'::jsonb;
  v_on_people  jsonb := '[]'::jsonb;
BEGIN
  FOR t IN SELECT id, slug FROM tenants WHERE tenant_is_operational(id) LOOP
    v_checked := v_checked + 1;

    SELECT count(*),
           count(*) FILTER (WHERE w.depends_on IS NULL
                              OR EXISTS (SELECT 1 FROM de_work_items d
                                          WHERE d.id = w.depends_on AND d.status = 'done'))
      INTO v_due, v_claimable
      FROM de_work_items w
      JOIN digital_employees de ON de.id = w.de_id
     WHERE w.tenant_id = t.id
       AND w.status = 'queued'
       AND w.scheduled_for <= now()
       AND de.status = 'active'
       AND de.lifecycle_status NOT IN ('paused', 'retired', 'archived');

    CONTINUE WHEN v_due = 0;  -- nothing to do; silence is correct

    SELECT count(*) INTO v_recent
      FROM de_work_items w
     WHERE w.tenant_id = t.id AND w.status IN ('done', 'failed')
       AND w.updated_at > now() - make_interval(mins => greatest(5, p_stall_minutes));

    IF v_claimable = 0 THEN
      SELECT count(*) INTO v_awaiting_human
        FROM de_work_items w WHERE w.tenant_id = t.id AND w.status = 'waiting_human';

      IF v_awaiting_human > 0 THEN
        -- Blocked on people. REPORTED ALWAYS — it is a fact about the queue and
        -- costs nothing to state — but never alarmed: the escalation queue is
        -- where somebody is already looking, and the stall sweep raises anything
        -- left unanswered. Reporting does not depend on recent completions,
        -- because "did something finish in the last half hour" says nothing
        -- about whether the queue is now waiting on a human.
        v_on_people := v_on_people || jsonb_build_object(
          'tenant', t.slug, 'due', v_due, 'awaiting_human', v_awaiting_human);
      ELSIF v_recent = 0 THEN
        -- Nothing can be picked up, nobody has been asked, and nothing is
        -- finishing. Wedged. This one is the alarm.
        v_deadlock := v_deadlock || jsonb_build_object('tenant', t.slug, 'due', v_due);
      END IF;
      CONTINUE;  -- nothing to probe: the claim has nothing to hand out
    END IF;

    v_probe_err := NULL;
    BEGIN
      PERFORM * FROM claim_de_work_items(1, 'heartbeat-probe', t.id);
      RAISE EXCEPTION 'heartbeat_probe_rollback';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'heartbeat_probe_rollback' THEN v_probe_err := SQLERRM; END IF;
    END;

    IF v_probe_err IS NOT NULL THEN
      v_broken := v_broken || jsonb_build_object('tenant', t.slug, 'claimable', v_claimable, 'error', left(v_probe_err, 300));
    ELSIF v_recent = 0 THEN
      v_stalled := v_stalled || jsonb_build_object('tenant', t.slug, 'claimable', v_claimable);
    END IF;
  END LOOP;

  IF jsonb_array_length(v_broken) > 0 THEN
    PERFORM raise_ops_alert('workforce_claim_broken',
      format('The work queue cannot be claimed in %s tenant(s) — no employee can pick up work', jsonb_array_length(v_broken)),
      jsonb_build_object('tenants', v_broken));
  END IF;

  IF jsonb_array_length(v_stalled) > 0 THEN
    PERFORM raise_ops_alert('workforce_stalled',
      format('%s tenant(s) have work ready but nothing has completed in %s minutes', jsonb_array_length(v_stalled), p_stall_minutes),
      jsonb_build_object('tenants', v_stalled, 'window_minutes', p_stall_minutes));
  END IF;

  IF jsonb_array_length(v_deadlock) > 0 THEN
    PERFORM raise_ops_alert('workforce_deadlocked',
      format('%s tenant(s) have work due that nothing can pick up, and no one has been asked to unblock it', jsonb_array_length(v_deadlock)),
      jsonb_build_object('tenants', v_deadlock, 'window_minutes', p_stall_minutes));
  END IF;

  -- Raise AND clear in one pass. An alert nobody closes buries the next real
  -- one, and the next real one here means no employee can pick up work.
  PERFORM resolve_cleared_ops_alerts(jsonb_build_object(
    'claim_broken', v_broken, 'stalled', v_stalled, 'deadlocked', v_deadlock));

  RETURN jsonb_build_object('ok', true, 'tenants_checked', v_checked,
    'claim_broken', v_broken, 'stalled', v_stalled,
    'deadlocked', v_deadlock, 'blocked_on_people', v_on_people);
END $function$
;

notify pgrst, 'reload schema';

DO $a$
DECLARE
  n_stale_before int; n_stale_after int; n_spin_before int; n_spin_after int;
  n_drift_before int; n_drift_after int; n_live_spin_wrongly_closed int;
  v_hb jsonb; v_probe_id uuid; v_resolved boolean;
BEGIN
  SELECT count(*) INTO n_stale_before FROM ops_alerts
   WHERE kind = 'dispatch_failure' AND resolved_at IS NULL AND created_at < now() - interval '2 hours';
  SELECT count(*) INTO n_spin_before FROM ops_alerts
   WHERE kind = 'de_objective_wake_spin' AND resolved_at IS NULL;
  SELECT count(*) INTO n_drift_before FROM ops_alerts
   WHERE kind = 'erp_ar_drift' AND resolved_at IS NULL;

  IF n_stale_before = 0 THEN
    RAISE EXCEPTION '527: no stale dispatch alerts to clear — the case under test is not live';
  END IF;

  -- End to end: the heartbeat is what runs on the cron, so exercise THAT, not
  -- the resolver directly. If the splice into it failed, this assert fails.
  v_hb := check_workforce_heartbeat();

  SELECT count(*) INTO n_stale_after FROM ops_alerts
   WHERE kind = 'dispatch_failure' AND resolved_at IS NULL AND created_at < now() - interval '2 hours';
  SELECT count(*) INTO n_spin_after FROM ops_alerts
   WHERE kind = 'de_objective_wake_spin' AND resolved_at IS NULL;
  SELECT count(*) INTO n_drift_after FROM ops_alerts
   WHERE kind = 'erp_ar_drift' AND resolved_at IS NULL;

  -- Would this pass if the change were a no-op? No: 15 were open a moment ago.
  IF n_stale_after > 0 THEN
    RAISE EXCEPTION '527: % dispatch alert(s) older than two hours are still open', n_stale_after;
  END IF;

  -- ── the one that matters: a kind we do not model must be UNTOUCHED ───────
  -- An age-out that quietly swept everything would pass every assert above.
  IF n_drift_after <> n_drift_before THEN
    RAISE EXCEPTION '527: closed % alert(s) of a kind this migration does not model',
      n_drift_before - n_drift_after;
  END IF;

  -- ...and a wake-spin alert whose goal is STILL spinning must survive.
  SELECT count(*) INTO n_live_spin_wrongly_closed
    FROM ops_alerts a JOIN de_objectives o ON o.id = (a.detail->>'objective_id')::uuid
   WHERE a.kind = 'de_objective_wake_spin' AND a.resolved_at IS NOT NULL
     AND o.status IN ('open','in_progress','blocked')
     AND o.attention_flag = 'wake_spin'
     AND NOT EXISTS (SELECT 1 FROM de_work_items w
                      WHERE w.objective_id = o.id AND w.updated_at > a.created_at);
  IF n_live_spin_wrongly_closed > 0 THEN
    RAISE EXCEPTION '527: closed % wake-spin alert(s) whose goal is still spinning', n_live_spin_wrongly_closed;
  END IF;

  -- ── a workforce alert must clear itself once the condition passes ────────
  -- Raise one for real, confirm a clean heartbeat closes it, then roll the
  -- whole probe back so no history is invented.
  BEGIN
    INSERT INTO ops_alerts (kind, message, detail)
    VALUES ('workforce_claim_broken', '527 self-test', '{"probe":true}'::jsonb)
    RETURNING id INTO v_probe_id;

    PERFORM check_workforce_heartbeat();

    SELECT resolved_at IS NOT NULL INTO v_resolved FROM ops_alerts WHERE id = v_probe_id;
    RAISE EXCEPTION 'ops_alert_selftest_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'ops_alert_selftest_rollback' THEN RAISE; END IF;
  END;

  IF NOT coalesce(v_resolved, false) THEN
    RAISE EXCEPTION '527: a workforce alert stayed open after the condition cleared — the loop is still one-way';
  END IF;
  IF EXISTS (SELECT 1 FROM ops_alerts WHERE detail->>'probe' = 'true') THEN
    RAISE EXCEPTION '527: the self-test leaked an alert';
  END IF;

  RAISE NOTICE '527: cleared % stale dispatch and % wake-spin alert(s); % drift alert(s) untouched; workforce alerts now self-clear',
    n_stale_before - n_stale_after, n_spin_before - n_spin_after, n_drift_after;
END $a$;
