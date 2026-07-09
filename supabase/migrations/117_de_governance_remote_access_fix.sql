-- Second wave of the Remote-Access-tenant-resolution fix (see 116).
--
-- These 9 DE-governance functions (all authored earlier this session,
-- Waves 1.1/2/4/5) still resolved the caller's tenant via a direct
-- `select tenant_id from profiles where user_id = auth.uid()` lookup.
-- That silently returns null for any platform admin operating via
-- Remote Access (platform admin profiles have tenant_id = null by
-- design), throwing a raw "not a member of any/this tenant" /
-- "not a member of this workspace" exception -- almost certainly what
-- the founder relayed in his own words as "no account attached" and
-- "DE has no tabs" while testing a new tenant through Remote Access.
--
-- Fix: swap the direct lookup for auth_tenant_id() (resolves own
-- membership first, falls back to an active Remote Access session --
-- migration 058/105), and for the owner/admin-gated functions, swap
-- the separate role check for auth_has_tenant_role(array[...]), which
-- already treats an active Remote Access session as authorized (same
-- helper migration 105 built and 116 already relies on). This drops
-- the separate is_active precision-message branch: auth_tenant_id()
-- only resolves non-null for an active caller by construction, so the
-- extra check was redundant once using it -- matching how every other
-- auth_tenant_id()/auth_has_tenant_role() consumer already behaves.
--
-- Business logic, error messages (other than the redundant is_active
-- one), and every non-auth line are byte-for-byte unchanged.

