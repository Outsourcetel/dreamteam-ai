-- ═══════════════════════════════════════════════════════════════
-- 181 — Consolidation pass, round 2 (adversarial SQL review of 170-179)
--
-- C1  Gate bypass: gate_de_certification fingerprinted the PRE-update row
--     (BEFORE trigger + re-SELECT), so one statement changing config AND
--     lifecycle together passed the gate on the old config. The
--     fingerprint logic now lives in de_config_fingerprint_row(record)
--     and the gate fingerprints NEW directly.
-- C2  Cert minting: certify_* accepted a caller-supplied threshold (0 →
--     any run passes). The archetype's pass_threshold_pct now governs;
--     the parameter is retained for signature compatibility but ignored.
-- C3  Stale-cert laundering: certs stamped the fingerprint at CERTIFY
--     time, so a passing run under config A could certify config B.
--     sim_runs now records the fingerprint AT RUN TIME and
--     certify_de_from_sim uses the run's own stamp.
--     HONEST LIMIT: eval_runs has no de_id column, so the eval path
--     cannot bind run→DE or run→fingerprint; it keeps certify-time
--     stamping under the enforced threshold. The sim path is the
--     recommended certification evidence.
-- C4  apply/reject_improvement had no tenant check (granted to
--     authenticated): cross-tenant apply/deny by UUID. Standard auth
--     block added; apply also takes a row lock (double-click race
--     produced duplicate published docs).
-- C5  outbound-draft status sync ran SECURITY INVOKER, so UI approvals
--     (authenticated) hit outbound_drafts' SELECT-only RLS and silently
--     synced nothing. Now SECURITY DEFINER.
-- H7  conclude_objective_wake could overwrite operator transitions
--     (abandoned→blocked). Status guard added.
-- M9  mcp_host_allowed was a cross-tenant allowlist oracle. Caller must
--     belong to the tenant (or be platform).
-- M10 alert_cert_regression used newest-cert freshness while the gate
--     uses any-cert-matches — false STALE alarms after a config revert.
--     Aligned to the gate's definition.
-- M11 Benchmark CSAT averaged a ±1 field (nonsense 0.33 readings).
--     Now reports % positive, like every other CSAT consumer.
-- M12 tenant_outcome_pricing had no write path at all. Owner/admin +
--     platform write policy added.
-- M14 A conversation that later escalated stayed billed. Recording an
--     escalation now flips that conversation's resolution to
--     non-billable, and metering/benchmark count only billable
--     resolutions. "Escalations are free" holds in spirit, not just letter.
-- DEFERRED (honest): the certification gate still fires only on UPDATE —
--     tenant provisioning inserts starter DEs directly into gated stages
--     by design, so an INSERT-path gate needs a provisioning marker first.
--     Tracked as a known limitation.
-- ═══════════════════════════════════════════════════════════════

-- ── C1: fingerprint from a ROW, shared by the column function and the gate ──
create or replace function public.de_config_fingerprint_row(d digital_employees)
returns text
language plpgsql security definer set search_path to 'public' stable as $function$
declare v_guard text; v_pb text;
begin
  select coalesce(count(*)::text, '0') || '|' || coalesce(max(updated_at)::text, '')
    into v_guard from guardrail_rules
   where tenant_id = d.tenant_id and active and scope = 'employee' and scope_ref = d.id::text;
  select coalesce(count(*)::text, '0') || '|' || coalesce(max(version)::text, '') || '|' || coalesce(max(updated_at)::text, '')
    into v_pb from playbook_definitions
   where tenant_id = d.tenant_id and de_id = d.id and status = 'published';
  return md5(concat_ws('~',
    coalesce(d.persona_name, ''), coalesce(d.description, ''),
    coalesce(d.model_provider, ''), coalesce(d.model_id, ''),
    coalesce(d.escalation_model_id, ''), coalesce(d.escalation_threshold::text, ''),
    coalesce(d.confidence_threshold::text, ''), coalesce(d.trust_level, ''),
    coalesce(d.required_approval::text, ''), coalesce(d.task_type, ''),
    coalesce(d.external_reply_mode, ''), coalesce(d.capabilities::text, ''),
    coalesce(d.responsibilities::text, ''), coalesce(d.channels::text, ''),
    coalesce(d.knowledge_sources::text, ''), coalesce(d.skills::text, ''),
    coalesce(d.model_config::text, ''), coalesce(d.attributes::text, ''),
    v_guard, v_pb));
