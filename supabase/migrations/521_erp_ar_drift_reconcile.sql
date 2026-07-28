-- ============================================================
-- Migration 521: ERP AR drift reconciliation (B3).
--
-- The mirror (renewal_invoices) is a governed COPY of the ERP's AR; this is the
-- sentinel that proves it still matches. Nightly, per connected erp_financials
-- connector, we compare the ERP's live submitted-invoice count + total against
-- the mirror and raise an ops_alert on any mismatch. Detect, never silently
-- correct (docs/32 R8) — a human sees the drift and decides.
--
-- Two helpers here; the comparison itself lives in the connector-hub
-- reconcile_financials action (it needs to call the ERP). Reuses
-- tenant_is_operational (mig 430) so suspended tenants are skipped. Reserved
-- #521 against the live ledger.
-- ============================================================

-- Mirror side: count + summed cents of the synced invoices for one provider.
create or replace function public.erp_ar_mirror_totals(p_tenant_id uuid, p_provider text)
returns table(cnt bigint, cents bigint)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select count(*)::bigint, coalesce(sum(amount_cents), 0)::bigint
  from renewal_invoices
  where tenant_id = p_tenant_id and source_provider = p_provider;
$function$;
revoke all on function public.erp_ar_mirror_totals(uuid, text) from public, anon, authenticated;

-- Nightly dispatcher: reconcile every connected, non-template erp_financials
-- connector for an operational tenant.
create or replace function public.dispatch_erp_reconcile_internal()
returns text
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
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
$function$;
revoke all on function public.dispatch_erp_reconcile_internal() from public, anon, authenticated;

select cron.schedule('erp-reconcile-nightly', '40 5 * * *', 'select dispatch_erp_reconcile_internal()');

do $assert$
begin
  if not exists (select 1 from pg_proc where proname = 'erp_ar_mirror_totals') then
    raise exception 'mig 521: erp_ar_mirror_totals missing';
  end if;
  if not exists (select 1 from pg_proc where proname = 'dispatch_erp_reconcile_internal') then
    raise exception 'mig 521: dispatch_erp_reconcile_internal missing';
  end if;
  if not exists (select 1 from cron.job where jobname = 'erp-reconcile-nightly') then
    raise exception 'mig 521: erp-reconcile-nightly cron not scheduled';
  end if;
end
$assert$;
