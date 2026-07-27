-- 422_guard_create_de_team_mission.sql
-- ============================================================================
-- Phase 3 Wave 2, GROUP B (actors) — missions & work. See docs/30 and 421.
--
-- ⚠ DEFENCE IN DEPTH, NOT A HOLE CLOSED — already manager+ gated. ─────────
--
-- create_de_team_mission(p_target_spec, p_directive) directs a mission at a SET
-- of employees rather than one, in three targeting modes. That makes it the
-- only actor in group B where "which employee" is not a single id, and the
-- guard has to answer the question three times:
--
--   explicit    an array of de_ids  → every one must be accessible
--   supervisor  one supervisor id   → that one must be accessible
--   archetype   an archetype key    → every ACTIVE employee of that archetype
--
-- All three are checked, in one block immediately before the INSERT, where all
-- three branch variables have been resolved. One splice point rather than three
-- is deliberate: fewer places for the edit to land wrong on a live function.
--
-- ── ⚠ The archetype case is checked but cannot be fully bounded here ──────
-- An archetype mission does not name its targets; the set is re-resolved when
-- the mission dispatches. The guard tests the set as it stands AT CREATION, so
-- an employee of that archetype hired afterwards would be included in the
-- mission without ever having been checked. That is a real limitation of
-- scoping a late-bound target, not something a different predicate would fix,
-- and it is written down rather than papered over. It does not bite today: the
-- function is manager+ only, and a manager can access every employee anyway.
--
-- Requiring access to ALL matching employees (rather than any) is the
-- conservative reading — a mission aimed at an archetype acts through all of
-- them, so partial responsibility is not enough to launch it.
--
-- de_missions.de_id is NULL for team missions by design; the targeting lives in
-- target_spec. That is why the guard reads target_spec and never de_id, and it
-- is also why set_de_mission_state (423) must be null-tolerant.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_ins text := '  INSERT INTO de_missions (tenant_id, de_id, target_spec, directive_text, created_by)';
  v_guard text; v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_de_team_mission';
  IF v_src IS NULL THEN RAISE EXCEPTION '422: create_de_team_mission not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '422: already guarded, nothing to do';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13) || chr(10) in v_src) > 0
                THEN chr(13) || chr(10) ELSE chr(10) END;

  v_guard := array_to_string(ARRAY[
    '  -- DE scoping (mig 385/422). DEFENCE IN DEPTH: the manager+ gate above',
    '  -- already implies all three of these. Checked here, once, where every',
    '  -- branch variable is resolved. ALL matching employees must be accessible,',
    '  -- not any — a mission aimed at a set acts through the whole set.',
    '  IF v_de_ids IS NOT NULL AND EXISTS (',
    '       SELECT 1 FROM unnest(v_de_ids) d WHERE NOT public.can_access_de(d)) THEN',
    '    RETURN jsonb_build_object(''ok'', false, ''error'', ''not_responsible_for_de'');',
    '  END IF;',
    '  IF v_sup IS NOT NULL AND NOT public.can_access_de(v_sup) THEN',
    '    RETURN jsonb_build_object(''ok'', false, ''error'', ''not_responsible_for_de'');',
    '  END IF;',
    '  -- Archetype targets are re-resolved at dispatch; this tests the set as it',
    '  -- stands now. An employee hired into the archetype later is not covered.',
    '  IF v_arch IS NOT NULL AND EXISTS (',
    '       SELECT 1 FROM digital_employees',
    '        WHERE tenant_id = v_tenant AND archetype_key = v_arch AND status = ''active''',
    '          AND NOT public.can_access_de(id)) THEN',
    '    RETURN jsonb_build_object(''ok'', false, ''error'', ''not_responsible_for_de'');',
    '  END IF;',
    ''], v_eol);

  v_hits := (length(v_src) - length(replace(v_src, a_ins, ''))) / length(a_ins);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '422: expected 1 mission insert to anchor to, found % — the body changed, refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, a_ins, v_guard || a_ins);
  IF v_new = v_src THEN
    RAISE EXCEPTION '422: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_calls int; v_out jsonb;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_de_team_mission';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  v_calls  := (length(v_def) - length(replace(v_def, 'public.can_access_de(', ''))) / length('public.can_access_de(');
  -- THREE, one per targeting mode. Two would mean a mode is unguarded, and the
  -- unguarded one would be invisible in a diff.
  IF v_guards <> 3 OR v_calls <> 3 THEN
    RAISE EXCEPTION '422: expected exactly 3 guards, one per targeting mode (token %, calls %)', v_guards, v_calls;
  END IF;
  -- Each mode by name, so a missing branch is named rather than just counted.
  IF v_def NOT LIKE '%unnest(v_de_ids) d WHERE NOT public.can_access_de(d)%' THEN
    RAISE EXCEPTION '422: the explicit-de_ids mode is unguarded';
  END IF;
  IF v_def NOT LIKE '%v_sup IS NOT NULL AND NOT public.can_access_de(v_sup)%' THEN
    RAISE EXCEPTION '422: the supervisor mode is unguarded';
  END IF;
  IF v_def NOT LIKE '%archetype_key = v_arch%AND NOT public.can_access_de(id)%' THEN
    RAISE EXCEPTION '422: the archetype mode is unguarded';
  END IF;

  IF v_def NOT LIKE '%auth_has_tenant_role(%tenant_owner%tenant_admin%tenant_manager%)%' THEN
    RAISE EXCEPTION '422: the manager+ role gate was lost — this would have WIDENED access, not narrowed it';
  END IF;
  IF position('not_permitted' in v_def) > position('can_access_de' in v_def) THEN
    RAISE EXCEPTION '422: the scope guard runs before the role gate';
  END IF;
  IF position('can_access_de' in v_def) > position('INSERT INTO de_missions' in v_def) THEN
    RAISE EXCEPTION '422: a guard lands after the insert';
  END IF;
  IF v_def NOT LIKE '%bad_target_kind%' OR v_def NOT LIKE '%no_active_de_for_archetype%'
     OR v_def NOT LIKE '%unknown_or_foreign_de%' THEN
    RAISE EXCEPTION '422: the body lost content — a stale or truncated definition was applied';
  END IF;

  SELECT public.create_de_team_mission(
    jsonb_build_object('kind', 'archetype', 'archetype_key', 'nope'),
    'a directive long enough to pass') INTO v_out;
  IF v_out->>'error' <> 'not_permitted' THEN
    RAISE EXCEPTION '422: expected not_permitted, got %', coalesce(v_out::text, 'null');
  END IF;

  RAISE NOTICE '422: guard added on all 3 targeting modes. NO BEHAVIOURAL CHANGE — manager+ already passed. Archetype targets are re-resolved at dispatch; see header.';
END $assert$;

NOTIFY pgrst, 'reload schema';
