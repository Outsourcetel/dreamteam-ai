-- 378_signup_grants_and_owner_email.sql
-- ============================================================================
-- Two fixes to complete_signup, both found by creating a genuinely new workspace
-- for the first time since the Knowledge ACL shipped.
--
-- ── 1. A NEW WORKSPACE OWNER CANNOT ADD KNOWLEDGE ──────────────────────────
-- Signing in as the owner of a freshly created workspace and importing a site:
--   insufficient_permission: adding knowledge requires contributor
--
-- Measured: the new tenant had 0 rows in knowledge_access_grants, and
-- complete_signup never creates one (its body does not mention the table).
-- All 16 production tenants DO have grants — because migration 343 BACKFILLED
-- them. So the existing workspaces work by historical accident, and EVERY
-- workspace created since the ACL shipped has been unable to complete "Teach it
-- your business".
--
-- That is the exact step both real signups died at. It also means the whole
-- onboarding push — site importer, in-chat rescue, the CTA — sat behind a
-- permission wall no new owner could pass. Invisible in production precisely
-- because every tenant there predates the ACL.
--
-- The five grants below are not invented: they are the exact shape migration 343
-- backfilled, verified identical across all 16 live tenants.
--
-- ── 2. A TENANT COULD BE CREATED WITH NO OWNER EMAIL ───────────────────────
-- tenants.admin_email was left NULL by complete_signup. A workspace with no
-- recorded owner contact cannot be emailed about billing, trial expiry, an
-- incident, or a deletion request — and on a product that sends outbound mail
-- and runs trials, "who owns this workspace?" must never be unanswerable.
-- Now taken from the authenticated user's own auth.users row, so it is the
-- verified address rather than something typed into a form.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.grant_workspace_baseline_access(
  p_tenant uuid, p_granted_by uuid DEFAULT NULL)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_n int;
