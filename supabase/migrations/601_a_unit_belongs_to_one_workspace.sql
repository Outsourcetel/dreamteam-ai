-- 601 — a person or employee cannot be placed in another company's department.
--
-- Found by a careless test, which is the honest way to describe it. A throwaway
-- `update digital_employees set org_unit_id = <a unit of outsourcetel-hq>
-- where name = 'Finance DE'` matched fifteen rows across FIFTEEN DIFFERENT
-- TENANTS, and every one of them was accepted. The Accounts Receivable team of
-- one workspace then reported fifteen digital employees, fourteen of which
-- belonged to other companies.
--
-- The foreign key on org_unit_id says the unit EXISTS. It says nothing about
-- whose it is, and `org_units` is tenant-scoped. `set_de_org_unit` and
-- `update_team_member_department` both check — but a check that lives only in
-- the functions people are supposed to use is not a boundary, it is a
-- convention. Anything writing the column directly (a migration, a fix-up
-- script, the service role, a future code path) bypasses it silently, and the
-- symptom is a roster quietly containing other people's staff.
--
-- ⚠ A CHECK constraint cannot do this: it may not run a subquery. It has to be
-- a trigger, and it has to be on BOTH tables — `profiles.org_unit_id` has
-- exactly the same exposure and would leak a person into another company's org
-- chart, which is worse.
--
-- This is a genuine tightening, not a formality: it fires on write, it refuses
-- rather than corrects, and the message names both workspaces so whoever hit it
-- can see immediately that they crossed a tenant boundary.

begin;

create or replace function assert_org_unit_same_tenant()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_unit_tenant uuid;
begin
  if new.org_unit_id is null then
    return new;
  end if;

  select u.tenant_id into v_unit_tenant from org_units u where u.id = new.org_unit_id;
  if v_unit_tenant is null then
    raise exception 'org unit % does not exist', new.org_unit_id;
  end if;

  if v_unit_tenant is distinct from new.tenant_id then
    raise exception
      'cross-tenant placement refused: % belongs to workspace %, but org unit % belongs to workspace %',
      tg_table_name, new.tenant_id, new.org_unit_id, v_unit_tenant
      using errcode = 'raise_exception';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_profiles_org_unit_tenant on profiles;
create trigger trg_profiles_org_unit_tenant
  before insert or update of org_unit_id on profiles
  for each row execute function assert_org_unit_same_tenant();

drop trigger if exists trg_de_org_unit_tenant on digital_employees;
create trigger trg_de_org_unit_tenant
  before insert or update of org_unit_id on digital_employees
  for each row execute function assert_org_unit_same_tenant();

-- ── Is anything already wrong? ─────────────────────────────────────────────
-- Asked before claiming the boundary holds. A trigger only governs writes from
-- now on; existing rows are the ones nobody would ever look at again.

do $audit$
declare
  v_bad_people int;
  v_bad_des    int;
begin
  select count(*) into v_bad_people
  from profiles p join org_units u on u.id = p.org_unit_id
  where u.tenant_id is distinct from p.tenant_id;

  select count(*) into v_bad_des
  from digital_employees d join org_units u on u.id = d.org_unit_id
  where u.tenant_id is distinct from d.tenant_id;

  if v_bad_people > 0 or v_bad_des > 0 then
    raise exception 'existing cross-tenant placements: % people, % digital employees — clear these before the guard can be trusted',
      v_bad_people, v_bad_des;
  end if;

  raise notice 'no existing cross-tenant placements; guard now enforces it on write';
end;
$audit$;

-- ── Prove the guard REFUSES, rather than trusting that it would ───────────
-- A guard nobody has seen fire is a guard nobody knows is wired up.

do $verify$
declare
  v_a uuid := (select id from tenants where slug = 'outsourcetel-hq');
  v_foreign_unit uuid;
  v_de uuid;
  v_refused boolean := false;
begin
  select u.id into v_foreign_unit
  from org_units u where u.tenant_id is distinct from v_a and u.kind = 'department' limit 1;
  select d.id into v_de from digital_employees d where d.tenant_id = v_a limit 1;

  if v_foreign_unit is null or v_de is null then
    raise notice 'nothing to test the guard against — skipping';
    return;
  end if;

  begin
    update digital_employees set org_unit_id = v_foreign_unit where id = v_de;
  exception when others then
    v_refused := true;
  end;

  if not v_refused then
    raise exception 'the cross-tenant guard did NOT fire — it is decorative';
  end if;
  raise notice 'cross-tenant placement refused as intended';
end;
$verify$;

commit;
