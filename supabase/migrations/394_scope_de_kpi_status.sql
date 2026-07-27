-- 394_scope_de_kpi_status.sql
-- ============================================================================
-- Phase 3 Wave 2, group A. See docs/30-de-scoping-wave2-worklist.md.
--
-- get_de_kpi_status(p_de_id) returns an employee's KPIs with their current
-- readings and whether each is being met. It is SECURITY DEFINER, so migration
-- 386's restrictive policy on de_conversations does not apply inside it.
--
-- ── The existing check is the wrong axis ───────────────────────────────────
-- The body resolves the employee's tenant and then asserts the caller belongs
-- to that workspace. That is the ROLE axis — "which doors" — and it is not the
-- question here. The question is the ASSIGNMENT axis — "which rooms": is this
-- caller responsible for THIS employee. docs/29 keeps those two separate on
-- purpose; collapsing them is what produces role names like manager_of_two_des.
-- So the scope check is added, not substituted: workspace membership still has
-- to hold as well.
--
-- ── Where the gate goes ────────────────────────────────────────────────────
-- On the employee lookup at the top. The body already treats an unresolvable
-- employee as an empty result (`if v_tenant is null then return; end if`), and
-- everything after — the metrics call, the CSAT read, the KPI rows and their
-- lateral joins — is keyed on the same p_de_id. Failing the lookup returns
-- zero rows before any of it runs.
--
-- service_role is unaffected: can_access_de returns true for it by name, which
-- is what keeps the dispatchers and the KPI workers running.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text;
  v_anchor text := 'select tenant_id into v_tenant from digital_employees where id = p_de_id;';
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_de_kpi_status';
  IF v_src IS NULL THEN RAISE EXCEPTION '394: get_de_kpi_status not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '394: already scoped, nothing to do';
    RETURN;
  END IF;

  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '394: expected 1 employee lookup, found % — the body changed, refusing to guess', v_hits;
  END IF;

  -- DE scoping (mig 385/394): an inaccessible employee resolves to no tenant,
  -- and the existing null check turns that into an empty result set.
  v_new := replace(v_src, v_anchor,
    'select tenant_id into v_tenant from digital_employees where id = p_de_id and public.can_access_de(id);');

  IF v_new = v_src THEN
    RAISE EXCEPTION '394: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_de_kpi_status';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  IF v_guards <> 1 THEN
    RAISE EXCEPTION '394: expected exactly 1 scope guard, found %', v_guards;
  END IF;

  -- The membership check is the OTHER axis and must survive alongside the new
  -- one. Losing it while adding scoping would trade one hole for another.
  IF v_def NOT LIKE '%not a member of this workspace%' THEN
    RAISE EXCEPTION '394: the workspace-membership check was lost in the rewrite';
  END IF;
  -- service_role must still be exempted by name, or the workers break.
  IF v_def NOT LIKE '%service_role%' THEN
    RAISE EXCEPTION '394: the service_role exemption was lost in the rewrite';
  END IF;
  IF v_def NOT LIKE '%get_de_performance_metrics%'
     OR v_def NOT LIKE '%de_kpi_readings%'
     OR v_def NOT LIKE '%kpi_metric_catalog%' THEN
    RAISE EXCEPTION '394: the body lost content — a stale or truncated definition was applied';
  END IF;
  IF position('can_access_de' in v_def) > position('get_de_performance_metrics' in v_def) THEN
    RAISE EXCEPTION '394: the guard is not ahead of the reads it is meant to gate';
  END IF;

  -- Runtime smoke test: an unknown employee must return zero rows, not error.
  SELECT count(*) INTO v_n FROM public.get_de_kpi_status('00000000-0000-0000-0000-000000000000'::uuid);
  IF v_n <> 0 THEN
    RAISE EXCEPTION '394: an unknown employee returned % rows', v_n;
  END IF;

  RAISE NOTICE '394: KPI status scoped at the employee lookup. Both axes now hold — workspace membership AND responsibility for the employee.';
END $assert$;

NOTIFY pgrst, 'reload schema';