BEGIN
  -- Exactly the shape migration 343 backfilled onto every existing tenant.
  -- ON CONFLICT DO NOTHING so this is safe to call on an established workspace.
  INSERT INTO knowledge_access_grants
    (tenant_id, resource_type, resource_id, principal_type, principal_role, permission, granted_by, note)
  SELECT p_tenant, 'workspace', NULL, g.ptype, g.prole, g.perm, p_granted_by,
         'baseline workspace access (mig 378)'
    FROM (VALUES
      ('role'::text,     'tenant_owner'::text, 'workspace_admin'::text),
      ('role',           'tenant_admin',       'workspace_admin'),
      ('role',           'owner',              'workspace_admin'),
      ('role',           'admin',              'workspace_admin'),
      ('everyone',       NULL,                 'editor')
    ) AS g(ptype, prole, perm)
   WHERE NOT EXISTS (
     SELECT 1 FROM knowledge_access_grants k
      WHERE k.tenant_id = p_tenant AND k.resource_type = 'workspace'
        AND k.principal_type = g.ptype
        AND k.principal_role IS NOT DISTINCT FROM g.prole);

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $fn$;
REVOKE ALL ON ROUTINE public.grant_workspace_baseline_access(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ── Patch complete_signup in place ──────────────────────────────────────────
-- Reproduced from the LIVE definition with two insertions, rather than pasted
-- from an old migration file: this function has been amended repeatedly and
-- re-applying a stale body would silently revert that work.
DO $patch$
DECLARE v_src text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'complete_signup';
  IF v_src IS NULL THEN RAISE EXCEPTION '378: complete_signup not found'; END IF;

  -- (2) record the owner's verified email on the tenant row.
  v_new := replace(v_src,
    'values (btrim(p_org_name), v_slug, nullif(btrim(coalesce(p_industry, '''')), ''''), ''starter'', ''trial'', ''{}''::jsonb, now() + interval ''14 days'')',
    'values (btrim(p_org_name), v_slug, nullif(btrim(coalesce(p_industry, '''')), ''''), ''starter'', ''trial'', ''{}''::jsonb, now() + interval ''14 days'', (select email from auth.users where id = v_user), coalesce(v_profile.full_name, (select email from auth.users where id = v_user)))');
  v_new := replace(v_new,
    'insert into tenants (name, slug, industry, plan, status, settings, trial_ends_at)',
    'insert into tenants (name, slug, industry, plan, status, settings, trial_ends_at, admin_email, admin_name)');

  IF v_new = v_src THEN
    RAISE EXCEPTION '378: could not locate the tenants INSERT in complete_signup — its shape changed, refusing to guess';
  END IF;

  -- (1) the baseline knowledge grants, immediately after the owner is linked.
  -- Anchored with a whitespace-tolerant regex: pg_get_functiondef returns the
  -- body with its real newlines and indentation, so a literal replace built
  -- from a normalised copy matches nothing. That is what failed on the first
  -- attempt, and the assertion below is what caught it.
  v_new := regexp_replace(v_new,
    '(where\s+user_id\s*=\s*v_user\s+and\s+tenant_id\s+is\s+null\s*;)',
    E'\\1\n  perform public.grant_workspace_baseline_access(v_tenant.id, v_user);',
    'i');

  IF v_new !~ 'grant_workspace_baseline_access' THEN
    RAISE EXCEPTION '378: could not insert the grant call into complete_signup';
  END IF;

  EXECUTE v_new;
END $patch$;

-- ── Backfill any tenant that slipped through ────────────────────────────────
-- Additive only: adds missing grants, removes nothing. Every established tenant
-- already has all five, so this is a no-op for them and a repair for anything
-- created since the ACL shipped.
DO $backfill$
DECLARE r record; v_total int := 0; v_n int;
BEGIN
  FOR r IN SELECT id, slug FROM tenants LOOP
    v_n := public.grant_workspace_baseline_access(r.id, NULL);
    IF v_n > 0 THEN
      v_total := v_total + v_n;
      RAISE NOTICE '378: % was missing % baseline grant(s)', r.slug, v_n;
    END IF;
  END LOOP;
  RAISE NOTICE '378: backfilled % grant(s) in total', v_total;
END $backfill$;

-- ── Prove it ────────────────────────────────────────────────────────────────
DO $assert$
DECLARE v_src text; v_bad text; v_no_email int;
BEGIN
  SELECT regexp_replace(pg_get_functiondef(p.oid), '\s+', ' ', 'g') INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'complete_signup';

  IF v_src !~ 'grant_workspace_baseline_access' THEN
    RAISE EXCEPTION '378: complete_signup does not grant baseline knowledge access';
  END IF;
  IF v_src !~ 'admin_email' THEN
    RAISE EXCEPTION '378: complete_signup does not record the owner email';
  END IF;
  -- Every original guard must survive the patch.
  IF v_src !~ 'not_authenticated' OR v_src !~ 'already_has_tenant'
     OR v_src !~ 'org_name_required' OR v_src !~ 'Refusing to provision the reserved demo tenant' THEN
    RAISE EXCEPTION '378: a complete_signup guard was lost in the rewrite';
  END IF;

  -- No tenant may now be missing workspace-level knowledge access.
  SELECT string_agg(t.slug, ', ') INTO v_bad
    FROM tenants t
   WHERE NOT EXISTS (SELECT 1 FROM knowledge_access_grants k
                      WHERE k.tenant_id = t.id AND k.resource_type = 'workspace');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '378: tenant(s) still without workspace knowledge access: %', v_bad;
  END IF;

  -- Reported, not enforced: existing rows predate this and back-filling an
  -- address we cannot verify would be inventing data.
  SELECT count(*) INTO v_no_email FROM tenants WHERE coalesce(btrim(admin_email), '') = '';
  RAISE NOTICE '378: baseline access guaranteed for every tenant; % existing tenant(s) still have no admin_email (new ones now always do)', v_no_email;
END $assert$;

NOTIFY pgrst, 'reload schema';
