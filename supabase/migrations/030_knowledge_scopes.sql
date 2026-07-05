-- ============================================================
-- Migration 030: PER-DE KNOWLEDGE SCOPES — optional doc-level
-- visibility for DEs/specialists, enforced in retrieval.
--
-- Closes the HONEST LIMIT documented in migration 029: "internal
-- knowledge_docs/chunks are NOT connector-gated — internal
-- knowledge remains tenant-wide in v1. Named upgrade: per-DE
-- knowledge scopes."
--
-- DESIGN (deliberately different default from connectors):
--   Connectors are DEFAULT-DENY (029) because they reach into the
--   customer's systems of record. Uploaded knowledge is content the
--   tenant explicitly gave the workforce, so the default here is
--   TENANT-WIDE-VISIBLE for backward compat and usability — with
--   OPTIONAL scoping on top:
--     • knowledge_docs.visibility: 'tenant' (default) | 'scoped'
--     • knowledge_doc_scopes: (doc, subject_kind de|specialist,
--       subject_id) — a 'scoped' doc is retrievable ONLY by the
--       listed subjects.
--   Scoping uses the SAME subject model as data_access_grants
--   (subject_kind 'de' | 'specialist') so it is one mental model.
--
-- ENFORCEMENT IS SERVER-SIDE, IN THE RETRIEVAL SQL:
--   • match_doc_chunks (vector path) gains p_subject_kind /
--     p_subject_id and joins knowledge_docs + knowledge_doc_scopes
--   • visible_knowledge_docs (NEW RPC) centralizes the previously
--     inline `select * from knowledge_docs` keyword-fallback
--     queries in de-answer / widget-ask / specialist-consult
--   A call with NO subject sees only tenant-visible docs (scoped
--   docs never leak to an unattributed path).
--
-- WRITES go through SECURITY DEFINER RPC set_doc_scope only:
--   empty subject list  → visibility flips back to 'tenant'
--   non-empty list      → visibility flips to 'scoped'
--   every change audited (access_control / knowledge_scope_changed)
--   and the doc row is touched so the answer-cache invalidation
--   trigger (migration 013) fires — cached answers derived from a
--   doc never outlive a scope change.
-- ============================================================

-- 1. visibility column
alter table knowledge_docs add column if not exists visibility text not null default 'tenant'
  check (visibility in ('tenant', 'scoped'));

-- 2. scopes join table
create table if not exists knowledge_doc_scopes (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  doc_id       uuid not null references knowledge_docs(id) on delete cascade,
  subject_kind text not null check (subject_kind in ('de', 'specialist')),
  subject_id   uuid not null,
  created_at   timestamptz not null default now(),
  unique (doc_id, subject_kind, subject_id)
);

create index if not exists knowledge_doc_scopes_tenant_idx on knowledge_doc_scopes(tenant_id);
create index if not exists knowledge_doc_scopes_doc_idx on knowledge_doc_scopes(doc_id);
create index if not exists knowledge_doc_scopes_subject_idx on knowledge_doc_scopes(tenant_id, subject_kind, subject_id);

alter table knowledge_doc_scopes enable row level security;

-- Tenant members can SEE scopes (transparency); ALL writes go through
-- the audited SECURITY DEFINER RPC below.
drop policy if exists "knowledge_doc_scopes_tenant_select" on knowledge_doc_scopes;
create policy "knowledge_doc_scopes_tenant_select" on knowledge_doc_scopes
  for select
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

