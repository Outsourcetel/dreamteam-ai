-- 802_an_action_that_lands_in_the_ledger.sql
-- ==========================================================================
-- WHY: M2 of the practical-work program. July's audit, verbatim: "ZERO
-- actions post to a ledger … until an action can land in the ledger, every
-- finance DE is a report writer." posting_drafts (mig 531) built the safe
-- middle leg — a balanced, evidence-cited proposal a person can judge — and
-- nothing could carry an approved draft the last step into the books.
--
-- Two definitions land (executors in connector-hub):
--   · payment_entry_for_invoice — built by ERPNext's own get_payment_entry
--     mapper (hand-assembling account heads is how a wrong ledger looks
--     right), optional partial amount, refuses ambiguous multi-document
--     allocations, SUBMITS — the human already approved at our gate, and a
--     gate that ends in a draft is the report-writer problem in a receipt.
--   · create_journal_entry — one balanced DR/CR pair, remark REQUIRED (a
--     journal line with no story is unauditable), SUBMITS.
-- Both destructive (they book money), both behind the existing finance arm
-- (billing_ar / accounting / fpa) — the mig-643 boundary.
-- ==========================================================================

begin;

insert into action_definitions (scope, tenant_id, category, action_key, label, description, provider, param_schema, risk, execution, status, reversible, rollback, requires_role)
select 'platform', null, 'erp_financials', 'payment_entry_for_invoice', 'Book a payment against an invoice',
       'Record a customer payment against a specific invoice and SUBMIT it to the ledger. Built by the ERP''s own invoice-to-payment mapper. Omit amount to book the full outstanding.',
       'erpnext',
       '[{"name":"external_ref","type":"string","required":true,"help":"The Sales Invoice number"},
         {"name":"amount","type":"number","required":false,"help":"Partial amount; omit for the full outstanding"}]'::jsonb,
       '{"idempotent":false,"destructive":true}'::jsonb,
       '{"execution_key":"erpnext_payment_entry_for_invoice"}'::jsonb,
       'active', true,
       '{"how":"Cancel the submitted Payment Entry in ERPNext (docstatus 2) — the booking is reversed in the ledger."}'::jsonb,
       'finance'
where not exists (select 1 from action_definitions where scope='platform' and provider='erpnext' and action_key='payment_entry_for_invoice');

insert into action_definitions (scope, tenant_id, category, action_key, label, description, provider, param_schema, risk, execution, status, reversible, rollback, requires_role)
select 'platform', null, 'erp_financials', 'create_journal_entry', 'Post a journal entry',
       'Post one balanced journal entry (a single debit/credit pair) and SUBMIT it to the ledger. The remark is required — every line must carry its story.',
       'erpnext',
       '[{"name":"debit_account","type":"string","required":true,"help":"Account to debit (exact ERP account name)"},
         {"name":"credit_account","type":"string","required":true,"help":"Account to credit"},
         {"name":"amount","type":"number","required":true,"help":"Amount"},
         {"name":"remark","type":"string","required":true,"help":"Why this entry exists"},
         {"name":"posting_date","type":"string","required":false,"help":"YYYY-MM-DD; defaults to today"}]'::jsonb,
       '{"idempotent":false,"destructive":true}'::jsonb,
       '{"execution_key":"erpnext_create_journal_entry"}'::jsonb,
       'active', true,
       '{"how":"Cancel the submitted Journal Entry in ERPNext (docstatus 2)."}'::jsonb,
       'finance'
where not exists (select 1 from action_definitions where scope='platform' and provider='erpnext' and action_key='create_journal_entry');

do $$
declare n int;
begin
  select count(*) into n from action_definitions
   where scope='platform' and provider='erpnext'
     and action_key in ('payment_entry_for_invoice','create_journal_entry');
  if n <> 2 then raise exception 'expected 2 ledger definitions, found %', n; end if;
end $$;

commit;
