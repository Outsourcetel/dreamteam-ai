-- ═══════════════════════════════════════════════════════════════
-- 161 — Autonomy heartbeat: run the DE work queue every 5 minutes.
--
-- de-work (edge fn) claims due de_work_items and works each with the
-- brain. When the queue is empty the claim returns nothing and no LLM
-- spend happens, so an idle heartbeat is effectively free. Mirrors the
-- established net.http_post cron pattern (migration 119): anon JWT
-- satisfies the platform gate, x-dispatch-secret is the real auth.
-- ═══════════════════════════════════════════════════════════════

create or replace function dispatch_de_work_internal()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  v_secret text;
  v_anon   text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmc3ZtaGNxZWl5cnhpdmJtcGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxMzIwMDgsImV4cCI6MjA5NzcwODAwOH0.RKCWute2ypkx9X-ByumIQWw8MS5uQPco-i-asNa-ESg';
  v_req_id bigint;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'playbook_dispatch_secret';
  if v_secret is null then return 'no dispatch secret'; end if;

  select net.http_post(
    url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/de-work',
    body    := '{"action":"run","max_items":3}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_anon,
      'x-dispatch-secret', v_secret
    )
  ) into v_req_id;
  return 'de-work dispatched, req ' || v_req_id;
end;
$fn$;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'de-work-run-5min') then
    perform cron.unschedule('de-work-run-5min');
  end if;
  perform cron.schedule('de-work-run-5min', '*/5 * * * *', 'select dispatch_de_work_internal()');
end $$;
