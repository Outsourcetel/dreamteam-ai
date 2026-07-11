-- DE-C3: Certifications + performance review cadence (constitution
-- §9.5, §10.3, §10.4).
--
-- What this closes:
--   * §9.5 Certifications: migration 126's lifecycle certification is
--     an EVENT (a moment in the pre-launch chain); this adds the
--     durable, EXPIRING attestation — typed, scoped, issued by a named
--     human, renewable. Expiry surfaces through the Incident Record
--     (B1) rather than a parallel health mechanism: an expired cert
--     raises a de_incidents row, which the existing review lifecycle
--     and incident_active health state already handle.
--   * §10.3 cadence: quarterly Performance Reviews (scheduled + on
--     demand) snapshotting REAL metrics; the 48-hour incident-review
--     SLA gets a real nudge. (Health checks are continuous and Skills
--     are daily since 127 — already ahead of the table.)
--   * §10.4 PIPs: a 'below' review verdict opens a PIP — a Development
--     item with a formal deadline and a WRITTEN consequence. The daily
--     sweep re-measures overdue PIPs: targets now met → completed;
--     still failing → 'failed' + a CRITICAL incident for human trust
--     review. Deliberately NO automatic pause/demotion — §10.4 says
--     "may be"; the consequence routes to the incident review where
--     pause_digital_employee / trust controls already live. An
--     unsupervised cron must not fire an employee.
--
-- NOT built (honest scope): Partner/Industry certifications (§9.5 —
-- marketplace concepts, no marketplace exists); §10.5 cross-tenant
-- benchmarks (needs opt-in anonymised aggregation infrastructure);
-- §10.2 metrics with no capture today (hallucination rate, SLA/handle
-- time, hours saved — the last is DE-C5 baseline territory).

-- ────────────────────────────────────────────────────────────────
-- 1. Durable certifications.
-- ────────────────────────────────────────────────────────────────
create table if not exists de_certifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  de_id uuid not null references digital_employees(id) on delete cascade,
  cert_type text not null check (cert_type in ('workspace', 'compliance', 'capability')),
  scope text not null default '',
  note text not null default '',
  issued_by uuid,
  issued_by_name text not null default 'A workspace admin',
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'expired', 'revoked')),
  warned_at timestamptz,          -- expiry warning emitted (dedup)
  revoked_reason text,
  created_at timestamptz not null default now()
);

create index if not exists de_certifications_de_idx on de_certifications(tenant_id, de_id);
create index if not exists de_certifications_expiry_idx on de_certifications(expires_at) where status = 'active';

alter table de_certifications enable row level security;
drop policy if exists de_certifications_tenant_select on de_certifications;
create policy de_certifications_tenant_select on de_certifications
  for select to authenticated using (tenant_id = auth_tenant_id());
-- Writes only via the RPCs below.

create or replace function certify_digital_employee(
  p_de_id uuid, p_cert_type text, p_scope text, p_note text, p_valid_days integer default 180
)
returns de_certifications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_de_name text;
  v_actor text;
  v_row de_certifications;
begin
  if p_cert_type not in ('workspace', 'compliance', 'capability') then
    raise exception 'certification type must be workspace, compliance, or capability';
  end if;
  if p_note is null or trim(p_note) = '' then
    raise exception 'a certification requires a note stating what was reviewed';
  end if;
  if coalesce(p_valid_days, 0) < 1 or p_valid_days > 730 then
    raise exception 'validity must be between 1 and 730 days';
  end if;
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then
    raise exception 'only workspace owners/admins can certify a Digital Employee';
  end if;
  select name into v_de_name from digital_employees
  where id = p_de_id and tenant_id = v_tenant and lifecycle_status not in ('retired', 'archived');
  if v_de_name is null then raise exception 'employee not found in this workspace (or retired)'; end if;

  select full_name into v_actor from profiles where user_id = auth.uid();

  insert into de_certifications (tenant_id, de_id, cert_type, scope, note, issued_by, issued_by_name, expires_at)
  values (v_tenant, p_de_id, p_cert_type, coalesce(p_scope, ''), trim(p_note), auth.uid(),
          coalesce(v_actor, 'A workspace admin'), now() + make_interval(days => p_valid_days))
  returning * into v_row;

  perform append_audit_event_internal(
    v_tenant, coalesce(v_actor, 'A workspace admin'), 'human',
    format('%s certified (%s%s) — valid %s days: "%s"', v_de_name, p_cert_type,
      case when coalesce(p_scope, '') <> '' then format(': %s', p_scope) else '' end,
      p_valid_days, left(trim(p_note), 160)),
    'config_change',
    jsonb_build_object('kind', 'de_certified', 'de_id', p_de_id, 'cert_id', v_row.id,
      'cert_type', p_cert_type, 'expires_at', v_row.expires_at)
  );
  return v_row;
