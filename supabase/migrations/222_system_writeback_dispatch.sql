-- 222_system_writeback_dispatch.sql
-- ============================================================================
-- DEEPEN Phase 1b — the generalized WRITE leg of the Connected Systems desk.
-- read_de_system + verify_de_system (mig 221) made read + verify config-driven;
-- the write leg still called the per-entity registries directly. This adds ONE
-- config-driven write entrypoint that routes to the right gated write-back
-- registry by the system's write_registry, so read → write → verify is uniform
-- across every registered system. A new system (billing, erp) plugs in by
-- adding its registry to the router — the DE and the gate don't change.
--
-- Routes to the PROVEN gated registries (propose_account_writeback /
-- propose_opportunity_writeback); no new write path, no new gate. GLOBAL.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.propose_system_writeback(
  p_de_id uuid, p_system_key text, p_entity_ref text, p_op text,
  p_params jsonb DEFAULT '{}'::jsonb, p_objective_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s de_connected_systems; v_tenant uuid;
  v_is_service boolean := coalesce(auth.role(),'') = 'service_role';
BEGIN
  SELECT tenant_id INTO v_tenant FROM digital_employees WHERE id = p_de_id;
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'de_not_found'); END IF;
  IF NOT v_is_service AND v_tenant IS DISTINCT FROM public.auth_tenant_id() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_tenant_member');
  END IF;

  SELECT * INTO s FROM de_connected_systems WHERE de_id = p_de_id AND system_key = p_system_key AND active;
  IF s.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'system_not_configured'); END IF;
  IF NOT s.can_write THEN RETURN jsonb_build_object('ok', false, 'error', 'write_not_allowed'); END IF;

  -- Route to the gated write-back registry this system writes through. Each
  -- branch reuses a proven propose_* (server-composed + frozen + gated via
  -- decide_action_execution). New systems add a branch; nothing else changes.
  IF s.write_registry = 'account' THEN
    RETURN public.propose_account_writeback(p_de_id, p_objective_id, p_entity_ref::uuid, p_op, p_params);
  ELSIF s.write_registry = 'opportunity' THEN
    RETURN public.propose_opportunity_writeback(p_de_id, p_objective_id, p_entity_ref::uuid, p_op, p_params);
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'write_registry_not_supported', 'write_registry', s.write_registry);
  END IF;
END; $$;

REVOKE ALL ON FUNCTION public.propose_system_writeback(uuid,text,text,text,jsonb,uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.propose_system_writeback(uuid,text,text,text,jsonb,uuid) TO authenticated, service_role;
