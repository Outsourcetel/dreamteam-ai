-- 472_development_program_wiring.sql
-- ============================================================================
-- docs/31 DECISION #3 — DEVELOPMENT BECOMES A PROGRAM (founder-chosen).
--
-- Today the daily detector (detect_de_development_needs_internal, migs 125+453)
-- opens de_development_items for four evidence signals and auto-closes them
-- when the metric recovers — but NOTHING ever acts on an open item. The two
-- improve drivers (dispatch_de_improve_internal mig 278, dispatch_gap_improve_
-- internal mig 282) run on their own 6-hour crons, pick work tenant-fairly,
-- and know nothing about development items. The plan card is a list the
-- machine writes and never works.
--
-- This migration wires them together, without bypassing a single human gate:
--
--   1. de_development_items gains an `attempts` jsonb log (no such column
--      existed — verified live 2026-07-28). Every machine attempt is recorded
--      ON THE ITEM, at dispatch time — long before mig 453's auto-close, which
--      REMAINS the only closer for detector items.
--   2. A new daily worker, work_de_development_program_internal(), runs 30
--      minutes AFTER the 06:00 detector (so the open/refresh pass AND the
--      453 recovery pass have both finished — no race, and an item that just
--      closed is never attempted). For each still-open detected item of the
--      two WIRED kinds it enqueues the de-improve organ scoped to that DE:
--        * first choice: an open, unlinked knowledge-gap cluster whose
--          representative run belongs to this DE  -> {tenant_id, gap_cluster_id}
--        * else: the oldest unhandled below-standard judgment for this DE
--          -> {tenant_id, judgment_id}
--        * else: an honest 'no_candidate' entry — the machine looked and had
--          nothing it could act on.
--      The de-improve edge fn keeps ALL its gates: tenant AI budget, draft ->
--      fail-closed replay -> human_tasks knowledge_revision review; publish
--      only via the approval-gated RPC. This worker only ever POSTs the same
--      request shape the two existing drivers already POST.
--   3. The two other detector kinds have NO driver that honestly fixes them
--      (a knowledge patch repairs answers, not run errors or guardrail
--      blocks), so they stay human-only; the asserts below prove this
--      function cannot name them, and the UI says so in plain language.
--
-- Discipline honoured:
--   * Exactly-once: the same NOT EXISTS dedup guards the drivers use, PLUS
--     the live partial unique index de_improvements_gap_cluster_uidx; one
--     dispatch per DE per cycle (two items on one DE share one attempt and
--     both record it); a 20-hour per-item attempt window makes a manual
--     re-run of the worker a no-op (house rule 7: pending-only WHERE on
--     every write — the fence appears three times, counted below).
--   * Human-queue backpressure: same "< 3 review_pending per tenant" rule
--     as both drivers — this worker cannot flood the review queue.
--   * Dormancy: suspended tenants are excluded (t.status <> 'suspended'),
--     per the founder-locked tenant-dormancy direction (mig 430 program).
--     Verified live: BOTH demo DEs with open items sit in Acme Telecom,
--     which is suspended — so the first run will do nothing until a live
--     tenant trips a signal or Acme is reactivated. That is the honest,
--     intended behaviour, stated in the report.
--   * Cron context: pg_cron connects directly as postgres with no JWT.
--     This function contains ZERO caller-identity predicates — no
--     can_access_de, nothing reading the request identity (the mig 454
--     lesson); an assert sweeps the deployed body for those tokens.
--   * Vault secret + anon-key fallback + platform_fn_url are byte-identical
--     to the LIVE bodies of both drivers (read via pg_get_functiondef
--     2026-07-28, which differ from their migration files — runtime-config
--     lookup and 60s timeout were added later).
--   * Fix-pass 2026-07-28: (a) attempts is guarded against app-side forgery
--     (trigger blocks auth.role()='authenticated' edits only; cron/postgres/
--     service_role pass — behavioural probe in the asserts); (b) the worker's
--     dedup arrays are appended only AFTER the fenced attempt-write and
--     dispatch succeed, so a fenced/rolled-back first item can no longer
--     suppress a later identical one with a phantom shared:true.
--   * Companion migration 473_ adds the knowledge-proposal entity-guard
--     (self-denial class): every de_improvements insert is tagged with
--     outcome_kind (kb_missing vs wrong_answer) and, when the proposal's
--     text names a live entity of this workspace, an entity_match warning
--     the review UI renders loudly. Apply 473_ in the same batch.
-- ============================================================================

-- ── 1. The attempt log ──────────────────────────────────────────────────────
alter table de_development_items
  add column if not exists attempts jsonb not null default '[]'::jsonb;

comment on column de_development_items.attempts is
  'Machine-attempt log (docs/31 decision #3): [{at, action, note, shared, gap_cluster_id|judgment_id, times?}]. Written only by work_de_development_program_internal() (enforced by trg_de_development_items_attempts_guard for app-side callers); the item is closed only by its owning sweep or a human.';

