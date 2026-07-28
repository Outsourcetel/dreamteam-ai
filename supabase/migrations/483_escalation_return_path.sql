-- 483_escalation_return_path.sql
-- ============================================================================
-- WAVE 1, ITEM 2: a human's answer reaches the work.
--
-- Proven live in docs/38: on 2026-07-22 a human rejected all four of the
-- Renewal DE's escalations. Nothing moved. Six days later the same four work
-- items were still 'waiting_human' with sixteen dependent steps frozen behind
-- them. Three separate defects made that inevitable:
--
--   1. de-work inserts the escalation with related_table/related_id NULL
--      (de-work/index.ts:538), so no decision can find the work it blocks.
--      33 live escalations carry NULL today.
--   2. The exception row (the ONE decidable record, carrying the DE's proposal)
--      is written separately and NEVER linked to the task. And it is only
--      written when the model happened to supply a proposed_action — an
--      escalation without a proposal produces a task nothing can act on.
--   3. All resume glue lives in the React client. decide_human_task touches no
--      work item at all, so approving an escalation on the approvals surface
--      resumes nothing, and a backstage write resumes nothing twice over.
--
-- Founder decision N4: ONE surface; a decision on a blocker must resolve to a
-- recorded disposition — answer it, cancel it with a reason, or reroute it —
-- and that ruling must flow back into the work.
--
-- The design point that makes this hold: THE TRIGGER RESUMES, NOT THE RPC.
-- Every path that marks an escalation decided — the new one-surface RPC, the
-- existing decide_human_task, a direct write — passes through one
-- AFTER UPDATE OF status trigger. There is exactly one resume implementation
-- and no way to decide a blocker without firing it.
--
-- Resume semantics are lifted from decide_de_exception (mig 443), which is the
-- only correct implementation in the platform — including its recursive
-- successor-cancel, without which a cancelled predecessor strands its
-- descendants as invisible 'queued' rows forever.
--
-- Status vocabulary is deliberately NOT widened: human_tasks_status_check has
-- 100 references across 34 TS files, 41 DB functions and 852 live pending rows.
-- The disposition lands in its own column.
-- ============================================================================

-- ── columns ─────────────────────────────────────────────────────────────────
alter table public.human_tasks add column if not exists disposition text;
alter table public.human_tasks add column if not exists resolved_work_item_id uuid;
alter table public.de_exceptions add column if not exists human_task_id uuid;

do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'human_tasks_disposition_check') then
    alter table public.human_tasks add constraint human_tasks_disposition_check
      check (disposition is null or disposition = any (array['answered','cancelled','rerouted']));
  end if;
end $c$;

-- N4's return path resolves a decision back to a work item through exactly
-- these two columns, on a table that is 947 rows and growing. Without this it
-- is a seq-scan per decision.
create index if not exists human_tasks_related_idx
  on public.human_tasks (related_table, related_id)
  where related_id is not null;

create index if not exists de_exceptions_task_idx
  on public.de_exceptions (human_task_id)
  where human_task_id is not null;

