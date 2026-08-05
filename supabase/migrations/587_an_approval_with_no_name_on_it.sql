-- 587 — an approval with no name on it is nobody's job.
--
-- 349 approvals have been raised. 318 are still pending. Every one of them has
-- an `assigned_user_id` column and every one of them is NULL — the columns were
-- added, indexed, rendered in the UI, and never written to by anything. Work
-- lands in a shared queue, and a shared queue is a place where each individual
-- item is, correctly, not any particular person's problem.
--
-- Two things were missing, and only one of them was obvious.
--
-- The obvious one: nothing ever assigned. There is no router.
--
-- The non-obvious one: there was nothing to route TO. It looked like there was.
-- `departments` holds 8 rows and `workforce_teams` holds 2, so the org structure
-- appeared half-built. It is not:
--
--   · `workforce_team_members` links team_id -> DE_ID. Those are teams of
--     DIGITAL employees, used for consultation fallback. No human is in one.
--   · `profiles.department` is free text. Of 21 profiles carrying a value, ZERO
--     resolve to a real `departments` row.
--
-- So there was no structure that groups humans, at any level. This migration
-- builds one, and the shape is the founder's: org -> location/branch ->
-- department -> team, with people placed into units and work routed by rules.
--
-- ── On round-robin ──────────────────────────────────────────────────────────
-- Round-robin was chosen as the fallback. Taken literally it re-creates the
-- problem it solves: rotating an item to whoever is next means nobody OWNS it,
-- which is precisely why 318 items have aged untouched. So the rotation picks a
-- person, but what gets written is a NAMED OWNER, with the time it landed and
-- the rule that put it there. Rotation decides who; it does not dilute that it
-- is now theirs. `assigned_at` makes ageing per-person measurable, which is the
-- thing an anonymous queue can never show you.
--
-- Nothing here decides an approval or moves work. It only answers "whose is
-- this?" — and it fails loudly rather than guessing.

begin;

-- ── The tree ────────────────────────────────────────────────────────────────
-- One self-referencing table rather than four rigid ones. Four tables force the
-- depth into the schema, and the first customer who has departments spanning
-- two branches, or a team reporting to a location directly, needs a migration.
-- The legal shapes are enforced by trigger instead, where they can be relaxed.

create table if not exists org_units (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  parent_id   uuid references org_units(id) on delete cascade,
  kind        text not null check (kind in ('location', 'branch', 'department', 'team')),
  name        text not null,
  code        text,
  timezone    text,
  is_active   boolean not null default true,
  -- Rotation position, kept on the UNIT and not on the rule: two rules pointing
  -- at the same team must share one rotation, or each rule restarts at the same
  -- person and the first member absorbs everything.
  rr_cursor   integer not null default 0,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, parent_id, kind, name)
);

create index if not exists idx_org_units_tenant on org_units(tenant_id) where is_active;
create index if not exists idx_org_units_parent on org_units(parent_id);

-- The unique constraint above does not cover top-level units: parent_id is NULL
-- there, and in SQL two NULLs are not equal, so "Head Office" could be created
-- twice at the root and every rule pointing at "the" one would be a coin toss.
create unique index if not exists idx_org_units_root_unique
  on org_units(tenant_id, kind, name) where parent_id is null;

create or replace function org_units_check_parent()
returns trigger language plpgsql as $$
declare
  v_parent_kind text;
  v_parent_tenant uuid;
begin
  if new.parent_id is null then
    -- A team must live in a department. Everything else may sit at the top:
    -- a single-site business should not be forced to invent a location.
    if new.kind = 'team' then
      raise exception 'org_units: a team must belong to a department (unit "%")', new.name;
    end if;
    return new;
  end if;

  select kind, tenant_id into v_parent_kind, v_parent_tenant from org_units where id = new.parent_id;
  if not found then
    raise exception 'org_units: parent % does not exist', new.parent_id;
  end if;
  if v_parent_tenant <> new.tenant_id then
    raise exception 'org_units: a unit cannot report into another tenant''s unit';
  end if;
  if new.parent_id = new.id then
    raise exception 'org_units: a unit cannot report to itself';
  end if;

  if not (
       (new.kind = 'location'   and v_parent_kind = 'location')                      -- regions
    or (new.kind = 'branch'     and v_parent_kind in ('location', 'branch'))
    or (new.kind = 'department' and v_parent_kind in ('location', 'branch'))
    or (new.kind = 'team'       and v_parent_kind in ('department', 'team'))         -- sub-teams
  ) then
    raise exception 'org_units: a % cannot report to a % (unit "%")', new.kind, v_parent_kind, new.name;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_org_units_check_parent on org_units;
create trigger trg_org_units_check_parent before insert or update on org_units
  for each row execute function org_units_check_parent();

drop trigger if exists org_units_updated_at on org_units;
create trigger org_units_updated_at before update on org_units
  for each row execute function update_updated_at();

-- ── The people in it ────────────────────────────────────────────────────────
-- References profiles.user_id, which is what human_tasks.assigned_user_id holds.

