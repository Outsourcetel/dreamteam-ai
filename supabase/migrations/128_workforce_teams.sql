-- DE-C2: Workforce Teams + primary/backup resilience (constitution §7).
--
-- SCOPE (deliberately bounded, same discipline as Wave 3's §7.6 note):
-- this ships the ONE §7.5 coordination behavior our machinery can
-- genuinely enforce — FALLBACK CHAINS. A team is a named group of DEs
-- with a fallback order; on any shared work source, the lowest-rank
-- ELIGIBLE member owns the inbox and higher ranks stay silent, taking
-- over automatically when the primary is paused/retired/pre-launch
-- (composing with migration 126's lifecycle gate). The layered result:
-- primary DE → backup DE → specialist desk → nothing.
--
-- NOT built, on purpose:
--   * Coordinator DE / Composition (§7.6): the constitution itself
--     gates this behind Phase 3 ("must not be implemented before the
--     single-DE model is stable"). Wave 3's single-hop consultation
--     remains the only sanctioned DE-to-DE interaction.
--   * Routing rules / load balancing / team memory / team KPIs (§7.5,
--     §7.2): no machinery exists to honor them — storing that config
--     would be a lie-in-waiting. Team KPIs arrive with DE-C4/C5.
--   * escalation_handler / quality_reviewer roles: routing a DE's
--     escalation to ANOTHER DE for autonomous handling is composition
--     territory; escalations keep going to humans (draft-for-approval
--     posture). Role vocabulary here is therefore rank-based: rank 1
--     is the primary responder, rank 2+ are backups.
--
-- TEAMS NEVER GRANT ACCESS. The Control Fabric stays necessary-never-
-- sufficient: a backup with no grant on a connector never polls it,
-- whatever its rank. Making a backup real = also granting it access —
-- evaluated independently, exactly like §7.6's governance rule 4.

create table if not exists workforce_teams (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  purpose text not null default '',
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists workforce_teams_tenant_idx on workforce_teams(tenant_id);

create table if not exists workforce_team_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  team_id uuid not null references workforce_teams(id) on delete cascade,
  de_id uuid not null references digital_employees(id) on delete cascade,
  fallback_rank integer not null check (fallback_rank >= 1),
  created_at timestamptz not null default now(),
  unique (team_id, de_id),
  unique (team_id, fallback_rank)
);

create index if not exists workforce_team_members_de_idx on workforce_team_members(tenant_id, de_id);

alter table workforce_teams enable row level security;
alter table workforce_team_members enable row level security;

drop policy if exists workforce_teams_tenant_select on workforce_teams;
create policy workforce_teams_tenant_select on workforce_teams
  for select to authenticated using (tenant_id = auth_tenant_id());

drop policy if exists workforce_team_members_tenant_select on workforce_team_members;
create policy workforce_team_members_tenant_select on workforce_team_members
  for select to authenticated using (tenant_id = auth_tenant_id());

-- Writes only via the RPCs below.

-- ────────────────────────────────────────────────────────────────
-- Team management — owner/admin, Remote-Access-aware, audited.
-- ────────────────────────────────────────────────────────────────
create or replace function upsert_workforce_team(p_name text, p_purpose text default '', p_team_id uuid default null)
returns workforce_teams
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_row workforce_teams;
  v_actor text;
begin
  if p_name is null or trim(p_name) = '' then raise exception 'a team needs a name'; end if;
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then
    raise exception 'only workspace owners/admins can manage workforce teams';
  end if;

  if p_team_id is null then
    insert into workforce_teams (tenant_id, name, purpose, created_by)
    values (v_tenant, trim(p_name), coalesce(p_purpose, ''), auth.uid())
    returning * into v_row;
  else
    update workforce_teams set name = trim(p_name), purpose = coalesce(p_purpose, ''), updated_at = now()
    where id = p_team_id and tenant_id = v_tenant
    returning * into v_row;
    if v_row.id is null then raise exception 'team not found in this workspace'; end if;
  end if;

  select full_name into v_actor from profiles where user_id = auth.uid();
  perform append_audit_event_internal(
    v_tenant, coalesce(v_actor, 'A workspace admin'), 'human',
    format('Workforce team "%s" %s', v_row.name, case when p_team_id is null then 'created' else 'updated' end),
    'config_change',
    jsonb_build_object('kind', 'workforce_team_upsert', 'team_id', v_row.id)
  );
  return v_row;
end;
$$;

revoke all on function upsert_workforce_team(text, text, uuid) from public, anon;
grant execute on function upsert_workforce_team(text, text, uuid) to authenticated, service_role;

create or replace function set_workforce_team_member(p_team_id uuid, p_de_id uuid, p_fallback_rank integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_team workforce_teams;
  v_de_name text;
  v_holder text;
  v_actor text;
begin
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then
    raise exception 'only workspace owners/admins can manage workforce teams';
  end if;

  select * into v_team from workforce_teams where id = p_team_id and tenant_id = v_tenant;
  if v_team.id is null then raise exception 'team not found in this workspace'; end if;

  select name into v_de_name from digital_employees
  where id = p_de_id and tenant_id = v_tenant and lifecycle_status not in ('retired', 'archived');
  if v_de_name is null then raise exception 'employee not found in this workspace (or retired)'; end if;

  select full_name into v_actor from profiles where user_id = auth.uid();

  if p_fallback_rank is null then
    delete from workforce_team_members where team_id = p_team_id and de_id = p_de_id;
    perform append_audit_event_internal(
      v_tenant, coalesce(v_actor, 'A workspace admin'), 'human',
      format('%s removed from workforce team "%s"', v_de_name, v_team.name),
      'config_change',
      jsonb_build_object('kind', 'workforce_team_member_removed', 'team_id', p_team_id, 'de_id', p_de_id)
    );
    return jsonb_build_object('ok', true, 'removed', true);
  end if;

  if p_fallback_rank < 1 then raise exception 'fallback rank must be 1 or higher (1 = primary responder)'; end if;

  -- Explicit rank-conflict message beats a raw unique-violation error.
  select de.name into v_holder
  from workforce_team_members m join digital_employees de on de.id = m.de_id
  where m.team_id = p_team_id and m.fallback_rank = p_fallback_rank and m.de_id <> p_de_id;
  if v_holder is not null then
    raise exception 'rank % is already held by % — move them first or pick another rank', p_fallback_rank, v_holder;
  end if;

  insert into workforce_team_members (tenant_id, team_id, de_id, fallback_rank)
  values (v_tenant, p_team_id, p_de_id, p_fallback_rank)
  on conflict (team_id, de_id) do update set fallback_rank = excluded.fallback_rank;

  perform append_audit_event_internal(
    v_tenant, coalesce(v_actor, 'A workspace admin'), 'human',
    format('%s set as %s on workforce team "%s"', v_de_name,
      case when p_fallback_rank = 1 then 'primary responder' else format('backup #%s', p_fallback_rank - 1) end,
      v_team.name),
    'config_change',
    jsonb_build_object('kind', 'workforce_team_member_set', 'team_id', p_team_id, 'de_id', p_de_id, 'fallback_rank', p_fallback_rank)
  );
  return jsonb_build_object('ok', true, 'fallback_rank', p_fallback_rank);
end;
$$;

revoke all on function set_workforce_team_member(uuid, uuid, integer) from public, anon;
grant execute on function set_workforce_team_member(uuid, uuid, integer) to authenticated, service_role;

create or replace function archive_workforce_team(p_team_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_team workforce_teams;
  v_actor text;
begin
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then
    raise exception 'only workspace owners/admins can manage workforce teams';
  end if;
  update workforce_teams set status = 'archived', updated_at = now()
  where id = p_team_id and tenant_id = v_tenant
  returning * into v_team;
  if v_team.id is null then raise exception 'team not found in this workspace'; end if;

  select full_name into v_actor from profiles where user_id = auth.uid();
  perform append_audit_event_internal(
    v_tenant, coalesce(v_actor, 'A workspace admin'), 'human',
    format('Workforce team "%s" archived — its fallback chain no longer applies', v_team.name),
    'config_change',
    jsonb_build_object('kind', 'workforce_team_archived', 'team_id', p_team_id)
  );
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function archive_workforce_team(uuid) from public, anon;
grant execute on function archive_workforce_team(uuid) to authenticated, service_role;

-- ────────────────────────────────────────────────────────────────
-- THE ENFORCEMENT — poll_de_work_sources_targets gains the team
-- fallback rule. Byte-identical to migration 126's version plus ONE
-- new suppression clause: a DE stays off a work source when a
-- lower-rank teammate (same active team) is eligible AND itself holds
-- a qualifying grant on that source. Composes with the existing
-- lifecycle gate and the specialist rule for the full chain:
-- primary DE → backup DE → specialist → nothing.
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
    -- LIFECYCLE GATE (migration 126): a DE polls only in an
    -- operational stage.
    and (g.subject_kind <> 'de'
         or (de.lifecycle_status in ('assigned', 'active', 'improving') and de.status = 'active'))
    -- TEAM FALLBACK CHAIN (migration 128): within an active team, the
    -- lowest-rank eligible member with a grant on this source owns it.
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
          and exists (
            select 1 from data_access_grants pg
            where pg.tenant_id = c.tenant_id and pg.subject_kind = 'de' and pg.subject_id = pde.id
              and ((pg.resource_kind = 'connector' and pg.resource_id = c.id)
                   or (pg.resource_kind = 'category' and pg.resource_category = c.category))
              and access_permission_level(pg.permission) >= access_permission_level('search')
          )
      )
    )
    -- The DE owns the inbox: a specialist polls only when no ELIGIBLE
    -- DE is on this connector (migrations 121 + 126).
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
