-- 395_scope_pending_draft.sql
-- ============================================================================
-- Phase 3 Wave 2, group A. See docs/30-de-scoping-wave2-worklist.md.
--
-- get_pending_draft(p_draft_id) returns one draft reply an employee has written
-- and is waiting for a human to approve: the customer's question and the full
-- proposed answer. It is keyed on the DRAFT id alone — a caller who has a draft
-- id gets its contents, whoever the employee is. It is SECURITY DEFINER, so the
-- restrictive policy on draft_responses does not apply inside it.
--
-- ── The fix ────────────────────────────────────────────────────────────────
-- One predicate. draft_responses.de_id is NOT NULL, so there is no null case:
-- every draft belongs to exactly one employee, and the caller either is
-- responsible for that employee or gets NULL back — the same answer the
-- function already gives for an expired or already-decided draft.
--
-- ⚠ TWO PRE-EXISTING ISSUES ON THIS FUNCTION, NOT FIXED HERE ────────────────
-- Both are out of scope for a DE-scoping wave and are recorded so they are not
-- mistaken for something this migration handled:
--
--   1. `anon` HAS EXECUTE on this function. Signup is live, so `anon` is the
--      internet ([[security_authenticated_perimeter]]). It fails closed today —
--      its only guard is current_setting('app.current_tenant_id'), which RAISES
--      when unset rather than returning null — and after this migration
--      can_access_de is false for anon on every branch, so it now fails closed
--      twice. That is a reason it is not urgent, not a reason to leave it.
--   2. NO `SET search_path` on a SECURITY DEFINER function, so `draft_responses`
--      resolves through the caller's search_path. Every comparable function in
--      this codebase pins it.
--
-- Neither is a DE-scoping bug and neither should be bundled into a scoping
-- migration; both are written up for the founder to decide on.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text;
  v_anchor text := 'AND tenant_id = current_setting(''app.current_tenant_id'')::uuid';
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_pending_draft';
  IF v_src IS NULL THEN RAISE EXCEPTION '395: get_pending_draft not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '395: already scoped, nothing to do';
    RETURN;
  END IF;

  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '395: expected 1 tenant filter, found % — the body changed, refusing to guess', v_hits;
  END IF;

  -- Schema-qualified on purpose: this function has no SET search_path (see the
  -- header), so an unqualified call would be resolved by the caller.
  v_new := replace(v_src, v_anchor,
    v_anchor || E'\n      -- DE scoping (mig 385/395): a draft belongs to one employee, and\n      -- draft_responses.de_id is NOT NULL, so there is no null case here.\n      AND public.can_access_de(de_id)');

  IF v_new = v_src THEN
    RAISE EXCEPTION '395: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_nullable text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_pending_draft';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  IF v_guards <> 1 THEN
    RAISE EXCEPTION '395: expected exactly 1 scope guard, found %', v_guards;
  END IF;

  -- The guard must be schema-qualified, because this function does not pin its
  -- search_path. An unqualified can_access_de here would be resolvable by the
  -- caller — a scoping check the caller can redefine is not a check.
  IF v_def NOT LIKE '%public.can_access_de%' THEN
    RAISE EXCEPTION '395: the guard is not schema-qualified and this function has no SET search_path';
  END IF;

  IF v_def NOT LIKE '%status = ''pending''%'
     OR v_def NOT LIKE '%expires_at > now()%'
     OR v_def NOT LIKE '%app.current_tenant_id%' THEN
    RAISE EXCEPTION '395: an existing filter was lost in the rewrite';
  END IF;
  IF v_def NOT LIKE '%draft_content%' OR v_def NOT LIKE '%confidence%' THEN
    RAISE EXCEPTION '395: the body lost content — a stale or truncated definition was applied';
  END IF;

  -- The no-null-case claim is load-bearing for the comment above. Assert it
  -- rather than trusting it: if de_id ever becomes nullable, this guard starts
  -- silently hiding drafts from owners too.
  SELECT is_nullable INTO v_nullable FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'draft_responses' AND column_name = 'de_id';
  IF v_nullable <> 'NO' THEN
    RAISE EXCEPTION '395: draft_responses.de_id is nullable — the null case this migration assumed away is real';
  END IF;

  RAISE NOTICE '395: get_pending_draft scoped. NOTE: anon still holds EXECUTE and the function has no SET search_path — both pre-existing, both written up, neither fixed here.';
END $assert$;

NOTIFY pgrst, 'reload schema';
