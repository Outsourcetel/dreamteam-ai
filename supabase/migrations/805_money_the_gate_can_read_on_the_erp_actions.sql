-- 805_money_the_gate_can_read_on_the_erp_actions.sql
-- ============================================================================
-- Register A-11. Two ACTIVE, platform-scope, DESTRUCTIVE actions created by
-- mig 802 declare their money as `amount`:
--
--   payment_entry_for_invoice   Book a payment against an invoice
--   create_journal_entry        Post a journal entry
--
-- connector-hub reads the amount out of a param named EXACTLY `amount_cents`
-- and passes it as p_amount_cents. Anything else reaches
-- decide_action_execution with p_amount_cents = NULL — which switches OFF the
-- approval threshold, the spend caps and the trust ceiling FOR THOSE ACTIONS
-- ALONE, in every tenant, with no error anywhere. Two destructive money-moving
-- actions were ungated.
--
-- ── Why this is not just a rename ──────────────────────────────────────────
-- The obvious fix — s/amount/amount_cents/ — would have been WRONG, and
-- quietly. The value is handed straight to ERPNext by connector-hub:
--
--     doc.paid_amount = amt;  doc.received_amount = amt;
--     refs[0].allocated_amount = amt;
--     { account: …, debit_in_account_currency: amt }
--
-- Those ERPNext fields are CURRENCY UNITS, not cents. So the param has always
-- carried dollars. Renaming it alone would make the gate read 1500.00 as
-- fifteen dollars — a 100x UNDER-count on a destructive action, which is a
-- quieter bypass than the one being closed: the gate would look armed and
-- would wave through a payment a hundred times over its threshold.
--
-- So the unit changes with the name — the param becomes integer CENTS, which
-- is what every other money param in this system already is (mig 643's
-- amount_cents is the only thing the gates read) — and connector-hub divides
-- by 100 at the ERPNext boundary. The two halves ship together; this migration
-- is inert without the connector-hub change in the same commit.
--
-- ── Safe to change in place ────────────────────────────────────────────────
-- Measured before writing, not assumed: 0 action_executions reference either
-- action, and 0 rows anywhere carry a param named `amount`, so there is no
-- stored payload to migrate and no in-flight approval whose params would stop
-- matching their schema. ERPNext has also been dead since 2026-08-11
-- (consecutive_failures 8402), so nothing can execute during the change.
-- ============================================================================

begin;

-- Optional param: omitting it still books the full outstanding.
update action_definitions ad
   set param_schema = (
         select jsonb_agg(
                  case when p->>'name' = 'amount'
                       then jsonb_set(jsonb_set(p, '{name}', '"amount_cents"'), '{type}', '"integer"')
                            || jsonb_build_object('help', 'Partial amount IN CENTS (150000 = 1,500.00); omit to book the full outstanding')
                       else p end
                  order by ord)
           from jsonb_array_elements(ad.param_schema) with ordinality as t(p, ord)),
       updated_at = now()
 where ad.scope = 'platform' and ad.provider = 'erpnext'
   and ad.action_key = 'payment_entry_for_invoice'
   and jsonb_typeof(ad.param_schema) = 'array';

-- Required param.
update action_definitions ad
   set param_schema = (
         select jsonb_agg(
                  case when p->>'name' = 'amount'
                       then jsonb_set(jsonb_set(p, '{name}', '"amount_cents"'), '{type}', '"integer"')
                            || jsonb_build_object('help', 'Amount IN CENTS (150000 = 1,500.00)')
                       else p end
                  order by ord)
           from jsonb_array_elements(ad.param_schema) with ordinality as t(p, ord)),
       updated_at = now()
 where ad.scope = 'platform' and ad.provider = 'erpnext'
   and ad.action_key = 'create_journal_entry'
   and jsonb_typeof(ad.param_schema) = 'array';

-- ── Proof ───────────────────────────────────────────────────────────────────
-- Phrased as the ABSENCE OF A VIOLATION, per CLAUDE.md rule 3, so it is
-- vacuously true on an environment that holds none of these rows and still
-- catches every real one. This is the same predicate tests/action-gate.test.ts
-- asserts, deliberately — one definition of "money the gate cannot read", not
-- two that can drift apart.
do $$
declare
  v_bad text;
begin
  select string_agg(distinct ad.action_key || '.' || (p->>'name'), ', ')
    into v_bad
    from action_definitions ad, jsonb_array_elements(ad.param_schema) p
   where jsonb_typeof(ad.param_schema) = 'array'
     and p->>'name' ~* '(^|_)(amount|amounts|cents|price|prices|total|totals|money|charge|fee|cost)($|_)'
     and p->>'name' <> 'amount_cents'
     and p->>'name' <> 'default_price_list';

  if v_bad is not null then
    raise exception '805: money the gate will never read is still declared on: %. connector-hub reads only amount_cents, so these reach decide_action_execution with p_amount_cents = NULL and no threshold applies.', v_bad;
  end if;

  -- The other half of the same worry: a param renamed to amount_cents but left
  -- typed as a fractional number would invite dollars back in under the right
  -- name, which the check above cannot see.
  select string_agg(distinct ad.action_key, ', ')
    into v_bad
    from action_definitions ad, jsonb_array_elements(ad.param_schema) p
   where jsonb_typeof(ad.param_schema) = 'array'
     and p->>'name' = 'amount_cents'
     and coalesce(p->>'type', '') not in ('integer', 'number');

  if v_bad is not null then
    raise exception '805: amount_cents is declared with a type that is not integer on: %', v_bad;
  end if;
end $$;

commit;
