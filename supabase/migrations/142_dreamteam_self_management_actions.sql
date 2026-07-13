-- ============================================================
-- 142 — DreamTeam self-management actions ("the product operating itself")
--
-- The deliberate, GATED opening of the wall that keeps platform-admin
-- operations out of a Digital Employee's hands. A DE trained on the
-- DreamTeam knowledge base can, from a customer's requirement, DRAFT the
-- setup to onboard them: a new Digital Employee, a draft playbook, a
-- specialist desk, or a proposed connector.
--
-- These are provider 'dreamteam' (NOT 'internal', so get_agentic_tools_for_de
-- surfaces them) with real executors in connector-hub NATIVE_ACTIONS. Every
-- one is destructive=true, so decide_action_execution ALWAYS routes it to
-- human approval — the employee proposes, a human approves, and only then is
-- anything created. A DE still needs a connected 'dreamteam' self-connector
-- (category 'platform_admin') AND an explicit write_back data-access grant to
-- see these tools at all.
-- ============================================================

-- 0. The self-management category (action_definitions.category FKs to system_categories).
insert into system_categories (key, label, description)
values ('platform_admin', 'DreamTeam Platform', 'Actions a Digital Employee takes to configure DreamTeam itself — create employees, draft playbooks, specialists, propose connectors. Always human-approved.')
on conflict (key) do nothing;

-- 1. Allow the self-connector's provider on the connectors table.
alter table connectors drop constraint if exists connectors_provider_check;
alter table connectors add constraint connectors_provider_check
  check (provider = any (array[
    'zendesk','salesforce','confluence','jira','intercom','generic_rest',
    'sharepoint','template','dreamteam'
  ]));

-- 2. Register the four platform-builder actions (scope platform → all tenants).
insert into action_definitions (scope, tenant_id, category, action_key, label, description, provider, template_id, param_schema, risk, execution)
values
(
  'platform', null, 'platform_admin', 'create_digital_employee',
  'Create a new Digital Employee',
  'Creates a new Digital Employee in DreamTeam at lifecycle stage "designed", trust "supervised" — it cannot answer or act until a human takes it through the lifecycle gates. Use when a customer needs a new AI employee for a role. ALWAYS requires human approval.',
  'dreamteam', null,
  '[{"name":"name","type":"string","required":true,"help":"The role/label, e.g. Patient Support DE"},{"name":"category","type":"string","required":false,"help":"Customer or Internal (default Customer)"},{"name":"department","type":"string","required":false,"help":"e.g. Support, Finance"},{"name":"persona_name","type":"string","required":false,"help":"Optional human first name it answers as"},{"name":"description","type":"string","required":false,"help":"Plain-language description of what it does"}]'::jsonb,
  '{"destructive": true, "idempotent": false}'::jsonb,
  '{"execution_key": "dt_create_digital_employee"}'::jsonb
),
(
  'platform', null, 'platform_admin', 'draft_playbook',
  'Draft a playbook',
  'Creates a DRAFT playbook in DreamTeam capturing a proposed procedure a DE should follow. A human refines the steps in the Playbook Builder and publishes it. ALWAYS requires human approval.',
  'dreamteam', null,
  '[{"name":"name","type":"string","required":true,"help":"Playbook name, e.g. Handle appointment reschedule"},{"name":"outline","type":"string","required":false,"help":"The proposed procedure / step outline in plain language"},{"name":"description","type":"string","required":false,"help":"What this playbook is for"}]'::jsonb,
  '{"destructive": true, "idempotent": false}'::jsonb,
  '{"execution_key": "dt_draft_playbook"}'::jsonb
),
(
  'platform', null, 'platform_admin', 'create_specialist',
  'Create a specialist desk',
  'Creates a specialist desk (deep-expertise reference a DE can consult) in DreamTeam. ALWAYS requires human approval.',
  'dreamteam', null,
  '[{"name":"name","type":"string","required":true,"help":"Specialist name, e.g. Dental Billing Specialist"},{"name":"charter","type":"string","required":false,"help":"What this specialist knows / is responsible for"}]'::jsonb,
  '{"destructive": true, "idempotent": false}'::jsonb,
  '{"execution_key": "dt_create_specialist"}'::jsonb
),
(
  'platform', null, 'platform_admin', 'propose_connector',
  'Propose a connector',
  'Proposes a connector to a customer system, created DISCONNECTED — a human must add credentials and connect it. The employee never handles credentials. ALWAYS requires human approval.',
  'dreamteam', null,
  '[{"name":"provider","type":"string","required":true,"help":"The system to connect, e.g. zendesk, salesforce, or a name for a custom API"},{"name":"category","type":"string","required":false,"help":"Connector category, e.g. helpdesk, crm, product_system"},{"name":"display_name","type":"string","required":false,"help":"A friendly name for the connection"},{"name":"base_url","type":"string","required":false,"help":"The system base URL if known"}]'::jsonb,
  '{"destructive": true, "idempotent": false}'::jsonb,
  '{"execution_key": "dt_propose_connector"}'::jsonb
)
on conflict (scope, tenant_id, category, action_key) do nothing;
