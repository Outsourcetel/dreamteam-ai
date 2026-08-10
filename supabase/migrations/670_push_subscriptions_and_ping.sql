-- 670_push_subscriptions_and_ping.sql
-- ==========================================================================
-- WHY: push notifications (spec 2026-08-10-push-notifications-design.md).
-- The phone shell exists to attack the decision bottleneck; a decision
-- surface nobody is told to open decides nothing. Every new pending
-- human_task now pings every registered device, instantly (founder's chosen
-- noise policy: one ping per decision, no burst-guard, no quiet hours).
--
-- Fire-and-forget by design: a lost ping is a courtesy lost, never data —
-- the task is still in /m. No outbox, no cron, nothing to rot.
-- ==========================================================================

begin;

do $$
begin
  if to_regclass('public.push_subscriptions') is not null then
    raise exception 'push_subscriptions already exists — 670 already applied';
  end if;
end $$;

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null,
  -- The push service URL for one browser on one device. Unique: re-subscribing
  -- the same device updates rather than duplicates (upsert on this).
  endpoint text not null unique,
  p256dh text not null,
  auth_key text not null,
  ua text null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index push_subscriptions_tenant_idx on public.push_subscriptions (tenant_id);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

-- Owner-only, all commands: you see and manage YOUR devices and nobody
-- else's. The sender (push-send) reads with the service role and is not
-- subject to this. Subscriptions are only ever created from /m, which is
-- APPROVALS-gated, so a row's existence is already an authorization claim.
create policy push_subscriptions_owner on public.push_subscriptions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid() and tenant_id = public.auth_tenant_id());

-- ── The ping: AFTER INSERT of a pending decision → push-send ──────────────
-- Mirrors migration 640's dispatch idiom exactly (vault secret + anon bearer
-- + platform_fn_url). SECURITY DEFINER so it can read the vault; EXECUTE is
-- revoked from clients — only the trigger calls it.
create or replace function public.notify_pending_human_task()
returns trigger
language plpgsql security definer set search_path to 'public'
as $fn$
declare
  v_secret text;
  v_anon   text;
  v_req    bigint;
begin
  -- Only real, pending decisions ping. (Exam hygiene lives upstream: exam
  -- answers no longer file tasks at all — migs 570/571/572 lineage.)
  if new.status is distinct from 'pending' then return new; end if;

  select decrypted_secret into v_secret from vault.decrypted_secrets
   where name = 'playbook_dispatch_secret';
  if v_secret is null then
    -- No alert spam here: this fires per task, and raise_ops_alert dedups
    -- globally on kind. A missing secret already alarms in the 640 dispatcher.
    return new;
  end if;
  v_anon := platform_anon_key();

  begin
    select net.http_post(
      url := platform_fn_url('/functions/v1/push-send'),
      body := jsonb_build_object('task_id', new.id, 'tenant_id', new.tenant_id),
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'Authorization', 'Bearer ' || v_anon,
                                    'x-dispatch-secret', v_secret),
      timeout_milliseconds := 10000) into v_req;
  exception when others then
    -- ⚠ NEVER let a ping failure block the INSERT that creates real work.
    raise warning 'push ping failed for task %: %', new.id, sqlerrm;
  end;
  return new;
end;
$fn$;

revoke execute on function public.notify_pending_human_task() from public, anon, authenticated;

create trigger human_tasks_push_ping
  after insert on public.human_tasks
  for each row execute function public.notify_pending_human_task();

do $$
declare v_pol int;
begin
  if to_regclass('public.push_subscriptions') is null then
    raise exception 'push_subscriptions was not created';
  end if;
  select count(*) into v_pol from pg_policies where tablename = 'push_subscriptions';
  if v_pol <> 1 then raise exception 'expected exactly 1 policy, found %', v_pol; end if;
  if not exists (select 1 from pg_trigger where tgname = 'human_tasks_push_ping') then
    raise exception 'trigger human_tasks_push_ping missing';
  end if;
  if has_function_privilege('authenticated', 'public.notify_pending_human_task()', 'EXECUTE') then
    raise exception 'clients can execute the trigger function — grants are wrong';
  end if;
end $$;

commit;
