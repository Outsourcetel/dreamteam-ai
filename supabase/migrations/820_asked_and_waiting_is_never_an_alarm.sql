-- 820_asked_and_waiting_is_never_an_alarm.sql
-- ==========================================================================
-- WHY: Workstream E close-out (doc 54-ops-readiness, defects B-11/C-8).
-- B-11's crash (fixed ~08-18) left a residue the fix did not touch: 45 goals
-- on the founder's live tenant flagged 'wake_spin', 81 open ops_alerts, 35
-- raised in the last 48h — and a census proved ALL of them are one shape:
-- every live step waits on a human who HAS an open pending ask (48 of 48
-- waiting_human steps asked; queued steps chain behind them via depends_on).
--
-- Migration 526 wrote the law for exactly this: "asked-and-waiting →
-- reported, NEVER alarmed; a hollow alert trains the operator to scroll
-- past the channel." The wake-spin flagger predates the law and never
-- learned it. Two surgical changes, both in de_stall_sweep_internal
-- (GENERATED from live, the mig-377 rule):
--
--   (b) the flagger gains the guard: flag only when the machine owes motion
--       (running, or queued-with-dependency-met) or a human is waited on
--       with NO open ask. Unasked waiting keeps alarming — that is a real
--       defect, and the guard must be able to fail.
--   (c) a healing block clears the flag on goals already in the
--       asked-and-waiting state; resolve_cleared_ops_alerts (whose wake_spin
--       arm keys on the flag) then retires their alerts on the next
--       heartbeat. The existing control loop does the closing — no third
--       path is added.
--
-- This must land BEFORE C-8 (alerts → push): wiring the phone to a channel
-- carrying 35 hollow alarms per 48h would train the founder to ignore it.
-- ==========================================================================

begin;

CREATE OR REPLACE FUNCTION public.de_stall_sweep_internal(p_stall_hours integer DEFAULT 24, p_wake_budget integer DEFAULT 12)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_waited int := 0;
  v_spin int := 0;
  v_healed int := 0;
  r record;
