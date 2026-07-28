-- 525_work_that_can_never_finish_must_say_so.sql
-- ============================================================================
-- The workforce stopped again at 11:25 and the heartbeat built this morning
-- (mig 522) stayed silent. It was RIGHT to, by its own rule — and the rule is
-- incomplete.
--
-- State at 14:09: 63 items queued, every one of them due, and ZERO claimable.
-- Nothing had completed in 2h44m. The heartbeat only speaks when claimable work
-- exists, so it read "nothing claimable" as "idle queue, say nothing". But a
-- queue with 63 items due and none claimable is not idle. It is DEADLOCKED, and
-- that is a louder condition than the one the heartbeat was built to catch.
--
-- Tracing what the 63 were waiting on found three separate ways for work to
-- wedge permanently, none of which anything detects or repairs:
--
-- ── 1. NOTHING EVER RELEASES A STALE 'running' ITEM ────────────────────────
-- claim_de_work_items sets status='running' + locked_at. complete_de_work_item
-- clears it. If the edge function dies, times out, or is redeployed mid-item,
-- NOTHING puts it back. Of the seven DB functions touching locked_at, not one
-- reaps a stale lock, and the 15-minute stall sweep only raises escalation
-- priority and flags wake-spin. One item had been 'running' since 09:50 —
-- 4h19m — holding its dependants hostage.
--
-- ── 2. A FAILED PARENT BLOCKS ITS CHILDREN FOR EVER ────────────────────────
-- The dependency gate is `parent.status = 'done'`. A parent that reaches
-- 'failed' can never satisfy that, so its children wait for a completion that
-- is never coming. Two items had failed with 'max turns reached without
-- completion' after 3 attempts; their children were queued, due, and
-- permanently unrunnable. Waiting for ever is the worst possible reading of a
-- dead chain: it is indistinguishable from patience.
--
-- ── 3. THE HEARTBEAT COULD NOT SEE EITHER ──────────────────────────────────
-- Both present as claimable=0, which it treats as healthy silence.
--
-- ── WHAT THIS CHANGES ──────────────────────────────────────────────────────
-- · reap_stale_running_work() — an item locked longer than the grace period
--   goes back to the queue. attempts is NOT reset, so a genuinely poisonous
--   item exhausts its retries and fails honestly rather than looping for ever.
-- · fail_dependents_of_failed_steps() — children of a terminally failed parent
--   are failed with the reason naming the step that killed the chain, and the
--   goal is flagged for attention rather than quietly abandoned. A human still
--   decides what to do; they just get told.
-- · reconcile_blocked_goals() gains a fourth outcome: a goal whose steps all
--   ended and ANY of them failed is NOT abandoned — it stays blocked with
--   attention_flag='steps_failed', because "we gave up" and "it broke" are
--   different facts and only one of them needs a person.
-- · the heartbeat gains the deadlock check: work is DUE, none is claimable, and
--   nothing has completed in the window.
-- ============================================================================

-- ── 0. a new thing to be flagged for ────────────────────────────────────────
-- 'stalled' means nothing is happening; 'steps_failed' means nothing is GOING
-- to happen without a person, because a step broke and everything behind it is
-- dead. Different facts, different response, so a different flag rather than
-- overloading one that already means something else. The TypeScript union and
-- the Employee File's label switch are updated in the same commit — a value the
-- UI does not handle renders as a bare "Needs you" and loses the reason.
ALTER TABLE public.de_objectives DROP CONSTRAINT IF EXISTS de_objectives_attention_flag_check;
ALTER TABLE public.de_objectives ADD CONSTRAINT de_objectives_attention_flag_check
  CHECK (attention_flag IS NULL OR attention_flag = ANY (ARRAY['stalled','waiting_too_long','wake_spin','steps_failed']));

-- ── 1. put stale locks back ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reap_stale_running_work(p_grace_minutes int DEFAULT 45)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE n int;
BEGIN
  UPDATE de_work_items w
     SET status = 'queued', locked_at = NULL, locked_by = NULL,
         scheduled_for = now(), updated_at = now(),
         last_error = format('Released after %s minutes locked with no result — the run that claimed it never finished.',
                             p_grace_minutes)
   WHERE w.status = 'running'
     AND w.locked_at IS NOT NULL
     AND w.locked_at < now() - make_interval(mins => greatest(5, p_grace_minutes))
     AND tenant_is_operational(w.tenant_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'released', n);
END $fn$;

COMMENT ON FUNCTION public.reap_stale_running_work(int) IS
  'Returns work items stuck in running (claimed but never completed — a dead or redeployed run) to the queue. attempts is deliberately not reset so a poisonous item still exhausts its retries.';

