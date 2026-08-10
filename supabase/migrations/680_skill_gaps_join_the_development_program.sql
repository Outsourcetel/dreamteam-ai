-- 680_skill_gaps_join_the_development_program.sql
-- ============================================================================
-- WHY (2026-08-10, finishing founder decision #3 / docs/31):
-- The development program (mig 472) wires two detector kinds into the
-- human-gated improve organ: confidence_gap and escalation_spike. skill_gap
-- was left out — yet it is measured from the SAME evidence (below-standard
-- eval judgments drive skill_proficiency) and is honestly served by the SAME
-- lever: draft a knowledge fix from this employee's failing judged answers,
-- replay-verified, human-approved. Two skill_gap items sit proposed today
-- (Finance DE, Technical Support) with the machine forbidden to touch them.
--
-- This migration re-issues the worker with skill_gap added to the wired-kind
-- fence. ONE line changes; every fence, guard and gate of 472 is reproduced
-- byte-identically and re-asserted below. pip stays human-only — a
-- performance-improvement plan is a management action, not a knowledge patch —
-- and the error_rate / guardrail_pattern kinds remain unnameable.
--
-- Context: the worker has NEVER acted on outsourcetel-hq — the tenant sat at
-- exactly 3 orphaned review_pending improvements (mig 673's finding) from the
-- worker's first run onward, so the <3 backpressure excluded it every day.
-- With 673 applied the reviews are visible; the queue frees as they are
-- decided, and the program (now including skill_gap) starts attempting.
-- ============================================================================

begin;

create or replace function work_de_development_program_internal()
returns text
language plpgsql security definer set search_path = public, extensions
as $fn$
declare
  v_secret text;
  v_anon   text := coalesce((select value from platform_runtime_config where key = 'supabase_anon_key'), 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmc3ZtaGNxZWl5cnhpdmJtcGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxMzIwMDgsImV4cCI6MjA5NzcwODAwOH0.RKCWute2ypkx9X-ByumIQWw8MS5uQPco-i-asNa-ESg');
  v_item   record;
  v_action text;
  v_target uuid;
  v_shared boolean;
  v_note   text;
  v_entry  jsonb;
  v_idx    int;
  v_seen_de     uuid[] := '{}';
  v_seen_action text[] := '{}';
  v_seen_target uuid[] := '{}';
  v_dispatched int := 0;
  v_covered    int := 0;
  v_none       int := 0;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'playbook_dispatch_secret';
  if v_secret is null then return 'no dispatch secret'; end if;

  for v_item in
    with pending as (
      select tenant_id, count(*) n from de_improvements
       where status = 'review_pending' group by tenant_id
    )
    select i.id, i.tenant_id, i.de_id, i.item_type
      from de_development_items i
      join tenants t on t.id = i.tenant_id
       and t.status <> 'suspended'                    -- dormancy: no work, no spend
      join digital_employees de on de.id = i.de_id
       and de.status = 'active'
       and de.lifecycle_status not in ('retired','archived')
      left join pending p on p.tenant_id = i.tenant_id
     where i.source = 'detected'
       and i.status in ('proposed', 'in_progress')
       and i.item_type in ('confidence_gap', 'escalation_spike', 'skill_gap')  -- the WIRED kinds only
       and coalesce(p.n, 0) < 3                       -- drivers' human-queue backpressure
       and not exists (                               -- one attempt per detection cycle
         select 1 from jsonb_array_elements(i.attempts) as a(entry)
          where (a.entry->>'at')::timestamptz > now() - interval '20 hours')
     order by i.tenant_id, i.de_id, i.item_type
     limit 25
  loop
    -- per-iteration isolation, same idiom as both drivers: one bad row can
    -- never abort the whole tick.
    begin
      v_shared := false; v_action := null; v_target := null;

      -- One dispatch per DE per cycle: a second open item on the same DE
      -- shares the first item's attempt (one knowledge fix serves both
      -- signals) instead of double-spending the LLM.
      v_idx := array_position(v_seen_de, v_item.de_id);
      if v_idx is not null then
        v_action := v_seen_action[v_idx];
        v_target := v_seen_target[v_idx];
        v_shared := true;
      else
        -- First choice: an open knowledge-gap cluster belonging to this DE,
        -- with the SAME dispatchability + dedup guards the gap driver uses
        -- (unlinked, un-drafted, representative run has the question).
        select g.id into v_target
          from knowledge_gap_clusters g
          join evidence_runs r on r.id = g.representative_run_id
         where g.tenant_id = v_item.tenant_id
           and g.status = 'open'
           and g.de_improvement_id is null
           and not exists (select 1 from de_improvements di where di.gap_cluster_id = g.id)
           and r.de_id = v_item.de_id
           and r.inquiry is not null
         order by g.severity_score desc nulls last, g.member_count desc
         limit 1;
        if v_target is not null then
          v_action := 'knowledge_gap_refresh';
        else
          -- Else: the oldest unhandled below-standard judgment for this DE
          -- (same bar and dedup as the judgment driver, FIFO).
          select j.id into v_target
            from eval_judgments j
           where j.tenant_id = v_item.tenant_id
             and j.de_id = v_item.de_id
             and j.verdict in ('fail','partial')
             and j.score < 70
             and not exists (select 1 from de_improvements di
                              where di.tenant_id = j.tenant_id and di.judgment_id = j.id)
           order by j.created_at asc
           limit 1;
          if v_target is not null then v_action := 'answer_quality_improve'; end if;
        end if;
        if v_action is null then v_action := 'no_candidate'; end if;
        -- NOTE (fix-pass 2026-07-28): the seen-arrays are appended only AFTER
        -- the fenced attempt-write (and dispatch) succeed, further down. If
        -- they were appended here and the first item's write was then skipped
        -- by the pending fence — or its subtransaction rolled back on a
        -- net.http_post error (plpgsql variables survive the rollback) — a
        -- second open item on the same DE would record shared:true against a
        -- dispatch that never happened. Appending late means that second item
        -- re-picks and retries instead, which is the honest behaviour (a
        -- rolled-back block also rolls back its enqueued pg_net row, so no
        -- double-send is possible).
      end if;

      if v_action = 'no_candidate' then
        -- Honest bookkeeping: the machine looked and had nothing it could act
        -- on. Consecutive same-outcome entries collapse into one (with a
        -- counter) so a long-lived item cannot grow an unbounded log.
        v_entry := jsonb_build_object(
          'at', now(), 'action', 'no_candidate',
          'note', 'Looked for improvable evidence (open knowledge gaps, below-standard judged answers) — none available to act on.');
        update de_development_items i
           set attempts = case
                 when jsonb_array_length(i.attempts) > 0
                  and (i.attempts->-1)->>'action' = 'no_candidate'
                 then (i.attempts - (jsonb_array_length(i.attempts) - 1))
                      || (v_entry || jsonb_build_object('times', coalesce(((i.attempts->-1)->>'times')::int, 1) + 1))
                 else i.attempts || v_entry
               end,
               updated_at = now()
         where i.id = v_item.id
           and i.status in ('proposed', 'in_progress');
        if found then
          v_none := v_none + 1;
          if not v_shared then
            v_seen_de     := array_append(v_seen_de, v_item.de_id);
            v_seen_action := array_append(v_seen_action, v_action);
            v_seen_target := array_append(v_seen_target, v_target);
          end if;
        end if;
        continue;
      end if;

      v_note := case v_action
        when 'knowledge_gap_refresh' then
          'Drafting a knowledge fix for an open knowledge gap this employee could not answer. It is verified by replay and reaches a human review only if it proves better; publishing requires approval.'
        else
          'Drafting a knowledge fix for a below-standard judged answer. It is verified by replay and reaches a human review only if it proves better; publishing requires approval.'
        end;
      v_entry := jsonb_build_object('at', now(), 'action', v_action, 'shared', v_shared, 'note', v_note)
              || case when v_action = 'knowledge_gap_refresh'
                      then jsonb_build_object('gap_cluster_id', v_target)
                      else jsonb_build_object('judgment_id', v_target) end;

      -- Record the attempt ON THE ITEM first (pending-only fence: if the item
      -- was closed or dismissed underneath us, do NOT dispatch for it).
      update de_development_items i
         set attempts = i.attempts || v_entry, updated_at = now()
       where i.id = v_item.id
         and i.status in ('proposed', 'in_progress');
      if not found then continue; end if;

      if v_shared then
        v_covered := v_covered + 1;
      else
        perform net.http_post(
          url     := public.platform_fn_url('/functions/v1/de-improve'),
          body    := case when v_action = 'knowledge_gap_refresh'
                          then jsonb_build_object('tenant_id', v_item.tenant_id, 'gap_cluster_id', v_target)
                          else jsonb_build_object('tenant_id', v_item.tenant_id, 'judgment_id', v_target) end,
          headers := jsonb_build_object(
                       'Content-Type', 'application/json',
                       'Authorization', 'Bearer ' || v_anon,
                       'x-dispatch-secret', v_secret)
        , timeout_milliseconds := 60000);
        v_dispatched := v_dispatched + 1;
        -- Dedup memory only now — attempt recorded AND dispatch enqueued in
        -- this (still-open) subtransaction; see the note at the pick site.
        v_seen_de     := array_append(v_seen_de, v_item.de_id);
        v_seen_action := array_append(v_seen_action, v_action);
        v_seen_target := array_append(v_seen_target, v_target);
      end if;
    exception when others then
      raise warning 'development-program attempt failed for item %: %', v_item.id, sqlerrm;
    end;
  end loop;

  -- Honest: posts are async; this counts dispatches recorded, not fixes made.
  return 'development program: ' || v_dispatched || ' improvement dispatch(es) (async), '
         || v_covered || ' item(s) covered by a shared dispatch, '
         || v_none || ' item(s) with nothing actionable';
end;
$fn$;

-- House rule (re-assert on replace): strip both default-grant mechanisms.
revoke all on function work_de_development_program_internal() from PUBLIC, anon, authenticated;
grant execute on function work_de_development_program_internal() to service_role;

-- ============================================================================
-- Asserts — the 472 discipline, re-proven against the NEW deployed body.
-- ============================================================================
do $assert$
declare
  v_def text;
  v_n   int;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname = 'work_de_development_program_internal';

  -- (1) The wired-kind fence names exactly the THREE wired kinds, once.
  v_n := (length(v_def) - length(replace(v_def, 'i.item_type in (''confidence_gap'', ''escalation_spike'', ''skill_gap'')', ''))) / length('i.item_type in (''confidence_gap'', ''escalation_spike'', ''skill_gap'')');
  if v_n <> 1 then raise exception '680: wired-kind fence count % (want 1)', v_n; end if;

  -- (2) The human-only kinds stay unnameable: pip is a management action; the
  --     run-error and guardrail kinds have no honest machine driver.
  if v_def like '%''pip''%' then raise exception '680: function must not name the pip kind'; end if;
  if v_def like '%error_rate%' then raise exception '680: function must not name the run-error kind'; end if;
  if v_def like '%guardrail_pattern%' then raise exception '680: function must not name the guardrail kind'; end if;

  -- (3) Cron-context sweep (mig 454 lesson): no caller-identity predicate.
  if v_def like '%can_access_de%' then raise exception '680: caller-scoping predicate found in cron-path body'; end if;
  if v_def like '%auth.%' then raise exception '680: request-identity call found in cron-path body'; end if;

  -- (4) Pending-only fence (house rule 7): exactly 3 occurrences.
  v_n := (length(v_def) - length(replace(v_def, 'i.status in (''proposed'', ''in_progress'')', ''))) / length('i.status in (''proposed'', ''in_progress'')');
  if v_n <> 3 then raise exception '680: pending-only fence count % (want 3)', v_n; end if;

  -- (5) Exactly-once + human-gate guards all present.
  if v_def not like '%g.de_improvement_id is null%' then raise exception '680: gap link guard missing'; end if;
  if v_def not like '%di.gap_cluster_id = g.id%' then raise exception '680: gap dedup guard missing'; end if;
  if v_def not like '%di.judgment_id = j.id%' then raise exception '680: judgment dedup guard missing'; end if;
  if v_def not like '%coalesce(p.n, 0) < 3%' then raise exception '680: review-queue backpressure missing'; end if;
  if v_def not like '%t.status <> ''suspended''%' then raise exception '680: dormancy guard missing'; end if;
  if v_def not like '%interval ''20 hours''%' then raise exception '680: per-cycle attempt window missing'; end if;

  -- (6) EXECUTE closed to the perimeter.
  if has_function_privilege('anon', 'public.work_de_development_program_internal()', 'execute') then
    raise exception '680: anon can execute the worker';
  end if;
  if has_function_privilege('authenticated', 'public.work_de_development_program_internal()', 'execute') then
    raise exception '680: authenticated can execute the worker';
  end if;

  -- (7) The cron roster is undisturbed: detector at 06:00, program at 06:30.
  select count(*) into v_n from cron.job
   where jobname = 'de-development-program-daily'
     and schedule = '30 6 * * *' and active
     and command = 'select work_de_development_program_internal()';
  if v_n <> 1 then raise exception '680: program cron job wrong (count %)', v_n; end if;
  select count(*) into v_n from cron.job
   where jobname = 'de-development-needs-daily' and active;
  if v_n <> 1 then raise exception '680: the detector cron was disturbed'; end if;

  -- (8) The attempts forgery guard (mig 472 fix-pass) is still armed.
  select count(*) into v_n from pg_trigger
   where tgrelid = 'de_development_items'::regclass and not tgisinternal
     and tgname = 'trg_de_development_items_attempts_guard';
  if v_n <> 1 then raise exception '680: attempts forgery guard trigger missing'; end if;

  -- (9) There is something for the new wiring to work on — refuse a vacuous
  --     ship if the skill_gap kind does not even exist in the data.
  select count(*) into v_n from de_development_items where item_type = 'skill_gap';
  if v_n = 0 then raise exception '680: no skill_gap items exist anywhere — wiring is untestable, investigate before applying'; end if;

  raise notice '680: skill_gap joins the development program — same lever, same fences, same human gates. pip stays human-only.';
end $assert$;

commit;
