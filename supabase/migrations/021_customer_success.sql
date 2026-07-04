-- ============================================================
-- Migration 021: Customer Success end-to-end
--
--   1. health_score_config     — per-tenant weights + thresholds for the
--      COMPUTED health score. One row per tenant, RLS tenant-scoped.
--   2. customer_accounts.health_components — transparent breakdown jsonb
--      written on every recompute (the "why" behind the number).
--   3. compute_account_health / compute_tenant_health — SECURITY DEFINER
--      scoring from REAL signals (open tickets, escalations, overdue sent
--      invoices, activity recency). Flips status active↔at_risk per the
--      thresholds (never touches churned) and appends ONE audit event per
--      status change (not per recompute).
--   4. account_at_risk event key on playbook_event_rules + a new branch in
--      dispatch_due_triggers() — accounts sitting at_risk fire a playbook
--      (per-account cooldown dedup, identical semantics to 020).
--   5. Cron path — invoke_playbook_dispatch() (the existing 5-min pg_cron
--      job's target) gains a cheap pre-step: recompute health for tenants
--      whose last compute is older than 24h ("nightly", evaluated every
--      tick). Recompute runs BEFORE dispatch so a flip can fire same-tick.
--
-- SCORING (0-100, penalties subtracted from 100; weight = max penalty):
--   open_tickets     (default w=25): open+pending count  0→0 · 1-2→40% · 3-5→70% · 6+→100%
--   escalations      (default w=25): escalated count     0→0 · 1→60%  · 2+→100%
--   overdue_invoices (default w=30): sent past due_date  0→0 · 1→70%  · 2+→100%
--   activity_recency (default w=20): days since last activity_event for
--                    the account  ≤7→0 · ≤14→30% · ≤30→60% · >30/none→100%
-- ============================================================

-- ============================================================
-- 1. TABLE: health_score_config (one row per tenant)
-- ============================================================
create table if not exists health_score_config (
  tenant_id        uuid primary key references tenants(id) on delete cascade,
  weights          jsonb not null default '{"open_tickets":25,"escalations":25,"overdue_invoices":30,"activity_recency":20}'::jsonb,
  thresholds       jsonb not null default '{"at_risk_below":50,"healthy_above":75}'::jsonb,
  last_computed_at timestamptz,
  updated_by       uuid,
  updated_at       timestamptz not null default now()
);

alter table health_score_config enable row level security;
drop policy if exists "health_score_config_tenant_isolation" on health_score_config;
create policy "health_score_config_tenant_isolation" on health_score_config
  for all
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()))
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

drop trigger if exists health_score_config_updated_at on health_score_config;
create trigger health_score_config_updated_at
  before update on health_score_config
  for each row execute function update_updated_at();

-- ============================================================
-- 2. Transparent component breakdown on the account row
-- ============================================================
alter table customer_accounts add column if not exists health_components jsonb;

-- ============================================================
-- Internal audit helper: same hash chain as append_audit_event but
-- WITHOUT the membership check — needed because the cron path runs as
-- the postgres role (auth.uid() is null, auth.role() is not
-- 'service_role'). NOT granted to authenticated/anon; called only from
-- the SECURITY DEFINER compute functions below (definer executes it).
-- ============================================================
create or replace function append_audit_event_internal(
  p_tenant_id  uuid,
  p_actor      text,
  p_actor_type text,
  p_action     text,
  p_category   text,
  p_detail     jsonb default '{}'::jsonb
) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_prev text;
  v_now  timestamptz := clock_timestamp();
begin
  perform pg_advisory_xact_lock(hashtext('audit_' || p_tenant_id::text));
  select hash into v_prev from audit_events
    where tenant_id = p_tenant_id
    order by created_at desc, id desc limit 1;
  v_prev := coalesce(v_prev, '');
  insert into audit_events (tenant_id, actor, actor_type, action, category, detail, prev_hash, hash, created_at)
  values (p_tenant_id, p_actor, p_actor_type, p_action, p_category, coalesce(p_detail, '{}'::jsonb), v_prev,
          encode(digest(v_prev || p_tenant_id::text || coalesce(p_action, '') ||
                        coalesce(p_detail::text, '{}') || v_now::text, 'sha256'), 'hex'),
          v_now);
end;
$$;
revoke all on function append_audit_event_internal(uuid, text, text, text, text, jsonb) from public, anon, authenticated;

