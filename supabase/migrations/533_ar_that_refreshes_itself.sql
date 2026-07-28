-- 533_ar_that_refreshes_itself.sql
-- ============================================================================
-- STEP 1 OF THE COLLECTIONS SEQUENCE: keep the receivables current.
--
-- sync_financials — the thing that pulls real invoices out of the ERP and into
-- the AR tables the whole collections chain reads — has NO cron and NO trigger
-- anywhere in src/. It has been run by hand, once. Every number the Billing
-- employee has ever quoted came from that single snapshot.
--
-- A collections agent working from a stale snapshot chases invoices that were
-- paid last week. That is worse than not chasing: it costs the relationship AND
-- the time. Freshness is not a nicety here, it is the precondition for anything
-- downstream being safe to send.
--
-- ── REUSING THE SCHEDULER THAT ALREADY EXISTS ──────────────────────────────
-- connectors already carries scheduled_sync_enabled / sync_interval_mins /
-- last_scheduled_sync_at, with set_connector_schedule as the setter and a
-- toggle on the Knowledge page. But the only reader is
-- dispatch_knowledge_sync_internal — knowledge sources only. So the columns,
-- the setter and the UI control are all in place and financial connectors were
-- simply never driven. Same fields, same setter, different action.
--
-- ── GENERIC BY CATEGORY, NOT BY PROVIDER ───────────────────────────────────
-- Selection is `category = 'erp_financials'`, never `provider = 'erpnext'`.
-- A second ERP added tomorrow is picked up with no change here; a provider
-- without a financial adapter answers 'sync_not_supported' harmlessly, so the
-- dispatcher does not need to know which providers can sync.
--
-- The interval gate does the pacing, so the cron itself can run often and cheap:
-- a connector is only called when its own sync_interval_mins has elapsed.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.dispatch_financial_sync_internal()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
  v_secret text;
  v_anon   text := platform_anon_key();
  c        record;
  v_req    bigint;
  n_sent   int := 0;
BEGIN
  -- Nothing due? Say so and spend nothing.
  IF NOT EXISTS (
    SELECT 1 FROM connectors k
     WHERE k.category = 'erp_financials'
       AND k.status = 'connected'
       AND k.scheduled_sync_enabled
       AND tenant_is_operational(k.tenant_id)
       AND (k.last_scheduled_sync_at IS NULL
            OR k.last_scheduled_sync_at < now() - make_interval(mins => greatest(15, coalesce(k.sync_interval_mins, 1440)))))
  THEN
    RETURN 'idle — no financial connector due';
  END IF;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
   WHERE name = 'playbook_dispatch_secret';
  IF v_secret IS NULL THEN
    PERFORM raise_ops_alert('dispatch_secret_missing',
      'playbook_dispatch_secret is missing from Vault — receivables cannot refresh, so collections would work from stale invoices.',
      jsonb_build_object('cron', 'dispatch_financial_sync_internal'));
    RETURN 'no dispatch secret';
  END IF;

  FOR c IN
    SELECT k.id, k.tenant_id, k.provider FROM connectors k
     WHERE k.category = 'erp_financials'
       AND k.status = 'connected'
       AND k.scheduled_sync_enabled
       AND tenant_is_operational(k.tenant_id)
       AND (k.last_scheduled_sync_at IS NULL
            OR k.last_scheduled_sync_at < now() - make_interval(mins => greatest(15, coalesce(k.sync_interval_mins, 1440))))
     ORDER BY k.last_scheduled_sync_at NULLS FIRST
     LIMIT 25
  LOOP
    SELECT net.http_post(
      url := platform_fn_url('/functions/v1/connector-hub'),
      body := jsonb_build_object('action','sync_financials','connector_id',c.id,'tenant_id',c.tenant_id),
      headers := jsonb_build_object('Content-Type','application/json',
                                    'Authorization','Bearer '||v_anon,
                                    'x-dispatch-secret', v_secret),
      timeout_milliseconds := 60000) INTO v_req;

    -- Stamp on DISPATCH, not on success. If the call fails the connector's own
    -- health fields and the drift sentinel report it; stamping here only stops
    -- the same connector being hammered every tick while one call is in flight.
    UPDATE connectors SET last_scheduled_sync_at = now() WHERE id = c.id;
    n_sent := n_sent + 1;
  END LOOP;

  RETURN format('financial sync dispatched for %s connector(s)', n_sent);
