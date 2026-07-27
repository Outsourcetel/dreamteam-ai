-- 429_audit_reporting_line_writers.sql
-- ============================================================================
-- docs/31 commitment #3, requested by the Employee File audit stream. Migration
-- number claimed by the permissions stream because de_assignments is its domain
-- (migs 385-428) and the numbering was at 428.
--
-- ── The gap ───────────────────────────────────────────────────────────────
-- set_de_assignment and remove_de_assignment change WHO IS ACCOUNTABLE for a
-- digital employee, and neither writes an audit event. Verified live via
-- pg_proc: neither body mentions append_audit_event. The retired
-- transfer_de_ownership DOES audit — so the live model lost a habit the dead
-- one had.
--
-- In a product whose pitch is governance, changing the reporting line without a
-- record is the wrong default. It also matters for the scoping work in 385-428:
-- de_assignments is now the input to can_access_de(), so an unaudited row here
-- silently changes what somebody can see and do across 48 guards.
--
-- ── ⚠ TWO CORRECTIONS TO THE REQUESTED SPEC — IT WOULD HAVE BROKEN PROD ───
-- The spec asked for append_audit_event(..., 'user', ..., 'governance', ...).
-- Both values are rejected by CHECK constraints on audit_events:
--
--   audit_events_category_check   allows: resolved, escalated, approval,
--     guardrail_check, guardrail_block, config_change, playbook_step, invoice,
--     connector_sync, connector_action, evidence_step, ACCESS_CONTROL,
--     knowledge_revision, inquiry_triage, action_execution, de_memory,
--     de_consultation, guardrail_adjudication.   'governance' is NOT a member.
--   audit_events_actor_type_check allows: de, human, system.   'user' is NOT.
--
-- Either violation raises inside append_audit_event, and that propagates up and
-- ABORTS THE CALLER. Applied as specified, this migration would have taken
-- set_de_assignment from "does not audit" to "does not work" — a P0 on the
-- reporting-line writer Phase 2 shipped a day earlier.
--
-- Corrected to category 'access_control' (already the live convention — read by
-- src/lib/accessGrantsApi.ts:125 for the access-denials view, 139 rows) and
-- actor_type 'human'. Both are semantically right, not just constraint-legal:
-- assigning responsibility for an employee IS an access-control change made by
-- a person.
--
-- ── Design notes ──────────────────────────────────────────────────────────
-- * Audit AFTER the write, never before: an event claiming a change that then
--   failed is worse than no event. Both are in the same transaction, so a
--   failed audit also rolls back the write — the pair is atomic either way.
-- * remove_de_assignment deletes by bare id, so the row is captured with a
--   DELETE ... RETURNING rather than a separate SELECT: one statement, no race
--   between reading and deleting, and it yields v_n from the same operation.
-- * A removal is only audited when a row was actually deleted. Auditing a
--   no-op delete would fill the trail with events for things that never
--   happened.
-- * set_de_assignment records whether the row was NEW or a RE-ASSIGN (the
--   ON CONFLICT path), because "assigned" and "re-confirmed by someone else"
--   are different governance facts. xmax = 0 on the RETURNING row is the
--   standard way to tell an INSERT from an ON CONFLICT UPDATE.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_ins text; a_ret text; v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'set_de_assignment';
  IF v_src IS NULL THEN RAISE EXCEPTION '429: set_de_assignment not found'; END IF;

  IF v_src ILIKE '%append_audit_event%' THEN
    RAISE NOTICE '429: set_de_assignment already audits, nothing to do';
  ELSE
    v_eol := CASE WHEN position(chr(13) || chr(10) in v_src) > 0
                  THEN chr(13) || chr(10) ELSE chr(10) END;

    -- Capture whether this was an insert or a re-assign, from the same
    -- statement, then audit after it succeeds.
    a_ins := '  RETURNING id INTO v_id;';
    a_ret := '  RETURN v_id;';

    v_hits := (length(v_src) - length(replace(v_src, a_ins, ''))) / length(a_ins);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION '429: expected 1 RETURNING clause in set_de_assignment, found %', v_hits;
    END IF;
    v_hits := (length(v_src) - length(replace(v_src, a_ret, ''))) / length(a_ret);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION '429: expected 1 RETURN in set_de_assignment, found %', v_hits;
    END IF;

    v_new := v_src;
    v_new := replace(v_new, 'DECLARE v_tenant uuid := auth_tenant_id(); v_id uuid;',
                            'DECLARE v_tenant uuid := auth_tenant_id(); v_id uuid; v_new_row boolean;');
    -- xmax = 0 distinguishes a fresh INSERT from an ON CONFLICT DO UPDATE.
    v_new := replace(v_new, a_ins, '  RETURNING id, (xmax = 0) INTO v_id, v_new_row;');
    v_new := replace(v_new, a_ret, array_to_string(ARRAY[
      '  -- Governance record (mig 429). AFTER the write: an event claiming a',
      '  -- change that then failed is worse than no event. category is',
      '  -- access_control and actor_type human because the audit_events CHECK',
      '  -- constraints allow no others — see this migration''s header.',
      '  PERFORM append_audit_event(',
      '    v_tenant,',
      '    coalesce((SELECT full_name FROM profiles WHERE user_id = auth.uid()), ''A manager''),',
      '    ''human'',',
      '    format(''%s %s as %s for a digital employee'',',
      '           CASE WHEN v_new_row THEN ''Assigned'' ELSE ''Re-confirmed'' END,',
      '           coalesce((SELECT full_name FROM profiles WHERE user_id = p_user_id), ''a teammate''),',
      '           p_relation),',
      '    ''access_control'',',
      '    jsonb_build_object(''kind'', ''de_assignment_set'', ''de_id'', p_de_id,',
      '                       ''user_id'', p_user_id, ''relation'', p_relation,',
      '                       ''assignment_id'', v_id, ''was_new'', v_new_row,',
      '                       ''assigned_by'', auth.uid()));',
      '',
      a_ret], v_eol));

    IF v_new = v_src THEN
      RAISE EXCEPTION '429: set_de_assignment rewrite produced an identical body';
    END IF;
    EXECUTE v_new;
  END IF;
