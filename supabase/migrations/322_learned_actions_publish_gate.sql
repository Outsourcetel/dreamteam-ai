-- 322_learned_actions_publish_gate.sql
-- ============================================================================
-- §3 BREADTH — learned actions are born INACTIVE and need an admin to publish.
--
-- tool-learn generates action_definitions straight from a third-party OpenAPI
-- spec with status='active'. get_agentic_tools_for_de only emits status='active',
-- so every learned write-action became agent-reachable the INSTANT the spec was
-- parsed — and tool-learn required only tenant MEMBERSHIP, so any member could
-- hand the entire DE workforce hundreds of new write tools with no admin review.
--
-- This adds the missing 'draft' state (the CHECK from mig 035 only allowed
-- active|disabled, which is why they were born active) plus an admin-gated
-- publish RPC. Combined with the tool-learn change (admin-only + writes 'draft'),
-- a learned action is inert until a human with authority reviews and publishes it.
-- Existing rows are untouched — nothing that works today stops working. GLOBAL.
-- ============================================================================

-- 1) Allow the draft state (reproduce mig 035's list + 'draft').
ALTER TABLE action_definitions DROP CONSTRAINT IF EXISTS action_definitions_status_check;
ALTER TABLE action_definitions ADD CONSTRAINT action_definitions_status_check
  CHECK (status IN ('active', 'disabled', 'draft'));

-- 2) Admin-gated publish / unpublish for learned actions.
--    Scoped to provider='learned_http' so this can never flip a platform action.
CREATE OR REPLACE FUNCTION public.set_learned_action_status(
  p_tenant_id uuid, p_action_id uuid, p_status text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n int;
BEGIN
  IF p_status NOT IN ('active', 'draft', 'disabled') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_status');
  END IF;
  -- Publishing hands a write tool to the whole workforce: owners/admins only.
  IF coalesce(auth.role(), '') <> 'service_role' AND NOT EXISTS (
    SELECT 1 FROM profiles p
     WHERE p.user_id = auth.uid() AND p.tenant_id = p_tenant_id
       AND (p.layer = 'platform' OR p.role IN ('tenant_owner', 'tenant_admin'))
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authorized');
  END IF;

  UPDATE action_definitions
     SET status = p_status, updated_at = now()
   WHERE id = p_action_id AND tenant_id = p_tenant_id
     AND scope = 'tenant' AND provider = 'learned_http';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found_or_not_learned'); END IF;
  RETURN jsonb_build_object('ok', true, 'status', p_status);
END $$;
REVOKE ALL ON FUNCTION public.set_learned_action_status(uuid, uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_learned_action_status(uuid, uuid, text) TO authenticated, service_role;

-- 3) Read the learned inventory (drafts + published) for the review UI.
CREATE OR REPLACE FUNCTION public.list_learned_actions(p_tenant_id uuid)
RETURNS TABLE (id uuid, category text, action_key text, label text, description text,
               status text, risk jsonb, execution jsonb, learned_from_spec_id uuid, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' AND NOT EXISTS (
    SELECT 1 FROM profiles p WHERE p.user_id = auth.uid()
      AND (p.layer = 'platform' OR p.tenant_id = p_tenant_id)
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  RETURN QUERY
  SELECT a.id, a.category, a.action_key, a.label, a.description, a.status, a.risk,
         a.execution, a.learned_from_spec_id, a.created_at
    FROM action_definitions a
   WHERE a.tenant_id = p_tenant_id AND a.scope = 'tenant' AND a.provider = 'learned_http'
   ORDER BY a.created_at DESC, a.action_key;
END $$;
REVOKE ALL ON FUNCTION public.list_learned_actions(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_learned_actions(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
