-- Tenant provisioning contract (QA program, Phase 2/3).
--
-- Root cause of "new tenant is missing a lot of builds": every feature's
-- tenant-level seed data (guardrails, onboarding template, specialist
-- profile) was only ever installed on Acme Telecom by hand during
-- development. New tenants got whatever complete_signup's feature
-- reconcile provisioned (2 starter DEs + their playbooks) and nothing
-- else. Worse, the platform console's approve_subtenant_request path
-- created tenants with ZERO provisioning at all — not even the DEs.
--
-- This migration establishes ONE canonical, idempotent baseline
-- provisioner that both creation paths call, plus a platform-gated
-- audit function that reports every tenant's compliance with the
-- contract. Founder-approved scope (2026-07-11): full parity — seed
-- everything except connectors, which need the tenant's own credentials.

-- ────────────────────────────────────────────────────────────────
-- 1. The canonical baseline provisioner (idempotent, internal)
-- ────────────────────────────────────────────────────────────────
create or replace function provision_tenant_baseline_internal(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_demo_tenant_id constant uuid := 'a0000000-0000-0000-0000-000000000001';
  v_tpl_id uuid;
  v_seeded_guardrails int := 0;
  v_seeded_template boolean := false;
  v_seeded_specialist boolean := false;
begin
  if p_tenant_id is null or p_tenant_id = v_demo_tenant_id then
    return jsonb_build_object('ok', false, 'error', 'refusing to provision null or the demo tenant');
  end if;
  if not exists (select 1 from tenants where id = p_tenant_id) then
    return jsonb_build_object('ok', false, 'error', 'tenant not found');
  end if;

  -- 1a. Feature reconcile — provisions the starter DEs, their playbooks,
  -- charters, event rules, trust policies, and autonomy rows (existing
  -- machinery, already idempotent). Same loop complete_signup ran.
  perform reconcile_tenant_feature(p_tenant_id, fr.key, true)
  from feature_registry fr
  where fr.default_enabled = true;

  -- 1b. Starter guardrail pack. Same rules Acme validated, with the
  -- tenant-specific ARR label generalized. Existence-guarded by rule
  -- text (or by rule_type for the approval rule, so a tenant that
  -- already configured ANY spend threshold isn't given a second one).
  insert into guardrail_rules (tenant_id, rule, rule_type, pattern, severity, applies_to, active)
  select p_tenant_id, r.rule, r.rule_type, r.pattern, r.severity, 'all', true
  from (values
    ('Explicit escalation demand', 'frustration_signal',
     'speak to a manager|speak with a manager|this is unacceptable|totally unacceptable', 'warning'),
    ('Repeated-contact frustration', 'frustration_signal',
     'third time i|already told you|i''ve asked this before|keep asking', 'warning'),
    ('Churn/cancellation threat', 'frustration_signal',
     'cancel(l)?ing my (subscription|account|plan)|switching to a competitor|find another (provider|vendor)', 'warning'),
    ('Strong negative sentiment', 'frustration_signal',
     'worst support|completely useless|waste of (my )?time|ridiculous that', 'warning'),
    ('No unilateral refund promises', 'blocked_phrase', 'refund', 'blocking'),
    ('No legal-threat language in outputs — route to a human', 'blocked_phrase',
     'legal action|lawsuit|sue you|attorney|court|legally liable|garnish|seize your assets', 'blocking')
  ) as r(rule, rule_type, pattern, severity)
  where not exists (
    select 1 from guardrail_rules g where g.tenant_id = p_tenant_id and g.rule = r.rule
  );
  get diagnostics v_seeded_guardrails = row_count;

  if not exists (
    select 1 from guardrail_rules g
    where g.tenant_id = p_tenant_id and g.rule_type = 'require_approval_over_cents'
  ) then
    insert into guardrail_rules (tenant_id, rule, rule_type, threshold, severity, applies_to, active)
    values (p_tenant_id, 'Actions over $10,000 always require human approval',
            'require_approval_over_cents', 1000000, 'blocking', 'all', true);
    v_seeded_guardrails := v_seeded_guardrails + 1;
  end if;

  -- 1c. Starter onboarding template + published version. Same content as
  -- install_starter_onboarding_template, but publish is inlined: the
  -- public publish RPC is caller-scoped (auth_tenant_id + role check)
  -- and this runs with no caller.
  if not exists (
    select 1 from onboarding_templates t
    where t.tenant_id = p_tenant_id and t.name = 'SaaS onboarding — starter'
  ) then
    insert into onboarding_templates (tenant_id, name, description, items)
    values (p_tenant_id, 'SaaS onboarding — starter',
      '10-step implementation checklist: kickoff → data → config → validation → go-live. Sign-off gates on settings, leave rules, UAT, and go-live.',
      '[
        {"key":"kickoff_call","label":"Kickoff call held","phase":"kickoff","owner_type":"human","requires_signoff":false,"description":"Intro call: goals, timeline, points of contact."},
        {"key":"data_export_received","label":"Data export received from customer","phase":"data","owner_type":"either","requires_signoff":false,"description":"Customer sends their employee/location export (CSV or spreadsheet)."},
        {"key":"employees_imported","label":"Employees imported","phase":"data","owner_type":"de","requires_signoff":false,"description":"Employee records loaded and normalized in the platform."},
        {"key":"locations_configured","label":"Locations configured","phase":"config","owner_type":"de","requires_signoff":false,"description":"Sites, time zones, and operating hours set up."},
        {"key":"settings_review","label":"Account settings reviewed","phase":"config","owner_type":"human","requires_signoff":true,"description":"Human sign-off on core account configuration."},
        {"key":"leave_rules_configured","label":"Leave rules configured","phase":"config","owner_type":"either","requires_signoff":true,"description":"Accrual, carryover, and approval chains — needs human sign-off."},
        {"key":"test_scenario_run","label":"Test scenario run","phase":"validation","owner_type":"de","requires_signoff":false,"description":"End-to-end test with sample data."},
        {"key":"uat_approved","label":"UAT approved by customer","phase":"validation","owner_type":"human","requires_signoff":true,"description":"Customer confirms acceptance testing passed."},
        {"key":"training_session","label":"Training session delivered","phase":"golive","owner_type":"human","requires_signoff":false,"description":"Admin + end-user training completed."},
        {"key":"go_live","label":"Go-live","phase":"golive","owner_type":"human","requires_signoff":true,"description":"Production cutover — final human sign-off."}
      ]'::jsonb)
    returning id into v_tpl_id;

    insert into onboarding_template_versions (template_id, tenant_id, version, name, description, items, published_by)
    select v_tpl_id, p_tenant_id, 1, t.name, t.description, t.items, null
    from onboarding_templates t where t.id = v_tpl_id;

    update onboarding_templates set version = 1, status = 'published' where id = v_tpl_id;
    v_seeded_template := true;
  end if;

  -- 1d. Starter specialist profile (read-only consult desk; same charter
  -- Acme validated).
  if not exists (
    select 1 from specialist_profiles sp
    where sp.tenant_id = p_tenant_id and sp.key = 'technical'
  ) then
    insert into specialist_profiles (tenant_id, key, name, charter, status)
    values (p_tenant_id, 'technical', 'Technical Specialist',
            'Answer only from configured sources; cite everything; escalate when unsure.', 'active');
    v_seeded_specialist := true;
  end if;

  if v_seeded_guardrails > 0 or v_seeded_template or v_seeded_specialist then
    perform append_audit_event_internal(
      p_tenant_id, 'DreamTeam', 'system',
      format('Workspace baseline provisioned — %s starter guardrail(s)%s%s. Connectors are the remaining setup step (they need your own system credentials).',
        v_seeded_guardrails,
        case when v_seeded_template then ', starter onboarding template' else '' end,
        case when v_seeded_specialist then ', Technical Specialist desk' else '' end),
      'config_change',
      jsonb_build_object('kind', 'tenant_baseline_provisioned',
        'guardrails_seeded', v_seeded_guardrails,
        'template_seeded', v_seeded_template,
        'specialist_seeded', v_seeded_specialist)
    );
  end if;

  return jsonb_build_object('ok', true,
    'guardrails_seeded', v_seeded_guardrails,
    'template_seeded', v_seeded_template,
    'specialist_seeded', v_seeded_specialist);
end;
$$;

revoke all on function provision_tenant_baseline_internal(uuid) from public, anon, authenticated;
grant execute on function provision_tenant_baseline_internal(uuid) to service_role;

-- ────────────────────────────────────────────────────────────────
-- 2. complete_signup: call the contract instead of just the
--    feature reconcile (self-serve creation path)
-- ────────────────────────────────────────────────────────────────
create or replace function complete_signup(p_org_name text, p_industry text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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

  insert into tenants (name, slug, industry, plan, status, settings, trial_ends_at)
  values (btrim(p_org_name), v_slug, nullif(btrim(coalesce(p_industry, '')), ''), 'starter', 'trial', '{}'::jsonb, now() + interval '14 days')
  returning * into v_tenant;

  if v_tenant.id = v_demo_tenant_id then
    raise exception 'Refusing to provision the reserved demo tenant id';
  end if;

  -- role='tenant_owner' added here — this UPDATE only ever fires once
  -- per user (tenant_id is null guard), for the tenant this same user
  -- just created above, so granting real ownership at this exact
  -- point is safe and correct, not a broadened grant.
  update profiles
  set tenant_id = v_tenant.id,
      role = 'tenant_owner',
      updated_at = now()
  where user_id = v_user
    and tenant_id is null;

  if not found then
    delete from tenants where id = v_tenant.id;
    return jsonb_build_object('ok', false, 'error', 'already_has_tenant',
      'detail', 'This account is already linked to an organization.');
  end if;

  -- Full baseline contract: feature reconcile (starter DEs + playbooks)
  -- PLUS starter guardrails, onboarding template, and specialist desk —
  -- previously only the reconcile ran here, so new tenants were missing
  -- every feature whose seed data had only ever been installed on the
  -- dev tenant by hand.
  perform provision_tenant_baseline_internal(v_tenant.id);

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
$$;

grant execute on function complete_signup(text, text) to authenticated, service_role;

-- ────────────────────────────────────────────────────────────────
-- 3. approve_subtenant_request: this path created tenants with ZERO
--    provisioning (not even the starter DEs) — now runs the same
--    contract as self-serve signup
-- ────────────────────────────────────────────────────────────────
create or replace function approve_subtenant_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req      tenant_provisioning_requests;
  v_slug     text;
  v_base_slug text;
  v_suffix   int := 0;
  v_tenant   tenants;
  v_requester_tenant uuid;
begin
  if not resolve_platform_capability(auth.uid(), 'tenants.manage') then
    raise exception 'only a platform team member with tenant management access may approve a tenant provisioning request';
  end if;

  select * into v_req from tenant_provisioning_requests where id = p_request_id for update;
  if not found then
    raise exception 'provisioning request not found';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'this request has already been decided (status=%)', v_req.status;
  end if;

  v_base_slug := lower(regexp_replace(btrim(v_req.proposed_name), '[^a-zA-Z0-9]+', '-', 'g'));
  v_base_slug := trim(both '-' from v_base_slug);
  if coalesce(v_base_slug, '') = '' then
    v_base_slug := 'org';
  end if;
  v_slug := v_base_slug;
  while exists (select 1 from tenants where slug = v_slug) loop
    v_suffix := v_suffix + 1;
    v_slug := v_base_slug || '-' || v_suffix::text;
  end loop;

  insert into tenants (name, slug, industry, plan, status, settings, parent_tenant_id)
  values (v_req.proposed_name, v_slug, nullif(btrim(coalesce(v_req.proposed_industry, '')), ''), 'starter', 'trial', '{}'::jsonb, v_req.proposed_parent_tenant_id)
  returning * into v_tenant;

  update tenant_provisioning_requests
  set status = 'approved', reviewed_by = auth.uid(), decided_at = now(), created_tenant_id = v_tenant.id
  where id = p_request_id;

  select tenant_id into v_requester_tenant from profiles where user_id = v_req.requested_by_user_id;
  if v_requester_tenant is null then
    update profiles
    set tenant_id = v_tenant.id, role = 'tenant_owner', updated_at = now()
    where user_id = v_req.requested_by_user_id and tenant_id is null;
  end if;

  -- Console-approved tenants previously got NO provisioning at all —
  -- no starter DEs, no playbooks, nothing. Run the same baseline
  -- contract the self-serve signup path runs.
  perform provision_tenant_baseline_internal(v_tenant.id);

  if v_req.proposed_parent_tenant_id is not null and exists (
    select 1 from profiles where user_id = auth.uid() and tenant_id = v_req.proposed_parent_tenant_id
  ) then
    perform append_audit_event(
      v_req.proposed_parent_tenant_id, 'Platform admin', 'human',
      format('Sub-tenant "%s" approved and created (request %s, new tenant id %s)', v_tenant.name, p_request_id, v_tenant.id),
      'config_change',
      jsonb_build_object('kind', 'tenant_provisioning_approved', 'request_id', p_request_id,
        'tenant_id', v_tenant.id, 'parent_tenant_id', v_req.proposed_parent_tenant_id,
        'approved_by', auth.uid(), 'requested_by', v_req.requested_by_user_id)
    );
  end if;

  return jsonb_build_object('ok', true, 'tenant_id', v_tenant.id, 'slug', v_tenant.slug);
end;
$$;

grant execute on function approve_subtenant_request(uuid) to authenticated, service_role;

-- ────────────────────────────────────────────────────────────────
-- 4. Contract audit — per-tenant provisioning compliance report for
--    the platform console (capability-gated)
-- ────────────────────────────────────────────────────────────────
create or replace function audit_tenant_provisioning()
returns table(
  tenant_id uuid, tenant_name text, tenant_status text,
  des bigint, playbooks bigint, guardrails bigint,
  onboarding_templates bigint, specialists bigint,
  trust_policies bigint, autonomy_rows bigint, connectors bigint,
  baseline_complete boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not resolve_platform_capability(auth.uid(), 'tenants.manage') then
    raise exception 'only a platform team member with tenant management access may audit tenant provisioning';
  end if;

  return query
  select
    t.id, t.name, t.status,
    (select count(*) from digital_employees d where d.tenant_id = t.id and d.lifecycle_status <> 'retired'),
    (select count(*) from playbook_definitions p where p.tenant_id = t.id),
    (select count(*) from guardrail_rules g where g.tenant_id = t.id and g.active),
    (select count(*) from onboarding_template_versions v where v.tenant_id = t.id),
    (select count(*) from specialist_profiles s where s.tenant_id = t.id and s.status = 'active'),
    (select count(*) from trust_policies tp where tp.tenant_id = t.id),
    (select count(*) from de_autonomy da where da.tenant_id = t.id),
    (select count(*) from connectors c where c.tenant_id = t.id),
    -- Connectors deliberately excluded: they require the tenant's own
    -- credentials and are a guided setup step, not a seedable default.
    (select count(*) from digital_employees d where d.tenant_id = t.id and d.lifecycle_status <> 'retired') >= 2
      and (select count(*) from playbook_definitions p where p.tenant_id = t.id) >= 2
      and (select count(*) from guardrail_rules g where g.tenant_id = t.id and g.active) >= 7
      and (select count(*) from onboarding_template_versions v where v.tenant_id = t.id) >= 1
      and (select count(*) from specialist_profiles s where s.tenant_id = t.id and s.status = 'active') >= 1
  from tenants t
  where t.id <> 'a0000000-0000-0000-0000-000000000001'
    and t.name not like '[TEST DEBRIS%'
  order by t.created_at desc;
end;
$$;

revoke all on function audit_tenant_provisioning() from public, anon;
grant execute on function audit_tenant_provisioning() to authenticated, service_role;

-- ────────────────────────────────────────────────────────────────
-- 5. Repair pass: bring every existing live tenant up to the contract
--    (idempotent — Acme's existing rules/template/specialist match the
--    existence guards, so it only fills genuine gaps)
-- ────────────────────────────────────────────────────────────────
select t.name, provision_tenant_baseline_internal(t.id) as result
from tenants t
where t.status in ('trial', 'active')
  and t.id <> 'a0000000-0000-0000-0000-000000000001'
  and t.name not like '[TEST DEBRIS%';
