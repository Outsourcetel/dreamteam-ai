-- ============================================================
-- Migration 539: platform-scope WRITE actions for HubSpot (docs/40 P1).
--
-- HubSpot already has native READS (search_accounts/get_account/
-- search_conversations/search_opportunities under crm). This adds the write
-- side: three registered actions bound to the hubspot_log_note /
-- hubspot_create_task / hubspot_update_deal_stage native executors already
-- added to connector-hub (NATIVE_ACTIONS.hubspotActions).
--
-- Risk classification (what the gate reads):
--   log_account_note      — an internal CRM note, not customer-facing → NOT
--                            destructive (trust-gated, may auto-execute once
--                            the workspace's trust dial allows it)
--   create_followup_task  — an internal reminder → NOT destructive
--   update_deal_stage     — mutates pipeline state a human may be relying on
--                            → DESTRUCTIVE, always floored to a human
--                            (decide_action_execution checks this FIRST,
--                            before guardrails or trust are even consulted)
--
-- Same mig-217/520 shape: WHERE NOT EXISTS so re-apply never duplicates;
-- platform scope (tenant_id NULL) binds to ANY tenant's hubspot connector via
-- resolveActionDefinition. Reserved #539 against ledger max 538.
-- ============================================================
insert into action_definitions
  (scope, tenant_id, category, action_key, label, description, provider, execution, param_schema, risk, status)
select v.scope, v.tenant_id, v.category, v.action_key, v.label, v.description, v.provider,
       v.execution::jsonb, v.param_schema::jsonb, v.risk::jsonb, v.status
from (values
  ('platform', null::uuid, 'crm', 'log_account_note',
   'Log an account note',
   'Log an internal note on a HubSpot company — not visible to the customer.',
   'hubspot', '{"execution_key":"hubspot_log_note"}',
   '[{"name":"external_ref","type":"string","required":true,"help":"The HubSpot company id"},{"name":"note","type":"string","required":true,"help":"The note text"}]',
   '{"destructive":false,"idempotent":false}', 'active'),
  ('platform', null::uuid, 'crm', 'create_followup_task',
   'Create a follow-up task',
   'Create an internal follow-up task on a HubSpot company, due tomorrow.',
   'hubspot', '{"execution_key":"hubspot_create_task"}',
   '[{"name":"external_ref","type":"string","required":true,"help":"The HubSpot company id"},{"name":"subject","type":"string","required":true,"help":"Task subject"},{"name":"note","type":"string","required":false,"help":"Task detail"}]',
   '{"destructive":false,"idempotent":false}', 'active'),
  ('platform', null::uuid, 'crm', 'update_deal_stage',
   'Move a deal to a new stage',
   'Update a HubSpot deal''s pipeline stage. Always requires human approval.',
   'hubspot', '{"execution_key":"hubspot_update_deal_stage"}',
   '[{"name":"external_ref","type":"string","required":true,"help":"The HubSpot deal id"},{"name":"stage","type":"string","required":true,"help":"The target pipeline stage id"}]',
   '{"destructive":true,"idempotent":false}', 'active')
) as v(scope, tenant_id, category, action_key, label, description, provider, execution, param_schema, risk, status)
where not exists (
  select 1 from action_definitions ad
  where ad.scope = 'platform' and ad.category = 'crm'
    and ad.action_key = v.action_key and ad.provider = 'hubspot'
);

do $assert$
declare v_n int;
begin
  select count(*) into v_n from action_definitions
   where scope='platform' and category='crm' and provider='hubspot'
     and action_key in ('log_account_note','create_followup_task','update_deal_stage');
  if v_n <> 3 then raise exception 'mig 539: expected 3 hubspot actions, got %', v_n; end if;
  if exists (select 1 from action_definitions where scope='platform' and provider='hubspot'
             and action_key = 'update_deal_stage' and (risk->>'destructive') <> 'true') then
    raise exception 'mig 539: update_deal_stage is not marked destructive';
  end if;
end
$assert$;
