-- 810_the_third_dispatcher_never_got_the_breaker.sql
-- ==========================================================================
-- Mig 774 built a circuit breaker because the ERPNext connector had been dead
-- since 2026-08-11 with http_402 and the platform kept calling it. It gated
-- dispatch_financial_sync_internal and dispatch_ledger_sync_internal.
--
-- There are THREE dispatchers.
--
--   financial-sync-15min    -> dispatch_financial_sync_internal   gated
--   ledger-sync-hourly      -> dispatch_ledger_sync_internal      gated
--   erp-reconcile-nightly   -> dispatch_erp_reconcile_internal    NOT GATED
--
-- The third still selects on status = connected alone, the stale stored marker
-- 774 itself identified as lying, and which still reads "connected" today
-- after 8,750 consecutive failures.
--
-- MEASURED, not inferred: 774 was written at 6,787 consecutive failures and
-- applied 2026-08-18. Today the counter reads 8,750 and last_error_at is
-- today. The breaker itself works — connector_circuit_open(8750, now())
-- returns true, and returns false at 2 failures and on a stale error — so it
-- was never the breaker that failed. One caller simply never asked it.
--
-- 774 WARNED ABOUT PRECISELY THIS IN ITS OWN HEADER: this codebase's recurring
-- defect is two lists that must agree and nothing checking that they do. It
-- then shipped a breaker and two of three call sites.
--
-- So this does not merely add the missing line. It asserts the INVARIANT, so a
-- fourth dispatcher cannot be added ungated: any function that selects
-- connectors by the stored marker AND calls net.http_post must consult the
-- breaker. Naming the three functions would reproduce the very defect being
-- fixed.
--
-- ── WHAT THIS DELIBERATELY DOES NOT FIX ───────────────────────────────────
-- Five other functions trust the same marker without the breaker:
-- dunning_connector_for, de_trust_surface_candidates, get_agentic_tools_for_de,
-- compute_de_lifecycle_readiness and onboarding_verb_verdict. None of them
-- CALLS the connector, so none is part of the failure storm — they make
-- ELIGIBILITY decisions while believing a dead integration is healthy, which
-- is a real but separate defect. Named here rather than quietly widened in.
-- ==========================================================================

begin;

CREATE OR REPLACE FUNCTION public.dispatch_erp_reconcile_internal()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_secret text;
  v_anon   text := platform_anon_key();
  v_c      record;
  v_n      int := 0;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'playbook_dispatch_secret';
  if v_secret is null then return 'no dispatch secret'; end if;

  for v_c in
    select id, tenant_id from connectors
    where category = 'erp_financials' and status = 'connected' and provider <> 'template'
      -- THE LINE MIG 774 GAVE THE OTHER TWO DISPATCHERS AND NOT THIS ONE.
      and not public.connector_circuit_open(consecutive_failures, last_error_at)
      and tenant_is_operational(tenant_id)
  loop
    begin
      perform net.http_post(
        url     := platform_fn_url('/functions/v1/connector-hub'),
        body    := jsonb_build_object('action', 'reconcile_financials', 'connector_id', v_c.id, 'tenant_id', v_c.tenant_id),
        headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_anon,
                                      'apikey', v_anon, 'x-dispatch-secret', v_secret),
        timeout_milliseconds := 60000);
      v_n := v_n + 1;
    exception when others then
      raise warning 'erp reconcile dispatch failed for connector %: %', v_c.id, sqlerrm;
    end;
  end loop;
  return 'erp-reconcile dispatched ' || v_n || ' connector(s)';
end;
$function$
;

-- ── proof ─────────────────────────────────────────────────────────────────
do $verify$
declare
  v_ungated text[];
  v_gated   int;
begin
  -- (a) THE INVARIANT, not a list of names. Anything that picks connectors by
  --     the stored marker and then CALLS one must ask the breaker first. A
  --     fourth dispatcher added tomorrow trips this without anyone editing it.
  select coalesce(array_agg(p.proname order by p.proname), '{}')
    into v_ungated
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g') ~ 'status\s*=\s*''connected'''
     and regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g') ~ 'net\.http_post'
     and regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g') !~ 'connector_circuit_open';
  if array_length(v_ungated, 1) > 0 then
    raise exception 'VERIFY FAILED: % dispatcher(s) call a connector chosen by the stale marker without consulting the breaker: %',
      array_length(v_ungated, 1), array_to_string(v_ungated, ', ');
  end if;

  -- (b) ...and the denominator is not zero. An invariant that holds because it
  --     matched nothing is not an invariant, it is a spelling mistake.
  select count(*) into v_gated
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g') ~ 'net\.http_post'
     and regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g') ~ 'connector_circuit_open';
  if v_gated < 3 then
    raise exception 'VERIFY FAILED: only % gated dispatcher(s) found, expected at least 3', v_gated;
  end if;

  -- (c) the breaker must still DISCRIMINATE. Gating three dispatchers on a
  --     predicate that always returns true would stop every sync in the
  --     product and look exactly like a fix.
  if not public.connector_circuit_open(8750, now()) then
    raise exception 'VERIFY FAILED: breaker does not open on 8750 failures with a fresh error';
  end if;
  if public.connector_circuit_open(0, null) then
    raise exception 'VERIFY FAILED: breaker opens on a HEALTHY connector — this would stop every sync';
  end if;
end
$verify$;

commit;
