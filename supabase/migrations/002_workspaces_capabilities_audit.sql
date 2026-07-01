-- ============================================================
-- Migration 002: Workspaces, Departments, Capabilities, Audit
-- Run in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- ── workspaces ───────────────────────────────────────────────
-- Named business function areas within a tenant.
-- Replaces the free-text `workspace` field on digital_employees.

create table if not exists workspaces (
  id          uuid    primary key default gen_random_uuid(),
  tenant_id   uuid    not null references tenants(id) on delete cascade,
  name        text    not null,
  slug        text    not null,
  description text    not null default '',
  icon        text    not null default '⊞',
  color       text    not null default '#6366f1',
  status      text    not null default 'active'
                check (status in ('active', 'inactive', 'archived')),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, slug)
);

create trigger workspaces_updated_at
  before update on workspaces
  for each row execute function update_updated_at();

alter table workspaces enable row level security;

create policy "workspaces_tenant_read" on workspaces
  for select using (
    tenant_id in (
      select tenant_id from profiles where user_id = auth.uid()
    )
  );

create policy "workspaces_tenant_write" on workspaces
  for all using (
    tenant_id in (
      select tenant_id from profiles
      where user_id = auth.uid()
        and role in ('tenant_owner', 'tenant_admin')
    )
  );

-- ── departments ──────────────────────────────────────────────
-- Human org structure within a tenant.

create table if not exists departments (
  id           uuid    primary key default gen_random_uuid(),
  tenant_id    uuid    not null references tenants(id) on delete cascade,
  name         text    not null,
  description  text    not null default '',
  head_name    text,
  color        text    not null default '#6366f1',
  member_count integer not null default 0,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger departments_updated_at
  before update on departments
  for each row execute function update_updated_at();

alter table departments enable row level security;

create policy "departments_tenant_read" on departments
  for select using (
    tenant_id in (
      select tenant_id from profiles where user_id = auth.uid()
    )
  );

create policy "departments_tenant_write" on departments
  for all using (
    tenant_id in (
      select tenant_id from profiles
      where user_id = auth.uid()
        and role in ('tenant_owner', 'tenant_admin', 'tenant_manager')
    )
  );

-- ── capabilities ─────────────────────────────────────────────
-- Atomic, reusable business operations a Digital Employee can perform.
-- Replaces localStorage in useCapabilities.ts.

create table if not exists capabilities (
  id                   uuid    primary key default gen_random_uuid(),
  tenant_id            uuid    not null references tenants(id) on delete cascade,
  slug                 text,   -- stable identifier for seeded capabilities
  name                 text    not null,
  description          text    not null default '',
  workspace            text    not null default '',
  icon                 text    not null default '⚡',
  status               text    not null default 'active'
                         check (status in ('active', 'disabled', 'draft')),
  risk_level           text    not null default 'low'
                         check (risk_level in ('low', 'medium', 'high')),
  approval_required    boolean not null default false,
  inputs               text[]  not null default '{}',
  outputs              text[]  not null default '{}',
  required_connectors  text[]  not null default '{}',
  required_knowledge   text[]  not null default '{}',
  assigned_des         text[]  not null default '{}',   -- DE IDs or catalog slugs
  run_count            integer not null default 0,
  avg_confidence       numeric(5,2),
  last_run_at          timestamptz,
  created_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (tenant_id, slug)
);

create trigger capabilities_updated_at
  before update on capabilities
  for each row execute function update_updated_at();

alter table capabilities enable row level security;

create policy "capabilities_tenant_read" on capabilities
  for select using (
    tenant_id in (
      select tenant_id from profiles where user_id = auth.uid()
    )
  );

create policy "capabilities_tenant_write" on capabilities
  for all using (
    tenant_id in (
      select tenant_id from profiles
      where user_id = auth.uid()
        and role in ('tenant_owner', 'tenant_admin', 'tenant_manager')
    )
  );

-- ── audit_logs ───────────────────────────────────────────────
-- Immutable record of every create/update/delete action.
-- Written by services; never mutated.

create table if not exists audit_logs (
  id            uuid    primary key default gen_random_uuid(),
  tenant_id     uuid    references tenants(id) on delete set null,
  actor_user_id uuid,
  action        text    not null,   -- 'create' | 'update' | 'delete' | 'hire' | 'dismiss' | 'advance_lifecycle' | ...
  entity_type   text    not null,   -- 'digital_employee' | 'playbook' | 'capability' | 'department' | ...
  entity_id     uuid,
  entity_name   text,
  before_data   jsonb,
  after_data    jsonb,
  metadata      jsonb   not null default '{}',
  created_at    timestamptz not null default now()
);

-- Audit logs are append-only — no update/delete policies on purpose.
alter table audit_logs enable row level security;

create policy "audit_logs_tenant_read" on audit_logs
  for select using (
    tenant_id in (
      select tenant_id from profiles where user_id = auth.uid()
    )
  );

-- Inserts are allowed for any authenticated user belonging to the same tenant.
-- Service role bypasses RLS for server-side writes.
create policy "audit_logs_tenant_insert" on audit_logs
  for insert with check (
    tenant_id in (
      select tenant_id from profiles where user_id = auth.uid()
    )
  );

-- ── ai_usage_events ──────────────────────────────────────────
-- Lightweight schema for tracking every future AI call.
-- No business logic yet — schema only.

create table if not exists ai_usage_events (
  id                   uuid    primary key default gen_random_uuid(),
  tenant_id            uuid    references tenants(id) on delete set null,
  workspace_id         uuid,
  capability_id        uuid,
  digital_employee_id  uuid,
  playbook_id          uuid,
  actor_user_id        uuid,
  model_provider       text    not null default '',
  model_name           text    not null default '',
  input_tokens         integer not null default 0,
  output_tokens        integer not null default 0,
  estimated_cost_usd   numeric(10,6) not null default 0,
  purpose              text    not null default '',
  duration_ms          integer,
  success              boolean not null default true,
  metadata             jsonb   not null default '{}',
  created_at           timestamptz not null default now()
);

alter table ai_usage_events enable row level security;

create policy "ai_usage_tenant_read" on ai_usage_events
  for select using (
    tenant_id in (
      select tenant_id from profiles where user_id = auth.uid()
    )
  );
