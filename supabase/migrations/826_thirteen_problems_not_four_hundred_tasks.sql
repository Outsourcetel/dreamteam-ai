-- 826_thirteen_problems_not_four_hundred_tasks.sql
-- ==========================================================================
-- THE WORKFORCE IS BLOCKED BY THIRTEEN THINGS, NOT BY FOUR HUNDRED TASKS.
--
-- Measured on production before writing this:
--
--   objectives          47 blocked ·  10 achieved      (83% blocked)
--   work items         129 queued  ·  50 waiting_human · 87 done
--   median time to done  0.1 hours
--
-- Nothing here is slow. When work flows it finishes in six minutes. It is all
-- blockage — and the blockage resolves to 13 distinct causes:
--
--   overdue         34      blocked_input   31      inconsistent  17
--   out_of_range    11      missing_owner    6
--
-- Only 4 of those causes are the dead ERP connector. The rest are accounts
-- with no owner, invoices coming due, onboarding projects needing setup — real
-- and independent. A workspace that fixed ERPNext tomorrow would still have
-- most of this.
--
-- ── WHAT WAS MISSING ──────────────────────────────────────────────────────
-- Mig 795 groups the queue by TYPE and EMPLOYEE, and mig 800 says what each
-- decision releases. Both are useful and neither answers "what is actually
-- wrong with my workforce", because the natural unit is the CAUSE and one
-- cause spans employees. "ledger reconciliation sweep" is ONE problem holding
-- 24 escalations. Presented as 24 rows it reads as 24 problems.
--
-- ── TWO HONEST LIMITS, BUILT FOR RATHER THAN AROUND ───────────────────────
--
-- 1. 60 OF 110 PENDING ESCALATIONS HAVE NO blocker_scope. They cannot be
--    grouped by cause because nothing recorded one. They are NOT dropped —
--    they appear as a single row with scoped = false, counted and visible. A
--    view that silently lost more than half its input would be worse than no
--    view, and this repo has shipped that shape before.
--
-- 2. SOME SCOPES FRAGMENT. The same renewal invoice appears as three causes —
--    its 1-day, 7-day and 14-day horizons. That is scope granularity being too
--    fine, and it is REPORTED rather than cleverly merged: collapsing by string
--    similarity would be inventing a grouping the data does not assert, which
--    is how a view starts lying about how many problems there are.
--
-- The frozen-work count is transitive, reusing the chain walk from mig 800 —
-- claim_de_work_items will not touch a successor until its predecessor is
-- done, so a cause at the head of a chain freezes everything behind it.
-- ==========================================================================

begin;