-- ============================================================
-- 3. CORE: compute one account's health from real signals.
--    No auth check here — this is the internal engine. The public
--    wrappers below guard membership.
-- ============================================================
create or replace function compute_account_health_core(p_account uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_acct       customer_accounts;
  v_weights    jsonb;
  v_thresholds jsonb;
  w_tickets    numeric; w_escal numeric; w_overdue numeric; w_activity numeric;
  n_open       integer; n_escal integer; n_overdue integer;
  v_last_act   timestamptz;
  v_days       integer;                  -- null = no activity ever
  p_tickets    numeric; p_escal numeric; p_overdue numeric; p_activity numeric;
  v_score      integer;
  v_components jsonb;
  v_at_risk    integer; v_healthy integer;
  v_new_status text;
begin
  select * into v_acct from customer_accounts where id = p_account;
  if not found then
    return jsonb_build_object('error', 'account_not_found');
  end if;

  select weights, thresholds into v_weights, v_thresholds
  from health_score_config where tenant_id = v_acct.tenant_id;
  v_weights    := coalesce(v_weights,    '{"open_tickets":25,"escalations":25,"overdue_invoices":30,"activity_recency":20}'::jsonb);
  v_thresholds := coalesce(v_thresholds, '{"at_risk_below":50,"healthy_above":75}'::jsonb);

  w_tickets  := coalesce((v_weights->>'open_tickets')::numeric, 25);
  w_escal    := coalesce((v_weights->>'escalations')::numeric, 25);
  w_overdue  := coalesce((v_weights->>'overdue_invoices')::numeric, 30);
  w_activity := coalesce((v_weights->>'activity_recency')::numeric, 20);
  v_at_risk  := coalesce((v_thresholds->>'at_risk_below')::int, 50);
  v_healthy  := coalesce((v_thresholds->>'healthy_above')::int, 75);

  -- ── real signals ──
  select count(*) filter (where status in ('open', 'pending')),
         count(*) filter (where status = 'escalated')
    into n_open, n_escal
  from support_tickets where account_id = p_account;

  select count(*) into n_overdue
  from renewal_invoices
  where account_id = p_account and status = 'sent'
    and due_date is not null and due_date < current_date;

  select max(created_at) into v_last_act
  from activity_events where account_id = p_account;
  v_days := case when v_last_act is null then null
                 else greatest(0, extract(day from now() - v_last_act)::int) end;

  -- ── bucketed penalties ──
  p_tickets  := case when n_open = 0 then 0 when n_open <= 2 then 0.4 * w_tickets
                     when n_open <= 5 then 0.7 * w_tickets else w_tickets end;
  p_escal    := case when n_escal = 0 then 0 when n_escal = 1 then 0.6 * w_escal else w_escal end;
  p_overdue  := case when n_overdue = 0 then 0 when n_overdue = 1 then 0.7 * w_overdue else w_overdue end;
  p_activity := case when v_days is null then w_activity
                     when v_days <= 7 then 0 when v_days <= 14 then 0.3 * w_activity
                     when v_days <= 30 then 0.6 * w_activity else w_activity end;

  v_score := greatest(0, least(100, round(100 - p_tickets - p_escal - p_overdue - p_activity)::int));

  v_components := jsonb_build_object(
    'score', v_score,
    'computed_at', now(),
    'open_tickets',     jsonb_build_object('count', n_open,    'penalty', round(p_tickets, 1),  'weight', w_tickets),
    'escalations',      jsonb_build_object('count', n_escal,   'penalty', round(p_escal, 1),    'weight', w_escal),
    'overdue_invoices', jsonb_build_object('count', n_overdue, 'penalty', round(p_overdue, 1),  'weight', w_overdue),
    'activity_recency', jsonb_build_object('days_since', v_days, 'penalty', round(p_activity, 1), 'weight', w_activity)
  );

  -- ── status flip per thresholds (never touches churned) ──
  v_new_status := v_acct.status;
  if v_acct.status = 'active' and v_score < v_at_risk then
    v_new_status := 'at_risk';
  elsif v_acct.status = 'at_risk' and v_score > v_healthy then
    v_new_status := 'active';
  end if;

  update customer_accounts
    set health_score = v_score, health_components = v_components, status = v_new_status
    where id = p_account;

  -- Audit ONLY on a status change — not on every recompute.
  if v_new_status <> v_acct.status then
    perform append_audit_event_internal(
      v_acct.tenant_id, 'Success DE', 'de',
      format('Account health flip — %s: %s → %s (score %s, at-risk < %s, healthy > %s)',
             v_acct.name, v_acct.status, v_new_status, v_score, v_at_risk, v_healthy),
      'config_change',
      jsonb_build_object('kind', 'health_recompute', 'account_id', p_account,
                         'old_status', v_acct.status, 'new_status', v_new_status,
                         'score', v_score, 'components', v_components));
  end if;

  return v_components || jsonb_build_object('status', v_new_status, 'status_changed', v_new_status <> v_acct.status);
end;
$$;
revoke all on function compute_account_health_core(uuid) from public, anon, authenticated;

-- ── Public wrapper: single account, membership-guarded ──
create or replace function compute_account_health(p_account uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tenant uuid;
begin
  select tenant_id into v_tenant from customer_accounts where id = p_account;
  if v_tenant is null then
    return jsonb_build_object('error', 'account_not_found');
  end if;
  if coalesce(auth.role(), '') <> 'service_role' and not exists (
    select 1 from profiles where user_id = auth.uid() and tenant_id = v_tenant
  ) then
    raise exception 'not a member of this tenant';
  end if;
  return compute_account_health_core(p_account);
end;
$$;
revoke all on function compute_account_health(uuid) from public;
grant execute on function compute_account_health(uuid) to authenticated, service_role;

-- ── Public wrapper: whole tenant. p_force=false honors the 1h freshness
--    window (opportunistic page-load path); p_force=true always runs
--    ("Recompute now"). Members recompute their own tenant only. ──
create or replace function compute_tenant_health(p_force boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tenant uuid;
  v_last   timestamptz;
  v_n      integer := 0;
  v_flips  integer := 0;
  v_acct   record;
  v_res    jsonb;
begin
  select tenant_id into v_tenant from profiles where user_id = auth.uid() limit 1;
  if v_tenant is null then
    raise exception 'no tenant for caller';
  end if;

  -- ensure the config row exists (defaults) so freshness can be tracked
  insert into health_score_config (tenant_id) values (v_tenant)
  on conflict (tenant_id) do nothing;

  select last_computed_at into v_last from health_score_config where tenant_id = v_tenant;
  if not p_force and v_last is not null and v_last > now() - interval '1 hour' then
    return jsonb_build_object('computed', 0, 'skipped', true, 'last_computed_at', v_last);
  end if;

  for v_acct in select id from customer_accounts where tenant_id = v_tenant and status <> 'churned' loop
    v_res := compute_account_health_core(v_acct.id);
    v_n := v_n + 1;
    if coalesce((v_res->>'status_changed')::boolean, false) then v_flips := v_flips + 1; end if;
  end loop;

  update health_score_config set last_computed_at = now() where tenant_id = v_tenant;
  return jsonb_build_object('computed', v_n, 'status_flips', v_flips, 'skipped', false);
end;
$$;
revoke all on function compute_tenant_health(boolean) from public;
grant execute on function compute_tenant_health(boolean) to authenticated;

-- ── Service/cron variant: explicit tenant, no JWT. Not for clients. ──
create or replace function compute_tenant_health_service(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_n     integer := 0;
  v_flips integer := 0;
  v_acct  record;
  v_res   jsonb;
begin
  for v_acct in select id from customer_accounts where tenant_id = p_tenant_id and status <> 'churned' loop
    v_res := compute_account_health_core(v_acct.id);
    v_n := v_n + 1;
    if coalesce((v_res->>'status_changed')::boolean, false) then v_flips := v_flips + 1; end if;
  end loop;
  insert into health_score_config (tenant_id, last_computed_at) values (p_tenant_id, now())
  on conflict (tenant_id) do update set last_computed_at = now();
  return jsonb_build_object('computed', v_n, 'status_flips', v_flips);
end;
$$;
revoke all on function compute_tenant_health_service(uuid) from public, anon, authenticated;
grant execute on function compute_tenant_health_service(uuid) to service_role;

-- ============================================================
-- 4. account_at_risk event key + dispatcher branch
-- ============================================================
alter table playbook_event_rules drop constraint if exists playbook_event_rules_event_key_check;
alter table playbook_event_rules add constraint playbook_event_rules_event_key_check
  check (event_key in ('invoice_overdue', 'ticket_synced_high_priority', 'account_at_risk'));

-- Recreate dispatch_due_triggers with the account_at_risk branch.
-- (Schedules + the two 020 event keys are byte-identical to 020.)
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
  v_pending    integer := 0;
  v_skipped    integer := 0;
  v_days       integer;
  v_priority   text;
  v_within     integer;
  v_recent     record;
  v_min_arr    bigint;
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
      -- NEW (021): accounts whose COMPUTED health flipped them to at_risk.
      -- target_ref = account id; per-account cooldown dedup identical to
      -- the 020 event keys. Optional params.min_arr_cents filter.
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
    end if;
  end loop;

  return jsonb_build_object('pending', v_pending, 'skipped_dedup', v_skipped);
end;
$$;

revoke all on function dispatch_due_triggers(uuid) from public;
grant execute on function dispatch_due_triggers(uuid) to service_role;

-- ============================================================
-- 5. CRON: extend invoke_playbook_dispatch() with a nightly-equivalent
--    health recompute pre-step (runs when a tenant's last compute is
--    older than 24h; checked on every 5-min tick, so it self-heals).
--    Recompute runs BEFORE the dispatch POST so an at_risk flip can be
--    picked up by the very same dispatch cycle.
-- ============================================================
create or replace function invoke_playbook_dispatch()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_secret text;
  v_req_id bigint;
  v_t      record;
  v_health integer := 0;
begin
  -- ── (0) nightly health recompute, per tenant with accounts ──
  for v_t in
    select distinct ca.tenant_id
    from customer_accounts ca
    left join health_score_config c on c.tenant_id = ca.tenant_id
    where c.last_computed_at is null or c.last_computed_at < now() - interval '24 hours'
  loop
    perform compute_tenant_health_service(v_t.tenant_id);
    v_health := v_health + 1;
  end loop;

  -- ── (1) dispatch POST (unchanged from 020) ──
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'playbook_dispatch_secret'
  limit 1;
  if v_secret is null then
    return format('health:%s no_secret', v_health);
  end if;

  select net.http_post(
    url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/playbook-execute',
    body    := '{"action":"dispatch"}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dispatch-secret', v_secret
    ),
    timeout_milliseconds := 30000
  ) into v_req_id;

  return format('health:%s queued:%s', v_health, v_req_id);
end;
$$;

revoke all on function invoke_playbook_dispatch() from public;
