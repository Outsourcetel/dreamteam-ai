-- 608 — ingest for the sources nothing could fill.
--
-- Three of the six watchable sources hold no rows in ANY tenant:
-- `opportunities`, `support_tickets`, `commercial_agreements`. Mig 606 refused
-- to create watchers against them for that reason, which was right but left the
-- question standing: why are they empty?
--
-- Because nothing ingests them. `renewal_invoices` fills from ERPNext through
-- syncFinancials -> upsert_external_ar_record. There is no equivalent for
-- opportunities or tickets — no adapter method, no sync action, no upsert. The
-- writers that DO exist are outbound (apply_opportunity_writeback_internal,
-- close_opportunity_won) or incidental (resume_playbook_on_task).
-- `upsert_commercial_agreement` exists with ZERO callers — written, never wired,
-- the pattern this codebase keeps producing.
--
-- ⚠ HONEST ABOUT WHAT THIS DOES NOT DO. I probed the live ERP before building:
--
--     GET /api/resource/Opportunity  ->  200  {"data":[]}
--     GET /api/resource/Issue        ->  200  {"data":[]}
--     GET /api/resource/Contract     ->  200  {"data":[]}
--
-- The credentials work and the permissions are fine. There is simply nothing
-- there. So this migration will move ZERO rows today, and saying otherwise
-- would be the kind of claim two days have been spent removing. What it does is
-- close the WIRING gap: the moment an opportunity or an issue exists in the ERP
-- the platform already uses, it lands here, feeds account health, and makes the
-- role watchers groundable. The data gap is the founder's to close by using
-- their ERP; the plumbing gap was ours.
--
-- Vocabularies are mapped, not passed through. `support_tickets` constrains
-- status to open|pending|resolved|escalated and priority to p1..p4; ERPNext
-- says Open/Replied/Resolved/Closed and Low/Medium/High/Urgent. An unmapped
-- passthrough would fail the check constraint on the first real row.

begin;

-- `support_tickets` already has (tenant_id, source, external_ref) unique.
-- `opportunities` does not, so a re-sync would duplicate every row.
create unique index if not exists opportunities_source_ref_uniq
  on opportunities (tenant_id, source, external_ref)
  where external_ref is not null;

