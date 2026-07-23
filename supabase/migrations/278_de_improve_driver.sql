-- ═══════════════════════════════════════════════════════════════
-- 278 — Self-improvement driver (Tier-3: wire the dark "improve" organ)
--
-- PROBLEM: the de-improve edge fn is a COMPLETE verified self-improvement loop
-- (pick a below-standard eval_judgment → LLM-propose a KB patch → replay via
-- de-answer + eval-judge + 2 golden sims, fail-closed → on pass, open a
-- human-gated knowledge_revision review that auto-applies on approval). But it
-- has ZERO callers — no cron, no button, no dispatch. online-eval (mig 169)
-- accumulates failed judgments every hour and nothing ever converts them into
-- improvement proposals. The loop never starts. This wires it, human-gating
-- unchanged (the driver only PROPOSES; publish still needs human approval).
--
-- Designed + adversarially verified (wf_651eb4bc-d37, execute_ready, 0 crit/high).
-- Corrections folded in: retryability for infra-failed replays; per-tenant
-- backpressure so a noisy DE can't flood the human queue; active-DE filter;
-- honest async logging; per-iteration subtransaction isolation. Same net.http_post
-- dispatch pattern as mig 264 (anon JWT satisfies the gate; x-dispatch-secret
-- from the vault is the real auth). GLOBAL — reaches every tenant incl. new ones.
-- ═══════════════════════════════════════════════════════════════

create or replace function dispatch_de_improve_internal()
returns text
language plpgsql security definer set search_path = public, extensions
as $fn$
declare
  v_secret text;
  v_anon   text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmc3ZtaGNxZWl5cnhpdmJtcGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxMzIwMDgsImV4cCI6MjA5NzcwODAwOH0.RKCWute2ypkx9X-ByumIQWw8MS5uQPco-i-asNa-ESg';
  v_row    record;
  v_count  int := 0;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'playbook_dispatch_secret';
  if v_secret is null then return 'no dispatch secret'; end if;

  -- Retryability: an infra-caused mid-replay failure (fail_closed) must not
  -- permanently burn a judgment. Clear such proposals older than 3 days so the
  -- candidate query re-picks their judgment for another pass. A genuine
  -- "answer could not be improved" that did NOT fail closed stays deduped.
  delete from de_improvements
   where status = 'failed_replay'
     and (replay->'golden'->>'failed_closed') = 'true'
     and updated_at < now() - interval '3 days';

  -- One oldest-unhandled below-standard judgment per tenant (FIFO fairness +
  -- sidesteps the edge fn's recency-window picker), skipping tenants that
  -- already have >= 3 open reviews (backpressure on the human queue), and only
  -- for active employees. Passing judgment_id makes each tick idempotent.
  for v_row in
    with pending as (
      select tenant_id, count(*) n from de_improvements
       where status = 'review_pending' group by tenant_id
    )
    select distinct on (j.tenant_id) j.tenant_id, j.id as judgment_id
      from eval_judgments j
      join digital_employees de on de.id = j.de_id
       and de.status = 'active'
       and de.lifecycle_status not in ('retired','archived')
      left join pending p on p.tenant_id = j.tenant_id
     where j.verdict in ('fail','partial')
       and j.score < 70
       and j.de_id is not null
       and coalesce(p.n, 0) < 3
       and not exists (select 1 from de_improvements di
                        where di.tenant_id = j.tenant_id and di.judgment_id = j.id)
     order by j.tenant_id, j.created_at asc
     limit 25
  loop
    -- per-iteration isolation: a bad row can never abort the global tick.
    begin
      perform net.http_post(
        url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/de-improve',
        body    := jsonb_build_object('tenant_id', v_row.tenant_id, 'judgment_id', v_row.judgment_id),
        headers := jsonb_build_object(
                     'Content-Type', 'application/json',
                     'Authorization', 'Bearer ' || v_anon,
                     'x-dispatch-secret', v_secret
                   )
      );
      v_count := v_count + 1;
    exception when others then
      raise warning 'de-improve dispatch failed for tenant % judgment %: %', v_row.tenant_id, v_row.judgment_id, sqlerrm;
    end;
  end loop;

  -- Honest: the posts are async; this counts dispatches, not improvements.
  return 'de-improve dispatched ' || v_count || ' http_post(s) (async)';
end;
$fn$;

-- Every 6 hours (conservative: protects reviewer load + cost); self-limiting —
-- the candidate query returns nothing when there is nothing to improve.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'de-improve-driver') then
    perform cron.unschedule('de-improve-driver');
  end if;
  perform cron.schedule('de-improve-driver', '20 */6 * * *', 'select dispatch_de_improve_internal()');
end $$;
