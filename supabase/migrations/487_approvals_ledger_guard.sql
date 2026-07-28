-- 486_approvals_ledger_guard.sql
-- ============================================================================
-- WAVE 1, ITEM 1b (N7): the governance record stops being editable and
-- erasable.
--
-- WHAT THE FORENSICS ESTABLISHED (docs/38 + this session's investigation).
-- Two backstage events on the approvals ledger, neither from product code:
--   (a) 2026-07-22 07:06:59.249+00 — 23 tasks decided in ONE statement.
--       decided_at carries THREE fractional digits; every SQL now() decision in
--       the table has six. That is a JavaScript ISO string, i.e. a value
--       supplied by a caller, not by Postgres.
--   (b) 2026-07-22 19:28:06/09 — two statements, 9 rows across three DEs, all
--       set to 'rejected' with decided_at left NULL: a different statement
--       shape, therefore a different writer.
-- Both ran with auth.uid() NULL — proven three ways: zero tenant_activity_log
-- rows (its trigger returns early when auth.uid() is null), zero
-- remote_access_write_log rows, zero audit_events in either window. And RLS on
-- human_tasks requires a non-null auth.uid() for `authenticated`, so the actor
-- held service_role or postgres. Separately, nine trust-gated write-back
-- approvals were HARD-DELETED while still undecided; every DELETE ever
-- recorded on this table ran as postgres, and the application has no delete
-- path at all.
--
-- Conclusion, stated plainly: this was out-of-band admin SQL — the same channel
-- our own tooling uses — not an intruder and not the product. The specific
-- process is unnameable (the statement has been evicted from
-- pg_stat_statements and no matching script exists in git history), so this
-- guard is designed to make the NEXT one impossible and recorded, rather than
-- to name the last one.
--
-- WHY RLS AND GRANTS CANNOT HOLD:
--   * service_role and postgres both have rolbypassrls = true — a policy is
--     invisible to exactly the roles that did this.
--   * postgres owns all 623 SECURITY DEFINER functions AND is the role the
--     Management API runs as, so role-based gating would break the platform.
--   * TRUNCATE bypasses both RLS and row triggers — and `authenticated`
--     currently HOLDS truncate on human_tasks. That is a live hole nobody was
--     looking for.
--
-- THE INSTRUMENT: a BEFORE UPDATE OR DELETE trigger keyed on a transaction-local
-- GUC that only the sanctioned decision functions set. This is the pattern
-- already proven twice in this codebase (audit_events_immutable with
-- app.allow_audit_purge; guard_compliance_guardrails with
-- app.allow_compliance_change).
--
-- DELIBERATELY STILL PERMITTED, because a guard that breaks the escalation
-- pipeline is worse than the hole it closes:
--   * INSERT — 25 DB functions and 10 edge-function sites create tasks.
--   * UPDATE of non-decision columns (priority, sla_due_at, assigned_role,
--     checklist_state, resolved_work_item_id, disposition, updated_at) — the
--     stall sweep raises priority, and the resume path stamps its own results.
--   * DELETE of an ALREADY-DECIDED row — retention and cleanup stay possible.
-- FORBIDDEN: changing status/decided_by/decided_at outside a decision function,
-- and deleting an UNDECIDED approval at all.
-- ============================================================================

-- ── the disposition gap found during wave-1 verification ────────────────────
-- A decision that arrives without an explicit disposition (the legacy path, or
-- a direct write) derives one — but never recorded it, so the row showed THAT
-- it was approved without showing WHAT was decided. Stamp it where the resume
-- already writes its result. Safe: the resume trigger is AFTER UPDATE OF
-- STATUS, so writing disposition here cannot re-fire it.
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
    update de_work_items set
      updated_at = now(),
      payload = payload || jsonb_build_object('rerouted', jsonb_build_object(
        'task_id', p_task_id, 'note', v_instruction, 'at', now()))
    where id = v_item.id and status = 'waiting_human'
    returning id into v_moved;
  end if;

  update de_exceptions set
    status = case when p_disposition = 'answered' then 'approved'
                  when p_disposition = 'cancelled' then 'denied'
                  else status end,
    outcome = coalesce(v_instruction, outcome),
    decided_at = case when p_disposition in ('answered','cancelled') then now() else decided_at end
  where human_task_id = p_task_id and status = 'proposed';

  -- Record WHAT was decided, not merely that something was.
  update human_tasks
     set resolved_work_item_id = v_moved,
         disposition = coalesce(disposition, p_disposition)
   where id = p_task_id;

  update de_objectives o set
    next_wake_at = least(coalesce(o.next_wake_at, now()), now()),
    attention_flag = null, attention_since = null, updated_at = now()
  where o.id = v_item.objective_id and o.status in ('open','in_progress','blocked');

  return v_moved;
end;
$function$;

revoke all on function public.resume_de_work_from_decision(uuid, text, text) from public, anon, authenticated;

-- ── sanctioned decision paths (spliced from LIVE defs, one anchor each) ──
-- Every function that legitimately writes status/decided_by/decided_at declares
-- itself to the guard. Enumerated by scanning pg_proc for writers of those
-- columns, not by memory: approve_learned_behavior, decide_human_task,
-- handoff_back_to_de, reject_learned_behavior, set_support_conversation_state
-- (decide_de_escalation already sets it, mig 486). The client only ever writes
-- checklist_state (src/lib/customerApi.ts:132), which the guard does not gate.

-- ── approve_learned_behavior ──
CREATE OR REPLACE FUNCTION public.approve_learned_behavior(p_cluster_id uuid, p_final_pattern text DEFAULT NULL::text, p_final_threshold bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user          uuid := auth.uid();
  v_caller_tenant uuid;
  v_is_active     boolean;
  v_cluster       record;
  v_rule_id       uuid;
  v_pattern       text;
begin
  perform set_config('app.allow_task_decision', 'on', true);   -- mig 486: sanctioned decision path
  select * into v_cluster from de_learned_behavior_clusters where id = p_cluster_id;
  if v_cluster.id is null or v_cluster.status <> 'proposed' then
    return jsonb_build_object('ok', false, 'error', 'not_proposed');
  end if;

  select tenant_id, coalesce(is_active, true) into v_caller_tenant, v_is_active from profiles where user_id = v_user;
  if v_caller_tenant is distinct from v_cluster.tenant_id then
    return jsonb_build_object('ok', false, 'error', 'not_tenant_member');
  end if;
  if not v_is_active then
    return jsonb_build_object('ok', false, 'error', 'not_tenant_member');
  end if;

  -- DE scoping (mig 385/416). The cluster belongs to one employee and
  -- de_learned_behavior_clusters.de_id is NOT NULL, so no null case.
  -- NOTE the resulting guardrail rule is WORKSPACE-scoped by default; this
  -- guard bounds who may approve, not how far the rule reaches. See header.
  if not public.can_access_de(v_cluster.de_id) then
    return jsonb_build_object('ok', false, 'error', 'not_responsible_for_de');
  end if;
  if v_cluster.verdict_type = 'correction' then
    v_pattern := coalesce(p_final_pattern, v_cluster.proposed_rule->>'suggested_pattern');
    if coalesce(btrim(v_pattern), '') = '' then
      return jsonb_build_object('ok', false, 'error', 'pattern_required');
    end if;
    insert into guardrail_rules (tenant_id, rule, rule_type, pattern, severity, active, created_by)
    values (
      v_cluster.tenant_id,
      format('Learned behavior — %s', left(v_pattern, 60)),
      coalesce(v_cluster.proposed_rule->>'rule_type', 'blocked_phrase'),
      v_pattern, 'warning', true, v_user
    )
    returning id into v_rule_id;
  else
    v_rule_id := v_cluster.guardrail_rule_id;
    if v_rule_id is null then
      return jsonb_build_object('ok', false, 'error', 'no_target_rule');
    end if;
    if p_final_threshold is not null then
      update guardrail_rules set threshold = p_final_threshold, updated_at = now() where id = v_rule_id and tenant_id = v_cluster.tenant_id;
    elsif p_final_pattern is not null then
      update guardrail_rules set pattern = p_final_pattern, updated_at = now() where id = v_rule_id and tenant_id = v_cluster.tenant_id;
    else
      -- No override given: the evidence says this rule is too strict for
      -- this whole pattern — the honest default is to deactivate it
      -- rather than silently leave it exactly as-is (which would make
      -- "approve" a no-op).
      update guardrail_rules set active = false, updated_at = now() where id = v_rule_id and tenant_id = v_cluster.tenant_id;
    end if;
  end if;

  update de_learned_behavior_clusters
  set status = 'resolved', fix_applied_at = now(), resulting_guardrail_rule_id = v_rule_id, updated_at = now()
  where id = p_cluster_id;

  if v_cluster.human_task_id is not null then
    update human_tasks set status = 'approved', decided_by = v_user, decided_at = now() where id = v_cluster.human_task_id;
  end if;

  perform append_audit_event(
    v_cluster.tenant_id, coalesce((select full_name from profiles where user_id = v_user), 'A reviewer'), 'human',
    format('Approved a learned behavior (%s) — %s guardrail rule %s', v_cluster.verdict_type,
      case when v_cluster.verdict_type = 'correction' then 'created' else 'updated' end, v_rule_id),
    'config_change',
    jsonb_build_object('kind', 'learned_behavior_approved', 'cluster_id', p_cluster_id, 'guardrail_rule_id', v_rule_id)
  );

  return jsonb_build_object('ok', true, 'guardrail_rule_id', v_rule_id);
end;
$function$
;

-- ── decide_human_task ──
CREATE OR REPLACE FUNCTION public.decide_human_task(p_task_id uuid, p_decision text, p_reason_code text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_edit jsonb DEFAULT NULL::jsonb)
 RETURNS human_tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := auth_tenant_id();
  v_task   human_tasks;
  v_row    human_tasks;
BEGIN
  perform set_config('app.allow_task_decision', 'on', true);   -- mig 486: sanctioned decision path
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'decision must be approved or rejected';
  END IF;
  -- A rejection with no reason teaches nothing. This is the one place the
  -- friction is worth it; a clean approval needs no code.
  IF p_decision = 'rejected' AND coalesce(btrim(p_reason_code), '') = '' THEN
    RAISE EXCEPTION 'reason_required: a rejection must carry a reason code';
  END IF;

  SELECT * INTO v_task FROM human_tasks WHERE id = p_task_id AND tenant_id = v_tenant;
  IF v_task.id IS NULL THEN RAISE EXCEPTION 'task_not_found'; END IF;

  -- DE scoping (mig 385). Null-tolerant, matching the mig-386/452 policies:
  -- an unattributed task is decidable by the whole workspace, exactly as it is
  -- visible to them. A bare guard here would be stricter than the table.
  IF v_task.de_id IS NOT NULL AND NOT public.can_access_de(v_task.de_id) THEN
    RAISE EXCEPTION 'not_responsible_for_de: this employee is not in your reporting line';
  END IF;

  -- ⚠ The pending-only clause is the double-approval guard the caller depends
  -- on. No row back means "already decided" and the caller MUST skip its side
  -- effects (invoice send, gated-action execute, write-backs). Do not relax.
  UPDATE human_tasks
     SET status               = p_decision,
         decided_by           = auth.uid(),
         decided_at           = now(),
         updated_at           = now(),
         decision_reason_code = nullif(btrim(p_reason_code), ''),
         decision_note        = nullif(btrim(p_note), ''),
         decision_edit        = p_edit
   WHERE id = p_task_id AND tenant_id = v_tenant AND status = 'pending'
   RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN RETURN NULL; END IF;   -- already decided; caller skips hooks

  -- Governance record. 'approval' is constraint-legal (checked against
  -- audit_events_category_check); p_category is NOT normalised by
  -- append_audit_event, so an invented category would raise and abort the
  -- decision — the mig-429 lesson.
  PERFORM append_audit_event(
    v_tenant,
    coalesce((SELECT full_name FROM profiles WHERE user_id = auth.uid()), 'An approver'),
    'human',
    format('Task %s: %s%s', p_decision, v_row.title,
           CASE WHEN p_reason_code IS NOT NULL THEN ' (' || p_reason_code || ')' ELSE '' END),
    'approval',
    jsonb_build_object(
      'kind', 'human_task_decision', 'task_id', p_task_id, 'task_type', v_row.type,
      'decision', p_decision, 'reason_code', nullif(btrim(p_reason_code), ''),
      'de_id', v_row.de_id, 'edited', (p_edit IS NOT NULL),
      'related_table', v_row.related_table, 'related_id', v_row.related_id));

  RETURN v_row;
END $function$
;

-- ── handoff_back_to_de ──
CREATE OR REPLACE FUNCTION public.handoff_back_to_de(p_conversation_id uuid, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_tenant uuid; v_de uuid; v_status text; v_de_name text;
begin
  perform set_config('app.allow_task_decision', 'on', true);   -- mig 486: sanctioned decision path
  v_tenant := _assert_conv_member(p_conversation_id);
  select de_id, status into v_de, v_status from de_conversations where id = p_conversation_id;
  if v_status = 'resolved' then raise exception 'conversation_resolved'; end if;
  if v_de is null then raise exception 'no_de_on_conversation'; end if;
  -- DE scoping (mig 385/409). v_de is proven non-null by the check above,
  -- so no null-tolerance here — this function refuses a DE-less conversation
  -- outright. Guards all four side effects below, including the memory
  -- write, which is the one that persists inside the employee.
  if not public.can_access_de(v_de) then
    raise exception 'not_responsible_for_de: this employee is not in your reporting line';
  end if;

  update de_conversations
     set status = 'ai_handling', owner_user_id = null, handoff_summary = null, last_message_at = now()
   where id = p_conversation_id;

  -- The lesson: written into the DE's conversation-scoped memory, which
  -- de-answer recalls on the next customer message in this thread.
  if coalesce(btrim(p_note), '') <> '' then
    perform de_memory_write(
      v_tenant, v_de,
      'A human teammate handled part of this conversation and handed it back with this guidance: ' || btrim(p_note),
      null, 'conversation', p_conversation_id::text, 'episodic', 0.9, 'human', null);
  end if;

  -- The thread is visibly handled — its pending escalation tasks are done.
  update human_tasks
     set status = 'approved', decided_by = auth.uid(), decided_at = now(), updated_at = now()
   where tenant_id = v_tenant and related_table = 'de_conversations'
     and related_id = p_conversation_id and type = 'escalation' and status = 'pending';

  select coalesce(persona_name, name, 'the DE') into v_de_name from digital_employees where id = v_de;
  insert into activity_events (tenant_id, actor, actor_type, event_type, text)
  values (v_tenant, v_de_name, 'de', 'handoff_returned',
          'A human handed the conversation back to ' || v_de_name
          || case when coalesce(btrim(p_note), '') <> '' then ' with guidance: ' || left(btrim(p_note), 200) else '' end);
end;
$function$
;

-- ── reject_learned_behavior ──
CREATE OR REPLACE FUNCTION public.reject_learned_behavior(p_cluster_id uuid, p_reason text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user          uuid := auth.uid();
  v_caller_tenant uuid;
  v_is_active     boolean;
  v_cluster       record;
begin
  perform set_config('app.allow_task_decision', 'on', true);   -- mig 486: sanctioned decision path
  select * into v_cluster from de_learned_behavior_clusters where id = p_cluster_id;
  if v_cluster.id is null or v_cluster.status <> 'proposed' then
    return jsonb_build_object('ok', false, 'error', 'not_proposed');
  end if;

  select tenant_id, coalesce(is_active, true) into v_caller_tenant, v_is_active from profiles where user_id = v_user;
  if v_caller_tenant is distinct from v_cluster.tenant_id then
    return jsonb_build_object('ok', false, 'error', 'not_tenant_member');
  end if;
  if not v_is_active then
    return jsonb_build_object('ok', false, 'error', 'not_tenant_member');
  end if;

  -- DE scoping (mig 385/417). Rejecting suppresses a correction derived
  -- from this employee''s own failures and records the caller as the
  -- reviewer who decided it. de_id is NOT NULL here, so no null case.
  if not public.can_access_de(v_cluster.de_id) then
    return jsonb_build_object('ok', false, 'error', 'not_responsible_for_de');
  end if;
  if v_cluster.human_task_id is not null then
    update human_tasks set status = 'rejected', decided_by = v_user, decided_at = now() where id = v_cluster.human_task_id;
  end if;

  update de_learned_behavior_clusters
  set status = 'open', human_task_id = null, updated_at = now()
  where id = p_cluster_id;

  perform append_audit_event(
    v_cluster.tenant_id, coalesce((select full_name from profiles where user_id = v_user), 'A reviewer'), 'human',
    format('Rejected a proposed learned behavior (%s)%s', v_cluster.verdict_type,
      case when coalesce(p_reason, '') <> '' then ' (' || p_reason || ')' else '' end),
    'config_change',
    jsonb_build_object('kind', 'learned_behavior_rejected', 'cluster_id', p_cluster_id, 'reason', coalesce(p_reason, ''))
  );

  return jsonb_build_object('ok', true);
end;
$function$
;

-- ── set_support_conversation_state ──
CREATE OR REPLACE FUNCTION public.set_support_conversation_state(p_conversation_id uuid, p_status text DEFAULT NULL::text, p_priority text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_tenant uuid; v_de uuid;
begin
  perform set_config('app.allow_task_decision', 'on', true);   -- mig 486: sanctioned decision path
  v_tenant := _assert_conv_member(p_conversation_id);
  if p_status is not null and p_status not in ('ai_handling','needs_human','human_owned','resolved') then raise exception 'bad_status'; end if;
  if p_priority is not null and p_priority not in ('low','normal','high','urgent') then raise exception 'bad_priority'; end if;
  -- DE scoping (mig 385/408). Guards BOTH mutations below: the state change
  -- and the escalation auto-approval that p_status = ''resolved'' triggers.
  -- Placed after the argument validation so a bad status still fails as a
  -- bad status. Null-tolerant to match the mig-386 policy.
  select de_id into v_de from de_conversations where id = p_conversation_id;
  if v_de is not null and not public.can_access_de(v_de) then
    raise exception 'not_responsible_for_de: this employee is not in your reporting line';
  end if;

  update de_conversations
    set status = coalesce(p_status, status), priority = coalesce(p_priority, priority), last_message_at = now()
  where id = p_conversation_id;
  if p_status = 'resolved' then
    update human_tasks
       set status = 'approved', decided_by = auth.uid(), decided_at = now(), updated_at = now()
     where tenant_id = v_tenant and related_table = 'de_conversations'
       and related_id = p_conversation_id and type = 'escalation' and status = 'pending';
  end if;
end;
$function$
;

-- ── the guard ───────────────────────────────────────────────────────────────
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
    -- An undecided approval is the governance record. It may never be erased;
    -- decide it (cancel-with-reason is a decision) and then retention may act.
    if old.status = 'pending' and not v_sanctioned then
      raise exception 'human_tasks: an undecided approval cannot be deleted (task %). Decide it first — cancelling with a reason is a decision.', old.id
        using errcode = 'raise_exception';
    end if;
    return old;
  end if;

  -- Decision columns may only move inside a sanctioned decision function.
  if (new.status is distinct from old.status
      or new.decided_by is distinct from old.decided_by
      or new.decided_at is distinct from old.decided_at)
     and not v_sanctioned then
    raise exception 'human_tasks: decisions must go through decide_human_task / resolve_de_escalation / decide_de_exception (task %). Direct writes to status/decided_by/decided_at are not recorded and cannot be audited.', old.id
      using errcode = 'raise_exception';
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_guard_human_task_decision on public.human_tasks;
create trigger trg_guard_human_task_decision
  before update or delete on public.human_tasks
  for each row execute function public.guard_human_task_decision();

-- TRUNCATE bypasses RLS *and* row triggers — and `authenticated` holds it today.
revoke truncate on public.human_tasks from authenticated, anon;
revoke truncate on public.de_exceptions from authenticated, anon;

notify pgrst, 'reload schema';


-- ── PROOF: the guard blocks the July 22 shape and permits the real paths ────
do $p$
declare
  v_tenant uuid; v_de uuid; v_task uuid; ok boolean;
begin
  select t.id into v_tenant from tenants t where t.slug='outsourcetel-hq';
  select d.id into v_de from digital_employees d where d.tenant_id=v_tenant order by d.created_at limit 1;
  if v_tenant is null then raise notice '487: no fixture — proof SKIPPED'; return; end if;

  insert into human_tasks (tenant_id, de_id, type, title, detail, source, status)
  values (v_tenant, v_de, 'escalation', '[MIG487 FIXTURE] guard proof', 'temporary', 'de', 'pending')
  returning id into v_task;

  -- 1. A raw backstage decision — the exact July 22 statement shape — must fail.
  ok := false;
  begin
    update human_tasks set status='rejected', decided_by=null,
           decided_at='2026-07-22 07:06:59.249+00'::timestamptz where id = v_task;
  exception when others then ok := true;
  end;
  if not ok then
    raise exception '487: a raw backstage decision STILL succeeded — the ledger is unguarded';
  end if;

  -- 2. Deleting an UNDECIDED approval must fail (the 9 erased write-backs).
  ok := false;
  begin
    delete from human_tasks where id = v_task;
  exception when others then ok := true;
  end;
  if not ok then
    raise exception '487: an undecided approval was deleted — the ledger is still erasable';
  end if;

  -- 3. Non-decision columns must stay writable (the stall sweep needs this).
  update human_tasks set priority='urgent' where id = v_task;

  -- 4. A sanctioned path must still work end to end.
  perform set_config('app.allow_task_decision','on',true);
  update human_tasks set status='rejected', decided_at=now() where id = v_task;
  if (select status from human_tasks where id=v_task) <> 'rejected' then
    raise exception '487: the sanctioned path was blocked — the guard is too strict';
  end if;

  -- 5. A DECIDED row may still be deleted (retention must keep working).
  delete from human_tasks where id = v_task;
  if exists (select 1 from human_tasks where id=v_task) then
    raise exception '487: cleanup of a decided row was blocked';
  end if;

  raise notice '487: guard proven';
end $p$;

do $a$
declare n int;
begin
  if not exists (select 1 from pg_trigger where tgname='trg_guard_human_task_decision' and not tgisinternal) then
    raise exception '486: the guard trigger does not exist';
  end if;
  select count(*) into n from information_schema.role_table_grants
   where table_schema='public' and table_name='human_tasks'
     and grantee in ('authenticated','anon') and privilege_type='TRUNCATE';
  if n > 0 then
    raise exception '486: TRUNCATE is still granted on human_tasks (% grants) — it bypasses the guard entirely', n;
  end if;
  if pg_get_functiondef('public.resume_de_work_from_decision(uuid,text,text)'::regprocedure) not ilike '%disposition = coalesce(disposition%' then
    raise exception '486: the disposition stamp did not land';
  end if;
  raise notice '486: approvals ledger guarded — decision columns and undecided deletes now require a sanctioned path';
end $a$;
