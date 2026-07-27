-- 408_guard_set_support_conversation_state.sql
-- ============================================================================
-- Phase 3 Wave 2, GROUP B (actors). See docs/30 and migration 403's header.
--
-- set_support_conversation_state(p_conversation_id, p_status, p_priority) moves
-- a customer thread between ai_handling / needs_human / human_owned / resolved
-- and sets its priority. Passing p_status = 'resolved' ALSO closes every
-- pending escalation task on that conversation — marking them `approved`, with
-- the caller recorded as the decider.
--
-- That second effect is the one that matters here. Unscoped, a person assigned
-- to one employee could resolve another employee's conversations and
-- auto-approve the escalations attached to them — the escalation queue is how a
-- digital employee asks a human for a decision, so this closes questions on
-- somebody else's behalf and stamps their name on the answer.
--
-- One guard covers both mutations because both are keyed on the same
-- conversation. It goes after the existing membership and argument-validation
-- checks — cheapest and least informative failures first, so a caller who is
-- not a member never learns whether the conversation exists.
--
-- Null-tolerant, matching the migration-386 policy (de_conversations.de_id is
-- nullable); same reasoning as 404, 406 and 407.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_decl text := 'declare v_tenant uuid;';
  a_upd  text;
  v_guard text;
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'set_support_conversation_state';
  IF v_src IS NULL THEN RAISE EXCEPTION '408: set_support_conversation_state not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '408: already guarded, nothing to do';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13) || chr(10) in v_src) > 0
                THEN chr(13) || chr(10) ELSE chr(10) END;

  a_upd := '  update de_conversations' || v_eol || '    set status = coalesce(p_status, status)';

  v_guard := array_to_string(ARRAY[
    '  -- DE scoping (mig 385/408). Guards BOTH mutations below: the state change',
    '  -- and the escalation auto-approval that p_status = ''''resolved'''' triggers.',
    '  -- Placed after the argument validation so a bad status still fails as a',
    '  -- bad status. Null-tolerant to match the mig-386 policy.',
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
      RAISE EXCEPTION '408: an anchor matched % times instead of 1 — the body changed, refusing to guess', v_hits;
    END IF;
  END LOOP;

  v_new := v_src;
  v_new := replace(v_new, a_decl, 'declare v_tenant uuid; v_de uuid;');
  v_new := replace(v_new, a_upd, v_guard || v_eol || a_upd);

  IF v_new = v_src THEN
    RAISE EXCEPTION '408: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_raised text; v_fired boolean := false;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'set_support_conversation_state';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  IF v_guards <> 1 THEN
    RAISE EXCEPTION '408: expected exactly 1 guard, found %', v_guards;
  END IF;
  IF v_def NOT LIKE '%raise exception ''not_responsible_for_de%' THEN
    RAISE EXCEPTION '408: the guard does not RAISE — an actor must refuse, not filter';
  END IF;
  IF v_def NOT LIKE '%v_de is not null and not public.can_access_de(v_de)%' THEN
    RAISE EXCEPTION '408: the guard is not null-tolerant — it would diverge from the mig-386 policy';
  END IF;
  IF position('_assert_conv_member' in v_def) > position('can_access_de' in v_def) THEN
    RAISE EXCEPTION '408: the scope guard runs before the workspace check';
  END IF;
  -- Must precede BOTH mutations — the state change and the escalation approval.
  IF position('can_access_de' in v_def) > position('update de_conversations' in v_def)
     OR position('can_access_de' in v_def) > position('update human_tasks' in v_def) THEN
    RAISE EXCEPTION '408: the guard lands after a mutation — state or escalations change before the check';
  END IF;
  IF v_def NOT LIKE '%bad_status%' OR v_def NOT LIKE '%bad_priority%' THEN
    RAISE EXCEPTION '408: the argument validation was lost in the rewrite';
  END IF;
  IF v_def NOT LIKE '%decided_by = auth.uid()%' THEN
    RAISE EXCEPTION '408: the body lost content — a stale or truncated definition was applied';
  END IF;

  -- Runtime smoke test: argument validation needs no identity, so a bad status
  -- must still be rejected as a bad status.
  BEGIN
    PERFORM public.set_support_conversation_state(
      '00000000-0000-0000-0000-000000000000'::uuid, 'not_a_real_status', NULL);
  EXCEPTION WHEN others THEN
    v_raised := SQLERRM; v_fired := true;
  END;
  IF NOT v_fired THEN
    RAISE EXCEPTION '408: a bad status was accepted';
  END IF;

  RAISE NOTICE '408: set_support_conversation_state guarded — covers the escalation auto-approval too.';
END $assert$;

NOTIFY pgrst, 'reload schema';
