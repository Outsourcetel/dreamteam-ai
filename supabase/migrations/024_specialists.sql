-- ============================================================
-- Migration 024: Specialist system v1 — Technical specialist first.
--
-- Founder intent (implemented structurally):
--   Specialists are consulted when completing tasks; highly
--   configurable; connect to knowledge/connectors/MCP/links/media;
--   per-source ACCESS MODE is the customer's choice (some companies
--   won't allow storing their data):
--     ingest      — content is stored/indexed in DreamTeam
--     fetch_only  — read at consult time, never persisted (read_through)
--     reference   — registered + cited, content not read in v1
--   Scribe sub-specialist ONLY writes back to connected systems,
--   with STRUCTURAL anti-hallucination guarantees (not prompt-based):
--     1. scribe_requests.consultation_id is FK NOT NULL — a write must
--        originate from a recorded consultation (the grounding chain)
--     2. payloads are built server-side from a whitelisted template per
--        action, interpolated from the consultation — never free text
--        composed by a model
--     3. every request creates a human_task (always-gated v1; trust
--        dial expansion is a later upgrade)
--     4. every write is audited with the consultation citation chain
--
-- ACCESS-MODE MATRIX (enforced by CHECK constraint):
--   knowledge   → ingest only            (it IS our stored knowledge)
--   connector   → ingest | fetch_only    (ingest = the connector's sync
--                 objects; fetch_only = read_through at consult time)
--   mcp_server  → fetch_only | reference (v1: registration + ping only —
--                 honest "full MCP session upgrade pending")
--   link        → reference              (url + note, cited)
--   media       → ingest                 (references media_assets)
--
-- Also: storage bucket 'specialist-media' (private, tenant-folder RLS).
-- LLM consultation path is DORMANT behind ANTHROPIC_API_KEY exactly
-- like de-answer; retrieval/config plumbing fully works now.
-- ============================================================

-- ============================================================
-- TABLE: specialist_profiles
-- ============================================================
create table if not exists specialist_profiles (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  key         text not null check (key in ('technical', 'legal', 'finance', 'people')),
  name        text not null,
  charter     text not null default '',
  status      text not null default 'active' check (status in ('active', 'paused')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, key)
);

create index if not exists specialist_profiles_tenant_idx on specialist_profiles(tenant_id);

alter table specialist_profiles enable row level security;

drop policy if exists "specialist_profiles_tenant_isolation" on specialist_profiles;
create policy "specialist_profiles_tenant_isolation" on specialist_profiles
  for all
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()))
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

drop trigger if exists specialist_profiles_updated_at on specialist_profiles;
create trigger specialist_profiles_updated_at
  before update on specialist_profiles
  for each row execute function update_updated_at();

-- ============================================================
-- TABLE: specialist_sources — per-source access-mode config
-- ============================================================
create table if not exists specialist_sources (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references specialist_profiles(id) on delete cascade,
  source_type  text not null check (source_type in ('knowledge', 'connector', 'mcp_server', 'link', 'media')),
  access_mode  text not null check (access_mode in ('ingest', 'fetch_only', 'reference')),
  label        text not null default '',
  config       jsonb not null default '{}'::jsonb,
  enabled      boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- THE ACCESS-MODE MATRIX — the customer's storage choice, enforced:
  constraint specialist_sources_mode_matrix check (
    (source_type = 'knowledge'  and access_mode = 'ingest') or
    (source_type = 'connector'  and access_mode in ('ingest', 'fetch_only')) or
    (source_type = 'mcp_server' and access_mode in ('fetch_only', 'reference')) or
    (source_type = 'link'       and access_mode = 'reference') or
    (source_type = 'media'      and access_mode = 'ingest')
  )
);

create index if not exists specialist_sources_profile_idx on specialist_sources(profile_id);

alter table specialist_sources enable row level security;

drop policy if exists "specialist_sources_tenant_isolation" on specialist_sources;
create policy "specialist_sources_tenant_isolation" on specialist_sources
  for all
  using (profile_id in (
    select sp.id from specialist_profiles sp
    join profiles p on p.tenant_id = sp.tenant_id
    where p.user_id = auth.uid()
  ))
  with check (profile_id in (
    select sp.id from specialist_profiles sp
    join profiles p on p.tenant_id = sp.tenant_id
    where p.user_id = auth.uid()
  ));

