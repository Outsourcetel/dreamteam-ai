-- ============================================================
-- Migration 023: BD + Sales end-to-end — the pipeline
--
-- DOCTRINE (SCALING-ARCHITECTURE.md §Systems-of-Record): the CRM
-- (Salesforce/HubSpot) stays the system of record for pipeline. This
-- table is a WORKING CACHE / action workspace, not a CRM replacement:
-- `source` ('native'|'import'|future crm providers) + `external_ref`
-- carry the SoR origin exactly like support_tickets does. Native mode
-- is the bootstrap for tenants without a CRM; the connector story is
-- designed-in (connector_objects already supports arbitrary object
-- types — 'opportunity' is the future sync target).
--
--   1. opportunities — stage prospect→qualified→proposal→negotiation
--      →won/lost, amount_cents, free-text owner (v1, like onboarding
--      assignee), stage_history jsonb appended by trigger on every
--      stage change (+ activity event; audit event on won/lost only).
--   2. Guarded transitions: won/lost ONLY via the close RPCs
--      (close_opportunity_won / close_opportunity_lost) — enforced by
--      the stage trigger via a transaction-local flag. Lost requires a
--      reason. Closed opportunities are immutable (stage-wise).
--   3. THE LIFECYCLE SPINE (crown jewel): close_opportunity_won —
--      BD → Sales → won → customer_account exists → onboarding project
--      starts (022 RPC) → success monitors health (021) → renewal
--      plays run (020). Winning a deal is the moment a prospect
--      becomes a customer; the full Customer Lifecycle loop closes.
--   4. opportunity_won event key on playbook_event_rules + dispatcher
--      clause (per-opportunity cooldown dedup, 020/021 semantics,
--      optional params.min_amount_cents) — winning a deal can
--      auto-fire a welcome/kickoff playbook.
--   5. pipeline_summary view — per-tenant count+amount by stage +
--      win rate last 90 days (security_invoker).
--
-- ARR note (documented v1 simplification): on won, arr_cents on the
-- created account = opportunity amount_cents as-is (deal amount is
-- treated as annual contract value; no annualization math in v1).
-- ============================================================

create table if not exists opportunities (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  account_id    uuid references customer_accounts(id) on delete set null,
  name          text not null,
  company_name  text not null default '',   -- denormalized for pre-account prospects
  stage         text not null default 'prospect'
                check (stage in ('prospect', 'qualified', 'proposal', 'negotiation', 'won', 'lost')),
  amount_cents  bigint,
  close_date    date,
  owner         text not null default '',   -- free text v1 (like onboarding assignee)
  source        text not null default 'native',  -- 'native' | 'import' | future CRM providers
  external_ref  text,                       -- the CRM's own id once sync exists
  stage_history jsonb not null default '[]'::jsonb,
  lost_reason   text,
  closed_at     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_opportunities_tenant_stage on opportunities(tenant_id, stage);
create index if not exists idx_opportunities_account on opportunities(account_id);

alter table opportunities enable row level security;
drop policy if exists "opportunities_tenant_isolation" on opportunities;
create policy "opportunities_tenant_isolation" on opportunities
  for all
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()))
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

drop trigger if exists opportunities_updated_at on opportunities;
create trigger opportunities_updated_at
  before update on opportunities
  for each row execute function update_updated_at();

-- ============================================================
-- Stage-change trigger: guarded transitions + stage_history append +
-- activity event; audit event on won/lost (detail.kind =
-- 'opportunity_closed'). Won/lost are reachable ONLY through the close
-- RPCs, which set a transaction-local flag before updating.
-- ============================================================
create or replace function opportunities_stage_guard()
returns trigger
language plpgsql
as $$
declare
  v_via_rpc boolean := coalesce(current_setting('dreamteam.opp_close', true), '') = 'on';
