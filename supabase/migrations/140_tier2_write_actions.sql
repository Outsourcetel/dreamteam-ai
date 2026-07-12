-- ============================================================
-- 140 — Tier-2 write-back actions (ServiceNow, GitHub, GitLab, Asana).
--
-- Registers platform action_definitions for the connector-hub NATIVE_ACTIONS
-- executors added with the Tier-2 connectors. Same shape as migrations 035
-- (Zendesk) and 139 (Slack). category = the connector's category so
-- execute_action resolves (connector.category, action_key) → def, then
-- def.provider picks the executor. These are internal collaboration writes
-- (work notes / issue+task comments), not customer-facing sends, so
-- destructive=false (like zendesk_add_internal_note) — the trust dial and
-- guardrails still gate them per DE.
-- ============================================================

-- ServiceNow — add a work note to an incident (helpdesk)
insert into action_definitions (scope, tenant_id, category, action_key, label, description, provider, template_id, param_schema, risk, execution)
values (
  'platform', null, 'helpdesk', 'add_work_note',
  'Add a work note to a ServiceNow incident',
  'Posts an internal work note on a ServiceNow incident (agent-facing, not the customer-visible comment stream).',
  'servicenow', null,
  '[{"name":"external_ref","type":"string","required":true,"help":"The incident sys_id"},{"name":"note","type":"string","required":true,"help":"The work note text"}]'::jsonb,
  '{"destructive": false, "idempotent": false}'::jsonb,
  '{"execution_key": "servicenow_add_work_note"}'::jsonb
)
on conflict (scope, tenant_id, category, action_key) do nothing;

-- GitHub — comment on an issue/PR (product_system)
insert into action_definitions (scope, tenant_id, category, action_key, label, description, provider, template_id, param_schema, risk, execution)
values (
  'platform', null, 'product_system', 'github_add_comment',
  'Comment on a GitHub issue',
  'Posts a comment on a GitHub issue or pull request (visible to repository members).',
  'github', null,
  '[{"name":"external_ref","type":"string","required":true,"help":"owner/repo/number of the issue"},{"name":"body","type":"string","required":true,"help":"The comment text (Markdown)"}]'::jsonb,
  '{"destructive": false, "idempotent": false}'::jsonb,
  '{"execution_key": "github_add_comment"}'::jsonb
)
on conflict (scope, tenant_id, category, action_key) do nothing;

-- GitLab — note on an issue (product_system)
insert into action_definitions (scope, tenant_id, category, action_key, label, description, provider, template_id, param_schema, risk, execution)
values (
  'platform', null, 'product_system', 'gitlab_add_note',
  'Add a note to a GitLab issue',
  'Posts a note (comment) on a GitLab issue (visible to project members).',
  'gitlab', null,
  '[{"name":"external_ref","type":"string","required":true,"help":"projectId/iid of the issue"},{"name":"body","type":"string","required":true,"help":"The note text (Markdown)"}]'::jsonb,
  '{"destructive": false, "idempotent": false}'::jsonb,
  '{"execution_key": "gitlab_add_note"}'::jsonb
)
on conflict (scope, tenant_id, category, action_key) do nothing;

-- Asana — comment on a task (product_system)
insert into action_definitions (scope, tenant_id, category, action_key, label, description, provider, template_id, param_schema, risk, execution)
values (
  'platform', null, 'product_system', 'asana_add_comment',
  'Comment on an Asana task',
  'Posts a comment (story) on an Asana task (visible to task followers).',
  'asana', null,
  '[{"name":"external_ref","type":"string","required":true,"help":"The task gid"},{"name":"text","type":"string","required":true,"help":"The comment text"}]'::jsonb,
  '{"destructive": false, "idempotent": false}'::jsonb,
  '{"execution_key": "asana_add_comment"}'::jsonb
)
on conflict (scope, tenant_id, category, action_key) do nothing;
