-- 843_auto_night_switching.sql
-- ============================================================================
-- Task 9 of the Daylight theme rollout (founder-requested 2026-08-21):
-- auto night-switching. A workspace may opt in to a schedule where its chosen
-- day surface applies 07:00-18:59 and a chosen NIGHT surface (default
-- Midnight Navy) applies 19:00-06:59, by each viewer's LOCAL clock. Off by
-- default; off is exactly today's behavior — nothing here changes what an
-- opted-out workspace renders.
--
-- Two new tenant_branding columns, both nullable-safe defaults so every
-- existing row is unaffected: auto_switch (false) and night_surface_key
-- (null, meaning "midnight" once auto_switch turns on — the runtime default,
-- not a stored one, so a workspace that never picks a night look still gets
-- one).
--
-- ── Why a companion RPC, not a wider set_tenant_branding (locked decision) ──
-- Adding a defaulted parameter to the existing two-arg set_tenant_branding
-- creates a THIRD overload once PostgREST resolves by argument count/name —
-- ambiguous RPC dispatch is exactly the class of bug that is invisible until
-- two clients disagree about which one they meant. DROP + CREATE with a new
-- signature would shed the function's ACLs (mig 247's grant, mig 610/630's
-- hygiene) and require re-granting from scratch with nothing to diff against.
-- A companion function avoids both: it is a NEW function, so it starts with
-- default (i.e. PUBLIC-open) ACLs and REQUIRES the explicit revoke/grant
-- block below — unlike CREATE OR REPLACE on an existing function, which
-- preserves whatever was already granted.
--
-- The tenant-resolution and permission-check preamble below is reproduced
-- verbatim from the LIVE set_tenant_branding body (fetched via
-- `select prosrc from pg_proc ... where proname='set_tenant_branding'`,
-- 2026-08-21, matches migration 841 byte-for-byte) rather than re-derived —
-- two hand-written copies of "who may write this row" is exactly the kind of
-- pair that drifts apart silently.
-- ============================================================================

ALTER TABLE public.tenant_branding
  ADD COLUMN auto_switch boolean NOT NULL DEFAULT false,
  ADD COLUMN night_surface_key text NULL;

ALTER TABLE public.tenant_branding
  ADD CONSTRAINT tenant_branding_night_surface_key_check
  CHECK (night_surface_key IS NULL OR night_surface_key IN ('midnight', 'graphite'));

CREATE FUNCTION public.set_tenant_branding_auto(p_auto_switch boolean, p_night_surface_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid;
BEGIN
  -- Preamble mirrored verbatim from the live set_tenant_branding prosrc.
  v_tenant := public.auth_tenant_id();
  IF v_tenant IS NULL OR NOT public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin']) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_permitted');
  END IF;
  -- Night surface is restricted to the two dark families — never the light
  -- ones, which would defeat the point of a NIGHT look. Same error code
  -- ('unknown_surface') the sibling function already uses for an out-of-set
  -- key, so the one UI string that explains it applies to both RPCs.
  IF p_night_surface_key IS NOT NULL AND p_night_surface_key NOT IN ('midnight','graphite') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unknown_surface');
  END IF;
  -- UPDATE, not upsert: a tenant_branding row only exists once a workspace has
  -- saved SOME branding (set_tenant_branding's INSERT .. ON CONFLICT is the
  -- only inserter, mig 247). The Save flow this RPC ships behind always calls
  -- set_tenant_branding first in the same save() (src/design/BrandingCard.tsx),
  -- which guarantees the row exists before this runs; calling this RPC first
  -- against a tenant with no branding row yet is the one case that legitimately
  -- needs a distinct error rather than silently creating a half-populated row.
  UPDATE public.tenant_branding
    SET auto_switch = p_auto_switch, night_surface_key = p_night_surface_key, updated_at = now()
    WHERE tenant_id = v_tenant;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  RETURN jsonb_build_object('ok', true);
END; $$;

-- NEW function: default ACLs hand EXECUTE to PUBLIC until taken back (repo
-- law, migs 610/630). CREATE OR REPLACE on an existing function does not need
-- this line because it preserves prior grants; a brand-new function always
-- does.
REVOKE ALL ON FUNCTION public.set_tenant_branding_auto(boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_tenant_branding_auto(boolean, text) TO authenticated, service_role;

DO $$
BEGIN
  -- Absence of a violation, never presence of an example (replayable on empty).
  IF EXISTS (SELECT 1 FROM public.tenant_branding
             WHERE night_surface_key IS NOT NULL
               AND night_surface_key NOT IN ('midnight', 'graphite')) THEN
    RAISE EXCEPTION 'tenant_branding holds a night_surface_key outside the two dark families';
  END IF;

  -- Schema assertions: describe what THIS migration installed, true on any
  -- database it runs against.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'tenant_branding'
                   AND column_name = 'auto_switch') THEN
    RAISE EXCEPTION 'tenant_branding.auto_switch column missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'tenant_branding'
                   AND column_name = 'night_surface_key') THEN
    RAISE EXCEPTION 'tenant_branding.night_surface_key column missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'set_tenant_branding_auto') THEN
    RAISE EXCEPTION 'set_tenant_branding_auto function missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'tenant_branding_night_surface_key_check'
                   AND pg_get_constraintdef(oid) LIKE '%midnight%'
                   AND pg_get_constraintdef(oid) LIKE '%graphite%') THEN
    RAISE EXCEPTION 'night_surface_key CHECK does not carry both dark keys';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