end;
$$;

revoke all on function certify_digital_employee(uuid, text, text, text, integer) from public, anon;
grant execute on function certify_digital_employee(uuid, text, text, text, integer) to authenticated, service_role;

create or replace function revoke_de_certification(p_cert_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_row de_certifications;
  v_actor text;
  v_de_name text;
begin
  if p_reason is null or trim(p_reason) = '' then raise exception 'a revocation reason is required'; end if;
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then
    raise exception 'only workspace owners/admins can revoke a certification';
  end if;
  update de_certifications set status = 'revoked', revoked_reason = trim(p_reason)
  where id = p_cert_id and tenant_id = v_tenant and status = 'active'
  returning * into v_row;
  if v_row.id is null then raise exception 'active certification not found in this workspace'; end if;

  select name into v_de_name from digital_employees where id = v_row.de_id;
  select full_name into v_actor from profiles where user_id = auth.uid();
  perform append_audit_event_internal(
    v_tenant, coalesce(v_actor, 'A workspace admin'), 'human',
    format('%s certification (%s) REVOKED — %s', coalesce(v_de_name, 'employee'), v_row.cert_type, left(trim(p_reason), 200)),
    'config_change',
    jsonb_build_object('kind', 'de_certification_revoked', 'cert_id', p_cert_id, 'de_id', v_row.de_id)
  );
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function revoke_de_certification(uuid, text) from public, anon;
grant execute on function revoke_de_certification(uuid, text) to authenticated, service_role;

-- ────────────────────────────────────────────────────────────────
-- 2. CHECK widenings for the new machinery.
-- ────────────────────────────────────────────────────────────────
alter table de_incidents drop constraint if exists de_incidents_kind_check;
alter table de_incidents add constraint de_incidents_kind_check
  check (kind in ('guardrail_block', 'trust_demotion', 'eval_regression', 'action_rejected',
                  'certification_expired', 'pip_failed'));

alter table de_development_items drop constraint if exists de_development_items_item_type_check;
alter table de_development_items add constraint de_development_items_item_type_check
  check (item_type in ('confidence_gap', 'escalation_spike', 'error_rate', 'guardrail_pattern', 'skill_gap', 'pip', 'manual'));

alter table de_development_items drop constraint if exists de_development_items_status_check;
alter table de_development_items add constraint de_development_items_status_check
  check (status in ('proposed', 'in_progress', 'completed', 'dismissed', 'failed'));

alter table de_development_items add column if not exists consequence text;

-- ────────────────────────────────────────────────────────────────
-- 3. Quarterly performance reviews — a durable, human-acknowledgeable
--    record built ONLY from metrics that already exist.
-- ────────────────────────────────────────────────────────────────
create table if not exists de_performance_reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  de_id uuid not null references digital_employees(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  verdict text not null check (verdict in ('meets', 'below', 'insufficient_data')),
  summary text not null,
  metrics_snapshot jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'acknowledged')),
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, de_id, period_start)
);

create index if not exists de_performance_reviews_de_idx on de_performance_reviews(tenant_id, de_id, created_at desc);

alter table de_performance_reviews enable row level security;
drop policy if exists de_performance_reviews_tenant_select on de_performance_reviews;
create policy de_performance_reviews_tenant_select on de_performance_reviews
  for select to authenticated using (tenant_id = auth_tenant_id());

-- The review generator. Thresholds match the dev-needs detection
-- (invented v1 judgment calls, flagged in 112/125): below = escalation
-- > 50% OR avg confidence < 50 OR error rate > 15%, on >= 10 decisions
-- in the 13-week window; fewer than 10 decisions = insufficient_data
-- (never a fabricated verdict). A 'below' verdict opens the PIP; a
-- 'meets' verdict completes any open PIP (closed loop).
create or replace function run_de_performance_review_internal(p_tenant_id uuid default null, p_de_id uuid default null)
returns setof de_performance_reviews
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_t record;
  m record;
  v_skills jsonb;
  v_verdict text;
  v_summary text;
  v_row de_performance_reviews;
  v_period_start date := (date_trunc('quarter', now()))::date;
  v_period_end date := current_date;
