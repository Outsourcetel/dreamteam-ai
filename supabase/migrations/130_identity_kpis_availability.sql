-- DE-C4: structured identity, real KPIs, and a scoped availability
-- model (constitution §3.1–3.2, §3.13, §3.19).
--
-- Honesty audit that shaped this scope:
--   * Identity/Purpose (§3.1–3.2): only shipped because every field is
--     CONSUMED somewhere real — display_title + purpose_statement feed
--     the answering persona's system prompt (dePersona.ts, deployed
--     alongside), and responsibilities finally get an edit surface
--     (they've been a dead seed-time column since migration 001, and
--     are a lifecycle identity_complete criterion since 126).
--   * KPIs (§3.13): a KPI row stores name/metric/target only. The
--     CURRENT value is computed at read time from the same real metric
--     functions the Performance page uses — never stored, never stale,
--     never fabricated. Only metrics this platform actually measures
--     are allowed as keys.
--   * Availability (§3.19): ONLY the schedule shipped, enforced at the
--     one surface with real machinery — inbox polling. Off-schedule =
--     ineligible, so a business-hours employee's inbox falls to its
--     always-on team backup (C2) or the specialist desk overnight.
--     Reactive Q&A stays available off-schedule (same scoped deviation
--     as migration 126 — the widget is the sandbox/reactive surface).
--     max_concurrent_tasks and queue_overflow_behavior are NOT built:
--     no concurrency or queue machinery exists to honor them, and
--     storing that config would be a lie-in-waiting.

-- ────────────────────────────────────────────────────────────────
-- 1. Identity columns + availability.
-- ────────────────────────────────────────────────────────────────
alter table digital_employees add column if not exists display_title text not null default '';
alter table digital_employees add column if not exists purpose_statement text not null default '';
alter table digital_employees add column if not exists primary_business_outcome text not null default '';
alter table digital_employees add column if not exists availability jsonb not null default '{"mode": "always_on"}'::jsonb;

-- ────────────────────────────────────────────────────────────────
-- 2. Availability resolution. FAIL-OPEN on malformed config (a typo'd
--    timezone must never silently stop a live inbox — the set RPC
--    validates on write; this is the belt-and-braces read side).
-- ────────────────────────────────────────────────────────────────
create or replace function de_is_available(p_availability jsonb)
returns boolean
language plpgsql
stable
set search_path = public
as $$
declare
  v_now timestamp;
  v_dow integer;
  v_hour integer;
begin
  if coalesce(p_availability->>'mode', 'always_on') <> 'business_hours' then
    return true;
  end if;
  begin
    v_now := now() at time zone coalesce(p_availability->>'timezone', 'UTC');
  exception when others then
    return true;  -- fail-open: bad timezone never stops an inbox
  end;
  v_dow := extract(isodow from v_now);
  v_hour := extract(hour from v_now);
  return exists (
      select 1 from jsonb_array_elements_text(coalesce(p_availability->'days', '[1,2,3,4,5]'::jsonb)) d
      where d::integer = v_dow)
    and v_hour >= coalesce((p_availability->>'start_hour')::integer, 9)
    and v_hour < coalesce((p_availability->>'end_hour')::integer, 17);
exception when others then
  return true;  -- fail-open on any malformed shape
end;
$$;

revoke all on function de_is_available(jsonb) from public, anon;
grant execute on function de_is_available(jsonb) to authenticated, service_role;

-- ────────────────────────────────────────────────────────────────
-- 3. Identity + availability RPCs — owner/admin, RA-aware, audited,
--    config-versioned (§13.5 discipline, same as update_digital_
--    employee — which is deliberately NOT touched: today's migration-
--    117 lesson is that recreating a live function from anything but
--    its latest body invites regressions; a dedicated RPC avoids the
--    risk entirely).
-- ────────────────────────────────────────────────────────────────
create or replace function set_de_identity(
  p_de_id uuid,
  p_display_title text default null,
  p_purpose_statement text default null,
  p_primary_business_outcome text default null,
  p_responsibilities text[] default null
)
returns digital_employees
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_row digital_employees;
  v_actor text;