end;
$function$;
revoke all on function public.de_config_fingerprint_row(digital_employees) from public, anon;
grant execute on function public.de_config_fingerprint_row(digital_employees) to authenticated, service_role;

create or replace function public.de_config_fingerprint(p_de_id uuid)
returns text
language plpgsql security definer set search_path to 'public' stable as $function$
declare v_de digital_employees;
begin
  select * into v_de from digital_employees where id = p_de_id;
  if v_de.id is null then return null; end if;
  return public.de_config_fingerprint_row(v_de);
end;
$function$;

create or replace function public.gate_de_certification() returns trigger
language plpgsql as $function$
declare v_gated text[] := array['certified','published','assigned','active']; v_fp text;
begin
  if NEW.lifecycle_status = any(v_gated) and OLD.lifecycle_status is distinct from NEW.lifecycle_status
     and OLD.lifecycle_status <> all(v_gated) then
    -- Fingerprint NEW, not a re-SELECT of the pre-update row: a single
    -- statement changing config AND lifecycle is judged on the config
    -- that will actually go live (C1).
    v_fp := public.de_config_fingerprint_row(NEW);
    if not exists (
      select 1 from role_certifications c
       where c.de_id = NEW.id and c.status = 'passed'
         and c.config_fingerprint is not distinct from v_fp
    ) then
      if exists (select 1 from role_certifications c where c.de_id = NEW.id and c.status = 'passed') then
        raise exception 'DE % cannot advance to "%": its passing certification is STALE — the configuration (including changes in this statement) was not certified. Re-run its eval/simulation and re-certify first.', NEW.id, NEW.lifecycle_status;
      else
        raise exception 'DE % cannot advance to "%": it has not passed role certification. Run its eval/simulation and certify it first.', NEW.id, NEW.lifecycle_status;
      end if;
    end if;
  end if;
  return NEW;
end;
$function$;

-- ── C3: the sim run stamps the fingerprint it RAN under ──
alter table sim_runs add column if not exists config_fingerprint text;

-- ── C2+C3: certify_de_from_sim — archetype threshold governs; the cert
--    carries the RUN's fingerprint (fallback: current, for legacy rows) ──
create or replace function public.certify_de_from_sim(
  p_de_id uuid, p_archetype_key text, p_sim_run_id uuid, p_threshold_pct integer default 80
) returns jsonb
language plpgsql security definer set search_path to 'public' as $function$
declare v_tenant uuid; v_run sim_runs; v_pct numeric; v_status text; v_threshold integer; v_fp text;
begin
  select tenant_id into v_tenant from digital_employees where id = p_de_id;
  if v_tenant is null then raise exception 'de not found'; end if;
  if auth.uid() is not null and not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = v_tenant)) then
    raise exception 'not authorized';
  end if;

  -- The archetype's bar governs; the caller's p_threshold_pct is IGNORED
  -- (kept only for signature compatibility) — a threshold of 0 could mint
  -- a passing cert from any finished run (C2).
  select coalesce((select pass_threshold_pct from role_archetypes where key = p_archetype_key), 80)
    into v_threshold;

  select * into v_run from sim_runs
    where id = p_sim_run_id and tenant_id = v_tenant and de_id = p_de_id
      and status in ('passed', 'failed') and candidate = false;
  if v_run.id is null or v_run.total = 0 then
    raise exception 'simulation has no results (or is a candidate dry-run, which cannot certify)';
  end if;
  v_pct := round(100.0 * v_run.passed / v_run.total, 1);
  v_status := case when v_pct >= v_threshold then 'passed' else 'failed' end;
  -- The cert vouches for the config the run actually TESTED (C3).
  v_fp := coalesce(v_run.config_fingerprint, public.de_config_fingerprint(p_de_id));

  insert into role_certifications (tenant_id, de_id, archetype_key, eval_run_id, score_pct, threshold_pct, status, evaluated_at, config_fingerprint)
  values (v_tenant, p_de_id, p_archetype_key, null, v_pct, v_threshold, v_status, now(), v_fp);

  return jsonb_build_object('status', v_status, 'score_pct', v_pct, 'threshold_pct', v_threshold,
                            'passed', v_run.passed, 'total', v_run.total, 'from', 'simulation');
