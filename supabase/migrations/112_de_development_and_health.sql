-- Migration 112: Wave 4 (Development Plans, evidence-grounded) + Wave 5
-- (DE Health, evidence-grounded) — both scoped deliberately narrower
-- than their full docs/10 specs, built ONLY on signals that are
-- already real and live (get_de_performance_metrics/093, get_de_
-- guardrail_activity/096, get_de_cost_metrics/094). Confirmed via
-- research before writing a line of this: capabilities (002),
-- digital_employees.skills (001), and any Development Plan/
-- Certification/health-score concept were all fully greenfield —
-- nothing latent to activate, no shortcuts available.
--
-- EXPLICITLY NOT BUILT (would require fabricating data, not
-- composing real data): Certification records (no reviewer/expiry
-- concept exists anywhere), Skills proficiency profiles (no per-skill
-- granularity — evidence_runs has no category dimension), Capability
-- primary/backup assignment (§6.4 — no concept of "unavailable"
-- routing exists), Workforce Teams (§7.1-7.5 — roles/KPIs/coordination
-- policy, fully greenfield), FTE Equivalent / ROI (§12.3-12.4 — need
-- org-configured avg_human_task_time_minutes / avg_human_fte_cost_usd,
-- which exist nowhere in this codebase; inventing them would mean
-- fabricating the exact kind of number this codebase has repeatedly
-- and deliberately refused to fake — see LivePerformancePage's own
-- comment: "no assumed human-cost comparison, since there's no real
-- baseline to compare against yet"), executive PDF reports (zero
-- infrastructure exists).
-- ============================================================

-- ── de_development_items: the real Development Plan object (docs
-- §9.2). Two sources: 'detected' (proposed from real performance
-- data by detect_de_development_needs) and 'manual' (an owner/admin
-- creates one directly, e.g. from a performance review). ──────────
create table if not exists de_development_items (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  de_id          uuid not null references digital_employees(id) on delete cascade,
  item_type      text not null check (item_type in ('confidence_gap', 'escalation_spike', 'error_rate', 'guardrail_pattern', 'manual')),
  source         text not null check (source in ('detected', 'manual')),
  priority       text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  description    text not null,
  target_metric  text,
  target_value   numeric,
  baseline_value numeric,
  status         text not null default 'proposed' check (status in ('proposed', 'in_progress', 'completed', 'dismissed')),
  assigned_to    uuid,
  due_date       date,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  completed_at   timestamptz
);

-- One OPEN item per (DE, item_type) — re-running detection refreshes
-- the existing open item's baseline/description instead of spawning
-- duplicates every time the same underlying issue is still present.
-- Manual items are exempt (a human might legitimately want several
-- concurrent manual items of a loosely-similar type).
create unique index if not exists de_development_items_open_detected_uq
  on de_development_items (tenant_id, de_id, item_type)
  where source = 'detected' and status in ('proposed', 'in_progress');

alter table de_development_items enable row level security;

create policy de_development_items_tenant_select on de_development_items
  for select using (tenant_id = auth_tenant_id());

