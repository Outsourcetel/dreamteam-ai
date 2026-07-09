-- Migration 111: Wave 3 (bounded) — DE-to-DE consultation.
--
-- NOT full DE Composition (docs/10 §7.6 — Coordinator DE, multi-target
-- fan-out, result synthesis). That remains explicitly gated: "DE
-- Composition is a Phase 3 capability. It must not be implemented
-- before the single-DE model is stable and well-governed," and this
-- platform is still Phase 1 per docs/13. This migration ships the one
-- concrete, argued (not merely observed) gap instead: Support DE has
-- zero grant on erp_financials — deliberately, a repeated least-
-- privilege choice documented in both 037 and 043 — so it cannot
-- answer a customer's billing question, and widening its grant would
-- break exactly the isolation those migrations went out of their way
-- to enforce. A single-hop, explicitly governed consultation (one DE
-- asks another DE one scoped question, under the TARGET's own
-- Responsibility/Policy constraints, never the requester's) is the
-- shape docs §7.6's own governance rule 3 describes ("cannot escalate
-- permissions") without any of the Coordinator/orchestration
-- machinery §7.6 defers to Phase 3.
--
-- Explicitly NOT built here: multi-DE fan-out, result synthesis
-- across multiple targets, a `coordinator` team role, delegation
-- chains beyond one hop. de_consultation_grants is a governance
-- ALLOW-LIST (tenant-admin configured), not an open "any DE can ask
-- any DE anything" mechanism — matches this codebase's Control Fabric
-- doctrine of nothing implicit.
-- ============================================================

-- ── audit_events: widen the category CHECK for the new, distinctly-
-- named category — a real delegation event, not folded under
-- config_change/evidence_step, so it's independently searchable
-- (docs §7.6 rule 5: "the full delegation chain is recorded in the
-- Audit Trail"). ─────────────────────────────────────────────────
alter table audit_events drop constraint if exists audit_events_category_check;
alter table audit_events add constraint audit_events_category_check
  check (category = any (array[
    'resolved','escalated','approval','guardrail_check','guardrail_block','config_change',
    'playbook_step','invoice','connector_sync','connector_action','evidence_step',
    'access_control','knowledge_revision','inquiry_triage','action_execution','de_memory',
    'de_consultation'
  ]));

-- ── de_consultation_grants: the governance allow-list. A requester DE
-- may consult a target DE for a given category ONLY if an active row
-- exists — tenant-admin configured, same shape as every other
-- Control Fabric grant in this codebase (data_access_grants,
-- platform_capability_grants). ─────────────────────────────────────
create table if not exists de_consultation_grants (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  requester_de_id uuid not null references digital_employees(id) on delete cascade,
  target_de_id    uuid not null references digital_employees(id) on delete cascade,
  category        text not null references system_categories(key),
  active          boolean not null default true,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  check (requester_de_id <> target_de_id),
  unique (tenant_id, requester_de_id, target_de_id, category)
);

alter table de_consultation_grants enable row level security;

create policy de_consultation_grants_tenant_select on de_consultation_grants
  for select using (tenant_id = auth_tenant_id());

create policy de_consultation_grants_tenant_admin_write on de_consultation_grants
  for all using (tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner','tenant_admin']))
  with check (tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner','tenant_admin']));

revoke all on de_consultation_grants from public;
revoke all on de_consultation_grants from anon;
grant select, insert, update, delete on de_consultation_grants to authenticated;
-- Fresh CREATE TABLE also grants TRIGGER/TRUNCATE/REFERENCES to
-- authenticated by this project's default schema privileges — the
-- same trap caught repeatedly this session. TRUNCATE specifically
-- bypasses RLS entirely (the inbox_watch_state lesson, migration
-- 109), so this is a real integrity gap, not just tidiness.
revoke trigger, truncate, references on de_consultation_grants from authenticated;
grant all on de_consultation_grants to service_role;

-- ── check_de_retirement_readiness: a DE other DEs actively consult is
-- itself a real dependency (docs §13.7's "Workflow dependencies") —
-- extending the SAME readiness check built in Wave 2 rather than
-- inventing a parallel one. Return shape unchanged (jsonb), so a
-- plain create-or-replace is correct here (no overload risk). ────────
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
  v_consulted_by integer;
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
$function$;
