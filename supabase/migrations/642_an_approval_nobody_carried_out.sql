-- 642_an_approval_nobody_carried_out.sql
-- ============================================================================
-- Six actions were approved in July and never carried out. They are not
-- pending — a human already said yes. They simply never ran, because approval
-- only executes when someone clicks in the browser and nobody went back.
--
-- We are about to build a scheduled job that executes approved actions. On its
-- first tick it would find these six and fire month-old decisions into two
-- suspended workspaces and one live one. So they must be made terminal first.
--
-- WHY 'expired' AND NOT 'rejected' — TWO INDEPENDENT REASONS, BOTH DECISIVE.
--
-- 1. HONESTY. `human_tasks.status` IS the human's decision. Writing 'rejected'
--    over 'approved' would make the record assert that a person rejected work
--    they in fact approved. That is falsifying a decision record — the same
--    family of mistake as rewriting an audit log to make its checker green,
--    which this codebase has done before and must never do again.
--
-- 2. SAFETY. Six AFTER UPDATE OF status triggers on human_tasks each guard on
--    `status in ('approved','rejected')`:
--      sync_amendment_decision · sync_computer_use_approval
--      sync_de_work_escalation · sync_entity_amendment_decision
--      sync_improvement_decision · sync_outbound_draft_status
--    Writing 'rejected' does not merely mislabel — it ACTIVATES their else
--    branches: reject_playbook_amendment, reject_entity_amendment,
--    reject_improvement, and writes into outbound_drafts, computer_use_tasks
--    and resume_de_work_from_decision. A new value falls outside every
--    whitelist and is inert by construction. (All six of these tasks carry
--    related_table='action_executions', so none would match anyway — but the
--    guarantee should not rest on that coincidence.)
--
-- WHAT IS PRESERVED. decided_by and decided_at are NOT touched. The row keeps
-- saying who approved it and when. Before the status changes, the full prior
-- state is written into an appended action_executions row, so the fact of the
-- approval survives in an append-only place even if the task row is later
-- edited. We add a fact; we do not overwrite one.
--
-- HOW THE SET IS CHOSEN. Not by hardcoded ids. The population is re-derived
-- here from evidence, and the migration REFUSES TO RUN if it does not find
-- exactly the six it expects. The obvious predicate — "no action_executions
-- row links back to this task" — is WRONG: resolves_task_id was not populated
-- before August (4 of 16 executions carry it, 0 carry task_id), so that test
-- reports executed work as pending. It reported 16. The true answer is 6.
-- Execution is therefore established by matching the gate row to an
-- executed_after_approval row on (tenant, action_definition, request_summary),
-- BY COUNT rather than existence, so that N approvals of identical shape need
-- N executions to all count as run.
-- ============================================================================

begin;

-- ── 1. Two additive CHECK widenings. Neither removes an existing value. ─────
alter table public.human_tasks drop constraint if exists human_tasks_status_check;
alter table public.human_tasks add constraint human_tasks_status_check
  check (status = any (array['pending'::text, 'approved'::text, 'rejected'::text, 'expired'::text]));

alter table public.action_executions drop constraint if exists action_executions_decision_check;
alter table public.action_executions add constraint action_executions_decision_check
  check (decision = any (array['previewed'::text, 'auto_executed'::text,
                               'human_gated_destructive'::text, 'human_gated_trust'::text,
                               'guardrail_blocked'::text, 'access_denied'::text,
                               'executed_after_approval'::text, 'rejected'::text,
                               'failed'::text, 'expired'::text]));

do $$
declare
  v_ids       uuid[];
  v_n         int;
  v_before    int;
  v_after     int;
  v_ran_before int;
  v_ran_after  int;
