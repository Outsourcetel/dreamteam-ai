-- 419_guard_request_trust_promotion.sql
-- ============================================================================
-- Phase 3 Wave 2, GROUP B (actors) — completes the learning & trust sub-group.
-- See docs/30.
--
-- request_trust_promotion(p_policy_id) asks for an employee's autonomy to be
-- widened one step: it checks the evidence meets the policy criteria, raises a
-- trust_promotion task for a human, and stamps the caller as requested_by.
--
-- This is the most consequential verb in the sub-group in one specific sense.
-- 416 and 418 change what an employee KNOWS; this changes what it is allowed to
-- DO WITHOUT ASKING. It does not grant the promotion — a human still approves
-- the task — but an unscoped caller could put an employee they have no
-- relationship with in front of an approver, with the evidence pre-assembled
-- and their own name on the request. That is how a rubber-stamped approval
-- happens.
--
-- ── ⚠ NULL-TOLERANT, and this one is measured, not inherited ──────────────
-- trust_policies.de_id is NULLABLE — 8 of the 38 policies in production have no
-- de_id. Those are workspace-level trust policies (the ladder is tenant-wide
-- even though the dial is per-DE). So the guard MUST be the null-tolerant form
--
--     if v_policy.de_id is not null and not can_access_de(v_policy.de_id)
--
-- which is the exact negation of the migration-386 predicate. The plain form
-- would refuse every workspace-level promotion request for a scoped user while
-- the corresponding reader shows them the policy — the divergence 400-402 had
-- to undo in group A.
--
-- This differs from 416, 417 and 418, whose de_id columns are all NOT NULL and
-- which therefore use the plain form. Four functions in one sub-group, two
-- shapes, decided per column. Checking beat assuming: the sibling functions
-- would have suggested the plain form here.
--
-- This function RAISEs on every failure, so the guard raises too.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_status text := '  if v_policy.status <> ''active'' then';
  v_guard text; v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'request_trust_promotion';
  IF v_src IS NULL THEN RAISE EXCEPTION '419: request_trust_promotion not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '419: already guarded, nothing to do';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13) || chr(10) in v_src) > 0
                THEN chr(13) || chr(10) ELSE chr(10) END;

  v_guard := array_to_string(ARRAY[
    '  -- DE scoping (mig 385/419). NULL-TOLERANT: trust_policies.de_id is',
    '  -- nullable and 8 of 38 live policies are workspace-level, so the plain',
    '  -- form would refuse those for a scoped user while the reader still shows',
    '  -- them. Exact negation of the mig-386 predicate.',
    '  if v_policy.de_id is not null and not public.can_access_de(v_policy.de_id) then',
    '    raise exception ''not_responsible_for_de: this employee is not in your reporting line'';',
    '  end if;',
    ''], v_eol);

  v_hits := (length(v_src) - length(replace(v_src, a_status, ''))) / length(a_status);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '419: expected 1 policy-status check to anchor to, found % — the body changed, refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, a_status, v_guard || a_status);
  IF v_new = v_src THEN
    RAISE EXCEPTION '419: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_calls int; v_nullable text; v_raised text; v_fired boolean := false;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'request_trust_promotion';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  v_calls  := (length(v_def) - length(replace(v_def, 'public.can_access_de(', ''))) / length('public.can_access_de(');
  IF v_guards <> 1 OR v_calls <> 1 THEN
    RAISE EXCEPTION '419: expected exactly 1 guard (token %, calls %) — a comment may be inflating the count', v_guards, v_calls;
  END IF;
  IF v_def NOT LIKE '%raise exception ''not_responsible_for_de%' THEN
    RAISE EXCEPTION '419: the guard does not RAISE — this function contracts on raising';
  END IF;

  -- ⚠ The null-tolerant shape is the measured decision in this file. The plain
  -- form here would break every workspace-level policy for a scoped user.
  IF v_def NOT LIKE '%v_policy.de_id is not null and not public.can_access_de(v_policy.de_id)%' THEN
    RAISE EXCEPTION '419: the guard is not null-tolerant — 8 of 38 live policies have a null de_id';
  END IF;
  -- And the column really is nullable, or the reasoning above is wrong.
  SELECT is_nullable INTO v_nullable FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'trust_policies' AND column_name = 'de_id';
  IF v_nullable <> 'YES' THEN
    RAISE EXCEPTION '419: trust_policies.de_id is NOT NULL — the null-tolerant shape is now dead code, re-check it';
  END IF;

  IF position('not a member of this tenant' in v_def) > position('can_access_de' in v_def) THEN
    RAISE EXCEPTION '419: the scope guard runs before the tenant membership check';
  END IF;
  IF position('can_access_de' in v_def) > position('insert into human_tasks' in v_def)
     OR position('can_access_de' in v_def) > position('update trust_policies' in v_def) THEN
    RAISE EXCEPTION '419: the guard lands after a mutation';
  END IF;

  -- The eligibility gate is the product guarantee: promotion is evidence-based,
  -- never a button someone can simply press.
  IF v_def NOT LIKE '%not eligible for promotion%' THEN
    RAISE EXCEPTION '419: the evidence eligibility gate was lost — promotion would stop being evidence-based';
  END IF;
  IF v_def NOT LIKE '%already at the highest trust level%'
     OR v_def NOT LIKE '%already awaiting approval%' THEN
    RAISE EXCEPTION '419: the body lost content — a stale or truncated definition was applied';
  END IF;

  BEGIN
    PERFORM public.request_trust_promotion('00000000-0000-0000-0000-000000000000'::uuid);
  EXCEPTION WHEN others THEN
    v_raised := SQLERRM; v_fired := true;
  END;
  IF NOT v_fired OR v_raised NOT LIKE '%trust policy not found%' THEN
    RAISE EXCEPTION '419: expected policy-not-found to fire first, got: %', coalesce(v_raised, '(nothing raised)');
  END IF;

  RAISE NOTICE '419: request_trust_promotion guarded, null-tolerant. Learning & trust sub-group complete (416-419).';
END $assert$;

NOTIFY pgrst, 'reload schema';
