-- 803_the_other_half_of_the_money_chain.sql
-- ==========================================================================
-- WHY: M3 of the practical-work program (spec 2026-08-11). The platform's
-- money chain ran one direction only — invoices out, chases, payments in
-- (renewal_invoices + reconcile_invoice_payments). "Payables" was a word on
-- the founder's list with NO pipe: no mirror of what WE owe, no book a DE
-- could read, no verb that settles a supplier invoice. Four pieces land:
--
--   1. purchase_invoices — the AP mirror table. Same discipline as the AR
--      mirror: provider's own arithmetic (outstanding_cents), a later sync
--      that omits the balance must not erase one we know, unique per
--      (tenant, provider, external ref) so the sync is idempotent.
--   2. upsert_external_ap_record — the ingest RPC connector-hub's payables
--      leg calls once per record. service_role only (the default-EXECUTE
--      lesson, mig 610/630).
--   3. pay_purchase_invoice — the action definition for the hub verb
--      erpnext_pay_purchase_invoice. amount_cents REQUIRED — it is the ONE
--      param name the money gates read, and an outbound payment whose amount
--      the gates cannot read must fail closed. Destructive, finance arm.
--   4. get_de_worklists gains the 'payable_invoices' book + the
--      'purchase_invoices' source-library arm, and the accounting archetype's
--      templates name the new book — an arm nobody's templates reference is
--      dead code, and a template without a library arm is the exact shape
--      that said "all accounts current" over $431k. Function GENERATED from
--      live and edited surgically (the mig-377 rule).
-- ==========================================================================

begin;

-- ── 1. The AP mirror ──────────────────────────────────────────────────────
create table if not exists public.purchase_invoices (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  supplier_external_ref text not null,
  supplier_name       text not null,
  source_provider     text not null,
  source_external_ref text not null,
  amount_cents        bigint not null default 0,
  -- NULL means the source never stated a balance — the worklist says
  -- UNVERIFIED, never "face value = confirmed balance".
  outstanding_cents   bigint,
  due_date            date,
  status              text not null default '',
  currency            text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, source_provider, source_external_ref)
);

create index if not exists purchase_invoices_tenant_due_idx
  on public.purchase_invoices (tenant_id, due_date);

alter table public.purchase_invoices enable row level security;

drop policy if exists purchase_invoices_tenant_read on public.purchase_invoices;
create policy purchase_invoices_tenant_read on public.purchase_invoices
  for select using (tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid()));

-- Read-only from the client side: the ONLY writer is the ingest RPC below
-- (service_role). No write policy exists on purpose.
revoke all on table public.purchase_invoices from public, anon, authenticated;
grant select on table public.purchase_invoices to authenticated;

