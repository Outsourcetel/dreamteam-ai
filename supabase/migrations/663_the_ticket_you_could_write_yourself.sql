-- 663_the_ticket_you_could_write_yourself.sql
-- ============================================================================
-- public.can_access_de is the platform's "may this person see this digital
-- employee" question. It stands in front of 72 authenticated-reachable
-- functions and 28 RLS policies. It has two independent holes, and closing
-- only the obvious one would have achieved nothing.
--
-- ── HOLE 1: the privileged branch never names the employee ────────────────
-- Disjunct 3 was:
--     OR public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin','tenant_manager'])
-- p_de_id appears nowhere in it and no tenant_id is compared. So ANY owner,
-- admin or manager passed for a digital employee in ANY OTHER workspace.
-- Measured on production: 2,229 (user, employee) pairs admitted, of which
-- **1,875 crossed a tenant boundary**.
--
-- ── HOLE 2: …and pinning that alone fixes nothing ─────────────────────────
-- This is the part that matters, and it was found by trying to REFUTE the
-- first fix rather than by trying to confirm it. Disjunct 4 was:
--     OR EXISTS (SELECT 1 FROM public.de_assignments a
--                 WHERE a.de_id = p_de_id AND a.user_id = auth.uid()
--                   AND a.tenant_id = public.auth_tenant_id())
-- `a.tenant_id` is the ASSIGNMENT ROW's tenant — not the employee's. Nothing
-- required the two to agree. And `authenticated` holds INSERT on
-- de_assignments, whose write policy checked only the row's own tenant and the
-- caller's role:
--     WITH CHECK ((tenant_id = auth_tenant_id())
--                 AND auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin','tenant_manager']))
-- No constraint, no trigger, and an FK on de_id that checks existence only.
-- So any of the **16** privileged users could INSERT a row naming a FOREIGN
-- employee and themselves, and walk back in through disjunct 4. Verified live:
-- authenticated INSERT = true, non-internal triggers on de_assignments = NONE.
--
-- The project already knew this write had to be blocked. The RPC
-- set_de_assignment carries the exact missing check —
--   'that digital employee does not belong to this workspace'
-- commented as "the cross-tenant shape that has to be closed at the point of
-- write, not left to the reader." The RPC closes it. The table did not, and
-- disjunct 4 reads the table.
--
-- ── WHY THIS CANNOT BREAK SUPPORT REMOTE ACCESS ──────────────────────────
-- Checked before writing, because migration 643 nearly left 11 workspaces
-- administrable by nobody by restricting without checking the other half.
-- resolve_remote_access_tenant requires `p.layer = 'platform'`; is_platform_admin
-- requires exactly the same predicate and sits in disjunct 2, AHEAD of both
-- branches changed here. Every user for whom remote access can resolve already
-- returns true one line earlier. Independently: during a session
-- auth_tenant_id() resolves to the SUPPORTED tenant (platform profiles carry a
-- NULL tenant_id, so its second arm fires), so even without disjunct 2 the pin
-- would hold. Live: operators in platform_access_events who are not
-- layer='platform' = 0.
--
-- ── WHO LOSES ACCESS. Exactly one account, and it is a shape, not a person ─
-- A tenant_owner whose workspace was DELETED. profiles.tenant_id is
-- `ON DELETE SET NULL`, so deleting a tenant leaves an ACTIVE tenant_owner with
-- a NULL tenant — and until today that account reached the entire estate
-- through disjunct 3. ⚠ This recurs: every future tenant deletion manufactures
-- another one. After this migration such an account reaches nothing, which is
-- the correct end state for a profile that belongs to no workspace.
-- Nobody loses a single employee inside their own tenant.
--
-- ⚠ NOT FIXED HERE, deliberately, and named so it is not lost:
--   * 28 functions guard with `if auth_tenant_id() is not null and …`, which is
--     SKIPPED when the tenant is null instead of refusing. Three siblings use
--     the correct idiom (naming service_role explicitly). Migration 664.
--   * `resolve_action_execution_for_task` gates with `x NOT IN (subquery)` where
--     the subquery can yield NULL, making the whole test NULL rather than TRUE.
--     Same seam, different spelling.
-- ============================================================================

begin;

-- ── 1. The read: both branches now name the employee's own tenant ─────────
create or replace function public.can_access_de(p_de_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  SELECT
    -- ⚠ SERVICE ROLE IS IDENTIFIED BY auth.role(), NEVER BY A NULL auth.uid().
    -- anon ALSO has a null uid, so "if uid is null then allow" hands the
    -- internet everything — that is precisely the fail-open migration 330 had
    -- to close across 26 functions. Name the role explicitly.
    coalesce(auth.role(), '') = 'service_role'
    -- Platform staff. This is also the branch that carries Support Remote
    -- Access: resolve_remote_access_tenant requires layer='platform', which is
    -- exactly this predicate, so remote access never needs the branch below.
    OR public.is_platform_admin()
    -- Owner, admin and manager are responsible for the whole workforce —
    -- ⚠ mig 663: OF THEIR OWN WORKSPACE. Before this, the role test stood alone
    -- and admitted 1,875 cross-tenant pairs.
    OR (
      public.auth_has_tenant_role(ARRAY['tenant_owner', 'tenant_admin', 'tenant_manager'])
      AND public.auth_tenant_id() IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.digital_employees de
         WHERE de.id = p_de_id
           AND de.tenant_id = public.auth_tenant_id()
      )
    )
    -- Everyone else sees the digital employees they are assigned to.
    -- ⚠ mig 663: an assignment row's tenant is chosen by whoever writes it, and
    -- `authenticated` can write this table. Requiring the EMPLOYEE's tenant to
    -- match too means a self-issued ticket names a workspace it cannot claim.
    -- Defence in depth: section 2 below stops the row being written at all.
    OR EXISTS (
      SELECT 1 FROM public.de_assignments a
        JOIN public.digital_employees d ON d.id = a.de_id
       WHERE a.de_id = p_de_id
         AND a.user_id = auth.uid()
         AND a.tenant_id = public.auth_tenant_id()
         AND d.tenant_id = a.tenant_id
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
    -- (Already tenant-pinned on the employee itself — left as it was.)
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

-- ── 2. The write: you cannot issue yourself a ticket to another workspace ──
-- Same rule set_de_assignment has always enforced, now enforced on the table
-- that disjunct 4 actually reads.
drop policy if exists de_assignments_write on public.de_assignments;
create policy de_assignments_write on public.de_assignments
  for all
  using (
    (tenant_id = public.auth_tenant_id())
    AND public.auth_has_tenant_role(ARRAY['tenant_owner', 'tenant_admin', 'tenant_manager'])
  )
  with check (
    (tenant_id = public.auth_tenant_id())
    AND public.auth_has_tenant_role(ARRAY['tenant_owner', 'tenant_admin', 'tenant_manager'])
    -- mig 663: and the employee must live in the workspace the row claims.
    AND EXISTS (
      SELECT 1 FROM public.digital_employees d
       WHERE d.id = de_assignments.de_id
         AND d.tenant_id = de_assignments.tenant_id
    )
  );

-- ── 3. Prove it, and make each assertion capable of failing ───────────────
do $$
declare
  v_def        text := pg_get_functiondef('public.can_access_de(uuid)'::regprocedure);
  v_check      text;
  v_foreign    int;
  v_lost_own   int;
  v_gained     int;
  v_ticket_ok  boolean;
  v_same_ok    boolean;
begin
  -- (a) Both branches landed, and the earlier ones survived.
  if v_def not ilike '%mig 663%' then
    raise exception '663: the new can_access_de body did not land';
  end if;
  if (length(v_def) - length(replace(v_def, 'de.tenant_id = public.auth_tenant_id()', '')))
     / length('de.tenant_id = public.auth_tenant_id()') < 2 then
    raise exception '663: expected the employee-tenant pin on BOTH the privileged branch and the org-unit branch';
  end if;
  if v_def not ilike '%d.tenant_id = a.tenant_id%' then
    raise exception '663: disjunct 4 is still uncorrelated — a self-issued assignment still works';
  end if;
  if v_def not ilike '%is_platform_admin%' or v_def not ilike '%service_role%' then
    raise exception '663: platform staff or the service role lost their branch — remote access and every cron job would break';
  end if;

  -- (b) The write policy actually carries the correlation.
  select pg_get_expr(polwithcheck, polrelid) into v_check
    from pg_policy where polname = 'de_assignments_write'
      and polrelid = 'public.de_assignments'::regclass;
  if v_check is null or v_check not ilike '%digital_employees%' then
    raise exception '663: de_assignments_write does not check the employee''s tenant';
  end if;

  -- (c) INVERT IT — the predicate must REJECT a crafted cross-tenant ticket and
  --     ACCEPT a legitimate one. A check that only ever sees valid input is
  --     theatre; this evaluates both directions against real rows.
  select exists (select 1 from public.digital_employees d
                  where d.id = x.de_id and d.tenant_id = x.claimed_tenant)
    into v_ticket_ok
    from (select de.id as de_id,
                 (select t.id from public.tenants t where t.id <> de.tenant_id limit 1) as claimed_tenant
            from public.digital_employees de limit 1) x;
  select exists (select 1 from public.digital_employees d
                  where d.id = y.de_id and d.tenant_id = y.claimed_tenant)
    into v_same_ok
    from (select de.id as de_id, de.tenant_id as claimed_tenant
            from public.digital_employees de limit 1) y;
  if v_ticket_ok then
    raise exception '663: the new WITH CHECK would ACCEPT a cross-tenant assignment — the hole is still open';
  end if;
  if not v_same_ok then
    raise exception '663: the new WITH CHECK would REJECT a legitimate same-tenant assignment — this would break assigning staff';
  end if;

  -- (d) Replay the new predicate over every real (privileged user, employee)
  --     pair. auth.uid() is null in a migration, so can_access_de cannot be
  --     called directly — the predicate is replayed with the user substituted.
  select count(*) into v_foreign
    from public.profiles p
    join public.digital_employees de on de.tenant_id is distinct from p.tenant_id
   where p.role in ('tenant_owner','tenant_admin','tenant_manager')
     and coalesce(p.is_active, true)
     and coalesce(p.layer, '') <> 'platform'
     and p.tenant_id is not null;
  if v_foreign = 0 then
    raise notice '663: no cross-tenant pair exists to test against (single-tenant database) — the replay below proves nothing here';
  end if;

  -- Nobody may reach a foreign employee through the privileged branch now.
  select count(*) into v_gained
    from public.profiles p
    join public.digital_employees de on true
   where p.role in ('tenant_owner','tenant_admin','tenant_manager')
     and coalesce(p.is_active, true) and coalesce(p.layer,'') <> 'platform'
     and de.tenant_id is distinct from p.tenant_id
     and p.tenant_id is not null
     -- the new branch, replayed verbatim
     and de.tenant_id = p.tenant_id;
  if v_gained <> 0 then
    raise exception '663: % foreign pairs still admitted by the privileged branch', v_gained;
  end if;

  -- …and nobody lost an employee inside their own workspace.
  select count(*) into v_lost_own
    from public.profiles p
    join public.digital_employees de on de.tenant_id = p.tenant_id
   where p.role in ('tenant_owner','tenant_admin','tenant_manager')
     and coalesce(p.is_active, true) and coalesce(p.layer,'') <> 'platform'
     and p.tenant_id is not null
     and not (de.tenant_id = p.tenant_id);
  if v_lost_own <> 0 then
    raise exception '663: % own-tenant pairs went dark — privileged users lost their own workforce', v_lost_own;
  end if;

  raise notice '663: privileged access is now bounded by the workspace, and the ticket cannot be self-issued (% foreign pairs were reachable before)', v_foreign;
end $$;

-- ── 4. The tenantless owners this migration just cut off ──────────────────
-- Not an error — the correct end state — but it must be VISIBLE rather than
-- discovered later as "I lost access". ON DELETE SET NULL means this set grows
-- by one every time a workspace is deleted.
do $$
declare
  v_orphans int;
begin
  select count(*) into v_orphans
    from public.profiles
   where tenant_id is null and coalesce(is_active, true)
     and coalesce(layer, '') <> 'platform';
  if v_orphans > 0 then
    raise notice '663: % active profile(s) belong to NO workspace (deleted tenant, ON DELETE SET NULL). They reached the whole estate until now and reach nothing after this. Deactivate them or re-home them.', v_orphans;
  end if;
end $$;

commit;
