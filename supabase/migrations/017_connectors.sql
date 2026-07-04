-- ============================================================
-- Migration 017: Systems-of-Record connector layer v1 (R2)
--
-- Doctrine (SCALING-ARCHITECTURE.md §Systems-of-Record):
--   DreamTeam never replaces a system of record. Connectors declare
--   per-object mode: 'sync' (cached working copy, TTL refresh) or
--   'read_through' (fetched at action time, never persisted).
--   Actions write BACK into the SoR. Our permanent data is the
--   judgment layer (audit chain) only.
--
-- Tables:
--   connectors         — tenant-scoped connector instances (Zendesk v1)
--   connector_secrets  — credentials, service-role-only (NO select
--                        policy for authenticated; writes only via
--                        SECURITY DEFINER RPCs)
--   connector_objects  — per-object mode registry (sync/read_through)
--   connector_actions  — write-back action registry (enable/disable)
--
-- Also:
--   support_tickets gains external_ref + source (working-cache key
--   for synced SoR tickets; unique on tenant+source+external_ref)
--   audit_events category constraint gains 'connector_sync' and
--   'connector_action'
-- ============================================================

-- ============================================================
-- TABLE: connectors
-- ============================================================
create table if not exists connectors (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  provider             text not null check (provider in ('zendesk')),
  display_name         text not null default '',
  base_url             text not null,
  status               text not null default 'disconnected'
                         check (status in ('connected', 'error', 'disconnected')),
  last_sync_at         timestamptz,
  last_error           text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists connectors_tenant_idx on connectors(tenant_id);

alter table connectors enable row level security;

drop policy if exists "connectors_tenant_isolation" on connectors;
create policy "connectors_tenant_isolation" on connectors
  for all
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()))
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

drop trigger if exists connectors_updated_at on connectors;
create trigger connectors_updated_at
  before update on connectors
  for each row execute function update_updated_at();

-- ============================================================
-- TABLE: connector_secrets — service-role-only credential store.
-- RLS enabled with NO policies for authenticated => tenant JWTs can
-- neither read nor write rows directly. Writes go through the
-- SECURITY DEFINER RPCs below; reads happen only in edge functions
-- via the service role. (Vault/KMS encryption is the hardening step.)
-- ============================================================
create table if not exists connector_secrets (
  connector_id  uuid primary key references connectors(id) on delete cascade,
  secret        text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table connector_secrets enable row level security;
-- deliberately NO policies: authenticated role has zero access.

drop trigger if exists connector_secrets_updated_at on connector_secrets;
create trigger connector_secrets_updated_at
  before update on connector_secrets
  for each row execute function update_updated_at();

-- ── set_connector_secret: the only tenant-facing write path. ──
create or replace function set_connector_secret(
  p_connector_id uuid,
  p_secret       text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and not exists (
    select 1
    from connectors c
    join profiles p on p.tenant_id = c.tenant_id
    where c.id = p_connector_id and p.user_id = auth.uid()
  ) then
    raise exception 'not a member of this connector''s tenant';
  end if;

  insert into connector_secrets (connector_id, secret)
  values (p_connector_id, p_secret)
  on conflict (connector_id) do update
    set secret = excluded.secret, updated_at = now();
end;
$$;

revoke all on function set_connector_secret(uuid, text) from public;
grant execute on function set_connector_secret(uuid, text) to authenticated, service_role;

-- ── purge_connector_secret: disconnect flow. ──
create or replace function purge_connector_secret(
  p_connector_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and not exists (
    select 1
    from connectors c
    join profiles p on p.tenant_id = c.tenant_id
    where c.id = p_connector_id and p.user_id = auth.uid()
  ) then
    raise exception 'not a member of this connector''s tenant';
  end if;

  delete from connector_secrets where connector_id = p_connector_id;
end;
$$;

revoke all on function purge_connector_secret(uuid) from public;
grant execute on function purge_connector_secret(uuid) to authenticated, service_role;

-- ============================================================
-- TABLE: connector_objects — per-object data mode
-- ============================================================
create table if not exists connector_objects (
  id                  uuid primary key default gen_random_uuid(),
  connector_id        uuid not null references connectors(id) on delete cascade,
  object_type         text not null check (object_type in ('ticket', 'user', 'organization')),
  mode                text not null default 'sync' check (mode in ('sync', 'read_through')),
  sync_interval_mins  integer not null default 60,
  last_synced_at      timestamptz,
  enabled             boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (connector_id, object_type)
);

create index if not exists connector_objects_connector_idx on connector_objects(connector_id);

alter table connector_objects enable row level security;

drop policy if exists "connector_objects_tenant_isolation" on connector_objects;
create policy "connector_objects_tenant_isolation" on connector_objects
  for all
  using (connector_id in (
    select c.id from connectors c
    join profiles p on p.tenant_id = c.tenant_id
    where p.user_id = auth.uid()
  ))
  with check (connector_id in (
    select c.id from connectors c
    join profiles p on p.tenant_id = c.tenant_id
    where p.user_id = auth.uid()
  ));

drop trigger if exists connector_objects_updated_at on connector_objects;
create trigger connector_objects_updated_at
  before update on connector_objects
  for each row execute function update_updated_at();

-- ============================================================
-- TABLE: connector_actions — write-back registry
-- ============================================================
create table if not exists connector_actions (
  id            uuid primary key default gen_random_uuid(),
  connector_id  uuid not null references connectors(id) on delete cascade,
  action_key    text not null check (action_key in ('add_internal_note', 'update_status')),
  enabled       boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (connector_id, action_key)
);

create index if not exists connector_actions_connector_idx on connector_actions(connector_id);

alter table connector_actions enable row level security;

drop policy if exists "connector_actions_tenant_isolation" on connector_actions;
create policy "connector_actions_tenant_isolation" on connector_actions
  for all
  using (connector_id in (
    select c.id from connectors c
    join profiles p on p.tenant_id = c.tenant_id
    where p.user_id = auth.uid()
  ))
  with check (connector_id in (
    select c.id from connectors c
    join profiles p on p.tenant_id = c.tenant_id
    where p.user_id = auth.uid()
  ));

drop trigger if exists connector_actions_updated_at on connector_actions;
create trigger connector_actions_updated_at
  before update on connector_actions
  for each row execute function update_updated_at();

-- ============================================================
-- support_tickets: working-cache identity for synced SoR tickets.
-- source = 'native' (created in DreamTeam) or the provider key
-- ('zendesk'). external_ref = the SoR's own id (Zendesk ticket id).
-- ============================================================
alter table support_tickets add column if not exists external_ref text;
alter table support_tickets add column if not exists source text not null default 'native';

create unique index if not exists support_tickets_source_ref_uniq
  on support_tickets(tenant_id, source, external_ref)
  where external_ref is not null;

-- ============================================================
-- audit_events: add connector categories to the check constraint
-- ============================================================
alter table audit_events drop constraint if exists audit_events_category_check;
alter table audit_events add constraint audit_events_category_check
  check (category in (
    'resolved', 'escalated', 'approval', 'guardrail_check', 'guardrail_block',
    'config_change', 'playbook_step', 'invoice',
    'connector_sync', 'connector_action'
  ));