drop trigger if exists specialist_sources_updated_at on specialist_sources;
create trigger specialist_sources_updated_at
  before update on specialist_sources
  for each row execute function update_updated_at();

-- ============================================================
-- TABLE: specialist_source_secrets — MCP auth values, service-role
-- only (same isolation pattern as connector_secrets: RLS with NO
-- policies for authenticated; write path is the RPC below).
-- ============================================================
create table if not exists specialist_source_secrets (
  source_id   uuid primary key references specialist_sources(id) on delete cascade,
  secret      text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table specialist_source_secrets enable row level security;
-- deliberately NO policies: authenticated role has zero access.

drop trigger if exists specialist_source_secrets_updated_at on specialist_source_secrets;
create trigger specialist_source_secrets_updated_at
  before update on specialist_source_secrets
  for each row execute function update_updated_at();

create or replace function set_specialist_source_secret(
  p_source_id uuid,
  p_secret    text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and not exists (
    select 1
    from specialist_sources s
    join specialist_profiles sp on sp.id = s.profile_id
    join profiles p on p.tenant_id = sp.tenant_id
    where s.id = p_source_id and p.user_id = auth.uid()
  ) then
    raise exception 'not a member of this source''s tenant';
  end if;

  insert into specialist_source_secrets (source_id, secret)
  values (p_source_id, p_secret)
  on conflict (source_id) do update
    set secret = excluded.secret, updated_at = now();
end;
$$;

revoke all on function set_specialist_source_secret(uuid, text) from public;
grant execute on function set_specialist_source_secret(uuid, text) to authenticated, service_role;

-- ============================================================
-- TABLE: media_assets — documents/images/videos with quality flags.
-- extracted=false is the HONEST state for pdf/docx/video/image:
-- indexed by title/tags now; content extraction is the activation
-- upgrade. .txt/.md are extracted client-side into a linked
-- knowledge_doc at upload so they are consultable immediately.
-- ============================================================
create table if not exists media_assets (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  profile_id    uuid references specialist_profiles(id) on delete set null,
  kind          text not null check (kind in ('document', 'image', 'video')),
  title         text not null,
  storage_path  text not null,
  mime          text not null default '',
  size_bytes    bigint not null default 0,
  tags          text[] not null default '{}',
  sort_order    integer not null default 0,
  quality_flags jsonb not null default '[]'::jsonb,
  extracted     boolean not null default false,
  knowledge_doc_id uuid references knowledge_docs(id) on delete set null,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists media_assets_tenant_idx on media_assets(tenant_id);
create index if not exists media_assets_profile_idx on media_assets(profile_id) where profile_id is not null;

alter table media_assets enable row level security;

drop policy if exists "media_assets_tenant_isolation" on media_assets;
create policy "media_assets_tenant_isolation" on media_assets
  for all
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()))
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

drop trigger if exists media_assets_updated_at on media_assets;
create trigger media_assets_updated_at
  before update on media_assets
  for each row execute function update_updated_at();

-- ============================================================
-- TABLE: spec_consultations — every consult recorded (the grounding
-- chain the Scribe hangs off). Tenant read; writes via edge fn.
-- ============================================================
create table if not exists spec_consultations (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  profile_id    uuid not null references specialist_profiles(id) on delete cascade,
  requested_by  text not null default 'human' check (requested_by in ('human', 'de', 'playbook')),
  run_id        uuid,
  question      text not null,
  answer        text,
  confidence    integer check (confidence between 0 and 100),
  sources_used  jsonb not null default '[]'::jsonb,
  status        text not null default 'answered'
                  check (status in ('answered', 'blocked_llm', 'escalated', 'error')),
  created_at    timestamptz not null default now()
);

create index if not exists spec_consultations_tenant_idx on spec_consultations(tenant_id);
create index if not exists spec_consultations_profile_idx on spec_consultations(profile_id);

alter table spec_consultations enable row level security;

drop policy if exists "spec_consultations_tenant_select" on spec_consultations;
create policy "spec_consultations_tenant_select" on spec_consultations
  for select
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));
-- writes only via the service role (specialist-consult edge function)

