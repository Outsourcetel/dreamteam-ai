-- ═══════════════════════════════════════════════════════════════
-- 156 — DE Work Engine: objectives + task queue (roadmap muscles
-- #3 long-horizon autonomy, #5 planning)
--
-- Today a DE only acts when poked (one invocation, one reply). A human
-- employee holds a GOAL, breaks it into steps, and works it over days —
-- "follow up on this overdue invoice Thursday, then again next week."
-- This adds:
--   • de_objectives — a goal a DE is pursuing, optionally anchored to an
--     entity/case, with a status lifecycle.
--   • de_work_items — a durable, scheduled task QUEUE with a state
--     machine, dependency ordering (the "plan"), attempts+backoff,
--     idempotent enqueue, and atomic FOR UPDATE SKIP LOCKED claiming so
--     a poller can drain it without double-processing (same safety the
--     ticket-ownership claim uses, migration 109).
--
-- MACHINERY vs BRAIN: the queue, scheduling, state transitions, and
-- concurrency safety are real and enforced here. WHAT a work item does
-- when executed (plan a goal into steps, take an action, decide to
-- follow up) is the agentic loop — dormant until ANTHROPIC_API_KEY. So
-- the autonomy SPINE ships and is provable now; the executor that pulls
-- from this queue is wired in the brain layer separately.
-- ═══════════════════════════════════════════════════════════════

create table if not exists de_objectives (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  de_id        uuid not null references digital_employees(id) on delete cascade,
  title        text not null,
  description  text not null default '',
  entity_kind  text,                       -- 'customer_account' | 'de_conversation' | ...
  entity_ref   text,
  status       text not null default 'open'
                 check (status in ('open', 'in_progress', 'blocked', 'achieved', 'abandoned')),
  priority     integer not null default 3,  -- 1 (highest) .. 5
  due_at       timestamptz,
  plan         jsonb not null default '[]'::jsonb,   -- optional freeform decomposition snapshot
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists de_objectives_lookup_idx
  on de_objectives (tenant_id, de_id, status, priority);

create table if not exists de_work_items (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  de_id           uuid not null references digital_employees(id) on delete cascade,
  objective_id    uuid references de_objectives(id) on delete cascade,
  title           text not null,
  kind            text not null default 'act'
                    check (kind in ('plan', 'act', 'follow_up', 'check', 'consult', 'escalate')),
  status          text not null default 'queued'
                    check (status in ('queued', 'running', 'done', 'failed', 'waiting_human', 'cancelled')),
  scheduled_for   timestamptz not null default now(),  -- becomes due at this time
  seq             integer not null default 0,          -- plan ordering within an objective
  depends_on      uuid references de_work_items(id) on delete set null,
  attempts        integer not null default 0,
  max_attempts    integer not null default 3,
  idempotency_key text,                                -- dedupe repeated enqueues
  payload         jsonb not null default '{}'::jsonb,
  result          jsonb,
  last_error      text,
  locked_at       timestamptz,
  locked_by       text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
-- Drives the claim query (due, queued, by schedule) and the dedupe.
create index if not exists de_work_items_due_idx
  on de_work_items (status, scheduled_for) where status = 'queued';
create index if not exists de_work_items_tenant_idx
  on de_work_items (tenant_id, de_id, status);
create unique index if not exists de_work_items_idem_idx
  on de_work_items (tenant_id, idempotency_key) where idempotency_key is not null;

alter table de_objectives enable row level security;
alter table de_work_items enable row level security;

-- Read: tenant members see their tenant's objectives/queue. Writes go
-- through the SECURITY DEFINER RPCs / service-role workers.
drop policy if exists de_objectives_tenant_read on de_objectives;
create policy de_objectives_tenant_read on de_objectives
  for select using (
    tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
    or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform')
  );
drop policy if exists de_work_items_tenant_read on de_work_items;
create policy de_work_items_tenant_read on de_work_items
  for select using (
    tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
    or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform')
  );

-- ── enqueue_de_work_item ── idempotent on (tenant, idempotency_key).
create or replace function public.enqueue_de_work_item(
  p_tenant_id       uuid,
  p_de_id           uuid,
  p_title           text,
  p_kind            text default 'act',
  p_scheduled_for   timestamptz default now(),
  p_objective_id    uuid default null,
  p_seq             integer default 0,
  p_depends_on      uuid default null,
  p_payload         jsonb default '{}'::jsonb,
  p_idempotency_key text default null,
  p_max_attempts    integer default 3
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid;
begin
  if auth.uid() is not null
     and not exists (select 1 from profiles p where p.user_id = auth.uid()
                       and (p.tenant_id = p_tenant_id or p.layer = 'platform')) then
    raise exception 'not authorized to enqueue work for this tenant';
  end if;

  insert into de_work_items (tenant_id, de_id, objective_id, title, kind,
                             scheduled_for, seq, depends_on, payload,
                             idempotency_key, max_attempts)
  values (p_tenant_id, p_de_id, p_objective_id, p_title, p_kind,
          coalesce(p_scheduled_for, now()), p_seq, p_depends_on, coalesce(p_payload, '{}'::jsonb),
          p_idempotency_key, greatest(1, p_max_attempts))
  on conflict (tenant_id, idempotency_key) where idempotency_key is not null
    do nothing
  returning id into v_id;

  -- ON CONFLICT DO NOTHING returns no row; fetch the existing one so the
  -- caller always gets a stable id for the same idempotency key.
  if v_id is null and p_idempotency_key is not null then
    select id into v_id from de_work_items
     where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
  end if;
  return v_id;
end;
$function$;

-- ── claim_de_work_items ── atomic, concurrency-safe. Service role only
-- (the cron/worker). Returns items now due whose dependency (if any) is
-- already done, marking them running under a lock.
create or replace function public.claim_de_work_items(
  p_limit  integer default 10,
  p_worker text default 'worker',
  p_tenant_id uuid default null
) returns setof de_work_items
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  return query
  with due as (
    select w.id
    from de_work_items w
    where w.status = 'queued'
      and w.scheduled_for <= now()
      and (p_tenant_id is null or w.tenant_id = p_tenant_id)
      and (w.depends_on is null
           or exists (select 1 from de_work_items d where d.id = w.depends_on and d.status = 'done'))
    order by w.scheduled_for asc
    limit greatest(1, least(100, p_limit))
    for update skip locked
  )
  update de_work_items w
     set status = 'running', locked_at = now(), locked_by = p_worker,
         attempts = w.attempts + 1, updated_at = now()
    from due
   where w.id = due.id
  returning w.*;
end;
$function$;

-- ── complete_de_work_item ── final transition, with retry+backoff on
-- transient failure (re-queues until max_attempts).
create or replace function public.complete_de_work_item(
  p_id     uuid,
  p_status text,                              -- 'done' | 'failed' | 'waiting_human' | 'cancelled'
  p_result jsonb default null,
  p_error  text default null,
  p_retry_delay_seconds integer default 300
) returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row de_work_items;
begin
  select * into v_row from de_work_items where id = p_id for update;
  if v_row.id is null then raise exception 'work item not found'; end if;

  if p_status = 'failed' and v_row.attempts < v_row.max_attempts then
    update de_work_items
       set status = 'queued', last_error = p_error,
           scheduled_for = now() + make_interval(secs => greatest(1, p_retry_delay_seconds)),
           locked_at = null, locked_by = null, updated_at = now()
     where id = p_id;
    return 'requeued';
  end if;

  update de_work_items
     set status = p_status, result = coalesce(p_result, result), last_error = p_error,
         locked_at = null, locked_by = null, updated_at = now()
   where id = p_id;
  return p_status;
end;
$function$;

-- ── set_de_objective_status ──
create or replace function public.set_de_objective_status(p_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is not null then
    if not exists (select 1 from de_objectives o join profiles p on p.user_id = auth.uid()
                    where o.id = p_id and (p.tenant_id = o.tenant_id or p.layer = 'platform')) then
      raise exception 'not authorized';
    end if;
  end if;
  update de_objectives set status = p_status, updated_at = now() where id = p_id;
end;
$function$;

revoke all on function public.enqueue_de_work_item(uuid, uuid, text, text, timestamptz, uuid, integer, uuid, jsonb, text, integer) from public, anon;
grant execute on function public.enqueue_de_work_item(uuid, uuid, text, text, timestamptz, uuid, integer, uuid, jsonb, text, integer) to authenticated, service_role;
revoke all on function public.claim_de_work_items(integer, text, uuid) from public, anon, authenticated;
grant execute on function public.claim_de_work_items(integer, text, uuid) to service_role;
revoke all on function public.complete_de_work_item(uuid, text, jsonb, text, integer) from public, anon, authenticated;
grant execute on function public.complete_de_work_item(uuid, text, jsonb, text, integer) to service_role;
revoke all on function public.set_de_objective_status(uuid, text) from public, anon;
grant execute on function public.set_de_objective_status(uuid, text) to authenticated, service_role;
