-- 318_action_exactly_once.sql
-- ============================================================================
-- §3 ACTION-HONESTY, Increment 0 (DB half) — EXACTLY-ONCE approval execution.
--
-- THE BUG (verified live): a gated action approved twice DOUBLE-EXECUTES.
-- connector-hub writes the executed row with task_id=NULL, so
-- resolve_action_execution_for_task (mig 078: `where task_id=p_task_id order by
-- created_at desc`) re-returns the ORIGINAL gated row on a second approval, and
-- runRegisteredAction fires the external call again (a double-charge). The
-- frontend decideHumanTask idempotency guard (shipped 72cfdde) closes the common
-- sequential double-click; THIS closes the concurrent race at the DB — the
-- authoritative serialization point before the external call.
--
-- Mechanism: a claim row carrying resolves_task_id, guarded by a PARTIAL UNIQUE
-- index so at most ONE successful execution can exist per approved task. The
-- claim is taken BEFORE the external call; a losing/racing/retry attempt hits
-- unique_violation and short-circuits to the recorded receipt without calling
-- the external system. A 'failed' execution clears the claim, so only genuine
-- failures are retryable and only one success can ever exist. GLOBAL.
-- ============================================================================

-- Correlation + claim columns (origin_* also feed Increment 1's def-of-done).
ALTER TABLE action_executions ADD COLUMN IF NOT EXISTS origin_kind      text;
ALTER TABLE action_executions ADD COLUMN IF NOT EXISTS origin_id        uuid;
ALTER TABLE action_executions ADD COLUMN IF NOT EXISTS resolves_task_id uuid REFERENCES human_tasks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS action_executions_origin_idx
  ON action_executions (origin_kind, origin_id) WHERE origin_id IS NOT NULL;

-- THE serialization point: at most one non-failed execution per approved task.
CREATE UNIQUE INDEX IF NOT EXISTS action_executions_resolves_once
  ON action_executions (resolves_task_id)
  WHERE resolves_task_id IS NOT NULL AND decision <> 'failed';

-- claim_gated_action_execution — atomic claim before the external call.
--   {claimed:true, claim_row_id}         → caller executes then UPDATEs this row
--   {claimed:false, existing_id, receipt}→ already executed; caller MUST NOT call out
--   {claimed:false, reason}              → task not approved / gated row missing
CREATE OR REPLACE FUNCTION public.claim_gated_action_execution(
  p_tenant_id uuid, p_task_id uuid, p_execution_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
declare
  v_task_status text;
  v_new_id uuid;
  v_existing_id uuid;
  v_existing_receipt text;
begin
  -- Authoritative resolution signal — the human_task must be APPROVED (the
  -- action_executions.decision alone can't distinguish pending/approved/rejected).
  select status into v_task_status from human_tasks where id = p_task_id and tenant_id = p_tenant_id;
  if v_task_status is distinct from 'approved' then
    return jsonb_build_object('claimed', false, 'reason', 'task_not_approved');
  end if;

  -- Already executed for this task?
  select id, receipt into v_existing_id, v_existing_receipt
    from action_executions where resolves_task_id = p_task_id and decision <> 'failed' limit 1;
  if v_existing_id is not null then
    return jsonb_build_object('claimed', false, 'existing_id', v_existing_id, 'receipt', v_existing_receipt);
  end if;

  -- Claim: copy the gated row's fields into a new executed-placeholder row,
  -- guarded by the partial unique index. Concurrent/retry attempts collide.
  begin
    insert into action_executions (
      tenant_id, action_definition_id, connector_id, subject_kind, subject_id, mode, params,
      decision, destructive, idempotent, dedupe_key, request_summary,
      origin_kind, origin_id, resolves_task_id, receipt, result, task_id
    )
    select
      tenant_id, action_definition_id, connector_id, subject_kind, subject_id, mode, params,
      'executed_after_approval', destructive, idempotent, dedupe_key, request_summary,
      origin_kind, origin_id, p_task_id, null, null, null
    from action_executions
    where id = p_execution_id and tenant_id = p_tenant_id
    returning id into v_new_id;
  exception when unique_violation then
    select id, receipt into v_existing_id, v_existing_receipt
      from action_executions where resolves_task_id = p_task_id and decision <> 'failed' limit 1;
    return jsonb_build_object('claimed', false, 'existing_id', v_existing_id, 'receipt', v_existing_receipt);
  end;

  if v_new_id is null then
    return jsonb_build_object('claimed', false, 'reason', 'gated_row_not_found');
  end if;
  return jsonb_build_object('claimed', true, 'claim_row_id', v_new_id);
end $$;
REVOKE ALL ON FUNCTION public.claim_gated_action_execution(uuid, uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_gated_action_execution(uuid, uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
