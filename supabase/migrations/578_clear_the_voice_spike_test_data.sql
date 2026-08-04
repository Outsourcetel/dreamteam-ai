-- 578 — clear the voice spike's test data out of the live workspace.
--
-- The P0 spike left fake callers in real queues: three pending "call back
-- Sam Rivera on 555-0100" tasks and a pending approval to book an appointment
-- for the same invented person. Those are commitments to customers who do not
-- exist, sitting in the queue an operator works from. Harmless while the
-- founder is the only user; actively misleading the moment anyone else opens
-- the workspace, and it would poison the first pilot's numbers.
--
-- KEPT DELIBERATELY:
--   * evidence_runs 69006c99 — the REAL call of 2026-08-04 21:13. That one
--     happened; it is evidence, not a fixture.
--   * every audit_events row, including those for the deleted objects. An
--     audit log is the record of what happened, not a view of what currently
--     exists — deleting entries to tidy the present is exactly the move
--     migration 549 exists to make impossible. The entries now point at
--     removed rows, which is correct: the events did occur.
--
-- Deletes, rather than marking rejected: a fake approval rejected on the
-- record teaches the learning loop that a legitimate booking was refused
-- (the migration-548 lesson).

do $$
declare
  v_msgs     uuid[];
  v_tasks    uuid[];
  v_runs     uuid[];
  v_execs    uuid[];
  v_exec_tsk uuid[];
  n_msg int; n_task int; n_run int; n_exec int;
begin
  -- Test messages: every voice message from a simulated or proof call. The
  -- real call produced no message (both live callers hung up before giving
  -- their details), so this is safe to scope by call_id.
  select array_agg(id) into v_msgs from voice_messages
   where call_id in ('sim-call-001', 'proof-callback-001') or call_id is null;

  select array_agg(id) into v_tasks from human_tasks
   where related_table = 'voice_messages'
     and (related_id = any(coalesce(v_msgs, '{}'::uuid[])) or related_id is null);

  select array_agg(id) into v_runs from evidence_runs
   where kind = 'call' and steps->0->>'call_id' = 'sim-call-001';

  select array_agg(e.id), array_agg(e.task_id)
    into v_execs, v_exec_tsk
    from action_executions e
    join action_definitions a on a.id = e.action_definition_id
   where a.action_key = 'book_appointment';

  -- `guard_human_task_decision` (mig 487) refuses to delete an UNDECIDED
  -- approval and tells you to decide it instead. That guard is right, and it
  -- is right here too — but only for real work. This approval is a fixture
  -- for an invented caller, and "deciding" it would write a rejection of a
  -- perfectly legitimate booking into the learning loop (the mig-548 lesson).
  -- The sanctioned bypass is transaction-local: it applies to this cleanup
  -- and nothing else, and never reaches a running system.
  perform set_config('app.allow_task_decision', 'on', true);

  -- Order matters: children before parents.
  delete from evidence_run_decisions where evidence_run_id = any(coalesce(v_runs, '{}'::uuid[]));
  delete from evidence_runs          where id             = any(coalesce(v_runs, '{}'::uuid[]));
  get diagnostics n_run = row_count;

  delete from action_executions      where id             = any(coalesce(v_execs, '{}'::uuid[]));
  get diagnostics n_exec = row_count;

  delete from human_tasks            where id             = any(coalesce(v_exec_tsk, '{}'::uuid[]));
  delete from human_tasks            where id             = any(coalesce(v_tasks, '{}'::uuid[]));
  get diagnostics n_task = row_count;

  delete from voice_messages         where id             = any(coalesce(v_msgs, '{}'::uuid[]));
  get diagnostics n_msg = row_count;

  delete from voice_appointments     where call_id in ('sim-call-001', 'proof-callback-001');

  perform public.append_audit_event_internal(
    '5bb802e1-8e92-4eef-9a7a-ac348785d43f',
    'Platform maintenance', 'system',
    format('Cleared voice spike test data — %s message(s), %s task(s), %s simulated call run(s), %s booking execution(s). The real call of 2026-08-04 and all audit entries were kept.',
           n_msg, n_task, n_run, n_exec),
    'config_change',
    jsonb_build_object('kind', 'voice_test_data_cleared', 'messages', n_msg,
                       'tasks', n_task, 'sim_runs', n_run, 'executions', n_exec)
  );
end $$;
