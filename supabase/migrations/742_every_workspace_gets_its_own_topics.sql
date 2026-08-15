-- 742_every_workspace_gets_its_own_topics.sql
-- ==========================================================================
-- WHY: every workspace created since 2026-07-18 has a topic filter that can
-- only ever say one word, and nothing anywhere says so.
--
-- `de_conversations.category` is a real, live topic axis. A trigger classifies
-- each conversation from `support_triage_rules` via `classify_support_text`,
-- three surfaces read it (the inbox facet, the History report, the command
-- centre), tenants can edit the rules through a full CRUD UI, and certify
-- pins the trigger. None of that is in doubt.
--
-- The rules were seeded ONCE, by migration 233, with:
--
--     insert into support_triage_rules … from tenants t cross join (values …)
--
-- — every tenant that existed AT APPLY TIME. There is no provisioning hook.
-- `classify_support_text` is the only function in the database that reads the
-- table, and nothing seeds it. Measured before this migration:
--
--     hudson-family          created 2026-08-12   0 rules
--     review-lab-disposable  created 2026-08-11   0 rules
--     acs                    created 2026-07-24   0 rules
--     the other 15           created ≤ 2026-07-18  11 rules each
--
-- AND THE FAILURE IS SILENT. `classify_support_text` falls through to a
-- hardcoded 'general' when no rule matches, and a workspace with no rules
-- matches nothing. So the axis exists, looks populated, and carries zero
-- information. Proven live in the two rule-less tenants that have traffic:
-- acs 4 of 4 and review-lab 3 of 3 conversations are labelled `general`.
--
-- This is the same defect class as the starter DEs in migration 723 — a
-- default that was a migration-time snapshot rather than a provisioning
-- decision — and it violates the standing rule that a capability must be live
-- for ALL tenants, not the ones that happened to exist when it shipped.
--
-- THE SHAPE IS NOT NEW. Migration 627 solved exactly this for approval limits
-- and stated the principle in its own comment, still visible in
-- provision_tenant_baseline_internal: *"a new workspace gets its approval
-- limits with everything else, from the same function that backfilled the
-- existing ones."* One function, called from provisioning AND used for the
-- backfill, so the two can never drift. Migration 685 made the same move for
-- the onboarding template (`starter_onboarding_template()`), for the same
-- reason: the list used to be written out twice.
--
-- ONE DEFINITION. The eleven rules below are transcribed from live production
-- and were verified to be byte-identical across all 15 tenants that hold them
-- (a single md5 signature over the whole ordered ruleset). Nobody has
-- customised theirs yet, so there is no question of which set is canonical.
-- Seeding is guarded by `where not exists` per rule name, so a tenant that
-- later deletes or renames one does not have it silently reinstated.
--
-- ==========================================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO, AND WHERE THE MEASURE LIVES
--
-- The obvious companion change is to assert the new invariant in
-- `audit_tenant_provisioning.baseline_complete` and in
-- `audit_tenant_feature_parity`'s `baseline_incomplete` arm. Both are declined
-- here, on purpose, and this is not an omission:
--
--   1. Those two are documented as sharing thresholds (*"Same thresholds
--      audit_tenant_provisioning uses"*), so changing one and not the other
--      creates exactly the divergence migration 723 had to repair.
--   2. `audit_tenant_feature_parity` is wired to the weekly cron
--      `tenant-feature-parity-weekly`, which calls `raise_ops_alert`. Getting
--      a new arm wrong there flags EVERY workspace, every week — the failure
--      mode 723 recorded.
--   3. Replacing either function means carrying its whole body forward. This
--      migration was written from a PARTIAL read of the parity function (it
--      has arms beyond the one shown), and transcribing a body one has not
--      fully read is how arms get silently dropped.
--
-- So the durability measure goes where this repository already keeps its
-- ratchets and already proves they can fail: a certify section, with a
-- mutation fixture that shows it going red. A workspace with zero triage
-- rules must be a finding somewhere, or this fix quietly reopens the first
-- time a new tenant path bypasses the provisioner.
-- ==========================================================================

create or replace function public.seed_support_triage_baseline(p_tenant_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare v_seeded integer := 0;
begin
  if p_tenant_id is null then return 0; end if;
  if not exists (select 1 from tenants where id = p_tenant_id) then return 0; end if;

  insert into support_triage_rules
    (tenant_id, rule_order, name, match_pattern, set_category, set_priority, set_severity, active)
  select p_tenant_id, r.rule_order, r.name, r.match_pattern, r.set_category, r.set_priority, r.set_severity, true
  from (values
    (10,   'Safety',          'injury|someone is hurt|unsafe|not safe|fire|smoke|gas leak|hazard|electric shock|danger',                                                        'safety',          'urgent', 'sev1'),
    (20,   'Security',        'data breach|breach of|hacked|unauthorized access|security incident|leaked|phishing|malware|ransomware|compromised account',                       'security',        'urgent', 'sev1'),
    (30,   'Legal/Regulatory','lawsuit|legal action|threaten to sue|gdpr|hipaa|regulator|compliance violation|subpoena|data protection',                                          'legal',           'high',   'sev2'),
    (40,   'Outage',          'outage|is down|system down|everything is broken|all users affected|cannot access at all|completely broken|nothing works|not working at all|major disruption', 'outage', 'high', 'sev2'),
    (50,   'Data loss',       'data loss|lost my data|deleted everything|missing records|records are gone|corrupted data',                                                        'data',            'high',   'sev2'),
    (60,   'Billing',         'invoice|refund|overcharged|billing|payment failed|charged twice|double charged|credit note|wrong amount',                                          'billing',         'normal', 'sev3'),
    (70,   'Access',          'locked out|reset password|cannot log in|unable to log in|access denied|unlock my account|forgot password|mfa|two factor',                          'access',          'normal', 'sev3'),
    (80,   'Complaint',       'complaint|unacceptable|terrible service|worst|extremely disappointed|want to escalate|speak to a manager|this is ridiculous',                      'complaint',       'high',   'sev3'),
    (90,   'Feature request', 'feature request|would be great if|can you add|please add|it would be nice|suggestion for',                                                         'feature_request', 'low',    'sev4'),
    (100,  'How-to',          'how do i|how to|how can i|where do i|where is|is it possible|walk me through|step by step|tutorial|guide',                                         'how_to',          'low',    'sev4'),
    -- The catch-all. Its match_pattern is NULL by design: classify_support_text
    -- treats a null pattern as "always matches", and rule_order 9999 puts it
    -- last. Without this row the classifier reaches its hardcoded 'general'
    -- fallback instead — the same answer, but with no rule anywhere saying so,
    -- which is precisely the invisible state this migration exists to remove.
    (9999, 'Default',         null,                                                                                                                                              'general',         'normal', 'sev3')
  ) as r(rule_order, name, match_pattern, set_category, set_priority, set_severity)
  where not exists (
    select 1 from support_triage_rules s
     where s.tenant_id = p_tenant_id and s.name = r.name
  );
  get diagnostics v_seeded = row_count;
  return v_seeded;
end;
$fn$;

comment on function public.seed_support_triage_baseline(uuid) is
  'The eleven starter conversation topics, in ONE place. Called by provision_tenant_baseline_internal for new workspaces and by migration 742 to backfill the three that missed them. Idempotent per rule name, so a tenant that deletes one does not get it back.';

-- Perimeter: copy seed_approval_baseline exactly (postgres + service_role, no
-- authenticated). The whole provisioning chain — complete_signup ->
-- provision_tenant_baseline_internal -> here — is SECURITY DEFINER owned by
-- postgres, so it executes as the definer and needs no grant to the caller's
-- own role. Verified below rather than assumed.
revoke all on function public.seed_support_triage_baseline(uuid) from public, anon, authenticated;
grant execute on function public.seed_support_triage_baseline(uuid) to service_role;

-- ==========================================================================
-- The provisioner. Body carried forward VERBATIM from the live definition
-- with exactly one addition, marked below.
-- ==========================================================================
create or replace function public.provision_tenant_baseline_internal(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare v_demo_tenant_id constant uuid := 'a0000000-0000-0000-0000-000000000001';
  v_tpl_id uuid; v_seeded_guardrails int := 0; v_seeded_template boolean := false;
  v_spec jsonb; v_seeded_topics int := 0;
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

  -- ↓↓ mig 742: THE ONLY ADDITION TO THIS FUNCTION ↓↓
  -- The conversation topic axis. Seeded by migration 233 for the tenants that
  -- existed then and by nothing since, so every workspace created after
  -- 2026-07-18 classified every conversation as 'general' and no surface said
  -- so. Same shape as seed_approval_baseline above: one function, used here
  -- and for the backfill, so new and existing workspaces cannot drift.
  v_seeded_topics := seed_support_triage_baseline(p_tenant_id);
  -- ↑↑ end of the 742 addition ↑↑

  if v_seeded_guardrails > 0 or v_seeded_template or v_seeded_topics > 0 then
    perform append_audit_event_internal(p_tenant_id, 'DreamTeam', 'system',
      format('Workspace baseline provisioned — %s starter guardrail(s)%s%s. Connectors are the remaining setup step (they need your own system credentials).',
        v_seeded_guardrails,
        case when v_seeded_template then ', starter onboarding template' else '' end,
        case when v_seeded_topics > 0 then format(', %s conversation topic(s)', v_seeded_topics) else '' end),
      'config_change', jsonb_build_object('kind', 'tenant_baseline_provisioned', 'guardrails_seeded', v_seeded_guardrails, 'template_seeded', v_seeded_template, 'triage_rules_seeded', v_seeded_topics));
  end if;
  return jsonb_build_object('ok', true, 'guardrails_seeded', v_seeded_guardrails, 'template_seeded', v_seeded_template, 'specialist_seeded', false, 'triage_rules_seeded', v_seeded_topics);
end;
$fn$;

-- ==========================================================================
-- THE BACKFILL — real, not rolled back. Three workspaces are missing topics
-- right now, one of them the founder's own. Through the SAME function
-- provisioning now calls, per migration 627's precedent.
-- ==========================================================================
do $$
declare
  r record;
  v_n integer;
  v_total integer := 0;
  v_tenants integer := 0;
begin
  for r in
    select t.id, t.name
      from tenants t
     where t.id <> 'a0000000-0000-0000-0000-000000000001'
       and t.name not like '[TEST DEBRIS%'
       and not exists (select 1 from support_triage_rules s where s.tenant_id = t.id)
     order by t.created_at
  loop
    v_n := seed_support_triage_baseline(r.id);
    v_total := v_total + v_n;
    v_tenants := v_tenants + 1;
    perform append_audit_event_internal(r.id, 'DreamTeam', 'system',
      format('Conversation topics backfilled — %s starter topic(s). This workspace was created after the original topic seeding and had none, so every conversation was being filed under "general".', v_n),
      'config_change',
      jsonb_build_object('kind', 'support_triage_backfilled', 'migration', 742, 'rules_seeded', v_n));
    raise notice '742: seeded % topic(s) for %', v_n, r.name;
  end loop;
  raise notice '742: backfilled % workspace(s), % rule(s) total', v_tenants, v_total;
end $$;

-- ==========================================================================
-- VERIFICATION — the pins inverted.
--
-- "Eleven rows appeared" is NOT the claim worth proving; rows can appear and
-- change nothing. The claim is that classification BEHAVES differently, so
-- probe 2 measures classify_support_text itself, before and after, on the
-- same text. Without that, this whole migration could be seeding a table
-- nothing reads and every assertion would still pass.
-- ==========================================================================
do $$
declare
  v_probe        uuid;
  v_before       text;
  v_after        text;
  v_seeded       integer;
  v_again        integer;
  v_rows         integer;
  v_gap          integer;
  v_tenants_pre  integer;
  v_bad          text[] := '{}';
begin
  -- ---- the real state, after the backfill above -------------------------
  select count(*) into v_gap
    from tenants t
   where t.id <> 'a0000000-0000-0000-0000-000000000001'
     and t.name not like '[TEST DEBRIS%'
     and not exists (select 1 from support_triage_rules s where s.tenant_id = t.id);
  if v_gap <> 0 then
    v_bad := v_bad || format('%s workspace(s) still have zero triage rules after the backfill', v_gap);
  end if;

  select count(*) into v_tenants_pre from support_triage_rules;
  if v_tenants_pre = 0 then
    raise exception '742 vacuity guard: support_triage_rules is empty — every assertion below would be about nothing';
  end if;

  -- ---- probe: an EXISTING workspace, emptied and re-seeded --------------
  -- Deliberately NOT a freshly inserted tenant. `auto_provision_new_tenant`
  -- fires on insert and creates a Workspace Assistant employee; this work is
  -- under a standing instruction not to read or write that employee's setup,
  -- and the cleanest way to honour it is not to trip the trigger at all.
  -- Emptying a real tenant's rules inside a rolled-back block also exercises
  -- the genuine path rather than a synthetic one.
  select t.id into v_probe
    from tenants t
   where t.id <> 'a0000000-0000-0000-0000-000000000001'
     and t.name not like '[TEST DEBRIS%'
     and exists (select 1 from support_triage_rules s where s.tenant_id = t.id)
   order by t.created_at
   limit 1;
  if v_probe is null then
    raise exception '742: no workspace with triage rules to probe against — the backfill above cannot have worked';
  end if;

  begin
    delete from support_triage_rules where tenant_id = v_probe;

    -- INVERSION FIRST. With no rule present, classification of unmistakably
    -- billing text must fall through to the hardcoded 'general'. If this does
    -- NOT hold, everything below proves nothing, because the "after" answer
    -- would have been reached with or without the seed.
    -- ⚠ classify_support_text returns JSONB, not text — the category is one
    -- field of {category, priority, severity, rule}.
    v_before := classify_support_text(v_probe, 'I was overcharged on my invoice and need a refund') ->> 'category';
    if v_before is distinct from 'general' then
      v_bad := v_bad || format('vacuity: an unseeded workspace classified billing text as %L, not %L — the before/after probe cannot demonstrate anything', coalesce(v_before,'NULL'), 'general');
    end if;

    v_seeded := seed_support_triage_baseline(v_probe);
    if v_seeded <> 11 then
      v_bad := v_bad || format('seeding an empty workspace produced %s rule(s), expected 11', v_seeded);
    end if;

    v_after := classify_support_text(v_probe, 'I was overcharged on my invoice and need a refund') ->> 'category';
    if v_after is distinct from 'billing' then
      v_bad := v_bad || format('after seeding, billing text still classifies as %L — the rules are present but the classifier is not using them, which is the only outcome that would make this migration pointless', coalesce(v_after,'NULL'));
    end if;

    -- A second topic, so "one rule matched" is not mistaken for "the ruleset
    -- works". Access text must not come back as billing.
    if classify_support_text(v_probe, 'I am locked out and need to reset password') ->> 'category' is distinct from 'access' then
      v_bad := v_bad || 'access text did not classify as access — only one rule is effective';
    end if;

    -- Precedence, not just membership: safety outranks billing, so text
    -- carrying both must come back safety. A ruleset seeded in the wrong
    -- rule_order would pass every check above and fail this one.
    if classify_support_text(v_probe, 'there is a gas leak and I also want a refund on my invoice') ->> 'category' is distinct from 'safety' then
      v_bad := v_bad || 'text matching both safety and billing did not classify as safety — rule_order is not being honoured';
    end if;

    -- The catch-all must still catch, and now there is a ROW saying so rather
    -- than a hardcoded fallback: the returned rule name distinguishes them.
    if classify_support_text(v_probe, 'zzzz qqqq wwww') ->> 'rule' is distinct from 'Default' then
      v_bad := v_bad || 'unmatched text did not reach the seeded catch-all rule — it fell through to the hardcoded default instead, so the seeded ruleset is incomplete or mis-ordered';
    end if;

    -- ---- idempotence: provisioning must be safe to re-run ---------------
    v_again := seed_support_triage_baseline(v_probe);
    select count(*) into v_rows from support_triage_rules where tenant_id = v_probe;
    if v_again <> 0 or v_rows <> 11 then
      v_bad := v_bad || format('re-seeding added %s row(s) and left %s total — provisioning is not idempotent', v_again, v_rows);
    end if;

    -- ---- and the whole provisioner, not just the seed function ----------
    -- The addition is only real if it is REACHED. Deleting one rule and
    -- running the full baseline provisioner must restore exactly that one.
    delete from support_triage_rules where tenant_id = v_probe and name = 'Billing';
    perform provision_tenant_baseline_internal(v_probe);
    select count(*) into v_rows from support_triage_rules where tenant_id = v_probe;
    if v_rows <> 11 then
      v_bad := v_bad || format('provision_tenant_baseline_internal left %s rule(s), expected 11 — the seed call is not on the provisioning path', v_rows);
    end if;

    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception when others then
    if sqlerrm <> '__undo_probe__' then raise; end if;
  end;

  -- ---- the probe tenant's rules must be intact --------------------------
  select count(*) into v_rows from support_triage_rules where tenant_id = v_probe;
  if v_rows <> 11 then
    v_bad := v_bad || format('the probe workspace holds %s rule(s) after rollback, expected 11 — the probe did not roll back and this migration has mutated a real workspace', v_rows);
  end if;

  -- ---- perimeter --------------------------------------------------------
  if has_function_privilege('authenticated', 'public.seed_support_triage_baseline(uuid)', 'execute') then
    v_bad := v_bad || 'authenticated can execute seed_support_triage_baseline — a signed-in user could reinstate rules a workspace deliberately removed';
  end if;
  if has_function_privilege('anon', 'public.seed_support_triage_baseline(uuid)', 'execute') then
    v_bad := v_bad || 'anon can execute seed_support_triage_baseline';
  end if;
  if not has_function_privilege('service_role', 'public.seed_support_triage_baseline(uuid)', 'execute') then
    v_bad := v_bad || 'service_role CANNOT execute seed_support_triage_baseline — the grant did not land';
  end if;

  if array_length(v_bad, 1) > 0 then
    raise exception '742: % check(s) failed: %', array_length(v_bad, 1), array_to_string(v_bad, ' | ');
  end if;

  raise notice '742: all checks passed — 0 workspaces without topics; an unseeded workspace demonstrably answered "general" to billing text and a seeded one answered "billing"; re-seeding is a no-op; the provisioner reaches the seed';
end $$;
