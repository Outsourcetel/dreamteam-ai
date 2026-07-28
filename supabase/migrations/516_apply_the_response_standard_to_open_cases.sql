-- 516_apply_the_response_standard_to_open_cases.sql
-- ============================================================================
-- Migration 515 gave state-condition watchers a declared response window and
-- taught them to stamp a deadline. But it only affects cases opened AFTER it —
-- and the occurrence dedupe means an already-open case is never re-minted. So
-- the tenant's 17 live health and at-risk cases kept no deadline at all, and
-- the urgency ordering from mig 514 still had only 3 goals to work with.
--
-- The standard now exists; it should apply to the work already in flight.
-- due_at is derived from the case's OWN opening time plus its OWN watcher's
-- declared window — never a flat date stamped across everything, so a case
-- opened three days ago is already closer to due than one opened this morning,
-- which is exactly right.
--
-- Only touches goals that are still open and have no deadline. A goal someone
-- gave a date to by hand is left alone.
-- ============================================================================

update public.de_objectives o
   set due_at = o.created_at + make_interval(days => (w.config->>'response_days')::int),
       updated_at = now()
  from public.work_watchers w
 where o.due_at is null
   and o.status in ('open', 'in_progress')
   and o.plan ? 'watcher_id'
   and w.id = (o.plan->>'watcher_id')::uuid
   and w.kind = 'state_condition'
   and (w.config->>'response_days') ~ '^[0-9]+$';

do $a$
declare n_open int; n_due int; n_overdue int;
begin
  select count(*), count(due_at) into n_open, n_due
    from de_objectives
   where tenant_id = (select id from tenants where slug = 'outsourcetel-hq')
     and status in ('open', 'in_progress');

  if n_due <= 3 then
    raise exception '516: still only % goals carry a deadline — the backfill matched nothing', n_due;
  end if;

  -- A case opened before its window elapsed is ALREADY overdue, and that is the
  -- honest reading: nobody responded inside the standard. It should surface as
  -- such rather than being quietly dated into the future.
  select count(*) into n_overdue from de_objectives
   where tenant_id = (select id from tenants where slug = 'outsourcetel-hq')
     and status in ('open', 'in_progress') and due_at < now();

  raise notice '516: % of % open goals now carry a deadline (% already past it)', n_due, n_open, n_overdue;
end $a$;
