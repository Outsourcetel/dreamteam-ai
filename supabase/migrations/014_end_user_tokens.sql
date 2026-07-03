-- ============================================================
-- Migration 014: End-user widget surface (scale track)
-- Tables: widget_keys, end_user_sessions
-- widget_keys: publishable widget keys (sha256 hash only — the
--   plaintext key is shown once at generation and never stored).
-- end_user_sessions: end users are traffic, not seats — no auth
--   accounts; sessions are upserted by the widget-ask edge
--   function (service role). Tenant members get read-only view.
-- ============================================================

-- ============================================================
-- TABLE: widget_keys
-- ============================================================
create table if not exists widget_keys (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  key_hash      text not null unique,
  label         text not null default 'Default key',
  active        boolean not null default true,
  request_count bigint not null default 0,
  last_used_at  timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists widget_keys_tenant_idx on widget_keys(tenant_id);
create index if not exists widget_keys_hash_idx on widget_keys(key_hash) where active;

alter table widget_keys enable row level security;

drop policy if exists "widget_keys_tenant_isolation" on widget_keys;
create policy "widget_keys_tenant_isolation" on widget_keys
  for all
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()))
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

-- ============================================================
-- TABLE: end_user_sessions
-- Managed by the widget-ask edge function via service role;
-- tenant members are read-only.
-- ============================================================
create table if not exists end_user_sessions (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  account_external_ref text,
  end_user_ref         text,
  display_name         text,
  created_at           timestamptz not null default now(),
  last_seen_at         timestamptz not null default now()
);

create index if not exists end_user_sessions_tenant_idx on end_user_sessions(tenant_id);
create index if not exists end_user_sessions_account_idx
  on end_user_sessions(tenant_id, account_external_ref);
create unique index if not exists end_user_sessions_identity_idx
  on end_user_sessions(tenant_id, coalesce(account_external_ref, ''), coalesce(end_user_ref, ''));

alter table end_user_sessions enable row level security;

drop policy if exists "end_user_sessions_tenant_read" on end_user_sessions;
create policy "end_user_sessions_tenant_read" on end_user_sessions
  for select
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));