begin
  -- ── 2. Re-derive the population from evidence. ───────────────────────────
  select array_agg(ht.id order by ht.created_at)
    into v_ids
    from human_tasks ht
    left join action_executions g on g.task_id = ht.id
   where ht.type = 'action_approval'
     and ht.status = 'approved'
     and (
       select count(*) from human_tasks h2
        left join action_executions g2 on g2.task_id = h2.id
        where h2.type = 'action_approval' and h2.status = 'approved'
          and h2.tenant_id = ht.tenant_id
          and g2.action_definition_id is not distinct from g.action_definition_id
          and g2.request_summary is not distinct from g.request_summary
     ) > (
       select count(*) from action_executions x
        where x.decision = 'executed_after_approval'
          and x.tenant_id = ht.tenant_id
          and x.action_definition_id is not distinct from g.action_definition_id
          and x.request_summary is not distinct from g.request_summary
     );

  v_n := coalesce(array_length(v_ids, 1), 0);
  -- A data repair is production-specific. On dev, on a fresh database, and on
  -- a replay from zero there is nothing to repair — that must be a clean skip,
  -- not a failure, or this migration breaks R1.9 (migrations replay from an
  -- empty DB) forever. But a population that is neither empty nor the six we
  -- verified means the facts moved under us, and that must stop the run.
  if v_n = 0 then
    raise notice '642: no approved-but-never-executed actions here — nothing to expire (expected on dev/replay)';
    return;
  end if;
  if v_n <> 6 then
    raise exception '642: expected exactly 6 approved-but-never-executed actions, found %. The population changed since this was written — re-derive before running.', v_n;
  end if;

  select count(*) into v_before from action_executions;
  select count(*) into v_ran_before from action_executions where decision = 'executed_after_approval';

  -- ── 3. Append the void to the action ledger BEFORE touching the task, so
  --       the prior approval is recorded in an append-only place first. ─────
  insert into action_executions
    (tenant_id, action_definition_id, connector_id, subject_kind, subject_id,
     mode, params, decision, destructive, idempotent,
     request_summary, result, task_id, resolves_task_id, origin_kind)
  select g.tenant_id, g.action_definition_id, g.connector_id, g.subject_kind, g.subject_id,
         g.mode, g.params, 'expired', g.destructive, g.idempotent,
         'EXPIRED, never carried out. ' || coalesce(g.request_summary, ''),
         jsonb_build_object(
           'expired_at',            now(),
           'expired_by',            'migration 642',
           'reason',                'Approved but never executed. Voided before a scheduled executor existed, so a month-old decision could not fire unattended.',
           'prior_task_status',     ht.status,
           'prior_decided_by',      ht.decided_by,
           'prior_decided_at',      ht.decided_at,
           'gate_verdict',          g.decision,
           'gate_execution_id',     g.id),
         null, ht.id, 'expiry_sweep_642'
    from human_tasks ht
    join action_executions g on g.task_id = ht.id
   where ht.id = any(v_ids);

  -- ── 4. Now make the task terminal. decided_by/decided_at are untouched. ──
  -- Sanctioned decision path (mig 486): a direct write to status is guarded.
  perform set_config('app.allow_task_decision', 'on', true);

  update human_tasks
     set status       = 'expired',
         disposition  = 'cancelled',
         decision_note = coalesce(nullif(btrim(decision_note), '') || ' | ', '')
           || 'Expired by migration 642 on ' || to_char(now(), 'YYYY-MM-DD')
           || ': approved but never carried out, voided before a scheduled executor could fire it unattended. The original approval stands in the action ledger.',
         updated_at   = now()
   where id = any(v_ids);

  get diagnostics v_n = row_count;
  if v_n <> 6 then
    raise exception '642: expected to expire 6 tasks, updated %', v_n;
  end if;

  -- ── 5. Prove it. The decisive assertion is that NOTHING EXECUTED. ────────
  select count(*) into v_after from action_executions;
  select count(*) into v_ran_after from action_executions where decision = 'executed_after_approval';

  if v_after <> v_before + 6 then
    raise exception '642: expected exactly 6 new ledger rows, ledger moved from % to %', v_before, v_after;
  end if;
  if v_ran_after <> v_ran_before then
    raise exception '642: SOMETHING EXECUTED. executed_after_approval moved from % to %', v_ran_before, v_ran_after;
  end if;
  if exists (select 1 from action_executions where decision = 'expired' and receipt is not null) then
    raise exception '642: an expired action carries a receipt — it ran';
  end if;
  if exists (select 1 from human_tasks where id = any(v_ids) and decided_by is null and decided_at is null) then
    raise exception '642: an expiry erased the original approver';
  end if;
  if exists (select 1 from human_tasks
              where type = 'action_approval' and status = 'approved'
                and id = any(v_ids)) then
    raise exception '642: a task was left approved';
  end if;

  raise notice '642: 6 approvals expired, 6 ledger rows appended, 0 executed';
end $$;

-- ── 6. The rule this leaves behind, asserted rather than remembered. ───────
-- An expired action must never acquire an execution. If a future scheduled
-- executor picks one up, this fails.
do $$
begin
  if exists (
    select 1 from action_executions e
     join human_tasks ht on ht.id = e.resolves_task_id
    where ht.status = 'expired'
      and e.decision in ('executed_after_approval', 'auto_executed')
  ) then
    raise exception '642: an expired approval has an execution against it';
  end if;
end $$;

commit;
