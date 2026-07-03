-- ============================================================
-- Migration 011: Customer entity — production data layer (P1)
-- Run this in: Supabase Dashboard → SQL Editor → New Query
--
-- Tables: customer_accounts, support_tickets, renewal_invoices,
--         human_tasks, activity_events
-- All tenant-scoped with RLS via profiles(tenant_id) lookup.
-- Money is stored in CENTS (bigint).
-- ============================================================

-- Shared updated_at trigger function (idempotent — also in 001)
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================
-- TABLE: customer_accounts
-- ============================================================
create table if not exists customer_accounts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  name          text not null,
  arr_cents     bigint not null default 0,
  health_score  integer not null default 70 check (health_score between 0 and 100),
  csm           text not null default '',
  status        text not null default 'active'
                  check (status in ('active', 'at_risk', 'churned')),
  renewal_date  date,
  notes         text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists customer_accounts_tenant_idx on customer_accounts(tenant_id);

alter table customer_accounts enable row level security;

drop policy if exists "customer_accounts_tenant_isolation" on customer_accounts;
create policy "customer_accounts_tenant_isolation" on customer_accounts
  for all
  using (
    tenant_id in (select tenant_id from profiles where user_id = auth.uid())
  )
  with check (
    tenant_id in (select tenant_id from profiles where user_id = auth.uid())
  );

drop trigger if exists customer_accounts_updated_at on customer_accounts;
create trigger customer_accounts_updated_at
  before update on customer_accounts
  for each row execute function update_updated_at();

-- ============================================================
-- TABLE: support_tickets
-- ============================================================
create table if not exists support_tickets (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  account_id    uuid references customer_accounts(id) on delete set null,
  subject       text not null,
  body          text not null default '',
  status        text not null default 'open'
                  check (status in ('open', 'pending', 'resolved', 'escalated')),
  priority      text not null default 'p3'
                  check (priority in ('p1', 'p2', 'p3', 'p4')),
  assignee      text not null default 'de'
                  check (assignee in ('de', 'human')),
  de_confidence integer check (de_confidence between 0 and 100),
  resolved_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists support_tickets_tenant_idx on support_tickets(tenant_id);
create index if not exists support_tickets_account_idx on support_tickets(account_id);

alter table support_tickets enable row level security;

drop policy if exists "support_tickets_tenant_isolation" on support_tickets;
create policy "support_tickets_tenant_isolation" on support_tickets
  for all
  using (
    tenant_id in (select tenant_id from profiles where user_id = auth.uid())
  )
  with check (
    tenant_id in (select tenant_id from profiles where user_id = auth.uid())
  );

drop trigger if exists support_tickets_updated_at on support_tickets;
create trigger support_tickets_updated_at
  before update on support_tickets
  for each row execute function update_updated_at();

-- ============================================================
-- TABLE: renewal_invoices
-- ============================================================
create table if not exists renewal_invoices (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  account_id    uuid not null references customer_accounts(id) on delete cascade,
  amount_cents  bigint not null default 0,
  status        text not null default 'pending_generation'
                  check (status in ('pending_generation', 'awaiting_approval', 'sent', 'paid', 'overdue')),
  due_date      date,
  cadence_stage integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists renewal_invoices_tenant_idx on renewal_invoices(tenant_id);
create index if not exists renewal_invoices_account_idx on renewal_invoices(account_id);

alter table renewal_invoices enable row level security;

drop policy if exists "renewal_invoices_tenant_isolation" on renewal_invoices;
create policy "renewal_invoices_tenant_isolation" on renewal_invoices
  for all
  using (
    tenant_id in (select tenant_id from profiles where user_id = auth.uid())
  )
  with check (
    tenant_id in (select tenant_id from profiles where user_id = auth.uid())
  );

drop trigger if exists renewal_invoices_updated_at on renewal_invoices;
create trigger renewal_invoices_updated_at
  before update on renewal_invoices
  for each row execute function update_updated_at();

-- ============================================================
-- TABLE: human_tasks
-- ============================================================
create table if not exists human_tasks (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  type          text not null default 'approval_gate'
                  check (type in ('approval_gate', 'review_gate', 'escalation', 'override', 'training_feedback')),
  title         text not null,
  detail        text not null default '',
  source        text not null default 'de'
                  check (source in ('de', 'chat', 'system')),
  related_table text,
  related_id    uuid,
  status        text not null default 'pending'
                  check (status in ('pending', 'approved', 'rejected')),
  decided_by    uuid,
  decided_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists human_tasks_tenant_idx on human_tasks(tenant_id);

alter table human_tasks enable row level security;

drop policy if exists "human_tasks_tenant_isolation" on human_tasks;
create policy "human_tasks_tenant_isolation" on human_tasks
  for all
  using (
    tenant_id in (select tenant_id from profiles where user_id = auth.uid())
  )
  with check (
    tenant_id in (select tenant_id from profiles where user_id = auth.uid())
  );

drop trigger if exists human_tasks_updated_at on human_tasks;
create trigger human_tasks_updated_at
  before update on human_tasks
  for each row execute function update_updated_at();

-- ============================================================
-- TABLE: activity_events (append-only activity feed)
-- ============================================================
create table if not exists activity_events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  actor       text not null default 'system',
  actor_type  text not null default 'system'
                check (actor_type in ('de', 'human', 'system')),
  event_type  text not null default 'config_change'
                check (event_type in ('resolved', 'escalated', 'kb_gap', 'error', 'config_change', 'approval')),
  text        text not null,
  confidence  integer check (confidence between 0 and 100),
  created_at  timestamptz not null default now()
);

create index if not exists activity_events_tenant_idx on activity_events(tenant_id);
create index if not exists activity_events_created_idx on activity_events(tenant_id, created_at desc);

alter table activity_events enable row level security;

drop policy if exists "activity_events_tenant_isolation" on activity_events;
create policy "activity_events_tenant_isolation" on activity_events
  for all
  using (
    tenant_id in (select tenant_id from profiles where user_id = auth.uid())
  )
  with check (
    tenant_id in (select tenant_id from profiles where user_id = auth.uid())
  );
