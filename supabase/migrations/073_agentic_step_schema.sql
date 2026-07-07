-- ============================================================
-- Migration 073: schema for the "agentic step" — a genuinely new
-- playbook primitive. Every other step type today is a human-
-- authored, pre-fixed instruction the executor walks through
-- mechanically. This one hands control to a real reasoning loop: given
-- a goal, it decides the next tool call, observes the result, and
-- decides again — adapting instead of following a script, the same
-- way a real operator (or Claude, driving this very session) works.
--
-- THE CENTRAL DESIGN DECISION: an agentic step's tool calls are not a
-- parallel action-taking system with its own safety model. Every tool
-- that writes or acts routes through the EXACT SAME `execute_action`
-- connector-hub call every deterministic `connector_action` playbook
-- step already uses — confirmed via direct code read that
-- `execute_action` internally and unconditionally composes
-- destructive-always-gates → guardrail-always-wins → trust-narrows-
-- within-guardrails (decide_action_execution, 037) with NO bypass path
-- other than resuming an already-human-approved gate. The agentic loop
-- becomes a smarter CALLER of that pipeline, not a new one.
--
-- This migration ships the schema only — the loop itself (migration
-- 074's edge function) is dormant until ANTHROPIC_API_KEY exists,
-- same pattern as de-answer/specialist-consult/eval-run. Every table
-- here is real, live, and independently testable without the key
-- (tool-list resolution, budget enforcement, transcript persistence
-- all being pure logic); only the actual reasoning is gated.
-- ============================================================

-- ============================================================
-- 1. agentic_step_policies — tenant-configurable hard limits.
-- Mirrors staleness_policies/knowledge_gap_policies exactly: tenant
-- owns and edits its own row directly via RLS, no RPC layer needed to
-- tune. One row per tenant (not per-category — a single budget
-- envelope to start; the research grounding for these defaults is
-- explicit: a real production incident burned $16-50k in 5 hours from
-- an agent loop with no iteration/cost cap at all — every one of
-- these four is a genuine, independently-enforced hard stop, not a
-- soft suggestion).
-- ============================================================
create table if not exists agentic_step_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  max_iterations integer not null default 15 check (max_iterations > 0),
  max_tokens integer not null default 100000 check (max_tokens > 0),
  max_cost_cents integer not null default 500 check (max_cost_cents > 0),
  max_no_progress_iterations integer not null default 3 check (max_no_progress_iterations > 0),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id)
);

alter table agentic_step_policies enable row level security;
alter table agentic_step_policies force row level security;

create policy agentic_step_policies_tenant_read on agentic_step_policies
  for select using (tenant_id = auth_tenant_id());

create policy agentic_step_policies_tenant_write on agentic_step_policies
  for all
  using (
    tenant_id = auth_tenant_id()
    and exists (select 1 from profiles where user_id = auth.uid() and role = any (array['tenant_owner', 'tenant_admin']))
  )
  with check (
    tenant_id = auth_tenant_id()
    and exists (select 1 from profiles where user_id = auth.uid() and role = any (array['tenant_owner', 'tenant_admin']))
  );

revoke all on agentic_step_policies from anon, authenticated;
grant select, insert, update, delete on agentic_step_policies to authenticated;
grant all on agentic_step_policies to service_role;

-- ============================================================
-- 2. agentic_step_runs — one row per agentic playbook step
-- invocation. Lives alongside playbook_runs the same way a
-- sub_playbook's child run does, but this isn't a child playbook run
-- — it's a bounded reasoning loop that eventually reports one result
-- back to the parent step. `de_id` is whose data_access_grants and
-- model_id/escalation_model_id govern this loop's tool availability
-- and which model reasons through it — reusing digital_employees'
-- existing model-config columns, confirmed genuinely unused by any
-- code path today (schema scaffolding from migrations 008/009, never
-- wired), rather than inventing new ones.
-- ============================================================
-- NON-BLOCKING BY DESIGN (see playbook-execute's agentic_step case): a
-- gated tool call inside the loop is routed to a human via
-- connector-hub's normal execute_action gate (the same human_tasks row
-- every connector_action gate already creates) and the loop is simply
-- told the action is pending — it does not pause here waiting for a
-- decision. So this run always reaches a terminal status in one HTTP
-- call; there is no 'waiting_approval' status to resume into.
create table if not exists agentic_step_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  playbook_run_id uuid not null references playbook_runs(id) on delete cascade,
  step_index integer not null,
  de_id uuid not null references digital_employees(id) on delete cascade,
  goal text not null,
  status text not null default 'running' check (status in (
    'running', 'completed', 'failed',
    'budget_exceeded', 'max_iterations_exceeded', 'no_progress', 'blocked_llm'
  )),
  iteration_count integer not null default 0,
  tokens_used integer not null default 0,
  cost_used_cents numeric not null default 0,
  -- Pointer to the LAST gate this run's tool calls triggered (if any) —
  -- an observability trail, not a resume point (see note above).
  last_gated_human_task_id uuid references human_tasks(id) on delete set null,
  last_progress_hash text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_agentic_step_runs_playbook_run on agentic_step_runs (playbook_run_id);
create index if not exists idx_agentic_step_runs_tenant_status on agentic_step_runs (tenant_id, status);

alter table agentic_step_runs enable row level security;
alter table agentic_step_runs force row level security;

create policy agentic_step_runs_tenant_read on agentic_step_runs
  for select using (tenant_id = auth_tenant_id());

revoke all on agentic_step_runs from anon, authenticated;
grant select on agentic_step_runs to authenticated;
grant all on agentic_step_runs to service_role;

-- ============================================================
-- 3. agentic_step_messages — the full transcript. Every turn (the
-- model's response, every tool_use block, every tool_result) is
-- persisted verbatim, not summarized — this is what makes an
-- autonomous reasoning loop auditable rather than a black box, the
-- same transparency standard every other automated decision on this
-- platform is held to.
-- ============================================================
create table if not exists agentic_step_messages (
  id uuid primary key default gen_random_uuid(),
  agentic_step_run_id uuid not null references agentic_step_runs(id) on delete cascade,
  turn_index integer not null,
  role text not null check (role in ('user', 'assistant', 'tool_result')),
  content jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_agentic_step_messages_run on agentic_step_messages (agentic_step_run_id, turn_index);

alter table agentic_step_messages enable row level security;
alter table agentic_step_messages force row level security;

create policy agentic_step_messages_tenant_read on agentic_step_messages
  for select using (
    exists (select 1 from agentic_step_runs r where r.id = agentic_step_run_id and r.tenant_id = auth_tenant_id())
  );

revoke all on agentic_step_messages from anon, authenticated;
grant select on agentic_step_messages to authenticated;
grant all on agentic_step_messages to service_role;

-- ============================================================
-- 4. 9th feature_registry entry. Ships on by default like the other
-- 8 — harmless while dormant (the step type validates and can be
-- authored into a playbook; it just can't actually run its reasoning
-- loop until ANTHROPIC_API_KEY exists, at which point it activates
-- with zero further migration).
-- ============================================================
insert into feature_registry (key, label, description, default_enabled, category)
values (
  'agentic_playbook_steps',
  'Agentic Playbook Steps',
  'Lets a playbook hand a step to a real reasoning loop instead of a fixed script — the DE decides what to do next based on what it observes, calling only tools it has been granted access to, with every action still passing through the same trust and guardrail checks as everything else.',
  true,
  'automation'
)
on conflict (key) do nothing;
