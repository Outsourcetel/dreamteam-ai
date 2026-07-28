-- 485_stall_sweep.sql
-- ============================================================================
-- WAVE 1, ITEM 4 (the intervention): the runtime gets an opinion about time.
--
-- Founder decision N6, TIGHTER budgets:
--   * work waiting on a human for 24h  -> automatic re-escalation
--   * 12 wakes with no progress        -> ops alarm + a flag on the board
--
-- docs/38 measured the cost of having neither: 475 wakes across four
-- objectives in six days, zero alarms, zero reassessments, sixteen dependent
-- steps frozen behind four unanswered questions, and a notice deadline due to
-- pass in silence.
--
-- A DEDICATED pg_cron job, not an extension of dispatch_de_work_internal:
-- that dispatcher only considers objectives whose next_wake_at is due, and a
-- work item parked under a blocked objective is never woken at all — so the
-- wake pass structurally cannot see the cases that matter most.
--
-- ON THE ALARM: raise_ops_alert() dedupes on KIND ALONE, globally, for one
-- hour. A single stuck objective anywhere on the platform would suppress every
-- other tenant's alarm for the next 60 minutes — the appearance of an alarm
-- rather than an alarm. This writes ops_alerts directly with a PER-SUBJECT
-- dedupe instead.
--
-- ON VISIBILITY: ops_alerts is platform-admin only (list_ops_alerts raises
-- 'platform admin only'), so it cannot serve N6's tenant-facing board flag.
-- The flag is de_objectives.attention_flag (added in 482) plus a tenant-scoped
-- audit_events row. Shipping the alarm alone would not satisfy N6.
-- ============================================================================

create or replace function public.de_stall_sweep_internal(
  p_stall_hours integer default 24,
  p_wake_budget integer default 12
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_waited int := 0;
  v_spin int := 0;
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

  return jsonb_build_object('ok', true, 'waited_too_long', v_waited, 'wake_spin', v_spin);
end;
$function$;

revoke all on function public.de_stall_sweep_internal(integer, integer) from public, anon, authenticated;

select cron.unschedule('de-stall-sweep-15min')
 where exists (select 1 from cron.job where jobname = 'de-stall-sweep-15min');

select cron.schedule('de-stall-sweep-15min', '*/15 * * * *',
  $cron$select public.de_stall_sweep_internal(24, 12);$cron$);

notify pgrst, 'reload schema';

do $a$
declare n int;
begin
  if to_regprocedure('public.de_stall_sweep_internal(integer,integer)') is null then
    raise exception '485: the sweep was not created';
  end if;
  select count(*) into n from cron.job where jobname = 'de-stall-sweep-15min' and active;
  if n <> 1 then raise exception '485: the sweep is not scheduled (% active jobs)', n; end if;
  -- The dormancy guard must be present, or the sweep works suspended tenants.
  if pg_get_functiondef('public.de_stall_sweep_internal(integer,integer)'::regprocedure)
       not ilike '%tenant_is_operational%' then
    raise exception '485: the sweep would run against suspended tenants (mig 430)';
  end if;
  raise notice '485: stall sweep created and scheduled every 15 minutes';
end $a$;
