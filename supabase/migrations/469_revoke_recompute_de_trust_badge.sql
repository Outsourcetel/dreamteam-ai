-- 469_revoke_recompute_de_trust_badge.sql
-- ============================================================================
-- ⚠ LIVE HOLE, ONE HOUR OLD, CAUGHT BY THE INVARIANT SUITE.
--
-- recompute_de_trust_badge(p_tenant_id, p_de_id) arrived in migration 462
-- (applied 2026-07-27 19:49:29Z, trust batch, audit stream) SECURITY DEFINER
-- and callable by **anon, authenticated and PUBLIC**, with no caller check of
-- any kind. It takes the tenant and the employee as PARAMETERS and never
-- compares either to the caller.
--
-- It writes digital_employees.trust_level — the dial governing how far a
-- digital employee may act without a human — from an unauthenticated call.
--
-- Bounded, and worth stating precisely rather than dramatically: the badge is
-- DERIVED (from de_records_gate and that employee's own trust_policies), so a
-- caller cannot choose the value. The reachable harm is forcing a recompute on
-- somebody else's employee in somebody else's workspace. That is still an
-- unauthenticated write to a governance field, and it is the same
-- tenant-id-as-a-parameter-with-no-check shape as analytics_de_workload
-- (mig 398) and assess_definition_of_done (mig 425).
--
-- ── Why REVOKE and not a guard ──────────────────────────────────────────
-- This function is not mine and its batch is in flight. A revoke removes the
-- exposure without altering a character of its logic or its callers inside the
-- database — SECURITY DEFINER functions calling it are unaffected, because
-- EXECUTE is only checked for the outermost caller. Adding a tenant guard is
-- the audit stream's call to make, in their own migration, once they decide
-- whether it should be reachable from a client at all. Told them; not deciding
-- it for them.
--
-- It is described in their batch as a "badge-derivation trigger" but is
-- attached to ZERO triggers and RETURNS void, so it is presently either wired
-- from elsewhere or not wired at all — another reason a revoke is the safe
-- intervention and a rewrite is not.
--
-- ── The gate that should have caught it ─────────────────────────────────
-- The audit stream added an explicit-REVOKE check to their apply gate after
-- mig 457, where Supabase's default privileges had granted INSERT on a new
-- table before the migration said anything. Right instinct, wrong object type:
-- the check was scoped to tables that get CREATEd, not to functions. Postgres
-- grants EXECUTE on a NEW FUNCTION to PUBLIC by default, which is exactly how
-- dispatch_de_work_internal became anon-callable (mig 426).
--
-- ⚠ REVOKE must name PUBLIC. anon and authenticated are both members of it, so
-- revoking from them alone is a silent no-op — the mistake mig 361 shipped.
-- ON ROUTINE, not ON FUNCTION (42809 on procedures).
-- ============================================================================

REVOKE ALL ON ROUTINE public.recompute_de_trust_badge(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

DO $assert$
DECLARE v_def text; v_sig text := 'public.recompute_de_trust_badge(uuid,uuid)';
BEGIN
  IF to_regprocedure(v_sig) IS NULL THEN
    RAISE EXCEPTION '469: % does not exist — refusing to claim a revoke that cannot have happened', v_sig;
  END IF;

  IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION '469: anon still holds EXECUTE';
  END IF;
  IF has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION '469: authenticated still holds EXECUTE';
  END IF;
  -- The no-op check: revoking anon while PUBLIC still holds it changes nothing.
  IF has_function_privilege('public', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION '469: PUBLIC still holds EXECUTE — the revoke did not strip PUBLIC and is a no-op';
  END IF;

  -- ⚠ The logic must be untouched. This migration removes a grant; if the body
  -- changed, something other than this file edited it.
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='recompute_de_trust_badge';
  IF v_def NOT LIKE '%de_records_gate%' OR v_def NOT LIKE '%trust_policies%' THEN
    RAISE EXCEPTION '469: the badge derivation changed — this migration should only alter grants';
  END IF;
  IF v_def NOT LIKE '%update digital_employees%' THEN
    RAISE EXCEPTION '469: the badge write was lost — this migration should only alter grants';
  END IF;

  RAISE NOTICE '469: recompute_de_trust_badge revoked from PUBLIC/anon/authenticated. Logic untouched; whether it should be client-reachable at all is the trust batch''s decision.';
END $assert$;

NOTIFY pgrst, 'reload schema';
