-- 499_work_becomes_measurable.sql
-- ============================================================================
-- docs/37 MOVE 1 — delivered, but NOT the way docs/37 prescribed. The
-- groundwork refuted the premise, so this follows the evidence instead.
--
-- ── WHAT docs/37 CLAIMED ───────────────────────────────────────────────────
-- "Every consumer is generic over evidence — support-shaped only in what feeds
--  them. One writer unblocks ten organs at once."
--
-- ── WHAT IS ACTUALLY TRUE ──────────────────────────────────────────────────
-- The read side is archetype-blind, yes. But of 29 consumers examined against
-- live definitions: 3 would just work, 14 would SILENTLY MISCOUNT, 12 exclude.
-- Feeding work into the answer substrate is not neutral, it is corrupting, and
-- in three places it is dangerous:
--
--   * de_records_gate computes an error rate over ALL of an employee's runs and
--     gates at >15%. Clean work runs enlarge the denominator and push the rate
--     under the bar — releasing an employee that should stay supervised. That
--     gate feeds resolve_de_autonomy and the trust badge, so it is not a display
--     bug: work evidence would quietly widen real permissions.
--   * detect_de_development_needs_internal closes an 'escalation_spike'
--     development item when escalation_rate falls back under 50. Diluting the
--     rate with clean work rows marks a genuinely escalating support employee
--     'completed' and flips it back to active.
--   * cluster_gap_candidates would turn work items into knowledge gaps, which
--     dispatches LLM spend to draft customer-support articles about renewal
--     work — and apply_knowledge_revision then seeds a golden exam question
--     from the work-item title with a NULL archetype, which de_records_gate
--     reads as "an exam exists" for EVERY archetype.
--
-- Two ratios sit at the centre of it: resolution_rate and escalation_rate are
-- computed over one undifferentiated denominator. Twenty-six renewal work items
-- completing cleanly would push a support employee's escalation rate down and
-- its resolution rate up with zero change in support behaviour.
--
-- ── WHAT THIS MIGRATION DOES INSTEAD ───────────────────────────────────────
-- Work gets measured in ITS OWN SHAPE, from the tables that already hold the
-- truth — de_work_items, de_objectives, de_objective_wakes, human_tasks — with
-- no risk to a single existing organ. This is also precisely the substrate
-- docs/37 Move 2 and founder decision D3 need for per-archetype performance
-- contracts, so it is the same work, arrived at honestly.
--
-- The answer-shaped columns added by mig 498 (evidence_runs.kind /
-- work_category) stay as a documented seam: if work evidence is ever written
-- into that table, the distinction already exists and mig 500 makes the
-- dangerous consumers refuse it.
--
-- NULL DISCIPLINE (mig 491's rule, applied from birth): a rate with no
-- denominator returns NULL — "not measured" — never 0. Counts return 0,
-- because a zero count is a true measurement.
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
  -- Same membership gate as get_de_performance_metrics, including the mig-454
  -- cron-context repair: a direct pg_cron connection has auth.role() NULL and
  -- must not be treated as an unauthenticated browser.
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
    -- An escalation is the work analogue of "handed to a human". It became
    -- countable only once mig 483 gave escalations a back-link to the work
    -- they block; before that they were unattributable.
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
    -- The rate the answer-shaped metric structurally cannot produce for a queue
    -- employee. Denominator = everything that reached a terminal state plus
    -- everything handed to a human, i.e. the work the employee actually took a
    -- position on. NULL when it took none.
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
    -- The two-axes assignment model (docs/29), mirrored from the answer-shaped
    -- metric including its cron-context repair.
    and (auth.role() is null
         or auth.role() = 'service_role'
         or public.can_access_de(d.id))
  order by d.name;
end;
$function$;

revoke all on function public.get_de_work_metrics(uuid, integer) from public, anon;
grant execute on function public.get_de_work_metrics(uuid, integer) to authenticated, service_role;

notify pgrst, 'reload schema';

-- ── PROOF ────────────────────────────────────────────────────────────────────
do $a$
declare
  v_tenant uuid;
  r record;
  n_esc int;
  n_rows int;
begin
  select t.id into v_tenant from tenants t where t.slug = 'outsourcetel-hq';
  if v_tenant is null then
    raise notice '499: no fixture tenant — behavioural proof SKIPPED';
    return;
  end if;

  select count(*) into n_rows from get_de_work_metrics(v_tenant, 26);
  if n_rows = 0 then
    raise exception '499: the work metric returned no employees at all';
  end if;

  -- THE POINT OF THE WHOLE BLOCK: the Renewal DE holds real escalations that
  -- the answer-shaped metric cannot see. They must now be counted.
  select * into r from get_de_work_metrics(v_tenant, 26)
   where de_id = '40d688eb-016d-4f74-8049-1ab2f660182d';
  if r.de_id is null then
    raise notice '499: renewal employee not in scope for this connection — partial proof only';
  else
    select count(*) into n_esc from human_tasks
     where de_id = '40d688eb-016d-4f74-8049-1ab2f660182d' and type = 'escalation' and source = 'de';
    if r.escalations_raised = 0 and n_esc > 0 then
      raise exception '499: the renewal employee has % real escalations and the work metric counts 0', n_esc;
    end if;
    -- And the rate must be a real number now, where the answer-shaped one is
    -- honestly NULL because that employee has no evidence rows at all.
    if r.escalation_rate is null and (r.items_completed + r.items_cancelled + r.escalations_raised) > 0 then
      raise exception '499: work exists but the escalation rate is still not measured';
    end if;
    raise notice '499: renewal employee — % escalations (% unanswered), % items done, % cancelled, rate %',
      r.escalations_raised, r.escalations_unanswered, r.items_completed, r.items_cancelled, r.escalation_rate;
  end if;

  -- NULL discipline: an employee with no work at all must report no rate,
  -- never a fabricated zero (the mig-491 rule, applied from birth).
  select count(*) into n_rows from get_de_work_metrics(v_tenant, 26) m
   where m.items_completed = 0 and m.items_cancelled = 0 and m.escalations_raised = 0
     and m.escalation_rate is not null;
  if n_rows > 0 then
    raise exception '499: % employees with no work still report an escalation rate', n_rows;
  end if;

  raise notice '499: work is measurable in its own shape, with no change to any answer-shaped organ';
end $a$;
