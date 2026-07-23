-- ============================================================================
-- 263 — ROLE-AWARE KPIs (founder: KPIs align with support but aren't universal)
--
-- Honest scope after audit: the KPI system was already partly generic — a
-- tenant can add CUSTOM metrics (upsert_kpi_metric) and record MANUAL readings
-- (de_kpi_readings) for anything the platform can't compute. The real gaps:
--   1) The ONLY auto-computed metrics were 7 conversation ones — a custom
--      metric could only be manual. A finance/ops DE's output (actions it
--      took) couldn't auto-track.
--   2) The catalog wasn't role-aware — it offered the 7 support metrics to
--      every employee regardless of what it does.
--
-- This adds an ACTION metric source (auto-computed from action_executions —
-- the same domain-agnostic work-product the Work tab shows), tags metrics by
-- the system CATEGORIES they suit, and seeds generic action metrics that work
-- for ANY acting role. No hardcoded vertical metrics — a finance DE gets
-- "Actions completed / Auto-execution rate" auto-computed, plus custom+manual
-- for anything domain-specific (e.g. DSO).
-- ============================================================================

alter table public.kpi_metric_catalog drop constraint if exists kpi_metric_catalog_source_check;
alter table public.kpi_metric_catalog add constraint kpi_metric_catalog_source_check
  check (source in ('computed', 'manual', 'action'));
alter table public.kpi_metric_catalog add column if not exists source_config jsonb not null default '{}'::jsonb;
alter table public.kpi_metric_catalog add column if not exists domains text[];   -- system categories it suits; null = any

-- Tag the 7 conversation metrics with the categories they actually fit — so a
-- finance DE isn't offered "Positive CSAT" first.
update public.kpi_metric_catalog
   set domains = array['helpdesk','crm','product_system']
 where tenant_id is null and metric_key in ('resolution_rate','csat_pct','high_frustration_count','escalation_rate');
-- avg_confidence / error_rate / total_decisions apply to any answering DE → left null (universal).

-- Generic ACTION metrics — auto-computed from what the employee DID, for any
-- role that takes actions (finance, ops, sales, support alike).
insert into public.kpi_metric_catalog (tenant_id, metric_key, label, description, direction, unit, source, source_config, sort_order)
select v.* from (values
  (null::uuid, 'actions_completed', 'Actions completed', 'How many actions this employee executed in the period.', 'higher', 'count', 'action', '{"agg":"count"}'::jsonb, 80),
  (null::uuid, 'auto_execution_rate', 'Auto-execution rate', 'Share of actions the employee completed on its own vs. sent for approval.', 'higher', '%', 'action', '{"agg":"auto_rate"}'::jsonb, 85)
) as v(tenant_id, metric_key, label, description, direction, unit, source, source_config, sort_order)
where not exists (select 1 from public.kpi_metric_catalog c where c.tenant_id is null and c.metric_key = v.metric_key);

-- ── get_de_kpi_status v2: computes conversation metrics (as before), ACTION
--    metrics (from action_executions per source_config), and falls back to the
--    latest manual reading — in that order. ──
create or replace function public.get_de_kpi_status(p_de_id uuid)
returns table(kpi_id uuid, name text, metric_key text, target numeric, direction text, current numeric, met boolean, sample bigint)
language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
declare
  v_tenant uuid; m record; v_csat numeric; v_csat_n bigint; v_vals jsonb; v_samples jsonb;
begin
  select tenant_id into v_tenant from digital_employees where id = p_de_id;
  if v_tenant is null then return; end if;
  if auth.role() is not null and auth.role() <> 'service_role' then
    if auth_tenant_id() is distinct from v_tenant then raise exception 'not a member of this workspace'; end if;
  end if;

  select * into m from get_de_performance_metrics(v_tenant, 13) where de_id = p_de_id;
  select round(100.0 * count(*) filter (where csat_score = 1) / nullif(count(*) filter (where csat_submitted_at is not null), 0), 1),
         count(*) filter (where csat_submitted_at is not null)
    into v_csat, v_csat_n
  from de_conversations where tenant_id = v_tenant and de_id = p_de_id;

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
    on c.metric_key = k.metric_key and (c.tenant_id is null or c.tenant_id = v_tenant)
  -- ACTION metrics: auto-computed from what the employee did (last 91 days).
  left join lateral (
    select
      case when coalesce(c.source, '') = 'action' then
        case when coalesce(c.source_config->>'agg', 'count') = 'auto_rate' then
          round(100.0 * count(*) filter (where ae.decision = 'auto_executed') / nullif(count(*), 0), 1)
        else count(*)::numeric end
      end as v,
      count(*) as n
      from action_executions ae
      left join action_definitions ad on ad.id = ae.action_definition_id
     where c.source = 'action'
       and ae.tenant_id = v_tenant and ae.subject_kind = 'de' and ae.subject_id = p_de_id
       and ae.rollback_of is null and ae.created_at >= now() - interval '91 days'
       and (coalesce(c.source_config->>'category', '') = '' or ad.category = c.source_config->>'category')
       and (coalesce(c.source_config->>'action_label', '') = '' or ad.label = c.source_config->>'action_label')
  ) act on true
  -- Latest manual reading, for metrics the platform doesn't compute.
  left join lateral (
    select d.value, count(*) over () as rn from de_kpi_readings d
     where d.de_id = k.de_id and d.metric_key = k.metric_key
     order by d.as_of desc, d.created_at desc limit 1
  ) r on true
  cross join lateral (
    select coalesce((v_vals->>k.metric_key)::numeric, act.v, r.value) as v,
           coalesce((v_samples->>k.metric_key)::bigint, nullif(act.n, 0), r.rn, coalesce(m.total_decisions, 0)) as n
  ) cur;
end $function$;

-- ── list_kpi_metrics v2: expose source_config + domains. ──
create or replace function public.list_kpi_metrics()
returns json language sql stable security definer set search_path to 'public' as $function$
  select coalesce(json_agg(row_to_json(x) order by x.sort_order, x.label), '[]'::json) from (
    select metric_key, label, description, direction, unit, source, source_config, domains, sort_order,
           (tenant_id is not null) as is_custom
      from kpi_metric_catalog
     where tenant_id is null or tenant_id = auth_tenant_id()
  ) x;
$function$;

-- ── Role-aware reader: metrics for one DE, applicable-to-its-domain first. ──
create or replace function public.get_kpi_metrics_for_de(p_de_id uuid)
returns json language plpgsql stable security definer set search_path to 'public' as $function$
declare v_tenant uuid; v_cats text[];
begin
  v_tenant := public.auth_tenant_id();
  if v_tenant is null then return '[]'::json; end if;
  if not exists (select 1 from digital_employees where id = p_de_id and tenant_id = v_tenant) then return '[]'::json; end if;
  select coalesce(array_agg(distinct resource_category), '{}') into v_cats
    from data_access_grants where tenant_id = v_tenant and subject_kind = 'de' and subject_id = p_de_id and resource_category is not null;
  return (
    select coalesce(json_agg(row_to_json(x) order by x.applicable desc, x.sort_order, x.label), '[]'::json) from (
      select metric_key, label, description, direction, unit, source, source_config, domains, sort_order,
             (tenant_id is not null) as is_custom,
             (domains is null or domains && v_cats) as applicable
        from kpi_metric_catalog
       where tenant_id is null or tenant_id = v_tenant
    ) x
  );
end $function$;
revoke all on function public.get_kpi_metrics_for_de(uuid) from public, anon;
grant execute on function public.get_kpi_metrics_for_de(uuid) to authenticated, service_role;

NOTIFY pgrst, 'reload schema';
