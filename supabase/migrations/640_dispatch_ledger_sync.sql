-- 640 — keep the ledger fresh, or it is stale by tomorrow.
--
-- 639 gave journal entries a way in and a live sync pulled 48 balanced entries.
-- Nothing schedules it. dispatch_financial_sync_internal fires exactly one
-- action, 'sync_financials', so the ledger would have been correct once and
-- wrong from the next posting onward — which is worse than empty, because an
-- empty book announces itself and a stale one does not.
--
-- ── WHY A SECOND DISPATCH AND NOT A WIDER sync_financials ──────────────────
-- GL Entry needs an ERPNext Accounts permission that the Sales Invoice read
-- does not. Folding the ledger into sync_financials would mean one workspace
-- without that permission fails the whole call and stops receiving AR — so a
-- missing ledger permission would silently break collections. Two dispatches,
-- two health outcomes, one failure domain each.
--
-- Reuses the existing selection logic, secret and cadence: the same connectors,
-- the same 15-minute floor, the same dispatch secret, so there is one place
-- where "which financial connectors are due" is decided.

BEGIN;

CREATE OR REPLACE FUNCTION public.dispatch_ledger_sync_internal()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_secret text;
  v_anon   text := platform_anon_key();
  c        record;
  v_req    bigint;
  n_sent   int := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM connectors k
     WHERE k.category = 'erp_financials'
       AND k.status = 'connected'
       AND k.scheduled_sync_enabled
       AND tenant_is_operational(k.tenant_id))
  THEN
    RETURN 'idle — no financial connector';
  END IF;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
   WHERE name = 'playbook_dispatch_secret';
  IF v_secret IS NULL THEN
    PERFORM raise_ops_alert('dispatch_secret_missing',
      'playbook_dispatch_secret is missing from Vault — the general ledger cannot refresh, so reconciliation would work from stale books.',
      jsonb_build_object('cron', 'dispatch_ledger_sync_internal'));
    RETURN 'no dispatch secret';
  END IF;

  FOR c IN
    SELECT k.id, k.tenant_id FROM connectors k
     WHERE k.category = 'erp_financials'
       AND k.status = 'connected'
       AND k.scheduled_sync_enabled
       AND tenant_is_operational(k.tenant_id)
     ORDER BY k.last_sync_at NULLS FIRST
     LIMIT 25
  LOOP
    SELECT net.http_post(
      url := platform_fn_url('/functions/v1/connector-hub'),
      body := jsonb_build_object('action', 'sync_ledger', 'connector_id', c.id, 'tenant_id', c.tenant_id),
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'Authorization', 'Bearer ' || v_anon,
                                    'x-dispatch-secret', v_secret),
      timeout_milliseconds := 60000) INTO v_req;
    n_sent := n_sent + 1;
  END LOOP;

  RETURN format('dispatched ledger sync for %s connector(s)', n_sent);
END;
$function$;

REVOKE ALL ON FUNCTION public.dispatch_ledger_sync_internal() FROM PUBLIC, anon, authenticated;

-- Hourly, not every 15 minutes: a general ledger moves far more slowly than the
-- receivables the dunning queue reads, and 42,951 cron runs a week already go
-- mostly to empty queues.
SELECT cron.schedule('ledger-sync-hourly', '7 * * * *',
                     $$select dispatch_ledger_sync_internal()$$);

DO $probe$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'ledger-sync-hourly';
  IF v_n <> 1 THEN RAISE EXCEPTION 'S1 FAILED: the schedule was not created'; END IF;

  IF has_function_privilege('authenticated', 'public.dispatch_ledger_sync_internal()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.dispatch_ledger_sync_internal()', 'EXECUTE') THEN
    RAISE EXCEPTION 'S2 FAILED: a client role can trigger the ledger dispatcher';
  END IF;

  -- S3: it runs and reports what it did. A dispatcher that throws on its first
  -- tick is the failure this codebase has shipped before — the cron shows green
  -- because the JOB succeeded while the statement inside it never worked.
  IF dispatch_ledger_sync_internal() IS NULL THEN
    RAISE EXCEPTION 'S3 FAILED: the dispatcher returned nothing';
  END IF;

  RAISE NOTICE '640 asserts passed: ledger sync scheduled hourly, closed to client roles, and it runs.';
END
$probe$;

COMMIT;
