-- 409_guard_handoff_back_to_de.sql
-- ============================================================================
-- Phase 3 Wave 2, GROUP B (actors) — completes the support-flow sub-group.
-- See docs/30 and migration 403's header.
--
-- handoff_back_to_de(p_conversation_id, p_note) returns a human-held thread to
-- the digital employee and, if a note is given, WRITES THAT NOTE INTO THE
-- EMPLOYEE'S MEMORY via de_memory_write — episodic, confidence 0.9, source
-- 'human'. de-answer recalls it on the next customer message in the thread.
--
-- That makes this the most consequential actor in the sub-group. The other
-- three move a row between states; this one puts words into an employee's head
-- and they stay there. Unscoped, a person could instruct an employee they have
-- no relationship with, and the instruction would be indistinguishable from one
-- written by the person actually responsible for it. It also auto-approves the
-- thread's pending escalation tasks and writes an activity event under the
-- employee's own name.
--
-- ── The one guard in this sub-group that needs no null-tolerance ───────────
-- This body already resolves v_de and refuses outright when it is null:
--
--     if v_de is null then raise exception 'no_de_on_conversation'; end if;
--
-- So by the time the guard runs, v_de is proven non-null and a plain
-- `not can_access_de(v_de)` is exactly right. Adding `v_de is not null and`
-- here would be dead code that implies a case the function has already
-- excluded — worse than redundant, it would mislead the next reader into
-- thinking an unattributed conversation can reach this point.
--
-- The guard is placed immediately after that null check and before the first
-- mutation, so all four side effects — status change, memory write, escalation
-- approval, activity event — are behind it.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_null text := '  if v_de is null then raise exception ''no_de_on_conversation''; end if;';
  v_guard text;
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'handoff_back_to_de';
  IF v_src IS NULL THEN RAISE EXCEPTION '409: handoff_back_to_de not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '409: already guarded, nothing to do';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13) || chr(10) in v_src) > 0
                THEN chr(13) || chr(10) ELSE chr(10) END;

  v_guard := array_to_string(ARRAY[
    '',
    '  -- DE scoping (mig 385/409). v_de is proven non-null by the check above,',
    '  -- so no null-tolerance here — this function refuses a DE-less conversation',
    '  -- outright. Guards all four side effects below, including the memory',
    '  -- write, which is the one that persists inside the employee.',
    '  if not public.can_access_de(v_de) then',
    '    raise exception ''not_responsible_for_de: this employee is not in your reporting line'';',
    '  end if;'], v_eol);

  v_hits := (length(v_src) - length(replace(v_src, a_null, ''))) / length(a_null);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '409: expected 1 null-de check to anchor to, found % — the body changed, refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, a_null, a_null || v_guard);
  IF v_new = v_src THEN
    RAISE EXCEPTION '409: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'handoff_back_to_de';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  IF v_guards <> 1 THEN
    RAISE EXCEPTION '409: expected exactly 1 guard, found %', v_guards;
  END IF;
  IF v_def NOT LIKE '%raise exception ''not_responsible_for_de%' THEN
    RAISE EXCEPTION '409: the guard does not RAISE — an actor must refuse, not filter';
  END IF;
  -- The null check this guard depends on must still be there AND still be first.
  IF v_def NOT LIKE '%no_de_on_conversation%' THEN
    RAISE EXCEPTION '409: the null-de check was lost — the guard would test a null v_de';
  END IF;
  -- Stated as the failure condition directly: if the null check appears LATER
  -- in the body than the guard, the guard is testing a v_de that has not been
  -- proven non-null yet.
  IF position('no_de_on_conversation' in v_def) > position('can_access_de' in v_def) THEN
    RAISE EXCEPTION '409: the guard runs before the null-de check it depends on';
  END IF;
  IF position('_assert_conv_member' in v_def) > position('can_access_de' in v_def) THEN
    RAISE EXCEPTION '409: the scope guard runs before the workspace check';
  END IF;
  -- All four side effects must sit behind the guard. de_memory_write is the
  -- one that persists inside the employee, so it is checked explicitly.
  IF position('can_access_de' in v_def) > position('de_memory_write' in v_def)
     OR position('can_access_de' in v_def) > position('update human_tasks' in v_def)
     OR position('can_access_de' in v_def) > position('insert into activity_events' in v_def)
     OR position('can_access_de' in v_def) > position('set status = ''ai_handling''' in v_def) THEN
    RAISE EXCEPTION '409: a side effect runs before the guard';
  END IF;
  IF v_def NOT LIKE '%conversation_resolved%' OR v_def NOT LIKE '%handoff_returned%' THEN
    RAISE EXCEPTION '409: the body lost content — a stale or truncated definition was applied';
  END IF;

  RAISE NOTICE '409: handoff_back_to_de guarded — including the de_memory_write that persists inside the employee.';
END $assert$;

NOTIFY pgrst, 'reload schema';
