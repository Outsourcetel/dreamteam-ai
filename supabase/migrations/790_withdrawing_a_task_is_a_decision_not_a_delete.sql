-- 790_withdrawing_a_task_is_a_decision_not_a_delete.sql
-- ============================================================================
-- The founder asked for a delete button: "we need an option to delete a task
-- otherwise the list gets too long." 412 tasks are pending, 276 of them older
-- than thirty days, and many are testing residue that will never be decided.
--
-- The table already refuses a delete, and its refusal names the right answer:
--
--     'human_tasks: an undecided approval cannot be deleted (task %).
--      Decide it first — cancelling with a reason is a decision.'
--                                        — guard_human_task_decision()
--
-- That guard is not in the way of this feature; it IS the feature's spec. A
-- hard DELETE would destroy the only record that the platform ever asked a
-- person for something, and human_tasks is pointed at from elsewhere
-- (trust_policies.pending_task_id among others), so the row is load-bearing
-- beyond its own list. What the founder wants is the task GONE FROM THE LIST,
-- and that does not require the row to be gone from the database.
--
-- ── Why this delegates instead of writing its own UPDATE ────────────────────
-- The obvious implementation writes status directly. That would be a SECOND
-- decision path, and every one this codebase has grown has cost it something:
-- the guard exists because direct writes "cannot be audited and do not resume
-- the blocked work". decide_human_task already carries all of it —
-- auth_tenant_id(), the DE reporting-line check, the sanctioned-decision flag
-- the table trigger demands, the audit event, and the fourteen trg_sync_*
-- triggers that stop a withdrawn task leaving an outbound draft or a
-- conversation reply pending behind it. So this calls it.
--
-- ── Why 'rejected' ──────────────────────────────────────────────────────────
-- A withdrawal must never execute the action. 'approved' can; 'rejected'
-- cannot, so the safe verb is the one that already means "do not do this".
--
-- It also lands on the right side of mig 593's authority model, which
-- deliberately does NOT gate rejections: "declining is the conservative
-- direction, and a rule that stops someone saying no is not an authority
-- model, it is a way of forcing things through." Clearing your own queue
-- clutter should not depend on your approval limit, and this way it doesn't.
--
-- ── Why the disposition matters, and is not decoration ──────────────────────
-- 'I read this and said no' and 'this should never have been in my list' are
-- both status='rejected'. Only the first is evidence about an employee's
-- judgement. Without a mark to tell them apart, withdrawing 300 testing
-- artefacts would drive the approval rate — a number this product SHOWS the
-- founder — toward zero and call it a quality signal.
--
-- disposition='cancelled' is that mark, and it is not invented here: 31 rows
-- already carry it from the expiry and stranding sweeps, meaning exactly this.
-- The UI change that ships with this migration excludes cancelled rows from
-- the approval-rate denominator for the same reason.
--
-- ⚠ AGENTS DO NOT CALL THIS. Mig 704: surfacing is not deciding. This inherits
-- decide_human_task's auth.uid() requirement, so a service-role caller with no
-- authenticated user fails on auth_tenant_id() before it reaches the write —
-- the boundary is kept by the delegation, not by a comment.
-- ============================================================================

create or replace function public.withdraw_human_task(p_task_id uuid, p_note text default null)
returns human_tasks
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_row human_tasks;
begin
  -- Every guard, audit event and downstream sync comes from here. The reason
  -- code is required for any rejection (decide_human_task raises without one)
  -- and 'withdrawn' is what makes these findable later as a class.
  v_row := public.decide_human_task(p_task_id, 'rejected', 'withdrawn', p_note);

  -- decide_human_task returns a NULL composite when the task was already
  -- decided. Say so rather than stamping a disposition onto someone else's
  -- decision.
  if v_row.id is null then
    return null;
  end if;

  -- Passes guard_human_task_decision: it raises only when status, decided_by
  -- or decided_at change, and none of them move here.
  update human_tasks set disposition = 'cancelled' where id = p_task_id;

  select * into v_row from human_tasks where id = p_task_id;
  return v_row;
end;
$fn$;

