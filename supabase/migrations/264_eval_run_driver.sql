-- ═══════════════════════════════════════════════════════════════
-- 264 — Eval-run completion driver (pilot-hardening)
--
-- PROBLEM: eval-run is a resumable batch loop — each invocation answers
-- only BATCH (=2) questions, then returns `remaining` and expects the
-- CLIENT to re-invoke with run_id until the suite finishes. A UI-started
-- exam therefore stalls forever if the browser session closes: two
-- Product Support re-cert runs sat frozen at 2/24 for hours, which meant
-- the G6 records gate could never lift and a demoted DE could never
-- recover unattended.
--
-- Two missing pieces, both fixed here:
--   1. eval_runs never persisted WHICH DE the run certifies, so a generic
--      driver couldn't resume it (resume forwards de_id to de-answer and
--      certify_de_from_eval needs it). Add de_id + archetype_key columns;
--      eval-run now writes them on create (see the edge-fn change shipped
--      alongside this migration).
--   2. Nothing on the server drove the loop. Add a security-definer
--      dispatcher on pg_cron that advances every running, de_id-tagged,
--      unfinished run by one batch per tick — same net.http_post pattern
--      as migration 169 (anon JWT satisfies the platform gate,
--      x-dispatch-secret is the real auth, read from the vault).
--
-- Cost is bounded: the dispatcher is a no-op whenever no de_id-tagged run
-- is mid-flight (the common case between exams). A 24-question suite
-- completes in ~11 ticks.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Persist the certification target on the run row ──
alter table eval_runs add column if not exists de_id uuid;
alter table eval_runs add column if not exists archetype_key text;

-- ── 2. Allow an honest terminal state for abandoned client loops ──
alter table eval_runs drop constraint if exists eval_runs_status_check;
alter table eval_runs add constraint eval_runs_status_check
  check (status = any (array['running','passed','failed','blocked_llm','abandoned']));

-- Close the two orphan runs that stalled before this fix (de_id null =
-- not attributable to any DE, incomplete). Honest closure, not "failed".
update eval_runs
   set status = 'abandoned', finished_at = now()
 where status = 'running'
   and de_id is null
   and coalesce(jsonb_array_length(results), 0) < total;

-- ── 3. The dispatcher: advance every resumable running run by one batch ──
create or replace function dispatch_eval_driver_internal()
returns text
language plpgsql security definer set search_path = public, extensions
as $fn$
declare
  v_secret text;
  v_anon   text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmc3ZtaGNxZWl5cnhpdmJtcGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxMzIwMDgsImV4cCI6MjA5NzcwODAwOH0.RKCWute2ypkx9X-ByumIQWw8MS5uQPco-i-asNa-ESg';
  v_run    record;
  v_count  int := 0;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'playbook_dispatch_secret';
  if v_secret is null then return 'no dispatch secret'; end if;

  for v_run in
    select id, tenant_id, de_id, archetype_key
      from eval_runs
     where status = 'running'
       and de_id is not null
       and finished_at is null
       and coalesce(jsonb_array_length(results), 0) < total
  loop
    perform net.http_post(
      url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/eval-run',
      body    := jsonb_build_object(
                   'run_id',        v_run.id,
                   'tenant_id',     v_run.tenant_id,
                   'de_id',         v_run.de_id,
                   'archetype_key', v_run.archetype_key
                 ),
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'Authorization', 'Bearer ' || v_anon,
                   'x-dispatch-secret', v_secret
                 )
    );
    v_count := v_count + 1;
  end loop;

  return 'eval-driver dispatched ' || v_count || ' run(s)';
end;
$fn$;

-- ── 4. Every minute; self-limiting (skips when nothing is mid-flight) ──
do $$
begin
  if exists (select 1 from cron.job where jobname = 'eval-run-driver') then
    perform cron.unschedule('eval-run-driver');
  end if;
  perform cron.schedule('eval-run-driver', '* * * * *', 'select dispatch_eval_driver_internal()');
end $$;
