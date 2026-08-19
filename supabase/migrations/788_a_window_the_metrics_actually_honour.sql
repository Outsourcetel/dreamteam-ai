-- 788_a_window_the_metrics_actually_honour.sql
-- ==========================================================================
-- Register item C-12, from the whole-branch review of migs 768-785.
--
-- Mig 765 is titled "a review judges the goals you set OVER THE WINDOW IT
-- NAMES", and its summary text and the improvement plan it opens both cite
-- that window. Two of the metrics it judges never honoured it:
--
--   * the CSAT read had NO time filter whatsoever -- an all-time figure
--     inside a payload where every other number was windowed;
--   * the action arm was hard-fixed at `interval '91 days'` and never
--     referenced p_window_weeks at all.
--
-- Only the four get_de_performance_metrics-derived metrics were honest.
--
-- MEASURED BEFORE TOUCHING ANYTHING: 0 CSAT rows exist in the entire
-- database, and 0 action_executions are older than 91 days. So at the
-- default 13 weeks this migration changes NO current number, and the
-- differential below proves that rather than asserting it. The value is
-- that a SHORTER window now tells the truth -- which is the whole reason
-- 765 made the window a parameter.
--
-- 13 weeks x 7 = 91 days exactly, so the default is the old constant. Every
-- existing caller that passes nothing keeps its behaviour; only a caller
-- that asks for a different window sees a different answer, which is the
-- point.
-- ==========================================================================

begin;
-- the action arm takes the window it is measuring ------------------------
--
-- ⚠ DROP FIRST. Adding a DEFAULTed parameter creates a SECOND overload; it
-- does not replace the first. Without this drop the 91-day version survives
-- and a 4-argument call becomes AMBIGUOUS between the two. Mig 758 hit this
-- exact trap and dropped the old signature for the same reason. The two live
-- callers (de_kpi_status_internal, snapshot_de_kpi_readings) both pass four
-- arguments and keep working, resolving to the default of 13 weeks — which
-- is the 91 days they already had.
drop function if exists public.de_kpi_action_value(uuid,uuid,text,jsonb);

CREATE OR REPLACE FUNCTION public.de_kpi_action_value(p_tenant_id uuid, p_de_id uuid, p_source text, p_source_config jsonb, p_window_weeks integer DEFAULT 13)
 RETURNS TABLE(v numeric, n bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select
    -- ⚠ mig 501's guard. A non-'action' metric MUST come back NULL, never 0.
    case when coalesce(p_source, '') = 'action' then
      case when coalesce(p_source_config->>'agg', 'count') = 'auto_rate'
           then round(100.0 * count(*) filter (where ae.decision = 'auto_executed') / nullif(count(*), 0), 1)
           else count(*)::numeric end
    end                                            as v,
    count(*)                                       as n
    from action_executions ae
    left join action_definitions ad on ad.id = ae.action_definition_id
   where p_source = 'action'
     and ae.tenant_id = p_tenant_id
     and ae.subject_kind = 'de'
     and ae.subject_id = p_de_id
     and ae.rollback_of is null
     and ae.created_at >= now() - (p_window_weeks * interval '7 days')
     and (coalesce(p_source_config->>'category', '')     = '' or ad.category = p_source_config->>'category')
     and (coalesce(p_source_config->>'action_label', '') = '' or ad.label    = p_source_config->>'action_label')
$function$
;

-- the status payload windows CSAT and passes the window down -------------

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
  from de_conversations where tenant_id = p_tenant_id and de_id = p_de_id
     -- ⚠ THE WINDOW THIS FUNCTION IS ASKED FOR. It had NO time filter at
     -- all, so csat_pct was an all-time figure sitting in a payload whose
     -- every other number honoured p_window_weeks, and a review calling
     -- itself "13 weeks" published it as such.
     --
     -- Restricting here also restricts the NUMERATOR, which previously
     -- counted csat_score = 1 rows whose csat_submitted_at was null while
     -- the denominator did not — a ratio that could exceed 100%. Naming it
     -- rather than leaving it: there is no way to window this read without
     -- touching that, and leaving it while editing this very expression
     -- would be the worse choice.
     and csat_submitted_at >= now() - (p_window_weeks * interval '7 days');

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
  left join lateral public.de_kpi_action_value(p_tenant_id, p_de_id, c.source, c.source_config, p_window_weeks) act on true
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

-- proof, in the migration: the window must actually BITE ------------------
do $verify$
declare
  v_t uuid; v_de uuid; v_wide numeric; v_narrow numeric; v_n_wide bigint; v_n_narrow bigint;
  v_rows int; v_src text;
begin
  -- (1) the literal is gone and the parameter is used
  select regexp_replace(prosrc,'--[^' || chr(10) || ']*','','g') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='de_kpi_action_value';
  -- exactly ONE overload, or a 4-arg call from either live caller is ambiguous
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.proname='de_kpi_action_value') <> 1 then
    raise exception 'VERIFY FAILED: de_kpi_action_value has % overloads, not 1',
      (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='de_kpi_action_value');
  end if;
  if v_src ~ '91 days' then
    raise exception 'VERIFY FAILED: de_kpi_action_value still hard-codes 91 days';
  end if;

  -- a 4-argument call must still RESOLVE — both live callers make one
  perform * from public.de_kpi_action_value(
    '00000000-0000-0000-0000-000000000000'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid, 'action', '{}'::jsonb);
  if v_src !~ 'p_window_weeks' then
    raise exception 'VERIFY FAILED: de_kpi_action_value ignores p_window_weeks';
  end if;

  -- (2) the CSAT read is windowed
  select regexp_replace(prosrc,'--[^' || chr(10) || ']*','','g') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='de_kpi_status_internal';
  if v_src !~ 'csat_submitted_at >= now' then
    raise exception 'VERIFY FAILED: the csat read is still unwindowed';
  end if;

  -- (3) ⚠ THE ONE THAT CAN ACTUALLY FAIL. A source grep proves the text
  --     changed, not that the window BITES. Find an employee with action
  --     rows and show a 1-week window returns no more than a 52-week one,
  --     and strictly fewer once any row is older than a week.
  select ae.tenant_id, ae.subject_id into v_t, v_de
    from action_executions ae
   where ae.subject_kind = 'de' and ae.rollback_of is null
   group by ae.tenant_id, ae.subject_id
   order by count(*) desc limit 1;

  if v_t is null then
    raise notice 'VERIFY SKIPPED: no action_executions exist to window';
  else
    select v, n into v_wide,   v_n_wide   from public.de_kpi_action_value(v_t, v_de, 'action', '{}'::jsonb, 52);
    select v, n into v_narrow, v_n_narrow from public.de_kpi_action_value(v_t, v_de, 'action', '{}'::jsonb, 1);
    if v_n_narrow > v_n_wide then
      raise exception 'VERIFY FAILED: a 1-week window returned MORE rows (%) than 52 weeks (%)', v_n_narrow, v_n_wide;
    end if;
    select count(*) into v_rows from action_executions ae
     where ae.tenant_id = v_t and ae.subject_kind = 'de' and ae.subject_id = v_de
       and ae.rollback_of is null and ae.created_at < now() - interval '7 days';
    if v_rows > 0 and v_n_narrow >= v_n_wide then
      raise exception 'VERIFY FAILED: % row(s) are older than a week, yet the 1-week window returned % and 52 weeks returned % — the window is not biting', v_rows, v_n_narrow, v_n_wide;
    end if;
    raise notice 'window bites: 52w n=%, 1w n=%, rows older than 1w=%', v_n_wide, v_n_narrow, v_rows;
  end if;
end
$verify$;

commit;
