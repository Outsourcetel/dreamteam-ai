-- 366_cron_observability.sql
-- ============================================================================
-- Cron reports success while the work it dispatched is failing.
--
-- MEASURED ON PRODUCTION BEFORE WRITING THIS:
--   cron.job                                29 jobs, all active
--   cron.job_run_details WHERE status='failed'          0
--   net._http_response                                851 calls
--   net._http_response WHERE error_msg IS NOT NULL     12  <- all timeouts
--
-- Zero cron failures and twelve failed HTTP calls are both true, because they
-- measure different things. pg_net is ASYNCHRONOUS: net.http_post() returns a
-- request id immediately and cron records that as success. Whether the edge
-- function ever answered is recorded minutes later in net._http_response, which
-- NOTHING in this system reads. So the dashboard is green by construction — it
-- reports that the request was posted, never that the work happened.
--
-- Every one of the 12 failures is the same:
--   "Timeout of 5000 ms reached. Total time: 5000.847 ms (DNS time: 5000.847 ms)"
-- 5000 ms is pg_net's DEFAULT. These 7 dispatchers never set one:
--   dispatch_de_fitness_measure_internal, dispatch_de_improve_internal,
--   dispatch_de_work_internal, dispatch_eval_driver_internal,
--   dispatch_gap_improve_internal, dispatch_knowledge_sync_internal,
--   dispatch_online_eval_internal
-- They call edge functions that do LLM work. Five seconds was never realistic;
-- it was simply never chosen.
--
-- This migration does two things:
--   1. gives those 7 a real timeout
--   2. makes the failures VISIBLE, so "cron is green" stops being a lie
--
-- Part 2 matters more. A longer timeout reduces these failures; only the read
-- path stops the next silent failure — of any kind — from going unnoticed.
-- ============================================================================

-- ── 1. Real timeouts on the 7 dispatchers ───────────────────────────────────
-- Rewritten FROM THE LIVE DEFINITION rather than pasted from a migration file:
-- several of these have been amended since they were first written, and
-- re-applying an older body would silently revert those changes.
DO $fix$
DECLARE
  r record;
  v_src text;
  v_new text;
  v_fixed int := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
       AND p.proname IN ('dispatch_de_fitness_measure_internal',
                         'dispatch_de_improve_internal',
                         'dispatch_de_work_internal',
                         'dispatch_eval_driver_internal',
                         'dispatch_gap_improve_internal',
                         'dispatch_knowledge_sync_internal',
                         'dispatch_online_eval_internal')
  LOOP
    v_src := pg_get_functiondef(r.oid);
    CONTINUE WHEN v_src ILIKE '%timeout_milliseconds%';

    -- Add timeout_milliseconds before the closing paren of the net.http_post
    -- call. Anchored on ") INTO" / ");" rather than on an argument name: these
    -- differ in argument ORDER, and several end with `) INTO v_req_id;` because
    -- pg_net returns a request id. A first attempt keyed on `body :=` matched
    -- four of seven and the assertion below caught it.
    --
    -- [^;]*? cannot cross a statement boundary, and the lazy quantifier walks
    -- past inner parens — platform_fn_url(...), jsonb_build_object(...) — until
    -- it finds the paren that actually closes the call.
    v_new := regexp_replace(
      v_src,
      '(net\.http_post\s*\([^;]*?)\)(\s*(?:INTO|;))',
      '\1, timeout_milliseconds := 60000)\2',
      'gi');

    IF v_new = v_src THEN
      RAISE EXCEPTION '366: could not add a timeout to % — its net.http_post call does not match the expected shape, and silently skipping it would leave it on the 5s default', r.proname;
    END IF;

    EXECUTE v_new;
    v_fixed := v_fixed + 1;
  END LOOP;

  RAISE NOTICE '366: added an explicit timeout to % dispatcher(s)', v_fixed;
END $fix$;

