-- 503_authority_follows_assignment.sql
-- ============================================================================
-- FOUNDER DECISION, block 4: who can answer a blocked employee.
--
-- This closes the "two axes disagree" item that has been open since docs/29.
-- The model says permissions run on two axes — ROLE grants modules, ASSIGNMENT
-- grants employees — but the two functions that actually unblock work ignored
-- assignment entirely and demanded tenant_owner or tenant_admin.
--
-- The cost of that was concrete, not theoretical. outsourcetel-hq has ONE owner
-- and TWO users, and no admins, managers or approvers at all. So exactly one
-- person could unfreeze anything, against 22 frozen work items and 22 open
-- exceptions. And Ali — a reporting-line MANAGER on these employees, proven in
-- the docs/29 behavioural test — could not act on the employees he manages,
-- which made the reporting line a label rather than an authority.
--
-- Fix: both decision paths now gate on can_access_de(), which already encodes
-- both axes exactly as the model intends — owner/admin/manager pass for the
-- whole workforce, everyone else passes for the employees they are assigned to.
-- Nobody gains reach over an employee they were not already trusted to see.
--
-- Note the ordering change in decide_de_exception: its role test ran BEFORE the
-- exception row was loaded, so it could not know which employee was involved.
-- The assignment test therefore moves to just after the row loads, alongside
-- the existing already-decided check. decide_de_escalation already tested
-- can_access_de after loading its task, so its blanket gate is simply removed.
--
-- Both bodies reproduced from the LIVE definitions (mig 377), single-hit
-- anchors (mig 430), CRLF preserved.
-- ============================================================================

