-- 217_freshdesk_helpdesk_actions.sql
-- ============================================================================
-- EXEC-1 — Support executes across the helpdesk CATEGORY, not just Zendesk.
--
-- The app already speaks the canonical helpdesk vocabulary (reply_to_ticket,
-- add_internal_note, update_status, add_tags) and connector-hub routes each to
-- the connector's provider. Zendesk had the write-side; this registers the SAME
-- four canonical actions for Freshdesk, executed by the freshdesk_* native
-- executors added in connector-hub. A Support DE now works a Freshdesk ticket
-- exactly as it works a Zendesk one.
--
-- Platform-scoped → every tenant gets these the moment they connect a Freshdesk
-- connector. resolveActionDefinition now picks the platform row whose provider
-- matches the connector, so Freshdesk and Zendesk never cross-fire.
-- Same risk profile as Zendesk: a public reply and a status change are
-- destructive (always gate for approval); a private note and tags are not.
-- ============================================================================

INSERT INTO action_definitions (category, action_key, provider, scope, status, label, param_schema, risk, execution)
SELECT * FROM (VALUES
  ('helpdesk', 'add_internal_note', 'freshdesk', 'platform', 'active', 'Add an internal note (Freshdesk)',
   '[{"name":"external_ref","type":"string","required":true,"help":"The ticket id to add the note to"},{"name":"note","type":"string","required":true,"help":"The private note text (not visible to the customer)"}]'::jsonb,
   '{"idempotent":false,"destructive":false}'::jsonb,
   '{"execution_key":"freshdesk_add_internal_note"}'::jsonb),

  ('helpdesk', 'reply_to_ticket', 'freshdesk', 'platform', 'active', 'Reply to the customer (Freshdesk)',
   '[{"name":"external_ref","type":"string","required":true,"help":"The ticket id to reply on"},{"name":"body","type":"string","required":true,"help":"The reply text the customer will see"}]'::jsonb,
   '{"idempotent":false,"destructive":true}'::jsonb,
   '{"execution_key":"freshdesk_reply_to_ticket"}'::jsonb),

  ('helpdesk', 'update_status', 'freshdesk', 'platform', 'active', 'Update ticket status (Freshdesk)',
   '[{"name":"external_ref","type":"string","required":true,"help":"The ticket id to update"},{"name":"status","type":"string","required":true,"help":"One of: open, pending, resolved, closed"}]'::jsonb,
   '{"idempotent":true,"destructive":true}'::jsonb,
   '{"execution_key":"freshdesk_update_status"}'::jsonb),

  ('helpdesk', 'add_tags', 'freshdesk', 'platform', 'active', 'Tag the ticket (Freshdesk)',
   '[{"name":"external_ref","type":"string","required":true,"help":"The ticket id to tag"},{"name":"tags","type":"string","required":true,"help":"Comma-separated tags to add (e.g. billing,priority-review)"}]'::jsonb,
   '{"idempotent":true,"destructive":false}'::jsonb,
   '{"execution_key":"freshdesk_add_tags"}'::jsonb)
) AS v(category, action_key, provider, scope, status, label, param_schema, risk, execution)
WHERE NOT EXISTS (
  SELECT 1 FROM action_definitions a
  WHERE a.category = v.category AND a.action_key = v.action_key AND a.provider = v.provider AND a.scope = v.scope
);
