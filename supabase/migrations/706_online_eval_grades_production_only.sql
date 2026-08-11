-- 706 — the online-eval organ grades PRODUCTION, and its readers count only
-- what they can prove is production.
--
-- docs/51 offender #1 (founder-approved fix list, item 1). Live, measured
-- 2026-08-12, last 30 days: of 141 eval_judgments tagged source='online' —
-- the tag that MEANS "continuous production quality" —
--     38 are exam-channel answers (the sampler has no channel filter),
--     80 point at messages that NO LONGER EXIST (hq, 07-18..08-03 — the
--        message_id was persisted, the source rows were later deleted, so
--        nothing can prove what they graded),
--     23 resolve to real production messages (dock/hosted).
-- The platform's only continuous production-QA organ graded more exams than
-- production, and fed both the drift alerts and the Performance page's
-- judged_quality number.
--
-- THREE READS FIXED, ONE INTAKE FIXED. Past judgments are HISTORY — nothing
-- here deletes or rewrites a row. Contaminated rows are excluded at READ
-- time, by provability: a judgment counts as production only if its message
-- still exists and its conversation is not filed under the exam channel
-- (the axis mig 671 split the corpus on).
--
--   1. sample_messages_for_online_eval — stops sampling exam-channel
--      conversations at the source (mig 570/571/671 lineage). hq still holds
--      316 exam messages the old sampler would have kept grading.
--   2. de_eval_quality — the headline (n / avg / pass / fail that the drift
--      alert fires on) now counts provably-production online judgments only.
--      by_source keeps showing the whole labeled population.
--   3. get_benchmark_report.judged_quality — same provability rule. mig 682
--      excluded golden/simulation; the exam contamination entered LABELED
--      'online', under that fix's radar.
--   (4. intake — eval-judge now persists message_id atomically with the
--      judgment row instead of attaching it after the fact; shipped with the
--      de-eval-online/eval-judge edge functions beside this migration. The
--      after-the-fact UPDATE left a race window; the atomic insert closes it.)
--
-- Expected founder-visible change (measured before applying): hq 30-day
-- judged_quality falls from "118 graded, 89% pass" to "6 graded, 50% pass".
-- That drop is the fix working — the 118 was mostly exams and unprovable
-- orphans. Honest and small beats impressive and false.

BEGIN;