-- ============================================================
-- RPC: set_doc_scope — replace a doc's scope list atomically.
--   p_subjects: jsonb array of {"kind":"de"|"specialist","id":uuid}
--   []  → clear scopes, visibility back to 'tenant'
--   [.] → validate every subject is in-tenant, replace, 'scoped'
-- Caller: any member of the doc's tenant (same trust level as doc
-- editing itself, which is member-RLS), or the service role.
-- ============================================================
create or replace function set_doc_scope(
  p_doc_id   uuid,
  p_subjects jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user        uuid := auth.uid();
  v_caller_tenant uuid;
  v_doc_tenant  uuid;
  v_doc_title   text;
  v_before      text;
  v_after       text;
  v_subj        jsonb;
  v_kind        text;
  v_sid         uuid;
  v_label       text;
  v_labels      text[] := '{}';
  v_count       integer := 0;
begin
  select tenant_id, title, visibility into v_doc_tenant, v_doc_title, v_before
    from knowledge_docs where id = p_doc_id;
  if v_doc_tenant is null then
    return jsonb_build_object('ok', false, 'error', 'doc_not_found');
  end if;

  -- Membership guard (JWT path); ONLY a genuine service_role connection
  -- is trusted without a JWT (same test append_audit_event uses) — an
  -- anon-key call with no bearer token must be rejected, not treated
  -- as trusted, or anyone could rescope any tenant's documents.
  if v_user is not null then
    select tenant_id into v_caller_tenant from profiles where user_id = v_user;
    if v_caller_tenant is null or v_caller_tenant <> v_doc_tenant then
      return jsonb_build_object('ok', false, 'error', 'not_tenant_member',
        'detail', 'Only members of this workspace can change who uses a document.');
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    return jsonb_build_object('ok', false, 'error', 'not_tenant_member',
      'detail', 'Only members of this workspace can change who uses a document.');
  end if;

  if p_subjects is null or jsonb_typeof(p_subjects) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'bad_subjects',
      'detail', 'p_subjects must be a JSON array of {kind, id}.');
  end if;

  -- Validate every subject belongs to the doc's tenant BEFORE writing.
  for v_subj in select * from jsonb_array_elements(p_subjects) loop
    v_kind := v_subj->>'kind';
    begin
      v_sid := (v_subj->>'id')::uuid;
    exception when others then
      return jsonb_build_object('ok', false, 'error', 'bad_subject_id');
    end;
    if v_kind = 'de' then
      select name into v_label from digital_employees where id = v_sid and tenant_id = v_doc_tenant;
    elsif v_kind = 'specialist' then
      select name into v_label from specialist_profiles where id = v_sid and tenant_id = v_doc_tenant;
    else
      return jsonb_build_object('ok', false, 'error', 'bad_subject_kind');
    end if;
    if v_label is null then
      return jsonb_build_object('ok', false, 'error', 'subject_not_in_tenant',
        'detail', v_kind || ' ' || v_sid || ' is not in this workspace.');
    end if;
    v_labels := array_append(v_labels, v_label || ' (' || v_kind || ')');
    v_count := v_count + 1;
  end loop;

  -- Replace scopes atomically.
  delete from knowledge_doc_scopes where doc_id = p_doc_id;
  for v_subj in select * from jsonb_array_elements(p_subjects) loop
    insert into knowledge_doc_scopes (tenant_id, doc_id, subject_kind, subject_id)
    values (v_doc_tenant, p_doc_id, v_subj->>'kind', (v_subj->>'id')::uuid)
    on conflict (doc_id, subject_kind, subject_id) do nothing;
  end loop;

  -- Visibility flips automatically; ALWAYS update the row so the
  -- answer-cache invalidation trigger (013) fires on any scope change.
  v_after := case when v_count > 0 then 'scoped' else 'tenant' end;
  update knowledge_docs set visibility = v_after where id = p_doc_id;

  -- Best-effort audit: append_audit_event requires either tenant
  -- membership on the JWT path or a genuine service_role connection;
  -- SQL-console/migration-context calls (auth.uid() null, role not
  -- service_role) are a legitimate trusted caller here (mirrors the
  -- seed_default_grants pattern in migration 029) but would otherwise
  -- raise — so this write must never fail because the audit line did.
  begin
    perform append_audit_event(
      v_doc_tenant,
      coalesce((select full_name from profiles where user_id = v_user), 'service'),
      case when v_user is null then 'system' else 'human' end,
      'Knowledge scope changed — "' || v_doc_title || '": ' || v_before || ' → ' || v_after
        || case when v_count > 0 then ' (only ' || array_to_string(v_labels, ', ') || ' will use this document)'
                else ' (all digital employees will use this document)' end,
      'access_control',
      jsonb_build_object('kind', 'knowledge_scope_changed', 'doc_id', p_doc_id,
        'doc_title', v_doc_title, 'before', v_before, 'after', v_after,
        'subjects', p_subjects, 'subject_labels', v_labels)
    );
  exception when others then null;
  end;

  return jsonb_build_object('ok', true, 'visibility', v_after, 'subjects', v_count);
