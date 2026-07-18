-- ═══════════════════════════════════════════════════════════════
-- 182 — Computer-use executor: the GATES, before the capability
--       (Frontier-20 #18 — "scaffold now, gate hard")
--
-- No browser/computer-use runtime exists in this platform today, and
-- this migration does NOT pretend one does. It builds the governance
-- rails FIRST, so that when a runtime lands it physically cannot run
-- ungoverned — the inverse of bolting safety onto a shipped capability.
--
-- PROVABLY INERT TODAY, by construction (each independently sufficient):
--   1. feature 'computer_use' ships default_enabled = FALSE — proposals
--      are refused per tenant until the flag is turned on.
--   2. computer_use_runtimes is EMPTY and only service-role can register
--      one — with zero active runtimes, no task can ever be claimed.
--   3. Every task requires an explicit human approval (approval_gate)
--      before it is even claimable, and a DB trigger — not an RPC
--      convention — blocks the claimed/running transitions unless the
--      approval is 'approved' AND an active runtime holds the claim.
--
-- CONSTRAINED-TASK-ONLY: a task must name its allowed domains (≥1) and
-- carries a bounded step budget. The runtime contract (docs/) requires
-- the worker to enforce the domain allowlist at navigation time, refuse
-- credential entry, and append a screenshot/step audit to the task row.
-- ═══════════════════════════════════════════════════════════════

insert into feature_registry (key, label, description, default_enabled, category)
values ('computer_use',
        'Computer-use tasks (gated)',
        'Allow digital employees to PROPOSE browser/computer tasks. Every task requires explicit human approval and a registered execution runtime; no runtime ships with the platform yet, so nothing can execute today.',
        false, 'autonomy')
on conflict (key) do nothing;

create table if not exists computer_use_runtimes (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  endpoint      text not null,
  active        boolean not null default false,
  registered_at timestamptz not null default now()
);
alter table computer_use_runtimes enable row level security;
drop policy if exists cu_runtimes_read on computer_use_runtimes;
create policy cu_runtimes_read on computer_use_runtimes for select using (
  exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'));
-- No write policy: registration is service-role only, deliberately.

create table if not exists computer_use_tasks (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  de_id           uuid not null references digital_employees(id) on delete cascade,
  goal            text not null check (length(trim(goal)) between 10 and 2000),
  -- coalesce: array_length('{}') is NULL and NULL>=1 would PASS the check
  allowed_domains text[] not null check (coalesce(array_length(allowed_domains, 1), 0) >= 1),
  max_steps       integer not null default 15 check (max_steps between 1 and 50),
  constraints     jsonb not null default '{}'::jsonb,
  status          text not null default 'pending_approval'
    check (status in ('pending_approval', 'approved', 'rejected', 'claimed', 'running', 'done', 'failed', 'expired')),
  human_task_id   uuid references human_tasks(id) on delete set null,
  runtime_id      uuid references computer_use_runtimes(id) on delete set null,
  -- the future runtime appends {step, action, url, screenshot_ref} entries
  audit           jsonb not null default '[]'::jsonb,
  result          text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists cu_tasks_tenant_idx on computer_use_tasks (tenant_id, created_at desc);

alter table computer_use_tasks enable row level security;
drop policy if exists cu_tasks_read on computer_use_tasks;
create policy cu_tasks_read on computer_use_tasks for select using (
  tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
  or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'));

-- ── THE HARD GATE: enforced in the database, not by RPC convention ──
create or replace function public.guard_computer_use_transition() returns trigger
language plpgsql security definer set search_path to 'public' as $function$
declare v_approval text;
begin
  if NEW.status in ('claimed', 'running') then
    -- valid predecessor only
    if not ((NEW.status = 'claimed' and OLD.status = 'approved')
         or (NEW.status = 'running' and OLD.status = 'claimed')) then
      raise exception 'computer-use task % cannot move % -> % (invalid transition)', NEW.id, OLD.status, NEW.status;
    end if;
    -- the human approval must exist and be APPROVED
    if NEW.human_task_id is null then
      raise exception 'computer-use task % has no approval task — it can never execute', NEW.id;
    end if;
    select status into v_approval from human_tasks where id = NEW.human_task_id;
    if v_approval is distinct from 'approved' then
      raise exception 'computer-use task % is not human-approved (approval status: %)', NEW.id, coalesce(v_approval, 'missing');
    end if;
    -- an ACTIVE registered runtime must hold the claim
    if NEW.runtime_id is null or not exists (
        select 1 from computer_use_runtimes r where r.id = NEW.runtime_id and r.active) then
      raise exception 'computer-use task % has no active registered runtime — no runtime ships with the platform yet', NEW.id;
    end if;
  end if;
  return NEW;
end;
$function$;
drop trigger if exists trg_guard_computer_use on computer_use_tasks;
create trigger trg_guard_computer_use
  before update of status on computer_use_tasks
  for each row execute function public.guard_computer_use_transition();

-- ── propose: DE machinery may only ASK; a human decides ──
create or replace function public.propose_computer_use_task(
  p_tenant_id uuid, p_de_id uuid, p_goal text, p_allowed_domains text[],
  p_max_steps integer default 15, p_constraints jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path to 'public' as $function$
declare v_task uuid; v_ht uuid; v_name text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'propose_computer_use_task is service-role only';
  end if;
  if not public.is_feature_enabled_internal(p_tenant_id, 'computer_use') then
    raise exception 'computer_use is not enabled for this workspace (default OFF)';
  end if;
  if not exists (select 1 from digital_employees where id = p_de_id and tenant_id = p_tenant_id) then
    raise exception 'de not in tenant';
  end if;

  insert into computer_use_tasks (tenant_id, de_id, goal, allowed_domains, max_steps, constraints)
  values (p_tenant_id, p_de_id, p_goal, p_allowed_domains,
          greatest(1, least(50, coalesce(p_max_steps, 15))), coalesce(p_constraints, '{}'::jsonb))
  returning id into v_task;

  select coalesce(persona_name, name, 'DE') into v_name from digital_employees where id = p_de_id;
  insert into human_tasks (tenant_id, type, source, title, detail, related_table, related_id)
  values (p_tenant_id, 'approval_gate', 'de',
    format('Computer-use request from %s', v_name),
    format(E'%s requests permission to operate a browser for this task. NOTHING runs without your approval, and no execution runtime is installed yet — approving only queues it for when one is.\n\nGoal: %s\n\nAllowed sites: %s\nStep budget: %s\n\nThe worker contract forbids credential entry and navigation outside the allowed sites, and records a screenshot audit of every step.',
           v_name, p_goal, array_to_string(p_allowed_domains, ', '), greatest(1, least(50, coalesce(p_max_steps, 15)))),
    'computer_use_tasks', v_task)
  returning id into v_ht;

  update computer_use_tasks set human_task_id = v_ht, updated_at = now() where id = v_task;
  return v_task;
end;
$function$;
revoke all on function public.propose_computer_use_task(uuid, uuid, text, text[], integer, jsonb) from public, anon, authenticated;
grant execute on function public.propose_computer_use_task(uuid, uuid, text, text[], integer, jsonb) to service_role;

-- ── approval decisions sync the task (SECURITY DEFINER — the mig-181 lesson) ──
create or replace function public.sync_computer_use_approval() returns trigger
language plpgsql security definer set search_path to 'public' as $function$
begin
  if NEW.related_table = 'computer_use_tasks' and NEW.status in ('approved', 'rejected')
     and OLD.status is distinct from NEW.status then
    update computer_use_tasks
       set status = case when NEW.status = 'approved' then 'approved' else 'rejected' end,
           updated_at = now()
     where id = NEW.related_id and status = 'pending_approval';
  end if;
  return NEW;
end;
$function$;
drop trigger if exists trg_sync_computer_use on human_tasks;
create trigger trg_sync_computer_use
  after update of status on human_tasks
  for each row execute function public.sync_computer_use_approval();

-- ── claim: only a registered ACTIVE runtime, only an approved task ──
create or replace function public.claim_computer_use_task(p_task_id uuid, p_runtime_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public' as $function$
declare v_row computer_use_tasks;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'claim_computer_use_task is service-role only';
  end if;
  -- Atomic claim; the transition trigger re-verifies approval + runtime.
  update computer_use_tasks
     set status = 'claimed', runtime_id = p_runtime_id, updated_at = now()
   where id = p_task_id and status = 'approved'
   returning * into v_row;
  if v_row.id is null then raise exception 'task not claimable (not approved, already claimed, or missing)'; end if;
  return jsonb_build_object('task_id', v_row.id, 'goal', v_row.goal,
                            'allowed_domains', v_row.allowed_domains, 'max_steps', v_row.max_steps,
                            'constraints', v_row.constraints);
end;
$function$;
revoke all on function public.claim_computer_use_task(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_computer_use_task(uuid, uuid) to service_role;
