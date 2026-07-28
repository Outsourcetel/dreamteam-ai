-- 523_escalations_that_answer_themselves.sql
-- ============================================================================
-- Triage of this tenant's 182 pending human tasks. Measured, not assumed — and
-- my first assumption was wrong, which is why the numbers below are counts and
-- not adjectives.
--
--   125  chat answers awaiting approval   (25 distinct questions, dock channel)
--    40  goal-level blockers              (18 goals)
--     8  action approvals                 (raised today, real)
--     2  item-level blockers
--     7  checklist / knowledge / trust    (individual)
--
-- I ASSUMED THE 120 CHAT ESCALATIONS WERE DUPLICATES. They are not. Each has a
-- distinct detail hash, a distinct confidence score, sometimes a different
-- employee, and its own de_conversations row: 25 questions asked ~5 times each
-- by real (internal, dock-channel) conversations. Collapsing them would have
-- destroyed 120 genuine draft answers. They are left entirely alone here — what
-- to do with them is a reply-mode decision, not a cleanup.
--
-- This migration fixes the two things that are unambiguously broken.
--
-- ── 1. AN ESCALATION MUST NOT OUTLIVE THE WORK IT IS ABOUT ─────────────────
-- Six pending escalations point at goals that are already ACHIEVED (2) or
-- ABANDONED (4). They ask a human to unblock work that finished or was dropped
-- days ago. Nothing has ever closed an escalation when its goal ended, so this
-- leaks forever and every one of them is noise a person has to read past.
-- Fixed at the source with a trigger, so it cannot drift again, plus a backfill
-- for what has already accumulated.
--
-- ── 2. THE RETRY SWEEP CANNOT SEE MOST BLOCKED WORK ────────────────────────
-- retry_answerable_blockers (mig 513) walks human_tasks -> de_work_items and
-- only matches related_table = 'de_work_items'. But of 168 pending escalations
-- only TWO are filed that way — 40 are filed against the OBJECTIVE. So seven
-- work items sitting in waiting_human, none of them ever retried, are invisible
-- to the sweep that exists to retry them. They have been stuck since 22 July,
-- several asking for a desk that has existed since migration 505.
--
-- The driver now finds a blocked item whether its escalation was filed against
-- the item or against the goal. Everything that made the original safe is kept:
-- once only (payload stamp), disposition 'retried' and never 'answered', an
-- explicit note that no human ruled, and the mig-487 sanctioned-write config.
-- A goal that is no longer live is skipped — part 1 closes those instead.
-- ============================================================================

-- ── 1. close escalations whose subject is over ──────────────────────────────
CREATE OR REPLACE FUNCTION public.close_escalations_for_finished_goal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
BEGIN
  IF NEW.status IN ('achieved', 'abandoned') AND NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM set_config('app.allow_task_decision', 'on', true);  -- mig 487 sanctioned path
    UPDATE human_tasks
       SET status = 'rejected',
           disposition = 'cancelled',
           decision_note = format(
             'Closed automatically: the goal this asked about is %s. Nobody needs to rule on it now, and no human ruling was made.',
             NEW.status),
           decided_at = now(),
           updated_at = now()
     WHERE related_table = 'de_objectives'
       AND related_id = NEW.id
       AND status = 'pending';
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_close_escalations_for_finished_goal ON public.de_objectives;
CREATE TRIGGER trg_close_escalations_for_finished_goal
  AFTER UPDATE OF status ON public.de_objectives
  FOR EACH ROW EXECUTE FUNCTION public.close_escalations_for_finished_goal();

-- Backfill what leaked before the trigger existed.
DO $b$
DECLARE n int;
BEGIN
  PERFORM set_config('app.allow_task_decision', 'on', true);
  UPDATE human_tasks h
     SET status = 'rejected', disposition = 'cancelled',
         decision_note = format(
           'Closed automatically: the goal this asked about is %s. Nobody needs to rule on it now, and no human ruling was made.',
           o.status),
         decided_at = now(), updated_at = now()
    FROM de_objectives o
   WHERE h.related_table = 'de_objectives' AND o.id = h.related_id
     AND h.status = 'pending' AND o.status IN ('achieved', 'abandoned');
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '523: closed % escalation(s) whose goal had already finished or been dropped', n;
END $b$;

