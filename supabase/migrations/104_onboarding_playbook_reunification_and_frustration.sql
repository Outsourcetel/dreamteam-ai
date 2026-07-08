-- ============================================================
-- Migration 104: two roadmap gaps closed together because they turned
-- out to be one root cause and one dormant capability, not four
-- separate features (founder picked items #8/#9/#11/#13; #11 is
-- already closed — see note at the bottom of this file).
--
-- PART A — #9 (auto-kickoff onboarding on a won deal) + #13 (reunify
-- onboarding with the playbook engine). The opportunity_won automatic
-- dispatcher path has been fully wired since migration 023
-- (dispatch_due_triggers -> real playbook_trigger_fires rows ->
-- playbook-execute really starts a run) — but no playbook step type
-- can create an onboarding project. The only caller of
-- create_onboarding_project today is the manual UI checkbox inside
-- close_opportunity_won, which bypasses the playbook engine entirely.
-- So a deal can close as won and the automatic path starts a real
-- playbook run with nothing real to do. Fixing this one gap closes
-- both roadmap items: #9 because the automatic path can now really
-- create the project, #13 because onboarding becomes reachable
-- through the same generic trigger/schedule machinery every other
-- department already uses.
--
-- create_onboarding_project resolves its tenant via
-- `select tenant_id from profiles where user_id = auth.uid()` — this
-- fails closed under playbook-execute's service-role context (no JWT).
-- Fix mirrors get_identity_inventory's existing service-role branch
-- (same migration 059 this function lives in), not a new `_service`
-- twin: add p_tenant_id, branch on auth.role() = 'service_role'.
-- ============================================================

create or replace function public.create_onboarding_project(
  p_account_id uuid,
  p_version_id uuid,
  p_name text default null::text,
  p_target date default null::date,
  p_tenant_id uuid default null   -- service-role callers only
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_tenant  uuid;
  v_is_service boolean := coalesce(auth.role(), '') = 'service_role';
  v_is_active boolean;
  v_acct    customer_accounts;
  v_ver     onboarding_template_versions;
  v_state   jsonb;
  v_proj_id uuid;
  v_name    text;
  v_created_by uuid;
begin
  if v_is_service then
    if p_tenant_id is null then
      return jsonb_build_object('error', 'tenant_id_required_for_service_call');
    end if;
    v_tenant := p_tenant_id;
    v_created_by := null;  -- honest: no human initiated this call
  else
    select tenant_id, coalesce(is_active, true) into v_tenant, v_is_active from profiles where user_id = auth.uid() limit 1;
    if v_tenant is null then raise exception 'no tenant for caller'; end if;
    if not v_is_active then raise exception 'account is deactivated'; end if;
    v_created_by := auth.uid();
  end if;

  select * into v_acct from customer_accounts where id = p_account_id and tenant_id = v_tenant;
  if not found then return jsonb_build_object('error', 'account_not_found'); end if;

  select * into v_ver from onboarding_template_versions where id = p_version_id and tenant_id = v_tenant;
  if not found then return jsonb_build_object('error', 'template_version_not_found'); end if;

  select jsonb_agg(jsonb_build_object(
    'key', i->>'key', 'status', 'pending', 'assignee', null, 'note', ''))
    into v_state
  from jsonb_array_elements(v_ver.items) i;

  v_name := coalesce(nullif(trim(p_name), ''), format('%s — %s', v_acct.name, v_ver.name));

  insert into onboarding_projects (tenant_id, account_id, template_version_id, name, target_golive, items_state, created_by)
  values (v_tenant, p_account_id, p_version_id, v_name, p_target, coalesce(v_state, '[]'::jsonb), v_created_by)
  returning id into v_proj_id;

  perform append_audit_event_internal(
    v_tenant, case when v_is_service then 'Playbook DE' else 'You' end, case when v_is_service then 'de' else 'human' end,
    format('Onboarding project created — %s (%s v%s, %s items)', v_name, v_ver.name, v_ver.version, jsonb_array_length(v_ver.items)),
    'config_change',
    jsonb_build_object('kind', 'onboarding_project_create', 'project_id', v_proj_id,
                       'account_id', p_account_id, 'version_id', p_version_id));

  insert into activity_events (tenant_id, account_id, actor, actor_type, event_type, text)
  values (v_tenant, p_account_id, case when v_is_service then 'Playbook DE' else 'You' end, case when v_is_service then 'de' else 'human' end, 'config_change',
          format('Onboarding started — %s', v_acct.name));

  return jsonb_build_object('project_id', v_proj_id);
end;
$function$;

revoke all on function public.create_onboarding_project(uuid, uuid, text, date, uuid) from public, anon;
grant execute on function public.create_onboarding_project(uuid, uuid, text, date, uuid) to authenticated, service_role;

-- `create or replace` with an added parameter does NOT replace the old
-- 4-arg overload — Postgres treats different arg counts as distinct
-- overloads, so close_opportunity_won's existing 4-arg positional call
-- would silently keep hitting the old, unpatched version forever.
-- Caught live during this migration's own verification pass (both
-- overloads existed side by side immediately after apply) — drop the
-- stale one outright, same discipline as every other signature cutover
-- in this file.
drop function if exists public.create_onboarding_project(uuid, uuid, text, date);

