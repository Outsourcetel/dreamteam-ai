-- 643_a_marketing_employee_could_hire_staff.sql
-- ============================================================================
-- 22 of 98 digital employees across 12 workspaces were being handed
-- `create_digital_employee` and `hire_from_archetype` — among them Marketing,
-- Accounting, Business Development and Technical Support. A marketing employee
-- could staff the company. Support agents were also holding `send_final_notice`,
-- a debt-collection escalation.
--
-- WHY. get_agentic_tools_for_de scopes tools by CONNECTOR, never by ROLE: for
-- every connected connector it offers every active action in that connector's
-- category, subject only to resolve_access(..., 'write_back'). Connect the
-- DreamTeam self-connector and every employee in the workspace is handed the
-- workspace-administration verbs.
--
-- WHY IT MATTERS MORE THAN IT LOOKS. decide_action_execution — the gate — takes
-- (label, category, destructive, de, amount, type, content). It has no
-- action_definition_id and no permission check: it decides destructive/trust/
-- guardrail/budget, NOT whether this employee may use this action at all. The
-- offer list IS the authorisation boundary, so a mis-scoped offer is a
-- mis-granted permission, not merely a cluttered menu.
--
-- THE RULE. An action may declare the role it requires; an employee must hold
-- it. Tagging is PER-ACTION, not per-category, and that distinction is load
-- bearing: `book_appointment` sits in the platform_admin category but is a
-- phone verb ("requested by a caller on the phone"), so a category-wide rule
-- would have taken a legitimate tool away from every support employee. It is
-- deliberately left untagged. (It is still miscategorised — 0 runs — and should
-- be re-homed when the voice channel lands; moving it now would orphan it,
-- since an action is only offered when its category matches a connected
-- connector's.)
--
-- WHAT IS NOT LOST. Every platform_admin execution in the system's history —
-- all 33 — came from ONE employee, `DreamTeam Onboarding Architect`, which is
-- not flagged as a workforce assistant and has been dormant since 24 July. Both
-- workspaces it operated in (kinetic, acs) now have a proper Workspace
-- Assistant, which keeps these verbs. Nothing live depends on the old grant.
--
-- UNKNOWN REQUIREMENT DENIES. de_may_use_action's CASE has no permissive else.
-- A future role class must be taught here deliberately; it can never arrive
-- default-allowed, which is how the last two privilege holes were shipped.
-- ============================================================================

begin;

-- ── 1. An action may declare the role it needs. ────────────────────────────
alter table public.action_definitions
  add column if not exists requires_role text;

alter table public.action_definitions
  drop constraint if exists action_definitions_requires_role_check;
alter table public.action_definitions
  add constraint action_definitions_requires_role_check
  check (requires_role is null or requires_role = any (array['workforce_assistant'::text]));

comment on column public.action_definitions.requires_role is
  'When set, only an employee holding this role may be OFFERED this action. NULL = no role requirement. The offer list is the authorisation boundary (decide_action_execution does not check identity), so this is a permission, not a menu filter.';

-- ── 2. One definition of the rule, used by the offer path. ────────────────
create or replace function public.de_may_use_action(
  p_tenant_id uuid, p_de_id uuid, p_action_definition_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(
    case
      when ad.requires_role is null then true
      when ad.requires_role = 'workforce_assistant'
        then coalesce(de.is_workforce_assistant, false)
      -- No permissive else. An unrecognised requirement DENIES.
      else false
    end, false)
    from action_definitions ad
    left join digital_employees de
      on de.id = p_de_id and de.tenant_id = p_tenant_id
   where ad.id = p_action_definition_id;
$function$;

-- Supabase grants anon/authenticated as NAMED ROLES by default, which
-- `revoke ... from public` does NOT remove (security_default_execute_grant).
revoke all on function public.de_may_use_action(uuid, uuid, uuid) from public, anon, authenticated;

-- ── 3. Tag the four true workspace-administration verbs. NOT book_appointment. ──
update action_definitions
   set requires_role = 'workforce_assistant', updated_at = now()
 where category = 'platform_admin'
   and action_key in ('create_digital_employee', 'hire_from_archetype',
                      'propose_connector', 'draft_playbook', 'create_specialist');

-- ── 3b. THE OTHER HALF: give the role that SHOULD hold these the access. ──
-- Restricting alone would have closed the hole by breaking the feature. Only
-- ONE of the 12 workforce assistants had write_back on its platform_admin
-- connector; the other 11 sit at 'no_grant', so after the restriction above
-- their workspaces would have had NO path to workspace administration at all.
-- The verbs were reachable only through employees that should never have had
-- them. Its own charter says "Help hire new DEs" — it was never granted the
-- permission to.
--
-- CATEGORY grant, not connector grant, deliberately. resolve_access falls back
-- from connector to category, and auto_provision_new_tenant does NOT create the
-- platform_admin connector — so a per-connector grant written at provisioning
-- time would name a connector that does not exist yet. A category grant covers
-- every current AND future platform_admin connector in the workspace.
insert into data_access_grants
  (tenant_id, subject_kind, subject_id, resource_kind, resource_category, permission, note)
select de.tenant_id, 'de', de.id, 'category', 'platform_admin', 'write_back',
       'mig 643: the workforce assistant is the role that administers this workspace'
  from digital_employees de
 where coalesce(de.is_workforce_assistant, false)
on conflict (tenant_id, subject_kind, subject_id, resource_kind,
             coalesce(resource_id::text, resource_category)) do nothing;

-- ── 4. The offer path honours it. Only the guard changes. ─────────────────
create or replace function public.get_agentic_tools_for_de(p_tenant_id uuid, p_de_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_tools jsonb := '[]'::jsonb;
  v_conn record;
  v_def record;
  v_verdict jsonb;
  v_properties jsonb;
  v_required jsonb;
  v_param record;
  v_type text;
  v_name text;     -- sanitized, connector-unique tool name
  v_suffix text;   -- per-connector discriminator
begin
  for v_conn in
    select id, category, display_name, provider
    from connectors
    where tenant_id = p_tenant_id and status = 'connected'
  loop
    for v_def in
      select *
      from action_definitions
      where status = 'active'
        and provider <> 'internal'
        and category = v_conn.category
        -- Matching on category ALONE offered an ERPNext-connected employee
        -- the Stripe/QuickBooks/Xero tools in the same category. Those could
        -- only ever fail: there is no such connector to run them against.
        and (provider is null or provider = v_conn.provider or provider = 'template')
        and (scope = 'platform' or (scope = 'tenant' and tenant_id = p_tenant_id))
    loop
      select resolve_access(p_tenant_id, 'de', p_de_id, v_conn.id, 'write_back') into v_verdict;
      -- mig 643: connector access says WHERE this employee may write; the role
      -- requirement says WHAT it may do there. Both must hold. Without the
      -- second, connecting the DreamTeam self-connector handed every employee
      -- in the workspace the verbs that create and hire other employees.
      if coalesce((v_verdict->>'allowed')::boolean, false)
         and public.de_may_use_action(p_tenant_id, p_de_id, v_def.id) then
        v_properties := '{}'::jsonb;
        v_required := '[]'::jsonb;

        for v_param in
          select * from jsonb_to_recordset(v_def.param_schema)
            as x(name text, type text, required boolean, help text)
        loop
          v_type := case v_param.type when 'number' then 'number' when 'boolean' then 'boolean' else 'string' end;
          v_properties := v_properties || jsonb_build_object(
            v_param.name, jsonb_build_object('type', v_type, 'description', coalesce(v_param.help, ''))
          );
          if coalesce(v_param.required, false) then
            v_required := v_required || to_jsonb(v_param.name);
          end if;
        end loop;

        -- Connector-unique + charset-safe + length-bounded (Anthropic: ^[a-zA-Z0-9_-]{1,64}$).
        v_suffix := '__' || left(replace(v_conn.id::text, '-', ''), 6) || left(md5(v_def.id::text), 4);
        -- Per-DEFINITION, not just per-connector. One action_key can have
        -- several executors (ERPNext comment vs ERPNext email), and the
        -- model rejects the ENTIRE call if any two tools share a name.
        v_name := regexp_replace(v_conn.category || '__' || v_def.action_key, '[^a-zA-Z0-9_-]', '_', 'g');
        v_name := left(v_name, 64 - length(v_suffix)) || v_suffix;

        v_tools := v_tools || jsonb_build_array(jsonb_build_object(
          'name', v_name,
          'description', v_def.label || '. ' || v_def.description
                         || ' (system: ' || coalesce(nullif(v_conn.display_name, ''), v_conn.provider) || ')',
          'input_schema', jsonb_build_object(
            'type', 'object', 'properties', v_properties, 'required', v_required
          ),
          'connector_id', v_conn.id,
          -- The EXACT definition this tool stands for. The name above already
          -- encodes it (mig 605 suffixes with md5(v_def.id)), but the caller was
          -- left to re-derive the action from (connector, action_key) — which is
          -- ambiguous whenever one key has several executors.
          'action_definition_id', v_def.id,
          'action_key', v_def.action_key,
          'destructive', coalesce((v_def.risk->>'destructive')::boolean, true)
        ));
      end if;
    end loop;
  end loop;

  return v_tools;
end;
$function$;

revoke all on function public.get_agentic_tools_for_de(uuid, uuid) from public, anon, authenticated;

-- ── 4b. New workspaces get it too. Backfill alone is a one-off; the feature
-- has to ship to every tenant, including the ones created tomorrow. ────────
create or replace function public.provision_workforce_assistant_internal(p_tenant_id uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_existing uuid;
  v_id uuid;
BEGIN
  IF p_tenant_id IS NULL THEN RETURN NULL; END IF;

  SELECT id INTO v_existing FROM digital_employees
   WHERE tenant_id = p_tenant_id AND is_workforce_assistant = true LIMIT 1;
  IF v_existing IS NOT NULL THEN
    -- Idempotent, and self-healing: an employee provisioned before this
    -- migration gets its missing permission the next time this runs.
    INSERT INTO de_autonomy (tenant_id, action_type, source_category, de_id, enabled, min_confidence, max_amount_cents)
    VALUES (p_tenant_id, 'answer_dock', NULL, v_existing, true, 70, NULL)
    ON CONFLICT (tenant_id, action_type, coalesce(de_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(playbook_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(source_category, ''))
    DO NOTHING;
    -- mig 643: same self-healing contract for the administration grant.
    INSERT INTO data_access_grants
      (tenant_id, subject_kind, subject_id, resource_kind, resource_category, permission, note)
    VALUES (p_tenant_id, 'de', v_existing, 'category', 'platform_admin', 'write_back',
            'mig 643: the workforce assistant is the role that administers this workspace')
    ON CONFLICT (tenant_id, subject_kind, subject_id, resource_kind,
                 coalesce(resource_id::text, resource_category)) DO NOTHING;
    RETURN v_existing;
  END IF;

  INSERT INTO digital_employees (
    tenant_id, name, icon, category, task_type, status, lifecycle_status,
    trust_level, model_provider, model_id, escalation_model_id,
    confidence_threshold, escalation_threshold, external_reply_mode,
    availability, is_workforce_assistant, is_product_expert, charter
  ) VALUES (
    p_tenant_id, 'Workspace Assistant', 'D', 'Customer', 'chat', 'active',
    'designed',
    'supervised',
    'anthropic', 'claude-haiku-4-5-20251001', 'claude-sonnet-5',
    75, 60,
    'draft',
    jsonb_build_object('mode', 'always_on'),
    true, true,
    jsonb_build_object(
      'name', 'Workspace Assistant',
      'persona', 'You are a trusted advisor helping this organization hire, improve, and manage their digital workforce. You are an expert on the DreamTeamAI platform.',
      'responsibilities', jsonb_build_array(
        'Help hire new DEs by understanding role requirements',
        'Suggest improvements to underperforming DEs based on metrics',
        'Monitor team performance and provide insights',
        'Help retire DEs and transition knowledge',
        'Train new tenants on DreamTeamAI features'),
      'guardrails', jsonb_build_array(
        'Never auto-approve DE changes without explicit user consent',
        'Always show evidence for recommendations',
        'Prioritize user success over automation',
        'Escalate ambiguous decisions to the tenant admin'))
  )
  RETURNING id INTO v_id;

  -- THE PART MIG 332 MISSED. Without this the employee exists and is mute:
  -- resolve_de_autonomy returns enabled=false, de-answer sets the confidence
  -- floor to 101, and every single message escalates to a human.
  -- answer_dock only — this is an internal advisor, never a public widget.
  INSERT INTO de_autonomy (tenant_id, action_type, source_category, de_id, enabled, min_confidence, max_amount_cents)
  VALUES (p_tenant_id, 'answer_dock', NULL, v_id, true, 70, NULL)
  ON CONFLICT (tenant_id, action_type, coalesce(de_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(playbook_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(source_category, ''))
  DO NOTHING;

  -- THE PART MIG 643 FOUND MISSING, exactly parallel to the one above. Its
  -- charter says "Help hire new DEs"; without this grant it could not, and
  -- after 643 restricts those verbs to this role, nobody else can either.
  -- Category-level so it does not depend on the platform_admin connector
  -- existing yet — auto_provision_new_tenant does not create it.
  INSERT INTO data_access_grants
    (tenant_id, subject_kind, subject_id, resource_kind, resource_category, permission, note)
  VALUES (p_tenant_id, 'de', v_id, 'category', 'platform_admin', 'write_back',
          'mig 643: the workforce assistant is the role that administers this workspace')
  ON CONFLICT (tenant_id, subject_kind, subject_id, resource_kind,
               coalesce(resource_id::text, resource_category)) DO NOTHING;

  RETURN v_id;
END $function$;

revoke all on function public.provision_workforce_assistant_internal(uuid) from public, anon, authenticated;

-- ── 5. Prove it BEHAVIOURALLY — both halves. ──────────────────────────────
do $$
declare
  v_leaked   int;
  v_kept     int;
  v_assist   int;
  v_eligible int;
  v_pop      int;
  v_untagged int;
begin
  -- (0) DATA, not population: book_appointment must have stayed reachable for
  -- non-assistants. This is the per-action distinction actually holding rather
  -- than being quietly category-wide, and it is true on every database, so it
  -- runs before any population check can skip out.
  select count(*) into v_untagged
    from action_definitions
   where category = 'platform_admin' and action_key = 'book_appointment'
     and requires_role is null;
  if v_untagged <> 1 then
    raise exception '643: book_appointment was tagged — a phone verb was treated as workspace administration';
  end if;

  -- (a) NOBODY without the role is offered a role-restricted action.
  select count(*) into v_leaked
    from digital_employees de
    join tenants t on t.id = de.tenant_id
   where t.status = 'active'
     and not coalesce(de.is_workforce_assistant, false)
     and exists (
       select 1 from jsonb_array_elements(get_agentic_tools_for_de(de.tenant_id, de.id)) x
        join action_definitions ad on ad.id = (x->>'action_definition_id')::uuid
       where ad.requires_role is not null);
  if v_leaked > 0 then
    raise exception '643: % non-assistant employees are still offered a role-restricted action', v_leaked;
  end if;

  -- THE OTHER HALF. A gate that refuses everyone is as broken as one that
  -- permits everyone — the golden path learned this the hard way. But assert it
  -- only where it CAN be satisfied: an assertion that fails for want of test
  -- data teaches people to delete assertions. Dev carries ZERO employees in
  -- active tenants (its fixtures are all suspended/test rows; the golden path
  -- creates its own tenant per run), so nothing there can be offered anything.
  -- Production has 98 employees, 24 of them offered tools.
  select count(*) into v_pop
    from digital_employees de join tenants t on t.id = de.tenant_id
   where t.status = 'active';
  if v_pop = 0 then
    raise notice '643: no employees in active tenants here — permit-half assertions skipped (expected on dev/replay). The deny-half above still ran.';
    return;
  end if;

  -- (b) At least one workforce assistant must STILL be offered them.
  select count(*) into v_eligible
    from digital_employees de
    join tenants t on t.id = de.tenant_id
   where t.status = 'active'
     and coalesce(de.is_workforce_assistant, false)
     and exists (select 1 from connectors c
                  where c.tenant_id = de.tenant_id and c.status = 'connected'
                    and c.category = 'platform_admin');

  select count(*) into v_assist
    from digital_employees de
    join tenants t on t.id = de.tenant_id
   where t.status = 'active'
     and coalesce(de.is_workforce_assistant, false)
     and exists (
       select 1 from jsonb_array_elements(get_agentic_tools_for_de(de.tenant_id, de.id)) x
        join action_definitions ad on ad.id = (x->>'action_definition_id')::uuid
       where ad.requires_role = 'workforce_assistant');
  if v_eligible = 0 then
    raise notice '643: no workforce assistant sits in an active tenant with a platform_admin connector — cannot assert the permit half here (expected on dev/replay)';
  elsif v_assist = 0 then
    raise exception '643: % assistants COULD be offered the admin verbs and none is — the filter refuses everyone', v_eligible;
  end if;

  -- (c) Untagged actions are UNAFFECTED. Support must not silently lose tools.
  select count(*) into v_kept
    from digital_employees de
    join tenants t on t.id = de.tenant_id
   where t.status = 'active'
     and exists (
       select 1 from jsonb_array_elements(get_agentic_tools_for_de(de.tenant_id, de.id)) x
        join action_definitions ad on ad.id = (x->>'action_definition_id')::uuid
       where ad.requires_role is null);
  if v_kept = 0 then
    raise exception '643: no employee retains any unrestricted action — the filter is too broad';
  end if;

  -- (e) EVERY workforce assistant in an active tenant with an admin connector
  -- must now reach the verbs — not just one. A backfill that covered a single
  -- workspace would leave the other eleven administrable by nobody, which is
  -- the failure this migration exists to avoid.
  if v_assist < v_eligible then
    raise exception '643: only % of % eligible workforce assistants can reach the admin verbs — the backfill missed some', v_assist, v_eligible;
  end if;

  raise notice '643: 0 leaks, %/% assistants retain admin verbs, % employees keep unrestricted tools', v_assist, v_eligible, v_kept;
end $$;

commit;
