-- 398_scope_analytics_de_workload.sql
-- ============================================================================
-- Phase 3 Wave 2, group A. See docs/30-de-scoping-wave2-worklist.md.
--
-- ⚠ THIS FUNCTION HAD A CROSS-TENANT HOLE, NOT JUST A SCOPING GAP. ──────────
-- analytics_de_workload(p_tenant_id, p_de_id) is SECURITY DEFINER, granted to
-- `authenticated`, takes the tenant id AS A PARAMETER — and never compares it
-- to the caller's workspace. There is no auth check of any kind in the body.
-- Any signed-in user of any workspace could pass another tenant's id and read
-- that tenant's objective and work-item status counts.
--
-- That is a different and more serious class than the one this wave is about,
-- and adding can_access_de ALONE WOULD NOT HAVE CLOSED IT: an owner or admin
-- passes can_access_de for any uuid at all, because they pass on role before
-- the assignment lookup is ever reached. Scoping this function without also
-- pinning the tenant would have produced a function that looked fixed and was
-- still cross-tenant readable. So both go in, and the tenant check goes first.
--
-- ── Belt and braces, in the right order ────────────────────────────────────
--   1. tenant  — the caller's workspace must be the one being asked about
--                (service_role and platform admins exempt, as everywhere else)
--   2. scope   — and they must be responsible for the employee
--
-- ── This function has ZERO callers ─────────────────────────────────────────
-- Nothing in src/, supabase/functions/ or scripts/ calls it; the only mentions
-- anywhere are docs/30 and this file. That is why fixing it is safe, and it is
-- also the strongest argument for a follow-up: dead SECURITY DEFINER functions
-- granted to `authenticated` are exactly how holes like this survive unnoticed.
-- Recommend dropping it outright — a founder decision, not made here.
--
-- ── Why a predicate and not a RAISE ────────────────────────────────────────
-- This is one of the two `language sql` functions in the wave, and a SQL body
-- cannot raise. Rewriting it as plpgsql to get a nicer error would mean
-- authoring a new body rather than editing the live one, which is the practice
-- that let migration 377 silently revert the export pager. A denied call
-- returns empty counts instead of an error; for a function nothing calls, that
-- is the right trade against re-authoring it.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text;
  v_anchor text := 'where tenant_id = p_tenant_id and de_id = p_de_id';
  v_guard  text :=
    E'where tenant_id = p_tenant_id and de_id = p_de_id\n'
    '         -- 1. the caller''s own workspace, or a trusted server\n'
    '         and (coalesce(auth.role(), '''') = ''service_role''\n'
    '              or public.is_platform_admin()\n'
    '              or p_tenant_id = public.auth_tenant_id())\n'
    '         -- 2. and an employee they are responsible for (mig 385)\n'
    '         and public.can_access_de(p_de_id)';
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'analytics_de_workload';
  IF v_src IS NULL THEN RAISE EXCEPTION '398: analytics_de_workload not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '398: already scoped, nothing to do';
    RETURN;
  END IF;

  -- Two reads: de_objectives and de_work_items. Both must be guarded — one of
  -- two is not a fix, it is a fix-shaped thing.
  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 2 THEN
    RAISE EXCEPTION '398: expected 2 unguarded reads, found % — the body changed, refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, v_anchor, v_guard);
  IF v_new = v_src THEN
    RAISE EXCEPTION '398: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_scope int; v_tenant int; v_out jsonb;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'analytics_de_workload';

  v_scope  := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  v_tenant := (length(v_def) - length(replace(v_def, 'auth_tenant_id', ''))) / length('auth_tenant_id');

  -- BOTH guards, on BOTH reads. Asserting only the scope guard would have let
  -- the cross-tenant hole through while reporting success.
  IF v_scope <> 2 THEN
    RAISE EXCEPTION '398: expected 2 scope guards (one per read), found %', v_scope;
  END IF;
  IF v_tenant <> 2 THEN
    RAISE EXCEPTION '398: expected 2 tenant guards (one per read), found % — the cross-tenant hole is not closed', v_tenant;
  END IF;
  IF v_def NOT LIKE '%de_objectives%' OR v_def NOT LIKE '%de_work_items%' THEN
    RAISE EXCEPTION '398: the body lost content — a stale or truncated definition was applied';
  END IF;

  -- Runtime smoke test: it must still return both keys rather than error.
  SELECT public.analytics_de_workload(
           '00000000-0000-0000-0000-000000000000'::uuid,
           '00000000-0000-0000-0000-000000000000'::uuid) INTO v_out;
  IF v_out->'objectives_by_status' IS NULL OR v_out->'work_items_by_status' IS NULL THEN
    RAISE EXCEPTION '398: analytics_de_workload no longer returns its contract';
  END IF;

  RAISE NOTICE '398: cross-tenant hole CLOSED and DE scope added. This function has no callers — recommend dropping it; that is a founder decision.';
END $assert$;

NOTIFY pgrst, 'reload schema';
