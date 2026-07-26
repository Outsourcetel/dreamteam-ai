-- 368_edge_error_reporting.sql
-- ============================================================================
-- Edge function crashes are currently invisible.
--
-- MEASURED BEFORE WRITING THIS:
--   56 edge functions in supabase/functions/
--    1 mentions Sentry (connector-hub)
--    0 write to ops_alerts
--    3 use the otel helper — and that records GenAI spans, not errors
--   53 end with a top-level `catch` that does console.error() and returns 500
--
-- console.error goes to the Supabase function log, which has short retention and
-- which nobody reads unless they already suspect a problem. So the business logic
-- — answering customers, running the work engine, writing back to CRMs — fails
-- silently. The frontend has real Sentry reporting (src/lib/sentry.ts, wired in
-- main.tsx with a root error boundary); the BACKEND has nothing.
--
-- This is the server half of the fix. The dedupe lives here rather than in the
-- edge helper on purpose: 56 copies of a rate-limiting rule is 56 chances for
-- one of them to be wrong, and a reporting path that floods ops_alerts during an
-- outage is its own incident.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.report_edge_error(
  p_function text,
  p_message  text,
  p_detail   jsonb DEFAULT '{}'::jsonb,
  p_tenant   uuid  DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_key text;
BEGIN
  IF p_function IS NULL OR btrim(p_function) = '' THEN RETURN; END IF;

  -- One alert per function per distinct message per hour. A crash loop should
  -- produce one row you can act on, not ten thousand you cannot.
  v_key := p_function || ':' || left(coalesce(p_message, ''), 200);

  INSERT INTO ops_alerts (kind, message, detail, created_at)
  SELECT 'edge_function_error',
         format('%s failed: %s', p_function, left(coalesce(p_message, 'unknown'), 300)),
         coalesce(p_detail, '{}'::jsonb)
           || jsonb_build_object('function', p_function, 'tenant_id', p_tenant, 'dedupe_key', v_key),
         now()
   WHERE NOT EXISTS (
     SELECT 1 FROM ops_alerts
      WHERE kind = 'edge_function_error'
        AND detail->>'dedupe_key' = v_key
        AND created_at > now() - interval '1 hour'
        AND resolved_at IS NULL);
END $fn$;

-- Called by edge functions with the SERVICE ROLE, which bypasses grants — so no
-- client role needs EXECUTE. Leaving it open would let any signed-up user forge
-- operational alerts, which is a cheap way to bury a real one in noise.
REVOKE ALL ON ROUTINE public.report_edge_error(text, text, jsonb, uuid)
  FROM PUBLIC, anon, authenticated;

-- ── Reading them ────────────────────────────────────────────────────────────
-- ops_alerts had NO reader anywhere in src/ or supabase/functions/ before this.
-- A table that is written and never read is not monitoring, so this is the
-- minimum that makes the alerts reachable by a human.
CREATE OR REPLACE FUNCTION public.list_ops_alerts(
  p_hours int DEFAULT 168, p_include_resolved boolean DEFAULT false)
RETURNS TABLE (id uuid, kind text, message text, detail jsonb,
               created_at timestamptz, resolved_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'list_ops_alerts: platform admin only';
  END IF;
  RETURN QUERY
    SELECT a.id, a.kind, a.message, a.detail, a.created_at, a.resolved_at
      FROM ops_alerts a
     WHERE a.created_at > now() - make_interval(hours => p_hours)
       AND (p_include_resolved OR a.resolved_at IS NULL)
     ORDER BY a.created_at DESC
     LIMIT 500;
END $fn$;
REVOKE ALL ON ROUTINE public.list_ops_alerts(int, boolean) FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.resolve_ops_alert(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'resolve_ops_alert: platform admin only';
  END IF;
  UPDATE ops_alerts SET resolved_at = now() WHERE id = p_id AND resolved_at IS NULL;
  RETURN jsonb_build_object('ok', FOUND);
END $fn$;
REVOKE ALL ON ROUTINE public.resolve_ops_alert(uuid) FROM PUBLIC, anon;

-- ── Prove it ────────────────────────────────────────────────────────────────
DO $assert$
DECLARE v_before int; v_after int; v_dedup int;
BEGIN
  SELECT count(*) INTO v_before FROM ops_alerts WHERE kind = 'edge_function_error';

  PERFORM public.report_edge_error('__selftest', 'boom', '{"a":1}'::jsonb, NULL);
  SELECT count(*) INTO v_after FROM ops_alerts WHERE kind = 'edge_function_error';
  IF v_after <> v_before + 1 THEN
    RAISE EXCEPTION '368: report_edge_error did not record an alert (% -> %)', v_before, v_after;
  END IF;

  -- The dedupe is the part most likely to be silently wrong, so assert it fires.
  PERFORM public.report_edge_error('__selftest', 'boom', '{"a":2}'::jsonb, NULL);
  SELECT count(*) INTO v_dedup FROM ops_alerts WHERE kind = 'edge_function_error';
  IF v_dedup <> v_after THEN
    RAISE EXCEPTION '368: dedupe failed — a crash loop would flood ops_alerts (% rows)', v_dedup;
  END IF;

  -- A DIFFERENT message must still get through, or a second real fault during an
  -- ongoing incident would be swallowed.
  PERFORM public.report_edge_error('__selftest', 'different', '{}'::jsonb, NULL);
  SELECT count(*) INTO v_dedup FROM ops_alerts WHERE kind = 'edge_function_error';
  IF v_dedup <> v_after + 1 THEN
    RAISE EXCEPTION '368: dedupe is too aggressive — a distinct error was swallowed';
  END IF;

  DELETE FROM ops_alerts WHERE detail->>'function' = '__selftest';

  IF has_function_privilege('authenticated', 'public.report_edge_error(text,text,jsonb,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '368: report_edge_error is client-callable — alerts could be forged';
  END IF;

  RAISE NOTICE '368: edge error reporting live, deduped per function+message per hour';
END $assert$;

NOTIFY pgrst, 'reload schema';