-- ── 2. Make the async failures readable ─────────────────────────────────────
-- net._http_response lives in the `net` schema, which tenant roles cannot read.
-- SECURITY DEFINER is what makes it reachable at all; the platform-admin check
-- is what stops that being a new hole.
CREATE OR REPLACE FUNCTION public.get_dispatch_health(p_hours int DEFAULT 24)
RETURNS TABLE (
  window_hours     int,
  http_total       bigint,
  http_failed      bigint,
  http_timed_out   bigint,
  cron_runs        bigint,
  cron_failed      bigint,
  worst_error      text,
  last_failure_at  timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'get_dispatch_health: platform admin only';
  END IF;

  RETURN QUERY
  WITH h AS (
    SELECT * FROM net._http_response
     WHERE created > now() - make_interval(hours => p_hours)
  ), c AS (
    SELECT * FROM cron.job_run_details
     WHERE start_time > now() - make_interval(hours => p_hours)
  )
  SELECT p_hours,
         (SELECT count(*) FROM h),
         (SELECT count(*) FROM h WHERE error_msg IS NOT NULL OR status_code >= 400),
         (SELECT count(*) FROM h WHERE error_msg ILIKE '%timeout%'),
         (SELECT count(*) FROM c),
         (SELECT count(*) FROM c WHERE status = 'failed'),
         (SELECT error_msg FROM h WHERE error_msg IS NOT NULL
           ORDER BY created DESC LIMIT 1),
         (SELECT max(created) FROM h WHERE error_msg IS NOT NULL);
END $fn$;
REVOKE ALL ON ROUTINE public.get_dispatch_health(int) FROM PUBLIC, anon;

-- ── 3. Turn silent async failure into a real incident ───────────────────────
-- A read-only view is still something a human has to remember to look at. This
-- runs on a schedule and writes an incident, so the failure arrives instead of
-- waiting to be discovered.
CREATE OR REPLACE FUNCTION public.check_dispatch_failures()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  v_failed  int;
  v_total   int;
  v_sample  text;
BEGIN
  SELECT count(*) FILTER (WHERE error_msg IS NOT NULL OR status_code >= 400),
         count(*),
         max(error_msg) FILTER (WHERE error_msg IS NOT NULL)
    INTO v_failed, v_total, v_sample
    FROM net._http_response
   WHERE created > now() - interval '1 hour';

  IF v_failed = 0 THEN
    RETURN jsonb_build_object('ok', true, 'checked', v_total, 'failed', 0);
  END IF;

  -- ops_alerts, not de_incidents: a dispatcher timing out is infrastructure, and
  -- attributing it to whichever tenant happened to trigger it would be wrong.
  -- ops_alerts has no tenant_id, which is exactly right for a platform fault.
  INSERT INTO ops_alerts (kind, message, detail, created_at)
  SELECT 'dispatch_failure',
         format('%s of %s background dispatches failed in the last hour', v_failed, v_total),
         jsonb_build_object(
           'failed', v_failed, 'total', v_total, 'sample_error', v_sample,
           'severity', CASE WHEN v_failed::numeric / greatest(v_total, 1) > 0.25
                            THEN 'high' ELSE 'medium' END),
         now()
  WHERE NOT EXISTS (
    -- One alert per hour, not one per failed call. Unresolved ones only, so a
    -- recurring fault re-alerts once it has been acknowledged and closed.
    SELECT 1 FROM ops_alerts
     WHERE kind = 'dispatch_failure'
       AND created_at > now() - interval '1 hour'
       AND resolved_at IS NULL);

  RETURN jsonb_build_object('ok', false, 'checked', v_total, 'failed', v_failed);
END $fn$;
REVOKE ALL ON ROUTINE public.check_dispatch_failures() FROM PUBLIC, anon, authenticated;

-- ── 4. Prove it ─────────────────────────────────────────────────────────────
DO $assert$
DECLARE
  v_missing int;
  v_r jsonb;
BEGIN
  SELECT count(*) INTO v_missing
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     AND pg_get_functiondef(p.oid) ILIKE '%net.http_post%'
     AND pg_get_functiondef(p.oid) NOT ILIKE '%timeout_milliseconds%';

  IF v_missing > 0 THEN
    RAISE EXCEPTION '366: % function(s) still call net.http_post on the 5s default', v_missing;
  END IF;

  -- The checker must actually run and actually read the response table. An
  -- assertion that only checks the function EXISTS would pass on a stub.
  v_r := public.check_dispatch_failures();
  IF v_r->>'checked' IS NULL THEN
    RAISE EXCEPTION '366: check_dispatch_failures did not read net._http_response';
  END IF;

  RAISE NOTICE '366: all dispatchers have explicit timeouts; last-hour check saw % call(s), % failed',
    v_r->>'checked', v_r->>'failed';
END $assert$;

-- ── 5. Schedule it ──────────────────────────────────────────────────────────
SELECT cron.unschedule('dispatch-failure-check')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-failure-check');

SELECT cron.schedule('dispatch-failure-check', '7 * * * *',
                     $$SELECT public.check_dispatch_failures()$$);

NOTIFY pgrst, 'reload schema';