-- ── 1b. Forgery guard (fix-pass 2026-07-28): the new column inherits the
--        table's tenant owner/admin FOR ALL policy, so without this a tenant
--        admin could edit or erase machine-attempt entries via PostgREST and
--        the column comment above would overclaim. Three-context rule:
--        * PostgREST user JWT (auth.role()='authenticated') — BLOCKED from
--          changing attempts; every other column stays admin-editable.
--        * service_role — passes (auth.role()='service_role').
--        * direct DB / pg_cron (auth.role() null) — passes; the worker and
--          any future sweep are unaffected.
create or replace function public.de_development_items_attempts_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.attempts is distinct from old.attempts
     and coalesce(auth.role(), '') = 'authenticated' then
    raise exception 'attempts is a machine-written log and cannot be edited from the app';
  end if;
  return new;
end $$;

revoke all on function public.de_development_items_attempts_guard() from PUBLIC, anon, authenticated;

drop trigger if exists trg_de_development_items_attempts_guard on de_development_items;
create trigger trg_de_development_items_attempts_guard
  before update on de_development_items
  for each row
  execute function public.de_development_items_attempts_guard();

-- ── 2. The worker ───────────────────────────────────────────────────────────
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
       and i.item_type in ('confidence_gap', 'escalation_spike')  -- the WIRED kinds only
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

-- House rule: Postgres default-grants EXECUTE on new functions to PUBLIC.
revoke all on function work_de_development_program_internal() from PUBLIC, anon, authenticated;
grant execute on function work_de_development_program_internal() to service_role;

-- ── 3. Cron: daily, 30 min after the 06:00 detector ─────────────────────────
-- Same direct-DB context as every other internal driver. 06:30 guarantees the
-- detector's open/refresh AND its mig-453 recovery close have both completed:
-- this worker only ever sees items that are genuinely still failing today.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'de-development-program-daily') then
    perform cron.unschedule('de-development-program-daily');
  end if;
  perform cron.schedule('de-development-program-daily', '30 6 * * *',
                        'select work_de_development_program_internal()');
end $$;

-- ============================================================================
-- Asserts — the wiring landed, the fences hold, nothing forbidden crept in.
-- ============================================================================
do $assert$
declare
  v_def text;
  v_n   int;
