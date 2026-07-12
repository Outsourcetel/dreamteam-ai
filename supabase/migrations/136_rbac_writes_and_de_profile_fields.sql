-- ============================================================
-- Wave 5 (part 1: server-side RBAC teeth) + Detailed DE profiles.
--
-- RBAC: the tenant role vocabulary has 7 roles, but three of them
-- (knowledge_manager, approver, read_only) carried ZERO server-side
-- enforcement — a "Read-Only Viewer" could insert/update/delete every
-- operational record, because five work-object tables still had the
-- original member-writable FOR ALL isolation policy from 011/022/023.
-- This splits each into the established read/write pattern (migration
-- 064): reads stay member-wide; writes exclude 'read_only'.
-- tenant_entity_fields (schema config, Wave 4) tightens further to
-- owner/admin/manager.
--
-- DE profiles: adds standard workforce-record fields (employee_code,
-- location, cost_center) + tenant-defined CUSTOM fields — definitions
-- in de_profile_fields, values in digital_employees.attributes —
-- written via set_de_attributes, which bumps config_version so changes
-- ride the existing versioning + tenant_activity_log diff history.
-- set_de_identity is recreated from its LIVE body with three trailing
-- params for the new standard fields (existing callers unaffected).
-- ============================================================

-- ── 1) read_only enforcement on the operational work-object tables ──
do $$
declare
  t text;
begin
  foreach t in array array['customer_accounts','support_tickets','renewal_invoices','opportunities','onboarding_projects'] loop
    execute format('drop policy if exists %I on %I', t || '_tenant_isolation', t);
    execute format('drop policy if exists %I on %I', t || '_tenant_read', t);
    execute format('drop policy if exists %I on %I', t || '_tenant_write', t);
    -- Reads: any active member of the tenant.
    execute format($p$
      create policy %I on %I for select using (
        tenant_id in (select tenant_id from profiles where user_id = auth.uid())
      )$p$, t || '_tenant_read', t);
    -- Writes: any active member EXCEPT read_only.
    execute format($p$
      create policy %I on %I for all using (
        exists (select 1 from profiles p
                where p.user_id = auth.uid()
                  and p.tenant_id = %I.tenant_id
                  and coalesce(p.is_active, true)
                  and p.role <> 'read_only')
      ) with check (
        exists (select 1 from profiles p
                where p.user_id = auth.uid()
                  and p.tenant_id = %I.tenant_id
                  and coalesce(p.is_active, true)
                  and p.role <> 'read_only')
      )$p$, t || '_tenant_write', t, t, t);
  end loop;
end $$;

-- ── 2) tenant_entity_fields: schema config → owner/admin/manager writes ──
drop policy if exists tenant_entity_fields_isolation on tenant_entity_fields;
drop policy if exists tenant_entity_fields_read on tenant_entity_fields;
drop policy if exists tenant_entity_fields_write on tenant_entity_fields;
create policy tenant_entity_fields_read on tenant_entity_fields
  for select using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));
create policy tenant_entity_fields_write on tenant_entity_fields
  for all using (
    exists (select 1 from profiles p
            where p.user_id = auth.uid() and p.tenant_id = tenant_entity_fields.tenant_id
              and coalesce(p.is_active, true)
              and p.role in ('tenant_owner','tenant_admin','tenant_manager'))
  ) with check (
    exists (select 1 from profiles p
            where p.user_id = auth.uid() and p.tenant_id = tenant_entity_fields.tenant_id
              and coalesce(p.is_active, true)
              and p.role in ('tenant_owner','tenant_admin','tenant_manager'))
  );

-- ── 3) Standard DE profile fields + custom-field values ─────────
alter table digital_employees
  add column if not exists employee_code text not null default '',
  add column if not exists location      text not null default '',
  add column if not exists cost_center   text not null default '',
  add column if not exists attributes    jsonb not null default '{}'::jsonb;

-- ── 4) Custom-field DEFINITIONS for DE profiles ──────────────────
create table if not exists de_profile_fields (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  field_key  text not null check (field_key ~ '^[a-z][a-z0-9_]*$'),
  label      text not null,
  field_type text not null default 'text' check (field_type in ('text', 'number', 'date')),
  position   integer not null default 0,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, field_key)
);

create index if not exists de_profile_fields_tenant_idx
  on de_profile_fields(tenant_id, position);

alter table de_profile_fields enable row level security;

drop policy if exists de_profile_fields_read on de_profile_fields;
create policy de_profile_fields_read on de_profile_fields
  for select using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));
drop policy if exists de_profile_fields_write on de_profile_fields;
create policy de_profile_fields_write on de_profile_fields
  for all using (
    exists (select 1 from profiles p
            where p.user_id = auth.uid() and p.tenant_id = de_profile_fields.tenant_id
              and coalesce(p.is_active, true)
              and p.role in ('tenant_owner','tenant_admin','tenant_manager'))
  ) with check (
    exists (select 1 from profiles p
            where p.user_id = auth.uid() and p.tenant_id = de_profile_fields.tenant_id
              and coalesce(p.is_active, true)
              and p.role in ('tenant_owner','tenant_admin','tenant_manager'))
  );

