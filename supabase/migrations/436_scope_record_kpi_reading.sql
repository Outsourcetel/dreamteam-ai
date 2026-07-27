-- 436_scope_record_kpi_reading.sql
-- ============================================================================
-- P1 from docs/32, verified live. record_kpi_reading(p_de_id, ...) writes a
-- manual KPI reading against a digital employee. It is tenant-safe (auth_tenant_id
-- plus a de-in-tenant check) but has no assignment check, so any member could
-- record a reading against any employee.
--
-- That is not cosmetic. get_de_kpi_status (scoped in mig 394) falls back to the
-- latest MANUAL reading for metrics the platform does not compute — the GI-5
-- "human readings only" path. So a false reading here becomes another
-- employee's reported KPI, and the fallback is exactly where nobody would think
-- to look for it.
--
-- ── DE scoping, not a role gate ─────────────────────────────────────────
-- The audit stream grouped this with writers lacking auth_has_tenant_role.
-- Recording a reading is day-to-day work on an employee you are responsible
-- for, not a workspace-level act, so the assignment axis is the right fix and a
-- manager+ gate would be over-restrictive — it would stop the very person
-- assigned to an employee from recording its numbers. The existing
-- de_not_found check already proves the employee is in the caller's workspace,
-- so the plain guard shape is correct.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_ins text := '  INSERT INTO de_kpi_readings (tenant_id, de_id, metric_key, value, as_of, recorded_by, note)';
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='record_kpi_reading';
  IF v_src IS NULL THEN RAISE EXCEPTION '436: record_kpi_reading not found'; END IF;
  IF v_src ILIKE '%can_access_de%' THEN RAISE NOTICE '436: already scoped'; RETURN; END IF;

  v_eol := CASE WHEN position(chr(13)||chr(10) in v_src) > 0 THEN chr(13)||chr(10) ELSE chr(10) END;

  v_hits := (length(v_src) - length(replace(v_src, a_ins, ''))) / length(a_ins);
  IF v_hits <> 1 THEN RAISE EXCEPTION '436: expected 1 insert, found %', v_hits; END IF;

  v_new := replace(v_src, a_ins, array_to_string(ARRAY[
    '  -- DE scoping (mig 385/436). A manual reading is the fallback source for',
    '  -- get_de_kpi_status, so an unscoped write here becomes another employee''''s',
    '  -- reported KPI. The de_not_found check above proves p_de_id is in this',
    '  -- workspace, so no null case.',
    '  IF NOT public.can_access_de(p_de_id) THEN',
    '    RAISE EXCEPTION ''not_responsible_for_de: this employee is not in your reporting line'';',
    '  END IF;',
    '',
    a_ins], v_eol));

  IF v_new = v_src THEN RAISE EXCEPTION '436: edit did not land'; END IF;
  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_calls int; v_raised text; v_fired boolean := false;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='record_kpi_reading';
  v_calls := (length(v_def) - length(replace(v_def,'public.can_access_de(',''))) / length('public.can_access_de(');
  IF v_calls <> 1 THEN RAISE EXCEPTION '436: expected exactly 1 guard, found %', v_calls; END IF;
  IF v_def NOT LIKE '%not_responsible_for_de%' THEN
    RAISE EXCEPTION '436: the guard does not RAISE — an actor must refuse, not filter';
  END IF;
  IF v_def NOT LIKE '%de_not_found%' THEN
    RAISE EXCEPTION '436: the de-in-tenant check was lost in the rewrite';
  END IF;
  IF position('de_not_found' in v_def) > position('can_access_de' in v_def) THEN
    RAISE EXCEPTION '436: the scope guard runs before the tenant check';
  END IF;
  IF position('can_access_de' in v_def) > position('INSERT INTO de_kpi_readings' in v_def) THEN
    RAISE EXCEPTION '436: the guard lands after the insert';
  END IF;

  BEGIN
    PERFORM public.record_kpi_reading('00000000-0000-0000-0000-000000000000'::uuid, 'k', 1);
  EXCEPTION WHEN others THEN v_raised := SQLERRM; v_fired := true; END;
  IF NOT v_fired OR v_raised NOT LIKE '%not_authenticated%' THEN
    RAISE EXCEPTION '436: expected the auth gate to fire first, got: %', coalesce(v_raised,'(nothing)');
  END IF;

  RAISE NOTICE '436: record_kpi_reading scoped.';
END $assert$;

NOTIFY pgrst, 'reload schema';
