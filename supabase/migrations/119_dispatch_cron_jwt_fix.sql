-- DE-A1 (Human-as-DE program): the 5-minute cron's call to
-- knowledge-gap-detect had failed with a platform-level 401 on every
-- tick since it shipped (2026-07-08). Root cause: that function was
-- deployed with verify_jwt=true (unlike its 14 siblings), and the
-- dispatcher sent only x-dispatch-secret — no Authorization header —
-- so Supabase's platform gate rejected the request before the
-- function's own dispatch-secret check ever ran.
--
-- Fix: rather than weakening the function's platform setting, the
-- dispatcher now sends the project's PUBLIC anon key as a valid JWT
-- on all four calls (it ships in every frontend bundle — not a
-- secret). Platform verification passes; each function's own
-- x-dispatch-secret check remains the real authorization.
--
-- Verified live 2026-07-11: all four legs return 200
-- (dispatch/poll/gap-detect/learned-behavior), gap + learned-behavior
-- pipelines scanning all 8 tenants.

create or replace function invoke_playbook_dispatch()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  v_secret  text;
  v_anon    text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmc3ZtaGNxZWl5cnhpdmJtcGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxMzIwMDgsImV4cCI6MjA5NzcwODAwOH0.RKCWute2ypkx9X-ByumIQWw8MS5uQPco-i-asNa-ESg';
  v_req_id  bigint;
  v_req_id2 bigint;
  v_req_id3 bigint;
  v_req_id4 bigint;
  v_t       record;
  v_health  integer := 0;
  v_stale   jsonb;
begin
  for v_t in
    select distinct ca.tenant_id
    from customer_accounts ca
    left join health_score_config c on c.tenant_id = ca.tenant_id
    where c.last_computed_at is null or c.last_computed_at < now() - interval '24 hours'
  loop
    perform compute_tenant_health_service(v_t.tenant_id);
    v_health := v_health + 1;
  end loop;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'playbook_dispatch_secret'
  limit 1;
  if v_secret is null then
    return format('health:%s no_secret', v_health);
  end if;

  select net.http_post(
    url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/playbook-execute',
    body    := '{"action":"dispatch"}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_anon,
      'apikey', v_anon,
      'x-dispatch-secret', v_secret
    ),
    timeout_milliseconds := 30000
  ) into v_req_id;

  select net.http_post(
    url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/specialist-consult',
    body    := '{"action":"poll_de_work_sources"}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_anon,
      'apikey', v_anon,
      'x-dispatch-secret', v_secret
    ),
    timeout_milliseconds := 30000
  ) into v_req_id2;

  begin
    v_stale := check_staleness();
  exception when others then
    v_stale := jsonb_build_object('error', sqlerrm);
  end;

  begin
    select net.http_post(
      url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/knowledge-gap-detect',
      body    := '{}'::jsonb,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_anon,
        'apikey', v_anon,
        'x-dispatch-secret', v_secret
      ),
      timeout_milliseconds := 30000
    ) into v_req_id3;
  exception when others then
    v_req_id3 := null;
  end;

  -- Piggyback #4: automatic learned-behavior detection (103). Same
  -- independence guarantee as piggyback #3 — a failure here never
  -- blocks or is blocked by the other three.
  begin
    select net.http_post(
      url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/learned-behavior-detect',
      body    := '{}'::jsonb,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_anon,
        'apikey', v_anon,
        'x-dispatch-secret', v_secret
      ),
      timeout_milliseconds := 30000
    ) into v_req_id4;
  exception when others then
    v_req_id4 := null;
  end;

  return format('health:%s dispatch:%s poll:%s gap:%s learn:%s stale:%s',
    v_health, v_req_id, v_req_id2, coalesce(v_req_id3::text, 'err'), coalesce(v_req_id4::text, 'err'),
    coalesce(v_stale->>'checked', '0'));
end;
$fn$;