-- ── Shared: resolve the customer, creating it if the ERP knows one we do not ──
-- Same behaviour as upsert_external_ar_record, deliberately: a ticket for a
-- customer we have never seen should not be dropped, and two ingests must not
-- produce two accounts.
create or replace function resolve_external_account(
  p_tenant_id uuid, p_provider text, p_customer_external_ref text, p_customer_name text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if coalesce(btrim(p_customer_external_ref), '') = '' then
    return null;
  end if;

  insert into customer_accounts (tenant_id, name, external_ref, source_provider, source_external_ref)
  values (p_tenant_id,
          coalesce(nullif(btrim(p_customer_name), ''), p_customer_external_ref),
          p_customer_external_ref, p_provider, p_customer_external_ref)
  on conflict (tenant_id, source_provider, source_external_ref) where source_external_ref is not null
  do update set name = excluded.name, updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function resolve_external_account(uuid, text, text, text) to service_role;

-- ── Opportunities ────────────────────────────────────────────────────────

create or replace function upsert_external_opportunity(
  p_tenant_id uuid, p_provider text, p_external_ref text,
  p_name text, p_company_name text, p_stage text,
  p_amount_cents bigint, p_close_date date, p_owner text,
  p_customer_external_ref text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_account uuid;
  v_stage   text;
  v_id      uuid;
begin
  if p_tenant_id is null or coalesce(p_provider,'') = '' or coalesce(p_external_ref,'') = '' then
    raise exception 'tenant, provider and external ref are all required';
  end if;

  -- The pipeline board reads a closed vocabulary. Anything unrecognised lands
  -- at the top of the funnel rather than as a stage the UI cannot render.
  v_stage := case lower(coalesce(p_stage, ''))
    when 'open' then 'prospect'
    when 'quotation' then 'proposal'
    when 'converted' then 'won'
    when 'closed' then 'won'
    when 'lost' then 'lost'
    when 'replied' then 'qualified'
    else case when lower(coalesce(p_stage,'')) in
      ('prospect','qualified','proposal','negotiation','won','lost')
      then lower(p_stage) else 'prospect' end
  end;

  v_account := resolve_external_account(p_tenant_id, p_provider, p_customer_external_ref, p_company_name);

  insert into opportunities (tenant_id, account_id, name, company_name, stage, amount_cents,
                             close_date, owner, source, external_ref)
  values (p_tenant_id, v_account,
          coalesce(nullif(btrim(p_name),''), p_external_ref),
          nullif(btrim(p_company_name),''), v_stage, coalesce(p_amount_cents, 0),
          p_close_date, nullif(btrim(p_owner),''), p_provider, p_external_ref)
  on conflict (tenant_id, source, external_ref) where external_ref is not null
  do update set
    account_id   = coalesce(excluded.account_id, opportunities.account_id),
    name         = excluded.name,
    company_name = coalesce(excluded.company_name, opportunities.company_name),
    stage        = excluded.stage,
    amount_cents = excluded.amount_cents,
    close_date   = excluded.close_date,
    owner        = coalesce(excluded.owner, opportunities.owner),
    updated_at   = now()
  returning id into v_id;

  return jsonb_build_object('opportunity_id', v_id, 'account_id', v_account, 'stage', v_stage);
end;
$$;

grant execute on function upsert_external_opportunity(uuid, text, text, text, text, text, bigint, date, text, text) to service_role;

-- ── Support tickets ──────────────────────────────────────────────────────

create or replace function upsert_external_ticket(
  p_tenant_id uuid, p_provider text, p_external_ref text,
  p_subject text, p_body text, p_status text, p_priority text,
  p_customer_external_ref text default null, p_customer_name text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_account  uuid;
  v_status   text;
  v_priority text;
  v_id       uuid;
begin
  if p_tenant_id is null or coalesce(p_provider,'') = '' or coalesce(p_external_ref,'') = '' then
    raise exception 'tenant, provider and external ref are all required';
  end if;

  -- CHECK constraints, not preferences: status must be one of four and priority
  -- one of p1..p4. A passthrough would fail on the first real row.
  v_status := case lower(coalesce(p_status,''))
    when 'open' then 'open'
    when 'replied' then 'pending'
    when 'on hold' then 'pending'
    when 'pending' then 'pending'
    when 'resolved' then 'resolved'
    when 'closed' then 'resolved'
    when 'escalated' then 'escalated'
    else 'open' end;

  v_priority := case lower(coalesce(p_priority,''))
    when 'urgent' then 'p1'
    when 'critical' then 'p1'
    when 'high' then 'p2'
    when 'medium' then 'p3'
    when 'low' then 'p4'
    else case when lower(coalesce(p_priority,'')) in ('p1','p2','p3','p4')
      then lower(p_priority) else 'p3' end
  end;

  v_account := resolve_external_account(p_tenant_id, p_provider, p_customer_external_ref, p_customer_name);

  insert into support_tickets (tenant_id, account_id, subject, body, status, priority,
                               assignee, source, external_ref, resolved_at)
  values (p_tenant_id, v_account,
          left(coalesce(nullif(btrim(p_subject),''), p_external_ref), 300),
          p_body, v_status, v_priority,
          -- Arrived from a system of record, so a person owns it until a
          -- digital employee is explicitly given it.
          'human', p_provider, p_external_ref,
          case when v_status = 'resolved' then now() end)
  on conflict (tenant_id, source, external_ref) where external_ref is not null
  do update set
    account_id  = coalesce(excluded.account_id, support_tickets.account_id),
    subject     = excluded.subject,
    body        = coalesce(excluded.body, support_tickets.body),
    status      = excluded.status,
    priority    = excluded.priority,
    resolved_at = case when excluded.status = 'resolved'
                       then coalesce(support_tickets.resolved_at, now()) else null end,
    updated_at  = now()
  returning id into v_id;

  return jsonb_build_object('ticket_id', v_id, 'account_id', v_account,
                            'status', v_status, 'priority', v_priority);
end;
$$;

grant execute on function upsert_external_ticket(uuid, text, text, text, text, text, text, text, text) to service_role;

-- ── Prove the mapping, then leave nothing behind ─────────────────────────
-- Asserted with real inserts rather than by reading the CASE arms: a mapping
-- that satisfies the check constraint is the only kind that matters, and the
-- vocabularies differ enough that eyeballing them is not proof.

do $verify$
declare
  v_t uuid := (select id from tenants where slug = 'outsourcetel-hq');
  v_o jsonb; v_k jsonb; v_k2 jsonb;
begin
  if v_t is null then raise notice 'no workspace to verify against'; return; end if;

  v_o := upsert_external_opportunity(v_t, '__probe__', 'PROBE-OPP-1', 'Probe deal',
           'Probe Co', 'Quotation', 250000, current_date + 30, 'Someone', 'PROBE-CUST-1');
  if v_o->>'stage' <> 'proposal' then
    raise exception 'opportunity stage mapping wrong: Quotation -> %', v_o->>'stage';
  end if;

  v_k := upsert_external_ticket(v_t, '__probe__', 'PROBE-TKT-1', 'Probe ticket',
           'body', 'Replied', 'High', 'PROBE-CUST-1', 'Probe Co');
  if v_k->>'status' <> 'pending' or v_k->>'priority' <> 'p2' then
    raise exception 'ticket mapping wrong: % / %', v_k->>'status', v_k->>'priority';
  end if;

  -- Idempotent: a second sync of the same record must update, not duplicate.
  v_k2 := upsert_external_ticket(v_t, '__probe__', 'PROBE-TKT-1', 'Probe ticket v2',
            'body', 'Resolved', 'Low', 'PROBE-CUST-1', 'Probe Co');
  if (v_k2->>'ticket_id') <> (v_k->>'ticket_id') then
    raise exception 're-syncing the same ticket created a second row';
  end if;
  if v_k2->>'status' <> 'resolved' then
    raise exception 'ticket status did not update on re-sync';
  end if;

  delete from support_tickets where source = '__probe__';
  delete from opportunities   where source = '__probe__';
  delete from customer_accounts where source_provider = '__probe__';

  raise notice 'ingest verified: vocabularies mapped, upserts idempotent, probe rows removed';
end;
$verify$;

commit;