-- ============================================================
-- TABLE: scribe_requests — the ONLY write path a specialist has into
-- connected systems. Structural guarantees documented at the top of
-- this file. consultation_id NOT NULL = no consultation, no write.
-- ============================================================
create table if not exists scribe_requests (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  profile_id       uuid not null references specialist_profiles(id) on delete cascade,
  consultation_id  uuid not null references spec_consultations(id) on delete restrict,
  connector_id     uuid not null references connectors(id) on delete cascade,
  action_key       text not null check (action_key in ('add_internal_note', 'update_status')),
  external_ref     text not null,
  payload          jsonb not null default '{}'::jsonb,
  payload_source   text not null default 'consultation_citation'
                     check (payload_source in ('consultation_citation')),
  status           text not null default 'pending_approval'
                     check (status in ('pending_approval', 'approved', 'executed', 'rejected', 'failed')),
  task_id          uuid references human_tasks(id) on delete set null,
  executed_at      timestamptz,
  result           jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists scribe_requests_tenant_idx on scribe_requests(tenant_id);
create index if not exists scribe_requests_task_idx on scribe_requests(task_id) where task_id is not null;

alter table scribe_requests enable row level security;

drop policy if exists "scribe_requests_tenant_select" on scribe_requests;
create policy "scribe_requests_tenant_select" on scribe_requests
  for select
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));
-- writes only via the service role (specialist-consult edge function)

drop trigger if exists scribe_requests_updated_at on scribe_requests;
create trigger scribe_requests_updated_at
  before update on scribe_requests
  for each row execute function update_updated_at();

-- ============================================================
-- RPC: install_technical_specialist — seeds the Technical profile
-- with a sensible tenant-editable charter. Idempotent.
-- ============================================================
create or replace function install_technical_specialist()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_id     uuid;
begin
  select tenant_id into v_tenant from profiles where user_id = auth.uid();
  if v_tenant is null then
    if coalesce(auth.role(), '') = 'service_role' then
      raise exception 'service role must use direct inserts with an explicit tenant';
    end if;
    return jsonb_build_object('error', 'no_tenant');
  end if;

  select id into v_id from specialist_profiles
    where tenant_id = v_tenant and key = 'technical';
  if v_id is not null then
    return jsonb_build_object('profile_id', v_id, 'already_installed', true);
  end if;

  insert into specialist_profiles (tenant_id, key, name, charter)
  values (
    v_tenant, 'technical', 'Technical Specialist',
    'You are the Technical Specialist — consulted for API, integration, architecture, and debugging questions that exceed a primary Digital Employee''s depth. Answer ONLY from the configured sources (knowledge documents, connected systems, registered references). Cite every source you use. If the sources do not support an answer, say so plainly and escalate — never guess. Escalate to a human whenever confidence falls below the floor.'
  )
  returning id into v_id;

  perform append_audit_event(
    v_tenant, 'You', 'human',
    'Technical Specialist installed — charter seeded, sources not yet configured',
    'config_change',
    jsonb_build_object('kind', 'specialist_profile', 'profile_id', v_id, 'key', 'technical')
  );

  return jsonb_build_object('profile_id', v_id, 'already_installed', false);
end;
$$;

revoke all on function install_technical_specialist() from public;
grant execute on function install_technical_specialist() to authenticated;

-- ============================================================
-- STORAGE: private bucket 'specialist-media', tenant-folder RLS.
-- Path convention: {tenant_id}/{uuid}-{filename}
-- ============================================================
insert into storage.buckets (id, name, public)
values ('specialist-media', 'specialist-media', false)
on conflict (id) do nothing;

drop policy if exists "specialist_media_tenant_select" on storage.objects;
create policy "specialist_media_tenant_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'specialist-media'
    and (storage.foldername(name))[1] in
        (select tenant_id::text from profiles where user_id = auth.uid())
  );

drop policy if exists "specialist_media_tenant_insert" on storage.objects;
create policy "specialist_media_tenant_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'specialist-media'
    and (storage.foldername(name))[1] in
        (select tenant_id::text from profiles where user_id = auth.uid())
  );

drop policy if exists "specialist_media_tenant_delete" on storage.objects;
create policy "specialist_media_tenant_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'specialist-media'
    and (storage.foldername(name))[1] in
        (select tenant_id::text from profiles where user_id = auth.uid())
  );
