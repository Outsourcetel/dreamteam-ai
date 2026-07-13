-- ============================================================
-- 143 — The Onboarding Architect, enabled by default for every tenant.
--
-- Every tenant gets a "DreamTeam Onboarding Architect" Digital Employee +
-- the DreamTeam self-connector + a write_back grant, so a customer can
-- describe what they need and the DE proposes the setup (DEs, playbooks,
-- specialists, connectors) — every build human-approved (migration 142).
--
-- Integration is a decoupled, exception-safe AFTER INSERT trigger on
-- tenants (never touches the critical provisioning function; can never
-- break tenant creation) + a one-time backfill of existing tenants.
-- Flag-gated by feature_registry 'onboarding_architect' (default on).
-- ============================================================

-- 1. Honest 'rate_limited' terminal state for the agentic loop (a persistent
--    Anthropic 429/529 after retries ends here — retryable, not a hard fail).
alter table agentic_step_runs drop constraint if exists agentic_step_runs_status_check;
alter table agentic_step_runs add constraint agentic_step_runs_status_check
  check (status = any (array[
    'running','completed','failed','budget_exceeded','max_iterations_exceeded',
    'no_progress','blocked_llm','rate_limited'
  ]));

-- 2. The feature flag (default on = "enabled by default for all tenants").
insert into feature_registry (key, label, description, default_enabled, category)
values ('onboarding_architect', 'Onboarding Architect',
  'A Digital Employee that configures DreamTeam for you — proposes new employees, playbooks, specialists and connectors from your requirements, always with human approval.',
  true, 'workforce')
on conflict (key) do update set default_enabled = excluded.default_enabled, description = excluded.description;

-- 3. Idempotent per-tenant provisioning of the Architect + self-connector + grant.
create or replace function provision_onboarding_architect(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
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

  -- Self-connector (idempotent)
  select id into v_conn from connectors
    where tenant_id = p_tenant_id and provider = 'dreamteam' limit 1;
  if v_conn is null then
    insert into connectors (tenant_id, provider, base_url, category, status, display_name)
    values (p_tenant_id, 'dreamteam', 'https://dreamteam.internal', 'platform_admin', 'connected', 'DreamTeam AI (self)')
    returning id into v_conn;
  end if;

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
$$;

revoke all on function provision_onboarding_architect(uuid) from public, anon, authenticated;
grant execute on function provision_onboarding_architect(uuid) to service_role;

-- 4. Decoupled, exception-safe trigger: every new tenant gets the Architect,
--    and a failure here can NEVER block tenant creation.
create or replace function trg_provision_onboarding_architect()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  begin
    perform provision_onboarding_architect(new.id);
  exception when others then
    null; -- best-effort; tenant creation must always succeed
  end;
  return new;
end;
$$;

drop trigger if exists provision_onboarding_architect_trg on tenants;
create trigger provision_onboarding_architect_trg
  after insert on tenants
  for each row execute function trg_provision_onboarding_architect();

-- 5. Backfill every existing real (non-demo, non-suspended) tenant.
do $$
declare r record;
begin
  for r in
    select id from tenants
    where id <> 'a0000000-0000-0000-0000-000000000001'
      and status in ('active','trial')
  loop
    perform provision_onboarding_architect(r.id);
  end loop;
end $$;
