-- 439_scope_cancel_case_continuation.sql
-- ============================================================================
-- P1 from docs/32, verified live. cancel_case_continuation(p_event_id) cancels
-- a pending case event — the continuation an employee is waiting on. Tenant-safe
-- with a service_role bypass; no assignment check, so any member could cancel
-- another employee's pending work.
--
-- de_case_events.de_id is NOT NULL, so the plain guard shape is correct.
--
-- ⚠ Verified, and worth recording: this function carries anon EXECUTE. It fails
-- CLOSED — for anon, auth_tenant_id() is NULL and `v_tenant IS DISTINCT FROM
-- NULL` is true, so the tenant branch refuses before anything is written. The
-- grant is inert, not a hole, which is why the invariant suite stays green. It
-- is revoked here anyway as housekeeping, matching migration 433: the report's
-- own "fails closed (safe today, but should still be revoked)" list names it.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_upd text := '  UPDATE de_case_events SET status = ''cancelled'', decided_at = now() WHERE id = p_event_id;';
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='cancel_case_continuation';
  IF v_src IS NULL THEN RAISE EXCEPTION '439: cancel_case_continuation not found'; END IF;
  IF v_src ILIKE '%can_access_de%' THEN RAISE NOTICE '439: already scoped'; RETURN; END IF;

  v_eol := CASE WHEN position(chr(13)||chr(10) in v_src) > 0 THEN chr(13)||chr(10) ELSE chr(10) END;

  v_hits := (length(v_src) - length(replace(v_src, a_upd, ''))) / length(a_upd);
  IF v_hits <> 1 THEN RAISE EXCEPTION '439: expected 1 cancel update, found %', v_hits; END IF;

  -- The existing SELECT resolves only tenant_id; extend it to carry de_id so the
  -- guard tests the same row the UPDATE will touch.
  v_new := v_src;
  v_new := replace(v_new, 'DECLARE v_tenant uuid;', 'DECLARE v_tenant uuid; v_de uuid;');
  v_new := replace(v_new,
    'SELECT tenant_id INTO v_tenant FROM de_case_events WHERE id = p_event_id AND status = ''pending'';',
    'SELECT tenant_id, de_id INTO v_tenant, v_de FROM de_case_events WHERE id = p_event_id AND status = ''pending'';');
  v_new := replace(v_new, a_upd, array_to_string(ARRAY[
    '  -- DE scoping (mig 385/439). de_case_events.de_id is NOT NULL, and it comes',
    '  -- off the same row the UPDATE below touches. Service callers bypass, as',
    '  -- they do for the tenant check above.',
    '  IF coalesce(auth.role(),'''') <> ''service_role'' AND NOT public.can_access_de(v_de) THEN',
    '    RETURN jsonb_build_object(''ok'', false, ''error'', ''not_responsible_for_de'');',
    '  END IF;',
    a_upd], v_eol));

  IF v_new = v_src THEN RAISE EXCEPTION '439: edit did not land'; END IF;
  EXECUTE v_new;
END $patch$;

REVOKE ALL ON ROUTINE public.cancel_case_continuation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON ROUTINE public.cancel_case_continuation(uuid) TO authenticated;

DO $assert$
DECLARE v_def text; v_calls int; v_out jsonb;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='cancel_case_continuation';
  v_calls := (length(v_def) - length(replace(v_def,'public.can_access_de(',''))) / length('public.can_access_de(');
  IF v_calls <> 1 THEN RAISE EXCEPTION '439: expected exactly 1 guard, found %', v_calls; END IF;
  -- The guard is only sound if v_de is resolved from the event row.
  IF v_def NOT LIKE '%SELECT tenant_id, de_id INTO v_tenant, v_de%' THEN
    RAISE EXCEPTION '439: v_de is not resolved from the event — the guard would test a null forever';
  END IF;
  IF v_def NOT LIKE '%not_found_or_decided%' THEN
    RAISE EXCEPTION '439: the pending-event check was lost';
  END IF;
  IF position('not_tenant_member' in v_def) > position('can_access_de' in v_def) THEN
    RAISE EXCEPTION '439: the scope guard runs before the tenant check';
  END IF;
  IF position('can_access_de' in v_def) > position('UPDATE de_case_events' in v_def) THEN
    RAISE EXCEPTION '439: the guard lands after the cancel';
  END IF;
  IF has_function_privilege('anon','public.cancel_case_continuation(uuid)','EXECUTE') THEN
    RAISE EXCEPTION '439: anon still holds EXECUTE';
  END IF;
  IF NOT has_function_privilege('authenticated','public.cancel_case_continuation(uuid)','EXECUTE') THEN
    RAISE EXCEPTION '439: authenticated lost EXECUTE';
  END IF;

  SELECT public.cancel_case_continuation('00000000-0000-0000-0000-000000000000'::uuid) INTO v_out;
  IF v_out->>'error' <> 'not_found_or_decided' THEN
    RAISE EXCEPTION '439: expected not_found_or_decided, got %', coalesce(v_out::text,'null');
  END IF;

  RAISE NOTICE '439: cancel_case_continuation scoped; inert anon grant revoked.';
END $assert$;

NOTIFY pgrst, 'reload schema';
