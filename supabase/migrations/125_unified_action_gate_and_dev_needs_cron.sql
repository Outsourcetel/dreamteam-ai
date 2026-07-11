-- DE-B3: one decision brain, one ledger, and a real development-needs
-- cadence (constitution §8/§11, gap_analysis_v3's "start_onboarding
-- inconsistency").
--
-- What this closes:
--   1. decide_action_execution never got Wave 1.1: it did raw
--      de_autonomy lookups with NO de_id dimension, so a per-employee
--      trust dial override never applied to registered actions. It
--      also had no amount concept, which is why generate_invoice kept
--      a private TypeScript copy of the guardrail+dial composition.
--      Fixed: the function gains p_de_id / p_amount_cents /
--      p_action_type and resolves through the shared
--      resolve_de_autonomy cascade — the composition is now written
--      once, in SQL, for every caller.
--   2. The two bespoke playbook steps (generate_invoice,
--      start_onboarding) executed with no action_definitions identity
--      and no action_executions ledger row — invisible to the DE's
--      action history, incident sweeps, and Systems & Actions. Fixed:
--      both get platform-scope 'internal' definitions and the step
--      executors record honest ledger rows (playbook-execute change,
--      deployed alongside). Their approval UX is the playbook's own
--      human_approval step, so record_action_execution gains
--      p_create_task to write a truthful gated ledger row WITHOUT
--      minting a duplicate action_approval task.
--   3. detect_de_development_needs (112) was auth-gated only — no
--      cron could ever run it, so development needs were detected
--      only when a human happened to click. Fixed: service-side
--      sibling + a daily cron, same split as detect_de_incidents.

-- ────────────────────────────────────────────────────────────────
-- 1. Internal actions have no connector.
-- ────────────────────────────────────────────────────────────────
alter table action_executions alter column connector_id drop not null;

-- ────────────────────────────────────────────────────────────────
-- 2. decide_action_execution — extended signature. Old callers
--    (connector-hub, named args) resolve unchanged via the defaults;
--    the old 4-arg overload is dropped so exactly one brain exists.
--    Composition order is UNCHANGED: destructive-always-gates →
--    guardrail-always-wins → trust-narrows-within-it. New inside the
--    trust tier: per-DE resolution (resolve_de_autonomy cascade) and,
--    when p_amount_cents is supplied, the amount composition that
--    previously lived only in generate_invoice's TypeScript
--    (require_approval_over_cents guardrail + the dial's
--    max_amount_cents cap).
-- ────────────────────────────────────────────────────────────────
drop function if exists decide_action_execution(uuid, text, text, boolean);

create function decide_action_execution(
  p_tenant_id     uuid,
  p_action_label  text,
  p_category      text,
  p_destructive   boolean,
  p_de_id         uuid default null,
  p_amount_cents  bigint default null,
  p_action_type   text default 'action_execute'
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_rule      record;
  v_text      text := lower(coalesce(p_action_label, '') || ' ' || coalesce(p_category, ''));
  v_autonomy  record;
  v_frag      text;
  v_hit       boolean;
  v_threshold bigint;
begin
  -- 0) DESTRUCTIVE ALWAYS GATES — checked first, unconditionally.
  if coalesce(p_destructive, true) then
    return jsonb_build_object(
      'decision', 'human_gated_destructive',
      'guardrail_rule_id', null, 'guardrail_rule', null, 'trust_level', null,
      'reasoning', format('This action is marked destructive — it always requires human approval regardless of trust level. This is a platform safety floor, not a per-department setting: "%s" will never auto-execute.', p_action_label)
    );
  end if;

  -- 1) Guardrail check — same blocked_topic/blocked_phrase matching as
  --    decide_inquiry_triage/checkAnswerGuardrails. Guardrails always
  --    win over the trust dial.
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
          'decision', 'guardrail_blocked',
          'guardrail_rule_id', v_rule.id, 'guardrail_rule', v_rule.rule, 'trust_level', null,
          'reasoning', format('Blocked: guardrail rule "%s" matched this action — routed to a human regardless of trust. Guardrails always win over the trust dial.', v_rule.rule)
        );
      end if;
    end loop;
  end loop;

  -- 1.5) Amount guardrail (require_approval_over_cents) — only when the
  --      caller supplies an amount. A gate, not a block: the action
  --      still happens after a human approves (matching the invoice
  --      flow's live semantics, where over-threshold invoices are
  --      created as awaiting_approval, never refused).
  if p_amount_cents is not null then
    select threshold into v_threshold from guardrail_rules
    where tenant_id = p_tenant_id and rule_type = 'require_approval_over_cents' and active
    order by updated_at desc limit 1;
    v_threshold := coalesce(v_threshold, 1000000);  -- $10,000 platform default, same as the old TS constant
    if p_amount_cents > v_threshold then
      return jsonb_build_object(
        'decision', 'human_gated_trust',
        'guardrail_rule_id', null, 'guardrail_rule', 'require_approval_over_cents', 'trust_level', null,
        'reasoning', format('Needs approval: "%s" is for $%s, above this workspace''s $%s approval threshold. Amounts over the threshold always get a human, regardless of the trust dial.', p_action_label, round(p_amount_cents / 100.0), round(v_threshold / 100.0))
      );
    end if;
  end if;

  -- 2) Trust dial — per-employee first now (Wave 1.1 cascade, the fix
  --    this sibling never received): exact de+category → de-wide →
  --    category-wide → tenant-wide, via the shared resolve_de_autonomy.
  --    An unconfigured dial resolves to (false, null, null) — trust is
  --    opt-in, never assumed.
  select * into v_autonomy from resolve_de_autonomy(p_tenant_id, p_action_type, p_de_id, p_category);

  if coalesce(v_autonomy.enabled, false)
     and (p_amount_cents is null
          or (v_autonomy.max_amount_cents is not null and p_amount_cents <= v_autonomy.max_amount_cents)) then
    return jsonb_build_object(
      'decision', 'auto_executed',
      'guardrail_rule_id', null, 'guardrail_rule', null, 'trust_level', 1,
      'reasoning', case
        when p_amount_cents is not null then
          format('Auto-executed: "%s" ($%s) is within both the workspace approval threshold and the earned trust-dial limit of $%s%s, and no guardrail blocked it.',
            p_action_label, round(p_amount_cents / 100.0), round(v_autonomy.max_amount_cents / 100.0),
            case when p_de_id is not null then ' resolved for this employee' else '' end)
        else
          format('Auto-executed: "%s" is not destructive, no guardrail blocked it, and the trust dial%s allows auto-executing non-destructive actions for %s.',
            p_action_label, case when p_de_id is not null then ' (resolved for this employee)' else '' end, p_category)
      end
    );
  end if;

  return jsonb_build_object(
    'decision', 'human_gated_trust',
    'guardrail_rule_id', null, 'guardrail_rule', null, 'trust_level', null,
    'reasoning', case
      when not coalesce(v_autonomy.enabled, false) then
        format('Needs approval: "%s" is not destructive, but the trust dial has not enabled auto-execution for %s %s actions yet (Governance -> Trust & Architecture).',
          p_action_label, case when p_de_id is not null then 'this employee''s' else 'this workspace''s' end, p_category)
      else
        format('Needs approval: "%s" ($%s) exceeds the trust-dial limit of %s earned so far.',
          p_action_label, round(coalesce(p_amount_cents, 0) / 100.0),
          coalesce('$' || round(v_autonomy.max_amount_cents / 100.0)::text, 'no amount'))
    end
  );
