-- 291_knowledge_reembed_cron.sql
-- ============================================================================
-- KNOWLEDGE PHASE 4 — WS7 Class-B: drain cron for reembed-drain (mig 290 + the
-- reembed-drain edge fn). Deployed AFTER the fn exists. Mirrors the mig-186
-- embed-backfill-drain cron exactly: one global drain call every 2 minutes, no
-- tenant filter — the worker pulls the next batch of reembed_pending=true chunks
-- across all tenants and clears each flag as it re-embeds in place.
--
-- INERT by construction: the enqueue (bulk_reembed_docs) is gated on the
-- default-OFF flag knowledge_reembed, so with no opt-in there are ZERO
-- reembed_pending rows and every tick no-ops (processed 0). A workspace turning
-- the flag on is the 1-tenant validation gate. The platform_config kill-switch
-- 'knowledge.reembed_paused' stops the drain independently of embed-backfill.
-- GLOBAL, additive.
-- ============================================================================

CREATE OR REPLACE FUNCTION invoke_reembed_drain()
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_secret text;
  v_req_id bigint;
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
   WHERE name = 'playbook_dispatch_secret' LIMIT 1;
  IF v_secret IS NULL THEN RETURN 'no_secret'; END IF;

  SELECT net.http_post(
    url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/reembed-drain',
    body    := jsonb_build_object('limit', 4),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-dispatch-secret', v_secret),
    timeout_milliseconds := 120000
  ) INTO v_req_id;

  RETURN 'dispatched:' || v_req_id;
END;
$$;
REVOKE ALL ON FUNCTION invoke_reembed_drain() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION invoke_reembed_drain() TO service_role;

-- Every 2 minutes; cron.schedule upserts by job name (idempotent).
SELECT cron.schedule('knowledge-reembed-drain', '*/2 * * * *', 'select invoke_reembed_drain()');

NOTIFY pgrst, 'reload schema';
