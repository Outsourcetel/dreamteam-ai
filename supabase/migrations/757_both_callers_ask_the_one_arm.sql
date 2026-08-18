-- ============================================================================
-- 757 — both callers ask the one arm.
--
-- The second half of docs/54 item 12's "extract before extending". Mig 756 put
-- the action arm in one place and proved it identical; this switches the two
-- callers onto it and deletes the copies. After this, `from action_executions`
-- appears in NEITHER function — so the next metric shape is written once.
--
-- NO BEHAVIOUR CHANGE. Both bodies are generated from the LIVE
-- pg_get_functiondef with exactly one expression replaced each, and the
-- generator REFUSES if either is not the shape it was written against, so a
-- concurrent session's edit cannot be silently overwritten.
--
-- ⚠ IT ALSO REMOVES A STRAY CARRIAGE RETURN. The stored source of
-- snapshot_de_kpi_readings carried a lone \r on the `case when
-- coalesce(cat.source...` line — a CRLF baked in when that migration was
-- written on Windows. The generator's exact-match guard FAILED on it, which is
-- the guard working: an invisible byte is exactly the kind of difference that
-- should stop an automated rewrite rather than be papered over. It is
-- normalised deliberately here, not silently.
--
-- mig 501's guard is NOT lost. It moved INSIDE de_kpi_action_value: a
-- non-'action' metric still resolves to NULL rather than 0, so
-- snapshot_de_kpi_readings still cannot persist a zero nobody measured. The
-- wrapper disappearing from this file is the wrapper being centralised, and
-- the migration says so in both places so the next reader does not "restore"
-- it.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_de_kpi_status(p_de_id uuid)
 RETURNS TABLE(kpi_id uuid, name text, metric_key text, target numeric, direction text, current numeric, met boolean, sample bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_tenant uuid; m record; v_csat numeric; v_csat_n bigint; v_vals jsonb; v_samples jsonb;
begin
  select tenant_id into v_tenant from digital_employees where id = p_de_id and public.can_access_de(id);
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
  -- mig 757: the arm lives in ONE place now (mig 756). Same expression,
  -- proven identical over 1143 (metric x employee) pairs before the switch.
  left join lateral public.de_kpi_action_value(v_tenant, p_de_id, c.source, c.source_config) act on true
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
             -- mig 757: one arm (mig 756). It carries mig 501's guard
             -- INTERNALLY — a non-'action' metric still returns NULL, never 0 —
             -- so that wrapper moved into the function rather than being lost.
             (select a.v from public.de_kpi_action_value(v_tenant, p_de_id, cat.source, cat.source_config) a)
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
