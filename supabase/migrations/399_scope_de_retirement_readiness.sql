-- 399_scope_de_retirement_readiness.sql
-- ============================================================================
-- Phase 3 Wave 2, group A — the last of the thirteen readers.
-- See docs/30-de-scoping-wave2-worklist.md.
--
-- ⚠ READ THIS BEFORE COUNTING IT AS A HOLE CLOSED. ─────────────────────────
-- check_de_retirement_readiness(p_de_id) is ALREADY gated to owner and admin:
--
--     if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then
--       raise exception 'only workspace owners/admins can check retirement readiness';
--
-- can_access_de returns TRUE for owner, admin and manager unconditionally, so
-- everyone who can reach this function already passes the check being added.
-- THIS MIGRATION CHANGES NO BEHAVIOUR TODAY, and will not change any until the
-- role gate above is loosened. It is defence in depth, not a fix.
--
-- It is applied anyway, and recorded honestly, for one reason: the worklist
-- classified this function as a group-A reader, and the next person to audit
-- that list needs to find either a guard or a written reason there is none.
-- Leaving it as the one unguarded entry with the explanation living only in a
-- session transcript is how "13 of 13" quietly becomes "12 of 13 and nobody
-- remembers why".
--
-- The alternative — relying on the role gate alone — puts the access rule in
-- two places, which is the mistake the knowledge ACL taught (docs/29): one
-- predicate, delegated to everywhere. If the retirement flow is ever opened to
-- managers, the guard is already where it needs to be.
--
-- ── Where it goes ──────────────────────────────────────────────────────────
-- On the employee lookup, whose existing null check already raises
-- 'employee not found in this workspace'. Every count below it — open
-- escalations, pending approvals, playbook assignments, charter bindings,
-- consultation grants — is keyed on the same p_de_id and runs after it.
-- ============================================================================

DO $patch$
DECLARE
  v_src text; v_new text;
  v_anchor text := 'select * into v_de from digital_employees where id = p_de_id and tenant_id = v_tenant;';
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'check_de_retirement_readiness';
  IF v_src IS NULL THEN RAISE EXCEPTION '399: check_de_retirement_readiness not found'; END IF;

  IF v_src ILIKE '%can_access_de%' THEN
    RAISE NOTICE '399: already scoped, nothing to do';
    RETURN;
  END IF;

  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '399: expected 1 employee lookup, found % — the body changed, refusing to guess', v_hits;
  END IF;

  -- Defence in depth (mig 385/399): redundant while the owner/admin gate above
  -- stands, correct the moment it does not.
  v_new := replace(v_src, v_anchor,
    'select * into v_de from digital_employees where id = p_de_id and tenant_id = v_tenant and public.can_access_de(id);');

  IF v_new = v_src THEN
    RAISE EXCEPTION '399: replacement produced an identical body — the edit did not land';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_guards int; v_raised text; v_ok boolean := false;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'check_de_retirement_readiness';

  v_guards := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  IF v_guards <> 1 THEN
    RAISE EXCEPTION '399: expected exactly 1 scope guard, found %', v_guards;
  END IF;

  -- The role gate is the one actually doing the work here. If the rewrite had
  -- traded it for the redundant guard, this migration would have WIDENED access
  -- from owner/admin to manager while looking like a security improvement.
  IF v_def NOT LIKE '%only workspace owners/admins can check retirement readiness%' THEN
    RAISE EXCEPTION '399: the owner/admin role gate was lost — this migration would have widened access, not narrowed it';
  END IF;
  IF v_def NOT LIKE '%consulted_by_other_des%'
     OR v_def NOT LIKE '%active_charter_bindings%'
     OR v_def NOT LIKE '%pending_approvals%' THEN
    RAISE EXCEPTION '399: the body lost content — a stale or truncated definition was applied';
  END IF;

  -- Runs as postgres, which is a member of no workspace, so the first gate must
  -- fire. Proves the body compiles and the gate order survived.
  BEGIN
    PERFORM public.check_de_retirement_readiness('00000000-0000-0000-0000-000000000000'::uuid);
  EXCEPTION WHEN others THEN
    v_raised := SQLERRM;
    v_ok := true;
  END;
  IF NOT v_ok OR v_raised NOT LIKE '%not a member of any tenant%' THEN
    RAISE EXCEPTION '399: expected the membership gate to fire, got: %', coalesce(v_raised, '(nothing raised)');
  END IF;

  RAISE NOTICE '399: guard added. NO BEHAVIOURAL CHANGE — owner/admin already passed can_access_de. Defence in depth, counted as such.';
END $assert$;

NOTIFY pgrst, 'reload schema';
