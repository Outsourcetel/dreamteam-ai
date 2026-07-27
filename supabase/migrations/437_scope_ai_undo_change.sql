-- 437_scope_ai_undo_change.sql
-- ============================================================================
-- P1 from docs/32, verified live. ai_undo_change(p_change_id) reverts a change
-- the Workspace Assistant made — restoring a knowledge doc, a playbook, or a
-- DIGITAL EMPLOYEE'S IDENTITY (name, persona_name, description,
-- purpose_statement) from the recorded before_state, or deleting the row if the
-- change created it.
--
-- It is tenant-safe: every read and write is pinned to auth_tenant_id(). What
-- it lacks is the assignment axis on the digital_employees branch — any member
-- could rewrite an employee's identity back to a prior state.
--
-- ── Scoped narrowly, on purpose ─────────────────────────────────────────
-- Only the digital_employees branch is guarded. The knowledge_docs and
-- playbook_definitions branches are NOT: those are workspace assets, not an
-- employee's, and DE scoping is the wrong axis for them — knowledge has its own
-- 6-level ACL (migs 341-345) and that is where a restriction belongs if one is
-- wanted. Guarding them here on can_access_de would be inventing a
-- relationship the data does not have, which is the mistake the onboarding pair
-- in group B was reclassified for.
--
-- ai_change_log.target_id is nullable, so the guard is null-tolerant — matching
-- the migration-386 predicate shape used throughout this wave.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_de text := '  ELSIF v_row.target_table = ''digital_employees'' THEN';
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='ai_undo_change';
  IF v_src IS NULL THEN RAISE EXCEPTION '437: ai_undo_change not found'; END IF;
  IF v_src ILIKE '%can_access_de%' THEN RAISE NOTICE '437: already scoped'; RETURN; END IF;

  v_eol := CASE WHEN position(chr(13)||chr(10) in v_src) > 0 THEN chr(13)||chr(10) ELSE chr(10) END;

  v_hits := (length(v_src) - length(replace(v_src, a_de, ''))) / length(a_de);
  IF v_hits <> 1 THEN RAISE EXCEPTION '437: expected 1 digital_employees branch, found %', v_hits; END IF;

  v_new := replace(v_src, a_de, array_to_string(ARRAY[
    a_de,
    '    -- DE scoping (mig 385/437). This branch alone: knowledge and playbooks',
    '    -- are workspace assets and have their own ACL. Null-tolerant because',
    '    -- ai_change_log.target_id is nullable.',
    '    IF v_row.target_id IS NOT NULL AND NOT public.can_access_de(v_row.target_id) THEN',
    '      RAISE EXCEPTION ''not_responsible_for_de: this employee is not in your reporting line'';',
    '    END IF;'], v_eol));

  IF v_new = v_src THEN RAISE EXCEPTION '437: edit did not land'; END IF;
  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_calls int; v_raised text; v_fired boolean := false;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='ai_undo_change';
  v_calls := (length(v_def) - length(replace(v_def,'public.can_access_de(',''))) / length('public.can_access_de(');
  IF v_calls <> 1 THEN RAISE EXCEPTION '437: expected exactly 1 guard, found %', v_calls; END IF;
  IF v_def NOT LIKE '%v_row.target_id IS NOT NULL AND NOT public.can_access_de%' THEN
    RAISE EXCEPTION '437: the guard is not null-tolerant';
  END IF;
  -- It must sit inside the digital_employees branch and before that UPDATE.
  IF position('can_access_de' in v_def) > position('UPDATE digital_employees SET' in v_def) THEN
    RAISE EXCEPTION '437: the guard lands after the identity update';
  END IF;
  -- The other branches must remain unguarded — guarding them would be the
  -- wrong axis, and a stray guard there would silently block knowledge undo.
  IF position('can_access_de' in v_def) < position('target_table = ''knowledge_docs''' in v_def) THEN
    RAISE EXCEPTION '437: the guard landed before the knowledge branch — it would block workspace-asset undo';
  END IF;
  IF v_def NOT LIKE '%undo_window_expired%' OR v_def NOT LIKE '%already_undone%' THEN
    RAISE EXCEPTION '437: the body lost content';
  END IF;

  BEGIN
    PERFORM public.ai_undo_change('00000000-0000-0000-0000-000000000000'::uuid);
  EXCEPTION WHEN others THEN v_raised := SQLERRM; v_fired := true; END;
  IF NOT v_fired OR v_raised NOT LIKE '%not_authenticated%' THEN
    RAISE EXCEPTION '437: expected the auth gate to fire first, got: %', coalesce(v_raised,'(nothing)');
  END IF;

  RAISE NOTICE '437: ai_undo_change scoped on the employee-identity branch only.';
END $assert$;

NOTIFY pgrst, 'reload schema';
