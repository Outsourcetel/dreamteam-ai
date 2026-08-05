-- 583 — the approvals queue stops generating its own work.
--
-- MEASURED, 30 days: 641 human_tasks created, 22 decided. 689 pending, the
-- oldest 31 days old — the queue has never once been drained. And 365 of those
-- pending rows are titled "Review overdue — <another task>", every one of them
-- pointing at a task that is STILL PENDING.
--
-- That is a feedback loop, not a backlog. The staleness watchdog sees an
-- un-decided approval and mints a NEW human_task saying it is overdue. That new
-- row is itself an un-decided task, so it goes overdue too. The further behind
-- a human gets, the more work the system creates, which puts them further
-- behind. 53% of the queue is the queue complaining about itself.
--
-- It is also redundant. HumanTasksPage ALREADY renders staleness inline — the
-- "⏱ STALLED · OVERDUE" badge — by reading staleness_escalations. The signal
-- had a perfectly good home; the extra row added nothing but volume.
--
-- Worse, the badge was landing on the wrong row. stale_upsert_escalation set
-- human_task_id to the NAG it had just created, not to the stale task, so the
-- item actually waiting for a decision showed no badge at all and the nag wore
-- it instead.
--
-- THE FIX, at the primitive: when the thing going stale IS a human task, there
-- is nothing to create. Record the escalation and point it at the task that
-- already exists. Other target kinds (an onboarding project, an unattended
-- invoice) have no task of their own, so for those a task is still raised —
-- that behaviour is unchanged.
--
-- What this does NOT do: relax any approval. Every gate still requires a human.
-- This removes duplicate ROWS, never a decision.

create or replace function public.stale_upsert_escalation(
  p_tenant_id     uuid,
  p_target_kind   text,
  p_target_id     uuid,
  p_tier          text,
  p_task_title    text,
  p_task_detail   text,
  p_related_table text,
  p_related_id    uuid
) returns uuid
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_task_id uuid;
  v_esc_id  uuid;
begin
  -- Mig 545: fix at the primitive, not only at the caller. A suspended
  -- workspace never gains new escalations regardless of who asks.
  if not tenant_is_operational(p_tenant_id) then
    return null;
  end if;

  -- Cooldown/dedup: an OPEN escalation for this exact
  -- (tenant, target_kind, target_id, tier) means do nothing — this is what
  -- stops the same stale item re-firing every 5-minute tick.
  if exists (
    select 1 from staleness_escalations
    where tenant_id = p_tenant_id and target_kind = p_target_kind
      and target_id = p_target_id and tier = p_tier and resolved_at is null
  ) then
    return null;
  end if;

  if p_related_table = 'human_tasks' then
    -- The stale thing is already IN the queue. Creating a second row about it
    -- is the amplifier this migration exists to remove. Point the escalation
    -- at the real task so the badge lands where the decision is owed.
    v_task_id := p_related_id;
  else
    insert into human_tasks (tenant_id, type, title, detail, source, related_table, related_id, status)
    values (p_tenant_id, 'escalation', p_task_title, p_task_detail, 'system', p_related_table, p_related_id, 'pending')
    returning id into v_task_id;
  end if;

  insert into staleness_escalations (tenant_id, target_kind, target_id, tier, human_task_id)
  values (p_tenant_id, p_target_kind, p_target_id, p_tier, v_task_id)
  returning id into v_esc_id;

  perform append_audit_event_internal(
    p_tenant_id, 'System', 'system',
    format('Staleness watchdog: %s escalation — %s', p_tier, p_task_title),
    'escalated',
    jsonb_build_object('kind', 'staleness_escalation', 'target_kind', p_target_kind,
                       'target_id', p_target_id, 'tier', p_tier, 'human_task_id', v_task_id,
                       'raised_new_task', p_related_table <> 'human_tasks')
  );

  return v_esc_id;
end;
$function$;

-- ── Undo the pile already made ──────────────────────────────────────────────
-- Order matters: staleness_escalations.human_task_id is ON DELETE NO ACTION,
-- so every escalation must point at the real task BEFORE the nags can go.
do $$
declare
  v_repointed int;
  v_deleted   int;
  v_before    int;
  v_after     int;
begin
  select count(*) into v_before from human_tasks where status = 'pending';

  update staleness_escalations se
     set human_task_id = se.target_id
   where se.target_kind = 'pending_review_task'
     and se.human_task_id is distinct from se.target_id
     and exists (select 1 from human_tasks t where t.id = se.target_id);
  get diagnostics v_repointed = row_count;

  -- The guard refuses to delete an undecided task, and it is right to: these
  -- would be real approvals if a human had raised them. They are not — they
  -- are watchdog duplicates of tasks that still exist and still need deciding.
  -- Transaction-local bypass, exactly as migrations 548 and 578 used.
  perform set_config('app.allow_task_decision', 'on', true);

  delete from human_tasks t
   where t.source = 'system'
     and t.type = 'escalation'
     and t.status = 'pending'
     and t.related_table = 'human_tasks'
     and (t.title like 'Review overdue — %' or t.title like 'Review waiting — %')
     and not exists (select 1 from staleness_escalations se where se.human_task_id = t.id);
  get diagnostics v_deleted = row_count;

  select count(*) into v_after from human_tasks where status = 'pending';

  perform public.append_audit_event_internal(
    '5bb802e1-8e92-4eef-9a7a-ac348785d43f',
    'Platform maintenance', 'system',
    format('Staleness watchdog no longer duplicates queued work — %s escalation(s) re-pointed at the task actually waiting, %s duplicate row(s) removed. Pending queue %s to %s.',
           v_repointed, v_deleted, v_before, v_after),
    'config_change',
    jsonb_build_object('kind', 'staleness_amplifier_removed',
                       'repointed', v_repointed, 'deleted', v_deleted,
                       'pending_before', v_before, 'pending_after', v_after)
  );
end $$;
