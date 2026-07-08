-- Migration 096: Performance & Insights page rebuild, part 4 — real
-- insight signals, replacing the hardcoded anomaly/retraining/
-- config-drift narrative text.
--
-- Anomaly (escalation-rate spikes) is computed in the frontend from
-- get_de_performance_metrics' already-real weekly trend (migration
-- 093) -- no new RPC needed for that one.
--
-- Config-drift (guardrail overrides): real, from audit_events
-- (category guardrail_block, or guardrail_check with detail->>'result'
-- = 'gated'). audit_events.actor is a free-text DE name (not a de_id
-- FK -- confirmed live, no attribution column exists), so this joins
-- by name match against digital_employees -- the best real attribution
-- available, not a fabricated linkage.
--
-- Retraining/recertification was confirmed to have NO real backend
-- concept at all (eval_runs has no de_id, no schedule table exists
-- anywhere) -- founder chose to replace it with a real, adjacent
-- signal instead of inventing a schedule: recent Proving Ground eval
-- failures, honestly framed as tenant-wide (not per-DE, since the data
-- genuinely isn't attributable to one).
-- =====================================================================

drop function if exists public.get_de_guardrail_activity(uuid, integer);

create or replace function public.get_de_guardrail_activity(p_tenant_id uuid, p_days integer default 30)
returns table(de_id uuid, de_name text, gated_count bigint, blocked_count bigint, tenant_total_events bigint, tenant_attributed_events bigint)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant_total bigint;
  v_tenant_attributed bigint;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not (
    is_platform_admin()
    or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = p_tenant_id)
  ) then
    raise exception 'not authorized to view this workspace''s guardrail activity';
  end if;

  -- Raw tenant-wide total, independent of name-attribution success --
  -- audit_events.actor is a free-text DE name (no de_id FK exists), so a
  -- historical DE rename can leave real events un-attributable to any
  -- CURRENT digital_employees row. Surfacing the raw total alongside the
  -- attributed rows keeps this honest instead of silently reading as
  -- "no guardrail activity" when there genuinely was some.
  select count(*) into v_tenant_total
    from audit_events a
    where a.tenant_id = p_tenant_id
      and (a.category = 'guardrail_block' or (a.category = 'guardrail_check' and a.detail->>'result' = 'gated'))
      and a.created_at > now() - (p_days || ' days')::interval;

  select count(*) into v_tenant_attributed
    from audit_events a
    join digital_employees de on de.tenant_id = p_tenant_id and de.name = a.actor
    where a.tenant_id = p_tenant_id
      and (a.category = 'guardrail_block' or (a.category = 'guardrail_check' and a.detail->>'result' = 'gated'))
      and a.created_at > now() - (p_days || ' days')::interval;

  return query
    select
      de.id, de.name,
      count(*) filter (where a.category = 'guardrail_check' and a.detail->>'result' = 'gated') as gated_count,
      count(*) filter (where a.category = 'guardrail_block') as blocked_count,
      v_tenant_total, v_tenant_attributed
    from digital_employees de
    join audit_events a on a.tenant_id = p_tenant_id and a.actor = de.name
      and a.category in ('guardrail_check', 'guardrail_block')
      and a.created_at > now() - (p_days || ' days')::interval
    where de.tenant_id = p_tenant_id
    group by de.id, de.name
    having count(*) filter (where a.category = 'guardrail_block' or a.detail->>'result' = 'gated') > 0;

  -- If real events exist tenant-wide but none could be attributed to a
  -- current DE name, still surface the totals via one summary-only row
  -- rather than silently returning nothing.
  if v_tenant_total > 0 and v_tenant_attributed = 0 and not found then
    return query select null::uuid, null::text, 0::bigint, 0::bigint, v_tenant_total, v_tenant_attributed;
  end if;
end;
$function$;

revoke all on function public.get_de_guardrail_activity(uuid, integer) from public, anon;
grant execute on function public.get_de_guardrail_activity(uuid, integer) to authenticated;

-- ── get_recent_eval_failures ──
-- Tenant-wide (eval_runs has no de_id -- honestly not attributed to one
-- DE). Surfaces real Proving Ground failures as a "needs attention"
-- signal instead of a fabricated recertification schedule.
create or replace function public.get_recent_eval_failures(p_tenant_id uuid, p_limit integer default 5)
returns table(id uuid, trigger text, total integer, passed integer, failed integer, started_at timestamptz, finished_at timestamptz)
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
    raise exception 'not authorized to view this workspace''s eval history';
  end if;

  return query
    select er.id, er.trigger, er.total, er.passed, er.failed, er.started_at, er.finished_at
    from eval_runs er
    where er.tenant_id = p_tenant_id and coalesce(er.failed, 0) > 0
    order by er.started_at desc
    limit p_limit;
end;
$function$;

revoke all on function public.get_recent_eval_failures(uuid, integer) from public, anon;
grant execute on function public.get_recent_eval_failures(uuid, integer) to authenticated;
