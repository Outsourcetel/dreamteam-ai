-- ═══════════════════════════════════════════════════════════════
-- 176 — Honest outcome benchmark (Frontier-20 #11)
--
-- The 2026 market lesson: honest metrics are a competitive weapon —
-- vendors claiming "67% resolution" measured over cherry-picked traffic
-- get found out (independent evals put the real number at 42-50%).
-- DreamTeam's benchmark is the OPPOSITE bet: every number is computed
-- over ALL traffic in the window from raw production rows anyone with
-- tenant access can recount, and the metric DEFINITIONS ship inside the
-- report payload itself so a buyer knows exactly what they're reading.
--
--   resolution_rate  = auto-sent, guardrail-clean answers ÷ ALL metered
--                      outcomes (resolutions + every escalation, hand-off
--                      and guardrail block). Denominator includes the
--                      misses — no cherry-picking.
--   judged_quality   = LLM-judge pass rate over graded answers
--                      (grounding/correctness/guardrails/tone, mig 167).
--   csat             = customer-submitted ratings only (never inferred).
--   cost_per_resolution = real model spend ÷ resolutions.
--   capability       = latest certification-grade simulation (candidate
--                      dry-runs excluded — they can't certify either).
-- ═══════════════════════════════════════════════════════════════

create or replace function public.get_benchmark_report(
  p_tenant_id uuid, p_de_id uuid default null, p_days integer default 30
) returns jsonb
language plpgsql security definer set search_path to 'public' stable as $function$
declare
  v_from timestamptz := now() - make_interval(days => greatest(1, least(365, p_days)));
  v_outcomes jsonb; v_quality jsonb; v_csat jsonb; v_cost jsonb; v_sim jsonb;
  v_res bigint; v_esc bigint; v_cost_cents numeric;
begin
  if auth.uid() is not null and not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = p_tenant_id)) then
    raise exception 'not authorized';
  end if;

  -- Outcomes: the denominator is EVERYTHING metered, misses included.
  select count(*) filter (where kind = 'resolution'),
         count(*) filter (where kind = 'escalation')
    into v_res, v_esc
    from billable_outcomes
   where tenant_id = p_tenant_id and occurred_at >= v_from
     and (p_de_id is null or de_id = p_de_id);
  v_outcomes := jsonb_build_object(
    'resolutions', v_res, 'escalations', v_esc,
    'resolution_rate_pct', case when v_res + v_esc > 0 then round(100.0 * v_res / (v_res + v_esc), 1) end);

  -- Judged quality: the LLM judge's verdicts over graded answers.
  select jsonb_build_object(
      'graded', count(*),
      'pass_rate_pct', case when count(*) > 0 then round(100.0 * count(*) filter (where verdict = 'pass') / count(*), 1) end,
      'avg_score', case when count(*) > 0 then round(avg(score), 1) end)
    into v_quality
    from eval_judgments
   where tenant_id = p_tenant_id and created_at >= v_from
     and (p_de_id is null or de_id = p_de_id);

  -- CSAT: only what customers actually submitted.
  select jsonb_build_object(
      'ratings', count(*),
      'avg_score', case when count(*) > 0 then round(avg(csat_score)::numeric, 2) end)
    into v_csat
    from de_conversations
   where tenant_id = p_tenant_id and csat_submitted_at is not null and csat_submitted_at >= v_from
     and (p_de_id is null or de_id = p_de_id);

  -- Real model spend in the window (usage × current pricing).
  select coalesce(sum(
      u.input_tokens  / 1000000.0 * coalesce(pr.input_price_per_million, 0) * 100
    + u.output_tokens / 1000000.0 * coalesce(pr.output_price_per_million, 0) * 100), 0)
    into v_cost_cents
    from de_token_usage u
    left join ai_model_pricing pr on pr.model_id = u.model_id
   where u.tenant_id = p_tenant_id and u.created_at >= v_from
     and (p_de_id is null or u.de_id = p_de_id);
  v_cost := jsonb_build_object(
    'ai_spend_cents', round(v_cost_cents),
    'cost_per_resolution_cents', case when v_res > 0 then round(v_cost_cents / v_res) end);

  -- Capability: latest certification-grade sim (candidate dry-runs excluded).
  select jsonb_build_object('mode', mode, 'passed', passed, 'total', total,
                            'avg_score', avg_score, 'status', status, 'ran_at', started_at)
    into v_sim
    from sim_runs
   where tenant_id = p_tenant_id and candidate = false and status in ('passed', 'failed')
     and (p_de_id is null or de_id = p_de_id)
   order by started_at desc limit 1;

  return jsonb_build_object(
    'window_days', greatest(1, least(365, p_days)),
    'de_id', p_de_id,
    'generated_at', now(),
    'outcomes', v_outcomes,
    'judged_quality', v_quality,
    'csat', v_csat,
    'cost', v_cost,
    'capability', coalesce(v_sim, jsonb_build_object('status', 'no_simulation_yet')),
    'definitions', jsonb_build_object(
      'resolution_rate_pct', 'Auto-sent, guardrail-clean answers as a share of ALL metered outcomes in the window — every escalation, human hand-off, and guardrail block counts in the denominator. Nothing is excluded.',
      'judged_quality', 'Share of graded answers an independent LLM judge scored as passing on grounding, correctness, guardrail adherence, and tone.',
      'csat', 'Average of ratings customers actually submitted. Never inferred or imputed.',
      'cost_per_resolution_cents', 'Real model spend in the window divided by resolutions delivered.',
      'capability', 'Latest certification-grade simulation result. Dry-run (candidate) simulations are excluded, exactly as they are excluded from certification.'));
end;
$function$;
revoke all on function public.get_benchmark_report(uuid, uuid, integer) from public, anon;
grant execute on function public.get_benchmark_report(uuid, uuid, integer) to authenticated, service_role;
