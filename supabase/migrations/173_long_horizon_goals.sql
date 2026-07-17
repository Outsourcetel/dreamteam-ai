-- ═══════════════════════════════════════════════════════════════
-- 173 — Long-horizon goal engine (Frontier-20 #7)
--
-- The Sierra-Horizon-class capability: a DE OWNS a goal over days or
-- weeks, not just a queue of one-shot tasks. Three pieces were missing:
--
--   1. TIME — objectives now carry next_wake_at (when the engine should
--      look at this goal again) and cadence_minutes (recurring check-in
--      interval; null = wake only when its work finishes). de_work_items
--      already had scheduled_for and the claim RPC already honors it, so
--      future-dated steps park until due with no new machinery.
--   2. WAKE-UPS — wake_due_objectives() hands de-work the goals whose
--      time has come; wake_count feeds idempotent replan keys
--      (obj-<id>-w<n>-step-<m>) so a re-run can never double-enqueue.
--   3. A HEARTBEAT — pg_cron drives de-work every 10 minutes (same
--      net.http_post + vault-secret pattern as migrations 119/169), so
--      goals progress with no human, no page open, no external trigger.
--
-- The REPLANNING brain (review progress → continue / achieved / blocked)
-- lives in de-work v5; this migration is the deterministic time spine.
-- Outbound-channel delivery legs (email/SMS) remain founder-blocked and
-- are NOT part of this: steps act through the existing governed tools.
-- ═══════════════════════════════════════════════════════════════

alter table de_objectives
  add column if not exists cadence_minutes integer check (cadence_minutes is null or cadence_minutes between 5 and 10080),
  add column if not exists next_wake_at    timestamptz,
  add column if not exists wake_count      integer not null default 0;

create index if not exists de_objectives_wake_idx
  on de_objectives (next_wake_at)
  where next_wake_at is not null and status in ('open', 'in_progress');

-- ── the wake list: goals whose time has come ──
create or replace function public.wake_due_objectives(p_limit integer default 5)
returns setof de_objectives
language sql security definer set search_path to 'public' stable as $function$
  select * from de_objectives
   where status in ('open', 'in_progress')
     and next_wake_at is not null
     and next_wake_at <= now()
   order by next_wake_at asc
   limit greatest(1, least(20, p_limit));
$function$;

-- ── one wake, atomically: bump the counter (for idempotency keys) and
--    advance/clear the alarm so a crashed worker can't wake the same
--    objective twice in a burst ──
create or replace function public.begin_objective_wake(p_objective_id uuid)
returns integer
language plpgsql security definer set search_path to 'public' as $function$
declare v_count integer;
begin
  update de_objectives
     set wake_count = wake_count + 1,
         -- provisional next alarm; de-work overrides on achieved/blocked
         next_wake_at = case when cadence_minutes is not null
                             then now() + make_interval(mins => cadence_minutes)
                             else now() + interval '60 minutes' end,
         updated_at = now()
   where id = p_objective_id and status in ('open', 'in_progress')
   returning wake_count into v_count;
  if v_count is null then raise exception 'objective not found or not wakeable'; end if;
  return v_count;
end;
$function$;

-- ── finish a wake: the review verdict decides the alarm ──
create or replace function public.conclude_objective_wake(
  p_objective_id uuid, p_assessment text, p_note text default null
) returns void
language plpgsql security definer set search_path to 'public' as $function$
begin
  if p_assessment = 'achieved' then
    update de_objectives set status = 'achieved', next_wake_at = null, updated_at = now()
     where id = p_objective_id;
  elsif p_assessment = 'blocked' then
    update de_objectives set status = 'blocked', next_wake_at = null, updated_at = now()
     where id = p_objective_id;
  elsif p_assessment = 'continue' then
    null; -- alarm already advanced by begin_objective_wake
  else
    raise exception 'assessment must be achieved | blocked | continue';
  end if;
end;
$function$;

revoke all on function public.wake_due_objectives(integer) from public, anon, authenticated;
revoke all on function public.begin_objective_wake(uuid) from public, anon, authenticated;
revoke all on function public.conclude_objective_wake(uuid, text, text) from public, anon, authenticated;
grant execute on function public.wake_due_objectives(integer) to service_role;
grant execute on function public.begin_objective_wake(uuid) to service_role;
grant execute on function public.conclude_objective_wake(uuid, text, text) to service_role;

-- ── the heartbeat: de-work every 10 minutes (pattern of migs 119/169 —
--    the dispatch secret is read from vault INSIDE this function) ──
create or replace function dispatch_de_work_internal()
returns text
language plpgsql security definer set search_path = public, extensions
as $fn$
declare
  v_secret text;
  v_anon   text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmc3ZtaGNxZWl5cnhpdmJtcGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxMzIwMDgsImV4cCI6MjA5NzcwODAwOH0.RKCWute2ypkx9X-ByumIQWw8MS5uQPco-i-asNa-ESg';
  v_req_id bigint;
begin
  -- Idle-cheap: skip the HTTP call entirely when nothing is due.
  if not exists (select 1 from de_work_items where status = 'queued' and scheduled_for <= now())
     and not exists (select 1 from de_objectives where status in ('open','in_progress')
                       and ( (next_wake_at is not null and next_wake_at <= now())
                             or not exists (select 1 from de_work_items w where w.objective_id = de_objectives.id) ))
  then
    return 'idle — nothing due';
  end if;

  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'playbook_dispatch_secret';
  if v_secret is null then return 'no dispatch secret'; end if;
  select net.http_post(
    url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/de-work',
    body    := '{"action":"run","max_items":3}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_anon, 'x-dispatch-secret', v_secret)
  ) into v_req_id;
  return 'de-work dispatched, req ' || v_req_id;
end;
$fn$;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'de-work-tick') then
    perform cron.unschedule('de-work-tick');
  end if;
  perform cron.schedule('de-work-tick', '*/10 * * * *', 'select dispatch_de_work_internal()');
end $$;