-- ── 2. The ingest RPC (param names are exactly what connector-hub sends) ──
create or replace function public.upsert_external_ap_record(
  p_tenant_id uuid,
  p_provider text,
  p_supplier_external_ref text,
  p_supplier_name text,
  p_invoice_external_ref text,
  p_amount_cents bigint,
  p_outstanding_cents bigint default null,
  p_due_date date default null,
  p_status text default '',
  p_currency text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_id uuid;
begin
  if p_tenant_id is null or coalesce(p_provider, '') = ''
     or coalesce(p_invoice_external_ref, '') = '' or coalesce(p_supplier_external_ref, '') = '' then
    raise exception 'tenant, provider, supplier ref and invoice ref are all required';
  end if;

  insert into purchase_invoices (tenant_id, supplier_external_ref, supplier_name,
                                 source_provider, source_external_ref,
                                 amount_cents, outstanding_cents, due_date, status, currency)
  values (p_tenant_id, p_supplier_external_ref,
          coalesce(nullif(p_supplier_name, ''), p_supplier_external_ref),
          p_provider, p_invoice_external_ref,
          coalesce(p_amount_cents, 0), p_outstanding_cents, p_due_date,
          coalesce(p_status, ''), p_currency)
  on conflict (tenant_id, source_provider, source_external_ref)
  do update set supplier_external_ref = excluded.supplier_external_ref,
                supplier_name = excluded.supplier_name,
                amount_cents = excluded.amount_cents,
                -- Same rule as the AR mirror: a sync that omits the balance
                -- must not ERASE a balance we already knew; a sync that
                -- states one always wins, because the ledger is the
                -- authority on what is owed.
                outstanding_cents = coalesce(excluded.outstanding_cents, purchase_invoices.outstanding_cents),
                due_date = excluded.due_date,
                status = excluded.status,
                currency = excluded.currency,
                updated_at = now()
  returning id into v_id;

  return jsonb_build_object('invoice_id', v_id, 'outstanding_known', p_outstanding_cents is not null);
end;
$fn$;

revoke execute on function public.upsert_external_ap_record(uuid, text, text, text, text, bigint, bigint, date, text, text) from public, anon, authenticated;
grant execute on function public.upsert_external_ap_record(uuid, text, text, text, text, bigint, bigint, date, text, text) to service_role;

-- ── 3. The outbound-money definition ──────────────────────────────────────
insert into action_definitions (scope, tenant_id, category, action_key, label, description, provider, param_schema, risk, execution, status, reversible, rollback, requires_role)
select 'platform', null, 'erp_financials', 'pay_purchase_invoice', 'Pay a supplier invoice',
       'Book an outbound payment against a supplier''s Purchase Invoice and SUBMIT it to the ledger. Built by the ERP''s own invoice-to-payment mapper. The amount is REQUIRED and read by every money gate.',
       'erpnext',
       '[{"name":"external_ref","type":"string","required":true,"help":"The Purchase Invoice number"},
         {"name":"amount_cents","type":"number","required":true,"help":"Amount to pay, in CENTS (whole number) - the approval gates read this"}]'::jsonb,
       '{"idempotent":false,"destructive":true}'::jsonb,
       '{"execution_key":"erpnext_pay_purchase_invoice"}'::jsonb,
       'active', true,
       '{"how":"Cancel the submitted Payment Entry in ERPNext (docstatus 2) - the outbound booking is reversed in the ledger."}'::jsonb,
       'finance'
where not exists (select 1 from action_definitions where scope='platform' and provider='erpnext' and action_key='pay_purchase_invoice');

