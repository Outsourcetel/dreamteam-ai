-- 766_a_goal_belongs_to_one_employee_in_one_workspace.sql
-- ==========================================================================
-- WHY: CROSS-TENANT READ. get_de_kpi_status(p_de_id) — public, granted to
-- `authenticated` — selected `from de_kpis k` with NO restriction: not by
-- employee, not by workspace. It returned EVERY KPI goal in the database
-- regardless of who asked or about whom.
--
-- MEASURED ON PRODUCTION, 2026-08-18, three ways:
--   · an employee with NO goals            -> 6 rows returned (another's)
--   · an employee in tenant a0000000-...   -> the 6 goals owned by tenant
--                                             5bb802e1-... came back
--   · fields exposed: name, metric_key, target, direction, current, met
--
-- PRE-EXISTING, NOT INTRODUCED BY MIG 764. The source dumped BEFORE 764
-- contains `k.de_id = p_de_id` exactly 0 times; 764's extraction was faithful
-- and carried the defect across unchanged. It surfaced only because mig 765
-- made the performance review CONSUME these goals, and all 14 employees came
-- back judged against the same 6 goals belonging to one employee in a
-- different workspace. Had 765 shipped first, a cross-tenant disclosure would
-- have become cross-tenant GOVERNANCE ACTION: PIPs opened against targets the
-- workspace never set.
--
-- THE FIX IS TWO GUARDS, not one, because either alone leaves a hole:
--   1. The goal set is scoped AT THE SOURCE — `from (select * from de_kpis
--      where de_id = p_de_id and tenant_id = p_tenant_id) k` — as a subquery,
--      so no later join can widen it back.
--   2. The (tenant, employee) pair is VERIFIED before anything is read. A
--      tenant id passed as a parameter is an assertion, not authorisation —
--      the trap this repo has already recorded for SECURITY DEFINER routines.
--      Today's only callers are trusted, but that is a property of today's
--      callers, not of this function.
--
-- SCOPE, enumerated rather than assumed. Three routines read de_kpis:
--   · de_kpi_status_internal  — LEAKS, fixed here
--   · set_de_kpi              — correct already: verifies the employee belongs
--                               to auth_tenant_id(), and filters both columns
--   · snapshot_de_kpi_readings— correct already: `where de_id = p_de_id`
-- So the fix is one function. The public reader get_de_kpi_status is unchanged
-- and inherits the fix through it.
--
-- Body generated from the LIVE pg_get_functiondef with two anchored
-- substitutions; the generator refuses if either anchor is missing.
-- ==========================================================================

begin;

CREATE OR REPLACE FUNCTION public.de_kpi_status_internal(p_tenant_id uuid, p_de_id uuid, p_window_weeks integer DEFAULT 13)
 RETURNS TABLE(kpi_id uuid, name text, metric_key text, target numeric, direction text, current numeric, met boolean, sample bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$

declare
  -- ⛔ mig 766: `p_tenant_id uuid;` WAS DECLARED HERE, shadowing the
  -- parameter of the same name. Mig 764 generated this body by replacing
  -- v_tenant -> p_tenant_id across the whole text, including the DECLARE
  -- block, so the function computed every tenant-scoped lookup against a
  -- NULL local instead of its argument. Removed.
  m record; v_csat numeric; v_csat_n bigint; v_vals jsonb; v_samples jsonb;
begin
  -- A tenant id passed as a PARAMETER is not authorisation, it is an assertion
  -- to be checked. Callers are trusted routines today; that is a property of
  -- today's callers, not of this function.
  if not exists (select 1 from digital_employees d
                  where d.id = p_de_id and d.tenant_id = p_tenant_id) then
    return;
  end if;


  select * into m from get_de_performance_metrics(p_tenant_id, p_window_weeks) where de_id = p_de_id;
  select round(100.0 * count(*) filter (where csat_score = 1) / nullif(count(*) filter (where csat_submitted_at is not null), 0), 1),
         count(*) filter (where csat_submitted_at is not null)
    into v_csat, v_csat_n
  from de_conversations where tenant_id = p_tenant_id and de_id = p_de_id;

  v_vals := jsonb_strip_nulls(jsonb_build_object(
    'resolution_rate',        case when coalesce(m.total_decisions, 0) >= 1 then m.resolution_rate end,
    'avg_confidence',         case when coalesce(m.total_decisions, 0) >= 1 then m.avg_confidence end,
    'escalation_rate',        case when coalesce(m.total_decisions, 0) >= 1 then m.escalation_rate end,
    'error_rate',             case when coalesce(m.total_runs, 0) >= 1 then m.error_rate end,
    'csat_pct',               v_csat,
    'high_frustration_count', case when coalesce(m.total_decisions, 0) >= 1 then m.high_frustration_count::numeric end,
    'total_decisions',        coalesce(m.total_decisions, 0)::numeric
  ));
  v_samples := jsonb_build_object('csat_pct', v_csat_n);

  return query
  select k.id, k.name, k.metric_key, k.target, k.direction, cur.v,
         case when cur.v is null then null
              when k.direction = 'higher' then cur.v >= k.target
              else cur.v <= k.target end,
         cur.n
  -- ⛔ mig 766. This read `from de_kpis k` with NO restriction at all — not
  -- by employee, not by workspace — so it returned EVERY goal in the database
  -- whatever it was asked about. Scoped here at the source, as a subquery, so
  -- no later join can widen it back.
  from (select * from de_kpis
         where de_id = p_de_id and tenant_id = p_tenant_id) k
  left join kpi_metric_catalog c
    on c.metric_key = k.metric_key and (c.tenant_id is null or c.tenant_id = p_tenant_id)
  -- mig 757: the arm lives in ONE place now (mig 756). Same expression,
  -- proven identical over 1143 (metric x employee) pairs before the switch.
  left join lateral public.de_kpi_action_value(p_tenant_id, p_de_id, c.source, c.source_config) act on true
  -- Latest manual reading, for metrics the platform doesn't compute.
  left join lateral (
    select d.value, count(*) over () as rn from de_kpi_readings d
     where d.de_id = k.de_id and d.metric_key = k.metric_key
       and d.source = 'manual'                    -- GI-5: fallback = human readings only
     order by d.as_of desc, d.created_at desc limit 1
  ) r on true
  cross join lateral (
    select coalesce((v_vals->>k.metric_key)::numeric, act.v, r.value) as v,
           coalesce((v_samples->>k.metric_key)::bigint, nullif(act.n, 0), r.rn, coalesce(m.total_decisions, 0)) as n
  ) cur;
end $function$

;

-- Unchanged from mig 764: internal only, nothing on the browser perimeter.
revoke all on function public.de_kpi_status_internal(uuid, uuid, int) from public;
revoke all on function public.de_kpi_status_internal(uuid, uuid, int) from anon;
revoke all on function public.de_kpi_status_internal(uuid, uuid, int) from authenticated;

commit;
