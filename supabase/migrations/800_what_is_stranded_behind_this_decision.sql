-- 800_what_is_stranded_behind_this_decision.sql
-- ==========================================================================
-- WHY THE EMPLOYEES LOOK IDLE.
--
-- Measured before writing a line of this:
--
--   253 work items created in 30 days      -- intake is NOT the problem
--   126 queued, ZERO ever attempted
--   126 of 126 pass every claim filter except one: depends_on
--    41 of those wait on an item in `waiting_human`
--    85 wait on one of those
--
-- Every chain has the same shape:
--
--   seq 1  Open the ledger books                 waiting_human   <- root
--   seq 2  Reconcile what is there               queued
--   seq 3  Prepare the reconciliation note       queued
--   seq 4  Raise anything that does not balance  queued
--
-- claim_de_work_items will not claim a successor until its predecessor is
-- 'done'. So one unanswered question at seq 1 freezes the whole chain, the
-- employee has nothing claimable, and it reads as "my digital employees do
-- nothing" when what is actually true is "my digital employees are waiting
-- for me".
--
-- 49 of 413 pending decisions gate a work chain. The other 364 do not. Nothing
-- in the product said which was which.
--
-- ── WHAT WAS ALREADY THERE, AND WHY IT WAS NOT ENOUGH ─────────────────────
-- getBlockedWorkForTask (customerApi) already counts what is stranded — but
-- `.eq('depends_on', row.id)`, which is ONE LEVEL. Chains here run to depth 7,
-- so a decision reporting "1 queued behind" was really holding five steps. And
-- it is computed for the one task already clicked, which is too late to help
-- anyone choose WHICH task to click.
--
-- This is the transitive count, for the whole queue at once, so the 413 can be
-- ordered by how much work each one releases.
-- ==========================================================================

begin;

-- ── the transitive chain behind one decision ──────────────────────────────