-- ── 4. The book: worklist arm + source-library arm + a template that reads it ──
CREATE OR REPLACE FUNCTION public.get_de_worklists(p_tenant_id uuid, p_de_id uuid)
 RETURNS TABLE(worklist_key text, label text, row_count bigint, sample jsonb, book_is_empty boolean, source_table text, source_has_any_rows boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_arch text;
  v_src_any boolean;
  v_templates jsonb;
  t jsonb;
begin
  if auth.role() is not null and auth.role() <> 'service_role' then
    if auth.uid() is null then raise exception 'not authenticated'; end if;
    if not (is_platform_admin()
            or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = p_tenant_id)) then
      raise exception 'not authorized to view this workspace';
    end if;
  end if;
  if not (auth.role() is null or auth.role() = 'service_role' or public.can_access_de(p_de_id)) then
    raise exception 'not authorized to view this employee';
  end if;

  select d.archetype_key into v_arch from digital_employees d
   where d.id = p_de_id and d.tenant_id = p_tenant_id;
  if v_arch is null then return; end if;

  select a.worklist_templates into v_templates from role_archetypes a where a.key = v_arch;
  if v_templates is null or v_templates = '[]'::jsonb then return; end if;

  for t in select * from jsonb_array_elements(v_templates) loop
    worklist_key := t->>'key';
    label        := t->>'label';
    row_count    := 0;
    sample       := '[]'::jsonb;
    source_table := null;
    source_has_any_rows := null;

    -- CLOSED LIBRARY. Every predicate is written here; nothing comes from data.
    case worklist_key

      when 'overdue_invoices' then
        source_table := 'renewal_invoices + invoices';
        select count(*), coalesce(jsonb_agg(x order by x->>'due_date') filter (where x is not null), '[]'::jsonb)
          into row_count, sample
          from (
            select jsonb_build_object('invoice', i.invoice_number, 'due', i.due_date,
                                      'amount', i.amount, 'status', i.status, 'source', 'invoices') as x,
                   i.due_date as ord
              from invoices i
             where i.tenant_id = p_tenant_id
               and i.due_date < current_date
               and coalesce(i.status, '') not in ('paid', 'void', 'cancelled')
            union all
            -- The ERP ingest (mig 517) lands real invoices in renewal_invoices,
            -- which this book did not read: 8 invoices worth $478k, two of them
            -- overdue, were invisible while the sweep reported "all accounts
            -- current". Same book, both sources.
            select jsonb_build_object('invoice', coalesce(r.source_external_ref, r.id::text), 'due', r.due_date,
                                      'amount', (r.amount_cents / 100.0), 'status', r.status,
                                      'still_owed', case when r.outstanding_cents is not null
                                                         then (r.outstanding_cents / 100.0)::text
                                                         else 'UNVERIFIED - no payment has ever been reconciled against this invoice; the amount shown is the face value, not a confirmed balance' end,
                                      'source', coalesce(r.source_provider, 'renewal_invoices')) as x,
                   r.due_date as ord
              from renewal_invoices r
             where r.tenant_id = p_tenant_id
               and r.due_date < current_date
               and coalesce(r.status, '') not in ('paid', 'void', 'cancelled')
             order by ord limit 25
          ) s;

      when 'unpaid_invoices' then
        source_table := 'renewal_invoices + invoices';
        select count(*), coalesce(jsonb_agg(x) filter (where x is not null), '[]'::jsonb)
          into row_count, sample
          from (
            select jsonb_build_object('invoice', i.invoice_number, 'due', i.due_date,
                                      'amount', i.amount, 'paid', i.amount_paid, 'status', i.status,
                                      'source', 'invoices') as x,
                   i.due_date as ord
              from invoices i
             where i.tenant_id = p_tenant_id
               and coalesce(i.status, '') not in ('paid', 'void', 'cancelled')
            union all
            select jsonb_build_object('invoice', coalesce(r.source_external_ref, r.id::text), 'due', r.due_date,
                                      'amount', (r.amount_cents / 100.0), 'status', r.status,
                                      'still_owed', case when r.outstanding_cents is not null
                                                         then (r.outstanding_cents / 100.0)::text
                                                         else 'UNVERIFIED - no payment has ever been reconciled against this invoice; the amount shown is the face value, not a confirmed balance' end,
                                      'source', coalesce(r.source_provider, 'renewal_invoices')) as x,
                   r.due_date as ord
              from renewal_invoices r
             where r.tenant_id = p_tenant_id
               and coalesce(r.status, '') not in ('paid', 'void', 'cancelled')
             order by ord nulls last limit 25
          ) s;

      when 'unreconciled_entries' then
        source_table := 'journal_entries';
        select count(*), coalesce(jsonb_agg(x) filter (where x is not null), '[]'::jsonb)
          into row_count, sample
          from (
            select jsonb_build_object('date', j.entry_date, 'memo', left(coalesce(j.memo, ''), 120),
                                      'debit', j.debit, 'credit', j.credit, 'source', j.source) as x
              from journal_entries j
             where j.tenant_id = p_tenant_id
               and j.entry_date >= date_trunc('month', current_date)
             order by j.entry_date desc limit 25
          ) s;

      when 'stalled_onboarding' then
        source_table := 'onboarding_projects';
        select count(*), coalesce(jsonb_agg(x) filter (where x is not null), '[]'::jsonb)
          into row_count, sample
          from (
            select jsonb_build_object('project', o.name, 'status', o.status,
                                      'progress_pct', o.progress_pct, 'target_golive', o.target_golive,
                                      'days_since_update', (current_date - o.updated_at::date)) as x
              from onboarding_projects o
             where o.tenant_id = p_tenant_id
               and o.completed_at is null
             order by o.updated_at limit 25
          ) s;

      when 'at_risk_accounts' then
        source_table := 'customer_accounts';
        select count(*), coalesce(jsonb_agg(x) filter (where x is not null), '[]'::jsonb)
          into row_count, sample
          from (
            select jsonb_build_object('account', c.name, 'health', c.health_score,
                                      'status', c.status, 'renews', c.renewal_date) as x
              from customer_accounts c
             where c.tenant_id = p_tenant_id
               and (coalesce(c.status, '') = 'at_risk' or coalesce(c.health_score, 100) < 50)
             order by c.health_score nulls last limit 25
          ) s;

      when 'payable_invoices' then
        -- Mig 803: the AP book. Same sample-of-25 semantics as the AR books,
        -- same UNVERIFIED honesty when the source never stated a balance.
        source_table := 'purchase_invoices';
        select count(*), coalesce(jsonb_agg(x) filter (where x is not null), '[]'::jsonb)
          into row_count, sample
          from (
            select jsonb_build_object('invoice', pi.source_external_ref, 'supplier', pi.supplier_name,
                                      'due', pi.due_date, 'amount', (pi.amount_cents / 100.0),
                                      'still_owed', case when pi.outstanding_cents is not null
                                                         then (pi.outstanding_cents / 100.0)::text
                                                         else 'UNVERIFIED - the source did not state a balance; the amount shown is the face value' end,
                                      'status', pi.status, 'source', pi.source_provider) as x,
                   pi.due_date as ord
              from purchase_invoices pi
             where pi.tenant_id = p_tenant_id
               and coalesce(pi.outstanding_cents, pi.amount_cents) > 0
               and lower(coalesce(pi.status, '')) not in ('paid', 'cancelled', 'return')
             order by ord nulls last limit 25
          ) s;

      when 'accounts_book' then
        source_table := 'customer_accounts';
        select count(*), coalesce(jsonb_agg(x) filter (where x is not null), '[]'::jsonb)
          into row_count, sample
          from (
            select jsonb_build_object('account', c.name, 'health', c.health_score,
                                      'status', c.status, 'renews', c.renewal_date) as x
              from customer_accounts c
             where c.tenant_id = p_tenant_id
               and coalesce(c.status, '') <> 'churned'
             order by c.name limit 25
          ) s;

      else
        -- A template naming a book the library does not implement. Say so
        -- rather than returning an empty list that reads as "nothing to do".
        label := coalesce(label, worklist_key) || ' (not available)';
        source_table := null;
    end case;

    -- THE DISTINCTION THIS WHOLE DESK RESTS ON.
    -- "0 invoices past due" finishes an AR sweep honestly. "I am pointed at a
    -- source that holds nothing for this tenant" does NOT — but until now both
    -- returned book_is_empty = true, and the SOP's "if the book is empty you are
    -- finished" rule turned the second into a confident all-clear. That is how a
    -- polished Daily AR Sweep Summary came to say "All accounts current, total
    -- invoices reviewed: 0" over $431k of live receivables.
    --
    -- NULL is the third answer, exactly as mig 491 made a rate with no
    -- denominator NULL rather than 0: not empty, not populated — unknown.
    if coalesce(row_count, 0) > 0 then
      book_is_empty := false;
    else
      v_src_any := case source_table
        -- Closed library, same as the predicates above: nothing here comes from data.
        -- FIX 1: migration 603 renamed this assignment to 'renewal_invoices + invoices'
        -- (both tables are unioned in the predicate now) but never added the matching
        -- arm, so every invoice book fell to `else null` the moment it had no rows.
        -- Latent while the books had work; it would have turned "no overdue invoices"
        -- into "this book cannot be read" the first quiet day. The old literal stays
        -- for any caller or template still naming it.
        when 'renewal_invoices + invoices'
                                   then (exists (select 1 from invoices            where tenant_id = p_tenant_id)
                                      or exists (select 1 from renewal_invoices    where tenant_id = p_tenant_id))
        when 'invoices'            then (exists (select 1 from invoices            where tenant_id = p_tenant_id)
                                      or exists (select 1 from renewal_invoices    where tenant_id = p_tenant_id))
        when 'journal_entries'     then  exists (select 1 from journal_entries     where tenant_id = p_tenant_id)
        when 'onboarding_projects' then  exists (select 1 from onboarding_projects where tenant_id = p_tenant_id)
        when 'customer_accounts'   then  exists (select 1 from customer_accounts   where tenant_id = p_tenant_id)
        when 'purchase_invoices'   then  exists (select 1 from purchase_invoices   where tenant_id = p_tenant_id)
        else null
      end;

      source_has_any_rows := v_src_any;

      -- FIX 2: SPLIT THE TWO MEANINGS OF NULL.
      --
      -- Until now NULL meant both "this source holds nothing for you" (common,
      -- benign, permanent for a young tenant) and "this book resolves to no
      -- source at all" (a real configuration gap). de-work renders NULL as
      -- "CANNOT BE READ — no source is connected for it" and then ORDERS an
      -- escalation, so the benign case produced a nightly false alarm: the
      -- Onboarding DE escalated 13 times in 3 days because onboarding_projects
      -- was simply empty.
      --
      -- Now:
      --   false -> rows matched the filter
      --   true  -> the source resolved and holds nothing matching. GENUINELY
      --            EMPTY, and a legitimate "nothing to work today". Whether the
      --            source is entirely unpopulated is reported separately in
      --            source_has_any_rows, so the runtime can say so WITHOUT
      --            claiming a connection failure it never measured.
      --   NULL  -> we could not resolve a source for this book at all: either
      --            the worklist key is not implemented (source_table is null)
      --            or its source_table literal matches no arm above. Both are
      --            real config gaps and both deserve a human.
      --
      -- The mig-528 property survives: a book pointed at the WRONG table is
      -- caught by the arm-coverage probe in `npm run certify`, not by
      -- pretending every empty table is a connection failure.
      book_is_empty := case
        when source_table is null then null
        when v_src_any is null    then null
        else true
      end;
    end if;
    return next;
  end loop;