END $fn$;

COMMENT ON FUNCTION public.dispatch_financial_sync_internal() IS
  'Refreshes receivables from every connected erp_financials connector whose own sync interval has elapsed. Selected by CATEGORY so a new ERP needs no change here. Without this the collections chain works from whenever someone last ran a sync by hand.';

REVOKE ALL ON FUNCTION public.dispatch_financial_sync_internal() FROM PUBLIC;

SELECT cron.schedule('financial-sync-15min', '*/15 * * * *',
                     $c$select dispatch_financial_sync_internal()$c$);

-- Turn it on for financial connectors that are already connected, at an AR-
-- appropriate cadence. 1440 (the knowledge-source default) is far too slow for
-- receivables: a day-old balance is a day of chasing money already received.
-- Hourly is a judgment and is per-connector editable via set_connector_schedule.
UPDATE public.connectors
   SET scheduled_sync_enabled = true,
       sync_interval_mins = CASE WHEN coalesce(sync_interval_mins, 1440) > 60 THEN 60
                                 ELSE sync_interval_mins END
 WHERE category = 'erp_financials' AND status = 'connected';

notify pgrst, 'reload schema';

DO $a$
DECLARE n_on int; n_due int; v_res text; v_before timestamptz; v_after timestamptz;
BEGIN
  SELECT count(*) INTO n_on FROM connectors
   WHERE category = 'erp_financials' AND status = 'connected' AND scheduled_sync_enabled;
  IF n_on = 0 THEN
    RAISE EXCEPTION '533: no connected financial connector is scheduled — receivables would still never refresh';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'financial-sync-15min' AND active) THEN
    RAISE EXCEPTION '533: the refresh cron is not armed';
  END IF;

  SELECT min(last_scheduled_sync_at) INTO v_before FROM connectors WHERE category = 'erp_financials';

  -- Run it for real. Would this pass if the selection were wrong? No — it must
  -- both report a dispatch AND move the stamp on the connector it chose.
  v_res := dispatch_financial_sync_internal();
  IF v_res NOT LIKE 'financial sync dispatched%' THEN
    RAISE EXCEPTION '533: the dispatcher found nothing to do on its first run: %', v_res;
  END IF;

  SELECT min(last_scheduled_sync_at) INTO v_after FROM connectors
   WHERE category = 'erp_financials' AND scheduled_sync_enabled;
  IF v_after IS NULL OR (v_before IS NOT NULL AND v_after <= v_before) THEN
    RAISE EXCEPTION '533: dispatched but the connector was not stamped — it would be re-hit every tick';
  END IF;

  -- ...and immediately after a dispatch, nothing is due again. This is the
  -- property that stops a 15-minute cron hammering the customer's ERP.
  -- The predicate here must match the dispatcher's EXACTLY. A first version
  -- omitted tenant_is_operational, so a connector in a dormant tenant — which
  -- is correctly never dispatched — read as permanently due and failed this
  -- assert. A check that does not mirror the thing it checks reports a fault
  -- that does not exist, which is how a real one later gets ignored.
  SELECT count(*) INTO n_due FROM connectors k
   WHERE k.category = 'erp_financials' AND k.status = 'connected' AND k.scheduled_sync_enabled
     AND tenant_is_operational(k.tenant_id)
     AND (k.last_scheduled_sync_at IS NULL
          OR k.last_scheduled_sync_at < now() - make_interval(mins => greatest(15, coalesce(k.sync_interval_mins,1440))));
  IF n_due > 0 THEN
    RAISE EXCEPTION '533: % connector(s) still due immediately after syncing — the interval gate does not hold', n_due;
  END IF;

  RAISE NOTICE '533: % financial connector(s) now refresh on their own interval; first sync dispatched', n_on;
END $a$;
