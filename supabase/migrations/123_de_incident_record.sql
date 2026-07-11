-- DE-B1: the durable Incident Record (constitution §3.16, Principle 9
-- "incidents are managed"). Until now, incident-shaped events existed
-- only as scattered, unreviewable rows: guardrail blocks in
-- evidence_run_decisions/audit_events, automatic trust demotions in
-- the audit trail, failed eval runs, and humans rejecting proposed
-- actions. The DE profile's "Incidents" tab name-matched audit rows
-- and offered no lifecycle at all.
--
-- This gives incidents identity: a durable row with severity, an
-- open→reviewed→closed lifecycle, a resolution note, and provenance
-- back to the source event. Capture is an idempotent SQL sweep
-- (detect_de_incidents_internal) piggybacked on the 5-minute
-- dispatcher — the same detection-cron pattern as knowledge gaps and
-- learned behaviors. The unique (tenant, source) key makes re-sweeps
-- free of duplicates.

create table if not exists de_incidents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  -- Nullable: some incidents are tenant-level (a failed eval run has
  -- no single attributable DE).
  de_id uuid references digital_employees(id) on delete cascade,
  kind text not null check (kind in ('guardrail_block', 'trust_demotion', 'eval_regression', 'action_rejected')),
  severity text not null default 'warning' check (severity in ('info', 'warning', 'critical')),
  title text not null,
  detail jsonb not null default '{}'::jsonb,
  source_table text not null,
  source_id uuid not null,
  status text not null default 'open' check (status in ('open', 'reviewed', 'closed')),
  resolution_note text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, source_table, source_id)
);

create index if not exists de_incidents_tenant_de_idx on de_incidents(tenant_id, de_id);
create index if not exists de_incidents_status_idx on de_incidents(tenant_id, status);

alter table de_incidents enable row level security;

drop policy if exists de_incidents_tenant_select on de_incidents;
create policy de_incidents_tenant_select on de_incidents
  for select to authenticated
  using (tenant_id = auth_tenant_id());

-- Writes only via the RPCs below.

