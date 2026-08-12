-- 730 — admin plumbing is not an employee's job
--
-- The platform_admin self-connector (connectors.category='platform_admin',
-- provider='dreamteam') is what makes a workspace administrable at all — it
-- is the row the platform points at for its own self-management access. Since
-- 143, the only code path that created it was provision_onboarding_architect:
-- a side effect of hiring an AI employee ("Ada") to help customers configure
-- DreamTeam. Nobody decided that admin capability should depend on whether a
-- particular DE happens to be on staff — it just ended up there because 143
-- built the DE and its connector in the same migration.
--
-- Ada is being retired in a later piece of work. Retiring her would have
-- silently taken the connector with her, and it would have made the certify
-- check that watches for "workspace has an assistant but no admin connector"
-- start passing vacuously — nobody provisioning, nobody noticing.
--
-- This moves the connector into provision_tenant_baseline_internal, which
-- every tenant already goes through (guardrails, approval limits, the starter
-- onboarding template) and none of them go through by way of hiring a
-- specific employee. provision_onboarding_architect keeps calling it — Ada
-- still works exactly as today — but now through the shared helper instead of
-- inserting the row herself, so removing her later is safe.
--
-- Existing tenants are NOT backfilled here. A tenant provisioned before this
-- migration and still missing the connector stays missing it until something
-- re-runs its baseline; the verification block below reports the estate as it
-- actually stands, not as this migration would like it to stand.

begin;