-- ── decide_de_escalation ──
CREATE OR REPLACE FUNCTION public.decide_de_escalation(p_task_id uuid, p_disposition text, p_instruction text DEFAULT NULL::text, p_assign_role text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := auth_tenant_id();
  v_task human_tasks;
  v_de_name text;
  v_instruction text;
  v_moved uuid;
begin
  -- mig 486: this is a sanctioned decision path (see guard_human_task_decision).
  perform set_config('app.allow_task_decision', 'on', true);

  if v_tenant is null then raise exception 'not_authenticated'; end if;
  -- mig 503: authority follows ASSIGNMENT, not job title. The per-employee
  -- can_access_de test below is the whole gate now.

  if p_disposition not in ('answered','cancelled','rerouted') then
    raise exception 'disposition must be answered | cancelled | rerouted';
  end if;

  select * into v_task from human_tasks where id = p_task_id and tenant_id = v_tenant;
  if v_task.id is null then raise exception 'task_not_found'; end if;
  if v_task.status <> 'pending' then raise exception 'already_decided: %', v_task.status; end if;
  if v_task.de_id is not null and not can_access_de(v_task.de_id) then
    raise exception 'insufficient_scope';
  end if;

  v_instruction := nullif(btrim(coalesce(p_instruction, '')), '');
  if p_disposition = 'cancelled' and v_instruction is null then
    raise exception 'cancelling a blocker requires a reason';
  end if;

  update human_tasks set
    status = case when p_disposition = 'cancelled' then 'rejected'
                  when p_disposition = 'answered' then 'approved'
                  else status end,
    disposition = p_disposition,
    decision_note = coalesce(v_instruction, decision_note),
    assigned_role = coalesce(p_assign_role, assigned_role),
    decided_by = auth.uid(),
    decided_at = now()
  where id = p_task_id;

  if p_disposition = 'rerouted' then
    v_moved := resume_de_work_from_decision(p_task_id, 'rerouted', v_instruction);
  else
    select resolved_work_item_id into v_moved from human_tasks where id = p_task_id;
  end if;

  select name into v_de_name from digital_employees where id = v_task.de_id;
  perform append_audit_event(
    v_tenant, 'Workspace', 'human',
    format('%s escalation %s — %s', coalesce(v_de_name, 'An employee'), p_disposition, left(v_task.title, 120)),
    'approval',
    jsonb_build_object('task_id', p_task_id, 'de_id', v_task.de_id,
      'disposition', p_disposition, 'instruction', v_instruction,
      'work_item_id', v_task.related_id, 'work_item_moved', v_moved is not null));

  return jsonb_build_object('ok', true, 'disposition', p_disposition,
    'work_item_id', v_task.related_id, 'work_item_moved', v_moved is not null);
end;
$function$
;

-- ── decide_de_exception ──
CREATE OR REPLACE FUNCTION public.decide_de_exception(p_exception_id uuid, p_decision text, p_outcome text DEFAULT NULL::text, p_learned boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := auth_tenant_id();
  v_row de_exceptions;
  v_de_name text;
  v_status text;
  v_memory_id uuid;
  v_item_moved uuid;
  v_instruction text;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  -- mig 503: authority follows ASSIGNMENT, not job title (founder decision,
  -- block 4). The per-employee test happens below, once the row identifies
  -- which employee this is.

  IF p_decision NOT IN ('approved','rejected','denied') THEN
    RAISE EXCEPTION 'decision must be approved or rejected';
  END IF;
  v_status := CASE WHEN p_decision = 'rejected' THEN 'denied' ELSE p_decision END;
  SELECT * INTO v_row FROM de_exceptions WHERE id = p_exception_id AND tenant_id = v_tenant;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'exception_not_found'; END IF;
  IF v_row.status <> 'proposed' THEN RAISE EXCEPTION 'already_decided: %', v_row.status; END IF;
  -- Assignment (or seniority) decides. can_access_de encodes both axes:
  -- owner/admin/manager pass for the whole workforce, everyone else passes
  -- for the employees they are actually assigned to.
  IF NOT can_access_de(v_row.de_id) THEN RAISE EXCEPTION 'insufficient_scope'; END IF;
  SELECT name INTO v_de_name FROM digital_employees WHERE id = v_row.de_id;
  v_instruction := nullif(btrim(coalesce(p_outcome, '')), '');

  UPDATE de_exceptions SET
    status = v_status, outcome = p_outcome, learned = coalesce(p_learned, false),
    decided_by = auth.uid(), decided_at = now()
  WHERE id = p_exception_id;

  -- (A) "remember this" -> durable memory the employee actually recalls.
  IF coalesce(p_learned, false) THEN
    v_memory_id := de_memory_write(
      p_tenant_id    => v_tenant,
      p_de_id        => v_row.de_id,
      p_content      => left(format('Human ruling (%s): when facing "%s" the proposal was "%s".%s', v_status, v_row.situation, v_row.proposed_action, CASE WHEN v_instruction IS NOT NULL THEN ' Instruction: ' || v_instruction ELSE '' END), 2000),
      p_embedding    => NULL,             -- de_memory_search degrades to recency+salience when null
      p_subject_kind => 'general',
      p_subject_ref  => NULL,
      p_kind         => 'fact',
      p_salience     => 0.8,
      p_source       => 'human');
  END IF;

  -- (B) the paused work item moves with the decision.
  IF v_row.work_item_id IS NOT NULL THEN
    IF v_status = 'approved' THEN
      UPDATE de_work_items SET
        status = 'queued', scheduled_for = now(), attempts = 0, last_error = NULL,
        locked_at = NULL, locked_by = NULL, updated_at = now(),
        payload = payload || jsonb_build_object(
          'detail', left(coalesce(payload->>'detail','')
            || E'\n\nHUMAN RULING: your proposal for this task was APPROVED'
            || CASE WHEN v_instruction IS NOT NULL THEN '. Instruction: ' || v_instruction ELSE '' END
            || '. Approved proposal: "' || left(v_row.proposed_action, 400)
            || '". Carry it out now; do not raise this same exception again.', 4000),
          'human_ruling', jsonb_build_object('exception_id', p_exception_id,
            'decision', v_status, 'outcome', p_outcome, 'decided_at', now()))
      WHERE id = v_row.work_item_id AND tenant_id = v_tenant AND status = 'waiting_human'
      RETURNING id INTO v_item_moved;
    ELSE
      UPDATE de_work_items SET
        status = 'cancelled', locked_at = NULL, locked_by = NULL, updated_at = now(),
        result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
          'summary', left('Denied by human' || CASE WHEN v_instruction IS NOT NULL THEN ': ' || v_instruction ELSE '' END, 500),
          'human_ruling', jsonb_build_object('exception_id', p_exception_id,
            'decision', v_status, 'outcome', p_outcome, 'decided_at', now()))
      WHERE id = v_row.work_item_id AND tenant_id = v_tenant AND status = 'waiting_human'
      RETURNING id INTO v_item_moved;
      -- claim_de_work_items requires depends_on to be 'done'; a cancelled
      -- predecessor strands its successors as invisible-stuck 'queued' rows.
      IF v_item_moved IS NOT NULL THEN
        WITH RECURSIVE chain AS (
          SELECT w.id FROM de_work_items w
           WHERE w.depends_on = v_row.work_item_id AND w.tenant_id = v_tenant
             AND w.status IN ('queued','waiting_human')
          UNION ALL
          SELECT w2.id FROM de_work_items w2 JOIN chain c ON w2.depends_on = c.id
           WHERE w2.status IN ('queued','waiting_human')
        )
        UPDATE de_work_items w SET status = 'cancelled',
               last_error = 'predecessor denied by human ruling', updated_at = now()
          FROM chain WHERE w.id = chain.id;
      END IF;
    END IF;
  END IF;

  PERFORM append_audit_event(
    v_tenant, 'Workspace', 'human',
    format('%s exception %s — %s', coalesce(v_de_name, 'An employee'), v_status, left(v_row.situation, 120)),
    'approval',
    jsonb_build_object('exception_id', p_exception_id, 'de_id', v_row.de_id,
      'decision', v_status, 'learned', coalesce(p_learned, false),
      'memory_id', v_memory_id, 'work_item_id', v_row.work_item_id,
      'work_item_moved', v_item_moved IS NOT NULL));
  RETURN jsonb_build_object('ok', true, 'status', v_status,
    'memory_id', v_memory_id, 'work_item_id', v_row.work_item_id,
    'work_item_moved', v_item_moved IS NOT NULL);
END$function$
;

notify pgrst, 'reload schema';

do $a$
declare v_exc text; v_esc text;
begin
  v_exc := pg_get_functiondef('public.decide_de_exception(uuid,text,text,boolean)'::regprocedure);
  v_esc := pg_get_functiondef('public.decide_de_escalation(uuid,text,text,text)'::regprocedure);

  -- The blanket role gate must be gone from BOTH.
  if v_exc ilike '%auth_has_tenant_role%' then
    raise exception '503: decide_de_exception still gates on job title';
  end if;
  if v_esc ilike '%auth_has_tenant_role%' then
    raise exception '503: decide_de_escalation still gates on job title';
  end if;

  -- ...and a per-employee test must have taken its place, or this migration
  -- just removed a permission check.
  if v_exc not ilike '%can_access_de%' then
    raise exception '503: decide_de_exception has NO scope check at all — that is worse than the role gate';
  end if;
  if v_esc not ilike '%can_access_de%' then
    raise exception '503: decide_de_escalation has NO scope check at all';
  end if;

  -- The resume machinery must be intact: the whole point is that a decision
  -- still moves the work.
  if v_exc not ilike '%HUMAN RULING%' or v_exc not ilike '%waiting_human%' then
    raise exception '503: decide_de_exception lost its work-item resume';
  end if;
  if v_esc not ilike '%disposition%' then
    raise exception '503: decide_de_escalation lost its disposition recording';
  end if;

  raise notice '503: authority now follows assignment — a reporting-line manager can answer the employees they manage';
end $a$;
