-- ============================================================
-- Migration 526: close the autonomous dunning chain for ERPNext.
--
-- The invoice_overdue trigger for outsourcetel-hq pointed at a summary
-- playbook that never proposed a dunning action. This seeds a real dunning
-- playbook whose connector_action proposes the (human-gated) erpnext
-- send_payment_reminder on the overdue invoice — using the {{invoice.external_ref}}
-- bridge so it writes back to the RIGHT ERP document — and repoints the rule at
-- it. Now: overdue ERP invoice → trigger → playbook → gated approval task
-- referencing the real invoice. Idempotent; reserved #526 vs ledger max 525.
-- Finance DE (f8c63e39) already holds the erp_financials write_back grant.
-- ============================================================
do $mig$
declare
  v_tenant uuid := '5bb802e1-8e92-4eef-9a7a-ac348785d43f';
  v_de     uuid := 'f8c63e39-8ec6-4500-8d7f-8d55df9a3ad9';
  v_rule   uuid := 'b0a30c70-731e-4e6f-9c84-d6a98622e0bd';
  v_def    uuid;
  v_steps  jsonb := $steps$[
    {"key":"check_account","label":"Check account","params":{}},
    {"key":"connector_action","label":"Send payment reminder","params":{
      "action_key":"send_payment_reminder",
      "action_category":"erp_financials",
      "param_templates":{
        "external_ref":"{{invoice.external_ref}}",
        "note":"Payment reminder for {{account.name}} — invoice {{invoice.external_ref}} is overdue. Courtesy reminder from the AR desk; please arrange payment."
      }
    }},
    {"key":"complete","label":"Done","params":{}}
  ]$steps$::jsonb;
begin
  select id into v_def from playbook_definitions
   where tenant_id = v_tenant and key = 'erpnext_dunning_reminder';

  if v_def is null then
    insert into playbook_definitions (tenant_id, key, name, description, version, status, steps, trigger_type, de_id)
    values (v_tenant, 'erpnext_dunning_reminder', 'ERPNext Dunning — Payment Reminder',
            'When an ERP invoice goes overdue, propose a courtesy payment reminder on that invoice in the ERP — always human-gated.',
            1, 'published', v_steps, 'event', v_de)
    returning id into v_def;

    insert into playbook_versions (definition_id, version, steps, published_at)
    values (v_def, 1, v_steps, now());
  else
    update playbook_definitions set steps = v_steps, status = 'published', updated_at = now() where id = v_def;
  end if;

  update playbook_event_rules set definition_id = v_def
   where id = v_rule and tenant_id = v_tenant;
end
$mig$;

do $assert$
declare v_def uuid; v_rule_def uuid;
begin
  select id into v_def from playbook_definitions
   where tenant_id = '5bb802e1-8e92-4eef-9a7a-ac348785d43f' and key = 'erpnext_dunning_reminder' and status = 'published';
  if v_def is null then raise exception 'mig 526: dunning def not published'; end if;
  if not exists (select 1 from playbook_versions where definition_id = v_def) then
    raise exception 'mig 526: no published version for the dunning def';
  end if;
  select definition_id into v_rule_def from playbook_event_rules where id = 'b0a30c70-731e-4e6f-9c84-d6a98622e0bd';
  if v_rule_def is distinct from v_def then raise exception 'mig 526: invoice_overdue rule not repointed'; end if;
end
$assert$;
