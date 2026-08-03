-- 550: make "every feature ships to every workspace" checkable, and fix the
-- three places where it had quietly stopped being true.
--
-- WHAT THE AUDIT FOUND (and did NOT find)
-- The worry was that features built while working on one workspace had shipped
-- only to that workspace. Measured, that is not what happened:
--   * ZERO database functions, cron jobs, edge functions or frontend files
--     hardcode a tenant id. The machinery is generic.
--   * All 43 connector write actions (20 providers, 10 categories) are
--     scope='platform' with tenant_id null — visible to every workspace.
--   * The feature registry is uniform: no workspace has a feature disabled,
--     and outsourcetel-hq holds no flag another workspace lacks.
--   * complete_signup() applies the full baseline contract to new workspaces.
--   * 14 of 15 existing workspaces already satisfy that baseline exactly.
-- What differs between workspaces is CONTENT they authored — their own SOP
-- playbooks, watchers, KPIs, customer records. That is theirs, and copying one
-- customer's procedures into another's workspace would be wrong.
--
-- The three real defects, fixed here:
--
-- 1. THE BASELINE STILL SEEDS A RETIRED CAPABILITY. Migration 512 retired the
--    Technical Specialist platform-wide and said so plainly: "install_
--    technical_specialist becomes a no-op, so newly provisioned tenants stop
--    inheriting one." But provision_tenant_baseline_internal creates the
--    specialist with its OWN inline INSERT, which 512 never touched. Proven by
--    provisioning a probe workspace: it reported specialist_seeded = true.
--    Every workspace created since 512 inherited an employee that all 15
--    existing workspaces have retired. The block is removed here; the return
--    key stays (always false) so existing callers keep working.
--
-- 2. EIGHT FEATURES TELL CUSTOMERS THEY ARE OFF WHILE THEY ARE ON. Their
--    descriptions still read "Default OFF — enable per workspace" although
--    default_enabled is true. That text is shown in the product. A control
--    that misreports its own state is the specific thing this platform sells
--    against, so the wording is corrected to what is actually true.
--
-- 3. NOTHING WATCHED FOR DRIFT. Parity was being maintained by memory. This
--    adds a detector, in the shape of migration 546's: quiet at today's state,
--    loud when a NEW divergence appears.
begin;

