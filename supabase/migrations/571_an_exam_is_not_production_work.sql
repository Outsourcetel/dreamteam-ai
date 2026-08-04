-- 571 — a certification exam is not production work.
--
-- FOUND BY WATCHING AUTO-SEND DIE TEN MINUTES AFTER IT WAS GRANTED. The
-- reply-mode gate cron demoted Technical Support back to draft:
--     "degraded 8-week metrics (escalation 97%, errors 0%)"
-- That was the governance machinery working — and reading a poisoned number.
--
-- All 57 decisions in the employee's 8-week record were from TODAY, and 54 of
-- them were its own certification exams. Exams run the LIVE pipeline
-- deliberately (replay would skip the platform knowledge shelf, the grounded
-- gate and the pre-send auditor, so a replayed exam would grade a weaker
-- pipeline than the one serving customers), which means their decisions land in
-- the evidence spine as source='live_channel' — indistinguishable from customer
-- work.
--
-- THE TRAP THAT CREATES, which is the real defect:
--     dial off  →  confidenceFloor 101  →  every answer escalates
--                                       →  exam history shows ~98% escalation
--     grant auto-send  →  gate reads that history  →  demotes  →  dial off
-- The employee can never earn autonomy, because the evidence of unworthiness is
-- manufactured by not having it. Same family as the eval-gate publish deadlock
-- (failing evals block the publishes that would fix them) and the denied-access
-- confidence penalty (punishing least-privilege). A metric that measures the
-- test instead of the work will always close a loop like this.
--
-- THE FIX uses the channel introduced in 570: decisions and runs traceable to an
-- 'exam' thread no longer count toward performance. What does NOT change: the
-- exam still runs live, its results still certify, and its threads still exist
-- as evidence. Only their claim to be PRODUCTION EVIDENCE is withdrawn.
--
-- Function body reproduced from the LIVE definition; only the two evidence CTEs
-- differ. Same signature, so this replaces rather than adding an overload.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_de_performance_metrics(p_tenant_id uuid, p_weeks integer DEFAULT 26)
 RETURNS TABLE(de_id uuid, de_name text, total_decisions bigint, resolution_rate numeric, avg_confidence numeric, escalation_rate numeric, blocked_guardrail_count bigint, total_runs bigint, error_rate numeric, avg_frustration_score numeric, high_frustration_count bigint, trend jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.role() is not null and auth.role() <> 'service_role' then
    if auth.uid() is null then
      raise exception 'not authenticated';
    end if;
    if not (
      is_platform_admin()
      or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = p_tenant_id)
    ) then
      raise exception 'not authorized to view this workspace''s performance data';
    end if;
  end if;

  return query
    with decisions as (
      select er.de_id as d_de_id, d.confidence as d_confidence, d.decision as d_decision,
        d.human_task_id as d_human_task_id, d.created_at as d_created_at,
        d.frustration_score as d_frustration_score
      from evidence_run_decisions d
      join evidence_runs er on er.id = d.evidence_run_id
      -- CASE, not a bare cast: external_ref is free text, and Postgres does not
      -- promise to evaluate a regex guard before a cast in the same predicate.
      left join de_conversations conv
        on conv.id = (case when d.external_ref ~ '^conversation:[0-9a-fA-F-]{36}$'
                           then substring(d.external_ref from 14)::uuid end)
      where er.tenant_id = p_tenant_id and er.de_id is not null
        -- p_weeks now means what it says. Without this the "fresh 4-week
        -- re-measure" behind every PIP verdict read the employee's whole life.
        and d.created_at > now() - (greatest(1, p_weeks) || ' weeks')::interval
        -- A CERTIFICATION EXAM IS NOT PRODUCTION WORK (mig 571). Exams run the
        -- real pipeline on purpose, so their decisions land here as
        -- source='live_channel', indistinguishable from customer work. Counting
        -- them made the employee's own exams its performance record — measured
        -- live: 54 of 57 decisions were exam answers, giving a 98% escalation
        -- rate that the reply-mode gate then used to DEMOTE it minutes after
        -- auto-send was granted. Exams also escalate by construction while the
        -- employee is gated, so the evidence of unworthiness was manufactured by
        -- the very state it justified. Threads filed under channel 'exam'
        -- (mig 570) are excluded; a decision with no traceable thread is KEPT,
        -- because unknown provenance must not silently erase real work.
        and conv.channel is distinct from 'exam'
    ),
    runs as (
      select er.de_id as r_de_id, er.status as r_status
      from evidence_runs er
      where er.tenant_id = p_tenant_id and er.de_id is not null
        and er.created_at > now() - (greatest(1, p_weeks) || ' weeks')::interval
        -- error_rate feeds the SAME demotion gate, so exam runs come out here
        -- too. An exam run is judged by the exam's own pass/fail, not twice.
        and not exists (
          select 1 from evidence_run_decisions d2
          join de_conversations c2
            on c2.id = (case when d2.external_ref ~ '^conversation:[0-9a-fA-F-]{36}$'
                             then substring(d2.external_ref from 14)::uuid end)
          where d2.evidence_run_id = er.id and c2.channel = 'exam')
    ),
    summary as (
      select
        dec.d_de_id as s_de_id,
        count(*) as total_decisions,
        round(100.0 * count(*) filter (where dec.d_decision <> 'needs_review') / nullif(count(*), 0), 1) as resolution_rate,
        round(avg(dec.d_confidence) filter (where dec.d_confidence is not null), 1) as avg_confidence,
        round(100.0 * count(*) filter (where dec.d_decision = 'needs_review') / nullif(count(*), 0), 1) as escalation_rate,
        count(*) filter (where dec.d_decision = 'blocked_guardrail') as blocked_guardrail_count,
        round(avg(dec.d_frustration_score) filter (where dec.d_frustration_score is not null), 1) as avg_frustration_score,
        count(*) filter (where dec.d_frustration_score >= 50) as high_frustration_count
      from decisions dec
      group by dec.d_de_id
    ),
    run_summary as (
      select r.r_de_id as rs_de_id, count(*) as total_runs,
        round(100.0 * count(*) filter (where r.r_status = 'failed') / nullif(count(*), 0), 1) as error_rate
      from runs r
      group by r.r_de_id
    ),
    weekly as (
      select
        dec.d_de_id as w_de_id,
        date_trunc('week', dec.d_created_at) as week_start,
        count(*) as decisions_count,
        round(100.0 * count(*) filter (where dec.d_decision <> 'needs_review') / nullif(count(*), 0), 1) as week_resolution_rate,
        round(avg(dec.d_confidence) filter (where dec.d_confidence is not null), 1) as week_avg_confidence
      from decisions dec
      where dec.d_created_at > now() - (p_weeks || ' weeks')::interval
      group by dec.d_de_id, date_trunc('week', dec.d_created_at)
    ),
    trend_agg as (
      select w.w_de_id as t_de_id, jsonb_agg(
        jsonb_build_object(
          'week', to_char(w.week_start, 'YYYY-MM-DD'),
          'decisions', w.decisions_count,
          'resolution_rate', w.week_resolution_rate,
          'avg_confidence', w.week_avg_confidence
        ) order by w.week_start
      ) as trend
      from weekly w
      group by w.w_de_id
    )
    select
      de.id, de.name,
      -- COUNTS stay coalesced: an employee that made no decisions genuinely
      -- made zero, and "no data" would be the lie in the other direction.
      coalesce(s.total_decisions, 0),
      -- RATES are no longer invented. NULL means "not measured", which is the
      -- truth for every employee whose work never produced this evidence.
      s.resolution_rate,
      s.avg_confidence,
      s.escalation_rate,
      coalesce(s.blocked_guardrail_count, 0),
      coalesce(rs.total_runs, 0),
      -- NULL only when there were no runs at all; a computed 0.0 over real
      -- runs is a true zero and survives.
      rs.error_rate,
      s.avg_frustration_score,
      coalesce(s.high_frustration_count, 0),
      coalesce(t.trend, '[]'::jsonb)
    from digital_employees de
    left join summary s on s.s_de_id = de.id
    left join run_summary rs on rs.rs_de_id = de.id
    left join trend_agg t on t.t_de_id = de.id
    where de.tenant_id = p_tenant_id
      -- DE scoping (mig 385/435), REPAIRED by mig 454. The trusted-server test
      -- MIRRORS this function's own membership gate at the top of the body;
      -- 435 omitted it, so pg_cron — direct connection, no JWT, auth.role()
      -- NULL — failed the guard for every employee and four jobs read nothing.
      and (auth.role() is null
           or auth.role() = 'service_role'
           or public.can_access_de(de.id))
    order by de.name;
