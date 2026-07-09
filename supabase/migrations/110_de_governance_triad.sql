-- Migration 110: Wave 2 — the DE governance triad (config versioning,
-- ownership/transfer, retirement with real dependency checks).
--
-- docs/10_Digital_Workforce_Framework.md's own gap ledger (added
-- 2026-07-09) self-labels all three of §13.5/§13.6/§13.7 "Roadmap",
-- and an exhaustive codebase investigation confirmed that's accurate:
-- there was no update RPC for a DE's config at all (create-only),
-- no owner concept beyond a never-updated created_by stamp, and no
-- retirement path beyond a narrow feature-flag-triggered soft-disable
-- scoped to exactly two catalog-seeded starter DEs. This migration
-- builds all three as real, enforced machinery, following the
-- existing conventions this codebase already established rather than
-- inventing new ones:
--   * tenant_activity_log (066/067) ALREADY fires a full before/after
--     diff trigger on any UPDATE to digital_employees — versioning
--     reuses that instead of building a second audit mechanism; this
--     migration only adds the version COUNTER and the write path.
--   * "soft-disable, never hard-delete" (deprovision_starter_de_
--     internal, 068) is the established retirement idiom — generalized
--     here to any DE, with real dependency checks first (docs §13.7
--     and the explicit Anti-Pattern §15.10 "no shortcut retirement
--     paths exist" — this migration makes that literally true by
--     removing the RLS DELETE policy that made a shortcut possible).
-- ============================================================

-- ── digital_employees: config_version + owner_id ────────────────────
alter table digital_employees add column if not exists config_version integer not null default 1;
alter table digital_employees add column if not exists owner_id uuid;
-- No FK: mirrors created_by's own existing convention (a bare uuid
-- matching auth.uid()/profiles.user_id, not FK-constrained — Supabase
-- projects generally don't FK into auth.users from app tables).
comment on column digital_employees.owner_id is
  'The human accountable for this DE''s configuration/performance/governance (docs §13.6). Backfilled from created_by; mutated only via transfer_de_ownership().';

-- Every existing DE gets a real owner from its own creation history —
-- "every DE has a defined owner" (docs §13.6) becomes true immediately
-- for the whole existing roster, not just DEs created after this migration.
update digital_employees set owner_id = created_by where owner_id is null and created_by is not null;

-- ── Retirement is genuinely terminal — configuration locked read-only
-- (docs §13.7 step 5) — enforced at the RLS layer, not just inside an
-- RPC, so a raw client-side update against a retired DE is rejected
-- the same as one routed through update_digital_employee(). ─────────
drop policy if exists de_tenant_admin_update on digital_employees;
create policy de_tenant_admin_update on digital_employees
  for update using (
    tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner','tenant_admin'])
    and lifecycle_status <> 'retired'
  ) with check (
    tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner','tenant_admin'])
  );

