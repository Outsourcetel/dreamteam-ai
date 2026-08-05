-- 591 — one org tree for people and digital employees.
--
-- Access to a digital employee is decided by ONE predicate, `can_access_de`,
-- which 73 functions and 28 row-security policies delegate to. That discipline
-- is the most valuable thing in the permission design, and this migration is
-- built entirely on it: adding one clause to one function changes what all 101
-- of those enforce, with no risk that two copies drift apart.
--
-- The clause: **you may access a digital employee that belongs to an org unit
-- you are a member of** — or to any unit beneath it, so a department head
-- reaches their teams' employees without being listed on each one.
--
-- ── Why this, rather than a third axis ─────────────────────────────────────
-- `de_assignments` is a hand-maintained row per (person, employee). It is the
-- right way to express a reporting line — primary/manager/executive on a named
-- employee — and the wrong way to express a department. Four rows exist today
-- across 117 employees. Saying "the Manchester finance team looks after these
-- eight" for a 200-person customer running 50 employees means maintaining a
-- 10,000-cell matrix by hand.
--
-- Org membership makes that O(people) + O(employees). Both mechanisms stay;
-- they answer different questions, and neither can express the other.
--
-- ── The department field this replaces ─────────────────────────────────────
-- `digital_employees.department` is free text and shows every symptom of it:
-- 34 rows blank, "Finance" alongside "Finance Operations", and "Support",
-- "customer_support" and "Customer Success" all in use. It is the same disease
-- as `profiles.department`, which resolved to a real department row for 0 of
-- 21 profiles.
--
-- The column is NOT dropped — 12 database functions and several screens read
-- it, and breaking `get_workforce_board` to tidy a field would be a poor
-- trade. It stops being the source of truth; `org_unit_id` is.
--
-- ── What the backfill will and will not do ─────────────────────────────────
-- Units are created from the department values each workspace ALREADY records,
-- matched case- and underscore-insensitively so `customer_support` lands in the
-- existing "Customer Support" unit rather than creating a twin.
--
-- It does NOT merge values that merely look similar. "Finance" and "Finance
-- Operations" stay separate units, as do "Support" and "Customer Success".
-- Guessing that two names mean one department is how a permission system
-- quietly grants someone access to a team they were never in.
--
-- ⚠ SHIPS DARK. Nobody's access changes on apply. Owners, admins and managers
-- already pass `can_access_de` on role, and the only two scoped users hold
-- assignments that keep working untouched. The new clause can only ADD access,
-- and only once a human is placed in the same unit as an employee.

begin;

alter table digital_employees
  add column if not exists org_unit_id uuid references org_units(id) on delete set null;

create index if not exists idx_de_org_unit on digital_employees(org_unit_id)
  where org_unit_id is not null;

-- ── Promote the recorded departments into the tree ─────────────────────────

do $backfill$
declare
  t        record;
  d        record;
  v_ho     uuid;
  v_unit   uuid;
  v_made   int := 0;
  v_placed int := 0;
begin
  for t in
    select distinct de.tenant_id from digital_employees de
    join tenants tn on tn.id = de.tenant_id
    where coalesce(de.department, '') <> ''
  loop
    select id into v_ho from org_units
     where tenant_id = t.tenant_id and parent_id is null and kind = 'location' and name = 'Head Office';
    -- A workspace with no people has no Head Office (588 seeded only where
    -- humans exist). Nothing to hang a department off, and no human to grant
    -- access to anyway.
    if v_ho is null then continue; end if;

    for d in
      select distinct de.department as raw,
             btrim(lower(replace(de.department, '_', ' '))) as key
      from digital_employees de
      where de.tenant_id = t.tenant_id and coalesce(de.department, '') <> ''
    loop
      -- Reuse an existing unit whose name means the same thing, at ANY depth —
      -- a workspace may already have "Finance" as a department and we must not
      -- create a second one beside it.
      select id into v_unit from org_units
       where tenant_id = t.tenant_id
         and kind in ('department', 'team')
         and btrim(lower(replace(name, '_', ' '))) = d.key
       order by (kind = 'department') desc
       limit 1;

      if v_unit is null then
        insert into org_units (tenant_id, parent_id, kind, name)
        values (t.tenant_id, v_ho, 'department', d.raw)
        returning id into v_unit;
        v_made := v_made + 1;
      end if;

      update digital_employees
         set org_unit_id = v_unit
       where tenant_id = t.tenant_id
         and btrim(lower(replace(department, '_', ' '))) = d.key
         and org_unit_id is distinct from v_unit;
      v_placed := v_placed + 1;
    end loop;
  end loop;

  raise notice 'created % department units, mapped % department values', v_made, v_placed;
end;
$backfill$;

-- ── The one predicate everything delegates to ──────────────────────────────
-- Generated from the deployed body, not retyped: this function has been
-- amended before and re-keying it from memory is how a clause goes missing.

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
    -- mig 591: …or that work in a unit you belong to.
    --
    -- DOWNWARD ONLY. Being in a department reaches the teams inside it;
    -- being in a team does NOT reach up to the department's other teams.
    -- The recursion walks parent → child and never the reverse, which is
    -- what keeps "I am in AR" from meaning "I am in all of Finance".
    OR EXISTS (
      WITH RECURSIVE mine AS (
        SELECT m.org_unit_id AS id
          FROM public.org_unit_members m
         WHERE m.user_id = auth.uid()
           AND m.is_active
           AND m.tenant_id = public.auth_tenant_id()
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

-- ── Assert the shape rather than trusting the edit ─────────────────────────
-- A CREATE OR REPLACE that silently dropped a clause would read as success and
-- widen or narrow access across 101 call sites.

do $assert$
declare v_src text;
begin
  select prosrc into v_src from pg_proc where proname = 'can_access_de';
  if v_src !~ 'service_role' then raise exception 'can_access_de: service-role clause lost'; end if;
  if v_src !~ 'is_platform_admin' then raise exception 'can_access_de: platform-admin clause lost'; end if;
  if v_src !~ 'auth_has_tenant_role' then raise exception 'can_access_de: role clause lost'; end if;
  if v_src !~ 'de_assignments' then raise exception 'can_access_de: assignment clause lost'; end if;
  if v_src !~ 'org_unit_members' then raise exception 'can_access_de: org clause not applied'; end if;
  -- Exactly one function of this name, or PostgREST cannot choose between them.
  if (select count(*) from pg_proc where proname = 'can_access_de') <> 1 then
    raise exception 'can_access_de: % overloads exist', (select count(*) from pg_proc where proname='can_access_de');
  end if;
end;
$assert$;

commit;