-- ── 2. a dead chain must read as dead ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fail_dependents_of_failed_steps()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE n int; v_total int := 0; v_rounds int := 0;
BEGIN
  -- Loop because failing a child creates a new failed parent for ITS children.
  -- Bounded: each round strictly shortens the longest live chain.
  LOOP
    v_rounds := v_rounds + 1;
    UPDATE de_work_items w
       SET status = 'failed', updated_at = now(),
           last_error = format('Cannot run: the step it depends on failed — "%s"', left(coalesce(p.title, 'earlier step'), 120))
      FROM de_work_items p
     WHERE w.depends_on = p.id
       AND w.status = 'queued'
       AND p.status = 'failed'
       AND tenant_is_operational(w.tenant_id);
    GET DIAGNOSTICS n = ROW_COUNT;
    v_total := v_total + n;
    EXIT WHEN n = 0 OR v_rounds >= 20;
  END LOOP;

  -- Tell somebody. A goal with a broken chain needs a person to decide whether
  -- to retry it, change the approach, or drop it — it must not look abandoned.
  UPDATE de_objectives o
     SET attention_flag = 'steps_failed',
         attention_since = coalesce(o.attention_since, now()),
         updated_at = now()
   WHERE o.status IN ('open', 'in_progress', 'blocked')
     AND o.attention_flag IS DISTINCT FROM 'steps_failed'
     AND EXISTS (SELECT 1 FROM de_work_items w WHERE w.objective_id = o.id AND w.status = 'failed');

  RETURN jsonb_build_object('ok', true, 'failed_dependents', v_total, 'rounds', v_rounds);
END $fn$;

COMMENT ON FUNCTION public.fail_dependents_of_failed_steps() IS
  'A step whose parent failed can never run — the dependency gate needs the parent done. Fails the chain with the reason naming the step that broke it, and flags the goal for attention, so a dead chain stops being indistinguishable from patience.';

-- ── 3. a goal whose steps FAILED is not a goal we abandoned ─────────────────
CREATE OR REPLACE FUNCTION public.reconcile_blocked_goals(p_tenant_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE
  g record;
  v_resumed int := 0; v_finished int := 0; v_dropped int := 0; v_left int := 0; v_broken int := 0;
BEGIN
  PERFORM set_config('app.allow_task_decision', 'on', true);  -- mig 487 sanctioned path

  FOR g IN
    SELECT o.id, o.tenant_id,
           count(w.id)                                             AS n_items,
           count(*) FILTER (WHERE w.status = 'waiting_human')       AS n_waiting,
           count(*) FILTER (WHERE w.status IN ('queued','running')) AS n_live,
           count(*) FILTER (WHERE w.status = 'done')                AS n_done,
           count(*) FILTER (WHERE w.status = 'failed')              AS n_failed
      FROM de_objectives o
      LEFT JOIN de_work_items w ON w.objective_id = o.id
     WHERE o.status = 'blocked'
       AND (p_tenant_id IS NULL OR o.tenant_id = p_tenant_id)
       AND tenant_is_operational(o.tenant_id)
     GROUP BY o.id, o.tenant_id
  LOOP
    IF g.n_waiting > 0 OR g.n_items = 0 THEN
      v_left := v_left + 1;
      CONTINUE;
    END IF;

    IF g.n_live > 0 THEN
      UPDATE de_objectives SET status = 'in_progress', updated_at = now() WHERE id = g.id;
      UPDATE human_tasks
         SET status = 'rejected', disposition = 'cancelled',
             decision_note = 'Closed automatically: nothing is blocking this goal any more — its remaining steps are queued and will run. No human ruling was made.',
             decided_at = now(), updated_at = now()
       WHERE related_table = 'de_objectives' AND related_id = g.id AND status = 'pending';
      v_resumed := v_resumed + 1;

    ELSIF g.n_failed > 0 THEN
      -- Everything is over and something BROKE. Do not abandon it: "we gave up"
      -- and "it broke" are different facts and only one of them needs a person.
      UPDATE de_objectives
         SET attention_flag = 'steps_failed',
             attention_since = coalesce(attention_since, now()), updated_at = now()
       WHERE id = g.id;
      v_broken := v_broken + 1;

    ELSIF g.n_done > 0 THEN
      UPDATE de_objectives SET status = 'achieved', updated_at = now() WHERE id = g.id;
      v_finished := v_finished + 1;

    ELSE
      UPDATE de_objectives SET status = 'abandoned', updated_at = now() WHERE id = g.id;
      v_dropped := v_dropped + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'resumed', v_resumed, 'finished', v_finished,
    'dropped', v_dropped, 'broken', v_broken, 'genuinely_blocked', v_left);
