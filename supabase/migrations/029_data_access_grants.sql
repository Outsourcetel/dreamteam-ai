-- ============================================================
-- Migration 029: DATA ACCESS GRANTS — default-deny, per-subject
-- (DE or specialist) × connected-system permissions.
--
-- Founder requirement: "we won't want a support DE having access
-- to company financials." Until now connectors were tenant-wide —
-- any DE's pipeline could touch any connector. This layer closes
-- that: every machine subject (a Digital Employee or a Specialist)
-- must hold an explicit grant to touch a connected system, and the
-- check runs SERVER-SIDE in the edge functions (connector-hub,
-- specialist-consult, playbook-execute) — not in the browser.
--
-- PERMISSION LADDER (cumulative — one row per subject×resource
-- holds the MAX level; higher levels include everything below):
--   search      (1)  can find matching records; cannot open them
--   read        (2)  + can open/fetch individual records
--   ingest      (3)  + can sync content into DreamTeam knowledge
--   write_back  (4)  + can write to the system (still human-gated
--                      by Scribe / trust-dial machinery — a grant
--                      is necessary, never sufficient, for a write)
--
-- RESOLUTION ORDER (resolve_access):
--   1. connector-specific grant  → wins, even over a broader
--      category grant (specific beats general)
--   2. category-level grant      → applies to every connector of
--      that category the tenant connects
--   3. nothing                   → DENY. Default-deny is the point.
--
-- HUMANS ARE NOT GOVERNED HERE: direct wizard calls (test /
-- health_check / dry-run) carry no subject and stay governed by
-- app RLS + roles. This table governs MACHINE subjects only.
--
-- HONEST LIMIT (documented): internal knowledge_docs/chunks are
-- NOT connector-gated — internal knowledge remains tenant-wide in
-- v1. Named upgrade: per-DE knowledge scopes.
-- ============================================================

-- ============================================================
-- TABLE: data_access_grants
-- ============================================================
create table if not exists data_access_grants (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  subject_kind       text not null check (subject_kind in ('de', 'specialist')),
  subject_id         uuid not null,
  resource_kind      text not null check (resource_kind in ('connector', 'category')),
  resource_id        uuid references connectors(id) on delete cascade,
  resource_category  text check (resource_category in (
                       'crm', 'helpdesk', 'knowledge_base', 'erp_financials', 'billing',
                       'payroll_hcm', 'pos', 'product_system', 'other')),
  permission         text not null check (permission in ('search', 'read', 'ingest', 'write_back')),
  granted_by         uuid,           -- profiles.user_id of the human who set it; null = seeded default
  note               text not null default '',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- resource shape must match its kind
  constraint data_access_grants_resource_shape check (
    (resource_kind = 'connector' and resource_id is not null and resource_category is null) or
    (resource_kind = 'category'  and resource_id is null and resource_category is not null)
  )
);

-- ONE row per subject × resource (the row holds the max permission level)
create unique index if not exists data_access_grants_subject_resource_uq
  on data_access_grants (tenant_id, subject_kind, subject_id, resource_kind,
                         coalesce(resource_id::text, resource_category));

create index if not exists data_access_grants_tenant_idx on data_access_grants(tenant_id);
create index if not exists data_access_grants_subject_idx on data_access_grants(tenant_id, subject_kind, subject_id);

alter table data_access_grants enable row level security;

-- Tenant members can SEE the grants (transparency); ALL writes go
-- through the SECURITY DEFINER RPCs below (audited, role-guarded).
drop policy if exists "data_access_grants_tenant_select" on data_access_grants;
create policy "data_access_grants_tenant_select" on data_access_grants
  for select
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

drop trigger if exists data_access_grants_updated_at on data_access_grants;
create trigger data_access_grants_updated_at
  before update on data_access_grants
  for each row execute function update_updated_at();

