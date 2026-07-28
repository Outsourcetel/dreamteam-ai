-- 506_agreements_find_their_customer.sql
-- ============================================================================
-- The last structural gap under the account book — and it is deliberately NOT
-- "create some customers".
--
-- WHAT ALREADY EXISTS (and is not rebuilt here): two intake paths, both wired.
-- A CSV importer (src/components/ImportCustomersModal.tsx) and a single-account
-- form (src/pages/tenant/entity/CustomerSuccessLive.tsx). The book can be
-- filled today, by a person, with the business's real customers.
--
-- WHAT IS MISSING: nothing connects an agreement to a customer.
-- commercial_agreements.account_id is NULL on all three rows, and no code path
-- anywhere sets it. So even after the book fills, the Renewal employee would
-- still only half-know its counterparty — it can read the contract but cannot
-- reach the account behind it, its contacts, or its health. docs/38 recorded
-- this as part of why outreach was unexecutable: "no contact store exists
-- (customer_account_contacts 0 rows, agreement.account_id NULL)".
--
-- WHY NO CUSTOMERS ARE CREATED HERE: the three agreements carry
-- attributes.seed='exec2c'. Minting accounts from them would put fictional
-- customers into a live workspace — the same class of problem as the dangling
-- test UUID that one employee is still chasing a renewal against. Real
-- customers go in through the importer; this migration makes sure that when
-- they do, the contracts find them.
--
-- MATCHING IS DELIBERATELY CONSERVATIVE. Case-insensitive exact match on the
-- trimmed name, and ONLY when exactly one candidate matches. Ambiguity is left
-- unlinked and counted rather than guessed — the same discipline migration 484
-- used for the escalation backfill, and for the same reason: a wrong link here
-- would point an employee at the wrong customer's record.
-- ============================================================================

create or replace function public.link_agreements_to_accounts(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  n_linked int := 0;
  n_ambiguous int := 0;
begin
  -- One unambiguous candidate only.
  with candidate as (
    select ag.id as agreement_id,
           (select a.id from customer_accounts a
             where a.tenant_id = ag.tenant_id
               and lower(btrim(a.name)) = lower(btrim(ag.counterparty_name))
             limit 1) as account_id,
           (select count(*) from customer_accounts a
             where a.tenant_id = ag.tenant_id
               and lower(btrim(a.name)) = lower(btrim(ag.counterparty_name))) as n
      from commercial_agreements ag
     where ag.tenant_id = p_tenant_id
       and ag.account_id is null
       and coalesce(btrim(ag.counterparty_name), '') <> ''
  ),
  linked as (
    update commercial_agreements ag
       set account_id = c.account_id, updated_at = now()
      from candidate c
     where ag.id = c.agreement_id and c.n = 1
    returning ag.id
  )
  select (select count(*) from linked), (select count(*) from candidate where n > 1)
    into n_linked, n_ambiguous;

  -- The case facet should point at the same customer, so the desk and the
  -- account book agree about who this is.
  update continuity_cases cc
     set account_id = ag.account_id, updated_at = now()
    from commercial_agreements ag
   where cc.agreement_id = ag.id
     and cc.tenant_id = p_tenant_id
     and cc.account_id is null
     and ag.account_id is not null;

  return jsonb_build_object('ok', true, 'linked', n_linked, 'ambiguous_left_alone', n_ambiguous);
end;
$function$;

revoke all on function public.link_agreements_to_accounts(uuid) from public, anon;
grant execute on function public.link_agreements_to_accounts(uuid) to authenticated, service_role;

-- ── the link fires by itself, from either direction ─────────────────────────
-- An account can arrive before or after its contract, and both orders happen:
-- the importer creates accounts in bulk, while run_work_watchers mints
-- agreements from the book of work.
create or replace function public.link_new_account_to_agreements()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- House pattern: a failed side effect must never roll back the row the
  -- person just created.
  begin
    perform link_agreements_to_accounts(new.tenant_id);
  exception when others then
    raise warning 'link_agreements_to_accounts failed for tenant %: %', new.tenant_id, sqlerrm;
  end;
  return new;
end;
$function$;

drop trigger if exists trg_link_account_to_agreements on public.customer_accounts;
create trigger trg_link_account_to_agreements
  after insert on public.customer_accounts
  for each row execute function public.link_new_account_to_agreements();

drop trigger if exists trg_link_agreement_to_account on public.commercial_agreements;
create trigger trg_link_agreement_to_account
  after insert on public.commercial_agreements
  for each row execute function public.link_new_account_to_agreements();

notify pgrst, 'reload schema';

-- ── backfill whatever can be linked today ───────────────────────────────────
do $b$
declare r jsonb; t record;
begin
  for t in select id, slug from tenants loop
    r := link_agreements_to_accounts(t.id);
    if coalesce((r->>'linked')::int, 0) > 0 or coalesce((r->>'ambiguous_left_alone')::int, 0) > 0 then
      raise notice '506: % — linked %, ambiguous %', t.slug, r->>'linked', r->>'ambiguous_left_alone';
    end if;
  end loop;
end $b$;

-- ── PROOF ────────────────────────────────────────────────────────────────────
do $a$
declare
  v_tenant uuid; v_acct uuid; v_ag uuid; n int;
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_link_account_to_agreements' and not tgisinternal) then
    raise exception '506: the account-side trigger does not exist';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_link_agreement_to_account' and not tgisinternal) then
    raise exception '506: the agreement-side trigger does not exist';
  end if;

  select t.id into v_tenant from tenants t where t.slug = 'outsourcetel-hq';
  if v_tenant is null then raise notice '506: no fixture — proof SKIPPED'; return; end if;

  -- BEHAVIOURAL: create an account whose name matches a real unlinked
  -- agreement, and the contract must find it WITHOUT anyone calling anything.
  select ag.id into v_ag from commercial_agreements ag
   where ag.tenant_id = v_tenant and ag.account_id is null
     and coalesce(btrim(ag.counterparty_name), '') <> '' limit 1;
  if v_ag is null then
    raise notice '506: no unlinked agreement to test against — proof SKIPPED';
    return;
  end if;

  insert into customer_accounts (tenant_id, name, notes)
  select v_tenant, ag.counterparty_name, '[MIG506 FIXTURE] temporary, removed in this transaction'
    from commercial_agreements ag where ag.id = v_ag
  returning id into v_acct;

  select count(*) into n from commercial_agreements
   where id = v_ag and account_id = v_acct;
  if n <> 1 then
    raise exception '506: the agreement did not find its customer — the link is inert';
  end if;

  -- ...and the case facet must agree about who the customer is.
  select count(*) into n from continuity_cases where agreement_id = v_ag and account_id = v_acct;
  if n = 0 then
    raise notice '506: agreement linked; no continuity case on this agreement to update';
  end if;

  -- Clean up: unlink first so the fixture account can be deleted without
  -- leaving a dangling reference.
  update commercial_agreements set account_id = null where id = v_ag;
  update continuity_cases set account_id = null where agreement_id = v_ag;
  delete from customer_accounts where id = v_acct;

  select count(*) into n from customer_accounts where notes like '[MIG506 FIXTURE]%';
  if n <> 0 then raise exception '506: fixture account survived (%)', n; end if;

  raise notice '506: contracts now find their customer automatically, from either direction';
end $a$;
