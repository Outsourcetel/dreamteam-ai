-- ============================================================
-- Migration 034: Proactive inquiry triage + live DE activity queue
--
-- Gap closed (gap-analysis Tier 0, items 3+4): today every evidence
-- run requires a human to click "resolve an inquiry" in SpecialistLive.
-- Nothing notices new work and acts on its own, and there is no
-- near-real-time view of a DE's reasoning while it works — only
-- after-the-fact audit rows.
--
-- RESEARCH GROUNDING (see memory/gap_analysis_roadmap.md +
-- feedback_research_before_build.md for the full pass):
--   - Decagon/Sierra escalation doctrine: auto-resolve is gated by
--     (a) a confidence threshold and (b) policy/guardrail rules that
--     route UNCONDITIONALLY regardless of confidence. We already have
--     both primitives (de_autonomy/trust_policies since migration 025,
--     guardrail_rules since migration 015) — this migration composes
--     them for inquiries exactly the way generateInvoice composes them
--     for invoices (customerApi.ts: "autonomy narrows within
--     guardrails, never overrides them"). No parallel confidence
--     system is invented. Sentiment/repeat-contact escalation is
--     explicitly OUT of scope for this pass (per the brief).
--   - 2026 agent-observability doctrine: dashboards must answer "is
--     the system making sound decisions", not just "is it running" —
--     semantic telemetry (the reasoning), not a structural spinner.
--     evidence_run_decisions.reasoning is a plain-language string
--     SERVER-COMPOSED from confidence_inputs + the guardrail/trust
--     check (same discipline as generateInvoice's audit detail) —
--     never free LLM text.
--
-- REUSE, NOT REINVENTION:
--   - Confidence: evidence_runs.confidence_inputs (migration
--     026/032) already carries knowledge_hits / history_corroborations
--     / account_context_found / systems_consulted counts. This
--     migration adds ONE deterministic scoring function
--     (compute_inquiry_confidence) that turns those counts into a
--     0-100 score — the same "server composes, never the client or a
--     free LLM" discipline used everywhere else in this codebase.
--   - Trust dial: reuses de_autonomy/trust_policies action_category
--     'answer_widget' — the category ALREADY MODELS "confidence-gated
--     auto-answer to a customer" (L0 off / L1 conf>=90 / L2 conf>=75 /
--     L3 conf>=60) and was stored-but-dormant since migration 025
--     pending exactly this activation (see autonomyApi.ts comment:
--     "consumed only on activation — TODO(R1-activation)"). This is
--     that activation.
--   - Guardrails: reuses guardrail_rules blocked_topic/blocked_phrase
--     rows via the SAME pattern specialist-consult's
--     checkAnswerGuardrails already applies to LLM answers.
--   - Access: reuses data_access_grants + resolve_access (migration
--     029) — proactive polling runs AS the DE's subject, same
--     default-deny enforcement as the human-invoked path.
--   - Dispatch: reuses the existing 5-minute pg_cron job
--     ('playbook-dispatch-5min' from migration 020). NO NEW CRON JOB.
--     invoke_playbook_dispatch() gains a second net.http_post call
--     (fire-and-forget, independent of the playbook dispatch result)
--     to specialist-consult's new 'poll_support_inbox' action.
--
-- WHAT THIS DOES NOT DO (honest limits):
--   - would_auto_send records INTENT only — there is still no
--     outbound reply channel (separately tracked gap, item 2 in the
--     roadmap). Nothing is ever actually sent to a customer here.
--   - No sentiment/frustration/repeat-contact detection (out of scope
--     per the brief — that's items 8 and the "nothing happened"
--     watchdog, tracked separately).
--
-- Objects added:
--   inbox_watch_state       — per-tenant-connector last-seen cursor,
--                              idempotent upsert, prevents reprocessing.
--   evidence_run_decisions  — one row per triage decision: source
--                              (manual | proactive_trigger |
--                              manual_simulation), decision
--                              (would_auto_send | needs_review |
--                              blocked_guardrail | skipped_no_access),
--                              plain-language reasoning, linked
--                              human_task_id when needs_review.
--   compute_inquiry_confidence(jsonb) — deterministic 0-100 score.
--   human_tasks: new type 'inquiry_review'.
-- ============================================================

-- ============================================================
-- TABLE: inbox_watch_state — per (tenant, connector) polling cursor.
-- Idempotent upsert; poll_support_inbox never reprocesses a ticket
-- already at or before last_seen_external_ref/timestamp.
-- ============================================================
create table if not exists inbox_watch_state (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete cascade,
  connector_id          uuid not null references connectors(id) on delete cascade,
  last_seen_external_ref   text,
  last_seen_timestamp      timestamptz,
  last_polled_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (tenant_id, connector_id)
);

create index if not exists inbox_watch_state_tenant_idx on inbox_watch_state(tenant_id);

alter table inbox_watch_state enable row level security;
drop policy if exists "inbox_watch_state_tenant_select" on inbox_watch_state;
create policy "inbox_watch_state_tenant_select" on inbox_watch_state
  for select
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));
-- writes: SECURITY DEFINER RPC / service-role only (poll_support_inbox)

