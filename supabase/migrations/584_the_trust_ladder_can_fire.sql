-- 584 — the trust ladder can fire.
--
-- Measured before this: every active Digital Employee frozen at 'supervised',
-- 2 promotions ever against 10 demotions. trust_evidence_for reported
-- human_samples = 0 on EVERY policy, against a requirement of 3-5. Not slow,
-- not strict — arithmetically impossible. Two independent causes, either
-- sufficient on its own.
--
-- (a) ATTRIBUTION WAS THROWN AWAY. record_action_execution receives
--     p_subject_kind/p_subject_id, so it knows exactly which employee an
--     approval is about — 106 executions carry it. It then created the
--     human_task WITHOUT de_id: 0 of 105 action_approval tasks had one. Trust
--     policies here are all employee-scoped, so evidence is filtered
--     de_id = policy.de_id, and evidence belonging to nobody counts for
--     nobody. Pure data loss, no policy in it.
--
-- (b) THE EVIDENCE QUERY IGNORED THE EVIDENCE. It counted only 'escalation'
--     and 'review_gate'. Of 22 decisions in the last 30 days, 17 were
--     action_approval — a human reading what an employee proposed and saying
--     yes, which is the most direct proof of trustworthiness the system can
--     produce. 18 of 22 decisions were discarded.
--
-- Founder-approved 2026-08-05. Matched to what each policy GOVERNS rather
-- than counted everywhere: approving a payment reminder must not earn the
-- right to auto-send customer answers. So action_execute gains
-- action_approval/approval_gate, and the answer categories gain
-- inquiry_review — which is literally a review of an answer and had been
-- excluded just as wrongly.
--
-- NOT a relaxation: no threshold moved, no gate opened. This makes real work
-- countable. An employee still has to earn every level.

