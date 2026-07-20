-- 215_account_writeback_registry.sql
-- ============================================================================
-- EXEC Phase 0.3 — the write-back registry (Scribe pattern, generalized).
--
-- "The job isn't done until the system of record reflects it." A human doesn't
-- finish a renewal call and walk away — they log the activity, move the
-- opportunity stage, and set the next step IN THE CRM. This gives DEs that same
-- close-the-loop write-back, on the exact safety pattern the Zendesk Scribe uses:
--
--   • WHITELISTED ops (a closed set), never free-form writes.
--   • SERVER-COMPOSED payloads, FROZEN at propose time — the caller supplies
--     structured params, not the final write; the destructive part (a status
--     change) is a closed enum, so a DE can never invent a value.
--   • GATED through the PROVEN decide_action_execution composition
--     (destructive-always-gates → guardrail-always-wins → trust-narrows). A
--     destructive write is never applied without a human approving it.
--   • GROUNDED (linked to the case/objective it came from) and AUDITED.
--
-- v1 target is the INTERNAL system of record (customer_accounts + a real
-- account activity timeline). The SAME propose→gate→apply path swaps its apply
-- step to an external CRM/billing connector once creds are attached — the DE and
-- the gate don't change.
-- GLOBAL — every tenant.
-- ============================================================================

-- ── The activity timeline — a real system-of-record write target ────────────
CREATE TABLE IF NOT EXISTS account_activities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id    uuid NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  de_id         uuid REFERENCES digital_employees(id) ON DELETE SET NULL,
  objective_id  uuid REFERENCES de_objectives(id) ON DELETE SET NULL,  -- the case it came from
  kind          text NOT NULL,          -- activity_logged | stage_changed | next_step_set
  summary       text NOT NULL,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_account_activities_acct ON account_activities(account_id, created_at DESC);
ALTER TABLE account_activities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_activities_tenant_read ON account_activities;
CREATE POLICY account_activities_tenant_read ON account_activities
  FOR SELECT USING (tenant_id = public.auth_tenant_id());

-- ── The frozen pending write — composed at propose, applied on approve ──────
CREATE TABLE IF NOT EXISTS account_writeback_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  de_id           uuid REFERENCES digital_employees(id) ON DELETE SET NULL,
  account_id      uuid NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  objective_id    uuid REFERENCES de_objectives(id) ON DELETE SET NULL,
  op              text NOT NULL CHECK (op IN ('log_activity','set_next_step','update_status')),
  composed        jsonb NOT NULL,         -- the exact server-built write (frozen)
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
CREATE INDEX IF NOT EXISTS idx_account_writeback_task ON account_writeback_requests(task_id) WHERE task_id IS NOT NULL;
ALTER TABLE account_writeback_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_writeback_tenant_read ON account_writeback_requests;
CREATE POLICY account_writeback_tenant_read ON account_writeback_requests
  FOR SELECT USING (tenant_id = public.auth_tenant_id());

