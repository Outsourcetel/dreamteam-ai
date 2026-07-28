-- ============================================================
-- Migration 520: platform-scope dunning ACTION DEFINITIONS for ERPNext.
--
-- The write side of the AR story: three registered actions the workforce can
-- take on an overdue invoice, all executed by the erpnext_invoice_comment
-- native executor (a note on the invoice's ERP timeline). They differ only in
-- RISK, which is what the action gate reads:
--   * send_payment_reminder — not destructive (trust-gated)
--   * send_final_notice     — destructive (floor-gated to a human, always)
--   * flag_for_collections  — destructive (floor-gated to a human, always)
--
-- ERPNext is the first native provider for erp_financials actions (mig 043's
-- rows were tenant-scoped template actions for one demo tenant). Platform
-- scope + provider='erpnext' means resolveActionDefinition binds these to any
-- tenant's erpnext connector automatically. mig-217-shaped WHERE NOT EXISTS so
-- re-apply never duplicates (platform rows carry NULL tenant_id, which a UNIQUE
-- constraint treats as distinct). Renumbered to #520: a parallel stream took
-- 518-519 after I first drafted this (and 514 ended up doubly-numbered — my
-- provider migration + their urgency one, both applied, cosmetic).
-- ============================================================
insert into action_definitions
  (scope, tenant_id, category, action_key, label, description, provider, execution, param_schema, risk, status)
select v.scope, v.tenant_id, v.category, v.action_key, v.label, v.description, v.provider,
       v.execution::jsonb, v.param_schema::jsonb, v.risk::jsonb, v.status
from (values
  ('platform', null::uuid, 'erp_financials', 'send_payment_reminder',
   'Send a payment reminder',
   'Log a courtesy payment-reminder note on an overdue invoice in the ERP.',
   'erpnext', '{"execution_key":"erpnext_invoice_comment"}',
   '[{"name":"external_ref","type":"string","required":true,"help":"The invoice number in the ERP"},{"name":"note","type":"string","required":true,"help":"The reminder text"}]',
   '{"destructive":false,"idempotent":false}', 'active'),
  ('platform', null::uuid, 'erp_financials', 'send_final_notice',
   'Send a final notice',
   'Log a final-notice note on a significantly overdue invoice in the ERP. Always requires human approval.',
   'erpnext', '{"execution_key":"erpnext_invoice_comment"}',
   '[{"name":"external_ref","type":"string","required":true,"help":"The invoice number in the ERP"},{"name":"note","type":"string","required":true,"help":"The final-notice text"}]',
   '{"destructive":true,"idempotent":false}', 'active'),
  ('platform', null::uuid, 'erp_financials', 'flag_for_collections',
   'Flag for collections',
   'Log a collections-referral note on an invoice in the ERP. Always requires human approval.',
   'erpnext', '{"execution_key":"erpnext_invoice_comment"}',
   '[{"name":"external_ref","type":"string","required":true,"help":"The invoice number in the ERP"},{"name":"note","type":"string","required":true,"help":"The collections note"}]',
   '{"destructive":true,"idempotent":false}', 'active')
) as v(scope, tenant_id, category, action_key, label, description, provider, execution, param_schema, risk, status)
where not exists (
  select 1 from action_definitions ad
  where ad.scope = 'platform' and ad.category = 'erp_financials'
    and ad.action_key = v.action_key and ad.provider = 'erpnext'
);

do $assert$
declare v_n int;
begin
  select count(*) into v_n from action_definitions
   where scope='platform' and category='erp_financials' and provider='erpnext'
     and action_key in ('send_payment_reminder','send_final_notice','flag_for_collections');
  if v_n <> 3 then raise exception 'mig 520: expected 3 erpnext dunning actions, got %', v_n; end if;
  -- the two destructive ones must be classified so the gate floors them
  if exists (select 1 from action_definitions where scope='platform' and provider='erpnext'
             and action_key in ('send_final_notice','flag_for_collections') and (risk->>'destructive') <> 'true') then
    raise exception 'mig 520: a final-notice/collections action is not marked destructive';
  end if;
end
$assert$;
