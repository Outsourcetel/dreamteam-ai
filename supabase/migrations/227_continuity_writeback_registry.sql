-- 227_continuity_writeback_registry.sql
-- ============================================================================
-- EXEC-2c (part 3) — the continuity case's own gated write-back registry.
--
-- Mig 226 opens a continuity_cases facet with a motion. This lets that case be
-- WORKED to completion the same proven way the account/opportunity desks close
-- their loop (migs 215/220), but keyed on the CASE itself (objective_id):
--
--   • WHITELISTED ops: log_activity | set_next_step | advance_stage.
--   • SERVER-COMPOSED + FROZEN payloads (the caller supplies params, not the
--     final write); advance_stage's target must be a REAL configured stage.
--   • GATED through the proven decide_action_execution composition
--     (destructive-always-gates → guardrail-always-wins → trust-narrows). A
--     stage change is destructive → never applied without a human approving it.
--   • GROUNDED (linked to the objective/case) and AUDITED, and every transition
--     lands in continuity_case_events (the case timeline / stage history).
--
-- Fully additive and ISOLATED: new tables + three functions that mirror the
-- account registry. No existing table, function, or desk is modified. GLOBAL.
-- ============================================================================

-- next_step lives on the case facet (mirrors customer_accounts.attributes.next_step)
ALTER TABLE continuity_cases
  ADD COLUMN IF NOT EXISTS next_step      text,
  ADD COLUMN IF NOT EXISTS next_step_date date;

-- ── The frozen pending write — composed at propose, applied on approve ──────
CREATE TABLE IF NOT EXISTS continuity_writeback_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  de_id           uuid REFERENCES digital_employees(id) ON DELETE SET NULL,
  objective_id    uuid NOT NULL REFERENCES de_objectives(id) ON DELETE CASCADE,
  op              text NOT NULL CHECK (op IN ('log_activity','set_next_step','advance_stage')),
  composed        jsonb NOT NULL,
  request_summary text NOT NULL,
  status          text NOT NULL DEFAULT 'pending_approval'
                    CHECK (status IN ('pending_approval','auto_applied','applied','rejected','failed')),
  task_id         uuid,
  result          jsonb,
  created_by      uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz,
  applied_at      timestamptz
);
CREATE INDEX IF NOT EXISTS idx_continuity_writeback_task ON continuity_writeback_requests(task_id) WHERE task_id IS NOT NULL;
ALTER TABLE continuity_writeback_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS continuity_writeback_tenant_read ON continuity_writeback_requests;
CREATE POLICY continuity_writeback_tenant_read ON continuity_writeback_requests
  FOR SELECT USING (tenant_id = public.auth_tenant_id());

-- ── Apply a frozen write (internal SoR) — the only place a case's state moves ─
CREATE OR REPLACE FUNCTION public.apply_continuity_writeback_internal(p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r continuity_writeback_requests; c continuity_cases;
  v_before text; v_actor text; v_terminal boolean; v_category text;
BEGIN
  SELECT * INTO r FROM continuity_writeback_requests WHERE id = p_request_id;
  IF r.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF r.status NOT IN ('pending_approval') THEN RETURN jsonb_build_object('ok', false, 'error', 'not_pending', 'status', r.status); END IF;
  SELECT * INTO c FROM continuity_cases WHERE objective_id = r.objective_id;
  IF c.objective_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'case_not_found'); END IF;
  v_actor := CASE WHEN r.de_id IS NOT NULL THEN 'de' ELSE 'human' END;

  IF r.op = 'log_activity' THEN
    INSERT INTO continuity_case_events (tenant_id, objective_id, motion, actor_kind, summary, detail)
    VALUES (r.tenant_id, r.objective_id, c.motion, v_actor, r.composed->>'summary',
            jsonb_build_object('activity_kind', r.composed->>'activity_kind'));

  ELSIF r.op = 'set_next_step' THEN
    UPDATE continuity_cases
       SET next_step = r.composed->>'next_step',
           next_step_date = nullif(r.composed->>'next_step_date','')::date,
           updated_at = now()
     WHERE objective_id = r.objective_id;
    INSERT INTO continuity_case_events (tenant_id, objective_id, motion, actor_kind, summary, detail)
    VALUES (r.tenant_id, r.objective_id, c.motion, v_actor, 'Next step: ' || (r.composed->>'next_step'), r.composed);

  ELSIF r.op = 'advance_stage' THEN
    v_before := c.stage_key;
    SELECT is_terminal, category INTO v_terminal, v_category
      FROM continuity_stage_config WHERE tenant_id = r.tenant_id AND stage_key = r.composed->>'to_stage';
    UPDATE continuity_cases
       SET stage_key = r.composed->>'to_stage',
           outcome = CASE WHEN coalesce(v_terminal,false) THEN v_category ELSE outcome END,
           updated_at = now()
     WHERE objective_id = r.objective_id;
    INSERT INTO continuity_case_events (tenant_id, objective_id, from_stage, to_stage, motion, actor_kind, summary, detail)
    VALUES (r.tenant_id, r.objective_id, v_before, r.composed->>'to_stage', c.motion, v_actor,
            'Stage ' || coalesce(v_before,'?') || ' → ' || (r.composed->>'to_stage'),
            jsonb_build_object('from', v_before, 'to', r.composed->>'to_stage', 'terminal', coalesce(v_terminal,false)));
  END IF;

  UPDATE continuity_writeback_requests SET status = 'applied', applied_at = now(), result = jsonb_build_object('op', r.op) WHERE id = p_request_id;
  RETURN jsonb_build_object('ok', true, 'op', r.op);