begin
  for v_t in
    select distinct de.tenant_id as tid from digital_employees de
    where de.lifecycle_status not in ('retired', 'archived')
      and (p_tenant_id is null or de.tenant_id = p_tenant_id)
  loop
    for m in
      select * from get_de_performance_metrics(v_t.tid, 13)
      where (p_de_id is null or de_id = p_de_id)
    loop
      -- Skip DEs outside the operational world (pre-launch/paused have
      -- nothing meaningful to review).
      if not exists (select 1 from digital_employees d where d.id = m.de_id
                     and d.lifecycle_status in ('assigned', 'active', 'improving', 'paused')) then
        continue;
      end if;

      select coalesce(jsonb_agg(jsonb_build_object('skill', s.skill_key, 'proficiency', s.proficiency, 'value', s.signal_value)), '[]'::jsonb)
        into v_skills from de_skills s where s.de_id = m.de_id;

      if m.total_decisions < 10 then
        v_verdict := 'insufficient_data';
        v_summary := format('%s handled %s decisions this period — below the 10 needed for a meaningful verdict. No judgment recorded on thin evidence.', m.de_name, m.total_decisions);
      elsif m.escalation_rate > 50 or m.avg_confidence < 50 or m.error_rate > 15 then
        v_verdict := 'below';
        v_summary := format('%s is below threshold this period: %s%% escalation (target <50), %s%% avg confidence (target 65+), %s%% error rate (target <15), across %s decisions. A Performance Improvement Plan has been opened.',
          m.de_name, round(m.escalation_rate), round(m.avg_confidence), round(m.error_rate), m.total_decisions);
      else
        v_verdict := 'meets';
        v_summary := format('%s meets expectations this period: %s%% resolution, %s%% avg confidence, %s%% error rate across %s decisions.',
          m.de_name, round(m.resolution_rate), round(m.avg_confidence), round(m.error_rate), m.total_decisions);
      end if;

      insert into de_performance_reviews (tenant_id, de_id, period_start, period_end, verdict, summary, metrics_snapshot)
      values (v_t.tid, m.de_id, v_period_start, v_period_end, v_verdict, v_summary,
        jsonb_build_object(
          'total_decisions', m.total_decisions, 'resolution_rate', m.resolution_rate,
          'avg_confidence', m.avg_confidence, 'escalation_rate', m.escalation_rate,
          'error_rate', m.error_rate, 'blocked_guardrail_count', m.blocked_guardrail_count,
          'avg_frustration_score', m.avg_frustration_score, 'skills', v_skills))
      on conflict (tenant_id, de_id, period_start)
      do update set period_end = excluded.period_end, verdict = excluded.verdict,
                    summary = excluded.summary, metrics_snapshot = excluded.metrics_snapshot
      returning * into v_row;

      if v_verdict = 'below' then
        -- §10.4: the PIP — a Development item with a formal deadline
        -- and a written consequence. One open PIP per DE (the partial
        -- unique index on detected items).
        insert into de_development_items (tenant_id, de_id, item_type, source, priority, description,
          target_metric, target_value, baseline_value, status, due_date, consequence)
        values (v_t.tid, m.de_id, 'pip', 'detected', 'high',
          format('Performance Improvement Plan for %s (quarterly review %s): bring escalation under 50%%, average confidence to 50+, and error rate under 15%% within 30 days. Current: %s%% / %s%% / %s%%.',
            m.de_name, v_period_start, round(m.escalation_rate), round(m.avg_confidence), round(m.error_rate)),
          'quarterly_review_thresholds', 1, 0, 'proposed', current_date + 30,
          'If targets are not met by the due date, a CRITICAL incident is raised for trust review — possible outcomes decided by a human there: trust reduction, added approval gates, or pause.')
        on conflict (tenant_id, de_id, item_type) where source = 'detected' and status in ('proposed', 'in_progress')
        do update set description = excluded.description, due_date = excluded.due_date, updated_at = now();
      elsif v_verdict = 'meets' then
        update de_development_items set status = 'completed', completed_at = now(), updated_at = now()
        where tenant_id = v_t.tid and de_id = m.de_id and item_type = 'pip'
          and source = 'detected' and status in ('proposed', 'in_progress');
      end if;

      return next v_row;
    end loop;
  end loop;
  return;
end;
$$;