create table if not exists org_unit_members (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  org_unit_id  uuid not null references org_units(id) on delete cascade,
  user_id      uuid not null,
  role_in_unit text not null default 'member' check (role_in_unit in ('member', 'lead')),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (org_unit_id, user_id)
);

create index if not exists idx_org_unit_members_unit on org_unit_members(org_unit_id) where is_active;
create index if not exists idx_org_unit_members_user on org_unit_members(user_id);

-- ── The routing rules ───────────────────────────────────────────────────────

create table if not exists work_assignment_rules (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  name                 text not null,
  -- Lower runs first, but only among rules of EQUAL specificity: a catch-all
  -- with priority 1 must never beat a rule written for this exact task type.
  priority             integer not null default 100,
  match_type           text,   -- human_tasks.type
  match_source         text,   -- human_tasks.source
  match_related_table  text,   -- human_tasks.related_table
  match_de_id          uuid,   -- raised by a specific digital employee
  target_unit_id       uuid not null references org_units(id) on delete cascade,
  strategy             text not null default 'round_robin'
                       check (strategy in ('round_robin', 'lead', 'lead_then_round_robin')),
  is_active            boolean not null default true,
  created_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists idx_war_tenant on work_assignment_rules(tenant_id) where is_active;

drop trigger if exists work_assignment_rules_updated_at on work_assignment_rules;
create trigger work_assignment_rules_updated_at before update on work_assignment_rules
  for each row execute function update_updated_at();

-- ── What the task now carries ───────────────────────────────────────────────
-- assigned_user_id and assigned_role already existed. These two say WHEN it
-- became someone's and WHY, so that a queue that is not draining can be read as
-- "person X has 40 items older than a week" rather than "the queue is big".

alter table human_tasks add column if not exists assigned_at  timestamptz;
alter table human_tasks add column if not exists assigned_via jsonb;

create index if not exists idx_human_tasks_assignee
  on human_tasks(tenant_id, assigned_user_id, status) where status = 'pending';

-- ── The router ──────────────────────────────────────────────────────────────

create or replace function assign_human_task(p_task_id uuid, p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task    human_tasks%rowtype;
  v_rule    work_assignment_rules%rowtype;
  v_unit    org_units%rowtype;
  v_cands   uuid[];
  v_pick    uuid;
  v_cursor  integer;
  v_scope   text;
begin
  select * into v_task from human_tasks where id = p_task_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'task_not_found');
  end if;
  if v_task.assigned_user_id is not null and not p_force then
    return jsonb_build_object('ok', true, 'reason', 'already_assigned',
                              'user_id', v_task.assigned_user_id);
  end if;

  -- Most SPECIFIC match wins, and only then the priority the tenant set. A rule
  -- naming this task's type beats a catch-all no matter how the numbers read;
  -- otherwise one low-numbered fallback silently swallows every specific rule
  -- anyone writes later.
  select * into v_rule
  from work_assignment_rules r
  where r.tenant_id = v_task.tenant_id
    and r.is_active
    and (r.match_type          is null or r.match_type          = v_task.type)
    and (r.match_source        is null or r.match_source        = v_task.source)
    and (r.match_related_table is null or r.match_related_table = v_task.related_table)
    and (r.match_de_id         is null or r.match_de_id         = v_task.de_id)
  order by
    ( (r.match_type is not null)::int + (r.match_source is not null)::int
    + (r.match_related_table is not null)::int + (r.match_de_id is not null)::int ) desc,
    r.priority asc, r.created_at asc
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_matching_rule');
  end if;

  select * into v_unit from org_units where id = v_rule.target_unit_id and is_active;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'target_unit_inactive',
                              'rule', v_rule.name);
  end if;

  -- Candidates: the unit's own people first. If a department has no direct
  -- members but its teams do, fall through to the teams beneath it rather than
  -- reporting "nobody" — an org chart is not usually populated at every level.
  select array_agg(m.user_id order by m.user_id)
    into v_cands
  from org_unit_members m
  where m.org_unit_id = v_unit.id
    and m.is_active
    and (v_rule.strategy = 'round_robin' or m.role_in_unit = 'lead');
  v_scope := 'unit';

  if v_cands is null and v_rule.strategy = 'lead_then_round_robin' then
    select array_agg(m.user_id order by m.user_id) into v_cands
    from org_unit_members m
    where m.org_unit_id = v_unit.id and m.is_active;
    v_scope := 'unit_any';
  end if;

  if v_cands is null then
    with recursive sub as (
      select id from org_units where id = v_unit.id
      union all
      select u.id from org_units u join sub s on u.parent_id = s.id where u.is_active
    )
    select array_agg(distinct m.user_id order by m.user_id) into v_cands
    from org_unit_members m
    where m.org_unit_id in (select id from sub) and m.is_active;
    v_scope := 'descendants';
  end if;

  if v_cands is null or array_length(v_cands, 1) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'unit_has_no_members',
                              'rule', v_rule.name, 'unit', v_unit.name);
  end if;

  -- Rotate. The cursor advances on the unit so concurrent assignments to the
  -- same team do not both land on the same person.
  update org_units set rr_cursor = rr_cursor + 1
   where id = v_unit.id
  returning rr_cursor into v_cursor;

  v_pick := v_cands[ (v_cursor % array_length(v_cands, 1)) + 1 ];

  update human_tasks
     set assigned_user_id = v_pick,
         assigned_role    = v_unit.name,
         assigned_at      = now(),
         assigned_via     = jsonb_build_object(
           'rule_id',   v_rule.id,
           'rule',      v_rule.name,
           'unit_id',   v_unit.id,
           'unit',      v_unit.name,
           'unit_kind', v_unit.kind,
           'strategy',  v_rule.strategy,
           'scope',     v_scope,
           'pool_size', array_length(v_cands, 1)
         )
   where id = p_task_id;

  return jsonb_build_object('ok', true, 'user_id', v_pick, 'unit', v_unit.name,
                            'rule', v_rule.name, 'pool_size', array_length(v_cands, 1));
