-- 308_gi5_kpi_snapshot_feeder.sql
-- ============================================================================
-- GI-5 (Governance Integrity) — FEED THE STARVED METRIC WATCHERS.
--
-- The metric_threshold arm of run_work_watchers (mig 272:481-501) reads ONLY
-- persisted de_kpi_readings rows, but de_kpi_readings has exactly one writer
-- today (record_kpi_reading — manual/human). get_de_kpi_status COMPUTES live
-- platform KPI values but never persists them, so for any metric that isn't
-- hand-entered the watcher finds LIMIT-1 = no row and never fires. This bridges
-- compute→persist with a pure-SQL cron snapshot.
--
-- Three adversarial-review fixes folded in (do NOT ship without them):
--  1. VALUE-CHANGE-IDEMPOTENT. The watcher's occurrence_key includes as_of, and
--     it dedups on (watcher_id, occurrence_key). A naive daily as_of stamp would
--     open ONE new autonomous de_objective per day per (DE, metric, threshold)
--     across ALL tenants for any SUSTAINED breach — a real cost/governance
--     regression (de_objectives feed de-work). Fix: only write when the computed
--     value CHANGED vs the last system reading, so as_of stays anchored on a
--     steady value → no daily re-open; re-fires correctly on change/recovery.
--  2. SAFE WRITE. value is NOT NULL → guard v_val IS NOT NULL. The uniqueness is
--     a PARTIAL index (WHERE source='system') → ON CONFLICT must repeat the
--     predicate or it faults on the 2nd intraday change.
--  3. FAIL-CLOSED TENANT ISOLATION. The writer is SECURITY DEFINER and resolves
--     tenant from the arg with no caller-tenant check (it must, to run under
--     cron). So EXECUTE is REVOKED from public/anon/authenticated — never rely
--     on get_de_performance_metrics incidentally raising for a foreign caller.
--
-- Platform arms (computed + action) are reproduced from get_de_kpi_status
-- (mig 263) but the MANUAL fallback is dropped, so the snapshot never echoes a
-- human reading back as a system row. GLOBAL.
-- ============================================================================

-- (A) Separate system snapshots from human rows -------------------------------
alter table public.de_kpi_readings
  add column if not exists source text not null default 'manual'
  check (source in ('manual','system'));
-- One system row per (DE, metric, day); manual rows stay multi-per-day.
create unique index if not exists de_kpi_readings_system_daily
  on public.de_kpi_readings (de_id, metric_key, as_of) where source = 'system';

-- (B) Keep get_de_kpi_status's manual FALLBACK human-only -----------------------
-- Reproduced VERBATIM from mig 263:46-111; the ONLY change is `and d.source =
-- 'manual'` in the manual-reading lateral so future system rows never leak in as
-- a KPI-status fallback value. Backward-compatible: every existing row is
-- 'manual' today, so output is byte-identical and the return shape is unchanged.
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
       and d.source = 'manual'                    -- GI-5: fallback = human readings only
     order by d.as_of desc, d.created_at desc limit 1
  ) r on true
  cross join lateral (
    select coalesce((v_vals->>k.metric_key)::numeric, act.v, r.value) as v,
           coalesce((v_samples->>k.metric_key)::bigint, nullif(act.n, 0), r.rn, coalesce(m.total_decisions, 0)) as n
  ) cur;
end $function$;

-- (C) Per-DE snapshot writer (pure SQL; cron-safe; fail-closed grants) ---------
create or replace function public.snapshot_de_kpi_readings(p_de_id uuid)
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
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
end $fn$;
revoke all on function public.snapshot_de_kpi_readings(uuid) from public, anon, authenticated;  -- fix #3
grant execute on function public.snapshot_de_kpi_readings(uuid) to service_role;

-- (D) All-DE driver + retention + daily cron ----------------------------------
create or replace function public.snapshot_all_de_kpi_readings()
returns jsonb language plpgsql security definer set search_path = public, extensions as $fn$
declare d record; v_total int := 0; v_des int := 0;
begin
  for d in
    select id from digital_employees
     where coalesce(lifecycle_status, 'active') not in ('retired', 'archived')
  loop
    begin
      v_total := v_total + public.snapshot_de_kpi_readings(d.id);   -- per-DE isolation
      v_des := v_des + 1;
    exception when others then
      raise warning 'snapshot_de_kpi_readings(%) failed: %', d.id, sqlerrm;
    end;
  end loop;
  -- Retention: system snapshots are cheap to recompute; keep 180 days.
  delete from de_kpi_readings where source = 'system' and as_of < current_date - 180;
  return jsonb_build_object('des', v_des, 'written', v_total);
end $fn$;
revoke all on function public.snapshot_all_de_kpi_readings() from public, anon, authenticated;
grant execute on function public.snapshot_all_de_kpi_readings() to service_role;

-- Daily at 06:30 UTC — pure SQL (get_de_performance_metrics is a SQL function),
-- runs as the cron owner (postgres), no edge-fn dispatch needed. Idempotent
-- re-schedule (established idiom, mig 278).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'kpi-snapshot-daily') then
    perform cron.unschedule('kpi-snapshot-daily');
  end if;
  perform cron.schedule('kpi-snapshot-daily', '30 6 * * *', 'select public.snapshot_all_de_kpi_readings()');
end $$;

NOTIFY pgrst, 'reload schema';
