-- 435_scope_de_performance_metrics.sql
-- ============================================================================
-- P1 from docs/32-pre-start-reports/02-permission-matrix.md, verified live.
-- The highest-value item in the P1 set: the audit stream's note that "one
-- migration fixes three surfaces" is correct — this feeds list_de_health and
-- get_de_kpi_status as well as its own browser caller (src/lib/api.ts:1082).
--
-- get_de_performance_metrics(p_tenant_id, p_weeks) returns ONE ROW PER DIGITAL
-- EMPLOYEE for the whole workspace: total decisions, resolution rate, average
-- confidence, escalation rate, guardrail blocks, run count, error rate, average
-- and high frustration counts, and a weekly trend series.
--
-- It checks workspace membership and nothing else, so a scoped user would get
-- the full performance profile of every employee — the same shape as
-- get_de_csat_metrics before migration 388, and considerably more revealing.
--
-- ── One predicate, on the outer employee list ────────────────────────────
-- Every CTE feeds LEFT JOINs onto a final `from digital_employees de where
-- de.tenant_id = p_tenant_id`. Filtering there filters the row set and
-- everything hanging off it — the same reasoning as migration 387 on the
-- workforce board. Filtering the CTEs instead would be more places to get
-- wrong and would still emit a zero-filled row for an employee you may not see.
--
-- The existing service_role bypass is untouched: can_access_de returns true for
-- service_role by name, so worker paths are unaffected. get_de_kpi_status
-- (scoped in migration 394) calls this internally and still resolves, because
-- an employee that caller may access passes here too.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_where text := '    where de.tenant_id = p_tenant_id';
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='get_de_performance_metrics';
  IF v_src IS NULL THEN RAISE EXCEPTION '435: get_de_performance_metrics not found'; END IF;
  IF v_src ILIKE '%can_access_de%' THEN RAISE NOTICE '435: already scoped'; RETURN; END IF;

  v_eol := CASE WHEN position(chr(13)||chr(10) in v_src) > 0 THEN chr(13)||chr(10) ELSE chr(10) END;

  v_hits := (length(v_src) - length(replace(v_src, a_where, ''))) / length(a_where);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '435: expected 1 outer employee filter, found % — refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, a_where, array_to_string(ARRAY[
    a_where,
    '      -- DE scoping (mig 385/435). Every CTE above LEFT JOINs onto this row',
    '      -- set, so filtering the employees filters their metrics and trend too.',
    '      and public.can_access_de(de.id)'], v_eol));

  IF v_new = v_src THEN RAISE EXCEPTION '435: edit did not land'; END IF;
  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_calls int; v_n int; v_tenant uuid;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='get_de_performance_metrics';

  v_calls := (length(v_def) - length(replace(v_def,'public.can_access_de(',''))) / length('public.can_access_de(');
  IF v_calls <> 1 THEN RAISE EXCEPTION '435: expected exactly 1 guard, found %', v_calls; END IF;
  IF v_def NOT LIKE '%de.tenant_id = p_tenant_id%' THEN
    RAISE EXCEPTION '435: the tenant filter was lost in the rewrite';
  END IF;
  IF v_def NOT LIKE '%not authorized to view this workspace%' THEN
    RAISE EXCEPTION '435: the membership check was lost in the rewrite';
  END IF;
  -- The service_role bypass keeps de-work and get_de_kpi_status working.
  IF v_def NOT LIKE '%service_role%' THEN
    RAISE EXCEPTION '435: the service_role bypass was lost';
  END IF;
  IF v_def NOT LIKE '%high_frustration_count%' OR v_def NOT LIKE '%trend_agg%' THEN
    RAISE EXCEPTION '435: the body lost content — a stale or truncated definition was applied';
  END IF;

  -- Behaviour, not text: postgres is in no workspace, so the row set must be
  -- empty rather than every employee. auth.role() is null here, which the
  -- function treats as a trusted-server call, so the membership check is
  -- skipped and only the new guard stands between the caller and the data.
  SELECT id INTO v_tenant FROM tenants LIMIT 1;
  IF v_tenant IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM public.get_de_performance_metrics(v_tenant, 4);
    IF v_n <> 0 THEN
      RAISE EXCEPTION '435: an unscoped caller still received % employee rows', v_n;
    END IF;
  END IF;

  RAISE NOTICE '435: performance metrics scoped — also covers list_de_health and get_de_kpi_status.';
END $assert$;

NOTIFY pgrst, 'reload schema';