END $patch$;

DO $patch2$
DECLARE
  v_src text; v_new text; v_eol text;
  a_del text; v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'remove_de_assignment';
  IF v_src IS NULL THEN RAISE EXCEPTION '429: remove_de_assignment not found'; END IF;

  IF v_src ILIKE '%append_audit_event%' THEN
    RAISE NOTICE '429: remove_de_assignment already audits, nothing to do';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13) || chr(10) in v_src) > 0
                THEN chr(13) || chr(10) ELSE chr(10) END;

  a_del := array_to_string(ARRAY[
    '  DELETE FROM de_assignments WHERE id = p_id AND tenant_id = v_tenant;',
    '  GET DIAGNOSTICS v_n = ROW_COUNT;',
    '  RETURN v_n > 0;'], v_eol);

  v_hits := (length(v_src) - length(replace(v_src, a_del, ''))) / length(a_del);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '429: expected 1 delete-and-return block in remove_de_assignment, found %', v_hits;
  END IF;

  v_new := v_src;
  v_new := replace(v_new, 'DECLARE v_tenant uuid := auth_tenant_id(); v_n int;',
                          'DECLARE v_tenant uuid := auth_tenant_id(); v_n int; v_de uuid; v_user uuid; v_rel text;');
  -- DELETE ... RETURNING captures the row in the SAME statement that removes
  -- it: no separate SELECT, so no window in which the row could change.
  v_new := replace(v_new, a_del, array_to_string(ARRAY[
    '  DELETE FROM de_assignments WHERE id = p_id AND tenant_id = v_tenant',
    '    RETURNING de_id, user_id, relation INTO v_de, v_user, v_rel;',
    '  GET DIAGNOSTICS v_n = ROW_COUNT;',
    '',
    '  -- Only audit a real removal (mig 429). A no-op delete is not an event;',
    '  -- recording one would fill the trail with things that never happened.',
    '  IF v_n > 0 THEN',
    '    PERFORM append_audit_event(',
    '      v_tenant,',
    '      coalesce((SELECT full_name FROM profiles WHERE user_id = auth.uid()), ''A manager''),',
    '      ''human'',',
    '      format(''Removed %s as %s for a digital employee'',',
    '             coalesce((SELECT full_name FROM profiles WHERE user_id = v_user), ''a teammate''),',
    '             v_rel),',
    '      ''access_control'',',
    '      jsonb_build_object(''kind'', ''de_assignment_removed'', ''de_id'', v_de,',
    '                         ''user_id'', v_user, ''relation'', v_rel,',
    '                         ''assignment_id'', p_id, ''removed_by'', auth.uid()));',
    '  END IF;',
    '',
    '  RETURN v_n > 0;'], v_eol));

  IF v_new = v_src THEN
    RAISE EXCEPTION '429: remove_de_assignment rewrite produced an identical body';
  END IF;
  EXECUTE v_new;
