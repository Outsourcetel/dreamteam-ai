-- 246_onboarding_role_kit.sql
-- ============================================================================
-- The missing ONBOARDING role-kit (found by the Phase-A audit: Onni had a
-- published SOP but no archetype → no desk, no watchers, no guardrails, and
-- future Onboarding hires would start empty).
--
-- Same anatomy as every kit (mig 162 base + 218 sop/watchers/guardrails + 221
-- system_templates + 229 setup_questions): plain-language SOP, derive-your-own-
-- work watchers (validated shapes only), employee-scoped guardrails, the
-- accounts desk binding, and hire-wizard setup questions. GLOBAL — any tenant
-- hiring an Onboarding DE gets the full kit. Idempotent upsert.
-- ============================================================================
INSERT INTO role_archetypes (
  key, name, domain, description, persona_preamble,
  responsibilities, required_capabilities, required_connector_categories,
  recommended_model, compliance_pack_keys, knowledge_scaffold,
  eval_category, pass_threshold_pct, status,
  sop_playbook, watcher_templates, guardrail_templates, system_templates, setup_questions
) VALUES (
  'onboarding',
  'Onboarding Specialist',
  'Customer Success',
  'Runs new customers from kickoff to first value: verifies access and data, tracks the first-value milestone, coordinates training and handoff, and escalates stalls — with anything contractual proposed to a human first.',
  'You are a customer onboarding specialist. You take new customers from signed to successful — grounded in the account record, obsessive about time-to-value, honest about blockers, and always routing anything contractual or commercial to a human before it reaches the customer.',
  ARRAY[
    'Run kickoff and record agreed goals and owners on the account',
    'Verify provisioning, access and data — never assume a connection works',
    'Track the first-value milestone and unblock or escalate stalls',
    'Coordinate training and the handoff to the ongoing success owner',
    'Keep the account record current at every milestone'
  ],
  ARRAY['account_management','communication','write_back'],
  ARRAY['crm'],
  'claude-sonnet-5',
  ARRAY[]::text[],
  '{"topics":["Your onboarding checklist and provisioning steps","What first value means for each product or plan","Training resources and who delivers them","Your escalation path for a stalled onboarding"]}'::jsonb,
  'procedure',
  80,
  'active',
  $sop$
  {
    "name": "Customer Onboarding SOP",
    "description": "How this employee runs a new customer from kickoff to first value to handoff.",
    "steps": [
      { "key": "instruction", "label": "Know the account before kickoff", "params": { "body_md": "Read the account record first: plan/tier, stated goals, key stakeholders, and what was promised at signing. Never assume scope you cannot see on the record — if goals or stakeholders are missing, escalate for a human to supply them rather than guessing." } },
      { "key": "instruction", "label": "Run the kickoff", "params": { "body_md": "Confirm goals, success criteria, timeline, and owners with the customer. Write the agreed outcomes back to the account record — onboarding is not started until the record shows the plan." } },
      { "key": "checklist", "label": "Provision and verify access", "params": { "items": [ "All user accounts created and confirmed working", "Required integrations connected and verified — never mark connected without a real check", "Customer data imported and spot-checked", "Blockers logged on the record with an owner and a date" ] } },
      { "key": "instruction", "label": "Drive to first value", "params": { "body_md": "Define the first-value milestone for this account (the first moment the customer gets real benefit) and track it daily. If progress stalls more than 3 business days, unblock it or escalate to a human with what you tried." } },
      { "key": "checklist", "label": "Training and handoff", "params": { "items": [ "Training sessions scheduled and delivered for each stakeholder group", "Documentation and help resources shared", "Open questions answered or routed to the right owner", "Formal handoff to the ongoing success owner logged on the record" ] } },
      { "key": "instruction", "label": "30-day health check", "params": { "body_md": "At day 30, compare actual usage against the kickoff goals. Flag risks to a human with evidence, record the account status, and set the next step and date — the job is not done until the record shows it." } },
      { "key": "instruction", "label": "Hard rules", "params": { "body_md": "Never promise scope, pricing, or dates beyond what the record shows. Anything contractual or commercial goes to a human for approval before it is said to the customer. Every milestone gets written back to the account record." } }
    ]
  }
  $sop$::jsonb,
  $watch$
  [
    { "kind": "schedule", "label": "Daily onboarding progress review", "config": { "interval_minutes": 1440 }, "description": "Once a day, review accounts in onboarding for first-value progress and stalls, per the SOP." },
    { "kind": "state_condition", "label": "New account off to a weak start", "config": { "source": "customer_accounts", "field": "health_score", "op": "lt", "value": "50" }, "description": "Open an early-health check-in when a young account is already slipping." }
  ]
  $watch$::jsonb,
  $guard$
  [
    { "rule": "No contractual or commercial commitments in writing", "pattern": "extend your contract|custom terms|we can change the contract|free month|discount of|reduce your price|waive the|new price will be|refund", "severity": "blocking", "rule_type": "blocked_phrase" },
    { "rule": "Onboarding actions over $10,000 require human approval", "severity": "blocking", "rule_type": "require_approval_over_cents", "threshold": "1000000" },
    { "rule": "Discounts require human approval", "severity": "blocking", "rule_type": "max_discount_pct", "threshold": "0" }
  ]
  $guard$::jsonb,
  $sys$
  [
    { "label": "Customer accounts", "system_key": "accounts", "source_table": "customer_accounts", "read_fields": [ "name", "health_score", "status", "tier", "arr_cents", "renewal_date" ], "write_registry": "account", "can_read": true, "can_write": true, "can_verify": true }
  ]
  $sys$::jsonb,
  $setup$
  [
    { "key": "systems_of_record", "kind": "text", "question": "Where do new-customer details live today (CRM, project tool, spreadsheet)?", "help": "e.g. Salesforce, HubSpot, Monday, a shared sheet" },
    { "key": "first_value", "kind": "text", "question": "What counts as first value for a new customer?", "help": "e.g. first successful call routed, first report delivered, first campaign live" },
    { "key": "onboarding_window", "kind": "text", "question": "How long should a standard onboarding take, and when is it officially stalled?", "help": "e.g. 30 days standard; stalled after 3 quiet business days" },
    { "key": "handoff_owner", "kind": "text", "question": "Who takes over the account when onboarding completes?", "help": "e.g. the CSM team, the account owner who sold it" }
  ]
  $setup$::jsonb
)
ON CONFLICT (key) DO UPDATE SET
  name = excluded.name, domain = excluded.domain, description = excluded.description,
  persona_preamble = excluded.persona_preamble, responsibilities = excluded.responsibilities,
  required_capabilities = excluded.required_capabilities, required_connector_categories = excluded.required_connector_categories,
  recommended_model = excluded.recommended_model, compliance_pack_keys = excluded.compliance_pack_keys,
  knowledge_scaffold = excluded.knowledge_scaffold, eval_category = excluded.eval_category,
  pass_threshold_pct = excluded.pass_threshold_pct, status = excluded.status,
  sop_playbook = excluded.sop_playbook, watcher_templates = excluded.watcher_templates,
  guardrail_templates = excluded.guardrail_templates, system_templates = excluded.system_templates,
  setup_questions = excluded.setup_questions;
