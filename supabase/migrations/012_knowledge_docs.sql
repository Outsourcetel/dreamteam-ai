-- ============================================================
-- Migration 012: Knowledge docs + DE conversations (P2)
-- Tables: knowledge_docs, de_conversations, de_messages
-- All tenant-scoped with RLS via profiles(tenant_id) lookup,
-- same pattern as migration 011.
-- ============================================================

-- Shared updated_at trigger function (idempotent — also in 001/011)
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================
-- TABLE: knowledge_docs
-- ============================================================
create table if not exists knowledge_docs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  title       text not null,
  content     text not null default '',
  source      text not null default 'paste' check (source in ('upload', 'paste')),
  tags        text[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists knowledge_docs_tenant_idx on knowledge_docs(tenant_id);

alter table knowledge_docs enable row level security;

drop policy if exists "knowledge_docs_tenant_isolation" on knowledge_docs;
create policy "knowledge_docs_tenant_isolation" on knowledge_docs
  for all
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()))
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

drop trigger if exists knowledge_docs_updated_at on knowledge_docs;
create trigger knowledge_docs_updated_at
  before update on knowledge_docs
  for each row execute function update_updated_at();

-- ============================================================
-- TABLE: de_conversations
-- ============================================================
create table if not exists de_conversations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  channel     text not null default 'dock' check (channel in ('dock')),
  created_at  timestamptz not null default now()
);

create index if not exists de_conversations_tenant_idx on de_conversations(tenant_id);

alter table de_conversations enable row level security;

drop policy if exists "de_conversations_tenant_isolation" on de_conversations;
create policy "de_conversations_tenant_isolation" on de_conversations
  for all
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()))
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

-- ============================================================
-- TABLE: de_messages
-- ============================================================
create table if not exists de_messages (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  conversation_id uuid not null references de_conversations(id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null,
  confidence      integer check (confidence between 0 and 100),
  escalated       boolean not null default false,
  created_at      timestamptz not null default now()
);

create index if not exists de_messages_tenant_idx on de_messages(tenant_id);
create index if not exists de_messages_conversation_idx on de_messages(conversation_id, created_at);

alter table de_messages enable row level security;

drop policy if exists "de_messages_tenant_isolation" on de_messages;
create policy "de_messages_tenant_isolation" on de_messages
  for all
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()))
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));