-- ── Apply a frozen write (internal SoR) — the only place account state moves ─
-- Never trusts caller free text: it reads the FROZEN composed payload and, for
-- the destructive op, the status is a value already validated at compose time.
CREATE OR REPLACE FUNCTION public.apply_account_writeback_internal(p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r account_writeback_requests; v_before text; v_act uuid;
BEGIN
  SELECT * INTO r FROM account_writeback_requests WHERE id = p_request_id;
  IF r.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF r.status NOT IN ('pending_approval') THEN RETURN jsonb_build_object('ok', false, 'error', 'not_pending', 'status', r.status); END IF;

  IF r.op = 'log_activity' THEN
    INSERT INTO account_activities (tenant_id, account_id, de_id, objective_id, kind, summary, detail)
    VALUES (r.tenant_id, r.account_id, r.de_id, r.objective_id, 'activity_logged', r.composed->>'summary',
            jsonb_build_object('activity_kind', r.composed->>'activity_kind'))
    RETURNING id INTO v_act;

  ELSIF r.op = 'set_next_step' THEN
    UPDATE customer_accounts
       SET attributes = coalesce(attributes,'{}'::jsonb)
             || jsonb_build_object('next_step', r.composed->>'next_step', 'next_step_date', r.composed->>'next_step_date'),
           updated_at = now()
     WHERE id = r.account_id AND tenant_id = r.tenant_id;
    INSERT INTO account_activities (tenant_id, account_id, de_id, objective_id, kind, summary, detail)
    VALUES (r.tenant_id, r.account_id, r.de_id, r.objective_id, 'next_step_set',
            'Next step: ' || (r.composed->>'next_step'), r.composed) RETURNING id INTO v_act;

  ELSIF r.op = 'update_status' THEN
    SELECT status INTO v_before FROM customer_accounts WHERE id = r.account_id AND tenant_id = r.tenant_id;
    UPDATE customer_accounts SET status = r.composed->>'to_status', updated_at = now()
     WHERE id = r.account_id AND tenant_id = r.tenant_id;
    INSERT INTO account_activities (tenant_id, account_id, de_id, objective_id, kind, summary, detail)
    VALUES (r.tenant_id, r.account_id, r.de_id, r.objective_id, 'stage_changed',
            'Status ' || coalesce(v_before,'?') || ' → ' || (r.composed->>'to_status'),
            jsonb_build_object('from', v_before, 'to', r.composed->>'to_status')) RETURNING id INTO v_act;
  END IF;

  UPDATE account_writeback_requests
     SET status = 'applied', applied_at = now(), result = jsonb_build_object('activity_id', v_act)
   WHERE id = p_request_id;
  RETURN jsonb_build_object('ok', true, 'activity_id', v_act);
END; $$;

-- ── Propose a write-back — compose, gate, auto-apply or route for approval ───
CREATE OR REPLACE FUNCTION public.propose_account_writeback(
  p_de_id uuid, p_objective_id uuid, p_account_id uuid, p_op text, p_params jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid; v_de_tenant uuid; v_acct_name text; v_de_name text;
  v_destructive boolean; v_label text; v_composed jsonb; v_summary text;
  v_status text; v_req uuid; v_task uuid; v_decision jsonb;
  v_is_service boolean := coalesce(auth.role(),'') = 'service_role';
BEGIN
  IF p_op NOT IN ('log_activity','set_next_step','update_status') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_op');
  END IF;

  SELECT tenant_id, coalesce(persona_name, name) INTO v_de_tenant, v_de_name FROM digital_employees WHERE id = p_de_id;
  IF v_de_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'de_not_found'); END IF;
  v_tenant := v_de_tenant;
  IF NOT v_is_service AND v_tenant IS DISTINCT FROM public.auth_tenant_id() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_tenant_member');
  END IF;

  SELECT name INTO v_acct_name FROM customer_accounts WHERE id = p_account_id AND tenant_id = v_tenant;
  IF v_acct_name IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'account_not_in_tenant'); END IF;

  -- ── SERVER-COMPOSE the frozen write + destructive flag (the whitelist). ──
  IF p_op = 'log_activity' THEN
    IF coalesce(p_params->>'summary','') = '' THEN RETURN jsonb_build_object('ok', false, 'error', 'summary_required'); END IF;
    v_destructive := false;
    v_composed := jsonb_build_object('summary', left(p_params->>'summary', 2000), 'activity_kind', coalesce(nullif(left(p_params->>'activity_kind',40),''),'note'));
    v_label := 'Log an activity'; v_summary := 'Log activity on ' || v_acct_name || ': ' || left(p_params->>'summary', 120);

  ELSIF p_op = 'set_next_step' THEN
    IF coalesce(p_params->>'next_step','') = '' THEN RETURN jsonb_build_object('ok', false, 'error', 'next_step_required'); END IF;
    v_destructive := false;
    v_composed := jsonb_build_object('next_step', left(p_params->>'next_step', 500), 'next_step_date', nullif(p_params->>'next_step_date',''));
    v_label := 'Set the next step'; v_summary := 'Set next step on ' || v_acct_name || ': ' || left(p_params->>'next_step', 120);

  ELSIF p_op = 'update_status' THEN
    -- CLOSED ENUM — the anti-hallucination guarantee. A DE can only move the
    -- account to a real status, never invent one.
    IF NOT (p_params->>'to_status' IN ('active','at_risk','churned')) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_status', 'detail', 'to_status must be one of: active, at_risk, churned');
    END IF;
    v_destructive := true;
    v_composed := jsonb_build_object('to_status', p_params->>'to_status');
    v_label := 'Change account status'; v_summary := 'Change ' || v_acct_name || ' status to "' || (p_params->>'to_status') || '"';
  END IF;

  -- ── THE GATE — destructive-always-gates → guardrail → trust (proven). ──
  SELECT public.decide_action_execution(v_tenant, v_label, 'crm', v_destructive, p_de_id) INTO v_decision;

  INSERT INTO account_writeback_requests (tenant_id, de_id, account_id, objective_id, op, composed, request_summary, status, created_by)
  VALUES (v_tenant, p_de_id, p_account_id, p_objective_id, p_op, v_composed, v_summary, 'pending_approval', auth.uid())
  RETURNING id INTO v_req;

  IF (v_decision->>'decision') = 'auto_executed' THEN
    PERFORM public.apply_account_writeback_internal(v_req);
    UPDATE account_writeback_requests SET status = 'auto_applied', decided_at = now() WHERE id = v_req AND status = 'applied';
    BEGIN PERFORM append_audit_event_internal(v_tenant, v_de_name, 'de',
      'Write-back APPLIED — ' || v_summary, 'connector_action',
      jsonb_build_object('kind','account_writeback','op',p_op,'request_id',v_req,'account_id',p_account_id,'objective_id',p_objective_id,'auto',true));
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN jsonb_build_object('ok', true, 'gated', false, 'applied', true, 'request_id', v_req);
  END IF;

  -- Gated — freeze it and route for human approval (decideHumanTask resolves).
  INSERT INTO human_tasks (tenant_id, type, title, detail, source, related_table, related_id, account_id, status)
  VALUES (v_tenant, 'action_approval', 'Approve write-back — ' || v_label || ' (' || v_acct_name || ')',
          (v_decision->>'reasoning') || ' Preview: ' || v_summary, 'de',
          'account_writeback_requests', v_req, p_account_id, 'pending')
  RETURNING id INTO v_task;
  UPDATE account_writeback_requests SET task_id = v_task WHERE id = v_req;

  BEGIN PERFORM append_audit_event_internal(v_tenant, v_de_name, 'de',
    'Write-back GATED — ' || v_summary || ': ' || (v_decision->>'reasoning'), 'approval',
    jsonb_build_object('kind','account_writeback_gated','op',p_op,'request_id',v_req,'task_id',v_task,'decision',v_decision->>'decision'));
  EXCEPTION WHEN OTHERS THEN NULL; END;

  RETURN jsonb_build_object('ok', true, 'gated', true, 'task_id', v_task, 'request_id', v_req, 'reasoning', v_decision->>'reasoning');