create or replace function public.decision_unblock_impact(p_task_ids uuid[] default null)
returns table (
  task_id        uuid,
  work_item_id   uuid,
  direct_blocked integer,
  total_blocked  integer,
  deepest_chain  integer
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $fn$
  with recursive roots as (
    select t.id as task_id, t.related_id as work_item_id
      from human_tasks t
     where t.tenant_id = auth_tenant_id()
       and t.status = 'pending'
       and t.related_table = 'de_work_items'
       and t.related_id is not null
       and (p_task_ids is null or t.id = any(p_task_ids))
       and (t.de_id is null or public.can_access_de(t.de_id))
  ),
  chain as (
    -- depth 1: the items whose predecessor IS the stranded item
    select r.task_id, w.id, 1 as depth
      from roots r
      join de_work_items w on w.depends_on = r.work_item_id
     where w.status in ('queued', 'waiting_human')
    union all
    -- ...and everything behind those, transitively
    select c.task_id, w.id, c.depth + 1
      from chain c
      join de_work_items w on w.depends_on = c.id
     where w.status in ('queued', 'waiting_human')
       -- ⚠ A CYCLE GUARD, NOT A DISPLAY LIMIT. depends_on has no constraint
       -- preventing A->B->A, and a recursive CTE that meets one does not
       -- return a wrong answer, it never returns. The deepest real chain
       -- measured on this data is 7.
       and c.depth < 50
  )
  select
    r.task_id,
    r.work_item_id,
    coalesce(count(*) filter (where c.depth = 1), 0)::int as direct_blocked,
    coalesce(count(c.id), 0)::int                         as total_blocked,
    coalesce(max(c.depth), 0)::int                        as deepest_chain
  from roots r
  left join chain c on c.task_id = r.task_id
  group by r.task_id, r.work_item_id;
$fn$;

revoke all on function public.decision_unblock_impact(uuid[]) from public;
revoke all on function public.decision_unblock_impact(uuid[]) from anon;
grant execute on function public.decision_unblock_impact(uuid[]) to authenticated;

-- ── the grouped queue, now ordered by what it RELEASES ─────────────────────
-- Replaces mig 795's version. Same shape plus two columns, so the client's
-- existing fields keep working; ordering changes from "biggest pile" to "most
-- work released", because a group of 3 that frees 14 steps beats a group of 57
-- that frees nothing.

-- Two columns are being ADDED, and `create or replace` cannot change a TABLE
-- return type. Inside this transaction the drop and the create are one step,
-- so there is no window where a caller finds the function missing.
drop function if exists public.list_decision_groups();

create or replace function public.list_decision_groups()
returns table (
  task_type      text,
  de_id          uuid,
  de_name        text,
  pending        bigint,
  oldest_at      timestamptz,
  oldest_days    integer,
  overdue        bigint,
  unpriced       bigint,
  gates_work     bigint,
  strands        bigint,
  sample_title   text,
  task_ids       uuid[]
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $fn$
  with impact as (select * from public.decision_unblock_impact(null))
  select
    t.type                                              as task_type,
    t.de_id,
    d.name                                              as de_name,
    count(*)                                            as pending,
    min(t.created_at)                                   as oldest_at,
    extract(day from (now() - min(t.created_at)))::int  as oldest_days,
    count(*) filter (where t.sla_due_at is not null and t.sla_due_at < now()) as overdue,
    count(*) filter (where (select amount_cents from task_approval_facts(t.id)) is null) as unpriced,
    -- how many of these decisions hold a work chain at all
    count(*) filter (where i.task_id is not null)       as gates_work,
    -- and how many steps they release between them
    coalesce(sum(i.total_blocked), 0)                   as strands,
    (array_agg(t.title order by t.created_at))[1]       as sample_title,
    array_agg(t.id order by t.created_at)               as task_ids
  from human_tasks t
  left join digital_employees d on d.id = t.de_id
  left join impact i on i.task_id = t.id
  where t.tenant_id = auth_tenant_id()
    and t.status = 'pending'
    and (t.de_id is null or public.can_access_de(t.de_id))
  group by t.type, t.de_id, d.name
  -- WHAT THIS RELEASES, then how long it has waited. The old ordering was
  -- count descending, which put the 57 that free nothing above the 3 that
  -- restart an employee.
  order by coalesce(sum(i.total_blocked), 0) desc, min(t.created_at);
$fn$;

revoke all on function public.list_decision_groups() from public;
revoke all on function public.list_decision_groups() from anon;
grant execute on function public.list_decision_groups() to authenticated;

-- ── proof ─────────────────────────────────────────────────────────────────
do $verify$
declare
  v_u uuid; v_t uuid; v_direct int; v_total int; v_deep int; v_rows int; v_gates bigint;
begin
  -- Act as a real admin in a workspace that actually has stranded work, or the
  -- assertions below measure an empty set and prove nothing.
  select p.user_id, t.tenant_id into v_u, v_t
    from human_tasks t
    join profiles p on p.tenant_id = t.tenant_id and coalesce(p.is_active, true)
                   and p.role in ('tenant_owner','tenant_admin')
   where t.status = 'pending' and t.related_table = 'de_work_items' and t.related_id is not null
     and exists (select 1 from de_work_items w
                  where w.depends_on = t.related_id and w.status in ('queued','waiting_human'))
   limit 1;

  if v_u is null then
    raise exception 'VERIFY FAILED: no pending decision strands any work, so nothing below would be measured';
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_u, 'role', 'authenticated')::text, true);

  -- (a) it returns a row per gating decision, and they are not all zero
  select count(*), max(total_blocked), max(deepest_chain)
    into v_rows, v_total, v_deep
    from public.decision_unblock_impact(null);
  if v_rows = 0 then
    raise exception 'VERIFY FAILED: impact returned no rows for a workspace that has stranded work';
  end if;
  if coalesce(v_total, 0) = 0 then
    raise exception 'VERIFY FAILED: every decision reports 0 stranded — the join found nothing';
  end if;

  -- (b) ⛔ THE POINT OF THIS MIGRATION. The transitive count must EXCEED the
  --     direct one somewhere, or this is the one-level count that already
  --     existed wearing a new name.
  select max(total_blocked - direct_blocked) into v_direct
    from public.decision_unblock_impact(null);
  if coalesce(v_direct, 0) <= 0 then
    raise exception 'VERIFY FAILED: total never exceeds direct — the recursion is not recursing (deepest chain seen: %)', v_deep;
  end if;
  if coalesce(v_deep, 0) < 2 then
    raise exception 'VERIFY FAILED: deepest chain is %, so nothing multi-step was traversed', v_deep;
  end if;

  -- (c) the grouped queue carries it through
  select coalesce(sum(strands), 0), coalesce(sum(gates_work), 0)
    into v_total, v_gates from public.list_decision_groups();
  if v_total = 0 or v_gates = 0 then
    raise exception 'VERIFY FAILED: groups report % stranded across % gating decisions', v_total, v_gates;
  end if;
end
$verify$;

commit;