-- ============================================================
-- PART B — #8 (sentiment/frustration detection). score_frustration_
-- internal (migration 070) is a real, deterministic, non-LLM,
-- tenant-configurable pattern-matcher — today it's used ONLY
-- internally by Knowledge Gap Detection for cluster severity. The
-- live Support triage path never calls it.
--
-- decide_inquiry_triage (034) is barely used — its only caller is
-- simulate_inquiry, a manual demo-safe test trigger. The real,
-- cron-driven decision path is its sibling decide_work_item_triage
-- (036), called from the proactive poll. Both need the identical
-- addition or this only works in the demo trigger, not for real.
--
-- New decision tier: guardrail > frustration > trust dial. A
-- genuinely angry customer should always get a human, even at
-- confidence that would otherwise auto-send. Threshold 50 (two
-- matching frustration_signal rules) is an invented v1 literal,
-- same category as this codebase's existing hardcoded $10,000
-- guardrail-threshold precedent — flagged here, not hidden.
-- ============================================================

alter table evidence_run_decisions add column if not exists frustration_score integer;
alter table evidence_run_decisions add constraint evidence_run_decisions_frustration_score_check
  check (frustration_score is null or (frustration_score between 0 and 100));

create or replace function decide_inquiry_triage(p_tenant_id uuid, p_inquiry text, p_confidence integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_rule       record;
  v_text       text := lower(coalesce(p_inquiry, ''));
  v_autonomy   record;
  v_min_conf   integer;
  v_enabled    boolean;
  v_frag       text;
  v_hit        boolean;
  v_frustration integer;
begin
  -- 1) Guardrail check — blocking blocked_topic/blocked_phrase rules,
  --    identical matching to checkAnswerGuardrails (specialist-consult).
  for v_rule in
    select id, rule, pattern from guardrail_rules
    where tenant_id = p_tenant_id and active and severity = 'blocking'
      and rule_type in ('blocked_phrase', 'blocked_topic')
  loop
    if v_rule.pattern is null then continue; end if;
    foreach v_frag in array string_to_array(v_rule.pattern, '|') loop
      v_frag := trim(both from lower(v_frag));
      if v_frag = '' then continue; end if;
      begin
        v_hit := v_text ~ v_frag;
      exception when others then
        v_hit := position(v_frag in v_text) > 0;
      end;
      if v_hit then
        return jsonb_build_object(
          'decision', 'blocked_guardrail',
          'confidence', p_confidence,
          'guardrail_rule_id', v_rule.id,
          'guardrail_rule', v_rule.rule,
          'trust_level', null,
          'frustration_score', null,
          'reasoning', format('Blocked: guardrail rule "%s" matched this inquiry — routed to a human regardless of confidence (%s%%). Guardrails always win over the trust dial.', v_rule.rule, p_confidence)
        );
      end if;
    end loop;
  end loop;

  -- 1.5) Frustration check — deterministic, tenant-configured
  -- frustration_signal guardrail_rules (score_frustration_internal,
  -- migration 070), previously only used for Knowledge Gap cluster
  -- severity. A high score forces needs_review even if confidence
  -- would otherwise clear the trust-dial floor.
  v_frustration := score_frustration_internal(p_tenant_id, p_inquiry);
  if v_frustration >= 50 then
    return jsonb_build_object(
      'decision', 'needs_review',
      'confidence', p_confidence,
      'guardrail_rule_id', null,
      'guardrail_rule', null,
      'trust_level', null,
      'frustration_score', v_frustration,
      'reasoning', format('Needs review: this inquiry scored %s%% on frustration signals — routed to a human regardless of confidence (%s%%). A frustrated customer always gets a human.', v_frustration, p_confidence)
    );
  end if;

  -- 2) Trust dial (de_autonomy, action_type='answer_widget') — the
  --    SAME table/row generateInvoice's sibling dial reads, just the
  --    confidence-unit category instead of the amount-unit one.
  select enabled, min_confidence into v_autonomy
  from de_autonomy where tenant_id = p_tenant_id and action_type = 'answer_widget';
  v_enabled := coalesce(v_autonomy.enabled, false);
  v_min_conf := v_autonomy.min_confidence;

  if v_enabled and v_min_conf is not null and p_confidence >= v_min_conf then
    return jsonb_build_object(
      'decision', 'would_auto_send',
      'confidence', p_confidence,
      'guardrail_rule_id', null,
      'guardrail_rule', null,
      'trust_level', v_min_conf,
      'frustration_score', v_frustration,
      'reasoning', format('Would auto-send: confidence %s%% clears the trust-dial floor of %s%% for auto-answering customers, and no guardrail blocked it. Recorded as intent only — no outbound reply channel exists yet, so nothing was actually sent.', p_confidence, v_min_conf)
    );
  end if;

  return jsonb_build_object(
    'decision', 'needs_review',
    'confidence', p_confidence,
    'guardrail_rule_id', null,
    'guardrail_rule', null,
    'trust_level', v_min_conf,
    'frustration_score', v_frustration,
    'reasoning', case
      when not v_enabled then format('Needs review: confidence %s%%, but auto-answering customers is not yet enabled on the trust dial (Governance -> Trust & Architecture).', p_confidence)
      else format('Needs review: confidence %s%% is below the trust-dial floor of %s%% required to auto-answer customers.', p_confidence, coalesce(v_min_conf, 0))
    end
  );
