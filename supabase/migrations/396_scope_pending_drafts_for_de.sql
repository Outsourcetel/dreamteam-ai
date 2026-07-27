-- 396_scope_pending_drafts_for_de.sql
-- ============================================================================
-- Phase 3 Wave 2, group A. See docs/30-de-scoping-wave2-worklist.md.
--
-- get_pending_drafts_for_de(p_de_id) is the list form of 395: every draft reply
-- an employee is waiting on a human for, with the customer question and the
-- full proposed answer. SECURITY DEFINER, so the restrictive policy on
-- draft_responses is bypassed, and the only filter is the employee id the
-- caller passed in — which is precisely what a scoped user should not be able
-- to choose freely.
--
-- Same fix and same shape as 395; kept as its own migration so a failure here
-- cannot be confused with a failure there, and so the assertion names one
-- function. draft_responses.de_id is NOT NULL, so there is no null case.
--
-- ⚠ The same two pre-existing issues as 395 apply to this function and are NOT
-- fixed here: `anon` holds EXECUTE, and there is no SET search_path. Both are
-- written up for the founder rather than bundled into a scoping migration.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text;
  v_anchor text := 'AND tenant_id = current_setting(''app.current_tenant_id'')::uuid;';
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_pending_drafts_for_de';
  IF v_src IS NULL THEN RAISE EXCEPTION '396: get_pending_drafts_for_de not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '396: already scoped, nothing to do';
    RETURN;
  END IF;

  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '396: expected 1 terminated tenant filter, found % — the body changed, refusing to guess', v_hits;
  END IF;

  -- Note the anchor carries the statement terminator, so the guard is spliced
  -- INSIDE the WHERE clause rather than after the statement ends.
  v_new := replace(v_src, v_anchor,
    E'AND tenant_id = current_setting(''app.current_tenant_id'')::uuid\n    -- DE scoping (mig 385/396): schema-qualified because this function does\n    -- not pin its search_path.\n    AND public.can_access_de(de_id);');

  IF v_new = v_src THEN
    RAISE EXCEPTION '396: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_out json;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_pending_drafts_for_de';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  IF v_guards <> 1 THEN
    RAISE EXCEPTION '396: expected exactly 1 scope guard, found %', v_guards;
  END IF;
  IF v_def NOT LIKE '%public.can_access_de%' THEN
    RAISE EXCEPTION '396: the guard is not schema-qualified and this function has no SET search_path';
  END IF;

  -- The guard must sit inside the WHERE clause, not after the statement. If the
  -- terminator ended up before it, the body would not have compiled — but a
  -- misplaced guard that still parses is the dangerous version, so check order.
  IF position('can_access_de' in v_def) > position('app.current_tenant_id' in v_def)
     AND v_def NOT LIKE '%can_access_de(de_id);%' THEN
    RAISE EXCEPTION '396: the guard is not inside the WHERE clause';
  END IF;

  IF v_def NOT LIKE '%status = ''pending''%'
     OR v_def NOT LIKE '%expires_at > now()%'
     OR v_def NOT LIKE '%FILTER (WHERE draft_id IS NOT NULL)%' THEN
    RAISE EXCEPTION '396: an existing filter was lost in the rewrite';
  END IF;

  -- Runtime smoke test. This function reads current_setting without a default,
  -- so with app.current_tenant_id unset it must RAISE — that is its existing
  -- fail-closed behaviour and the check is that the rewrite did not remove it.
  BEGIN
    SELECT public.get_pending_drafts_for_de('00000000-0000-0000-0000-000000000000'::uuid) INTO v_out;
    -- If a tenant id happens to be set in this session it returns null instead;
    -- either way the body executed, which is what the smoke test is for.
    RAISE NOTICE '396: smoke call returned without raising (app.current_tenant_id was set in this session)';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%app.current_tenant_id%' THEN
      RAISE EXCEPTION '396: the body raised something unexpected: %', SQLERRM;
    END IF;
  END;

  RAISE NOTICE '396: get_pending_drafts_for_de scoped. Same two pre-existing issues as 395 remain open by design.';
END $assert$;

NOTIFY pgrst, 'reload schema';
