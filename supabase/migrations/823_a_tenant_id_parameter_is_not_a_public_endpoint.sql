-- 823_a_tenant_id_parameter_is_not_a_public_endpoint.sql
-- ==========================================================================
-- WHY: de_kpi_action_value(p_tenant_id uuid, ...) was SECURITY DEFINER,
-- owned by postgres, and its ACL read `{=X/postgres, postgres=X/postgres,
-- service_role=X/postgres}` — that leading `=X/` is PUBLIC, so anon and
-- authenticated held EXECUTE by inheritance. SECDEF bypasses RLS and the
-- body's ONLY tenant scoping is `ae.tenant_id = p_tenant_id`, a value the
-- caller supplies. That is precisely the shape migs 662-664 and 749 exist to
-- forbid: a tenant-id parameter standing in for authorisation.
--
-- PROVEN, not inferred, before this migration was written. Three POSTs to
-- https://<project>.supabase.co/rest/v1/rpc/de_kpi_action_value carrying only
-- the PUBLISHABLE anon key, no session, from outside every workspace:
--
--   outsourcetel-hq   -> HTTP 200 [{"v":13,"n":13}]      (auto_rate 0.0)
--   Review Lab        -> HTTP 200 [{"v":53,"n":53}]      (auto_rate 11.3)
--   third tenant      -> HTTP 200 [{"v":20,"n":20}]      (auto_rate 0.0)
--
-- Every figure matches the service-role ground truth exactly. RLS would have
-- returned nothing; SECDEF returned all three.
--
-- SEVERITY, STATED HONESTLY RATHER THAN INFLATED. The function returns two
-- AGGREGATES — a count and an auto-execution percentage — never a row, never
-- a customer name, and it writes nothing. Reaching a given workspace needs
-- BOTH a tenant uuid and a de uuid, neither of which is enumerable in
-- practice. So this is not a dump; it is a cross-tenant AGGREGATE ORACLE:
-- given the two ids, the internet learns how much a workspace's employee has
-- done, how much of it ran unsupervised, and — via the `category` and
-- `action_label` keys of p_source_config — WHICH kinds of work it does. Real,
-- and a genuine RLS bypass, at the moderate end.
--
-- THE FIX IS A REVOKE, AND DELIBERATELY NOT A DERIVATION. The whole call
-- graph was enumerated from pg_proc (not from grep, which cannot see a SQL
-- caller) and there is NO client caller anywhere in src/ or
-- supabase/functions/. Every caller is already service_role-only and already
-- authorised the tenant upstream:
--
--   get_de_kpi_status(p_de_id)        authenticated — DERIVES: can_access_de()
--                                     + `auth_tenant_id() is distinct from
--                                     v_tenant -> raise`. The real front door,
--                                     and it takes no tenant parameter at all.
--     -> de_kpi_status_internal(p_tenant_id, p_de_id, ...)   service_role only
--        (and it ALREADY re-asserts the de belongs to the tenant before it
--         calls down — its own comment says a tenant id passed as a parameter
--         is an assertion to be checked, not authorisation)
--          -> de_kpi_action_value(...)                       <- THIS FUNCTION
--     snapshot_de_kpi_readings(p_de_id) / snapshot_all_de_kpi_readings()
--     run_de_performance_review_internal / de_governance_sweep_internal
--                                       all service_role only, all resolve the
--                                       tenant from the DE row themselves.
--
-- Adding a derivation HERE would be worse than the bug. Every genuine call
-- path runs under service_role or cron, where auth.uid() is null — so an
-- auth.uid()-based guard would either fail OPEN (`auth.uid() is not null
-- and ...`, the exact shape mig 749 spent a whole migration deleting from 29
-- bodies) or fail CLOSED and silently zero out the KPI snapshot. And the
-- (de_id, tenant_id) consistency check this leaf would need already exists
-- one level up in de_kpi_status_internal; a second copy is a second
-- definition of one rule, which this repo has already watched rot.
--
-- So: make the leaf what its callers already assume it is — internal. Nested
-- calls run as the DEFINER (postgres), so revoking anon/authenticated cannot
-- affect them; that is asserted here and was DRIVEN afterwards, not reasoned.
--
-- ⚠ `create or replace` PRESERVES grants, so this revoke survives a future
-- body edit — but a DROP + CREATE resets the ACL to PUBLIC=X, which is how
-- this hole was born. The standing arm shipped alongside this migration
-- (certify probe `secdef-tenant-param-unreachable-by-anon`) has NO allowlist
-- and NO exemption, so the next one goes red on arrival instead of on the
-- next person's initiative.
-- ==========================================================================

begin;