END $patch2$;

DO $assert$
DECLARE v_set text; v_rem text; v_allowed text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_set FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='set_de_assignment';
  SELECT pg_get_functiondef(p.oid) INTO v_rem FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='remove_de_assignment';

  IF v_set NOT LIKE '%append_audit_event%' THEN
    RAISE EXCEPTION '429: set_de_assignment still does not audit';
  END IF;
  IF v_rem NOT LIKE '%append_audit_event%' THEN
    RAISE EXCEPTION '429: remove_de_assignment still does not audit';
  END IF;

  -- ⚠ THE ASSERTION THAT MATTERS. The requested spec used values that violate
  -- the CHECK constraints; if either slipped through, the writers would raise
  -- at runtime and assigning responsibility would be BROKEN. Verify against the
  -- live constraint rather than against what this file happens to say.
  SELECT pg_get_constraintdef(con.oid) INTO v_allowed
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
   WHERE c.relname = 'audit_events' AND con.conname = 'audit_events_category_check';
  IF v_allowed NOT LIKE '%access_control%' THEN
    RAISE EXCEPTION '429: access_control is not an allowed audit category — the writers would raise at runtime';
  END IF;
  IF v_set LIKE '%''governance''%' OR v_rem LIKE '%''governance''%' THEN
    RAISE EXCEPTION '429: a body still uses category ''governance'', which the CHECK constraint rejects';
  END IF;
  IF v_set LIKE '%, ''user'',%' OR v_rem LIKE '%, ''user'',%' THEN
    RAISE EXCEPTION '429: a body still uses actor_type ''user'', which the CHECK constraint rejects';
  END IF;

  -- Order: audit AFTER the write in both.
  IF position('INSERT INTO de_assignments' in v_set) > position('append_audit_event' in v_set) THEN
    RAISE EXCEPTION '429: set_de_assignment audits before it writes';
  END IF;
  IF position('DELETE FROM de_assignments' in v_rem) > position('append_audit_event' in v_rem) THEN
    RAISE EXCEPTION '429: remove_de_assignment audits before it deletes';
  END IF;
  -- A removal must only be recorded when a row actually went.
  IF v_rem NOT LIKE '%IF v_n > 0 THEN%' THEN
    RAISE EXCEPTION '429: remove_de_assignment audits unconditionally — a no-op delete would be recorded as a removal';
  END IF;
  -- The permission gates and cross-tenant checks must survive both rewrites.
  IF v_set NOT LIKE '%insufficient_permission%' OR v_rem NOT LIKE '%insufficient_permission%' THEN
    RAISE EXCEPTION '429: a manager+ permission gate was lost in the rewrite';
  END IF;
  IF v_set NOT LIKE '%does not belong to this workspace%' THEN
    RAISE EXCEPTION '429: the cross-tenant checks were lost from set_de_assignment';
  END IF;
  IF v_set NOT LIKE '%ON CONFLICT (de_id, user_id, relation)%' THEN
    RAISE EXCEPTION '429: the upsert contract was lost from set_de_assignment';
  END IF;

  RAISE NOTICE '429: reporting-line writers now audit as access_control/human. Spec asked for governance/user — both violate CHECK constraints and would have broken set_de_assignment.';
END $assert$;

NOTIFY pgrst, 'reload schema';
