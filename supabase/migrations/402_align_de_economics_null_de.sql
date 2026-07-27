-- 402_align_de_economics_null_de.sql
-- ============================================================================
-- Corrects migration 391 — mine, applied earlier in this same session. Last of
-- the three alignment migrations; see 400's header for the full argument.
--
-- ── The four reads ─────────────────────────────────────────────────────────
--   evidence_runs        er.de_id     nullable, BUT the query already pins
--                                     `er.de_id is not null`, so the added
--                                     clause is inert — aligned for uniformity
--   action_executions    subject_id   nullable; sound only because the same
--                                     WHERE pins subject_kind = 'de'
--   de_conversations     de_id        nullable — 14 such rows in production
--   de_token_usage       u.de_id      nullable — unattributable model spend
--
-- ⚠ The ROI numbers move with this. hours_saved, fte_equivalent, roi_ratio and
-- monthly_saving_usd are all derived from the four counts above, so admitting
-- unattributed rows raises them for a scoped user relative to migration 391.
-- That is the intended direction: it matches what the same rows would show
-- through the table's own RLS policy. Nobody sees a different number today —
-- every live user is owner, admin or manager and passes can_access_de
-- unconditionally — but this is the migration to remember when the first ROI
-- panel is read by somebody scoped.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text;
  a_evid  text := 'and public.can_access_de(er.de_id)';
  a_act   text := 'and public.can_access_de(subject_id)';
  a_conv  text := 'and public.can_access_de(de_id)';
  a_usage text := 'and public.can_access_de(u.de_id)';
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_de_economics';
  IF v_src IS NULL THEN RAISE EXCEPTION '402: get_de_economics not found'; END IF;

  IF v_src LIKE '%is null or public.can_access_de%' THEN
    RAISE NOTICE '402: already aligned, nothing to do';
    RETURN;
  END IF;
  IF v_src NOT LIKE '%can_access_de%' THEN
    RAISE EXCEPTION '402: no scope guards present — migration 391 has not been applied';
  END IF;

  FOR v_hits IN
    SELECT (length(v_src) - length(replace(v_src, a, ''))) / length(a)
      FROM unnest(ARRAY[a_evid, a_act, a_conv, a_usage]) a
  LOOP
    IF v_hits <> 1 THEN
      RAISE EXCEPTION '402: a guard anchor matched % times instead of 1 — refusing to guess', v_hits;
    END IF;
  END LOOP;

  v_new := v_src;
  v_new := replace(v_new, a_evid,  'and (er.de_id is null or public.can_access_de(er.de_id))');
  v_new := replace(v_new, a_act,   'and (subject_id is null or public.can_access_de(subject_id))');
  v_new := replace(v_new, a_conv,  'and (de_id is null or public.can_access_de(de_id))');
  v_new := replace(v_new, a_usage, 'and (u.de_id is null or public.can_access_de(u.de_id))');

  IF v_new = v_src THEN
    RAISE EXCEPTION '402: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_aligned int; v_total int; v_out jsonb; v_tenant uuid;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_de_economics';

  v_aligned := (length(v_def) - length(replace(v_def, 'is null or public.can_access_de', '')))
               / length('is null or public.can_access_de');
  v_total   := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');

  IF v_aligned <> 4 THEN
    RAISE EXCEPTION '402: expected 4 null-aligned guards, found %', v_aligned;
  END IF;
  IF v_total <> 4 THEN
    RAISE EXCEPTION '402: expected 4 guards in total, found % — a read was gained or lost', v_total;
  END IF;
  -- Still the load-bearing pin: without subject_kind = 'de', comparing
  -- subject_id to an employee id is meaningless.
  IF v_def NOT LIKE '%subject_kind = ''de''%' THEN
    RAISE EXCEPTION '402: subject_kind pin lost — the action guard is no longer sound';
  END IF;
  IF v_def NOT LIKE '%not authorized to view this workspace%' THEN
    RAISE EXCEPTION '402: the workspace-membership check was lost in the rewrite';
  END IF;
  IF v_def NOT LIKE '%9600.0 * p_days / 30.0%' OR v_def NOT LIKE '%unconfigured%' THEN
    RAISE EXCEPTION '402: the body lost content — a stale or truncated definition was applied';
  END IF;

  SELECT id INTO v_tenant FROM tenants LIMIT 1;
  IF v_tenant IS NOT NULL THEN
    SELECT public.get_de_economics(v_tenant, NULL, 30) INTO v_out;
    IF v_out->'counts' IS NULL OR v_out->'baselines' IS NULL THEN
      RAISE EXCEPTION '402: get_de_economics no longer returns its contract';
    END IF;
  END IF;

  RAISE NOTICE '402: economics aligned. Group A is now internally consistent with the mig-386 policy shape.';
END $assert$;

NOTIFY pgrst, 'reload schema';