drop trigger if exists inbox_watch_state_updated_at on inbox_watch_state;
create trigger inbox_watch_state_updated_at
  before update on inbox_watch_state
  for each row execute function update_updated_at();

-- ============================================================
-- TABLE: evidence_run_decisions — the triage verdict for one
-- evidence_runs row. A COMPANION table (evidence_runs stays the
-- generic evidence-pipeline record; this is the decision LAYER on
-- top, additive — human-invoked resolve_inquiry rows simply have no
-- decision row, which is honest: a human reading the answer IS the
-- decision there).
-- ============================================================
create table if not exists evidence_run_decisions (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  evidence_run_id   uuid not null references evidence_runs(id) on delete cascade,
  connector_id      uuid references connectors(id) on delete set null,
  external_ref      text,
  source            text not null
                      check (source in ('manual', 'proactive_trigger', 'manual_simulation')),
  decision          text not null
                      check (decision in ('would_auto_send', 'needs_review', 'blocked_guardrail', 'skipped_no_access')),
  confidence        integer check (confidence is null or (confidence between 0 and 100)),
  guardrail_rule_id uuid references guardrail_rules(id) on delete set null,
  trust_level       integer,
  reasoning         text not null default '',
  human_task_id     uuid references human_tasks(id) on delete set null,
  created_at        timestamptz not null default now(),
  unique (evidence_run_id)
);

create index if not exists evidence_run_decisions_tenant_idx on evidence_run_decisions(tenant_id, created_at desc);
create index if not exists evidence_run_decisions_connector_idx on evidence_run_decisions(connector_id, external_ref);

alter table evidence_run_decisions enable row level security;
drop policy if exists "evidence_run_decisions_tenant_select" on evidence_run_decisions;
create policy "evidence_run_decisions_tenant_select" on evidence_run_decisions
  for select
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));
-- writes: SECURITY DEFINER RPC / service-role only

-- ============================================================
-- human_tasks: new type 'inquiry_review' (proactive needs_review gate)
-- ============================================================
alter table human_tasks drop constraint if exists human_tasks_type_check;
alter table human_tasks add constraint human_tasks_type_check
  check (type in ('approval_gate', 'review_gate', 'escalation', 'override',
                  'training_feedback', 'trust_promotion', 'trust_demotion_notice',
                  'checklist', 'knowledge_revision', 'inquiry_review'));

