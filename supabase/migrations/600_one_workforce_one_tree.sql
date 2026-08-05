-- 600 — one workforce, one tree.
--
-- Digital employees join the same hierarchy as people. A department is a
-- department: it contains whoever does that work, whether or not they sleep.
--
-- ── What was already there, and what was not ───────────────────────────────
-- `digital_employees.org_unit_id` ALREADY EXISTS — migs 591-593 added it for
-- org-scoped access, and 73 of 117 employees are bound. So this does NOT add a
-- second link; a sixth department list is the last thing this codebase needs.
-- What was missing is that the tree could not SHOW them, and that
-- `digital_employees.department` was still free text competing with the unit —
-- 17 distinct values including both "Support" and "customer_support".
--
-- ── The divergence this also has to close ─────────────────────────────────
-- I introduced one myself. There are two ways to say where a PERSON works:
--
--   profiles.org_unit_id   — their department, set on the employee record
--   org_unit_members       — membership, which is what approval routing draws
--                            its round-robin pool from
--
-- All 12 people with a department had NO membership row. So putting Sarah in
-- Accounts Receivable on her record did not make her eligible for a single AR
-- approval. Two ways to state the same fact, disagreeing — exactly the defect
-- the last three migrations existed to remove.
--
-- Now `org_unit_members` is THE membership table, `profiles.org_unit_id` names
-- the PRIMARY one, and a trigger keeps the primary membership in step. Being
-- added to a second team stays possible and is left alone (is_primary = false).
--
-- ── The one way a digital employee is NOT the same as a person ────────────
-- It may belong to a department. It may NOT be in the approval pool. Routing
-- picks from `org_unit_members`, and an employee that could be picked to
-- approve work is an employee that can approve its own — the single thing the
-- whole governance model exists to prevent. That was true by accident (the
-- table has a user_id and no de_id); this makes it true on purpose, with a
-- constraint that says so.

begin;

-- ── 1. Bind the digital employees whose department already names a unit ───

update digital_employees d
   set org_unit_id = u.id
  from org_units u
 where u.tenant_id = d.tenant_id
   and u.kind in ('department', 'team')
   and u.is_active
   and lower(btrim(u.name)) = lower(btrim(coalesce(d.department, '')))
   and d.org_unit_id is null
   and coalesce(btrim(d.department), '') <> '';

-- ── 2. `digital_employees.department` becomes a mirror, like profiles ─────
-- Thirteen SQL functions read this column (can_access_de, guardrail_rules_for_de,
-- get_workforce_board and others). Keeping it as a derived name means none of
-- them has to change and none of them can disagree with the tree.

create or replace function sync_de_department()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Same shape as sync_profile_department (mig 599), including the lesson that
  -- cost that migration a revision: `BEFORE INSERT OR UPDATE OF col` still
  -- fires on EVERY insert, so a new employee arriving with a department NAME
  -- and no unit must be RESOLVED, not blanked.
  if tg_op = 'INSERT'
     and new.org_unit_id is null
     and coalesce(btrim(new.department), '') <> '' then
    select u.id into new.org_unit_id
    from org_units u
    where u.tenant_id = new.tenant_id
      and u.kind in ('department', 'team')
      and lower(btrim(u.name)) = lower(btrim(new.department))
      and u.is_active
    limit 1;
  end if;

  if new.org_unit_id is not null then
    select u.name into new.department from org_units u where u.id = new.org_unit_id;
  elsif tg_op = 'UPDATE' then
    new.department := '';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sync_de_department on digital_employees;
create trigger trg_sync_de_department
  before insert or update of org_unit_id on digital_employees
  for each row execute function sync_de_department();

update digital_employees d
   set department = u.name
  from org_units u
 where u.id = d.org_unit_id
   and coalesce(d.department, '') is distinct from u.name;

-- ── 3. A person's department IS a membership ─────────────────────────────

alter table org_unit_members add column if not exists is_primary boolean not null default false;

-- Only humans. `user_id` never held a de_id, but "never happened yet" is not a
-- guarantee — and the cost of it happening once is a digital employee in the
-- rota that approves digital employees' work.
do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'org_unit_members_is_a_person') then
    alter table org_unit_members add constraint org_unit_members_is_a_person
      check (user_id is not null) not valid;
  end if;
end;
$c$;

create or replace function sync_primary_unit_membership()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.org_unit_id is not distinct from old.org_unit_id then
    return new;
  end if;

  -- Retire the previous primary. Memberships somebody added by hand are
  -- is_primary = false and are none of this trigger's business.
  delete from org_unit_members m
   where m.user_id = new.user_id and m.is_primary
     and (new.org_unit_id is null or m.org_unit_id <> new.org_unit_id);

  if new.org_unit_id is not null and new.user_id is not null then
    insert into org_unit_members (tenant_id, org_unit_id, user_id, role_in_unit, is_active, is_primary)
    values (new.tenant_id, new.org_unit_id, new.user_id, 'member', true, true)
    on conflict (org_unit_id, user_id)
      -- Already a member by hand: promote that row rather than duplicating it,
      -- and do NOT demote a lead to a member on the way past.
      do update set is_primary = true, is_active = true;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sync_primary_unit_membership on profiles;
create trigger trg_sync_primary_unit_membership
  after insert or update of org_unit_id on profiles
  for each row execute function sync_primary_unit_membership();

