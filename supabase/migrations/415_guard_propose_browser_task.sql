-- 415_guard_propose_browser_task.sql
-- ============================================================================
-- Phase 3 Wave 2, GROUP B (actors) — completes the browser-operator sub-group.
-- See docs/30 and migration 414's header, which applies here in full.
--
-- ⚠ SAME STANDING AS 414: DEFENCE IN DEPTH, NOT A HOLE CLOSED. ────────────
-- propose_browser_task already refuses anyone who is not a member of the named
-- workspace holding tenant_owner / tenant_admin / tenant_manager, and
-- can_access_de() passes all three unconditionally. **No behaviour changes.**
-- Recorded honestly so the wave is not mis-measured.
--
-- ── Two differences from 414 worth writing down ───────────────────────────
--
-- 1. MECHANISM. This function RAISEs on every failure — 'not permitted — tenant
--    admin required', 'de not in tenant', 'at least one allowed site is
--    required'. So the guard RAISEs too. Its sibling create_browser_operation
--    returns an {ok:false} envelope and 414 matches THAT. Same rule, mechanism
--    chosen per contract — the group-B requirement is refuse EXPLICITLY, never
--    filter silently; it was never "always RAISE".
--
-- 2. PLACEMENT. 414 guards immediately after its role gate. Here the guard goes
--    after the `de not in tenant` check instead, which is the last thing before
--    the INSERT. That is deliberate: it is the canonical group-B shape —
--    resolve the row, prove it is real and in-tenant, THEN check responsibility,
--    THEN mutate. Guarding earlier would work but would check an employee whose
--    existence has not yet been established, and can_access_de(<nonexistent>)
--    is TRUE for owner/admin/manager, so the guard would silently be a no-op
--    on a bad id rather than a real check.
--
-- ── Note on p_tenant_id ───────────────────────────────────────────────────
-- This function takes the tenant as a PARAMETER, which is the shape that hid a
-- genuine cross-tenant hole in analytics_de_workload (mig 398). Not the case
-- here: the first check is `public.auth_tenant_id() = p_tenant_id`, so the
-- caller cannot name a workspace that is not theirs. Verified, not assumed.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text; v_eol text;
  a_de text; v_guard text; v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'propose_browser_task';
  IF v_src IS NULL THEN RAISE EXCEPTION '415: propose_browser_task not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '415: already guarded, nothing to do';
    RETURN;
  END IF;

  v_eol := CASE WHEN position(chr(13) || chr(10) in v_src) > 0
                THEN chr(13) || chr(10) ELSE chr(10) END;

  a_de := array_to_string(ARRAY[
    '  IF NOT EXISTS (SELECT 1 FROM digital_employees WHERE id = p_de_id AND tenant_id = p_tenant_id) THEN',
    '    RAISE EXCEPTION ''de not in tenant'';',
    '  END IF;'], v_eol);

  v_guard := array_to_string(ARRAY[
    -- NB: this comment deliberately avoids the bare token, so that counting
    -- occurrences of it in the body stays equal to the number of real guards.
    '  -- DE scoping (mig 385/415). DEFENCE IN DEPTH, NOT A FIX: the manager+',
    '  -- gate above already implies this. Placed AFTER the existence check on',
    '  -- purpose — the check below is TRUE for owner/admin/manager even for an',
    '  -- id that resolves to nothing, so guarding before the row is proven real',
    '  -- would be a no-op on a bad id. RAISEs to match this function.',
    '  IF NOT public.can_access_de(p_de_id) THEN',
    '    RAISE EXCEPTION ''not_responsible_for_de: this employee is not in your reporting line'';',
    '  END IF;'], v_eol);

  v_hits := (length(v_src) - length(replace(v_src, a_de, ''))) / length(a_de);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '415: expected 1 employee existence check to anchor to, found % — the body changed, refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src, a_de, a_de || v_eol || v_guard);
  IF v_new = v_src THEN
    RAISE EXCEPTION '415: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_raised text; v_fired boolean := false;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'propose_browser_task';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  IF v_guards <> 1 THEN
    RAISE EXCEPTION '415: expected exactly 1 guard, found %', v_guards;
  END IF;
  IF v_def NOT LIKE '%RAISE EXCEPTION ''not_responsible_for_de%' THEN
    RAISE EXCEPTION '415: the guard does not RAISE — this function contracts on raising';
  END IF;

  -- ⚠ THE CRITICAL ASSERTION. The manager+ gate is what actually restricts this
  -- function; trading it for the redundant guard would WIDEN access to any
  -- assigned user while looking like a security improvement.
  IF v_def NOT LIKE '%auth_has_tenant_role(ARRAY[''tenant_owner'',''tenant_admin'',''tenant_manager''])%' THEN
    RAISE EXCEPTION '415: the manager+ role gate was lost — this migration would have WIDENED access, not narrowed it';
  END IF;
  -- The tenant pin is what keeps the p_tenant_id parameter from being the
  -- cross-tenant shape that bit analytics_de_workload (mig 398).
  IF v_def NOT LIKE '%public.auth_tenant_id() = p_tenant_id%' THEN
    RAISE EXCEPTION '415: the tenant pin was lost — p_tenant_id becomes caller-chosen, the mig-398 shape';
  END IF;
  -- Guard must sit AFTER the existence check it depends on, and BEFORE the insert.
  IF position('de not in tenant' in v_def) > position('can_access_de' in v_def) THEN
    RAISE EXCEPTION '415: the guard runs before the existence check — it would be a no-op on a bad id';
  END IF;
  IF position('can_access_de' in v_def) > position('INSERT INTO computer_use_tasks' in v_def) THEN
    RAISE EXCEPTION '415: the guard lands after the task insert';
  END IF;
  -- Safety properties of the browser surface.
  IF v_def NOT LIKE '%default OFF%' THEN
    RAISE EXCEPTION '415: the computer_use feature gate was lost';
  END IF;
  IF v_def NOT LIKE '%at least one allowed site is required%' THEN
    RAISE EXCEPTION '415: the domain-confinement requirement was lost — a task could run unconfined';
  END IF;
  IF v_def NOT LIKE '%approval_gate%' THEN
    RAISE EXCEPTION '415: the human approval task was lost — operations would run ungated';
  END IF;

  -- Runtime smoke test: postgres is a member of no workspace, so the role gate
  -- fires first. Proves the body compiles and the gate order survived.
  BEGIN
    PERFORM public.propose_browser_task(
      '00000000-0000-0000-0000-000000000000'::uuid,
      '00000000-0000-0000-0000-000000000000'::uuid,
      'a goal', ARRAY['example.com'], 5, 'browser_dom', 'none', NULL);
  EXCEPTION WHEN others THEN
    v_raised := SQLERRM; v_fired := true;
  END;
  IF NOT v_fired OR v_raised NOT LIKE '%tenant admin required%' THEN
    RAISE EXCEPTION '415: expected the role gate to fire first, got: %', coalesce(v_raised, '(nothing raised)');
  END IF;

  RAISE NOTICE '415: guard added. NO BEHAVIOURAL CHANGE — manager+ already passed can_access_de. Browser-operator sub-group complete (414-415), both defence in depth.';
END $assert$;

NOTIFY pgrst, 'reload schema';
