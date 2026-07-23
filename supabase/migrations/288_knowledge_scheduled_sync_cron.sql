-- 288_knowledge_scheduled_sync_cron.sql
-- ============================================================================
-- KNOWLEDGE PHASE 4 — WS8 STEP 4/9: scheduled connector sync. Ships GLOBALLY but
-- is INERT — gated on a feature flag `knowledge_scheduled_sync` with
-- default_enabled=FALSE, so NO tenant re-syncs automatically until the flag is
-- explicitly enabled per workspace (that opt-in IS the 1-tenant validation gate:
-- enable on outsourcetel-hq, prove sync#1 embeds N / sync#2 embeds 0 / an edit
-- re-embeds only itself, THEN roll wider). Reuses the mig-278 driver pattern
-- (vault secret + anon JWT + x-dispatch-secret + net.http_post) with per-tick
-- backpressure + per-iteration subtransaction isolation. Only safe now because:
-- content_hash skips unchanged docs (mig 286), ingestDoc defers embedding to the
-- drain (no OOM), and the embed-backfill pause kill-switch exists. GLOBAL.
-- ============================================================================

INSERT INTO feature_registry (key, label, description, default_enabled, category)
VALUES ('knowledge_scheduled_sync', 'Scheduled knowledge sync',
        'Automatically re-sync knowledge connectors on their interval. Default OFF; enable per workspace after validating on one connector.',
        false, 'ingestion')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION dispatch_knowledge_sync_internal()
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $fn$
DECLARE
  v_secret text;
  v_anon   text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmc3ZtaGNxZWl5cnhpdmJtcGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxMzIwMDgsImV4cCI6MjA5NzcwODAwOH0.RKCWute2ypkx9X-ByumIQWw8MS5uQPco-i-asNa-ESg';
  v_row    record;
  v_count  int := 0;
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'playbook_dispatch_secret';
  IF v_secret IS NULL THEN RETURN 'no dispatch secret'; END IF;

  FOR v_row IN
    SELECT c.id AS connector_id, c.tenant_id
      FROM connectors c
     WHERE c.scheduled_sync_enabled = true
       AND coalesce(c.access_mode, '') <> 'fetch_only'
       -- default-OFF flag => no tenant is touched until it explicitly opts in
       AND public.is_feature_enabled_internal(c.tenant_id, 'knowledge_scheduled_sync') = true
       AND (c.last_scheduled_sync_at IS NULL
            OR c.last_scheduled_sync_at < now() - make_interval(mins => greatest(60, c.sync_interval_mins)))
     ORDER BY c.last_scheduled_sync_at ASC NULLS FIRST
     LIMIT 25
  LOOP
    BEGIN
      -- Claim first (advance the clock) so a slow/duplicate tick can't double-fire.
      UPDATE connectors SET last_scheduled_sync_at = now() WHERE id = v_row.connector_id;
      PERFORM net.http_post(
        url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/connector-hub',
        body    := jsonb_build_object('action', 'sync', 'connector_id', v_row.connector_id,
                                      'tenant_id', v_row.tenant_id, 'scheduled', true),
        headers := jsonb_build_object(
                     'Content-Type', 'application/json',
                     'Authorization', 'Bearer ' || v_anon,
                     'x-dispatch-secret', v_secret)
      );
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'knowledge-sync dispatch failed for connector %: %', v_row.connector_id, sqlerrm;
    END;
  END LOOP;

  RETURN 'knowledge-sync dispatched ' || v_count || ' connector(s) (async)';
END;
$fn$;

-- Every 2 hours; self-limiting (no opted-in connector due → dispatches 0).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'knowledge-sync-driver') THEN
    PERFORM cron.unschedule('knowledge-sync-driver');
  END IF;
  PERFORM cron.schedule('knowledge-sync-driver', '15 */2 * * *', 'select dispatch_knowledge_sync_internal()');
END $$;

NOTIFY pgrst, 'reload schema';