end;
$$;

revoke all on function decide_inquiry_triage(uuid, text, integer) from public;
grant execute on function decide_inquiry_triage(uuid, text, integer) to service_role;

create or replace function decide_work_item_triage(p_tenant_id uuid, p_category text, p_inquiry text, p_confidence integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_rule       record;
  v_text       text := lower(coalesce(p_inquiry, ''));
  v_autonomy   record;
  v_min_conf   integer;
  v_enabled    boolean;
  v_frag       text;
  v_hit        boolean;
  v_frustration integer;
begin
  -- 1) Guardrail check — identical matching to decide_inquiry_triage.
  for v_rule in
    select id, rule, pattern from guardrail_rules
    where tenant_id = p_tenant_id and active and severity = 'blocking'
      and rule_type in ('blocked_phrase', 'blocked_topic')
  loop
    if v_rule.pattern is null then continue; end if;
    foreach v_frag in array string_to_array(v_rule.pattern, '|') loop
      v_frag := trim(both from lower(v_frag));
      if v_frag = '' then continue; end if;
      begin
        v_hit := v_text ~ v_frag;
      exception when others then
        v_hit := position(v_frag in v_text) > 0;
      end;
      if v_hit then
        return jsonb_build_object(
          'decision', 'blocked_guardrail',
          'confidence', p_confidence,
          'guardrail_rule_id', v_rule.id,
          'guardrail_rule', v_rule.rule,
          'trust_level', null,
          'frustration_score', null,
          'reasoning', format('Blocked: guardrail rule "%s" matched this %s item — routed to a human regardless of confidence (%s%%). Guardrails always win over the trust dial.', v_rule.rule, p_category, p_confidence)
        );
      end if;
    end loop;
  end loop;

  -- 1.5) Frustration check — same tier as decide_inquiry_triage.
  v_frustration := score_frustration_internal(p_tenant_id, p_inquiry);
  if v_frustration >= 50 then
    return jsonb_build_object(
      'decision', 'needs_review',
      'confidence', p_confidence,
      'guardrail_rule_id', null,
      'guardrail_rule', null,
      'trust_level', null,
      'frustration_score', v_frustration,
      'reasoning', format('Needs review: this %s item scored %s%% on frustration signals — routed to a human regardless of confidence (%s%%). A frustrated customer always gets a human.', p_category, v_frustration, p_confidence)
    );
  end if;

  -- 2) Trust dial (de_autonomy, action_type='answer_widget') —
  --    category-specific row first, else the legacy tenant-wide row
  --    (source_category is null). Same mechanism since migration 025;
  --    only the resolution now considers source_category before
  --    falling back.
  select enabled, min_confidence into v_autonomy
  from de_autonomy
  where tenant_id = p_tenant_id and action_type = 'answer_widget'
    and source_category = p_category
  limit 1;
  if not found then
    select enabled, min_confidence into v_autonomy
    from de_autonomy
    where tenant_id = p_tenant_id and action_type = 'answer_widget'
      and source_category is null
    limit 1;
  end if;
  v_enabled := coalesce(v_autonomy.enabled, false);
  v_min_conf := v_autonomy.min_confidence;

  if v_enabled and v_min_conf is not null and p_confidence >= v_min_conf then
    return jsonb_build_object(
      'decision', 'would_auto_send',
      'confidence', p_confidence,
      'guardrail_rule_id', null,
      'guardrail_rule', null,
      'trust_level', v_min_conf,
      'frustration_score', v_frustration,
      'reasoning', format('Would auto-send: confidence %s%% clears the trust-dial floor of %s%% for auto-answering on %s, and no guardrail blocked it. Recorded as intent only unless a registered action can act on this item.', p_confidence, v_min_conf, p_category)
    );
  end if;

  return jsonb_build_object(
    'decision', 'needs_review',
    'confidence', p_confidence,
    'guardrail_rule_id', null,
    'guardrail_rule', null,
    'trust_level', v_min_conf,
    'frustration_score', v_frustration,
    'reasoning', case
      when not v_enabled then format('Needs review: confidence %s%%, but auto-answering on %s is not yet enabled on the trust dial (Governance -> Trust & Architecture).', p_confidence, p_category)
      else format('Needs review: confidence %s%% is below the trust-dial floor of %s%% required to auto-answer on %s.', p_confidence, coalesce(v_min_conf, 0), p_category)
    end
  );
