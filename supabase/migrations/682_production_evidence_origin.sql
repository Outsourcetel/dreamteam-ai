-- 682 — an exam is not business activity, anywhere (G-B: the production-evidence bar).
--
-- The platform has shipped the same defect three times in different organs: exam
-- activity counted as production evidence. A DE accumulated 158 exam conversations
-- and zero real ones and looked busy; guardrail blocks provoked by tests were
-- recorded against the employee's trust evidence; 282 exams polluted the support
-- topic axis (671). Migration 571 fixed ONE reader (performance metrics) with a
-- channel filter and a fragile string join. This migration closes the CLASS:
--
--   * an exam answer could record a BILLABLE RESOLUTION (de-answer's outcome
--     writer guarded on replay only, never on isExam — the cache-hit path even
--     carries a comment saying "an exam answer is not business activity" two
--     statements above an unguarded record_billable_outcome call);
--   * exam tokens counted in every cost metric;
--   * exam-provoked guardrail blocks and exam escalation decisions fed
--     trust_evidence_for — the evidence that decides AUTONOMY;
--   * the public proof-stats endpoint counted exam conversations while its own
--     scope string claimed they were excluded.
--
-- Mechanism, mirroring 679's "one definition" rule: ONE origin stamp at the
-- WRITE boundary + ONE shared predicate every reader uses, ratcheted by a
-- certify probe (scripts/production-evidence.mjs) so the fourth recurrence
-- cannot ship. Explicitly NOT done here: audit_events history is never edited —
-- the chain is tamper-evident by design; the four known voice-test blocks age
-- out of the 30-day evidence window on 2026-09-03. New audit writes carry the
-- marker in detail; voice-turn's exercise flag is a follow-up scoped to the
-- voice seam (its writes are inside a live-call streaming path).

-- ── 1. The one definition ──────────────────────────────────────────────────
create or replace function public.evidence_is_production(p_origin text)
returns boolean
language sql immutable
as $$ select coalesce(p_origin, 'production') <> 'exercise' $$;
comment on function public.evidence_is_production(text) is
  'THE production-evidence predicate (G-B). Every metric/evidence reader over '
  'billable_outcomes / de_token_usage / evidence_runs / human_tasks origin — and '
  'the guardrail-block CTE in trust_evidence_for — must call this, or be pinned '
  'with a reason in scripts/production-evidence.mjs. An exam is not business activity.';
revoke all on function public.evidence_is_production(text) from public, anon, authenticated;

-- ── 2. The stamp, at the write boundary ────────────────────────────────────
alter table billable_outcomes add column if not exists origin text not null default 'production'
  check (origin in ('production','exercise'));
alter table evidence_runs     add column if not exists origin text not null default 'production'
  check (origin in ('production','exercise'));
alter table human_tasks       add column if not exists origin text not null default 'production'
  check (origin in ('production','exercise'));
alter table de_token_usage    add column if not exists origin text not null default 'production'
  check (origin in ('production','exercise'));

