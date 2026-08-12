-- 723 — a new workspace starts with one employee
--
-- The founder set up a brand-new tenant (Hudson & Family, Healthcare) and found
-- four digital employees waiting for him. He asked why, and there is no good
-- answer, so this removes two of them.
--
-- Where the four came from. Two are deliberate and stay: the Workspace
-- Assistant (auto_provision_new_tenant_trigger, 196 -> 332) and the Onboarding
-- Architect (143), which onboarding-assist matches BY NAME and which is the
-- only creator of the platform_admin connector. The other two — "Finance DE"
-- and "Account Success DE", plus a playbook each — are side effects of the
-- feature flags `finance_de` and `account_de` being default_enabled.
--
-- Read 068's own header for why those two flags exist. Migration 050 had
-- shipped a feature registry and a console toggle that "actually GATED or
-- PROVISIONED nothing". 068 picked these two keys to prove the mechanism end to
-- end, precisely BECAUSE they were the only ones that created visible standing
-- state. They were the demonstration payload for a plumbing fix. Nobody ever
-- decided that a new customer needs a Finance DE, and a healthcare practice
-- being handed an Overdue Invoice Follow-Up playbook is the proof.
--
-- FOUNDER DECISION 2026-08-12: new tenants only. The 17 existing workspaces
-- keep the employees they already have. That is what this migration does and
-- all it does — it changes what `provision_tenant_baseline_internal` seeds, via
-- its `where fr.default_enabled = true` loop. It deliberately does NOT call
-- reconcile_tenant_feature(..., false) on anybody. Verified before writing:
-- there are ZERO readers of these two keys in src/ or supabase/functions/, the
-- weekly cron `tenant-feature-parity-weekly` -> run_tenant_feature_parity_audit
-- is read-only, and only one tenant_feature_overrides row exists for either key
-- (account_de, enabled=true) so no existing workspace loses anything.
--
-- The flags stay in the registry and stay reconcilable, so a workspace that
-- wants a starter finance employee can still switch one on from the console.
-- deprovision_starter_de_internal pauses rather than deletes, so this is
-- reversible in both directions.

begin;

update public.feature_registry
   set default_enabled = false,
       description = 'Seeds a starter finance employee and an overdue-invoice playbook. '
                  || 'Default OFF — switch it on if you want one; new workspaces start clean.'
 where key = 'finance_de';

update public.feature_registry
   set default_enabled = false,
       description = 'Seeds a starter account-success employee and an at-risk check-in playbook. '
                  || 'Default OFF — switch it on if you want one; new workspaces start clean.'
 where key = 'account_de';

-- Note on the description text: parity finding (c) only fires when a
-- description says "default off" while default_enabled is TRUE. These now say
-- it and ARE false, which is the honest pairing, not a contradiction.

-- ---------------------------------------------------------------------------
-- The baseline contract has to move in the same transaction, or every
-- workspace alerts every Monday.
--
-- Both audit functions assert `playbook_definitions >= 2`. That threshold was
-- only ever satisfiable because the two flags above each seeded one playbook.
-- With them off, a correctly-provisioned new workspace has zero playbooks and
-- would be reported as baseline_incomplete forever.
--
-- The fix is to stop asserting a thing we no longer promise, NOT to weaken the
-- audit. The other three clauses still describe exactly what provisioning does
-- deliver, and they stay: >= 2 employees (the Workspace Assistant and the
-- Onboarding Architect — so this still fails loudly if either trigger breaks,
-- and note 143 swallows its own exceptions, which is precisely the failure this
-- clause is here to catch), >= 7 active guardrails, >= 1 onboarding template
-- version. The playbook COUNT is still reported by audit_tenant_provisioning;
-- it just no longer gates.
-- ---------------------------------------------------------------------------