-- ============================================================
-- audit_events: add the access_control category
-- ============================================================
alter table audit_events drop constraint if exists audit_events_category_check;
alter table audit_events add constraint audit_events_category_check
  check (category in (
    'resolved', 'escalated', 'approval', 'guardrail_check', 'guardrail_block',
    'config_change', 'playbook_step', 'invoice',
    'connector_sync', 'connector_action', 'evidence_step',
    'access_control'
  ));

-- ============================================================
-- helper: permission ladder level
-- ============================================================
create or replace function access_permission_level(p_permission text)
returns integer
language sql immutable
as $$
  select case p_permission
    when 'search' then 1
    when 'read' then 2
    when 'ingest' then 3
    when 'write_back' then 4
    else 0
  end;
$$;

-- ============================================================
-- RPC: set_access_grant — upsert one subject×resource permission.
-- Caller: tenant admin/owner (JWT path) or service role.
-- Every change audited with before/after.
-- ============================================================
create or replace function set_access_grant(
  p_subject_kind      text,
  p_subject_id        uuid,
  p_resource_kind     text,
  p_resource_id       uuid,
  p_resource_category text,
  p_permission        text,
  p_note              text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant   uuid;
  v_user     uuid := auth.uid();
  v_role     text;
  v_before   text;
  v_grant_id uuid;
  v_subject_label text;
  v_resource_label text;
begin
  -- Tenant + role guard. Service-role callers have auth.uid() null and
  -- must operate through the edge functions (which pin tenant themselves) —
  -- for SQL-console/service use we derive tenant from the subject instead.
  if v_user is not null then
    select tenant_id, role into v_tenant, v_role from profiles where user_id = v_user;
    if v_tenant is null then
      return jsonb_build_object('ok', false, 'error', 'no_tenant');
    end if;
    if v_role not in ('tenant_owner', 'tenant_admin') then
      return jsonb_build_object('ok', false, 'error', 'admin_role_required',
        'detail', 'Only workspace owners/admins can change data access rules.');
    end if;
  else
    -- service role: derive tenant from the subject row
    if p_subject_kind = 'de' then
      select tenant_id into v_tenant from digital_employees where id = p_subject_id;
    else
      select tenant_id into v_tenant from specialist_profiles where id = p_subject_id;
    end if;
    if v_tenant is null then
      return jsonb_build_object('ok', false, 'error', 'subject_not_found');
    end if;
  end if;

  -- Validate subject belongs to the tenant
  if p_subject_kind = 'de' then
    select name into v_subject_label from digital_employees where id = p_subject_id and tenant_id = v_tenant;
  elsif p_subject_kind = 'specialist' then
    select name into v_subject_label from specialist_profiles where id = p_subject_id and tenant_id = v_tenant;
  else
    return jsonb_build_object('ok', false, 'error', 'bad_subject_kind');
  end if;
  if v_subject_label is null then
    return jsonb_build_object('ok', false, 'error', 'subject_not_in_tenant');
  end if;

  -- Validate resource
  if p_resource_kind = 'connector' then
    select display_name into v_resource_label from connectors where id = p_resource_id and tenant_id = v_tenant;
    if v_resource_label is null then
      return jsonb_build_object('ok', false, 'error', 'connector_not_in_tenant');
    end if;
  elsif p_resource_kind = 'category' then
    v_resource_label := 'all ' || p_resource_category || ' systems';
  else
    return jsonb_build_object('ok', false, 'error', 'bad_resource_kind');
  end if;

  if access_permission_level(p_permission) = 0 then
    return jsonb_build_object('ok', false, 'error', 'bad_permission');
  end if;

  select permission into v_before from data_access_grants
   where tenant_id = v_tenant and subject_kind = p_subject_kind and subject_id = p_subject_id
     and resource_kind = p_resource_kind
     and coalesce(resource_id::text, resource_category) = coalesce(p_resource_id::text, p_resource_category);

  insert into data_access_grants
    (tenant_id, subject_kind, subject_id, resource_kind, resource_id, resource_category, permission, granted_by, note)
  values
    (v_tenant, p_subject_kind, p_subject_id, p_resource_kind,
     case when p_resource_kind = 'connector' then p_resource_id else null end,
     case when p_resource_kind = 'category' then p_resource_category else null end,
     p_permission, v_user, coalesce(p_note, ''))
  on conflict (tenant_id, subject_kind, subject_id, resource_kind,
               coalesce(resource_id::text, resource_category))
  do update set permission = excluded.permission, granted_by = excluded.granted_by,
                note = excluded.note, updated_at = now()
  returning id into v_grant_id;

  perform append_audit_event(
    v_tenant,
    coalesce((select full_name from profiles where user_id = v_user), 'service'),
    case when v_user is null then 'system' else 'human' end,
    'Data access grant changed — ' || v_subject_label || ' on ' || v_resource_label
      || ': ' || coalesce(v_before, 'none') || ' → ' || p_permission
      || case when coalesce(p_note, '') <> '' then ' (' || p_note || ')' else '' end,
    'access_control',
    jsonb_build_object('kind', 'access_grant_changed', 'grant_id', v_grant_id,
      'subject_kind', p_subject_kind, 'subject_id', p_subject_id, 'subject_label', v_subject_label,
      'resource_kind', p_resource_kind, 'resource_id', p_resource_id,
      'resource_category', p_resource_category, 'resource_label', v_resource_label,
      'before', v_before, 'after', p_permission)
  );

  return jsonb_build_object('ok', true, 'grant_id', v_grant_id, 'before', v_before, 'after', p_permission);
end;
$$;

revoke all on function set_access_grant(text, uuid, text, uuid, text, text, text) from public;
grant execute on function set_access_grant(text, uuid, text, uuid, text, text, text) to authenticated, service_role;

-- ============================================================
-- RPC: revoke_access_grant — remove a grant (back to default-deny).
-- ============================================================
create or replace function revoke_access_grant(
  p_subject_kind      text,
  p_subject_id        uuid,
  p_resource_kind     text,
  p_resource_id       uuid,
  p_resource_category text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_user   uuid := auth.uid();
  v_role   text;
  v_before text;
  v_subject_label text;
  v_resource_label text;
begin
  if v_user is not null then
    select tenant_id, role into v_tenant, v_role from profiles where user_id = v_user;
    if v_tenant is null then
      return jsonb_build_object('ok', false, 'error', 'no_tenant');
    end if;
    if v_role not in ('tenant_owner', 'tenant_admin') then
      return jsonb_build_object('ok', false, 'error', 'admin_role_required');
    end if;
  else
    if p_subject_kind = 'de' then
      select tenant_id into v_tenant from digital_employees where id = p_subject_id;
    else
      select tenant_id into v_tenant from specialist_profiles where id = p_subject_id;
    end if;
    if v_tenant is null then
      return jsonb_build_object('ok', false, 'error', 'subject_not_found');
    end if;
  end if;

  if p_subject_kind = 'de' then
    select name into v_subject_label from digital_employees where id = p_subject_id and tenant_id = v_tenant;
  else
    select name into v_subject_label from specialist_profiles where id = p_subject_id and tenant_id = v_tenant;
  end if;
  v_resource_label := case when p_resource_kind = 'connector'
    then coalesce((select display_name from connectors where id = p_resource_id and tenant_id = v_tenant), 'connector')
    else 'all ' || p_resource_category || ' systems' end;

  delete from data_access_grants
   where tenant_id = v_tenant and subject_kind = p_subject_kind and subject_id = p_subject_id
     and resource_kind = p_resource_kind
     and coalesce(resource_id::text, resource_category) = coalesce(p_resource_id::text, p_resource_category)
  returning permission into v_before;

  if v_before is null then
    return jsonb_build_object('ok', true, 'removed', false, 'note', 'no grant existed — already default-deny');
  end if;

  perform append_audit_event(
    v_tenant,
    coalesce((select full_name from profiles where user_id = v_user), 'service'),
    case when v_user is null then 'system' else 'human' end,
    'Data access grant REVOKED — ' || coalesce(v_subject_label, 'subject') || ' on ' || v_resource_label
      || ': ' || v_before || ' → none (default-deny)',
    'access_control',
    jsonb_build_object('kind', 'access_grant_changed',
      'subject_kind', p_subject_kind, 'subject_id', p_subject_id, 'subject_label', v_subject_label,
      'resource_kind', p_resource_kind, 'resource_id', p_resource_id,
      'resource_category', p_resource_category, 'resource_label', v_resource_label,
      'before', v_before, 'after', null)
  );

  return jsonb_build_object('ok', true, 'removed', true, 'before', v_before);
end;
$$;

revoke all on function revoke_access_grant(text, uuid, text, uuid, text) from public;
grant execute on function revoke_access_grant(text, uuid, text, uuid, text) to authenticated, service_role;

-- ============================================================
-- FUNCTION: resolve_access — THE enforcement primitive.
-- Called by edge functions (service role) on every subject-attributed
-- connector call. Connector-specific grant wins over category grant;
-- no grant = DENY (default-deny is the doctrine).
-- ============================================================
create or replace function resolve_access(
  p_tenant_id     uuid,
  p_subject_kind  text,
  p_subject_id    uuid,
  p_connector_id  uuid,
  p_needed        text
)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_category text;
  v_has      text;
  v_via      text;
begin
  select category into v_category from connectors
   where id = p_connector_id and tenant_id = p_tenant_id;
  if v_category is null then
    return jsonb_build_object('allowed', false, 'reason', 'connector_not_found', 'needed', p_needed, 'has', null, 'via', null);
  end if;

  -- 1. connector-specific grant wins
  select permission into v_has from data_access_grants
   where tenant_id = p_tenant_id and subject_kind = p_subject_kind and subject_id = p_subject_id
     and resource_kind = 'connector' and resource_id = p_connector_id;
  if v_has is not null then
    v_via := 'connector';
  else
    -- 2. category-level grant
    select permission into v_has from data_access_grants
     where tenant_id = p_tenant_id and subject_kind = p_subject_kind and subject_id = p_subject_id
       and resource_kind = 'category' and resource_category = v_category;
    if v_has is not null then v_via := 'category'; end if;
  end if;

  -- 3. default deny
  if v_has is null then
    return jsonb_build_object('allowed', false, 'reason', 'no_grant', 'needed', p_needed, 'has', null, 'via', null);
  end if;

  if access_permission_level(v_has) >= access_permission_level(p_needed) then
    return jsonb_build_object('allowed', true, 'reason', 'granted', 'needed', p_needed, 'has', v_has, 'via', v_via);
  end if;
  return jsonb_build_object('allowed', false, 'reason', 'insufficient_permission', 'needed', p_needed, 'has', v_has, 'via', v_via);
end;
$$;

revoke all on function resolve_access(uuid, text, uuid, uuid, text) from public;
grant execute on function resolve_access(uuid, text, uuid, uuid, text) to authenticated, service_role;

-- ============================================================
-- FUNCTION: seed_default_grants — sensible per-domain defaults so a
-- freshly created DE/specialist works out of the box WITHOUT ever
-- touching financial/billing/payroll systems. Category-level grants;
-- ON CONFLICT DO NOTHING so manual edits are never overwritten.
-- Domains:
--   support   → helpdesk:read, knowledge_base:read, product_system:read
--   technical → support defaults + crm:read
--   sales     → crm:read, knowledge_base:read
--   finance   → erp_financials:read, billing:read, crm:search
-- (NO financials/billing/payroll for support/technical/sales subjects.)
-- ============================================================
create or replace function seed_default_grants(
  p_subject_kind text,
  p_subject_id   uuid,
  p_domain       text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_label  text;
  v_pairs  text[][];
  v_pair   text[];
  v_seeded integer := 0;
begin
  if p_subject_kind = 'de' then
    select tenant_id, name into v_tenant, v_label from digital_employees where id = p_subject_id;
  elsif p_subject_kind = 'specialist' then
    select tenant_id, name into v_tenant, v_label from specialist_profiles where id = p_subject_id;
  else
    return jsonb_build_object('ok', false, 'error', 'bad_subject_kind');
  end if;
  if v_tenant is null then
    return jsonb_build_object('ok', false, 'error', 'subject_not_found');
  end if;

  v_pairs := case p_domain
    when 'support'   then array[['helpdesk','read'], ['knowledge_base','read'], ['product_system','read']]
    when 'technical' then array[['helpdesk','read'], ['knowledge_base','read'], ['product_system','read'], ['crm','read']]
    when 'sales'     then array[['crm','read'], ['knowledge_base','read']]
    when 'finance'   then array[['erp_financials','read'], ['billing','read'], ['crm','search']]
    else null
  end;
  if v_pairs is null then
    return jsonb_build_object('ok', false, 'error', 'unknown_domain',
      'detail', 'domain must be one of: support, technical, sales, finance');
  end if;

  foreach v_pair slice 1 in array v_pairs loop
    insert into data_access_grants
      (tenant_id, subject_kind, subject_id, resource_kind, resource_category, permission, granted_by, note)
    values (v_tenant, p_subject_kind, p_subject_id, 'category', v_pair[1], v_pair[2], null,
            'seeded default (' || p_domain || ') — editable like any grant')
    on conflict (tenant_id, subject_kind, subject_id, resource_kind,
                 coalesce(resource_id::text, resource_category))
    do nothing;
    if found then v_seeded := v_seeded + 1; end if;
  end loop;

  -- Best-effort audit: seeding may run from the SQL console/migration
  -- context where append_audit_event's membership check cannot pass.
  begin
  perform append_audit_event(
    v_tenant, 'DreamTeam', 'system',
    'Default data-access grants seeded for ' || coalesce(v_label, 'subject')
      || ' (' || p_domain || ' domain): ' || v_seeded || ' category grant(s). '
      || 'No financial, billing or payroll access is ever granted by default.',
    'access_control',
    jsonb_build_object('kind', 'access_grant_changed', 'seeded', v_seeded,
      'subject_kind', p_subject_kind, 'subject_id', p_subject_id,
      'subject_label', v_label, 'domain', p_domain)
  );
  exception when others then null;
  end;

  return jsonb_build_object('ok', true, 'seeded', v_seeded, 'domain', p_domain);
end;
$$;

revoke all on function seed_default_grants(text, uuid, text) from public;
grant execute on function seed_default_grants(text, uuid, text) to authenticated, service_role;

-- ============================================================
-- playbook_definitions: which DE runs this playbook (the subject
-- whose grants govern its connector steps). Nullable — when null,
-- the executor falls back to the tenant's first DE (same pattern
-- as trust_policies in migration 025).
-- ============================================================
alter table playbook_definitions add column if not exists de_id uuid references digital_employees(id) on delete set null;

-- ============================================================
-- SEED (live tenant Acme Telecom a1b2c3d4-…0001 — the working
-- pipeline tenant; the demo tenant a0000000-…0001 is never touched):
--   • a Support DE (fixed id) so per-DE grants are demonstrable
--   • default grants for it (support domain) and the existing
--     Technical Specialist (technical domain)
-- ============================================================
do $$
declare
  v_tenant uuid := 'a1b2c3d4-0000-0000-0000-000000000001';
  v_de     uuid := 'de000000-0000-0000-0000-000000000201';
  v_spec   uuid;
begin
  if not exists (select 1 from tenants where id = v_tenant) then return; end if;

  insert into digital_employees (id, tenant_id, name, description, category, status)
  values (v_de, v_tenant, 'Support DE', 'Handles customer support inquiries — data access limited to helpdesk, knowledge and product systems by default', 'Customer', 'active')
  on conflict (id) do nothing;

  perform seed_default_grants('de', v_de, 'support');

  select id into v_spec from specialist_profiles
   where tenant_id = v_tenant and key = 'technical';
  if v_spec is not null then
    perform seed_default_grants('specialist', v_spec, 'technical');
  end if;
end $$;