END; $$;

-- ── Propose a write-back — compose, gate, auto-apply or route for approval ───
CREATE OR REPLACE FUNCTION public.propose_continuity_writeback(
  p_de_id uuid, p_objective_id uuid, p_op text, p_params jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid; v_de_name text; c continuity_cases; v_case_name text;
  v_destructive boolean; v_label text; v_composed jsonb; v_summary text;
  v_req uuid; v_task uuid; v_decision jsonb;
  v_is_service boolean := coalesce(auth.role(),'') = 'service_role';
BEGIN
  IF p_op NOT IN ('log_activity','set_next_step','advance_stage') THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_op'); END IF;

  SELECT tenant_id, coalesce(persona_name, name) INTO v_tenant, v_de_name FROM digital_employees WHERE id = p_de_id;
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'de_not_found'); END IF;
  IF NOT v_is_service AND v_tenant IS DISTINCT FROM public.auth_tenant_id() THEN RETURN jsonb_build_object('ok', false, 'error', 'not_tenant_member'); END IF;

  SELECT * INTO c FROM continuity_cases WHERE objective_id = p_objective_id AND tenant_id = v_tenant;
  IF c.objective_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_a_continuity_case'); END IF;
  SELECT coalesce(o.title, 'case') INTO v_case_name FROM de_objectives o WHERE o.id = p_objective_id;

  IF p_op = 'log_activity' THEN
    IF coalesce(p_params->>'summary','') = '' THEN RETURN jsonb_build_object('ok', false, 'error', 'summary_required'); END IF;
    v_destructive := false;
    v_composed := jsonb_build_object('summary', left(p_params->>'summary', 2000), 'activity_kind', coalesce(nullif(left(p_params->>'activity_kind',40),''),'note'));
    v_label := 'Log a continuity activity'; v_summary := 'Log activity on ' || v_case_name || ': ' || left(p_params->>'summary', 120);

  ELSIF p_op = 'set_next_step' THEN
    IF coalesce(p_params->>'next_step','') = '' THEN RETURN jsonb_build_object('ok', false, 'error', 'next_step_required'); END IF;
    v_destructive := false;
    v_composed := jsonb_build_object('next_step', left(p_params->>'next_step', 500), 'next_step_date', nullif(p_params->>'next_step_date',''));
    v_label := 'Set the next step'; v_summary := 'Set next step on ' || v_case_name || ': ' || left(p_params->>'next_step', 120);

  ELSIF p_op = 'advance_stage' THEN
    -- Anti-hallucination: the target must be a REAL configured stage for this tenant.
    IF NOT EXISTS (SELECT 1 FROM continuity_stage_config s WHERE s.tenant_id = v_tenant AND s.stage_key = p_params->>'to_stage' AND s.active) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_stage', 'detail', 'to_stage must be an active configured continuity stage_key');
    END IF;
    v_destructive := true;
    v_composed := jsonb_build_object('to_stage', p_params->>'to_stage');
    v_label := 'Advance the case stage'; v_summary := 'Advance ' || v_case_name || ' to stage "' || (p_params->>'to_stage') || '"';
  END IF;

  -- ── THE GATE — same proven composition as every other desk. ──
  SELECT public.decide_action_execution(v_tenant, v_label, 'crm', v_destructive, p_de_id) INTO v_decision;

  INSERT INTO continuity_writeback_requests (tenant_id, de_id, objective_id, op, composed, request_summary, status, created_by)
  VALUES (v_tenant, p_de_id, p_objective_id, p_op, v_composed, v_summary, 'pending_approval', auth.uid())
  RETURNING id INTO v_req;

  IF (v_decision->>'decision') = 'auto_executed' THEN
    PERFORM public.apply_continuity_writeback_internal(v_req);
    UPDATE continuity_writeback_requests SET status = 'auto_applied', decided_at = now() WHERE id = v_req AND status = 'applied';
    BEGIN PERFORM append_audit_event_internal(v_tenant, v_de_name, 'de', 'Continuity write-back APPLIED — ' || v_summary, 'connector_action',
      jsonb_build_object('kind','continuity_writeback','op',p_op,'request_id',v_req,'objective_id',p_objective_id,'auto',true));
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN jsonb_build_object('ok', true, 'gated', false, 'applied', true, 'request_id', v_req);
  END IF;

  INSERT INTO human_tasks (tenant_id, type, title, detail, source, related_table, related_id, status)
  VALUES (v_tenant, 'action_approval', 'Approve continuity write-back — ' || v_label || ' (' || v_case_name || ')',
          (v_decision->>'reasoning') || ' Preview: ' || v_summary, 'de', 'continuity_writeback_requests', v_req, 'pending')
  RETURNING id INTO v_task;
  UPDATE continuity_writeback_requests SET task_id = v_task WHERE id = v_req;

  BEGIN PERFORM append_audit_event_internal(v_tenant, v_de_name, 'de', 'Continuity write-back GATED — ' || v_summary || ': ' || (v_decision->>'reasoning'), 'approval',
    jsonb_build_object('kind','continuity_writeback_gated','op',p_op,'request_id',v_req,'task_id',v_task,'decision',v_decision->>'decision'));
  EXCEPTION WHEN OTHERS THEN NULL; END;

  RETURN jsonb_build_object('ok', true, 'gated', true, 'task_id', v_task, 'request_id', v_req, 'reasoning', v_decision->>'reasoning');
