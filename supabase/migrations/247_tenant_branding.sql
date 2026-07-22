-- 247_tenant_branding.sql
-- ============================================================================
-- Per-tenant BRANDING (founder idea, 2026-07-22): every workspace wears its
-- own colors. Guardrailed customization — an accent hex + a curated surface
-- family key — never a free-for-all palette, so every combination stays
-- readable (Design System v1, docs/design-system.md). GLOBAL — all tenants.
-- ============================================================================
CREATE TABLE IF NOT EXISTS tenant_branding (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  accent_hex  text,                       -- e.g. '#6366f1'; NULL = platform indigo
  surface_key text NOT NULL DEFAULT 'midnight'
              CHECK (surface_key IN ('midnight', 'graphite')),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenant_branding ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_branding_read ON tenant_branding;
CREATE POLICY tenant_branding_read ON tenant_branding
  FOR SELECT USING (tenant_id = public.auth_tenant_id());

-- Owner/admin write goes through the validated RPC only (no direct policy).
CREATE OR REPLACE FUNCTION public.set_tenant_branding(p_accent_hex text, p_surface_key text DEFAULT 'midnight')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_hex text;
BEGIN
  v_tenant := public.auth_tenant_id();
  IF v_tenant IS NULL OR NOT public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin']) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_permitted');
  END IF;
  IF p_surface_key NOT IN ('midnight','graphite') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unknown_surface');
  END IF;
  v_hex := nullif(lower(btrim(coalesce(p_accent_hex,''))), '');
  IF v_hex IS NOT NULL AND v_hex !~ '^#[0-9a-f]{6}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'accent_must_be_hex6');
  END IF;
  INSERT INTO tenant_branding (tenant_id, accent_hex, surface_key, updated_at)
  VALUES (v_tenant, v_hex, p_surface_key, now())
  ON CONFLICT (tenant_id) DO UPDATE
    SET accent_hex = excluded.accent_hex, surface_key = excluded.surface_key, updated_at = now();
  RETURN jsonb_build_object('ok', true);
END; $$;
REVOKE ALL ON FUNCTION public.set_tenant_branding(text,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_tenant_branding(text,text) TO authenticated, service_role;