CREATE OR REPLACE FUNCTION public.record_action_execution(p_tenant_id uuid, p_action_definition_id uuid, p_connector_id uuid, p_subject_kind text, p_subject_id uuid, p_mode text, p_params jsonb, p_decision text, p_destructive boolean, p_idempotent boolean, p_dedupe_key text, p_request_summary text, p_receipt text, p_result jsonb, p_task_title text, p_task_detail text, p_create_task boolean DEFAULT true, p_origin_kind text DEFAULT NULL::text, p_origin_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_task_id uuid;
  v_row_id  uuid;
  v_category text;
  v_label    text;
  v_ref      text;
begin
  if p_create_task and p_decision in ('human_gated_destructive', 'human_gated_trust') then
    insert into human_tasks (tenant_id, de_id, type, title, detail, source, related_table, related_id, status)
    values (
      p_tenant_id,
      -- The employee this approval is ABOUT. It was already in scope and was
      -- being thrown away: 0 of 105 action_approval tasks carried it, so the
      -- trust ladder could never attribute a single approval to anyone.
      case when p_subject_kind = 'de' then p_subject_id end,
      'action_approval',
      coalesce(p_task_title, 'Action awaiting approval'),
      coalesce(p_task_detail, ''), 'de', 'action_executions', null, 'pending'
    )
    returning id into v_task_id;
  end if;

  insert into action_executions (
    tenant_id, action_definition_id, connector_id, subject_kind, subject_id,
    mode, params, decision, destructive, idempotent, dedupe_key,
    request_summary, receipt, result, task_id, origin_kind, origin_id
  ) values (
    p_tenant_id, p_action_definition_id, p_connector_id, p_subject_kind, p_subject_id,
    p_mode, coalesce(p_params, '{}'::jsonb), p_decision, coalesce(p_destructive, true), coalesce(p_idempotent, false), p_dedupe_key,
    coalesce(p_request_summary, ''), p_receipt, p_result, v_task_id, p_origin_kind, p_origin_id
  )
  returning id into v_row_id;

  if v_task_id is not null then
    update human_tasks set related_id = v_row_id where id = v_task_id;
  end if;

  if p_mode = 'execute' and p_subject_id is not null then
    select category into v_category from action_definitions where id = p_action_definition_id;
    select label into v_label from action_definitions where id = p_action_definition_id;
    v_ref := coalesce(
      nullif(p_params->>'external_ref', ''),
      nullif(p_params->>'account_name', ''),
      nullif(p_params->>'account_ref', '')
    );
    if v_category is not null and v_ref is not null then
      perform record_de_experience(
        p_tenant_id, p_subject_kind, p_subject_id, v_category, v_ref,
        format('Considered action "%s" (%s)', coalesce(v_label, 'action'), coalesce(p_request_summary, '')),
        format('Decision: %s', p_decision),
        coalesce(p_receipt, case
          when p_decision in ('human_gated_destructive', 'human_gated_trust') then 'Awaiting human approval — not yet executed.'
          when p_decision = 'failed' then 'Attempted but failed — see result for detail.'
          else 'No receipt recorded.'
        end),
        null, v_row_id
      );
    end if;
  end if;

  return jsonb_build_object('id', v_row_id, 'task_id', v_task_id);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.trust_evidence_for(p_policy trust_policies)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  c              jsonb := p_policy.criteria;
  v_window       integer := coalesce((c->>'window_days')::integer, 30);
  v_since        timestamptz := now() - make_interval(days => coalesce((c->>'window_days')::integer, 30));
  -- eval evidence
  v_eval_total   bigint := 0;
  v_eval_passed  bigint := 0;
  v_eval_rate    numeric := 0;
  -- human evidence
  v_h_total      bigint := 0;
  v_h_approved   bigint := 0;
  v_h_rate       numeric := 0;
  -- guardrail evidence
  v_blocks       bigint := 0;
  -- criteria thresholds
  v_min_rate     numeric := coalesce((c->>'min_eval_pass_rate')::numeric, 0.9);
  v_min_samples  integer := coalesce((c->>'min_eval_samples')::integer, 25);
  v_min_h_rate   numeric := coalesce((c->>'min_human_approval_rate')::numeric, 0.9);
  v_min_h_n      integer := coalesce((c->>'min_human_samples')::integer, 0);
  v_max_blocks   integer := coalesce((c->>'max_guardrail_blocks')::integer, 0);
  v_criteria     jsonb;
  v_eligible     boolean;
begin
  -- Source 1: Proving Ground — finished eval runs in the window. An
  -- employee-scoped policy counts only runs attributed to that employee
  -- (eval_runs.de_id); a tenant-scoped policy keeps the historical
  -- whole-workspace count.
  select coalesce(sum(total), 0), coalesce(sum(passed), 0)
    into v_eval_total, v_eval_passed
  from eval_runs
  where tenant_id = p_policy.tenant_id
    and finished_at is not null
    and finished_at >= v_since
    and status in ('passed', 'failed')
    and (p_policy.de_id is null or de_id = p_policy.de_id);
  v_eval_rate := case when v_eval_total > 0 then round(v_eval_passed::numeric / v_eval_total, 4) else 0 end;

  -- Source 2: human task outcomes in the window. invoice category
  -- reads invoice approval gates; answer categories read
  -- escalation / review outcomes (sparse until LLM activation —
  -- min_human_samples defaults to 0 there, honestly noted).
  -- An employee-scoped policy counts only tasks attributed to that
  -- employee (human_tasks.de_id); unattributed tasks are not another
  -- employee's evidence and are excluded from scoped policies.
  select count(*), count(*) filter (where status = 'approved')
    into v_h_total, v_h_approved
  from human_tasks
  where tenant_id = p_policy.tenant_id
    and status in ('approved', 'rejected')
    and decided_at is not null
    and decided_at >= v_since
    and case
      when p_policy.action_category = 'invoice_auto_send'
        then (related_table = 'renewal_invoices' or type = 'approval_gate')
      -- An approval IS the evidence. A human looking at what an employee
      -- wants to do and saying yes is the most direct proof it can be
      -- trusted, and it was being discarded: 17 of 22 decisions in the last
      -- 30 days were action_approval and none of them counted.
      -- Deliberately matched to what each policy GOVERNS rather than counted
      -- everywhere: approving a payment reminder must not earn the right to
      -- auto-send customer answers.
      when p_policy.action_category = 'action_execute'
        then type in ('action_approval', 'approval_gate', 'escalation', 'review_gate')
      else type in ('inquiry_review', 'escalation', 'review_gate')
    end
    and (p_policy.de_id is null or de_id = p_policy.de_id);
  v_h_rate := case when v_h_total > 0 then round(v_h_approved::numeric / v_h_total, 4) else 0 end;

  -- Source 3: guardrail blocks in the window. A tenant-scoped policy counts
  -- every block in the tenant (historical behavior). An employee-scoped
  -- policy counts blocks stamped with this employee's id in detail — rows
  -- written before the stamp existed carry no id and age out of the
  -- evidence window naturally.
  select count(*) into v_blocks
  from audit_events
  where tenant_id = p_policy.tenant_id
    and category = 'guardrail_block'
    and created_at >= v_since
    and (p_policy.de_id is null or detail->>'de_id' = p_policy.de_id::text);

  v_criteria := jsonb_build_array(
    jsonb_build_object(
      'key', 'eval_pass_rate', 'label', 'Evaluation pass rate',
      'actual', v_eval_rate, 'required', v_min_rate,
      'met', (v_eval_total >= v_min_samples and v_eval_rate >= v_min_rate),
      'detail', format('%s of %s evaluated answers passed in the last %s days', v_eval_passed, v_eval_total, v_window)),
    jsonb_build_object(
      'key', 'eval_samples', 'label', 'Evaluation sample size',
      'actual', v_eval_total, 'required', v_min_samples,
      'met', v_eval_total >= v_min_samples,
      'detail', format('%s evaluated answers (needs %s)', v_eval_total, v_min_samples)),
    jsonb_build_object(
      'key', 'human_approval_rate', 'label', 'Human approval rate',
      'actual', v_h_rate, 'required', v_min_h_rate,
      'met', (v_min_h_n = 0 or (v_h_total >= v_min_h_n and v_h_rate >= v_min_h_rate)),
      'detail', format('%s of %s human reviews approved in the last %s days', v_h_approved, v_h_total, v_window)),
    jsonb_build_object(
      'key', 'human_samples', 'label', 'Human review sample size',
      'actual', v_h_total, 'required', v_min_h_n,
      'met', v_h_total >= v_min_h_n,
      'detail', format('%s decided reviews (needs %s)', v_h_total, v_min_h_n)),
    jsonb_build_object(
      'key', 'guardrail_blocks', 'label', 'Guardrail blocks',
      'actual', v_blocks, 'required', v_max_blocks,
      'met', v_blocks <= v_max_blocks,
      'detail', format('%s guardrail blocks in the last %s days (max %s)', v_blocks, v_window, v_max_blocks))
  );

  select bool_and((x->>'met')::boolean) into v_eligible
  from jsonb_array_elements(v_criteria) x;

  return jsonb_build_object(
    'policy_id', p_policy.id,
    'action_category', p_policy.action_category,
    'current_level', p_policy.current_level,
    'target_level', p_policy.target_level,
    'window_days', v_window,
    'criteria', v_criteria,
    'eligible', coalesce(v_eligible, false) and p_policy.current_level < 3 and p_policy.status = 'active',
    'at_max_level', p_policy.current_level >= 3,
    'computed_at', now()
  );
end;
$function$
;


-- Recover the attribution already lost. The employee is still recorded on the
-- execution, so every orphaned approval task can be re-linked exactly — no
-- guessing, and it turns months of real decisions into usable evidence
-- instead of making the ladder wait for fresh ones.
do $$
declare n int;
begin
  update human_tasks t
     set de_id = e.subject_id
    from action_executions e
   where e.task_id = t.id
     and t.de_id is null
     and e.subject_kind = 'de'
     and e.subject_id is not null;
  get diagnostics n = row_count;

  perform public.append_audit_event_internal(
    '5bb802e1-8e92-4eef-9a7a-ac348785d43f',
    'Platform maintenance', 'system',
    format('Trust evidence repaired — %s approval task(s) re-attributed to the employee they were always about, and approvals now count as evidence.', n),
    'config_change',
    jsonb_build_object('kind', 'trust_evidence_repaired', 'tasks_reattributed', n)
  );
end $$;