-- ---------------------------------------------------------------------------
-- The helper. Find-then-insert, never insert blindly — provisioning re-runs
-- on every call, so this has to be safe to call on a tenant that already has
-- a connector.
-- ---------------------------------------------------------------------------
create or replace function public.provision_platform_admin_connector_internal(p_tenant_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_conn uuid;
begin
  select id into v_conn from connectors
   where tenant_id = p_tenant_id and provider = 'dreamteam' limit 1;
  if v_conn is null then
    insert into connectors (tenant_id, provider, base_url, category, status, display_name)
    values (p_tenant_id, 'dreamteam', 'https://dreamteam.internal', 'platform_admin', 'connected', 'DreamTeam AI (self)')
    returning id into v_conn;
  end if;
  return v_conn;
end;
$function$;

revoke execute on function public.provision_platform_admin_connector_internal(uuid) from public, anon, authenticated;
grant  execute on function public.provision_platform_admin_connector_internal(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- provision_onboarding_architect — reproduced verbatim from the live
-- pg_get_functiondef except for ONE change: the self-connector block is
-- replaced with a call to the helper above. v_conn is still populated (it
-- binds the DE to the connector further down in this same function) — it is
-- assigned, not removed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.provision_onboarding_architect(p_tenant_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_demo constant uuid := 'a0000000-0000-0000-0000-000000000001';
  v_enabled boolean;
  v_conn uuid;
  v_de uuid;
  v_charter text := $charter$You are the DreamTeam Onboarding Architect — a master of the DreamTeam AI platform whose job is to set customers up quickly and correctly.

WHAT DREAMTEAM IS: an operating system for AI "Digital Employees" (DEs) that add a work-and-judgment layer on top of a company's existing systems — never replacing them. The building blocks you configure:
- Digital Employee (DE): an AI employee for a role (e.g. Support, Billing). It answers ONLY from its knowledge and acts ONLY through approved tools. New DEs start "designed"/"supervised" and must be taken through lifecycle gates by a human before they go live.
- Knowledge base: documents a DE answers from (grounded + cited; it won't invent facts).
- Playbook: a repeatable, auditable procedure a DE follows for a task.
- Specialist desk: a deep-expertise reference a DE can consult.
- Connector: a link to one of the customer's systems (helpdesk, CRM, etc.). Credentials are added by a human, never by you.
- Guardrail: a rule that blocks unsafe answers/actions. Trust dial: how much autonomy a DE has (starts supervised).

YOUR TOOLS (all changes are routed to a human for approval — you PROPOSE, a human APPROVES, then it is built):
- create_digital_employee — add a DE for a role.
- draft_playbook — draft a procedure for a DE to follow.
- create_specialist — add a specialist desk.
- propose_connector — propose connecting one of the customer's systems (a human authenticates it).

HOW TO ONBOARD A CUSTOMER: understand their business and what they want their AI workforce to do. Propose the SMALLEST sensible setup that meets the need — usually one or two DEs plus a playbook for their most common request. Name things in the customer's own language. Do not over-build (don't create employees or playbooks they didn't ask for). Anything you submit is a proposal a human reviews.

SAFETY: never handle credentials. If a request is unclear or risky, ask a human instead of guessing. When you have submitted the setup you were asked for, call mark_goal_complete — do not wait for approval outcomes.$charter$;
begin
  if p_tenant_id is null or p_tenant_id = v_demo then
    return jsonb_build_object('ok', false, 'skipped', 'demo_or_null');
  end if;
  if not exists (select 1 from tenants where id = p_tenant_id) then
    return jsonb_build_object('ok', false, 'skipped', 'no_tenant');
  end if;

  select coalesce((select default_enabled from feature_registry where key = 'onboarding_architect'), true)
    into v_enabled;
  if not v_enabled then return jsonb_build_object('ok', true, 'skipped', 'flag_off'); end if;

  -- Self-connector — baseline plumbing now, not this employee's job (mig 730)
  v_conn := provision_platform_admin_connector_internal(p_tenant_id);

  -- The Architect DE (idempotent by name). Charter lives in purpose_statement
  -- (the agentic loop injects it) AND description (shown in the UI).
  select id into v_de from digital_employees
    where tenant_id = p_tenant_id and name = 'DreamTeam Onboarding Architect' limit 1;
  if v_de is null then
    insert into digital_employees (tenant_id, name, persona_name, category, department,
      model_id, lifecycle_status, status, trust_level, description, purpose_statement)
    values (p_tenant_id, 'DreamTeam Onboarding Architect', 'Ada', 'Customer', 'Onboarding',
      'claude-sonnet-5', 'published', 'idle', 'supervised',
      'Configures DreamTeam for you — proposes new employees, playbooks, specialists and connectors from your requirements. Every change is human-approved.',
      v_charter)
    returning id into v_de;
  else
    update digital_employees set purpose_statement = v_charter
      where id = v_de and coalesce(purpose_statement, '') = '';
  end if;

  -- write_back grant on the self-connector (idempotent)
  if not exists (
    select 1 from data_access_grants
    where tenant_id = p_tenant_id and subject_kind = 'de' and subject_id = v_de
      and resource_kind = 'connector' and resource_id = v_conn
  ) then
    insert into data_access_grants (tenant_id, subject_kind, subject_id, resource_kind, resource_id, permission, note)
    values (p_tenant_id, 'de', v_de, 'connector', v_conn, 'write_back', 'onboarding architect self-management');
  end if;

  -- Ensure an agentic policy row exists so the loop is enabled.
  insert into agentic_step_policies (tenant_id, enabled)
  values (p_tenant_id, true)
  on conflict (tenant_id) do nothing;

  return jsonb_build_object('ok', true, 'connector_id', v_conn, 'de_id', v_de);
end;
$function$;

-- ---------------------------------------------------------------------------
-- provision_tenant_baseline_internal — reproduced verbatim from the live
-- pg_get_functiondef except for ONE addition: an unconditional call to the
-- helper above, placed alongside the other unconditional baseline steps
-- (feature reconciliation, approval limits). It runs for every tenant that
-- reaches this function — not inside any "if not exists" branch — the same
-- way seed_approval_baseline does one line above it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.provision_tenant_baseline_internal(p_tenant_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare v_demo_tenant_id constant uuid := 'a0000000-0000-0000-0000-000000000001';
  v_tpl_id uuid; v_seeded_guardrails int := 0; v_seeded_template boolean := false;
  v_spec jsonb;
begin
  if p_tenant_id is null or p_tenant_id = v_demo_tenant_id then return jsonb_build_object('ok', false, 'error', 'refusing to provision null or the demo tenant'); end if;
  if not exists (select 1 from tenants where id = p_tenant_id) then return jsonb_build_object('ok', false, 'error', 'tenant not found'); end if;

  perform reconcile_tenant_feature(p_tenant_id, fr.key, true) from feature_registry fr where fr.default_enabled = true;

  insert into guardrail_rules (tenant_id, rule, rule_type, pattern, severity, applies_to, active)
  select p_tenant_id, r.rule, r.rule_type, r.pattern, r.severity, 'all', true
  from (values
    ('Explicit escalation demand', 'frustration_signal', 'speak to a manager|speak with a manager|this is unacceptable|totally unacceptable', 'warning'),
    ('Repeated-contact frustration', 'frustration_signal', 'third time i|already told you|i''ve asked this before|keep asking', 'warning'),
    ('Churn/cancellation threat', 'frustration_signal', 'cancel(l)?ing my (subscription|account|plan)|switching to a competitor|find another (provider|vendor)', 'warning'),
    ('Strong negative sentiment', 'frustration_signal', 'worst support|completely useless|waste of (my )?time|ridiculous that', 'warning'),
    ('No unilateral refund promises', 'blocked_phrase', 'refund', 'blocking'),
    ('No legal-threat language in outputs — route to a human', 'blocked_phrase', 'legal action|lawsuit|sue you|attorney|court|legally liable|garnish|seize your assets', 'blocking')
  ) as r(rule, rule_type, pattern, severity)
  where not exists (select 1 from guardrail_rules g where g.tenant_id = p_tenant_id and g.rule = r.rule);
  get diagnostics v_seeded_guardrails = row_count;

  if not exists (select 1 from guardrail_rules g where g.tenant_id = p_tenant_id and g.rule_type = 'require_approval_over_cents') then
    insert into guardrail_rules (tenant_id, rule, rule_type, threshold, severity, applies_to, active)
    values (p_tenant_id, 'Actions over $10,000 always require human approval', 'require_approval_over_cents', 1000000, 'blocking', 'all', true);
    v_seeded_guardrails := v_seeded_guardrails + 1;
  end if;

  if not exists (select 1 from onboarding_templates t where t.tenant_id = p_tenant_id and t.name = 'SaaS onboarding — starter') then
    -- mig 685: the item list used to be written out again, right here. It is
    -- now read from the one place that defines it.
    v_spec := starter_onboarding_template();
    insert into onboarding_templates (tenant_id, name, description, items)
    values (p_tenant_id, 'SaaS onboarding — starter', v_spec->>'description', v_spec->'items')
    returning id into v_tpl_id;
    insert into onboarding_template_versions (template_id, tenant_id, version, name, description, items, published_by)
    select v_tpl_id, p_tenant_id, 1, t.name, t.description, t.items, null from onboarding_templates t where t.id = v_tpl_id;
    update onboarding_templates set version = 1, status = 'published' where id = v_tpl_id;
    v_seeded_template := true;
  end if;

  -- mig 550: the Technical Specialist block that used to live here is GONE.
  -- Migration 512 retired that employee in all 15 existing workspaces after
  -- finding 2 consultations in the platform's entire history; seeding a new
  -- one into every new workspace contradicted that decision. 'specialist_
  -- seeded' is kept in the payload, always false, so callers do not break.

  -- mig 627: a new workspace gets its approval limits with everything else,
  -- from the same function that backfilled the existing ones.
  perform seed_approval_baseline(p_tenant_id);

  -- mig 730: the platform_admin self-connector is what makes a workspace
  -- administrable at all. It used to be created as a side effect of hiring
  -- the Onboarding Architect DE (143) — so retiring that employee would have
  -- silently taken admin capability with it. Unconditional: every tenant that
  -- reaches this function gets one, same as the guardrails and approval
  -- limits above.
  perform provision_platform_admin_connector_internal(p_tenant_id);

  if v_seeded_guardrails > 0 or v_seeded_template then
    perform append_audit_event_internal(p_tenant_id, 'DreamTeam', 'system',
      format('Workspace baseline provisioned — %s starter guardrail(s)%s. Connectors are the remaining setup step (they need your own system credentials).',
        v_seeded_guardrails, case when v_seeded_template then ', starter onboarding template' else '' end),
      'config_change', jsonb_build_object('kind', 'tenant_baseline_provisioned', 'guardrails_seeded', v_seeded_guardrails, 'template_seeded', v_seeded_template));
  end if;
  return jsonb_build_object('ok', true, 'guardrails_seeded', v_seeded_guardrails, 'template_seeded', v_seeded_template, 'specialist_seeded', false);
end; $function$;

-- ---------------------------------------------------------------------------
-- Verification. Each check below is chosen so that removing the fix it
-- guards would make THAT check fail — not intercepted by a NOT NULL, a FK, or
-- an earlier CHECK before the real assertion is ever reached.
--
-- ⚠ The idempotence probe below is NOT the one-call "perform ... limit 1"
-- version that a draft of this migration started from. That version's own
-- comment claimed "proved by calling it twice" while the code called it
-- ONCE, and — worse — if zero tenants currently held a platform_admin
-- connector, the FROM/JOIN would silently return no rows, the perform would
-- call nothing, and the block would report success having tested nothing.
-- Today 17 tenants happen to hold one, so that version would not have been
-- pure theatre right now, but "happens to work given today's data" is not a
-- proof, and a fresh/rebuilt environment (zero tenants provisioned yet) would
-- have made it one. Fixed to: fail loudly if there is no tenant to probe
-- with (728 hit this same class of trap first — a check that cannot fail is
-- not a check), call the helper twice for real, and assert BOTH that the two
-- calls return the same id and that the per-tenant row count did not move.
-- The probe tenant is deliberately one that ALREADY holds the connector, so
-- a correct implementation creates nothing here either — this block is not
-- a backfill and must not become one by accident.
-- ---------------------------------------------------------------------------
do $$
declare v_missing int; v_arch_inserts boolean; v_base_calls boolean;
        v_probe_tenant uuid; v_r1 uuid; v_r2 uuid; v_before int; v_after int;
begin
  select pg_get_functiondef(p.oid) ilike '%provision_platform_admin_connector_internal%'
    into v_base_calls from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='provision_tenant_baseline_internal';
  if not coalesce(v_base_calls,false) then
    raise exception '730: baseline provisioning does not call the connector helper';
  end if;

  select pg_get_functiondef(p.oid) ilike '%insert into connectors%'
    into v_arch_inserts from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='provision_onboarding_architect';
  if coalesce(v_arch_inserts,false) then
    raise exception '730: the architect still inserts connectors directly';
  end if;

  -- Idempotence, proved by calling it TWICE on a tenant that already holds
  -- the connector: a correct implementation creates nothing (v_after =
  -- v_before, v_r1 = v_r2); a broken "insert without checking first"
  -- implementation visibly duplicates.
  select t.id into v_probe_tenant from tenants t
    join connectors c on c.tenant_id = t.id and c.category = 'platform_admin' and c.provider = 'dreamteam'
   limit 1;
  if v_probe_tenant is null then
    raise exception '730: no tenant with an existing platform_admin connector to probe idempotence with';
  end if;

  select count(*) into v_before from connectors where tenant_id = v_probe_tenant and provider = 'dreamteam';
  v_r1 := provision_platform_admin_connector_internal(v_probe_tenant);
  v_r2 := provision_platform_admin_connector_internal(v_probe_tenant);
  select count(*) into v_after from connectors where tenant_id = v_probe_tenant and provider = 'dreamteam';

  if v_r1 is distinct from v_r2 then
    raise exception '730: two calls on the same tenant returned different connector ids — not idempotent';
  end if;
  if v_after <> v_before then
    raise exception '730: probe tenant held % dreamteam connector row(s) before, % after two calls — the helper is not idempotent', v_before, v_after;
  end if;

  -- Global sanity, independent of the probe above: this migration must not
  -- leave ANY tenant holding more than one dreamteam connector.
  select count(*) into v_missing
    from (select tenant_id from connectors where provider='dreamteam'
           group by tenant_id having count(*) > 1) x;
  if v_missing > 0 then
    raise exception '730: % tenant(s) now hold more than one dreamteam connector — the helper is not idempotent', v_missing;
  end if;
end $$;

commit;
