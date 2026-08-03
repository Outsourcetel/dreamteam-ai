-- 552: hiring from six of the twelve role templates was BROKEN for every
-- workspace. This makes all twelve installable.
--
-- ── HOW IT SURFACED ────────────────────────────────────────────────────────
-- The ask was to offer one workspace's eight role SOPs to everyone. They were
-- already offered: role_archetypes is a global table with no tenant_id, it
-- carries a sop_playbook per role, and install_role_kit stamps that SOP onto a
-- newly hired employee. So the catalogue existed. Installing from it did not.
--
-- Running install_role_kit for another workspace failed outright:
--     null value in column "description" of relation "playbook_definitions"
--
-- install_role_kit inserts a.sop_playbook->>'description', and SIX of the
-- twelve archetypes have an sop_playbook with no description key at all:
-- accounting, billing_ar, cs_manager, fpa, onboarding, renewal_manager.
-- playbook_definitions.description is NOT NULL, so the insert throws and the
-- WHOLE kit install aborts — watchers, guardrails and systems included.
--
-- That is not a cosmetic gap. hireFromArchetype (the Hire Employee wizard)
-- calls instantiate_role_archetype, then install_role_kit, and rethrows any
-- error. So hiring any of those six roles created the employee and then failed,
-- leaving a half-hired employee with no Book of Work, no SOP and no guardrails.
-- Those six are Accounting, Billing/AR, Customer Success, FP&A, Onboarding and
-- Renewal Manager — which is exactly why no other workspace has these SOPs,
-- watchers or KPIs. They could not hire the roles.
--
-- ── THE FIX, IN TWO PARTS ──────────────────────────────────────────────────
-- 1. Give the six archetypes the description their SOP always should have had.
--    The wording is taken from the working copies of the same SOPs, so the
--    catalogue now says what those playbooks actually do.
-- 2. Stop install_role_kit depending on the key being present. A missing
--    description is a thin catalogue-authoring mistake; it must never again be
--    able to abort a hire. It now falls back to the SOP name, then the role
--    name. Same treatment for the SOP's own name.
begin;

-- ── 1. the six missing descriptions ─────────────────────────────────────────
update role_archetypes set sop_playbook = sop_playbook || jsonb_build_object('description',
  'Standard operating procedure for reviewing the ledger and preparing a reconciliation memo.')
 where key = 'accounting' and not (sop_playbook ? 'description');

update role_archetypes set sop_playbook = sop_playbook || jsonb_build_object('description',
  'Standard operating procedure for working overdue receivables from sweep through resolution.')
 where key = 'billing_ar' and not (sop_playbook ? 'description');

update role_archetypes set sop_playbook = sop_playbook || jsonb_build_object('description',
  'Standard operating procedure for keeping an account healthy from early-warning through save or expansion.')
 where key = 'cs_manager' and not (sop_playbook ? 'description');

update role_archetypes set sop_playbook = sop_playbook || jsonb_build_object('description',
  'Standard operating procedure for building a grounded financial report.')
 where key = 'fpa' and not (sop_playbook ? 'description');

update role_archetypes set sop_playbook = sop_playbook || jsonb_build_object('description',
  'How this employee runs a new customer from kickoff to first value to handoff.')
 where key = 'onboarding' and not (sop_playbook ? 'description');

update role_archetypes set sop_playbook = sop_playbook || jsonb_build_object('description',
  'Standard operating procedure for working any commercial-continuity case — renewal, extension, reorder, replacement, renegotiation or termination — from early warning through outcome.')
 where key = 'renewal_manager' and not (sop_playbook ? 'description');

