-- 645_ten_executions_that_forgot_what_they_resolved.sql
-- ============================================================================
-- Ten actions executed in July without recording WHICH approval authorised
-- them. `action_executions.resolves_task_id` was not populated before August,
-- so the ledger cannot connect the decision to the deed.
--
-- This is not tidiness. TWO live mechanisms ask exactly that question:
--
--   1. due_approved_actions (mig 644) treats "no resolving row" as "not yet
--      carried out". Ten already-executed approvals therefore look DUE. They
--      are held back today only by the enabled_at watermark being later than
--      their decided_at — a guard that evaporates the moment anyone backdates
--      it to catch up on a backlog, which is a reasonable-sounding thing to do.
--
--   2. claim_gated_action_execution — the exactly-once claim itself — uses the
--      SAME test: `where resolves_task_id = p_task_id and decision <> 'failed'`.
--      So the mechanism designed to prevent a second external call would not
--      have prevented one. It is blind for precisely these ten rows.
--
-- The result would be duplicate payment reminders in acme-telecom and duplicate
-- digital employees in kinetic — and it would look, from the ledger, entirely
-- correct. This is the same class of error that made me report 16 stale
-- approvals when there were 6 (mig 642): the linkage column is not the fact.
--
-- The repair pairs each unresolved approval with its execution on
-- (tenant, action_definition, request_summary), ordered by time, matched
-- one-to-one by row number so that N identical approvals bind to N distinct
-- executions rather than all pointing at the first. It writes ONLY the missing
-- linkage — no status, no decision, no receipt, nothing that would change what
-- the record says happened.
-- ============================================================================

begin;

do $$
declare
  v_expected int;
  v_updated  int;
  v_left     int;
  v_dupes    int;
begin
  -- What we expect to fix, computed before touching anything.
  with appr as (
    select ht.id as task_id, ht.tenant_id, g.action_definition_id, g.request_summary,
           row_number() over (partition by ht.tenant_id, g.action_definition_id, g.request_summary
                              order by ht.decided_at, ht.id) as rn
      from human_tasks ht
      join action_executions g on g.task_id = ht.id
     where ht.type = 'action_approval' and ht.status = 'approved'
       and not exists (select 1 from action_executions x
                        where x.resolves_task_id = ht.id and x.decision <> 'failed')
  ), ran as (
    select x.id as exec_id, x.tenant_id, x.action_definition_id, x.request_summary,
           row_number() over (partition by x.tenant_id, x.action_definition_id, x.request_summary
                              order by x.created_at, x.id) as rn
      from action_executions x
     where x.decision = 'executed_after_approval' and x.resolves_task_id is null
  )
  select count(*) into v_expected
    from appr a
    join ran r on r.tenant_id = a.tenant_id
              and r.action_definition_id is not distinct from a.action_definition_id
              and r.request_summary is not distinct from a.request_summary
              and r.rn = a.rn;

  if v_expected = 0 then
    raise notice '645: no unlinked executions here — nothing to repair (expected on dev/replay)';
    return;
  end if;

  with appr as (
    select ht.id as task_id, ht.tenant_id, g.action_definition_id, g.request_summary,
           row_number() over (partition by ht.tenant_id, g.action_definition_id, g.request_summary
                              order by ht.decided_at, ht.id) as rn
      from human_tasks ht
      join action_executions g on g.task_id = ht.id
     where ht.type = 'action_approval' and ht.status = 'approved'
       and not exists (select 1 from action_executions x
                        where x.resolves_task_id = ht.id and x.decision <> 'failed')
  ), ran as (
    select x.id as exec_id, x.tenant_id, x.action_definition_id, x.request_summary,
           row_number() over (partition by x.tenant_id, x.action_definition_id, x.request_summary
                              order by x.created_at, x.id) as rn
      from action_executions x
     where x.decision = 'executed_after_approval' and x.resolves_task_id is null
  ), pairs as (
    select r.exec_id, a.task_id
      from appr a
      join ran r on r.tenant_id = a.tenant_id
                and r.action_definition_id is not distinct from a.action_definition_id
                and r.request_summary is not distinct from a.request_summary
                and r.rn = a.rn
  )
  update action_executions ae
     set resolves_task_id = p.task_id
    from pairs p
   where ae.id = p.exec_id
     and ae.resolves_task_id is null;   -- never overwrite a linkage that exists

  get diagnostics v_updated = row_count;
  if v_updated <> v_expected then
    raise exception '645: expected to link % executions, linked %', v_expected, v_updated;
  end if;

  -- No execution may now claim to resolve a task another already resolves.
  select count(*) into v_dupes from (
    select resolves_task_id from action_executions
     where resolves_task_id is not null and decision <> 'failed'
     group by resolves_task_id having count(*) > 1) d;
  if v_dupes > 0 then
    raise exception '645: % task(s) are resolved by more than one execution', v_dupes;
  end if;

  -- THE POINT: nothing approved may still look un-executed.
  select count(*) into v_left
    from human_tasks ht
    join action_executions g on g.task_id = ht.id
   where ht.type = 'action_approval' and ht.status = 'approved'
     and g.decision like 'human_gated%'
     and not exists (select 1 from action_executions x
                      where x.resolves_task_id = ht.id and x.decision <> 'failed');
  if v_left > 0 then
    raise exception '645: % approved action(s) still have no resolving execution — the driver would re-run them', v_left;
  end if;

  raise notice '645: linked % executions to the approvals that authorised them; 0 approvals now look un-executed', v_updated;
end $$;

commit;
