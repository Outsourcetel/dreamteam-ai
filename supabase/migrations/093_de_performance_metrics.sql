-- Migration 093: Performance & Insights page rebuild, part 1 — real
-- per-DE performance metrics. PerformancePage/InsightsPage
-- (IntelligencePages.tsx) have always shown 100% hardcoded per-company
-- demo numbers (resolution rate, confidence, escalation rate, error
-- rate, 6-month trend sparklines) with zero connection to real DE
-- activity. Confirmed by exhaustive schema check before writing this:
-- digital_employees.success_rate/tasks_this_month exist but have never
-- been written by anything since their migration-001 creation (dead
-- columns, not a real source).
--
-- The real foundation: evidence_runs.de_id attributes every resolved
-- inquiry to a specific DE (already used by the proactive-trigger and
-- action-execution pipelines since migration 034/035), and
-- evidence_run_decisions carries a real confidence score and decision
-- outcome per inquiry. 'needs_review' always carries a human_task_id
-- (confirmed live: 57/57) -- that's the real "this needed a human"
-- signal, i.e. resolution_rate = 1 - (needs_review / total).
-- =====================================================================

create or replace function public.get_de_performance_metrics(p_tenant_id uuid, p_weeks integer default 26)
returns table(
  de_id uuid,
  de_name text,
  total_decisions bigint,
  resolution_rate numeric,
  avg_confidence numeric,
  escalation_rate numeric,
  blocked_guardrail_count bigint,
  total_runs bigint,
  error_rate numeric,
  trend jsonb
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
    raise exception 'not authorized to view this workspace''s performance data';
  end if;

  return query
    with decisions as (
      select er.de_id as d_de_id, d.confidence as d_confidence, d.decision as d_decision,
        d.human_task_id as d_human_task_id, d.created_at as d_created_at
      from evidence_run_decisions d
      join evidence_runs er on er.id = d.evidence_run_id
      where er.tenant_id = p_tenant_id and er.de_id is not null
    ),
    runs as (
      select er.de_id as r_de_id, er.status as r_status
      from evidence_runs er
      where er.tenant_id = p_tenant_id and er.de_id is not null
    ),
    summary as (
      select
        dec.d_de_id as s_de_id,
        count(*) as total_decisions,
        round(100.0 * count(*) filter (where dec.d_decision <> 'needs_review') / nullif(count(*), 0), 1) as resolution_rate,
        round(avg(dec.d_confidence) filter (where dec.d_confidence is not null), 1) as avg_confidence,
        round(100.0 * count(*) filter (where dec.d_decision = 'needs_review') / nullif(count(*), 0), 1) as escalation_rate,
        count(*) filter (where dec.d_decision = 'blocked_guardrail') as blocked_guardrail_count
      from decisions dec
      group by dec.d_de_id
    ),
    run_summary as (
      select r.r_de_id as rs_de_id, count(*) as total_runs,
        round(100.0 * count(*) filter (where r.r_status = 'failed') / nullif(count(*), 0), 1) as error_rate
      from runs r
      group by r.r_de_id
    ),
    weekly as (
      select
        dec.d_de_id as w_de_id,
        date_trunc('week', dec.d_created_at) as week_start,
        count(*) as decisions_count,
        round(100.0 * count(*) filter (where dec.d_decision <> 'needs_review') / nullif(count(*), 0), 1) as week_resolution_rate,
        round(avg(dec.d_confidence) filter (where dec.d_confidence is not null), 1) as week_avg_confidence
      from decisions dec
      where dec.d_created_at > now() - (p_weeks || ' weeks')::interval
      group by dec.d_de_id, date_trunc('week', dec.d_created_at)
    ),
    trend_agg as (
      select w.w_de_id as t_de_id, jsonb_agg(
        jsonb_build_object(
          'week', to_char(w.week_start, 'YYYY-MM-DD'),
          'decisions', w.decisions_count,
          'resolution_rate', w.week_resolution_rate,
          'avg_confidence', w.week_avg_confidence
        ) order by w.week_start
      ) as trend
      from weekly w
      group by w.w_de_id
    )
    select
      de.id, de.name,
      coalesce(s.total_decisions, 0),
      coalesce(s.resolution_rate, 0),
      coalesce(s.avg_confidence, 0),
      coalesce(s.escalation_rate, 0),
      coalesce(s.blocked_guardrail_count, 0),
      coalesce(rs.total_runs, 0),
      coalesce(rs.error_rate, 0),
      coalesce(t.trend, '[]'::jsonb)
    from digital_employees de
    left join summary s on s.s_de_id = de.id
    left join run_summary rs on rs.rs_de_id = de.id
    left join trend_agg t on t.t_de_id = de.id
    where de.tenant_id = p_tenant_id
    order by de.name;
end;
$function$;

revoke all on function public.get_de_performance_metrics(uuid, integer) from public, anon;
grant execute on function public.get_de_performance_metrics(uuid, integer) to authenticated;
