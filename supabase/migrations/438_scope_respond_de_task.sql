-- 438_scope_respond_de_task.sql
-- ============================================================================
-- P1 from docs/32, verified live. respond_de_task(p_request_id, p_status,
-- p_result) is the cross-DE task protocol: the RECEIVING employee reports
-- accepted / in_progress / completed / declined / failed on work another
-- employee delegated to it.
--
-- A terminal status is not just a label — 'completed' routes through
-- conclude_objective_verified (assess, log, withhold-on-enforce) and
-- 'declined'/'failed' set the receiver's objective to blocked. So an unscoped
-- caller could close or block work on an employee they are not responsible for,
-- and the audit event is written under that employee's own name.
--
-- Tenant-safe already, with a service_role bypass. Missing the assignment axis.
--
-- ── Guarded on the RECEIVER, and the bypass is preserved ────────────────
-- de_task_requests.to_de_id is NOT NULL, so the plain guard shape is correct.
-- It is the receiver that is acting, so to_de_id is the right subject — not
-- from_de_id, which merely asked.
--
-- The guard sits inside the same non-service_role condition the tenant check
-- uses: this is predominantly a MACHINE path (de-work responds on an
-- employee's behalf with the service role), and an unconditional guard would
-- have to be satisfied by a worker that has no user identity. can_access_de
-- returns true for service_role by name, so this is belt-and-braces rather
-- than strictly required — but keeping the shape identical to the tenant check
-- beside it means the two can never disagree about who is a trusted caller.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_tenant text := '  IF NOT v_is_service AND r.tenant_id IS DISTINCT FROM public.auth_tenant_id() THEN';
  a_close  text := '    RETURN jsonb_build_object(''ok'', false, ''error'', ''not_tenant_member'');';
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='respond_de_task';
  IF v_src IS NULL THEN RAISE EXCEPTION '438: respond_de_task not found'; END IF;
  IF v_src ILIKE '%can_access_de%' THEN RAISE NOTICE '438: already scoped'; RETURN; END IF;

  v_eol := CASE WHEN position(chr(13)||chr(10) in v_src) > 0 THEN chr(13)||chr(10) ELSE chr(10) END;

  v_hits := (length(v_src) - length(replace(v_src, a_close, ''))) / length(a_close);
  IF v_hits <> 1 THEN RAISE EXCEPTION '438: expected 1 not_tenant_member return, found %', v_hits; END IF;

  v_new := replace(v_src, a_close || v_eol || '  END IF;', array_to_string(ARRAY[
    a_close,
    '  END IF;',
    '  -- DE scoping (mig 385/438). Guarded on the RECEIVER (to_de_id, NOT NULL):',
    '  -- it is the receiver that acts, and a terminal status concludes or blocks',
    '  -- its objective. Same non-service condition as the tenant check above, so',
    '  -- the two can never disagree about who is a trusted caller.',
    '  IF NOT v_is_service AND NOT public.can_access_de(r.to_de_id) THEN',
    '    RETURN jsonb_build_object(''ok'', false, ''error'', ''not_responsible_for_de'');',
    '  END IF;'], v_eol));

  IF v_new = v_src THEN RAISE EXCEPTION '438: edit did not land'; END IF;
  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_calls int; v_out jsonb;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='respond_de_task';
  v_calls := (length(v_def) - length(replace(v_def,'public.can_access_de(',''))) / length('public.can_access_de(');
  IF v_calls <> 1 THEN RAISE EXCEPTION '438: expected exactly 1 guard, found %', v_calls; END IF;
  IF v_def NOT LIKE '%''not_responsible_for_de''%' THEN
    RAISE EXCEPTION '438: the guard does not refuse in this function''s envelope';
  END IF;
  -- The receiver, not the sender.
  IF v_def NOT LIKE '%can_access_de(r.to_de_id)%' THEN
    RAISE EXCEPTION '438: the guard is not on the receiving employee';
  END IF;
  -- ⚠ The worker bypass must survive, or de-work cannot respond for a DE.
  IF v_def NOT LIKE '%NOT v_is_service AND NOT public.can_access_de%' THEN
    RAISE EXCEPTION '438: the service bypass is missing — de-work could not respond on an employee''s behalf';
  END IF;
  IF position('not_tenant_member' in v_def) > position('can_access_de' in v_def) THEN
    RAISE EXCEPTION '438: the scope guard runs before the tenant check';
  END IF;
  IF position('can_access_de' in v_def) > position('UPDATE de_task_requests' in v_def)
     OR position('can_access_de' in v_def) > position('conclude_objective_verified' in v_def) THEN
    RAISE EXCEPTION '438: the guard lands after a mutation';
  END IF;
  IF v_def NOT LIKE '%bad_status%' THEN RAISE EXCEPTION '438: the body lost content'; END IF;

  SELECT public.respond_de_task('00000000-0000-0000-0000-000000000000'::uuid,'nope') INTO v_out;
  IF v_out->>'error' <> 'bad_status' THEN
    RAISE EXCEPTION '438: expected bad_status, got %', coalesce(v_out::text,'null');
  END IF;

  RAISE NOTICE '438: respond_de_task scoped on the receiving employee.';
END $assert$;

NOTIFY pgrst, 'reload schema';
