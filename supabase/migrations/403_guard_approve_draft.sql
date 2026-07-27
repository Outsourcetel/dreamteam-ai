-- 403_guard_approve_draft.sql
-- ============================================================================
-- Phase 3 Wave 2, GROUP B (actors) — first of 24. See docs/30.
--
-- ── Group B is a different fix from group A, and the difference matters ────
-- A reader leaks; an actor ACTS. The risk here is not "sees too much" but
-- "approves an outbound reply for an employee they are not responsible for".
-- So the fix is a GUARD THAT RAISES after resolving the row and before mutating
-- it — never a filter on the UPDATE. A filter would turn "you may not do this"
-- into "nothing happened", and this function in particular returns
-- {ok:true} unconditionally, so a filtered UPDATE would report success while
-- changing nothing. Silent success is the worst possible failure for an
-- approval primitive.
--
-- ── ⚠ LINE ENDINGS ARE MIXED IN THIS DATABASE — read before copying this ───
-- pg_get_functiondef returns each body exactly as it was created, and the
-- migrations that created these functions did not agree on line endings. This
-- body is CRLF; the group-A bodies patched in 387-402 were LF. A multi-line
-- anchor written with plain \n therefore matched ZERO times here and the
-- migration correctly refused rather than guessing.
--
-- So every multi-line anchor below is composed against the EOL actually found
-- in the body. Single-line anchors are unaffected, which is why group A never
-- hit this. Reuse this shape for the remaining group-B functions.
--
-- ── Why the existence check is part of the guard, not scope creep ──────────
-- can_access_de(NULL) is TRUE for owner/admin/manager — they pass on role
-- before the assignment lookup runs. So without first proving the draft EXISTS,
-- a guard on a null de_id would pass for exactly the people who can approve
-- anything, and the check would be decorative for them. draft_responses.de_id
-- is NOT NULL, so "no de_id resolved" is precisely "no such draft in this
-- workspace", and one lookup does both jobs.
--
-- ⚠ BEHAVIOUR CHANGE, stated plainly: approving a draft that does not exist in
-- the caller's workspace previously returned {ok:true} while updating zero rows
-- — the UPDATE had no row-count check. It now raises. That is a fix, but it is
-- a change beyond scoping, so it is called out rather than buried. This
-- function has NO caller anywhere in src/, so the blast radius is nil.
--
-- ⚠ This function has no SET search_path (unlike every comparable one here), so
-- can_access_de is schema-qualified and the assertion below enforces that.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_decl text; a_upd text; v_guard text;
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'approve_draft';
  IF v_src IS NULL THEN RAISE EXCEPTION '403: approve_draft not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '403: already guarded, nothing to do';
    RETURN;
  END IF;

  -- Match the body's own line ending, and emit the same one.
  v_eol := CASE WHEN position(chr(13) || chr(10) in v_src) > 0
                THEN chr(13) || chr(10) ELSE chr(10) END;

  a_decl := 'DECLARE' || v_eol || '  v_user_id UUID;';
  a_upd  := '  UPDATE draft_responses' || v_eol || '  SET';

  v_guard := array_to_string(ARRAY[
    '  -- DE scoping (mig 385/403). Resolve the row FIRST, on exactly the same',
    '  -- terms the UPDATE below uses, then refuse. draft_responses.de_id is NOT',
    '  -- NULL, so a null here means no such draft in this workspace.',
    '  SELECT de_id INTO v_de_id',
    '    FROM draft_responses',
    '   WHERE draft_id = p_draft_id',
    '     AND tenant_id = current_setting(''app.current_tenant_id'')::uuid;',
    '',
    '  IF v_de_id IS NULL THEN',
    '    RAISE EXCEPTION ''draft_not_found: no such draft in this workspace'';',
    '  END IF;',
    '  IF NOT public.can_access_de(v_de_id) THEN',
    '    RAISE EXCEPTION ''not_responsible_for_de: this employee is not in your reporting line'';',
    '  END IF;',
    ''], v_eol);

  FOR v_hits IN
    SELECT (length(v_src) - length(replace(v_src, a, ''))) / length(a)
      FROM unnest(ARRAY[a_decl, a_upd]) a
  LOOP
    IF v_hits <> 1 THEN
      RAISE EXCEPTION '403: an anchor matched % times instead of 1 — the body changed, refusing to guess', v_hits;
    END IF;
  END LOOP;

  v_new := v_src;
  v_new := replace(v_new, a_decl, 'DECLARE' || v_eol || '  v_user_id UUID;' || v_eol || '  v_de_id UUID;');
  v_new := replace(v_new, a_upd, v_guard || v_eol || a_upd);

  IF v_new = v_src THEN
    RAISE EXCEPTION '403: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_nullable text; v_raised text; v_fired boolean := false;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'approve_draft';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  IF v_guards <> 1 THEN
    RAISE EXCEPTION '403: expected exactly 1 guard, found %', v_guards;
  END IF;

  -- It must RAISE, not filter. An actor that silently does nothing is worse
  -- than one that refuses loudly.
  IF v_def NOT LIKE '%NOT public.can_access_de(v_de_id) THEN%'
     OR v_def NOT LIKE '%not_responsible_for_de%' THEN
    RAISE EXCEPTION '403: the guard does not RAISE — an actor must refuse, not filter';
  END IF;
  -- No SET search_path on this function, so an unqualified call would be
  -- resolvable by the caller.
  IF v_def NOT LIKE '%public.can_access_de%' THEN
    RAISE EXCEPTION '403: the guard is not schema-qualified and this function has no SET search_path';
  END IF;
  -- Order: the guard must precede the UPDATE it protects.
  IF position('can_access_de' in v_def) > position('UPDATE draft_responses' in v_def) THEN
    RAISE EXCEPTION '403: the guard lands AFTER the UPDATE — the row is mutated before it is checked';
  END IF;
  IF v_def NOT LIKE '%Not authenticated%' THEN
    RAISE EXCEPTION '403: the authentication check was lost in the rewrite';
  END IF;
  IF v_def NOT LIKE '%approved_by = v_user_id%' OR v_def NOT LIKE '%edited_content%' THEN
    RAISE EXCEPTION '403: the body lost content — a stale or truncated definition was applied';
  END IF;

  -- The NOT NULL assumption is load-bearing: it is what makes "null de_id"
  -- mean "no such draft" rather than "an unattributed draft".
  SELECT is_nullable INTO v_nullable FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'draft_responses' AND column_name = 'de_id';
  IF v_nullable <> 'NO' THEN
    RAISE EXCEPTION '403: draft_responses.de_id is nullable — the existence check this guard relies on is unsound';
  END IF;

  -- Runtime smoke test: postgres has a null auth.uid(), so the FIRST gate must
  -- still fire. Proves the body compiles and the gate order survived.
  BEGIN
    PERFORM public.approve_draft('00000000-0000-0000-0000-000000000000'::uuid, NULL, NULL);
  EXCEPTION WHEN others THEN
    v_raised := SQLERRM; v_fired := true;
  END;
  IF NOT v_fired OR v_raised NOT LIKE '%Not authenticated%' THEN
    RAISE EXCEPTION '403: expected the authentication gate to fire first, got: %', coalesce(v_raised, '(nothing raised)');
  END IF;

  RAISE NOTICE '403: approve_draft guarded. NOTE behaviour change — a non-existent draft now raises instead of returning ok:true over zero rows.';
END $assert$;

NOTIFY pgrst, 'reload schema';
