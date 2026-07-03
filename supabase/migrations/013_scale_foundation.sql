-- ============================================================
-- Migration 013: Scale foundation (P2.5)
--   1. Account dimension — reuse customer_accounts as the
--      Tenant → Account level (four-level tenancy). Adds
--      external_ref/tier to customer_accounts and nullable
--      account_id to knowledge/conversation/activity tables.
--      (support_tickets & renewal_invoices already carry it.)
--   2. knowledge_doc_chunks — 384-dim gte-small embeddings over
--      knowledge_docs (NEW table: legacy knowledge_chunks from
--      006 is 1536-dim and article-based; left untouched).
--   3. answer_cache — semantic answer cache (schema + RPCs;
--      writes stay dormant until an LLM key exists).
--   4. usage_metrics — per-tenant daily counters + RPCs.
-- ============================================================

create extension if not exists vector;

-- ============================================================
-- 1. ACCOUNT DIMENSION
-- ============================================================
alter table customer_accounts add column if not exists external_ref text;
alter table customer_accounts add column if not exists tier text;
create index if not exists customer_accounts_external_ref_idx
  on customer_accounts(tenant_id, external_ref);

alter table knowledge_docs    add column if not exists account_id uuid references customer_accounts(id) on delete set null;
alter table de_conversations  add column if not exists account_id uuid references customer_accounts(id) on delete set null;
alter table de_messages       add column if not exists account_id uuid references customer_accounts(id) on delete set null;
alter table activity_events   add column if not exists account_id uuid references customer_accounts(id) on delete set null;
alter table human_tasks       add column if not exists account_id uuid references customer_accounts(id) on delete set null;

create index if not exists knowledge_docs_account_idx   on knowledge_docs(account_id);
create index if not exists de_conversations_account_idx on de_conversations(account_id);
create index if not exists de_messages_account_idx      on de_messages(account_id);
create index if not exists activity_events_account_idx  on activity_events(account_id);
create index if not exists human_tasks_account_idx      on human_tasks(account_id);

-- ============================================================
-- 2. KNOWLEDGE DOC CHUNKS (vector retrieval, gte-small = 384)
-- ============================================================
create table if not exists knowledge_doc_chunks (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  account_id  uuid references customer_accounts(id) on delete set null,
  doc_id      uuid not null references knowledge_docs(id) on delete cascade,
  chunk_index integer not null default 0,
  content     text not null,
  embedding   vector(384),
  created_at  timestamptz not null default now()
);

create index if not exists knowledge_doc_chunks_tenant_idx on knowledge_doc_chunks(tenant_id);
create index if not exists knowledge_doc_chunks_doc_idx    on knowledge_doc_chunks(doc_id);
create index if not exists knowledge_doc_chunks_embedding_idx
  on knowledge_doc_chunks using hnsw (embedding vector_cosine_ops);

alter table knowledge_doc_chunks enable row level security;

drop policy if exists "knowledge_doc_chunks_tenant_isolation" on knowledge_doc_chunks;
create policy "knowledge_doc_chunks_tenant_isolation" on knowledge_doc_chunks
  for all
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()))
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

-- Account-first chunk retrieval. SECURITY DEFINER with a tenant
-- guard: authenticated callers may only query their own tenant;
-- the service role (auth.uid() is null) is trusted (edge functions).
create or replace function match_doc_chunks(
  p_tenant_id       uuid,
  p_account_id      uuid,
  p_query_embedding vector(384),
  p_match_count     int default 5
)
returns table (id uuid, doc_id uuid, content text, account_id uuid, distance float)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and p_tenant_id not in
     (select tenant_id from profiles where user_id = auth.uid()) then
    raise exception 'tenant access denied';
  end if;
  return query
  select c.id, c.doc_id, c.content, c.account_id,
         (c.embedding <=> p_query_embedding)::float as distance
  from knowledge_doc_chunks c
  where c.tenant_id = p_tenant_id
    and c.embedding is not null
    and (c.account_id is null or (p_account_id is not null and c.account_id = p_account_id))
  order by
    (c.account_id is not null and c.account_id = p_account_id) desc, -- account overlay first
    c.embedding <=> p_query_embedding
  limit p_match_count;
end;
$$;