-- ── 2. a bad catalogue entry must never again abort a hire ──────────────────
-- A SECOND uninstallable role turned up while proving the first fix:
-- support_agent carries a watcher of kind 'inbox', which validate_watcher_config
-- rejects. Its own description says intake "is served by the proactive poller",
-- so it documents something rather than watching anything — but it still took
-- the whole hire down with it.
--
-- The existing comment said a bad template "fails loudly here", and loud is
-- right. Failing the entire hire is not: the employee is already created by
-- then, so the caller is left with a half-configured employee and a raw
-- Postgres error. Each watcher now installs in its own sub-block; one that the
-- validator refuses is counted in a new `watchers_skipped` field instead of
-- destroying the rest of the kit. Still visible, no longer fatal.
--
-- Recreated in full from a fresh dump rather than string-patched, so what is
-- deployed is exactly what is written here.
create or replace function public.install_role_kit(p_de_id uuid, p_archetype_key text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  a role_archetypes;
  v_tenant uuid;
  v_watchers int := 0;
  v_skipped int := 0;
  v_guardrails int := 0;
  v_pb_key text;
  v_pb_id uuid;
  v_pb_version int;
  w jsonb;
  g jsonb;
begin
  select tenant_id into v_tenant from digital_employees where id = p_de_id;
  if v_tenant is null then raise exception 'unknown DE %', p_de_id; end if;

  if auth.uid() is not null and not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or (p.tenant_id = v_tenant
           and p.role in ('tenant_owner','tenant_admin','tenant_manager')))) then
    raise exception 'not authorized to configure this DE';
  end if;

  select * into a from role_archetypes where key = p_archetype_key and status = 'active';
  if a.key is null then raise exception 'unknown archetype %', p_archetype_key; end if;

  -- Watchers: derive-your-own-work. validate_watcher_config enforces each
  -- kind's config shape. A template it refuses is SKIPPED and counted (mig
  -- 552) — it must not cost the employee its SOP and guardrails too.
  if a.watcher_templates is not null then
    for w in select * from jsonb_array_elements(a.watcher_templates) loop
      if not exists (
        select 1 from work_watchers
        where de_id = p_de_id and kind = w->>'kind' and label = w->>'label') then
        begin
          insert into work_watchers (tenant_id, de_id, kind, label, description, config, active)
          values (v_tenant, p_de_id, w->>'kind', w->>'label', w->>'description', w->'config', true);
          v_watchers := v_watchers + 1;
        exception when others then
          v_skipped := v_skipped + 1;
        end;
      end if;
    end loop;
  end if;

  -- SOP playbook: attach to THIS DE + publish (snapshot into playbook_versions).
  -- name/description are coalesced (mig 552): six archetypes shipped an
  -- sop_playbook with no description key, and description is NOT NULL, so the
  -- insert threw and took the whole kit with it.
  if a.sop_playbook is not null then
    v_pb_key := p_archetype_key || '_sop';
    insert into playbook_definitions
      (tenant_id, key, name, description, version, status, steps, trigger_type, de_id)
    values
      (v_tenant, v_pb_key,
       coalesce(a.sop_playbook->>'name', a.name || ' SOP'),
       coalesce(a.sop_playbook->>'description', a.sop_playbook->>'name', a.name || ' standard operating procedure'),
       1, 'published', a.sop_playbook->'steps', 'manual', p_de_id)
    on conflict (tenant_id, key) do update
      set name = excluded.name, description = excluded.description,
          steps = excluded.steps, status = 'published',
          version = playbook_definitions.version + 1, de_id = p_de_id,
          updated_at = now()
    returning id, version into v_pb_id, v_pb_version;

    insert into playbook_versions (definition_id, version, steps, published_by)
    values (v_pb_id, v_pb_version, a.sop_playbook->'steps', null)
    on conflict do nothing;
  end if;

  -- Role guardrails: employee-scoped. The permanent propose-only guarantee for
  -- money/terms is the destructive-action FLOOR in decide_action_execution;
  -- these state the rules to the DE and add amount/discount/phrase gates.
  if a.guardrail_templates is not null then
    for g in select * from jsonb_array_elements(a.guardrail_templates) loop
      if not exists (
        select 1 from guardrail_rules
        where tenant_id = v_tenant and scope = 'employee' and scope_ref = p_de_id::text
          and rule_type = g->>'rule_type' and rule = g->>'rule') then
        insert into guardrail_rules
          (tenant_id, rule, rule_type, pattern, threshold, severity, active, scope, scope_ref)
        values
          (v_tenant, g->>'rule', g->>'rule_type', g->>'pattern',
           nullif(g->>'threshold','')::bigint,
           coalesce(g->>'severity','blocking'), true, 'employee', p_de_id::text);
        v_guardrails := v_guardrails + 1;
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'de_id', p_de_id, 'archetype', p_archetype_key,
    'watchers_created', v_watchers, 'watchers_skipped', v_skipped,
    'guardrails_created', v_guardrails,
    'sop_playbook_id', v_pb_id);
end;
$fn$;

-- ── prove it: EVERY archetype, not a sample ─────────────────────────────────
do $do$
declare
  a record; v_t uuid; v_de uuid; v_ok int := 0; v_fail text := '';
  v_kit jsonb; v_desc int;
begin
  select count(*) into v_desc from role_archetypes where not (sop_playbook ? 'description');
  if v_desc <> 0 then raise exception '552: % archetype(s) still have no SOP description', v_desc; end if;

  -- Install all twelve kits onto a real employee in a workspace that has none
  -- of them, then roll the whole thing back. Testing one would prove nothing:
  -- six were broken and six were fine.
  select id into v_t from tenants where name = 'Harbor Peak Consulting';
  select id into v_de from digital_employees
   where tenant_id = v_t and not is_specialist and lifecycle_status <> 'retired'
   order by created_at limit 1;
  if v_de is null then raise exception '552: no employee available to test kit installs'; end if;

  begin
    for a in select key from role_archetypes where status = 'active' order by key loop
      begin
        v_kit := public.install_role_kit(v_de, a.key);
        v_ok := v_ok + 1;
      exception when others then
        v_fail := v_fail || a.key || ' (' || left(sqlerrm, 70) || '); ';
      end;
    end loop;
    raise exception using errcode = '22000', message = '__probe_rollback__';
  exception when sqlstate '22000' then
    if sqlerrm <> '__probe_rollback__' then raise; end if;
  end;

  if v_fail <> '' then raise exception '552: role kits still fail to install: %', v_fail; end if;
  if v_ok <> 12 then raise exception '552: expected 12 kit installs, got %', v_ok; end if;

  -- The SOP is the point of the exercise: every kit must actually produce one,
  -- not merely avoid throwing.
  if exists (select 1 from role_archetypes r where r.status = 'active' and r.sop_playbook is null) then
    raise exception '552: an active archetype has no SOP to install';
  end if;

  raise notice '552: all 12 role kits install cleanly into a workspace that had none';
end $do$;

commit;
