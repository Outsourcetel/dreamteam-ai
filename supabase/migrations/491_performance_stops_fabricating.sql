-- 491_performance_stops_fabricating.sql
-- ============================================================================
-- docs/37 MOVE 0 — stop the lies. Non-optional under the honesty mandate.
--
-- THE HEADLINE LIE, re-verified live on 2026-07-28: the Renewal DE's
-- performance tab reports escalation_rate = 0 while that employee holds NINE
-- human_tasks of type='escalation' (4 of them rejected) and FOUR de_exceptions.
-- 14 of outsourcetel-hq's 16 employees render an entire row of fabricated
-- zeros. A manager reading that page is told the opposite of reality.
--
-- The mechanism: the final SELECT LEFT JOINs every digital_employees row onto
-- the measurement CTEs, then coalesce(...,0) turns "this was never measured"
-- into a displayed number. The inner CTEs are already CORRECT — nullif() and
-- the avg-filters produce proper NULLs — so the whole lie lives in the
-- coalesce wrappers.
--
-- WHAT CHANGES (5 of 12 columns) — "not measured":
--   resolution_rate, avg_confidence, escalation_rate, error_rate,
--   avg_frustration_score
-- WHAT DELIBERATELY DOES NOT (a zero here is a TRUE measurement, and turning
-- it into "no data" would trade one lie for another):
--   total_decisions, blocked_guardrail_count, total_runs,
--   high_frustration_count, trend ('[]')
-- error_rate keeps its computed 0.0 when runs exist and no run failed — that
-- is a real zero. It becomes NULL only when there were no runs at all.
--
-- SECOND BUG, found in the same body and arguably worse: p_weeks is IGNORED by
-- every scalar column. Only the `weekly` CTE filters on it; `decisions` and
-- `runs` carry no date predicate, so all nine scalar metrics are ALL-TIME
-- regardless of the window asked for. The consequence is not cosmetic —
-- de_governance_sweep_internal calls this with p_weeks=4 under a comment
-- saying "RE-MEASURE on a fresh 4-week window" and uses the answer to decide
-- whether a performance-improvement plan PASSED or FAILED. An employee could
-- never age out of a bad month, because the "fresh window" was its whole life.
-- Both CTEs now honour the window.
--
-- All twelve column names, types and order are preserved byte-for-byte; the
-- five newly-nullable columns were ALREADY declared `numeric` in RETURNS TABLE,
-- so no signature change is required. Every downstream SQL consumer was checked
-- and is already NULL-safe (they gate on total_decisions >= 10 or coalesce
-- themselves). The CLIENT is the other half of this fix and is handled in the
-- same commit — Math.round(null) is 0 in JavaScript, so the lie would otherwise
-- survive at the render sites.
--
-- Reproduced from the LIVE definition (pg_get_functiondef, 2026-07-28), per the
-- mig-377 lesson. The mig-454 cron-context guard and the mig-385/435 DE scoping
-- are carried through unchanged.
-- ============================================================================