-- ============================================================
-- 3. SEMANTIC ANSWER CACHE
-- ============================================================
create table if not exists answer_cache (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  account_id         uuid references customer_accounts(id) on delete set null,
  question           text not null,
  question_embedding vector(384),
  answer             text not null,
  confidence         integer not null default 0 check (confidence between 0 and 100),
  sources            jsonb not null default '[]',
  hits               integer not null default 0,
  verified_at        timestamptz not null default now(),
  invalidated        boolean not null default false
);

create index if not exists answer_cache_tenant_idx on answer_cache(tenant_id);
create index if not exists answer_cache_embedding_idx
  on answer_cache using hnsw (question_embedding vector_cosine_ops);

alter table answer_cache enable row level security;

drop policy if exists "answer_cache_tenant_isolation" on answer_cache;
create policy "answer_cache_tenant_isolation" on answer_cache
  for all
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()))
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

-- Nearest valid cached answer (account-first), or nothing.
create or replace function match_cached_answer(
  p_tenant_id       uuid,
  p_account_id      uuid,
  p_query_embedding vector(384),
  p_max_distance    float default 0.15
)
returns table (id uuid, answer text, confidence integer, sources jsonb, distance float)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and p_tenant_id not in
     (select tenant_id from profiles where user_id = auth.uid()) then
    raise exception 'tenant access denied';
  end if;
  return query
  select a.id, a.answer, a.confidence, a.sources,
         (a.question_embedding <=> p_query_embedding)::float as distance
  from answer_cache a
  where a.tenant_id = p_tenant_id
    and a.invalidated = false
    and a.question_embedding is not null
    and (a.account_id is null or (p_account_id is not null and a.account_id = p_account_id))
    and (a.question_embedding <=> p_query_embedding) < p_max_distance
  order by
    (a.account_id is not null and a.account_id = p_account_id) desc,
    a.question_embedding <=> p_query_embedding
  limit 1;
end;
$$;

-- Cache invalidation: any knowledge change invalidates the
-- tenant's cached answers (trigger, so no code path can forget).
create or replace function invalidate_answer_cache()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update answer_cache
    set invalidated = true
    where tenant_id = coalesce(new.tenant_id, old.tenant_id)
      and invalidated = false;
  return coalesce(new, old);
end;
$$;

drop trigger if exists knowledge_docs_invalidate_cache on knowledge_docs;
create trigger knowledge_docs_invalidate_cache
  after insert or update or delete on knowledge_docs
  for each row execute function invalidate_answer_cache();

-- ============================================================
-- 4. USAGE METRICS
-- ============================================================
create table if not exists usage_metrics (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  day       date not null default current_date,
  metric    text not null,
  value     bigint not null default 0,
  unique (tenant_id, day, metric)
);

create index if not exists usage_metrics_tenant_idx on usage_metrics(tenant_id, day);

alter table usage_metrics enable row level security;

drop policy if exists "usage_metrics_tenant_read" on usage_metrics;
create policy "usage_metrics_tenant_read" on usage_metrics
  for select
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));
-- No insert/update policies: writes only via SECURITY DEFINER RPCs below.

-- Authenticated path: tenant derived from the caller's profile.
create or replace function increment_metric(p_metric text, p_delta bigint default 1)
returns void language plpgsql security definer set search_path = public as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from profiles where user_id = auth.uid() limit 1;
  if v_tenant is null then raise exception 'no tenant for caller'; end if;
  insert into usage_metrics (tenant_id, day, metric, value)
    values (v_tenant, current_date, p_metric, p_delta)
    on conflict (tenant_id, day, metric)
    do update set value = usage_metrics.value + excluded.value;
end;
$$;

-- Service-role path (edge functions pass the tenant explicitly).
create or replace function increment_metric_tenant(p_tenant_id uuid, p_metric text, p_delta bigint default 1)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then
    raise exception 'service role only';
  end if;
  insert into usage_metrics (tenant_id, day, metric, value)
    values (p_tenant_id, current_date, p_metric, p_delta)
    on conflict (tenant_id, day, metric)
    do update set value = usage_metrics.value + excluded.value;
end;
$$;

revoke execute on function increment_metric_tenant(uuid, text, bigint) from anon, authenticated;
