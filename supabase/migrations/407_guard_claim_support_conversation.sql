-- 407_guard_claim_support_conversation.sql
-- ============================================================================
-- Phase 3 Wave 2, GROUP B (actors). See docs/30 and migration 403's header for
-- the fix shape and the mixed-line-endings hazard.
--
-- claim_support_conversation(p_conversation_id) takes personal ownership of a
-- live customer thread: sets owner_user_id to the caller and flips the status
-- to human_owned, which stops the digital employee answering it.
--
-- Unscoped, that is a denial-of-service on somebody else's employee — a person
-- assigned to one DE could claim every conversation in the workspace and every
-- one of those employees would fall silent. No data is read and nothing is
-- sent, which is exactly why this one is easy to overlook: the harm is that
-- work STOPS, not that anything leaks.
--
-- _assert_conv_member already proves workspace membership (the role axis) and
-- is kept. This adds the assignment axis. Null-tolerant, matching the
-- migration-386 policy: de_conversations.de_id is nullable, and an actor
-- stricter than the corresponding reader is the divergence 400-402 undid.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_decl text := 'declare v_tenant uuid;';
  a_upd  text := '  update de_conversations set owner_user_id = auth.uid(), status = ''human_owned'', last_message_at = now()';
  v_guard text;
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'claim_support_conversation';
  IF v_src IS NULL THEN RAISE EXCEPTION '407: claim_support_conversation not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '407: already guarded, nothing to do';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13) || chr(10) in v_src) > 0
                THEN chr(13) || chr(10) ELSE chr(10) END;

  v_guard := array_to_string(ARRAY[
    '  -- DE scoping (mig 385/407). Claiming a thread SILENCES the employee that',
    '  -- was answering it, so this is an act on that employee, not just on the',
    '  -- conversation. Null-tolerant to match the mig-386 policy.',
    '  select de_id into v_de from de_conversations where id = p_conversation_id;',
    '  if v_de is not null and not public.can_access_de(v_de) then',
    '    raise exception ''not_responsible_for_de: this employee is not in your reporting line'';',
    '  end if;',
    ''], v_eol);

  FOR v_hits IN
    SELECT (length(v_src) - length(replace(v_src, a, ''))) / length(a)
      FROM unnest(ARRAY[a_decl, a_upd]) a
  LOOP
    IF v_hits <> 1 THEN
      RAISE EXCEPTION '407: an anchor matched % times instead of 1 — the body changed, refusing to guess', v_hits;
    END IF;
  END LOOP;

  v_new := v_src;
  v_new := replace(v_new, a_decl, 'declare v_tenant uuid; v_de uuid;');
  v_new := replace(v_new, a_upd, v_guard || v_eol || a_upd);

  IF v_new = v_src THEN
    RAISE EXCEPTION '407: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'claim_support_conversation';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  IF v_guards <> 1 THEN
    RAISE EXCEPTION '407: expected exactly 1 guard, found %', v_guards;
  END IF;
  IF v_def NOT LIKE '%raise exception ''not_responsible_for_de%' THEN
    RAISE EXCEPTION '407: the guard does not RAISE — an actor must refuse, not filter';
  END IF;
  IF v_def NOT LIKE '%v_de is not null and not public.can_access_de(v_de)%' THEN
    RAISE EXCEPTION '407: the guard is not null-tolerant — it would diverge from the mig-386 policy';
  END IF;
  IF v_def NOT LIKE '%_assert_conv_member%' THEN
    RAISE EXCEPTION '407: _assert_conv_member was lost — the workspace axis is gone';
  END IF;
  -- Membership first, then scope.
  IF position('_assert_conv_member' in v_def) > position('can_access_de' in v_def) THEN
    RAISE EXCEPTION '407: the scope guard runs before the workspace check';
  END IF;
  IF position('can_access_de' in v_def) > position('update de_conversations' in v_def) THEN
    RAISE EXCEPTION '407: the guard lands AFTER the UPDATE — the thread is claimed before it is checked';
  END IF;
  IF v_def NOT LIKE '%human_owned%' THEN
    RAISE EXCEPTION '407: the body lost content — a stale or truncated definition was applied';
  END IF;

  RAISE NOTICE '407: claim_support_conversation guarded.';
END $assert$;

NOTIFY pgrst, 'reload schema';