-- ============================================================
-- compute_inquiry_confidence — DETERMINISTIC, server-composed score
-- from evidence_runs.confidence_inputs. NOT a free LLM guess: a fixed
-- point formula, auditable and explainable in plain language, the
-- same discipline as getApprovalThresholdCents/generateInvoice.
--
-- Base 40, +8 per knowledge hit (cap +24), +8 per history
-- corroboration (cap +24), +12 if account context found, -15 per
-- system that failed or was denied access (never below 0), capped at
-- 97 (never claim certainty). Systems merely "skipped_not_connected"
-- do not penalize — that is an honest capability gap, not a failure.
-- ============================================================
create or replace function compute_inquiry_confidence(p_inputs jsonb)
returns integer
language sql
immutable
as $$
  select greatest(0, least(97,
    40
    + least(24, 8 * coalesce((p_inputs->>'knowledge_hits')::int, 0))
    + least(24, 8 * coalesce((p_inputs->>'history_corroborations')::int, 0))
    + case when coalesce((p_inputs->>'account_context_found')::boolean, false) then 12 else 0 end
    - 15 * coalesce((p_inputs->>'systems_failed')::int, 0)
    - 15 * coalesce((p_inputs->>'systems_denied_no_access')::int, 0)
  ))::integer;
$$;

-- ============================================================
-- decide_inquiry_triage — THE COMPOSITION (mirrors generateInvoice's
-- inline rule 1:1, transplanted to the answer_widget category):
--   guardrailAllows = no blocking guardrail_rules match on the inquiry
--     text (blocked_topic / blocked_phrase, same match as
--     checkAnswerGuardrails in specialist-consult)
--   autonomyAllows  = de_autonomy['answer_widget'] enabled AND
--     confidence >= min_confidence (the L0..L3 ladder seeded in
--     migration 025's trust_level_settings; L0/disabled = never auto)
--   decision = blocked_guardrail            (guardrail wins, always)
--            | would_auto_send               (guardrailAllows AND autonomyAllows)
--            | needs_review                  (guardrailAllows AND NOT autonomyAllows)
-- skipped_no_access is decided by the CALLER (poll_support_inbox)
-- before evidence gathering even starts — it never reaches here.
-- ============================================================
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
          'reasoning', format('Blocked: guardrail rule "%s" matched this inquiry — routed to a human regardless of confidence (%s%%). Guardrails always win over the trust dial.', v_rule.rule, p_confidence)
        );
      end if;
    end loop;
  end loop;

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
      'reasoning', format('Would auto-send: confidence %s%% clears the trust-dial floor of %s%% for auto-answering customers, and no guardrail blocked it. Recorded as intent only — no outbound reply channel exists yet, so nothing was actually sent.', p_confidence, v_min_conf)
    );
  end if;

  return jsonb_build_object(
    'decision', 'needs_review',
    'confidence', p_confidence,
    'guardrail_rule_id', null,
    'guardrail_rule', null,
    'trust_level', v_min_conf,
    'reasoning', case
      when not v_enabled then format('Needs review: confidence %s%%, but auto-answering customers is not yet enabled on the trust dial (Governance -> Trust & Architecture).', p_confidence)
      else format('Needs review: confidence %s%% is below the trust-dial floor of %s%% required to auto-answer customers.', p_confidence, coalesce(v_min_conf, 0))
    end
  );
end;
$$;

revoke all on function decide_inquiry_triage(uuid, text, integer) from public;
grant execute on function decide_inquiry_triage(uuid, text, integer) to service_role;

