-- ============================================================
-- Migration 517: AR ingest foundation.
--
-- Lets an external ERP's invoices/customers land in the tables the existing
-- dunning / at-risk / staleness machinery already reads (renewal_invoices,
-- customer_accounts), so a real overdue ERP invoice can drive the SAME
-- playbooks that run today. Additive columns + one upsert RPC — nothing is
-- recreated, so no fresh-dump risk.
--
-- PROVIDER-GENERIC on purpose (docs/32 §0 invariant / R6): no 'erpnext'
-- anywhere in the schema. `source_provider` namespaces the idempotency key so
-- two ERPs (or an ERP + a CRM) never collide, and the existing
-- customer_accounts.external_ref semantics are left untouched. Reserved #517
-- against ledger max 516.
-- ============================================================
alter table public.renewal_invoices
  add column if not exists source_provider text,
  add column if not exists source_external_ref text,
  add column if not exists source_currency text;

alter table public.customer_accounts
  add column if not exists source_provider text,
  add column if not exists source_external_ref text;

-- Partial unique = the idempotency guarantee. Existing rows have NULL
-- source_external_ref and are excluded, so this is safe on populated tables.
create unique index if not exists renewal_invoices_source_key
  on public.renewal_invoices (tenant_id, source_provider, source_external_ref)
  where source_external_ref is not null;

create unique index if not exists customer_accounts_source_key
  on public.customer_accounts (tenant_id, source_provider, source_external_ref)
  where source_external_ref is not null;

-- ── The upsert. The caller passes a status already in OUR vocabulary; an
-- unknown value is coerced to 'sent' (issued & owing) rather than rejected, so
-- a new/unmapped ERP status can never silently drop an invoice. Upserts the
-- account first (dedup by its own source ref), then the invoice against it.
create or replace function public.upsert_external_ar_record(
  p_tenant_id uuid,
  p_provider text,
  p_customer_external_ref text,
  p_customer_name text,
  p_invoice_external_ref text,
  p_amount_cents bigint,
  p_due_date date,
  p_status text,
  p_currency text
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_account_id uuid;
  v_invoice_id uuid;
  v_status text;
begin
  if p_tenant_id is null or coalesce(p_provider,'') = ''
     or coalesce(p_invoice_external_ref,'') = '' or coalesce(p_customer_external_ref,'') = '' then
    raise exception 'tenant, provider, customer ref and invoice ref are all required';
  end if;

  v_status := case when p_status in ('pending_generation','awaiting_approval','sent','paid','overdue')
                   then p_status else 'sent' end;

  insert into customer_accounts (tenant_id, name, external_ref, source_provider, source_external_ref)
  values (p_tenant_id,
          coalesce(nullif(p_customer_name,''), p_customer_external_ref),
          p_customer_external_ref, p_provider, p_customer_external_ref)
  on conflict (tenant_id, source_provider, source_external_ref) where source_external_ref is not null
  do update set name = excluded.name, external_ref = excluded.external_ref, updated_at = now()
  returning id into v_account_id;

  insert into renewal_invoices (tenant_id, account_id, amount_cents, status, due_date, cadence_stage,
                                source_provider, source_external_ref, source_currency)
  values (p_tenant_id, v_account_id, coalesce(p_amount_cents, 0), v_status, p_due_date, 0,
          p_provider, p_invoice_external_ref, p_currency)
  on conflict (tenant_id, source_provider, source_external_ref) where source_external_ref is not null
  do update set account_id = excluded.account_id, amount_cents = excluded.amount_cents,
                status = excluded.status, due_date = excluded.due_date,
                source_currency = excluded.source_currency, updated_at = now()
  returning id into v_invoice_id;

  return jsonb_build_object('account_id', v_account_id, 'invoice_id', v_invoice_id);
end;
$function$;

revoke all on function public.upsert_external_ar_record(uuid, text, text, text, text, bigint, date, text, text)
  from public, anon, authenticated;

-- Structural assertions (behavioural idempotency is proven live by syncing
-- twice — an in-migration insert would need a fake tenant that trips the FK).
do $assert$
begin
  if not exists (select 1 from information_schema.columns where table_name='renewal_invoices' and column_name='source_external_ref')
     or not exists (select 1 from information_schema.columns where table_name='customer_accounts' and column_name='source_external_ref') then
    raise exception 'mig 517: source_external_ref column missing';
  end if;
  if not exists (select 1 from pg_indexes where indexname='renewal_invoices_source_key')
     or not exists (select 1 from pg_indexes where indexname='customer_accounts_source_key') then
    raise exception 'mig 517: source_key unique index missing';
  end if;
  if not exists (select 1 from pg_proc where proname='upsert_external_ar_record') then
    raise exception 'mig 517: upsert_external_ar_record missing';
  end if;
end
$assert$;
