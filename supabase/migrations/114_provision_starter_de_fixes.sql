-- Migration 114: provision_starter_de_internal was silently broken by
-- migration 108, and missing owner_id like create_digital_employee.
--
-- Found during a pre-onboarding go-live audit (2026-07-09), triggered
-- by the founder asking "will every NEW tenant actually see this
-- working" before adding their first real customer. Proved live (in a
-- rolled-back transaction) that this function's two ON CONFLICT
-- clauses — written before migration 108 widened trust_policies' and
-- de_autonomy's unique indexes to include de_id — no longer match
-- either real index at all:
--   ERROR 42P10: there is no unique or exclusion constraint matching
--   the ON CONFLICT specification
-- This is the SAME staleness class already found and fixed in
-- seed_trust_policies() (migration 108) and upsertAutonomy() (the
-- frontend) — but THIS call site was missed at the time, because it
-- lives in a different migration (068) than the one being edited.
-- Any tenant enabling the "Starter Account DE" or "Starter Finance
-- DE" feature flag today gets a hard SQL error instead of a
-- provisioned employee — this is not hypothetical, it was reproduced
-- live before writing this fix.
-- ============================================================
create or replace function provision_starter_de_internal(p_tenant_id uuid, p_feature_key text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_catalog_id  text;
  v_name        text;
  v_persona     text;
  v_description text;
  v_category    text;
  v_department  text;
  v_source_cat  text;
  v_playbook_key  text;
  v_playbook_name text;
  v_playbook_desc text;
  v_event_key   text;
  v_steps       jsonb;
  v_de_id       uuid;
  v_playbook_id uuid;
begin
  if p_feature_key = 'account_de' then
    v_catalog_id := 'starter_account_de';
    v_name := 'Account Success DE';
    v_persona := 'Riley';
    v_description := 'Watches account health and flags at-risk accounts for a human to follow up on. Starts with read/check-in access to CRM only — no financial systems.';
    v_category := 'Customer';
    v_department := 'Account Success';
    v_source_cat := 'crm';
    v_playbook_key := 'account_at_risk_checkin';
    v_playbook_name := 'Account At-Risk Check-In';
    v_playbook_desc := 'Fires when an account''s computed health flips to at-risk. Notices the signal and hands a follow-up checklist to a human — does not act on its own.';
    v_event_key := 'account_at_risk';
    v_steps := '[
      {"key":"check_account","label":"Check account","params":{}},
      {"key":"checklist","label":"Human follow-up","params":{"items":["Review why this account went at-risk","Reach out to the account contact","Decide whether a retention offer or escalation is needed"]}},
      {"key":"complete","label":"Done","params":{}}
    ]'::jsonb;
  elsif p_feature_key = 'finance_de' then
    v_catalog_id := 'starter_finance_de';
    v_name := 'Finance DE';
    v_persona := 'Morgan';
    v_description := 'Watches overdue invoices and flags them for a human to follow up on. Starts with access to financial records only — no CRM/relationship data.';
    v_category := 'Internal';
    v_department := 'Finance';
    v_source_cat := 'erp_financials';
    v_playbook_key := 'invoice_overdue_followup';
    v_playbook_name := 'Overdue Invoice Follow-Up';
    v_playbook_desc := 'Fires when an invoice goes overdue. Notices the signal and hands a follow-up checklist to a human — does not send anything on its own.';
    v_event_key := 'invoice_overdue';
    v_steps := '[
      {"key":"check_account","label":"Check account","params":{}},
      {"key":"checklist","label":"Human follow-up","params":{"items":["Review the overdue invoice","Reach out about payment","Decide whether a reminder or escalation is appropriate"]}},
      {"key":"complete","label":"Done","params":{}}
    ]'::jsonb;
  else
    return null; -- not a DE-provisioning feature — nothing to do
  end if;

  select id into v_de_id from digital_employees where tenant_id = p_tenant_id and catalog_id = v_catalog_id;

  if v_de_id is null then
    select id into v_de_id from digital_employees
    where tenant_id = p_tenant_id and name = v_name and catalog_id is null
    order by created_at asc
    limit 1;
  end if;

  if v_de_id is not null then
    update digital_employees
    set status = 'active', lifecycle_status = 'published', catalog_id = coalesce(catalog_id, v_catalog_id)
    where id = v_de_id;
  else
    insert into digital_employees (
      tenant_id, catalog_id, name, persona_name, description, category, department,
      status, lifecycle_status, trust_level, confidence_threshold, required_approval, tags, owner_id
    ) values (
      p_tenant_id, v_catalog_id, v_name, v_persona, v_description, v_category, v_department,
      'active', 'published', 'supervised', 75, false, array['auto_provisioned'], null
    )
    returning id into v_de_id;
  end if;

  insert into data_access_grants (tenant_id, subject_kind, subject_id, resource_kind, resource_category, permission, granted_by, note)
  values (p_tenant_id, 'de', v_de_id, 'category', v_source_cat, 'write_back', null,
    'Starter DE default access — provisioned automatically when this feature was turned on')
  on conflict (tenant_id, subject_kind, subject_id, resource_kind, coalesce(resource_id::text, resource_category))
  do update set permission = excluded.permission;

  insert into playbook_definitions (tenant_id, key, name, description, version, status, trigger_type, de_id, steps)
  values (p_tenant_id, v_playbook_key, v_playbook_name, v_playbook_desc, 1, 'published', 'event', v_de_id, v_steps)
  on conflict (tenant_id, key) do update set status = 'published', steps = excluded.steps, de_id = excluded.de_id
  returning id into v_playbook_id;

  if v_playbook_id is null then
    select id into v_playbook_id from playbook_definitions where tenant_id = p_tenant_id and key = v_playbook_key;
  end if;

  insert into playbook_versions (definition_id, version, steps, published_by)
  select v_playbook_id, 1, v_steps, null
  where not exists (select 1 from playbook_versions where definition_id = v_playbook_id);

  insert into de_playbook_charter (tenant_id, de_id, playbook_id, priority, active)
  values (p_tenant_id, v_de_id, v_playbook_id, 50, true)
  on conflict (de_id, playbook_id) do update set active = true, priority = 50;

  if not exists (
    select 1 from playbook_event_rules
    where tenant_id = p_tenant_id and definition_id = v_playbook_id and event_key = v_event_key
  ) then
    insert into playbook_event_rules (tenant_id, definition_id, event_key, params, cooldown_hours, active)
    values (p_tenant_id, v_playbook_id, v_event_key, '{}'::jsonb, 24, true);
  else
    update playbook_event_rules set active = true
    where tenant_id = p_tenant_id and definition_id = v_playbook_id and event_key = v_event_key;
  end if;

  -- Migration 108 widened this unique index to (tenant_id,
  -- action_category, coalesce(source_category,''), coalesce(de_id::
  -- text,'')) — this insert already provides a real de_id, so the
  -- fixed ON CONFLICT target correctly matches a PER-DE row here
  -- (not the tenant-wide default row), which is what this function
  -- has always meant to seed.
  insert into trust_policies (tenant_id, de_id, action_category, source_category, baseline_level, current_level, criteria)
  values (
    p_tenant_id, v_de_id, 'action_execute', v_source_cat, 0, 0,
    '{"window_days":30,"min_eval_pass_rate":0.9,"min_eval_samples":0,"min_human_approval_rate":0.9,"min_human_samples":3,"max_guardrail_blocks":0}'::jsonb
  )
  on conflict (tenant_id, action_category, coalesce(source_category, ''), coalesce(de_id::text, '')) do nothing;

  -- Deliberately kept tenant-wide (no de_id), matching this insert's
  -- original, unchanged intent — only the ON CONFLICT target needed
  -- fixing here, not the row's scope. (Unlike trust_policies just
  -- above, which was ALREADY per-DE in the original code.)
  insert into de_autonomy (tenant_id, action_type, source_category, enabled, max_amount_cents, min_confidence)
  values (p_tenant_id, 'action_execute', v_source_cat, false, null, null)
  on conflict (tenant_id, action_type, coalesce(source_category, ''), coalesce(de_id::text, '')) do nothing;

  perform append_audit_event_internal(
    p_tenant_id, 'DreamTeam', 'system',
    format('%s ("%s") provisioned — starter %s access, %s playbook charter, action_execute trust started at level 0 (gated).',
      v_name, v_persona, v_source_cat, v_playbook_name),
    'config_change',
    jsonb_build_object('kind', 'feature_de_provisioned', 'feature_key', p_feature_key, 'de_id', v_de_id, 'playbook_id', v_playbook_id)
  );

  return v_de_id;
end;
$function$;

-- Grants unchanged (same signature) — re-affirmed defensively.
revoke all on function provision_starter_de_internal(uuid, text) from public;
revoke all on function provision_starter_de_internal(uuid, text) from anon;
revoke all on function provision_starter_de_internal(uuid, text) from authenticated;
grant execute on function provision_starter_de_internal(uuid, text) to service_role;
