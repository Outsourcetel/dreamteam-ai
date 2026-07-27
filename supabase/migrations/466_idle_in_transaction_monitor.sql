-- 466_idle_in_transaction_monitor.sql
-- ============================================================================
-- Detect the failure that blocked migration 465 and that nothing would have
-- caught: a connection left `idle in transaction`.
--
-- ── What happened, 2026-07-27 ────────────────────────────────────────────
-- A PostgREST backend sat `idle in transaction` for 16 h 55 m. It held
-- AccessShareLock on de_playbook_charter, customer_accounts, opportunities and
-- playbook_definitions, so any ALTER/DROP on those tables could not acquire
-- AccessExclusiveLock — which is how it was finally noticed, as an unrelated
-- migration timing out.
--
-- The blockage was the SMALL half. It also pinned the xmin horizon at
-- backend_xmin 432665, so VACUUM could not reclaim ANY newer row version
-- anywhere in the database for seventeen hours. Continuous, invisible bloat
-- across every table.
--
-- It raised no error, appeared in no alert, and degraded nothing a user would
-- report. docs/35 §5 has the full account.
--
-- ── Why this is worth a cron job ─────────────────────────────────────────
-- The standing rule from the ops-visibility audit is that a shipped alert with
-- no reader is worthless. This is the inverse and worse: a real, compounding
-- condition with no alert at all. The detection is four lines of SQL; the cost
-- of not having it was seventeen hours of bloat and a migration that failed for
-- reasons that took a lock investigation to explain.
--
-- ops_alerts HAS a reader — src/components/OpsAlertsBanner.tsx — checked before
-- writing into it, per the same rule.
--
-- ── Alert, do NOT auto-terminate ─────────────────────────────────────────
-- Deliberate. pg_terminate_backend kills a client's transaction, and this
-- function cannot tell a stuck PostgREST connection from a deliberate long
-- session someone is mid-way through. Terminating the wrong one loses work
-- silently, which is the same class of harm as the bloat. A human took ten
-- seconds to decide once the alert existed; the automation only has to make
-- that decision REACHABLE.
--
-- If auto-termination is ever wanted it belongs at a much higher threshold
-- (an hour-plus) as an explicit founder decision, not folded in here.
--
-- ── One alert per incident ───────────────────────────────────────────────
-- Raises only when no UNRESOLVED alert of this kind exists, so a stuck
-- connection produces one banner rather than one every five minutes. Resolving
-- the alert re-arms the check — which is the right behaviour: if it recurs
-- after somebody looked, that is news.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.check_idle_in_transaction_internal()
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_threshold interval := interval '5 minutes';
  v_count int; v_worst interval; v_worst_pid int; v_app text; v_xmin_age bigint;
BEGIN
  -- 'idle in transaction (aborted)' counts too: an aborted transaction still
  -- holds its locks and still pins xmin until the client rolls back.
  SELECT count(*), max(now() - state_change)
    INTO v_count, v_worst
    FROM pg_stat_activity
   WHERE state IN ('idle in transaction', 'idle in transaction (aborted)')
     AND pid <> pg_backend_pid()
     AND now() - state_change > v_threshold;

  IF coalesce(v_count, 0) = 0 THEN RETURN 'ok — none idle in transaction'; END IF;

  SELECT pid, coalesce(application_name, '(unnamed)')
    INTO v_worst_pid, v_app
    FROM pg_stat_activity
   WHERE state IN ('idle in transaction', 'idle in transaction (aborted)')
     AND pid <> pg_backend_pid()
   ORDER BY state_change ASC LIMIT 1;

  -- The wider harm: how far behind the oldest pinned snapshot is. This is what
  -- stops VACUUM reclaiming, database-wide, and it is the number that makes the
  -- alert worth acting on rather than merely noting.
  SELECT max(age(backend_xmin)) INTO v_xmin_age FROM pg_stat_activity;

  -- One banner per incident. Resolving it re-arms the check.
  IF EXISTS (SELECT 1 FROM ops_alerts
              WHERE kind = 'idle_in_transaction' AND resolved_at IS NULL) THEN
    RETURN format('still stuck (%s), alert already open', v_worst);
  END IF;

  PERFORM raise_ops_alert(
    'idle_in_transaction',
    format('%s database connection(s) idle in transaction — oldest %s (pid %s, %s). '
           || 'This holds locks AND blocks VACUUM database-wide until it ends.',
           v_count, v_worst, v_worst_pid, v_app),
    jsonb_build_object(
      'count', v_count, 'oldest', v_worst::text, 'pid', v_worst_pid,
      'application_name', v_app, 'oldest_xmin_age', v_xmin_age,
      'threshold', v_threshold::text,
      'remedy', 'Investigate the client, then: select pg_terminate_backend(<pid>)'));

  RETURN format('alert raised — %s stuck, oldest %s', v_count, v_worst);
