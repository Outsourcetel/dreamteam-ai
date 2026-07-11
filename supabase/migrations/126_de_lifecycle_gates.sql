-- DE-B4: lifecycle gates (constitution §8 — "Lifecycle status is not a
-- label, it is a governance gate").
--
-- The lifecycle_status column has existed since migration 001 with all
-- 12 stage values — but nothing ever enforced it. Found while building
-- this (three real gaps):
--   1. poll_de_work_sources_targets never checked the DE's OWN
--      lifecycle — only the specialist-suppression subquery looked at
--      'retired'. A paused DE kept polling its inbox; a retired DE
--      whose grants remained would too (retirement disables charter +
--      autonomy but deliberately keeps grants for audit).
--   2. widget-ask / de-answer resolve "the tenant's first DE" with no
--      eligibility filter — a paused or retired employee could still
--      be the live answering persona (edge-function fix deployed
--      alongside this migration).
--   3. Pause had no machinery at all — no RPC, no teeth, no audit.
--
-- SCOPE (founder-approved): the pre-launch chain (designed →
-- configured → trained → tested → certified → published → assigned →
-- active) with every criterion checked against REAL machinery; Paused
-- with teeth; audited transitions. Deliberately NOT built: Archived
-- (cold storage — meaningless at current scale) and the Marketplace
-- certification path (no marketplace exists). Certification CADENCE /
-- renewal is DE-C3.
--
-- Scoped deviation from §8, recorded honestly (same pattern as §7.6's
-- Wave-3 note): reactive Q&A (widget/chat) stays available from
-- pre-launch stages — it is this platform's sandbox surface (§8
-- "Tested: test execution in sandbox mode"), already guarded by
-- guardrails + confidence + triage, and blocking it would break the
-- new-tenant first-run experience. Paused/retired employees are
-- excluded from answering everywhere. PROACTIVE work (inbox polling,
-- claiming, acting) requires assigned/active/improving — strictly.

-- ────────────────────────────────────────────────────────────────
-- 1. Transition history — every stage change is a durable event.
-- ────────────────────────────────────────────────────────────────
create table if not exists de_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  de_id uuid not null references digital_employees(id) on delete cascade,
  from_stage text not null,
  to_stage text not null,
  actor_id uuid,
  actor_label text not null default 'system',
  note text,
  criteria_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists de_lifecycle_events_de_idx on de_lifecycle_events(tenant_id, de_id, created_at desc);

alter table de_lifecycle_events enable row level security;

drop policy if exists de_lifecycle_events_tenant_select on de_lifecycle_events;
create policy de_lifecycle_events_tenant_select on de_lifecycle_events
  for select to authenticated
  using (tenant_id = auth_tenant_id());

-- Writes only via the RPCs below.

