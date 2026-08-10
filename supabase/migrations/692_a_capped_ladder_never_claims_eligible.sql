-- 692 — a capped ladder never claims eligible (G-F follow-up, honesty fix).
--
-- mig 458 made max_level the founder's per-policy ceiling and wired it into
-- apply_trust_promotion (least(current+1, max_level)) — but trust_evidence_for
-- still hardcodes 3: a policy sitting AT its cap (Bailey's billing ladder is
-- capped at 1 by founder decision D2) would show eligible:true while a
-- promotion request could only no-op at the cap. A green badge on a door that
-- doesn't open is a small lie, and this platform doesn't keep small lies.
--
-- Two expressions change; every criterion, threshold and evidence source is
-- mig 682's body VERBATIM:
--   eligible     … and current_level < least(3, coalesce(max_level, 3)) …
--   at_max_level … current_level >= least(3, coalesce(max_level, 3))

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
  -- 692: the ladder's true ceiling — founder's per-policy cap, hard-limited to 3.
  v_ceiling      integer := least(3, coalesce(p_policy.max_level, 3));
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
  -- 682: an exam-origin task is not evidence about production conduct —
  -- deciding an exam escalation must not move the autonomy dial.
  select count(*), count(*) filter (where status = 'approved')
    into v_h_total, v_h_approved
  from human_tasks
  where tenant_id = p_policy.tenant_id
    and status in ('approved', 'rejected')
    and decided_at is not null
    and decided_at >= v_since
    and evidence_is_production(origin)   -- 682
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
  -- 682: a block provoked by a marked exercise is the CONTROL being tested,
  -- not the employee misbehaving. Unmarked history ages out of the window;
  -- the chain itself is never edited.
  select count(*) into v_blocks
  from audit_events
  where tenant_id = p_policy.tenant_id
    and category = 'guardrail_block'
    and created_at >= v_since
    and evidence_is_production(detail->>'origin')   -- 682
    and (p_policy.de_id is null or detail->>'de_id' = p_policy.de_id::text);

  v_criteria := jsonb_build_array(
    jsonb_build_object(
      'key', 'eval_pass_rate', 'label', 'Evaluation pass rate',
      'actual', v_eval_rate, 'required', v_min_rate,
      -- Mirror of the human_approval_rate criterion two entries below, which
      -- already reads `v_min_h_n = 0 or (...)`. A policy that sets
      -- min_eval_samples = 0 is saying this employee is not examined on
      -- answering — Finance DE and Account Success DE execute actions, they do
      -- not staff an answer desk. Without this, zero samples produced a zero
      -- rate which failed a 0.9 bar FOREVER: an employee excused from the exam
      -- was permanently marked as having failed it.
      'met', (v_min_samples = 0 or (v_eval_total >= v_min_samples and v_eval_rate >= v_min_rate)),
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
    -- 692: the door only shows green if it can actually open.
    'eligible', coalesce(v_eligible, false) and p_policy.current_level < v_ceiling and p_policy.status = 'active',
    'at_max_level', p_policy.current_level >= v_ceiling,
    'computed_at', now()
  );
end;
$function$;

-- ── Prove it, in this transaction ──────────────────────────────────────────
do $$
declare
  v_t uuid; v_at_cap trust_policies; v_below trust_policies; v_r jsonb; v_ok text;
begin
  select id into v_t from tenants order by created_at limit 1;

  -- A policy AT its founder cap: never eligible, honestly at_max_level.
  insert into trust_policies (tenant_id, action_category, current_level, max_level,
                              criteria, display_name)
  values (v_t, 'action:probe-692-at-cap', 1, 1,
          '{"window_days":30,"min_eval_samples":0,"min_human_samples":0,"min_human_approval_rate":0,"max_guardrail_blocks":999999}'::jsonb,
          '692 probe — at cap')
  returning * into v_at_cap;
  v_r := trust_evidence_for(v_at_cap);
  if (v_r->>'eligible') <> 'false' then
    raise exception '692: a policy AT its cap still claims eligible: %', v_r;
  end if;
  if (v_r->>'at_max_level') <> 'true' then
    raise exception '692: a policy AT its cap does not report at_max_level';
  end if;

  -- The same trivially-satisfied criteria BELOW the cap: eligible (precision —
  -- the fix must not refuse everyone).
  insert into trust_policies (tenant_id, action_category, current_level, max_level,
                              criteria, display_name)
  values (v_t, 'action:probe-692-below-cap', 0, 1,
          '{"window_days":30,"min_eval_samples":0,"min_human_samples":0,"min_human_approval_rate":0,"max_guardrail_blocks":999999}'::jsonb,
          '692 probe — below cap')
  returning * into v_below;
  v_r := trust_evidence_for(v_below);
  if (v_r->>'eligible') <> 'true' then
    raise exception '692: a satisfiable policy below its cap is refused: %', v_r;
  end if;

  delete from trust_policies where id in (v_at_cap.id, v_below.id);

  -- Live precision: Morgan's earned eligibility survives the ceiling change.
  select trust_evidence_for(p)->>'eligible' into v_ok
    from trust_policies p
    join digital_employees d on d.id = p.de_id
    join tenants t on t.id = p.tenant_id
   where t.slug = 'outsourcetel-hq' and d.archetype_key = 'fpa'
     and p.action_category = 'action_execute' and p.status = 'active'
   limit 1;
  if v_ok is distinct from 'true' then
    raise exception '692: Morgan''s eligibility did not survive (got %)', v_ok;
  end if;
end $$;