create policy de_development_items_tenant_admin_write on de_development_items
  for all using (tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner','tenant_admin']))
  with check (tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner','tenant_admin']));

revoke all on de_development_items from public;
revoke all on de_development_items from anon;
grant select, insert, update, delete on de_development_items to authenticated;
revoke trigger, truncate, references on de_development_items from authenticated;
grant all on de_development_items to service_role;

-- ── sync_de_lifecycle_from_development: the one real enforcement
-- this migration adds to lifecycle_status beyond Wave 2's 'retired'
-- gate — docs §8.2's Improving entry/exit criteria ("Performance
-- review identifies a gap; a Development Plan is active" / "Development
-- Plan targets met"). Internal helper, called from the item-writing
-- functions below — NOT exposed to authenticated directly, since
-- callers must go through the gated functions that call it, not
-- invoke lifecycle transitions arbitrarily. Only ever moves a DE
-- between 'active' and 'improving' — never touches any other stage
-- (a DE still 'designed'/'trained'/'paused'/'retired' is untouched). ──
create or replace function sync_de_lifecycle_from_development(p_de_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_de digital_employees;
  v_open_count integer;
begin
  select * into v_de from digital_employees where id = p_de_id;
  if v_de.id is null then return; end if;

  select count(*) into v_open_count from de_development_items
  where de_id = p_de_id and status in ('proposed', 'in_progress');

  if v_open_count > 0 and v_de.lifecycle_status = 'active' then
    update digital_employees set lifecycle_status = 'improving', updated_at = now() where id = p_de_id;
  elsif v_open_count = 0 and v_de.lifecycle_status = 'improving' then
    update digital_employees set lifecycle_status = 'active', updated_at = now() where id = p_de_id;
  end if;
end;
$function$;

revoke all on function sync_de_lifecycle_from_development(uuid) from public;
revoke all on function sync_de_lifecycle_from_development(uuid) from anon;
revoke all on function sync_de_lifecycle_from_development(uuid) from authenticated;
grant execute on function sync_de_lifecycle_from_development(uuid) to service_role;

-- ============================================================
-- detect_de_development_needs — proposes items from REAL performance
-- data (8-week window from get_de_performance_metrics, 093), never
-- invented signals. Thresholds below are invented v1 judgment calls,
-- flagged explicitly here rather than presented as derived from a
-- real baseline (this codebase has no historical baseline yet) —
-- same category as the existing hardcoded frustration_score>=50 and
-- $10,000 guardrail-approval precedents elsewhere in this codebase.
-- Requires a minimum sample size (10 decisions in the window) so a
-- brand-new DE with a handful of runs doesn't get flagged on noise.
-- ============================================================
create or replace function detect_de_development_needs(p_tenant_id uuid)
returns setof de_development_items
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_role text;
  v_is_active boolean;
  v_tenant uuid;
  m record;
  v_candidate record;
  v_row de_development_items;
begin
  select tenant_id, role, coalesce(is_active, true) into v_tenant, v_role, v_is_active from profiles where user_id = auth.uid();
  if v_tenant is null or v_tenant <> p_tenant_id then raise exception 'not a member of this workspace'; end if;
  if not v_is_active then raise exception 'account is deactivated'; end if;
  if v_role not in ('tenant_owner', 'tenant_admin') then raise exception 'only workspace owners/admins can scan for development needs'; end if;

  for m in select * from get_de_performance_metrics(p_tenant_id, 8) where total_decisions >= 10
  loop
    -- Independent checks, not a first-match chain — a DE can genuinely
    -- have more than one real gap at once (confirmed live: Acme's
    -- Finance DE and Support DE both currently show 100% escalation
    -- AND sub-50% confidence simultaneously), and each is worth its
    -- own item, not just whichever check happens to run first.
    -- get_de_performance_metrics returns escalation_rate/error_rate as
    -- 0-100 PERCENTAGES (round(100.0 * count(...) / count(*), 1)), not
    -- 0-1 fractions — confirmed by reading its source before trusting
    -- a threshold against it. avg_confidence is likewise already 0-100
    -- (evidence_run_decisions.confidence is an integer percentage
    -- throughout this codebase), so its threshold needs no scaling.
    for v_candidate in
      select * from (values
        ('escalation_spike', m.escalation_rate > 50, 'escalation_rate'::text, 30::numeric, m.escalation_rate,
          format('%s escalated %s%% of %s decisions over the last 8 weeks — more than half. Target: bring escalation rate under 30%%.', m.de_name, round(m.escalation_rate), m.total_decisions)),
        ('confidence_gap', m.avg_confidence < 50, 'avg_confidence', 65::numeric, m.avg_confidence,
          format('%s''s average confidence across %s decisions is %s%% — evidence or knowledge coverage may be thin. Target: 65%%+.', m.de_name, m.total_decisions, round(m.avg_confidence))),
        ('error_rate', m.error_rate > 15, 'error_rate', 5::numeric, m.error_rate,
          format('%s had a %s%% run error rate over the last 8 weeks (%s runs). Target: under 5%%.', m.de_name, round(m.error_rate), m.total_runs)),
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
$function$;

revoke all on function detect_de_development_needs(uuid) from public;
revoke all on function detect_de_development_needs(uuid) from anon;
grant execute on function detect_de_development_needs(uuid) to authenticated, service_role;

-- ── create_de_development_item — manual creation (a human-authored
-- item, e.g. from a performance review). ───────────────────────────
create or replace function create_de_development_item(
  p_de_id uuid, p_description text, p_target_metric text default null,
  p_target_value numeric default null, p_priority text default 'medium',
  p_due_date date default null, p_assigned_to uuid default null
) returns de_development_items
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_tenant uuid; v_role text; v_is_active boolean; v_row de_development_items;
begin
  select tenant_id, role, coalesce(is_active, true) into v_tenant, v_role, v_is_active from profiles where user_id = auth.uid();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not v_is_active then raise exception 'account is deactivated'; end if;
  if v_role not in ('tenant_owner', 'tenant_admin') then raise exception 'only workspace owners/admins can create a development item'; end if;
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
$function$;

revoke all on function create_de_development_item(uuid, text, text, numeric, text, date, uuid) from public;
revoke all on function create_de_development_item(uuid, text, text, numeric, text, date, uuid) from anon;
grant execute on function create_de_development_item(uuid, text, text, numeric, text, date, uuid) to authenticated, service_role;

-- ── update_de_development_item_status — the only mutation path once
-- an item exists (start/complete/dismiss). Triggers the lifecycle
-- sync so completing the last open item genuinely exits 'improving'. ──
create or replace function update_de_development_item_status(p_item_id uuid, p_status text)
returns de_development_items
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_tenant uuid; v_role text; v_is_active boolean; v_row de_development_items;
begin
  if p_status not in ('proposed', 'in_progress', 'completed', 'dismissed') then
    raise exception 'invalid status %', p_status;
  end if;
  select tenant_id, role, coalesce(is_active, true) into v_tenant, v_role, v_is_active from profiles where user_id = auth.uid();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not v_is_active then raise exception 'account is deactivated'; end if;
  if v_role not in ('tenant_owner', 'tenant_admin') then raise exception 'only workspace owners/admins can update a development item'; end if;

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
$function$;

revoke all on function update_de_development_item_status(uuid, text) from public;
revoke all on function update_de_development_item_status(uuid, text) from anon;
grant execute on function update_de_development_item_status(uuid, text) to authenticated, service_role;

-- ============================================================
-- list_de_health — Wave 5. Composes ONLY signals that are already
-- real (get_de_performance_metrics/093, get_de_guardrail_activity/096,
-- get_de_cost_metrics/094, de_development_items above) into a single
-- state per DE. Deliberately implements a SUBSET of docs §11.2's 11
-- states — only the ones with a real underlying signal today:
--   incident_active   — a guardrail block in the last 7 days
--   degraded          — escalation_rate/error_rate over an invented
--                        v1 threshold (same class as detect_de_
--                        development_needs' thresholds above)
--   low_confidence     — avg_confidence under an invented v1 floor
--   high_cost          — cost this period over an invented v1 dollar
--                         floor (no real per-tenant cost baseline
--                         exists yet to compare against instead)
--   improving           — lifecycle_status = 'improving' (now real,
--                          driven by de_development_items above)
--   healthy             — none of the above, adequate sample size
--   insufficient_data   — not enough real decisions yet to say
--                          anything honest (a brand-new DE is NOT
--                          reported "healthy" on zero evidence)
--   retired             — lifecycle_status = 'retired'
-- NOT implemented: policy_restricted, awaiting_approval, knowledge_
-- outdated, connector_failure, certification_expired — none have a
-- real, attributable-per-DE signal in this codebase today. Reporting
-- them would mean fabricating a signal, which this migration's whole
-- premise refuses to do.
-- ============================================================
create or replace function list_de_health(p_tenant_id uuid)
returns table(
  de_id uuid, de_name text, state text, signals jsonb,
  total_decisions bigint, avg_confidence numeric, escalation_rate numeric, error_rate numeric,
  recent_guardrail_blocks bigint, cost_this_period_usd numeric, cost_per_task_usd numeric
)
language plpgsql
stable
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_tenant uuid; v_role text; v_is_active boolean;
begin
  select tenant_id, role, coalesce(is_active, true) into v_tenant, v_role, v_is_active from profiles where user_id = auth.uid();
  if v_tenant is null or v_tenant <> p_tenant_id then raise exception 'not a member of this workspace'; end if;
  if not v_is_active then raise exception 'account is deactivated'; end if;

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
      -- escalation_rate/error_rate are 0-100 percentages from
      -- get_de_performance_metrics, not 0-1 fractions — same scale
      -- correction made in detect_de_development_needs above.
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
$function$;

revoke all on function list_de_health(uuid) from public;
revoke all on function list_de_health(uuid) from anon;
grant execute on function list_de_health(uuid) to authenticated, service_role;
