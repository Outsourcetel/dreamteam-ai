-- ═══════════════════════════════════════════════════════════════
-- 170 — Simulation studio (Frontier-20 #3)
--
-- "Test before customers do" — the 2026 table-stakes bar (Decagon
-- Simulations, Copilot Agent Evaluation). Run a scenario set through a DE
-- and score every answer with the LLM judge (mig 167), producing a
-- certification-grade result BEFORE the DE goes customer-facing.
--
-- Scenario modes: 'golden' (the tenant's golden_qa, with expected facts
-- as the judge reference), 'synthetic' (LLM-generated persona questions),
-- 'historical' (real past customer questions for this tenant). The
-- de-simulate edge function drives de-answer + eval-judge; this migration
-- is the run store + a certification path so a passing simulation can
-- satisfy the go-live gate (mig 162), alongside certify_de_from_eval.
--
-- HONEST SCOPE: v1 simulates the DE's CURRENT config (de-answer answers
-- from live config). True candidate-config diffing (test a proposed change
-- before applying it) needs a config-override on de-answer — a follow-up,
-- noted in the edge function header. The pre-go-live value holds today
-- because the cert gate blocks customer-facing stages until a sim passes.
-- ═══════════════════════════════════════════════════════════════

create table if not exists sim_runs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  de_id         uuid not null references digital_employees(id) on delete cascade,
  mode          text not null default 'synthetic' check (mode in ('golden', 'synthetic', 'historical')),
  status        text not null default 'running' check (status in ('running', 'passed', 'failed', 'blocked_llm', 'error')),
  total         integer not null default 0,
  passed        integer not null default 0,
  failed        integer not null default 0,
  avg_score     numeric not null default 0,
  threshold_pct integer not null default 80,
  -- [{question, answer, verdict, score, dimensions, rationale}]
  results       jsonb not null default '[]'::jsonb,
  created_by    uuid,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index if not exists sim_runs_de_idx on sim_runs(tenant_id, de_id, started_at desc);

alter table sim_runs enable row level security;
drop policy if exists sim_runs_read on sim_runs;
create policy sim_runs_read on sim_runs for select using (
  tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
  or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'));

-- Certify a DE from a passing simulation — mirrors certify_de_from_eval
-- (mig 162) but reads sim_runs, so the go-live gate has a second, richer
-- evidence source (semantic judge vs fragment-match golden runs).
create or replace function public.certify_de_from_sim(
  p_de_id uuid, p_archetype_key text, p_sim_run_id uuid, p_threshold_pct integer default 80
) returns jsonb
language plpgsql security definer set search_path to 'public' as $function$
declare v_tenant uuid; v_total int; v_passed int; v_pct numeric; v_status text;
begin
  select tenant_id into v_tenant from digital_employees where id = p_de_id;
  if v_tenant is null then raise exception 'de not found'; end if;
  if auth.uid() is not null and not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = v_tenant)) then
    raise exception 'not authorized';
  end if;

  select total, passed into v_total, v_passed from sim_runs
    where id = p_sim_run_id and tenant_id = v_tenant and de_id = p_de_id and status in ('passed', 'failed');
  if v_total is null or v_total = 0 then raise exception 'simulation has no results'; end if;
  v_pct := round(100.0 * v_passed / v_total, 1);
  v_status := case when v_pct >= p_threshold_pct then 'passed' else 'failed' end;

  insert into role_certifications (tenant_id, de_id, archetype_key, eval_run_id, score_pct, threshold_pct, status, evaluated_at)
  values (v_tenant, p_de_id, p_archetype_key, null, v_pct, p_threshold_pct, v_status, now());

  return jsonb_build_object('status', v_status, 'score_pct', v_pct, 'threshold_pct', p_threshold_pct, 'passed', v_passed, 'total', v_total, 'from', 'simulation');
end;
$function$;

revoke all on function public.certify_de_from_sim(uuid, text, uuid, integer) from public, anon;
grant execute on function public.certify_de_from_sim(uuid, text, uuid, integer) to authenticated, service_role;