-- ── 1. the baseline stops seeding a retired employee ────────────────────────
create or replace function public.provision_tenant_baseline_internal(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $fn$
declare v_demo_tenant_id constant uuid := 'a0000000-0000-0000-0000-000000000001';
  v_tpl_id uuid; v_seeded_guardrails int := 0; v_seeded_template boolean := false;
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
    insert into onboarding_templates (tenant_id, name, description, items)
    values (p_tenant_id, 'SaaS onboarding — starter',
      '10-step implementation checklist: kickoff → data → config → validation → go-live. Sign-off gates on settings, leave rules, UAT, and go-live.',
      '[{"key":"kickoff_call","label":"Kickoff call held","phase":"kickoff","owner_type":"human","requires_signoff":false,"description":"Intro call: goals, timeline, points of contact."},{"key":"data_export_received","label":"Data export received from customer","phase":"data","owner_type":"either","requires_signoff":false,"description":"Customer sends their employee/location export (CSV or spreadsheet)."},{"key":"employees_imported","label":"Employees imported","phase":"data","owner_type":"de","requires_signoff":false,"description":"Employee records loaded and normalized in the platform."},{"key":"locations_configured","label":"Locations configured","phase":"config","owner_type":"de","requires_signoff":false,"description":"Sites, time zones, and operating hours set up."},{"key":"settings_review","label":"Account settings reviewed","phase":"config","owner_type":"human","requires_signoff":true,"description":"Human sign-off on core account configuration."},{"key":"leave_rules_configured","label":"Leave rules configured","phase":"config","owner_type":"either","requires_signoff":true,"description":"Accrual, carryover, and approval chains — needs human sign-off."},{"key":"test_scenario_run","label":"Test scenario run","phase":"validation","owner_type":"de","requires_signoff":false,"description":"End-to-end test with sample data."},{"key":"uat_approved","label":"UAT approved by customer","phase":"validation","owner_type":"human","requires_signoff":true,"description":"Customer confirms acceptance testing passed."},{"key":"training_session","label":"Training session delivered","phase":"golive","owner_type":"human","requires_signoff":false,"description":"Admin + end-user training completed."},{"key":"go_live","label":"Go-live","phase":"golive","owner_type":"human","requires_signoff":true,"description":"Production cutover — final human sign-off."}]'::jsonb)
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

  if v_seeded_guardrails > 0 or v_seeded_template then
    perform append_audit_event_internal(p_tenant_id, 'DreamTeam', 'system',
      format('Workspace baseline provisioned — %s starter guardrail(s)%s. Connectors are the remaining setup step (they need your own system credentials).',
        v_seeded_guardrails, case when v_seeded_template then ', starter onboarding template' else '' end),
      'config_change', jsonb_build_object('kind', 'tenant_baseline_provisioned', 'guardrails_seeded', v_seeded_guardrails, 'template_seeded', v_seeded_template));
  end if;
  return jsonb_build_object('ok', true, 'guardrails_seeded', v_seeded_guardrails, 'template_seeded', v_seeded_template, 'specialist_seeded', false);
end; $fn$;

-- ── 2. say what is actually true ────────────────────────────────────────────
-- Each of these is default_enabled = true while its description still tells the
-- customer it is off. Corrected individually, because each says something
-- slightly different and a blanket edit would flatten real meaning.
update feature_registry set description =
  'Before a run or objective is marked done, verify that its required approved actions actually executed — not just that the model said so. On by default; its enforcement mode (shadow or enforcing) is set platform-wide.'
 where key = 'definition_of_done';

update feature_registry set description =
  'Compute answer confidence from real retrieval support (distance, coverage, corroboration) instead of trusting the model''s self-report. On by default; its mode is set platform-wide.'
 where key = 'grounded_confidence';

update feature_registry set description =
  'When the keyword filter blocks a draft answer, a small model decides whether the answer ENACTS the prohibited act or merely DESCRIBES the control against it. On by default and fail-closed: only an explicit per-rule opt-in makes a rule clearable, every release is permanently audited, and it never applies to money actions or the public widget.'
 where key = 'guardrail_adjudication';

update feature_registry set description =
  'Use the HNSW index to bound semantic retrieval cost as the corpus grows. On by default; results are identical — turn it off for a workspace if you need an exhaustive scan.'
 where key = 'knowledge_ann_retrieval';

update feature_registry set description =
  'Detect near-duplicate and contradicting knowledge and raise it for human review. On by default — turn it off for a workspace that does not want the review queue.'
 where key = 'knowledge_conflict_detection';

update feature_registry set description =
  'Compute live "is this demand covered?" verdicts on the Quality page by probing the corpus per gap. On by default — the rest of the analytics work without it.'
 where key = 'knowledge_coverage_probe';

update feature_registry set description =
  'Nudge fresher, non-expired knowledge slightly higher in retrieval. On by default — turn it off for a workspace to A/B against citation outcomes.'
 where key = 'knowledge_freshness_weighting';

update feature_registry set description =
  'Allow forcing a re-index (re-embed) of selected documents. On by default.'
 where key = 'knowledge_reembed';

-- ── 3. a detector, so parity stops depending on memory ──────────────────────
create table if not exists public.tenant_parity_exemptions (
  id          uuid primary key default gen_random_uuid(),
  finding_kind text not null,
  subject     text not null,
  reason      text not null,
  reviewed    boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (finding_kind, subject)
);
alter table public.tenant_parity_exemptions enable row level security;
revoke all on public.tenant_parity_exemptions from anon, authenticated;

create or replace function public.audit_tenant_feature_parity()
returns table(finding_kind text, subject text, detail text)
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
begin
  return query
  -- (a) a workspace that does not meet the baseline contract every workspace
  --     is supposed to get. Same thresholds audit_tenant_provisioning uses.
  select 'baseline_incomplete'::text, t.name::text,
         format('employees=%s playbooks=%s guardrails=%s onboarding_versions=%s',
           (select count(*) from digital_employees d where d.tenant_id=t.id and d.lifecycle_status<>'retired' and not d.is_specialist),
           (select count(*) from playbook_definitions p where p.tenant_id=t.id),
           (select count(*) from guardrail_rules g where g.tenant_id=t.id and g.active),
           (select count(*) from onboarding_template_versions v where v.tenant_id=t.id))::text
    from tenants t
   where t.id <> 'a0000000-0000-0000-0000-000000000001'
     and t.name not like '[TEST DEBRIS%'
     and (  (select count(*) from digital_employees d where d.tenant_id=t.id and d.lifecycle_status<>'retired' and not d.is_specialist) < 2
         or (select count(*) from playbook_definitions p where p.tenant_id=t.id) < 2
         or (select count(*) from guardrail_rules g where g.tenant_id=t.id and g.active) < 7
         or (select count(*) from onboarding_template_versions v where v.tenant_id=t.id) < 1)

  union all
  -- (b) a feature that ships on by default but has been switched OFF for a
  --     single workspace — the literal shape of "not available to everyone".
  select 'feature_disabled_for_one'::text, (t.name || ' / ' || o.feature_key)::text,
         'default_enabled=true but this workspace has an explicit disable'::text
    from tenant_feature_overrides o
    join tenants t on t.id = o.tenant_id
    join feature_registry f on f.key = o.feature_key
   where f.default_enabled = true and o.enabled = false

  union all
  -- (c) the drift that produced defect 2: a description that contradicts the
  --     flag. Cheap to check, and it is what customers actually read.
  select 'description_contradicts_flag'::text, f.key::text,
         'default_enabled=true but the description says it is off by default'::text
    from feature_registry f
   where f.default_enabled = true and f.description ilike '%default off%'

  union all
  -- (d) a workspace-scoped action that duplicates a platform one: that
  --     workspace's employees see two tools for the same job.
  select 'tenant_action_shadows_platform'::text, (t.name || ' / ' || a.action_key || ' [' || a.category || ']')::text,
         'a platform action with the same key and category already reaches every workspace'::text
    from action_definitions a
    join tenants t on t.id = a.tenant_id
   where a.scope = 'tenant'
     and exists (select 1 from action_definitions p
                  where p.scope = 'platform' and p.tenant_id is null
                    and p.action_key = a.action_key and p.category = a.category);
end $fn$;
revoke all on function public.audit_tenant_feature_parity() from public, anon, authenticated;

create or replace function public.run_tenant_feature_parity_audit()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare v_count int; v_list text;
begin
  select count(*), string_agg(finding_kind || ': ' || subject, '; ' order by finding_kind, subject)
    into v_count, v_list
    from audit_tenant_feature_parity() a
   where not exists (select 1 from tenant_parity_exemptions e
                      where e.finding_kind = a.finding_kind and e.subject = a.subject);

  if v_count > 0 then
    perform raise_ops_alert(
      'tenant_feature_parity',
      format('%s workspace parity finding(s): %s. Either make the capability reach every workspace, '
             || 'or record why the difference is correct in tenant_parity_exemptions.', v_count, v_list),
      jsonb_build_object('kind', 'tenant_feature_parity', 'count', v_count));
  end if;

  return jsonb_build_object('findings', v_count, 'detail', coalesce(v_list, ''));
end $fn$;
revoke all on function public.run_tenant_feature_parity_audit() from public, anon, authenticated;

-- Weekly, for the same reason as the dormancy audit: a new divergence arrives
-- with a deploy, and a noisy guard-rail is an ignored guard-rail.
select cron.schedule('tenant-feature-parity-weekly', '40 6 * * 1',
                     'select public.run_tenant_feature_parity_audit()');

-- Baseline: the differences that exist today and are NOT parity bugs.
insert into tenant_parity_exemptions (finding_kind, subject, reason, reviewed) values
  ('tenant_action_shadows_platform', 'Acme Telecom / send_payment_reminder [erp_financials]',
   'Legacy workspace-scoped dunning action from mig 043, provider=template. Predates the platform-scope ERPNext/QuickBooks/Xero actions. Acme only, and Acme is suspended; harmless duplication in its own tool list, not a capability another workspace lacks.', true),
  ('tenant_action_shadows_platform', 'Acme Telecom / send_final_notice [erp_financials]',
   'Same legacy mig-043 origin as send_payment_reminder above.', true),
  ('tenant_action_shadows_platform', 'Acme Telecom / flag_for_collections [erp_financials]',
   'Same legacy mig-043 origin as send_payment_reminder above.', true)
on conflict (finding_kind, subject) do nothing;

-- ── prove it, in both directions ────────────────────────────────────────────
do $do$
declare v_res jsonb; v_n int; v_probe uuid; v_spec int; v_before int;
begin
  -- POSITIVE: quiet at today's state.
  v_res := public.run_tenant_feature_parity_audit();
  if (v_res->>'findings')::int <> 0 then
    raise exception '550: parity audit is not quiet at baseline: %', v_res->>'detail';
  end if;

  -- NEGATIVE: it must actually flag something. Withdraw a baselined exemption
  -- and confirm the finding reappears, then put it back.
  delete from tenant_parity_exemptions
   where subject = 'Acme Telecom / flag_for_collections [erp_financials]';
  select count(*) into v_n from audit_tenant_feature_parity() a
   where not exists (select 1 from tenant_parity_exemptions e
                      where e.finding_kind = a.finding_kind and e.subject = a.subject);
  if v_n <> 1 then
    raise exception '550: detector should have flagged the withdrawn row, saw % findings', v_n;
  end if;
  insert into tenant_parity_exemptions (finding_kind, subject, reason, reviewed)
  values ('tenant_action_shadows_platform', 'Acme Telecom / flag_for_collections [erp_financials]',
          'Same legacy mig-043 origin as send_payment_reminder above.', true);

  -- No description may still contradict its flag.
  select count(*) into v_n from feature_registry
   where default_enabled = true and description ilike '%default off%';
  if v_n <> 0 then raise exception '550: % feature description(s) still claim default OFF', v_n; end if;

  -- BEHAVIOUR: a newly provisioned workspace must no longer inherit a
  -- Technical Specialist, and must still get the rest of the baseline.
  -- The probe runs in a sub-block that ends by raising, which rolls the whole
  -- workspace back to the block's implicit savepoint. It cannot simply be
  -- deleted afterwards: deleting a tenant cascades into audit_events, and that
  -- table refuses DELETE. Variables survive the rollback, so the assertions
  -- below still see what the probe measured.
  begin
    insert into tenants (name, slug, status)
    values ('ZZ Parity Probe 550', 'zz-parity-probe-550-' || substr(md5(random()::text), 1, 8), 'trial')
    returning id into v_probe;
    v_res := public.provision_tenant_baseline_internal(v_probe);
    select count(*) into v_spec from digital_employees where tenant_id = v_probe and is_specialist;
    select count(*) into v_before from guardrail_rules where tenant_id = v_probe and active;
    raise exception using errcode = '22000', message = '__probe_rollback__';
  exception when sqlstate '22000' then
    if sqlerrm <> '__probe_rollback__' then raise; end if;
  end;

  if v_spec <> 0 then raise exception '550: a new workspace still inherits % specialist(s)', v_spec; end if;
  if (v_res->>'specialist_seeded')::boolean then raise exception '550: baseline still reports seeding a specialist'; end if;
  if (v_res->>'guardrails_seeded')::int < 7 then
    raise exception '550: new workspace got only % guardrails', v_res->>'guardrails_seeded'; end if;
  if v_before < 7 then raise exception '550: new workspace ended with only % active guardrails', v_before; end if;
  if not (v_res->>'template_seeded')::boolean then
    raise exception '550: new workspace got no onboarding template'; end if;

  raise notice '550: parity audit quiet at baseline and provably able to flag; new workspaces no longer inherit a retired specialist';
end $do$;

commit;