begin
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then
    raise exception 'only workspace owners/admins can edit a Digital Employee''s identity';
  end if;
  select * into v_row from digital_employees where id = p_de_id and tenant_id = v_tenant;
  if v_row.id is null then raise exception 'employee not found in this workspace'; end if;
  if v_row.lifecycle_status in ('retired', 'archived') then
    raise exception 'this employee is retired — configuration is locked read-only';
  end if;

  update digital_employees set
    display_title = coalesce(p_display_title, display_title),
    purpose_statement = coalesce(p_purpose_statement, purpose_statement),
    primary_business_outcome = coalesce(p_primary_business_outcome, primary_business_outcome),
    responsibilities = coalesce(p_responsibilities, responsibilities),
    config_version = config_version + 1,
    updated_at = now()
  where id = p_de_id
  returning * into v_row;

  select full_name into v_actor from profiles where user_id = auth.uid();
  perform append_audit_event_internal(
    v_tenant, coalesce(v_actor, 'A workspace admin'), 'human',
    format('%s identity updated (title/purpose/responsibilities) — config v%s', v_row.name, v_row.config_version),
    'config_change',
    jsonb_build_object('kind', 'de_identity_update', 'de_id', p_de_id, 'config_version', v_row.config_version)
  );
  return v_row;
end;
$$;

revoke all on function set_de_identity(uuid, text, text, text, text[]) from public, anon;
grant execute on function set_de_identity(uuid, text, text, text, text[]) to authenticated, service_role;

create or replace function set_de_availability(
  p_de_id uuid,
  p_mode text,
  p_timezone text default 'UTC',
  p_start_hour integer default 9,
  p_end_hour integer default 17,
  p_days integer[] default array[1,2,3,4,5]
)
returns digital_employees
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_row digital_employees;
  v_actor text;
  v_avail jsonb;
  v_probe timestamp;
begin
  if p_mode not in ('always_on', 'business_hours') then
    raise exception 'availability mode must be always_on or business_hours';
  end if;
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then
    raise exception 'only workspace owners/admins can set availability';
  end if;
  select * into v_row from digital_employees where id = p_de_id and tenant_id = v_tenant;
  if v_row.id is null then raise exception 'employee not found in this workspace'; end if;

  if p_mode = 'business_hours' then
    if p_start_hour < 0 or p_start_hour > 23 or p_end_hour < 1 or p_end_hour > 24 or p_start_hour >= p_end_hour then
      raise exception 'hours must satisfy 0 <= start < end <= 24';
    end if;
    if p_days is null or array_length(p_days, 1) is null then
      raise exception 'business hours need at least one working day (1=Mon … 7=Sun)';
    end if;
    begin
      v_probe := now() at time zone p_timezone;  -- validates the tz name
    exception when others then
      raise exception 'unknown timezone "%"', p_timezone;
    end;
    v_avail := jsonb_build_object('mode', 'business_hours', 'timezone', p_timezone,
      'start_hour', p_start_hour, 'end_hour', p_end_hour, 'days', to_jsonb(p_days));
  else
    v_avail := '{"mode": "always_on"}'::jsonb;
  end if;

  update digital_employees set availability = v_avail, updated_at = now()
  where id = p_de_id returning * into v_row;

  select full_name into v_actor from profiles where user_id = auth.uid();
  perform append_audit_event_internal(
    v_tenant, coalesce(v_actor, 'A workspace admin'), 'human',
    format('%s availability set to %s%s', v_row.name, p_mode,
      case when p_mode = 'business_hours' then format(' (%s–%s %s)', p_start_hour, p_end_hour, p_timezone) else '' end),
    'config_change',
    jsonb_build_object('kind', 'de_availability_set', 'de_id', p_de_id, 'availability', v_avail)
  );
  return v_row;
end;
$$;

revoke all on function set_de_availability(uuid, text, text, integer, integer, integer[]) from public, anon;
grant execute on function set_de_availability(uuid, text, text, integer, integer, integer[]) to authenticated, service_role;

-- ────────────────────────────────────────────────────────────────
-- 4. KPIs — targets stored, CURRENT computed live from real metrics.
-- ────────────────────────────────────────────────────────────────
create table if not exists de_kpis (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  de_id uuid not null references digital_employees(id) on delete cascade,
  name text not null,
  metric_key text not null check (metric_key in (
    'resolution_rate', 'avg_confidence', 'escalation_rate', 'error_rate',
    'csat_pct', 'high_frustration_count', 'total_decisions')),
  target numeric not null,
  direction text not null check (direction in ('higher', 'lower')),
  owner_user_id uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, de_id, metric_key)
);

alter table de_kpis enable row level security;
drop policy if exists de_kpis_tenant_select on de_kpis;
create policy de_kpis_tenant_select on de_kpis
  for select to authenticated using (tenant_id = auth_tenant_id());

