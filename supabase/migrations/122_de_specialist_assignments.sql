-- DE-centered restructure: a Digital Employee has a PRIMARY and an
-- optional SECONDARY specialist (founder-mandated 2026-07-11; closes
-- the "per-DE specialist priority" gap from gap-analysis v3).
--
-- Consumption: the consult_specialist playbook step accepts
-- profile_key 'auto', resolved via resolve_de_specialist_internal():
-- the DE's primary if its profile is active, else the secondary, else
-- null (the step's existing honest-skip handles null). Assignment is
-- owner/admin-gated and audited; both RPCs use auth_tenant_id()/
-- auth_has_tenant_role() so Remote Access works from day one.

create table if not exists de_specialist_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  de_id uuid not null references digital_employees(id) on delete cascade,
  specialist_id uuid not null references specialist_profiles(id) on delete cascade,
  rank smallint not null check (rank in (1, 2)),  -- 1 = primary, 2 = secondary
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, de_id, rank),
  unique (tenant_id, de_id, specialist_id)
);

alter table de_specialist_assignments enable row level security;

drop policy if exists de_specialist_assignments_tenant_select on de_specialist_assignments;
create policy de_specialist_assignments_tenant_select on de_specialist_assignments
  for select to authenticated
  using (tenant_id = auth_tenant_id());

-- Writes only via the RPC below — no direct-write policies.

create or replace function set_de_specialist(p_de_id uuid, p_rank smallint, p_specialist_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_de digital_employees;
  v_sp specialist_profiles;
begin
  if p_rank not in (1, 2) then raise exception 'rank must be 1 (primary) or 2 (secondary)'; end if;
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then
    raise exception 'only workspace owners/admins can assign specialists';
  end if;

  select * into v_de from digital_employees where id = p_de_id and tenant_id = v_tenant;
  if v_de.id is null then raise exception 'employee not found in this workspace'; end if;

  if p_specialist_id is null then
    delete from de_specialist_assignments
    where tenant_id = v_tenant and de_id = p_de_id and rank = p_rank;
    perform append_audit_event_internal(
      v_tenant, 'You', 'human',
      format('%s''s %s specialist cleared', v_de.name, case when p_rank = 1 then 'primary' else 'secondary' end),
      'config_change',
      jsonb_build_object('kind', 'de_specialist_cleared', 'de_id', p_de_id, 'rank', p_rank)
    );
    return jsonb_build_object('ok', true, 'cleared', true);
  end if;

  select * into v_sp from specialist_profiles where id = p_specialist_id and tenant_id = v_tenant;
  if v_sp.id is null then raise exception 'specialist not found in this workspace'; end if;

  -- One specialist can't hold both ranks for the same DE: clear any
  -- other rank it holds first, then upsert this rank.
  delete from de_specialist_assignments
  where tenant_id = v_tenant and de_id = p_de_id and specialist_id = p_specialist_id and rank <> p_rank;

  insert into de_specialist_assignments (tenant_id, de_id, specialist_id, rank, created_by)
  values (v_tenant, p_de_id, p_specialist_id, p_rank, auth.uid())
  on conflict (tenant_id, de_id, rank)
  do update set specialist_id = excluded.specialist_id, created_by = excluded.created_by, created_at = now();

  perform append_audit_event_internal(
    v_tenant, 'You', 'human',
    format('%s assigned as %s''s %s specialist', v_sp.name, v_de.name, case when p_rank = 1 then 'primary' else 'secondary' end),
    'config_change',
    jsonb_build_object('kind', 'de_specialist_assigned', 'de_id', p_de_id, 'specialist_id', p_specialist_id, 'rank', p_rank)
  );

  return jsonb_build_object('ok', true, 'specialist', v_sp.name, 'rank', p_rank);
end;
$$;

revoke all on function set_de_specialist(uuid, smallint, uuid) from public, anon;
grant execute on function set_de_specialist(uuid, smallint, uuid) to authenticated, service_role;

create or replace function list_de_specialists(p_de_id uuid)
returns table(rank smallint, specialist_id uuid, specialist_key text, specialist_name text, specialist_status text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
begin
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  return query
  select a.rank, sp.id, sp.key, sp.name, sp.status
  from de_specialist_assignments a
  join specialist_profiles sp on sp.id = a.specialist_id
  where a.tenant_id = v_tenant and a.de_id = p_de_id
  order by a.rank;
end;
$$;

revoke all on function list_de_specialists(uuid) from public, anon;
grant execute on function list_de_specialists(uuid) to authenticated, service_role;

-- Service-side resolution for playbook-execute's 'auto' consult target:
-- primary if active, else secondary if active, else null.
create or replace function resolve_de_specialist_internal(p_tenant_id uuid, p_de_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select sp.key
  from de_specialist_assignments a
  join specialist_profiles sp on sp.id = a.specialist_id
  where a.tenant_id = p_tenant_id and a.de_id = p_de_id and sp.status = 'active'
  order by a.rank
  limit 1;
$$;

revoke all on function resolve_de_specialist_internal(uuid, uuid) from public, anon, authenticated;
grant execute on function resolve_de_specialist_internal(uuid, uuid) to service_role;
