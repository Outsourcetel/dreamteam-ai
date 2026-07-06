-- ============================================================
-- Migration 037: THE REAL ACCOUNT DIGITAL EMPLOYEE — proving the
-- configuration-only genericity claim on a real department, not a
-- synthetic test category.
--
-- Context (see memory/gap_analysis_roadmap.md items 14/15/16 and
-- memory/feedback_de_genericity_test.md — the standing genericity
-- test for every new DE build): migration 035 (action layer) and 036
-- (trigger layer) proved the MECHANISM generalizes across domains
-- using only configuration, on a synthetic/reused-specialist test
-- (the existing Technical Specialist, CRM category). Both files were
-- explicit that the remaining work — standing up an actual SECOND
-- department with its own persona — was not yet done. This migration
-- does that: a real "Jordan" Account Success DE persona, config-only,
-- on top of the exact same machinery.
--
-- THE ONE NEW CAPABILITY (explicitly in scope per the founder's brief
-- — "if there is genuinely no existing UI/RPC to CREATE a new DE
-- persona row at all, building a simple generic 'Add a Digital
-- Employee' admin capability is in scope"): a validated, admin-role-
-- gated, audited RPC to create a digital_employees row. Verified
-- first: no such RPC existed anywhere — every existing
-- `insert into digital_employees` in the codebase lives inside a
-- one-time migration seed do-block with a fixed UUID (003, 029), and
-- the live RLS policy on digital_employees (migration 001,
-- "de_tenant_isolation") is a blanket `for all` with no role check —
-- ANY tenant member could otherwise insert directly via the client,
-- which is inconsistent with every other write path in this system
-- (data_access_grants, action_definitions, adapter_templates all
-- gate writes to tenant_owner/tenant_admin through a SECURITY DEFINER
-- RPC). create_digital_employee below is domain-agnostic — it takes
-- name/role-label/category/department and starting autonomy defaults;
-- nothing account-specific is baked into it. It works for creating ANY
-- future DE (Finance, Onboarding-as-its-own-persona, etc.), not just
-- this one.
--
-- EVERYTHING AFTER THE PERSONA ROW IS CONFIGURATION ONLY, using
-- machinery that already exists and is unchanged by this migration:
--   - data_access_grants (029) + seed_default_grants — the Account DE
--     gets crm:read (account/relationship context) — explicitly NOT
--     erp_financials/billing/payroll_hcm, mirroring the founder's own
--     "a support DE should never see company financials" principle.
--   - de_playbook_charter (031) — assigns the Account DE the (newly
--     authored, but via the EXISTING playbook_definitions/steps
--     document format — no new step primitive) account_at_risk
--     playbook, real content: check_account -> connector_action
--     (log a check-in note via the generalized action layer) ->
--     checklist (human follow-up task) -> complete.
--   - playbook_event_rules (021) — the account_at_risk event key
--     ALREADY EXISTS in dispatch_due_triggers (021); this migration
--     only inserts a row wiring it to the new playbook for Acme.
--   - action_definitions (035) — ONE new row, category='crm',
--     action_key='log_checkin_note', provider='template', pointed at
--     the SAME verification adapter template migration 036's proof
--     already used (no new code, one more action binding in that
--     template's existing `actions` jsonb map — pure configuration).
--   - trust_policies / de_autonomy (025/035/036) — a fresh
--     source_category='crm'-scoped action_execute policy at level 0
--     (baseline/gated), so the Account DE starts conservatively
--     (human-approved) rather than silently inheriting Support's
--     already-earned tenant-wide action_execute trust. Same earned-
--     trust ladder, same composition function, nothing new.
--
-- HONEST BUGS FOUND AND FIXED (not new business logic — restoring
-- regressions, discovered while standing up this DE's at-risk path):
--   1. migration 036 REPLACED invoke_playbook_dispatch() to add the
--      poll_de_work_sources piggyback, but in doing so silently
--      DROPPED the nightly health-recompute pre-step migration 021
--      added (section 5 of that file). Health scores have not been
--      auto-recomputed on the 5-min cron since migration 036 applied.
--      Restored below, unchanged in logic from 021, composed with
--      036's piggyback — both run every tick now.
--   2. migration 031 REPLACED dispatch_due_triggers() to add the
--      DE-operating-charter priority ordering, but in doing so
--      silently DROPPED the entire 'account_at_risk' event-rule
--      branch migration 021 added (021 section 4) — only
--      'invoice_overdue' and 'ticket_synced_high_priority' survived
--      into 031's version. This meant account_at_risk event rules
--      (like the one this migration inserts in step 2f above) could
--      never fire, at all, for any tenant, since 031 shipped — the
--      dispatcher simply had no branch that recognized the event key.
--      Restored below, byte-faithful to 021's logic (same query, same
--      dedup/cooldown pattern, same min_arr_cents param), now with
--      031's charter_priority ordering applied on top exactly like
--      the other two event keys already get.
--   3. GENUINE GENERICITY GAP (found via this build's own acceptance
--      test, fixed at the primitive level per the standing rule —
--      "if you find yourself needing a bespoke workaround, fix the
--      primitive instead"): migration 036 added source_category to
--      BOTH de_autonomy and trust_policies and taught
--      decide_work_item_triage (the READ/answer-triage composition) to
--      resolve it, but never updated decide_action_execution (the
--      WRITE/act-execution composition, migration 035) to do the same
--      — it still does a flat tenant-wide de_autonomy lookup. Result:
--      a fresh category-scoped action_execute trust policy (like this
--      migration's crm-scoped one for the Account DE, started at
--      level 0/gated) was silently ignored — the composition instead
--      matched whatever OTHER de_autonomy row existed tenant-wide
--      (Support's already-earned one), auto-executing an action that
--      should have been gated. Fixed below with the IDENTICAL
--      resolution order decide_work_item_triage already uses
--      (category-scoped row first, tenant-wide/null fallback second)
--      — not a new composition rule, the same one migration 036
--      already established, applied to the function that was missed.
-- All three are restorations/completions of already-shipped, already-
-- reviewed generic mechanisms that a later migration accidentally
-- left half-applied — not new business rules invented for this build.
-- ============================================================

-- ============================================================
-- 1. RPC: create_digital_employee — THE GENERIC "ADD A DIGITAL
-- EMPLOYEE" CAPABILITY. Domain-agnostic: name, role label, category,
-- department, starting autonomy defaults. Admin/owner-role gated
-- (JWT path) or service-role (migration/seed path). Audited like
-- every other config-changing RPC in this system.
-- ============================================================
create or replace function create_digital_employee(
  p_name                text,
  p_description         text default '',
  p_category            text default 'Customer',
  p_department          text default '',
  p_persona_name        text default null,
  p_trust_level         text default 'supervised',
  p_confidence_threshold integer default 75,
  p_required_approval   boolean default false
) returns digital_employees
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tenant uuid;
  v_role   text;
  v_user   uuid := auth.uid();
  v_row    digital_employees;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    select tenant_id, role into v_tenant, v_role from profiles where user_id = v_user;
    if v_tenant is null then
      raise exception 'not a member of any tenant';
    end if;
    if v_role not in ('tenant_owner', 'tenant_admin') then
      raise exception 'only workspace owners/admins can create a new Digital Employee';
    end if;
  else
    raise exception 'service-role callers must pass a tenant explicitly — use the seed do-block pattern for migration-time creation';
  end if;

  if trim(coalesce(p_name, '')) = '' then
    raise exception 'a Digital Employee needs a name';
  end if;
  if p_trust_level not in ('supervised', 'semi_autonomous', 'autonomous') then
    raise exception 'trust_level must be one of: supervised, semi_autonomous, autonomous';
  end if;
  if p_confidence_threshold < 0 or p_confidence_threshold > 100 then
    raise exception 'confidence_threshold must be between 0 and 100';
  end if;

  insert into digital_employees (
    tenant_id, name, persona_name, description, category, department,
    status, lifecycle_status, trust_level, confidence_threshold, required_approval, created_by
  ) values (
    v_tenant, trim(p_name), nullif(trim(coalesce(p_persona_name, '')), ''), coalesce(p_description, ''),
    coalesce(p_category, 'Customer'), coalesce(p_department, ''),
    'active', 'designed', p_trust_level, p_confidence_threshold, coalesce(p_required_approval, false), v_user
  )
  returning * into v_row;

  perform append_audit_event(
    v_tenant, coalesce((select full_name from profiles where user_id = v_user), 'you'), 'human',
    format('New Digital Employee created — %s%s (%s / %s)', v_row.name,
      case when v_row.persona_name is not null then format(' ("%s")', v_row.persona_name) else '' end,
      v_row.category, coalesce(nullif(v_row.department, ''), 'unassigned department')),
    'config_change',
    jsonb_build_object('kind', 'digital_employee_created', 'de_id', v_row.id, 'name', v_row.name,
      'persona_name', v_row.persona_name, 'category', v_row.category, 'department', v_row.department,
      'trust_level', v_row.trust_level, 'created_by', v_user)
  );

  return v_row;
end;
$$;

revoke all on function create_digital_employee(text, text, text, text, text, text, integer, boolean) from public;
grant execute on function create_digital_employee(text, text, text, text, text, text, integer, boolean) to authenticated;

-- Tighten the previously-blanket RLS policy on digital_employees: SELECT
-- stays open to any tenant member (transparency, matches every other
-- table in this system); INSERT/UPDATE/DELETE now require admin/owner
-- OR the SECURITY DEFINER RPC path (which bypasses RLS entirely, so
-- this only closes the direct-client-write hole the audit above found).
drop policy if exists "de_tenant_isolation" on digital_employees;
drop policy if exists "de_tenant_select" on digital_employees;
drop policy if exists "de_tenant_admin_write" on digital_employees;
drop policy if exists "de_tenant_admin_update" on digital_employees;
drop policy if exists "de_tenant_admin_delete" on digital_employees;

create policy "de_tenant_select" on digital_employees
  for select
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

create policy "de_tenant_admin_write" on digital_employees
  for insert
  with check (
    tenant_id in (select tenant_id from profiles where user_id = auth.uid() and role in ('tenant_owner', 'tenant_admin'))
  );

create policy "de_tenant_admin_update" on digital_employees
  for update
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid() and role in ('tenant_owner', 'tenant_admin')))
  with check (tenant_id in (select tenant_id from profiles where user_id = auth.uid() and role in ('tenant_owner', 'tenant_admin')));

create policy "de_tenant_admin_delete" on digital_employees
  for delete
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid() and role in ('tenant_owner', 'tenant_admin')));

