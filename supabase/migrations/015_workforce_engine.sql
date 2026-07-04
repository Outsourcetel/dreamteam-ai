-- ============================================================
-- Migration 015: Workforce Engine (P3)
--   1. guardrail_rules  — tenant-configurable guardrails enforced
--      in the real path (invoice gate now; LLM answer check dormant)
--   2. audit_events     — immutable, hash-chained audit log.
--      All writes go through append_audit_event() (SECURITY DEFINER),
--      which computes hash = sha256(prev_hash || tenant || action ||
--      detail || created_at). UPDATE/DELETE raise an exception.
--   3. playbook_runs    — one real playbook (renewal_v1) executed
--      end-to-end with a human approval gate.
-- ============================================================

create extension if not exists pgcrypto;

-- ============================================================
-- TABLE: guardrail_rules
-- ============================================================
create table if not exists guardrail_rules (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  rule        text not null,
  rule_type   text not null
                check (rule_type in ('blocked_topic', 'blocked_phrase', 'require_approval_over_cents', 'max_discount_pct')),
  pattern     text,
  threshold   bigint,
  applies_to  text not null default 'all',
  severity    text not null default 'blocking'
                check (severity in ('blocking', 'warning')),
  active      boolean not null default true,
  version     integer not null default 1,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists guardrail_rules_tenant_idx on guardrail_rules(tenant_id);

alter table guardrail_rules enable row level security;

drop policy if exists "guardrail_rules_tenant_isolation" on guardrail_rules;
create policy "guardrail_rules_tenant_isolation" on guardrail_rules
  for all
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()))
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

drop trigger if exists guardrail_rules_updated_at on guardrail_rules;
create trigger guardrail_rules_updated_at
  before update on guardrail_rules
  for each row execute function update_updated_at();

-- ============================================================
-- TABLE: audit_events (INSERT-only, hash-chained)
-- ============================================================
create table if not exists audit_events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  actor       text not null default 'system',
  actor_type  text not null default 'system'
                check (actor_type in ('de', 'human', 'system')),
  action      text not null,
  category    text not null
                check (category in ('resolved', 'escalated', 'approval', 'guardrail_check', 'guardrail_block', 'config_change', 'playbook_step', 'invoice')),
  detail      jsonb not null default '{}'::jsonb,
  prev_hash   text not null default '',
  hash        text not null,
  created_at  timestamptz not null default now()
);

create index if not exists audit_events_tenant_idx on audit_events(tenant_id);
create index if not exists audit_events_created_idx on audit_events(tenant_id, created_at desc);

alter table audit_events enable row level security;

-- Tenant members can read and insert (inserts normally go through the RPC).
-- NO update/delete policies exist — and a trigger enforces immutability
-- even for privileged roles.
drop policy if exists "audit_events_tenant_select" on audit_events;
create policy "audit_events_tenant_select" on audit_events
  for select
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

drop policy if exists "audit_events_tenant_insert" on audit_events;
create policy "audit_events_tenant_insert" on audit_events
  for insert
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

create or replace function audit_events_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_events is immutable — records can only be appended';
end;
$$;

drop trigger if exists audit_events_no_update_delete on audit_events;
create trigger audit_events_no_update_delete
  before update or delete on audit_events
  for each row execute function audit_events_immutable();

-- ── append_audit_event: the ONLY intended write path. ──
-- Serializes per tenant (advisory lock), reads the last hash, computes
-- the new chain hash, inserts. Callable by tenant members (JWT) and by
-- the service role (edge functions).
create or replace function append_audit_event(
  p_tenant_id  uuid,
  p_actor      text,
  p_actor_type text,
  p_action     text,
  p_category   text,
  p_detail     jsonb default '{}'::jsonb
) returns audit_events
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_prev text;
  v_now  timestamptz := clock_timestamp();
  v_hash text;
  v_row  audit_events;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not exists (
    select 1 from profiles where user_id = auth.uid() and tenant_id = p_tenant_id
  ) then
    raise exception 'not a member of this tenant';
  end if;

  perform pg_advisory_xact_lock(hashtext('audit_' || p_tenant_id::text));

  select hash into v_prev
  from audit_events
  where tenant_id = p_tenant_id
  order by created_at desc, id desc
  limit 1;
  v_prev := coalesce(v_prev, '');

  v_hash := encode(digest(
    v_prev || p_tenant_id::text || coalesce(p_action, '') ||
    coalesce(p_detail::text, '{}') || v_now::text,
    'sha256'), 'hex');

  insert into audit_events (tenant_id, actor, actor_type, action, category, detail, prev_hash, hash, created_at)
  values (
    p_tenant_id,
    coalesce(nullif(p_actor, ''), 'system'),
    coalesce(nullif(p_actor_type, ''), 'system'),
    p_action,
    p_category,
    coalesce(p_detail, '{}'::jsonb),
    v_prev,
    v_hash,
    v_now
  )
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function append_audit_event(uuid, text, text, text, text, jsonb) from public;
grant execute on function append_audit_event(uuid, text, text, text, text, jsonb) to authenticated, service_role;

-- ── verify_audit_chain: walks the tenant's chain server-side and
-- reports whether every link recomputes. ──
create or replace function verify_audit_chain(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  r          record;
  v_prev     text := '';
  v_expected text;
  v_checked  integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not exists (
    select 1 from profiles where user_id = auth.uid() and tenant_id = p_tenant_id
  ) then
    raise exception 'not a member of this tenant';
  end if;

  for r in
    select * from audit_events
    where tenant_id = p_tenant_id
    order by created_at asc, id asc
  loop
    v_expected := encode(digest(
      v_prev || r.tenant_id::text || coalesce(r.action, '') ||
      coalesce(r.detail::text, '{}') || r.created_at::text,
      'sha256'), 'hex');
    if r.prev_hash <> v_prev or r.hash <> v_expected then
      return jsonb_build_object('intact', false, 'checked', v_checked, 'broken_at', r.id);
    end if;
    v_prev := r.hash;
    v_checked := v_checked + 1;
  end loop;

  return jsonb_build_object('intact', true, 'checked', v_checked, 'broken_at', null);
end;
$$;

revoke all on function verify_audit_chain(uuid) from public;
grant execute on function verify_audit_chain(uuid) to authenticated, service_role;

-- ============================================================
-- TABLE: playbook_runs (renewal_v1 — one real playbook)
-- ============================================================
create table if not exists playbook_runs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  playbook_key    text not null default 'renewal_v1',
  account_id      uuid references customer_accounts(id) on delete set null,
  status          text not null default 'running'
                    check (status in ('running', 'waiting_approval', 'completed', 'cancelled')),
  current_step    integer not null default 0,
  steps           jsonb not null default '[]'::jsonb,
  waiting_task_id uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists playbook_runs_tenant_idx on playbook_runs(tenant_id);
create index if not exists playbook_runs_task_idx on playbook_runs(waiting_task_id) where waiting_task_id is not null;

alter table playbook_runs enable row level security;

drop policy if exists "playbook_runs_tenant_isolation" on playbook_runs;
create policy "playbook_runs_tenant_isolation" on playbook_runs
  for all
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()))
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

drop trigger if exists playbook_runs_updated_at on playbook_runs;
create trigger playbook_runs_updated_at
  before update on playbook_runs
  for each row execute function update_updated_at();
