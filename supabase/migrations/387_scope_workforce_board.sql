-- 387_scope_workforce_board.sql
-- ============================================================================
-- Phase 3 Wave 2, group A, first function. See docs/30-de-scoping-wave2-worklist.md.
--
-- get_workforce_board is the roster everybody lands on, and it aggregates
-- across EVERY digital employee by design. It is SECURITY DEFINER, so the
-- restrictive policies migration 386 put on de_work_items, human_tasks and the
-- rest do not apply inside it: RLS is bypassed for the duration of the call.
--
-- So today this function hands a scoped user the whole workforce — the board,
-- what each employee is doing right now, and what is queued next — regardless
-- of who they are responsible for. It is the single widest reader in the list
-- of 46, which is why it is first.
--
-- ── The fix is one predicate, on purpose ───────────────────────────────────
-- The outer query already filters to the tenant and drops retired employees.
-- Scoping belongs in exactly that WHERE clause, because every inner subquery is
-- correlated to d.id — filter the employees and everything hanging off them
-- follows. Filtering the subqueries instead would be more code, more places to
-- get wrong, and would still show an empty card for an employee you may not see.
--
-- Reproduce-from-live: the body is read with pg_get_functiondef and edited,
-- never pasted from an older migration. This function has been amended several
-- times (next-up channels, objective wakes); re-applying a stale body would
-- silently revert that work, which is how 377 undid the export pager.
--
-- Still dark: can_access_de is true for owner, admin and manager, and nobody
-- live holds a role below manager.
-- ============================================================================

DO $patch$
DECLARE v_src text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_workforce_board';
  IF v_src IS NULL THEN RAISE EXCEPTION '387: get_workforce_board not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '387: already scoped, nothing to do';
    RETURN;
  END IF;

  v_new := replace(v_src,
    '    FROM digital_employees d
    WHERE d.tenant_id = v_tenant',
    '    FROM digital_employees d
    WHERE d.tenant_id = v_tenant
      -- DE scoping (mig 385/387): every subquery below is correlated to d.id,
      -- so filtering the employee filters its work, its queue and its counts.
      AND public.can_access_de(d.id)');

  IF v_new = v_src THEN
    RAISE EXCEPTION '387: could not find the outer tenant filter — its shape changed, refusing to guess';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_board jsonb;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_workforce_board';

  IF v_def NOT ILIKE '%can_access_de%' THEN
    RAISE EXCEPTION '387: the scope predicate is not present';
  END IF;
  -- The rewrite must not have cost the function its tenant filter. A scoping
  -- change that drops tenant isolation would be catastrophically worse than the
  -- gap it closes, and would still look scoped in a diff.
  IF v_def NOT LIKE '%d.tenant_id = v_tenant%' THEN
    RAISE EXCEPTION '387: the tenant filter was lost in the rewrite';
  END IF;
  IF v_def NOT LIKE '%next_up%' OR v_def NOT LIKE '%lifecycle_status%' THEN
    RAISE EXCEPTION '387: the body lost content — a stale or truncated definition was applied';
  END IF;

  -- Still returns its shape. Runs as postgres, which has no workspace, so the
  -- board is expected to be EMPTY here — the check is that it does not error.
  SELECT public.get_workforce_board() INTO v_board;
  IF v_board->>'ok' IS NULL THEN
    RAISE EXCEPTION '387: get_workforce_board no longer returns its contract';
  END IF;

  RAISE NOTICE '387: workforce board scoped. Verify with a real signed-in user — a migration runs as postgres and can never see a board.';
END $assert$;

NOTIFY pgrst, 'reload schema';