-- ── 2. the retry sweep reaches work blocked under a goal-level escalation ───
CREATE OR REPLACE FUNCTION public.retry_answerable_blockers(p_tenant_id uuid, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_retried int := 0;
  v_skipped int := 0;
  r record;
begin
  if auth.role() is not null and auth.role() <> 'service_role' then
    if auth.uid() is null then raise exception 'not_authenticated'; end if;
    if not auth_has_tenant_role(array['tenant_owner','tenant_admin','tenant_manager']) then
      raise exception 'insufficient_role';
    end if;
  end if;

  -- mig 487: this is a sanctioned path for touching decision columns.
  perform set_config('app.allow_task_decision', 'on', true);

  for r in
    -- Drive from the BLOCKED ITEM, not from how somebody happened to file the
    -- escalation. mig 513 drove from human_tasks.related_table='de_work_items'
    -- and therefore could not see the seven items whose escalation was filed
    -- against the goal instead.
    select w.id as item_id, w.payload, w.objective_id
      from de_work_items w
      left join de_objectives o on o.id = w.objective_id
     where w.tenant_id = p_tenant_id
       and w.status = 'waiting_human'
       and tenant_is_operational(w.tenant_id)
       -- Still worth doing: a finished or dropped goal is closed by the
       -- trigger above, not retried here.
       and (o.id is null or o.status not in ('achieved', 'abandoned'))
       -- Somebody is actually waiting on this, filed either way.
       and exists (
         select 1 from human_tasks h
          where h.status = 'pending' and h.type = 'escalation'
            and ((h.related_table = 'de_work_items' and h.related_id = w.id)
              or (h.related_table = 'de_objectives'  and h.related_id = w.objective_id)))
     order by w.created_at
     limit greatest(1, p_limit)
  loop
    -- Once only. A step that fails a fair retry is a genuine human decision.
    if r.payload ? 'retried_at' then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    update de_work_items set
      status = 'queued', scheduled_for = now(), attempts = 0, last_error = null,
      locked_at = null, locked_by = null, updated_at = now(),
      payload = payload || jsonb_build_object(
        'retried_at', now(),
        'retry_reason', 'This step was blocked before the employee had the tools it was asking for. Try again with what you have now; if it still cannot be done, say precisely what is missing today.')
    where id = r.item_id;

    -- Resolve whichever escalation was raised for it — item-level or goal-level.
    update human_tasks set
      status = 'rejected',
      disposition = 'retried',
      decision_note = 'Retried automatically: this was raised before the employee had the capability it asked for. No human ruling was made.',
      decided_at = now(), updated_at = now()
    where status = 'pending' and type = 'escalation'
      and ((related_table = 'de_work_items' and related_id = r.item_id)
        or (related_table = 'de_objectives'  and related_id = r.objective_id));

    -- A goal parked on that step gets its chance again too, or the item runs
    -- and the goal stays blocked forever regardless.
    update de_objectives set status = 'in_progress', updated_at = now()
     where id = r.objective_id and status = 'blocked';

    update de_exceptions set
      status = 'auto_resolved',
      outcome = 'Retried under current capabilities — no human ruling.',
      decided_at = now()
    where human_task_id in (
      select id from human_tasks
       where (related_table = 'de_work_items' and related_id = r.item_id)
          or (related_table = 'de_objectives'  and related_id = r.objective_id))
      and status = 'proposed';

    v_retried := v_retried + 1;
  end loop;

  return jsonb_build_object('ok', true, 'retried', v_retried, 'already_retried_left_alone', v_skipped);
end;
$function$;

notify pgrst, 'reload schema';

DO $a$
DECLARE
  v_tenant uuid; v_res jsonb; n_obsolete int; n_stuck_before int; n_stuck_after int; n_still_pending int;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'outsourcetel-hq';

  -- Part 1 must have left nothing pending against a finished goal.
  SELECT count(*) INTO n_obsolete
    FROM human_tasks h JOIN de_objectives o ON o.id = h.related_id
   WHERE h.related_table = 'de_objectives' AND h.status = 'pending'
     AND o.status IN ('achieved', 'abandoned');
  IF n_obsolete > 0 THEN
    RAISE EXCEPTION '523: % escalation(s) still pending against a finished goal', n_obsolete;
  END IF;

  -- Part 2: the sweep must now actually reach the goal-filed blockers.
  SELECT count(*) INTO n_stuck_before FROM de_work_items
   WHERE tenant_id = v_tenant AND status = 'waiting_human' AND NOT (payload ? 'retried_at');

  v_res := retry_answerable_blockers(v_tenant, 100);

  SELECT count(*) INTO n_stuck_after FROM de_work_items
   WHERE tenant_id = v_tenant AND status = 'waiting_human' AND NOT (payload ? 'retried_at');

  -- Would this pass if the change were a no-op? No: before this migration the
  -- driver matched only two item-filed tasks, both already stamped, so it
  -- retried exactly zero.
  IF (v_res->>'retried')::int = 0 THEN
    RAISE EXCEPTION '523: the sweep still retried nothing — it cannot see goal-filed blockers';
  END IF;
  IF n_stuck_after >= n_stuck_before THEN
    RAISE EXCEPTION '523: % un-retried blocked item(s) before, % after — nothing moved',
      n_stuck_before, n_stuck_after;
  END IF;

  SELECT count(*) INTO n_still_pending FROM human_tasks
   WHERE tenant_id = v_tenant AND status = 'pending';

  RAISE NOTICE '523: retried % blocked step(s) (% left un-retried, was %); % human task(s) still pending',
    (v_res->>'retried')::int, n_stuck_after, n_stuck_before, n_still_pending;
END $a$;
