-- 832_a_success_the_system_can_verify.sql
-- ============================================================================
-- Task 5 of 7, trust-promotion program (plan: 2026-08-21-trust-promotion).
--
-- FOUNDER DECISION 1, 2026-08-21: what counts as proof an employee earned a
-- looser limit is "human approvals OR system-corroborated correctness".
-- FOUNDER DECISION 2: where an employee's corroboration signals come from is
-- "the role archetype declares them".
--
-- Migration 819 landed the negative half: a REFUSAL the system can corroborate
-- is evidence. This lands the positive half. Migration 831 landed the
-- declaration (role_archetypes.trust_signals) and its reader
-- (declared_trust_signals); this is the first thing that counts anything.
--
-- ── THE SIGNAL INTERFACE, DECIDED HERE ───────────────────────────────────────
-- The plan is explicit that the shape of a signal is settled by this migration
-- and becomes an interface Task 7's real declarations must speak. It is:
--
--   TABLE      public.de_system_verifications  (migration 221, described in
--              its own words as "the verify audit trail -- proof the DE came
--              back and checked its own work")
--   NAMED BY   de_system_verifications.system_key. A role declares a signal by
--              putting that exact string in
--              role_archetypes.trust_signals -> <action_category>, e.g.
--                {"action_execute": ["invoices", "ledger"]}
--              and the platform reads it through declared_trust_signals(uuid).
--   SUBJECT    de_system_verifications.entity_ref -- what was checked. This is
--              the unit of evidence and the anti-farming key.
--   PREDICATE  matched = true, over a NON-EMPTY expectation.
--
-- A role can only declare a system_key it actually has: the same
-- role_archetypes catalog already carries system_templates, and
-- install_role_systems stamps those keys onto de_connected_systems at hire.
-- So the vocabulary a role declares here is the vocabulary the platform can
-- already evaluate -- which is the whole point of naming the shape rather than
-- leaving Task 7 free to invent one the platform cannot read.
--
-- ── WHY NOT THE OBVIOUS SOURCE ───────────────────────────────────────────────
-- de_work_items.status = 'done' was the first candidate and was REJECTED after
-- reading the writer. 819's first load-bearing guard is "it cannot be
-- self-asserted", and a work item is marked done from a tool the MODEL calls:
-- supabase/functions/de-work/index.ts, "if (out.done) { done = true; ... }",
-- then complete_de_work_item(p_status => finalStatus). An employee could farm
-- trust by declaring itself finished. de_system_verifications cannot be farmed
-- that way: verify_de_system takes only the employee's EXPECTATION, fetches
-- "actual" by re-reading the system of record through read_de_system, and
-- computes "matched" itself. The employee cannot make the system of record
-- agree with it; it can only find out whether it does.
--
-- ── WHAT THIS MIGRATION DELIBERATELY DOES NOT DO ─────────────────────────────
-- It does NOT add a second counter. The spec's boxed warning in section 3.2 is
-- explicit: machine evidence already satisfies the counter named
-- min_human_samples -- v_h_corrob has been summed into it since 819 -- and a
-- second machine-only counter beside it is a divergence this repo has already
-- paid to unpick. So v_h_success folds into exactly the same places
-- v_h_corrob folds into, and nothing else moves. It also does NOT introduce a
-- min_decided_by_human floor: that option is named in the spec and explicitly
-- NOT taken, because the founder's ruling was OR, not AND.
--
-- It does NOT populate trust_signals for any role. All 15 active role
-- archetypes still declare nothing after this runs -- measured, not assumed --
-- so corroborated_successes is 0 for every one of today's 58 trust policies
-- and NOT ONE policy's eligibility changes. PROBE A below proves that by
-- comparing the old function's verdict against the new one's, policy by
-- policy, inside this transaction. Seeding a real role is Task 7 and needs the
-- founder to say what a step means first.
--
-- ── NEVER HARDCODE A DEPARTMENT ──────────────────────────────────────────────
-- Nothing here names Billing, Support, or any role by business meaning, and
-- the counting query has no branch on which role it is looking at. It reads
-- one declared list, through one reader, keyed only by the action_category the
-- policy already carries. The fixtures in the proof are prefixed
-- 'zz_probe_832_' precisely so none of them could ever be mistaken for a real
-- declaration; all are created and deleted inside this one transaction.
--
-- ── KNOWN LIMIT, STATED RATHER THAN PAPERED OVER ─────────────────────────────
-- Migration 682's production-vs-exam filter (evidence_is_production) is applied
-- to every other evidence source in trust_evidence_for. It is NOT applied to
-- this one, because de_system_verifications has no origin column to apply it
-- to. That is not a hole today: the only writer is verify_de_system, and its
-- only caller anywhere in this repository is the de-work production loop's
-- verify_system tool (grepped across supabase/functions and src, and no SQL
-- routine references it). It becomes a hole the day an exam or simulation path
-- is given that tool, and the fix then is an origin column on that table --
-- not a filter invented here over a column that does not exist.
--
-- Also unchanged, and worth flagging to whoever builds the evidence card: the
-- human_approval_rate DETAIL line still speaks only of decided reviews, so a
-- policy with corroborated evidence and no decided reviews reads "no reviews
-- decided" beside a non-zero rate. That was already true of 819's corroborated
-- refusals; the spec's answer is to correct the LABEL where it surfaces to a
-- customer, which is Task 6's surface, not a second redefinition here.
--
-- ── PRECONDITION ─────────────────────────────────────────────────────────────
-- Requires migration 831 (declared_trust_signals). Migrations replay in
-- filename order so 831 always precedes this on a rebuild; the guard below
-- turns a wrong APPLY order into one named refusal instead of a function that
-- installs cleanly and then raises 42883 on every eligibility check.
-- ============================================================================

begin;

-- ── precondition, asserted about SCHEMA (true wherever this replays) ─────────
do $precheck$
begin
  if to_regprocedure('public.declared_trust_signals(uuid)') is null then
    -- errcode is deliberate, not decoration. audit-migration-replayability
    -- classifies a dry-run failure by SQLSTATE: P0001 means "this migration
    -- asserted on data the environment lacks" (the defect that gate exists to
    -- stop) while 42883 means "a dependency is missing here" (not the
    -- author's doing, reported as NOT PROVEN rather than as a pass). A missing
    -- declared_trust_signals is literally an undefined function, so raising
    -- P0001 here would accuse this file of a defect it does not have. Saying
    -- 42883 in plain words keeps the legible message AND the honest class.
    raise exception 'PRECONDITION FAILED: public.declared_trust_signals(uuid) does not exist -- migration 831 has not been applied. Apply 831 first; without it the counting arm below raises 42883 on every call to trust_evidence_for.'
      using errcode = 'undefined_function';
  end if;
end
$precheck$;

-- ── THE REGRESSION CONTROL, captured BEFORE the function is replaced ─────────
-- The strongest control available for this change: the feature is inert until
-- a role declares something, so applying it must leave every existing policy's
-- verdict exactly as it was. This snapshot is taken with the SHIPPED function
-- still in place; PROBE A re-reads the same policies through the NEW one and
-- compares, id by id. now() is transaction time, so both reads see the same
-- evidence window and the comparison is not racing the clock.
create temp table zz_tef_baseline_832 on commit drop as
select p.id as policy_id,
       coalesce((public.trust_evidence_for(p)->>'eligible')::boolean, false) as eligible
  from public.trust_policies p;


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
  -- mig 815: how many reviews are WAITING. Not evidence, and deliberately
  -- not part of any threshold — it is the difference between "this employee
  -- has shown nothing" and "nobody has looked at what it showed".
  v_h_pending    bigint := 0;
  -- mig 819: refusals the SYSTEM can corroborate, counted by distinct cause.
  v_h_corrob     bigint := 0;
  -- mig 832: SUCCESSES the system can corroborate — the positive half of 819,
  -- counted by distinct subject, from the signals the ROLE declared. Folded
  -- into the SAME counter as v_h_corrob; deliberately not a second counter.
  v_h_success    bigint := 0;
  -- The role's declaration, read ONCE per call. Mig 831 guarantees a jsonb
  -- array (never SQL NULL, never a scalar); if that contract ever breaks this
  -- raises loudly rather than coalescing to a silent zero, because a silent
  -- zero here is indistinguishable from "the employee earned nothing".
  v_signals      jsonb := '[]'::jsonb;
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

  -- mig 815: the same population, still undecided. Same tenant, same window
  -- start, same production-origin filter — so this number is comparable with
  -- v_h_total rather than being a different question with a similar name.
  -- Deliberately NOT scoped by the per-category CASE below: a workspace that
  -- has not decided anything has not decided anything, and narrowing this to
  -- one category would under-report the reason the sample size is zero.
  select count(*) into v_h_pending
    from human_tasks
   where tenant_id = p_policy.tenant_id
     and status = 'pending'
     and evidence_is_production(origin)
     and (p_policy.de_id is null or de_id = p_policy.de_id);

  -- mig 819: A REFUSAL THE SYSTEM CAN CORROBORATE IS EVIDENCE.
  --
  -- An employee that declines to act because its source is unreadable, when
  -- the platform independently knows that source is dead, has demonstrated
  -- exactly the judgment this ladder exists to reward — and it demonstrated
  -- it without anyone deciding anything.
  --
  -- ⛔ TWO GUARDS, AND BOTH ARE LOad-BEARING:
  --
  -- 1. IT CANNOT BE SELF-ASSERTED. The corroboration is the connector circuit
  --    being open — >= 10 failures with a recent error. An employee cannot
  --    make an integration fail; it can only notice that it has.
  --
  -- 2. DISTINCT CAUSE, NOT ROWS. Accounting DE holds 17 blocked_input
  --    escalations about ONE dead connector. Counting rows would let a single
  --    outage buy a promotion, which is trust farming with extra steps.
  --    Counting distinct blocker_scope gives 1: it was right about one thing,
  --    repeatedly, which is one piece of evidence.
  select count(distinct t.blocker_scope) into v_h_corrob
    from human_tasks t
   where t.tenant_id = p_policy.tenant_id
     and t.type = 'escalation'
     and 'blocked_input' = any(t.blocker_signature)
     and t.created_at >= v_since
     and evidence_is_production(t.origin)
     and (p_policy.de_id is null or t.de_id = p_policy.de_id)
     and exists (select 1 from connectors c
                  where c.tenant_id = t.tenant_id
                    and public.connector_circuit_open(c.consecutive_failures, c.last_error_at));

  -- mig 832: A SUCCESS THE SYSTEM CAN VERIFY.
  --
  -- The symmetric counterpart to 819 above. 819 credits a refusal the platform
  -- could independently confirm; this credits a piece of work the platform
  -- went and re-read in the system of record and found to be as the employee
  -- said it would be.
  --
  -- ── THE SIGNAL INTERFACE (decided here, and now binding on Task 7) ────────
  --   table      public.de_system_verifications  (mig 221 — "the verify audit
  --              trail: proof the DE came back and checked its own work")
  --   named by   de_system_verifications.system_key — the exact string a role
  --              lists in role_archetypes.trust_signals -> <action_category>,
  --              read through public.declared_trust_signals (mig 831)
  --   subject    de_system_verifications.entity_ref — the anti-farming key
  --   predicate  matched = true, over a NON-EMPTY expectation
  --
  -- ── WHY THIS TABLE AND NOT THE EMPLOYEE'S OWN WORD ────────────────────────
  -- 819's first load-bearing guard is "it cannot be self-asserted". The
  -- obvious source — de_work_items.status = 'done' — fails that test: the
  -- runner sets it from a tool the MODEL calls (de-work/index.ts, "if
  -- (out.done)"), so an employee could farm trust by declaring itself
  -- finished. de_system_verifications cannot be farmed the same way: the
  -- employee supplies only the EXPECTATION, and "actual" is read back out of
  -- the system of record by read_de_system inside verify_de_system. "matched"
  -- is the platform's comparison of the two, not the employee's claim.
  --
  -- ── THE THREE GUARDS ──────────────────────────────────────────────────────
  -- 1. ONLY WHAT THE ROLE DECLARED. system_key must appear in this role's
  --    declaration for this action category. A role that declares nothing
  --    earns nothing here — which is every one of the 15 active roles on the
  --    day this shipped, and is why applying this changes no eligibility.
  -- 2. A VACUOUS CHECK EARNS NOTHING. verify_de_system computes "matched" by
  --    looping over jsonb_object_keys(p_expectation), so an EMPTY expectation
  --    matches vacuously — and empty is reachable: de-work passes
  --    "input.expectation ?? {}" straight through from the model. Verifying
  --    nothing at all is not evidence of anything, so "{}" is excluded.
  -- 3. DISTINCT SUBJECT, NOT ROWS — 819's guard, applied identically. Checking
  --    one invoice seventeen times is one demonstration, not seventeen.
  --    Deliberately keyed on entity_ref ALONE rather than
  --    (system_key, entity_ref): the same entity confirmed in two declared
  --    systems collapses to one. That under-counts rather than over-counts,
  --    and under-counting only delays a promotion where over-counting would
  --    hand out authority nobody earned.
  --
  -- ── WHAT THIS DOES NOT CARRY, STATED PLAINLY ──────────────────────────────
  -- 682's production-vs-exam filter is applied to every other source in this
  -- function via evidence_is_production(...). It is NOT applied here, because
  -- de_system_verifications has no origin column to apply it to. That is not
  -- a hole TODAY: the sole writer is verify_de_system, whose sole caller in
  -- the whole repository is the de-work production loop's verify_system tool
  -- (grepped across supabase/functions and src, and no SQL routine calls it).
  -- It BECOMES a hole the day an exam or simulation path is given that tool,
  -- and the fix then is an origin column on the table, not a filter invented
  -- here over a column that does not exist.
  --
  -- A tenant-scoped policy (de_id IS NULL) always scores 0 here, and that is
  -- correct rather than an oversight: declared_trust_signals resolves a role
  -- through the policy's EMPLOYEE, so a policy with no employee has no role,
  -- and a policy with no role has declared nothing.
  v_signals := public.declared_trust_signals(p_policy.id);

  select count(distinct v.entity_ref) into v_h_success
    from de_system_verifications v
   where v.tenant_id = p_policy.tenant_id
     and v.created_at >= v_since
     and v.matched
     and jsonb_typeof(v.expectation) = 'object'
     and v.expectation <> '{}'::jsonb
     and (p_policy.de_id is null or v.de_id = p_policy.de_id)
     and exists (select 1 from jsonb_array_elements_text(v_signals) s(sig)
                  where s.sig = v.system_key);

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
      'actual', case when (v_h_total + v_h_corrob + v_h_success) = 0 then 0
                     else round((v_h_approved + v_h_corrob + v_h_success)::numeric / (v_h_total + v_h_corrob + v_h_success), 4) end,
      'required', v_min_h_rate,
      -- mig 819: corroborated refusals count on BOTH sides of the rate. A
      -- refusal the system confirmed is an observation, and it went the right
      -- way. Mixing them into the numerator only would inflate the rate; into
      -- the denominator only would punish an employee for being right.
      'met', (v_min_h_n = 0 or ((v_h_total + v_h_corrob + v_h_success) >= v_min_h_n
                                and (case when (v_h_total + v_h_corrob + v_h_success) = 0 then 0
                                          else round((v_h_approved + v_h_corrob + v_h_success)::numeric
                                                     / (v_h_total + v_h_corrob + v_h_success), 4) end) >= v_min_h_rate)),
      'detail', case
        -- A rate over zero observations is not 0%, it is absent. Reporting
        -- "0 of 0 approved" reads as an employee that scored nothing, which
        -- is the opposite of what is true when the reviews are simply
        -- sitting undecided.
        when v_h_total = 0 and v_h_pending > 0 then
          format('no reviews decided in the last %s days — %s awaiting a decision', v_window, v_h_pending)
        when v_h_total = 0 then
          format('no reviews decided in the last %s days, and none waiting', v_window)
        else format('%s of %s human reviews approved in the last %s days', v_h_approved, v_h_total, v_window)
      end),
    jsonb_build_object(
      'key', 'human_samples', 'label', 'Human review sample size',
      'actual', v_h_total + v_h_corrob + v_h_success, 'required', v_min_h_n,
      'met', (v_h_total + v_h_corrob + v_h_success) >= v_min_h_n,
      'detail', format('%s decided review(s) + %s corroborated refusal(s) + %s corroborated success(es) (needs %s)%s', v_h_total, v_h_corrob, v_h_success, v_min_h_n,
        case when v_h_pending > 0
             then format(' — %s awaiting a decision', v_h_pending)
             else '' end)),
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
    'pending_reviews', v_h_pending,
    'corroborated_refusals', v_h_corrob,
    'corroborated_successes', v_h_success,
    'criteria', v_criteria,
    -- 692: the door only shows green if it can actually open.
    'eligible', coalesce(v_eligible, false) and p_policy.current_level < v_ceiling and p_policy.status = 'active',
    'at_max_level', p_policy.current_level >= v_ceiling,
    'computed_at', now()
  );
end;
$function$;


-- ── proof ───────────────────────────────────────────────────────────────────
-- Every probe states its denominator. A sweep that compared nothing is NOT
-- counted as a check and says so in a named VACUITY notice instead -- zero
-- findings from zero comparisons looks exactly like a clean result.
-- NOTE: scripts/db-query.mjs does not surface RAISE NOTICE, so none of the
-- notices below are visible on a real apply. They exist for psql and for the
-- rollback-only dry run.
do $verify$
declare
  v_checks integer := 0;
  v_bad    text[]  := '{}';

  -- PROBE A / B -- the live population
  v_base_total      bigint := 0;
  v_base_eligible   bigint := 0;
  v_after_eligible  bigint := 0;
  v_flipped         bigint := 0;
  v_flip_example    uuid;
  v_live_absent     bigint := 0;
  v_live_nonzero    bigint := 0;
  v_nonzero_example uuid;

  -- PROBE C..F -- the fixture
  v_tenant_id       uuid;
  v_fixture_ran     boolean := false;
  v_role_declaring  text := 'zz_probe_832_declaring';
  v_role_silent     text := 'zz_probe_832_silent';
  v_category        text := 'zz_probe_832_category';
  v_sig_declared    text := 'zz_probe_832_system_declared';
  v_sig_undeclared  text := 'zz_probe_832_system_undeclared';
  v_de_declaring    uuid;
  v_de_silent       uuid;
  v_pol_declaring   uuid;
  v_pol_silent      uuid;

  v_ev              jsonb;
  v_before          bigint;
  v_after           bigint;
  v_samples_before  bigint;
  v_samples_after   bigint;
  v_detail          text;
  v_keys            text[];
  v_leftover        bigint := 0;
  v_window_start    timestamptz;
begin
  -- ══ PROBE A ── ⛔ THE REGRESSION CONTROL, AND THE MOST IMPORTANT ARM HERE.
  -- No role declares a signal, so no policy may gain or lose eligibility from
  -- this change. Checked as a SET, not a count: an equal number of eligible
  -- policies with a different membership is still a policy that was promoted
  -- or demoted by a migration that was supposed to be inert.
  select count(*) into v_base_total from zz_tef_baseline_832;

  if v_base_total = 0 then
    raise notice '832 VACUITY -- PROBE A and PROBE B compared ZERO policies: this database holds no trust_policies rows. True and honest on an empty or freshly rebuilt database, and NOT counted as a passing check. The fixture probes below (C-F) are unaffected -- they build their own data.';
  else
    v_checks := v_checks + 1;
    select count(*) filter (where b.eligible) into v_base_eligible from zz_tef_baseline_832 b;
    select count(*) filter (where coalesce((public.trust_evidence_for(p)->>'eligible')::boolean, false))
      into v_after_eligible
      from public.trust_policies p
      join zz_tef_baseline_832 b on b.policy_id = p.id;
    if v_after_eligible <> v_base_eligible then
      v_bad := array_append(v_bad, format(
        'PROBE A: %s of %s policies reported eligible BEFORE this migration and %s AFTER -- adding a counting arm nothing declares must not move the bar for anyone',
        v_base_eligible, v_base_total, v_after_eligible));
    end if;

    v_checks := v_checks + 1;
    select count(*), min(p.id::text)::uuid into v_flipped, v_flip_example
      from public.trust_policies p
      join zz_tef_baseline_832 b on b.policy_id = p.id
     where coalesce((public.trust_evidence_for(p)->>'eligible')::boolean, false) is distinct from b.eligible;
    if v_flipped > 0 then
      v_bad := array_append(v_bad, format(
        'PROBE A: %s of %s policies changed their eligibility verdict (e.g. policy %s) -- the same COUNT would have hidden this',
        v_flipped, v_base_total, v_flip_example));
    end if;

    -- ══ PROBE B -- the new number exists on every live policy, and is zero on
    -- every one of them, because nothing has been declared yet. Absence is
    -- checked separately from zero: a missing key reads as 0 through ->> and
    -- would otherwise pass as a clean result.
    v_checks := v_checks + 1;
    select count(*) filter (where (public.trust_evidence_for(p)->'corroborated_successes') is null),
           count(*) filter (where (public.trust_evidence_for(p)->'corroborated_successes') is not null
                             and coalesce((public.trust_evidence_for(p)->>'corroborated_successes')::bigint, -1) <> 0),
           (min(p.id::text) filter (where (public.trust_evidence_for(p)->'corroborated_successes') is not null
                                     and coalesce((public.trust_evidence_for(p)->>'corroborated_successes')::bigint, -1) <> 0))::uuid
      into v_live_absent, v_live_nonzero, v_nonzero_example
      from public.trust_policies p
      join zz_tef_baseline_832 b on b.policy_id = p.id;
    if v_live_absent > 0 then
      v_bad := array_append(v_bad, format(
        'PROBE B: corroborated_successes is absent from the evidence payload for %s of %s live policies',
        v_live_absent, v_base_total));
    end if;
    if v_live_nonzero > 0 then
      v_bad := array_append(v_bad, format(
        'PROBE B: %s of %s live policies scored a corroborated success (e.g. %s) while no role archetype declares any signal -- something is being counted that nobody asked for',
        v_live_nonzero, v_base_total, v_nonzero_example));
    end if;
  end if;

  -- ══ PROBE C..F -- the fixture. A counter that is 0 everywhere because the
  -- feature is off looks exactly like a counter that is 0 everywhere because
  -- it is broken, so the arm is exercised against a role that DOES declare a
  -- signal. Needs one tenant to hang throwaway employees off; on a database
  -- with none, every fixture probe is skipped and SAID SO.
  select id into v_tenant_id from public.tenants order by created_at limit 1;

  if v_tenant_id is null then
    raise notice '832 VACUITY -- PROBE C, D, E and F made ZERO comparisons: no tenant exists on this database to hang a throwaway employee off. The counting arm is therefore UNEXERCISED here and only PROBE A/B (data permitting) ran.';
  else
    v_fixture_ran := true;

    insert into public.role_archetypes (key, name, domain, trust_signals)
      values (v_role_declaring, 'zz probe 832 (declares a signal)', 'zz_probe_832',
              jsonb_build_object(v_category, jsonb_build_array(v_sig_declared)));
    -- The control role: identical in every way except that it declares
    -- nothing -- which is the state all 15 real roles are in today.
    insert into public.role_archetypes (key, name, domain, trust_signals)
      values (v_role_silent, 'zz probe 832 (declares nothing)', 'zz_probe_832', null);

    insert into public.digital_employees (tenant_id, name, archetype_key)
      values (v_tenant_id, 'zz probe 832 DE (declaring role)', v_role_declaring)
      returning id into v_de_declaring;
    insert into public.digital_employees (tenant_id, name, archetype_key)
      values (v_tenant_id, 'zz probe 832 DE (silent role)', v_role_silent)
      returning id into v_de_silent;

    insert into public.trust_policies (tenant_id, de_id, action_category)
      values (v_tenant_id, v_de_declaring, v_category)
      returning id into v_pol_declaring;
    insert into public.trust_policies (tenant_id, de_id, action_category)
      values (v_tenant_id, v_de_silent, v_category)
      returning id into v_pol_silent;

    select public.trust_evidence_for(p) into v_ev
      from public.trust_policies p where p.id = v_pol_declaring;
    v_window_start := now() - make_interval(days => (v_ev->>'window_days')::integer);

    -- ── PROBE C -- the payload carries the number, and it starts at zero.
    v_checks := v_checks + 1;
    if (v_ev->'corroborated_successes') is null then
      v_bad := array_append(v_bad, 'PROBE C: corroborated_successes is absent from the evidence payload');
    end if;
    v_before := coalesce((v_ev->>'corroborated_successes')::bigint, -1);
    select (c->>'actual')::bigint into v_samples_before
      from jsonb_array_elements(v_ev->'criteria') c where c->>'key' = 'human_samples';
    if v_before <> 0 then
      v_bad := array_append(v_bad, format(
        'PROBE C: a brand-new employee with no verifications at all scored %s corroborated success(es)', v_before));
    end if;

    -- ── PROBE C -- one verification of a DECLARED signal counts, exactly once.
    insert into public.de_system_verifications
      (tenant_id, de_id, system_key, entity_ref, expectation, actual, matched)
    values
      (v_tenant_id, v_de_declaring, v_sig_declared, 'zz_probe_832_entity_1',
       jsonb_build_object('status', 'settled'), jsonb_build_object('status', 'settled'), true);

    v_checks := v_checks + 1;
    select coalesce((public.trust_evidence_for(p)->>'corroborated_successes')::bigint, -1) into v_after
      from public.trust_policies p where p.id = v_pol_declaring;
    if v_after <> v_before + 1 then
      v_bad := array_append(v_bad, format(
        'PROBE C: corroborated_successes went %s -> %s after ONE matched verification of a declared signal, expected +1',
        v_before, v_after));
    end if;

    -- ── PROBE D -- five things that must NOT count. Asserted one at a time so
    -- a failure names WHICH guard stopped working rather than "still 1".
    -- Denominator: 5 comparisons, each against the count established above.

    -- D1: a signal the role did NOT declare. This is the arm that proves the
    -- declaration is actually read -- without it the platform would be
    -- crediting every verification any employee ever ran.
    insert into public.de_system_verifications
      (tenant_id, de_id, system_key, entity_ref, expectation, actual, matched)
    values
      (v_tenant_id, v_de_declaring, v_sig_undeclared, 'zz_probe_832_entity_2',
       jsonb_build_object('status', 'settled'), jsonb_build_object('status', 'settled'), true);
    v_checks := v_checks + 1;
    select coalesce((public.trust_evidence_for(p)->>'corroborated_successes')::bigint, -1) into v_after
      from public.trust_policies p where p.id = v_pol_declaring;
    if v_after <> v_before + 1 then
      v_bad := array_append(v_bad, format(
        'PROBE D1: a verification of a system_key the role never declared moved the count to %s (expected %s) -- the role archetype is not what decides this',
        v_after, v_before + 1));
    end if;

    -- D2: the system of record DISAGREED. A check that failed is not a success.
    insert into public.de_system_verifications
      (tenant_id, de_id, system_key, entity_ref, expectation, actual, matched)
    values
      (v_tenant_id, v_de_declaring, v_sig_declared, 'zz_probe_832_entity_3',
       jsonb_build_object('status', 'settled'), jsonb_build_object('status', 'overdue'), false);
    v_checks := v_checks + 1;
    select coalesce((public.trust_evidence_for(p)->>'corroborated_successes')::bigint, -1) into v_after
      from public.trust_policies p where p.id = v_pol_declaring;
    if v_after <> v_before + 1 then
      v_bad := array_append(v_bad, format(
        'PROBE D2: a verification with matched = false moved the count to %s (expected %s) -- a check the system of record failed is being counted as a success',
        v_after, v_before + 1));
    end if;

    -- D3: an EMPTY expectation. verify_de_system loops over the expectation's
    -- keys, so {} matches vacuously -- and de-work passes the model's
    -- expectation through as "input.expectation ?? {}", so this is reachable,
    -- not hypothetical. Verifying nothing must earn nothing.
    insert into public.de_system_verifications
      (tenant_id, de_id, system_key, entity_ref, expectation, actual, matched)
    values
      (v_tenant_id, v_de_declaring, v_sig_declared, 'zz_probe_832_entity_4',
       '{}'::jsonb, jsonb_build_object('status', 'settled'), true);
    v_checks := v_checks + 1;
    select coalesce((public.trust_evidence_for(p)->>'corroborated_successes')::bigint, -1) into v_after
      from public.trust_policies p where p.id = v_pol_declaring;
    if v_after <> v_before + 1 then
      v_bad := array_append(v_bad, format(
        'PROBE D3: a verification with an EMPTY expectation moved the count to %s (expected %s) -- checking nothing is being counted as evidence',
        v_after, v_before + 1));
    end if;

    -- D4: the SAME subject checked again. 819's anti-farming guard, applied
    -- identically: re-checking one entity seventeen times is one demonstration.
    insert into public.de_system_verifications
      (tenant_id, de_id, system_key, entity_ref, expectation, actual, matched)
    values
      (v_tenant_id, v_de_declaring, v_sig_declared, 'zz_probe_832_entity_1',
       jsonb_build_object('status', 'settled'), jsonb_build_object('status', 'settled'), true);
    v_checks := v_checks + 1;
    select coalesce((public.trust_evidence_for(p)->>'corroborated_successes')::bigint, -1) into v_after
      from public.trust_policies p where p.id = v_pol_declaring;
    if v_after <> v_before + 1 then
      v_bad := array_append(v_bad, format(
        'PROBE D4: re-checking the SAME entity_ref moved the count to %s (expected %s) -- it is counting rows, so one subject checked repeatedly would buy a promotion',
        v_after, v_before + 1));
    end if;

    -- D5: outside the evidence window. Same window as every other source in
    -- this function; discovered from the payload rather than assumed to be 30.
    insert into public.de_system_verifications
      (tenant_id, de_id, system_key, entity_ref, expectation, actual, matched, created_at)
    values
      (v_tenant_id, v_de_declaring, v_sig_declared, 'zz_probe_832_entity_5',
       jsonb_build_object('status', 'settled'), jsonb_build_object('status', 'settled'), true,
       v_window_start - interval '1 day');
    v_checks := v_checks + 1;
    select coalesce((public.trust_evidence_for(p)->>'corroborated_successes')::bigint, -1) into v_after
      from public.trust_policies p where p.id = v_pol_declaring;
    if v_after <> v_before + 1 then
      v_bad := array_append(v_bad, format(
        'PROBE D5: a verification from before the evidence window moved the count to %s (expected %s) -- old work is being counted as current evidence',
        v_after, v_before + 1));
    end if;

    -- ── PROBE E -- ⛔ THE SECOND CONTROL ON PROBE D. If the counter simply
    -- stopped moving, every arm of D would pass for the wrong reason. A
    -- SECOND distinct declared subject must take it to +2.
    insert into public.de_system_verifications
      (tenant_id, de_id, system_key, entity_ref, expectation, actual, matched)
    values
      (v_tenant_id, v_de_declaring, v_sig_declared, 'zz_probe_832_entity_6',
       jsonb_build_object('status', 'settled'), jsonb_build_object('status', 'settled'), true);
    v_checks := v_checks + 1;
    select public.trust_evidence_for(p) into v_ev
      from public.trust_policies p where p.id = v_pol_declaring;
    v_after := coalesce((v_ev->>'corroborated_successes')::bigint, -1);
    if v_after <> v_before + 2 then
      v_bad := array_append(v_bad, format(
        'PROBE E: CONTROL FAILED -- a SECOND distinct declared subject took the count to %s, expected %s. Every "must not count" arm in PROBE D above proves nothing if the counter has simply stopped moving',
        v_after, v_before + 2));
    end if;

    -- ── PROBE E -- the fold. The payload number is visibility; the COUNTER is
    -- what decides authority. min_human_samples must have moved by exactly the
    -- same delta -- asserted as a delta, never as an absolute, so this holds
    -- whatever else the fixture employee happens to have.
    v_checks := v_checks + 1;
    select (c->>'actual')::bigint into v_samples_after
      from jsonb_array_elements(v_ev->'criteria') c where c->>'key' = 'human_samples';
    if (v_samples_after - v_samples_before) <> (v_after - v_before) then
      v_bad := array_append(v_bad, format(
        'PROBE E: corroborated_successes rose by %s but the human_samples counter rose by %s -- the number is on the card without being folded into the bar it is supposed to satisfy',
        v_after - v_before, v_samples_after - v_samples_before));
    end if;

    -- ── PROBE E -- it says so in words, the way 819 does.
    v_checks := v_checks + 1;
    select c->>'detail' into v_detail
      from jsonb_array_elements(v_ev->'criteria') c where c->>'key' = 'human_samples';
    if v_detail !~ 'corroborated success' then
      v_bad := array_append(v_bad, format(
        'PROBE E: the sample-size line does not mention corroborated successes: %s', v_detail));
    end if;
    if v_detail !~ 'corroborated refusal' then
      v_bad := array_append(v_bad, format(
        'PROBE E: 819''s corroborated refusals were dropped from the sample-size line: %s', v_detail));
    end if;

    -- ── PROBE E -- ONE counter, not two. The spec's boxed warning forbids a
    -- second machine-only counter beside min_human_samples and forbids a
    -- min_decided_by_human floor. Pinned as an exact set so an added criterion
    -- cannot slip past.
    v_checks := v_checks + 1;
    select array_agg(c->>'key' order by c->>'key') into v_keys
      from jsonb_array_elements(v_ev->'criteria') c;
    if v_keys is distinct from array['eval_pass_rate','eval_samples','guardrail_blocks','human_approval_rate','human_samples']::text[] then
      v_bad := array_append(v_bad, format(
        'PROBE E: the criteria list is now %s -- a counter was added or removed. Corroborated successes fold into min_human_samples; a second counter beside it is the divergence this repo has already paid to unpick',
        v_keys::text));
    end if;

    -- ── PROBE F -- ⛔ THE DECLARATION IS WHAT DECIDES. The silent role's
    -- employee is given the SAME evidence -- same tenant, same declared-by-the-
    -- other-role system_key, matched, non-empty expectation, inside the window
    -- -- and must still score zero, because its own role declared nothing.
    insert into public.de_system_verifications
      (tenant_id, de_id, system_key, entity_ref, expectation, actual, matched)
    values
      (v_tenant_id, v_de_silent, v_sig_declared, 'zz_probe_832_entity_7',
       jsonb_build_object('status', 'settled'), jsonb_build_object('status', 'settled'), true);
    v_checks := v_checks + 1;
    select coalesce((public.trust_evidence_for(p)->>'corroborated_successes')::bigint, -1) into v_after
      from public.trust_policies p where p.id = v_pol_silent;
    if v_after <> 0 then
      v_bad := array_append(v_bad, format(
        'PROBE F: an employee whose role declares NO signals scored %s corroborated success(es) -- corroboration is not coming from the declaration',
        v_after));
    end if;

    -- ── PROBE F -- and that same row must not leak into the declaring
    -- employee's count either.
    v_checks := v_checks + 1;
    select coalesce((public.trust_evidence_for(p)->>'corroborated_successes')::bigint, -1) into v_after
      from public.trust_policies p where p.id = v_pol_declaring;
    if v_after <> v_before + 2 then
      v_bad := array_append(v_bad, format(
        'PROBE F: another employee''s verification moved this policy''s count to %s (expected %s) -- one employee is being credited with another''s work',
        v_after, v_before + 2));
    end if;

    -- ── cleanup. Verifications FIRST: de_system_verifications.de_id is
    -- ON DELETE SET NULL, so deleting the employee first would strand probe
    -- rows with a null de_id -- and a null de_id is counted by every
    -- TENANT-scoped policy in this workspace.
    delete from public.de_system_verifications
     where de_id in (v_de_declaring, v_de_silent) or entity_ref like 'zz_probe_832_%';
    delete from public.trust_policies where id in (v_pol_declaring, v_pol_silent);
    delete from public.digital_employees where id in (v_de_declaring, v_de_silent);
    delete from public.role_archetypes where key in (v_role_declaring, v_role_silent);

    v_checks := v_checks + 1;
    select (select count(*) from public.de_system_verifications where entity_ref like 'zz_probe_832_%')
         + (select count(*) from public.role_archetypes where key like 'zz_probe_832_%')
         + (select count(*) from public.digital_employees where archetype_key like 'zz_probe_832_%')
      into v_leftover;
    if v_leftover > 0 then
      v_bad := array_append(v_bad, format(
        'PROBE F: %s probe fixture row(s) survived cleanup -- this migration would leave synthetic evidence behind in a real workspace', v_leftover));
    end if;
  end if;

  if array_length(v_bad, 1) > 0 then
    raise exception 'VERIFICATION FAILED (% finding(s) from % comparison(s)): %',
      array_length(v_bad, 1), v_checks, array_to_string(v_bad, ' | ');
  end if;

  if v_fixture_ran and v_base_total > 0 then
    raise notice '832: % comparisons, 0 findings -- FULL RUN. PROBE A/B swept % live trust_policies (% eligible before, % after, % flipped, % scoring a corroborated success). PROBE C-F exercised the counting arm on a throwaway role in tenant %, cleaned up. NOTE: db-query.mjs does not surface RAISE NOTICE -- this line is invisible on a real apply.',
      v_checks, v_base_total, v_base_eligible, v_after_eligible, v_flipped, v_live_nonzero, v_tenant_id;
  elsif v_fixture_ran then
    raise notice '832: % comparisons, 0 findings -- REDUCED RUN: no trust_policies rows on this database, so the regression control (PROBE A/B) compared nothing (see the VACUITY notice above). PROBE C-F exercised the counting arm on a throwaway role in tenant %. NOTE: db-query.mjs does not surface RAISE NOTICE -- this line is invisible on a real apply.',
      v_checks, v_tenant_id;
  else
    raise notice '832: % comparisons, 0 findings -- REDUCED RUN: no tenant on this database, so the counting arm itself was NEVER EXERCISED here (see the VACUITY notice above); only PROBE A/B over % live trust_policies ran. NOTE: db-query.mjs does not surface RAISE NOTICE -- this line is invisible on a real apply.',
      v_checks, v_base_total;
  end if;
end
$verify$;

commit;