-- ============================================================
-- 2. THE PERSONA — "Jordan," the Account Success DE, for the live
-- working-pipeline tenant (Acme Telecom). Demo tenant untouched.
-- Uses create_digital_employee's own insert shape directly (service-
-- role seed context, not the RPC — matching the existing pattern in
-- migration 029 for the Support DE) so this migration is idempotent
-- and re-runnable.
-- ============================================================
do $$
declare
  v_tenant uuid := 'a1b2c3d4-0000-0000-0000-000000000001';
  v_de     uuid := 'de000000-0000-0000-0000-000000000301';
  v_playbook_id uuid;
  v_action_id   uuid;
  v_template_id uuid := 'aea9ec1a-77f0-4e4d-a2fe-b3d3ea830303';  -- the existing verification adapter template (product_system/crm shared demo backend, migration 036's proof)
  v_crm_connector uuid;
begin
  if not exists (select 1 from tenants where id = v_tenant) then return; end if;

  -- ── 2a. Persona row ──
  insert into digital_employees (
    id, tenant_id, name, persona_name, description, category, department,
    status, lifecycle_status, trust_level, confidence_threshold, required_approval
  ) values (
    v_de, v_tenant, 'Account Success DE', 'Jordan',
    'Owns account health and relationship follow-through — notices at-risk accounts, checks in, and hands anything requiring judgment to a human. Data access limited to CRM/account context by default — no financial or billing systems.',
    'Customer', 'Account Success',
    'active', 'published', 'supervised', 75, false
  )
  on conflict (id) do nothing;

  -- ── 2b. Data access — crm:read only. Explicitly NOT erp_financials/
  -- billing/payroll_hcm, same principle as seed_default_grants's
  -- existing domains (support/technical/sales/finance). Inserted
  -- directly (same migration-seed context as seed_default_grants's own
  -- writes below) because set_access_grant's audit call requires an
  -- authenticated session (auth.uid()) which a migration/SQL-console
  -- context does not have — resolve_access/data_access_grants (the
  -- actual generic enforcement primitive) take any category directly;
  -- set_access_grant is the human-admin-facing RPC wrapper around the
  -- same table, not a different mechanism.
  -- write_back (not just read): logging a check-in note IS this DE's
  -- job (step 2c/2d below) — still crm-only, never erp_financials/
  -- billing/payroll_hcm. write_back is necessary but never sufficient
  -- for an actual write (decide_action_execution's destructive-always-
  -- gates + guardrail + trust composition still applies on every call).
  insert into data_access_grants (tenant_id, subject_kind, subject_id, resource_kind, resource_category, permission, granted_by, note)
  values (v_tenant, 'de', v_de, 'category', 'crm', 'write_back', null, 'Account DE default — account/relationship context only (read + check-in write-back), no financial systems')
  on conflict (tenant_id, subject_kind, subject_id, resource_kind, coalesce(resource_id::text, resource_category)) do update set permission = excluded.permission, note = excluded.note;

  -- ── 2c. action_definitions: log_checkin_note, category=crm,
  -- non-destructive, provider=template pointed at the SAME shared
  -- verification template migration 036 already proved works for the
  -- crm category (create_test_record). One new action BINDING added
  -- to that template's existing `actions` jsonb map below (pure
  -- configuration — the template's ops/auth/base_url are untouched).
  update adapter_templates
  set definition = jsonb_set(
    definition, '{actions,log_checkin_note}',
    '{"method":"POST","path_template":"/posts","body_template":{"title":"Account check-in — {account_name}","body":"{note}"}}'::jsonb
  )
  where id = v_template_id
    and definition #> '{actions,log_checkin_note}' is null;

  insert into action_definitions (scope, tenant_id, category, action_key, label, description, provider, template_id, param_schema, risk, execution)
  values (
    'tenant', v_tenant, 'crm', 'log_checkin_note',
    'Log an account check-in note',
    'Records a check-in note against the account in the connected CRM — a plain relationship touch-point, not a financial or destructive change.',
    'template', v_template_id,
    '[{"name":"account_name","type":"string","required":true,"help":"The account name for the check-in"},{"name":"note","type":"string","required":true,"help":"The check-in note text"}]'::jsonb,
    '{"destructive": false, "idempotent": false}'::jsonb,
    '{}'::jsonb
  )
  on conflict (scope, tenant_id, category, action_key) do nothing
  returning id into v_action_id;

  if v_action_id is null then
    select id into v_action_id from action_definitions
      where scope = 'tenant' and tenant_id = v_tenant and category = 'crm' and action_key = 'log_checkin_note';
  end if;

  -- ── 2d. The at-risk playbook — real content, existing step
  -- primitives only (check_account / connector_action / checklist /
  -- complete — all from the existing playbook_definitions document
  -- format, migration 019/031, zero new step types).
  insert into playbook_definitions (tenant_id, key, name, description, version, status, trigger_type, de_id, steps)
  values (
    v_tenant, 'account_at_risk_checkin', 'Account At-Risk Check-In',
    'Fires when an account''s computed health flips to at-risk. Logs a check-in note against the account and hands a follow-up to a human — the DE does not attempt anything financial or destructive on its own.',
    1, 'published', 'event', v_de,
    '[
      {"key":"check_account","label":"Check account","params":{}},
      {"key":"connector_action","label":"Log check-in note","params":{"action_key":"log_checkin_note","action_category":"crm","param_templates":{"account_name":"{{account.name}}","note":"Account {{account.name}} flipped to at-risk (computed health score). Jordan (Account Success DE) logged this check-in and flagged it for human follow-up."}}},
      {"key":"checklist","label":"Human follow-up","params":{"items":["Review why this account went at-risk","Reach out to the account contact","Decide whether a retention offer or escalation is needed"]}},
      {"key":"complete","label":"Done","params":{}}
    ]'::jsonb
  )
  on conflict (tenant_id, key) do update set status = 'published', steps = excluded.steps, de_id = excluded.de_id
  returning id into v_playbook_id;

  if v_playbook_id is null then
    select id into v_playbook_id from playbook_definitions where tenant_id = v_tenant and key = 'account_at_risk_checkin';
  end if;

  -- ── 2d-2. Version snapshot — the executor (playbook-execute's
  -- startDefinitionRunServer) reads FROM playbook_versions, not from
  -- playbook_definitions.steps directly (an immutable-snapshot-at-
  -- publish design so editing a definition never changes an
  -- in-flight run). The normal path is the "Publish" button in the
  -- Playbook Builder UI (playbook-execute action=publish); this
  -- migration does the same thing directly since a migration/seed
  -- context has no user session to call that action through. Version
  -- 1, matching playbook_definitions.version above.
  insert into playbook_versions (definition_id, version, steps, published_by)
  select v_playbook_id, 1,
    (select steps from playbook_definitions where id = v_playbook_id), null
  where not exists (select 1 from playbook_versions where definition_id = v_playbook_id);

  -- ── 2e. Charter — Jordan runs this playbook, priority 50 (ahead of
  -- the unassigned-default 1000, behind nothing else configured yet).
  insert into de_playbook_charter (tenant_id, de_id, playbook_id, priority, active)
  values (v_tenant, v_de, v_playbook_id, 50, true)
  on conflict (de_id, playbook_id) do update set active = true, priority = 50;

  -- ── 2f. Event rule — wires the account_at_risk event key (migration
  -- 021's original event key/params shape — min_arr_cents filter,
  -- 24h cooldown dedup) to this playbook. NOTE: the dispatcher branch
  -- that recognizes this event key was found to be MISSING from the
  -- live dispatch_due_triggers (see the honest-bugs note above) —
  -- restored, not reinvented, at the bottom of this migration.
  insert into playbook_event_rules (tenant_id, definition_id, event_key, params, cooldown_hours, active)
  select v_tenant, v_playbook_id, 'account_at_risk', '{}'::jsonb, 24, true
  where not exists (
    select 1 from playbook_event_rules where tenant_id = v_tenant and definition_id = v_playbook_id and event_key = 'account_at_risk'
  );

  -- ── 2g. Earned trust — a fresh crm-scoped action_execute policy at
  -- level 0 (baseline/gated). The Account DE starts conservative:
  -- its check-in action is human-gated until evidence earns it up,
  -- same ladder/composition as every other trust_policies row, not a
  -- new mechanism. (Tenant-wide action_execute is already enabled from
  -- Support's earned trust — this row deliberately does NOT inherit
  -- that; decide_action_execution/resolve reads source_category-scoped
  -- rows first, see migration 036, so Jordan's actions compose against
  -- THIS row, not Support's.)
  insert into trust_policies (tenant_id, de_id, action_category, source_category, baseline_level, current_level, criteria)
  values (
    v_tenant, v_de, 'action_execute', 'crm', 0, 0,
    '{"window_days":30,"min_eval_pass_rate":0.9,"min_eval_samples":0,"min_human_approval_rate":0.9,"min_human_samples":3,"max_guardrail_blocks":0}'::jsonb
  )
  on conflict (tenant_id, action_category, coalesce(source_category, '')) do nothing;

  insert into de_autonomy (tenant_id, action_type, source_category, enabled, max_amount_cents, min_confidence)
  values (v_tenant, 'action_execute', 'crm', false, null, null)
  on conflict (tenant_id, action_type, coalesce(source_category, '')) do nothing;

  -- Best-effort audit (migration/seed context has no auth.uid() session
  -- — use the internal, membership-check-free writer, same pattern
  -- migration 021's compute_account_health_core and 029's
  -- seed_default_grants already use for this exact situation).
  perform append_audit_event_internal(
    v_tenant, 'DreamTeam', 'system',
    'Account Success DE ("Jordan") stood up — crm access (read + check-in write-back), account_at_risk playbook charter, log_checkin_note action registered, action_execute trust started at level 0 (gated) for the crm category.',
    'config_change',
    jsonb_build_object('kind', 'account_de_provisioned', 'de_id', v_de, 'playbook_id', v_playbook_id, 'action_definition_id', v_action_id)
  );
end $$;

-- ============================================================
-- 3. FIX REGRESSION: restore the migration-021 nightly health-recompute
-- pre-step that migration 036's REPLACE of invoke_playbook_dispatch()
-- silently dropped. Both pre-steps (021's health recompute, 036's
-- poll_de_work_sources piggyback) now run on every 5-min tick, exactly
-- as both migrations originally intended — nothing new invented, this
-- restores prior, already-shipped behavior.
-- ============================================================
create or replace function invoke_playbook_dispatch()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_secret  text;
  v_req_id  bigint;
  v_req_id2 bigint;
  v_t       record;
  v_health  integer := 0;
begin
  -- ── (0) nightly health recompute, per tenant with accounts (021) ──
  for v_t in
    select distinct ca.tenant_id
    from customer_accounts ca
    left join health_score_config c on c.tenant_id = ca.tenant_id
    where c.last_computed_at is null or c.last_computed_at < now() - interval '24 hours'
  loop
    perform compute_tenant_health_service(v_t.tenant_id);
    v_health := v_health + 1;
  end loop;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'playbook_dispatch_secret'
  limit 1;
  if v_secret is null then
    return format('health:%s no_secret', v_health);
  end if;

  select net.http_post(
    url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/playbook-execute',
    body    := '{"action":"dispatch"}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dispatch-secret', v_secret
    ),
    timeout_milliseconds := 30000
  ) into v_req_id;

  -- Piggyback: the GENERALIZED proactive trigger, any category, on
  -- the SAME 5-minute tick (036). Independent request; a failure here
  -- never blocks or is blocked by the playbook dispatch above.
  select net.http_post(
    url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/specialist-consult',
    body    := '{"action":"poll_de_work_sources"}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dispatch-secret', v_secret
    ),
    timeout_milliseconds := 30000
  ) into v_req_id2;

  return format('health:%s queued:%s,%s', v_health, v_req_id, v_req_id2);