end;
$function$;

-- ── C2: certify_de_from_eval — same threshold enforcement. HONEST LIMIT:
--    eval_runs has no de_id, so run→DE binding and run-time fingerprints
--    are impossible on this path; sim certification is the primary evidence ──
create or replace function public.certify_de_from_eval(
  p_de_id uuid, p_archetype_key text, p_eval_run_id uuid, p_threshold_pct integer default 80
) returns jsonb
language plpgsql security definer set search_path to 'public' as $function$
declare v_tenant uuid; v_total int; v_passed int; v_pct numeric; v_status text; v_threshold integer;
begin
  select tenant_id into v_tenant from digital_employees where id = p_de_id;
  if v_tenant is null then raise exception 'de not found'; end if;
  if auth.uid() is not null and not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = v_tenant)) then
    raise exception 'not authorized';
  end if;
  select coalesce((select pass_threshold_pct from role_archetypes where key = p_archetype_key), 80)
    into v_threshold;
  select total, passed into v_total, v_passed from eval_runs where id = p_eval_run_id and tenant_id = v_tenant;
  if v_total is null or v_total = 0 then raise exception 'eval run has no results'; end if;
  v_pct := round(100.0 * v_passed / v_total, 1);
  v_status := case when v_pct >= v_threshold then 'passed' else 'failed' end;
  insert into role_certifications (tenant_id, de_id, archetype_key, eval_run_id, score_pct, threshold_pct, status, evaluated_at, config_fingerprint)
  values (v_tenant, p_de_id, p_archetype_key, p_eval_run_id, v_pct, v_threshold, v_status, now(), public.de_config_fingerprint(p_de_id));
  return jsonb_build_object('status', v_status, 'score_pct', v_pct, 'threshold_pct', v_threshold, 'passed', v_passed, 'total', v_total);
end;
$function$;

-- ── C4: apply/reject_improvement — tenant auth + row lock ──
create or replace function public.apply_improvement(p_improvement_id uuid)
returns uuid
language plpgsql security definer set search_path to 'public' as $function$
declare imp de_improvements; v_task_status text; v_doc uuid;
begin
  -- Row lock: two concurrent applies (double-click/retry) serialize here,
  -- and the second sees status='applied' and returns idempotently.
  select * into imp from de_improvements where id = p_improvement_id for update;
  if imp.id is null then raise exception 'improvement not found'; end if;
  if auth.uid() is not null and not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = imp.tenant_id)) then
    raise exception 'not authorized';
  end if;
  if imp.status = 'applied' then return imp.applied_doc_id; end if;
  if imp.status = 'rejected' then raise exception 'improvement was rejected'; end if;

  if imp.human_task_id is null then
    raise exception 'improvement has no review task — call create_improvement_review first';
  end if;
  select status into v_task_status from human_tasks where id = imp.human_task_id;
  if v_task_status is distinct from 'approved' then
    raise exception 'improvement is not human-approved (review task status: %) — a proposed fix can only be published after explicit approval', coalesce(v_task_status, 'missing');
  end if;

  insert into knowledge_docs (tenant_id, title, content, source, visibility, is_current, tags)
  values (imp.tenant_id, imp.proposed_title, imp.proposed_content, 'self_improvement', 'scoped', true,
          array['self-improvement'])
  returning id into v_doc;
  insert into knowledge_doc_scopes (tenant_id, doc_id, subject_kind, subject_id)
  values (imp.tenant_id, v_doc, 'de', imp.de_id);

  update de_improvements set status = 'applied', applied_doc_id = v_doc, updated_at = now()
   where id = p_improvement_id;

  insert into activity_events (tenant_id, actor, actor_type, event_type, text, confidence)
  select imp.tenant_id, coalesce(d.persona_name, d.name, 'DE'), 'system', 'config_change',
    format('Approved self-improvement published: "%s" (scoped to %s). Proposed from a failed answer, verified by replay, human-approved.',
           imp.proposed_title, coalesce(d.persona_name, d.name, 'this employee')),
    coalesce((imp.replay->'after'->>'score')::numeric, 0)
  from digital_employees d where d.id = imp.de_id;

  return v_doc;
