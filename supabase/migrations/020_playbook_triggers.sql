-- ============================================================
-- Migration 020: R7 scheduled & event playbook triggers
--
-- Fills the trigger_type slots reserved in 019 ('schedule'/'event').
--
--   playbook_schedules      — friendly cadences (daily/weekly/monthly at an
--     UTC hour), NOT raw cron strings — honest v1 simplicity. next_fire_at
--     is computed server-side on every write via trigger.
--   playbook_event_rules    — two event keys in v1:
--     invoice_overdue                (sent invoices past due_date + N days)
--     ticket_synced_high_priority    (Zendesk-synced tickets at priority)
--     Per-target cooldown dedup (cooldown_hours, default 24).
--   playbook_trigger_fires  — the firing log. Every dispatch decision is a
--     row: pending_start → started (run created) / error, or skipped_dedup
--     (recorded ONCE per cooldown window so the log shows the dedup
--     decision without spamming a row per dispatch tick).
--
--   dispatch_due_triggers(p_tenant_id) — SECURITY DEFINER. Pure SQL: finds
--     due schedules + matching event targets, inserts 'pending_start'
--     fires, stamps schedule last/next_fire_at (so a crashed HTTP
--     processor can never double-fire a schedule). It CANNOT start runs —
--     that lives in the playbook-execute edge function's 'dispatch'
--     action, which processes pending fires into real runs.
--
--   DISPATCH WIRING (verified on this project): pg_cron 1.6.4 + pg_net
--     0.20.3 + Vault are all available → PRIMARY path is a pg_cron job
--     every 5 minutes calling invoke_playbook_dispatch(), which posts
--     {action:'dispatch'} to playbook-execute with a secret header. The
--     secret lives in Vault under 'playbook_dispatch_secret' and is
--     provisioned OUT OF BAND (never committed to git). BACKUP path:
--     the Playbooks page opportunistically invokes 'dispatch' on load.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ============================================================
-- next-fire computation (UTC, friendly cadences)
-- ============================================================
create or replace function playbook_next_fire_at(
  p_cadence     text,
  p_run_at_hour integer,
  p_weekly_day  integer,   -- 0=Sunday .. 6=Saturday
  p_monthly_day integer,   -- 1..28
  p_from        timestamptz
) returns timestamptz
language plpgsql immutable
as $$
declare
  v_candidate timestamptz;
begin
  if p_cadence = 'daily' then
    v_candidate := date_trunc('day', p_from at time zone 'utc') at time zone 'utc'
                   + make_interval(hours => p_run_at_hour);
    if v_candidate <= p_from then v_candidate := v_candidate + interval '1 day'; end if;
  elsif p_cadence = 'weekly' then
    v_candidate := date_trunc('day', p_from at time zone 'utc') at time zone 'utc'
                   + make_interval(hours => p_run_at_hour);
    while extract(dow from v_candidate at time zone 'utc')::int <> coalesce(p_weekly_day, 1)
          or v_candidate <= p_from loop
      v_candidate := v_candidate + interval '1 day';
    end loop;
  elsif p_cadence = 'monthly' then
    v_candidate := date_trunc('month', p_from at time zone 'utc') at time zone 'utc'
                   + make_interval(days => coalesce(p_monthly_day, 1) - 1, hours => p_run_at_hour);
    if v_candidate <= p_from then
      v_candidate := date_trunc('month', (p_from at time zone 'utc') + interval '1 month') at time zone 'utc'
                     + make_interval(days => coalesce(p_monthly_day, 1) - 1, hours => p_run_at_hour);
    end if;
  else
    raise exception 'unknown cadence %', p_cadence;
  end if;
  return v_candidate;
end;
$$;

-- ============================================================
-- TABLE: playbook_schedules
-- ============================================================
create table if not exists playbook_schedules (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  definition_id    uuid not null references playbook_definitions(id) on delete cascade,
  cadence          text not null check (cadence in ('daily', 'weekly', 'monthly')),
  run_at_hour      integer not null default 9 check (run_at_hour between 0 and 23),
  weekly_day       integer check (weekly_day between 0 and 6),
  monthly_day      integer check (monthly_day between 1 and 28),
  account_selector jsonb not null default '{"mode":"all_eligible"}'::jsonb,
  active           boolean not null default true,
  last_fired_at    timestamptz,
  next_fire_at     timestamptz,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists playbook_schedules_tenant_idx on playbook_schedules(tenant_id);
create index if not exists playbook_schedules_due_idx on playbook_schedules(next_fire_at) where active;

alter table playbook_schedules enable row level security;
drop policy if exists "playbook_schedules_tenant_isolation" on playbook_schedules;
create policy "playbook_schedules_tenant_isolation" on playbook_schedules
  for all
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()))
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

drop trigger if exists playbook_schedules_updated_at on playbook_schedules;
create trigger playbook_schedules_updated_at
  before update on playbook_schedules
  for each row execute function update_updated_at();