END; $$;

-- ── Resolve on human decision — hook target for decideHumanTask ─────────────
CREATE OR REPLACE FUNCTION public.resolve_continuity_writeback(p_task_id uuid, p_decision text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r continuity_writeback_requests; v_res jsonb;
BEGIN
  SELECT * INTO r FROM continuity_writeback_requests WHERE task_id = p_task_id;
  IF r.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_request_for_task'); END IF;
  IF r.status <> 'pending_approval' THEN RETURN jsonb_build_object('ok', true, 'already', r.status); END IF;
  IF p_decision = 'approved' THEN
    v_res := public.apply_continuity_writeback_internal(r.id);
    UPDATE continuity_writeback_requests SET decided_at = now() WHERE id = r.id;
    BEGIN PERFORM append_audit_event_internal(r.tenant_id, 'You', 'human', 'Continuity write-back APPROVED + applied — ' || r.request_summary, 'connector_action',
      jsonb_build_object('kind','continuity_writeback','op',r.op,'request_id',r.id,'approved',true));
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN jsonb_build_object('ok', true, 'applied', true);
  ELSE
    UPDATE continuity_writeback_requests SET status = 'rejected', decided_at = now() WHERE id = r.id;
    RETURN jsonb_build_object('ok', true, 'applied', false);
  END IF;
END; $$;

REVOKE ALL ON FUNCTION public.propose_continuity_writeback(uuid,uuid,text,jsonb) FROM public;
REVOKE ALL ON FUNCTION public.apply_continuity_writeback_internal(uuid) FROM public;
REVOKE ALL ON FUNCTION public.resolve_continuity_writeback(uuid,text) FROM public;
GRANT EXECUTE ON FUNCTION public.propose_continuity_writeback(uuid,uuid,text,jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_continuity_writeback(uuid,text) TO authenticated, service_role;
-- apply_* is internal-only (called by propose/resolve); no direct grant.
