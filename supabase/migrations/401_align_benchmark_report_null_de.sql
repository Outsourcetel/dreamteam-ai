-- 401_align_benchmark_report_null_de.sql
-- ============================================================================
-- Corrects migration 390 — mine, applied earlier in this same session. Same
-- defect and same reasoning as 400; see that file's header for the full
-- argument. In short: migration 386's shipped policies read
-- `(de_id IS NULL) OR can_access_de(de_id)`, and a bare can_access_de(de_id) is
-- FALSE for a scoped user on a null de_id — so 390 answered a question about
-- unattributed rows differently from the RLS policy on the same table.
--
-- ── All five reads here allow a null de_id, or are unaffected ──────────────
--   billable_outcomes   de_id nullable   outcomes attributed to no employee
--   eval_judgments      de_id nullable   judgments not tied to an employee
--   de_conversations    de_id nullable   14 such rows in production today
--   de_token_usage      de_id nullable   spend not attributable to an employee
--   sim_runs            de_id NOT NULL   ← the null clause is inert here
--
-- All five are aligned uniformly rather than four-of-five. On sim_runs the
-- added clause can never be true, so it costs nothing and buys something worth
-- more than the character count: every DE guard in the codebase reads the same
-- way. A reader who has to check the column's nullability to know whether a
-- guard is the standard one will eventually not check.
--
-- Nobody's view changes today — every live user is owner, admin or manager and
-- passes can_access_de unconditionally.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text;
  a_plain text := 'and public.can_access_de(de_id)';
  a_alias text := 'and public.can_access_de(u.de_id)';
  v_plain int; v_alias int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_benchmark_report';
  IF v_src IS NULL THEN RAISE EXCEPTION '401: get_benchmark_report not found'; END IF;

  IF v_src LIKE '%is null or public.can_access_de%' THEN
    RAISE NOTICE '401: already aligned, nothing to do';
    RETURN;
  END IF;
  IF v_src NOT LIKE '%can_access_de%' THEN
    RAISE EXCEPTION '401: no scope guards present — migration 390 has not been applied';
  END IF;

  v_plain := (length(v_src) - length(replace(v_src, a_plain, ''))) / length(a_plain);
  v_alias := (length(v_src) - length(replace(v_src, a_alias, ''))) / length(a_alias);
  IF v_plain <> 4 THEN
    RAISE EXCEPTION '401: expected 4 unaliased guards, found % — refusing to guess', v_plain;
  END IF;
  IF v_alias <> 1 THEN
    RAISE EXCEPTION '401: expected 1 aliased guard, found % — refusing to guess', v_alias;
  END IF;

  v_new := v_src;
  v_new := replace(v_new, a_plain, 'and (de_id is null or public.can_access_de(de_id))');
  v_new := replace(v_new, a_alias, 'and (u.de_id is null or public.can_access_de(u.de_id))');

  IF v_new = v_src THEN
    RAISE EXCEPTION '401: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_aligned int; v_total int; v_out jsonb; v_tenant uuid;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_benchmark_report';

  v_aligned := (length(v_def) - length(replace(v_def, 'is null or public.can_access_de', '')))
               / length('is null or public.can_access_de');
  v_total   := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');

  IF v_aligned <> 5 THEN
    RAISE EXCEPTION '401: expected 5 null-aligned guards, found %', v_aligned;
  END IF;
  IF v_total <> 5 THEN
    RAISE EXCEPTION '401: expected 5 guards in total, found % — a read was gained or lost', v_total;
  END IF;
  IF v_def NOT LIKE '%not authorized%' THEN
    RAISE EXCEPTION '401: the workspace-membership check was lost in the rewrite';
  END IF;
  IF v_def NOT LIKE '%cost_per_resolution_cents%'
     OR v_def NOT LIKE '%Dry-run (candidate) simulations are excluded%' THEN
    RAISE EXCEPTION '401: the body lost content — a stale or truncated definition was applied';
  END IF;

  SELECT id INTO v_tenant FROM tenants LIMIT 1;
  IF v_tenant IS NOT NULL THEN
    SELECT public.get_benchmark_report(v_tenant, NULL, 30) INTO v_out;
    IF v_out->'outcomes' IS NULL OR v_out->'definitions' IS NULL THEN
      RAISE EXCEPTION '401: get_benchmark_report no longer returns its contract';
    END IF;
  END IF;

  RAISE NOTICE '401: benchmark report aligned to the mig-386 guard shape on all 5 reads.';
END $assert$;

NOTIFY pgrst, 'reload schema';
