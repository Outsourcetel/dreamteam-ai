-- ============================================================
-- Migration 018: Proving Ground v1 (R3)
-- golden_qa: per-tenant golden question/answer suites.
-- eval_runs: history of eval runs against the LIVE DE (de-answer).
-- eval_gate: latest finished run per tenant (drives the
--   knowledge-publish soft gate in the client).
-- RLS: tenant-scoped reads/writes for golden_qa; tenant-scoped
--   READ for eval_runs (writes come from the eval-run edge
--   function via service role, which bypasses RLS).
-- NOTE: deliberately does NOT touch the activity_events /
--   audit_events category constraints (parallel migrations 016/017
--   may alter them) — eval audit entries use the existing
--   'config_change' category with detail.kind='eval_run'.
-- ============================================================

-- Shared updated_at trigger function (idempotent — also in 001/011/012)
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================
-- TABLE: golden_qa
-- ============================================================
create table if not exists golden_qa (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  question           text not null,
  -- The DE's answer must contain ALL fragments (case-insensitive) to pass.
  expected_fragments text[] not null default '{}',
  min_confidence     integer not null default 60 check (min_confidence between 0 and 100),
  category           text not null default 'knowledge'
                       check (category in ('knowledge', 'procedure', 'guardrail', 'escalation', 'calibration')),
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists golden_qa_tenant_idx on golden_qa(tenant_id);

alter table golden_qa enable row level security;

drop policy if exists "golden_qa_tenant_isolation" on golden_qa;
create policy "golden_qa_tenant_isolation" on golden_qa
  for all
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()))
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

drop trigger if exists golden_qa_updated_at on golden_qa;
create trigger golden_qa_updated_at
  before update on golden_qa
  for each row execute function update_updated_at();

-- ============================================================
-- TABLE: eval_runs
-- ============================================================
create table if not exists eval_runs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  trigger     text not null default 'manual'
                check (trigger in ('manual', 'knowledge_publish', 'scheduled')),
  status      text not null default 'running'
                check (status in ('running', 'passed', 'failed', 'blocked_llm')),
  total       integer not null default 0,
  passed      integer not null default 0,
  failed      integer not null default 0,
  -- Per-question results: [{qa_id, question, answer?, confidence?, passed, reason}]
  results     jsonb not null default '[]'::jsonb,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists eval_runs_tenant_idx on eval_runs(tenant_id, started_at desc);

alter table eval_runs enable row level security;

-- Tenant-scoped READ only; all writes go through the eval-run edge
-- function using the service role (bypasses RLS by design).
drop policy if exists "eval_runs_tenant_read" on eval_runs;
create policy "eval_runs_tenant_read" on eval_runs
  for select
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

-- ============================================================
-- VIEW: eval_gate — latest FINISHED run per tenant.
-- security_invoker so the underlying eval_runs RLS applies to
-- the querying user (no cross-tenant leak through the view).
-- ============================================================
drop view if exists eval_gate;
create view eval_gate
with (security_invoker = true) as
select distinct on (tenant_id)
  tenant_id, id as run_id, status, total, passed, failed, finished_at
from eval_runs
where finished_at is not null
order by tenant_id, finished_at desc;
