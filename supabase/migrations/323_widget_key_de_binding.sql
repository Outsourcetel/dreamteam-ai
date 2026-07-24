-- 323_widget_key_de_binding.sql
-- ============================================================================
-- FOUNDER-REPORTED (live use, 2026-07-25): "Riley was responding, not the
-- customer support DE."
--
-- ROOT CAUSE: a widget key cannot name the employee that answers it. widget-ask
-- picks the front DE as: first DE whose external_reply_mode='auto', ELSE the
-- OLDEST eligible DE. With no DE set to 'auto' (all default to 'draft'), every
-- public conversation lands on whichever employee happens to be oldest — for
-- Outsourcetel that is Riley (Account Success), so the Technical Support DE is
-- unreachable from the public chat entirely.
--
-- For a product whose promise is "hire a digital employee", the customer-facing
-- chat landing on an arbitrary employee is a core-promise failure, not a nit.
--
-- FIX: a widget key may name its answering DE. widget-ask prefers that binding
-- and only falls back to the old heuristic when the key names none — so every
-- existing key keeps working exactly as before. GLOBAL.
-- ============================================================================

ALTER TABLE widget_keys ADD COLUMN IF NOT EXISTS de_id uuid REFERENCES digital_employees(id) ON DELETE SET NULL;

COMMENT ON COLUMN widget_keys.de_id IS
  'The digital employee that answers this widget/chat key. NULL = fall back to the front-DE heuristic (first auto-reply DE, else oldest).';

-- Point a key at an employee (or clear it). Owner/admin only — this decides who
-- talks to your customers. Tenant-scoped on BOTH sides so a key can never be
-- bound to another tenant's employee.
CREATE OR REPLACE FUNCTION public.set_widget_key_de(p_widget_key_id uuid, p_de_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_n int;
BEGIN
  SELECT tenant_id INTO v_tenant FROM widget_keys WHERE id = p_widget_key_id;
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'key_not_found'); END IF;

  IF coalesce(auth.role(), '') <> 'service_role' AND NOT EXISTS (
    SELECT 1 FROM profiles p WHERE p.user_id = auth.uid() AND p.tenant_id = v_tenant
      AND (p.layer = 'platform' OR p.role IN ('tenant_owner', 'tenant_admin'))
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authorized');
  END IF;

  IF p_de_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM digital_employees d WHERE d.id = p_de_id AND d.tenant_id = v_tenant
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'de_not_in_tenant');
  END IF;

  UPDATE widget_keys SET de_id = p_de_id WHERE id = p_widget_key_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', v_n > 0, 'de_id', p_de_id);
END $$;
REVOKE ALL ON FUNCTION public.set_widget_key_de(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_widget_key_de(uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