-- ────────────────────────────────────────────────────────────────
-- Capture sweep — idempotent, service-side, called from the 5-min
-- dispatcher. Windows to the last 30 days on each pass; the unique
-- source key dedupes everything already captured.
-- ────────────────────────────────────────────────────────────────
create or replace function detect_de_incidents_internal(p_tenant_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted integer := 0;
  v_count integer;
begin
  -- 1. Guardrail blocks from the triage pipeline (best attribution:
  --    evidence_runs.de_id).
  insert into de_incidents (tenant_id, de_id, kind, severity, title, detail, source_table, source_id, occurred_at)
  select d.tenant_id, er.de_id, 'guardrail_block', 'warning',
    'Guardrail blocked an automatic action',
    jsonb_build_object('reasoning', left(d.reasoning, 400), 'guardrail_rule_id', d.guardrail_rule_id,
                       'external_ref', d.external_ref, 'source_category', d.source_category,
                       'evidence_run_id', d.evidence_run_id),
    'evidence_run_decisions', d.id, d.created_at
  from evidence_run_decisions d
  join evidence_runs er on er.id = d.evidence_run_id
  where d.decision = 'blocked_guardrail'
    and d.created_at > now() - interval '30 days'
    and (p_tenant_id is null or d.tenant_id = p_tenant_id)
  on conflict (tenant_id, source_table, source_id) do nothing;
  get diagnostics v_count = row_count; v_inserted := v_inserted + v_count;

  -- 2. Guardrail blocks recorded straight to the audit trail (widget/
  --    chat answers withheld). Attribution by actor name — the same
  --    semantics the old profile tab used, now persisted once.
  insert into de_incidents (tenant_id, de_id, kind, severity, title, detail, source_table, source_id, occurred_at)
  select a.tenant_id,
    (select de.id from digital_employees de
     where de.tenant_id = a.tenant_id and (de.name = a.actor or de.persona_name = a.actor)
     limit 1),
    'guardrail_block', 'warning',
    'Guardrail withheld an answer',
    jsonb_build_object('action', left(a.action, 400), 'rule', a.detail->>'rule', 'channel', a.detail->>'channel'),
    'audit_events', a.id, a.created_at
  from audit_events a
  where a.category = 'guardrail_block'
    and a.created_at > now() - interval '30 days'
    and (p_tenant_id is null or a.tenant_id = p_tenant_id)
  on conflict (tenant_id, source_table, source_id) do nothing;
  get diagnostics v_count = row_count; v_inserted := v_inserted + v_count;

  -- 3. Automatic trust demotions (migration 025's "demote fast" path).
  insert into de_incidents (tenant_id, de_id, kind, severity, title, detail, source_table, source_id, occurred_at)
  select a.tenant_id,
    nullif(a.detail->>'de_id', '')::uuid,
    'trust_demotion', 'critical',
    'Trust level automatically demoted',
    jsonb_build_object('action', left(a.action, 400), 'action_category', a.detail->>'action_category',
                       'policy_id', a.detail->>'policy_id'),
    'audit_events', a.id, a.created_at
  from audit_events a
  where a.detail->>'kind' = 'trust_demoted'
    and a.created_at > now() - interval '30 days'
    and (p_tenant_id is null or a.tenant_id = p_tenant_id)
  on conflict (tenant_id, source_table, source_id) do nothing;
  get diagnostics v_count = row_count; v_inserted := v_inserted + v_count;

  -- 4. Failed eval runs (tenant-level: no single attributable DE).
  insert into de_incidents (tenant_id, de_id, kind, severity, title, detail, source_table, source_id, occurred_at)
  select r.tenant_id, null,
    'eval_regression', 'warning',
    format('Golden QA run failed — %s of %s passed', r.passed, r.total),
    jsonb_build_object('run_id', r.id, 'passed', r.passed, 'failed', r.failed, 'trigger', r.trigger),
    'eval_runs', r.id, coalesce(r.finished_at, r.started_at)
  from eval_runs r
  where r.status = 'failed'
    and coalesce(r.finished_at, r.started_at) > now() - interval '30 days'
    and (p_tenant_id is null or r.tenant_id = p_tenant_id)
  on conflict (tenant_id, source_table, source_id) do nothing;
  get diagnostics v_count = row_count; v_inserted := v_inserted + v_count;

  -- 5. Humans rejecting a proposed action (a draft the DE got wrong).
  insert into de_incidents (tenant_id, de_id, kind, severity, title, detail, source_table, source_id, occurred_at)
  select t.tenant_id,
    case when ae.subject_kind = 'de' then ae.subject_id else null end,
    'action_rejected', 'info',
    format('Proposed action rejected by a human — %s', left(t.title, 120)),
    jsonb_build_object('task_id', t.id, 'request_summary', left(ae.request_summary, 300), 'decided_at', t.decided_at),
    'human_tasks', t.id, coalesce(t.decided_at, t.created_at)
  from human_tasks t
  join action_executions ae on ae.task_id = t.id
  where t.type = 'action_approval' and t.status = 'rejected'
    and coalesce(t.decided_at, t.created_at) > now() - interval '30 days'
    and (p_tenant_id is null or t.tenant_id = p_tenant_id)
  on conflict (tenant_id, source_table, source_id) do nothing;
  get diagnostics v_count = row_count; v_inserted := v_inserted + v_count;

  return jsonb_build_object('inserted', v_inserted);
end;
$$;

revoke all on function detect_de_incidents_internal(uuid) from public, anon, authenticated;
grant execute on function detect_de_incidents_internal(uuid) to service_role;

-- ────────────────────────────────────────────────────────────────
-- Review lifecycle — owner/admin gated, Remote-Access-aware, audited.
-- ────────────────────────────────────────────────────────────────
create or replace function review_de_incident(p_incident_id uuid, p_status text, p_resolution_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_row de_incidents;
begin
  if p_status not in ('reviewed', 'closed', 'open') then
    raise exception 'status must be reviewed, closed, or open';
  end if;
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then
    raise exception 'only workspace owners/admins can review incidents';
  end if;

  select * into v_row from de_incidents where id = p_incident_id and tenant_id = v_tenant;
  if v_row.id is null then raise exception 'incident not found in this workspace'; end if;

  update de_incidents set
    status = p_status,
    resolution_note = coalesce(p_resolution_note, resolution_note),
    reviewed_by = auth.uid(),
    reviewed_at = now()
  where id = p_incident_id
  returning * into v_row;

  perform append_audit_event_internal(
    v_tenant, 'You', 'human',
    format('Incident %s — %s%s', p_status, v_row.title,
      case when p_resolution_note is not null and p_resolution_note <> '' then format(' ("%s")', left(p_resolution_note, 160)) else '' end),
    'config_change',
    jsonb_build_object('kind', 'incident_review', 'incident_id', p_incident_id, 'status', p_status, 'incident_kind', v_row.kind)
  );

  return jsonb_build_object('ok', true, 'status', v_row.status);
end;
$$;

revoke all on function review_de_incident(uuid, text, text) from public, anon;
grant execute on function review_de_incident(uuid, text, text) to authenticated, service_role;

-- ────────────────────────────────────────────────────────────────
-- Scheduled capture: a dedicated 5-minute cron job (plain SQL — no
-- edge function, no HTTP, no dispatcher coupling). Kept separate from
-- playbook-dispatch-5min so a failure in either never blocks the other.
-- ────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from cron.job where jobname = 'de-incident-sweep-5min') then
    perform cron.unschedule('de-incident-sweep-5min');
  end if;
  perform cron.schedule('de-incident-sweep-5min', '*/5 * * * *', 'select detect_de_incidents_internal()');
end $$;

-- Initial backfill sweep (last 30 days across all tenants).
select detect_de_incidents_internal();