end;
$$;

revoke all on function set_doc_scope(uuid, jsonb) from public;
grant execute on function set_doc_scope(uuid, jsonb) to authenticated, service_role;

-- ============================================================
-- match_doc_chunks — SUBJECT-AWARE (replaces the 013 version;
-- DROP first: the argument list changes). Same tenant guard.
-- Filter: doc is tenant-visible OR the calling subject is listed
-- in its scopes. No subject → tenant-visible docs only.
-- Returns doc visibility so callers can avoid caching answers
-- derived from scoped content.
-- ============================================================
drop function if exists match_doc_chunks(uuid, uuid, vector, int);
create or replace function match_doc_chunks(
  p_tenant_id       uuid,
  p_account_id      uuid,
  p_query_embedding vector(384),
  p_match_count     int default 5,
  p_subject_kind    text default null,
  p_subject_id      uuid default null
)
returns table (id uuid, doc_id uuid, content text, account_id uuid, distance float, visibility text)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and p_tenant_id not in
     (select tenant_id from profiles where user_id = auth.uid()) then
    raise exception 'tenant access denied';
  end if;
  return query
  select c.id, c.doc_id, c.content, c.account_id,
         (c.embedding <=> p_query_embedding)::float as distance,
         d.visibility
  from knowledge_doc_chunks c
  join knowledge_docs d on d.id = c.doc_id
  where c.tenant_id = p_tenant_id
    and c.embedding is not null
    and (c.account_id is null or (p_account_id is not null and c.account_id = p_account_id))
    and (
      d.visibility = 'tenant'
      or (p_subject_kind is not null and p_subject_id is not null and exists (
            select 1 from knowledge_doc_scopes s
            where s.doc_id = d.id
              and s.subject_kind = p_subject_kind
              and s.subject_id = p_subject_id))
    )
  order by
    (c.account_id is not null and c.account_id = p_account_id) desc, -- account overlay first
    c.embedding <=> p_query_embedding
  limit p_match_count;
end;
$$;

-- ============================================================
-- visible_knowledge_docs — centralizes the keyword-fallback doc
-- listing that de-answer / widget-ask / specialist-consult used
-- to run as inline `select * from knowledge_docs` (which would
-- have bypassed scoping). Same subject semantics as above.
-- ============================================================
create or replace function visible_knowledge_docs(
  p_tenant_id    uuid,
  p_subject_kind text default null,
  p_subject_id   uuid default null
)
returns table (id uuid, title text, content text, tags text[], visibility text)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and p_tenant_id not in
     (select tenant_id from profiles where user_id = auth.uid()) then
    raise exception 'tenant access denied';
  end if;
  return query
  select d.id, d.title, d.content, d.tags, d.visibility
  from knowledge_docs d
  where d.tenant_id = p_tenant_id
    and (
      d.visibility = 'tenant'
      or (p_subject_kind is not null and p_subject_id is not null and exists (
            select 1 from knowledge_doc_scopes s
            where s.doc_id = d.id
              and s.subject_kind = p_subject_kind
              and s.subject_id = p_subject_id))
    );
end;
$$;

revoke all on function visible_knowledge_docs(uuid, text, uuid) from public;
grant execute on function visible_knowledge_docs(uuid, text, uuid) to authenticated, service_role;
