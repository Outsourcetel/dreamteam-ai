-- 651_the_first_configure_verb.sql
-- ============================================================================
-- Every one of the 68 active actions is a note, a reply, a tag, a reminder, a
-- post or an admin verb. Not one of them CONFIGURES anything for a customer.
-- That is why `action_executions` shows 186 rows and not a single one whose
-- origin is an employee doing its job: there has never been a job to do.
--
-- This registers the first. `configure_customer_setup` sets a customer's
-- defaults in ERPNext — customer group, territory, price list, payment terms —
-- the kind of change an onboarding employee makes to take a signed-up customer
-- to a working setup.
--
-- DESTRUCTIVE = TRUE, deliberately, and it is not a judgement about how risky
-- these four fields are. `decide_action_execution` checks the destructive floor
-- BEFORE trust: destructive => human_gated_destructive, always, regardless of
-- how trusted the employee becomes. For the first verb that reaches into a real
-- customer's record, "a person sees every one of these" is the correct setting
-- and can be relaxed later on evidence. It cannot be un-relaxed after an
-- incident.
--
-- REVERSIBLE = TRUE, and honoured rather than asserted: the executor reads the
-- record BEFORE writing and the receipt names each change as `was → now`, so
-- there is something concrete to put back. A receipt carrying only the new
-- value makes "reversible" a word.
--
-- NO amount_cents PARAM, and that is deliberate too. `execute_action` reads the
-- money only from a parameter named exactly `amount_cents`; naming a param
-- anything else silently disarms the approval threshold, the spend cap and the
-- trust ceiling (mig 586). This action moves no money, so it carries no such
-- param and no money gate is implied.
--
-- The FIELD LIST is not here. It lives in the executor, because Frappe accepts a
-- PUT for any field on the Customer doctype — tax ids, credit limits,
-- `disabled`. The model picks the VALUES; it never picks which fields exist.
-- ============================================================================

begin;

insert into action_definitions
  (scope, tenant_id, category, action_key, label, description, provider,
   param_schema, risk, execution, status, reversible)
values (
  'platform', null, 'erp_financials', 'configure_customer_setup',
  'Configure a customer''s setup',
  'Set a customer''s defaults in ERPNext as part of onboarding — customer group, territory, price list or payment terms. Give the ERPNext Customer name plus only the settings you actually need to change. Read the record first and change one thing at a time; a person approves every one of these before it runs.',
  'erpnext',
  jsonb_build_array(
    jsonb_build_object('name','external_ref','type','string','required',true,
      'help','The Customer name in ERPNext (not the invoice, not our account id)'),
    jsonb_build_object('name','customer_group','type','string','required',false,
      'help','e.g. Commercial, Government — must already exist in ERPNext'),
    jsonb_build_object('name','territory','type','string','required',false,
      'help','e.g. United Kingdom — must already exist in ERPNext'),
    jsonb_build_object('name','default_price_list','type','string','required',false,
      'help','the price list this customer should be billed from'),
    jsonb_build_object('name','payment_terms','type','string','required',false,
      'help','the payment terms template, e.g. Net 30')),
  jsonb_build_object('destructive', true, 'idempotent', true),
  jsonb_build_object('execution_key', 'erpnext_set_customer_defaults'),
  'active', true)
on conflict do nothing;

-- ── Prove it is registered the way the gates actually read it. ────────────
do $$
declare a action_definitions;
begin
  select * into a from action_definitions
   where action_key = 'configure_customer_setup' and provider = 'erpnext' and status = 'active';
  if a.id is null then raise exception '651: the configure action did not register'; end if;

  -- The destructive floor is what makes "a person sees every one" true.
  if coalesce((a.risk->>'destructive')::boolean, false) is not true then
    raise exception '651: the first configure verb is not floored to human approval';
  end if;

  -- An execution_key that no executor answers to is an action that is offered
  -- and then fails at the moment of truth. connector-hub owns the other side;
  -- this asserts the contract exists on ours.
  if coalesce(a.execution->>'execution_key', '') <> 'erpnext_set_customer_defaults' then
    raise exception '651: execution_key does not name the executor';
  end if;

  -- The money-gate trap: any numeric param whose name looks like money but is
  -- not exactly amount_cents disarms the spend controls silently.
  if exists (select 1 from jsonb_array_elements(a.param_schema) p
              where (p->>'type') in ('integer','number')
                and (p->>'name') ~* '(budget|amount|cents|price|spend)'
                and (p->>'name') <> 'amount_cents') then
    raise exception '651: a money-shaped param would disarm the spend gates';
  end if;

  -- It must be reachable by the role that needs it, and by nobody who does not.
  -- (mig 643: requires_role null = no role restriction; the connector grant is
  -- what scopes this one.)
  if a.requires_role is not null then
    raise exception '651: a configure verb should be scoped by connector access, not pinned to one role';
  end if;

  raise notice '651: configure_customer_setup registered — destructive floor on, reversible, no money param';
end $$;

commit;