END $fn$;

-- ── 4. the heartbeat learns what a deadlock looks like ──────────────────────
CREATE OR REPLACE FUNCTION public.check_workforce_heartbeat(p_stall_minutes int DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE
  t record;
  v_due int; v_claimable int; v_recent int; v_probe_err text;
  v_checked int := 0;
  v_stalled  jsonb := '[]'::jsonb;
  v_broken   jsonb := '[]'::jsonb;
  v_deadlock jsonb := '[]'::jsonb;
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

    -- Genuinely nothing to do. Silence is correct.
    CONTINUE WHEN v_due = 0;

    SELECT count(*) INTO v_recent
      FROM de_work_items w
     WHERE w.tenant_id = t.id
       AND w.status IN ('done', 'failed')
       AND w.updated_at > now() - make_interval(mins => greatest(5, p_stall_minutes));

    -- ── THE CASE THIS MORNING'S VERSION MISSED ────────────────────────────
    -- Work is due, none of it can be picked up, and nothing is finishing.
    -- Every dependency chain is wedged behind something that will not move.
    IF v_claimable = 0 THEN
      IF v_recent = 0 THEN
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
      format('%s tenant(s) have work due that NOTHING can pick up — every chain is behind a step that will not move', jsonb_array_length(v_deadlock)),
      jsonb_build_object('tenants', v_deadlock, 'window_minutes', p_stall_minutes));
  END IF;

  RETURN jsonb_build_object('ok', true, 'tenants_checked', v_checked,
    'claim_broken', v_broken, 'stalled', v_stalled, 'deadlocked', v_deadlock);
END $fn$;

REVOKE ALL ON FUNCTION public.reap_stale_running_work(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fail_dependents_of_failed_steps() FROM PUBLIC;

SELECT cron.schedule('reap-stale-running-work-10min', '*/10 * * * *',
                     $c$select reap_stale_running_work()$c$);
SELECT cron.schedule('fail-dead-chains-30min', '*/30 * * * *',
                     $c$select fail_dependents_of_failed_steps()$c$);

notify pgrst, 'reload schema';

DO $a$
DECLARE
  v_tenant uuid; v_res jsonb; v_hb jsonb;
  n_stuck int; n_released int; n_dead_children int; n_claimable int;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'outsourcetel-hq';

  -- ── the deadlock check must FIRE on the state that is live right now ─────
  -- Would this pass if the new branch were absent? No: this is exactly the
  -- condition mig 522 stayed silent through for 2h44m.
  SELECT count(*) INTO n_claimable
    FROM de_work_items w JOIN digital_employees de ON de.id = w.de_id
   WHERE w.tenant_id = v_tenant AND w.status = 'queued' AND w.scheduled_for <= now()
     AND de.status = 'active' AND de.lifecycle_status NOT IN ('paused','retired','archived')
     AND (w.depends_on IS NULL OR EXISTS (SELECT 1 FROM de_work_items d WHERE d.id = w.depends_on AND d.status='done'));

  IF n_claimable = 0 THEN
    v_hb := check_workforce_heartbeat();
    IF jsonb_array_length(v_hb->'deadlocked') = 0 THEN
      RAISE EXCEPTION '525: work is due with nothing claimable and the heartbeat still says nothing';
    END IF;
    DELETE FROM ops_alerts WHERE kind = 'workforce_deadlocked' AND resolved_at IS NULL;
  END IF;

  -- ── the reaper releases the stale lock ──────────────────────────────────
  SELECT count(*) INTO n_stuck FROM de_work_items
   WHERE tenant_id = v_tenant AND status = 'running'
     AND locked_at < now() - interval '45 minutes';
  v_res := reap_stale_running_work(45);
  n_released := (v_res->>'released')::int;
  IF n_stuck > 0 AND n_released = 0 THEN
    RAISE EXCEPTION '525: % item(s) locked for over 45 minutes and the reaper released none', n_stuck;
  END IF;

  -- ── a dead chain reads as dead ──────────────────────────────────────────
  v_res := fail_dependents_of_failed_steps();
  n_dead_children := (v_res->>'failed_dependents')::int;

  -- The invariant: nothing may sit queued behind a parent that failed.
  IF EXISTS (SELECT 1 FROM de_work_items w JOIN de_work_items p ON p.id = w.depends_on
              WHERE w.status = 'queued' AND p.status = 'failed') THEN
    RAISE EXCEPTION '525: work is still queued behind a step that already failed';
  END IF;

  RAISE NOTICE '525: released % stale lock(s), failed % dependent(s) of broken chains, deadlock detection armed',
    n_released, n_dead_children;
END $a$;