comment on function public.withdraw_human_task(uuid, text) is
  'Remove a task from the queue without acting on it. Delegates to '
  'decide_human_task(rejected, withdrawn) so every guard, audit event and sync '
  'trigger applies, then marks disposition=cancelled so it is excluded from '
  'the approval-rate denominator. The row is kept: mig 486''s guard refuses to '
  'let an undecided approval be deleted, and this is the decision it asks for.';

-- ── Bulk, because the problem the founder reported is a LIST, not a task ────
-- Per-task subtransactions on purpose: one task the caller may not touch
-- (another employee's reporting line) must not roll back the other 299. The
-- caller is told which ones failed and why rather than being told "done".
create or replace function public.withdraw_human_tasks(p_task_ids uuid[], p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_id uuid;
  v_ok int := 0;
  v_failed jsonb := '[]'::jsonb;
  v_row human_tasks;
begin
  if p_task_ids is null or array_length(p_task_ids, 1) is null then
    return jsonb_build_object('withdrawn', 0, 'failed', v_failed);
  end if;
  -- A cap, so a UI bug cannot empty a whole workspace's queue in one call.
  -- 500 is comfortably above the largest real queue (412 today) and far below
  -- "everything, everywhere".
  if array_length(p_task_ids, 1) > 500 then
    raise exception 'too_many: withdraw at most 500 tasks at a time (got %)', array_length(p_task_ids, 1);
  end if;

  foreach v_id in array p_task_ids loop
    begin
      v_row := public.withdraw_human_task(v_id, p_note);
      if v_row.id is null then
        v_failed := v_failed || jsonb_build_object('id', v_id, 'error', 'already_decided');
      else
        v_ok := v_ok + 1;
      end if;
    exception when others then
      v_failed := v_failed || jsonb_build_object('id', v_id, 'error', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('withdrawn', v_ok, 'failed', v_failed);
end;
$fn$;

comment on function public.withdraw_human_tasks(uuid[], text) is
  'Bulk withdraw. Per-task subtransactions so one refusal does not roll back '
  'the rest; returns {withdrawn, failed[{id,error}]} so a partial result is '
  'reported as partial rather than as success.';

revoke all on function public.withdraw_human_task(uuid, text)    from public, anon, authenticated;
revoke all on function public.withdraw_human_tasks(uuid[], text) from public, anon, authenticated;
grant execute on function public.withdraw_human_task(uuid, text)    to authenticated;
grant execute on function public.withdraw_human_tasks(uuid[], text) to authenticated;

-- ── Prove the properties rather than asserting them in a comment ────────────
do $$
declare
  v_def text;
  v_grantees text;
begin
  -- A. It must not have grown its own UPDATE of status. The whole safety
  --    argument is that it delegates; a future edit that inlines the write
  --    would keep the name and lose the guarantee.
  select pg_get_functiondef(oid) into v_def
    from pg_proc where oid = 'public.withdraw_human_task(uuid, text)'::regprocedure;
  if v_def !~* 'decide_human_task' then
    raise exception '790: withdraw_human_task no longer delegates to decide_human_task — every guard came from that call';
  end if;
  if v_def ~* 'update[[:space:]]+human_tasks[[:space:]]+set[^;]*status' then
    raise exception '790: withdraw_human_task writes status directly — that is the second decision path mig 486 exists to prevent';
  end if;

  -- B. It must reject, never approve. An approval executes the action, which
  --    is the one outcome a withdrawal must never produce.
  if v_def !~* '''rejected''' then
    raise exception '790: withdraw_human_task does not decide rejected — a withdrawal must never be able to execute the action';
  end if;

  -- C. anon must not hold it. This is a mutation of governance state.
  select coalesce(string_agg(distinct grantee, ','), '(none)') into v_grantees
    from information_schema.role_routine_grants
   where specific_schema = 'public'
     and routine_name in ('withdraw_human_task', 'withdraw_human_tasks')
     and grantee in ('anon', 'public');
  if v_grantees <> '(none)' then
    raise exception '790: withdraw is reachable by % — the internet does not clear a governance queue', v_grantees;
  end if;

  -- D. The disposition value must be one the readers already understand.
  --    Inventing a new word here would leave 31 existing rows meaning the
  --    same thing under a different name.
  if not exists (select 1 from human_tasks where disposition = 'cancelled') then
    raise exception '790: no row carries disposition=cancelled — the vocabulary this migration reuses is not actually in use, check before reusing it';
  end if;
end $$;