-- ── 3. Backfill what is provably exam-linked. ──────────────────────────────
-- de_conversations.channel = 'exam' is the ground truth (CHECK since mig 570;
-- eval-run stamps it; de-answer's allow-list enforces it). de_token_usage rows
-- carry no conversation link and CANNOT be backfilled — stated, not papered
-- over; they are stamped from today by the new writer signature below.

-- An exam "resolution" is not merely mislabeled — it must also never bill and
-- never settle. billable=false + status 'unbilled' takes it out of the
-- settlement sweep's reach (settle_billable_outcomes touches 'pending' only).
update billable_outcomes b
   set origin = 'exercise', billable = false, unit_price_cents = 0,
       status = 'unbilled', settled_at = coalesce(b.settled_at, now())
  from de_conversations c
 where c.id = b.conversation_id and c.channel = 'exam'
   and b.origin = 'production';

update evidence_runs er
   set origin = 'exercise'
  from de_conversations c
 where er.account_ref = 'conversation:' || c.id::text and c.channel = 'exam'
   and er.origin = 'production';

update human_tasks h
   set origin = 'exercise'
  from de_conversations c
 where h.related_table = 'de_conversations' and h.related_id = c.id
   and c.channel = 'exam' and h.origin = 'production';

-- ── 4. Writers carry the stamp. New signatures; old ones DROPPED ───────────
-- (532's lesson: a DEFAULTed param added beside the old signature creates a
-- second overload and every call becomes ambiguous).

drop function if exists public.record_billable_outcome(uuid, uuid, uuid, text, text);
-- mig 314 verbatim + p_origin. An exercise outcome is recorded (idempotency and
-- honesty want the row) but is born unbilled and outside settlement.
create or replace function public.record_billable_outcome(
  p_tenant_id uuid, p_de_id uuid, p_conversation_id uuid, p_kind text,
  p_source text default 'chat', p_origin text default 'production'
) returns jsonb
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_price integer := 0; v_billable boolean := false; v_id uuid;
  v_status text := 'free'; v_settle_after timestamptz := null;
  v_origin text := case when p_origin = 'exercise' then 'exercise' else 'production' end;
  v_deferred boolean := (select value = 'true' from platform_config where key = 'metering_deferred_settlement_enabled');
  v_window numeric := coalesce((select value from platform_config where key = 'metering_settle_window_hours')::numeric, 72);
begin
  if p_kind not in ('resolution', 'escalation') then raise exception 'kind must be resolution|escalation'; end if;
  if p_conversation_id is null then return jsonb_build_object('recorded', false, 'reason', 'no_conversation'); end if;
  v_deferred := coalesce(v_deferred, false);

  if v_origin = 'exercise' then
    -- An exam outcome never bills, never pends, never settles — whatever kind.
    v_billable := false; v_price := 0; v_status := 'unbilled';
  elsif p_kind = 'resolution' then
    select coalesce((select price_per_resolution_cents from tenant_outcome_pricing where tenant_id = p_tenant_id), 99)
      into v_price;
    if exists (select 1 from billable_outcomes where conversation_id = p_conversation_id and kind = 'escalation') then
      v_billable := false; v_price := 0; v_status := 'unbilled';           -- escalated first: never bills
    elsif v_deferred then
      v_billable := false; v_status := 'pending'; v_settle_after := now() + make_interval(hours => v_window);
    else
      v_billable := true;  v_status := 'confirmed';                        -- LEGACY bill-on-answer (flag OFF)
    end if;
  else
    -- Escalation after a resolution: reverse it. MUST catch PENDING too, so the
    -- settle cron can never later confirm a conversation the human took over.
    update billable_outcomes set billable = false, unit_price_cents = 0, status = 'unbilled', settled_at = now()
     where conversation_id = p_conversation_id and kind = 'resolution' and status in ('pending','confirmed');
    v_billable := false; v_status := 'free';
  end if;

  insert into billable_outcomes (tenant_id, de_id, conversation_id, kind, source, billable, unit_price_cents, status, settle_after, settled_at, origin)
  values (p_tenant_id, p_de_id, p_conversation_id, p_kind,
          case when p_source in ('chat','widget','a2a','orchestrate') then p_source else 'chat' end,
          v_billable, v_price, v_status, v_settle_after,
          case when v_status in ('confirmed','free','unbilled') then now() else null end,
          v_origin)
  on conflict do nothing
  returning id into v_id;

  return jsonb_build_object('recorded', v_id is not null, 'billable', v_billable, 'unit_price_cents', v_price, 'status', v_status, 'origin', v_origin);
end;
$function$;
revoke all on function public.record_billable_outcome(uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.record_billable_outcome(uuid, uuid, uuid, text, text, text) to service_role;

drop function if exists public.record_de_token_usage(uuid, uuid, text, integer, integer);
create or replace function public.record_de_token_usage(
  p_tenant_id uuid, p_de_id uuid, p_model_id text, p_input_tokens integer, p_output_tokens integer,
  p_origin text default 'production'
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'record_de_token_usage is service-role only';
  end if;
  insert into de_token_usage (tenant_id, de_id, model_id, input_tokens, output_tokens, origin)
  values (p_tenant_id, p_de_id, p_model_id, coalesce(p_input_tokens, 0), coalesce(p_output_tokens, 0),
          case when p_origin = 'exercise' then 'exercise' else 'production' end);
end;
$function$;
revoke all on function public.record_de_token_usage(uuid, uuid, text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.record_de_token_usage(uuid, uuid, text, integer, integer, text) to service_role;

-- ── 5. Readers use the one definition. CREATE OR REPLACE preserves each
--       function's existing grants — no ACL lines, no allowlist drift. ──────

-- 5a. get_de_cost_metrics (094 verbatim + predicate).
create or replace function public.get_de_cost_metrics(p_tenant_id uuid)
returns table(de_id uuid, total_calls bigint, total_input_tokens bigint, total_output_tokens bigint, total_cost_usd numeric)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not (
    is_platform_admin()
    or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = p_tenant_id)
  ) then
    raise exception 'not authorized to view this workspace''s cost data';
  end if;

  return query
    select
      u.de_id,
      count(*) as total_calls,
      sum(u.input_tokens) as total_input_tokens,
      sum(u.output_tokens) as total_output_tokens,
      round(sum(
        (u.input_tokens::numeric / 1000000) * coalesce(pr.input_price_per_million, 3.00)
        + (u.output_tokens::numeric / 1000000) * coalesce(pr.output_price_per_million, 15.00)
      ), 4) as total_cost_usd
    from de_token_usage u
    left join ai_model_pricing pr on pr.model_id = u.model_id
    where u.tenant_id = p_tenant_id and u.de_id is not null
      and evidence_is_production(u.origin)   -- 682: exam spend is not a business cost metric
    group by u.de_id;
end;
$function$;

-- 5b. get_de_cost_metrics_ranged (148 verbatim + predicate).
create or replace function public.get_de_cost_metrics_ranged(p_tenant_id uuid, p_days integer default null)
returns table(de_id uuid, total_calls bigint, total_input_tokens bigint, total_output_tokens bigint, total_cost_usd numeric)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not (is_platform_admin() or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = p_tenant_id)) then
    raise exception 'not authorized to view this workspace''s cost data';
  end if;
  return query
    select
      u.de_id,
      count(*)::bigint as total_calls,
      sum(u.input_tokens)::bigint as total_input_tokens,
      sum(u.output_tokens)::bigint as total_output_tokens,
      round(sum(
        (u.input_tokens::numeric / 1000000) * coalesce(pr.input_price_per_million, 3.00)
        + (u.output_tokens::numeric / 1000000) * coalesce(pr.output_price_per_million, 15.00)
      ), 4) as total_cost_usd
    from de_token_usage u
    left join ai_model_pricing pr on pr.model_id = u.model_id
    where u.tenant_id = p_tenant_id and u.de_id is not null
      and evidence_is_production(u.origin)   -- 682
      and (p_days is null or u.created_at >= now() - make_interval(days => p_days))
    group by u.de_id;
end;
$function$;

-- 5c. get_de_csat_metrics (095 verbatim + channel filter — CSAT lives on
--     conversations, which carry channel rather than origin; same rule 571
--     used for performance metrics).
create or replace function public.get_de_csat_metrics(p_tenant_id uuid)
returns table(de_id uuid, total_ratings bigint, positive_ratings bigint, csat_pct numeric)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not (
    is_platform_admin()
    or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = p_tenant_id)
  ) then
    raise exception 'not authorized to view this workspace''s CSAT data';
  end if;

  return query
    select
      c.de_id,
      count(*) as total_ratings,
      count(*) filter (where c.csat_score = 1) as positive_ratings,
      round(100.0 * count(*) filter (where c.csat_score = 1) / nullif(count(*), 0), 1) as csat_pct
    from de_conversations c
    where c.tenant_id = p_tenant_id and c.csat_submitted_at is not null and c.de_id is not null
      and c.channel is distinct from 'exam'   -- 682: an exam thread is not a customer rating
    group by c.de_id;
end;
$function$;

-- 5d. get_outcome_metering (181 verbatim + predicate in all three shapes).
create or replace function public.get_outcome_metering(
  p_tenant_id uuid, p_from timestamptz default now() - interval '30 days', p_to timestamptz default now()
) returns jsonb
language plpgsql security definer set search_path to 'public' stable as $function$
declare v_totals jsonb; v_by_de jsonb; v_by_day jsonb; v_price integer;
begin
  if auth.uid() is not null and not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = p_tenant_id)) then
    raise exception 'not authorized';
  end if;

  select coalesce((select price_per_resolution_cents from tenant_outcome_pricing where tenant_id = p_tenant_id), 99)
    into v_price;

  select jsonb_build_object(
    'resolutions', count(*) filter (where kind = 'resolution' and billable),
    'escalations', count(*) filter (where kind = 'escalation'),
    'billable_amount_cents', coalesce(sum(unit_price_cents) filter (where billable), 0))
    into v_totals
    from billable_outcomes
   where tenant_id = p_tenant_id and occurred_at between p_from and p_to
     and evidence_is_production(origin);   -- 682

  select coalesce(jsonb_agg(row_de order by (row_de->>'amount_cents')::bigint desc), '[]'::jsonb) into v_by_de
  from (
    select jsonb_build_object(
      'de_id', b.de_id,
      'name', coalesce(max(d.persona_name), max(d.name), 'Unknown'),
      'resolutions', count(*) filter (where b.kind = 'resolution' and b.billable),
      'escalations', count(*) filter (where b.kind = 'escalation'),
      'amount_cents', coalesce(sum(b.unit_price_cents) filter (where b.billable), 0)) as row_de
    from billable_outcomes b
    left join digital_employees d on d.id = b.de_id
    where b.tenant_id = p_tenant_id and b.occurred_at between p_from and p_to
      and evidence_is_production(b.origin)   -- 682
    group by b.de_id
  ) s;

  select coalesce(jsonb_agg(row_day order by row_day->>'day'), '[]'::jsonb) into v_by_day
  from (
    select jsonb_build_object(
      'day', day_key,
      'resolutions', count(*) filter (where kind = 'resolution' and billable),
      'escalations', count(*) filter (where kind = 'escalation')) as row_day
    from (
      select to_char(occurred_at at time zone 'utc', 'YYYY-MM-DD') as day_key, kind, billable
      from billable_outcomes
      where tenant_id = p_tenant_id and occurred_at between p_from and p_to
        and evidence_is_production(origin)   -- 682
    ) raw
    group by day_key
  ) s;

  return jsonb_build_object('totals', v_totals, 'by_de', v_by_de, 'by_day', v_by_day,
                            'price_per_resolution_cents', v_price);
