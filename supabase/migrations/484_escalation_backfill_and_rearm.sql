-- 484_escalation_backfill_and_rearm.sql
-- ============================================================================
-- WAVE 1: unfreeze what is already stuck. Data only — no new machinery.
-- (The stall sweep that WRITES the board flag is migration 485; this one is
-- split out deliberately so each unit applies inside one round-trip.)
--
-- Two repairs, both consequences of defects fixed in 482/483:
--
--   1. 33 escalations carry related_table/related_id NULL, because de-work has
--      inserted them that way since the beginning (de-work/index.ts:538). A
--      decision on any of them cannot find the work it blocks — which is
--      exactly why rejecting four of them on 2026-07-22 changed nothing.
--      Each is matched to its de_exceptions sibling by (de_id, tenant, created
--      within 5s) and linked ONLY where the match is unambiguous. Ambiguous
--      ones are left alone and counted: a wrong link would resume the wrong
--      work, which is worse than leaving it stuck.
--
--   2. 6 objectives were disarmed permanently by an earlier 'blocked' verdict
--      (the old conclude_objective_wake set next_wake_at = NULL). Migration 482
--      stopped NEW blocks from being terminal; these predate it and would
--      otherwise never be reassessed. Re-armed with a stagger so they do not
--      all land on the same tick.
-- ============================================================================

-- ── 1. link orphaned escalations to the work they block ─────────────────────
with m as (
  select t.id as task_id, (array_agg(e.id))[1] as exc_id
    from human_tasks t
    join de_exceptions e
      on e.de_id = t.de_id
     and e.tenant_id = t.tenant_id
     and e.human_task_id is null
     and e.work_item_id is not null
     and abs(extract(epoch from (e.created_at - t.created_at))) <= 5
   where t.type = 'escalation' and t.source = 'de' and t.related_id is null
   group by t.id
  having count(*) = 1          -- unambiguous only
)
update human_tasks t
   set related_table = 'de_work_items',
       related_id = e.work_item_id
  from m join de_exceptions e on e.id = m.exc_id
 where t.id = m.task_id;

-- ── 1b. and the back-link, so the two surfaces cannot disagree ──────────────
update de_exceptions e
   set human_task_id = t.id
  from human_tasks t
 where t.type = 'escalation'
   and t.source = 'de'
   and t.related_table = 'de_work_items'
   and t.related_id = e.work_item_id
   and e.de_id = t.de_id
   and e.tenant_id = t.tenant_id
   and e.human_task_id is null
   and abs(extract(epoch from (e.created_at - t.created_at))) <= 5;

-- ── 2. re-arm objectives the old code disarmed forever ──────────────────────
update de_objectives
   set next_wake_at = now() + (random() * interval '30 minutes'),
       updated_at = now()
 where status = 'blocked'
   and next_wake_at is null;

-- ── PROOF ────────────────────────────────────────────────────────────────────
do $a$
declare
  v_orphans int;
  v_disarmed int;
  v_linked int;
  v_mislinked int;
begin
  -- The re-arm is absolute: no blocked objective may remain unwakeable.
  select count(*) into v_disarmed from de_objectives where status = 'blocked' and next_wake_at is null;
  if v_disarmed > 0 then
    raise exception '484: % blocked objectives are still disarmed — they can never be reassessed', v_disarmed;
  end if;

  -- The backfill must have moved something. It was 33 before this ran; if it
  -- is still 33 the join matched nothing and this migration is a no-op.
  select count(*) into v_orphans from human_tasks
   where type = 'escalation' and source = 'de' and related_id is null;
  select count(*) into v_linked from human_tasks
   where type = 'escalation' and source = 'de' and related_table = 'de_work_items' and related_id is not null;
  if v_linked = 0 then
    raise exception '484: not one escalation was linked — the backfill is a no-op';
  end if;

  -- Every link must point at a work item that actually exists, in the same
  -- tenant. A dangling or cross-tenant related_id would resume the wrong work.
  select count(*) into v_mislinked
    from human_tasks t
    left join de_work_items w on w.id = t.related_id and w.tenant_id = t.tenant_id
   where t.related_table = 'de_work_items' and t.related_id is not null and w.id is null;
  if v_mislinked > 0 then
    raise exception '484: % escalations point at a missing or cross-tenant work item', v_mislinked;
  end if;

  raise notice '484: % escalations now linked, % left unlinked (ambiguous), 0 blocked objectives disarmed',
    v_linked, v_orphans;
end $a$;
