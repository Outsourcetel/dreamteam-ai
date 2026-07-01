-- ============================================================
-- Migration 003: Seed Data — Outsourcetel
-- Run AFTER migrations 001 and 002.
-- Idempotent: uses ON CONFLICT DO NOTHING throughout.
-- ============================================================

-- ── Step 1: Ensure Outsourcetel tenant exists ─────────────────
-- If you already created it via sign-up, update the slug/plan
-- here to match. This upsert is safe to re-run.

insert into tenants (
  id, name, slug, industry, plan, status,
  accent_color, settings, created_at, updated_at
)
values (
  'a0000000-0000-0000-0000-000000000001',
  'Outsourcetel',
  'outsourcetel',
  'Business Process Outsourcing',
  'enterprise',
  'active',
  '#6366f1',
  '{"workforce_engine": true, "max_digital_employees": 50}'::jsonb,
  now(),
  now()
)
on conflict (id) do update set
  name         = excluded.name,
  plan         = excluded.plan,
  status       = excluded.status,
  updated_at   = now();

-- Capture the tenant ID for use in subsequent inserts.
-- Note: we use the fixed UUID above so all seeds below are portable.
do $$ declare
  v_tenant_id uuid := 'a0000000-0000-0000-0000-000000000001';
begin

  -- ── Workspaces ───────────────────────────────────────────────
  insert into workspaces (tenant_id, name, slug, description, icon, color, status)
  values
    (v_tenant_id, 'Workforce HQ',        'workforce-hq',       'Central command for all Digital Employee operations',             '⌘', '#6366f1', 'active'),
    (v_tenant_id, 'Revenue Workspace',   'revenue',            'Business development, lead qualification, and outreach',          '$', '#10b981', 'active'),
    (v_tenant_id, 'Support Workspace',   'support',            'Customer support resolution and escalation',                      '◈', '#3b82f6', 'active'),
    (v_tenant_id, 'Knowledge Workspace', 'knowledge',          'KB curation, gap detection, and training material management',    '◉', '#8b5cf6', 'active'),
    (v_tenant_id, 'Onboarding Workspace','onboarding',         'New customer and employee onboarding operations',                 '⊕', '#f59e0b', 'active'),
    (v_tenant_id, 'Finance Workspace',   'finance',            'Billing, reconciliation, and financial exception handling',       '⊞', '#ef4444', 'active')
  on conflict (tenant_id, slug) do nothing;

  -- ── Departments ──────────────────────────────────────────────
  insert into departments (tenant_id, name, description, head_name, color)
  values
    (v_tenant_id, 'Leadership',         'Executive and senior leadership',              'Bilal Khan',    '#6366f1'),
    (v_tenant_id, 'Operations',         'Process management and service delivery',      '',              '#10b981'),
    (v_tenant_id, 'Revenue',            'Sales and business development',               '',              '#8b5cf6'),
    (v_tenant_id, 'Customer Success',   'Account management and retention',             '',              '#06b6d4'),
    (v_tenant_id, 'Finance',            'Financial planning, billing, and compliance',  '',              '#f59e0b'),
    (v_tenant_id, 'Technology',         'Platform, infrastructure, and integrations',   '',              '#3b82f6'),
    (v_tenant_id, 'Quality Assurance',  'QA, review, and continuous improvement',       '',              '#ec4899'),
    (v_tenant_id, 'HR & People',        'Hiring, onboarding, and people operations',    '',              '#ef4444')
  on conflict do nothing;

  -- ── Capabilities ─────────────────────────────────────────────
  insert into capabilities (
    tenant_id, slug, name, description, workspace, icon,
    status, risk_level, approval_required,
    inputs, outputs, required_connectors, required_knowledge,
    run_count, avg_confidence
  )
  values
    -- Support
    (v_tenant_id, 'cap_answer_query',    'Answer Customer Query',
     'Respond to an inbound customer question using KB + conversation history',
     'Support', '💬', 'active', 'low', false,
     '{"customer_message","conversation_history"}',
     '{"response_text","confidence_score","citations"}',
     '{"zendesk"}', '{"Product","Support Scripts","Onboarding"}',
     4821, 0.87),

    (v_tenant_id, 'cap_issue_refund',    'Issue Credit / Refund',
     'Process a customer refund within configured value limits',
     'Support', '↩', 'active', 'high', true,
     '{"customer_id","amount","reason"}',
     '{"refund_confirmation","audit_entry"}',
     '{"stripe","zendesk"}', '{"Billing"}',
     142, 0.91),

    (v_tenant_id, 'cap_escalate_human',  'Escalate to Human',
     'Identify when a conversation needs human intervention and route to the right team',
     'Support', '⬆', 'active', 'medium', false,
     '{"conversation_context","escalation_reason"}',
     '{"escalation_ticket","human_handoff_summary"}',
     '{"zendesk","slack"}', '{"Support Scripts"}',
     287, 0.79),

    (v_tenant_id, 'cap_summarise_case',  'Summarise Case History',
     'Produce a concise summary of all customer interactions and open issues',
     'Support', '≡', 'active', 'low', false,
     '{"customer_id","date_range"}',
     '{"case_summary_md","open_issues_list"}',
     '{"zendesk"}', '{}',
     618, 0.93),

    -- Revenue
    (v_tenant_id, 'cap_qualify_lead',    'Qualify Lead',
     'Score and qualify inbound leads against ICP criteria',
     'Revenue', '◉', 'active', 'low', false,
     '{"lead_data","company_info"}',
     '{"qualification_score","icp_match","next_action"}',
     '{"salesforce"}', '{"Product"}',
     931, 0.82),

    (v_tenant_id, 'cap_draft_outreach',  'Draft Outreach',
     'Generate personalised outreach copy based on prospect research and product fit',
     'Revenue', '✉', 'active', 'medium', true,
     '{"prospect_id","outreach_goal","tone"}',
     '{"email_draft","linkedin_message_draft"}',
     '{"salesforce"}', '{"Product","Onboarding"}',
     524, 0.78),

    (v_tenant_id, 'cap_research_account','Research Account',
     'Deep-dive research on a target account: news, financials, org chart, buying signals',
     'Revenue', '⚲', 'active', 'low', false,
     '{"company_name","domain"}',
     '{"account_brief","key_contacts","buying_signals"}',
     '{"salesforce"}', '{}',
     312, 0.85),

    (v_tenant_id, 'cap_update_crm',      'Update CRM Record',
     'Write call notes, update deal stage, log activities in Salesforce',
     'Revenue', '↺', 'active', 'low', false,
     '{"deal_id","call_transcript"}',
     '{"crm_update_confirmation","summary_note"}',
     '{"salesforce"}', '{}',
     1204, 0.94),

    -- Finance
    (v_tenant_id, 'cap_detect_exception','Detect Transaction Exception',
     'Flag anomalous transactions against policy rules and historical patterns',
     'Finance', '⚠', 'active', 'medium', false,
     '{"transaction_batch"}',
     '{"exception_list","severity_scores","audit_entry"}',
     '{"stripe"}', '{"Finance Procedures","Compliance"}',
     2088, 0.89),

    (v_tenant_id, 'cap_reconcile',       'Reconcile Statement',
     'Match bank statement lines to ledger entries and surface unmatched items',
     'Finance', '=', 'active', 'high', true,
     '{"bank_statement","ledger_export"}',
     '{"reconciliation_report","unmatched_items"}',
     '{"stripe"}', '{"Finance Procedures"}',
     47, 0.96),

    -- HR
    (v_tenant_id, 'cap_onboard_employee','Onboard New Employee',
     'Trigger onboarding sequence: accounts, checklist, welcome pack, buddy assignment',
     'HR', '⊕', 'active', 'medium', true,
     '{"employee_record","start_date","department"}',
     '{"onboarding_checklist","system_access_requests","welcome_message"}',
     '{"bamboohr","slack"}', '{"Onboarding","HR Policies"}',
     23, 0.88),

    (v_tenant_id, 'cap_answer_hr_policy','Answer HR Policy Question',
     'Respond to employee questions about leave, benefits, policies using HR KB',
     'HR', '?', 'active', 'low', false,
     '{"employee_question"}',
     '{"policy_answer","relevant_articles"}',
     '{}', '{"HR Policies","Compliance"}',
     389, 0.86),

    -- Compliance
    (v_tenant_id, 'cap_flag_compliance', 'Flag Compliance Risk',
     'Scan conversation or document for policy violations and raise alerts',
     'Compliance', '⛛', 'draft', 'medium', false,
     '{"document_or_conversation"}',
     '{"risk_flags","policy_references","recommended_actions"}',
     '{}', '{"Compliance","Legal"}',
     0, null)

  on conflict (tenant_id, slug) do nothing;

  -- ── Digital Employees ─────────────────────────────────────────
  insert into digital_employees (
    tenant_id, catalog_id, name, description, icon,
    category, department, workspace,
    status, lifecycle_status, trust_level,
    capabilities, responsibilities, channels,
    confidence_threshold, required_approval
  )
  values
    (v_tenant_id, 'de_sales',      'Revenue Representative',
     'Qualifies leads, drafts outreach, researches accounts, and keeps CRM current',
     'R', 'Customer', 'Revenue', 'Revenue',
     'idle', 'published', 'supervised',
     '{"Qualify Lead","Draft Outreach","Research Account","Update CRM Record"}',
     '{"Lead qualification","Outreach drafting","CRM hygiene"}',
     '{"email","chat"}', 80, true),

    (v_tenant_id, 'de_support',    'Support Specialist',
     'Handles inbound customer queries, escalates complex cases, summarises case history',
     'S', 'Customer', 'Customer Success', 'Support',
     'idle', 'published', 'supervised',
     '{"Answer Customer Query","Escalate to Human","Summarise Case History"}',
     '{"Query resolution","Escalation routing","Case summarisation"}',
     '{"chat","email"}', 75, false),

    (v_tenant_id, 'de_knowledge',  'Knowledge Curator',
     'Identifies knowledge gaps, curates KB articles, flags stale content',
     'K', 'Internal', 'Operations', 'Knowledge',
     'idle', 'designed', 'supervised',
     '{}', '{"KB curation","Gap detection","Content review"}',
     '{"internal"}', 70, false),

    (v_tenant_id, 'de_compliance', 'Compliance Officer',
     'Scans conversations and documents for policy violations',
     'C', 'Internal', 'Quality Assurance', 'Workforce HQ',
     'idle', 'designed', 'supervised',
     '{"Flag Compliance Risk"}',
     '{"Compliance scanning","Risk flagging","Policy enforcement"}',
     '{"internal"}', 85, true),

    (v_tenant_id, 'de_onboarding', 'Onboarding Specialist',
     'Manages new customer onboarding plans, tracks milestones, generates training summaries',
     'O', 'Customer', 'Customer Success', 'Onboarding',
     'idle', 'designed', 'supervised',
     '{"Onboard New Employee"}',
     '{"Onboarding planning","Progress tracking","Welcome coordination"}',
     '{"email","chat"}', 75, false),

    (v_tenant_id, 'de_finance',    'Finance Analyst',
     'Detects billing exceptions, prepares reconciliation summaries',
     'F', 'Internal', 'Finance', 'Finance',
     'idle', 'designed', 'supervised',
     '{"Detect Transaction Exception","Reconcile Statement"}',
     '{"Exception detection","Reconciliation","Financial review"}',
     '{"internal"}', 80, true),

    (v_tenant_id, 'de_billing',    'Billing Specialist',
     'Processes refunds, handles billing disputes, issues credits within policy limits',
     'B', 'Customer', 'Finance', 'Finance',
     'idle', 'designed', 'supervised',
     '{"Issue Credit / Refund"}',
     '{"Refund processing","Billing dispute resolution","Credit issuance"}',
     '{"email","chat"}', 85, true),

    (v_tenant_id, 'de_qa',         'QA Reviewer',
     'Reviews conversation quality, flags non-compliant responses, reports on DE performance',
     'Q', 'Internal', 'Quality Assurance', 'Workforce HQ',
     'idle', 'designed', 'supervised',
     '{}', '{"Quality review","Performance reporting","Compliance checking"}',
     '{"internal"}', 80, false),

    (v_tenant_id, 'de_training',   'Training Coach',
     'Answers HR and policy questions, assists with onboarding new team members',
     'T', 'Internal', 'HR & People', 'Knowledge',
     'idle', 'designed', 'supervised',
     '{"Answer HR Policy Question"}',
     '{"Policy Q&A","Training material delivery","Onboarding support"}',
     '{"chat","internal"}', 75, false)

  on conflict do nothing;

  -- ── Playbooks ─────────────────────────────────────────────────
  insert into playbooks (
    tenant_id, name, slug, version, domain,
    business_objective, risk_level, lifecycle_status,
    trigger_type, is_base_playbook
  )
  values
    (v_tenant_id,
     'BDR Lead Qualification Playbook', 'bdr-lead-qualification', 1,
     'business_development',
     'Qualify every inbound lead against ICP criteria within 2 hours of receipt, score it, and route to the right next action without manual triage.',
     'low', 'published', 'inbound_request', true),

    (v_tenant_id,
     'Customer Support Resolution Playbook', 'customer-support-resolution', 1,
     'customer_support',
     'Resolve inbound customer queries at first contact with DE-handled rate above 80%, escalating only when confidence falls below threshold.',
     'low', 'published', 'inbound_request', true),

    (v_tenant_id,
     'Knowledge Gap Review Playbook', 'knowledge-gap-review', 1,
     'knowledge_management',
     'Detect, log, and assign knowledge gaps identified during customer interactions, triggering article creation within 48 hours.',
     'low', 'designed', 'event', true),

    (v_tenant_id,
     'Customer Onboarding Playbook', 'customer-onboarding', 1,
     'onboarding',
     'Guide new customers through a structured onboarding sequence — account setup, training, first value milestone — within 14 days of contract start.',
     'medium', 'designed', 'human_initiated', true),

    (v_tenant_id,
     'Billing Exception Review Playbook', 'billing-exception-review', 1,
     'billing_operations',
     'Detect anomalous billing events, classify severity, and resolve or escalate within SLA. No manual intervention for low-severity items.',
     'high', 'designed', 'scheduled', true)

  on conflict do nothing;

end $$;
