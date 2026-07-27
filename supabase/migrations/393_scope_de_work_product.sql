-- 393_scope_de_work_product.sql
-- ============================================================================
-- Phase 3 Wave 2, group A. See docs/30-de-scoping-wave2-worklist.md.
--
-- get_de_work_product(p_de_id) is what an employee has actually produced:
-- conversation volume by channel and outcome, and every system action it has
-- taken grouped by category. It powers the Employee File "Work" tab. It is
-- SECURITY DEFINER, so migration 386's restrictive policy on de_conversations
-- is bypassed, and its only check is workspace membership.
--
-- ── Gate the existence check, not the two reads ────────────────────────────
-- The body already refuses with {ok:false, error:'de_not_found'} when the
-- employee is not in the caller's workspace, and both reads run after it.
-- Extending that one condition covers both, and keeps "you may not see this"
-- reported identically to "this does not exist" — an employee you are not
-- responsible for should not be confirmed to exist by the error code.
--
-- The action read is keyed on subject_kind = 'de' AND subject_id = p_de_id, so
-- it is covered by the same gate; there is no second de reference to miss.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text;
  v_anchor text := 'if not exists (select 1 from digital_employees where id = p_de_id and tenant_id = v_tenant) then';
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_de_work_product';
  IF v_src IS NULL THEN RAISE EXCEPTION '393: get_de_work_product not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '393: already scoped, nothing to do';
    RETURN;
  END IF;

  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '393: expected 1 existence check, found % — the body changed, refusing to guess', v_hits;
  END IF;

  -- DE scoping (mig 385/393): an employee the caller is not responsible for is
  -- reported exactly as one that does not exist.
  v_new := replace(v_src, v_anchor,
    'if not exists (select 1 from digital_employees where id = p_de_id and tenant_id = v_tenant and public.can_access_de(id)) then');

  IF v_new = v_src THEN
    RAISE EXCEPTION '393: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_out jsonb;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_de_work_product';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  IF v_guards <> 1 THEN
    RAISE EXCEPTION '393: expected exactly 1 scope guard, found %', v_guards;
  END IF;

  -- Position, not presence: the guard must precede both reads it protects.
  IF position('can_access_de' in v_def) > position('de_conversations' in v_def)
     OR position('can_access_de' in v_def) > position('action_executions' in v_def) THEN
    RAISE EXCEPTION '393: the guard is not ahead of the reads it is meant to gate';
  END IF;
  IF v_def NOT LIKE '%de_not_found%' THEN
    RAISE EXCEPTION '393: the not-found contract was lost in the rewrite';
  END IF;
  IF v_def NOT LIKE '%by_channel%'
     OR v_def NOT LIKE '%rollback_of is null%' THEN
    RAISE EXCEPTION '393: the body lost content — a stale or truncated definition was applied';
  END IF;

  SELECT public.get_de_work_product('00000000-0000-0000-0000-000000000000'::uuid) INTO v_out;
  IF v_out->>'ok' IS NULL THEN
    RAISE EXCEPTION '393: the function no longer returns its ok/error contract';
  END IF;

  RAISE NOTICE '393: work product scoped at the existence check; denial is indistinguishable from de_not_found.';
END $assert$;

NOTIFY pgrst, 'reload schema';
