-- 423_guard_set_de_mission_state.sql
-- ============================================================================
-- Phase 3 Wave 2, GROUP B (actors) — completes missions & work. See docs/30.
--
-- ⚠ DEFENCE IN DEPTH, NOT A HOLE CLOSED — already manager+ gated. ─────────
--
-- set_de_mission_state(p_mission_id, p_action) pauses, resumes or cancels a
-- mission. Cancel is the one worth reading closely: it deletes the mission's
-- work_watchers, cancels every queued de_work_item under its objectives, and
-- abandons the objectives themselves. Unscoped, that would be the broadest
-- single act of destruction available in group B — one call stops an employee
-- and unwinds everything it had queued.
--
-- ── ⚠ NULL-TOLERANT, and the reason is structural ─────────────────────────
-- de_missions.de_id is NULL for every TEAM mission — create_de_team_mission
-- (422) inserts NULL by design and puts the targeting in target_spec. So the
-- plain guard would refuse every team mission for a scoped user, while the
-- reader beside it still shows the mission. The null-tolerant form is the exact
-- negation of the migration-386 predicate, same as 404/406/407/408/419.
--
-- That leaves a gap this migration does NOT close, stated plainly: for a team
-- mission the guard passes on a null de_id and does not walk target_spec. A
-- scoped user could therefore cancel a team mission targeting employees they do
-- not own. Closing it means resolving target_spec here the way 422 does at
-- creation — three modes, one of them late-bound — which is a bigger change
-- than a scoping wave should make to a live cancel path. It is inert today
-- (manager+ only, and de_missions is empty in production: 0 rows), and it is
-- recorded in docs/30 as the follow-up rather than half-done here.
--
-- The body resolves only `status` today; the guard needs de_id, so the SELECT
-- is extended rather than a second lookup added — that keeps the guard on
-- exactly the row the UPDATE will touch, and inside the same FOR UPDATE lock.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_decl text := 'DECLARE v_tenant uuid; v_status text; v_next text;';
  a_sel  text := '  SELECT status INTO v_status FROM de_missions';
  a_case text := '  v_next := CASE';
  v_guard text; v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'set_de_mission_state';
  IF v_src IS NULL THEN RAISE EXCEPTION '423: set_de_mission_state not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '423: already guarded, nothing to do';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13) || chr(10) in v_src) > 0
                THEN chr(13) || chr(10) ELSE chr(10) END;

  v_guard := array_to_string(ARRAY[
    '  -- DE scoping (mig 385/423). DEFENCE IN DEPTH: the manager+ gate above',
    '  -- already implies this. NULL-TOLERANT because de_missions.de_id is NULL',
    '  -- for every TEAM mission (targeting lives in target_spec) — the plain',
    '  -- form would refuse those while the reader still shows them.',
    '  -- KNOWN GAP: this does not walk target_spec, so a team mission is not',
    '  -- scoped by it. See the header and docs/30.',
    '  IF v_de IS NOT NULL AND NOT public.can_access_de(v_de) THEN',
    '    RETURN jsonb_build_object(''ok'', false, ''error'', ''not_responsible_for_de'');',
    '  END IF;',
    ''], v_eol);

  FOR v_hits IN
    SELECT (length(v_src) - length(replace(v_src, a, ''))) / length(a)
      FROM unnest(ARRAY[a_decl, a_sel, a_case]) a
  LOOP
    IF v_hits <> 1 THEN
      RAISE EXCEPTION '423: an anchor matched % times instead of 1 — the body changed, refusing to guess', v_hits;
    END IF;
  END LOOP;

  v_new := v_src;
  v_new := replace(v_new, a_decl, 'DECLARE v_tenant uuid; v_status text; v_next text; v_de uuid;');
  -- Extend the existing lookup rather than adding a second one: same row, same
  -- FOR UPDATE lock, no chance of guarding a different row than the one updated.
  v_new := replace(v_new, a_sel,  '  SELECT status, de_id INTO v_status, v_de FROM de_missions');
  v_new := replace(v_new, a_case, v_guard || a_case);

  IF v_new = v_src THEN
    RAISE EXCEPTION '423: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_calls int; v_nullable text; v_out jsonb;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'set_de_mission_state';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  v_calls  := (length(v_def) - length(replace(v_def, 'public.can_access_de(', ''))) / length('public.can_access_de(');
  IF v_guards <> 1 OR v_calls <> 1 THEN
    RAISE EXCEPTION '423: expected exactly 1 guard (token %, calls %)', v_guards, v_calls;
  END IF;
  -- The guard is worthless unless v_de is actually populated from the mission.
  IF v_def NOT LIKE '%SELECT status, de_id INTO v_status, v_de FROM de_missions%' THEN
    RAISE EXCEPTION '423: v_de is not resolved from the mission row — the guard would test a null forever';
  END IF;
  IF v_def NOT LIKE '%v_de IS NOT NULL AND NOT public.can_access_de(v_de)%' THEN
    RAISE EXCEPTION '423: the guard is not null-tolerant — every team mission would be refused';
  END IF;
  -- The lock must still be on the row being guarded and updated.
  IF v_def NOT LIKE '%FOR UPDATE%' THEN
    RAISE EXCEPTION '423: the FOR UPDATE lock was lost in the rewrite';
  END IF;
  SELECT is_nullable INTO v_nullable FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'de_missions' AND column_name = 'de_id';
  IF v_nullable <> 'YES' THEN
    RAISE EXCEPTION '423: de_missions.de_id is NOT NULL — the null-tolerant shape is now dead code, re-check it';
  END IF;

  IF v_def NOT LIKE '%auth_has_tenant_role(%tenant_owner%tenant_admin%tenant_manager%)%' THEN
    RAISE EXCEPTION '423: the manager+ role gate was lost — this would have WIDENED access, not narrowed it';
  END IF;
  IF position('not_permitted' in v_def) > position('can_access_de' in v_def) THEN
    RAISE EXCEPTION '423: the scope guard runs before the role gate';
  END IF;
  -- The cancel cascade is the destructive part; all of it must sit behind the
  -- guard, and the documented ordering (watchers first) must survive.
  IF position('can_access_de' in v_def) > position('UPDATE de_missions SET status' in v_def)
     OR position('can_access_de' in v_def) > position('DELETE FROM work_watchers' in v_def)
     OR position('can_access_de' in v_def) > position('UPDATE de_objectives SET status' in v_def) THEN
    RAISE EXCEPTION '423: the guard lands after part of the cancel cascade';
  END IF;
  IF position('DELETE FROM work_watchers' in v_def) > position('UPDATE de_objectives SET status' in v_def) THEN
    RAISE EXCEPTION '423: the cancel ordering changed — watchers must stop ticking before work is unwound';
  END IF;
  IF v_def NOT LIKE '%invalid_transition%' THEN
    RAISE EXCEPTION '423: the body lost content — a stale or truncated definition was applied';
  END IF;

  SELECT public.set_de_mission_state('00000000-0000-0000-0000-000000000000'::uuid, 'cancel') INTO v_out;
  IF v_out->>'error' <> 'not_permitted' THEN
    RAISE EXCEPTION '423: expected not_permitted, got %', coalesce(v_out::text, 'null');
  END IF;

  RAISE NOTICE '423: guard added, null-tolerant. NO BEHAVIOURAL CHANGE. KNOWN GAP: team missions (null de_id) are not scoped by target_spec — recorded in docs/30.';
END $assert$;

NOTIFY pgrst, 'reload schema';
