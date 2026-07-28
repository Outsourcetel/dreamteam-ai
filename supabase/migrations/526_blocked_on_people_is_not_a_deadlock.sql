-- 526_blocked_on_people_is_not_a_deadlock.sql
-- ============================================================================
-- Migration 525 taught the heartbeat to notice a deadlock: work due, nothing
-- claimable, nothing completing. Correct as far as it goes — and as written it
-- would have cried wolf every hour starting immediately.
--
-- Right now this tenant has 62 items queued and only 1 claimable. The other 61
-- are behind TWENTY items sitting in waiting_human. That is not a broken
-- system. That is the workforce doing exactly what it should: asking a person,
-- and waiting. The escalation queue already owns that state, and the 15-minute
-- stall sweep already raises anything unanswered for 24h to urgent.
--
-- An ops alert that fires hourly for a condition the operator already knows
-- about and has a queue for is worse than no alert, because it teaches them to
-- ignore the channel — and the next time it means "the claim is throwing and
-- nobody can work", they will scroll past it.
--
-- ── THE DISTINCTION ────────────────────────────────────────────────────────
--   nothing claimable, and people have been asked   -> the queue is blocked on
--        humans. Report it in the return value, raise NOTHING. It is visible
--        in the escalation queue, which is where a person is already looking.
--   nothing claimable, and nobody has been asked    -> genuinely wedged. No
--        employee can work and no human has been given the chance to unwedge
--        it. That is the alarm.
--
-- ── THE TRADE-OFF, STATED ──────────────────────────────────────────────────
-- A tenant with one item wedged behind a failed step AND twenty waiting on a
-- person is reported as blocked-on-humans, so the wedged one is not alarmed on.
-- Accepted because fail_dependents_of_failed_steps (mig 525, every 30 min) now
-- converts exactly that case into failed work rather than leaving it queued, so
-- it stops being invisible by a different route. If that assumption ever breaks
-- the symptom is a silent wedge, which is the thing this whole line of work
-- exists to prevent — so it is written down here rather than left implicit.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.check_workforce_heartbeat(p_stall_minutes int DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
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

  RETURN jsonb_build_object('ok', true, 'tenants_checked', v_checked,
    'claim_broken', v_broken, 'stalled', v_stalled,
    'deadlocked', v_deadlock, 'blocked_on_people', v_on_people);
END $fn$;

notify pgrst, 'reload schema';

DO $a$
DECLARE
  v_tenant uuid; v_hb jsonb; v_slug text := 'outsourcetel-hq';
  n_waiting int; n_alerts_before int; n_alerts_after int;
  v_on_people int := -1; v_deadlocked int := -1; v_alerted int := -1;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = v_slug;
  SELECT count(*) INTO n_waiting FROM de_work_items
   WHERE tenant_id = v_tenant AND status = 'waiting_human';
  IF n_waiting = 0 THEN
    RAISE EXCEPTION '526: this tenant has nothing waiting on a person — the case under test is not live';
  END IF;
  SELECT count(*) INTO n_alerts_before FROM ops_alerts WHERE kind = 'workforce_deadlocked';

  -- ── build the exact condition, measure it, then put everything back ──────
  -- A first attempt asserted against whatever the live queue happened to be
  -- doing, and failed the moment the tenant had one claimable item — proving
  -- nothing about the classification. So create the state deliberately:
  -- push only the CLAIMABLE items out of reach, so claimable becomes 0 while
  -- work is still DUE and still waiting on a person. Pushing everything out was
  -- the first attempt and it made due=0, which skips the tenant entirely and
  -- tests nothing. plpgsql variables survive the rollback; the data changes and
  -- any alert raised do not.
  BEGIN
    UPDATE de_work_items w SET scheduled_for = now() + interval '1 day'
     WHERE w.tenant_id = v_tenant AND w.status = 'queued'
       AND (w.depends_on IS NULL
            OR EXISTS (SELECT 1 FROM de_work_items d WHERE d.id = w.depends_on AND d.status = 'done'));

    v_hb := check_workforce_heartbeat();

    SELECT count(*) INTO v_on_people
      FROM jsonb_array_elements(v_hb->'blocked_on_people') e WHERE e->>'tenant' = v_slug;
    SELECT count(*) INTO v_deadlocked
      FROM jsonb_array_elements(v_hb->'deadlocked') e WHERE e->>'tenant' = v_slug;
    SELECT count(*) INTO v_alerted FROM ops_alerts WHERE kind = 'workforce_deadlocked';

    RAISE EXCEPTION 'heartbeat_classification_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'heartbeat_classification_rollback' THEN RAISE; END IF;
  END;

  -- Would this pass if the change were a no-op? No: mig 525 classified exactly
  -- this state as deadlocked and raised an alert for it.
  IF v_deadlocked <> 0 THEN
    RAISE EXCEPTION '526: a queue waiting on % person-blocked step(s) was still called deadlocked', n_waiting;
  END IF;
  IF v_alerted > n_alerts_before THEN
    RAISE EXCEPTION '526: still alarmed on a queue that is merely waiting for a person';
  END IF;
  -- ...and it must not have gone silent instead. An assert that only proved the
  -- alert stopped would also pass if the whole check had been deleted.
  IF v_on_people <> 1 THEN
    RAISE EXCEPTION '526: the condition is no longer reported at all (blocked_on_people=%)', v_on_people;
  END IF;

  -- The probe state must be exactly as it was found.
  SELECT count(*) INTO n_alerts_after FROM ops_alerts WHERE kind = 'workforce_deadlocked';
  IF n_alerts_after <> n_alerts_before THEN
    RAISE EXCEPTION '526: the classification probe leaked an alert';
  END IF;
  IF EXISTS (SELECT 1 FROM de_work_items WHERE tenant_id = v_tenant
              AND status = 'queued' AND scheduled_for > now() + interval '12 hours') THEN
    RAISE EXCEPTION '526: the classification probe left work pushed into the future';
  END IF;

  RAISE NOTICE '526: a queue blocked on % human decision(s) is reported, not alarmed', n_waiting;
END $a$;
