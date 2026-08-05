-- 597 — one department list.
--
-- A workspace could answer "what departments do we have?" FIVE different ways,
-- and no two agreed:
--
--   1. `DEPARTMENTS` — ten hard-coded strings in UserManagementPage.tsx, the
--      list the invite form and the per-person dropdown actually offered.
--   2. `DEPT_NAMES` — eight DIFFERENT hard-coded strings in useDepartments.ts.
--   3. the `departments` table — 8 rows, all belonging to tenant
--      `outsourcetel` ("Demo Workspace", 0 people). The real workspace,
--      `outsourcetel-hq`, has none. Two similarly-named tenants is why this
--      looked populated and behaved empty.
--   4. `profiles.department` — free text, written by
--      update_team_member_department from list (1).
--   5. `org_units` where kind is department or team — the actual hierarchy.
--
-- The founder found it the way these things are always found: a person whose
-- department is "Customer Success" while the department picker cannot offer
-- "Customer Success". Both statements were true, about different lists.
--
-- Worse, the People page carried its own "Department Management" panel — add,
-- rename, delete, assign a head — writing to (3), which is a different set of
-- rows from the Organisation page's tree. Two managers for one concept.
--
-- ── After this ─────────────────────────────────────────────────────────────
-- `org_units` is the single source of truth. `profiles.org_unit_id` is where a
-- person's department lives, and `profiles.department` becomes a MIRROR of that
-- unit's name, maintained by trigger, so the existing readers (the People page
-- list, its search, useUsers) keep working without knowing anything changed.
--
-- Nothing is deleted. The `departments` rows are migrated into the tree first,
-- so a demo workspace's eight departments survive as units rather than being
-- silently dropped on the way past.

begin;

-- ── 1. Bring the old table's rows into the tree ────────────────────────────

do $migrate$
declare d record; v_ho uuid;
begin
  for d in
    select dp.tenant_id, dp.name, dp.description
    from departments dp
    join tenants t on t.id = dp.tenant_id
  loop
    -- Every tenant with people already has a Head Office (mig 588). One that
    -- does not gets one now, so a migrated department has somewhere to live.
    select id into v_ho from org_units
     where tenant_id = d.tenant_id and parent_id is null and kind = 'location' and name = 'Head Office';
    if v_ho is null then
      insert into org_units (tenant_id, kind, name, code)
      values (d.tenant_id, 'location', 'Head Office', 'HO')
      on conflict do nothing;
      select id into v_ho from org_units
       where tenant_id = d.tenant_id and parent_id is null and kind = 'location' and name = 'Head Office';
    end if;

    insert into org_units (tenant_id, parent_id, kind, name)
    values (d.tenant_id, v_ho, 'department', d.name)
    on conflict do nothing;
  end loop;
end;
$migrate$;

-- ── 2. Nobody loses the department they were recorded as having ────────────
-- A free-text value with no matching unit becomes one, rather than being
-- discarded because it was not on somebody's hard-coded list.

do $adopt$
declare p record; v_ho uuid; v_unit uuid;
begin
  for p in
    select pr.user_id, pr.tenant_id, btrim(pr.department) as dept
    from profiles pr
    join tenants t on t.id = pr.tenant_id
    where pr.org_unit_id is null
      and coalesce(btrim(pr.department), '') <> ''
  loop
    select id into v_unit from org_units
     where tenant_id = p.tenant_id and kind in ('department','team')
       and lower(btrim(name)) = lower(p.dept)
     limit 1;

    if v_unit is null then
      select id into v_ho from org_units
       where tenant_id = p.tenant_id and parent_id is null and kind = 'location' and name = 'Head Office';
      if v_ho is null then
        insert into org_units (tenant_id, kind, name, code)
        values (p.tenant_id, 'location', 'Head Office', 'HO') on conflict do nothing;
        select id into v_ho from org_units
         where tenant_id = p.tenant_id and parent_id is null and kind = 'location' and name = 'Head Office';
      end if;
      insert into org_units (tenant_id, parent_id, kind, name)
      values (p.tenant_id, v_ho, 'department', p.dept)
      on conflict do nothing;
      select id into v_unit from org_units
       where tenant_id = p.tenant_id and parent_id = v_ho and kind = 'department' and name = p.dept;
    end if;

    update profiles set org_unit_id = v_unit where user_id = p.user_id;
  end loop;