begin
  -- (1) The attempt log column exists, jsonb, not null, empty-array default.
  select count(*) into v_n from information_schema.columns
   where table_schema = 'public' and table_name = 'de_development_items'
     and column_name = 'attempts' and data_type = 'jsonb' and is_nullable = 'NO';
  if v_n <> 1 then raise exception '472: attempts column missing or wrong shape'; end if;

  -- (2) Exactly one worker function, and we read its DEPLOYED body.
  select count(*) into v_n from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname = 'work_de_development_program_internal';
  if v_n <> 1 then raise exception '472: expected 1 worker function, found %', v_n; end if;

  select pg_get_functiondef(p.oid) into v_def from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname = 'work_de_development_program_internal';

  -- (3) Cron-context sweep (the mig 454 lesson): no caller-identity predicate
  --     may exist anywhere in the deployed body. Under pg_cron the request
  --     identity is NULL and any such predicate silently blinds the worker.
  if v_def like '%can_access_de%' then raise exception '472: caller-scoping predicate found in cron-path body'; end if;
  if v_def like '%auth.%' then raise exception '472: request-identity call found in cron-path body'; end if;

  -- (4) Pending-only fence (house rule 7) on the candidate read AND both
  --     writes: exactly 3 occurrences.
  v_n := (length(v_def) - length(replace(v_def, 'i.status in (''proposed'', ''in_progress'')', ''))) / length('i.status in (''proposed'', ''in_progress'')');
  if v_n <> 3 then raise exception '472: pending-only fence count % (want 3)', v_n; end if;

  -- (5) The wired-kind fence names exactly the two wired kinds…
  v_n := (length(v_def) - length(replace(v_def, 'i.item_type in (''confidence_gap'', ''escalation_spike'')', ''))) / length('i.item_type in (''confidence_gap'', ''escalation_spike'')');
  if v_n <> 1 then raise exception '472: wired-kind fence count % (want 1)', v_n; end if;
  -- …and the two human-only detector kinds are unnameable by this function:
  -- no driver honestly fixes them, so no code path may pretend to.
  if v_def like '%error_rate%' then raise exception '472: function must not name the run-error kind'; end if;
  if v_def like '%guardrail_pattern%' then raise exception '472: function must not name the guardrail kind'; end if;

  -- (6) Exactly-once + human-gate guards present: gap-cluster dedup (both
  --     halves), judgment dedup, review-queue backpressure, dormancy guard,
  --     per-cycle window.
  if v_def not like '%g.de_improvement_id is null%' then raise exception '472: gap link guard missing'; end if;
  if v_def not like '%di.gap_cluster_id = g.id%' then raise exception '472: gap dedup guard missing'; end if;
  if v_def not like '%di.judgment_id = j.id%' then raise exception '472: judgment dedup guard missing'; end if;
  if v_def not like '%coalesce(p.n, 0) < 3%' then raise exception '472: review-queue backpressure missing'; end if;
  if v_def not like '%t.status <> ''suspended''%' then raise exception '472: dormancy guard missing'; end if;
  if v_def not like '%interval ''20 hours''%' then raise exception '472: per-cycle attempt window missing'; end if;

  -- (7) Execute privilege is closed to the perimeter (anon inherits PUBLIC,
  --     so these two checks also prove the PUBLIC default-grant is gone).
  if has_function_privilege('anon', 'public.work_de_development_program_internal()', 'execute') then
    raise exception '472: anon can execute the worker';
  end if;
  if has_function_privilege('authenticated', 'public.work_de_development_program_internal()', 'execute') then
    raise exception '472: authenticated can execute the worker';
  end if;

  -- (7b) Fix-pass 2026-07-28 — the attempts forgery guard is armed.
  select count(*) into v_n from pg_trigger
   where tgrelid = 'de_development_items'::regclass and not tgisinternal
     and tgname = 'trg_de_development_items_attempts_guard';
  if v_n <> 1 then raise exception '472: attempts forgery guard trigger missing'; end if;
  if has_function_privilege('anon', 'public.de_development_items_attempts_guard()', 'execute')
     or has_function_privilege('authenticated', 'public.de_development_items_attempts_guard()', 'execute') then
    raise exception '472: attempts guard function executable by the perimeter';
  end if;
  -- Behavioural probe (the assert question — this fails if the guard does not
  -- actually block): simulate the PostgREST claim auth.role() reads
  -- (request.jwt.claim.role — no auth.users row is forged, only the
  -- transaction-local GUC), attempt to tamper with attempts on a real item,
  -- and require the raise. The GUC is reset IMMEDIATELY either way so the
  -- rest of this migration's transaction never runs as 'authenticated'.
  -- Skipped honestly (with a notice) only when the table has no rows to
  -- probe against (live 2026-07-28: 8 rows exist).
  declare
    v_probe uuid;
    v_blocked boolean := false;
  begin
    select id into v_probe from de_development_items limit 1;
    if v_probe is null then
      raise notice '472: no de_development_items row to probe the forgery guard against — behavioural check skipped';
    else
      perform set_config('request.jwt.claim.role', 'authenticated', true);
      begin
        update de_development_items
           set attempts = attempts || jsonb_build_object('forged', true)
         where id = v_probe;
      exception when others then
        v_blocked := true;
      end;
      perform set_config('request.jwt.claim.role', '', true);
      if not v_blocked then
        raise exception '472: forgery guard did NOT block an authenticated attempts edit';
      end if;
    end if;
  end;

  -- (8) The cron landed, once, at 06:30, and the detector's own job survived.
  select count(*) into v_n from cron.job
   where jobname = 'de-development-program-daily'
     and schedule = '30 6 * * *' and active
     and command = 'select work_de_development_program_internal()';
  if v_n <> 1 then raise exception '472: program cron job wrong (count %)', v_n; end if;
  select count(*) into v_n from cron.job
   where jobname = 'de-development-needs-daily' and active;
  if v_n <> 1 then raise exception '472: the detector cron was disturbed'; end if;

  -- (9) The closer is untouched: this migration must not have redefined the
  --     detector. Its live body still carries the mig-453 recovery pass.
  select pg_get_functiondef(p.oid) into v_def from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname = 'detect_de_development_needs_internal';
  if v_def not like '%completed_at = now()%' then
    raise exception '472: detector auto-close (mig 453) is missing — do not apply this wiring without it';
  end if;

  raise notice '472: development program wired — daily worker at 06:30 records machine attempts on open confidence/escalation items and dispatches the human-gated improve organ, one dispatch per employee per cycle. Run-error and guardrail kinds remain human-only by design.';
end $assert$;

notify pgrst, 'reload schema';

-- ============================================================================
-- Post-apply verification (read-only, for the applying session):
--
--   -- the column and its default:
--   select attempts from de_development_items limit 3;
--
--   -- the worker's deployed body (sweep it once more by eye):
--   select pg_get_functiondef(p.oid) from pg_proc p
--    where p.pronamespace='public'::regnamespace
--      and p.proname='work_de_development_program_internal';
--
--   -- cron roster:
--   select jobname, schedule, command, active from cron.job
--    where jobname in ('de-development-needs-daily','de-development-program-daily',
--                      'de-improve-driver','gap-improve-driver');
--
--   -- After the first 06:30 run (or a manual `select work_de_development_
--   -- program_internal()` from a service context), inspect the trail:
--   select de_id, item_type, status, jsonb_pretty(attempts)
--     from de_development_items
--    where source='detected' and attempts <> '[]'::jsonb;
--
--   -- Expected TODAY (verified live 2026-07-28): the only open wired-kind
--   -- items belong to Acme Telecom, which is SUSPENDED — the dormancy guard
--   -- excludes them, so the first run reports 0/0/0. That is intended.
--   -- The program becomes visible the first time an ACTIVE tenant's employee
--   -- trips a confidence/escalation signal (detector at 06:00, attempt at
--   -- 06:30 the same morning, improvement draft in review minutes later if
--   -- the evidence supports one).
-- ============================================================================
