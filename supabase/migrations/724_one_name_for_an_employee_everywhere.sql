-- 724_one_name_for_an_employee_everywhere.sql
-- ==========================================================================
-- An employee has ONE name. `list_org_tree_core` was the last place that
-- disagreed.
--
-- ── The defect, measured before writing a line (prod, 2026-08-12) ─────────
--   select count(*)                                                   -> 127
--        , count(persona_name)                                        ->  75
--        , count(*) filter (where persona_name = '')                  ->   0
--        , count(*) filter (where persona_name is not null
--                             and persona_name <> ''
--                             and persona_name <> name)               ->  72
--     from digital_employees;
--
-- 72 of 127 employees answer to a name that is not their role name. Every
-- surface that reads them through a DB function — get_workforce_board,
-- list_consultable_for_de, list_de_health, get_identity_inventory,
-- request_de_task, handoff_back_to_de — already resolves the display name as
-- coalesce(persona_name, name). This function alone returned `d.name` raw.
--
-- So the org chart called an employee by its role name while every other
-- screen called it by its name, for 72 of 127 employees. Not a rendering
-- quirk: two screens, two answers to "who is this", and no way for the reader
-- to know they were looking at one employee.
--
-- ── Why the nullif, when the siblings do not have one ─────────────────────
-- The rule being adopted is "persona_name when non-null AND non-empty, else
-- name", because that is what the TypeScript callers have always done —
-- `persona_name || name` in ~30 places, where JS `||` already treats '' as
-- absent. Plain coalesce() does not: it would return '' and render a nameless
-- row. That is not hypothetical in this table. Its sibling column proves it:
--
--   count(*) filter (where display_title is not null and display_title <> '')
--                                                                    ->   8
--   count(*) filter (where display_title = '')                       -> 119
--
-- 119 rows store the empty string where a reader would expect NULL. persona_name
-- happens to have none today; the column next to it has 119. The guard costs
-- nothing and makes SQL and TypeScript resolve the same name from the same row,
-- which is the entire point of the change. The siblings are left alone — this
-- migration fixes the outlier it names, and widening it to six more functions
-- that are already correct is not what was asked.
--
-- ── What this deliberately does NOT do ────────────────────────────────────
--   * `title` STAYS `display_title`. It is a JOB TITLE (migration 130), not a
--     name — a SUBTITLE under the name, never a substitute for it. Only 8 rows
--     have a non-empty one; the callers already fall back correctly.
--   * `order by d.name` IS UNCHANGED. The sort key stays the role name so this
--     migration changes exactly one expression and the chart's row order is
--     identical before and after. Sorting by the displayed name is a real
--     improvement and a separate, visible decision — it is named here rather
--     than smuggled in under a rename.
--   * THE WRAPPER IS NOT TOUCHED. `list_org_tree` does
--     `perform assert_own_tenant(p_tenant_id)` and delegates; that gate is the
--     reason the tenant-id parameter is safe on a SECURITY DEFINER function.
--     Editing the wrapper is how that check gets dropped by accident.
--
-- ── Grants ────────────────────────────────────────────────────────────────
-- CREATE OR REPLACE preserves an existing function's ACL, and this one is
-- correct today: postgres + service_role only, with no `authenticated` grant —
-- the core is reachable only through the wrapper that checks the tenant. The
-- REVOKE below re-asserts that rather than trusting it, because a default
-- PUBLIC EXECUTE is one accidental DROP-then-CREATE away and this function
-- reads every unit in a tenant.
-- ==========================================================================

begin;

create or replace function public.list_org_tree_core(p_tenant_id uuid)
returns jsonb
language sql
stable security definer
set search_path to 'public'
as $function$
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
      'de_count', (select count(*) from digital_employees d
                    where d.org_unit_id = t.id and coalesce(d.lifecycle_status, '') not in ('retired', 'archived')),
      'open_tasks', (select count(*) from human_tasks h
                      where h.tenant_id = p_tenant_id and h.status = 'pending'
                        and h.assigned_via->>'unit_id' = t.id::text),
      'members', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'user_id', m.user_id, 'name', p.full_name, 'role_in_unit', m.role_in_unit,
                 'job_title', p.job_title, 'is_primary', m.is_primary) order by p.full_name), '[]'::jsonb)
        from org_unit_members m left join profiles p on p.user_id = m.user_id
        where m.org_unit_id = t.id and m.is_active
      ),
      -- The same department, staffed by whoever does the work. Kept as its own
      -- list rather than merged into `members`: they belong to the same unit,
      -- but only people appear in the approval rota, and a single blended list
      -- would make that distinction invisible at exactly the wrong moment.
      'digital_employees', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 -- One employee, one name. The name it answers to, falling back
                 -- to the internal role name — the same rule every other
                 -- name-returning function applies. `title` below is the JOB
                 -- TITLE and stays a subtitle.
                 'de_id', d.id, 'name', coalesce(nullif(d.persona_name, ''), d.name),
                 'title', d.display_title,
                 'trust_level', d.trust_level, 'status', d.status) order by d.name), '[]'::jsonb)
        from digital_employees d
        where d.org_unit_id = t.id and coalesce(d.lifecycle_status, '') not in ('retired', 'archived')
      )
    ) as x
    from t
  ) s;
$function$;

-- Re-assert the perimeter (see header). The core is internal: only the
-- tenant-checking wrapper may reach it.
revoke execute on function public.list_org_tree_core(uuid) from public, anon, authenticated;
grant execute on function public.list_org_tree_core(uuid) to service_role;

commit;
