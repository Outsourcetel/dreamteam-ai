-- ============================================================
-- Migration 068: wire the 7 dormant feature_registry flags (050) to
-- REAL behavior, for every tenant, live-reactive.
--
-- Context: feature_registry / tenant_feature_overrides / the Platform
-- Console toggle panel already existed (migration 050) and already
-- worked as a database + UI mechanism — a platform admin could flip a
-- switch and it would persist. What none of the 7 registered flags
-- did was actually GATE or PROVISION anything. Founder's explicit
-- instruction: "whatever we have built [on] acme - those should be
-- wired such that each tenant gets it, with Platform owner having
-- access to enable to disable certain features by tenant." Scope
-- confirmed explicitly: all 7 flags in one pass, live-reactive
-- (toggling at any time immediately provisions or removes/pauses the
-- capability, not just at signup).
--
-- TWO KINDS OF FLAG, TWO KINDS OF WIRING:
--   - account_de / finance_de create real, standing state (a Digital
--     Employee persona + starter access + a starter playbook) — these
--     need PROVISION/DEPROVISION side effects when toggled.
--   - de_memory / connector_hub / proactive_triage /
--     staleness_watchdog / identity_credential_inventory gate an
--     ALREADY-EXISTING mechanism at the moment it runs — no state to
--     create or tear down, just a runtime check inline in the
--     existing function/edge function.
--
-- GENERICITY, STATED HONESTLY: create_digital_employee (037) requires
-- a real tenant_owner/tenant_admin JWT caller and explicitly refuses
-- service_role. Both trigger points here (a platform admin toggling a
-- flag for a tenant they don't belong to, and complete_signup
-- provisioning defaults for a brand-new tenant) don't fit that
-- caller-role assumption, so this migration adds a separate internal
-- provisioning path (provision_starter_de_internal) rather than
-- calling that RPC — same insert shape create_digital_employee uses,
-- SECURITY DEFINER, revoked from anon/authenticated/public.
--
-- The starter Account/Finance DE is deliberately CONFIGURATION-ONLY
-- and connector-agnostic: it gets a category-level access grant
-- (crm / erp_financials) and a playbook wired to an EXISTING generic
-- event key (account_at_risk / invoice_overdue, both already fire off
-- core schema — customer_accounts.status / renewal_invoices.due_date
-- — that every tenant has, Acme-specific or not) using ONLY the
-- check_account -> checklist -> complete step primitives. It does NOT
-- fabricate a connector_action bound to a specific adapter template,
-- because a brand-new tenant has no connector to act through yet —
-- inventing one would be dishonest, not generic. Its trust_policies/
-- de_autonomy row starts at level 0 (gated), so if/when the tenant
-- later connects a real CRM/ERP and an admin adds action_definitions
-- for it, the DE is already sitting at the correct conservative
-- starting trust rather than silently inheriting some other
-- department's earned trust — the same earned-autonomy ladder Jordan
-- (037) and Sasha (043) already proved, not a new mechanism.
-- ============================================================

