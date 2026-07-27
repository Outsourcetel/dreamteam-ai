-- 426_revoke_dispatch_de_work_internal.sql
-- ============================================================================
-- Phase 3 Wave 2, GROUP C — "verify before skipping". See docs/30.
--
-- ⚠ ANYONE ON THE INTERNET COULD FIRE THE WORK ENGINE. ────────────────────
-- dispatch_de_work_internal() is the pg_cron tick for the autonomy loop (job
-- 22, every 5 minutes, `select dispatch_de_work_internal()`, username postgres).
-- Its name says internal and docs/30 classified it as internal. Measured:
--
--   * it is NOT a trigger function — RETURNS text, zero triggers attached
--   * `anon` AND `authenticated` both hold EXECUTE (via the PUBLIC default)
--   * it has NO caller check of any kind
--
-- So it is callable over PostgREST by anyone, signed in or not. Signup is live,
-- and `anon` needs no account at all.
--
-- What a caller gets: it reads the playbook_dispatch_secret from Vault and
-- POSTs to the de-work edge function, running up to 3 queued work items. It
-- does NOT return the secret — that is the one mercy here — but it does let a
-- stranger drive somebody else's AI workforce on demand:
--
--   * forced execution of queued work across EVERY tenant, at will
--   * unbounded LLM spend — a denial-of-wallet, repeatable as fast as HTTP
--   * a coarse cross-tenant oracle: "idle — nothing due" versus "dispatched"
--     reveals whether any workspace anywhere has work pending
--   * it can raise an ops alert (dispatch_secret_missing) on demand
--
-- ── The fix is REVOKE, not a guard ────────────────────────────────────────
-- There is no de_id here and no tenant argument; the function is a scheduler
-- tick, not a per-employee or per-tenant operation. can_access_de would be
-- meaningless. What is wrong is that a machine entrypoint was ever reachable by
-- clients, so the correct fix is to take the grant away.
--
-- Safe, verified rather than assumed:
--   * the cron job runs as `postgres`, which OWNS the function — an owner keeps
--     EXECUTE regardless of any REVOKE, so job 22 is unaffected
--   * NO src/ call site: the browser never calls it
--   * NO edge function calls it, and the service role bypasses GRANTs anyway
--   * NO other database function calls it — checked across every plpgsql body
--
-- That is exactly the migration-365 criterion for a safe revoke ("no browser
-- call site"), and this one is stronger: nothing calls it but cron.
--
-- ⚠ REVOKE must strip PUBLIC. Postgres grants EXECUTE on new functions to
-- PUBLIC by default and both anon and authenticated are members, so
-- `REVOKE ... FROM authenticated` alone is a silent no-op — the exact mistake
-- migration 361 shipped and had to redo. And it must be ON ROUTINE, not
-- ON FUNCTION, which errors on procedures (42809).
-- ============================================================================

REVOKE ALL ON ROUTINE public.dispatch_de_work_internal()
  FROM PUBLIC, anon, authenticated;

DO $assert$
DECLARE v_job record; v_owner name;
BEGIN
  -- 1. The grant is actually gone, for every client role. This is the whole
  --    point of the migration, so it is checked per role rather than in bulk.
  IF has_function_privilege('anon', 'public.dispatch_de_work_internal()', 'EXECUTE') THEN
    RAISE EXCEPTION '426: anon still holds EXECUTE — the REVOKE did not land';
  END IF;
  IF has_function_privilege('authenticated', 'public.dispatch_de_work_internal()', 'EXECUTE') THEN
    RAISE EXCEPTION '426: authenticated still holds EXECUTE — the REVOKE did not land (did it strip PUBLIC?)';
  END IF;
  IF has_function_privilege('public', 'public.dispatch_de_work_internal()', 'EXECUTE') THEN
    RAISE EXCEPTION '426: PUBLIC still holds EXECUTE — REVOKE FROM authenticated alone is a no-op, strip PUBLIC';
  END IF;

  -- 2. ⚠ THE ONE THAT MATTERS MORE THAN THE REVOKE: the autonomy loop must
  --    still run. If this migration silently broke cron job 22, every digital
  --    employee stops picking up work and nothing would say so — the failure
  --    would look like "the DEs went quiet", which is exactly the class of
  --    invisible breakage the ops-visibility work exists to prevent.
  SELECT * INTO v_job FROM cron.job WHERE command LIKE '%dispatch_de_work_internal%';
  IF v_job IS NULL THEN
    RAISE EXCEPTION '426: the dispatch cron job is missing — refusing to claim the revoke is safe';
  END IF;
  IF NOT v_job.active THEN
    RAISE EXCEPTION '426: the dispatch cron job is INACTIVE — the work engine is not ticking';
  END IF;

  SELECT pg_get_userbyid(p.proowner) INTO v_owner
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'dispatch_de_work_internal';

  -- The cron job's role must still be able to execute it. An owner always
  -- retains EXECUTE, so this holds when they match — assert it rather than
  -- reason about it.
  IF NOT has_function_privilege(v_job.username, 'public.dispatch_de_work_internal()', 'EXECUTE') THEN
    RAISE EXCEPTION '426: cron runs as % but that role can no longer EXECUTE the function — THE WORK ENGINE IS BROKEN, roll back', v_job.username;
  END IF;

  RAISE NOTICE '426: revoked from PUBLIC/anon/authenticated. Cron job % still active as % (owner %) and can still execute it.',
    v_job.jobid, v_job.username, v_owner;
END $assert$;

NOTIFY pgrst, 'reload schema';