END; $$;

-- ── Resolve on human decision — hook target for decideHumanTask ─────────────
CREATE OR REPLACE FUNCTION public.resolve_account_writeback(p_task_id uuid, p_decision text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r account_writeback_requests; v_res jsonb;
BEGIN
  SELECT * INTO r FROM account_writeback_requests WHERE task_id = p_task_id;
  IF r.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_request_for_task'); END IF;
  IF r.status <> 'pending_approval' THEN RETURN jsonb_build_object('ok', true, 'already', r.status); END IF;

  IF p_decision = 'approved' THEN
    v_res := public.apply_account_writeback_internal(r.id);
    UPDATE account_writeback_requests SET decided_at = now() WHERE id = r.id;
    BEGIN PERFORM append_audit_event_internal(r.tenant_id, 'You', 'human',
      'Write-back APPROVED + applied — ' || r.request_summary, 'connector_action',
      jsonb_build_object('kind','account_writeback','op',r.op,'request_id',r.id,'approved',true));
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN jsonb_build_object('ok', true, 'applied', true);
  ELSE
    UPDATE account_writeback_requests SET status = 'rejected', decided_at = now() WHERE id = r.id;
    RETURN jsonb_build_object('ok', true, 'applied', false);
  END IF;
END; $$;

REVOKE ALL ON FUNCTION public.propose_account_writeback(uuid,uuid,uuid,text,jsonb) FROM public;
REVOKE ALL ON FUNCTION public.apply_account_writeback_internal(uuid) FROM public;
REVOKE ALL ON FUNCTION public.resolve_account_writeback(uuid,text) FROM public;
GRANT EXECUTE ON FUNCTION public.propose_account_writeback(uuid,uuid,uuid,text,jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_account_writeback(uuid,text) TO authenticated, service_role;
-- apply_* is internal-only (called by propose/resolve); no direct grant.
