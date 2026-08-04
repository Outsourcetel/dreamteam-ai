-- 563 — remove a duplicate overload 562 created, and gate the REAL function.
--
-- MY MISTAKE, CAUGHT BY CALLING IT. 562 wrote:
--     CREATE OR REPLACE FUNCTION public.invoke_conflict_probe_drain()
-- but the function that already existed is
--     invoke_conflict_probe_drain(p_tenant_id uuid DEFAULT NULL)
-- A different argument list is a NEW FUNCTION, not a replacement. So the gate
-- landed on a zero-arg twin nobody calls, the original kept dispatching
-- ungated, and worse — the cron's `select invoke_conflict_probe_drain()` became
-- AMBIGUOUS between the two ("function is not unique", 42725) and would have
-- failed on its next tick.
--
-- 562's own asserts could not catch this: they tested the PREDICATE, which is
-- correct and unaffected. Calling the dispatcher is what surfaced it. A gate
-- proven right can still be bolted to the wrong function.
--
-- embed-backfill and reembed-drain each have exactly one signature and were
-- genuinely replaced; only this one had a defaulted parameter.

BEGIN;

-- The twin 562 created. Dropping it makes `invoke_conflict_probe_drain()`
-- unambiguous again — it resolves to the real one via its DEFAULT.
DROP FUNCTION IF EXISTS public.invoke_conflict_probe_drain();

-- The REAL function, body reproduced verbatim from the live definition, with
-- only the gate added. Signature kept EXACTLY, defaulted parameter included, so
-- this replaces rather than multiplies.
CREATE OR REPLACE FUNCTION public.invoke_conflict_probe_drain(p_tenant_id uuid DEFAULT NULL::uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_secret text;
  v_req_id bigint;
  v_body   jsonb;
  -- Project anon JWT satisfies the edge gateway (verify_jwt); x-dispatch-secret is
  -- the real auth checked inside the fn (same pattern as mig 288/278).
  v_anon   text := coalesce((select value from platform_runtime_config where key = 'supabase_anon_key'), 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmc3ZtaGNxZWl5cnhpdmJtcGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxMzIwMDgsImV4cCI6MjA5NzcwODAwOH0.RKCWute2ypkx9X-ByumIQWw8MS5uQPco-i-asNa-ESg');
BEGIN
  -- Don't wake the edge function for an empty queue. Same shape as
  -- invoke_knowledge_ingest_drain, which has done this in production for weeks.
  -- The hourly escape bounds a wrong gate to an hour of delay, never forever.
  -- Only skips for the UNSCOPED cron call; an explicit tenant request always
  -- dispatches, because a caller naming a tenant knows something we do not.
  IF p_tenant_id IS NULL
     AND NOT public._pending_conflict_probe()
     AND NOT public._dispatch_overdue('conflict-probe-drain') THEN
    RETURN 'idle';
  END IF;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
   WHERE name = 'playbook_dispatch_secret' LIMIT 1;
  IF v_secret IS NULL THEN RETURN 'no_secret'; END IF;

  v_body := jsonb_build_object('limit', 10);
  IF p_tenant_id IS NOT NULL THEN v_body := v_body || jsonb_build_object('tenant_id', p_tenant_id); END IF;

  SELECT net.http_post(
    url     := public.platform_fn_url('/functions/v1/conflict-probe-drain'),
    body    := v_body,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || v_anon,
                                  'x-dispatch-secret', v_secret),
    timeout_milliseconds := 120000
  ) INTO v_req_id;

  RETURN 'dispatched:' || v_req_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.invoke_conflict_probe_drain(uuid) FROM PUBLIC, anon, authenticated;

-- ── Asserts ────────────────────────────────────────────────────────────────
-- These test what 562's did not: that the CRON'S OWN CALL resolves and returns.
DO $probe$
DECLARE
  v_n int;
  v_res text;
BEGIN
  -- H1: exactly one signature, so the cron's bare call is unambiguous again.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'invoke_conflict_probe_drain';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'H1 FAILED: % overloads of invoke_conflict_probe_drain — the cron call stays ambiguous', v_n;
  END IF;

  -- H2: CALL IT THE WAY THE CRON DOES. This is the check that would have caught
  -- 562, and the queue is empty, so it must skip.
  EXECUTE 'select invoke_conflict_probe_drain()' INTO v_res;
  IF v_res <> 'idle' THEN
    RAISE EXCEPTION 'H2 FAILED: the cron call returned % on an empty queue, expected idle', v_res;
  END IF;

  -- H3: the sibling dispatchers still resolve to exactly one signature each.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('invoke_embed_backfill','invoke_reembed_drain');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'H3 FAILED: expected 1 signature each for embed/reembed, found % total', v_n;
  END IF;

  RAISE NOTICE '563 asserts passed: one signature, the cron call resolves and skips.';
END
$probe$;

COMMIT;