-- ============================================================
-- 1. is_feature_enabled_internal — same lookup as is_feature_enabled
-- (050) MINUS the caller-membership check, for use inside other
-- SECURITY DEFINER functions and cron/service-role-driven code paths
-- that have no auth.uid() session (check_staleness, poll_support_
-- inbox_targets, connector-hub). Safe specifically because it is
-- revoked from anon/authenticated/public — never callable directly by
-- an end user, only from already-authorized internal code (mirrors
-- append_audit_event_internal's existing "_internal" pattern).
-- ============================================================
create or replace function public.is_feature_enabled_internal(p_tenant_id uuid, p_feature_key text)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_override boolean;
  v_default  boolean;
begin
  select enabled into v_override from tenant_feature_overrides
  where tenant_id = p_tenant_id and feature_key = p_feature_key;
  if found then
    return v_override;
  end if;

  select default_enabled into v_default from feature_registry where key = p_feature_key;
  if not found then
    return true; -- unknown key: fail open rather than silently breaking an unrelated caller
  end if;
  return v_default;
end;
$function$;

revoke all on function public.is_feature_enabled_internal(uuid, text) from public, anon, authenticated;
grant execute on function public.is_feature_enabled_internal(uuid, text) to service_role;

-- ============================================================
-- 2. provision_starter_de_internal — creates (or reactivates, if
-- previously paused) the starter Account/Finance DE for a tenant.
-- Idempotent via a fixed catalog_id per feature key.
-- ============================================================
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
  if v_de_id is not null then
    update digital_employees set status = 'active', lifecycle_status = 'published' where id = v_de_id;
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

-- ============================================================
-- 3. deprovision_starter_de_internal — soft-pause, not delete. Matches
-- this session's established soft-delete convention (e.g.
-- remove_team_member): the DE, its access grants, and its history all
-- stay in place so nothing is silently destroyed and the audit trail
-- stays intact; only the things that make it ACT are turned off.
-- ============================================================
create or replace function public.deprovision_starter_de_internal(p_tenant_id uuid, p_feature_key text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_catalog_id text;
  v_source_cat text;
  v_de_id      uuid;
begin
  v_catalog_id := case p_feature_key when 'account_de' then 'starter_account_de' when 'finance_de' then 'starter_finance_de' else null end;
  v_source_cat := case p_feature_key when 'account_de' then 'crm' when 'finance_de' then 'erp_financials' else null end;
  if v_catalog_id is null then
    return; -- not a DE-provisioning feature — nothing to do
  end if;

  select id into v_de_id from digital_employees where tenant_id = p_tenant_id and catalog_id = v_catalog_id;
  if v_de_id is null then
    return; -- never provisioned — honest no-op
  end if;

  update digital_employees set status = 'disabled', lifecycle_status = 'paused' where id = v_de_id;

  update de_playbook_charter set active = false
  where tenant_id = p_tenant_id and de_id = v_de_id;

  update playbook_event_rules set active = false
  where tenant_id = p_tenant_id
    and definition_id in (select playbook_id from de_playbook_charter where de_id = v_de_id);

  update de_autonomy set enabled = false
  where tenant_id = p_tenant_id and action_type = 'action_execute' and source_category = v_source_cat;

  perform append_audit_event_internal(
    p_tenant_id, 'DreamTeam', 'system',
    format('Starter Digital Employee paused (feature "%s" turned off) — its playbook and autonomy were disabled; access grants and history were kept, not deleted.', p_feature_key),
    'config_change',
    jsonb_build_object('kind', 'feature_de_deprovisioned', 'feature_key', p_feature_key, 'de_id', v_de_id)
  );
end;
$function$;

revoke all on function public.deprovision_starter_de_internal(uuid, text) from public, anon, authenticated;
grant execute on function public.deprovision_starter_de_internal(uuid, text) to service_role;

-- ============================================================
-- 4. reconcile_tenant_feature — the single dispatch point both
-- set_tenant_feature_override (live toggle) and complete_signup (new-
-- tenant defaults) call. For account_de/finance_de it provisions or
-- pauses the starter DE. For the other 5 flags there is no standing
-- state to create — they are pure runtime gates checked inline
-- elsewhere (is_feature_enabled_internal calls added below in
-- check_staleness, poll_support_inbox_targets, set_conversation_fact,
-- record_de_experience, get_identity_inventory, and connector-hub) —
-- so reconciling them here is a correct, honest no-op, not a gap.
-- ============================================================
create or replace function public.reconcile_tenant_feature(p_tenant_id uuid, p_feature_key text, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if p_feature_key in ('account_de', 'finance_de') then
    if p_enabled then
      perform provision_starter_de_internal(p_tenant_id, p_feature_key);
    else
      perform deprovision_starter_de_internal(p_tenant_id, p_feature_key);
    end if;
  end if;
end;
$function$;

revoke all on function public.reconcile_tenant_feature(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.reconcile_tenant_feature(uuid, text, boolean) to service_role;

-- ============================================================
-- 5. LIVE-REACTIVE: set_tenant_feature_override now reconciles
-- immediately after persisting the override — a platform admin's
-- toggle takes effect the moment they flip it, not just at next
-- signup. Body otherwise byte-identical to the live definition (050).
-- ============================================================
create or replace function public.set_tenant_feature_override(p_tenant_id uuid, p_feature_key text, p_enabled boolean, p_note text default null::text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not is_platform_admin() then
    raise exception 'only a platform admin may set a tenant feature override';
  end if;

  if not exists (select 1 from feature_registry where key = p_feature_key) then
    raise exception 'unknown feature key: %', p_feature_key;
  end if;

  insert into tenant_feature_overrides (tenant_id, feature_key, enabled, set_by, note, updated_at)
  values (p_tenant_id, p_feature_key, p_enabled, auth.uid(), p_note, now())
  on conflict (tenant_id, feature_key)
  do update set enabled = excluded.enabled, set_by = excluded.set_by, note = excluded.note, updated_at = now();

  perform reconcile_tenant_feature(p_tenant_id, p_feature_key, p_enabled);

  if exists (select 1 from profiles where user_id = auth.uid() and tenant_id = p_tenant_id) then
    perform append_audit_event(
      p_tenant_id, 'Platform admin', 'human',
      format('Feature "%s" set to %s for this tenant', p_feature_key, case when p_enabled then 'ON' else 'OFF' end),
      'config_change',
      jsonb_build_object('kind', 'tenant_feature_override_set', 'feature_key', p_feature_key,
        'enabled', p_enabled, 'set_by', auth.uid(), 'note', p_note)
    );
  end if;

  return jsonb_build_object('ok', true);
end;
$function$;

-- ============================================================
-- 6. complete_signup now provisions every default-enabled feature for
-- a brand-new tenant, right after the tenant row and profile link are
-- created — a new signup gets the same defaults a platform admin
-- would see already ON in the Platform Console. Body otherwise byte-
-- identical to the live definition; only the reconcile loop is new
-- (inserted right before the audit_events call at the end).
-- ============================================================
create or replace function public.complete_signup(p_org_name text, p_industry text default null::text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user   uuid := auth.uid();
  v_profile profiles;
  v_slug   text;
  v_base_slug text;
  v_suffix int := 0;
  v_tenant tenants;
  v_demo_tenant_id constant uuid := 'a0000000-0000-0000-0000-000000000001';
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated',
      'detail', 'You must be signed in to set up an organization.');
  end if;

  if coalesce(btrim(p_org_name), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'org_name_required');
  end if;

  select * into v_profile from profiles where user_id = v_user;
  if v_profile.id is null then
    return jsonb_build_object('ok', false, 'error', 'no_profile',
      'detail', 'No profile found for this user. Please contact support.');
  end if;

  if v_profile.tenant_id is not null then
    return jsonb_build_object('ok', false, 'error', 'already_has_tenant',
      'tenant_id', v_profile.tenant_id,
      'detail', 'This account is already linked to an organization.');
  end if;

  v_base_slug := lower(regexp_replace(btrim(p_org_name), '[^a-zA-Z0-9]+', '-', 'g'));
  v_base_slug := trim(both '-' from v_base_slug);
  if coalesce(v_base_slug, '') = '' then
    v_base_slug := 'org';
  end if;
  v_slug := v_base_slug;
  while exists (select 1 from tenants where slug = v_slug) loop
    v_suffix := v_suffix + 1;
    v_slug := v_base_slug || '-' || v_suffix::text;
  end loop;

  insert into tenants (name, slug, industry, plan, status, settings)
  values (btrim(p_org_name), v_slug, nullif(btrim(coalesce(p_industry, '')), ''), 'starter', 'trial', '{}'::jsonb)
  returning * into v_tenant;

  if v_tenant.id = v_demo_tenant_id then
    raise exception 'Refusing to provision the reserved demo tenant id';
  end if;

  update profiles
  set tenant_id = v_tenant.id,
      updated_at = now()
  where user_id = v_user
    and tenant_id is null;

  if not found then
    delete from tenants where id = v_tenant.id;
    return jsonb_build_object('ok', false, 'error', 'already_has_tenant',
      'detail', 'This account is already linked to an organization.');
  end if;

  -- Provision every default-enabled feature for this brand-new tenant
  -- (account_de/finance_de create their starter DE; the other 5 flags
  -- have nothing to provision — they gate at runtime, already default-
  -- on the moment is_feature_enabled_internal is checked with no
  -- override row present).
  perform reconcile_tenant_feature(v_tenant.id, fr.key, true)
  from feature_registry fr
  where fr.default_enabled = true;

  perform append_audit_event(
    v_tenant.id,
    coalesce(v_profile.full_name, 'owner'),
    'human',
    'Organization "' || v_tenant.name || '" created at signup by ' || coalesce(v_profile.full_name, 'the account owner'),
    'config_change',
    jsonb_build_object('kind', 'tenant_provisioned', 'tenant_id', v_tenant.id,
      'tenant_name', v_tenant.name, 'slug', v_tenant.slug, 'industry', v_tenant.industry,
      'user_id', v_user)
  );

  return jsonb_build_object('ok', true, 'tenant_id', v_tenant.id, 'slug', v_tenant.slug, 'name', v_tenant.name);
end;
$function$;

-- ============================================================
-- 7. Runtime gate: staleness_watchdog — check_staleness now skips any
-- policy belonging to a tenant that has this feature off. Body
-- otherwise byte-identical to the live definition (042); only the
-- filter clause in the outer policy loop is new.
-- ============================================================
create or replace function public.check_staleness(p_tenant_id uuid default null::uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_policy   record;
  v_proj     record;
  v_task     record;
  v_inv      record;
  v_open     record;
  v_warned   integer := 0;
  v_breached integer := 0;
  v_resolved integer := 0;
  v_acct     text;
begin
  for v_policy in
    select * from staleness_policies sp
    where sp.enabled
      and (p_tenant_id is null or sp.tenant_id = p_tenant_id)
      and is_feature_enabled_internal(sp.tenant_id, 'staleness_watchdog')
  loop

    if v_policy.target_kind = 'onboarding_project' then
      for v_proj in
        select op.id, op.name, op.updated_at, op.account_id
        from onboarding_projects op
        where op.tenant_id = v_policy.tenant_id
          and op.status = 'active'
      loop
        select name into v_acct from customer_accounts
          where id = v_proj.account_id and tenant_id = v_policy.tenant_id;

        if now() - v_proj.updated_at >= v_policy.breach_after then
          if stale_upsert_escalation(
            v_policy.tenant_id, 'onboarding_project', v_proj.id, 'breach',
            format('Onboarding stalled — %s', v_proj.name),
            format('This onboarding project for %s hasn''t been touched in %s (breach threshold: %s).',
                   coalesce(v_acct, v_proj.name), stale_humanize_interval(now() - v_proj.updated_at),
                   stale_humanize_interval(v_policy.breach_after)),
            'onboarding_projects', v_proj.id
          ) is not null then v_breached := v_breached + 1; end if;
        elsif now() - v_proj.updated_at >= v_policy.warning_after then
          if stale_upsert_escalation(
            v_policy.tenant_id, 'onboarding_project', v_proj.id, 'warning',
            format('Onboarding going quiet — %s', v_proj.name),
            format('This onboarding project for %s hasn''t been touched in %s (warning threshold: %s).',
                   coalesce(v_acct, v_proj.name), stale_humanize_interval(now() - v_proj.updated_at),
                   stale_humanize_interval(v_policy.warning_after)),
            'onboarding_projects', v_proj.id
          ) is not null then v_warned := v_warned + 1; end if;
        end if;
      end loop;

      for v_open in
        select se.id, se.target_id
        from staleness_escalations se
        where se.tenant_id = v_policy.tenant_id
          and se.target_kind = 'onboarding_project'
          and se.resolved_at is null
      loop
        if not exists (
          select 1 from onboarding_projects op
          where op.id = v_open.target_id and op.tenant_id = v_policy.tenant_id
            and op.status = 'active'
            and now() - op.updated_at >= v_policy.warning_after
        ) then
          update staleness_escalations set resolved_at = now() where id = v_open.id;
          v_resolved := v_resolved + 1;
        end if;
      end loop;

    elsif v_policy.target_kind = 'pending_review_task' then
      for v_task in
        select ht.id, ht.title, ht.created_at, ht.type
        from human_tasks ht
        where ht.tenant_id = v_policy.tenant_id
          and ht.status = 'pending'
          and ht.type in ('inquiry_review', 'action_approval', 'checklist', 'review_gate', 'approval_gate')
      loop
        if now() - v_task.created_at >= v_policy.breach_after then
          if stale_upsert_escalation(
            v_policy.tenant_id, 'pending_review_task', v_task.id, 'breach',
            format('Review overdue — %s', v_task.title),
            format('This %s has been waiting %s for a human decision (breach threshold: %s).',
                   replace(v_task.type, '_', ' '), stale_humanize_interval(now() - v_task.created_at),
                   stale_humanize_interval(v_policy.breach_after)),
            'human_tasks', v_task.id
          ) is not null then v_breached := v_breached + 1; end if;
        elsif now() - v_task.created_at >= v_policy.warning_after then
          if stale_upsert_escalation(
            v_policy.tenant_id, 'pending_review_task', v_task.id, 'warning',
            format('Review waiting — %s', v_task.title),
            format('This %s has been waiting %s for a human decision (warning threshold: %s).',
                   replace(v_task.type, '_', ' '), stale_humanize_interval(now() - v_task.created_at),
                   stale_humanize_interval(v_policy.warning_after)),
            'human_tasks', v_task.id
          ) is not null then v_warned := v_warned + 1; end if;
        end if;
      end loop;

      for v_open in
        select se.id, se.target_id
        from staleness_escalations se
        where se.tenant_id = v_policy.tenant_id
          and se.target_kind = 'pending_review_task'
          and se.resolved_at is null
      loop
        if not exists (
          select 1 from human_tasks ht
          where ht.id = v_open.target_id and ht.tenant_id = v_policy.tenant_id
            and ht.status = 'pending'
        ) then
          update staleness_escalations set resolved_at = now() where id = v_open.id;
          v_resolved := v_resolved + 1;
        end if;
      end loop;

    elsif v_policy.target_kind = 'overdue_invoice_unattended' then
      for v_inv in
        select ri.id, ri.account_id, ri.amount_cents, ri.due_date, ca.name as account_name
        from renewal_invoices ri
        join customer_accounts ca on ca.id = ri.account_id and ca.tenant_id = v_policy.tenant_id
        where ri.tenant_id = v_policy.tenant_id
          and ri.status in ('sent', 'awaiting_approval')
          and ri.due_date is not null
      loop
        if (current_date - v_inv.due_date) * interval '1 day' >= v_policy.breach_after then
          if stale_upsert_escalation(
            v_policy.tenant_id, 'overdue_invoice_unattended', v_inv.id, 'breach',
            format('Invoice seriously overdue — %s', v_inv.account_name),
            format('Invoice for %s (%s cents) has been overdue since %s — %s past due (breach threshold: %s).',
                   v_inv.account_name, v_inv.amount_cents, v_inv.due_date,
                   stale_humanize_interval((current_date - v_inv.due_date) * interval '1 day'),
                   stale_humanize_interval(v_policy.breach_after)),
            'renewal_invoices', v_inv.id
          ) is not null then v_breached := v_breached + 1; end if;
        elsif (current_date - v_inv.due_date) * interval '1 day' >= v_policy.warning_after then
          if stale_upsert_escalation(
            v_policy.tenant_id, 'overdue_invoice_unattended', v_inv.id, 'warning',
            format('Invoice overdue — %s', v_inv.account_name),
            format('Invoice for %s (%s cents) has been overdue since %s — %s past due (warning threshold: %s).',
                   v_inv.account_name, v_inv.amount_cents, v_inv.due_date,
                   stale_humanize_interval((current_date - v_inv.due_date) * interval '1 day'),
                   stale_humanize_interval(v_policy.warning_after)),
            'renewal_invoices', v_inv.id
          ) is not null then v_warned := v_warned + 1; end if;
        end if;
      end loop;

      for v_open in
        select se.id, se.target_id
        from staleness_escalations se
        where se.tenant_id = v_policy.tenant_id
          and se.target_kind = 'overdue_invoice_unattended'
          and se.resolved_at is null
      loop
        if not exists (
          select 1 from renewal_invoices ri
          where ri.id = v_open.target_id and ri.tenant_id = v_policy.tenant_id
            and ri.status in ('sent', 'awaiting_approval')
        ) then
          update staleness_escalations set resolved_at = now() where id = v_open.id;
          v_resolved := v_resolved + 1;
        end if;
      end loop;

    end if;
  end loop;

  return jsonb_build_object('warned', v_warned, 'breached', v_breached, 'resolved', v_resolved);
end;
$function$;

-- ============================================================
-- 8. Runtime gate: proactive_triage — poll_support_inbox_targets now
-- only yields rows for a tenant with this feature on. Body otherwise
-- byte-identical to the live definition (034); only the WHERE clause
-- gained one more predicate.
-- ============================================================
create or replace function public.poll_support_inbox_targets(p_tenant_id uuid default null::uuid)
returns table(tenant_id uuid, connector_id uuid, connector_provider text, connector_display_name text, subject_kind text, subject_id uuid, subject_name text, last_seen_external_ref text, last_seen_timestamp timestamp with time zone)
language sql
stable
security definer
set search_path to 'public', 'extensions'
as $function$
  select
    c.tenant_id, c.id as connector_id, c.provider, c.display_name,
    g.subject_kind, g.subject_id,
    coalesce(sp.name, de.name, 'DE') as subject_name,
    w.last_seen_external_ref, w.last_seen_timestamp
  from connectors c
  join data_access_grants g
    on g.tenant_id = c.tenant_id
   and ((g.resource_kind = 'connector' and g.resource_id = c.id)
        or (g.resource_kind = 'category' and g.resource_category = c.category))
   and access_permission_level(g.permission) >= access_permission_level('search')
  left join specialist_profiles sp on sp.id = g.subject_id and g.subject_kind = 'specialist'
  left join digital_employees de on de.id = g.subject_id and g.subject_kind = 'de'
  left join inbox_watch_state w on w.tenant_id = c.tenant_id and w.connector_id = c.id
  where c.category = 'helpdesk'
    and c.status <> 'disconnected'
    and (p_tenant_id is null or c.tenant_id = p_tenant_id)
    and is_feature_enabled_internal(c.tenant_id, 'proactive_triage');
$function$;

-- ============================================================
-- 9. Runtime gate: de_memory — set_conversation_fact and
-- record_de_experience become honest no-ops (return null, write
-- nothing) for a tenant with this feature off. Bodies otherwise byte-
-- identical to the live definitions (045).
-- ============================================================
create or replace function public.set_conversation_fact(p_tenant_id uuid, p_conversation_id uuid, p_fact_key text, p_fact_value jsonb)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_id uuid;
begin
  if not is_feature_enabled_internal(p_tenant_id, 'de_memory') then
    return null;
  end if;

  insert into conversation_facts (tenant_id, conversation_id, fact_key, fact_value)
  values (p_tenant_id, p_conversation_id, p_fact_key, p_fact_value)
  on conflict (conversation_id, fact_key) do update set
    fact_value = excluded.fact_value,
    updated_at = now()
  returning id into v_id;
  return v_id;
end;
$function$;

create or replace function public.record_de_experience(p_tenant_id uuid, p_subject_kind text, p_subject_id uuid, p_category text, p_external_ref text, p_what_happened text, p_decision_made text, p_outcome text, p_source_evidence_run_id uuid, p_source_action_execution_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_id uuid;
begin
  if not is_feature_enabled_internal(p_tenant_id, 'de_memory') then
    return null;
  end if;

  if p_subject_kind is null or p_subject_id is null or p_category is null or p_external_ref is null or p_external_ref = '' then
    return null; -- honest no-op: an experience fact needs a resolvable subject + category + external_ref
  end if;
  insert into de_experience (
    tenant_id, subject_kind, subject_id, category, external_ref,
    fact_summary, source_evidence_run_id, source_action_execution_id
  ) values (
    p_tenant_id, p_subject_kind, p_subject_id, p_category, p_external_ref,
    jsonb_build_object(
      'what_happened', p_what_happened,
      'decision_made', p_decision_made,
      'outcome', p_outcome
    ),
    p_source_evidence_run_id, p_source_action_execution_id
  )
  returning id into v_id;
  return v_id;
end;
$function$;

-- ============================================================
-- 10. Runtime gate: identity_credential_inventory — get_identity_
-- inventory returns an honest empty result set for a tenant with this
-- feature off (the caller-membership/deactivation checks above it are
-- untouched). Body otherwise byte-identical to the live definition.
-- ============================================================
create or replace function public.get_identity_inventory(p_tenant_id uuid)
returns table(subject_kind text, subject_id uuid, subject_name text, subject_label text, subject_role text, subject_status text, connector_id uuid, connector_name text, connector_provider text, connector_category text, connector_status text, connector_last_ok_at timestamp with time zone, connector_last_error_at timestamp with time zone, connector_consecutive_failures integer, has_stored_credential boolean, permission text, permission_via text, trust_current_level integer, trust_target_level integer, autonomy_enabled boolean, possible_actions jsonb)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_caller_tenant uuid;
  v_is_service    boolean := coalesce(auth.role(), '') = 'service_role';
  v_is_active     boolean;
begin
  if not v_is_service then
    select tenant_id, coalesce(is_active, true) into v_caller_tenant, v_is_active from profiles where user_id = auth.uid();
    if v_caller_tenant is null then
      raise exception 'not authenticated or no tenant membership';
    end if;
    if not v_is_active then
      raise exception 'account is deactivated';
    end if;
    if v_caller_tenant is distinct from p_tenant_id then
      raise exception 'not a member of this tenant';
    end if;
  end if;

  if not is_feature_enabled_internal(p_tenant_id, 'identity_credential_inventory') then
    return; -- feature off for this tenant: honest empty result, not an error
  end if;

  return query
  with subjects as (
    select 'de'::text as subject_kind, d.id as subject_id, d.name as subject_name,
           coalesce(d.persona_name, d.name) as subject_label,
           coalesce(nullif(d.department, ''), d.category) as subject_role,
           d.status as subject_status
    from digital_employees d
    where d.tenant_id = p_tenant_id
    union all
    select 'specialist'::text, s.id, s.name, s.name, s.key, s.status
    from specialist_profiles s
    where s.tenant_id = p_tenant_id
  ),
  grants_resolved as (
    select g.subject_kind, g.subject_id, c.id as connector_id, g.permission, 'category'::text as via,
           g.resource_category as eff_category
    from data_access_grants g
    join connectors c on c.tenant_id = g.tenant_id and c.category = g.resource_category
    where g.tenant_id = p_tenant_id and g.resource_kind = 'category'
    union all
    select g.subject_kind, g.subject_id, g.resource_id as connector_id, g.permission, 'connector'::text as via,
           c.category as eff_category
    from data_access_grants g
    join connectors c on c.id = g.resource_id and c.tenant_id = p_tenant_id
    where g.tenant_id = p_tenant_id and g.resource_kind = 'connector'
  ),
  grants_final as (
    select distinct on (gr.subject_kind, gr.subject_id, gr.connector_id)
      gr.subject_kind, gr.subject_id, gr.connector_id, gr.permission, gr.via, gr.eff_category
    from grants_resolved gr
    order by gr.subject_kind, gr.subject_id, gr.connector_id,
             (gr.via = 'connector') desc
  ),
  secrets as (
    select cs.connector_id as secret_connector_id, true as has_secret from connector_secrets cs
  ),
  trust as (
    select tp.de_id, tp.source_category, tp.current_level, tp.target_level
    from trust_policies tp
    where tp.tenant_id = p_tenant_id and tp.action_category = 'action_execute'
  ),
  autonomy as (
    select da.source_category, da.enabled
    from de_autonomy da
    where da.tenant_id = p_tenant_id and da.action_type = 'action_execute'
  ),
  actions_by_category as (
    select ad.category,
           jsonb_agg(jsonb_build_object(
             'action_key', ad.action_key, 'label', ad.label,
             'destructive', coalesce((ad.risk->>'destructive')::boolean, true)
           ) order by ad.label) as actions
    from action_definitions ad
    where ad.status = 'active' and (ad.scope = 'platform' or ad.tenant_id = p_tenant_id)
    group by ad.category
  )
  select
    s.subject_kind, s.subject_id, s.subject_name, s.subject_label, s.subject_role, s.subject_status,
    c.id, c.display_name, c.provider, c.category, c.status,
    c.last_ok_at, c.last_error_at, c.consecutive_failures,
    coalesce(sec.has_secret, false),
    gf.permission, gf.via,
    coalesce(
      (select tr.current_level from trust tr where tr.de_id = s.subject_id and tr.source_category = c.category),
      (select tr.current_level from trust tr where tr.de_id = s.subject_id and tr.source_category is null and s.subject_kind = 'de')
    ),
    coalesce(
      (select tr.target_level from trust tr where tr.de_id = s.subject_id and tr.source_category = c.category),
      (select tr.target_level from trust tr where tr.de_id = s.subject_id and tr.source_category is null and s.subject_kind = 'de')
    ),
    coalesce(
      (select au.enabled from autonomy au where au.source_category = c.category),
      (select au.enabled from autonomy au where au.source_category is null)
    ),
    coalesce(abc.actions, '[]'::jsonb)
  from subjects s
  left join grants_final gf on gf.subject_kind = s.subject_kind and gf.subject_id = s.subject_id
  left join connectors c on c.id = gf.connector_id
  left join secrets sec on sec.secret_connector_id = c.id
  left join actions_by_category abc on abc.category = c.category
  order by s.subject_kind, s.subject_name, c.category, c.display_name;
end;
$function$;

-- ============================================================
-- 11. Backfill: reconcile every EXISTING tenant against the current
-- feature_registry defaults (skips the demo tenant, matching the
-- standing "never write to the demo tenant" rule). Without this, only
-- tenants created AFTER this migration or explicitly toggled by a
-- platform admin would ever get a starter Account/Finance DE — every
-- already-provisioned tenant would stay stuck exactly as-is forever.
-- ============================================================
do $$
declare
  v_demo_tenant_id constant uuid := 'a0000000-0000-0000-0000-000000000001';
  v_t record;
  v_fr record;
begin
  for v_t in select id from tenants where id <> v_demo_tenant_id and status <> 'suspended' loop
    for v_fr in select key from feature_registry loop
      -- EFFECTIVE state (existing override, if any, else the registry
      -- default) — NOT a blind "true". A tenant that already had an
      -- explicit override (e.g. a platform admin had turned finance_de
      -- off for one sub-tenant before this migration ever ran) must stay
      -- exactly as configured, not get silently re-provisioned.
      perform reconcile_tenant_feature(v_t.id, v_fr.key, is_feature_enabled_internal(v_t.id, v_fr.key));
    end loop;
  end loop;
end $$;