end;
$$;

grant execute on function assign_human_task(uuid, boolean) to authenticated, service_role;

-- Fire on creation. AFTER INSERT so the row exists to be read and updated; the
-- decision guard only watches status/decided_by/decided_at, so writing
-- assignment columns here does not trip it.
create or replace function trg_assign_human_task()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform assign_human_task(new.id);
  return null;
exception when others then
  -- Routing must never be able to stop an approval from being raised. A task
  -- nobody owns is a problem; a task that was never created is a worse one.
  return null;
end;
$$;

drop trigger if exists trg_human_tasks_assign on human_tasks;
create trigger trg_human_tasks_assign after insert on human_tasks
  for each row execute function trg_assign_human_task();

-- ── Reading the structure ───────────────────────────────────────────────────

create or replace function list_org_tree(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(x order by x->>'path'), '[]'::jsonb)
  from (
    with recursive t as (
      select u.id, u.parent_id, u.kind, u.name, u.is_active, 0 as depth, u.name as path
      from org_units u where u.tenant_id = p_tenant_id and u.parent_id is null
      union all
      select u.id, u.parent_id, u.kind, u.name, u.is_active, t.depth + 1, t.path || ' / ' || u.name
      from org_units u join t on u.parent_id = t.id where u.tenant_id = p_tenant_id
    )
    select jsonb_build_object(
      'id', t.id, 'parent_id', t.parent_id, 'kind', t.kind, 'name', t.name,
      'is_active', t.is_active, 'depth', t.depth, 'path', t.path,
      'member_count', (select count(*) from org_unit_members m where m.org_unit_id = t.id and m.is_active),
      -- Counted on the unit ID recorded at assignment time, never on the name.
      -- Matching by name would silently miscount the moment two units share one
      -- (a "Support" team under two branches) or a unit is renamed.
      'open_tasks', (select count(*) from human_tasks h
                      where h.tenant_id = p_tenant_id and h.status = 'pending'
                        and h.assigned_via->>'unit_id' = t.id::text),
      'members', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'user_id', m.user_id, 'name', p.full_name, 'role_in_unit', m.role_in_unit) order by p.full_name), '[]'::jsonb)
        from org_unit_members m left join profiles p on p.user_id = m.user_id
        where m.org_unit_id = t.id and m.is_active
      )
    ) as x
    from t
  ) s;
$$;

grant execute on function list_org_tree(uuid) to authenticated, service_role;

-- ── Isolation ───────────────────────────────────────────────────────────────

alter table org_units            enable row level security;
alter table org_unit_members     enable row level security;
alter table work_assignment_rules enable row level security;

drop policy if exists org_units_tenant_read on org_units;
create policy org_units_tenant_read on org_units for select
  using (tenant_id = auth_tenant_id());
drop policy if exists org_units_tenant_write on org_units;
create policy org_units_tenant_write on org_units for all
  using (tenant_id = auth_tenant_id()
         and auth_has_tenant_role(array['tenant_owner','tenant_admin','tenant_manager']));

drop policy if exists org_unit_members_tenant_read on org_unit_members;
create policy org_unit_members_tenant_read on org_unit_members for select
  using (tenant_id = auth_tenant_id());
drop policy if exists org_unit_members_tenant_write on org_unit_members;
create policy org_unit_members_tenant_write on org_unit_members for all
  using (tenant_id = auth_tenant_id()
         and auth_has_tenant_role(array['tenant_owner','tenant_admin','tenant_manager']));

drop policy if exists war_tenant_read on work_assignment_rules;
create policy war_tenant_read on work_assignment_rules for select
  using (tenant_id = auth_tenant_id());
drop policy if exists war_tenant_write on work_assignment_rules;
create policy war_tenant_write on work_assignment_rules for all
  using (tenant_id = auth_tenant_id()
         and auth_has_tenant_role(array['tenant_owner','tenant_admin']));

commit;