end;
$function$;

create or replace function public.reject_improvement(p_improvement_id uuid)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from de_improvements where id = p_improvement_id;
  if v_tenant is null then raise exception 'improvement not found'; end if;
  if auth.uid() is not null and not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = v_tenant)) then
    raise exception 'not authorized';
  end if;
  update de_improvements set status = 'rejected', updated_at = now()
   where id = p_improvement_id and status in ('review_pending','replayed');
  if not found then raise exception 'improvement not in a rejectable state'; end if;
end;
$function$;

-- ── C5: the draft-status sync must bypass the approver's RLS ──
create or replace function public.sync_outbound_draft_status() returns trigger
language plpgsql security definer set search_path to 'public' as $function$
begin
  if NEW.related_table = 'outbound_drafts' and NEW.status in ('approved', 'rejected')
     and OLD.status is distinct from NEW.status then
    update outbound_drafts set status = NEW.status, updated_at = now()
     where id = NEW.related_id and status = 'pending_approval';
  end if;
  return NEW;
end;
$function$;

-- ── H7: a wake conclusion never overwrites an operator's transition ──
create or replace function public.conclude_objective_wake(
  p_objective_id uuid, p_assessment text, p_note text default null
) returns void
language plpgsql security definer set search_path to 'public' as $function$
begin
  if p_assessment = 'achieved' then
    update de_objectives set status = 'achieved', next_wake_at = null, updated_at = now()
     where id = p_objective_id and status in ('open', 'in_progress');
  elsif p_assessment = 'blocked' then
    update de_objectives set status = 'blocked', next_wake_at = null, updated_at = now()
     where id = p_objective_id and status in ('open', 'in_progress');
  elsif p_assessment = 'continue' then
    null;
  else
    raise exception 'assessment must be achieved | blocked | continue';
  end if;
end;
$function$;

-- ── M9: the allowlist check is not a cross-tenant oracle ──
create or replace function public.mcp_host_allowed(p_tenant_id uuid, p_host text)
returns boolean
language plpgsql security definer set search_path to 'public' stable as $function$
begin
  if auth.uid() is not null and not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = p_tenant_id)) then
    raise exception 'not authorized';
  end if;
  return case
    when not exists (select 1 from mcp_server_allowlist where tenant_id = p_tenant_id) then true
    else exists (select 1 from mcp_server_allowlist
                  where tenant_id = p_tenant_id and lower(host) = lower(p_host))
  end;
end;
$function$;

-- ── M10: alert freshness aligned to the gate's definition ──
create or replace function public.alert_cert_regression() returns trigger
language plpgsql security definer set search_path to 'public' as $function$
declare v_fp text; v_pass role_certifications; v_name text; v_fresh boolean;
begin
  select * into v_pass from role_certifications
    where de_id = NEW.id and status = 'passed'
    order by evaluated_at desc nulls last, created_at desc limit 1;
  if v_pass.id is null then return NEW; end if;

  v_fp := public.de_config_fingerprint_row(NEW);
  -- Same predicate as the gate: fresh iff ANY passing cert matches.
  v_fresh := exists (select 1 from role_certifications c
                      where c.de_id = NEW.id and c.status = 'passed'
                        and c.config_fingerprint is not distinct from v_fp);
  if v_fresh then
    if v_pass.stale_alerted then
      update role_certifications set stale_alerted = false where id = v_pass.id;
    end if;
    return NEW;
  end if;
  if v_pass.stale_alerted then return NEW; end if;

  v_name := coalesce(NEW.persona_name, NEW.name, 'this employee');
  insert into activity_events (tenant_id, actor, actor_type, event_type, text, confidence)
  values (NEW.tenant_id, coalesce(NEW.persona_name, NEW.name, 'DE'), 'system', 'certification_stale',
    format('Configuration changed for %s after it was certified (%s%% on %s). Its certification is now STALE and no longer vouches for the current setup — re-run its evaluation or simulation and re-certify before relying on it or promoting it again.',
           v_name, v_pass.score_pct, coalesce(v_pass.evaluated_at::date::text, 'a prior run')),
    coalesce(v_pass.score_pct, 0));
  update role_certifications set stale_alerted = true where id = v_pass.id;
  return NEW;
