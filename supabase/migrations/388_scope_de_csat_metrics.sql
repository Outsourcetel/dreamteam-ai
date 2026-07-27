-- 388_scope_de_csat_metrics.sql
-- ============================================================================
-- Phase 3 Wave 2, group A. See docs/30-de-scoping-wave2-worklist.md.
--
-- get_de_csat_metrics(p_tenant_id) returns ONE ROW PER DIGITAL EMPLOYEE for the
-- whole workspace: how many ratings each one got and what share were positive.
-- It is SECURITY DEFINER, so the restrictive policy migration 386 put on
-- de_conversations does not apply inside it — RLS is off for the duration of
-- the call. A scoped user assigned to one employee gets the satisfaction scores
-- of every employee in the workspace.
--
-- It is second only to the board in width, which is why it is next: it is a
-- per-employee list, and it is wired into the product (src/lib/api.ts:1100).
--
-- ── The fix ────────────────────────────────────────────────────────────────
-- One predicate on the grouped read. c.de_id is already required to be non-null
-- by the existing filter, so there is no null case to reason about here.
--
-- Reproduce-from-live: the body is read with pg_get_functiondef and edited in
-- place, never pasted from an older migration. Re-applying a stale body is how
-- 377 silently reverted the export pager.
--
-- Still dark: can_access_de is true for owner, admin and manager, and no live
-- workspace has anybody below manager.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text;
  v_anchor text := 'where c.tenant_id = p_tenant_id and c.csat_submitted_at is not null and c.de_id is not null';
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_de_csat_metrics';
  IF v_src IS NULL THEN RAISE EXCEPTION '388: get_de_csat_metrics not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '388: already scoped, nothing to do';
    RETURN;
  END IF;

  -- Count the anchor BEFORE editing. A previous attempt at this work "succeeded"
  -- while changing nothing — a silent no-op is the worst outcome, because it
  -- leaves a migration in the ledger claiming a hole is closed. Refuse to guess
  -- if the body no longer has exactly the shape this edit was written against.
  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '388: expected 1 occurrence of the CSAT filter, found % — the body changed, refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, v_anchor,
    v_anchor || E'\n      -- DE scoping (mig 385/388): a caller sees the satisfaction scores of the\n      -- employees they are responsible for. Owner/admin/manager see all.\n      and public.can_access_de(c.de_id)');

  IF v_new = v_src THEN
    RAISE EXCEPTION '388: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_raised text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_de_csat_metrics';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  IF v_guards <> 1 THEN
    RAISE EXCEPTION '388: expected exactly 1 scope guard in the body, found %', v_guards;
  END IF;

  -- The rewrite must not have cost the function its tenant filter or its
  -- membership check. A scoping change that drops tenant isolation is worse
  -- than the gap it closes, and looks correct in a diff.
  IF v_def NOT LIKE '%c.tenant_id = p_tenant_id%' THEN
    RAISE EXCEPTION '388: the tenant filter was lost in the rewrite';
  END IF;
  IF v_def NOT LIKE '%not authorized to view this workspace%' THEN
    RAISE EXCEPTION '388: the workspace-membership check was lost in the rewrite';
  END IF;
  IF v_def NOT LIKE '%positive_ratings%' OR v_def NOT LIKE '%csat_pct%' THEN
    RAISE EXCEPTION '388: the body lost content — a stale or truncated definition was applied';
  END IF;

  -- Runtime smoke test. This migration runs as postgres, which has no
  -- auth.uid(), so the function's own gate must still fire. That proves the
  -- plpgsql body executes and that the gate survived — it proves nothing about
  -- what a scoped user sees.
  BEGIN
    PERFORM * FROM public.get_de_csat_metrics('00000000-0000-0000-0000-000000000000'::uuid);
    v_raised := '(nothing raised)';
  EXCEPTION WHEN others THEN
    v_raised := SQLERRM;
  END;
  IF v_raised NOT LIKE '%not authenticated%' THEN
    RAISE EXCEPTION '388: expected the not-authenticated gate to fire, got: %', v_raised;
  END IF;

  RAISE NOTICE '388: get_de_csat_metrics scoped. Only provable with a real signed-in tenant_user assigned to one DE — a migration runs as postgres and has no workspace identity.';
END $assert$;

NOTIFY pgrst, 'reload schema';
