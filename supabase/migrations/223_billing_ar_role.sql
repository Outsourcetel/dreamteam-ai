-- 223_billing_ar_role.sql
-- ============================================================================
-- MONEY ROLE 1 — Billing / AR, stood up on the deepened machinery (Connected
-- Systems desk + role kits + gated write-backs). The Billing & Invoicing DE
-- already exists (a shell); this gives it its real kit: the invoices ground,
-- a propose-only invoice write-back registry, an AR-sweep book of work, a
-- dunning SOP, and PERMANENT propose-only money guardrails.
--
-- Money rule (founder, permanent, no trust unlock): every write that touches
-- money — status changes, write-offs, credits — is destructive → always gated
-- for human approval. There is no trust tier that auto-executes them.
--
-- Watcher = a SCHEDULE sweep (existing kind, no run_work_watchers change) so
-- this lands safely without re-touching the shared watcher engine while credits
-- are out; a per-invoice due-date watcher is a documented follow-up.
-- GLOBAL. Proven at the DATA layer (registry + read + gate); autonomous loop
-- unverified until the Anthropic credit top-up.
-- ============================================================================

-- 1. Expand the connected-systems read whitelist to the finance tables --------
CREATE OR REPLACE FUNCTION public.read_de_system(p_de_id uuid, p_system_key text, p_entity_ref text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s de_connected_systems; v_tenant uuid; v_sql text; v_row jsonb;
  v_is_service boolean := coalesce(auth.role(),'') = 'service_role';
BEGIN
  SELECT tenant_id INTO v_tenant FROM digital_employees WHERE id = p_de_id;
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'de_not_found'); END IF;
  IF NOT v_is_service AND v_tenant IS DISTINCT FROM public.auth_tenant_id() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_tenant_member');
  END IF;

  SELECT * INTO s FROM de_connected_systems WHERE de_id = p_de_id AND system_key = p_system_key AND active;
  IF s.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'system_not_configured'); END IF;
  IF NOT s.can_read THEN RETURN jsonb_build_object('ok', false, 'error', 'read_not_allowed'); END IF;
  IF s.binding_kind <> 'internal_table' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'connector_read_pending_creds', 'system_key', p_system_key);
  END IF;
  IF NOT (s.source_table = ANY (ARRAY['customer_accounts','opportunities','account_activities','opportunity_activities','invoices','bills','payments','journal_entries'])) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unsupported_source_table');
  END IF;

  v_sql := format(
    'SELECT to_jsonb(t) - (SELECT coalesce(array_agg(k),ARRAY[]::text[]) FROM (SELECT key AS k FROM jsonb_each(to_jsonb(t)) WHERE key <> ALL (SELECT jsonb_array_elements_text($3))) x) FROM %I t WHERE t.%I = $1::uuid AND t.tenant_id = $2',
    s.source_table, s.id_column);
  EXECUTE v_sql INTO v_row USING p_entity_ref, v_tenant, s.read_fields;
  IF v_row IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'record_not_found'); END IF;
  RETURN jsonb_build_object('ok', true, 'system_key', p_system_key, 'record', v_row);
END; $$;

-- 2. Invoice write-back registry (propose-only money) ------------------------
CREATE TABLE IF NOT EXISTS invoice_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  de_id uuid REFERENCES digital_employees(id) ON DELETE SET NULL,
  objective_id uuid REFERENCES de_objectives(id) ON DELETE SET NULL,
  kind text NOT NULL, summary text NOT NULL, detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoice_activities_inv ON invoice_activities(invoice_id, created_at DESC);
ALTER TABLE invoice_activities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoice_activities_tenant_read ON invoice_activities;
CREATE POLICY invoice_activities_tenant_read ON invoice_activities FOR SELECT USING (tenant_id = public.auth_tenant_id());