END $fn$;

-- Machine entrypoint. Clients have no reason to reach it, and mig 426 is the
-- precedent: dispatch_de_work_internal was callable by anon because nobody
-- revoked the PUBLIC default. Strip PUBLIC explicitly or the revoke is a no-op.
REVOKE ALL ON ROUTINE public.check_idle_in_transaction_internal() FROM PUBLIC, anon, authenticated;

DO $sched$
BEGIN
  PERFORM cron.unschedule('idle-in-transaction-check');
EXCEPTION WHEN OTHERS THEN NULL;   -- not scheduled yet
END $sched$;

SELECT cron.schedule('idle-in-transaction-check', '*/5 * * * *',
                     'select public.check_idle_in_transaction_internal()');

DO $assert$
DECLARE v_job record; v_res text; v_owner name;
BEGIN
  -- The job exists, is active, and runs as a role that can actually execute it.
  SELECT * INTO v_job FROM cron.job WHERE jobname = 'idle-in-transaction-check';
  IF v_job IS NULL THEN RAISE EXCEPTION '466: the cron job was not created'; END IF;
  IF NOT v_job.active THEN RAISE EXCEPTION '466: the cron job is inactive'; END IF;

  SELECT pg_get_userbyid(p.proowner) INTO v_owner FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='check_idle_in_transaction_internal';
  IF NOT has_function_privilege(v_job.username, 'public.check_idle_in_transaction_internal()', 'EXECUTE') THEN
    RAISE EXCEPTION '466: cron runs as % but cannot execute the check (owner %) — the monitor would never fire', v_job.username, v_owner;
  END IF;

  -- Not client-reachable (mig 426's lesson).
  IF has_function_privilege('anon', 'public.check_idle_in_transaction_internal()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.check_idle_in_transaction_internal()', 'EXECUTE') THEN
    RAISE EXCEPTION '466: the monitor is client-callable — strip PUBLIC, not just anon';
  END IF;

  -- ⚠ The rule from the ops-visibility audit: an alert nobody reads is not a
  -- feature. ops_alerts is read by src/components/OpsAlertsBanner.tsx; the
  -- table must at least be readable, or this writes into a void.
  IF NOT has_table_privilege('authenticated', 'public.ops_alerts', 'SELECT') THEN
    RAISE EXCEPTION '466: authenticated cannot read ops_alerts — the alert would have no reader';
  END IF;

  -- ⚠ BEHAVIOURAL, not shape. This migration runs in the same auth context as
  -- cron (postgres, no JWT), so calling it here is a real test of the cron path
  -- — the lesson from mig 454, where a guard that looked fine returned nothing
  -- to every cron caller for eight hours.
  SELECT public.check_idle_in_transaction_internal() INTO v_res;
  IF v_res IS NULL THEN RAISE EXCEPTION '466: the check returned NULL'; END IF;
  IF v_res NOT LIKE 'ok%' AND v_res NOT LIKE 'alert raised%' AND v_res NOT LIKE 'still stuck%' THEN
    RAISE EXCEPTION '466: unexpected result from the check: %', v_res;
  END IF;

  RAISE NOTICE '466: idle-in-transaction monitor live, every 5 min. First run said: %', v_res;
END $assert$;

NOTIFY pgrst, 'reload schema';
