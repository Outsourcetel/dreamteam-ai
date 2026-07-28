-- 488_guard_message_accuracy.sql
-- ============================================================================
-- The guard's own error message named resolve_de_escalation — a function that
-- no longer exists under that signature (renamed to decide_de_escalation in
-- 486). An error that tells you to call something that isn't there sends the
-- next person down a dead end at exactly the moment they are blocked.
--
-- Message only. The predicate is unchanged and re-asserted below.
-- ============================================================================

create or replace function public.guard_human_task_decision()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_sanctioned boolean := coalesce(current_setting('app.allow_task_decision', true), '') = 'on';
begin
  if tg_op = 'DELETE' then
    if old.status = 'pending' and not v_sanctioned then
      raise exception 'human_tasks: an undecided approval cannot be deleted (task %). Decide it first — cancelling with a reason is a decision.', old.id
        using errcode = 'raise_exception';
    end if;
    return old;
  end if;

  if (new.status is distinct from old.status
      or new.decided_by is distinct from old.decided_by
      or new.decided_at is distinct from old.decided_at)
     and not v_sanctioned then
    raise exception 'human_tasks: decisions must go through decide_human_task, decide_de_escalation or decide_de_exception (task %). A direct write to status/decided_by/decided_at is not recorded, cannot be audited, and does not resume the blocked work.', old.id
      using errcode = 'raise_exception';
  end if;

  return new;
end;
$function$;

do $a$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.guard_human_task_decision()'::regprocedure);
  if v_def ilike '%resolve_de_escalation%' then
    raise exception '488: the message still points at the removed function';
  end if;
  if v_def not ilike '%decide_de_escalation%' then
    raise exception '488: the corrected name did not land';
  end if;
  -- The predicate must be intact: both gates still present.
  if v_def not ilike '%an undecided approval cannot be deleted%'
     or v_def not ilike '%decided_by is distinct from old.decided_by%' then
    raise exception '488: the guard predicate was weakened by the message fix';
  end if;
  raise notice '488: guard message corrected, predicate unchanged';
end $a$;
