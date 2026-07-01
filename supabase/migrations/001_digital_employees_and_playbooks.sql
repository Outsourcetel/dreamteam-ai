-- ============================================================
-- Migration 001: Digital Employees + Playbooks
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- ── Shared updated_at trigger function (idempotent) ──────────
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================
-- TABLE: digital_employees
-- The core Digital Workforce entity. One row per Digital
-- Employee hired by a tenant. RLS-isolated per tenant.
-- ============================================================

create table if not exists digital_employees (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,

  -- Origin
  catalog_id           text,          -- which DE_CATALOG entry this was based on (null = custom)

  -- Identity
  name                 text not null,
  persona_name         text,          -- customer-visible name if different from internal name
  description          text not null default '',
  icon                 text not null default 'D',
  category             text not null default 'Customer'
                         check (category in ('Customer', 'Internal')),
  department           text not null default '',
  workspace            text not null default '', -- business function / Workspace name

  -- Status & Governance
  status               text not null default 'idle'
                         check (status in ('active', 'idle', 'disabled')),
  lifecycle_status     text not null default 'designed'
                         check (lifecycle_status in (
                           'designed', 'configured', 'trained', 'tested',
                           'certified', 'published', 'assigned', 'active',
                           'improving', 'paused', 'retired', 'archived'
                         )),
  trust_level          text not null default 'supervised'
                         check (trust_level in (
                           'supervised', 'established', 'trusted', 'autonomous'
                         )),

  -- Operational Configuration
  capabilities         text[]   not null default '{}',
  responsibilities     text[]   not null default '{}',
  channels             text[]   not null default '{}',
  knowledge_sources    text[]   not null default '{}',
  tags                 text[]   not null default '{}',
  confidence_threshold integer  not null default 75
                         check (confidence_threshold between 0 and 100),
  required_approval    boolean  not null default false,

  -- Skills (array of {name, proficiency: 1-5, evidence: string})
  skills               jsonb    not null default '[]'::jsonb,

  -- Model Configuration ({provider, model, temperature, max_tokens, system_prompt, rag_enabled, rag_top_k})
  model_config         jsonb    not null default '{}'::jsonb,

  -- Performance (updated by execution engine / admin)
  tasks_this_month     integer  not null default 0,
  success_rate         numeric(5,2) not null default 100.00,
  fte_equivalent       numeric(8,4),

  -- Audit
  created_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Indexes
create index if not exists de_tenant_idx         on digital_employees(tenant_id);
create index if not exists de_tenant_status_idx  on digital_employees(tenant_id, status);
create index if not exists de_tenant_category_idx on digital_employees(tenant_id, category);

-- RLS
alter table digital_employees enable row level security;

drop policy if exists "de_tenant_isolation" on digital_employees;
create policy "de_tenant_isolation" on digital_employees
  for all
  using (
    tenant_id = (
      select tenant_id from profiles
      where user_id = auth.uid()
      limit 1
    )
  );

-- Updated-at trigger
drop trigger if exists digital_employees_updated_at on digital_employees;
create trigger digital_employees_updated_at
  before update on digital_employees
  for each row execute function update_updated_at();


-- ============================================================
-- TABLE: playbooks
-- Governing business process specifications. Each Playbook
-- belongs to a tenant and optionally to a Digital Employee.
-- Supports inheritance via parent_playbook_id.
-- ============================================================

create table if not exists playbooks (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete cascade,

  -- Ownership & Hierarchy
  digital_employee_id   uuid references digital_employees(id) on delete set null,
  parent_playbook_id    uuid references playbooks(id) on delete set null,  -- inheritance

  -- Identity
  name                  text not null,
  slug                  text not null,
  version               integer not null default 1,
  domain                text not null default '',  -- billing, customer_support, finance…
  business_objective    text not null default '',
  owner_role            text,

  -- Risk & Governance
  risk_level            text not null default 'low'
                          check (risk_level in ('low', 'medium', 'high', 'critical')),
  lifecycle_status      text not null default 'designed'
                          check (lifecycle_status in (
                            'designed', 'drafted', 'configured', 'tested',
                            'simulated', 'certified', 'published', 'assigned',
                            'active', 'improving', 'deprecated', 'retired'
                          )),
  is_base_playbook      boolean not null default false,  -- true = can be inherited

  -- Trigger
  trigger_type          text not null default 'inbound_request'
                          check (trigger_type in (
                            'inbound_request', 'api_call', 'scheduled', 'event',
                            'workflow_step', 'human_initiated', 'threshold_breach'
                          )),

  -- Operational Definition (structured JSON sections)
  capabilities_used     text[]  not null default '{}',
  knowledge_collections text[]  not null default '{}',
  connector_requirements jsonb  not null default '[]'::jsonb,
  human_approval_required boolean not null default false,
  approval_points       jsonb   not null default '[]'::jsonb,
  decision_rules        jsonb   not null default '[]'::jsonb,
  escalation_rules      jsonb   not null default '[]'::jsonb,
  exception_handlers    jsonb   not null default '[]'::jsonb,
  expected_outputs      jsonb   not null default '[]'::jsonb,

  -- KPIs  [{name, target, unit, current_value}]
  kpis                  jsonb   not null default '[]'::jsonb,

  -- Performance Estimates & Actuals
  estimated_duration_ms integer,
  estimated_cost_usd    numeric(10,4),
  tasks_this_month      integer not null default 0,
  success_rate          numeric(5,2) not null default 0,
  de_handled_rate       numeric(5,2) not null default 0,  -- % handled without human intervention

  -- Certification
  certified_by          uuid,
  certified_at          timestamptz,
  next_review_due       date,

  -- Audit
  created_by            uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Unique slug per tenant + version
create unique index if not exists playbooks_tenant_slug_version
  on playbooks(tenant_id, slug, version);

-- Indexes
create index if not exists pb_tenant_idx    on playbooks(tenant_id);
create index if not exists pb_de_idx        on playbooks(digital_employee_id);
create index if not exists pb_domain_idx    on playbooks(tenant_id, domain);
create index if not exists pb_lifecycle_idx on playbooks(tenant_id, lifecycle_status);

-- RLS
alter table playbooks enable row level security;

drop policy if exists "pb_tenant_isolation" on playbooks;
create policy "pb_tenant_isolation" on playbooks
  for all
  using (
    tenant_id = (
      select tenant_id from profiles
      where user_id = auth.uid()
      limit 1
    )
  );

-- Updated-at trigger
drop trigger if exists playbooks_updated_at on playbooks;
create trigger playbooks_updated_at
  before update on playbooks
  for each row execute function update_updated_at();


-- ============================================================
-- TABLE: de_playbook_assignments
-- Many-to-many: a DE can run multiple Playbooks;
-- a Playbook can be assigned to multiple DEs.
-- ============================================================

create table if not exists de_playbook_assignments (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  digital_employee_id  uuid not null references digital_employees(id) on delete cascade,
  playbook_id          uuid not null references playbooks(id) on delete cascade,
  assigned_at          timestamptz not null default now(),
  assigned_by          uuid,
  is_primary           boolean not null default false,  -- the DE's primary Playbook for a domain

  unique (digital_employee_id, playbook_id)
);

alter table de_playbook_assignments enable row level security;

drop policy if exists "dpa_tenant_isolation" on de_playbook_assignments;
create policy "dpa_tenant_isolation" on de_playbook_assignments
  for all
  using (
    tenant_id = (
      select tenant_id from profiles
      where user_id = auth.uid()
      limit 1
    )
  );


-- ============================================================
-- SEED: Platform-admin bypass policy (for Supabase service role)
-- Service role bypasses RLS automatically — no extra policy needed.
-- ============================================================

-- Done. Verify with:
-- select count(*) from digital_employees;
-- select count(*) from playbooks;
