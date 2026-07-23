-- 300_reembed_dispatcher_jwt_fix.sql
-- ============================================================================
-- FIX: invoke_reembed_drain (mig 291) posts to the reembed-drain edge fn WITHOUT
-- an Authorization header. reembed-drain was deployed with verify_jwt=true (the
-- default for a fresh fn), so the edge GATEWAY rejects the post with 401
-- UNAUTHORIZED_NO_AUTH_HEADER before the fn even runs — confirmed live. Harmless
-- today (reembed is inert: 0 pending), but the drain would never run once a
-- workspace enabled knowledge_reembed. Same defect + same fix as the conflict
-- dispatcher (mig 298): include the project anon JWT to satisfy the gateway;
-- x-dispatch-secret remains the real auth checked inside the fn. GLOBAL, additive.
-- ============================================================================

CREATE OR REPLACE FUNCTION invoke_reembed_drain()
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_secret text;
  v_req_id bigint;
  v_anon   text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmc3ZtaGNxZWl5cnhpdmJtcGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxMzIwMDgsImV4cCI6MjA5NzcwODAwOH0.RKCWute2ypkx9X-ByumIQWw8MS5uQPco-i-asNa-ESg';
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
   WHERE name = 'playbook_dispatch_secret' LIMIT 1;
  IF v_secret IS NULL THEN RETURN 'no_secret'; END IF;

  SELECT net.http_post(
    url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/reembed-drain',
    body    := jsonb_build_object('limit', 4),
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || v_anon,
                                  'x-dispatch-secret', v_secret),
    timeout_milliseconds := 120000
  ) INTO v_req_id;

  RETURN 'dispatched:' || v_req_id;
END;
$$;
REVOKE ALL ON FUNCTION invoke_reembed_drain() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION invoke_reembed_drain() TO service_role;

NOTIFY pgrst, 'reload schema';