create or replace function check_de_retirement_readiness(p_de_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, extensions
as $$
declare
  v_tenant uuid;
  v_de digital_employees;
  v_open_tasks integer;
  v_pending_actions integer;
  v_playbook_assignments integer;
  v_active_charter_bindings integer;
  v_consulted_by integer;
  v_blockers jsonb := '[]'::jsonb;
begin
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then raise exception 'only workspace owners/admins can check retirement readiness'; end if;

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

  select count(*) into v_consulted_by
  from de_consultation_grants where tenant_id = v_tenant and target_de_id = p_de_id and active;

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
  if v_consulted_by > 0 then
    v_blockers := v_blockers || jsonb_build_object('kind', 'consulted_by_other_des', 'count', v_consulted_by,
      'message', format('%s other employee(s) are configured to consult this one — remove those consultation grants first.', v_consulted_by));
  end if;

  return jsonb_build_object(
    'de_id', p_de_id, 'ready', jsonb_array_length(v_blockers) = 0,
    'open_conversations', v_open_tasks, 'pending_approvals', v_pending_actions,
    'playbook_assignments', v_playbook_assignments, 'active_charter_bindings', v_active_charter_bindings,
    'consulted_by_other_des', v_consulted_by,
    'blockers', v_blockers
  );
end;
$$;

create or replace function create_de_development_item(p_de_id uuid, p_description text, p_target_metric text default null, p_target_value numeric default null, p_priority text default 'medium', p_due_date date default null, p_assigned_to uuid default null)
returns de_development_items
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tenant uuid; v_row de_development_items;
begin
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then raise exception 'only workspace owners/admins can create a development item'; end if;
  if not exists (select 1 from digital_employees where id = p_de_id and tenant_id = v_tenant) then
    raise exception 'employee not found in this workspace';
  end if;
  if p_assigned_to is not null and not exists (select 1 from profiles where user_id = p_assigned_to and tenant_id = v_tenant and coalesce(is_active, true)) then
    raise exception 'assignee must be an active member of this workspace';
  end if;

  insert into de_development_items (tenant_id, de_id, item_type, source, priority, description, target_metric, target_value, status, assigned_to, due_date, created_by)
  values (v_tenant, p_de_id, 'manual', 'manual', p_priority, p_description, p_target_metric, p_target_value, 'proposed', p_assigned_to, p_due_date, auth.uid())
  returning * into v_row;

  perform sync_de_lifecycle_from_development(p_de_id);
  return v_row;
end;
$$;

create or replace function detect_de_development_needs(p_tenant_id uuid)
returns setof de_development_items
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tenant uuid;
  m record;
  v_candidate record;
  v_row de_development_items;
begin
  v_tenant := auth_tenant_id();
  if v_tenant is null or v_tenant <> p_tenant_id then raise exception 'not a member of this workspace'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then raise exception 'only workspace owners/admins can scan for development needs'; end if;

  for m in select * from get_de_performance_metrics(p_tenant_id, 8) where total_decisions >= 10
  loop
    for v_candidate in
      select * from (values
        ('escalation_spike', m.escalation_rate > 0.5, 'escalation_rate'::text, 0.3::numeric, m.escalation_rate,
          format('%s escalated %s%% of %s decisions over the last 8 weeks — more than half. Target: bring escalation rate under 30%%.', m.de_name, round(m.escalation_rate * 100), m.total_decisions)),
        ('confidence_gap', m.avg_confidence < 50, 'avg_confidence', 65::numeric, m.avg_confidence,
          format('%s''s average confidence across %s decisions is %s%% — evidence or knowledge coverage may be thin. Target: 65%%+.', m.de_name, m.total_decisions, round(m.avg_confidence))),
        ('error_rate', m.error_rate > 0.15, 'error_rate', 0.05::numeric, m.error_rate,
          format('%s had a %s%% run error rate over the last 8 weeks (%s runs). Target: under 5%%.', m.de_name, round(m.error_rate * 100), m.total_runs)),
        ('guardrail_pattern', m.total_runs > 0 and m.blocked_guardrail_count::numeric / m.total_runs > 0.1, 'blocked_guardrail_count', 0::numeric, m.blocked_guardrail_count::numeric,
          format('%s was blocked by a guardrail on %s of %s runs (%s%%) — review whether this is a knowledge gap or a genuinely out-of-scope request pattern.', m.de_name, m.blocked_guardrail_count, m.total_runs, round(m.blocked_guardrail_count::numeric / m.total_runs * 100)))
      ) as c(item_type, triggered, target_metric, target_value, baseline_value, description)
      where c.triggered
    loop
      insert into de_development_items (tenant_id, de_id, item_type, source, priority, description, target_metric, target_value, baseline_value, status)
      values (p_tenant_id, m.de_id, v_candidate.item_type, 'detected', 'medium', v_candidate.description, v_candidate.target_metric, v_candidate.target_value, v_candidate.baseline_value, 'proposed')
      on conflict (tenant_id, de_id, item_type) where source = 'detected' and status in ('proposed', 'in_progress')
      do update set description = excluded.description, baseline_value = excluded.baseline_value, updated_at = now()
      returning * into v_row;
      perform sync_de_lifecycle_from_development(m.de_id);
      return next v_row;
    end loop;
  end loop;
  return;
end;
$$;

create or replace function list_de_health(p_tenant_id uuid)
returns table(de_id uuid, de_name text, state text, signals jsonb, total_decisions bigint, avg_confidence numeric, escalation_rate numeric, error_rate numeric, recent_guardrail_blocks bigint, cost_this_period_usd numeric, cost_per_task_usd numeric)
language plpgsql
security definer
stable
set search_path = public, extensions
as $$
declare
  v_tenant uuid;
begin
  v_tenant := auth_tenant_id();
  if v_tenant is null or v_tenant <> p_tenant_id then raise exception 'not a member of this workspace'; end if;

  return query
  with perf as (
    select * from get_de_performance_metrics(p_tenant_id, 8)
  ), guard as (
    select * from get_de_guardrail_activity(p_tenant_id, 7)
  ), cost as (
    select * from get_de_cost_metrics(p_tenant_id)
  )
  select
    d.id, coalesce(d.persona_name, d.name),
    case
      when d.lifecycle_status = 'retired' then 'retired'
      when coalesce(g.blocked_count, 0) > 0 then 'incident_active'
      when p.total_decisions is null or p.total_decisions < 10 then 'insufficient_data'
      when p.escalation_rate > 50 or p.error_rate > 15 then 'degraded'
      when p.avg_confidence < 50 then 'low_confidence'
      when coalesce(c.total_cost_usd, 0) > 50 then 'high_cost'
      when d.lifecycle_status = 'improving' then 'improving'
      else 'healthy'
    end,
    jsonb_build_object(
      'guardrail_blocked_7d', coalesce(g.blocked_count, 0),
      'escalation_rate_over_threshold', p.escalation_rate > 50,
      'error_rate_over_threshold', p.error_rate > 15,
      'low_confidence', p.avg_confidence < 50,
      'high_cost', coalesce(c.total_cost_usd, 0) > 50,
      'open_development_items', (select count(*) from de_development_items where de_id = d.id and status in ('proposed','in_progress'))
    ),
    coalesce(p.total_decisions, 0), p.avg_confidence, p.escalation_rate, p.error_rate,
    coalesce(g.blocked_count, 0), coalesce(c.total_cost_usd, 0),
    case when coalesce(p.total_decisions, 0) > 0 then round(coalesce(c.total_cost_usd, 0) / p.total_decisions, 4) else null end
  from digital_employees d
  left join perf p on p.de_id = d.id
  left join guard g on g.de_id = d.id
  left join cost c on c.de_id = d.id
  where d.tenant_id = p_tenant_id;
end;
$$;

create or replace function resolve_my_de_autonomy(p_action_type text, p_de_id uuid default null, p_source_category text default null)
returns table(enabled boolean, max_amount_cents bigint, min_confidence integer)
language plpgsql
security definer
stable
set search_path = public, extensions
as $$
declare
  v_tenant uuid;
begin
  v_tenant := auth_tenant_id();
  if v_tenant is null then
    raise exception 'not a member of any tenant';
  end if;
  return query select * from resolve_de_autonomy(v_tenant, p_action_type, p_de_id, p_source_category);
end;
$$;

create or replace function retire_digital_employee(p_de_id uuid, p_reason text)
returns digital_employees
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tenant uuid;
  v_de digital_employees;
  v_readiness jsonb;
  v_owner_name text;
begin
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'a retirement reason is required';
  end if;

  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then raise exception 'only workspace owners/admins can retire a Digital Employee'; end if;

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
$$;

create or replace function transfer_de_ownership(p_de_id uuid, p_new_owner_user_id uuid, p_note text default null)
returns digital_employees
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tenant uuid;
  v_row digital_employees;
  v_old_owner_name text;
  v_new_owner_name text;
begin
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then raise exception 'only workspace owners/admins can transfer Digital Employee ownership'; end if;

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
$$;

create or replace function update_de_development_item_status(p_item_id uuid, p_status text)
returns de_development_items
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tenant uuid; v_row de_development_items;
begin
  if p_status not in ('proposed', 'in_progress', 'completed', 'dismissed') then
    raise exception 'invalid status %', p_status;
  end if;
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then raise exception 'only workspace owners/admins can update a development item'; end if;

  select * into v_row from de_development_items where id = p_item_id and tenant_id = v_tenant;
  if v_row.id is null then raise exception 'development item not found in this workspace'; end if;

  update de_development_items set
    status = p_status, updated_at = now(),
    completed_at = case when p_status = 'completed' then now() else completed_at end
  where id = p_item_id
  returning * into v_row;

  perform sync_de_lifecycle_from_development(v_row.de_id);
  return v_row;
end;
$$;

create or replace function update_digital_employee(p_de_id uuid, p_name text default null, p_persona_name text default null, p_description text default null, p_department text default null, p_icon text default null, p_confidence_threshold integer default null, p_required_approval boolean default null, p_model_provider text default null, p_model_id text default null, p_task_type text default null, p_escalation_model_id text default null, p_escalation_threshold integer default null)
returns digital_employees
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tenant uuid;
  v_row digital_employees;
  v_name text; v_persona_name text; v_description text; v_department text; v_icon text;
  v_confidence_threshold integer; v_required_approval boolean;
  v_model_provider text; v_model_id text; v_task_type text;
  v_escalation_model_id text; v_escalation_threshold integer;
  v_changed boolean;
begin
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then raise exception 'only workspace owners/admins can edit a Digital Employee'; end if;

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
$$;

grant execute on function check_de_retirement_readiness(uuid) to authenticated, service_role;
grant execute on function create_de_development_item(uuid, text, text, numeric, text, date, uuid) to authenticated, service_role;
grant execute on function detect_de_development_needs(uuid) to authenticated, service_role;
grant execute on function list_de_health(uuid) to authenticated, service_role;
grant execute on function resolve_my_de_autonomy(text, uuid, text) to authenticated, service_role;
grant execute on function retire_digital_employee(uuid, text) to authenticated, service_role;
grant execute on function transfer_de_ownership(uuid, uuid, text) to authenticated, service_role;
grant execute on function update_de_development_item_status(uuid, text) to authenticated, service_role;
grant execute on function update_digital_employee(uuid, text, text, text, text, text, integer, boolean, text, text, text, text, integer) to authenticated, service_role;
