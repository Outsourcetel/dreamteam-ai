-- 833_daylight_surface_family.sql
-- ============================================================================
-- Daylight joins the curated surface families (Design System: Daylight theme
-- rollout, plan 2026-08-21). Guardrail unchanged: curated keys, never
-- free-form.
-- ============================================================================

ALTER TABLE public.tenant_branding
  DROP CONSTRAINT IF EXISTS tenant_branding_surface_key_check;
ALTER TABLE public.tenant_branding
  ADD CONSTRAINT tenant_branding_surface_key_check
  CHECK (surface_key IN ('midnight', 'graphite', 'daylight'));

CREATE OR REPLACE FUNCTION public.set_tenant_branding(p_accent_hex text, p_surface_key text DEFAULT 'midnight')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_hex text;
BEGIN
  v_tenant := public.auth_tenant_id();
  IF v_tenant IS NULL OR NOT public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin']) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_permitted');
  END IF;
  IF p_surface_key NOT IN ('midnight','graphite','daylight') THEN
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
-- CREATE OR REPLACE preserves the function's existing ACLs (mig 247 + the
-- default-EXECUTE hygiene of migs 610/630) — do not re-grant here.

DO $$
BEGIN
  -- Absence of a violation, never presence of an example (replayable on empty).
  IF EXISTS (SELECT 1 FROM public.tenant_branding
             WHERE surface_key NOT IN ('midnight','graphite','daylight')) THEN
    RAISE EXCEPTION 'tenant_branding holds a surface_key outside the curated set';
  END IF;
  -- Schema assertion: the constraint really carries all three keys.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'tenant_branding_surface_key_check'
                   AND pg_get_constraintdef(oid) LIKE '%daylight%') THEN
    RAISE EXCEPTION 'surface_key CHECK does not include daylight';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