-- "No shortcut retirement paths exist" (docs §15.10, Anti-Pattern) —
-- today RLS allowed ANY tenant admin to hard-DELETE a DE directly via
-- the client, cascade-destroying de_playbook_assignments/de_playbook_
-- charter/agentic_step_runs/de_learned_behavior_clusters with zero
-- dependency checking. Removed outright: retirement is the only exit
-- path now, and it never deletes the row (soft-disable, matching the
-- rest of this codebase's convention).
drop policy if exists de_tenant_admin_delete on digital_employees;

-- ============================================================
-- update_digital_employee — the config-edit write path. Deliberately
-- excludes trust_level (governed by the evidence-gated trust_apply_
-- level flow, migration 025/108 — this RPC must not offer a bypass)
-- and status/lifecycle_status (governed by retire_digital_employee
-- below). Every param defaults to null/"don't change" so a caller
-- only sends the fields it's actually editing; config_version only
-- increments when something genuinely changed, so opening and
-- re-saving a form with no edits doesn't pollute the version history
-- with phantom entries.
-- ============================================================
create or replace function update_digital_employee(
  p_de_id uuid,
  p_name text default null,
  p_persona_name text default null,
  p_description text default null,
  p_department text default null,
  p_icon text default null,
  p_confidence_threshold integer default null,
  p_required_approval boolean default null,
  p_model_provider text default null,
  p_model_id text default null,
  p_task_type text default null,
  p_escalation_model_id text default null,
  p_escalation_threshold integer default null
) returns digital_employees
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_tenant uuid;
  v_role text;
  v_is_active boolean;
  v_row digital_employees;
  v_name text; v_persona_name text; v_description text; v_department text; v_icon text;
  v_confidence_threshold integer; v_required_approval boolean;
  v_model_provider text; v_model_id text; v_task_type text;
  v_escalation_model_id text; v_escalation_threshold integer;
  v_changed boolean;
begin
  select tenant_id, role, coalesce(is_active, true) into v_tenant, v_role, v_is_active from profiles where user_id = auth.uid();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not v_is_active then raise exception 'account is deactivated'; end if;
  if v_role not in ('tenant_owner', 'tenant_admin') then raise exception 'only workspace owners/admins can edit a Digital Employee'; end if;

  select * into v_row from digital_employees where id = p_de_id and tenant_id = v_tenant;
  if v_row.id is null then raise exception 'employee not found in this workspace'; end if;
  if v_row.lifecycle_status = 'retired' then raise exception 'this employee is retired — configuration is locked read-only'; end if;

  v_name                := coalesce(p_name, v_row.name);
  v_persona_name        := coalesce(p_persona_name, v_row.persona_name);
  v_description         := coalesce(p_description, v_row.description);
  v_department          := coalesce(p_department, v_row.department);
  v_icon                := coalesce(p_icon, v_row.icon);
  v_confidence_threshold:= coalesce(p_confidence_threshold, v_row.confidence_threshold);
  v_required_approval   := coalesce(p_required_approval, v_row.required_approval);
  v_model_provider      := coalesce(p_model_provider, v_row.model_provider);
  v_model_id            := coalesce(p_model_id, v_row.model_id);
  v_task_type           := coalesce(p_task_type, v_row.task_type);
  v_escalation_model_id := coalesce(p_escalation_model_id, v_row.escalation_model_id);
  v_escalation_threshold:= coalesce(p_escalation_threshold, v_row.escalation_threshold);

  v_changed := v_name is distinct from v_row.name
    or v_persona_name is distinct from v_row.persona_name
    or v_description is distinct from v_row.description
    or v_department is distinct from v_row.department
    or v_icon is distinct from v_row.icon
    or v_confidence_threshold is distinct from v_row.confidence_threshold
    or v_required_approval is distinct from v_row.required_approval
    or v_model_provider is distinct from v_row.model_provider
    or v_model_id is distinct from v_row.model_id
    or v_task_type is distinct from v_row.task_type
    or v_escalation_model_id is distinct from v_row.escalation_model_id
    or v_escalation_threshold is distinct from v_row.escalation_threshold;

  if not v_changed then
    return v_row;
  end if;

  update digital_employees set
    name = v_name, persona_name = v_persona_name, description = v_description,
    department = v_department, icon = v_icon,
    confidence_threshold = v_confidence_threshold, required_approval = v_required_approval,
    model_provider = v_model_provider, model_id = v_model_id, task_type = v_task_type,
    escalation_model_id = v_escalation_model_id, escalation_threshold = v_escalation_threshold,
    config_version = v_row.config_version + 1,
    updated_at = now()
  where id = p_de_id and tenant_id = v_tenant
  returning * into v_row;

  return v_row;
end;
$function$;

revoke all on function update_digital_employee(uuid, text, text, text, text, text, integer, boolean, text, text, text, text, integer) from public;
revoke all on function update_digital_employee(uuid, text, text, text, text, text, integer, boolean, text, text, text, text, integer) from anon;
grant execute on function update_digital_employee(uuid, text, text, text, text, text, integer, boolean, text, text, text, text, integer) to authenticated, service_role;

-- ============================================================
-- transfer_de_ownership — docs §13.6: "Ownership can be transferred
-- between users. Transfer is an audited event." A dedicated RPC
-- (rather than folding owner_id into update_digital_employee) because
-- this is a narrative governance event, not a config field edit — it
-- gets its own descriptive audit line naming both the outgoing and
-- incoming owner, not just a raw column diff.
-- ============================================================
create or replace function transfer_de_ownership(
  p_de_id uuid, p_new_owner_user_id uuid, p_note text default null
) returns digital_employees
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_tenant uuid;
  v_role text;
  v_is_active boolean;
  v_row digital_employees;
  v_old_owner_name text;
  v_new_owner_name text;
begin
  select tenant_id, role, coalesce(is_active, true) into v_tenant, v_role, v_is_active from profiles where user_id = auth.uid();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not v_is_active then raise exception 'account is deactivated'; end if;
  if v_role not in ('tenant_owner', 'tenant_admin') then raise exception 'only workspace owners/admins can transfer Digital Employee ownership'; end if;

  select * into v_row from digital_employees where id = p_de_id and tenant_id = v_tenant;
  if v_row.id is null then raise exception 'employee not found in this workspace'; end if;
  if v_row.lifecycle_status = 'retired' then raise exception 'this employee is retired — ownership cannot be transferred'; end if;

  if not exists (
    select 1 from profiles where user_id = p_new_owner_user_id and tenant_id = v_tenant and coalesce(is_active, true)
  ) then
    raise exception 'the new owner must be an active member of this workspace';
  end if;

  select full_name into v_old_owner_name from profiles where user_id = v_row.owner_id;
  select full_name into v_new_owner_name from profiles where user_id = p_new_owner_user_id;

  update digital_employees set owner_id = p_new_owner_user_id, updated_at = now()
  where id = p_de_id and tenant_id = v_tenant
  returning * into v_row;

  perform append_audit_event(
    v_tenant,
    coalesce(v_new_owner_name, 'A workspace admin'),
    'human',
    format('Ownership of %s transferred from %s to %s%s', v_row.name,
      coalesce(v_old_owner_name, 'unassigned'), coalesce(v_new_owner_name, 'unassigned'),
      case when p_note is not null and p_note <> '' then format(' — "%s"', p_note) else '' end),
    'config_change',
    jsonb_build_object('kind', 'de_ownership_transfer', 'de_id', p_de_id,
      'old_owner_user_id', v_row.owner_id, 'new_owner_user_id', p_new_owner_user_id, 'note', p_note)
  );

  return v_row;
end;
$function$;

revoke all on function transfer_de_ownership(uuid, uuid, text) from public;
revoke all on function transfer_de_ownership(uuid, uuid, text) from anon;
grant execute on function transfer_de_ownership(uuid, uuid, text) to authenticated, service_role;

-- ============================================================
-- check_de_retirement_readiness — docs §13.7 step 2: "active
-- Conversations? Active Workflows depending on this DE? Pending
-- Approvals?" Each count is a REAL, verifiable query against tables
-- that already exist — not a guess. de_conversations has no open/
-- closed status column, so "active" is defined by the concrete,
-- objective signal that already exists: an OPEN human_tasks
-- escalation still attached to it. Purely informational recency
-- counts are deliberately NOT included as blockers — only genuinely
-- pending things block retirement, matching this codebase's "no
-- fabricated gates" discipline.
-- ============================================================
create or replace function check_de_retirement_readiness(p_de_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_tenant uuid;
  v_role text;
  v_is_active boolean;
  v_de digital_employees;
  v_open_tasks integer;
  v_pending_actions integer;
  v_playbook_assignments integer;
  v_active_charter_bindings integer;
  v_blockers jsonb := '[]'::jsonb;
begin
  select tenant_id, role, coalesce(is_active, true) into v_tenant, v_role, v_is_active from profiles where user_id = auth.uid();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not v_is_active then raise exception 'account is deactivated'; end if;
  if v_role not in ('tenant_owner', 'tenant_admin') then raise exception 'only workspace owners/admins can check retirement readiness'; end if;

  select * into v_de from digital_employees where id = p_de_id and tenant_id = v_tenant;
  if v_de.id is null then raise exception 'employee not found in this workspace'; end if;

  select count(*) into v_open_tasks
  from human_tasks
  where tenant_id = v_tenant and status = 'open' and related_table = 'de_conversations'
    and related_id in (select id from de_conversations where de_id = p_de_id);

  select count(*) into v_pending_actions
  from action_executions ae
  join human_tasks ht on ht.id = ae.task_id
  where ae.tenant_id = v_tenant and ae.subject_kind = 'de' and ae.subject_id = p_de_id
    and ae.decision in ('human_gated_destructive', 'human_gated_trust') and ht.status = 'open';

  select count(*) into v_playbook_assignments
  from de_playbook_assignments where tenant_id = v_tenant and digital_employee_id = p_de_id;

  select count(*) into v_active_charter_bindings
  from de_playbook_charter where tenant_id = v_tenant and de_id = p_de_id and active;

  if v_open_tasks > 0 then
    v_blockers := v_blockers || jsonb_build_object('kind', 'open_conversations', 'count', v_open_tasks,
      'message', format('%s open escalation(s) from conversations this employee is party to — resolve them first.', v_open_tasks));
  end if;
  if v_pending_actions > 0 then
    v_blockers := v_blockers || jsonb_build_object('kind', 'pending_approvals', 'count', v_pending_actions,
      'message', format('%s action(s) awaiting human approval — decide them first.', v_pending_actions));
  end if;
  if v_playbook_assignments > 0 then
    v_blockers := v_blockers || jsonb_build_object('kind', 'playbook_assignments', 'count', v_playbook_assignments,
      'message', format('Assigned to %s playbook(s) — reassign or remove those assignments first.', v_playbook_assignments));
  end if;
  if v_active_charter_bindings > 0 then
    v_blockers := v_blockers || jsonb_build_object('kind', 'active_charter_bindings', 'count', v_active_charter_bindings,
      'message', format('%s active playbook charter binding(s) — deactivate them first.', v_active_charter_bindings));
  end if;

  return jsonb_build_object(
    'de_id', p_de_id, 'ready', jsonb_array_length(v_blockers) = 0,
    'open_conversations', v_open_tasks, 'pending_approvals', v_pending_actions,
    'playbook_assignments', v_playbook_assignments, 'active_charter_bindings', v_active_charter_bindings,
    'blockers', v_blockers
  );
end;
$function$;

revoke all on function check_de_retirement_readiness(uuid) from public;
revoke all on function check_de_retirement_readiness(uuid) from anon;
grant execute on function check_de_retirement_readiness(uuid) to authenticated, service_role;

-- ============================================================
-- retire_digital_employee — docs §13.7's actual point: retirement is
-- REFUSED, not just discouraged, while real dependencies remain open
-- (Anti-Pattern §15.10: "No shortcut retirement paths exist"). Never
-- deletes the row — soft-disable, matching deprovision_starter_de_
-- internal's established idiom, generalized to any DE rather than
-- just the two catalog-seeded starter DEs.
-- ============================================================
create or replace function retire_digital_employee(p_de_id uuid, p_reason text)
returns digital_employees
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_tenant uuid;
  v_role text;
  v_is_active boolean;
  v_de digital_employees;
  v_readiness jsonb;
  v_owner_name text;
begin
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'a retirement reason is required';
  end if;

  select tenant_id, role, coalesce(is_active, true) into v_tenant, v_role, v_is_active from profiles where user_id = auth.uid();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not v_is_active then raise exception 'account is deactivated'; end if;
  if v_role not in ('tenant_owner', 'tenant_admin') then raise exception 'only workspace owners/admins can retire a Digital Employee'; end if;

  select * into v_de from digital_employees where id = p_de_id and tenant_id = v_tenant;
  if v_de.id is null then raise exception 'employee not found in this workspace'; end if;
  if v_de.lifecycle_status = 'retired' then raise exception 'this employee is already retired'; end if;

  v_readiness := check_de_retirement_readiness(p_de_id);
  if not (v_readiness->>'ready')::boolean then
    raise exception 'cannot retire — unresolved dependencies: %', (
      select string_agg(b->>'message', '; ') from jsonb_array_elements(v_readiness->'blockers') b
    );
  end if;

  update digital_employees set status = 'disabled', lifecycle_status = 'retired', updated_at = now()
  where id = p_de_id and tenant_id = v_tenant
  returning * into v_de;

  -- Soft-disable everything that would otherwise let a "retired"
  -- employee still act (mirrors deprovision_starter_de_internal, 068).
  update de_playbook_charter set active = false where tenant_id = v_tenant and de_id = p_de_id and active;
  update de_autonomy set enabled = false where tenant_id = v_tenant and de_id = p_de_id and enabled;

  select full_name into v_owner_name from profiles where user_id = v_de.owner_id;

  perform append_audit_event(
    v_tenant, coalesce(v_owner_name, 'A workspace admin'), 'human',
    format('%s retired — %s', v_de.name, p_reason),
    'config_change',
    jsonb_build_object('kind', 'de_retirement', 'de_id', p_de_id, 'reason', p_reason)
  );

  return v_de;
end;
$function$;

revoke all on function retire_digital_employee(uuid, text) from public;
revoke all on function retire_digital_employee(uuid, text) from anon;
grant execute on function retire_digital_employee(uuid, text) to authenticated, service_role;
