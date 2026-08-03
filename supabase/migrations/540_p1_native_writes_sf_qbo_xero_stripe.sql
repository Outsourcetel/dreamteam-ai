-- ============================================================
-- Migration 540: P1 completion — governed WRITE actions for Salesforce,
-- QuickBooks, Xero and Stripe (docs/40 P1, following 539's HubSpot slice).
--
-- These four join HubSpot + ERPNext + the five support systems in the
-- governed-write tier. The read side already existed for all four.
--
-- CANONICAL KEYS, PER-PROVIDER RISK. The action_keys deliberately match their
-- category siblings (crm: log_account_note / create_followup_task /
-- update_deal_stage; erp_financials + billing: send_payment_reminder) so one
-- playbook runs on whichever brand a tenant actually has. Postgres treats the
-- NULL tenant_id in UNIQUE (scope, tenant_id, category, action_key) as
-- distinct, so these sit beside ERPNext's rows exactly as freshdesk sits
-- beside zendesk (verified against live data before writing this).
--
-- The RISK differs per provider even where the key is shared, because the
-- real-world effect differs — this is the honest part:
--   ERPNext send_payment_reminder  → an internal ledger note   → NOT destructive
--   QuickBooks / Xero / Stripe     → EMAILS THE CUSTOMER       → DESTRUCTIVE
--   stripe refund_payment          → MOVES MONEY               → DESTRUCTIVE
-- Destructive actions are floored to a human by decide_action_execution before
-- guardrails or trust are consulted — they can never auto-execute.
--
-- refund_payment's amount param is named `amount_cents`, the registry's money
-- convention, so the approval-threshold / spend-cap / trust-ceiling gates all
-- engage and an unreadable amount fails closed to a human.
--
-- mig-217 shape: WHERE NOT EXISTS so re-apply never duplicates. Reserved #540
-- against ledger max 539.
-- ============================================================
insert into action_definitions
  (scope, tenant_id, category, action_key, label, description, provider, execution, param_schema, risk, status)
select v.scope, v.tenant_id, v.category, v.action_key, v.label, v.description, v.provider,
       v.execution::jsonb, v.param_schema::jsonb, v.risk::jsonb, v.status
from (values
  -- ── Salesforce (crm) ──
  ('platform', null::uuid, 'crm', 'log_account_note',
   'Log an account note',
   'Log an internal activity note on a Salesforce account or opportunity — not visible to the customer.',
   'salesforce', '{"execution_key":"salesforce_log_note"}',
   '[{"name":"external_ref","type":"string","required":true,"help":"The Salesforce Account or Opportunity id"},{"name":"note","type":"string","required":true,"help":"The note text"},{"name":"subject","type":"string","required":false,"help":"Activity subject line"}]',
   '{"destructive":false,"idempotent":false}', 'active'),
  ('platform', null::uuid, 'crm', 'create_followup_task',
   'Create a follow-up task',
   'Create an internal follow-up task on a Salesforce record, due tomorrow.',
   'salesforce', '{"execution_key":"salesforce_create_task"}',
   '[{"name":"external_ref","type":"string","required":true,"help":"The Salesforce Account or Opportunity id"},{"name":"subject","type":"string","required":true,"help":"Task subject"},{"name":"note","type":"string","required":false,"help":"Task detail"}]',
   '{"destructive":false,"idempotent":false}', 'active'),
  ('platform', null::uuid, 'crm', 'update_deal_stage',
   'Move an opportunity to a new stage',
   'Update a Salesforce opportunity''s StageName. Always requires human approval.',
   'salesforce', '{"execution_key":"salesforce_update_opportunity_stage"}',
   '[{"name":"external_ref","type":"string","required":true,"help":"The Salesforce Opportunity id"},{"name":"stage","type":"string","required":true,"help":"The target StageName"}]',
   '{"destructive":true,"idempotent":false}', 'active'),

  -- ── QuickBooks (erp_financials) — sending emails the customer ──
  ('platform', null::uuid, 'erp_financials', 'send_payment_reminder',
   'Email the invoice to the customer',
   'Send a QuickBooks invoice to the customer by email. The customer receives this, so it always requires human approval.',
   'quickbooks', '{"execution_key":"quickbooks_send_invoice_reminder"}',
   '[{"name":"external_ref","type":"string","required":true,"help":"The QuickBooks invoice id"},{"name":"email","type":"string","required":false,"help":"Override recipient address (defaults to the invoice''s billing email)"}]',
   '{"destructive":true,"idempotent":false}', 'active'),

  -- ── Xero (erp_financials) ──
  ('platform', null::uuid, 'erp_financials', 'send_payment_reminder',
   'Email the invoice to the customer',
   'Send a Xero invoice to the customer by email. The customer receives this, so it always requires human approval.',
   'xero', '{"execution_key":"xero_send_invoice_reminder"}',
   '[{"name":"external_ref","type":"string","required":true,"help":"The Xero InvoiceID"}]',
   '{"destructive":true,"idempotent":false}', 'active'),
  ('platform', null::uuid, 'erp_financials', 'log_invoice_note',
   'Log a note on the invoice',
   'Add an internal history note to a Xero invoice — not visible to the customer.',
   'xero', '{"execution_key":"xero_log_invoice_note"}',
   '[{"name":"external_ref","type":"string","required":true,"help":"The Xero InvoiceID"},{"name":"note","type":"string","required":true,"help":"The note text"}]',
   '{"destructive":false,"idempotent":false}', 'active'),

  -- ── Stripe (billing) ──
  ('platform', null::uuid, 'billing', 'send_payment_reminder',
   'Email the invoice to the customer',
   'Send a Stripe invoice to the customer by email. The customer receives this, so it always requires human approval.',
   'stripe', '{"execution_key":"stripe_send_invoice_reminder"}',
   '[{"name":"external_ref","type":"string","required":true,"help":"The Stripe invoice id (in_…)"}]',
   '{"destructive":true,"idempotent":false}', 'active'),
  ('platform', null::uuid, 'billing', 'refund_payment',
   'Refund a payment',
   'Refund a Stripe payment, in full or in part. This moves money out of your account and always requires human approval.',
   'stripe', '{"execution_key":"stripe_refund_payment"}',
   '[{"name":"external_ref","type":"string","required":true,"help":"The Stripe PaymentIntent id (pi_…)"},{"name":"amount_cents","type":"number","required":false,"help":"Partial refund amount in cents; omit to refund in full"}]',
   '{"destructive":true,"idempotent":false}', 'active')
) as v(scope, tenant_id, category, action_key, label, description, provider, execution, param_schema, risk, status)
where not exists (
  select 1 from action_definitions ad
  where ad.scope = 'platform' and ad.category = v.category
    and ad.action_key = v.action_key and ad.provider = v.provider
);

do $assert$
declare v_n int; v_bad text;
begin
  select count(*) into v_n from action_definitions
   where scope='platform' and provider in ('salesforce','quickbooks','xero','stripe');
  if v_n <> 8 then raise exception 'mig 540: expected 8 new P1 actions, got %', v_n; end if;

  -- every customer-facing / money action must be floored to a human
  select string_agg(provider || '.' || action_key, ', ') into v_bad
    from action_definitions
   where scope='platform'
     and (provider, action_key) in (
       ('quickbooks','send_payment_reminder'), ('xero','send_payment_reminder'),
       ('stripe','send_payment_reminder'), ('stripe','refund_payment'),
       ('salesforce','update_deal_stage'))
     and (risk->>'destructive') is distinct from 'true';
  if v_bad is not null then
    raise exception 'mig 540: these must be destructive but are not: %', v_bad;
  end if;

  -- the internal-only ones must NOT be destructive (else they can never auto-run)
  select string_agg(provider || '.' || action_key, ', ') into v_bad
    from action_definitions
   where scope='platform'
     and (provider, action_key) in (
       ('salesforce','log_account_note'), ('salesforce','create_followup_task'),
       ('xero','log_invoice_note'))
     and (risk->>'destructive') is distinct from 'false';
  if v_bad is not null then
    raise exception 'mig 540: these internal actions are wrongly destructive: %', v_bad;
  end if;

  -- regression: ERPNext's non-destructive reminder must be untouched by the
  -- shared-key insert above
  if not exists (select 1 from action_definitions
                  where scope='platform' and provider='erpnext'
                    and action_key='send_payment_reminder' and (risk->>'destructive')='false') then
    raise exception 'mig 540: erpnext send_payment_reminder was disturbed';
  end if;
end
$assert$;
