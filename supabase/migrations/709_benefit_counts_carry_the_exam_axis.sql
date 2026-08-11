-- 709 — every benefit-side count of conversations/decisions carries the exam
-- axis. Defuses the armed trap in get_de_economics (docs/51 fix 4) and the
-- two count-reads the widened ratchet sieve exposed.
--
-- THE TRAP (docs/51 organ #15, MEASURES-THE-EXAM, latent + partial-live):
-- get_de_economics turns counts × tenant-typed minutes into "Hours saved" /
-- FTE / ROI — the founder-facing ROI headline. Its benefit-side counts had
-- NO exam filter: hq's last 30 days read 160 conversations (158 exam) and
-- 91 decisions (75 exam), all counted as conversations_answered /
-- inquiries_handled — numbers LiveOutcomesPage and the Employee File already
-- display. hours_saved is NULL today only because no real tenant has typed
-- baselines in (workforce_baselines = 1 row, demo tenant 'sonic'). The day a
-- real tenant configures minutes, the headline is ~90% exam. This fixes the
-- reads BEFORE the trap can fire. The COST side stays deliberately
-- unfiltered: exam tokens are real dollars, and counting them keeps the
-- economics conservative (the 682 pin's reasoning, now carried in-body).
--
-- Same axis, same fix, two more count-reads (found by extending the
-- production-evidence ratchet sieve to conversation/decision count-reads —
-- the blind spot that let organs #13/#15/#16 slip past 682):
--   · get_de_inquiry_metrics — per-DE decision counts/rates on the founder's
--     OutcomeStatement (30-day range), no exam filter. The audit's census
--     MISSED this organ; the widened sieve caught it. Same defect as 571,
--     fourth instance.
--   · get_workforce_learning_digest volume block — SelfLearningPage reported
--     158 exam threads as workforce "conversations" (docs/51 ranked fix 5).
--     Volume line only; the quality trend heals upstream via mig 706.

BEGIN;

-- ── 1. get_de_economics: the benefit side goes production-only ──────────────
CREATE OR REPLACE FUNCTION public.get_de_economics(p_tenant_id uuid, p_de_id uuid DEFAULT NULL::uuid, p_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  b workforce_baselines;
  v_inquiries bigint;
  v_actions bigint;
  v_conversations bigint;
  v_de_cost numeric;
  v_human_minutes numeric := 0;
  v_counted boolean := false;
  v_missing text[] := '{}';
  v_fte numeric;
  v_human_cost numeric;
  v_roi numeric;
  v_savings numeric;
  v_std_minutes numeric;
begin
  if p_days < 1 or p_days > 365 then raise exception 'window must be 1-365 days'; end if;
  -- Same trusted-server/human gate as get_de_performance_metrics.
  if auth.role() is not null and auth.role() <> 'service_role' then
    if auth.uid() is null then raise exception 'not authenticated'; end if;
    if not (is_platform_admin()
            or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = p_tenant_id)) then
      raise exception 'not authorized to view this workspace''s economics';
    end if;
  end if;

  select * into b from workforce_baselines where tenant_id = p_tenant_id;

  -- Real work counts, windowed. mig 709: BENEFIT counts are production-only —
  -- these numbers get multiplied by tenant-typed minutes into the founder's
  -- "Hours saved" headline, and before this filter hq's window was 158-of-160
  -- conversations and 75-of-91 decisions certification-exam traffic. An exam
  -- is the control being tested, never work a human was saved from doing.
  select count(*) into v_inquiries
  from evidence_run_decisions d join evidence_runs er on er.id = d.evidence_run_id
  where er.tenant_id = p_tenant_id and er.de_id is not null
    and public.evidence_is_production(er.origin)
    and (p_de_id is null or er.de_id = p_de_id) and (er.de_id is null or public.can_access_de(er.de_id))
    and d.created_at > now() - make_interval(days => p_days);

  select count(*) into v_actions
  from action_executions
  where tenant_id = p_tenant_id and subject_kind = 'de' and mode = 'execute'
    and decision in ('auto_executed', 'executed_after_approval')
    and (p_de_id is null or subject_id = p_de_id) and (subject_id is null or public.can_access_de(subject_id))
    and created_at > now() - make_interval(days => p_days);

  select count(*) into v_conversations
  from de_conversations
  where tenant_id = p_tenant_id and de_id is not null
    and channel is distinct from 'exam'   -- mig 709, the 671 axis
    and (p_de_id is null or de_id = p_de_id) and (de_id is null or public.can_access_de(de_id))
    and created_at > now() - make_interval(days => p_days);

  -- Real AI cost, windowed (same pricing join as get_de_cost_metrics).
  -- mig 709: DELIBERATELY not exam-filtered. Exam tokens are real spend under
  -- the same budget cap; excluding them would flatter the economics. Filtering
  -- benefits and not costs is the conservative direction, on purpose.
  select coalesce(round(sum(
      (u.input_tokens::numeric / 1000000) * coalesce(pr.input_price_per_million, 3.00)
      + (u.output_tokens::numeric / 1000000) * coalesce(pr.output_price_per_million, 15.00)
    ), 4), 0) into v_de_cost
  from de_token_usage u
  left join ai_model_pricing pr on pr.model_id = u.model_id
  where u.tenant_id = p_tenant_id
    and (p_de_id is null or u.de_id = p_de_id) and (u.de_id is null or public.can_access_de(u.de_id))
    and u.created_at > now() - make_interval(days => p_days);

  -- Human-minutes over CONFIGURED task types only.
  if b.inquiry_minutes is not null then
    v_human_minutes := v_human_minutes + v_inquiries * b.inquiry_minutes; v_counted := true;
  elsif v_inquiries > 0 then v_missing := array_append(v_missing, 'inquiry_minutes'); end if;

  if b.action_minutes is not null then
    v_human_minutes := v_human_minutes + v_actions * b.action_minutes; v_counted := true;
  elsif v_actions > 0 then v_missing := array_append(v_missing, 'action_minutes'); end if;

  if b.conversation_minutes is not null then
    v_human_minutes := v_human_minutes + v_conversations * b.conversation_minutes; v_counted := true;
  elsif v_conversations > 0 then v_missing := array_append(v_missing, 'conversation_minutes'); end if;

  -- §12.3: 9,600 standard working minutes per month, prorated.
  v_std_minutes := 9600.0 * p_days / 30.0;
  if v_counted then
    v_fte := round(v_human_minutes / v_std_minutes, 3);
    if b.avg_fte_cost_monthly_usd is not null then
      v_human_cost := round(v_fte * b.avg_fte_cost_monthly_usd * p_days / 30.0, 2);
      v_savings := round(v_human_cost - v_de_cost, 2);
      if v_de_cost > 0 then
        v_roi := round((v_human_cost - v_de_cost) / v_de_cost, 1);
      end if;
    else
      v_missing := array_append(v_missing, 'avg_fte_cost_monthly_usd');
    end if;
  end if;

  return jsonb_build_object(
    'window_days', p_days,
    'counts', jsonb_build_object(
      'inquiries_handled', v_inquiries, 'actions_executed', v_actions, 'conversations_answered', v_conversations),
    'baselines', jsonb_build_object(
      'inquiry_minutes', b.inquiry_minutes, 'action_minutes', b.action_minutes,
      'conversation_minutes', b.conversation_minutes, 'avg_fte_cost_monthly_usd', b.avg_fte_cost_monthly_usd),
    'hours_saved', case when v_counted then round(v_human_minutes / 60.0, 1) end,
    'fte_equivalent', v_fte,
    'de_cost_usd', v_de_cost,
    'human_cost_equivalent_usd', v_human_cost,
    'monthly_saving_usd', case when v_savings is not null then round(v_savings * 30.0 / p_days, 2) end,
    'roi_ratio', v_roi,
    'unconfigured', to_jsonb(v_missing),
    'configured', v_counted and b.avg_fte_cost_monthly_usd is not null and array_length(v_missing, 1) is null
  );
end;
$function$;

REVOKE ALL ON FUNCTION public.get_de_economics(uuid, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_de_economics(uuid, uuid, integer) TO authenticated, service_role;

-- ── 2. get_de_inquiry_metrics: the 571 defect, fourth instance ──────────────
-- (Gate deliberately unchanged: mig 446 asserts this function REFUSES an
-- identity-less caller, and that stands.)
CREATE OR REPLACE FUNCTION public.get_de_inquiry_metrics(p_tenant_id uuid, p_days integer DEFAULT NULL::integer)
 RETURNS TABLE(de_id uuid, total_decisions bigint, resolution_rate numeric, avg_confidence numeric, escalation_rate numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not (is_platform_admin() or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = p_tenant_id)) then
    raise exception 'not authorized to view this workspace''s performance data';
  end if;
  return query
    with dec as (
      select er.de_id as d_de_id, d.confidence as conf, d.decision as decision
      from evidence_run_decisions d
      join evidence_runs er on er.id = d.evidence_run_id
      where er.tenant_id = p_tenant_id and er.de_id is not null
        -- mig 709: A CERTIFICATION EXAM IS NOT PRODUCTION WORK (the 571 rule,
        -- via the 682 origin stamp). This organ fed the founder's
        -- OutcomeStatement per-DE decision counts with exam traffic — the
        -- same defect 571 fixed in get_de_performance_metrics.
        and public.evidence_is_production(er.origin)
        -- DE scoping (wave2 grpB): decisions narrow to the employees
        -- this caller is responsible for.
        and public.can_access_de(er.de_id)
        and (p_days is null or d.created_at >= now() - make_interval(days => p_days))
    )
    select
      dec.d_de_id as de_id,
      count(*)::bigint,
      round(100.0 * count(*) filter (where dec.decision <> 'needs_review') / nullif(count(*), 0), 1),
      round(avg(dec.conf) filter (where dec.conf is not null), 1),
      round(100.0 * count(*) filter (where dec.decision = 'needs_review') / nullif(count(*), 0), 1)
    from dec
    group by dec.d_de_id;
end;
$function$;

REVOKE ALL ON FUNCTION public.get_de_inquiry_metrics(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_de_inquiry_metrics(uuid, integer) TO authenticated, service_role;

-- ── 3. get_workforce_learning_digest: the volume block stops counting exams ─
-- Body reproduced from the LIVE definition; ONE predicate added to the
-- conversations count. The quality trend's online contamination heals at the
-- source (mig 706 sampler); its historical window ages out on its own.
CREATE OR REPLACE FUNCTION public.get_workforce_learning_digest(p_days integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid;
  v_since timestamptz;
  v_prior timestamptz;
  v_avg numeric; v_prev_avg numeric; v_n bigint; v_prev_n bigint;
  v_out jsonb;
BEGIN
  v_tenant := public.auth_tenant_id();
  IF v_tenant IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_permitted');
  END IF;
  p_days  := GREATEST(1, LEAST(90, COALESCE(p_days, 7)));
  v_since := now() - make_interval(days => p_days);
  v_prior := now() - make_interval(days => p_days * 2);

  SELECT avg(score), count(*) INTO v_avg, v_n
    FROM eval_judgments WHERE tenant_id = v_tenant AND created_at >= v_since
     AND source IS DISTINCT FROM 'simulation';
  SELECT avg(score), count(*) INTO v_prev_avg, v_prev_n
    FROM eval_judgments WHERE tenant_id = v_tenant
     AND created_at >= v_prior AND created_at < v_since
     AND source IS DISTINCT FROM 'simulation';

  v_out := jsonb_build_object(
    'ok', true,
    'period', jsonb_build_object('days', p_days, 'since', v_since),

    'volume', jsonb_build_object(
      'work_done', (SELECT count(*) FROM de_work_items
        WHERE tenant_id = v_tenant AND status = 'done' AND updated_at >= v_since AND (de_id IS NULL OR public.can_access_de(de_id))),
      -- mig 709: exam threads are not workforce conversations. Before this
      -- predicate, hq's SelfLearningPage reported 158 certification-exam
      -- threads as 30-day conversation volume (docs/51 ranked fix 5).
      'conversations', (SELECT count(*) FROM de_conversations
        WHERE tenant_id = v_tenant AND last_message_at >= v_since AND channel IS DISTINCT FROM 'exam' AND (de_id IS NULL OR public.can_access_de(de_id))),
      'escalations', (SELECT count(*) FROM human_tasks
        WHERE tenant_id = v_tenant AND created_at >= v_since AND (de_id IS NULL OR public.can_access_de(de_id)))),

    'knowledge', jsonb_build_object(
      'docs_added', (SELECT count(*) FROM knowledge_docs
        WHERE tenant_id = v_tenant AND is_current AND created_at >= v_since),
      'docs_by_source', COALESCE((SELECT jsonb_object_agg(src, n) FROM (
          SELECT COALESCE(source, 'manual') AS src, count(*) AS n
            FROM knowledge_docs
           WHERE tenant_id = v_tenant AND is_current AND created_at >= v_since
           GROUP BY 1) s), '{}'::jsonb),
      'gaps_detected', (SELECT count(*) FROM knowledge_gap_clusters
        WHERE tenant_id = v_tenant AND first_seen_at >= v_since),
      'gaps_resolved', (SELECT count(*) FROM knowledge_gap_clusters
        WHERE tenant_id = v_tenant AND fix_applied_at >= v_since)),

    -- GI-6a: the CLOSED LOOP on recurring problems — the honest, already-real
    -- "it gets measurably better" evidence (persona-amendment fitness is GI-6b).
    'learning', jsonb_build_object(
      -- Issues that RECURRED (came back at least once) and then got a fix
      -- applied in this window — genuine repeat problems the workforce closed.
      'recurring_issues_fixed', (SELECT count(*) FROM knowledge_gap_clusters
        WHERE tenant_id = v_tenant AND fix_applied_at >= v_since
          AND COALESCE(recurrence_count, 0) >= 1),
      -- Fix durability, ALL-TIME (a fix's durability isn't a window property):
      -- of every gap ever fixed, how many held vs came back. Denominator is
      -- exposed so the reader never over-reads a tiny sample.
      'fixes_held', (SELECT count(*) FROM knowledge_gap_clusters
        WHERE tenant_id = v_tenant AND fix_applied_at IS NOT NULL
          AND NOT COALESCE(recurred_after_fix, false)),
      'fixes_reopened', (SELECT count(*) FROM knowledge_gap_clusters
        WHERE tenant_id = v_tenant AND fix_applied_at IS NOT NULL
          AND COALESCE(recurred_after_fix, false))),

    'quality', jsonb_build_object(
      'evals', COALESCE(v_n, 0),
      'avg_score', round(COALESCE(v_avg, 0)::numeric, 1),
      'prev_evals', COALESCE(v_prev_n, 0),
      'prev_avg_score', round(COALESCE(v_prev_avg, 0)::numeric, 1),
      'delta', CASE WHEN v_n >= 5 AND v_prev_n >= 5
                    THEN round((v_avg - v_prev_avg)::numeric, 1) END,
      'drift', (v_n >= 10 AND v_prev_n >= 10 AND (v_avg - v_prev_avg) <= -8)),

    'amendments', jsonb_build_object(
      'proposed', (SELECT count(*) FROM workforce_entity_amendments
        WHERE tenant_id = v_tenant AND created_at >= v_since),
      'adopted', (SELECT count(*) FROM workforce_entity_amendments
        WHERE tenant_id = v_tenant AND status IN ('applied', 'adopted')
          AND updated_at >= v_since),
      'fitness_avg_delta', (SELECT round(avg(replay_score_after - replay_score_before)::numeric, 1)
        FROM amendment_metrics
        WHERE tenant_id = v_tenant AND adopted_at >= v_since
          AND replay_score_after IS NOT NULL AND replay_score_before IS NOT NULL),
      'fitness_samples', (SELECT count(*) FROM amendment_metrics
        WHERE tenant_id = v_tenant AND adopted_at >= v_since
          AND replay_score_after IS NOT NULL AND replay_score_before IS NOT NULL)),

    'certifications', jsonb_build_object(
      'runs', (SELECT count(*) FROM role_certifications
        WHERE tenant_id = v_tenant AND evaluated_at >= v_since),
      'passed', (SELECT count(*) FROM role_certifications
        WHERE tenant_id = v_tenant AND evaluated_at >= v_since AND status = 'passed')),

    'ramp', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'who', who, 'hired_at', hired_at, 'trust_level', trust_level,
        'days_to_first_cert', days_to_first_cert) ORDER BY hired_at DESC)
      FROM (
        SELECT COALESCE(d.persona_name, d.name) AS who, d.created_at AS hired_at,
               d.trust_level,
               (SELECT round(extract(epoch FROM (min(rc.evaluated_at) - d.created_at)) / 86400.0, 1)
                  FROM role_certifications rc
                 WHERE rc.tenant_id = v_tenant AND rc.de_id = d.id AND rc.status = 'passed') AS days_to_first_cert
          FROM digital_employees d
         WHERE d.tenant_id = v_tenant
           AND COALESCE(d.lifecycle_status, 'active') <> 'retired'
           -- DE scoping (mig 385/389): the ramp list names employees. Scope it
           -- or a scoped user reads the whole roster off a "learning digest".
           AND public.can_access_de(d.id)
         LIMIT 30) r), '[]'::jsonb)
  );
  RETURN v_out;
END $function$;

REVOKE ALL ON FUNCTION public.get_workforce_learning_digest(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_workforce_learning_digest(integer) TO authenticated, service_role;

-- ── Asserts ─────────────────────────────────────────────────────────────────
DO $probe$
DECLARE
  v_hq uuid := '5bb802e1-8e92-4eef-9a7a-ac348785d43f';
  v_n int; v_expect bigint; v_out jsonb;
  v_arms text := '';
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  -- S1 (always): one signature each.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace nsp ON nsp.oid = p.pronamespace
   WHERE nsp.nspname = 'public' AND p.proname IN ('get_de_economics', 'get_de_inquiry_metrics', 'get_workforce_learning_digest');
  IF v_n <> 3 THEN RAISE EXCEPTION 'S1 FAILED: % signatures (want 3)', v_n; END IF;

  -- S2 (always): perimeter.
  IF has_function_privilege('anon', 'public.get_de_economics(uuid, uuid, integer)', 'execute')
     OR has_function_privilege('anon', 'public.get_de_inquiry_metrics(uuid, integer)', 'execute')
     OR has_function_privilege('anon', 'public.get_workforce_learning_digest(integer)', 'execute') THEN
    RAISE EXCEPTION 'S2 FAILED: anon can execute a metrics reader';
  END IF;
  IF NOT (has_function_privilege('authenticated', 'public.get_de_economics(uuid, uuid, integer)', 'execute')
     AND has_function_privilege('authenticated', 'public.get_de_inquiry_metrics(uuid, integer)', 'execute')
     AND has_function_privilege('authenticated', 'public.get_workforce_learning_digest(integer)', 'execute')) THEN
    RAISE EXCEPTION 'S2 FAILED: authenticated lost EXECUTE';
  END IF;

  -- D1: DRIVE get_de_economics for hq and hold every benefit count to an
  -- independent production-only recount. Population-guarded.
  IF EXISTS (SELECT 1 FROM tenants WHERE id = v_hq) THEN
    v_out := public.get_de_economics(v_hq, NULL, 30);

    SELECT count(*) INTO v_expect
      FROM evidence_run_decisions d JOIN evidence_runs er ON er.id = d.evidence_run_id
     WHERE er.tenant_id = v_hq AND er.de_id IS NOT NULL
       AND public.evidence_is_production(er.origin)
       AND d.created_at > now() - interval '30 days';
    IF (v_out->'counts'->>'inquiries_handled')::bigint IS DISTINCT FROM v_expect THEN
      RAISE EXCEPTION 'D1 FAILED: inquiries_handled=% but production recount=%',
        v_out->'counts'->>'inquiries_handled', v_expect;
    END IF;

    SELECT count(*) INTO v_expect
      FROM de_conversations
     WHERE tenant_id = v_hq AND de_id IS NOT NULL
       AND channel IS DISTINCT FROM 'exam'
       AND created_at > now() - interval '30 days';
    IF (v_out->'counts'->>'conversations_answered')::bigint IS DISTINCT FROM v_expect THEN
      RAISE EXCEPTION 'D1 FAILED: conversations_answered=% but non-exam recount=%',
        v_out->'counts'->>'conversations_answered', v_expect;
    END IF;

    -- The exam corpus must be untouched — read-filtered, never deleted.
    SELECT count(*) INTO v_n FROM de_conversations WHERE tenant_id = v_hq AND channel = 'exam';
    IF v_n = 0 AND EXISTS (SELECT 1 FROM eval_runs WHERE tenant_id = v_hq) THEN
      RAISE EXCEPTION 'D1 FAILED: the exam corpus is GONE — this migration must never delete evidence';
    END IF;

    -- No baselines on file for hq ⇒ hours_saved stays NULL even with real
    -- counts (the §12.3 rule get_de_economics already honoured).
    IF NOT EXISTS (SELECT 1 FROM workforce_baselines WHERE tenant_id = v_hq)
       AND (v_out->>'hours_saved') IS NOT NULL THEN
      RAISE EXCEPTION 'D1 FAILED: hours_saved=% with no baseline row', v_out->>'hours_saved';
    END IF;
    v_arms := v_arms || format(' D1(inquiries=%s, conversations=%s, exam corpus=%s rows intact)',
      v_out->'counts'->>'inquiries_handled', v_out->'counts'->>'conversations_answered', v_n);
  ELSE
    v_arms := v_arms || ' D1(SKIPPED: hq tenant absent)';
  END IF;

  -- D2: the 446 gates STAND — an identity-less caller is still refused by
  -- inquiry metrics and bounced (ok:false) by the digest. This drives the
  -- gate, which is all an identity-less probe may reach.
  PERFORM set_config('request.jwt.claims', '{}', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  BEGIN
    PERFORM * FROM public.get_de_inquiry_metrics(v_hq, 7);
    RAISE EXCEPTION 'D2 FAILED: get_de_inquiry_metrics no longer refuses an identity-less caller (mig 446 gate lost)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%not authenticated%' THEN RAISE; END IF;
  END;
  IF (public.get_workforce_learning_digest(7)->>'ok')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'D2 FAILED: learning digest served an identity-less caller';
  END IF;
  v_arms := v_arms || ' D2(gates hold)';

  RAISE NOTICE '709 asserts passed:%', v_arms;
END
$probe$;

COMMIT;
