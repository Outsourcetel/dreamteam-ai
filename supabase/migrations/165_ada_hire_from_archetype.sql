-- ═══════════════════════════════════════════════════════════════
-- 165 — Ada gains "hire from archetype" (P3 dogfooding wiring)
--
-- role_archetypes + instantiate_role_archetype (mig 162) were DEAD CODE:
-- nothing called them. This registers a 5th dreamteam self-management
-- action so the Onboarding Architect can propose "hire a ready-to-go
-- <role> Digital Employee" from the archetype catalog — persona,
-- responsibilities, capabilities, recommended model, and compliance
-- packs all applied in one gated step, instead of a blank
-- create_digital_employee the human then has to configure from scratch.
--
-- Same safety envelope as the other four: provider 'dreamteam',
-- destructive:true → decide_action_execution ALWAYS human-gates it; the
-- new DE lands at lifecycle 'designed'/trust 'supervised' and still must
-- pass certification before it can go customer-facing (mig 162 trigger).
-- Executor: dt_hire_from_archetype (connector-hub) → instantiate_role_archetype.
-- ═══════════════════════════════════════════════════════════════

insert into action_definitions (scope, tenant_id, category, action_key, label, description, provider, template_id, param_schema, risk, execution)
values (
  'platform', null, 'platform_admin', 'hire_from_archetype',
  'Hire a ready-to-go Digital Employee from a role archetype',
  'Creates a Digital Employee from a pre-built ROLE ARCHETYPE (e.g. support_agent) — persona, responsibilities, capabilities, recommended model and mandatory compliance packs are all applied at once. Prefer this over create_digital_employee when a matching archetype exists. The new DE lands at lifecycle "designed"/trust "supervised" and must pass certification before going live. ALWAYS requires human approval.',
  'dreamteam', null,
  '[{"name":"archetype_key","type":"string","required":true,"help":"The archetype to hire from, e.g. support_agent. Use one of the available archetype keys."},{"name":"de_name","type":"string","required":true,"help":"The name/label for this new employee, e.g. Acme Support"},{"name":"persona_name","type":"string","required":false,"help":"Optional human first name it answers as"}]'::jsonb,
  '{"destructive": true, "idempotent": false}'::jsonb,
  '{"execution_key": "dt_hire_from_archetype"}'::jsonb
)
on conflict (scope, tenant_id, category, action_key) do nothing;