create or replace function public.get_de_performance_metrics(p_tenant_id uuid, p_weeks integer DEFAULT 26)
returns table(de_id uuid, de_name text, total_decisions bigint, resolution_rate numeric, avg_confidence numeric, escalation_rate numeric, blocked_guardrail_count bigint, total_runs bigint, error_rate numeric, avg_frustration_score numeric, high_frustration_count bigint, trend jsonb)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.role() is not null and auth.role() <> 'service_role' then
    if auth.uid() is null then
      raise exception 'not authenticated';
    end if;
    if not (
      is_platform_admin()
      or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = p_tenant_id)
    ) then
      raise exception 'not authorized to view this workspace''s performance data';
    end if;
  end if;

  return query
    with decisions as (
      select er.de_id as d_de_id, d.confidence as d_confidence, d.decision as d_decision,
        d.human_task_id as d_human_task_id, d.created_at as d_created_at,
        d.frustration_score as d_frustration_score
      from evidence_run_decisions d
      join evidence_runs er on er.id = d.evidence_run_id
      where er.tenant_id = p_tenant_id and er.de_id is not null
        -- p_weeks now means what it says. Without this the "fresh 4-week
        -- re-measure" behind every PIP verdict read the employee's whole life.
        and d.created_at > now() - (greatest(1, p_weeks) || ' weeks')::interval
    ),
    runs as (
      select er.de_id as r_de_id, er.status as r_status
      from evidence_runs er
      where er.tenant_id = p_tenant_id and er.de_id is not null
        and er.created_at > now() - (greatest(1, p_weeks) || ' weeks')::interval
    ),
    summary as (
      select
        dec.d_de_id as s_de_id,
        count(*) as total_decisions,
        round(100.0 * count(*) filter (where dec.d_decision <> 'needs_review') / nullif(count(*), 0), 1) as resolution_rate,
        round(avg(dec.d_confidence) filter (where dec.d_confidence is not null), 1) as avg_confidence,
        round(100.0 * count(*) filter (where dec.d_decision = 'needs_review') / nullif(count(*), 0), 1) as escalation_rate,
        count(*) filter (where dec.d_decision = 'blocked_guardrail') as blocked_guardrail_count,
        round(avg(dec.d_frustration_score) filter (where dec.d_frustration_score is not null), 1) as avg_frustration_score,
        count(*) filter (where dec.d_frustration_score >= 50) as high_frustration_count
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
      -- COUNTS stay coalesced: an employee that made no decisions genuinely
      -- made zero, and "no data" would be the lie in the other direction.
      coalesce(s.total_decisions, 0),
      -- RATES are no longer invented. NULL means "not measured", which is the
      -- truth for every employee whose work never produced this evidence.
      s.resolution_rate,
      s.avg_confidence,
      s.escalation_rate,
      coalesce(s.blocked_guardrail_count, 0),
      coalesce(rs.total_runs, 0),
      -- NULL only when there were no runs at all; a computed 0.0 over real
      -- runs is a true zero and survives.
      rs.error_rate,
      s.avg_frustration_score,
      coalesce(s.high_frustration_count, 0),
      coalesce(t.trend, '[]'::jsonb)
    from digital_employees de
    left join summary s on s.s_de_id = de.id
    left join run_summary rs on rs.rs_de_id = de.id
    left join trend_agg t on t.t_de_id = de.id
    where de.tenant_id = p_tenant_id
      -- DE scoping (mig 385/435), REPAIRED by mig 454. The trusted-server test
      -- MIRRORS this function's own membership gate at the top of the body;
      -- 435 omitted it, so pg_cron — direct connection, no JWT, auth.role()
      -- NULL — failed the guard for every employee and four jobs read nothing.
      and (auth.role() is null
           or auth.role() = 'service_role'
           or public.can_access_de(de.id))
    order by de.name;
end;
$function$;

-- ── the other fabricated number ─────────────────────────────────────────────
-- digital_employees.success_rate is NOT NULL DEFAULT 100.00 with ZERO writers
-- and ZERO readers: all 117 rows platform-wide read exactly 100.00. It is a
-- perfect score nobody earned, sitting in the data waiting for a reader to
-- believe it. Drop the default and null the untouched rows so the next reader
-- gets "not measured" rather than "flawless".
alter table public.digital_employees alter column success_rate drop not null;
alter table public.digital_employees alter column success_rate drop default;
update public.digital_employees set success_rate = null where success_rate = 100.00;

notify pgrst, 'reload schema';

-- ── PROOF ────────────────────────────────────────────────────────────────────
do $a$
declare
  v_def text;
  v_tenant uuid;
  r record;
  n_real int;
  n_fab int;
begin
  v_def := pg_get_functiondef('public.get_de_performance_metrics(uuid,integer)'::regprocedure);

  -- No-op detectors: the five rates must no longer be wrapped.
  if v_def ilike '%coalesce(s.escalation_rate%' or v_def ilike '%coalesce(s.resolution_rate%'
     or v_def ilike '%coalesce(s.avg_confidence%' or v_def ilike '%coalesce(rs.error_rate%'
     or v_def ilike '%coalesce(s.avg_frustration_score%' then
    raise exception '491: a rate is still coalesced to zero — the lie survives';
  end if;
  -- ...and the true counts must STILL be wrapped. Over-applying the fix is its
  -- own defect: it would report "no data" for a genuine zero.
  if v_def not ilike '%coalesce(s.total_decisions, 0)%'
     or v_def not ilike '%coalesce(rs.total_runs, 0)%'
     or v_def not ilike '%coalesce(s.blocked_guardrail_count, 0)%'
     or v_def not ilike '%coalesce(s.high_frustration_count, 0)%'
     or v_def not ilike '%coalesce(t.trend%' then
    raise exception '491: a TRUE zero was turned into null — over-applied';
  end if;
  -- The window bug must be closed on BOTH scalar CTEs.
  if v_def not ilike '%and d.created_at > now()%' or v_def not ilike '%and er.created_at > now()%' then
    raise exception '491: p_weeks is still ignored by the scalar metrics';
  end if;
  -- The cron-context guard (mig 454) must have survived the recreate.
  if v_def not ilike '%auth.role() is null%' then
    raise exception '491: lost the mig-454 cron-context guard';
  end if;

  -- BEHAVIOURAL: on the real tenant, an employee with no evidence must now
  -- report NULL rates, and the one employee that HAS evidence must keep real
  -- numbers. A definition check alone would pass a function that returned
  -- nothing at all.
  select t.id into v_tenant from tenants t where t.slug = 'outsourcetel-hq';
  if v_tenant is null then
    raise notice '491: no fixture tenant — behavioural proof SKIPPED';
    return;
  end if;

  select count(*) filter (where m.total_decisions = 0 and m.escalation_rate is null),
         count(*) filter (where m.total_decisions = 0 and m.escalation_rate is not null)
    into n_real, n_fab
    from get_de_performance_metrics(v_tenant, 26) m;

  if n_fab > 0 then
    raise exception '491: % employees with zero decisions still report an escalation rate', n_fab;
  end if;
  if n_real = 0 then
    raise exception '491: no unmeasured employees found — the proof did not exercise the fix';
  end if;

  -- The employee that DOES have evidence must still carry real numbers.
  select count(*) into n_fab from get_de_performance_metrics(v_tenant, 26) m
   where m.total_decisions > 0 and m.escalation_rate is null;
  if n_fab > 0 then
    raise exception '491: % measured employees lost their real rate', n_fab;
  end if;

  select count(*) into n_fab from digital_employees where success_rate is not null;
  raise notice '491: % employees now report "not measured" instead of fabricated zeros; % still carry a success_rate', n_real, n_fab;
end $a$;