CREATE TABLE IF NOT EXISTS invoice_writeback_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  de_id uuid REFERENCES digital_employees(id) ON DELETE SET NULL,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  objective_id uuid REFERENCES de_objectives(id) ON DELETE SET NULL,
  op text NOT NULL CHECK (op IN ('log_activity','set_next_step','update_status')),
  composed jsonb NOT NULL, request_summary text NOT NULL,
  status text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','auto_applied','applied','rejected','failed')),
  task_id uuid, result jsonb, created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz, applied_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_invoice_writeback_task ON invoice_writeback_requests(task_id) WHERE task_id IS NOT NULL;
ALTER TABLE invoice_writeback_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoice_writeback_tenant_read ON invoice_writeback_requests;
CREATE POLICY invoice_writeback_tenant_read ON invoice_writeback_requests FOR SELECT USING (tenant_id = public.auth_tenant_id());

CREATE OR REPLACE FUNCTION public.apply_invoice_writeback_internal(p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r invoice_writeback_requests; v_before text; v_act uuid;
BEGIN
  SELECT * INTO r FROM invoice_writeback_requests WHERE id = p_request_id;
  IF r.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF r.status NOT IN ('pending_approval') THEN RETURN jsonb_build_object('ok', false, 'error', 'not_pending', 'status', r.status); END IF;

  IF r.op = 'log_activity' THEN
    INSERT INTO invoice_activities (tenant_id, invoice_id, de_id, objective_id, kind, summary, detail)
    VALUES (r.tenant_id, r.invoice_id, r.de_id, r.objective_id, 'activity_logged', r.composed->>'summary',
            jsonb_build_object('activity_kind', r.composed->>'activity_kind')) RETURNING id INTO v_act;
  ELSIF r.op = 'set_next_step' THEN
    INSERT INTO invoice_activities (tenant_id, invoice_id, de_id, objective_id, kind, summary, detail)
    VALUES (r.tenant_id, r.invoice_id, r.de_id, r.objective_id, 'next_step_set',
            'Next step: ' || (r.composed->>'next_step'), r.composed) RETURNING id INTO v_act;
  ELSIF r.op = 'update_status' THEN
    SELECT status INTO v_before FROM invoices WHERE id = r.invoice_id AND tenant_id = r.tenant_id;
    UPDATE invoices SET status = r.composed->>'to_status' WHERE id = r.invoice_id AND tenant_id = r.tenant_id;
    INSERT INTO invoice_activities (tenant_id, invoice_id, de_id, objective_id, kind, summary, detail)
    VALUES (r.tenant_id, r.invoice_id, r.de_id, r.objective_id, 'status_changed',
            'Status ' || coalesce(v_before,'?') || ' → ' || (r.composed->>'to_status'),
            jsonb_build_object('from', v_before, 'to', r.composed->>'to_status')) RETURNING id INTO v_act;
  END IF;

  UPDATE invoice_writeback_requests SET status = 'applied', applied_at = now(), result = jsonb_build_object('activity_id', v_act) WHERE id = p_request_id;
  RETURN jsonb_build_object('ok', true, 'activity_id', v_act);
END; $$;

CREATE OR REPLACE FUNCTION public.propose_invoice_writeback(
  p_de_id uuid, p_objective_id uuid, p_invoice_id uuid, p_op text, p_params jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid; v_de_name text; v_inv text; v_destructive boolean; v_label text; v_composed jsonb; v_summary text;
  v_req uuid; v_task uuid; v_decision jsonb; v_is_service boolean := coalesce(auth.role(),'') = 'service_role';
BEGIN
  IF p_op NOT IN ('log_activity','set_next_step','update_status') THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_op'); END IF;
  SELECT tenant_id, coalesce(persona_name, name) INTO v_tenant, v_de_name FROM digital_employees WHERE id = p_de_id;
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'de_not_found'); END IF;
  IF NOT v_is_service AND v_tenant IS DISTINCT FROM public.auth_tenant_id() THEN RETURN jsonb_build_object('ok', false, 'error', 'not_tenant_member'); END IF;
  SELECT invoice_number INTO v_inv FROM invoices WHERE id = p_invoice_id AND tenant_id = v_tenant;
  IF v_inv IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'invoice_not_in_tenant'); END IF;

  IF p_op = 'log_activity' THEN
    IF coalesce(p_params->>'summary','') = '' THEN RETURN jsonb_build_object('ok', false, 'error', 'summary_required'); END IF;
    v_destructive := false;
    v_composed := jsonb_build_object('summary', left(p_params->>'summary', 2000), 'activity_kind', coalesce(nullif(left(p_params->>'activity_kind',40),''),'collection_note'));
    v_label := 'Log a collection activity'; v_summary := 'Log activity on invoice ' || v_inv || ': ' || left(p_params->>'summary', 120);
  ELSIF p_op = 'set_next_step' THEN
    IF coalesce(p_params->>'next_step','') = '' THEN RETURN jsonb_build_object('ok', false, 'error', 'next_step_required'); END IF;
    v_destructive := false;
    v_composed := jsonb_build_object('next_step', left(p_params->>'next_step', 500), 'next_step_date', nullif(p_params->>'next_step_date',''));
    v_label := 'Set the next step'; v_summary := 'Set next step on invoice ' || v_inv || ': ' || left(p_params->>'next_step', 120);
  ELSIF p_op = 'update_status' THEN
    -- Anti-hallucination + money floor: closed enum, and ANY status change on an
    -- invoice is destructive → always human-gated (never auto-executes).
    IF NOT (p_params->>'to_status' IN ('open','paid','partial','overdue','void')) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_status', 'detail', 'to_status must be one of: open, paid, partial, overdue, void');
    END IF;
    v_destructive := true;
    v_composed := jsonb_build_object('to_status', p_params->>'to_status');
    v_label := 'Change invoice status'; v_summary := 'Move invoice ' || v_inv || ' to status "' || (p_params->>'to_status') || '"';
  END IF;

  SELECT public.decide_action_execution(v_tenant, v_label, 'billing', v_destructive, p_de_id) INTO v_decision;

  INSERT INTO invoice_writeback_requests (tenant_id, de_id, invoice_id, objective_id, op, composed, request_summary, status, created_by)
  VALUES (v_tenant, p_de_id, p_invoice_id, p_objective_id, p_op, v_composed, v_summary, 'pending_approval', auth.uid())
  RETURNING id INTO v_req;

  IF (v_decision->>'decision') = 'auto_executed' THEN
    PERFORM public.apply_invoice_writeback_internal(v_req);
    UPDATE invoice_writeback_requests SET status = 'auto_applied', decided_at = now() WHERE id = v_req AND status = 'applied';
    RETURN jsonb_build_object('ok', true, 'gated', false, 'applied', true, 'request_id', v_req);
  END IF;

  INSERT INTO human_tasks (tenant_id, type, title, detail, source, related_table, related_id, status)
  VALUES (v_tenant, 'action_approval', 'Approve invoice write-back — ' || v_label || ' (' || v_inv || ')',
          (v_decision->>'reasoning') || ' Preview: ' || v_summary, 'de', 'invoice_writeback_requests', v_req, 'pending')
  RETURNING id INTO v_task;
  UPDATE invoice_writeback_requests SET task_id = v_task WHERE id = v_req;
  RETURN jsonb_build_object('ok', true, 'gated', true, 'task_id', v_task, 'request_id', v_req, 'reasoning', v_decision->>'reasoning');
