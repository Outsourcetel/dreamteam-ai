-- 585 — an unanswered question is not a wrong answer.
--
-- The trust ladder's eval criterion read 0.7765 against a 0.9 bar. Half of
-- that shortfall was the harness failing, not the employee working badly.
--
-- Of 59 item failures in the 30-day window for the attributed employee:
--   · 14 recorded "de-answer error: ai_budget_exceeded" — the AI spend cap cut
--     the run off and every REMAINING question was scored as a failed answer.
--     The employee was never asked them.
--   · 16 were phantom: two runs carried total=24 while recording only 16
--     results, so 8 items each counted as failures with no item behind them.
--   · 29 were genuine — an answer given and judged wrong.
--
-- Recording an outage as a wrong answer is the same defect class as an exam
-- that grades the test instead of the work: it permanently poisons the
-- evidence the trust ladder depends on, and it gets WORSE now that the AI
-- budget check fails closed (mig 7d0bcf3), because a database blip can now
-- also stop a run mid-flight.
--
-- HONEST ABOUT WHAT THIS DOES NOT DO: correcting both defects moves the rate
-- to 0.8761. That is still BELOW the 0.9 bar. The remaining 29 failures are
-- real, and the ladder SHOULD keep blocking promotion until the answers get
-- better. This migration makes the number true, not green.

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
  v_eval_skipped bigint := 0;
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
  -- Counted per ITEM from results, not from the run counters, and an item the
  -- employee never actually answered is not a wrong answer.
  --
  -- Two defects were inflating the failure count. Runs whose AI budget ran out
  -- mid-way recorded every remaining question as a FAILED ANSWER, reason
  -- "de-answer error: ai_budget_exceeded" — the employee was never asked. And
  -- two runs carried total=24 with only 16 recorded results, so 8 items each
  -- counted as failures with no item behind them at all. Together that is 30
  -- of 59 failures in the window: half the apparent quality problem was the
  -- harness, not the work.
  --
  -- This is NOT grading on a curve. Genuinely wrong answers still count in
  -- full and the bar has not moved. Questions that were never put to the
  -- employee simply leave the denominator, the way an exam paper that was
  -- never handed out is not a zero.
  select
    count(*) filter (where coalesce((x->>'passed')::boolean, false)
                        or coalesce(x->>'reason','') !~* '(budget|de-answer error|llm_|provider|timeout|unavailable|not_configured)'),
    count(*) filter (where coalesce((x->>'passed')::boolean, false))
    into v_eval_total, v_eval_passed
  from eval_runs r, jsonb_array_elements(coalesce(r.results, '[]'::jsonb)) x
  where r.tenant_id = p_policy.tenant_id
    and r.finished_at is not null
    and r.finished_at >= v_since
    and r.status in ('passed', 'failed')
    and (p_policy.de_id is null or r.de_id = p_policy.de_id);

  select count(*) into v_eval_skipped
  from eval_runs r, jsonb_array_elements(coalesce(r.results, '[]'::jsonb)) x
  where r.tenant_id = p_policy.tenant_id
    and r.finished_at is not null
    and r.finished_at >= v_since
    and r.status in ('passed', 'failed')
    and (p_policy.de_id is null or r.de_id = p_policy.de_id)
    and coalesce((x->>'passed')::boolean, false) = false
    and coalesce(x->>'reason','') ~* '(budget|de-answer error|llm_|provider|timeout|unavailable|not_configured)';
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
      'detail', format('%s of %s answered questions passed in the last %s days%s', v_eval_passed, v_eval_total, v_window,
        case when v_eval_skipped > 0
             then format(' (%s never put to the employee — e.g. the AI budget ran out mid-run — and excluded rather than counted wrong)', v_eval_skipped)
             else '' end)),
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