begin
  if tg_op = 'INSERT' then
    if new.stage in ('won', 'lost') then
      raise exception 'opportunities cannot be created already closed';
    end if;
    new.stage_history := jsonb_build_array(jsonb_build_object(
      'stage', new.stage, 'at', now(), 'by', coalesce(auth.uid()::text, 'system')));
    return new;
  end if;

  if new.stage <> old.stage then
    if old.stage in ('won', 'lost') then
      raise exception 'closed opportunities cannot change stage';
    end if;
    if new.stage in ('won', 'lost') and not v_via_rpc then
      raise exception 'won/lost only via close_opportunity_won / close_opportunity_lost';
    end if;
    if new.stage = 'lost' and coalesce(trim(new.lost_reason), '') = '' then
      raise exception 'lost requires a reason';
    end if;
    new.stage_history := coalesce(old.stage_history, '[]'::jsonb)
      || jsonb_build_object('stage', new.stage, 'at', now(), 'by', coalesce(auth.uid()::text, 'system'));
    if new.stage in ('won', 'lost') then
      new.closed_at := now();
      perform append_audit_event_internal(
        new.tenant_id, 'You', 'human',
        format('Opportunity %s — %s%s', case new.stage when 'won' then 'WON' else 'lost' end,
               new.name,
               case when new.stage = 'lost' then format(' (reason: %s)', new.lost_reason)
                    when new.amount_cents is not null then format(' ($%s)', round(new.amount_cents / 100.0)) else '' end),
        'config_change',
        jsonb_build_object('kind', 'opportunity_closed', 'opportunity_id', new.id,
                           'stage', new.stage, 'amount_cents', new.amount_cents,
                           'lost_reason', new.lost_reason, 'account_id', new.account_id));
    end if;
    insert into activity_events (tenant_id, account_id, actor, actor_type, event_type, text)
    values (new.tenant_id, new.account_id, 'You', 'human',
            case when new.stage = 'lost' then 'escalated' else 'config_change' end,
            format('Opportunity %s → %s', new.name, new.stage));
  end if;
  return new;
end;
$$;

drop trigger if exists opportunities_stage_trg on opportunities;
create trigger opportunities_stage_trg
  before insert or update on opportunities
  for each row execute function opportunities_stage_guard();