-- ── open_de_escalation: both rows, cross-linked, in one transaction ─────────
-- Replaces de-work's two unlinked inserts. ALWAYS writes the exception row —
-- with an explicit sentinel when the employee offered no proposal — because an
-- escalation with no decidable record is the failure mode that produced 33
-- dead-end tasks.
create or replace function public.open_de_escalation(
  p_tenant_id uuid,
  p_de_id uuid,
  p_work_item_id uuid,
  p_objective_id uuid,
  p_title text,
  p_reason text,
  p_proposed_action text default null,
  p_justification text default null,
  p_needs_input boolean default false,
  p_sla_hours integer default 24
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_task uuid;
  v_exc uuid;
  v_de_name text;
  v_proposal text;
  v_title text;
begin
  if p_tenant_id is null or p_de_id is null then
    raise exception 'open_de_escalation: tenant and de are required';
  end if;
  select name into v_de_name from digital_employees where id = p_de_id;

  -- The sentinel is deliberate and readable on the surface: a human must be
  -- able to decide even when the employee proposed nothing.
  v_proposal := nullif(btrim(coalesce(p_proposed_action, '')), '');
  if v_proposal is null then
    v_proposal := case when p_needs_input
      then 'No proposal — the employee stopped and asked a question instead of finishing. Answer it, or cancel the task with a reason.'
      else 'No proposal — the employee reported a blocker without proposing an action. Give it an instruction, or cancel the task with a reason.' end;
  end if;

  v_title := nullif(btrim(coalesce(p_title, '')), '');
  if v_title is null then
    v_title := coalesce(v_de_name, 'An employee') || ' needs a decision';
  end if;

  insert into human_tasks (
    tenant_id, de_id, type, title, detail, source, priority,
    related_table, related_id, handoff_summary, sla_due_at
  ) values (
    p_tenant_id, p_de_id, 'escalation', left(v_title, 300), coalesce(p_reason, ''), 'de', 'high',
    case when p_work_item_id is not null then 'de_work_items' else null end,
    p_work_item_id,
    left(v_proposal, 1000),
    now() + make_interval(hours => greatest(1, coalesce(p_sla_hours, 24)))
  ) returning id into v_task;

  insert into de_exceptions (
    tenant_id, de_id, objective_id, work_item_id,
    situation, proposed_action, justification, human_task_id
  ) values (
    p_tenant_id, p_de_id, p_objective_id, p_work_item_id,
    left(coalesce(p_reason, ''), 4000), left(v_proposal, 4000),
    left(coalesce(p_justification, ''), 4000), v_task
  ) returning id into v_exc;

  return jsonb_build_object('ok', true, 'task_id', v_task, 'exception_id', v_exc);
end;
$function$;

revoke all on function public.open_de_escalation(uuid, uuid, uuid, uuid, text, text, text, text, boolean, integer) from public, anon, authenticated;

-- ── the ONE resume implementation ───────────────────────────────────────────
-- Internal. Called only by the trigger below, so every decision path — new RPC,
-- legacy decide_human_task, or a direct write — resumes identically.
create or replace function public.resume_de_work_from_decision(
  p_task_id uuid,
  p_disposition text,
  p_instruction text
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_task human_tasks;
  v_item de_work_items;
  v_moved uuid;
  v_instruction text;
begin
  select * into v_task from human_tasks where id = p_task_id;
  if v_task.id is null then return null; end if;
  if v_task.related_table is distinct from 'de_work_items' or v_task.related_id is null then
    return null;
  end if;

  select * into v_item from de_work_items where id = v_task.related_id and tenant_id = v_task.tenant_id;
  if v_item.id is null then return null; end if;

  v_instruction := nullif(btrim(coalesce(p_instruction, '')), '');

  if p_disposition = 'answered' then
    update de_work_items set
      status = 'queued', scheduled_for = now(), attempts = 0, last_error = null,
      locked_at = null, locked_by = null, updated_at = now(),
      payload = payload || jsonb_build_object(
        'detail', left(coalesce(payload->>'detail','')
          || E'\n\nHUMAN RULING: this task was answered by a person.'
          || case when v_instruction is not null then ' Instruction: ' || v_instruction else '' end
          || ' Act on it now; do not raise this same escalation again.', 4000),
        'human_ruling', jsonb_build_object('task_id', p_task_id,
          'disposition', p_disposition, 'instruction', v_instruction, 'decided_at', now()))
    where id = v_item.id and status = 'waiting_human'
    returning id into v_moved;

  elsif p_disposition = 'cancelled' then
    update de_work_items set
      status = 'cancelled', locked_at = null, locked_by = null, updated_at = now(),
      result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
        'summary', left('Cancelled by a person'
          || case when v_instruction is not null then ': ' || v_instruction
                  else ' without a stated reason.' end, 500),
        'human_ruling', jsonb_build_object('task_id', p_task_id,
          'disposition', p_disposition, 'instruction', v_instruction, 'decided_at', now()))
    where id = v_item.id and status = 'waiting_human'
    returning id into v_moved;

    -- claim_de_work_items requires a predecessor to be 'done'. Without this
    -- cascade a cancelled step strands every descendant as an invisible
    -- 'queued' row — the exact shape of the 16 frozen dependents at hq.
    if v_moved is not null then
      with recursive chain as (
        select w.id from de_work_items w
         where w.depends_on = v_item.id and w.tenant_id = v_task.tenant_id
           and w.status in ('queued','waiting_human')
        union all
        select w2.id from de_work_items w2 join chain c on w2.depends_on = c.id
         where w2.status in ('queued','waiting_human')
      )
      update de_work_items w set status = 'cancelled',
             last_error = 'predecessor cancelled by human decision', updated_at = now()
        from chain where w.id = chain.id;
    end if;

  elsif p_disposition = 'rerouted' then
    -- The work stays parked on purpose; the routing change is the decision.
    update de_work_items set
      updated_at = now(),
      payload = payload || jsonb_build_object('rerouted', jsonb_build_object(
        'task_id', p_task_id, 'note', v_instruction, 'at', now()))
    where id = v_item.id and status = 'waiting_human'
    returning id into v_moved;
  end if;

  -- Close the linked exception so the two surfaces cannot disagree.
  update de_exceptions set
    status = case when p_disposition = 'answered' then 'approved'
                  when p_disposition = 'cancelled' then 'denied'
                  else status end,
    outcome = coalesce(v_instruction, outcome),
    decided_at = case when p_disposition in ('answered','cancelled') then now() else decided_at end
  where human_task_id = p_task_id and status = 'proposed';

  update human_tasks set resolved_work_item_id = v_moved where id = p_task_id;

  -- An objective disarmed by an earlier 'blocked' verdict must come back
  -- around now that its blocker has been ruled on; mig 482 made that possible.
  update de_objectives o set
    next_wake_at = least(coalesce(o.next_wake_at, now()), now()),
    attention_flag = null, attention_since = null, updated_at = now()
  where o.id = v_item.objective_id and o.status in ('open','in_progress','blocked');

  return v_moved;
end;
$function$;

revoke all on function public.resume_de_work_from_decision(uuid, text, text) from public, anon, authenticated;

-- ── the trigger: no decision escapes the resume ─────────────────────────────
create or replace function public.sync_de_work_escalation()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_disposition text;
begin
  if new.related_table is distinct from 'de_work_items' then return new; end if;
  if new.status not in ('approved','rejected') then return new; end if;
  if old.status is not distinct from new.status then return new; end if;

  -- An explicit disposition wins. Otherwise derive one — a bare approve means
  -- "yes, proceed"; a bare reject means "no, stop this work", which is a real
  -- outcome and must be recorded as such rather than evaporating.
  v_disposition := coalesce(new.disposition,
    case when new.status = 'approved' then 'answered' else 'cancelled' end);

  -- House pattern (mirrors the five existing status-sync triggers): a failed
  -- side effect must never roll back the human's decision.
  begin
    perform resume_de_work_from_decision(new.id, v_disposition,
      coalesce(nullif(btrim(coalesce(new.decision_note, '')), ''), new.handoff_summary));
  exception when others then
    raise warning 'sync_de_work_escalation failed for task %: %', new.id, sqlerrm;
  end;

  return new;
end;
$function$;

drop trigger if exists trg_sync_de_work_escalation on public.human_tasks;
create trigger trg_sync_de_work_escalation
  after update of status on public.human_tasks
  for each row execute function public.sync_de_work_escalation();

-- ── the one human-facing surface ────────────────────────────────────────────
-- Records the disposition; the trigger does the resume. Role-gated exactly
-- like decide_de_exception. Cancelling REQUIRES a reason — that is what turns
-- "reject" from a void into a decision.
create or replace function public.resolve_de_escalation(
  p_task_id uuid,
  p_disposition text,
  p_instruction text default null,
  p_assign_role text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid := auth_tenant_id();
  v_task human_tasks;
  v_de_name text;
  v_instruction text;
  v_moved uuid;
begin
  if v_tenant is null then raise exception 'not_authenticated'; end if;
  if not auth_has_tenant_role(array['tenant_owner','tenant_admin']) then
    raise exception 'insufficient_role';
  end if;
  if p_disposition not in ('answered','cancelled','rerouted') then
    raise exception 'disposition must be answered | cancelled | rerouted';
  end if;

  select * into v_task from human_tasks where id = p_task_id and tenant_id = v_tenant;
  if v_task.id is null then raise exception 'task_not_found'; end if;
  if v_task.status <> 'pending' then raise exception 'already_decided: %', v_task.status; end if;
  if v_task.de_id is not null and not can_access_de(v_task.de_id) then
    raise exception 'insufficient_scope';
  end if;

  v_instruction := nullif(btrim(coalesce(p_instruction, '')), '');
  if p_disposition = 'cancelled' and v_instruction is null then
    raise exception 'cancelling a blocker requires a reason';
  end if;

  -- Setting status is what fires the trigger; the resume happens there.
  update human_tasks set
    status = case when p_disposition = 'cancelled' then 'rejected'
                  when p_disposition = 'answered' then 'approved'
                  else status end,
    disposition = p_disposition,
    decision_note = coalesce(v_instruction, decision_note),
    assigned_role = coalesce(p_assign_role, assigned_role),
    decided_by = auth.uid(),
    decided_at = now()
  where id = p_task_id;

  -- A reroute leaves the task pending, so the trigger never fires for it;
  -- run the (non-destructive) resume path directly.
  if p_disposition = 'rerouted' then
    v_moved := resume_de_work_from_decision(p_task_id, 'rerouted', v_instruction);
  else
    select resolved_work_item_id into v_moved from human_tasks where id = p_task_id;
  end if;

  select name into v_de_name from digital_employees where id = v_task.de_id;
  perform append_audit_event(
    v_tenant, 'Workspace', 'human',
    format('%s escalation %s — %s', coalesce(v_de_name, 'An employee'), p_disposition, left(v_task.title, 120)),
    'approval',
    jsonb_build_object('task_id', p_task_id, 'de_id', v_task.de_id,
      'disposition', p_disposition, 'instruction', v_instruction,
      'work_item_id', v_task.related_id, 'work_item_moved', v_moved is not null));

  return jsonb_build_object('ok', true, 'disposition', p_disposition,
    'work_item_id', v_task.related_id, 'work_item_moved', v_moved is not null);
end;
$function$;

revoke all on function public.resolve_de_escalation(uuid, text, text, text) from public, anon;
grant execute on function public.resolve_de_escalation(uuid, text, text, text) to authenticated;

notify pgrst, 'reload schema';

-- ── PROOF ────────────────────────────────────────────────────────────────────
do $a$
declare
  v_tenant uuid; v_de uuid; v_obj uuid;
  v_item uuid; v_next uuid; v_res jsonb; v_task uuid; v_exc uuid;
  v_row de_work_items; v_task_row human_tasks; n int;
begin
  -- No-op detectors.
  if to_regprocedure('public.open_de_escalation(uuid,uuid,uuid,uuid,text,text,text,text,boolean,integer)') is null then
    raise exception '483: open_de_escalation was not created';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_sync_de_work_escalation' and not tgisinternal) then
    raise exception '483: the resume trigger does not exist — decisions still evaporate';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='human_tasks' and column_name='disposition') then
    raise exception '483: disposition column missing';
  end if;

  select t.id into v_tenant from tenants t where t.slug = 'outsourcetel-hq';
  select d.id into v_de from digital_employees d where d.tenant_id = v_tenant order by d.created_at limit 1;
  if v_tenant is null or v_de is null then
    raise notice '483: no fixture available — behavioural proof SKIPPED';
    return;
  end if;

  insert into de_objectives (tenant_id, de_id, title, description, status, next_wake_at)
  values (v_tenant, v_de, '[MIG483 FIXTURE] return path proof', 'temporary', 'blocked', null)
  returning id into v_obj;

  insert into de_work_items (tenant_id, de_id, objective_id, title, status, seq, payload)
  values (v_tenant, v_de, v_obj, '[MIG483] blocked step', 'waiting_human', 1, '{"detail":"original detail"}'::jsonb)
  returning id into v_item;

  insert into de_work_items (tenant_id, de_id, objective_id, title, status, seq, depends_on)
  values (v_tenant, v_de, v_obj, '[MIG483] dependent step', 'queued', 2, v_item)
  returning id into v_next;

  -- 1. The escalation must carry the back-link that has been NULL 33 times.
  v_res := open_de_escalation(v_tenant, v_de, v_item, v_obj, null,
    'Fixture blocker: cannot read the record.', null, null, false, 24);
  v_task := (v_res->>'task_id')::uuid;
  v_exc := (v_res->>'exception_id')::uuid;
  select * into v_task_row from human_tasks where id = v_task;
  if v_task_row.related_table is distinct from 'de_work_items' or v_task_row.related_id is distinct from v_item then
    raise exception '483: escalation has no back-link — the original defect is unfixed';
  end if;
  if v_task_row.sla_due_at is null then
    raise exception '483: no SLA timer set — the 24h budget has nothing to measure';
  end if;
  select count(*) into n from de_exceptions where id = v_exc and human_task_id = v_task;
  if n <> 1 then raise exception '483: exception not cross-linked to the task'; end if;

  -- 2. THE JULY 22 TEST: a bare rejection, exactly as it happened. It must now
  --    move the work instead of doing nothing.
  update human_tasks set status = 'rejected' where id = v_task;
  select * into v_row from de_work_items where id = v_item;
  if v_row.status <> 'cancelled' then
    raise exception '483: a rejection STILL does not reach the work item (status %) — this is the July 22 failure, unfixed', v_row.status;
  end if;
  select status into v_row.status from de_work_items where id = v_next;
  if v_row.status <> 'cancelled' then
    raise exception '483: the dependent step was left stranded (status %) — the cascade did not run', v_row.status;
  end if;
  select count(*) into n from de_exceptions where id = v_exc and status = 'denied';
  if n <> 1 then raise exception '483: the linked exception was not closed by the decision'; end if;
  select next_wake_at into v_row.scheduled_for from de_objectives where id = v_obj;
  if v_row.scheduled_for is null then
    raise exception '483: the blocked objective was not re-armed after its blocker was ruled on';
  end if;

  -- 3. The answered path must re-queue WITH the ruling where the next run reads it.
  update de_work_items set status = 'waiting_human' where id = v_item;
  update human_tasks set status = 'pending', decided_at = null, disposition = null,
         resolved_work_item_id = null where id = v_task;
  update de_exceptions set status = 'proposed', decided_at = null where id = v_exc;
  update human_tasks set decision_note = 'Use the contract record in commercial_agreements.',
         status = 'approved' where id = v_task;
  select * into v_row from de_work_items where id = v_item;
  if v_row.status <> 'queued' then
    raise exception '483: an approved escalation did not re-queue the work (status %)', v_row.status;
  end if;
  if coalesce(v_row.payload->>'detail','') not like '%HUMAN RULING%' then
    raise exception '483: the ruling never reached payload.detail — the next run will not see it';
  end if;
  if coalesce(v_row.payload->>'detail','') not like '%commercial_agreements%' then
    raise exception '483: the human''s typed instruction was dropped';
  end if;
  if coalesce(v_row.payload->>'detail','') not like '%original detail%' then
    raise exception '483: the ruling CLOBBERED the original detail instead of appending';
  end if;

  delete from de_objectives where id = v_obj;   -- cascades work items
  delete from human_tasks where id = v_task;
  delete from de_exceptions where id = v_exc;

  raise notice '483: return path proven — back-link written, a bare rejection now cancels and cascades, an approval re-queues with the ruling attached';
end $a$;