create or replace function set_de_kpi(
  p_de_id uuid, p_metric_key text, p_name text, p_target numeric, p_direction text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_de_name text;
  v_actor text;
begin
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then
    raise exception 'only workspace owners/admins can set KPIs';
  end if;
  select name into v_de_name from digital_employees
  where id = p_de_id and tenant_id = v_tenant and lifecycle_status not in ('retired', 'archived');
  if v_de_name is null then raise exception 'employee not found in this workspace (or retired)'; end if;

  select full_name into v_actor from profiles where user_id = auth.uid();

  if p_target is null then
    delete from de_kpis where tenant_id = v_tenant and de_id = p_de_id and metric_key = p_metric_key;
    perform append_audit_event_internal(
      v_tenant, coalesce(v_actor, 'A workspace admin'), 'human',
      format('%s KPI removed (%s)', v_de_name, p_metric_key),
      'config_change',
      jsonb_build_object('kind', 'de_kpi_removed', 'de_id', p_de_id, 'metric_key', p_metric_key)
    );
    return jsonb_build_object('ok', true, 'removed', true);
  end if;

  if p_direction not in ('higher', 'lower') then raise exception 'direction must be higher or lower'; end if;
  if p_name is null or trim(p_name) = '' then raise exception 'a KPI needs a name'; end if;

  insert into de_kpis (tenant_id, de_id, name, metric_key, target, direction, owner_user_id)
  values (v_tenant, p_de_id, trim(p_name), p_metric_key, p_target, p_direction, auth.uid())
  on conflict (tenant_id, de_id, metric_key)
  do update set name = excluded.name, target = excluded.target, direction = excluded.direction;

  perform append_audit_event_internal(
    v_tenant, coalesce(v_actor, 'A workspace admin'), 'human',
    format('%s KPI set — "%s": %s %s %s', v_de_name, trim(p_name), p_metric_key,
      case when p_direction = 'higher' then '≥' else '≤' end, p_target),
    'config_change',
    jsonb_build_object('kind', 'de_kpi_set', 'de_id', p_de_id, 'metric_key', p_metric_key, 'target', p_target)
  );
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function set_de_kpi(uuid, text, text, numeric, text) from public, anon;
grant execute on function set_de_kpi(uuid, text, text, numeric, text) to authenticated, service_role;

-- Live status: target vs CURRENT (computed from the same real metric
-- functions the Performance page uses; 13-week window). A KPI with no
-- measurable sample returns current=null, met=null — honest, not zero.
create or replace function get_de_kpi_status(p_de_id uuid)
returns table(kpi_id uuid, name text, metric_key text, target numeric, direction text,
              current numeric, met boolean, sample bigint)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_tenant uuid;
  m record;
  v_csat numeric;
  v_csat_n bigint;
begin
  select tenant_id into v_tenant from digital_employees where id = p_de_id;
  if v_tenant is null then return; end if;
  if auth.role() is not null and auth.role() <> 'service_role' then
    if auth_tenant_id() is distinct from v_tenant then
      raise exception 'not a member of this workspace';
    end if;
  end if;

  select * into m from get_de_performance_metrics(v_tenant, 13) where de_id = p_de_id;

  select round(100.0 * count(*) filter (where csat_score = 1) / nullif(count(*) filter (where csat_submitted_at is not null), 0), 1),
         count(*) filter (where csat_submitted_at is not null)
    into v_csat, v_csat_n
  from de_conversations where tenant_id = v_tenant and de_id = p_de_id;

  return query
  select k.id, k.name, k.metric_key, k.target, k.direction,
    case k.metric_key
      when 'resolution_rate' then case when coalesce(m.total_decisions, 0) >= 1 then m.resolution_rate end
      when 'avg_confidence' then case when coalesce(m.total_decisions, 0) >= 1 then m.avg_confidence end
      when 'escalation_rate' then case when coalesce(m.total_decisions, 0) >= 1 then m.escalation_rate end
      when 'error_rate' then case when coalesce(m.total_runs, 0) >= 1 then m.error_rate end
      when 'csat_pct' then v_csat
      when 'high_frustration_count' then case when coalesce(m.total_decisions, 0) >= 1 then m.high_frustration_count::numeric end
      when 'total_decisions' then coalesce(m.total_decisions, 0)::numeric
    end as current,
    case
      when (case k.metric_key
              when 'resolution_rate' then case when coalesce(m.total_decisions, 0) >= 1 then m.resolution_rate end
              when 'avg_confidence' then case when coalesce(m.total_decisions, 0) >= 1 then m.avg_confidence end
              when 'escalation_rate' then case when coalesce(m.total_decisions, 0) >= 1 then m.escalation_rate end
              when 'error_rate' then case when coalesce(m.total_runs, 0) >= 1 then m.error_rate end
              when 'csat_pct' then v_csat
              when 'high_frustration_count' then case when coalesce(m.total_decisions, 0) >= 1 then m.high_frustration_count::numeric end
              when 'total_decisions' then coalesce(m.total_decisions, 0)::numeric
            end) is null then null
      when k.direction = 'higher' then
        (case k.metric_key
           when 'resolution_rate' then m.resolution_rate
           when 'avg_confidence' then m.avg_confidence
           when 'escalation_rate' then m.escalation_rate
           when 'error_rate' then m.error_rate
           when 'csat_pct' then v_csat
           when 'high_frustration_count' then m.high_frustration_count::numeric
           when 'total_decisions' then m.total_decisions::numeric
         end) >= k.target
      else
        (case k.metric_key
           when 'resolution_rate' then m.resolution_rate
           when 'avg_confidence' then m.avg_confidence
           when 'escalation_rate' then m.escalation_rate
           when 'error_rate' then m.error_rate
           when 'csat_pct' then v_csat
           when 'high_frustration_count' then m.high_frustration_count::numeric
           when 'total_decisions' then m.total_decisions::numeric
         end) <= k.target
    end as met,
    case k.metric_key when 'csat_pct' then v_csat_n else coalesce(m.total_decisions, 0) end as sample
  from de_kpis k
  where k.de_id = p_de_id
  order by k.created_at;
end;
$$;

revoke all on function get_de_kpi_status(uuid) from public, anon;
grant execute on function get_de_kpi_status(uuid) to authenticated, service_role;

-- ────────────────────────────────────────────────────────────────
-- 5. THE AVAILABILITY ENFORCEMENT — poll gate recreation (byte-
--    identical to migration 128's version plus de_is_available in all
--    three eligibility checks: the DE's own row, the team peer, and
--    the specialist suppression — so off-schedule falls through the
--    same chain as paused: primary → backup → specialist).
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
    -- LIFECYCLE + AVAILABILITY GATE (126 + 130): operational stage AND
    -- on schedule.
    and (g.subject_kind <> 'de'
         or (de.lifecycle_status in ('assigned', 'active', 'improving') and de.status = 'active'
             and de_is_available(de.availability)))
    -- TEAM FALLBACK CHAIN (128): lowest-rank eligible member with a
    -- grant on this source owns it.
    and not (
      g.subject_kind = 'de'
      and exists (
        select 1
        from workforce_team_members me
        join workforce_teams t on t.id = me.team_id and t.status = 'active'
        join workforce_team_members peer on peer.team_id = me.team_id and peer.fallback_rank < me.fallback_rank
        join digital_employees pde on pde.id = peer.de_id
        where me.de_id = g.subject_id
          and t.tenant_id = c.tenant_id
          and pde.lifecycle_status in ('assigned', 'active', 'improving')
          and pde.status = 'active'
          and de_is_available(pde.availability)
          and exists (
            select 1 from data_access_grants pg
            where pg.tenant_id = c.tenant_id and pg.subject_kind = 'de' and pg.subject_id = pde.id
              and ((pg.resource_kind = 'connector' and pg.resource_id = c.id)
                   or (pg.resource_kind = 'category' and pg.resource_category = c.category))
              and access_permission_level(pg.permission) >= access_permission_level('search')
          )
      )
    )
    -- The DE owns the inbox: a specialist polls only when no ELIGIBLE,
    -- ON-SCHEDULE DE is on this connector (121 + 126 + 130).
    and not (
      g.subject_kind = 'specialist'
      and exists (
        select 1 from data_access_grants g2
        join digital_employees de2 on de2.id = g2.subject_id
        where g2.tenant_id = c.tenant_id and g2.subject_kind = 'de'
          and de2.lifecycle_status in ('assigned', 'active', 'improving')
          and de2.status = 'active'
          and de_is_available(de2.availability)
          and ((g2.resource_kind = 'connector' and g2.resource_id = c.id)
               or (g2.resource_kind = 'category' and g2.resource_category = c.category))
          and access_permission_level(g2.permission) >= access_permission_level('search')
      )
    );
$$;