end;
$$;

revoke all on function decide_action_execution(uuid, text, text, boolean, uuid, bigint, text) from public, anon, authenticated;
grant execute on function decide_action_execution(uuid, text, text, boolean, uuid, bigint, text) to service_role;

-- ────────────────────────────────────────────────────────────────
-- 3. record_action_execution — p_create_task. The playbook's invoice
--    approval UX is its own human_approval step (approval_gate task +
--    run resume); the ledger row must still say human_gated_trust
--    truthfully without minting a second, competing action_approval
--    task for the same invoice.
-- ────────────────────────────────────────────────────────────────
drop function if exists record_action_execution(uuid, uuid, uuid, text, uuid, text, jsonb, text, boolean, boolean, text, text, text, jsonb, text, text);

create function record_action_execution(
  p_tenant_id            uuid,
  p_action_definition_id uuid,
  p_connector_id         uuid,
  p_subject_kind         text,
  p_subject_id           uuid,
  p_mode                 text,
  p_params               jsonb,
  p_decision             text,
  p_destructive          boolean,
  p_idempotent           boolean,
  p_dedupe_key           text,
  p_request_summary      text,
  p_receipt              text,
  p_result               jsonb,
  p_task_title           text,
  p_task_detail          text,
  p_create_task          boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_task_id uuid;
  v_row_id  uuid;
  v_category text;
  v_label    text;
  v_ref      text;
begin
  if p_create_task and p_decision in ('human_gated_destructive', 'human_gated_trust') then
    insert into human_tasks (tenant_id, type, title, detail, source, related_table, related_id, status)
    values (
      p_tenant_id, 'action_approval',
      coalesce(p_task_title, 'Action awaiting approval'),
      coalesce(p_task_detail, ''), 'de', 'action_executions', null, 'pending'
    )
    returning id into v_task_id;
  end if;

  insert into action_executions (
    tenant_id, action_definition_id, connector_id, subject_kind, subject_id,
    mode, params, decision, destructive, idempotent, dedupe_key,
    request_summary, receipt, result, task_id
  ) values (
    p_tenant_id, p_action_definition_id, p_connector_id, p_subject_kind, p_subject_id,
    p_mode, coalesce(p_params, '{}'::jsonb), p_decision, coalesce(p_destructive, true), coalesce(p_idempotent, false), p_dedupe_key,
    coalesce(p_request_summary, ''), p_receipt, p_result, v_task_id
  )
  returning id into v_row_id;

  if v_task_id is not null then
    update human_tasks set related_id = v_row_id where id = v_task_id;
  end if;

  -- ── DE MEMORY (migration 044) — only on EXECUTE mode (a preview call
  -- never really happened, so it is honestly not "experience"), and
  -- only when a category + external_ref are resolvable.
  if p_mode = 'execute' and p_subject_id is not null then
    select category into v_category from action_definitions where id = p_action_definition_id;
    select label into v_label from action_definitions where id = p_action_definition_id;
    v_ref := coalesce(
      nullif(p_params->>'external_ref', ''),
      nullif(p_params->>'account_name', ''),
      nullif(p_params->>'account_ref', '')
    );
    if v_category is not null and v_ref is not null then
      perform record_de_experience(
        p_tenant_id, p_subject_kind, p_subject_id, v_category, v_ref,
        format('Considered action "%s" (%s)', coalesce(v_label, 'action'), coalesce(p_request_summary, '')),
        format('Decision: %s', p_decision),
        coalesce(p_receipt, case
          when p_decision in ('human_gated_destructive', 'human_gated_trust') then 'Awaiting human approval — not yet executed.'
          when p_decision = 'failed' then 'Attempted but failed — see result for detail.'
          else 'No receipt recorded.'
        end),
        null, v_row_id
      );
    end if;
  end if;

  return jsonb_build_object('id', v_row_id, 'task_id', v_task_id);
end;
$$;

revoke all on function record_action_execution(uuid, uuid, uuid, text, uuid, text, jsonb, text, boolean, boolean, text, text, text, jsonb, text, text, boolean) from public, anon, authenticated;
grant execute on function record_action_execution(uuid, uuid, uuid, text, uuid, text, jsonb, text, boolean, boolean, text, text, text, jsonb, text, text, boolean) to service_role;

-- ────────────────────────────────────────────────────────────────
-- 4. Registry identity for the two internal actions. Platform scope
--    (shared by every tenant, like the built-in helpdesk actions).
--    provider 'internal' = executed by the playbook engine itself,
--    never by connector-hub. destructive=false: their gating is the
--    amount/trust composition (invoice) or an internal record write
--    (onboarding project), not an irreversible external side effect.
--    NOTE: the unique constraint doesn't cover platform rows
--    (tenant_id null), hence WHERE NOT EXISTS instead of ON CONFLICT.
-- ────────────────────────────────────────────────────────────────
insert into action_definitions (scope, tenant_id, category, action_key, label, description, provider, param_schema, risk, execution)
select 'platform', null, 'billing', 'generate_invoice',
  'Generate a renewal invoice',
  'Creates a renewal invoice for an account. Auto-sends only within the workspace approval threshold AND the earned trust-dial amount limit; otherwise it is created awaiting human approval via the playbook''s approval step.',
  'internal',
  '[{"name": "amount_cents", "type": "number", "required": true, "help": "Invoice amount in cents"}, {"name": "account_name", "type": "string", "required": false, "help": "Account the invoice is for"}]'::jsonb,
  '{"destructive": false, "idempotent": false}'::jsonb,
  '{"kind": "internal", "handler": "playbook-execute:generate_invoice"}'::jsonb
where not exists (
  select 1 from action_definitions where scope = 'platform' and category = 'billing' and action_key = 'generate_invoice'
);

insert into action_definitions (scope, tenant_id, category, action_key, label, description, provider, param_schema, risk, execution)
select 'platform', null, 'other', 'start_onboarding',
  'Start an onboarding project',
  'Creates an internal onboarding project for an account from a published template — an internal record write (no external system is touched), executed ungated by design from human-published playbooks, recorded here for the ledger.',
  'internal',
  '[{"name": "template_version_id", "type": "string", "required": true, "help": "Published onboarding template version id"}, {"name": "account_name", "type": "string", "required": false, "help": "Account being onboarded"}]'::jsonb,
  '{"destructive": false, "idempotent": false}'::jsonb,
  '{"kind": "internal", "handler": "playbook-execute:start_onboarding"}'::jsonb
where not exists (
  select 1 from action_definitions where scope = 'platform' and category = 'other' and action_key = 'start_onboarding'
);

-- ────────────────────────────────────────────────────────────────
-- 4b. get_agentic_tools_for_de: internal actions are executed by the
--     playbook engine, never via connector-hub — exposing them as
--     agentic tools would give the model a tool that always refuses.
--     Body verbatim from migration 074 plus the one-line provider
--     filter.
-- ────────────────────────────────────────────────────────────────
create or replace function public.get_agentic_tools_for_de(p_tenant_id uuid, p_de_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_tools jsonb := '[]'::jsonb;
  v_conn record;
  v_def record;
  v_verdict jsonb;
  v_properties jsonb;
  v_required jsonb;
  v_param record;
  v_type text;
begin
  for v_conn in
    select id, category, display_name, provider
    from connectors
    where tenant_id = p_tenant_id and status = 'connected'
  loop
    for v_def in
      select *
      from action_definitions
      where status = 'active'
        and provider <> 'internal'
        and category = v_conn.category
        and (scope = 'platform' or (scope = 'tenant' and tenant_id = p_tenant_id))
    loop
      select resolve_access(p_tenant_id, 'de', p_de_id, v_conn.id, 'write_back') into v_verdict;
      if coalesce((v_verdict->>'allowed')::boolean, false) then
        v_properties := '{}'::jsonb;
        v_required := '[]'::jsonb;

        for v_param in
          select * from jsonb_to_recordset(v_def.param_schema)
            as x(name text, type text, required boolean, help text)
        loop
          v_type := case v_param.type when 'number' then 'number' when 'boolean' then 'boolean' else 'string' end;
          v_properties := v_properties || jsonb_build_object(
            v_param.name, jsonb_build_object('type', v_type, 'description', coalesce(v_param.help, ''))
          );
          if coalesce(v_param.required, false) then
            v_required := v_required || to_jsonb(v_param.name);
          end if;
        end loop;

        v_tools := v_tools || jsonb_build_array(jsonb_build_object(
          'name', v_conn.category || '__' || v_def.action_key,
          'description', v_def.label || '. ' || v_def.description
                         || ' (system: ' || coalesce(nullif(v_conn.display_name, ''), v_conn.provider) || ')',
          'input_schema', jsonb_build_object(
            'type', 'object', 'properties', v_properties, 'required', v_required
          ),
          'connector_id', v_conn.id,
          'action_key', v_def.action_key,
          'destructive', coalesce((v_def.risk->>'destructive')::boolean, true)
        ));
      end if;
    end loop;
  end loop;

  return v_tools;
end;
$$;

revoke all on function public.get_agentic_tools_for_de(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_agentic_tools_for_de(uuid, uuid) to service_role;

-- ────────────────────────────────────────────────────────────────
-- 5. get_de_performance_metrics: service-role branch so the scheduled
--    detection below can read metrics (same single-function-branch
--    pattern as get_identity_inventory/create_onboarding_project).
--    Body verbatim from migration 104 apart from the gate.
-- ────────────────────────────────────────────────────────────────
create or replace function public.get_de_performance_metrics(p_tenant_id uuid, p_weeks integer default 26)
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
  -- Trusted server contexts may read any tenant's metrics: PostgREST
  -- service-role calls (auth.role() = 'service_role') AND direct DB
  -- sessions with no JWT at all (auth.role() is null — the cron sweep
  -- and the Management API run as postgres). PostgREST always stamps a
  -- role claim for anon/authenticated requests, and the EXECUTE grants
  -- below don't include anon, so a null role can only be a privileged
  -- direct session. Humans keep the exact gate from migration 104.
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
grant execute on function public.get_de_performance_metrics(uuid, integer) to authenticated, service_role;

-- ────────────────────────────────────────────────────────────────
-- 6. Scheduled development-needs detection: service-side sibling
--    (the authed function from 112/117 stays as the on-demand human
--    path and now delegates so the logic exists once).
--
--    ALSO FIXES A REAL REGRESSION FOUND WHILE BUILDING THIS:
--    migration 117's Remote-Access sweep recreated this function from
--    a stale body and reintroduced the exact 0-100-vs-0-1 percentage
--    scale bug migration 112 documented catching (escalation_spike
--    fired at 0.5% instead of 50%, error_rate at 0.15% instead of
--    15%, and descriptions multiplied already-percentage rates by 100).
--    get_de_performance_metrics returns escalation_rate/error_rate as
--    0-100 PERCENTAGES — thresholds below restore 112's correct scale.
-- ────────────────────────────────────────────────────────────────
create or replace function detect_de_development_needs_internal(p_tenant_id uuid default null)
returns setof de_development_items
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  t record;
  m record;
  v_candidate record;
  v_row de_development_items;
begin
  for t in
    select id from tenants
    where (p_tenant_id is null or id = p_tenant_id)
  loop
    for m in select * from get_de_performance_metrics(t.id, 8) where total_decisions >= 10
    loop
      for v_candidate in
        select * from (values
          ('escalation_spike', m.escalation_rate > 50, 'escalation_rate'::text, 30::numeric, m.escalation_rate,
            format('%s escalated %s%% of %s decisions over the last 8 weeks — more than half. Target: bring escalation rate under 30%%.', m.de_name, round(m.escalation_rate), m.total_decisions)),
          ('confidence_gap', m.avg_confidence < 50, 'avg_confidence', 65::numeric, m.avg_confidence,
            format('%s''s average confidence across %s decisions is %s%% — evidence or knowledge coverage may be thin. Target: 65%%+.', m.de_name, m.total_decisions, round(m.avg_confidence))),
          ('error_rate', m.error_rate > 15, 'error_rate', 5::numeric, m.error_rate,
            format('%s had a %s%% run error rate over the last 8 weeks (%s runs). Target: under 5%%.', m.de_name, round(m.error_rate), m.total_runs)),
          ('guardrail_pattern', m.total_runs > 0 and m.blocked_guardrail_count::numeric / m.total_runs > 0.1, 'blocked_guardrail_count', 0::numeric, m.blocked_guardrail_count::numeric,
            format('%s was blocked by a guardrail on %s of %s runs (%s%%) — review whether this is a knowledge gap or a genuinely out-of-scope request pattern.', m.de_name, m.blocked_guardrail_count, m.total_runs, round(m.blocked_guardrail_count::numeric / m.total_runs * 100)))
        ) as c(item_type, triggered, target_metric, target_value, baseline_value, description)
        where c.triggered
      loop
        insert into de_development_items (tenant_id, de_id, item_type, source, priority, description, target_metric, target_value, baseline_value, status)
        values (t.id, m.de_id, v_candidate.item_type, 'detected', 'medium', v_candidate.description, v_candidate.target_metric, v_candidate.target_value, v_candidate.baseline_value, 'proposed')
        on conflict (tenant_id, de_id, item_type) where source = 'detected' and status in ('proposed', 'in_progress')
        do update set description = excluded.description, baseline_value = excluded.baseline_value, updated_at = now()
        returning * into v_row;
        perform sync_de_lifecycle_from_development(m.de_id);
        return next v_row;
      end loop;
    end loop;
  end loop;
  return;
end;
$$;

revoke all on function detect_de_development_needs_internal(uuid) from public, anon, authenticated;
grant execute on function detect_de_development_needs_internal(uuid) to service_role;

-- The on-demand human path: keep its gate, delegate the detection.
create or replace function detect_de_development_needs(p_tenant_id uuid)
returns setof de_development_items
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tenant uuid;
begin
  v_tenant := auth_tenant_id();
  if v_tenant is null or v_tenant <> p_tenant_id then raise exception 'not a member of this workspace'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then raise exception 'only workspace owners/admins can scan for development needs'; end if;
  return query select * from detect_de_development_needs_internal(p_tenant_id);
end;
$$;

revoke all on function detect_de_development_needs(uuid) from public, anon;
grant execute on function detect_de_development_needs(uuid) to authenticated, service_role;

-- Clean up any items the regressed (117) thresholds over-created:
-- 'detected' items still awaiting review whose recorded baseline would
-- NOT trigger under the correct 0-100 scale. Human-touched items
-- (in_progress/completed/dismissed) are never deleted.
delete from de_development_items
where source = 'detected' and status = 'proposed'
  and ((item_type = 'escalation_spike' and baseline_value <= 50)
    or (item_type = 'error_rate' and baseline_value <= 15));

-- Daily cadence — development needs move on a weeks scale; daily is
-- plenty and keeps the sweep cheap. Same plain-SQL-cron pattern as
-- de-incident-sweep-5min (independent of the playbook dispatcher).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'de-development-needs-daily') then
    perform cron.unschedule('de-development-needs-daily');
  end if;
  perform cron.schedule('de-development-needs-daily', '0 6 * * *', 'select count(*) from detect_de_development_needs_internal()');
end $$;