end;
$adopt$;

-- ── 3. `profiles.department` becomes a mirror, not a second opinion ────────
-- Kept because several readers use it (the People list, its search box) and
-- rewriting all of them in one migration is how a "consolidation" turns into an
-- outage. It is now DERIVED: one direction, org_unit_id → department.

create or replace function sync_profile_department()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_unit_id is null then
    -- Somebody genuinely has no department. Say so rather than leaving the
    -- last one they were in sitting there looking current.
    new.department := '';
  else
    select u.name into new.department from org_units u where u.id = new.org_unit_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_profile_department on profiles;
create trigger trg_sync_profile_department
  before insert or update of org_unit_id on profiles
  for each row execute function sync_profile_department();

-- Bring existing rows into agreement in the same direction.
update profiles p
   set department = coalesce((select u.name from org_units u where u.id = p.org_unit_id), '')
 where coalesce(p.department, '') is distinct from
       coalesce((select u.name from org_units u where u.id = p.org_unit_id), '');

-- ── 4. Setting a department means choosing a real unit ─────────────────────
-- ⚠ The parameter type changes, so the old signature is DROPPED. A defaulted
-- overload would leave two functions matching the old call and PostgREST would
-- refuse to pick between them.

drop function if exists update_team_member_department(uuid, text);

create or replace function update_team_member_department(
  p_target_user_id uuid, p_org_unit_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_caller_tenant uuid;
  v_caller_role   text;
  v_target_tenant uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select tenant_id, role into v_caller_tenant, v_caller_role
  from profiles where user_id = auth.uid() and coalesce(is_active, true) = true;
  if v_caller_tenant is null or v_caller_role not in ('tenant_owner', 'tenant_admin') then
    raise exception 'only workspace owners/admins can change a teammate''s department';
  end if;

  select tenant_id into v_target_tenant from profiles where user_id = p_target_user_id;
  if v_target_tenant is null or v_target_tenant is distinct from v_caller_tenant then
    raise exception 'that person is not a member of this workspace';
  end if;

  -- A unit from another workspace would place someone in an org chart their
  -- employer cannot see.
  if p_org_unit_id is not null and not exists (
    select 1 from org_units u
    where u.id = p_org_unit_id and u.tenant_id = v_caller_tenant and u.is_active
  ) then
    raise exception 'that is not a department in this workspace';
  end if;

  -- department is maintained by trigger from org_unit_id.
  update profiles set org_unit_id = p_org_unit_id where user_id = p_target_user_id;

  return jsonb_build_object('ok', true,
    'department', coalesce((select name from org_units where id = p_org_unit_id), ''));
end;
$$;

grant execute on function update_team_member_department(uuid, uuid) to authenticated, service_role;

do $a$
begin
  if (select count(*) from pg_proc where proname = 'update_team_member_department') <> 1 then
    raise exception 'update_team_member_department exists at % arities',
      (select count(*) from pg_proc where proname = 'update_team_member_department');
  end if;
end;
$a$;

-- ── 5. Say plainly that the old table is no longer the answer ──────────────
-- Left in place with its data: dropping a table to prove a point is how you
-- discover the one reader nobody grepped for.

comment on table departments is
  'DEPRECATED (mig 597). Superseded by org_units where kind in (department, team), which is the single source of truth for the org hierarchy and is what profiles.org_unit_id points at. Rows here were migrated into org_units and are kept only so nothing was destroyed. Do not read this table in new code.';

comment on column profiles.department is
  'DERIVED — a mirror of org_units.name for profiles.org_unit_id, maintained by trg_sync_profile_department (mig 597). Read it if convenient; never write it. Set org_unit_id instead.';

commit;
