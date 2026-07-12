-- ============================================================
-- 139 — Slack write-back action: post a message / reply in-channel.
--
-- Gap fix: the Slack connector (v22) was read-only (search past answers).
-- This registers the write side — a DE/playbook posting a reply where
-- people work — via the connector-hub NATIVE_ACTIONS.slack_post_message
-- executor. Same shape as the seeded Zendesk native actions (migration
-- 035).
--
-- category = 'knowledge_base' because that is the Slack connector's
-- category, and execute_action resolves an action_definition by
-- (connector.category, action_key); def.provider then selects the
-- executor. destructive=true: a posted Slack message reaches people
-- immediately and can't be unsent, so it is ALWAYS human-gated by the
-- action layer's destructive rule.
-- ============================================================
insert into action_definitions (scope, tenant_id, category, action_key, label, description, provider, template_id, param_schema, risk, execution)
values (
  'platform', null, 'knowledge_base', 'post_message',
  'Post a message in Slack',
  'Posts a message (or threaded reply) to a Slack channel — people see it immediately. Requires the Slack connector token to have the chat:write scope. Always requires human approval (destructive: a sent message cannot be unsent).',
  'slack', null,
  '[{"name":"channel","type":"string","required":true,"help":"Channel id (e.g. C0123ABCD) or #name to post to"},{"name":"text","type":"string","required":true,"help":"The message text to post"},{"name":"thread_ts","type":"string","required":false,"help":"Optional: a message timestamp to reply in-thread"}]'::jsonb,
  '{"destructive": true, "idempotent": false}'::jsonb,
  '{"execution_key": "slack_post_message"}'::jsonb
)
on conflict (scope, tenant_id, category, action_key) do nothing;