-- next_fire_at is server-computed on every write — clients never set it.
create or replace function playbook_schedules_compute_next()
returns trigger language plpgsql as $$
begin
  new.next_fire_at := playbook_next_fire_at(new.cadence, new.run_at_hour, new.weekly_day, new.monthly_day,
                        coalesce(new.last_fired_at, now()));
  return new;
end;
$$;
drop trigger if exists playbook_schedules_next_fire on playbook_schedules;
create trigger playbook_schedules_next_fire
  before insert or update of cadence, run_at_hour, weekly_day, monthly_day, active, last_fired_at
  on playbook_schedules
  for each row execute function playbook_schedules_compute_next();

-- ============================================================
-- TABLE: playbook_event_rules
-- ============================================================
create table if not exists playbook_event_rules (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  definition_id  uuid not null references playbook_definitions(id) on delete cascade,
  event_key      text not null check (event_key in ('invoice_overdue', 'ticket_synced_high_priority')),
  params         jsonb not null default '{}'::jsonb,
  cooldown_hours integer not null default 24 check (cooldown_hours between 1 and 720),
  active         boolean not null default true,
  last_fired_at  timestamptz,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists playbook_event_rules_tenant_idx on playbook_event_rules(tenant_id);

alter table playbook_event_rules enable row level security;
drop policy if exists "playbook_event_rules_tenant_isolation" on playbook_event_rules;
create policy "playbook_event_rules_tenant_isolation" on playbook_event_rules
  for all
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()))
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

drop trigger if exists playbook_event_rules_updated_at on playbook_event_rules;
create trigger playbook_event_rules_updated_at
  before update on playbook_event_rules
  for each row execute function update_updated_at();

-- ============================================================
-- TABLE: playbook_trigger_fires — the firing log (read-only to clients)
-- ============================================================
create table if not exists playbook_trigger_fires (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  source            text not null check (source in ('schedule', 'event')),
  schedule_id       uuid references playbook_schedules(id) on delete set null,
  event_rule_id     uuid references playbook_event_rules(id) on delete set null,
  definition_id     uuid references playbook_definitions(id) on delete set null,
  target_account_id uuid,
  target_ref        text,          -- e.g. invoice id / ticket id for event dedup
  run_id            uuid references playbook_runs(id) on delete set null,
  status            text not null default 'pending_start'
                      check (status in ('pending_start', 'started', 'skipped_dedup', 'error')),
  detail            text not null default '',
  fired_at          timestamptz not null default now()
);

create index if not exists playbook_trigger_fires_tenant_idx on playbook_trigger_fires(tenant_id, fired_at desc);
create index if not exists playbook_trigger_fires_pending_idx on playbook_trigger_fires(status) where status = 'pending_start';
create index if not exists playbook_trigger_fires_dedup_idx on playbook_trigger_fires(event_rule_id, target_ref, fired_at desc);

alter table playbook_trigger_fires enable row level security;
drop policy if exists "playbook_trigger_fires_tenant_select" on playbook_trigger_fires;
create policy "playbook_trigger_fires_tenant_select" on playbook_trigger_fires
  for select
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));
-- writes happen only via the SECURITY DEFINER dispatcher / service role

-- ============================================================
-- RPC: dispatch_due_triggers — pure-SQL trigger evaluation.
-- Inserts 'pending_start' fires; NEVER starts runs (no HTTP in SQL —
-- the playbook-execute 'dispatch' action turns fires into runs).
-- Schedule last/next_fire_at is stamped HERE, atomically with the fire
-- insert, so schedules can never double-fire even if the HTTP
-- processor crashes mid-batch.
-- ============================================================
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
      -- all_eligible: accounts with a renewal_date within N days (default 60)
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

    -- stamp: the before-update trigger recomputes next_fire_at from last_fired_at
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
          -- record the dedup decision ONCE per cooldown window (no log spam)
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
    end if;
  end loop;

  return jsonb_build_object('pending', v_pending, 'skipped_dedup', v_skipped);
end;
$$;

revoke all on function dispatch_due_triggers(uuid) from public;
grant execute on function dispatch_due_triggers(uuid) to service_role;
-- NOT granted to authenticated: tenant users reach dispatch only through
-- the playbook-execute edge function (which scopes to their tenant).

-- ============================================================
-- CRON WIRING — pg_cron + pg_net + Vault (all verified available).
-- invoke_playbook_dispatch() posts to the playbook-execute edge
-- function with the Vault-held secret. If the secret is missing the
-- function no-ops honestly (returns 'no_secret') instead of failing.
-- The secret VALUE is provisioned out of band — never in git.
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
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'playbook_dispatch_secret'
  limit 1;
  if v_secret is null then
    return 'no_secret';
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

  return 'queued:' || v_req_id::text;
end;
$$;

revoke all on function invoke_playbook_dispatch() from public;

-- Every 5 minutes. cron.schedule upserts by job name — idempotent.
select cron.schedule(
  'playbook-dispatch-5min',
  '*/5 * * * *',
  $$select invoke_playbook_dispatch()$$
);
