-- 771_an_alarm_that_reaches_a_person.sql
-- ============================================================================
-- Register C-8 — the most-repeated finding of the whole review, reached from
-- four independent directions (docs/54 E, docs/61 P, docs/67 R, docs/50 B):
--
--   ops alerts        -> an in-app banner, and nothing else
--   connector failure -> a derived UI badge, and nothing else
--   Sentry issues     -> the Sentry dashboard, and nothing else
--   the founder's phone, which demonstrably works, only ever carried approvals
--
-- The cost of that gap, measured: a scheduled job dead 13 days (B-11), the only
-- live integration dead 7 days (B-13), and an alarm ringing for 20 days that
-- nobody saw (C-8). Every one was DETECTED correctly. None was ANNOUNCED.
--
-- ── What this does ─────────────────────────────────────────────────────────
-- The sixth status-sync trigger on this schema, deliberately shaped like the
-- fifth. `notify_pending_human_task` already proves the pattern: read the
-- dispatch secret from the vault, POST to push-send, and swallow every error so
-- a ping can never block the row that created it. This mirrors it for alerts.
--
-- ── Three deliberate limits ────────────────────────────────────────────────
--   1. INSERT ONLY. There are 133 unresolved alerts today. A trigger on UPDATE
--      or a backfill would fire all of them at one device at once, which would
--      teach the founder to mute the channel — the exact opposite of the fix.
--      Only alerts raised from now on ping.
--   2. RESOLVED ALERTS NEVER PING. Guarded here and again inside push-send, on
--      the same reasoning as a task decided between insert and ping.
--   3. NEVER BLOCKS THE INSERT. An alert that cannot be delivered must still be
--      recorded; a raise_ops_alert that fails because a phone is unreachable
--      would be a worse defect than the one being fixed.
--
-- Routing needs no tenant column: every alert raised in production carries
-- tenant_id in its detail (measured, 133 of 133), and push-send routes on that,
-- so this stays generic across every workspace with no tenant named anywhere.
--
-- Volume is bounded by `raise_ops_alert`, which already dedups globally on
-- kind — so a storm of one condition is one row, and therefore one ping.
-- ============================================================================

create or replace function public.notify_ops_alert()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_secret text;
  v_anon   text;
  v_req    bigint;
begin
  -- A resolved alert is history, not news.
  if new.resolved_at is not null then return new; end if;

  select decrypted_secret into v_secret from vault.decrypted_secrets
   where name = 'playbook_dispatch_secret';
  if v_secret is null then
    -- Deliberately silent: raising an ops alert about ops alerts, from inside
    -- the ops alert trigger, is a loop. The 640 dispatcher already alarms on a
    -- missing secret.
    return new;
  end if;
  v_anon := platform_anon_key();

  begin
    select net.http_post(
      url := platform_fn_url('/functions/v1/push-send'),
      body := jsonb_build_object('alert_id', new.id),
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'Authorization', 'Bearer ' || v_anon,
                                    'x-dispatch-secret', v_secret),
      timeout_milliseconds := 10000) into v_req;
  exception when others then
    -- ⚠ NEVER let a ping failure block the INSERT that records the problem.
    raise warning 'ops alert ping failed for %: %', new.id, sqlerrm;
  end;
  return new;
end;
$function$;

revoke all on function public.notify_ops_alert() from public, anon, authenticated;

drop trigger if exists ops_alerts_push_ping on public.ops_alerts;
create trigger ops_alerts_push_ping
  after insert on public.ops_alerts
  for each row execute function public.notify_ops_alert();

comment on function public.notify_ops_alert() is
  'C-8: carries a newly raised ops alert to the same phone that already receives approvals. INSERT-only by design — the 133 alerts open when this shipped must never fire at once. Never blocks the insert.';
