-- 390_scope_benchmark_report.sql
-- ============================================================================
-- Phase 3 Wave 2, group A. See docs/30-de-scoping-wave2-worklist.md.
--
-- get_benchmark_report(p_tenant_id, p_de_id, p_days) takes p_de_id as OPTIONAL.
-- Called with it, it reports on one employee; called without it — which is
-- exactly how the product calls it (src/lib/api.ts:1166 passes only tenant and
-- days) — it aggregates the whole workspace. It is SECURITY DEFINER, so
-- migration 386's restrictive policy on de_conversations is bypassed, and there
-- is no scope check on the p_de_id path either.
--
-- ── One predicate, five reads ──────────────────────────────────────────────
-- The five source reads already share the shape `(p_de_id is null or de_id =
-- p_de_id)`. Adding can_access_de alongside it fixes BOTH paths in one edit:
-- the single-employee call is denied for an employee the caller is not
-- responsible for, and the whole-workspace call narrows to the employees they
-- are.
--
-- ── Why nulls need no special case ─────────────────────────────────────────
-- billable_outcomes, eval_judgments, de_conversations and de_token_usage all
-- allow a NULL de_id — outcomes attributed to no employee. can_access_de(NULL)
-- is TRUE for owner/admin/manager (they pass on role, before the assignment
-- lookup) and FALSE for a scoped user (a lookup on a null de_id matches
-- nothing). So unattributed rows stay in the workspace-wide totals for the
-- people who own the whole workspace, and drop out for someone who owns part of
-- it. That is the behaviour we want, and it falls out of the helper rather than
-- being written twice — which is the whole reason can_access_de exists.
--
-- Reproduce-from-live: pg_get_functiondef, targeted edit, never a paste from an
-- older migration.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text;
  -- Four reads (billable_outcomes, eval_judgments, de_conversations, sim_runs)
  -- share this exact text; de_token_usage aliases its table, so it differs.
  a_plain text := '(p_de_id is null or de_id = p_de_id)';
  a_alias text := '(p_de_id is null or u.de_id = p_de_id)';
  v_plain int; v_alias int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_benchmark_report';
  IF v_src IS NULL THEN RAISE EXCEPTION '390: get_benchmark_report not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '390: already scoped, nothing to do';
    RETURN;
  END IF;

  v_plain := (length(v_src) - length(replace(v_src, a_plain, ''))) / length(a_plain);
  v_alias := (length(v_src) - length(replace(v_src, a_alias, ''))) / length(a_alias);
  -- Assert the exact counts, not "more than zero". If a sixth read is added
  -- later this migration must fail loudly rather than scope five of six and
  -- report success — a partial fix that claims completeness is the failure mode
  -- this whole wave exists to correct.
  IF v_plain <> 4 THEN
    RAISE EXCEPTION '390: expected 4 unaliased de_id filters, found % — the body changed, refusing to guess', v_plain;
  END IF;
  IF v_alias <> 1 THEN
    RAISE EXCEPTION '390: expected 1 aliased (u.de_id) filter, found % — the body changed, refusing to guess', v_alias;
  END IF;

  v_new := v_src;
  v_new := replace(v_new, a_plain, a_plain || ' and public.can_access_de(de_id)');
  v_new := replace(v_new, a_alias, a_alias || ' and public.can_access_de(u.de_id)');

  IF v_new = v_src THEN
    RAISE EXCEPTION '390: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_out jsonb; v_tenant uuid;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_benchmark_report';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  IF v_guards <> 5 THEN
    RAISE EXCEPTION '390: expected exactly 5 scope guards (one per source read), found %', v_guards;
  END IF;

  IF v_def NOT LIKE '%tenant_id = p_tenant_id%' THEN
    RAISE EXCEPTION '390: the tenant filter was lost in the rewrite';
  END IF;
  IF v_def NOT LIKE '%not authorized%' THEN
    RAISE EXCEPTION '390: the workspace-membership check was lost in the rewrite';
  END IF;
  -- The definitions block is the honest-reporting contract this function is
  -- built around; losing it would be a silent product regression.
  IF v_def NOT LIKE '%cost_per_resolution_cents%'
     OR v_def NOT LIKE '%Dry-run (candidate) simulations are excluded%' THEN
    RAISE EXCEPTION '390: the body lost content — a stale or truncated definition was applied';
  END IF;

  -- Runtime smoke test on a real tenant. postgres has a null auth.uid(), and
  -- this function only enforces membership when auth.uid() is NOT null, so it
  -- runs here and must still return its shape.
  SELECT id INTO v_tenant FROM tenants LIMIT 1;
  IF v_tenant IS NOT NULL THEN
    SELECT public.get_benchmark_report(v_tenant, NULL, 30) INTO v_out;
    IF v_out->'outcomes' IS NULL OR v_out->'definitions' IS NULL THEN
      RAISE EXCEPTION '390: get_benchmark_report no longer returns its contract';
    END IF;
  END IF;

  RAISE NOTICE '390: benchmark report scoped on all 5 source reads. Numbers seen here are the postgres role''s, not a user''s.';
END $assert$;

NOTIFY pgrst, 'reload schema';