end;
$function$;

-- 5e. get_benchmark_report (181 verbatim + predicate on outcomes and cost,
--     golden/simulation excluded from judged quality — 311 excluded
--     'simulation' from the digest; certification 'golden' rows belong to
--     certification, not to the live-quality number).
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

  select jsonb_build_object(
      'graded', count(*),
      'pass_rate_pct', case when count(*) > 0 then round(100.0 * count(*) filter (where verdict = 'pass') / count(*), 1) end,
      'avg_score', case when count(*) > 0 then round(avg(score), 1) end)
    into v_quality
    from eval_judgments
   where tenant_id = p_tenant_id and created_at >= v_from
     and coalesce(source, 'online') not in ('golden', 'simulation')   -- 682: exams grade certification, not live quality
     and (p_de_id is null or de_id = p_de_id);

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
      'resolution_rate_pct', 'Auto-sent, guardrail-clean answers that were NOT later handed to a human, as a share of ALL metered outcomes in the window — every escalation, hand-off, and guardrail block counts in the denominator. Certification-exam traffic is excluded from numerator and denominator alike (mig 682).',
      'judged_quality', 'Share of graded LIVE answers an independent LLM judge scored as passing on grounding, correctness, guardrail adherence, and tone. Certification (golden) and simulation grades are excluded — they measure the exam, not the work.',
      'csat', 'Percent of customer-submitted thumbs ratings that were positive. Never inferred or imputed.',
      'cost_per_resolution_cents', 'Real model spend on production traffic in the window divided by billable resolutions delivered.',
      'capability', 'Latest certification-grade simulation result. Dry-run (candidate) simulations are excluded, exactly as they are excluded from certification.'));
