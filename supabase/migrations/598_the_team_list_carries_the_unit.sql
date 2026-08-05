-- 598 — the team list has to carry the unit, or the picker cannot bind to it.
--
-- 597 made `org_units` the single source of truth and turned
-- `profiles.department` into a derived mirror of the unit's name. But the
-- People page reads its roster through `list_team_members_full`, which returns
-- the NAME and not the id. A department picker bound to a name has to match
-- back by string — which is precisely the failure mode 597 exists to end, and
-- it breaks outright the moment two units share a name (a "Support" team under
-- two different branches is an ordinary thing to have).
--
-- ⚠ The RETURN TYPE changes, so this is a DROP and CREATE. `CREATE OR REPLACE`
-- cannot change a function's output columns — it fails with "cannot change
-- return type of existing function" — and adding columns any other way would
-- mean a second overload PostgREST could not choose between.
--
-- `job_title` comes along too: the roster showed a role ("tenant_user") where
-- people expect a job ("Support Specialist"). Those are different questions and
-- the record has held the answer to the second since mig 594.

begin;

drop function if exists list_team_members_full(uuid);

create or replace function list_team_members_full(p_tenant_id uuid)
returns table(
  user_id uuid, full_name text, email text, role text, department text,
  org_unit_id uuid, job_title text, employment_status text,
  is_active boolean, last_seen_at timestamptz, created_at timestamptz, invited_by text
)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not (
    is_platform_admin()
    or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = p_tenant_id)
  ) then
    raise exception 'not authorized to view this workspace''s team';
  end if;

  return query
    select p.user_id, p.full_name, u.email::text, p.role, p.department,
      p.org_unit_id, p.job_title, p.employment_status,
      coalesce(p.is_active, true), p.last_seen_at, p.created_at, p.invited_by
    from profiles p
    join auth.users u on u.id = p.user_id
    where p.tenant_id = p_tenant_id;
end;
$function$;

grant execute on function list_team_members_full(uuid) to authenticated, service_role;

do $a$
begin
  if (select count(*) from pg_proc where proname = 'list_team_members_full') <> 1 then
    raise exception 'list_team_members_full exists at % arities — PostgREST cannot choose',
      (select count(*) from pg_proc where proname = 'list_team_members_full');
  end if;
end;
$a$;

commit;
