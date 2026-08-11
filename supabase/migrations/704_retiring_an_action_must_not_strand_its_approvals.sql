-- 704_retiring_an_action_must_not_strand_its_approvals.sql
-- ==========================================================================
-- WHY. On 2026-07-13 migration 611 retired the specialist role and set
-- `create_specialist` to status 'disabled'. An approval naming that definition
-- had ALREADY been raised and was sitting in front of a human in the `kinetic`
-- workspace:
--
--     "Approve action — Create a specialist desk (DreamTeam AI (self))"
--     human_tasks d4fa3c75… · pending since 2026-07-13 23:28Z
--
-- From the instant 611 committed, that task was unexecutable: connector-hub's
-- `resolveActionDefinition` only ever looks at ACTIVE definitions, so approving
-- it answers `action_definition_not_found` and sends nothing. Nobody was told.
-- It sat pending for TWENTY-NINE DAYS and was found on 2026-08-11 by a probe
-- written for an unrelated reason (`no-pending-approval-the-platform-cannot-
-- carry-out`, mig 703's follow-up), not by anything watching the retirement.
--
-- The retirement was correct. The silence was the defect. Any future retirement
-- — and there will be more; the catalog already holds 6 disabled definitions —
-- does the same thing the same way, and this is the thing that notices.
--
-- ── WHAT IT DOES NOT DO, AND THIS IS THE WHOLE DESIGN CONSTRAINT ──────────
-- ⛔ IT NEVER DECIDES, REJECTS OR CANCELS A TASK. Not once, not "obviously
-- safely", not for the row it can prove is dead. `decide_human_task` derives
-- the decider from `auth.uid()` precisely so that every decision on this
-- platform has a human's name attached to it; a trigger that auto-rejected a
-- stranded approval would be the first decision in the system with nobody
-- behind it, and it would do it silently, in bulk, on a schema change. The
-- stranded `kinetic` row is STILL PENDING after this migration, on purpose.
-- SURFACING IS NOT DECIDING. A person reads the alert and withdraws the task.
--
-- ⛔ IT NEVER BLOCKS A RETIREMENT. This is an AFTER trigger, so its return
-- value is discarded and it cannot veto the UPDATE. The per-tenant loop body is
-- additionally wrapped in an exception block: if writing one workspace's alert
-- fails, the other workspaces still get theirs and the retirement still
-- commits. That failure is re-raised as a WARNING rather than swallowed —
-- "the guard broke quietly" is the failure mode this file exists to end, and
-- reproducing it inside the fix would be absurd.
--
-- ── WHY A TRIGGER RATHER THAN A SWEEP ─────────────────────────────────────
-- "At that moment" is the requirement, and a definition can be retired from
-- several places: a migration (611 did), the platform console, a direct
-- statement. A cron sweep would catch all of those but only on its next tick,
-- which is the same "found it later" shape that cost 29 days — just shorter. A
-- trigger on the table is the one place every writer must pass through.
--
-- The FIRING CONDITION is in the trigger's WHEN clause, not in the body:
--
--     WHEN (OLD.status = 'active' AND NEW.status IS DISTINCT FROM 'active')
--
-- so a genuine active→non-active transition is the ONLY thing that can even
-- enter the function. `status` allows 'active' | 'disabled' | 'draft', so both
-- retirement directions are covered. Non-active→non-active cannot match (OLD
-- is not 'active'), active→active cannot match (NEW is not DISTINCT), and an
-- update that touches any other column while leaving status alone cannot match
-- for the same reason. Postgres evaluates WHEN before calling the function, so
-- an unrelated `update action_definitions set label = …` does not so much as
-- enter it. All four cases are proven below, not asserted.
--
-- ── ⚠ raise_ops_alert DEDUPS ON `kind` GLOBALLY — MEASURED, NOT ASSUMED ────
-- Its body is three lines and there is no tenant in them:
--
--     IF EXISTS (SELECT 1 FROM ops_alerts
--                 WHERE kind = p_kind AND resolved_at IS NULL
--                   AND created_at > now() - interval '1 hour')
--     THEN RETURN; END IF;
--
-- and `ops_alerts` HAS NO tenant_id COLUMN AT ALL, so there is nothing for a
-- per-tenant dedup to key on even in principle. Verified against production in
-- a rolled-back transaction on 2026-08-11: three raise_ops_alert calls with one
-- shared kind and three different tenant messages landed **1 row** — the first
-- one, "tenant A"; B and C were discarded silently and their retirements would
-- have gone unreported. The same three calls with a tenant-keyed kind landed
-- **3 rows**. That is the trap this migration is required to avoid, observed
-- rather than believed.
--
-- So this writes to ops_alerts DIRECTLY with a kind carrying BOTH ids —
--
--     stranded_approval_<tenant8>_<definition8>
--
-- — which makes the global dedup do the right thing: one alert per workspace
-- per retired definition. Five workspaces stranded by one platform-scope
-- retirement produce five alerts naming five workspaces. This is not a novel
-- trick; mig 689's weekly digest bypasses raise_ops_alert the same way and for
-- the same reason (`value_digest_<week>_<tenant8>`), and 13 such rows are in
-- production today. The re-fire suppression is an explicit not-exists on the
-- UNRESOLVED alert of that exact kind, so re-retiring a definition whose alert
-- a human already dismissed says so again.
--
-- ── WHO IS TOLD ───────────────────────────────────────────────────────────
-- ops_alerts already has a live reader: `list_ops_alerts` (platform-admin only)
-- feeds `OpsAlertsBanner.tsx`, which polls every 5 minutes and renders nothing
-- when there is nothing unresolved. The banner is kind-agnostic, so this new
-- kind surfaces with no UI change. That reader itself exists because ops_alerts
-- once had NO reader anywhere and an "AI budget exhausted" alert went unseen
-- for four days — the channel is chosen because it is wired, not because it is
-- convenient.
--
-- ── NO BACKFILL, DELIBERATELY ─────────────────────────────────────────────
-- Rows stranded BEFORE this trigger existed are not alerted here, and that is a
-- decision rather than an oversight: the certify probe
-- `no-pending-approval-the-platform-cannot-carry-out` already reports every one
-- of them on every run, by inspection of current state rather than by having
-- witnessed the transition. It names the `kinetic` / `create_specialist` row
-- today and will keep naming it until a human withdraws it. A backfill would
-- write a duplicate signal for a condition already surfaced, and would have to
-- invent a transition timestamp it does not know.
-- ==========================================================================

begin;

create or replace function public.alert_on_stranded_approvals()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_row  record;
  v_kind text;
begin
  -- One pass per WORKSPACE holding a stranded approval for this definition.
  -- A platform-scope definition is visible to every tenant, so one retirement
  -- can strand tasks in several — and each workspace's operator needs to see
  -- their own, named.
  for v_row in
    select ht.tenant_id                          as tenant_id,
           coalesce(t.slug, ht.tenant_id::text)  as slug,
           count(*)                              as n_tasks,
           jsonb_agg(jsonb_build_object(
             'task_id',   ht.id,
             'title',     ht.title,
             'raised_at', ht.created_at) order by ht.created_at) as tasks
      from human_tasks ht
      join action_executions ae
        on (ae.task_id = ht.id or ae.resolves_task_id = ht.id)
      left join tenants t on t.id = ht.tenant_id
     where ae.action_definition_id = new.id
       and ht.type   = 'action_approval'
       and ht.status = 'pending'         -- only a task still awaiting a human
     group by ht.tenant_id, t.slug
  loop
    begin
      -- ⚠ THE TENANT AND THE DEFINITION ARE BOTH IN THE KIND. raise_ops_alert
      -- dedups on kind GLOBALLY (verified: 3 tenants, 1 shared kind -> 1 row
      -- landed), and ops_alerts has no tenant column, so a kind that does not
      -- carry the tenant reports one retirement when five happened.
      v_kind := 'stranded_approval_' || left(v_row.tenant_id::text, 8)
                || '_' || left(new.id::text, 8);

      if exists (select 1 from ops_alerts
                  where kind = v_kind and resolved_at is null) then
        continue;                        -- already open and unread; don't pile on
      end if;

      insert into ops_alerts (kind, message, detail) values (
        v_kind,
        v_row.slug || ': ' || v_row.n_tasks || ' pending approval'
          || case when v_row.n_tasks = 1 then '' else 's' end
          || ' can no longer be carried out. The action "' || new.action_key
          || '" just left status ''active'' for ''' || new.status
          || '''; connector-hub only ever resolves ACTIVE definitions, so '
          || 'approving ' || case when v_row.n_tasks = 1 then 'this task' else 'these tasks' end
          || ' would send nothing while the queue reads as done. First: '
          || coalesce(v_row.tasks->0->>'title', '(untitled)')
          || '. A person must withdraw or re-raise them — nothing has been decided here.',
        jsonb_build_object(
          'tenant_id',            v_row.tenant_id,
          'tenant_slug',          v_row.slug,
          'action_definition_id', new.id,
          'action_key',           new.action_key,
          'old_status',           old.status,
          'new_status',           new.status,
          'stranded_task_count',  v_row.n_tasks,
          'stranded_tasks',       v_row.tasks,
          'remedy',               'A human withdraws or re-raises each task. This alert never decides one.')
      );
    exception when others then
      -- ⛔ A BROKEN ALERT MUST NOT BLOCK A LEGITIMATE RETIREMENT, and one bad
      -- workspace must not cost the others their alert. Loud, not swallowed:
      -- a guard that fails quietly is the exact defect this migration exists
      -- to end.
      raise warning '704: could not raise the stranded-approval alert for tenant % on definition %: % (the retirement itself is unaffected)',
        v_row.tenant_id, new.id, sqlerrm;
    end;
  end loop;

  return new;   -- AFTER trigger: ignored. It cannot veto the UPDATE.
end;
$fn$;

comment on function public.alert_on_stranded_approvals() is
  'AFTER-UPDATE trigger on action_definitions. When a definition leaves '
  'status=''active'', writes ONE ops_alerts row per workspace still holding a '
  'PENDING action_approval that names it, so a retirement cannot silently '
  'strand approvals the way mig 611 did for 29 days. The kind embeds tenant '
  'AND definition because raise_ops_alert dedups on kind GLOBALLY. It never '
  'decides, rejects or cancels a task, and never blocks the retirement. '
  'See mig 704.';

-- Migs 610+630: BOTH default-grant mechanisms. anon/authenticated are NAMED
-- roles in Supabase, so revoking PUBLIC alone leaves them holding EXECUTE.
-- Trigger functions are invoked by the trigger machinery, which does not
-- consult EXECUTE — service_role is granted to match every sibling trigger
-- function on this table (log_tenant_activity, notify_pending_human_task:
-- {postgres=X/postgres,service_role=X/postgres}) rather than leaving a lone
-- odd-one-out ACL for a future perimeter diff to puzzle over.
revoke execute on function public.alert_on_stranded_approvals()
  from public, anon, authenticated;
grant execute on function public.alert_on_stranded_approvals() to service_role;

drop trigger if exists action_definitions_retirement_strands on public.action_definitions;
create trigger action_definitions_retirement_strands
  after update on public.action_definitions
  for each row
  -- THE FIRING CONDITION, in the WHEN clause so the function is not even
  -- entered otherwise. active->disabled and active->draft both match;
  -- active->active, disabled->disabled and a label-only edit cannot.
  when (old.status = 'active' and new.status is distinct from 'active')
  execute function public.alert_on_stranded_approvals();

-- ── ASSERTIONS ────────────────────────────────────────────────────────────
do $assert$
declare
  v_when     text;
  v_src      text;
  v_tenant   uuid;
  v_def      uuid;
  v_task     uuid;
  v_exec     uuid;
  v_n        int;
  v_kind     text;
  v_before_n int;
  v_before   text;
  v_after    text;
begin
  -- ── THE INVARIANT THIS MIGRATION MUST NOT BREAK, captured BEFORE anything
  --    runs and compared at the end (assert I). Not the count alone — the
  --    exact SET of undecided approvals, fingerprinted. A count survives one
  --    task being decided and another being raised; the fingerprint does not.
  select count(*), coalesce(md5(string_agg(ht.id::text, ',' order by ht.id)), '(none)')
    into v_before_n, v_before
    from human_tasks ht
   where ht.type = 'action_approval' and ht.status = 'pending';

  -- A. THE FIRING CONDITION IS WHERE IT IS CLAIMED TO BE. A trigger without
  --    the WHEN clause fires on EVERY update of every definition — the
  --    "fires on everything" failure, which is as broken as never firing.
  select pg_get_triggerdef(tg.oid) into v_when
    from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'action_definitions'
     and tg.tgname = 'action_definitions_retirement_strands';
  if v_when is null then
    raise exception '704: the trigger does not exist on action_definitions';
  end if;
  if v_when !~ 'WHEN' or v_when !~ 'status' then
    raise exception '704: the trigger has no WHEN clause on status — it would fire on EVERY definition update: %', v_when;
  end if;
  if v_when !~* 'AFTER UPDATE' then
    raise exception '704: the trigger is not AFTER UPDATE — a BEFORE trigger can veto a legitimate retirement: %', v_when;
  end if;

  -- B. IT NEVER DECIDES. The one rule with no exceptions. Comments stripped
  --    first: mig 701 shipped two pins that passed against a deliberately
  --    broken function because the words they searched for sat in a comment
  --    above the code, and the prose above THIS function is full of the very
  --    words being forbidden.
  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'alert_on_stranded_approvals';
  v_src := regexp_replace(v_src, '--[^\n]*', '', 'g');
  if v_src ~* '(update|delete)\s+(from\s+)?human_tasks' then
    raise exception '704: the trigger WRITES to human_tasks — surfacing is not deciding, and decide_human_task derives the decider from auth.uid() precisely so no decision is anonymous';
  end if;
  if v_src ~* 'decide_human_task|decide_action_execution' then
    raise exception '704: the trigger calls a DECISION function — it must only report';
  end if;
  if v_src ~* '(update|delete)\s+(from\s+)?action_executions' then
    raise exception '704: the trigger WRITES to action_executions';
  end if;
  -- ...and the only table it may write.
  if v_src !~* 'insert\s+into\s+ops_alerts' then
    raise exception '704: the trigger does not write an ops_alerts row — it would notice a retirement and tell nobody, which is the 29-day silence this migration exists to end';
  end if;

  -- C. THE TENANT IS IN THE DEDUP KEY. raise_ops_alert dedups on kind
  --    GLOBALLY; a kind without the tenant reports one retirement when five
  --    happened. Anchored to the CONSTRUCTION of the key, not to the string
  --    'stranded_approval' appearing somewhere.
  if v_src !~ 'v_kind\s*:=[^;]*tenant_id::text' then
    raise exception '704: the alert kind does not embed the tenant id — ops_alerts has no tenant column and the dedup is global, so alerts would COLLAPSE ACROSS TENANTS';
  end if;
  if v_src !~ 'v_kind\s*:=[^;]*new\.id::text' then
    raise exception '704: the alert kind does not embed the definition id — two different retirements in one workspace would collapse into one alert';
  end if;

  -- D. BOTH LINKAGE COLUMNS. mig 642 added resolves_task_id; a guard reading
  --    only task_id would miss every approval linked the newer way.
  if v_src !~ 'ae\.task_id\s*=\s*ht\.id' or v_src !~ 'ae\.resolves_task_id\s*=\s*ht\.id' then
    raise exception '704: the stranded-task query does not check BOTH linkage columns (task_id, resolves_task_id)';
  end if;
  -- ...and only rows still awaiting a human.
  if v_src !~ 'ht\.status\s*=\s*''pending''' then
    raise exception '704: the query is not limited to PENDING tasks — it would alert about approvals a human already decided';
  end if;

  -- E. THE PERIMETER, asserted rather than described. `create or replace`
  --    PRESERVES grants, so a REVOKE above is a statement of intent and this
  --    is the statement of RESULT (mig 630's lesson, twice re-shipped).
  if has_function_privilege('anon', 'public.alert_on_stranded_approvals()', 'EXECUTE') then
    raise exception '704: anon can execute alert_on_stranded_approvals';
  end if;
  if has_function_privilege('authenticated', 'public.alert_on_stranded_approvals()', 'EXECUTE') then
    raise exception '704: authenticated can execute alert_on_stranded_approvals — authenticated is the internet (mig 365)';
  end if;
  if has_function_privilege('public', 'public.alert_on_stranded_approvals()', 'EXECUTE') then
    raise exception '704: PUBLIC still holds EXECUTE — revoking the named roles alone is theatre (mig 610)';
  end if;
  if not has_function_privilege('service_role', 'public.alert_on_stranded_approvals()', 'EXECUTE') then
    raise exception '704: service_role LOST EXECUTE on alert_on_stranded_approvals';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'alert_on_stranded_approvals'
       and p.prosecdef
       and array_to_string(p.proconfig, ',') like '%search_path=public%')
  then
    raise exception '704: alert_on_stranded_approvals lost SECURITY DEFINER or its pinned search_path — ops_alerts has no INSERT policy, so an invoker-rights trigger would RAISE and block the retirement';
  end if;

  -- ── F. BOTH HALVES, DRIVEN. Everything above READS the definition of the
  --    guard; this RUNS it. A guard nobody has fired is a guard nobody has
  --    tested, and this repository has shipped several of those.
  --
  -- ⚠ IN A SUBTRANSACTION THAT IS DELIBERATELY ABORTED, and both reasons are
  -- load-bearing rather than tidiness:
  --
  --   1. `human_tasks_push_ping` (mig 670) fires AFTER INSERT on any pending
  --      human_task and net.http_post's /push-send. A committed fixture would
  --      ring the FOUNDER'S LOCK SCREEN with "704 PROBE". pg_net queues into a
  --      table, so aborting the subtransaction unqueues it before any worker
  --      can see it.
  --   2. `guard_human_task_decision` REFUSES to delete an undecided approval —
  --      correctly; deleting one is how a decision gets un-audited. So the
  --      fixture cannot be torn down by DELETE, and must not be, and setting
  --      `app.allow_task_decision` to bypass the guard for a test would be
  --      exactly the kind of convenience that later becomes a hole.
  --
  -- A plpgsql block with an EXCEPTION handler IS a subtransaction, so raising
  -- a sentinel at the end unwinds every fixture, every trigger side effect and
  -- every queued http row. NOTICEs already emitted are not rolled back, which
  -- is what makes the proof visible in the migration output. Any OTHER error
  -- is re-raised unchanged, so a genuinely failing assertion still fails the
  -- migration.
  begin
    select id into v_tenant from tenants order by created_at limit 1;
    if v_tenant is null then
      raise exception '704: no tenants — the proof below would be vacuous, which looks exactly like a pass';
    end if;

    -- A definition of our own to retire, so no real catalog row is touched.
    insert into action_definitions
      (category, action_key, label, provider, scope, status, param_schema, execution)
    values ('erp_financials', 'zz_704_probe_verb', '704 probe verb', 'erpnext', 'platform',
            'active', '[]'::jsonb, '{"execution_key":"zz_704_probe"}'::jsonb)
    returning id into v_def;

    -- ── F1. A LEGITIMATE RETIREMENT WITH NOTHING STRANDED MUST STAY SILENT.
    select count(*) into v_n from ops_alerts where kind like 'stranded\_approval\_%';
    update action_definitions set status = 'disabled' where id = v_def;
    if (select count(*) from ops_alerts where kind like 'stranded\_approval\_%') <> v_n then
      raise exception '704 F1 FAILED: a retirement with NO pending approvals raised an alert. A guard that fires on every retirement is noise, and noise is how an ai_budget_exhausted alert went unread for four days';
    end if;
    raise notice '704 F1 PASS: retirement with nothing stranded -> 0 alerts (silent, correct)';

    -- ── F2. UNRELATED UPDATES MUST STAY SILENT — the WHEN clause, driven.
    update action_definitions set status = 'active' where id = v_def;      -- back to active
    update action_definitions set label  = '704 probe verb (renamed)' where id = v_def;
    if (select count(*) from ops_alerts where kind like 'stranded\_approval\_%') <> v_n then
      raise exception '704 F2 FAILED: editing an unrelated column while status stayed active raised an alert — the WHEN clause is not doing its job';
    end if;
    update action_definitions set status = 'disabled' where id = v_def;    -- active -> non-active
    update action_definitions set status = 'draft'    where id = v_def;    -- non-active -> non-active
    if (select count(*) from ops_alerts where kind like 'stranded\_approval\_%') <> v_n then
      raise exception '704 F2 FAILED: a disabled->draft transition raised an alert — only a genuine active->non-active retirement may fire';
    end if;
    raise notice '704 F2 PASS: label-only edit, and disabled->draft -> 0 alerts (silent, correct)';

    -- ── F3. A RETIREMENT *WITH* A STRANDED APPROVAL MUST PRODUCE EXACTLY ONE
    --    ALERT NAMING THE TENANT, THE TASK AND THE DEFINITION.
    update action_definitions set status = 'active' where id = v_def;
    insert into human_tasks (tenant_id, type, title, status, source)
    values (v_tenant, 'action_approval', '704 PROBE — stranded approval fixture',
            'pending', 'system')
    returning id into v_task;
    insert into action_executions
      (tenant_id, action_definition_id, mode, params, decision, destructive, idempotent,
       request_summary, task_id)
    values (v_tenant, v_def, 'execute', '{}'::jsonb, 'human_gated_trust', false, true,
            '704 probe execution', v_task)
    returning id into v_exec;

    update action_definitions set status = 'disabled' where id = v_def;    -- THE RETIREMENT

    v_kind := 'stranded_approval_' || left(v_tenant::text, 8) || '_' || left(v_def::text, 8);
    select count(*) into v_n from ops_alerts where kind = v_kind;
    if v_n <> 1 then
      raise exception '704 F3 FAILED: retiring a definition with a stranded approval produced % alert(s), expected exactly 1', v_n;
    end if;
    if not exists (
      select 1 from ops_alerts
       where kind = v_kind
         and detail->>'tenant_id'            = v_tenant::text
         and detail->>'action_definition_id' = v_def::text
         and detail->>'action_key'           = 'zz_704_probe_verb'
         and detail->>'old_status'           = 'active'
         and detail->>'new_status'           = 'disabled'
         and detail->'stranded_tasks'->0->>'task_id' = v_task::text)
    then
      raise exception '704 F3 FAILED: the alert does not name the tenant, the definition AND the task. An alert that does not say WHICH is a rumour. detail = %',
        coalesce((select detail::text from ops_alerts where kind = v_kind), '(no row)');
    end if;
    raise notice '704 F3 PASS: retirement with a stranded approval -> exactly 1 alert; kind %, names tenant %, task %, definition %',
      v_kind, v_tenant, v_task, v_def;

    -- ── F4. THE TASK WAS NOT DECIDED. The rule with no exceptions, checked on
    --    the actual row rather than only in the source.
    if (select status from human_tasks where id = v_task) <> 'pending' then
      raise exception '704 F4 FAILED: THE TRIGGER DECIDED THE TASK. It must only report — a decision with no auth.uid() behind it is the one thing this must never do';
    end if;
    if (select count(*) from action_executions
         where id = v_exec and decision = 'human_gated_trust' and receipt is null) <> 1 then
      raise exception '704 F4 FAILED: the execution row was modified — the trigger must not touch it';
    end if;
    raise notice '704 F4 PASS: the stranded task is STILL pending and its execution untouched (surfacing is not deciding)';

    -- Unwind everything: fixtures, trigger side effects, the queued push row.
    raise exception using message = '704_PROBE_ROLLBACK', errcode = 'raise_exception';
  exception when others then
    if sqlerrm <> '704_PROBE_ROLLBACK' then
      raise;                        -- a REAL failure; propagate it unchanged
    end if;
    raise notice '704 F: all four cases proven, every fixture rolled back (nothing committed, no push sent)';
  end;

  -- G. Nothing of the probe survived the unwind.
  if exists (select 1 from action_definitions where action_key = 'zz_704_probe_verb')
     or exists (select 1 from human_tasks where title like '704 PROBE%')
     or exists (select 1 from ops_alerts where detail->>'action_key' = 'zz_704_probe_verb') then
    raise exception '704: probe fixtures SURVIVED the rollback — a test that leaves state in production is not a test';
  end if;

  -- ── H. NOT ONE APPROVAL WAS DECIDED. The single rule with no exceptions,
  --    proven against live state rather than only against the source. Written
  --    as a fingerprint of the whole undecided set, so it holds in every
  --    environment (dev has 0 such tasks, production 90) and cannot be
  --    satisfied by one task being decided while another appears.
  select count(*), coalesce(md5(string_agg(ht.id::text, ',' order by ht.id)), '(none)')
    into v_n, v_after
    from human_tasks ht
   where ht.type = 'action_approval' and ht.status = 'pending';
  if v_n <> v_before_n or v_after <> v_before then
    raise exception '704: THE SET OF UNDECIDED APPROVALS CHANGED across this migration (% rows/% -> % rows/%). Surfacing is not deciding, and this migration must leave every pending approval exactly as it found it',
      v_before_n, v_before, v_n, v_after;
  end if;
  raise notice '704 H: % pending approval(s) before and after, same set (fingerprint %) — surfaced, never decided',
    v_n, v_after;

  -- I. ...and mig 611's own casualty specifically, where it exists. This is
  --    the row that started all of this: it stays PENDING until a HUMAN
  --    withdraws it. Reported rather than asserted, because it is a fact about
  --    production data and not every environment has it — an assert that
  --    passes vacuously on dev would be worth nothing there and misleading
  --    here.
  select count(*) into v_n
    from human_tasks ht
    join action_executions ae  on ae.task_id = ht.id
    join action_definitions ad on ad.id = ae.action_definition_id
   where ht.type = 'action_approval' and ht.status = 'pending'
     and ad.status <> 'active';
  raise notice '704 I: % approval(s) currently stranded by an already-retired definition, still pending, still nobody''s decision but a human''s. certify''s no-pending-approval-the-platform-cannot-carry-out probe names each one.', v_n;
end $assert$;

commit;
