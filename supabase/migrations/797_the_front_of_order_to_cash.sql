-- 797_the_front_of_order_to_cash.sql
-- ==========================================================================
-- WHY: M1 of the practical-work program (spec 2026-08-11). Order-to-cash had
-- a middle and an end (invoice → chase → payment evidence) and no FRONT —
-- ERPNext's Quotation and Sales Order doctypes had no verbs, so "quote
-- generation" and "order taking" were job titles with no pipe. Three verbs
-- land (create_quotation, submit_quotation, quotation_to_sales_order;
-- executors in connector-hub), platform-scope so every tenant that connects
-- an ERP gets them (Always-Live), gated behind a NEW role arm:
--
--   sales_desk → bdr, sdr, front_desk, billing_ar
--
-- because quoting a price is a commercial act, not something every employee
-- holding the ERP connector may do (the mig-643 boundary, extended).
-- SUBMIT is the destructive one — a draft in the client's ERP is editable
-- and deletable there; a submitted quotation is a live offer.
--
-- de_may_use_action below is GENERATED from the live definition and edited
-- surgically (the mig-377 rule).
-- ==========================================================================

begin;

CREATE OR REPLACE FUNCTION public.de_may_use_action(p_tenant_id uuid, p_de_id uuid, p_action_definition_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(
    case
      when ad.requires_role is null then true
      when ad.requires_role = 'workforce_assistant'
        then coalesce(de.is_workforce_assistant, false)
      -- mig 669: the money desk. Reaching a CUSTOMER about their unpaid
      -- invoice is a finance act, not something every employee holding the
      -- ERP connector should be able to do.
      when ad.requires_role = 'finance'
        then coalesce(de.archetype_key, '') in ('billing_ar', 'accounting', 'fpa')
      -- Mig 797: the sales desk. Quoting a price and taking an order are
      -- commercial acts — the roles that face the customer commercially,
      -- not everyone holding the ERP connector.
      when ad.requires_role = 'sales_desk'
        then coalesce(de.archetype_key, '') in ('bdr', 'sdr', 'front_desk', 'billing_ar')
      -- No permissive else. An unrecognised requirement DENIES.
      else false
    end, false)
    from action_definitions ad
    left join digital_employees de
      on de.id = p_de_id and de.tenant_id = p_tenant_id
   where ad.id = p_action_definition_id;
$function$
;


insert into action_definitions (scope, tenant_id, category, action_key, label, description, provider, param_schema, risk, execution, status, reversible, rollback, requires_role)
select 'platform', null, 'erp_financials', 'create_quotation', 'Draft a quotation', 'Create a DRAFT quotation in the ERP for one item. Nothing is promised to the customer until a person submits it.', 'erpnext',
       '[{"name":"customer","type":"string","required":true,"help":"The ERPNext Customer name"},{"name":"item_code","type":"string","required":true,"help":"The ERPNext Item code being quoted"},{"name":"qty","type":"number","required":true,"help":"Quantity"},{"name":"rate","type":"number","required":true,"help":"Price per unit, in the ERP currency"},{"name":"valid_till","type":"string","required":false,"help":"Offer valid until (YYYY-MM-DD)"}]'::jsonb,
       '{"idempotent":false,"destructive":false}'::jsonb,
       '{"execution_key":"erpnext_create_quotation"}'::jsonb,
       'active', true, '{"how":"Delete the draft Quotation in ERPNext — drafts are deletable."}'::jsonb, 'sales_desk'
where not exists (
  select 1 from action_definitions
   where scope = 'platform' and provider = 'erpnext' and action_key = 'create_quotation'
);

insert into action_definitions (scope, tenant_id, category, action_key, label, description, provider, param_schema, risk, execution, status, reversible, rollback, requires_role)
select 'platform', null, 'erp_financials', 'submit_quotation', 'Submit a quotation', 'Submit a drafted quotation in the ERP, turning it into a live offer the customer can rely on. The committing act — always human-approved.', 'erpnext',
       '[{"name":"external_ref","type":"string","required":true,"help":"The quotation number in the ERP"}]'::jsonb,
       '{"idempotent":false,"destructive":true}'::jsonb,
       '{"execution_key":"erpnext_submit_quotation"}'::jsonb,
       'active', true, '{"how":"Cancel the submitted Quotation in ERPNext (docstatus 2)."}'::jsonb, 'sales_desk'
where not exists (
  select 1 from action_definitions
   where scope = 'platform' and provider = 'erpnext' and action_key = 'submit_quotation'
);

insert into action_definitions (scope, tenant_id, category, action_key, label, description, provider, param_schema, risk, execution, status, reversible, rollback, requires_role)
select 'platform', null, 'erp_financials', 'quotation_to_sales_order', 'Take the order', 'Create a DRAFT sales order from a submitted quotation, copying its lines verbatim. A person submits the order in the ERP.', 'erpnext',
       '[{"name":"external_ref","type":"string","required":true,"help":"The submitted quotation number"},{"name":"delivery_date","type":"string","required":true,"help":"Promised delivery date (YYYY-MM-DD)"}]'::jsonb,
       '{"idempotent":false,"destructive":false}'::jsonb,
       '{"execution_key":"erpnext_quotation_to_sales_order"}'::jsonb,
       'active', true, '{"how":"Delete the draft Sales Order in ERPNext — drafts are deletable."}'::jsonb, 'sales_desk'
where not exists (
  select 1 from action_definitions
   where scope = 'platform' and provider = 'erpnext' and action_key = 'quotation_to_sales_order'
);

do $$
declare n int;
begin
  select count(*) into n from action_definitions
   where scope='platform' and provider='erpnext'
     and action_key in ('create_quotation','submit_quotation','quotation_to_sales_order');
  if n <> 3 then raise exception 'expected 3 sales-desk definitions, found %', n; end if;
  select count(*) into n from action_definitions
   where scope='platform' and provider='erpnext' and action_key='create_quotation';
  if n <> 1 then raise exception 'create_quotation duplicated (%)', n; end if;
end $$;

commit;
