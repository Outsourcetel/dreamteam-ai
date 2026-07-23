-- 298_knowledge_conflict_dispatcher.sql
-- ============================================================================
-- KNOWLEDGE PHASE 5 — WS9 automation: the SQL dispatcher for conflict-probe-drain
-- (vault 'playbook_dispatch_secret' + net.http_post, mirrors invoke_reembed_drain).
-- Deployed so the drain can be invoked with proper auth — including the MANUAL
-- one-shot invocation used by the 1-tenant validation gate.
--
-- NO cron is scheduled here. Scheduling the '*/3' tick + the enqueue trigger is
-- deferred until AFTER the validation gate proves a seeded contradicting pair
-- actually surfaces end-to-end. Until then this fn only runs when called by hand,
-- and even then it no-ops unless a tenant has opted into the default-OFF flag
-- (empty queue). GLOBAL, additive.
-- ============================================================================

CREATE OR REPLACE FUNCTION invoke_conflict_probe_drain(p_tenant_id uuid DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_secret text;
  v_req_id bigint;
  v_body   jsonb;
  -- Project anon JWT satisfies the edge gateway (verify_jwt); x-dispatch-secret is
  -- the real auth checked inside the fn (same pattern as mig 288/278).
  v_anon   text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmc3ZtaGNxZWl5cnhpdmJtcGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxMzIwMDgsImV4cCI6MjA5NzcwODAwOH0.RKCWute2ypkx9X-ByumIQWw8MS5uQPco-i-asNa-ESg';
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
   WHERE name = 'playbook_dispatch_secret' LIMIT 1;
  IF v_secret IS NULL THEN RETURN 'no_secret'; END IF;

  v_body := jsonb_build_object('limit', 10);
  IF p_tenant_id IS NOT NULL THEN v_body := v_body || jsonb_build_object('tenant_id', p_tenant_id); END IF;

  SELECT net.http_post(
    url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/conflict-probe-drain',
    body    := v_body,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || v_anon,
                                  'x-dispatch-secret', v_secret),
    timeout_milliseconds := 120000
  ) INTO v_req_id;

  RETURN 'dispatched:' || v_req_id;
END;
$$;
REVOKE ALL ON FUNCTION invoke_conflict_probe_drain(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION invoke_conflict_probe_drain(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
