-- 501_kpi_snapshot_stops_storing_fabricated_zeros.sql
-- ============================================================================
-- A live defect found while mapping the KPI machinery for block 3, in a place
-- migration 491 did not reach — and unlike 491's, this one drives BEHAVIOUR.
--
-- snapshot_de_kpi_readings resolves a metric as
--     coalesce( <platform computed value>, <action-table fallback> )
-- and the fallback is an ungrouped aggregate whose only source guard sits
-- INSIDE its WHERE clause. For a metric whose source is 'computed' the WHERE is
-- false, so the subquery scans zero rows — but an ungrouped count(*) over zero
-- rows returns 0, not NULL. The function's own `if rec.val is null then
-- continue` guard therefore never fires, and a fabricated 0 is written to
-- de_kpi_readings for exactly the "not measured" case 491 exists to eliminate.
--
-- get_de_kpi_status does NOT have this bug: the identical arm there is wrapped
-- in `case when coalesce(c.source,'') = 'action' then … end`. The wrapper was
-- dropped when the arm was copied into the snapshot. So the DISPLAY has been
-- honest and the STORE has not.
--
-- WHY IT MATTERS MORE THAN A WRONG NUMBER: run_work_watchers reads
-- de_kpi_readings to fire metric_threshold watchers, which OPEN AUTONOMOUS
-- OBJECTIVES. A watcher on resolution_rate with op='lt' fires on a fabricated
-- 0. Six such rows are stored right now, dated 2026-07-24 — and the store is
-- stale as well as false: the same employee's real values today are
-- resolution 47.2, confidence 92.6, escalation 52.8, all persisted as 0. The
-- value-change guard (`if v_last is not distinct from rec.val then continue`)
-- is what froze them: the fabricated 0 never changed, so the nightly job has
-- succeeded every day since without writing anything.
--
-- Fix: wrap the fallback in the same source guard the display uses, and delete
-- the fabricated rows so nothing keeps reading them. Recreated from the LIVE
-- definition (mig 377) — the checked-in migration 308 is stale and does not
-- contain the tenant_is_operational dormancy guard the live body carries.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.snapshot_de_kpi_readings(p_de_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_tenant uuid; m record; v_csat numeric; v_vals jsonb;
  rec record; v_last numeric; v_written int := 0;
begin
  -- Cron-safe: resolves tenant from the DE; never calls auth.uid()/auth_tenant_id().
  select tenant_id into v_tenant from digital_employees where id = p_de_id;
  if v_tenant is null then return 0; end if;

  -- Platform conversation/perf arm — reproduced VERBATIM from get_de_kpi_status
  -- (mig 263:58-72). CSAT sample count is unused here (no fallback), so omitted.
  select * into m from get_de_performance_metrics(v_tenant, 13) where de_id = p_de_id;
  select round(100.0 * count(*) filter (where csat_score = 1) / nullif(count(*) filter (where csat_submitted_at is not null), 0), 1)
    into v_csat
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

  -- Target set S = configured KPI targets ∪ active metric_threshold watcher keys
  -- for this DE. For each, resolve the PLATFORM value (computed v_vals, else the
  -- action arm from mig 263:85-100) — NEVER the manual fallback.
  for rec in
    with s as (
      select distinct mk from (
        select metric_key mk from de_kpis where de_id = p_de_id and metric_key is not null
        union
        select config->>'metric_key' from work_watchers
          where de_id = p_de_id and kind = 'metric_threshold' and active
            and config->>'metric_key' is not null
      ) u
    )
    select s.mk as metric_key,
           coalesce(
             (v_vals->>s.mk)::numeric,
             -- mig 501: the source guard must wrap the WHOLE subquery, not sit
             -- inside its WHERE. Without this wrapper a computed metric with no
             -- platform value resolves to 0 rather than NULL, and the snapshot
             -- PERSISTS that zero — which run_work_watchers then reads to open
             -- autonomous objectives against a number nobody measured.
             case when coalesce(cat.source, '') = 'action' then
             (select case when coalesce(cat.source_config->>'agg', 'count') = 'auto_rate'
                          then round(100.0 * count(*) filter (where ae.decision = 'auto_executed') / nullif(count(*), 0), 1)
                          else count(*)::numeric end
                from action_executions ae
                left join action_definitions ad on ad.id = ae.action_definition_id
               where cat.source = 'action'
                 and ae.tenant_id = v_tenant and ae.subject_kind = 'de' and ae.subject_id = p_de_id
                 and ae.rollback_of is null and ae.created_at >= now() - interval '91 days'
                 and (coalesce(cat.source_config->>'category', '') = '' or ad.category = cat.source_config->>'category')
                 and (coalesce(cat.source_config->>'action_label', '') = '' or ad.label = cat.source_config->>'action_label'))
             end
           ) as val
    from s
    left join kpi_metric_catalog cat
      on cat.metric_key = s.mk and (cat.tenant_id is null or cat.tenant_id = v_tenant)
  loop
    if rec.val is null then continue; end if;                      -- fix #2: NOT NULL guard
    select value into v_last from de_kpi_readings
      where de_id = p_de_id and metric_key = rec.metric_key and source = 'system'
      order by as_of desc, created_at desc limit 1;
    if v_last is not distinct from rec.val then continue; end if;  -- fix #1: value-change only
    insert into de_kpi_readings (tenant_id, de_id, metric_key, value, as_of, recorded_by, source)
    values (v_tenant, p_de_id, rec.metric_key, rec.val, current_date, null, 'system')
    on conflict (de_id, metric_key, as_of) where source = 'system'  -- fix #2: partial-index predicate
      do update set value = excluded.value, created_at = now();
    v_written := v_written + 1;
  end loop;
  return v_written;
end $function$
;

notify pgrst, 'reload schema';

do $a$
declare v_def text; n int;
begin
  v_def := pg_get_functiondef('public.snapshot_de_kpi_readings(uuid)'::regprocedure);
  if v_def not ilike '%case when coalesce(cat.source, %) = ''action'' then%'
     and v_def not ilike '%case when coalesce(cat.source,%''action''%then%' then
    raise exception '501: the source guard did not land — the snapshot still fabricates zeros';
  end if;
  -- The dormancy guard must survive the recreate (it is NOT in migration 308).
  if pg_get_functiondef('public.snapshot_all_de_kpi_readings()'::regprocedure) not ilike '%tenant_is_operational%' then
    raise exception '501: the mig-430 dormancy guard is missing from the driver';
  end if;
  raise notice '501: snapshot guarded';
end $a$;

-- Purge what was fabricated. These are stored measurements of metrics that were
-- never measured; leaving them means the watcher keeps reading them.
delete from de_kpi_readings r
 where r.value = 0
   and exists (
     select 1 from kpi_metric_catalog c
      where c.metric_key = r.metric_key
        and coalesce(c.source, '') <> 'action');

do $b$
declare n int;
begin
  select count(*) into n from de_kpi_readings r
   join kpi_metric_catalog c on c.metric_key = r.metric_key
   where r.value = 0 and coalesce(c.source, '') <> 'action';
  if n > 0 then
    raise exception '501: % fabricated zero readings survive', n;
  end if;
  raise notice '501: fabricated readings purged — the next snapshot writes only measured values';
end $b$;
