-- ============================================================
-- 148 — date-range support for the Performance / Insights pages.
--
-- The existing get_de_performance_metrics has been redefined three times
-- (093/104/125) and is used by other pages, so it is left UNTOUCHED and
-- keeps serving the (all-time) 6-month trend + frustration fields. This
-- migration adds small, windowed helpers the range selector drives:
--   * get_de_action_metrics   — made null-safe (p_days null = all time)
--   * get_de_inquiry_metrics  — NEW: windowed inquiry counts + quality
--   * get_de_cost_metrics_ranged — NEW: windowed AI cost (094's formula)
-- Every one takes p_days (null = all time) and is gated to tenant members.
-- ============================================================

-- 1) Action metrics — same as 147 but p_days null => all time (so the
--    "All" range option works without make_interval(null) erroring).
create or replace function public.get_de_action_metrics(p_tenant_id uuid, p_days integer default null)
returns table(
  de_id uuid,
  total_events bigint,
  executed bigint,
  auto_executed bigint,
  approved_after_gate bigint,
  sent_to_human bigint,
  blocked bigint,
  rejected bigint,
  failed bigint,
  autonomy_rate numeric
)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not (is_platform_admin() or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = p_tenant_id)) then
    raise exception 'not authorized to view this workspace''s performance data';
  end if;
  return query
    with ax as (
      select ae.subject_id as d_de_id, ae.decision as dec
      from action_executions ae
      where ae.tenant_id = p_tenant_id
        and ae.subject_kind = 'de'
        and ae.subject_id is not null
        and ae.decision <> 'previewed'
        and (p_days is null or ae.created_at >= now() - make_interval(days => p_days))
    )
    select
      ax.d_de_id as de_id,
      count(*)::bigint,
      count(*) filter (where dec in ('auto_executed', 'executed_after_approval'))::bigint,
      count(*) filter (where dec = 'auto_executed')::bigint,
      count(*) filter (where dec = 'executed_after_approval')::bigint,
      count(*) filter (where dec in ('human_gated_destructive', 'human_gated_trust'))::bigint,
      count(*) filter (where dec in ('guardrail_blocked', 'access_denied'))::bigint,
      count(*) filter (where dec = 'rejected')::bigint,
      count(*) filter (where dec = 'failed')::bigint,
      round(100.0 * count(*) filter (where dec = 'auto_executed')
        / nullif(count(*) filter (where dec in ('auto_executed', 'executed_after_approval')), 0), 1)
    from ax
    group by ax.d_de_id;
end;
$function$;
grant execute on function public.get_de_action_metrics(uuid, integer) to authenticated;

-- 2) Windowed inquiry counts + answer quality (the answering half),
--    without disturbing the evolved get_de_performance_metrics.
create or replace function public.get_de_inquiry_metrics(p_tenant_id uuid, p_days integer default null)
returns table(
  de_id uuid,
  total_decisions bigint,
  resolution_rate numeric,
  avg_confidence numeric,
  escalation_rate numeric
)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not (is_platform_admin() or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = p_tenant_id)) then
    raise exception 'not authorized to view this workspace''s performance data';
  end if;
  return query
    with dec as (
      select er.de_id as d_de_id, d.confidence as conf, d.decision as decision
      from evidence_run_decisions d
      join evidence_runs er on er.id = d.evidence_run_id
      where er.tenant_id = p_tenant_id and er.de_id is not null
        and (p_days is null or d.created_at >= now() - make_interval(days => p_days))
    )
    select
      dec.d_de_id as de_id,
      count(*)::bigint,
      round(100.0 * count(*) filter (where dec.decision <> 'needs_review') / nullif(count(*), 0), 1),
      round(avg(dec.conf) filter (where dec.conf is not null), 1),
      round(100.0 * count(*) filter (where dec.decision = 'needs_review') / nullif(count(*), 0), 1)
    from dec
    group by dec.d_de_id;
end;
$function$;
grant execute on function public.get_de_inquiry_metrics(uuid, integer) to authenticated;

-- 3) Windowed AI cost — same formula as get_de_cost_metrics (094).
create or replace function public.get_de_cost_metrics_ranged(p_tenant_id uuid, p_days integer default null)
returns table(de_id uuid, total_calls bigint, total_input_tokens bigint, total_output_tokens bigint, total_cost_usd numeric)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not (is_platform_admin() or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = p_tenant_id)) then
    raise exception 'not authorized to view this workspace''s cost data';
  end if;
  return query
    select
      u.de_id,
      count(*)::bigint as total_calls,
      sum(u.input_tokens)::bigint as total_input_tokens,
      sum(u.output_tokens)::bigint as total_output_tokens,
      round(sum(
        (u.input_tokens::numeric / 1000000) * coalesce(pr.input_price_per_million, 3.00)
        + (u.output_tokens::numeric / 1000000) * coalesce(pr.output_price_per_million, 15.00)
      ), 4) as total_cost_usd
    from de_token_usage u
    left join ai_model_pricing pr on pr.model_id = u.model_id
    where u.tenant_id = p_tenant_id and u.de_id is not null
      and (p_days is null or u.created_at >= now() - make_interval(days => p_days))
    group by u.de_id;
end;
$function$;
grant execute on function public.get_de_cost_metrics_ranged(uuid, integer) to authenticated;
