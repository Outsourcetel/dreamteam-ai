-- ============================================================
-- Migration 542: P3 — governed WRITE actions for support, people and
-- point-of-sale (docs/40 P3, after P1's money/CRM writes in 539+540).
--
-- Intercom and Gorgias reuse the EXACT canonical helpdesk keys zendesk and
-- freshdesk already established (add_internal_note / reply_to_ticket /
-- update_status), so a support playbook written once runs on whichever desk a
-- tenant actually has. BambooHR, Square and Shopify establish the first write
-- vocabulary for payroll_hcm and pos.
--
-- RISK BY EFFECT, as always — an internal note is not destructive; anything
-- the customer sees, anything that moves money, and anything that cancels an
-- order or decides someone's leave is:
--   internal notes (intercom/gorgias/shopify)        → NOT destructive
--   customer-visible replies (intercom/gorgias)      → DESTRUCTIVE
--   ticket status, order cancellation                → DESTRUCTIVE
--   time-off approve/deny (affects pay and staffing) → DESTRUCTIVE
--   square refund (moves money, amount_cents)        → DESTRUCTIVE
--
-- square refund_payment names its amount `amount_cents` — the registry money
-- convention — so the approval-threshold, spend-cap and trust-ceiling gates
-- engage and an unreadable amount fails closed to a human.
--
-- ⚠ GUSTO IS DELIBERATELY ABSENT. Its public API is read-centric; the write
-- surface is payroll-grade (running payroll, editing compensation). Rather
-- than register a guessed endpoint we cannot stand behind, Gusto stays
-- reads-only until a safe write is verified against a real account. BambooHR
-- carries the people-side write instead. Honest gap, recorded not hidden.
--
-- mig-217 shape: WHERE NOT EXISTS so re-apply never duplicates. Reserved #542
-- against ledger max 541.
-- ============================================================
insert into action_definitions
  (scope, tenant_id, category, action_key, label, description, provider, execution, param_schema, risk, status)
select v.scope, v.tenant_id, v.category, v.action_key, v.label, v.description, v.provider,
       v.execution::jsonb, v.param_schema::jsonb, v.risk::jsonb, v.status
from (values
  -- ── Intercom (helpdesk) ──
  ('platform', null::uuid, 'helpdesk', 'add_internal_note',
   'Add an internal note',
   'Add a private note to an Intercom conversation — teammates only, never shown to the customer.',
   'intercom', '{"execution_key":"intercom_add_note"}',
   '[{"name":"external_ref","type":"string","required":true,"help":"The Intercom conversation id"},{"name":"note","type":"string","required":true,"help":"The note text"},{"name":"admin_id","type":"string","required":true,"help":"The Intercom teammate id the note is posted as"}]',
   '{"destructive":false,"idempotent":false}', 'active'),
  ('platform', null::uuid, 'helpdesk', 'reply_to_ticket',
   'Reply to the customer',
   'Post a public reply on an Intercom conversation. The customer sees this, so it always requires human approval.',
   'intercom', '{"execution_key":"intercom_reply"}',
   '[{"name":"external_ref","type":"string","required":true,"help":"The Intercom conversation id"},{"name":"body","type":"string","required":true,"help":"The reply text"},{"name":"admin_id","type":"string","required":true,"help":"The Intercom teammate id the reply is sent as"}]',
   '{"destructive":true,"idempotent":false}', 'active'),

  -- ── Gorgias (helpdesk) ──
  ('platform', null::uuid, 'helpdesk', 'add_internal_note',
   'Add an internal note',
   'Add an internal note to a Gorgias ticket — agents only, never shown to the customer.',
   'gorgias', '{"execution_key":"gorgias_add_note"}',
   '[{"name":"external_ref","type":"string","required":true,"help":"The Gorgias ticket id"},{"name":"note","type":"string","required":true,"help":"The note text"}]',
   '{"destructive":false,"idempotent":false}', 'active'),
  ('platform', null::uuid, 'helpdesk', 'reply_to_ticket',
   'Reply to the customer',
   'Send a reply on a Gorgias ticket. The customer receives this, so it always requires human approval.',
   'gorgias', '{"execution_key":"gorgias_reply"}',
   '[{"name":"external_ref","type":"string","required":true,"help":"The Gorgias ticket id"},{"name":"body","type":"string","required":true,"help":"The reply text"}]',
   '{"destructive":true,"idempotent":false}', 'active'),
  ('platform', null::uuid, 'helpdesk', 'update_status',
   'Change the ticket status',
   'Open or close a Gorgias ticket. Always requires human approval.',
   'gorgias', '{"execution_key":"gorgias_update_status"}',
   '[{"name":"external_ref","type":"string","required":true,"help":"The Gorgias ticket id"},{"name":"status","type":"string","required":true,"help":"open or closed"}]',
   '{"destructive":true,"idempotent":true}', 'active'),

  -- ── BambooHR (payroll_hcm) — the people-side decision ──
  ('platform', null::uuid, 'payroll_hcm', 'update_time_off_status',
   'Approve or deny time off',
   'Approve or deny a BambooHR time-off request. This affects pay and staffing, so it always requires human approval.',
   'bamboohr', '{"execution_key":"bamboohr_time_off_decision"}',
   '[{"name":"external_ref","type":"string","required":true,"help":"The BambooHR time-off request id"},{"name":"status","type":"string","required":true,"help":"approved or denied"},{"name":"note","type":"string","required":false,"help":"Optional note recorded with the decision"}]',
   '{"destructive":true,"idempotent":true}', 'active'),

  -- ── Square (pos) ──
  ('platform', null::uuid, 'pos', 'refund_payment',
   'Refund a payment',
   'Refund a Square payment. This moves money out of your account and always requires human approval.',
   'square', '{"execution_key":"square_refund_payment"}',
   '[{"name":"external_ref","type":"string","required":true,"help":"The Square payment id"},{"name":"amount_cents","type":"number","required":true,"help":"Refund amount in cents (Square requires an explicit amount)"},{"name":"currency","type":"string","required":false,"help":"ISO currency code, defaults to USD"},{"name":"reason","type":"string","required":false,"help":"Reason recorded on the refund"}]',
   '{"destructive":true,"idempotent":false}', 'active'),

  -- ── Shopify (pos) ──
  ('platform', null::uuid, 'pos', 'add_order_note',
   'Add a note to the order',
   'Add an internal note to a Shopify order — staff-only, not shown to the customer.',
   'shopify', '{"execution_key":"shopify_add_order_note"}',
   '[{"name":"external_ref","type":"string","required":true,"help":"The Shopify order id"},{"name":"note","type":"string","required":true,"help":"The note text"}]',
   '{"destructive":false,"idempotent":true}', 'active'),
  ('platform', null::uuid, 'pos', 'cancel_order',
   'Cancel the order',
   'Cancel a Shopify order. The customer is notified by Shopify, so it always requires human approval.',
   'shopify', '{"execution_key":"shopify_cancel_order"}',
   '[{"name":"external_ref","type":"string","required":true,"help":"The Shopify order id"},{"name":"reason","type":"string","required":false,"help":"Cancellation reason (customer, declined, fraud, inventory, other)"}]',
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
   where scope='platform' and provider in ('intercom','gorgias','bamboohr','square','shopify');
  if v_n <> 9 then raise exception 'mig 542: expected 9 new P3 actions, got %', v_n; end if;

  -- customer-visible / money / state-changing must be floored to a human
  select string_agg(provider || '.' || action_key, ', ') into v_bad
    from action_definitions
   where scope='platform'
     and (provider, action_key) in (
       ('intercom','reply_to_ticket'), ('gorgias','reply_to_ticket'), ('gorgias','update_status'),
       ('bamboohr','update_time_off_status'), ('square','refund_payment'), ('shopify','cancel_order'))
     and (risk->>'destructive') is distinct from 'true';
  if v_bad is not null then
    raise exception 'mig 542: these must be destructive but are not: %', v_bad;
  end if;

  -- internal-only notes must NOT be destructive (else they can never auto-run)
  select string_agg(provider || '.' || action_key, ', ') into v_bad
    from action_definitions
   where scope='platform'
     and (provider, action_key) in (
       ('intercom','add_internal_note'), ('gorgias','add_internal_note'), ('shopify','add_order_note'))
     and (risk->>'destructive') is distinct from 'false';
  if v_bad is not null then
    raise exception 'mig 542: these internal actions are wrongly destructive: %', v_bad;
  end if;

  -- regression: the canonical helpdesk keys shared with zendesk/freshdesk must
  -- be untouched by this insert (NULL tenant_id keeps them distinct rows)
  if not exists (select 1 from action_definitions
                  where scope='platform' and provider='zendesk'
                    and action_key='add_internal_note' and (risk->>'destructive')='false')
     or not exists (select 1 from action_definitions
                     where scope='platform' and provider='freshdesk'
                       and action_key='reply_to_ticket' and (risk->>'destructive')='true') then
    raise exception 'mig 542: an existing zendesk/freshdesk helpdesk action was disturbed';
  end if;
end
$assert$;