-- ============================================================
-- poll_support_inbox_targets — SECURITY DEFINER. Resolves the WORK
-- LIST only (connector + subject + already-seen cursor); it does NOT
-- call the network (SQL cannot call connector-hub's HTTP-based
-- list_recent) — the edge function does the fetch/diff/
-- resolve_inquiry/decide loop and calls back into
-- upsert_inbox_watch_state per item. This mirrors
-- dispatch_due_triggers/playbook-execute's split exactly: SQL
-- resolves *what's due*, the edge function does the HTTP work.
-- A tenant with no qualifying grant simply yields no rows — an
-- honest no-op, not a silent failure.
-- ============================================================
create or replace function poll_support_inbox_targets(p_tenant_id uuid default null)
returns table (
  tenant_id uuid, connector_id uuid, connector_provider text, connector_display_name text,
  subject_kind text, subject_id uuid, subject_name text,
  last_seen_external_ref text, last_seen_timestamp timestamptz
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  -- One row per (connector, subject) where the subject has >= 'search'
  -- access — either a direct connector grant or a category-level grant
  -- for 'helpdesk'. Prefers a Technical Specialist subject (v1 scope);
  -- honest: a tenant with no such grant simply yields no rows.
  select
    c.tenant_id, c.id as connector_id, c.provider, c.display_name,
    g.subject_kind, g.subject_id,
    coalesce(sp.name, de.name, 'DE') as subject_name,
    w.last_seen_external_ref, w.last_seen_timestamp
  from connectors c
  join data_access_grants g
    on g.tenant_id = c.tenant_id
   and ((g.resource_kind = 'connector' and g.resource_id = c.id)
        or (g.resource_kind = 'category' and g.resource_category = c.category))
   and access_permission_level(g.permission) >= access_permission_level('search')
  left join specialist_profiles sp on sp.id = g.subject_id and g.subject_kind = 'specialist'
  left join digital_employees de on de.id = g.subject_id and g.subject_kind = 'de'
  left join inbox_watch_state w on w.tenant_id = c.tenant_id and w.connector_id = c.id
  where c.category = 'helpdesk'
    and c.status <> 'disconnected'
    and (p_tenant_id is null or c.tenant_id = p_tenant_id);
$$;

revoke all on function poll_support_inbox_targets(uuid) from public;
grant execute on function poll_support_inbox_targets(uuid) to service_role;

-- ============================================================
-- upsert_inbox_watch_state — idempotent cursor advance. Called once
-- per connector per poll tick with the newest item's ref/timestamp
-- actually processed (so a re-run never reprocesses it).
-- ============================================================
create or replace function upsert_inbox_watch_state(
  p_tenant_id uuid, p_connector_id uuid, p_external_ref text, p_timestamp timestamptz
) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  insert into inbox_watch_state (tenant_id, connector_id, last_seen_external_ref, last_seen_timestamp, last_polled_at)
  values (p_tenant_id, p_connector_id, p_external_ref, p_timestamp, now())
  on conflict (tenant_id, connector_id) do update set
    last_seen_external_ref = excluded.last_seen_external_ref,
    last_seen_timestamp = excluded.last_seen_timestamp,
    last_polled_at = now(),
    updated_at = now();
end;
$$;

revoke all on function upsert_inbox_watch_state(uuid, uuid, text, timestamptz) from public;
grant execute on function upsert_inbox_watch_state(uuid, uuid, text, timestamptz) to service_role;

-- Touch-only cursor bump (a poll tick ran but found nothing new —
-- still worth recording last_polled_at so the UI can show "checked Xs ago").
create or replace function touch_inbox_watch_state(p_tenant_id uuid, p_connector_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  insert into inbox_watch_state (tenant_id, connector_id, last_polled_at)
  values (p_tenant_id, p_connector_id, now())
  on conflict (tenant_id, connector_id) do update set last_polled_at = now();
end;
$$;
revoke all on function touch_inbox_watch_state(uuid, uuid) from public;
grant execute on function touch_inbox_watch_state(uuid, uuid) to service_role;

-- ============================================================
-- record_inquiry_decision — SECURITY DEFINER writer for
-- evidence_run_decisions (+ optional human_task creation for
-- needs_review). Single entry point so the edge function never
-- writes these tables directly (RLS: writes are service-role/RPC only).
-- ============================================================
create or replace function record_inquiry_decision(
  p_tenant_id       uuid,
  p_evidence_run_id uuid,
  p_connector_id    uuid,
  p_external_ref    text,
  p_source          text,     -- 'manual' | 'proactive_trigger' | 'manual_simulation'
  p_decision        text,     -- 'would_auto_send' | 'needs_review' | 'blocked_guardrail' | 'skipped_no_access'
  p_confidence      integer,
  p_guardrail_rule_id uuid,
  p_trust_level     integer,
  p_reasoning       text,
  p_inquiry_title   text      -- used only if a human_task is created
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_task_id uuid;
  v_row_id  uuid;
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
    confidence, guardrail_rule_id, trust_level, reasoning, human_task_id
  ) values (
    p_tenant_id, p_evidence_run_id, p_connector_id, p_external_ref, p_source, p_decision,
    p_confidence, p_guardrail_rule_id, p_trust_level, p_reasoning, v_task_id
  )
  on conflict (evidence_run_id) do update set
    decision = excluded.decision, confidence = excluded.confidence,
    guardrail_rule_id = excluded.guardrail_rule_id, trust_level = excluded.trust_level,
    reasoning = excluded.reasoning, human_task_id = coalesce(evidence_run_decisions.human_task_id, excluded.human_task_id)
  returning id into v_row_id;

  return jsonb_build_object('id', v_row_id, 'human_task_id', v_task_id);
end;
$$;

revoke all on function record_inquiry_decision(uuid, uuid, uuid, text, text, text, integer, uuid, integer, text, text) from public;
grant execute on function record_inquiry_decision(uuid, uuid, uuid, text, text, text, integer, uuid, integer, text, text) to service_role;

-- ============================================================
-- audit_events: add 'inquiry_triage' category for decision events
-- (kept separate from the generic 'evidence_step' category so the
-- Activity/Audit views can filter on triage decisions specifically).
-- ============================================================
alter table audit_events drop constraint if exists audit_events_category_check;
alter table audit_events add constraint audit_events_category_check
  check (category in (
    'resolved', 'escalated', 'approval', 'guardrail_check', 'guardrail_block',
    'config_change', 'playbook_step', 'invoice',
    'connector_sync', 'connector_action', 'evidence_step', 'access_control',
    'knowledge_revision', 'inquiry_triage'
  ));

-- ============================================================
-- CRON PIGGYBACK — no new pg_cron job. invoke_playbook_dispatch()
-- (migration 020) already runs every 5 minutes; it gains a SECOND,
-- independent net.http_post to specialist-consult's new
-- 'poll_support_inbox' action, fire-and-forget, using the SAME
-- Vault-held dispatch secret and the same honest no-op-if-missing
-- behavior. A failure/slowness in one call never blocks the other —
-- each is posted independently and neither awaits the other's result
-- (pg_net is async; both requests are queued in the same statement).
-- ============================================================
create or replace function invoke_playbook_dispatch()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_secret text;
  v_req_id bigint;
  v_req_id2 bigint;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'playbook_dispatch_secret'
  limit 1;
  if v_secret is null then
    return 'no_secret';
  end if;

  select net.http_post(
    url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/playbook-execute',
    body    := '{"action":"dispatch"}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dispatch-secret', v_secret
    ),
    timeout_milliseconds := 30000
  ) into v_req_id;

  -- Piggyback: proactive support-inbox triage on the SAME 5-minute
  -- tick. Independent request; a failure here never blocks or is
  -- blocked by the playbook dispatch above.
  select net.http_post(
    url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/specialist-consult',
    body    := '{"action":"poll_support_inbox"}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dispatch-secret', v_secret
    ),
    timeout_milliseconds := 30000
  ) into v_req_id2;

  return 'queued:' || v_req_id::text || ',' || v_req_id2::text;
end;
$$;

revoke all on function invoke_playbook_dispatch() from public;

-- cron.schedule upserts by job name — same job, same schedule,
-- unchanged; only the function body above changed.
select cron.schedule(
  'playbook-dispatch-5min',
  '*/5 * * * *',
  $$select invoke_playbook_dispatch()$$
);