end;
$function$;

-- ── M12: pricing gets a real write path (owner/admin + platform) ──
drop policy if exists outcome_pricing_write on tenant_outcome_pricing;
create policy outcome_pricing_write on tenant_outcome_pricing for all using (
  tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid()
                and p.role in ('tenant_owner', 'tenant_admin'))
  or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'))
  with check (
  tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid()
                and p.role in ('tenant_owner', 'tenant_admin'))
  or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'));

-- ── M14: a conversation a human ultimately handled is not billed ──
create or replace function public.record_billable_outcome(
  p_tenant_id uuid, p_de_id uuid, p_conversation_id uuid, p_kind text, p_source text default 'chat'
) returns jsonb
language plpgsql security definer set search_path to 'public' as $function$
declare v_price integer := 0; v_billable boolean := false; v_id uuid;
begin
  if p_kind not in ('resolution', 'escalation') then raise exception 'kind must be resolution|escalation'; end if;
  if p_conversation_id is null then return jsonb_build_object('recorded', false, 'reason', 'no_conversation'); end if;

  if p_kind = 'resolution' then
    select coalesce((select price_per_resolution_cents from tenant_outcome_pricing where tenant_id = p_tenant_id), 99)
      into v_price;
    v_billable := true;
    -- A conversation that already escalated resolves FREE — the human did
    -- the heavy lifting; the AI closing it out is not a billable outcome.
    if exists (select 1 from billable_outcomes where conversation_id = p_conversation_id and kind = 'escalation') then
      v_billable := false; v_price := 0;
    end if;
  else
    -- Escalation AFTER a billed resolution: the human took over, so the
    -- earlier charge is reversed in place. "Escalations are free" holds
    -- in spirit, not just letter.
    update billable_outcomes set billable = false, unit_price_cents = 0
     where conversation_id = p_conversation_id and kind = 'resolution' and billable;
  end if;

  insert into billable_outcomes (tenant_id, de_id, conversation_id, kind, source, billable, unit_price_cents)
  values (p_tenant_id, p_de_id, p_conversation_id, p_kind,
          case when p_source in ('chat','widget','a2a','orchestrate') then p_source else 'chat' end,
          v_billable, v_price)
  on conflict do nothing
  returning id into v_id;

  return jsonb_build_object('recorded', v_id is not null, 'billable', v_billable, 'unit_price_cents', v_price);
end;
$function$;

-- ── M11 + M14: benchmark CSAT as %-positive; resolution counts = billable ──
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
     and (p_de_id is null or de_id = p_de_id);

  -- CSAT is a ±1 thumbs field: % positive is the honest statistic (an
  -- "average of 0.33" is meaningless to a reader).
  select jsonb_build_object(
      'ratings', count(*),
      'positive_pct', case when count(*) > 0 then round(100.0 * count(*) filter (where csat_score = 1) / count(*), 1) end)
    into v_csat
    from de_conversations
   where tenant_id = p_tenant_id and csat_submitted_at is not null and csat_submitted_at >= v_from
     and (p_de_id is null or de_id = p_de_id);

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
      'resolution_rate_pct', 'Auto-sent, guardrail-clean answers that were NOT later handed to a human, as a share of ALL metered outcomes in the window — every escalation, hand-off, and guardrail block counts in the denominator. Nothing is excluded.',
      'judged_quality', 'Share of graded answers an independent LLM judge scored as passing on grounding, correctness, guardrail adherence, and tone.',
      'csat', 'Percent of customer-submitted thumbs ratings that were positive. Never inferred or imputed.',
      'cost_per_resolution_cents', 'Real model spend in the window divided by billable resolutions delivered.',
      'capability', 'Latest certification-grade simulation result. Dry-run (candidate) simulations are excluded, exactly as they are excluded from certification.'));
end;
$function$;

-- ── M14 (dashboard side): metering counts billable resolutions ──
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
   where tenant_id = p_tenant_id and occurred_at between p_from and p_to;

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
    ) raw
    group by day_key
  ) s;

  return jsonb_build_object('totals', v_totals, 'by_de', v_by_de, 'by_day', v_by_day,
                            'price_per_resolution_cents', v_price);
end;
$function$;