create or replace function public.audit_tenant_feature_parity()
 returns table(finding_kind text, subject text, detail text)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  return query
  -- (a) a workspace that does not meet the baseline contract every workspace
  --     is supposed to get. Same thresholds audit_tenant_provisioning uses.
  select 'baseline_incomplete'::text, t.name::text,
         format('employees=%s playbooks=%s guardrails=%s onboarding_versions=%s',
           (select count(*) from digital_employees d where d.tenant_id=t.id and d.lifecycle_status<>'retired'),
           (select count(*) from playbook_definitions p where p.tenant_id=t.id),
           (select count(*) from guardrail_rules g where g.tenant_id=t.id and g.active),
           (select count(*) from onboarding_template_versions v where v.tenant_id=t.id))::text
    from tenants t
   where t.id <> 'a0000000-0000-0000-0000-000000000001'
     and t.name not like '[TEST DEBRIS%'
     and (  (select count(*) from digital_employees d where d.tenant_id=t.id and d.lifecycle_status<>'retired') < 2
         -- playbooks intentionally NOT asserted: provisioning no longer seeds any (723)
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
end $function$;

create or replace function public.audit_tenant_provisioning()
 returns table(tenant_id uuid, tenant_name text, tenant_status text, des bigint, playbooks bigint,
               guardrails bigint, onboarding_templates bigint, specialists bigint,
               trust_policies bigint, autonomy_rows bigint, connectors bigint, baseline_complete boolean)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if not resolve_platform_capability(auth.uid(), 'tenants.manage') then raise exception 'only a platform team member with tenant management access may audit tenant provisioning'; end if;
  return query
  select t.id, t.name, t.status,
    (select count(*) from digital_employees d where d.tenant_id = t.id and d.lifecycle_status <> 'retired'),
    (select count(*) from playbook_definitions p where p.tenant_id = t.id),
    (select count(*) from guardrail_rules g where g.tenant_id = t.id and g.active),
    (select count(*) from onboarding_template_versions v where v.tenant_id = t.id),
    0,
    (select count(*) from trust_policies tp where tp.tenant_id = t.id),
    (select count(*) from de_autonomy da where da.tenant_id = t.id),
    (select count(*) from connectors c where c.tenant_id = t.id),
    (select count(*) from digital_employees d where d.tenant_id = t.id and d.lifecycle_status <> 'retired') >= 2
      -- playbooks intentionally NOT asserted: provisioning no longer seeds any (723)
      and (select count(*) from guardrail_rules g where g.tenant_id = t.id and g.active) >= 7
      and (select count(*) from onboarding_template_versions v where v.tenant_id = t.id) >= 1
  from tenants t
  where t.id <> 'a0000000-0000-0000-0000-000000000001' and t.name not like '[TEST DEBRIS%'
  order by t.created_at desc;
end; $function$;

-- ---------------------------------------------------------------------------
-- Re-assert the EXECUTE grants explicitly rather than relying on CREATE OR
-- REPLACE preserving them. It does preserve them today, but a rebuild from the
-- baseline dump would not, and 722 has just been through this exact class of
-- bug ("preserves service_role instead of assuming it").
--
-- The asymmetry below is DELIBERATE and is the reason this block is spelled out
-- instead of being a copy-pasted blanket revoke:
--
--   * audit_tenant_feature_parity  — service_role only. Nothing signed in ever
--     calls it; the weekly cron reaches it through
--     run_tenant_feature_parity_audit, which is itself service_role only.
--
--   * audit_tenant_provisioning   — KEEPS `authenticated`. It is called from the
--     Platform Console by a signed-in platform admin, and it guards itself on
--     its first line with resolve_platform_capability(auth.uid(),'tenants.manage').
--     Revoking `authenticated` here would break that page. Measured before
--     writing: its live ACL is postgres + authenticated + service_role.
--
-- Both drop `public` and `anon` unconditionally.
-- ---------------------------------------------------------------------------

revoke execute on function public.audit_tenant_feature_parity() from public, anon, authenticated;
grant  execute on function public.audit_tenant_feature_parity() to service_role;

revoke execute on function public.audit_tenant_provisioning() from public, anon;
grant  execute on function public.audit_tenant_provisioning() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Prove it, rather than asserting it. Three checks that would each have caught
-- a mistake in the above.
-- ---------------------------------------------------------------------------
do $$
declare v_on int; v_incomplete int;
begin
  select count(*) into v_on
    from public.feature_registry where key in ('finance_de','account_de') and default_enabled;
  if v_on <> 0 then
    raise exception '723: expected both starter-DE flags off, % still on', v_on;
  end if;

  -- The grant block above is easy to get backwards, and getting it backwards
  -- either breaks the Platform Console or quietly re-opens a function to every
  -- signed-in user. Assert both directions, not just one.
  if has_function_privilege('authenticated', 'public.audit_tenant_feature_parity()', 'execute') then
    raise exception '723: audit_tenant_feature_parity must NOT be executable by authenticated';
  end if;
  if not has_function_privilege('authenticated', 'public.audit_tenant_provisioning()', 'execute') then
    raise exception '723: audit_tenant_provisioning MUST stay executable by authenticated (Platform Console)';
  end if;

  -- No EXISTING workspace may become baseline_incomplete because of this change.
  -- (They all still have their playbooks; this asserts we did not break the
  -- other three clauses while editing.)
  select count(*) into v_incomplete
    from public.audit_tenant_feature_parity()
   where finding_kind = 'baseline_incomplete';
  if v_incomplete <> 0 then
    raise exception '723: % existing workspace(s) went baseline_incomplete: %',
      v_incomplete,
      (select string_agg(subject || ' [' || detail || ']', '; ')
         from public.audit_tenant_feature_parity() where finding_kind = 'baseline_incomplete');
  end if;
end $$;

commit;