create or replace function public.list_workforce_blockers()
returns table (
  cause              text,
  scoped             boolean,
  classes            text[],
  escalations        bigint,
  employees          bigint,
  employee_names     text[],
  objectives_blocked bigint,
  work_items_frozen  bigint,
  corroborated       boolean,
  oldest_at          timestamptz,
  oldest_days        integer,
  task_ids           uuid[]
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $fn$
  with recursive mine as (
    select t.*
      from human_tasks t
     where t.tenant_id = auth_tenant_id()
       and t.status = 'pending'
       and t.type = 'escalation'
       and (t.de_id is null or public.can_access_de(t.de_id))
  ),
  -- Everything frozen behind each escalation's work item, walked transitively.
  chain as (
    select m.id as task_id, w.id, 1 as depth
      from mine m
      join de_work_items w on w.depends_on = m.related_id
     where m.related_table = 'de_work_items' and m.related_id is not null
       and w.status in ('queued', 'waiting_human')
    union all
    select c.task_id, w.id, c.depth + 1
      from chain c
      join de_work_items w on w.depends_on = c.id
     where w.status in ('queued', 'waiting_human')
       -- Cycle guard, not a display limit: depends_on has no constraint
       -- preventing A->B->A, and a recursive CTE meeting one never returns.
       and c.depth < 50
  ),
  frozen as (
    select task_id, count(*) as n from chain group by task_id
  )
  select
    -- The null bucket is named, not hidden. Anyone reading this should see
    -- immediately that these are ungrouped, not a cause called "unscoped".
    coalesce(m.blocker_scope, format('(%s escalations with no recorded cause)',
             count(*) over (partition by (m.blocker_scope is null)))) as cause,
    (m.blocker_scope is not null)                        as scoped,
    (select array_agg(distinct s) from
       (select unnest(m2.blocker_signature) s from mine m2
         where m2.blocker_scope is not distinct from m.blocker_scope) u) as classes,
    count(*)                                             as escalations,
    count(distinct m.de_id)                              as employees,
    array_remove(array_agg(distinct d.name), null)       as employee_names,
    count(distinct o.id) filter (where o.status = 'blocked') as objectives_blocked,
    coalesce(sum(f.n), 0)                                as work_items_frozen,
    -- Can the platform confirm this cause on its own? Same test mig 819 uses
    -- to credit a corroborated refusal.
    bool_or('blocked_input' = any(m.blocker_signature)
            and exists (select 1 from connectors c
                         where c.tenant_id = m.tenant_id
                           and public.connector_circuit_open(c.consecutive_failures, c.last_error_at)))
                                                         as corroborated,
    min(m.created_at)                                    as oldest_at,
    extract(day from (now() - min(m.created_at)))::int   as oldest_days,
    array_agg(m.id order by m.created_at)                as task_ids
  from mine m
  left join digital_employees d on d.id = m.de_id
  left join frozen f            on f.task_id = m.id
  left join de_work_items w     on w.id = m.related_id and m.related_table = 'de_work_items'
  left join de_objectives o     on o.id = w.objective_id
  group by m.blocker_scope
  -- What it holds, then how long it has held it.
  order by coalesce(sum(f.n), 0) desc, count(*) desc, min(m.created_at);
$fn$;

revoke all on function public.list_workforce_blockers() from public;
revoke all on function public.list_workforce_blockers() from anon;
grant execute on function public.list_workforce_blockers() to authenticated;

-- ── proof ─────────────────────────────────────────────────────────────────
do $verify$
declare
  v_u uuid; v_t uuid;
  v_rows int; v_sum bigint; v_total bigint; v_distinct int;
begin
  select t.tenant_id, p.user_id into v_t, v_u
    from human_tasks t
    join profiles p on p.tenant_id = t.tenant_id and coalesce(p.is_active, true)
                   and p.role in ('tenant_owner','tenant_admin')
   where t.status = 'pending' and t.type = 'escalation'
   group by t.tenant_id, p.user_id
   order by count(*) desc
   limit 1;
  if v_u is null then
    raise exception 'VERIFY FAILED: no workspace with pending escalations — nothing below is measured';
  end if;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_u, 'role', 'authenticated')::text, true);

  select count(*), coalesce(sum(escalations), 0)
    into v_rows, v_sum from public.list_workforce_blockers();

  select count(*) into v_total
    from human_tasks t
   where t.tenant_id = v_t and t.status = 'pending' and t.type = 'escalation'
     and (t.de_id is null or public.can_access_de(t.de_id));

  -- (a) it says something
  if v_rows = 0 then
    raise exception 'VERIFY FAILED: % pending escalation(s) exist and the view returned no causes', v_total;
  end if;

  -- (b) ⛔ NOTHING IS LOST. Over half the escalations carry no scope; a view
  --     that grouped only the scoped ones would silently drop them and look
  --     tidier for it. Every escalation must appear in exactly one row.
  if v_sum <> v_total then
    raise exception 'VERIFY FAILED: % escalations in, % accounted for across % cause(s) — the view is dropping or double-counting', v_total, v_sum, v_rows;
  end if;

  -- (c) ...and it actually GROUPED. If every escalation became its own row,
  --     this is the task list with new column names.
  if v_rows >= v_total then
    raise exception 'VERIFY FAILED: % causes for % escalations — no grouping happened', v_rows, v_total;
  end if;

  -- (d) one row per cause, no fan-out from the four joins hanging off it
  select count(distinct cause) into v_distinct from public.list_workforce_blockers();
  if v_distinct <> v_rows then
    raise exception 'VERIFY FAILED: % rows for % distinct causes — a join fanned out', v_rows, v_distinct;
  end if;

  -- (e) the unscoped bucket is present and honest about itself
  if not exists (select 1 from public.list_workforce_blockers() where not scoped)
     and exists (select 1 from human_tasks t where t.tenant_id = v_t
                  and t.status='pending' and t.type='escalation' and t.blocker_scope is null) then
    raise exception 'VERIFY FAILED: escalations with no cause exist but no unscoped row was returned';
  end if;
end
$verify$;

commit;