revoke all on function run_de_performance_review_internal(uuid, uuid) from public, anon, authenticated;
grant execute on function run_de_performance_review_internal(uuid, uuid) to service_role;

-- On-demand authed wrapper + acknowledge RPC.
create or replace function run_de_performance_review()
returns setof de_performance_reviews
language plpgsql
security definer
set search_path = public
as $$
declare v_tenant uuid;
begin
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any workspace'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then
    raise exception 'only workspace owners/admins can run a performance review';
  end if;
  return query select * from run_de_performance_review_internal(v_tenant, null);
end;
$$;

revoke all on function run_de_performance_review() from public, anon;
grant execute on function run_de_performance_review() to authenticated, service_role;

create or replace function acknowledge_de_performance_review(p_review_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_row de_performance_reviews;
begin
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any workspace'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then
    raise exception 'only workspace owners/admins can acknowledge a review';
  end if;
  update de_performance_reviews set status = 'acknowledged', acknowledged_by = auth.uid(), acknowledged_at = now()
  where id = p_review_id and tenant_id = v_tenant
  returning * into v_row;
  if v_row.id is null then raise exception 'review not found in this workspace'; end if;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function acknowledge_de_performance_review(uuid) from public, anon;
grant execute on function acknowledge_de_performance_review(uuid) to authenticated, service_role;

-- ────────────────────────────────────────────────────────────────
-- 4. Lifecycle wiring: advancing to 'certified' (migration 126) now
--    ALSO issues the durable workspace certification (180 days), so
--    the pre-launch checkpoint and §9.5's expiring attestation are one
--    action. Signature unchanged — call sites unaffected.
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

  -- §9.5 (migration 129): the lifecycle checkpoint also issues the
  -- durable, expiring workspace certification.
  if p_to_stage = 'certified' then
    insert into de_certifications (tenant_id, de_id, cert_type, scope, note, issued_by, issued_by_name, expires_at)
    values (v_tenant, p_de_id, 'workspace', 'Pre-launch lifecycle certification', trim(p_note), auth.uid(),
            coalesce(v_actor_name, 'A workspace admin'), now() + interval '180 days');
  end if;

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

-- ────────────────────────────────────────────────────────────────
-- 5. The daily governance sweep: cert expiry warnings + expiry
--    incidents, overdue-PIP re-measurement, and the 48-hour
--    incident-review SLA nudge. Idempotent throughout (warned_at,
--    the incidents unique source key, and a detail flag).
-- ────────────────────────────────────────────────────────────────
create or replace function de_governance_sweep_internal()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_cert record;
  v_pip record;
  v_inc record;
  m record;
  v_warned integer := 0;
  v_expired integer := 0;
  v_pip_completed integer := 0;
  v_pip_failed integer := 0;
  v_sla integer := 0;
  v_de_name text;
  v_passing boolean;
begin
  -- (a) Expiring within 14 days → one warning audit event per cert.
  for v_cert in
    select c.*, de.name as de_name from de_certifications c
    join digital_employees de on de.id = c.de_id
    where c.status = 'active' and c.warned_at is null
      and c.expires_at <= now() + interval '14 days' and c.expires_at > now()
  loop
    update de_certifications set warned_at = now() where id = v_cert.id;
    perform append_audit_event_internal(
      v_cert.tenant_id, 'Governance sweep', 'system',
      format('%s''s %s certification expires %s — recertify to keep it current', v_cert.de_name, v_cert.cert_type, to_char(v_cert.expires_at, 'YYYY-MM-DD')),
      'config_change',
      jsonb_build_object('kind', 'certification_expiring', 'cert_id', v_cert.id, 'de_id', v_cert.de_id)
    );
    v_warned := v_warned + 1;
  end loop;

  -- (b) Expired → status flip + incident (dedup via unique source key).
  for v_cert in
    select c.*, de.name as de_name from de_certifications c
    join digital_employees de on de.id = c.de_id
    where c.status = 'active' and c.expires_at <= now()
  loop
    update de_certifications set status = 'expired' where id = v_cert.id;
    insert into de_incidents (tenant_id, de_id, kind, severity, title, detail, source_table, source_id, occurred_at)
    values (v_cert.tenant_id, v_cert.de_id, 'certification_expired', 'warning',
      format('%s certification expired — %s', initcap(v_cert.cert_type), v_cert.de_name),
      jsonb_build_object('cert_id', v_cert.id, 'cert_type', v_cert.cert_type, 'scope', v_cert.scope,
                         'issued_by', v_cert.issued_by_name, 'expired_at', v_cert.expires_at),
      'de_certifications', v_cert.id, v_cert.expires_at)
    on conflict (tenant_id, source_table, source_id) do nothing;
    v_expired := v_expired + 1;
  end loop;

  -- (c) Overdue open PIPs → RE-MEASURE on a fresh 4-week window: now
  --     passing → completed (closed loop); still failing → 'failed' +
  --     CRITICAL incident for human trust review.
  for v_pip in
    select i.* from de_development_items i
    where i.item_type = 'pip' and i.source = 'detected'
      and i.status in ('proposed', 'in_progress') and i.due_date < current_date
  loop
    select name into v_de_name from digital_employees where id = v_pip.de_id;
    v_passing := false;
    for m in select * from get_de_performance_metrics(v_pip.tenant_id, 4) where de_id = v_pip.de_id loop
      v_passing := m.total_decisions >= 10
        and m.escalation_rate <= 50 and m.avg_confidence >= 50 and m.error_rate <= 15;
    end loop;

    if v_passing then
      update de_development_items set status = 'completed', completed_at = now(), updated_at = now() where id = v_pip.id;
      perform append_audit_event_internal(
        v_pip.tenant_id, 'Governance sweep', 'system',
        format('%s met its Performance Improvement Plan targets — PIP closed', coalesce(v_de_name, 'Employee')),
        'config_change',
        jsonb_build_object('kind', 'pip_completed', 'item_id', v_pip.id, 'de_id', v_pip.de_id)
      );
      v_pip_completed := v_pip_completed + 1;
    else
      update de_development_items set status = 'failed', updated_at = now() where id = v_pip.id;
      insert into de_incidents (tenant_id, de_id, kind, severity, title, detail, source_table, source_id, occurred_at)
      values (v_pip.tenant_id, v_pip.de_id, 'pip_failed', 'critical',
        format('Performance Improvement Plan failed — %s', coalesce(v_de_name, 'employee')),
        jsonb_build_object('item_id', v_pip.id, 'due_date', v_pip.due_date,
          'consequence', v_pip.consequence,
          'next_step', 'A human decides here: trust reduction, added approval gates, or pause (Pause is on the employee profile).'),
        'de_development_items', v_pip.id, now())
      on conflict (tenant_id, source_table, source_id) do nothing;
      v_pip_failed := v_pip_failed + 1;
    end if;
  end loop;

  -- (d) §10.3: critical incidents should be reviewed within 48 hours —
  --     one nudge each (detail flag dedup).
  for v_inc in
    select * from de_incidents
    where status = 'open' and severity = 'critical'
      and created_at < now() - interval '48 hours'
      and coalesce(detail->>'sla_nudged', '') = ''
  loop
    update de_incidents set detail = detail || '{"sla_nudged": true}'::jsonb where id = v_inc.id;
    perform append_audit_event_internal(
      v_inc.tenant_id, 'Governance sweep', 'system',
      format('Critical incident open past the 48-hour review window: %s', left(v_inc.title, 160)),
      'config_change',
      jsonb_build_object('kind', 'incident_sla_nudge', 'incident_id', v_inc.id, 'de_id', v_inc.de_id)
    );
    v_sla := v_sla + 1;
  end loop;

  return jsonb_build_object('cert_warnings', v_warned, 'certs_expired', v_expired,
    'pips_completed', v_pip_completed, 'pips_failed', v_pip_failed, 'sla_nudges', v_sla);
end;
$$;

revoke all on function de_governance_sweep_internal() from public, anon, authenticated;
grant execute on function de_governance_sweep_internal() to service_role;

-- ────────────────────────────────────────────────────────────────
-- 6. Cadence: daily governance sweep + quarterly review run (§10.3).
-- ────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from cron.job where jobname = 'de-governance-sweep-daily') then
    perform cron.unschedule('de-governance-sweep-daily');
  end if;
  perform cron.schedule('de-governance-sweep-daily', '45 6 * * *', 'select de_governance_sweep_internal()');

  if exists (select 1 from cron.job where jobname = 'de-performance-review-quarterly') then
    perform cron.unschedule('de-performance-review-quarterly');
  end if;
  perform cron.schedule('de-performance-review-quarterly', '0 7 1 1,4,7,10 *',
    'select count(*) from run_de_performance_review_internal()');
end $$;