end;
$$;

revoke all on function invoke_playbook_dispatch() from public;

-- ============================================================
-- 4. FIX REGRESSION: restore the migration-021 'account_at_risk'
-- event-rule branch that migration 031's REPLACE of
-- dispatch_due_triggers() silently dropped (031 carried forward only
-- 'invoice_overdue' and 'ticket_synced_high_priority' from 021's two
-- prior event keys, omitting the third one 021 itself added in the
-- same migration). Byte-faithful restoration of 021's query/dedup/
-- cooldown logic, with 031's charter_priority ordering applied on top
-- exactly like the other two branches already get — not a new rule.
-- ============================================================
create or replace function dispatch_due_triggers(p_tenant_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_sched      record;
  v_rule       record;
  v_acct       record;
  v_inv        record;
  v_ticket     record;
  v_pending    integer := 0;
  v_skipped    integer := 0;
  v_days       integer;
  v_priority   text;
  v_within     integer;
  v_recent     record;
  v_min_arr    bigint;
begin
  -- ── (a) due schedules — lowest DE-assigned priority first ──
  for v_sched in
    select s.*, d.status as def_status,
      coalesce((select min(a.priority) from de_playbook_charter a
                where a.playbook_id = s.definition_id and a.active), 1000) as charter_priority
    from playbook_schedules s
    join playbook_definitions d on d.id = s.definition_id
    where s.active
      and s.next_fire_at is not null
      and s.next_fire_at <= now()
      and (p_tenant_id is null or s.tenant_id = p_tenant_id)
    order by charter_priority asc, s.next_fire_at asc
    for update of s skip locked
  loop
    if v_sched.def_status <> 'published' then
      insert into playbook_trigger_fires (tenant_id, source, schedule_id, definition_id, status, detail)
      values (v_sched.tenant_id, 'schedule', v_sched.id, v_sched.definition_id, 'error',
              'definition is not published — schedule fired into the void');
      v_skipped := v_skipped + 1;
    elsif v_sched.account_selector->>'mode' = 'single' then
      insert into playbook_trigger_fires (tenant_id, source, schedule_id, definition_id, target_account_id, status, detail)
      values (v_sched.tenant_id, 'schedule', v_sched.id, v_sched.definition_id,
              (v_sched.account_selector->>'account_id')::uuid, 'pending_start',
              format('schedule due at %s (single account, charter priority %s)', v_sched.next_fire_at, v_sched.charter_priority));
      v_pending := v_pending + 1;
    else
      v_within := coalesce((v_sched.account_selector->>'renewal_within_days')::int, 60);
      for v_acct in
        select id from customer_accounts
        where tenant_id = v_sched.tenant_id
          and renewal_date is not null
          and renewal_date <= (current_date + v_within)
      loop
        insert into playbook_trigger_fires (tenant_id, source, schedule_id, definition_id, target_account_id, status, detail)
        values (v_sched.tenant_id, 'schedule', v_sched.id, v_sched.definition_id, v_acct.id, 'pending_start',
                format('schedule due at %s (renewal within %s days, charter priority %s)', v_sched.next_fire_at, v_within, v_sched.charter_priority));
        v_pending := v_pending + 1;
      end loop;
    end if;

    update playbook_schedules set last_fired_at = now() where id = v_sched.id;
  end loop;

  -- ── (b) event rules — lowest DE-assigned priority first ────
  for v_rule in
    select r.*, d.status as def_status,
      coalesce((select min(a.priority) from de_playbook_charter a
                where a.playbook_id = r.definition_id and a.active), 1000) as charter_priority
    from playbook_event_rules r
    join playbook_definitions d on d.id = r.definition_id
    where r.active
      and d.status = 'published'
      and (p_tenant_id is null or r.tenant_id = p_tenant_id)
    order by charter_priority asc
  loop
    if v_rule.event_key = 'invoice_overdue' then
      v_days := coalesce((v_rule.params->>'overdue_days')::int, 7);
      for v_inv in
        select id, account_id from renewal_invoices
        where tenant_id = v_rule.tenant_id
          and status = 'sent'
          and due_date is not null
          and due_date < (current_date - v_days)
      loop
        select * into v_recent from playbook_trigger_fires
          where event_rule_id = v_rule.id and target_ref = v_inv.id::text
            and status in ('pending_start', 'started')
            and fired_at > now() - make_interval(hours => v_rule.cooldown_hours)
          order by fired_at desc limit 1;
        if found then
          if not exists (
            select 1 from playbook_trigger_fires
            where event_rule_id = v_rule.id and target_ref = v_inv.id::text
              and status = 'skipped_dedup' and fired_at > v_recent.fired_at
          ) then
            insert into playbook_trigger_fires (tenant_id, source, event_rule_id, definition_id, target_account_id, target_ref, status, detail)
            values (v_rule.tenant_id, 'event', v_rule.id, v_rule.definition_id, v_inv.account_id, v_inv.id::text, 'skipped_dedup',
                    format('invoice already fired within the %sh cooldown', v_rule.cooldown_hours));
            v_skipped := v_skipped + 1;
          end if;
        else
          insert into playbook_trigger_fires (tenant_id, source, event_rule_id, definition_id, target_account_id, target_ref, status, detail)
          values (v_rule.tenant_id, 'event', v_rule.id, v_rule.definition_id, v_inv.account_id, v_inv.id::text, 'pending_start',
                  format('invoice overdue > %s days (charter priority %s)', v_days, v_rule.charter_priority));
          update playbook_event_rules set last_fired_at = now() where id = v_rule.id;
          v_pending := v_pending + 1;
        end if;
      end loop;

    elsif v_rule.event_key = 'ticket_synced_high_priority' then
      v_priority := coalesce(v_rule.params->>'priority', 'p1');
      for v_ticket in
        select id, account_id from support_tickets
        where tenant_id = v_rule.tenant_id
          and source = 'zendesk'
          and priority = v_priority
          and created_at > now() - interval '7 days'
      loop
        select * into v_recent from playbook_trigger_fires
          where event_rule_id = v_rule.id and target_ref = v_ticket.id::text
            and status in ('pending_start', 'started')
            and fired_at > now() - make_interval(hours => v_rule.cooldown_hours)
          order by fired_at desc limit 1;
        if found then
          if not exists (
            select 1 from playbook_trigger_fires
            where event_rule_id = v_rule.id and target_ref = v_ticket.id::text
              and status = 'skipped_dedup' and fired_at > v_recent.fired_at
          ) then
            insert into playbook_trigger_fires (tenant_id, source, event_rule_id, definition_id, target_account_id, target_ref, status, detail)
            values (v_rule.tenant_id, 'event', v_rule.id, v_rule.definition_id, v_ticket.account_id, v_ticket.id::text, 'skipped_dedup',
                    format('ticket already fired within the %sh cooldown', v_rule.cooldown_hours));
            v_skipped := v_skipped + 1;
          end if;
        else
          insert into playbook_trigger_fires (tenant_id, source, event_rule_id, definition_id, target_account_id, target_ref, status, detail)
          values (v_rule.tenant_id, 'event', v_rule.id, v_rule.definition_id, v_ticket.account_id, v_ticket.id::text, 'pending_start',
                  format('%s ticket synced from Zendesk (charter priority %s)', v_priority, v_rule.charter_priority));
          update playbook_event_rules set last_fired_at = now() where id = v_rule.id;
          v_pending := v_pending + 1;
        end if;
      end loop;

    elsif v_rule.event_key = 'account_at_risk' then
      -- RESTORED (originally 021, dropped by 031's REPLACE): accounts
      -- whose COMPUTED health flipped them to at_risk. target_ref =
      -- account id; per-account cooldown dedup identical to the other
      -- two branches. Optional params.min_arr_cents filter (021).
      v_min_arr := coalesce((v_rule.params->>'min_arr_cents')::bigint, 0);
      for v_acct in
        select id, arr_cents from customer_accounts
        where tenant_id = v_rule.tenant_id
          and status = 'at_risk'
          and arr_cents >= v_min_arr
      loop
        select * into v_recent from playbook_trigger_fires
          where event_rule_id = v_rule.id and target_ref = v_acct.id::text
            and status in ('pending_start', 'started')
            and fired_at > now() - make_interval(hours => v_rule.cooldown_hours)
          order by fired_at desc limit 1;
        if found then
          if not exists (
            select 1 from playbook_trigger_fires
            where event_rule_id = v_rule.id and target_ref = v_acct.id::text
              and status = 'skipped_dedup' and fired_at > v_recent.fired_at
          ) then
            insert into playbook_trigger_fires (tenant_id, source, event_rule_id, definition_id, target_account_id, target_ref, status, detail)
            values (v_rule.tenant_id, 'event', v_rule.id, v_rule.definition_id, v_acct.id, v_acct.id::text, 'skipped_dedup',
                    format('account already fired within the %sh cooldown', v_rule.cooldown_hours));
            v_skipped := v_skipped + 1;
          end if;
        else
          insert into playbook_trigger_fires (tenant_id, source, event_rule_id, definition_id, target_account_id, target_ref, status, detail)
          values (v_rule.tenant_id, 'event', v_rule.id, v_rule.definition_id, v_acct.id, v_acct.id::text, 'pending_start',
                  format('account at risk (computed health below threshold, charter priority %s)', v_rule.charter_priority));
          update playbook_event_rules set last_fired_at = now() where id = v_rule.id;
          v_pending := v_pending + 1;
        end if;
      end loop;
    end if;
  end loop;

  return jsonb_build_object('pending', v_pending, 'skipped_dedup', v_skipped);
end;
$$;

revoke all on function dispatch_due_triggers(uuid) from public;
grant execute on function dispatch_due_triggers(uuid) to service_role;

-- ============================================================
-- 5. FIX GENERICITY GAP: decide_action_execution now resolves the
-- action_execute trust dial PER CATEGORY (p_category, already passed
-- in by connector-hub's execute_action — see call site), falling back
-- to the legacy tenant-wide row (source_category is null) exactly the
-- same way decide_work_item_triage already does for answer_widget
-- (migration 036). Composition order (destructive-always-gates ->
-- guardrail-always-wins -> trust-narrows-within-it) is UNCHANGED —
-- only the trust-dial LOOKUP within step 3 gains the category-scoped
-- resolution it should always have had.
-- ============================================================
create or replace function decide_action_execution(
  p_tenant_id     uuid,
  p_action_label  text,
  p_category      text,
  p_destructive   boolean
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_rule     record;
  v_text     text := lower(coalesce(p_action_label, '') || ' ' || coalesce(p_category, ''));
  v_autonomy record;
  v_enabled  boolean;
  v_frag     text;
  v_hit      boolean;
begin
  -- 0) DESTRUCTIVE ALWAYS GATES — checked first, unconditionally.
  if coalesce(p_destructive, true) then
    return jsonb_build_object(
      'decision', 'human_gated_destructive',
      'guardrail_rule_id', null, 'guardrail_rule', null, 'trust_level', null,
      'reasoning', format('This action is marked destructive — it always requires human approval regardless of trust level. This is a platform safety floor, not a per-department setting: "%s" will never auto-execute.', p_action_label)
    );
  end if;

  -- 1) Guardrail check — same blocked_topic/blocked_phrase matching as
  --    decide_inquiry_triage/checkAnswerGuardrails. Guardrails always
  --    win over the trust dial.
  for v_rule in
    select id, rule, pattern from guardrail_rules
    where tenant_id = p_tenant_id and active and severity = 'blocking'
      and rule_type in ('blocked_phrase', 'blocked_topic')
  loop
    if v_rule.pattern is null then continue; end if;
    foreach v_frag in array string_to_array(v_rule.pattern, '|') loop
      v_frag := trim(both from lower(v_frag));
      if v_frag = '' then continue; end if;
      begin
        v_hit := v_text ~ v_frag;
      exception when others then
        v_hit := position(v_frag in v_text) > 0;
      end;
      if v_hit then
        return jsonb_build_object(
          'decision', 'guardrail_blocked',
          'guardrail_rule_id', v_rule.id, 'guardrail_rule', v_rule.rule, 'trust_level', null,
          'reasoning', format('Blocked: guardrail rule "%s" matched this action — routed to a human regardless of trust. Guardrails always win over the trust dial.', v_rule.rule)
        );
      end if;
    end loop;
  end loop;

  -- 2) Trust dial (de_autonomy, action_type='action_execute') —
  --    category-scoped row FIRST, else the legacy tenant-wide row
  --    (source_category is null). SAME resolution order as
  --    decide_work_item_triage (migration 036) — the fix this section
  --    applies was simply never carried over to this sibling function.
  select enabled into v_autonomy
  from de_autonomy
  where tenant_id = p_tenant_id and action_type = 'action_execute'
    and source_category = p_category
  limit 1;
  if not found then
    select enabled into v_autonomy
    from de_autonomy
    where tenant_id = p_tenant_id and action_type = 'action_execute'
      and source_category is null
    limit 1;
  end if;
  v_enabled := coalesce(v_autonomy.enabled, false);

  if v_enabled then
    return jsonb_build_object(
      'decision', 'auto_executed',
      'guardrail_rule_id', null, 'guardrail_rule', null, 'trust_level', 1,
      'reasoning', format('Auto-executed: "%s" is not destructive, no guardrail blocked it, and this workspace has earned enough trust to auto-execute non-destructive actions for %s.', p_action_label, p_category)
    );
  end if;

  return jsonb_build_object(
    'decision', 'human_gated_trust',
    'guardrail_rule_id', null, 'guardrail_rule', null, 'trust_level', null,
    'reasoning', format('Needs approval: "%s" is not destructive, but this workspace has not yet enabled auto-execution for non-destructive %s actions (Governance -> Trust & Architecture).', p_action_label, p_category)
  );
end;
$$;

revoke all on function decide_action_execution(uuid, text, text, boolean) from public;
grant execute on function decide_action_execution(uuid, text, text, boolean) to service_role;