-- ── 5) set_de_identity — LIVE body + 3 trailing standard-field params ──
create or replace function public.set_de_identity(
  p_de_id uuid,
  p_display_title text default null,
  p_purpose_statement text default null,
  p_primary_business_outcome text default null,
  p_responsibilities text[] default null,
  p_employee_code text default null,
  p_location text default null,
  p_cost_center text default null
) returns digital_employees
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid;
  v_row digital_employees;
  v_actor text;
begin
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then
    raise exception 'only workspace owners/admins can edit a Digital Employee''s identity';
  end if;
  select * into v_row from digital_employees where id = p_de_id and tenant_id = v_tenant;
  if v_row.id is null then raise exception 'employee not found in this workspace'; end if;
  if v_row.lifecycle_status in ('retired', 'archived') then
    raise exception 'this employee is retired — configuration is locked read-only';
  end if;

  update digital_employees set
    display_title = coalesce(p_display_title, display_title),
    purpose_statement = coalesce(p_purpose_statement, purpose_statement),
    primary_business_outcome = coalesce(p_primary_business_outcome, primary_business_outcome),
    responsibilities = coalesce(p_responsibilities, responsibilities),
    employee_code = coalesce(p_employee_code, employee_code),
    location = coalesce(p_location, location),
    cost_center = coalesce(p_cost_center, cost_center),
    config_version = config_version + 1,
    updated_at = now()
  where id = p_de_id
  returning * into v_row;

  select full_name into v_actor from profiles where user_id = auth.uid();
  perform append_audit_event_internal(
    v_tenant, coalesce(v_actor, 'A workspace admin'), 'human',
    format('%s identity updated (title/purpose/responsibilities) — config v%s', v_row.name, v_row.config_version),
    'config_change',
    jsonb_build_object('kind', 'de_identity_update', 'de_id', p_de_id, 'config_version', v_row.config_version)
  );
  return v_row;
end;
$function$;

-- The 5-arg overload is superseded (defaulted trailing params); drop it
-- so PostgREST doesn't see an ambiguous pair.
drop function if exists public.set_de_identity(uuid, text, text, text, text[]);

revoke all on function public.set_de_identity(uuid, text, text, text, text[], text, text, text) from public, anon;
grant execute on function public.set_de_identity(uuid, text, text, text, text[], text, text, text) to authenticated, service_role;

-- ── 6) set_de_attributes — custom-field VALUES, validated against the
--      tenant's definitions, config-versioned + audited. ──────────
create or replace function public.set_de_attributes(p_de_id uuid, p_attributes jsonb)
returns digital_employees
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid;
  v_row digital_employees;
  v_actor text;
  v_key text;
begin
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then
    raise exception 'only workspace owners/admins can edit a Digital Employee''s profile fields';
  end if;
  if p_attributes is null or jsonb_typeof(p_attributes) <> 'object' then
    raise exception 'attributes must be a JSON object';
  end if;

  select * into v_row from digital_employees where id = p_de_id and tenant_id = v_tenant;
  if v_row.id is null then raise exception 'employee not found in this workspace'; end if;
  if v_row.lifecycle_status in ('retired', 'archived') then
    raise exception 'this employee is retired — configuration is locked read-only';
  end if;

  -- Every key must be a DEFINED custom field for this tenant — no
  -- freestyle keys (schema stays intentional, like tenant_entity_fields).
  for v_key in select jsonb_object_keys(p_attributes) loop
    if not exists (select 1 from de_profile_fields f
                   where f.tenant_id = v_tenant and f.field_key = v_key) then
      raise exception 'unknown profile field "%" — define it first under Profile fields', v_key;
    end if;
  end loop;

  -- Merge: provided keys overwrite; a JSON null value REMOVES the key.
  update digital_employees set
    attributes = jsonb_strip_nulls(attributes || p_attributes),
    config_version = config_version + 1,
    updated_at = now()
  where id = p_de_id
  returning * into v_row;

  select full_name into v_actor from profiles where user_id = auth.uid();
  perform append_audit_event_internal(
    v_tenant, coalesce(v_actor, 'A workspace admin'), 'human',
    format('%s profile fields updated — config v%s', v_row.name, v_row.config_version),
    'config_change',
    jsonb_build_object('kind', 'de_attributes_update', 'de_id', p_de_id,
                       'keys', (select jsonb_agg(k) from jsonb_object_keys(p_attributes) k),
                       'config_version', v_row.config_version)
  );
  return v_row;
end;
$function$;

revoke all on function public.set_de_attributes(uuid, jsonb) from public, anon;
grant execute on function public.set_de_attributes(uuid, jsonb) to authenticated, service_role;