end;
$function$
;

-- The accounting archetype carries the AP book (payables is bookkeeping
-- work). Idempotent append — never duplicate the key.
update role_archetypes
   set worklist_templates = worklist_templates || '[{"key":"payable_invoices","label":"Supplier invoices to pay"}]'::jsonb
 where key = 'accounting'
   and not exists (select 1 from jsonb_array_elements(worklist_templates) e where e->>'key' = 'payable_invoices');

-- ── Self-checks (each one CAN fail; counted, not assumed) ─────────────────
do $$
declare n int;
begin
  if to_regclass('public.purchase_invoices') is null then
    raise exception 'purchase_invoices table missing';
  end if;

  select count(*) into n from action_definitions
   where scope='platform' and provider='erpnext' and action_key='pay_purchase_invoice';
  if n <> 1 then raise exception 'expected exactly 1 pay_purchase_invoice definition, found %', n; end if;

  if position('payable_invoices' in pg_get_functiondef('public.get_de_worklists(uuid,uuid)'::regprocedure)) = 0 then
    raise exception 'get_de_worklists lost the payable_invoices arm';
  end if;
  if position($lit$when 'purchase_invoices'$lit$ in pg_get_functiondef('public.get_de_worklists(uuid,uuid)'::regprocedure)) = 0 then
    raise exception 'get_de_worklists lost the purchase_invoices source-library arm';
  end if;

  select count(*) into n from role_archetypes a,
    lateral jsonb_array_elements(a.worklist_templates) e
   where a.key = 'accounting' and e->>'key' = 'payable_invoices';
  if n <> 1 then raise exception 'accounting archetype template count for payable_invoices = %', n; end if;

  -- Perimeter: the internet must NOT hold execute on the ingest RPC.
  if has_function_privilege('authenticated', 'public.upsert_external_ap_record(uuid,text,text,text,text,bigint,bigint,date,text,text)', 'execute') then
    raise exception 'authenticated can execute upsert_external_ap_record - perimeter breach';
  end if;
  if has_function_privilege('anon', 'public.upsert_external_ap_record(uuid,text,text,text,text,bigint,bigint,date,text,text)', 'execute') then
    raise exception 'anon can execute upsert_external_ap_record - perimeter breach';
  end if;
end $$;

commit;
