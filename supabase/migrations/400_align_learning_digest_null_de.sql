-- 400_align_learning_digest_null_de.sql
-- ============================================================================
-- Corrects migration 389 — mine, applied an hour earlier in this same session.
--
-- ── The inconsistency ──────────────────────────────────────────────────────
-- Migration 386 put seven restrictive policies on the Wave-1 work surfaces, and
-- every one of them reads:
--
--     (de_id IS NULL) OR can_access_de(de_id)
--
-- A row attributed to NO employee is visible to the whole workspace. That is a
-- deliberate choice in the shipped policy, and 389 did not match it: a bare
-- can_access_de(de_id) is FALSE for a scoped user when de_id is null, because
-- the assignment lookup finds nothing to match.
--
-- So after 389 the same table answered two different questions depending on how
-- it was reached — RLS said an unattributed task was visible, the RPC said it
-- was not. That is precisely the "one predicate in two places" failure docs/29
-- names as the reason can_access_de exists at all, and I reintroduced it while
-- closing the SECURITY DEFINER bypass.
--
-- ── Why it matters here specifically ───────────────────────────────────────
-- human_tasks.de_id is NULL on 760 of 924 rows in production — 82%. So this is
-- not a corner case: for a scoped user the escalations count would have been
-- computed over a sixth of the tasks the table would have shown them directly.
--
-- ── Direction of the fix, and what is NOT being decided ────────────────────
-- This aligns the RPC to the POLICY, not the other way round. The policy
-- shipped first, was reviewed as part of Wave 1, and is the more permissive of
-- the two — so adopting it cannot hide anything from anyone that is visible
-- today. Nobody's view changes either way right now: every live user is owner,
-- admin or manager, all of whom pass can_access_de unconditionally.
--
-- Whether an unattributed row SHOULD be workspace-visible is a real product
-- question and is NOT settled here. It is now answered consistently in one
-- shape, which is the prerequisite for changing it in one place later.
--
-- The ramp guard on digital_employees.id is left alone: that is an entity's own
-- identity, never null, and not an attribution.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text;
  v_anchor text := 'AND public.can_access_de(de_id)';
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_workforce_learning_digest';
  IF v_src IS NULL THEN RAISE EXCEPTION '400: get_workforce_learning_digest not found'; END IF;

  IF v_src LIKE '%de_id IS NULL OR public.can_access_de%' THEN
    RAISE NOTICE '400: already aligned, nothing to do';
    RETURN;
  END IF;
  IF v_src NOT LIKE '%can_access_de%' THEN
    RAISE EXCEPTION '400: no scope guards present — migration 389 has not been applied';
  END IF;

  -- Exactly the three attribution guards. The fourth guard in this body is
  -- can_access_de(d.id) on the ramp roster and must NOT match this anchor.
  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 3 THEN
    RAISE EXCEPTION '400: expected 3 attribution guards, found % — refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, v_anchor, 'AND (de_id IS NULL OR public.can_access_de(de_id))');
  IF v_new = v_src THEN
    RAISE EXCEPTION '400: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_aligned int; v_total int; v_out jsonb;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_workforce_learning_digest';

  v_aligned := (length(v_def) - length(replace(v_def, 'de_id IS NULL OR public.can_access_de', '')))
               / length('de_id IS NULL OR public.can_access_de');
  v_total   := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');

  IF v_aligned <> 3 THEN
    RAISE EXCEPTION '400: expected 3 null-aligned guards, found %', v_aligned;
  END IF;
  -- Four guards total: three aligned attributions plus the untouched ramp
  -- guard. If this is 3, the ramp roster lost its scoping.
  IF v_total <> 4 THEN
    RAISE EXCEPTION '400: expected 4 guards in total (3 attribution + 1 ramp roster), found %', v_total;
  END IF;
  IF v_def NOT LIKE '%can_access_de(d.id)%' THEN
    RAISE EXCEPTION '400: the ramp roster guard was lost — the employee list is unscoped again';
  END IF;
  IF v_def NOT LIKE '%recurring_issues_fixed%' OR v_def NOT LIKE '%days_to_first_cert%' THEN
    RAISE EXCEPTION '400: the body lost content — a stale or truncated definition was applied';
  END IF;

  SELECT public.get_workforce_learning_digest(7) INTO v_out;
  IF v_out->>'ok' IS NULL THEN
    RAISE EXCEPTION '400: the function no longer returns its ok/error contract';
  END IF;

  RAISE NOTICE '400: learning digest now matches the mig-386 policy shape. Open question for the founder: SHOULD an unattributed row be workspace-visible? 82%% of human_tasks carry no de_id.';
END $assert$;

NOTIFY pgrst, 'reload schema';
