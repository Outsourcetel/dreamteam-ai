-- ═══════════════════════════════════════════════════════════════
-- 169 — Continuous online evals: hourly heartbeat (Frontier-20 #2)
--
-- Drives de-eval-online once an hour to score a small sample of recent
-- delivered answers. Hard-capped per run (MAX_SAMPLE=8 in the fn) and
-- eval-judge is budget-gated, so cost is bounded; an idle hour with no
-- new delivered answers judges nothing. Mirrors the net.http_post cron
-- pattern (migration 119): anon JWT satisfies the platform gate,
-- x-dispatch-secret is the real auth.
-- ═══════════════════════════════════════════════════════════════

create or replace function dispatch_online_eval_internal()
returns text
language plpgsql security definer set search_path = public, extensions
as $fn$
declare
  v_secret text;
  v_anon   text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmc3ZtaGNxZWl5cnhpdmJtcGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxMzIwMDgsImV4cCI6MjA5NzcwODAwOH0.RKCWute2ypkx9X-ByumIQWw8MS5uQPco-i-asNa-ESg';
  v_req_id bigint;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'playbook_dispatch_secret';
  if v_secret is null then return 'no dispatch secret'; end if;
  select net.http_post(
    url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/de-eval-online',
    body    := '{"limit":8,"window_minutes":90}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_anon, 'x-dispatch-secret', v_secret)
  ) into v_req_id;
  return 'online-eval dispatched, req ' || v_req_id;
end;
$fn$;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'de-online-eval-hourly') then
    perform cron.unschedule('de-online-eval-hourly');
  end if;
  perform cron.schedule('de-online-eval-hourly', '7 * * * *', 'select dispatch_online_eval_internal()');
end $$;