end;
$function$
;

-- ── Asserts ────────────────────────────────────────────────────────────────
DO $probe$
DECLARE
  v_tenant uuid := '5bb802e1-8e92-4eef-9a7a-ac348785d43f';
  v_de     uuid := '7c6a2668-1587-4d7a-a1eb-01da95e0a672';
  v_total  bigint;
  v_esc    numeric;
  v_n      int;
BEGIN
  -- N1: the employee's exam answers no longer count as its work. Before this
  -- migration: 57 decisions at ~98% escalation. After: only the handful that
  -- are traceable to a real thread.
  SELECT m.total_decisions, m.escalation_rate INTO v_total, v_esc
    FROM get_de_performance_metrics(v_tenant, 8) m WHERE m.de_id = v_de;
  IF v_total >= 50 THEN
    RAISE EXCEPTION 'N1 FAILED: still % decisions — exam evidence was not excluded', v_total;
  END IF;

  -- N2: THE ONE THAT MATTERS. With exams excluded the employee falls under the
  -- gate's own 10-decision floor, so the demotion cannot fire on a record made
  -- entirely of tests. If this ever passes with >= 10 decisions AND > 50%
  -- escalation, the trap is still live.
  IF v_total >= 10 AND coalesce(v_esc, 0) > 50 THEN
    RAISE EXCEPTION 'N2 FAILED: % decisions at %%% escalation would still demote', v_total, v_esc;
  END IF;

  -- N3: real work is NOT erased. A decision with no traceable conversation is
  -- kept, so an over-broad exclusion would show up as zero here.
  SELECT count(*) INTO v_n
    FROM evidence_run_decisions d
    JOIN evidence_runs er ON er.id = d.evidence_run_id
    WHERE er.tenant_id = v_tenant AND er.de_id = v_de
      AND d.created_at > now() - interval '8 weeks';
  IF v_n < 50 THEN
    RAISE EXCEPTION 'N3 FAILED: only % raw decisions remain — the migration DELETED evidence, it must only stop counting it', v_n;
  END IF;

  -- N4: one signature (the 562 lesson).
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_de_performance_metrics';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'N4 FAILED: % overloads', v_n;
  END IF;

  RAISE NOTICE '571 asserts passed: exams no longer count as production; raw evidence intact.';
END
$probe$;

COMMIT;
