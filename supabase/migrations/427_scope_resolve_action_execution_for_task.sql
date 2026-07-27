-- 427_scope_resolve_action_execution_for_task.sql
-- ============================================================================
-- Phase 3 Wave 2, GROUP C — "verify before skipping". See docs/30.
--
-- resolve_action_execution_for_task(p_task_id) returns the action_executions
-- row behind a human approval task: what the employee actually wants to do, the
-- decision that gated it, and its parameters. docs/30 classified it as internal.
-- Measured, it is not: it is `authenticated`-executable, it is not a trigger,
-- and **the browser calls it directly** — `src/lib/connectorApi.ts:1403`. It is
-- the detail panel behind an approval.
--
-- ── What it already gets right, and what it was missing ───────────────────
-- Unlike its group-C neighbours this one is NOT a cross-tenant hole: it
-- resolves the task's tenant and refuses a caller from another workspace
-- (with a platform `support.cross_tenant` capability escape). That is the role
-- axis and it is kept untouched.
--
-- What it never had is the assignment axis. Any member of the workspace holding
-- a task id could read the pending action of any employee — the one surface in
-- group C that is a genuine DE-scoping gap rather than a tenant one.
--
-- ── A reader, so it FILTERS — it does not raise ───────────────────────────
-- This is group A's rule, not group B's, because the function reads and returns
-- a row rather than mutating anything. It already answers "no such task" by
-- returning NULL, so an inaccessible action returns NULL too: indistinguishable
-- from a task that does not exist, which is the property we want. Raising here
-- would both break the caller's contract and confirm the row exists.
--
-- ── Scoped on the ACTION's subject, not the task's de_id ──────────────────
-- Deliberate. human_tasks.de_id is NULL on 760 of 924 rows (82%), so scoping on
-- it would be nearly meaningless here. The action_executions row carries the
-- real attribution — subject_kind = 'de' with subject_id as the employee — and
-- that is the row being returned, so it is the right thing to test.
--
-- Rows whose subject is not a DE (subject_kind <> 'de') are left alone: they
-- are not an employee's work and there is nothing to scope them by.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_ret text := '  return v_row;';
  v_guard text; v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_action_execution_for_task';
  IF v_src IS NULL THEN RAISE EXCEPTION '427: resolve_action_execution_for_task not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '427: already scoped, nothing to do';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13) || chr(10) in v_src) > 0
                THEN chr(13) || chr(10) ELSE chr(10) END;

  -- Two apostrophes escapes to one inside this dollar-quoted block (mig 425).
  v_guard := array_to_string(ARRAY[
    '  -- DE scoping (mig 385/427). A READER, so it filters rather than raising:',
    '  -- an action the caller may not see returns NULL, exactly as a task that',
    '  -- does not exist already does. Scoped on the ACTION subject, not on',
    '  -- human_tasks.de_id, which is NULL on 82% of rows.',
    '  if v_row.id is not null and v_row.subject_kind = ''de''',
    '     and v_row.subject_id is not null',
    '     and not public.can_access_de(v_row.subject_id) then',
    '    return null;',
    '  end if;'], v_eol);

  v_hits := (length(v_src) - length(replace(v_src, a_ret, ''))) / length(a_ret);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '427: expected 1 return statement to anchor to, found % — the body changed, refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, a_ret, v_guard || v_eol || a_ret);
  IF v_new = v_src THEN
    RAISE EXCEPTION '427: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_calls int; v_row action_executions;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_action_execution_for_task';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  v_calls  := (length(v_def) - length(replace(v_def, 'public.can_access_de(', ''))) / length('public.can_access_de(');
  IF v_guards <> 1 OR v_calls <> 1 THEN
    RAISE EXCEPTION '427: expected exactly 1 guard (token %, calls %)', v_guards, v_calls;
  END IF;

  -- It must FILTER, not raise. A reader that starts raising both breaks
  -- connectorApi.ts and confirms the row exists.
  IF v_def NOT LIKE '%return null;%' THEN
    RAISE EXCEPTION '427: the guard does not return null — a reader must filter, not raise';
  END IF;
  IF v_def LIKE '%raise exception%not_responsible_for_de%' THEN
    RAISE EXCEPTION '427: the guard raises — this is a reader and its caller expects null';
  END IF;
  -- The subject_kind pin is what makes subject_id an employee id at all.
  IF v_def NOT LIKE '%v_row.subject_kind = ''de''%' THEN
    RAISE EXCEPTION '427: the subject_kind pin is missing — subject_id would not be an employee id';
  END IF;
  -- The tenant axis must survive alongside the new one.
  IF v_def NOT LIKE '%tenant access denied%' THEN
    RAISE EXCEPTION '427: the tenant check was lost in the rewrite';
  END IF;
  IF v_def NOT LIKE '%support.cross_tenant%' THEN
    RAISE EXCEPTION '427: the platform cross-tenant capability escape was lost';
  END IF;
  -- The guard must sit after the row is fetched and before it is handed back.
  IF position('order by ae.created_at desc' in v_def) > position('can_access_de' in v_def) THEN
    RAISE EXCEPTION '427: the guard runs before the row is fetched — v_row would be empty';
  END IF;

  -- Runtime smoke test: an unknown task must still return null, not error.
  SELECT * INTO v_row FROM public.resolve_action_execution_for_task(
    '00000000-0000-0000-0000-000000000000'::uuid);
  IF v_row.id IS NOT NULL THEN
    RAISE EXCEPTION '427: an unknown task returned a row';
  END IF;

  RAISE NOTICE '427: scoped. docs/30 called this internal; the browser calls it directly at connectorApi.ts:1403.';
END $assert$;

NOTIFY pgrst, 'reload schema';
