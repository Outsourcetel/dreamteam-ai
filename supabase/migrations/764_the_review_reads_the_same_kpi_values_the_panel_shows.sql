-- ============================================================================
-- 764 — the review reads the same KPI values the panel shows.
--
-- docs/54 item 13: run_de_performance_review_internal "ignores de_kpis
-- entirely — Goals and Reviews are disconnected". Verified on production:
-- prosrc contains no reference to de_kpis at all. It judges instead on three
-- HARDCODED thresholds (escalation > 50, confidence < 50, error > 15), so a
-- workspace can set whatever goals it likes and the review will never look at
-- them.
--
-- Making the review judge against a tenant's own KPIs means it must resolve
-- each KPI to a value. That resolution already exists, once, in
-- get_de_kpi_status — but that function is USER-scoped: it opens by resolving
-- the caller's tenant through can_access_de and refuses anyone not assigned.
-- A cron-driven review has no caller.
--
-- So, exactly as with migs 756/757: EXTRACT FIRST. The resolution moves into
-- an internal function that takes the tenant explicitly, and get_de_kpi_status
-- becomes what it always was underneath — an authorisation check in front of
-- that resolution. The review will call the internal one in the next
-- migration. Nothing judges anything differently yet.
--
-- NO BEHAVIOUR CHANGE. The internal body is generated MECHANICALLY from the
-- live prosrc with exactly three substitutions, and the generator REFUSES if
-- either anchor is missing:
--   1. the auth preamble is REMOVED (it moves to the wrapper, verbatim)
--   2. v_tenant becomes the p_tenant_id parameter (0 occurrences remain)
--   3. the hardcoded 13-week window becomes p_window_weeks, and the wrapper
--      passes 13 — so today's callers see exactly today's numbers
--
-- The window becoming a parameter is not scope creep: the next migration gives
-- reviews a configurable cadence, and a review measured over 4 weeks must read
-- its KPIs over 4 weeks or the verdict cites numbers from a different period
-- than the one it claims to describe. That is the same defect this workstream
-- is already fixing in the review's own period_start.
--
-- ⚠ WHAT IS NOT PROVEN HERE. get_de_kpi_status cannot be executed from the
-- Management API — can_access_de correctly refuses a caller with no
-- auth.uid() — so there is no before/after differential of the public
-- function. The equivalence is BY CONSTRUCTION (mechanical substitution from
-- the live source, anchors asserted) plus the probe below, which calls the
-- internal function for every employee that has KPIs and reports how many rows
-- and how many non-null values came back, so "it worked" cannot be zero rows
-- silently.
-- ============================================================================

create or replace function public.de_kpi_status_internal(
  p_tenant_id    uuid,
  p_de_id        uuid,
  p_window_weeks int default 13
)
returns table (kpi_id uuid, name text, metric_key text, target numeric, direction text,
               current numeric, met boolean, sample bigint)
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$

declare
  p_tenant_id uuid; m record; v_csat numeric; v_csat_n bigint; v_vals jsonb; v_samples jsonb;
begin

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
  from de_kpis k
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
end $fn$;

-- Internal: the review and the wrapper call it, nothing on the browser
-- perimeter does. Default PUBLIC/anon/authenticated EXECUTE (migs 610 + 630)
-- closed explicitly rather than pinned later.
revoke all on function public.de_kpi_status_internal(uuid, uuid, int) from public;
revoke all on function public.de_kpi_status_internal(uuid, uuid, int) from anon;
revoke all on function public.de_kpi_status_internal(uuid, uuid, int) from authenticated;

-- The public reader keeps its exact signature, its exact grants and its exact
-- auth preamble — it is now that preamble plus a call.
create or replace function public.get_de_kpi_status(p_de_id uuid)
returns table (kpi_id uuid, name text, metric_key text, target numeric, direction text,
               current numeric, met boolean, sample bigint)
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
declare
  v_tenant uuid;
begin
  select tenant_id into v_tenant from digital_employees where id = p_de_id and public.can_access_de(id);
  if v_tenant is null then return; end if;
  if auth.role() is not null and auth.role() <> 'service_role' then
    if auth_tenant_id() is distinct from v_tenant then raise exception 'not a member of this workspace'; end if;
  end if;

  -- 13: the window this function has always used. Unchanged on purpose.
  return query select * from public.de_kpi_status_internal(v_tenant, p_de_id, 13);
end
$fn$;
