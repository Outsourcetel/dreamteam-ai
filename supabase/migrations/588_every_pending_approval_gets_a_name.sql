-- 588 — give the structure people, give the rules teeth, and name the 318.
--
-- 587 built the org tree and the router. This one populates it, writes the
-- routing rules, and assigns the backlog that has been sitting anonymous.
--
-- ── The fix 587 needed and did not have ─────────────────────────────────────
-- 587 walked DOWN when a unit had no members: a department with empty rosters
-- but staffed teams beneath it still resolves. It did not walk UP, and that is
-- the case that actually matters. A tenant that creates "Finance" before hiring
-- into it would have every AR approval fail to route and drop back into the
-- anonymous queue — silently, because the router returns a reason nobody reads.
--
-- Walking up makes an empty unit SAFE. That is what lets a tenant draw their
-- real org chart incrementally: a branch with nobody in it yet escalates to its
-- parent instead of swallowing work. It also means the seed below can lay down
-- a realistic department skeleton for every tenant without stranding anything.
--
-- ── What the seed is, and what it is honestly not ───────────────────────────
-- It is NOT a guess at anyone's org chart. The existing `departments` table was
-- no help: its 8 rows all belong to one tenant that has no human profiles at
-- all, and `profiles.department` is free text matching nothing. Inventing who
-- reports where from that would be fabrication.
--
-- So the seed asserts only what is true: every tenant has a head office, and
-- the people who exist work there. Departments and teams are created empty, and
-- work reaches a real person through the upward fallback until someone fills
-- them in. Nobody is placed anywhere the data does not support.

begin;

-- ── Resolver: add the upward walk ───────────────────────────────────────────
-- Same signature, so this replaces rather than overloads. (An added parameter
-- with a default would create a SECOND function and PostgREST would refuse to
-- choose between them.)

create or replace function assign_human_task(p_task_id uuid, p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task      human_tasks%rowtype;
  v_rule      work_assignment_rules%rowtype;
  v_unit      org_units%rowtype;
  v_pool      org_units%rowtype;   -- the unit the rotation actually draws from
  v_cands     uuid[];
  v_pick      uuid;
  v_cursor    integer;
  v_scope     text;
  v_up_id     uuid;
begin
  select * into v_task from human_tasks where id = p_task_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'task_not_found');
  end if;
  if v_task.assigned_user_id is not null and not p_force then
    return jsonb_build_object('ok', true, 'reason', 'already_assigned',
                              'user_id', v_task.assigned_user_id);
  end if;

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
    return jsonb_build_object('ok', false, 'reason', 'target_unit_inactive', 'rule', v_rule.name);
  end if;
  v_pool := v_unit;

  -- 1. The unit's own people.
  select array_agg(m.user_id order by m.user_id) into v_cands
  from org_unit_members m
  where m.org_unit_id = v_unit.id and m.is_active
    and (v_rule.strategy = 'round_robin' or m.role_in_unit = 'lead');
  v_scope := 'unit';

  -- 2. Asked for a lead, found none — take anyone in the unit.
  if v_cands is null and v_rule.strategy = 'lead_then_round_robin' then
    select array_agg(m.user_id order by m.user_id) into v_cands
    from org_unit_members m where m.org_unit_id = v_unit.id and m.is_active;
    v_scope := 'unit_any';
  end if;

  -- 3. Nobody at this level — look at the teams beneath it.
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

  -- 4. Still nobody — walk UP to the NEAREST staffed ancestor. Nearest, not
  --    "anyone above", so a team's work escalates to its own department before
  --    it reaches head office.
  if v_cands is null then
    with recursive up as (
      select id, parent_id, 0 as lvl from org_units where id = v_unit.id
      union all
      select u.id, u.parent_id, up.lvl + 1 from org_units u join up on u.id = up.parent_id
      where u.is_active
    )
    select up.id into v_up_id
    from up
    where up.lvl > 0
      and exists (select 1 from org_unit_members m where m.org_unit_id = up.id and m.is_active)
    order by up.lvl asc
    limit 1;

    if v_up_id is not null then
      select * into v_pool from org_units where id = v_up_id;
      select array_agg(m.user_id order by m.user_id) into v_cands
      from org_unit_members m where m.org_unit_id = v_up_id and m.is_active;
      v_scope := 'ancestor';
    end if;
  end if;

  if v_cands is null or array_length(v_cands, 1) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'unit_has_no_members',
                              'rule', v_rule.name, 'unit', v_unit.name);
  end if;

  update org_units set rr_cursor = rr_cursor + 1
   where id = v_pool.id
  returning rr_cursor into v_cursor;

  v_pick := v_cands[ (v_cursor % array_length(v_cands, 1)) + 1 ];

  update human_tasks
     set assigned_user_id = v_pick,
         assigned_role    = v_unit.name,
         assigned_at      = now(),
         assigned_via     = jsonb_build_object(
           'rule_id',   v_rule.id,      'rule',      v_rule.name,
           'unit_id',   v_unit.id,      'unit',      v_unit.name,
           'unit_kind', v_unit.kind,    'strategy',  v_rule.strategy,
           'scope',     v_scope,        'pool_unit', v_pool.name,
           'pool_size', array_length(v_cands, 1)
         )
   where id = p_task_id;

  return jsonb_build_object('ok', true, 'user_id', v_pick, 'unit', v_unit.name,
                            'scope', v_scope, 'rule', v_rule.name,
                            'pool_size', array_length(v_cands, 1));