end;
$function$;

-- 5f. trust_evidence_for (586 verbatim + the two origin filters). The eval
--     source deliberately keeps counting exams — that criterion IS the exam.
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
    'eligible', coalesce(v_eligible, false) and p_policy.current_level < 3 and p_policy.status = 'active',
    'at_max_level', p_policy.current_level >= 3,
    'computed_at', now()
  );
end;
$function$;

-- ── 6. Prove it, in this transaction. ──────────────────────────────────────
do $$
declare v_bad bigint;
begin
  -- Columns landed.
  perform 1 from information_schema.columns where table_name='billable_outcomes' and column_name='origin';
  if not found then raise exception '682: billable_outcomes.origin did not land'; end if;
  perform 1 from information_schema.columns where table_name='de_token_usage' and column_name='origin';
  if not found then raise exception '682: de_token_usage.origin did not land'; end if;

  -- No exam-linked outcome may remain marked production.
  select count(*) into v_bad
    from billable_outcomes b join de_conversations c on c.id = b.conversation_id
   where c.channel = 'exam' and b.origin = 'production';
  if v_bad > 0 then raise exception '682: % exam-linked billable_outcomes still marked production', v_bad; end if;

  -- No exercise row may bill — ever.
  select count(*) into v_bad from billable_outcomes where origin = 'exercise' and billable;
  if v_bad > 0 then raise exception '682: % exercise outcomes are billable', v_bad; end if;

  -- The readers carry the predicate; the writer carries the stamp.
  perform 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='trust_evidence_for' and p.prosrc ilike '%evidence_is_production%';
  if not found then raise exception '682: trust_evidence_for does not call the shared predicate'; end if;
  perform 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='record_billable_outcome' and p.prosrc ilike '%v_origin%';
  if not found then raise exception '682: record_billable_outcome does not carry the origin stamp'; end if;
end $$;
