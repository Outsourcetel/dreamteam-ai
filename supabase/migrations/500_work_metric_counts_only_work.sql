-- 500_work_metric_counts_only_work.sql
-- ============================================================================
-- A defect in migration 499, caught against live data one query after applying
-- it — and it is exactly the sin this block exists to prevent, committed by the
-- fix itself.
--
-- 499 counted an employee's escalations as `human_tasks where type='escalation'
-- and source='de'`. That set is not work. Live breakdown:
--     de_conversations  152   <- CHAT escalations, from the answer path
--     de_objectives      30   <- work engine: a goal declared itself blocked
--     de_work_items      21   <- work engine: a step needed a human
--     (none)              1
-- So the Technical Support employee — which has never run a single work item —
-- reported 141 escalations and a 100% escalation rate in the WORK metric,
-- because its chat escalations were the entire denominator.
--
-- That is the same class of error as feeding work into the answer substrate,
-- pointed the other way: a number that blends two populations and reads as
-- authoritative. It would have been especially convincing, because 100% looks
-- like a discovery rather than a bug.
--
-- Fix: count only escalations the WORK ENGINE raised — those attached to a work
-- item or an objective. Chat escalations belong to the answer-shaped metrics and
-- are already counted there.
--
-- The one row with no related_table is deliberately excluded: it predates the
-- back-link (mig 483) and cannot be attributed to work without guessing. Mig
-- 484 linked the 18 that had a decidable record and left the rest alone for the
-- same reason.
-- ============================================================================

create or replace function public.get_de_work_metrics(p_tenant_id uuid, p_weeks integer default 26)
returns table(
  de_id uuid,
  de_name text,
  archetype_key text,
  items_completed bigint,
  items_cancelled bigint,
  items_waiting_human bigint,
  escalations_raised bigint,
  escalations_answered bigint,
  escalations_unanswered bigint,
  escalation_rate numeric,
  oldest_unanswered_hours numeric,
  goals_open bigint,
  goals_blocked bigint,
  goals_needing_attention bigint,
  attention_oldest_since timestamptz,
  wakes_recorded bigint,
  wakes_concluded_blocked bigint
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare v_since timestamptz := now() - (greatest(1, p_weeks) || ' weeks')::interval;
begin
  if auth.role() is not null and auth.role() <> 'service_role' then
    if auth.uid() is null then
      raise exception 'not authenticated';
    end if;
    if not (
      is_platform_admin()
      or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = p_tenant_id)
    ) then
      raise exception 'not authorized to view this workspace''s work data';
    end if;
  end if;

  return query
  with items as (
    select w.de_id as i_de,
           count(*) filter (where w.status = 'done') as done,
           count(*) filter (where w.status = 'cancelled') as cancelled,
           count(*) filter (where w.status = 'waiting_human') as waiting
      from de_work_items w
     where w.tenant_id = p_tenant_id and w.updated_at >= v_since
     group by w.de_id
  ),
  esc as (
    -- WORK-ENGINE escalations only. A chat escalation is answer-path evidence
    -- and belongs to the answer-shaped metrics; counting it here made an
    -- answer-only employee report a 100% work escalation rate (mig 499 defect).
    select h.de_id as e_de,
           count(*) as raised,
           count(*) filter (where h.status <> 'pending') as answered,
           count(*) filter (where h.status = 'pending') as unanswered,
           max(extract(epoch from (now() - h.created_at)) / 3600.0)
             filter (where h.status = 'pending') as oldest_hours
      from human_tasks h
     where h.tenant_id = p_tenant_id
       and h.type = 'escalation'
       and h.source = 'de'
       and h.de_id is not null
       and h.related_table in ('de_work_items', 'de_objectives')
       and h.created_at >= v_since
     group by h.de_id
  ),
  goals as (
    select o.de_id as g_de,
           count(*) filter (where o.status in ('open', 'in_progress')) as open_goals,
           count(*) filter (where o.status = 'blocked') as blocked_goals,
           count(*) filter (where o.attention_flag is not null
                              and o.status in ('open', 'in_progress', 'blocked')) as flagged,
           min(o.attention_since) filter (where o.attention_flag is not null) as oldest_flag
      from de_objectives o
     where o.tenant_id = p_tenant_id
     group by o.de_id
  ),
  wakes as (
    select k.de_id as w_de,
           count(*) as recorded,
           count(*) filter (where k.assessment = 'blocked') as blocked_conclusions
      from de_objective_wakes k
     where k.tenant_id = p_tenant_id and k.started_at >= v_since
     group by k.de_id
  )
  select
    d.id, d.name, d.archetype_key,
    coalesce(i.done, 0), coalesce(i.cancelled, 0), coalesce(i.waiting, 0),
    coalesce(e.raised, 0), coalesce(e.answered, 0), coalesce(e.unanswered, 0),
    round(100.0 * coalesce(e.raised, 0)
          / nullif(coalesce(i.done, 0) + coalesce(i.cancelled, 0) + coalesce(e.raised, 0), 0), 1),
    round(e.oldest_hours, 1),
    coalesce(g.open_goals, 0), coalesce(g.blocked_goals, 0), coalesce(g.flagged, 0),
    g.oldest_flag,
    coalesce(k.recorded, 0), coalesce(k.blocked_conclusions, 0)
  from digital_employees d
  left join items i on i.i_de = d.id
  left join esc   e on e.e_de = d.id
  left join goals g on g.g_de = d.id
  left join wakes k on k.w_de = d.id
  where d.tenant_id = p_tenant_id
    and (auth.role() is null
         or auth.role() = 'service_role'
         or public.can_access_de(d.id))
  order by d.name;
end;
$function$;

revoke all on function public.get_de_work_metrics(uuid, integer) from public, anon;
grant execute on function public.get_de_work_metrics(uuid, integer) to authenticated, service_role;

notify pgrst, 'reload schema';

do $a$
declare
  v_tenant uuid; r record; n int;
begin
  if pg_get_functiondef('public.get_de_work_metrics(uuid,integer)'::regprocedure)
       not ilike '%de_objectives%''%' and
     pg_get_functiondef('public.get_de_work_metrics(uuid,integer)'::regprocedure)
       not ilike '%related_table in%' then
    raise exception '500: the work metric still counts chat escalations';
  end if;

  select t.id into v_tenant from tenants t where t.slug = 'outsourcetel-hq';
  if v_tenant is null then raise notice '500: no fixture — proof SKIPPED'; return; end if;

  -- An answer-only employee must now report NO work escalations. Technical
  -- Support has 141 chat escalations and has never run a work item; if it still
  -- shows any here, the filter did not land.
  select * into r from get_de_work_metrics(v_tenant, 26) m
   where m.de_name = 'Technical Support';
  if r.de_id is not null and r.escalations_raised > 0 then
    raise exception '500: an answer-only employee still reports % work escalations', r.escalations_raised;
  end if;

  -- ...while the queue employees keep theirs. If this zeroed everyone, the
  -- filter was too strict and the block delivered nothing.
  select count(*) into n from get_de_work_metrics(v_tenant, 26) m where m.escalations_raised > 0;
  if n = 0 then
    raise exception '500: no employee has any work escalation — the filter is too strict';
  end if;

  raise notice '500: work escalations counted for % employee(s); chat escalations excluded', n;
end $a$;