-- ============================================================
-- THE WON → LIFECYCLE HANDOFF (the lifecycle spine).
-- BD → Sales → won → account exists → onboarding starts → success
-- monitors health → renewal plays run. This RPC is the seam where a
-- prospect becomes a customer: it closes the pipeline record, creates
-- (or links) the customer_accounts row, and optionally kicks off the
-- onboarding project via the existing 022 machinery.
-- ============================================================
create or replace function close_opportunity_won(
  p_opp               uuid,
  p_account_id        uuid default null,       -- link an existing account instead of creating
  p_create_onboarding boolean default false,
  p_template_version  uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_opp       opportunities;
  v_tenant    uuid;
  v_acct_id   uuid;
  v_acct_name text;
  v_proj      jsonb;
  v_proj_id   uuid;
begin
  select tenant_id into v_tenant from profiles where user_id = auth.uid() limit 1;
  if v_tenant is null then raise exception 'no tenant for caller'; end if;

  select * into v_opp from opportunities where id = p_opp and tenant_id = v_tenant;
  if not found then return jsonb_build_object('error', 'opportunity_not_found'); end if;
  if v_opp.stage in ('won', 'lost') then return jsonb_build_object('error', 'already_closed'); end if;

  -- account: explicit link > existing link > create from company_name.
  v_acct_id := coalesce(p_account_id, v_opp.account_id);
  if v_acct_id is not null then
    select name into v_acct_name from customer_accounts where id = v_acct_id and tenant_id = v_tenant;
    if v_acct_name is null then return jsonb_build_object('error', 'account_not_found'); end if;
  else
    v_acct_name := coalesce(nullif(trim(v_opp.company_name), ''), v_opp.name);
    -- ARR v1: deal amount used as annual contract value verbatim (documented).
    insert into customer_accounts (tenant_id, name, arr_cents, health_score, status, notes)
    values (v_tenant, v_acct_name, coalesce(v_opp.amount_cents, 0), 70, 'active',
            format('Created from won opportunity "%s"', v_opp.name))
    returning id into v_acct_id;
    insert into activity_events (tenant_id, account_id, actor, actor_type, event_type, text)
    values (v_tenant, v_acct_id, 'You', 'human', 'config_change',
            format('Account created from won opportunity — %s', v_acct_name));
  end if;

  -- close it (transaction-local flag lets the guard trigger accept 'won')
  perform set_config('dreamteam.opp_close', 'on', true);
  update opportunities set stage = 'won', account_id = v_acct_id where id = v_opp.id;
  perform set_config('dreamteam.opp_close', '', true);

  perform append_audit_event_internal(
    v_tenant, 'You', 'human',
    format('Won → lifecycle handoff — %s: account "%s"%s', v_opp.name, v_acct_name,
           case when p_create_onboarding then ' + onboarding kickoff' else '' end),
    'config_change',
    jsonb_build_object('kind', 'opportunity_won_handoff', 'opportunity_id', v_opp.id,
                       'account_id', v_acct_id, 'created_account', v_opp.account_id is null and p_account_id is null,
                       'create_onboarding', p_create_onboarding));

  if p_create_onboarding and p_template_version is not null then
    v_proj := create_onboarding_project(v_acct_id, p_template_version, null, null);
    v_proj_id := (v_proj->>'project_id')::uuid;
    if v_proj->>'error' is not null then
      return jsonb_build_object('account_id', v_acct_id, 'onboarding_error', v_proj->>'error');
    end if;
  end if;

  return jsonb_build_object('account_id', v_acct_id, 'project_id', v_proj_id);
end;
$$;
revoke all on function close_opportunity_won(uuid, uuid, boolean, uuid) from public;
grant execute on function close_opportunity_won(uuid, uuid, boolean, uuid) to authenticated;

-- ── Lost: reason mandatory ──
create or replace function close_opportunity_lost(
  p_opp    uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_opp    opportunities;
  v_tenant uuid;
begin
  select tenant_id into v_tenant from profiles where user_id = auth.uid() limit 1;
  if v_tenant is null then raise exception 'no tenant for caller'; end if;
  if coalesce(trim(p_reason), '') = '' then
    return jsonb_build_object('error', 'lost_reason_required');
  end if;
  select * into v_opp from opportunities where id = p_opp and tenant_id = v_tenant;
  if not found then return jsonb_build_object('error', 'opportunity_not_found'); end if;
  if v_opp.stage in ('won', 'lost') then return jsonb_build_object('error', 'already_closed'); end if;

  perform set_config('dreamteam.opp_close', 'on', true);
  update opportunities set stage = 'lost', lost_reason = trim(p_reason) where id = v_opp.id;
  perform set_config('dreamteam.opp_close', '', true);

  return jsonb_build_object('closed', true);
end;
$$;
revoke all on function close_opportunity_lost(uuid, text) from public;
grant execute on function close_opportunity_lost(uuid, text) to authenticated;

-- ============================================================
-- opportunity_won event key (params: {min_amount_cents?}) + dispatcher
-- clause — per-opportunity cooldown dedup, identical 020/021 semantics.
-- ============================================================
alter table playbook_event_rules drop constraint if exists playbook_event_rules_event_key_check;
alter table playbook_event_rules add constraint playbook_event_rules_event_key_check
  check (event_key in ('invoice_overdue', 'ticket_synced_high_priority', 'account_at_risk', 'opportunity_won'));

-- Recreate dispatch_due_triggers with the opportunity_won branch.
-- (Schedules + the 020/021 event keys are byte-identical to 021.)
create or replace function dispatch_due_triggers(p_tenant_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_sched      record;
  v_rule       record;
  v_acct       record;
  v_inv        record;
  v_ticket     record;
  v_opp        record;
  v_pending    integer := 0;
  v_skipped    integer := 0;
  v_days       integer;
  v_priority   text;
  v_within     integer;
  v_recent     record;
  v_min_arr    bigint;
  v_min_amount bigint;
begin
  -- ── (a) due schedules ─────────────────────────────────────
  for v_sched in
    select s.*, d.status as def_status
    from playbook_schedules s
    join playbook_definitions d on d.id = s.definition_id
    where s.active
      and s.next_fire_at is not null
      and s.next_fire_at <= now()
      and (p_tenant_id is null or s.tenant_id = p_tenant_id)
    for update of s skip locked
  loop
    if v_sched.def_status <> 'published' then
      insert into playbook_trigger_fires (tenant_id, source, schedule_id, definition_id, status, detail)
      values (v_sched.tenant_id, 'schedule', v_sched.id, v_sched.definition_id, 'error',
              'definition is not published — schedule fired into the void');
      v_skipped := v_skipped + 1;
    elsif v_sched.account_selector->>'mode' = 'single' then
      insert into playbook_trigger_fires (tenant_id, source, schedule_id, definition_id, target_account_id, status, detail)
      values (v_sched.tenant_id, 'schedule', v_sched.id, v_sched.definition_id,
              (v_sched.account_selector->>'account_id')::uuid, 'pending_start',
              format('schedule due at %s (single account)', v_sched.next_fire_at));
      v_pending := v_pending + 1;
    else
      v_within := coalesce((v_sched.account_selector->>'renewal_within_days')::int, 60);
      for v_acct in
        select id from customer_accounts
        where tenant_id = v_sched.tenant_id
          and renewal_date is not null
          and renewal_date <= (current_date + v_within)
      loop
        insert into playbook_trigger_fires (tenant_id, source, schedule_id, definition_id, target_account_id, status, detail)
        values (v_sched.tenant_id, 'schedule', v_sched.id, v_sched.definition_id, v_acct.id, 'pending_start',
                format('schedule due at %s (renewal within %s days)', v_sched.next_fire_at, v_within));
        v_pending := v_pending + 1;
      end loop;
    end if;

    update playbook_schedules set last_fired_at = now() where id = v_sched.id;
  end loop;

  -- ── (b) event rules ───────────────────────────────────────
  for v_rule in
    select r.*, d.status as def_status
    from playbook_event_rules r
    join playbook_definitions d on d.id = r.definition_id
    where r.active
      and d.status = 'published'
      and (p_tenant_id is null or r.tenant_id = p_tenant_id)
  loop
    if v_rule.event_key = 'invoice_overdue' then
      v_days := coalesce((v_rule.params->>'overdue_days')::int, 7);
      for v_inv in
        select id, account_id from renewal_invoices
        where tenant_id = v_rule.tenant_id
          and status = 'sent'
          and due_date is not null
          and due_date < (current_date - v_days)
      loop
        select * into v_recent from playbook_trigger_fires
          where event_rule_id = v_rule.id and target_ref = v_inv.id::text
            and status in ('pending_start', 'started')
            and fired_at > now() - make_interval(hours => v_rule.cooldown_hours)
          order by fired_at desc limit 1;
        if found then
          if not exists (
            select 1 from playbook_trigger_fires
            where event_rule_id = v_rule.id and target_ref = v_inv.id::text
              and status = 'skipped_dedup' and fired_at > v_recent.fired_at
          ) then
            insert into playbook_trigger_fires (tenant_id, source, event_rule_id, definition_id, target_account_id, target_ref, status, detail)
            values (v_rule.tenant_id, 'event', v_rule.id, v_rule.definition_id, v_inv.account_id, v_inv.id::text, 'skipped_dedup',
                    format('invoice already fired within the %sh cooldown', v_rule.cooldown_hours));
            v_skipped := v_skipped + 1;
          end if;
        else
          insert into playbook_trigger_fires (tenant_id, source, event_rule_id, definition_id, target_account_id, target_ref, status, detail)
          values (v_rule.tenant_id, 'event', v_rule.id, v_rule.definition_id, v_inv.account_id, v_inv.id::text, 'pending_start',
                  format('invoice overdue > %s days', v_days));
          update playbook_event_rules set last_fired_at = now() where id = v_rule.id;
          v_pending := v_pending + 1;
        end if;
      end loop;

    elsif v_rule.event_key = 'ticket_synced_high_priority' then
      v_priority := coalesce(v_rule.params->>'priority', 'p1');
      for v_ticket in
        select id, account_id from support_tickets
        where tenant_id = v_rule.tenant_id
          and source = 'zendesk'
          and priority = v_priority
          and created_at > now() - interval '7 days'
      loop
        select * into v_recent from playbook_trigger_fires
          where event_rule_id = v_rule.id and target_ref = v_ticket.id::text
            and status in ('pending_start', 'started')
            and fired_at > now() - make_interval(hours => v_rule.cooldown_hours)
          order by fired_at desc limit 1;
        if found then
          if not exists (
            select 1 from playbook_trigger_fires
            where event_rule_id = v_rule.id and target_ref = v_ticket.id::text
              and status = 'skipped_dedup' and fired_at > v_recent.fired_at
          ) then
            insert into playbook_trigger_fires (tenant_id, source, event_rule_id, definition_id, target_account_id, target_ref, status, detail)
            values (v_rule.tenant_id, 'event', v_rule.id, v_rule.definition_id, v_ticket.account_id, v_ticket.id::text, 'skipped_dedup',
                    format('ticket already fired within the %sh cooldown', v_rule.cooldown_hours));
            v_skipped := v_skipped + 1;
          end if;
        else
          insert into playbook_trigger_fires (tenant_id, source, event_rule_id, definition_id, target_account_id, target_ref, status, detail)
          values (v_rule.tenant_id, 'event', v_rule.id, v_rule.definition_id, v_ticket.account_id, v_ticket.id::text, 'pending_start',
                  format('%s ticket synced from Zendesk', v_priority));
          update playbook_event_rules set last_fired_at = now() where id = v_rule.id;
          v_pending := v_pending + 1;
        end if;
      end loop;

    elsif v_rule.event_key = 'account_at_risk' then
      v_min_arr := coalesce((v_rule.params->>'min_arr_cents')::bigint, 0);
      for v_acct in
        select id, arr_cents from customer_accounts
        where tenant_id = v_rule.tenant_id
          and status = 'at_risk'
          and arr_cents >= v_min_arr
      loop
        select * into v_recent from playbook_trigger_fires
          where event_rule_id = v_rule.id and target_ref = v_acct.id::text
            and status in ('pending_start', 'started')
            and fired_at > now() - make_interval(hours => v_rule.cooldown_hours)
          order by fired_at desc limit 1;
        if found then
          if not exists (
            select 1 from playbook_trigger_fires
            where event_rule_id = v_rule.id and target_ref = v_acct.id::text
              and status = 'skipped_dedup' and fired_at > v_recent.fired_at
          ) then
            insert into playbook_trigger_fires (tenant_id, source, event_rule_id, definition_id, target_account_id, target_ref, status, detail)
            values (v_rule.tenant_id, 'event', v_rule.id, v_rule.definition_id, v_acct.id, v_acct.id::text, 'skipped_dedup',
                    format('account already fired within the %sh cooldown', v_rule.cooldown_hours));
            v_skipped := v_skipped + 1;
          end if;
        else
          insert into playbook_trigger_fires (tenant_id, source, event_rule_id, definition_id, target_account_id, target_ref, status, detail)
          values (v_rule.tenant_id, 'event', v_rule.id, v_rule.definition_id, v_acct.id, v_acct.id::text, 'pending_start',
                  'account at risk (computed health below threshold)');
          update playbook_event_rules set last_fired_at = now() where id = v_rule.id;
          v_pending := v_pending + 1;
        end if;
      end loop;

    elsif v_rule.event_key = 'opportunity_won' then
      -- NEW (023): recently-won opportunities (closed within 7 days,
      -- matching the ticket clause's recency window) fire a
      -- welcome/kickoff playbook against the account created/linked by
      -- close_opportunity_won. target_ref = opportunity id; per-
      -- opportunity cooldown dedup identical to the other event keys.
      -- Optional params.min_amount_cents filter.
      v_min_amount := coalesce((v_rule.params->>'min_amount_cents')::bigint, 0);
      for v_opp in
        select id, account_id, amount_cents from opportunities
        where tenant_id = v_rule.tenant_id
          and stage = 'won'
          and account_id is not null
          and closed_at > now() - interval '7 days'
          and coalesce(amount_cents, 0) >= v_min_amount
      loop
        select * into v_recent from playbook_trigger_fires
          where event_rule_id = v_rule.id and target_ref = v_opp.id::text
            and status in ('pending_start', 'started')
            and fired_at > now() - make_interval(hours => v_rule.cooldown_hours)
          order by fired_at desc limit 1;
        if found then
          if not exists (
            select 1 from playbook_trigger_fires
            where event_rule_id = v_rule.id and target_ref = v_opp.id::text
              and status = 'skipped_dedup' and fired_at > v_recent.fired_at
          ) then
            insert into playbook_trigger_fires (tenant_id, source, event_rule_id, definition_id, target_account_id, target_ref, status, detail)
            values (v_rule.tenant_id, 'event', v_rule.id, v_rule.definition_id, v_opp.account_id, v_opp.id::text, 'skipped_dedup',
                    format('opportunity already fired within the %sh cooldown', v_rule.cooldown_hours));
            v_skipped := v_skipped + 1;
          end if;
        else
          insert into playbook_trigger_fires (tenant_id, source, event_rule_id, definition_id, target_account_id, target_ref, status, detail)
          values (v_rule.tenant_id, 'event', v_rule.id, v_rule.definition_id, v_opp.account_id, v_opp.id::text, 'pending_start',
                  'opportunity won — welcome/kickoff play');
          update playbook_event_rules set last_fired_at = now() where id = v_rule.id;
          v_pending := v_pending + 1;
        end if;
      end loop;
    end if;
  end loop;

  return jsonb_build_object('pending', v_pending, 'skipped_dedup', v_skipped);
end;
$$;

revoke all on function dispatch_due_triggers(uuid) from public;
grant execute on function dispatch_due_triggers(uuid) to service_role;

-- ============================================================
-- pipeline_summary — per-tenant stage counts/amounts + win rate 90d.
-- security_invoker: RLS on opportunities applies to the caller.
-- ============================================================
create or replace view pipeline_summary
with (security_invoker = true)
as
select
  tenant_id,
  stage,
  count(*)::int                          as opp_count,
  coalesce(sum(amount_cents), 0)::bigint as amount_cents,
  (select case when count(*) = 0 then null
          else round(100.0 * count(*) filter (where o2.stage = 'won') / count(*))::int end
   from opportunities o2
   where o2.tenant_id = o.tenant_id
     and o2.stage in ('won', 'lost')
     and o2.closed_at > now() - interval '90 days')  as win_rate_90d
from opportunities o
group by tenant_id, stage;
