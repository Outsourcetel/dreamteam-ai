-- 287_connector_sync_cursors.sql
-- ============================================================================
-- KNOWLEDGE PHASE 4 — WS8 STEP 2/6: per-connector schedule + persisted walk
-- state. connector_objects.sync_interval_mins is unusable here (its object_type
-- is constrained to ticket/user/organization), so the schedule lives on
-- connectors directly. The cursor table persists walk state so a future
-- incremental sync can resume + skip re-walking; for now the full walk is
-- compute-cheap (mig-286 content_hash skips re-ingestion) and HWM advances ONLY
-- on a completed walk (the adversary's fix against silently missing docs).
-- GLOBAL, additive. Owner/admin-gated schedule writes.
-- ============================================================================

CREATE TABLE IF NOT EXISTS connector_sync_cursors (
  connector_id      uuid PRIMARY KEY REFERENCES connectors(id) ON DELETE CASCADE,
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cursor            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- opaque provider walk state
  high_water_mark   timestamptz,                          -- newest source modified_at fully ingested
  page_token        text,
  last_external_ref text,
  walk_complete     boolean NOT NULL DEFAULT false,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE connector_sync_cursors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS connector_sync_cursors_read ON connector_sync_cursors;
CREATE POLICY connector_sync_cursors_read ON connector_sync_cursors
  FOR SELECT USING (tenant_id = public.auth_tenant_id());
-- Writes: service_role only (connector-hub edge fn) — no authenticated write policy.

ALTER TABLE connectors ADD COLUMN IF NOT EXISTS scheduled_sync_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS sync_interval_mins     int     NOT NULL DEFAULT 1440;
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS last_scheduled_sync_at timestamptz;

-- Owner/admin toggle a connector's auto-sync (mirrors the mig-138 config gate).
CREATE OR REPLACE FUNCTION public.set_connector_schedule(p_connector_id uuid, p_enabled boolean, p_interval_mins int)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM connectors WHERE id = p_connector_id;
  IF v_tenant IS NULL OR v_tenant IS DISTINCT FROM public.auth_tenant_id()
     OR NOT public.auth_has_tenant_role(array['tenant_owner','tenant_admin']) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_permitted');
  END IF;
  UPDATE connectors
     SET scheduled_sync_enabled = coalesce(p_enabled, false),
         sync_interval_mins     = greatest(60, coalesce(p_interval_mins, 1440))
   WHERE id = p_connector_id;
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.set_connector_schedule(uuid, boolean, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_connector_schedule(uuid, boolean, int) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
