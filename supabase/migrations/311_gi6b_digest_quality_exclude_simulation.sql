-- 311_gi6b_digest_quality_exclude_simulation.sql
-- ============================================================================
-- GI-6b (quality-pollution fix) — exclude cert-simulation judge rows from the
-- workforce QUALITY aggregate. de-simulate runs cert sims that call eval-judge
-- with source='simulation' + persist=true, persisting 2xN judge rows that today
-- inflate/deflate quality.avg_score / delta / drift in get_workforce_learning_digest.
-- (The GI-6b measure-mode replay is persist=false, so it is NOT a polluter —
-- normal cert runs are.) Reproduces get_workforce_learning_digest VERBATIM from
-- mig 309 (the highest def; preserves the 309 learning block) and changes ONLY
-- the two eval_judgments predicates to add: AND source IS DISTINCT FROM 'simulation'.
-- IS DISTINCT FROM (not <>) so it survives any future drop of source NOT NULL.
-- Excluding sim rows lowers v_n, so drift/delta may go dark in sim-heavy tenants
-- — that is MORE honest, not a regression. GLOBAL.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_workforce_learning_digest(p_days integer DEFAULT 7)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
        WHERE tenant_id = v_tenant AND status = 'done' AND updated_at >= v_since),
      'conversations', (SELECT count(*) FROM de_conversations
        WHERE tenant_id = v_tenant AND last_message_at >= v_since),
      'escalations', (SELECT count(*) FROM human_tasks
        WHERE tenant_id = v_tenant AND created_at >= v_since)),

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
         LIMIT 30) r), '[]'::jsonb)
  );
  RETURN v_out;
END $$;

REVOKE ALL ON FUNCTION public.get_workforce_learning_digest(integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_workforce_learning_digest(integer) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
