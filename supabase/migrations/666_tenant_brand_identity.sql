-- 666_tenant_brand_identity.sql
-- ============================================================================
-- Per-tenant BRAND IDENTITY (founder-approved 2026-08-10): the tenant's
-- COMPANY brand — palette, typography, logo, tone of voice, contact identity —
-- consumed by DE work products (emails, invoices, documents). Distinct from
-- tenant_branding (mig 247), which themes the app UI. GLOBAL — all tenants.
--
-- Writes go through set_tenant_brand_identity ONLY: tenant derived from auth
-- (never a parameter), owner/admin gated, sections whitelisted, hex validated.
-- ============================================================================
CREATE TABLE IF NOT EXISTS tenant_brand_identity (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  brand      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenant_brand_identity ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_brand_identity_read ON tenant_brand_identity;
CREATE POLICY tenant_brand_identity_read ON tenant_brand_identity
  FOR SELECT USING (tenant_id = public.auth_tenant_id());
-- No INSERT/UPDATE/DELETE policies: mutations only via the RPC below.

CREATE OR REPLACE FUNCTION public.set_tenant_brand_identity(p_brand jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid;
  v_key    text;
  v_hex    text;
BEGIN
  v_tenant := public.auth_tenant_id();
  IF v_tenant IS NULL OR NOT public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin']) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_permitted');
  END IF;

  IF p_brand IS NULL OR jsonb_typeof(p_brand) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'brand_must_be_object');
  END IF;

  IF length(p_brand::text) > 20000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'brand_too_large');
  END IF;

  -- Whitelist top-level sections; an unknown key is a hard refusal, not a skip.
  FOR v_key IN SELECT jsonb_object_keys(p_brand) LOOP
    IF v_key NOT IN ('overview','colors','typography','logo','voice','contact','outputs') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'unknown_section', 'section', v_key);
    END IF;
    IF jsonb_typeof(p_brand -> v_key) <> 'object' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'section_must_be_object', 'section', v_key);
    END IF;
  END LOOP;

  -- Every non-empty color value must be a 6-digit hex.
  IF p_brand ? 'colors' THEN
    FOR v_key IN SELECT jsonb_object_keys(p_brand -> 'colors') LOOP
      v_hex := nullif(lower(btrim(p_brand -> 'colors' ->> v_key)), '');
      IF v_hex IS NOT NULL AND v_hex !~ '^#[0-9a-f]{6}$' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'color_must_be_hex6', 'field', v_key);
      END IF;
    END LOOP;
  END IF;

  INSERT INTO tenant_brand_identity (tenant_id, brand, updated_by, updated_at)
  VALUES (v_tenant, p_brand, auth.uid(), now())
  ON CONFLICT (tenant_id) DO UPDATE
    SET brand = excluded.brand, updated_by = excluded.updated_by, updated_at = now();

  RETURN jsonb_build_object('ok', true);
END; $$;

-- Migs 610+630 rule: strip BOTH default-grant mechanisms, then grant deliberately.
REVOKE ALL ON FUNCTION public.set_tenant_brand_identity(jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_tenant_brand_identity(jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