-- ── 1. The sampler: exam-channel answers are never production samples ──────
CREATE OR REPLACE FUNCTION public.sample_messages_for_online_eval(p_limit integer DEFAULT 5, p_window_minutes integer DEFAULT 90, p_tenant_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(message_id uuid, tenant_id uuid, de_id uuid, conversation_id uuid, question text, answer text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select m.id, m.tenant_id, c.de_id, m.conversation_id,
         -- the most recent customer turn before this answer
         (select um.content from de_messages um
           where um.conversation_id = m.conversation_id and um.role = 'user' and um.created_at <= m.created_at
           order by um.created_at desc limit 1) as question,
         m.content as answer
  from de_messages m
  join de_conversations c on c.id = m.conversation_id
  where m.role = 'assistant'
    and m.delivery = 'sent'                     -- only answers a customer actually received
    and not m.escalated
    -- mig 706: A CERTIFICATION EXAM IS NOT PRODUCTION WORK (571 lineage,
    -- on the channel axis 671 split the corpus by). Exams run the live
    -- pipeline on purpose and their answers are marked delivered, so without
    -- this line the "continuous production quality" organ grades the exam:
    -- measured 2026-08-12, 38 of 141 online judgments were exam answers.
    -- A null channel is KEPT — unknown provenance must not erase real work.
    and c.channel is distinct from 'exam'
    and m.created_at >= now() - make_interval(mins => greatest(5, p_window_minutes))
    and (p_tenant_id is null or m.tenant_id = p_tenant_id)
    and not exists (select 1 from eval_judgments j where j.message_id = m.id)
    and exists (select 1 from de_messages um where um.conversation_id = m.conversation_id and um.role = 'user' and um.created_at <= m.created_at)
  order by m.created_at desc
  limit greatest(1, least(50, p_limit));
$function$;

REVOKE ALL ON FUNCTION public.sample_messages_for_online_eval(integer, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sample_messages_for_online_eval(integer, integer, uuid) TO service_role;

-- ── 2. de_eval_quality: the headline the drift alert fires on ───────────────
-- Headline = provably-production online judgments ONLY. by_source still
-- shows every labeled source so nothing is hidden — it is the blended
-- headline that was the lie (it mixed golden + simulation + mislabeled
-- exams into "recent quality", and de-eval-online's drift alert read it).
CREATE OR REPLACE FUNCTION public.de_eval_quality(p_tenant_id uuid, p_de_id uuid, p_days integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with prod as (
    -- mig 706: count only what is PROVABLY production — the judgment links to
    -- a message that still exists, in a conversation not filed under the exam
    -- channel. Judgments whose source rows are gone (80 live rows, hq) cannot
    -- prove what they graded and are excluded at read time; they are not
    -- deleted or rewritten — they are history.
    select j.score, j.verdict
    from eval_judgments j
    join de_messages m on m.id = j.message_id
    join de_conversations c on c.id = m.conversation_id
    where j.tenant_id = p_tenant_id and j.de_id = p_de_id
      and j.source = 'online'
      and c.channel is distinct from 'exam'
      and j.created_at >= now() - make_interval(days => greatest(1, p_days))
  )
  select jsonb_build_object(
    'n', count(*),
    'avg_score', coalesce(round(avg(score)), 0),
    'pass_rate', coalesce(round(100.0 * count(*) filter (where verdict = 'pass') / nullif(count(*), 0)), 0),
    'fail_rate', coalesce(round(100.0 * count(*) filter (where verdict = 'fail') / nullif(count(*), 0)), 0),
    'headline_basis', 'production_online_only',
    'by_source', coalesce((select jsonb_object_agg(source, c) from
       (select source, count(*) c from eval_judgments
        where tenant_id = p_tenant_id and de_id = p_de_id
          and created_at >= now() - make_interval(days => greatest(1, p_days)) group by source) s), '{}'::jsonb)
  )
  from prod;
$function$;

REVOKE ALL ON FUNCTION public.de_eval_quality(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.de_eval_quality(uuid, uuid, integer) TO service_role;

-- ── 3. get_benchmark_report: judged_quality on the same provability rule ────
-- Body reproduced from the LIVE definition (read 2026-08-12); only the
-- judged_quality read and its written definition change.
CREATE OR REPLACE FUNCTION public.get_benchmark_report(p_tenant_id uuid, p_de_id uuid DEFAULT NULL::uuid, p_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_from timestamptz := now() - make_interval(days => greatest(1, least(365, p_days)));
  v_outcomes jsonb; v_quality jsonb; v_csat jsonb; v_cost jsonb; v_sim jsonb; v_review jsonb;
  v_res bigint; v_esc bigint; v_cost_cents numeric;
begin
  if auth.uid() is not null and not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = p_tenant_id)) then
    raise exception 'not authorized';
  end if;

  -- Billable resolutions only (a human-handled conversation is not an AI
  -- resolution); escalations and blocks all stay in the denominator.
  select count(*) filter (where kind = 'resolution' and billable),
         count(*) filter (where kind = 'escalation')
    into v_res, v_esc
    from billable_outcomes
   where tenant_id = p_tenant_id and occurred_at >= v_from
     and evidence_is_production(origin)   -- 682
     and (p_de_id is null or de_id = p_de_id);
  v_outcomes := jsonb_build_object(
    'resolutions', v_res, 'escalations', v_esc,
    'resolution_rate_pct', case when v_res + v_esc > 0 then round(100.0 * v_res / (v_res + v_esc), 1) end);

  -- mig 706: judged_quality counts PROVABLY-production online judgments only.
  -- 682 excluded golden/simulation at this reader; the remaining leak was
  -- upstream — the online sampler graded exam answers and they arrived here
  -- labeled 'online'. The proof standard is now positive: the judgment's
  -- message still exists and its conversation is not on the exam channel.
  select jsonb_build_object(
      'graded', count(*),
      'pass_rate_pct', case when count(*) > 0 then round(100.0 * count(*) filter (where j.verdict = 'pass') / count(*), 1) end,
      'avg_score', case when count(*) > 0 then round(avg(j.score), 1) end)
    into v_quality
    from eval_judgments j
    join de_messages m on m.id = j.message_id
    join de_conversations c on c.id = m.conversation_id
   where j.tenant_id = p_tenant_id and j.created_at >= v_from
     and j.source = 'online'
     and c.channel is distinct from 'exam'
     and (p_de_id is null or j.de_id = p_de_id);

  -- CSAT is a ±1 thumbs field: % positive is the honest statistic (an
  -- "average of 0.33" is meaningless to a reader).
  select jsonb_build_object(
      'ratings', count(*),
      'positive_pct', case when count(*) > 0 then round(100.0 * count(*) filter (where csat_score = 1) / count(*), 1) end)
    into v_csat
    from de_conversations
   where tenant_id = p_tenant_id and csat_submitted_at is not null and csat_submitted_at >= v_from
     and channel is distinct from 'exam'   -- 682
     and (p_de_id is null or de_id = p_de_id);

  select coalesce(sum(
      u.input_tokens  / 1000000.0 * coalesce(pr.input_price_per_million, 0) * 100
    + u.output_tokens / 1000000.0 * coalesce(pr.output_price_per_million, 0) * 100), 0)
    into v_cost_cents
    from de_token_usage u
    left join ai_model_pricing pr on pr.model_id = u.model_id
   where u.tenant_id = p_tenant_id and u.created_at >= v_from
     and evidence_is_production(u.origin)   -- 682
     and (p_de_id is null or u.de_id = p_de_id);
  v_cost := jsonb_build_object(
    'ai_spend_cents', round(v_cost_cents),
    'cost_per_resolution_cents', case when v_res > 0 then round(v_cost_cents / v_res) end);

  select jsonb_build_object('mode', mode, 'passed', passed, 'total', total,
                            'avg_score', avg_score, 'status', status, 'ran_at', started_at)
    into v_sim
    from sim_runs
   where tenant_id = p_tenant_id and candidate = false and status in ('passed', 'failed')
     and (p_de_id is null or de_id = p_de_id)
   order by started_at desc limit 1;

  -- 691 (G-D): the human side of the COGS, beside the AI side. Tenant-wide
  -- (the modeled minutes attribute per-DE inside the block itself).
  v_review := public.get_review_cost_internal(p_tenant_id, greatest(1, least(365, p_days)));

  return jsonb_build_object(
    'window_days', greatest(1, least(365, p_days)),
    'de_id', p_de_id,
    'generated_at', now(),
    'outcomes', v_outcomes,
    'judged_quality', v_quality,
    'csat', v_csat,
    'cost', v_cost,
    'human_review', v_review,
    'capability', coalesce(v_sim, jsonb_build_object('status', 'no_simulation_yet')),
    'definitions', jsonb_build_object(
      'resolution_rate_pct', 'Auto-sent, guardrail-clean answers that were NOT later handed to a human, as a share of ALL metered outcomes in the window — every escalation, hand-off, and guardrail block counts in the denominator. Certification-exam traffic is excluded from numerator and denominator alike (mig 682).',
      'judged_quality', 'Share of graded LIVE answers an independent LLM judge scored as passing on grounding, correctness, guardrail adherence, and tone. Counts only judgments provably tied to a delivered production message; certification, simulation, and exam-channel grades are excluded — they measure the exam, not the work (migs 682/706).',
      'csat', 'Percent of customer-submitted thumbs ratings that were positive. Never inferred or imputed.',
      'cost_per_resolution_cents', 'Real model spend on production traffic in the window divided by billable resolutions delivered.',
      'human_review', 'MODELED, not measured: decided review tasks × founder-editable standard minutes per decision type (exam-origin decisions excluded), divided by landed outputs. Dollars appear only when the workspace baseline (G-A) is on file.',
      'capability', 'Latest certification-grade simulation result. Dry-run (candidate) simulations are excluded, exactly as they are excluded from certification.'));
end;
$function$;

REVOKE ALL ON FUNCTION public.get_benchmark_report(uuid, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_benchmark_report(uuid, uuid, integer) TO authenticated, service_role;

-- ── Asserts ─────────────────────────────────────────────────────────────────
DO $probe$
DECLARE
  v_hq uuid := '5bb802e1-8e92-4eef-9a7a-ac348785d43f';
  v_n int; v_expect int; v_got int;
  v_pop int;
  v_de uuid;
  v_arms text := '';
BEGIN
  -- Drive functions as the trusted server would (auth.role() = service_role);
  -- transaction-local, gone at COMMIT.
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  -- S1 (structural, always): one signature each — the 562 lesson.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('sample_messages_for_online_eval', 'de_eval_quality', 'get_benchmark_report');
  IF v_n <> 3 THEN RAISE EXCEPTION 'S1 FAILED: % signatures across the 3 functions (want 3 — an overload survived)', v_n; END IF;

  -- S2 (structural, always): the EXECUTE perimeter (mig 610/630 discipline).
  IF has_function_privilege('anon', 'public.sample_messages_for_online_eval(integer, integer, uuid)', 'execute')
     OR has_function_privilege('authenticated', 'public.sample_messages_for_online_eval(integer, integer, uuid)', 'execute') THEN
    RAISE EXCEPTION 'S2 FAILED: sampler executable by the perimeter';
  END IF;
  IF has_function_privilege('anon', 'public.de_eval_quality(uuid, uuid, integer)', 'execute')
     OR has_function_privilege('authenticated', 'public.de_eval_quality(uuid, uuid, integer)', 'execute') THEN
    RAISE EXCEPTION 'S2 FAILED: de_eval_quality executable by the perimeter';
  END IF;
  IF has_function_privilege('anon', 'public.get_benchmark_report(uuid, uuid, integer)', 'execute')
     OR NOT has_function_privilege('authenticated', 'public.get_benchmark_report(uuid, uuid, integer)', 'execute')
     OR NOT has_function_privilege('service_role', 'public.get_benchmark_report(uuid, uuid, integer)', 'execute') THEN
    RAISE EXCEPTION 'S2 FAILED: get_benchmark_report perimeter wrong (want authenticated+service_role, never anon)';
  END IF;

  -- D1 (data, population-guarded): DRIVE the sampler over a window wide enough
  -- to cover every exam message. If unjudged, delivered exam answers exist —
  -- they do in production (hq holds 316 exam messages) — the sampler must
  -- return NONE of them. On an empty database this arm reports itself skipped
  -- rather than passing on zero comparisons.
  SELECT count(*) INTO v_pop
    FROM de_messages m JOIN de_conversations c ON c.id = m.conversation_id
   WHERE m.role = 'assistant' AND m.delivery = 'sent' AND NOT m.escalated
     AND c.channel = 'exam'
     AND m.created_at >= now() - interval '60 days'
     AND NOT EXISTS (SELECT 1 FROM eval_judgments j WHERE j.message_id = m.id)
     AND EXISTS (SELECT 1 FROM de_messages um WHERE um.conversation_id = m.conversation_id AND um.role = 'user' AND um.created_at <= m.created_at);
  IF v_pop > 0 THEN
    SELECT count(*) INTO v_n
      FROM public.sample_messages_for_online_eval(50, 86400, NULL) s
      JOIN de_conversations c ON c.id = s.conversation_id
     WHERE c.channel = 'exam';
    IF v_n > 0 THEN
      RAISE EXCEPTION 'D1 FAILED: sampler returned % exam-channel answers with % sampleable exam messages live', v_n, v_pop;
    END IF;
    v_arms := v_arms || format(' D1(pop=%s)', v_pop);
  ELSE
    v_arms := v_arms || ' D1(SKIPPED: no sampleable exam messages)';
  END IF;

  -- D2 (data, population-guarded): DRIVE de_eval_quality for the DE with the
  -- most online judgments and compare its headline n to an independent count
  -- of the provably-production population. Zero-comparison honesty: only runs
  -- where judgments exist.
  SELECT j.de_id INTO v_de FROM eval_judgments j
   WHERE j.tenant_id = v_hq AND j.source = 'online' AND j.de_id IS NOT NULL
   GROUP BY j.de_id ORDER BY count(*) DESC LIMIT 1;
  IF v_de IS NOT NULL THEN
    SELECT count(*) INTO v_expect
      FROM eval_judgments j
      JOIN de_messages m ON m.id = j.message_id
      JOIN de_conversations c ON c.id = m.conversation_id
     WHERE j.tenant_id = v_hq AND j.de_id = v_de AND j.source = 'online'
       AND c.channel IS DISTINCT FROM 'exam'
       AND j.created_at >= now() - interval '30 days';
    SELECT (public.de_eval_quality(v_hq, v_de, 30)->>'n')::int INTO v_got;
    IF v_got IS DISTINCT FROM v_expect THEN
      RAISE EXCEPTION 'D2 FAILED: de_eval_quality headline n=% but provably-production count=%', v_got, v_expect;
    END IF;
    -- The raw population must be UNTOUCHED: read-time filtering, never a
    -- rewrite. 30d online judgments for this tenant stay where they were.
    SELECT count(*) INTO v_n FROM eval_judgments
     WHERE tenant_id = v_hq AND source = 'online' AND created_at >= now() - interval '30 days';
    IF v_n < v_expect THEN
      RAISE EXCEPTION 'D2 FAILED: fewer raw judgments (%) than production ones (%) — history was deleted', v_n, v_expect;
    END IF;
    v_arms := v_arms || format(' D2(n=%s of %s raw)', v_got, v_n);
  ELSE
    v_arms := v_arms || ' D2(SKIPPED: no online judgments)';
  END IF;

  -- D3 (data, population-guarded): DRIVE get_benchmark_report and hold its
  -- judged_quality.graded to the same independent count, tenant-wide.
  IF EXISTS (SELECT 1 FROM tenants WHERE id = v_hq) THEN
    SELECT count(*) INTO v_expect
      FROM eval_judgments j
      JOIN de_messages m ON m.id = j.message_id
      JOIN de_conversations c ON c.id = m.conversation_id
     WHERE j.tenant_id = v_hq AND j.source = 'online'
       AND c.channel IS DISTINCT FROM 'exam'
       AND j.created_at >= now() - interval '30 days';
    SELECT (public.get_benchmark_report(v_hq, NULL, 30)->'judged_quality'->>'graded')::int INTO v_got;
    IF v_got IS DISTINCT FROM v_expect THEN
      RAISE EXCEPTION 'D3 FAILED: judged_quality.graded=% but provably-production count=%', v_got, v_expect;
    END IF;
    v_arms := v_arms || format(' D3(graded=%s)', v_got);
  ELSE
    v_arms := v_arms || ' D3(SKIPPED: hq tenant absent)';
  END IF;

  RAISE NOTICE '706 asserts passed:%', v_arms;
END
$probe$;

COMMIT;