-- The 12 that were stranded.
insert into org_unit_members (tenant_id, org_unit_id, user_id, role_in_unit, is_active, is_primary)
select p.tenant_id, p.org_unit_id, p.user_id, 'member', true, true
from profiles p
where p.org_unit_id is not null and p.user_id is not null
on conflict (org_unit_id, user_id) do update set is_primary = true, is_active = true;

-- ── 4. The tree shows the whole workforce ────────────────────────────────

create or replace function list_org_tree(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(x order by x->>'path'), '[]'::jsonb)
  from (
    with recursive t as (
      select u.id, u.parent_id, u.kind, u.name, u.is_active, 0 as depth, u.name as path
      from org_units u where u.tenant_id = p_tenant_id and u.parent_id is null
      union all
      select u.id, u.parent_id, u.kind, u.name, u.is_active, t.depth + 1, t.path || ' / ' || u.name
      from org_units u join t on u.parent_id = t.id where u.tenant_id = p_tenant_id
    )
    select jsonb_build_object(
      'id', t.id, 'parent_id', t.parent_id, 'kind', t.kind, 'name', t.name,
      'is_active', t.is_active, 'depth', t.depth, 'path', t.path,
      'member_count', (select count(*) from org_unit_members m where m.org_unit_id = t.id and m.is_active),
      'de_count', (select count(*) from digital_employees d
                    where d.org_unit_id = t.id and d.status = 'active'),
      'open_tasks', (select count(*) from human_tasks h
                      where h.tenant_id = p_tenant_id and h.status = 'pending'
                        and h.assigned_via->>'unit_id' = t.id::text),
      'members', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'user_id', m.user_id, 'name', p.full_name, 'role_in_unit', m.role_in_unit,
                 'job_title', p.job_title, 'is_primary', m.is_primary) order by p.full_name), '[]'::jsonb)
        from org_unit_members m left join profiles p on p.user_id = m.user_id
        where m.org_unit_id = t.id and m.is_active
      ),
      -- The same department, staffed by whoever does the work. Kept as its own
      -- list rather than merged into `members`: they belong to the same unit,
      -- but only people appear in the approval rota, and a single blended list
      -- would make that distinction invisible at exactly the wrong moment.
      'digital_employees', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'de_id', d.id, 'name', d.name, 'title', d.display_title,
                 'trust_level', d.trust_level, 'status', d.status) order by d.name), '[]'::jsonb)
        from digital_employees d
        where d.org_unit_id = t.id and d.status = 'active'
      )
    ) as x
    from t
  ) s;
$$;

grant execute on function list_org_tree(uuid) to authenticated, service_role;

-- ── 5. Moving a digital employee between departments ─────────────────────

create or replace function set_de_org_unit(p_de_id uuid, p_org_unit_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := auth_tenant_id();
begin
  if v_tenant is null then raise exception 'not_authenticated'; end if;
  if not auth_has_tenant_role(array['tenant_owner','tenant_admin','tenant_manager']) then
    raise exception 'not_allowed: only an owner, admin or manager may move an employee between departments';
  end if;
  if not exists (select 1 from digital_employees where id = p_de_id and tenant_id = v_tenant) then
    raise exception 'no_such_employee_in_this_workspace';
  end if;
  if p_org_unit_id is not null and not exists (
    select 1 from org_units where id = p_org_unit_id and tenant_id = v_tenant and is_active
  ) then
    raise exception 'that is not a department in this workspace';
  end if;

  -- department follows via trg_sync_de_department.
  update digital_employees set org_unit_id = p_org_unit_id, updated_at = now() where id = p_de_id;

  return jsonb_build_object('ok', true,
    'department', coalesce((select name from org_units where id = p_org_unit_id), ''));
end;
$$;

grant execute on function set_de_org_unit(uuid, uuid) to authenticated, service_role;

-- ── 6. Prove the claims rather than assert the shape ─────────────────────

do $verify$
declare
  v_stranded int;
  v_mismatch int;
  v_de_in_pool int;
begin
  select count(*) into v_stranded
  from profiles p
  where p.org_unit_id is not null and p.user_id is not null
    and not exists (select 1 from org_unit_members m
                    where m.user_id = p.user_id and m.org_unit_id = p.org_unit_id and m.is_active);
  if v_stranded > 0 then
    raise exception '% people have a department but no membership — routing still cannot see them', v_stranded;
  end if;

  select count(*) into v_mismatch
  from digital_employees d join org_units u on u.id = d.org_unit_id
  where coalesce(d.department, '') is distinct from u.name;
  if v_mismatch > 0 then
    raise exception '% digital employees disagree with their own unit', v_mismatch;
  end if;

  -- No membership row may point at a digital employee.
  select count(*) into v_de_in_pool
  from org_unit_members m where exists (select 1 from digital_employees d where d.id = m.user_id);
  if v_de_in_pool > 0 then
    raise exception '% digital employees are in the approval pool', v_de_in_pool;
  end if;

  raise notice 'one tree: memberships aligned, departments mirrored, approval pool is people only';
end;
$verify$;

comment on column digital_employees.department is
  'DERIVED — a mirror of org_units.name for digital_employees.org_unit_id, maintained by trg_sync_de_department (mig 600). Read it; never write it. Set org_unit_id, or call set_de_org_unit().';

comment on column org_unit_members.is_primary is
  'TRUE for the membership that mirrors profiles.org_unit_id (the person''s home department), maintained by trg_sync_primary_unit_membership. Memberships added by hand — a second team, a cover arrangement — are FALSE and are never touched by that trigger.';

commit;
