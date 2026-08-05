-- 592 — being based somewhere is not supervising it.
--
-- 591 gave `can_access_de` a fifth clause: you may access a digital employee in
-- a unit you belong to, or any unit beneath it. The claim in its header was
-- that it ships dark and can only add access once a human is placed in the same
-- unit as an employee.
--
-- That claim was wrong, and checking it rather than trusting it is the only
-- reason this was caught before anyone signed in.
--
-- Migration 588 seeded every person into "Head Office" — the ROOT of the tree —
-- because that was the one placement the data supported. Harmless while units
-- only routed work. The moment units grant ACCESS, membership of the root means
-- membership of everything beneath it.
--
-- Measured immediately after applying 591: Sarah Mitchell, a `tenant_user`
-- deliberately scoped to exactly ONE employee (and proven at exactly one, on
-- screen, in July), would have reached TWELVE of sixteen. A permission fix that
-- quietly hands a scoped account most of the workforce.
--
-- ── The rule that fixes it, and why it is right on its own terms ───────────
--
--   A LOCATION or BRANCH grants access only to someone who LEADS it.
--   A DEPARTMENT or TEAM grants access to any member.
--
-- Not a patch — a distinction that should have been there from the start.
-- Where you sit is not what you work on. Everyone in a company is "at" the head
-- office; that says nothing about whose work is theirs. A department or a team
-- IS a statement about the work. Someone accountable for a whole site is a
-- different claim again, and it is one somebody has to make deliberately by
-- naming them its lead.
--
-- Effect today: 588 marked only tenant_owners as leads, and owners already pass
-- `can_access_de` on role. So the org clause now grants exactly nothing that
-- was not already granted — which is what "ships dark" was supposed to mean.
-- It becomes real the first time a person is placed in a department.
--
-- Routing is untouched: `assign_human_task` reads unit membership directly and
-- never consults this predicate.

begin;

create or replace function public.can_access_de(p_de_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  SELECT
    -- ⚠ SERVICE ROLE IS IDENTIFIED BY auth.role(), NEVER BY A NULL auth.uid().
    -- anon ALSO has a null uid, so "if uid is null then allow" hands the
    -- internet everything — that is precisely the fail-open migration 330 had
    -- to close across 26 functions. Name the role explicitly.
    coalesce(auth.role(), '') = 'service_role'
    OR public.is_platform_admin()
    -- Owner, admin and manager are responsible for the whole workforce.
    OR public.auth_has_tenant_role(ARRAY['tenant_owner', 'tenant_admin', 'tenant_manager'])
    -- Everyone else sees the digital employees they are assigned to.
    OR EXISTS (
      SELECT 1 FROM public.de_assignments a
       WHERE a.de_id = p_de_id
         AND a.user_id = auth.uid()
         AND a.tenant_id = public.auth_tenant_id()
    )
    -- mig 591 + 592: …or that work in a unit you belong to.
    --
    -- The seed set (mig 592): a DEPARTMENT or TEAM you are in, or a
    -- LOCATION/BRANCH you LEAD. Being based at a site is not supervising it —
    -- everybody is "at" the head office, and 588 placed them all there.
    -- Without this distinction, root membership meant the whole workforce.
    --
    -- DOWNWARD ONLY from that seed. A department reaches its teams; a team
    -- never reaches back up to the department's other teams.
    OR EXISTS (
      WITH RECURSIVE mine AS (
        SELECT m.org_unit_id AS id
          FROM public.org_unit_members m
          JOIN public.org_units su ON su.id = m.org_unit_id
         WHERE m.user_id = auth.uid()
           AND m.is_active
           AND m.tenant_id = public.auth_tenant_id()
           AND su.is_active
           AND (su.kind IN ('department', 'team') OR m.role_in_unit = 'lead')
        UNION
        SELECT u.id
          FROM public.org_units u
          JOIN mine ON u.parent_id = mine.id
         WHERE u.is_active
      )
      SELECT 1
        FROM public.digital_employees de
       WHERE de.id = p_de_id
         AND de.tenant_id = public.auth_tenant_id()
         AND de.org_unit_id IS NOT NULL
         AND de.org_unit_id IN (SELECT id FROM mine)
    );
$function$;

do $assert$
declare
  v_src   text;
  v_sarah uuid;
  v_reach int;
begin
  select prosrc into v_src from pg_proc where proname = 'can_access_de';
  if v_src !~ 'service_role'         then raise exception 'lost: service-role clause'; end if;
  if v_src !~ 'is_platform_admin'    then raise exception 'lost: platform-admin clause'; end if;
  if v_src !~ 'auth_has_tenant_role' then raise exception 'lost: role clause'; end if;
  if v_src !~ 'de_assignments'       then raise exception 'lost: assignment clause'; end if;
  if v_src !~ 'org_unit_members'     then raise exception 'lost: org clause'; end if;
  if v_src !~ 'role_in_unit'         then raise exception 'the lead distinction was not applied'; end if;
  if (select count(*) from pg_proc where proname = 'can_access_de') <> 1 then
    raise exception 'can_access_de: overloads exist';
  end if;

  -- Behavioural, not textual: run the seed rule for the account that exposed
  -- the problem and require it to reach NOTHING through the org clause. A
  -- migration cannot sign in as her, but it can evaluate the same set.
  select user_id into v_sarah from profiles where full_name = 'Sarah Mitchell' limit 1;
  if v_sarah is not null then
    with recursive mine as (
      select m.org_unit_id as id
        from org_unit_members m join org_units su on su.id = m.org_unit_id
       where m.user_id = v_sarah and m.is_active and su.is_active
         and (su.kind in ('department','team') or m.role_in_unit = 'lead')
      union
      select u.id from org_units u join mine on u.parent_id = mine.id where u.is_active
    )
    select count(*) into v_reach from digital_employees de where de.org_unit_id in (select id from mine);

    if v_reach > 0 then
      raise exception 'the org clause would still widen a scoped account: % employees reachable', v_reach;
    end if;
  end if;
end;
$assert$;

commit;
