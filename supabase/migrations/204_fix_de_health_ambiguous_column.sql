-- 204: fix list_de_health() — "column reference de_id is ambiguous"
--
-- WHY
-- The function's RETURNS TABLE declares an OUT column named de_id. Inside
-- the body, this unqualified reference:
--
--   (select count(*) from de_development_items where de_id = d.id and ...)
--
-- resolves de_id against that OUT parameter rather than the table column,
-- so Postgres refuses it as ambiguous and the whole call throws. The DE
-- Health feature has therefore been failing on every roster page load —
-- visible only as a console error, with the health chips silently absent.
-- Found while browser-verifying the Wave 1 panel on the live workspace.
--
-- Fix is the qualification alone; all logic is unchanged.

CREATE OR REPLACE FUNCTION public.list_de_health(p_tenant_id uuid)
RETURNS TABLE(de_id uuid, de_name text, state text, signals jsonb, total_decisions bigint, avg_confidence numeric, escalation_rate numeric, error_rate numeric, recent_guardrail_blocks bigint, cost_this_period_usd numeric, cost_per_task_usd numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_tenant uuid;
begin
  v_tenant := auth_tenant_id();
  if v_tenant is null or v_tenant <> p_tenant_id then raise exception 'not a member of this workspace'; end if;

  return query
  with perf as (
    select * from get_de_performance_metrics(p_tenant_id, 8)
  ), guard as (
    select * from get_de_guardrail_activity(p_tenant_id, 7)
  ), cost as (
    select * from get_de_cost_metrics(p_tenant_id)
  )
  select
    d.id, coalesce(d.persona_name, d.name),
    case
      when d.lifecycle_status = 'retired' then 'retired'
      when coalesce(g.blocked_count, 0) > 0 then 'incident_active'
      when p.total_decisions is null or p.total_decisions < 10 then 'insufficient_data'
      when p.escalation_rate > 50 or p.error_rate > 15 then 'degraded'
      when p.avg_confidence < 50 then 'low_confidence'
      when coalesce(c.total_cost_usd, 0) > 50 then 'high_cost'
      when d.lifecycle_status = 'improving' then 'improving'
      else 'healthy'
    end,
    jsonb_build_object(
      'guardrail_blocked_7d', coalesce(g.blocked_count, 0),
      'escalation_rate_over_threshold', p.escalation_rate > 50,
      'error_rate_over_threshold', p.error_rate > 15,
      'low_confidence', p.avg_confidence < 50,
      'high_cost', coalesce(c.total_cost_usd, 0) > 50,
      -- Table-qualified: bare de_id would bind to this function's OUT column.
      'open_development_items', (
        select count(*) from de_development_items i
         where i.de_id = d.id and i.status in ('proposed','in_progress')
      )
    ),
    coalesce(p.total_decisions, 0), p.avg_confidence, p.escalation_rate, p.error_rate,
    coalesce(g.blocked_count, 0), coalesce(c.total_cost_usd, 0),
    case when coalesce(p.total_decisions, 0) > 0 then round(coalesce(c.total_cost_usd, 0) / p.total_decisions, 4) else null end
  from digital_employees d
  left join perf p on p.de_id = d.id
  left join guard g on g.de_id = d.id
  left join cost c on c.de_id = d.id
  where d.tenant_id = p_tenant_id;
end;
$function$;