end;
$$;

grant execute on function assign_human_task(uuid, boolean) to authenticated, service_role;

-- ── Seed the structure, for every tenant that has people ────────────────────

do $seed$
declare
  t          record;
  v_ho       uuid;
  v_dept     uuid;
  v_ar       uuid;
  v_placed   int;
begin
  for t in
    select p.tenant_id, count(*) as humans
    from profiles p
    -- Joined to tenants, not merely non-null: a profile can carry a tenant_id
    -- that no longer exists, and the foreign key would abort the whole seed.
    join tenants tn on tn.id = p.tenant_id
    where p.is_active and p.user_id is not null
    group by p.tenant_id
  loop
    insert into org_units (tenant_id, kind, name, code)
    values (t.tenant_id, 'location', 'Head Office', 'HO')
    on conflict do nothing;
    select id into v_ho from org_units
     where tenant_id = t.tenant_id and parent_id is null and kind = 'location' and name = 'Head Office';

    -- Everyone who exists works here. This is the one placement the data
    -- actually supports, and it is what makes every unit below reachable.
    insert into org_unit_members (tenant_id, org_unit_id, user_id, role_in_unit)
    select t.tenant_id, v_ho, p.user_id,
           case when p.role in ('tenant_owner') then 'lead' else 'member' end
    from profiles p
    where p.tenant_id = t.tenant_id and p.is_active and p.user_id is not null
    on conflict (org_unit_id, user_id) do nothing;

    -- A department skeleton matching the work the platform actually raises.
    -- Deliberately EMPTY: work reaches Head Office through the upward walk
    -- until a human is placed here, and no one is assigned a department they
    -- were never recorded as belonging to.
    insert into org_units (tenant_id, parent_id, kind, name)
    select t.tenant_id, v_ho, 'department', d
    from unnest(array['Finance', 'Customer Support', 'Operations']) d
    on conflict do nothing;

    select id into v_dept from org_units
     where tenant_id = t.tenant_id and parent_id = v_ho and kind = 'department' and name = 'Finance';

    insert into org_units (tenant_id, parent_id, kind, name)
    values (t.tenant_id, v_dept, 'team', 'Accounts Receivable')
    on conflict do nothing;
    select id into v_ar from org_units
     where tenant_id = t.tenant_id and parent_id = v_dept and kind = 'team' and name = 'Accounts Receivable';

    -- ── Rules ───────────────────────────────────────────────────────────────
    -- Catch-all last (specificity, then priority — see the resolver).
    insert into work_assignment_rules (tenant_id, name, priority, target_unit_id, strategy)
    select t.tenant_id, 'Unrouted work → Head Office', 900, v_ho, 'round_robin'
    where not exists (select 1 from work_assignment_rules w
                       where w.tenant_id = t.tenant_id and w.name = 'Unrouted work → Head Office');

    -- Collections and AR. `escalation` on `renewal_invoices` is the shape the
    -- dunning path actually raises — read off live rows, not assumed.
    insert into work_assignment_rules (tenant_id, name, priority, match_related_table, target_unit_id, strategy)
    select t.tenant_id, 'Invoice & collections → Accounts Receivable', 100, 'renewal_invoices', v_ar, 'lead_then_round_robin'
    where not exists (select 1 from work_assignment_rules w
                       where w.tenant_id = t.tenant_id and w.name = 'Invoice & collections → Accounts Receivable');

    insert into work_assignment_rules (tenant_id, name, priority, match_related_table, target_unit_id, strategy)
    select t.tenant_id, 'Customer conversations → Customer Support', 100, 'de_conversations',
           (select id from org_units where tenant_id = t.tenant_id and parent_id = v_ho
              and kind = 'department' and name = 'Customer Support'),
           'lead_then_round_robin'
    where not exists (select 1 from work_assignment_rules w
                       where w.tenant_id = t.tenant_id and w.name = 'Customer conversations → Customer Support');
  end loop;

  select count(*) into v_placed from org_unit_members;
  raise notice 'seed: % people placed across % units', v_placed, (select count(*) from org_units);
end;
$seed$;

-- ── Name the backlog ────────────────────────────────────────────────────────
-- Oldest first, so the rotation reflects the order work actually arrived.

do $backfill$
declare
  r      record;
  v_res  jsonb;
  v_ok   int := 0;
  v_no   int := 0;
begin
  for r in
    select id from human_tasks
    where status = 'pending' and assigned_user_id is null
    order by created_at asc
  loop
    v_res := assign_human_task(r.id);
    if coalesce((v_res->>'ok')::boolean, false) then v_ok := v_ok + 1; else v_no := v_no + 1; end if;
  end loop;
  raise notice 'backfill: % assigned, % unroutable', v_ok, v_no;
end;
$backfill$;

commit;
