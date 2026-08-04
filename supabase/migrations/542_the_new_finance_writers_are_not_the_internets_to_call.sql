-- 542_the_new_finance_writers_are_not_the_internets_to_call.sql
-- ============================================================================
-- The knowledge-ACL invariant suite caught this within minutes of the finance
-- work landing, which is exactly what it exists for:
--
--   "a new SECURITY DEFINER function writes without checking the caller tenant
--    and is callable by any signed-up user"
--
-- Seven functions, all added over the last two days:
--   reconcile_invoice_payments      529
--   reconcile_blocked_goals         524
--   resolve_cleared_ops_alerts      527
--   upsert_external_ar_record       532
--   dispatch_financial_sync_internal 533
--   propose_invoice_from_agreement  538
--   record_payment_promise          537
--
-- Every one takes a tenant id as a PARAMETER and writes with the definer's
-- rights without checking that the caller belongs to that tenant. Signup is
-- open (mig 365: `authenticated` is effectively the internet), so as written,
-- any signed-in user could have reconciled payments, drafted invoices or
-- recorded promises against ANY workspace by passing its id.
--
-- ── WHY REVOKE RATHER THAN ADD A CALLER CHECK ──────────────────────────────
-- None of these are called from a browser. They are the service-role surface:
-- edge functions, the ingest, and two crons. The narrowest correct fix is to
-- stop them being callable by clients at all, rather than to bolt on a tenant
-- check that implies a client path exists and invites one.
--
-- When a screen genuinely needs to record a promise or draft an invoice, it
-- gets a thin wrapper that resolves the tenant from auth.uid() and never takes
-- one as an argument — which is the shape that cannot be abused in the first
-- place. set_tenant_llm_key (mig 541) is written that way already.
-- ============================================================================

REVOKE ALL ON FUNCTION public.reconcile_invoice_payments(uuid, jsonb, int)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_blocked_goals(uuid)                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_cleared_ops_alerts(jsonb)                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.upsert_external_ar_record(uuid,text,text,text,text,bigint,date,text,text,bigint)
                                                                                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dispatch_financial_sync_internal()                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.propose_invoice_from_agreement(uuid, date, date, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_payment_promise(uuid,bigint,date,text,text,text,int,uuid)
                                                                                FROM PUBLIC, anon, authenticated;

-- Companions from the same wave that write and should never be client-callable.
REVOKE ALL ON FUNCTION public.settle_due_payment_promises()                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reap_stale_running_work(int)                      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_dependents_of_failed_steps()                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.check_workforce_heartbeat(int)                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.clear_tenant_llm_key(uuid, text)                  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_posting_draft(uuid)                           FROM PUBLIC, anon;

notify pgrst, 'reload schema';

DO $a$
DECLARE
  v_fn text; n_open int := 0; v_open text := '';
  v_fns text[] := ARRAY[
    'reconcile_invoice_payments','reconcile_blocked_goals','resolve_cleared_ops_alerts',
    'upsert_external_ar_record','dispatch_financial_sync_internal',
    'propose_invoice_from_agreement','record_payment_promise',
    'settle_due_payment_promises','reap_stale_running_work',
    'fail_dependents_of_failed_steps','check_workforce_heartbeat'];
BEGIN
  -- Would this pass if the revokes were a no-op? No: every one of these was
  -- EXECUTE-able by `authenticated` a moment ago, which is how the invariant
  -- suite found them.
  FOREACH v_fn IN ARRAY v_fns LOOP
    IF EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = v_fn
         AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
           OR has_function_privilege('anon', p.oid, 'EXECUTE'))
    ) THEN
      n_open := n_open + 1; v_open := v_open || v_fn || ' ';
    END IF;
  END LOOP;

  IF n_open > 0 THEN
    RAISE EXCEPTION '542: % writer(s) still callable by a signed-in user: %', n_open, v_open;
  END IF;

  -- ...and the service role must still be able to run them, or every cron and
  -- edge function that depends on them silently stops.
  IF NOT has_function_privilege('service_role',
        'public.check_workforce_heartbeat(int)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '542: the revoke also cut off service_role — the crons would stop';
  END IF;

  RAISE NOTICE '542: % finance/ops writer(s) are now service-role only; service_role retains EXECUTE', array_length(v_fns, 1);
END $a$;