-- ────────────────────────────────────────────────────────────────
-- 2. Readiness — the entry criteria for each next stage, every one a
--    real signal that already exists in this codebase. Nothing here is
--    fabricated; where a criterion is workspace-level rather than
--    per-employee (golden QA today), the payload says so.
-- ────────────────────────────────────────────────────────────────
create or replace function compute_de_lifecycle_readiness(p_de_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_de digital_employees;
  v_tenant uuid;
  v_identity boolean;
  v_grants boolean;
  v_knowledge boolean;
  v_policies boolean;
  v_embedded boolean;
  v_qa_passed boolean;
  v_certified boolean;
  v_channel boolean;
  v_executed boolean;
begin
  select * into v_de from digital_employees where id = p_de_id;
  if v_de.id is null then return jsonb_build_object('error', 'not_found'); end if;
  v_tenant := v_de.tenant_id;

  -- Humans must belong to the workspace; trusted server contexts pass.
  if auth.role() is not null and auth.role() <> 'service_role' then
    if auth_tenant_id() is distinct from v_tenant then
      raise exception 'not a member of this workspace';
    end if;
  end if;

  v_identity := coalesce(v_de.name, '') <> '' and coalesce(v_de.description, '') <> ''
    and (coalesce(v_de.department, '') <> '' or coalesce(v_de.workspace, '') <> '')
    and coalesce(array_length(v_de.responsibilities, 1), 0) >= 1;

  v_grants := exists (select 1 from data_access_grants
    where tenant_id = v_tenant and subject_kind = 'de' and subject_id = p_de_id);

  v_knowledge := exists (select 1 from knowledge_docs d
    where d.tenant_id = v_tenant
      and (d.visibility = 'tenant'
           or exists (select 1 from knowledge_doc_scopes s
                      where s.doc_id = d.id and s.subject_kind = 'de' and s.subject_id = p_de_id)));

  v_policies := exists (select 1 from guardrail_rules where tenant_id = v_tenant and active);

  v_embedded := exists (select 1 from knowledge_doc_chunks c
    join knowledge_docs d on d.id = c.doc_id
    where d.tenant_id = v_tenant and c.embedding is not null
      and (d.visibility = 'tenant'
           or exists (select 1 from knowledge_doc_scopes s
                      where s.doc_id = d.id and s.subject_kind = 'de' and s.subject_id = p_de_id)));

  v_qa_passed := coalesce((select r.status = 'passed' from eval_runs r
    where r.tenant_id = v_tenant
    order by coalesce(r.finished_at, r.started_at) desc limit 1), false);

  v_certified := exists (select 1 from de_lifecycle_events
    where tenant_id = v_tenant and de_id = p_de_id and to_stage = 'certified' and actor_id is not null);

  v_channel := exists (select 1 from data_access_grants g
      where g.tenant_id = v_tenant and g.subject_kind = 'de' and g.subject_id = p_de_id
        and access_permission_level(g.permission) >= access_permission_level('search'))
    or exists (select 1 from widget_keys where tenant_id = v_tenant and active);

  v_executed := exists (select 1 from evidence_runs where tenant_id = v_tenant and de_id = p_de_id);

  return jsonb_build_object(
    'stage', v_de.lifecycle_status,
    'status', v_de.status,
    'criteria', jsonb_build_object(
      'configured', jsonb_build_object(
        'identity_complete', v_identity,
        'detail', 'Name, description, a department or workspace, and at least one responsibility.'),
      'trained', jsonb_build_object(
        'control_fabric_grant', v_grants,
        'knowledge_in_scope', v_knowledge,
        'active_guardrails', v_policies,
        'detail', 'At least one system-access grant, knowledge this employee can see, and active workspace guardrails.'),
      'tested', jsonb_build_object(
        'knowledge_embedded', v_embedded,
        'detail', 'The knowledge in scope is actually searchable (embedded), so answers can cite it.'),
      'certified', jsonb_build_object(
        'golden_qa_passed', v_qa_passed,
        'scope', 'workspace',
        'detail', 'The latest golden Q&A run passed. (Suite is workspace-level today — per-employee suites arrive with Skills, DE-C1.)'),
      'published', jsonb_build_object(
        'certified_by_human', v_certified,
        'detail', 'A named workspace owner/admin recorded certification.'),
      'assigned', jsonb_build_object(
        'has_work_channel', v_channel,
        'detail', 'A searchable system grant (inbox) or an active site widget key.'),
      'active', jsonb_build_object(
        'first_live_execution', v_executed,
        'detail', 'At least one real evidence run attributed to this employee.')
    )
  );
end;
$$;

revoke all on function compute_de_lifecycle_readiness(uuid) from public, anon;
grant execute on function compute_de_lifecycle_readiness(uuid) to authenticated, service_role;

-- ────────────────────────────────────────────────────────────────
-- 3. Forward transitions — owner/admin, RA-aware, criteria-enforced,
--    audited. Retirement is NOT reachable here (retire_digital_employee
--    is the only exit — Anti-Pattern §15.10); Archived is out of scope.
--    Pause/resume have their own RPCs below.
-- ────────────────────────────────────────────────────────────────
create or replace function advance_de_lifecycle(p_de_id uuid, p_to_stage text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_de digital_employees;
  v_readiness jsonb;
  v_ok boolean;
  v_actor_name text;
  v_expected_from text;
begin
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then
    raise exception 'only workspace owners/admins can advance an employee''s lifecycle';
  end if;

  select * into v_de from digital_employees where id = p_de_id and tenant_id = v_tenant;
  if v_de.id is null then raise exception 'employee not found in this workspace'; end if;
  if v_de.lifecycle_status in ('retired', 'archived') then
    raise exception 'this employee is retired — its lifecycle is closed';
  end if;
  if v_de.lifecycle_status = 'paused' then
    raise exception 'this employee is paused — use resume first';
  end if;

  -- The forward chain: each target stage has exactly one legal
  -- predecessor and one criteria set.
  v_expected_from := case p_to_stage
    when 'configured' then 'designed'
    when 'trained'    then 'configured'
    when 'tested'     then 'trained'
    when 'certified'  then 'tested'
    when 'published'  then 'certified'
    when 'assigned'   then 'published'
    when 'active'     then 'assigned'
    else null
  end;
  if v_expected_from is null then
    raise exception 'stage "%" is not reachable through advance (pause/resume/retire have their own controls)', p_to_stage;
  end if;
  if v_de.lifecycle_status <> v_expected_from then
    raise exception 'cannot advance to "%" from "%" — the chain is designed → configured → trained → tested → certified → published → assigned → active', p_to_stage, v_de.lifecycle_status;
  end if;

  v_readiness := compute_de_lifecycle_readiness(p_de_id);
  v_ok := case p_to_stage
    when 'configured' then (v_readiness->'criteria'->'configured'->>'identity_complete')::boolean
    when 'trained'    then (v_readiness->'criteria'->'trained'->>'control_fabric_grant')::boolean
                       and (v_readiness->'criteria'->'trained'->>'knowledge_in_scope')::boolean
                       and (v_readiness->'criteria'->'trained'->>'active_guardrails')::boolean
    when 'tested'     then (v_readiness->'criteria'->'tested'->>'knowledge_embedded')::boolean
    when 'certified'  then (v_readiness->'criteria'->'certified'->>'golden_qa_passed')::boolean
    when 'published'  then (v_readiness->'criteria'->'published'->>'certified_by_human')::boolean
    when 'assigned'   then (v_readiness->'criteria'->'assigned'->>'has_work_channel')::boolean
    when 'active'     then (v_readiness->'criteria'->'active'->>'first_live_execution')::boolean
  end;
  if not coalesce(v_ok, false) then
    return jsonb_build_object('ok', false, 'blocked', true, 'readiness', v_readiness,
      'reason', format('Entry criteria for "%s" are not met yet — see readiness.', p_to_stage));
  end if;

  -- Certification is a human checkpoint: a note is required and the
  -- reviewer's identity is recorded (constitution: "cannot be
  -- automated away").
  if p_to_stage = 'certified' and (p_note is null or trim(p_note) = '') then
    raise exception 'certification requires a note stating what was reviewed';
  end if;

  select full_name into v_actor_name from profiles where user_id = auth.uid();

  update digital_employees set
    lifecycle_status = p_to_stage,
    status = case when p_to_stage in ('assigned', 'active') then 'active' else status end,
    updated_at = now()
  where id = p_de_id;

  insert into de_lifecycle_events (tenant_id, de_id, from_stage, to_stage, actor_id, actor_label, note, criteria_snapshot)
  values (v_tenant, p_de_id, v_de.lifecycle_status, p_to_stage, auth.uid(), coalesce(v_actor_name, 'A workspace admin'), p_note, v_readiness);

  perform append_audit_event_internal(
    v_tenant, coalesce(v_actor_name, 'A workspace admin'), 'human',
    format('%s advanced to %s%s', v_de.name, p_to_stage,
      case when p_note is not null and p_note <> '' then format(' — "%s"', left(p_note, 160)) else '' end),
    'config_change',
    jsonb_build_object('kind', 'lifecycle_advance', 'de_id', p_de_id, 'from', v_de.lifecycle_status, 'to', p_to_stage)
  );

  return jsonb_build_object('ok', true, 'stage', p_to_stage);
end;
$$;

revoke all on function advance_de_lifecycle(uuid, text, text) from public, anon;
grant execute on function advance_de_lifecycle(uuid, text, text) to authenticated, service_role;

-- ────────────────────────────────────────────────────────────────
-- 4. Pause with teeth / resume with a note.
-- ────────────────────────────────────────────────────────────────
create or replace function pause_digital_employee(p_de_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_de digital_employees;
  v_actor_name text;
begin
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'a pause reason is required';
  end if;
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then
    raise exception 'only workspace owners/admins can pause a Digital Employee';
  end if;
  select * into v_de from digital_employees where id = p_de_id and tenant_id = v_tenant;
  if v_de.id is null then raise exception 'employee not found in this workspace'; end if;
  if v_de.lifecycle_status in ('retired', 'archived') then raise exception 'this employee is retired'; end if;
  if v_de.lifecycle_status = 'paused' then raise exception 'this employee is already paused'; end if;

  select full_name into v_actor_name from profiles where user_id = auth.uid();

  -- Teeth: status 'disabled' + stage 'paused'. The poll gate below and
  -- the answering-DE eligibility filters (edge functions) both key off
  -- these. Trust level, grants, and configuration are retained
  -- (constitution §8: paused pending investigation, not stripped).
  update digital_employees set lifecycle_status = 'paused', status = 'disabled', updated_at = now()
  where id = p_de_id;

  insert into de_lifecycle_events (tenant_id, de_id, from_stage, to_stage, actor_id, actor_label, note)
  values (v_tenant, p_de_id, v_de.lifecycle_status, 'paused', auth.uid(), coalesce(v_actor_name, 'A workspace admin'), p_reason);

  perform append_audit_event_internal(
    v_tenant, coalesce(v_actor_name, 'A workspace admin'), 'human',
    format('%s PAUSED — %s (live work stopped; configuration and trust retained)', v_de.name, left(p_reason, 200)),
    'config_change',
    jsonb_build_object('kind', 'de_paused', 'de_id', p_de_id, 'from', v_de.lifecycle_status, 'reason', p_reason)
  );

  return jsonb_build_object('ok', true, 'stage', 'paused', 'resumes_to', v_de.lifecycle_status);
end;
$$;

revoke all on function pause_digital_employee(uuid, text) from public, anon;
grant execute on function pause_digital_employee(uuid, text) to authenticated, service_role;

create or replace function resume_digital_employee(p_de_id uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_de digital_employees;
  v_actor_name text;
  v_back_to text;
begin
  if p_note is null or trim(p_note) = '' then
    raise exception 'resuming requires a note on what was investigated/remediated';
  end if;
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then
    raise exception 'only workspace owners/admins can resume a Digital Employee';
  end if;
  select * into v_de from digital_employees where id = p_de_id and tenant_id = v_tenant;
  if v_de.id is null then raise exception 'employee not found in this workspace'; end if;
  if v_de.lifecycle_status <> 'paused' then raise exception 'this employee is not paused'; end if;

  -- Return to the stage the employee paused FROM (the last pause
  -- event's from_stage) — falling back to 'assigned' if history is
  -- missing. Open development items pull it to 'improving' on the next
  -- sync, matching §8's "returns to Active or Improving".
  select from_stage into v_back_to from de_lifecycle_events
  where tenant_id = v_tenant and de_id = p_de_id and to_stage = 'paused'
  order by created_at desc limit 1;
  v_back_to := coalesce(v_back_to, 'assigned');

  select full_name into v_actor_name from profiles where user_id = auth.uid();

  update digital_employees set lifecycle_status = v_back_to, status = 'active', updated_at = now()
  where id = p_de_id;

  insert into de_lifecycle_events (tenant_id, de_id, from_stage, to_stage, actor_id, actor_label, note)
  values (v_tenant, p_de_id, 'paused', v_back_to, auth.uid(), coalesce(v_actor_name, 'A workspace admin'), p_note);

  perform append_audit_event_internal(
    v_tenant, coalesce(v_actor_name, 'A workspace admin'), 'human',
    format('%s resumed to %s — "%s"', v_de.name, v_back_to, left(p_note, 200)),
    'config_change',
    jsonb_build_object('kind', 'de_resumed', 'de_id', p_de_id, 'to', v_back_to, 'note', p_note)
  );

  return jsonb_build_object('ok', true, 'stage', v_back_to);
end;
$$;

revoke all on function resume_digital_employee(uuid, text) from public, anon;
grant execute on function resume_digital_employee(uuid, text) to authenticated, service_role;

-- ────────────────────────────────────────────────────────────────
-- 5. Auto transition assigned → active on first real execution — the
--    one transition the constitution defines by observed fact, not
--    human decision. Own 5-minute cron (same pattern as the incident
--    sweep; independent of the dispatcher).
-- ────────────────────────────────────────────────────────────────
create or replace function sync_de_lifecycle_auto_internal()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_count integer := 0;
begin
  for v_row in
    select de.id, de.tenant_id, de.name from digital_employees de
    where de.lifecycle_status = 'assigned'
      and exists (select 1 from evidence_runs er where er.tenant_id = de.tenant_id and er.de_id = de.id)
  loop
    update digital_employees set lifecycle_status = 'active', updated_at = now() where id = v_row.id;
    insert into de_lifecycle_events (tenant_id, de_id, from_stage, to_stage, actor_label, note)
    values (v_row.tenant_id, v_row.id, 'assigned', 'active', 'system', 'First live execution observed — activated automatically.');
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('activated', v_count);
end;
$$;

revoke all on function sync_de_lifecycle_auto_internal() from public, anon, authenticated;
grant execute on function sync_de_lifecycle_auto_internal() to service_role;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'de-lifecycle-sync-5min') then
    perform cron.unschedule('de-lifecycle-sync-5min');
  end if;
  perform cron.schedule('de-lifecycle-sync-5min', '*/5 * * * *', 'select sync_de_lifecycle_auto_internal()');
end $$;

-- ────────────────────────────────────────────────────────────────
-- 6. THE POLL GATE — proactive work requires an operational stage.
--    Fixes the found bug too: the DE's own lifecycle/status were never
--    checked here at all (only the specialist-suppression subquery
--    looked at 'retired'). The suppression subquery is aligned to the
--    same eligible set: a paused DE no longer suppresses its
--    specialist backup — §7's primary/backup resilience for free.
-- ────────────────────────────────────────────────────────────────
create or replace function poll_de_work_sources_targets(p_tenant_id uuid default null)
returns table(
  tenant_id uuid, connector_id uuid, connector_provider text, connector_display_name text,
  category text,
  subject_kind text, subject_id uuid, subject_name text,
  last_seen_external_ref text, last_seen_timestamp timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.tenant_id, c.id as connector_id, c.provider, c.display_name,
    c.category,
    g.subject_kind, g.subject_id,
    coalesce(sp.name, de.name, 'DE') as subject_name,
    w.last_seen_external_ref, w.last_seen_timestamp
  from connectors c
  join data_access_grants g
    on g.tenant_id = c.tenant_id
   and ((g.resource_kind = 'connector' and g.resource_id = c.id)
        or (g.resource_kind = 'category' and g.resource_category = c.category))
   and access_permission_level(g.permission) >= access_permission_level('search')
  left join specialist_profiles sp on sp.id = g.subject_id and g.subject_kind = 'specialist'
  left join digital_employees de on de.id = g.subject_id and g.subject_kind = 'de'
  left join inbox_watch_state w on w.tenant_id = c.tenant_id and w.connector_id = c.id
  where c.status <> 'disconnected'
    and (p_tenant_id is null or c.tenant_id = p_tenant_id)
    -- LIFECYCLE GATE (DE-B4): a DE polls only in an operational stage.
    and (g.subject_kind <> 'de'
         or (de.lifecycle_status in ('assigned', 'active', 'improving') and de.status = 'active'))
    -- The DE owns the inbox: a specialist polls only when no ELIGIBLE
    -- DE is on this connector (paused/pre-launch DEs no longer block
    -- the specialist backup).
    and not (
      g.subject_kind = 'specialist'
      and exists (
        select 1 from data_access_grants g2
        join digital_employees de2 on de2.id = g2.subject_id
        where g2.tenant_id = c.tenant_id and g2.subject_kind = 'de'
          and de2.lifecycle_status in ('assigned', 'active', 'improving')
          and de2.status = 'active'
          and ((g2.resource_kind = 'connector' and g2.resource_id = c.id)
               or (g2.resource_kind = 'category' and g2.resource_category = c.category))
          and access_permission_level(g2.permission) >= access_permission_level('search')
      )
    );
$$;

-- ────────────────────────────────────────────────────────────────
-- 7. Backfill — grandfather what is already truthfully operating.
--    Evidence-bearing employees are 'active' (observed fact). Employees
--    sitting at 'published' with a real work channel are 'assigned'
--    (they are channel-routed today — without this, the new poll gate
--    would silently stop currently-polling employees). Every backfill
--    writes an event row saying exactly why.
-- ────────────────────────────────────────────────────────────────
-- Evidence beats stage bookkeeping: a DE with real evidence runs is
-- operating, whatever its recorded stage says (Acme's own Support DE
-- sat at 'designed' — the default from its creation — while running
-- 19/20 golden QA and a live draft-reply loop; the first version of
-- this backfill only looked at published/assigned and knocked it off
-- its own inbox for a few minutes).
with promoted as (
  update digital_employees de set lifecycle_status = 'active', updated_at = now()
  from (select id, lifecycle_status as old_stage from digital_employees) old
  where old.id = de.id
    and de.lifecycle_status in ('designed', 'configured', 'trained', 'tested', 'certified', 'published', 'assigned')
    and de.status = 'active'
    and exists (select 1 from evidence_runs er where er.tenant_id = de.tenant_id and er.de_id = de.id)
  returning de.id, de.tenant_id, old.old_stage as from_stage
)
insert into de_lifecycle_events (tenant_id, de_id, from_stage, to_stage, actor_label, note)
select tenant_id, id, from_stage, 'active', 'system',
  'Backfill (migration 126): real evidence runs exist — this employee is operating.'
from promoted;

with promoted as (
  update digital_employees de set lifecycle_status = 'assigned', updated_at = now()
  where de.lifecycle_status = 'published'
    and de.status = 'active'
    and exists (select 1 from data_access_grants g
                where g.tenant_id = de.tenant_id and g.subject_kind = 'de' and g.subject_id = de.id
                  and access_permission_level(g.permission) >= access_permission_level('search'))
  returning de.id, de.tenant_id
)
insert into de_lifecycle_events (tenant_id, de_id, from_stage, to_stage, actor_label, note)
select tenant_id, id, 'published', 'assigned', 'system',
  'Backfill (migration 126): a searchable work-channel grant exists — this employee is channel-assigned.'
from promoted;
