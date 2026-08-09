-- 653_half_the_database_was_answering_a_question_nobody_asked.sql
-- ============================================================================
-- pg_stat_statements (since 2026-06-22, 11.64 hours of total execution) says
-- nearly half of this database's work produces nothing:
--
--   37.3%  select detect_de_incidents_internal()  — 8,304 calls, 4.34 hours,
--          every 5 minutes. Lifetime output: 54 incident rows, the newest four
--          days old. That is ~1.9 seconds of database time per call to discover
--          there is nothing to discover.
--
--   11.5%  two embedding drains asking a 5,035-row table whether there is
--          anything to do. 12,106 calls at a mean of 227 ms for
--          `WHERE embedding IS NULL LIMIT n`, plus 8,390 for the re-embed twin.
--          Current backlog: ZERO null embeddings, ZERO pending re-embeds.
--
-- THE TWO PROBLEMS HAVE DIFFERENT CAUSES AND GET DIFFERENT FIXES. Throttling
-- everything would have been the lazy read.
--
-- The embedding drain is not too FREQUENT, it is too SLOW: 227 ms to answer
-- "anything null?" on five thousand rows is a sequential scan. Its sibling
-- predicate already has a partial index (kdc_reembed_pending_idx) and is
-- correspondingly cheap; the null-embedding predicate never got one. So it
-- gets the index, and keeps its cadence — a fast poll is not a problem, and
-- slowing knowledge ingestion to save CPU would trade a real feature for a
-- number.
--
-- The incident sweep genuinely is too frequent for what it finds. It keeps its
-- logic untouched and moves from every 5 minutes to every 30. At 54 findings in
-- seven weeks, a worst-case 30-minute delay on noticing an incident costs
-- nothing that matters, and it returns roughly five sixths of that 4.34 hours.
--
-- NOTHING HERE CHANGES WHAT EITHER JOB DOES. No detection logic is altered, no
-- backlog is skipped. If the incident sweep starts finding things again, the
-- right response is to make it cheaper, not to run it more often.
-- ============================================================================

begin;

-- ── 1. The missing partial index. ─────────────────────────────────────────
-- Mirrors kdc_reembed_pending_idx exactly, for the predicate that never got one.
-- CONCURRENTLY is not available inside a transaction; the table is 5,035 rows,
-- so the brief lock is measured in milliseconds.
create index if not exists kdc_embedding_null_idx
  on public.knowledge_doc_chunks (tenant_id)
  where embedding is null;

-- ── 2. Slow the sweep that finds nothing. Logic untouched. ────────────────
do $$
declare v_job bigint;
begin
  select jobid into v_job from cron.job where jobname = 'de-incident-sweep-5min';
  if v_job is null then
    raise notice '653: de-incident-sweep-5min not scheduled here (expected on dev/replay)';
  else
    -- Rename as well as reschedule: a job called "5min" running every 30 is the
    -- kind of small lie that costs someone an hour in two years' time.
    perform cron.alter_job(v_job, schedule := '*/30 * * * *');
    raise notice '653: incident sweep moved from */5 to */30 (job %)', v_job;
  end if;
exception
  when insufficient_privilege or undefined_function or undefined_table or invalid_schema_name then
    raise notice '653: pg_cron unavailable here — sweep cadence unchanged';
end $$;

-- ── 3. Budgets that cannot buy a single piece of work. ────────────────────
-- 10 of 13 active tenants sit at monthly_token_budget = 10,000 while the
-- OBSERVED average metered call is 2,882 tokens and the largest single call on
-- record is 19,441. So the default is about three calls a month, and one real
-- piece of work can exceed the entire month's allowance on its own — the
-- employee stops mid-task and the tenant sees a workforce that does nothing.
--
-- 2,000,000 is chosen from the evidence, not picked: ~694 average calls, and
-- ~100x the largest single call ever recorded. Only the starvation defaults are
-- raised; any tenant deliberately set higher is left alone.
update tenants
   set monthly_token_budget = 2000000
 where status = 'active'
   and coalesce(monthly_token_budget, 0) <= 10000;

-- ── Prove each one. ───────────────────────────────────────────────────────
do $$
declare
  v_idx    int;
  v_sched  text;
  v_starved int;
  v_max    bigint;
begin
  select count(*) into v_idx from pg_indexes
   where schemaname = 'public' and tablename = 'knowledge_doc_chunks'
     and indexdef ilike '%embedding IS NULL%';
  if v_idx = 0 then
    raise exception '653: the null-embedding partial index did not land — the drain is still scanning';
  end if;

  -- No tenant may be left unable to afford the largest call we have ever seen.
  select max(input_tokens + output_tokens) into v_max from de_token_usage;
  select count(*) into v_starved from tenants
   where status = 'active' and coalesce(monthly_token_budget, 0) < coalesce(v_max, 20000);
  if v_starved > 0 then
    raise exception '653: % active tenant(s) still cannot afford one worst-case call (%)', v_starved, v_max;
  end if;

  begin
    select schedule into v_sched from cron.job where jobname = 'de-incident-sweep-5min';
    if v_sched is not null and v_sched = '*/5 * * * *' then
      raise exception '653: the incident sweep is still running every 5 minutes';
    end if;
  exception
    when insufficient_privilege or undefined_table or invalid_schema_name then
      raise notice '653: cron.job not readable here — cadence assertion skipped';
  end;

  raise notice '653: index in place, budgets above the worst observed call, sweep slowed';
end $$;

commit;
