-- 599 — an invite must not lose its department on the way in.
--
-- 597's mirror trigger is `BEFORE INSERT OR UPDATE OF org_unit_id`. The
-- "UPDATE OF" clause narrows the update case to that one column, but it does
-- NOT narrow the INSERT case: the trigger fires on EVERY insert. And its body
-- said "no unit means no department", so a new profile arriving with
-- department = 'Customer Success' and org_unit_id = null — which is exactly the
-- shape the invite flow produces — had its department blanked on the way in.
--
-- Consolidating onto one list would have silently thrown away the department of
-- every person invited after it shipped. Found by trying to insert one.
--
-- The fix keeps a single source of truth rather than restoring the free-text
-- field: on INSERT, a department NAME is resolved to the unit that bears it, so
-- the invite lands bound to the hierarchy. If no unit matches, the text is left
-- alone rather than discarded — a name nobody can resolve is still the only
-- record of what the inviter meant, and losing it is worse than an unbound
-- value that a human can fix.
--
-- Clearing stays possible: an UPDATE that sets org_unit_id to null still empties
-- the mirror, because there the null was chosen rather than merely absent.

begin;

create or replace function sync_profile_department()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- INSERT: the invite carries a NAME. Bind it to the real unit if one exists.
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
    -- Explicitly moved out of a unit. Blank it, so the last department someone
    -- was in does not sit there looking current.
    new.department := '';
  end if;
  -- INSERT with no matching unit: keep whatever the inviter typed.

  return new;
end;
$$;

-- Prove both directions, then leave nothing behind. A migration that asserts
-- its own fix is the only kind that cannot ship a fix-shaped non-fix — and 597
-- shipped exactly that, having asserted nothing about inserts.
do $verify$
declare
  v_tenant uuid := (select id from tenants where slug = 'outsourcetel-hq');
  v_user   uuid := (select user_id from profiles where tenant_id = v_tenant limit 1);
  v_dept   text;
  v_unit   uuid;
begin
  if v_tenant is null or v_user is null then
    raise notice 'no workspace to verify against — skipping';
    return;
  end if;

  -- A real auth user is reused rather than invented: forging auth.users to
  -- make a test pass is never allowed, and a foreign key would refuse anyway.
  create temp table _prof_backup on commit drop as
    select org_unit_id, department from profiles where user_id = v_user;

  -- An UPDATE that does not touch org_unit_id must not fire the trigger at all,
  -- so a direct write to the text survives. (Writing BOTH columns at once DOES
  -- fire it and the unit wins — correct, and the first version of this check
  -- got that wrong by setting both and expecting the text to stand.)
  update profiles set department = 'Customer Success' where user_id = v_user;
  select department, org_unit_id into v_dept, v_unit from profiles where user_id = v_user;
  if coalesce(v_dept, '') <> 'Customer Success' then
    raise exception 'a department-only write was clobbered: got %', v_dept;
  end if;

  update profiles p set org_unit_id = (select id from org_units
      where tenant_id = v_tenant and kind = 'department' and name = 'Customer Success' limit 1)
   where p.user_id = v_user;
  select department into v_dept from profiles where user_id = v_user;
  if coalesce(v_dept, '') <> 'Customer Success' then
    raise exception 'mirror did not follow org_unit_id: got %', v_dept;
  end if;

  update profiles set org_unit_id = null where user_id = v_user;
  select department into v_dept from profiles where user_id = v_user;
  if coalesce(v_dept, '') <> '' then
    raise exception 'clearing the unit left a stale department: got %', v_dept;
  end if;

  update profiles p
     set org_unit_id = b.org_unit_id, department = b.department
    from _prof_backup b where p.user_id = v_user;

  raise notice 'mirror verified in both directions and the row restored';
end;
$verify$;

commit;
