-- 774_a_dead_connector_stops_being_called.sql
-- ============================================================================
-- Register B-13 (docs/61): the only real external integration has been dead
-- since 2026-08-11 with http_402 — the dev Frappe Cloud instance hit a payment
-- wall — and the platform kept calling it. consecutive_failures reached 6,787
-- and was still climbing while this was written. There is no circuit breaker.
--
-- ── Where the calls actually came from ─────────────────────────────────────
-- Measured before writing anything: connector-hub is DISPATCHED only 1-3 times
-- an hour, yet the failure count grew ~29/hour. So the storm is not the cron
-- firing often; it is each dispatched run hammering a dead endpoint many times
-- internally.
--
-- The dispatchers decide whether that run happens at all, and their predicate
-- was:
--
--     WHERE k.category = 'erp_financials'
--       AND k.status = 'connected'          <-- the stale stored marker
--       AND k.scheduled_sync_enabled ...
--
-- `connectors.status` is exactly the column docs/61 found lying: it still reads
-- 'connected' after 6,787 consecutive failures, because nothing writes it on
-- failure. The UI never trusted it — computeHealth() derives 'down' at 3+
-- failures, which is why the screen correctly says "Not working". The
-- dispatchers were the one reader that still believed the marker.
--
-- ── The breaker ────────────────────────────────────────────────────────────
-- Defined ONCE, in `connector_circuit_open`, and called by every dispatcher.
-- This codebase's recurring defect is two lists that must agree and nothing
-- checking that they do (mig 769 was the same shape three hours ago), so the
-- threshold lives in one function rather than being spelled out per caller.
--
-- It is half-open by construction: suppression depends on last_error_at being
-- RECENT, so once the cooldown lapses exactly one run is allowed through. If it
-- succeeds, recordHealth() resets consecutive_failures to 0 and normal service
-- resumes with no human involved. If it fails, last_error_at refreshes and the
-- connector is quiet for another hour. No manual reset, no flag to remember.
--
-- Deliberately NOT done here: flipping erpnext's status to 'error'. That is a
-- data edit dressed as a fix — the column would still be a marker nobody
-- maintains, and the next connector to die would repeat this exactly. The
-- reader is what changes.
--
-- Restoring the ERPNext instance itself remains a founder decision (billing on
-- Frappe Cloud); this only stops the platform shouting at a wall meanwhile.
-- ============================================================================

create or replace function public.connector_circuit_open(
  p_failures      int,
  p_last_error_at timestamptz
) returns boolean
language sql
stable
as $$
  -- Open (i.e. suppress dispatch) once a connector has failed repeatedly AND
  -- is still failing recently. 10 is generous enough that a transient blip or
  -- a brief provider wobble never trips it; an hour of quiet is short enough
  -- that a fixed connector recovers by itself within the hour.
  select coalesce(p_failures, 0) >= 10
     and p_last_error_at is not null
     and p_last_error_at > now() - interval '1 hour';
$$;

revoke all on function public.connector_circuit_open(int, timestamptz) from public, anon, authenticated;

comment on function public.connector_circuit_open(int, timestamptz) is
  'B-13: true when a connector should not be dispatched to — 10+ consecutive failures and still failing within the hour. Half-open by construction: after the cooldown one run is allowed through, and a success resets the count. Defined once so every dispatcher shares one threshold.';

CREATE OR REPLACE FUNCTION public.dispatch_financial_sync_internal()
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
  -- Nothing due? Say so and spend nothing.
  IF NOT EXISTS (
    SELECT 1 FROM connectors k
     WHERE k.category = 'erp_financials'
       AND k.status = 'connected'
       AND NOT public.connector_circuit_open(k.consecutive_failures, k.last_error_at)
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
       AND NOT public.connector_circuit_open(k.consecutive_failures, k.last_error_at)
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
END $function$

;

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
       AND NOT public.connector_circuit_open(k.consecutive_failures, k.last_error_at)
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
       AND NOT public.connector_circuit_open(k.consecutive_failures, k.last_error_at)
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
$function$

;

