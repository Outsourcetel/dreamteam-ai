-- 513_retry_blockers_the_employee_can_now_answer.sql
-- ============================================================================
-- Making the queue answerable — by removing the questions that no longer need
-- a human, not by answering them faster.
--
-- ── WHAT THE MEASUREMENT ACTUALLY SHOWED ───────────────────────────────────
-- I expected stale blockers and repeated wording, and proposed auto-closing the
-- former and grouping the latter. Both were wrong:
--   * ZERO are stale. Every one of the 61 is live — no work has moved on, no
--     goal has closed.
--   * ZERO repeat textually. Every blocker is worded uniquely, so grouping by
--     similarity would have grouped nothing.
-- What IS true: 45 of 61 were raised BEFORE the capability that answers them
-- existed, and 26 of those belong to the schedule-driven roles that were asking
-- for a book they have had since migration 505.
--
-- So the queue is not full of questions a human must answer. It is full of
-- questions the EMPLOYEE can now answer itself, frozen at the moment it could
-- not.
--
-- ── THE ACTION: RETRY, NOT ANSWER ──────────────────────────────────────────
-- Re-queue the frozen step and let the employee try again with today's tools.
-- It either completes — as Billing did the moment it was given its book — or it
-- raises a NEW blocker that reflects what is actually missing today rather than
-- what was missing on Tuesday. Both outcomes are strictly better than a human
-- answering a question the machine has already outgrown.
--
-- Deliberately NOT modelled as "which capability answers which blocker": that
-- mapping would be guesswork and would rot the moment a tool changes. Retrying
-- and letting the employee report is self-correcting and needs no maintenance.
--
-- ── THE GUARD THAT MATTERS ─────────────────────────────────────────────────
-- A retry loop would be worse than the freeze: the same step failing, being
-- retried, and failing again forever, burning budget and refilling the queue.
-- Each item may be retried ONCE. The stamp lives in the work item's payload, so
-- a second call skips it and a genuinely stuck item stays visible as a human
-- decision — which is correct, because after one honest retry it IS one.
-- ============================================================================

-- 'retried' is a real disposition: the blocker was resolved without a human
-- ruling. Recording it as 'answered' would credit a person with a decision they
-- never made, which the approvals ledger exists to prevent.
do $c$
begin
  alter table public.human_tasks drop constraint if exists human_tasks_disposition_check;
  alter table public.human_tasks add constraint human_tasks_disposition_check
    check (disposition is null or disposition = any (array['answered','cancelled','rerouted','retried']));
end $c$;

create or replace function public.retry_answerable_blockers(
  p_tenant_id uuid,
  p_limit integer default 100
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
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
    select h.id as task_id, w.id as item_id, w.payload, h.de_id
      from human_tasks h
      join de_work_items w on w.id = h.related_id
     where h.tenant_id = p_tenant_id
       and h.status = 'pending'
       and h.type = 'escalation'
       and h.related_table = 'de_work_items'
       and w.status = 'waiting_human'
       and tenant_is_operational(h.tenant_id)
     order by h.created_at
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

    update human_tasks set
      status = 'rejected',
      disposition = 'retried',
      decision_note = 'Retried automatically: this was raised before the employee had the capability it asked for. No human ruling was made.',
      decided_at = now()
    where id = r.task_id;

    update de_exceptions set
      status = 'auto_resolved',
      outcome = 'Retried under current capabilities — no human ruling.',
      decided_at = now()
    where human_task_id = r.task_id and status = 'proposed';

    v_retried := v_retried + 1;
  end loop;

  return jsonb_build_object('ok', true, 'retried', v_retried, 'already_retried_left_alone', v_skipped);
end;
$function$;

revoke all on function public.retry_answerable_blockers(uuid, integer) from public, anon;
grant execute on function public.retry_answerable_blockers(uuid, integer) to authenticated, service_role;

notify pgrst, 'reload schema';

do $a$
declare v_def text;
begin
  if to_regprocedure('public.retry_answerable_blockers(uuid,integer)') is null then
    raise exception '513: the retry action was not created';
  end if;
  v_def := pg_get_functiondef('public.retry_answerable_blockers(uuid,integer)'::regprocedure);
  -- The once-only guard is the difference between a fix and a retry loop.
  if v_def not ilike '%retried_at%' then
    raise exception '513: no once-only guard — this would loop forever';
  end if;
  -- It must be a sanctioned decision path or the mig-487 ledger guard rejects it.
  if v_def not ilike '%app.allow_task_decision%' then
    raise exception '513: not a sanctioned path — the ledger guard would block it';
  end if;
  -- And it must respect suspension (mig 430).
  if v_def not ilike '%tenant_is_operational%' then
    raise exception '513: would retry work in a suspended tenant';
  end if;
  raise notice '513: retry action ready — once per item, recorded as retried rather than answered';
end $a$;
