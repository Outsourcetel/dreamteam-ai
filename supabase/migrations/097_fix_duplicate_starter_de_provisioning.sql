-- ============================================================
-- Migration 097: fix a real found bug — migration 068's starter DE
-- provisioning created a DUPLICATE "Account Success DE"/"Finance DE"
-- row for any tenant that already had a same-named DE predating the
-- `catalog_id` column, because provision_starter_de_internal's
-- existence check only matched on `catalog_id`. Confirmed live: Acme
-- Telecom (a1b2c3d4-0000-0000-0000-000000000001) has exactly this —
-- an older DE (catalog_id null, created 2026-07-06, holding all real
-- evidence_runs/evidence_run_decisions history) and a newer
-- "starter_*" duplicate (created 2026-07-07 by migration 068's
-- backfill loop, zero real activity). Found while building the
-- Performance & Insights page (migration 093) — its per-DE metrics
-- would otherwise silently split/hide real activity behind whichever
-- duplicate row a query happened to pick.
--
-- Two parts:
--  1. Forward fix — provision_starter_de_internal now also matches an
--     existing DE by (tenant_id, name) when no catalog_id match is
--     found, and backfills catalog_id onto it instead of inserting a
--     new row. Prevents recurrence for any tenant, not just Acme.
--  2. One-time cleanup — for any tenant with this exact duplicate
--     shape today, repoint the real, additive capability the
--     duplicate introduced (its starter playbook — invoice watching /
--     at-risk watching) onto the canonical (older) DE, then soft-
--     disable the duplicate row. Nothing is hard-deleted: the
--     duplicate's own history/audit trail stays intact, matching this
--     project's established soft-pause convention (deprovision_
--     starter_de_internal, remove_team_member, etc.).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Forward fix: adopt a pre-existing same-named DE instead of
-- inserting a duplicate when catalog_id isn't set on it yet.
-- ------------------------------------------------------------
create or replace function public.provision_starter_de_internal(p_tenant_id uuid, p_feature_key text)
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
    -- No catalog_id-tagged row yet. Before creating one, check whether a
    -- DE with this exact name already exists for this tenant (created
    -- before catalog_id existed, or by some other path) — adopt it
    -- rather than provisioning a silent duplicate.
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
      status, lifecycle_status, trust_level, confidence_threshold, required_approval, tags
    ) values (
      p_tenant_id, v_catalog_id, v_name, v_persona, v_description, v_category, v_department,
      'active', 'published', 'supervised', 75, false, array['auto_provisioned']
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

  -- playbook_event_rules has no unique index beyond its pkey (same as
  -- migration 037 found) — explicit exists-check instead of ON CONFLICT.
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

  insert into trust_policies (tenant_id, de_id, action_category, source_category, baseline_level, current_level, criteria)
  values (
    p_tenant_id, v_de_id, 'action_execute', v_source_cat, 0, 0,
    '{"window_days":30,"min_eval_pass_rate":0.9,"min_eval_samples":0,"min_human_approval_rate":0.9,"min_human_samples":3,"max_guardrail_blocks":0}'::jsonb
  )
  on conflict (tenant_id, action_category, coalesce(source_category, '')) do nothing;

  insert into de_autonomy (tenant_id, action_type, source_category, enabled, max_amount_cents, min_confidence)
  values (p_tenant_id, 'action_execute', v_source_cat, false, null, null)
  on conflict (tenant_id, action_type, coalesce(source_category, '')) do nothing;

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

revoke all on function public.provision_starter_de_internal(uuid, text) from public, anon, authenticated;
grant execute on function public.provision_starter_de_internal(uuid, text) to service_role;

-- ------------------------------------------------------------
-- 2. One-time cleanup: for any tenant already carrying this exact
-- duplicate shape (an older, catalog_id-less DE and a newer
-- "starter_*" duplicate sharing the same name), repoint the starter
-- playbook's ownership + charter onto the canonical (older) DE, drop
-- the duplicate's now-redundant access grant, and soft-disable the
-- duplicate row. Written generically (loops every affected tenant),
-- not hardcoded to Acme — verified live beforehand that Acme is the
-- only tenant currently in this state, but the fix applies to
-- whichever tenants match, present or future.
-- ------------------------------------------------------------
do $$
declare
  v_pair record;
  v_stale_charter_id uuid;
begin
  for v_pair in
    select
      old_de.id as old_id, new_de.id as new_id, old_de.tenant_id, old_de.name
    from digital_employees old_de
    join digital_employees new_de
      on new_de.tenant_id = old_de.tenant_id
     and new_de.name = old_de.name
     and new_de.id <> old_de.id
     and new_de.catalog_id in ('starter_account_de', 'starter_finance_de')
    where old_de.catalog_id is null
      and old_de.status = 'active'
      and new_de.status = 'active'
  loop
    -- Repoint playbook ownership from the duplicate to the canonical DE.
    update playbook_definitions
    set de_id = v_pair.old_id
    where de_id = v_pair.new_id;

    -- Repoint the charter row too, unless the canonical DE already has
    -- its own charter entry for that exact playbook (stale-hijack case
    -- found live for Account Success DE, where migration 068's
    -- playbook_definitions upsert reassigned an existing playbook to
    -- the new duplicate while the canonical DE's own charter row for
    -- that same playbook was left in place) — then just drop the
    -- duplicate's now-redundant charter row instead of conflicting.
    for v_stale_charter_id in
      select pc.playbook_id from de_playbook_charter pc where pc.de_id = v_pair.new_id
    loop
      if exists (
        select 1 from de_playbook_charter
        where de_id = v_pair.old_id and playbook_id = v_stale_charter_id
      ) then
        delete from de_playbook_charter where de_id = v_pair.new_id and playbook_id = v_stale_charter_id;
      else
        update de_playbook_charter
        set de_id = v_pair.old_id
        where de_id = v_pair.new_id and playbook_id = v_stale_charter_id;
      end if;
    end loop;

    -- The duplicate's own access grant is redundant — the canonical DE
    -- already carries its own grant for the same resource category.
    delete from data_access_grants
    where subject_kind = 'de' and subject_id = v_pair.new_id;

    -- Soft-disable the duplicate itself. Not deleted: its own audit
    -- trail (the "provisioned" event from migration 068) stays intact.
    update digital_employees
    set status = 'disabled',
        lifecycle_status = 'paused',
        tags = array(select distinct unnest(tags || array['duplicate_merged']))
    where id = v_pair.new_id;

    perform append_audit_event_internal(
      v_pair.tenant_id, 'DreamTeam', 'system',
      format('Duplicate "%s" row merged — its starter playbook was moved onto the original %s and the duplicate was disabled. This was a provisioning bug (migration 068 did not check for a pre-existing same-named DE), not a user action.',
        v_pair.name, v_pair.old_id),
      'config_change',
      jsonb_build_object('kind', 'duplicate_de_merged', 'canonical_de_id', v_pair.old_id, 'merged_de_id', v_pair.new_id)
    );
  end loop;
end $$;