end;
$$;

revoke all on function decide_work_item_triage(uuid, text, text, integer) from public;
grant execute on function decide_work_item_triage(uuid, text, text, integer) to service_role;

-- score_frustration_internal is called by decide_inquiry_triage/
-- decide_work_item_triage now (both service_role-only, same as
-- score_frustration_internal itself) — no grant change needed.

-- ── record_inquiry_decision: additive 13th param, drop-and-recreate
-- the old 12-arg signature outright (this codebase's established
-- discipline, e.g. the source_category cutover in this same
-- function) — not left dangling for a stale caller to hit by accident.
create or replace function record_inquiry_decision(
  p_tenant_id       uuid,
  p_evidence_run_id uuid,
  p_connector_id    uuid,
  p_external_ref    text,
  p_source          text,
  p_decision        text,
  p_confidence      integer,
  p_guardrail_rule_id uuid,
  p_trust_level     integer,
  p_reasoning       text,
  p_inquiry_title   text,
  p_source_category text default null,
  p_frustration_score integer default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_task_id uuid;
  v_row_id  uuid;
  v_run     record;
  v_subject_kind text;
  v_subject_id   uuid;
  v_ref     text;
begin
  if p_decision = 'needs_review' then
    insert into human_tasks (tenant_id, type, title, detail, source, related_table, related_id, status)
    values (
      p_tenant_id, 'inquiry_review',
      format('Review inquiry — %s', left(coalesce(p_inquiry_title, '(no subject)'), 120)),
      p_reasoning, 'de', 'evidence_runs', p_evidence_run_id, 'pending'
    )
    returning id into v_task_id;
  end if;

  insert into evidence_run_decisions (
    tenant_id, evidence_run_id, connector_id, external_ref, source, decision,
    confidence, guardrail_rule_id, trust_level, reasoning, human_task_id, source_category,
    frustration_score
  ) values (
    p_tenant_id, p_evidence_run_id, p_connector_id, p_external_ref, p_source, p_decision,
    p_confidence, p_guardrail_rule_id, p_trust_level, p_reasoning, v_task_id, p_source_category,
    p_frustration_score
  )
  on conflict (evidence_run_id) do update set
    decision = excluded.decision, confidence = excluded.confidence,
    guardrail_rule_id = excluded.guardrail_rule_id, trust_level = excluded.trust_level,
    reasoning = excluded.reasoning, human_task_id = coalesce(evidence_run_decisions.human_task_id, excluded.human_task_id),
    source_category = coalesce(excluded.source_category, evidence_run_decisions.source_category),
    frustration_score = coalesce(excluded.frustration_score, evidence_run_decisions.frustration_score)
  returning id into v_row_id;

  -- ── DE MEMORY (migration 044) — unchanged from prior definition ──
  select de_id, specialist_id, account_ref into v_run from evidence_runs where id = p_evidence_run_id;
  if v_run.de_id is not null then
    v_subject_kind := 'de'; v_subject_id := v_run.de_id;
  elsif v_run.specialist_id is not null then
    v_subject_kind := 'specialist'; v_subject_id := v_run.specialist_id;
  end if;
  v_ref := coalesce(nullif(p_external_ref, ''), nullif(v_run.account_ref, ''));

  if v_subject_id is not null and p_source_category is not null and v_ref is not null then
    perform record_de_experience(
      p_tenant_id, v_subject_kind, v_subject_id, p_source_category, v_ref,
      format('%s inquiry via %s (source: %s)', initcap(replace(p_source_category, '_', ' ')), coalesce(p_inquiry_title, '(untitled)'), p_source),
      format('Decision: %s%s', p_decision, case when p_confidence is not null then format(' (confidence %s%%)', p_confidence) else '' end),
      p_reasoning,
      p_evidence_run_id, null
    );
  end if;

  return jsonb_build_object('id', v_row_id, 'human_task_id', v_task_id);
end;
$$;

revoke all on function record_inquiry_decision(uuid, uuid, uuid, text, text, text, integer, uuid, integer, text, text, text, integer) from public, anon, authenticated;
grant execute on function record_inquiry_decision(uuid, uuid, uuid, text, text, text, integer, uuid, integer, text, text, text, integer) to service_role;

drop function if exists record_inquiry_decision(uuid, uuid, uuid, text, text, text, integer, uuid, integer, text, text, text);

-- ============================================================
-- get_de_performance_metrics: widen with real frustration aggregates.
-- Widening a `returns table` signature needs drop + create, not
-- create or replace (same discipline as the cutover above).
-- ============================================================
drop function if exists public.get_de_performance_metrics(uuid, integer);

create function public.get_de_performance_metrics(p_tenant_id uuid, p_weeks integer default 26)
returns table(
  de_id uuid,
  de_name text,
  total_decisions bigint,
  resolution_rate numeric,
  avg_confidence numeric,
  escalation_rate numeric,
  blocked_guardrail_count bigint,
  total_runs bigint,
  error_rate numeric,
  avg_frustration_score numeric,
  high_frustration_count bigint,
  trend jsonb
)
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
    raise exception 'not authorized to view this workspace''s performance data';
  end if;

  return query
    with decisions as (
      select er.de_id as d_de_id, d.confidence as d_confidence, d.decision as d_decision,
        d.human_task_id as d_human_task_id, d.created_at as d_created_at,
        d.frustration_score as d_frustration_score
      from evidence_run_decisions d
      join evidence_runs er on er.id = d.evidence_run_id
      where er.tenant_id = p_tenant_id and er.de_id is not null
    ),
    runs as (
      select er.de_id as r_de_id, er.status as r_status
      from evidence_runs er
      where er.tenant_id = p_tenant_id and er.de_id is not null
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
      coalesce(s.total_decisions, 0),
      coalesce(s.resolution_rate, 0),
      coalesce(s.avg_confidence, 0),
      coalesce(s.escalation_rate, 0),
      coalesce(s.blocked_guardrail_count, 0),
      coalesce(rs.total_runs, 0),
      coalesce(rs.error_rate, 0),
      coalesce(s.avg_frustration_score, 0),
      coalesce(s.high_frustration_count, 0),
      coalesce(t.trend, '[]'::jsonb)
    from digital_employees de
    left join summary s on s.s_de_id = de.id
    left join run_summary rs on rs.rs_de_id = de.id
    left join trend_agg t on t.t_de_id = de.id
    where de.tenant_id = p_tenant_id
    order by de.name;
end;
$function$;

revoke all on function public.get_de_performance_metrics(uuid, integer) from public, anon;
grant execute on function public.get_de_performance_metrics(uuid, integer) to authenticated;

-- ============================================================
-- Starter frustration_signal guardrail_rules — Acme Telecom only,
-- never the demo tenant. Without at least one rule configured,
-- score_frustration_internal always returns 0 and this whole build
-- would show honestly-empty data forever on the one real tenant we
-- can verify against. Four realistic B2B SaaS phrases, 25 pts each —
-- two hits crosses the 50-point threshold by design.
-- ============================================================
insert into guardrail_rules (tenant_id, rule, rule_type, pattern, severity, active)
select 'a1b2c3d4-0000-0000-0000-000000000001'::uuid, v.rule, 'frustration_signal', v.pattern, 'warning', true
from (values
  ('Explicit escalation demand', 'speak to a manager|speak with a manager|this is unacceptable|totally unacceptable'),
  ('Repeated-contact frustration', 'third time i|already told you|i''ve asked this before|keep asking'),
  ('Churn/cancellation threat', 'cancel(l)?ing my (subscription|account|plan)|switching to a competitor|find another (provider|vendor)'),
  ('Strong negative sentiment', 'worst support|completely useless|waste of (my )?time|ridiculous that')
) as v(rule, pattern)
where not exists (
  select 1 from guardrail_rules gr
  where gr.tenant_id = 'a1b2c3d4-0000-0000-0000-000000000001'::uuid and gr.rule_type = 'frustration_signal' and gr.rule = v.rule
);
