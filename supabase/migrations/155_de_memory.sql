-- ═══════════════════════════════════════════════════════════════
-- 155 — Durable DE memory (roadmap muscle #4)
--
-- A human employee remembers "this customer, this case, what we said
-- last week." Today the DE is amnesiac between invocations. This gives
-- every DE a persistent, embedding-backed memory it can write to and
-- retrieve from, scoped to an entity/case so recall is relevant.
--
-- This is MACHINERY: the store + write + hybrid-retrieve. The reasoning
-- layer (agentic loop / de-answer, gated on ANTHROPIC_API_KEY) decides
-- WHAT to remember and reads it back into context. Embeddings are the
-- free gte-small 384-dim vectors (_shared/knowledgeEmbed.ts), computed
-- in the edge runtime and passed in — same pattern as knowledge search
-- (migration 046). Null embedding degrades to recency+salience recall.
-- ═══════════════════════════════════════════════════════════════

create extension if not exists vector;

create table if not exists de_memory (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  de_id            uuid not null references digital_employees(id) on delete cascade,
  -- What this memory is anchored to, so recall is scoped (a Collections
  -- DE recalls THIS account's history, not every account's).
  subject_kind     text not null default 'general'
                     check (subject_kind in ('general', 'entity', 'case', 'conversation')),
  subject_ref      text,                       -- e.g. customer_accounts.id, de_conversations.id
  kind             text not null default 'episodic'
                     check (kind in ('episodic', 'semantic', 'fact', 'preference')),
  content          text not null,
  embedding        vector(384),
  salience         numeric not null default 0.5 check (salience >= 0 and salience <= 1),
  source           text not null default 'de'
                     check (source in ('de', 'human', 'system', 'ingestion')),
  created_at       timestamptz not null default now(),
  last_accessed_at timestamptz,
  expires_at       timestamptz                 -- optional TTL for ephemeral episodic notes
);

create index if not exists de_memory_lookup_idx
  on de_memory (tenant_id, de_id, subject_kind, subject_ref, created_at desc);
create index if not exists de_memory_expiry_idx
  on de_memory (expires_at) where expires_at is not null;

alter table de_memory enable row level security;

-- Read: any member of the owning tenant (memory can contain sensitive
-- case detail, so tenant-scoped only). Writes go through the SECURITY
-- DEFINER RPC below / service-role edge function, never direct client
-- INSERT — so there is deliberately no INSERT/UPDATE policy.
drop policy if exists de_memory_tenant_read on de_memory;
create policy de_memory_tenant_read on de_memory
  for select using (
    tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
    or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform')
  );

-- ── de_memory_write ──────────────────────────────────────────────
-- Embedding is computed in the edge runtime and passed in (nullable).
create or replace function public.de_memory_write(
  p_tenant_id    uuid,
  p_de_id        uuid,
  p_content      text,
  p_embedding    vector(384) default null,
  p_subject_kind text default 'general',
  p_subject_ref  text default null,
  p_kind         text default 'episodic',
  p_salience     numeric default 0.5,
  p_source       text default 'de',
  p_expires_at   timestamptz default null
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid;
begin
  -- Caller must be service_role (edge functions) or a member of the
  -- tenant. auth.uid() is null under service_role, so the membership
  -- check is skipped for it; a signed-in user must belong to p_tenant_id.
  if auth.uid() is not null
     and not exists (select 1 from profiles p where p.user_id = auth.uid()
                       and (p.tenant_id = p_tenant_id or p.layer = 'platform')) then
    raise exception 'not authorized to write memory for this tenant';
  end if;
  if p_content is null or btrim(p_content) = '' then
    raise exception 'memory content required';
  end if;

  insert into de_memory (tenant_id, de_id, subject_kind, subject_ref, kind,
                         content, embedding, salience, source, expires_at)
  values (p_tenant_id, p_de_id, p_subject_kind, p_subject_ref, p_kind,
          p_content, p_embedding, greatest(0, least(1, coalesce(p_salience, 0.5))),
          p_source, p_expires_at)
  returning id into v_id;
  return v_id;
end;
$function$;

-- ── de_memory_search ─────────────────────────────────────────────
-- Blended recall: semantic distance (when an embedding is given) +
-- recency + salience. Scoped to the DE, optionally to a subject. Not-
-- yet-expired only. Touches last_accessed_at on the returned rows.
create or replace function public.de_memory_search(
  p_tenant_id       uuid,
  p_de_id           uuid,
  p_query_embedding vector(384) default null,
  p_subject_kind    text default null,
  p_subject_ref     text default null,
  p_kinds           text[] default null,
  p_match_count     int default 8
) returns table (
  id uuid, content text, kind text, subject_kind text, subject_ref text,
  salience numeric, distance float, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is not null
     and not exists (select 1 from profiles p where p.user_id = auth.uid()
                       and (p.tenant_id = p_tenant_id or p.layer = 'platform')) then
    raise exception 'not authorized to read memory for this tenant';
  end if;

  return query
  select m.id, m.content, m.kind, m.subject_kind, m.subject_ref, m.salience,
         case when p_query_embedding is not null and m.embedding is not null
              then (m.embedding <=> p_query_embedding)::float else null end as distance,
         m.created_at
  from de_memory m
  where m.tenant_id = p_tenant_id
    and m.de_id = p_de_id
    and (m.expires_at is null or m.expires_at > now())
    and (p_subject_kind is null or m.subject_kind = p_subject_kind)
    and (p_subject_ref  is null or m.subject_ref  = p_subject_ref)
    and (p_kinds is null or m.kind = any(p_kinds))
  order by
    -- lower is better: semantic distance when available, else a recency+
    -- salience proxy (newer & more salient sort first).
    coalesce(case when p_query_embedding is not null and m.embedding is not null
                  then (m.embedding <=> p_query_embedding)::float end,
             1.0 - m.salience
               + least(0.5, extract(epoch from (now() - m.created_at)) / (86400.0 * 60)))
    asc
  limit greatest(1, least(50, p_match_count));
end;
$function$;

revoke all on function public.de_memory_write(uuid, uuid, text, vector, text, text, text, numeric, text, timestamptz) from public, anon;
grant execute on function public.de_memory_write(uuid, uuid, text, vector, text, text, text, numeric, text, timestamptz) to authenticated, service_role;
revoke all on function public.de_memory_search(uuid, uuid, vector, text, text, text[], int) from public, anon;
grant execute on function public.de_memory_search(uuid, uuid, vector, text, text, text[], int) to authenticated, service_role;
