-- 414_guard_create_browser_operation.sql
-- ============================================================================
-- Phase 3 Wave 2, GROUP B (actors) — browser-operator sub-group. See docs/30.
--
-- ⚠ READ THIS BEFORE COUNTING IT AS A HOLE CLOSED — IT IS NOT ONE. ─────────
-- create_browser_operation already refuses anyone who is not service_role or a
-- member of this workspace holding tenant_owner / tenant_admin / tenant_manager:
--
--     IF NOT v_is_service AND NOT (v_tenant = public.auth_tenant_id()
--          AND public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin','tenant_manager'])) THEN
--       RETURN jsonb_build_object('ok', false, 'error', 'not_permitted');
--
-- and can_access_de() returns TRUE for service_role, platform admins, and all
-- three of those roles — unconditionally, before the assignment lookup is ever
-- reached. **Every caller who can reach this function already passes the check
-- being added. THIS MIGRATION CHANGES NO BEHAVIOUR.**
--
-- The docs/30 worklist classified this as an unguarded actor. On the evidence
-- that is an overstatement: a scoped user cannot reach it at all, today. The
-- browser-operator surface a scoped user COULD reach was the reader
-- list_browser_operator, and that was closed in migration 397.
--
-- ── Why apply it anyway ───────────────────────────────────────────────────
-- Two reasons, and neither is "to finish the list".
--
-- 1. Browser operations are the highest-consequence surface in the product: a
--    task here carries a credential_policy that can be 'vault_injected', which
--    means the runtime is handed a REAL STORED CREDENTIAL for a customer's
--    system. If browser operations are ever opened below manager — plausible,
--    it is a work surface — the guard needs to be in place already, not
--    remembered.
-- 2. One predicate, delegated to from everywhere (docs/29). Relying on the role
--    gate alone leaves the access rule written in two places, which is the
--    mistake the knowledge ACL taught.
--
-- Recorded as defence in depth so the next audit finds a guard AND the reason,
-- rather than concluding the exposure was real and mis-measuring the wave.
--
-- ── Mechanism: the error envelope, not RAISE ──────────────────────────────
-- This function reports every failure as {ok:false, error:...} — de_not_found,
-- not_permitted, browser_operator_disabled, system_not_operable. The guard
-- matches that contract, exactly as the write-back four do (see 410). Its
-- sibling propose_browser_task RAISEs instead, and 415 matches THAT contract.
-- Same rule, two mechanisms, chosen per function.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_role text; v_guard text; v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_browser_operation';
  IF v_src IS NULL THEN RAISE EXCEPTION '414: create_browser_operation not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '414: already guarded, nothing to do';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13) || chr(10) in v_src) > 0
                THEN chr(13) || chr(10) ELSE chr(10) END;

  a_role := array_to_string(ARRAY[
    '  IF NOT v_is_service AND NOT (v_tenant = public.auth_tenant_id()',
    '       AND public.auth_has_tenant_role(ARRAY[''tenant_owner'',''tenant_admin'',''tenant_manager''])) THEN',
    '    RETURN jsonb_build_object(''ok'', false, ''error'', ''not_permitted'');',
    '  END IF;'], v_eol);

  v_guard := array_to_string(ARRAY[
    -- NB: this comment deliberately avoids the bare token, so that counting
    -- occurrences of it in the body stays equal to the number of real guards.
    '  -- DE scoping (mig 385/414). DEFENCE IN DEPTH, NOT A FIX: every role that',
    '  -- passes the gate above already satisfies the check below. It bites only',
    '  -- if browser operations are opened below manager — and a task here can',
    '  -- carry credential_policy = vault_injected, i.e. a real stored credential',
    '  -- for a customer system, so that is the day it must already be present.',
    '  IF NOT public.can_access_de(p_de_id) THEN',
    '    RETURN jsonb_build_object(''ok'', false, ''error'', ''not_responsible_for_de'');',
    '  END IF;'], v_eol);

  v_hits := (length(v_src) - length(replace(v_src, a_role, ''))) / length(a_role);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '414: expected 1 role gate to anchor to, found % — the body changed, refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, a_role, a_role || v_eol || v_guard);
  IF v_new = v_src THEN
    RAISE EXCEPTION '414: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_out jsonb;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_browser_operation';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  IF v_guards <> 1 THEN
    RAISE EXCEPTION '414: expected exactly 1 guard, found %', v_guards;
  END IF;
  IF v_def NOT LIKE '%RETURN jsonb_build_object(''ok'', false, ''error'', ''not_responsible_for_de'')%' THEN
    RAISE EXCEPTION '414: the guard does not return the error envelope this function contracts on';
  END IF;

  -- ⚠ THE CRITICAL ASSERTION IN THIS FILE.
  -- The role gate is the check actually doing the work. If the rewrite had
  -- traded it for the redundant guard, this migration would have WIDENED
  -- access — can_access_de passes any assigned user, while the gate requires
  -- manager or above. It would have looked like a security improvement.
  IF v_def NOT LIKE '%auth_has_tenant_role(ARRAY[''tenant_owner'',''tenant_admin'',''tenant_manager''])%' THEN
    RAISE EXCEPTION '414: the manager+ role gate was lost — this migration would have WIDENED access, not narrowed it';
  END IF;
  IF v_def NOT LIKE '%not_permitted%' THEN
    RAISE EXCEPTION '414: the not_permitted refusal was lost in the rewrite';
  END IF;
  IF position('not_permitted' in v_def) > position('can_access_de' in v_def) THEN
    RAISE EXCEPTION '414: the scope guard runs before the role gate';
  END IF;

  -- The feature flag and the operability checks must still precede the writes.
  IF v_def NOT LIKE '%browser_operator_disabled%' THEN
    RAISE EXCEPTION '414: the computer_use feature gate was lost — Browser Operator is default-OFF for a reason';
  END IF;
  IF v_def NOT LIKE '%system_not_operable%' OR v_def NOT LIKE '%no_operate_domain%' THEN
    RAISE EXCEPTION '414: an operability check was lost in the rewrite';
  END IF;
  -- The credential policy and the domain confinement are the safety properties
  -- this function exists to establish.
  IF v_def NOT LIKE '%vault_injected%' OR v_def NOT LIKE '%allowed_domains%' THEN
    RAISE EXCEPTION '414: the credential policy or domain confinement was lost — a task could run unconfined';
  END IF;
  IF position('can_access_de' in v_def) > position('INSERT INTO computer_use_tasks' in v_def) THEN
    RAISE EXCEPTION '414: the guard lands after the task insert';
  END IF;

  -- Runtime smoke test: postgres is a member of no workspace and is not
  -- service_role, so de_not_found fires first on an unknown employee.
  SELECT public.create_browser_operation(
           '00000000-0000-0000-0000-000000000000'::uuid, 'nope', 'do a thing', 5) INTO v_out;
  IF v_out->>'error' <> 'de_not_found' THEN
    RAISE EXCEPTION '414: expected de_not_found, got %', coalesce(v_out::text, 'null');
  END IF;

  RAISE NOTICE '414: guard added. NO BEHAVIOURAL CHANGE — manager+ already passed can_access_de. Defence in depth, counted as such.';
END $assert$;

NOTIFY pgrst, 'reload schema';
