-- DE-A5 (Human-as-DE program): support-role action breadth.
--
-- The generalized action registry (migration 035) already covered the
-- support day-loop's note/reply/status ops (add_internal_note,
-- reply_to_ticket, update_status — all platform-scope helpdesk
-- actions). The missing triage op was tag/categorize. Registered here
-- with the same shape; the zendesk_add_tags adapter ships in
-- connector-hub alongside its three siblings. additional_tags is
-- append-only in Zendesk, which is what makes this honestly
-- idempotent (and non-destructive: it removes nothing).
insert into action_definitions (scope, tenant_id, category, action_key, label, description, provider, param_schema, risk, execution, status)
select 'platform', null, 'helpdesk', 'add_tags',
  'Tag / categorize a ticket',
  'Appends tags to a helpdesk ticket (never removes existing tags). Used by triage to categorize work — not visible to the customer.',
  'zendesk',
  '[
    {"name":"external_ref","type":"string","required":true,"help":"The ticket number to tag"},
    {"name":"tags","type":"string","required":true,"help":"Comma-separated tags to append (e.g. billing,priority-review)"}
  ]'::jsonb,
  '{"destructive": false, "idempotent": true}'::jsonb,
  '{"execution_key": "zendesk_add_tags"}'::jsonb,
  'active'
where not exists (
  select 1 from action_definitions
  where scope = 'platform' and category = 'helpdesk' and action_key = 'add_tags'
);