END; $$;

CREATE OR REPLACE FUNCTION public.resolve_invoice_writeback(p_task_id uuid, p_decision text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r invoice_writeback_requests;
BEGIN
  SELECT * INTO r FROM invoice_writeback_requests WHERE task_id = p_task_id;
  IF r.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_request_for_task'); END IF;
  IF r.status <> 'pending_approval' THEN RETURN jsonb_build_object('ok', true, 'already', r.status); END IF;
  IF p_decision = 'approved' THEN
    PERFORM public.apply_invoice_writeback_internal(r.id);
    UPDATE invoice_writeback_requests SET decided_at = now() WHERE id = r.id;
    RETURN jsonb_build_object('ok', true, 'applied', true);
  ELSE
    UPDATE invoice_writeback_requests SET status = 'rejected', decided_at = now() WHERE id = r.id;
    RETURN jsonb_build_object('ok', true, 'applied', false);
  END IF;
END; $$;

REVOKE ALL ON FUNCTION public.propose_invoice_writeback(uuid,uuid,uuid,text,jsonb) FROM public, anon;
REVOKE ALL ON FUNCTION public.apply_invoice_writeback_internal(uuid) FROM public, anon;
REVOKE ALL ON FUNCTION public.resolve_invoice_writeback(uuid,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.propose_invoice_writeback(uuid,uuid,uuid,text,jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_invoice_writeback(uuid,text) TO authenticated, service_role;

-- 3. Route 'invoice' writes through the generic dispatcher -------------------
CREATE OR REPLACE FUNCTION public.propose_system_writeback(
  p_de_id uuid, p_system_key text, p_entity_ref text, p_op text,
  p_params jsonb DEFAULT '{}'::jsonb, p_objective_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s de_connected_systems; v_tenant uuid; v_is_service boolean := coalesce(auth.role(),'') = 'service_role';
BEGIN
  SELECT tenant_id INTO v_tenant FROM digital_employees WHERE id = p_de_id;
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'de_not_found'); END IF;
  IF NOT v_is_service AND v_tenant IS DISTINCT FROM public.auth_tenant_id() THEN RETURN jsonb_build_object('ok', false, 'error', 'not_tenant_member'); END IF;
  SELECT * INTO s FROM de_connected_systems WHERE de_id = p_de_id AND system_key = p_system_key AND active;
  IF s.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'system_not_configured'); END IF;
  IF NOT s.can_write THEN RETURN jsonb_build_object('ok', false, 'error', 'write_not_allowed'); END IF;

  IF s.write_registry = 'account' THEN
    RETURN public.propose_account_writeback(p_de_id, p_objective_id, p_entity_ref::uuid, p_op, p_params);
  ELSIF s.write_registry = 'opportunity' THEN
    RETURN public.propose_opportunity_writeback(p_de_id, p_objective_id, p_entity_ref::uuid, p_op, p_params);
  ELSIF s.write_registry = 'invoice' THEN
    RETURN public.propose_invoice_writeback(p_de_id, p_objective_id, p_entity_ref::uuid, p_op, p_params);
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'write_registry_not_supported', 'write_registry', s.write_registry);
  END IF;
END; $$;

-- 4. Billing/AR archetype kit + install on the Billing & Invoicing DE ---------
INSERT INTO role_archetypes
  (key, name, domain, description, persona_preamble, responsibilities,
   required_capabilities, required_connector_categories, recommended_model,
   compliance_pack_keys, knowledge_scaffold, eval_category, pass_threshold_pct, status,
   sop_playbook, watcher_templates, guardrail_templates, system_templates)
VALUES (
  'billing_ar', 'Billing & AR Specialist', 'Finance Operations',
  'Works accounts receivable: sweeps for overdue invoices, runs the dunning motion, keeps the invoice record current, and proposes status changes and outreach for human approval. Never moves money on its own.',
  'You are a billing and collections specialist. You keep receivables current and get invoices paid — grounded in the invoice record, disciplined about follow-ups, and ALWAYS proposing anything that touches money (status changes, write-offs, credits) to a human. You never commit to payment terms or waive an amount yourself.',
  ARRAY['Sweep for overdue and approaching-due invoices','Run the dunning / collections motion','Keep the invoice record current with activities and next steps','Propose status changes and customer outreach for human approval','Escalate disputes and large balances'],
  ARRAY['accounts_receivable','communication','write_back'],
  ARRAY['erp_financials'],
  'claude-sonnet-5',
  ARRAY[]::text[],
  '{"topics":["Your dunning cadence and grace periods","How write-offs and credits get approved","Your invoice status meanings"]}'::jsonb,
  'procedure', 80, 'active',
  jsonb_build_object(
    'name','Billing / AR SOP',
    'description','Standard operating procedure for working overdue receivables from sweep through resolution.',
    'steps', jsonb_build_array(
      jsonb_build_object('key','instruction','label','Sweep the receivables','params',jsonb_build_object('body_md','Read your invoices system and identify what needs attention: invoices past due, approaching due, or with an outstanding balance (amount minus amount paid). Prioritise by balance and days overdue. Never assume an amount or a payment you cannot see on the record.')),
      jsonb_build_object('key','instruction','label','Assess each invoice','params',jsonb_build_object('body_md','For each invoice needing action, read its current status, amount, amount paid, due date, and recent collection activity. Judge where it is in the dunning cycle (first reminder, second, final notice, dispute, escalation).')),
      jsonb_build_object('key','checklist','label','Run the dunning motion','params',jsonb_build_object('items', jsonb_build_array('Log the current collection status as an activity on the invoice','Set the next step with a date (when to follow up)','Prepare the appropriate reminder as a draft for human approval — do not send email yourself','If a status change is warranted (e.g. mark overdue), propose it for human approval','If the balance is large or the invoice is disputed, escalate to a human'))),
      jsonb_build_object('key','instruction','label','Stay within your authority (money = propose-only)','params',jsonb_build_object('body_md','You may log activity and set next steps freely. Any change that touches money — invoice status, write-offs, credits, adjustments — is ALWAYS proposed for human approval and never applied by you. You may NOT commit to payment plans, discounts, or waivers, or promise to write off a balance. Never invent amounts or payment facts.')),
      jsonb_build_object('key','instruction','label','Close the loop and verify','params',jsonb_build_object('body_md','A collection step is not done until the invoice record reflects it. Write back the activity and next step, and after a human approves a status change, verify the invoice now shows the intended status before considering it resolved.'))
    )
  ),
  jsonb_build_array(
    jsonb_build_object('kind','schedule','label','Daily AR sweep','description','Wake daily to sweep receivables for overdue and approaching-due invoices.','config',jsonb_build_object('interval_minutes',1440))
  ),
  jsonb_build_array(
    jsonb_build_object('rule','No write-offs, credits, or adjustments without approval','rule_type','max_discount_pct','threshold','0','severity','blocking'),
    jsonb_build_object('rule','No payment-term, waiver, or write-off commitments in writing','rule_type','blocked_phrase','pattern','write off|waive the|forgive the balance|payment plan|we can reduce|clear the balance|no need to pay|discount the invoice|settle for','severity','blocking'),
    jsonb_build_object('rule','Any receivable action over $10,000 requires human approval','rule_type','require_approval_over_cents','threshold','1000000','severity','blocking')
  ),
  jsonb_build_array(
    jsonb_build_object('system_key','invoices','label','Invoices (AR)','source_table','invoices',
      'read_fields', jsonb_build_array('invoice_number','amount','amount_paid','status','due_date','currency','customer_id'),
      'write_registry','invoice','can_read',true,'can_write',true,'can_verify',true)
  )
)
ON CONFLICT (key) DO UPDATE SET
  sop_playbook = excluded.sop_playbook, watcher_templates = excluded.watcher_templates,
  guardrail_templates = excluded.guardrail_templates, system_templates = excluded.system_templates,
  persona_preamble = excluded.persona_preamble, responsibilities = excluded.responsibilities, status = 'active';

SELECT public.install_role_kit(d.id, 'billing_ar'), public.install_role_systems(d.id, 'billing_ar')
FROM digital_employees d
WHERE d.tenant_id = (SELECT id FROM tenants WHERE slug = 'outsourcetel-hq') AND d.name ILIKE '%billing%';
