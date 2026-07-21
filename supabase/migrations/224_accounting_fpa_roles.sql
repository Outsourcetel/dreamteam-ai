-- 224_accounting_fpa_roles.sql
-- ============================================================================
-- MONEY ROLES 2 & 3 — Accounting and FP&A (Finance), on the deepened machinery.
-- Both are READ-heavy + propose-only: they sweep a ledger / the finances, judge,
-- and PRODUCE a deliverable (reconciliation memo, variance report) for a human —
-- they never post, adjust, or move money themselves. Their "act" is the existing
-- produce_deliverable (mig 216) + escalate, so no new write path is needed.
--
-- Adds list_de_system: a multi-record read (the single-record read_de_system
-- can't sweep a ledger). Safe: source_table whitelisted, tenant-scoped, no
-- caller-supplied filter/SQL, integer limit only.
--
-- GLOBAL. Proven at the DATA layer (config + list read). Autonomous loop
-- unverified until the Anthropic credit top-up. Aggregate/period roll-ups and a
-- journal-proposal registry (propose a posting → gated → insert) are documented
-- follow-ups.
-- ============================================================================

-- 1. list_de_system — multi-record grounded read for sweep/reconcile roles ----
CREATE OR REPLACE FUNCTION public.list_de_system(p_de_id uuid, p_system_key text, p_limit integer DEFAULT 25)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s de_connected_systems; v_tenant uuid; v_sql text; v_rows jsonb;
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
  IF NOT (s.source_table = ANY (ARRAY['customer_accounts','opportunities','invoices','bills','payments','journal_entries'])) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unsupported_source_table');
  END IF;

  -- read_fields projected per row; tenant-bound; recent-first; integer limit only.
  v_sql := format(
    'SELECT coalesce(jsonb_agg(to_jsonb(t) - (SELECT coalesce(array_agg(k),ARRAY[]::text[]) FROM (SELECT key AS k FROM jsonb_each(to_jsonb(t)) WHERE key <> ALL (SELECT jsonb_array_elements_text($2))) x)), ''[]''::jsonb) '
    'FROM (SELECT * FROM %I WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT %s) t',
    s.source_table, least(greatest(p_limit,1),100));
  EXECUTE v_sql INTO v_rows USING v_tenant, s.read_fields;
  RETURN jsonb_build_object('ok', true, 'system_key', p_system_key, 'count', jsonb_array_length(v_rows), 'records', v_rows);
END; $$;
REVOKE ALL ON FUNCTION public.list_de_system(uuid,text,integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_de_system(uuid,text,integer) TO authenticated, service_role;

-- 2. Accounting archetype (reconcile the ledger, propose-only) ----------------
INSERT INTO role_archetypes
  (key, name, domain, description, persona_preamble, responsibilities, required_capabilities,
   required_connector_categories, recommended_model, compliance_pack_keys, knowledge_scaffold,
   eval_category, pass_threshold_pct, status, sop_playbook, watcher_templates, guardrail_templates, system_templates)
VALUES (
  'accounting', 'Accounting Specialist', 'Accounting',
  'Reviews the general ledger: reconciles entries, checks the books against source records, and produces a reconciliation memo for human review. Never posts, adjusts, or closes the books itself.',
  'You are an accounting specialist. You reconcile and check the books — grounded in the ledger and source records, precise about discrepancies, and ALWAYS producing your findings as a memo for a human to review and post. You never write a journal entry, adjust a balance, or close a period yourself.',
  ARRAY['Reconcile ledger entries against source records','Check the books for discrepancies and unusual entries','Produce reconciliation and close-readiness memos for human review','Escalate discrepancies and control exceptions'],
  ARRAY['accounting','reporting'], ARRAY['erp_financials'], 'claude-sonnet-5', ARRAY[]::text[],
  '{"topics":["Your chart of accounts","Your close calendar and reconciliation cadence","What requires a manual journal vs an automated one"]}'::jsonb,
  'procedure', 80, 'active',
  jsonb_build_object('name','Accounting / Reconciliation SOP','description','Standard operating procedure for reviewing the ledger and preparing a reconciliation memo.',
    'steps', jsonb_build_array(
      jsonb_build_object('key','instruction','label','Read the ledger','params',jsonb_build_object('body_md','Read the recent journal entries and the source records they should tie to. Never assume a balance or an entry you cannot see. Work from the numbers on the record.')),
      jsonb_build_object('key','instruction','label','Reconcile and find discrepancies','params',jsonb_build_object('body_md','Compare entries against source records (invoices, payments, bills). Flag anything that does not tie out: missing entries, duplicates, wrong accounts, unusual amounts. Compute totals with your compute tool — never eyeball a sum.')),
      jsonb_build_object('key','checklist','label','Prepare the memo','params',jsonb_build_object('items', jsonb_build_array('List each discrepancy with the entry, the expected value, and the difference','State what a human would need to post or adjust to resolve it','Produce a reconciliation memo (a deliverable) for human review','Escalate any control exception or material discrepancy'))),
      jsonb_build_object('key','instruction','label','Stay within your authority (books = propose-only)','params',jsonb_build_object('body_md','You do NOT post journal entries, adjust balances, or close periods. Your output is a memo of findings and proposed corrections for a human accountant to review and action. Never state that an entry has been posted or a period closed.'))
    )),
  jsonb_build_array(jsonb_build_object('kind','schedule','label','Ledger reconciliation sweep','description','Wake on a cadence to reconcile the ledger and prepare a memo.','config',jsonb_build_object('interval_minutes',1440))),
  jsonb_build_array(
    jsonb_build_object('rule','No posting, adjusting, or closing without human action','rule_type','blocked_phrase','pattern','posted the entry|closed the period|adjusted the balance|booked the|i have posted|entry is now posted|reconciled and closed','severity','blocking'),
    jsonb_build_object('rule','Any adjustment over $10,000 requires human approval','rule_type','require_approval_over_cents','threshold','1000000','severity','blocking')),
  jsonb_build_array(jsonb_build_object('system_key','ledger','label','General ledger','source_table','journal_entries',
    'read_fields', jsonb_build_array('entry_date','account_id','memo','debit','credit','source'),
    'write_registry', NULL, 'can_read',true,'can_write',false,'can_verify',true))
)
ON CONFLICT (key) DO UPDATE SET sop_playbook=excluded.sop_playbook, watcher_templates=excluded.watcher_templates,
  guardrail_templates=excluded.guardrail_templates, system_templates=excluded.system_templates,
  persona_preamble=excluded.persona_preamble, responsibilities=excluded.responsibilities, status='active';

-- 3. FP&A / Finance archetype (analyze + report, propose-only) ----------------
INSERT INTO role_archetypes
  (key, name, domain, description, persona_preamble, responsibilities, required_capabilities,
   required_connector_categories, recommended_model, compliance_pack_keys, knowledge_scaffold,
   eval_category, pass_threshold_pct, status, sop_playbook, watcher_templates, guardrail_templates, system_templates)
VALUES (
  'fpa', 'FP&A Analyst', 'Finance',
  'Analyzes the financial picture — receivables, payables, cash movement — and produces variance and cash-position reports for human review. Advisory only: it never moves money or changes a record.',
  'You are an FP&A analyst. You turn the raw financial records into clear, grounded analysis — receivables, payables, cash — and produce reports and flags for humans. You compute every number from the records with your compute tool, cite what you read, and never move money, change a record, or give a recommendation you cannot support with the data.',
  ARRAY['Analyze receivables, payables, and cash movement','Compute variances and cash position from the records','Produce financial reports and flag anomalies for human review','Escalate material variances'],
  ARRAY['financial_analysis','reporting'], ARRAY['erp_financials'], 'claude-sonnet-5', ARRAY[]::text[],
  '{"topics":["Your reporting cadence and KPIs","Your budget/forecast figures","What counts as a material variance"]}'::jsonb,
  'procedure', 80, 'active',
  jsonb_build_object('name','FP&A Reporting SOP','description','Standard operating procedure for building a grounded financial report.',
    'steps', jsonb_build_array(
      jsonb_build_object('key','instruction','label','Read the financials','params',jsonb_build_object('body_md','Read the recent invoices, bills, and payments. Never assume a figure — pull it from the records. Note the period you are covering.')),
      jsonb_build_object('key','instruction','label','Compute the analysis','params',jsonb_build_object('body_md','Compute receivables/payables totals, cash movement, and any variance against expectation — always with your compute tool, never by estimating. Identify anomalies and material variances.')),
      jsonb_build_object('key','checklist','label','Produce the report','params',jsonb_build_object('items', jsonb_build_array('Summarise the cash and AR/AP position with the computed figures','Call out material variances and anomalies with the numbers behind them','Produce a report (a deliverable) for human review','Escalate anything that needs a decision'))),
      jsonb_build_object('key','instruction','label','Stay within your authority (advisory only)','params',jsonb_build_object('body_md','You produce analysis and reports only. You do NOT move money, change a record, approve a payment, or commit the business to anything. Give recommendations a human can act on, each grounded in the figures you read.'))
    )),
  jsonb_build_array(jsonb_build_object('kind','schedule','label','Financial reporting cadence','description','Wake on a cadence to build the financial report.','config',jsonb_build_object('interval_minutes',10080))),
  jsonb_build_array(
    jsonb_build_object('rule','Advisory only — no money movement or record changes','rule_type','blocked_phrase','pattern','i have paid|transferred the funds|approved the payment|moved the money|processed the payment|updated the record|i have adjusted','severity','blocking'),
    jsonb_build_object('rule','Never guess a figure — compute from the records','rule_type','require_computed_number','severity','warning')),
  jsonb_build_array(
    jsonb_build_object('system_key','receivables','label','Invoices (AR)','source_table','invoices','read_fields', jsonb_build_array('invoice_number','amount','amount_paid','status','due_date'),'write_registry', NULL,'can_read',true,'can_write',false,'can_verify',true),
    jsonb_build_object('system_key','payables','label','Bills (AP)','source_table','bills','read_fields', jsonb_build_array('bill_number','amount','amount_paid','status','due_date'),'write_registry', NULL,'can_read',true,'can_write',false,'can_verify',true),
    jsonb_build_object('system_key','payments','label','Payments','source_table','payments','read_fields', jsonb_build_array('direction','amount','paid_date','invoice_id','bill_id'),'write_registry', NULL,'can_read',true,'can_write',false,'can_verify',true))
)
ON CONFLICT (key) DO UPDATE SET sop_playbook=excluded.sop_playbook, watcher_templates=excluded.watcher_templates,
  guardrail_templates=excluded.guardrail_templates, system_templates=excluded.system_templates,
  persona_preamble=excluded.persona_preamble, responsibilities=excluded.responsibilities, status='active';

-- 4. Install on the existing Accounting DE + Finance DE -----------------------
SELECT public.install_role_kit(d.id, CASE WHEN d.name='Accounting DE' THEN 'accounting' ELSE 'fpa' END),
       public.install_role_systems(d.id, CASE WHEN d.name='Accounting DE' THEN 'accounting' ELSE 'fpa' END)
FROM digital_employees d
WHERE d.tenant_id = (SELECT id FROM tenants WHERE slug='outsourcetel-hq') AND d.name IN ('Accounting DE','Finance DE');
