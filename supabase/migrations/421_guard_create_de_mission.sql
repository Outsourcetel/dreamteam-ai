-- 421_guard_create_de_mission.sql
-- ============================================================================
-- Phase 3 Wave 2, GROUP B (actors) — missions & work. See docs/30.
--
-- ⚠ DEFENCE IN DEPTH, NOT A HOLE CLOSED. ─────────────────────────────────
-- create_de_mission(p_de_id, p_directive) is already gated to tenant_owner /
-- tenant_admin / tenant_manager, and can_access_de passes all three
-- unconditionally. **No behaviour changes.** Its sibling enqueue_de_work_item
-- (mig 420) was the real gap in this sub-group — that one had no role gate at
-- all. Recorded honestly so the wave is not mis-measured; same standing as
-- 399, 414 and 415.
--
-- Applied because a mission is a standing instruction that spawns objectives
-- and work items under an employee. If missions are ever opened below manager —
-- and "give someone their own employee to direct" is the obvious reason to add
-- a scoped role at all — this guard must already be in place.
--
-- The existence check above it already proves p_de_id is an active employee in
-- the caller's workspace, so the plain (non-null-tolerant) shape is correct.
-- Refuses through this function's own {ok:false} envelope.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_ins text := '  INSERT INTO de_missions (tenant_id, de_id, directive_text, created_by)';
  v_guard text; v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_de_mission';
  IF v_src IS NULL THEN RAISE EXCEPTION '421: create_de_mission not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '421: already guarded, nothing to do';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13) || chr(10) in v_src) > 0
                THEN chr(13) || chr(10) ELSE chr(10) END;

  v_guard := array_to_string(ARRAY[
    '  -- DE scoping (mig 385/421). DEFENCE IN DEPTH: the manager+ gate above',
    '  -- already implies this. The existence check has proven p_de_id is an',
    '  -- active employee in this workspace, so no null case.',
    '  IF NOT public.can_access_de(p_de_id) THEN',
    '    RETURN jsonb_build_object(''ok'', false, ''error'', ''not_responsible_for_de'');',
    '  END IF;',
    ''], v_eol);

  v_hits := (length(v_src) - length(replace(v_src, a_ins, ''))) / length(a_ins);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '421: expected 1 mission insert to anchor to, found % — the body changed, refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, a_ins, v_guard || a_ins);
  IF v_new = v_src THEN
    RAISE EXCEPTION '421: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_calls int; v_out jsonb;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_de_mission';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  v_calls  := (length(v_def) - length(replace(v_def, 'public.can_access_de(', ''))) / length('public.can_access_de(');
  IF v_guards <> 1 OR v_calls <> 1 THEN
    RAISE EXCEPTION '421: expected exactly 1 guard (token %, calls %)', v_guards, v_calls;
  END IF;
  IF v_def NOT LIKE '%''not_responsible_for_de''%' THEN
    RAISE EXCEPTION '421: the guard does not refuse';
  END IF;

  -- ⚠ The manager+ gate is what actually restricts this function. Trading it
  -- for the redundant guard would WIDEN access to any assigned user while
  -- reading like a security improvement.
  IF v_def NOT LIKE '%auth_has_tenant_role(%tenant_owner%tenant_admin%tenant_manager%)%' THEN
    RAISE EXCEPTION '421: the manager+ role gate was lost — this would have WIDENED access, not narrowed it';
  END IF;
  IF position('not_permitted' in v_def) > position('can_access_de' in v_def) THEN
    RAISE EXCEPTION '421: the scope guard runs before the role gate';
  END IF;
  IF position('can_access_de' in v_def) > position('INSERT INTO de_missions' in v_def) THEN
    RAISE EXCEPTION '421: the guard lands after the insert';
  END IF;
  IF v_def NOT LIKE '%unknown_or_inactive_de%' OR v_def NOT LIKE '%directive_too_short%' THEN
    RAISE EXCEPTION '421: the body lost content — a stale or truncated definition was applied';
  END IF;

  -- Runtime smoke test: postgres is a member of no workspace, so not_permitted.
  SELECT public.create_de_mission('00000000-0000-0000-0000-000000000000'::uuid,
                                  'a directive long enough to pass') INTO v_out;
  IF v_out->>'error' <> 'not_permitted' THEN
    RAISE EXCEPTION '421: expected not_permitted, got %', coalesce(v_out::text, 'null');
  END IF;

  RAISE NOTICE '421: guard added. NO BEHAVIOURAL CHANGE — manager+ already passed. Defence in depth, counted as such.';
END $assert$;

NOTIFY pgrst, 'reload schema';