-- ── 1. THE REVOKE. PUBLIC FIRST, and that ordering is the point. ──────────
-- This repo's recorded lesson (security_anon_guard_hole): an anon-only revoke
-- is THEATRE. anon never held a named grant here — it inherited PUBLIC's —
-- so `revoke ... from anon` alone would have changed the ACL not at all while
-- reading like a fix. anon and authenticated are named as well, so that a
-- future named grant to either is also removed.
revoke execute on function
  public.de_kpi_action_value(uuid, uuid, text, jsonb, integer)
  from public, anon, authenticated;

-- ── 2. BOTH HALVES. The service path must keep working. ───────────────────
-- Mig 643 nearly left 11 of 12 workspaces administrable by nobody, and a
-- revoke that silently breaks the nightly KPI snapshot is the same defect
-- wearing the opposite mask. REVOKE reports nothing either way, so the
-- surviving privilege is granted explicitly and asserted below rather than
-- assumed to have been left alone.
grant execute on function
  public.de_kpi_action_value(uuid, uuid, text, jsonb, integer)
  to service_role;

-- ── 3. ASSERT THE RESULT, because a REVOKE is not a description of the ────
-- resulting privileges. Every assertion below is about SCHEMA — what this
-- migration itself installed — so it is true wherever this file replays and
-- vacuously safe on empty data (CLAUDE.md rule 3).
do $$
declare
  f oid := to_regprocedure('public.de_kpi_action_value(uuid, uuid, text, jsonb, integer)')::oid;
begin
  if f is null then
    raise exception '823: de_kpi_action_value(uuid,uuid,text,jsonb,integer) does not exist — the revoke had no target';
  end if;

  -- 3a. The violation must be ABSENT. Note has_function_privilege() resolves
  --     PUBLIC inheritance, which a proacl string comparison would not.
  if has_function_privilege('anon', f, 'EXECUTE') then
    raise exception '823: anon STILL holds EXECUTE on de_kpi_action_value — the revoke did not land';
  end if;
  if has_function_privilege('authenticated', f, 'EXECUTE') then
    raise exception '823: authenticated STILL holds EXECUTE on de_kpi_action_value — the revoke did not land';
  end if;

  -- 3b. And PUBLIC directly, since that is the grant that actually existed.
  --     acldefault() is how a NULL proacl (never GRANTed/REVOKEd = PUBLIC=X)
  --     is spelled, so this catches the born-public state too.
  if exists (
    select 1
      from pg_proc p,
           lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where p.oid = f
       and a.grantee = 0             -- oid 0 is PUBLIC
       and a.privilege_type = 'EXECUTE'
  ) then
    raise exception '823: PUBLIC STILL holds EXECUTE on de_kpi_action_value';
  end if;

  -- 3c. BOTH HALVES — the roles the service path needs must REMAIN.
  if not has_function_privilege('service_role', f, 'EXECUTE') then
    raise exception '823: service_role LOST EXECUTE on de_kpi_action_value — the revoke over-reached';
  end if;
  if not has_function_privilege('postgres', f, 'EXECUTE') then
    raise exception '823: postgres LOST EXECUTE on de_kpi_action_value — the revoke over-reached';
  end if;
end $$;

-- ── 4. THE SIBLINGS, asserted rather than assumed. ────────────────────────
-- The two SQL callers are SECURITY DEFINER owned by postgres, so a nested
-- call to the leaf runs as postgres and never consults the caller's grants.
-- That is WHY step 1 is safe, so it is checked here instead of being taken on
-- trust — and it is checked as the absence of a violation, in both
-- directions: they must not be on the public perimeter either, and they must
-- still be reachable by the service path that drives them.
do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('public.de_kpi_status_internal(uuid, uuid, integer)'),
      ('public.snapshot_de_kpi_readings(uuid)')
    ) as v(sig)
  loop
    -- Skip a signature this database does not have rather than demanding
    -- production's shape: a migration must not assume which environment it is
    -- replaying into.
    continue when to_regprocedure(r.sig) is null;

    if not (select prosecdef from pg_proc where oid = to_regprocedure(r.sig)::oid) then
      raise exception '823: % is no longer SECURITY DEFINER — the nested call would run as the CALLER, and the revoke above would break it', r.sig;
    end if;
    if has_function_privilege('anon', to_regprocedure(r.sig)::oid, 'EXECUTE')
       or has_function_privilege('authenticated', to_regprocedure(r.sig)::oid, 'EXECUTE') then
      raise exception '823: % is reachable by anon/authenticated — it takes a caller-supplied tenant id and must not be', r.sig;
    end if;
    if not has_function_privilege('service_role', to_regprocedure(r.sig)::oid, 'EXECUTE') then
      raise exception '823: % lost service_role EXECUTE — the KPI snapshot path is broken', r.sig;
    end if;
  end loop;
end $$;

commit;
