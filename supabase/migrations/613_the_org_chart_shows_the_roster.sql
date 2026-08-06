-- 613 — the org chart shows the roster, not the switchboard.
--
-- Found immediately after 612 moved 17 employees from active to idle: the org
-- tree lists and counts only `status = 'active'`, so an employee that is placed
-- in a department but not currently switched on is INVISIBLE there.
--
-- This was already wrong before 612 — 40 idle employees hold an org_unit_id and
-- none of them appeared — but 612 would have made it worse by 17 and I would
-- have caused it. Measured, not assumed:
--
--   status=idle,   placed in a department: 40
--   status=active, placed in a department: 37
--
-- An org chart answers "who belongs to this department". Whether an employee is
-- switched on right now is a different question, and the tree already carries
-- `status` on every employee it returns, so the UI can show it as a state — it
-- does not need to be the filter.
--
-- Retired and archived stay excluded: they have left, which is not the same as
-- being idle.
--
-- ⚠ The body being edited is list_org_tree_CORE. Migration 610 split this
-- function in two — a thin `list_org_tree` that checks the caller owns the
-- workspace, wrapping the original body renamed to `_core`. Editing the wrapper
-- would silently do nothing.

begin;

do $splice$
declare
  v_def   text;
  v_new   text;
  v_count int;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f' and p.proname = 'list_org_tree_core';

  if v_def is null then
    raise exception 'list_org_tree_core is missing — did migration 610 apply?';
  end if;

  -- Two sites: the count, and the list. Both must move, or the badge disagrees
  -- with the rows underneath it.
  v_count := (length(v_def) - length(replace(v_def, 'and d.status = ''active''', ''))) / length('and d.status = ''active''');
  if v_count <> 2 then
    raise exception 'expected exactly 2 active-only filters in the tree, found % — refusing to splice', v_count;
  end if;

  v_new := replace(v_def,
    'and d.status = ''active''',
    'and coalesce(d.lifecycle_status, '''') not in (''retired'', ''archived'')');

  if v_new = v_def then raise exception 'the splice was a silent no-op'; end if;
  execute v_new;
end;
$splice$;

-- ── Prove the tree now holds the people it says it holds ─────────────────
do $verify$
declare
  v_tid   uuid := (select id from tenants where slug = 'outsourcetel-hq');
  v_tree  jsonb;
  v_in_tree int;
  v_placed  int;
begin
  if v_tid is null then raise notice 'no workspace to verify against'; return; end if;

  v_tree := list_org_tree_core(v_tid);

  -- Every employee placed in one of this workspace's units must now appear.
  select count(*) into v_placed
  from digital_employees d
  join org_units u on u.id = d.org_unit_id
  where u.tenant_id = v_tid
    and coalesce(d.lifecycle_status, '') not in ('retired', 'archived');

  select coalesce(sum(jsonb_array_length(x->'digital_employees')), 0) into v_in_tree
  from jsonb_array_elements(v_tree) x;

  if v_in_tree <> v_placed then
    raise exception 'org chart shows % employees but % are placed in it', v_in_tree, v_placed;
  end if;

  -- ...and the count badge must agree with the rows under it.
  if exists (
    select 1 from jsonb_array_elements(v_tree) x
    where (x->>'de_count')::int <> jsonb_array_length(x->'digital_employees')
  ) then
    raise exception 'a unit''s employee count disagrees with its own employee list';
  end if;

  raise notice 'org chart now shows all % placed employees, counts agree with rows', v_in_tree;
end;
$verify$;

commit;
