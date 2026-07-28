-- 522_a_heartbeat_for_the_workforce.sql
-- ============================================================================
-- On 2026-07-28 the entire workforce stopped for 47 minutes and every surface
-- said it was healthy. claim_de_work_items raised on every call (mig 514 put
-- LEFT JOINs inside a FOR UPDATE); de-work swallowed the error and returned
-- HTTP 200 {"worked":0}; the cron reported "succeeded" in 0.1s, eight times an
-- hour, because pg_net dispatch is async and cron duration says nothing about
-- whether any work happened.
--
-- Nothing was watching the one thing that mattered: IS ANYTHING GETTING DONE.
--
-- The existing signals all missed it, and each for a good reason:
--   · dispatch_failure       — the dispatch SUCCEEDED. Only the work failed.
--   · de-stall-sweep-15min   — watches individual items, not whether the
--                              workforce as a whole is moving.
--   · de_objective_wake_spin — watches goals waking, and they were waking fine.
--
-- ── WHAT THIS ADDS ─────────────────────────────────────────────────────────
-- Two checks per operational tenant, every 15 minutes:
--
-- 1. THROUGHPUT. Work is claimable right now, yet nothing has completed or
--    failed in the window. That is the symptom no matter the cause — a broken
--    claim, a dead edge function, an exhausted budget, a stuck LLM.
--
-- 2. A DIRECT PROBE OF THE CLAIM. Throughput alone takes a full window to
--    notice. So the heartbeat CALLS claim_de_work_items for real and forces the
--    subtransaction to roll back, which surfaces a raising claim on the very
--    next tick. This is deliberately not a re-implementation of the claim:
--    reproducing that query is precisely how mig 514 shipped broken, because a
--    hand-written mirror has no FOR UPDATE clause and cannot fail the way the
--    real function fails.
--
-- Alerts are AGGREGATED into one per condition per run. raise_ops_alert dedups
-- on kind alone, globally — so one alert per tenant would mean the second
-- stalled tenant in an hour is silently dropped. The affected tenants go in the
-- detail payload instead, where none of them can be lost.
--
-- A tenant with no claimable work is SILENT, not healthy-by-assertion: an idle
-- queue is a legitimate state and must never page anyone.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.check_workforce_heartbeat(p_stall_minutes int DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE
  t record;
  v_claimable int; v_recent int; v_probe_err text;
  v_checked int := 0;
  v_stalled jsonb := '[]'::jsonb;
  v_broken  jsonb := '[]'::jsonb;
BEGIN
  FOR t IN SELECT id, slug FROM tenants WHERE tenant_is_operational(id) LOOP
    v_checked := v_checked + 1;

    -- Work that could be picked up RIGHT NOW. Mirrors the claim's own gates so
    -- that "claimable" means the same thing here as it does there.
    SELECT count(*) INTO v_claimable
      FROM de_work_items w
      JOIN digital_employees de ON de.id = w.de_id
     WHERE w.tenant_id = t.id
       AND w.status = 'queued'
       AND w.scheduled_for <= now()
       AND de.status = 'active'
       AND de.lifecycle_status NOT IN ('paused', 'retired', 'archived')
       AND (w.depends_on IS NULL
            OR EXISTS (SELECT 1 FROM de_work_items d WHERE d.id = w.depends_on AND d.status = 'done'));

    -- An idle queue is fine. Say nothing.
    CONTINUE WHEN v_claimable = 0;

    -- 'failed' counts as movement: an employee hitting its budget ceiling is a
    -- different problem, and reporting it as a stall would be wrong.
    SELECT count(*) INTO v_recent
      FROM de_work_items w
     WHERE w.tenant_id = t.id
       AND w.status IN ('done', 'failed')
       AND w.updated_at > now() - make_interval(mins => greatest(5, p_stall_minutes));

    -- ── probe the real claim, then undo it ────────────────────────────────
    v_probe_err := NULL;
    BEGIN
      PERFORM * FROM claim_de_work_items(1, 'heartbeat-probe', t.id);
      -- This was a probe, not a shift. Raising rolls the subtransaction back,
      -- releasing the row lock and un-claiming the item.
      RAISE EXCEPTION 'heartbeat_probe_rollback';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'heartbeat_probe_rollback' THEN
        v_probe_err := SQLERRM;
      END IF;
    END;

    IF v_probe_err IS NOT NULL THEN
      v_broken := v_broken || jsonb_build_object('tenant', t.slug, 'claimable', v_claimable, 'error', left(v_probe_err, 300));
    ELSIF v_recent = 0 THEN
      v_stalled := v_stalled || jsonb_build_object('tenant', t.slug, 'claimable', v_claimable);
    END IF;
  END LOOP;

  IF jsonb_array_length(v_broken) > 0 THEN
    PERFORM raise_ops_alert(
      'workforce_claim_broken',
      format('The work queue cannot be claimed in %s tenant(s) — no employee can pick up work',
             jsonb_array_length(v_broken)),
      jsonb_build_object('tenants', v_broken));
  END IF;

  IF jsonb_array_length(v_stalled) > 0 THEN
    PERFORM raise_ops_alert(
      'workforce_stalled',
      format('%s tenant(s) have work ready but nothing has completed in %s minutes',
             jsonb_array_length(v_stalled), p_stall_minutes),
      jsonb_build_object('tenants', v_stalled, 'window_minutes', p_stall_minutes));
  END IF;

  RETURN jsonb_build_object('ok', true, 'tenants_checked', v_checked,
    'claim_broken', v_broken, 'stalled', v_stalled);
END $fn$;

COMMENT ON FUNCTION public.check_workforce_heartbeat(int) IS
  'Is the workforce actually getting anything done? Per operational tenant: work is claimable but nothing completed in the window (throughput), and a live rolled-back probe of claim_de_work_items (breakage). Silent when a queue is legitimately idle. Added after a 47-minute outage that every other signal reported as healthy.';

REVOKE ALL ON FUNCTION public.check_workforce_heartbeat(int) FROM PUBLIC;

SELECT cron.schedule('workforce-heartbeat-15min', '*/15 * * * *',
                     $c$select check_workforce_heartbeat()$c$);

notify pgrst, 'reload schema';

DO $a$
DECLARE
  v_saved text; v_res jsonb; n_before int; n_after int; n_probe int; n_alert int;
BEGIN
  -- ── 1. it runs, and it does not leave a single item claimed ──────────────
  SELECT count(*) INTO n_before FROM de_work_items WHERE status = 'running';
  v_res := check_workforce_heartbeat();
  SELECT count(*) INTO n_after  FROM de_work_items WHERE status = 'running';
  SELECT count(*) INTO n_probe  FROM de_work_items WHERE locked_by = 'heartbeat-probe';

  IF (v_res->>'tenants_checked')::int = 0 THEN
    RAISE EXCEPTION '522: the heartbeat checked no tenants at all';
  END IF;
  -- Would this pass if the rollback were broken? No — the probe claims a real
  -- item, and without the rollback it would be sitting in 'running' right now.
  IF n_after <> n_before OR n_probe > 0 THEN
    RAISE EXCEPTION '522: the probe left % item(s) claimed — the rollback does not work', n_probe;
  END IF;
  IF jsonb_array_length(v_res->'claim_broken') > 0 THEN
    RAISE EXCEPTION '522: the claim is broken right now: %', v_res->'claim_broken';
  END IF;

  -- ── 2. BREAK THE CLAIM ON PURPOSE AND CONFIRM IT NOTICES ─────────────────
  -- The only assert worth having. A detector that has never seen the fault it
  -- exists to catch is a guess. All of this is inside the migration's
  -- transaction, so the real function is restored either way.
  v_saved := pg_get_functiondef('public.claim_de_work_items(integer,text,uuid)'::regprocedure);

  EXECUTE $x$
    -- The defaults must match the real signature exactly: CREATE OR REPLACE
    -- cannot remove parameter defaults from an existing function.
    CREATE OR REPLACE FUNCTION public.claim_de_work_items(p_limit integer DEFAULT 10, p_worker text DEFAULT 'worker'::text, p_tenant_id uuid DEFAULT NULL::uuid)
     RETURNS SETOF de_work_items LANGUAGE plpgsql AS $stub$
    BEGIN RAISE EXCEPTION 'simulated: FOR UPDATE cannot be applied to the nullable side of an outer join'; END $stub$;
  $x$;

  v_res := check_workforce_heartbeat();

  EXECUTE v_saved;  -- restore the real one before anything can use the stub

  IF jsonb_array_length(v_res->'claim_broken') = 0 THEN
    RAISE EXCEPTION '522: the claim was deliberately broken and the heartbeat did not notice';
  END IF;

  -- The alert it raised during the test is not a real incident.
  DELETE FROM ops_alerts
   WHERE kind = 'workforce_claim_broken' AND resolved_at IS NULL
     AND detail::text LIKE '%simulated%';
  GET DIAGNOSTICS n_alert = ROW_COUNT;

  -- ── 3. the real claim survived the swap ──────────────────────────────────
  IF pg_get_functiondef('public.claim_de_work_items(integer,text,uuid)'::regprocedure) NOT ILIKE '%for update of w skip locked%' THEN
    RAISE EXCEPTION '522: the real claim was not restored after the fault test';
  END IF;

  RAISE NOTICE '522: heartbeat live over % tenant(s); caught a deliberately broken claim and cleaned up % test alert(s)',
    (v_res->>'tenants_checked')::int, n_alert;
END $a$;