begin
  -- (a) WAITING TOO LONG. Raising to 'urgent' is itself the idempotency
  --     guard — a second sweep finds nothing left to raise.
  for r in
    select t.id as task_id, t.tenant_id, t.de_id, t.title, t.related_id,
           w.objective_id, t.sla_due_at
      from human_tasks t
      join de_work_items w on w.id = t.related_id
     where t.type = 'escalation'
       and t.status = 'pending'
       and t.related_table = 'de_work_items'
       and coalesce(t.priority, 'normal') <> 'urgent'
       and t.created_at < now() - make_interval(hours => greatest(1, p_stall_hours))
       and w.status = 'waiting_human'
       and tenant_is_operational(t.tenant_id)
     limit 200
  loop
    update human_tasks set priority = 'urgent', updated_at = now() where id = r.task_id;

    update de_objectives
       set attention_flag = 'waiting_too_long',
           attention_since = coalesce(attention_since, now()),
           updated_at = now()
     where id = r.objective_id and attention_flag is distinct from 'waiting_too_long';

    perform append_audit_event_internal(
      r.tenant_id, 'Workspace', 'system',
      format('Escalation unanswered for over %sh — raised to urgent: %s',
             p_stall_hours, left(coalesce(r.title, ''), 120)),
      'escalated',
      jsonb_build_object('task_id', r.task_id, 'de_id', r.de_id,
        'work_item_id', r.related_id, 'objective_id', r.objective_id,
        'sla_due_at', r.sla_due_at, 'stall_hours', p_stall_hours));

    v_waited := v_waited + 1;
  end loop;

  -- (b) WAKE SPIN: the loop runs, nothing moves. The staleness form works on
  --     objectives that predate the 482 wake store (Lakeshore has 121 wakes
  --     and work items untouched since 2026-07-22); once the store fills, an
  --     identical progress_fingerprint across consecutive wakes says the same
  --     thing more precisely.
  for r in
    select o.id, o.tenant_id, o.de_id, o.title, o.wake_count
      from de_objectives o
     where o.status in ('open','in_progress','blocked')
       and o.wake_count >= greatest(2, p_wake_budget)
       and o.attention_flag is distinct from 'wake_spin'
       and tenant_is_operational(o.tenant_id)
       and exists (select 1 from de_work_items w
                    where w.objective_id = o.id
                      and w.status in ('queued','running','waiting_human'))
       -- mig 820, the mig-526 law applied here: ASKED-AND-WAITING IS NEVER AN
       -- ALARM. Flag only when the MACHINE owes motion (something running, or
       -- queued with its dependency met) or when a human is waited on WITHOUT
       -- an open ask (unasked waiting is a real defect and must keep firing).
       -- A goal whose every live step chains behind a pending human task is
       -- the approval queue's business — 45 of the founder's own undecided
       -- goals were re-alarmed daily for 16 days by exactly this gap.
       and (
         exists (select 1 from de_work_items w2
                  where w2.objective_id = o.id
                    and (w2.status = 'running'
                         or (w2.status = 'queued'
                             and (w2.depends_on is null
                                  or exists (select 1 from de_work_items pp
                                              where pp.id = w2.depends_on
                                                and pp.status = 'done')))))
         or exists (select 1 from de_work_items w3
                     where w3.objective_id = o.id
                       and w3.status = 'waiting_human'
                       and not exists (select 1 from human_tasks ht
                             where ht.status = 'pending'
                               and (ht.related_id = w3.id or ht.related_id = o.id
                                    or ht.resolved_work_item_id = w3.id)))
       )
       and coalesce((select max(w.updated_at) from de_work_items w where w.objective_id = o.id),
                    o.created_at) < now() - make_interval(hours => greatest(1, p_stall_hours))
     limit 200
  loop
    update de_objectives
       set attention_flag = 'wake_spin',
           attention_since = coalesce(attention_since, now()),
           updated_at = now()
     where id = r.id;

    insert into ops_alerts (kind, message, detail)
    select 'de_objective_wake_spin',
           format('%s wakes with no progress: %s', r.wake_count, left(coalesce(r.title, ''), 160)),
           jsonb_build_object('objective_id', r.id, 'tenant_id', r.tenant_id,
             'de_id', r.de_id, 'wake_count', r.wake_count, 'wake_budget', p_wake_budget)
     where not exists (
       select 1 from ops_alerts a
        where a.kind = 'de_objective_wake_spin'
          and a.resolved_at is null
          and a.detail->>'objective_id' = r.id::text);

    perform append_audit_event_internal(
      r.tenant_id, 'Workspace', 'system',
      format('Goal woke %s times with no progress: %s', r.wake_count, left(coalesce(r.title, ''), 120)),
      'escalated',
      jsonb_build_object('objective_id', r.id, 'de_id', r.de_id,
        'wake_count', r.wake_count, 'wake_budget', p_wake_budget));

    v_spin := v_spin + 1;
  end loop;

  -- (c) THE CONTROL LOOP CLOSES (mig 820): a goal that spun into the flag
  --     and has since reached asked-and-waiting stops being flagged here, and
  --     resolve_cleared_ops_alerts retires its open alerts on the next
  --     heartbeat (its wake_spin arm keys on the flag being cleared). One
  --     writer, one healer, no third path.
  update de_objectives o
     set attention_flag = null, attention_since = null, updated_at = now()
   where o.attention_flag = 'wake_spin'
     and o.status in ('open','in_progress','blocked')
     and not exists (select 1 from de_work_items w2
                      where w2.objective_id = o.id
                        and (w2.status = 'running'
                             or (w2.status = 'queued'
                                 and (w2.depends_on is null
                                      or exists (select 1 from de_work_items pp
                                                  where pp.id = w2.depends_on
                                                    and pp.status = 'done')))))
     and not exists (select 1 from de_work_items w3
                      where w3.objective_id = o.id
                        and w3.status = 'waiting_human'
                        and not exists (select 1 from human_tasks ht
                              where ht.status = 'pending'
                                and (ht.related_id = w3.id or ht.related_id = o.id
                                     or ht.resolved_work_item_id = w3.id)));
  get diagnostics v_healed = row_count;

  return jsonb_build_object('ok', true, 'waited_too_long', v_waited, 'wake_spin', v_spin,
                            'asked_and_waiting_healed', v_healed);
end;
$function$
;

do $$
declare v jsonb;
begin
  -- The function must carry both edits (each CAN fail).
  v := to_jsonb(pg_get_functiondef('public.de_stall_sweep_internal(int,int)'::regprocedure));
  if position('asked-and-waiting' in v #>> '{}') = 0 then
    raise exception 'de_stall_sweep_internal lost the asked-and-waiting guard';
  end if;
  if position('asked_and_waiting_healed' in v #>> '{}') = 0 then
    raise exception 'de_stall_sweep_internal lost the healing block';
  end if;
end $$;

commit;
