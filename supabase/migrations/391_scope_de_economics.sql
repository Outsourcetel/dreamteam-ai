-- 391_scope_de_economics.sql
-- ============================================================================
-- Phase 3 Wave 2, group A. See docs/30-de-scoping-wave2-worklist.md.
--
-- get_de_economics(p_tenant_id, p_de_id, p_days) is the ROI panel: hours saved,
-- FTE equivalent, AI spend, human-cost equivalent. Like get_benchmark_report,
-- p_de_id is optional and the whole-workspace call is the default one. It is
-- SECURITY DEFINER, so migration 386's restrictive policy on de_conversations
-- does not apply, and nothing checks which employees the caller is responsible
-- for.
--
-- ── Four reads, four predicates ────────────────────────────────────────────
--   evidence_run_decisions × evidence_runs   er.de_id     inquiries handled
--   action_executions                        subject_id   actions executed
--   de_conversations                         de_id        conversations
--   de_token_usage                           u.de_id      real AI spend
--
-- action_executions is the one to read twice: its de reference is `subject_id`,
-- meaningful only because the same WHERE already pins `subject_kind = 'de'`.
-- Scoping on subject_id without that pin would be comparing a de_id to whatever
-- other kind of subject the row happens to carry.
--
-- Null de_id needs no special case, for the reason set out in 390:
-- can_access_de(NULL) is true for owner/admin/manager and false for a scoped
-- user, so unattributed cost and conversation rows stay in the workspace-wide
-- totals for whoever owns the whole workspace.
--
-- ⚠ The derived numbers move with the scope, and that is correct but worth
-- saying out loud: a scoped user's ROI panel reports the return on THEIR
-- employees, not the workspace's. hours_saved, fte_equivalent and roi_ratio are
-- all computed from the counts above, so they narrow automatically.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text;
  a_evid  text := '(p_de_id is null or er.de_id = p_de_id)';
  a_act   text := '(p_de_id is null or subject_id = p_de_id)';
  a_conv  text := '(p_de_id is null or de_id = p_de_id)';
  a_usage text := '(p_de_id is null or u.de_id = p_de_id)';
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_de_economics';
  IF v_src IS NULL THEN RAISE EXCEPTION '391: get_de_economics not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '391: already scoped, nothing to do';
    RETURN;
  END IF;

  FOR v_hits IN
    SELECT (length(v_src) - length(replace(v_src, a, ''))) / length(a)
      FROM unnest(ARRAY[a_evid, a_act, a_conv, a_usage]) a
  LOOP
    IF v_hits <> 1 THEN
      RAISE EXCEPTION '391: an anchor matched % times instead of 1 — the body changed, refusing to guess', v_hits;
    END IF;
  END LOOP;

  v_new := v_src;
  v_new := replace(v_new, a_evid,  a_evid  || ' and public.can_access_de(er.de_id)');
  -- subject_id is only a de_id because subject_kind = 'de' is already pinned in
  -- the same WHERE. Do not lift this predicate anywhere that is not true.
  v_new := replace(v_new, a_act,   a_act   || ' and public.can_access_de(subject_id)');
  v_new := replace(v_new, a_conv,  a_conv  || ' and public.can_access_de(de_id)');
  v_new := replace(v_new, a_usage, a_usage || ' and public.can_access_de(u.de_id)');

  IF v_new = v_src THEN
    RAISE EXCEPTION '391: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_out jsonb; v_tenant uuid;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_de_economics';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  IF v_guards <> 4 THEN
    RAISE EXCEPTION '391: expected exactly 4 scope guards (one per source read), found %', v_guards;
  END IF;

  -- The subject_kind pin must still be there, or the action guard is comparing
  -- a de_id to something that is not one.
  IF v_def NOT LIKE '%subject_kind = ''de''%' THEN
    RAISE EXCEPTION '391: subject_kind pin lost — can_access_de(subject_id) is no longer sound';
  END IF;
  IF v_def NOT LIKE '%not authorized to view this workspace%' THEN
    RAISE EXCEPTION '391: the workspace-membership check was lost in the rewrite';
  END IF;
  IF v_def NOT LIKE '%9600.0 * p_days / 30.0%'
     OR v_def NOT LIKE '%avg_fte_cost_monthly_usd%'
     OR v_def NOT LIKE '%unconfigured%' THEN
    RAISE EXCEPTION '391: the body lost content — a stale or truncated definition was applied';
  END IF;

  SELECT id INTO v_tenant FROM tenants LIMIT 1;
  IF v_tenant IS NOT NULL THEN
    SELECT public.get_de_economics(v_tenant, NULL, 30) INTO v_out;
    IF v_out->'counts' IS NULL OR v_out->'baselines' IS NULL THEN
      RAISE EXCEPTION '391: get_de_economics no longer returns its contract';
    END IF;
  END IF;

  RAISE NOTICE '391: economics scoped on all 4 source reads. A scoped user''s ROI panel reports on THEIR employees — verify that is intended before the first scoped role is granted.';
END $assert$;

NOTIFY pgrst, 'reload schema';
