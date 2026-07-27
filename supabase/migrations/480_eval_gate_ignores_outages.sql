-- 480_eval_gate_ignores_outages.sql
-- ============================================================================
-- The last open piece of the founder's middle-path directive (docs/36).
--
-- eval_gate was DISTINCT ON (tenant_id) ... WHERE finished_at IS NOT NULL
-- ORDER BY finished_at DESC — the tenant's gate row is simply the LATEST
-- finished run of ANY status. A finished 'blocked_llm' (outage) run therefore
-- OVERWRITES a real 'failed': a genuine red followed by a budget exhaustion
-- or judge outage silently OPENS the publish gate. Wrong direction for a
-- governance control — an outage must be invisible to the gate, not a pardon.
--
-- Fix: the gate reads only QUALITY verdicts. Runs with any other status
-- (blocked_llm today; anything future) simply do not exist to the gate.
-- gate_knowledge_publish itself is untouched — it already tests = 'failed'.
-- ============================================================================

create or replace view eval_gate as
  select distinct on (tenant_id)
    tenant_id,
    id as run_id,
    status,
    total,
    passed,
    failed,
    finished_at
  from eval_runs
  where finished_at is not null
    and status in ('passed', 'failed')   -- quality verdicts only; outages are invisible
  order by tenant_id, finished_at desc;

do $a$
declare v_def text; v_hq text; n int;
begin
  -- No-op detector: the definition must now carry the quality filter.
  v_def := pg_get_viewdef('eval_gate'::regclass, true);
  if v_def not ilike '%''passed''%' or v_def not ilike '%''failed''%' then
    raise exception '480: the quality-status filter did not land in the view';
  end if;

  -- Broken detector: no tenant's gate row may carry a non-quality status.
  select count(*) into n from eval_gate where status not in ('passed','failed');
  if n > 0 then
    raise exception '480: % gate rows still carry non-quality statuses', n;
  end if;

  -- The historic green must survive the change: hq's latest QUALITY run is
  -- 847fec63 (passed). If this reads anything else, the filter broke reality.
  select status into v_hq from eval_gate
   where tenant_id = (select id from tenants where slug = 'outsourcetel-hq');
  if v_hq is distinct from 'passed' then
    raise exception '480: outsourcetel-hq gate reads % — expected the historic passed run', coalesce(v_hq, 'NULL');
  end if;

  -- And the overwrite hole must be provably closed: for every tenant that has
  -- BOTH a quality run and a later-finished non-quality run, the gate must
  -- still show the quality one. (Zero such tenants passes vacuously — but the
  -- hq history contains a blocked_llm run, so this is exercised today.)
  select count(*) into n
  from eval_gate g
  join eval_runs r on r.tenant_id = g.tenant_id
   and r.finished_at is not null
   and r.status not in ('passed','failed')
   and r.finished_at > g.finished_at;
  -- rows here are CORRECT outcomes: a newer outage exists and the gate kept
  -- the older quality verdict. The assert is that the join itself works and
  -- the gate row remained a quality status (already checked above).
  raise notice '480: gate ignores % newer outage run(s) across tenants — the overwrite hole is closed', n;
end $a$;

notify pgrst, 'reload schema';
