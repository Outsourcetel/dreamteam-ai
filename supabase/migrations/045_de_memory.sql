-- ============================================================
-- Migration 045: THE GENERALIZED DE MEMORY SYSTEM — one substrate
-- closing gap-analysis items 5 (multi-turn conversation memory) and
-- 24 (cross-session DE memory of its own past decisions), per the
-- standing genericity test (memory/feedback_de_genericity_test.md):
-- build ONE domain-agnostic primitive, not a Support-specific chat
-- buffer plus a separate Account-DE "seen this before" bolt-on.
--
-- RESEARCH GROUNDING (cited, applied to every design choice below —
-- see docs/PROTOTYPE-PRODUCTION-BOUNDARY.md §0 for the full account):
-- current 2026 agent-memory research argues AGAINST summarizing at
-- write time — "an agent that summarizes at write time collapses
-- distinct episodes into semantic generalizations, destroying the
-- episodic signal before it can be used." Structured episodic memory
-- needs five properties: long-term persistence, explicit reasoning
-- support, single-shot capture (from one exposure, no retraining),
-- instance-specific detail, contextual binding (who/when/where/why
-- tied to the content). The winning pattern: "a summary field, a
-- distinguishing technical detail, thematic assignment, and file
-- references, all tied back to the original verbatim source" —
-- structured fields with a citation back to source, NOT generated
-- prose. This is fortunate, not a workaround: there is no
-- ANTHROPIC_API_KEY active in this environment, so everything here
-- MUST be structural/server-composed — matching the exact anti-
-- hallucination discipline already used everywhere in this codebase
-- (the Scribe's whitelisted payload templates, the knowledge feedback
-- loop's revision drafts, decide_inquiry_triage's plain-language
-- reasoning) — this is the currently-correct design, not a
-- consolation prize.
--
-- For conversation-level state, the established pattern is NOT
-- summarization but explicit STATE TRACKING — aggregating established
-- facts across turns (account resolved, category determined, evidence
-- already gathered) so a follow-up message extends rather than
-- restarts. Both scopes below follow that discipline: no field in
-- either table is ever an LLM-generated summary string; every field is
-- either a literal value already known server-side (an id, a category,
-- a decision enum, a confidence integer) or a plain-language sentence
-- assembled by string interpolation from those literal values — the
-- SAME technique buildScribePayload/decide_inquiry_triage's reasoning
-- already use, applied to memory instead of write-back/triage.
--
-- ── SCOPE 1: conversation_facts (item 5) ──
-- Short-term, within ONE de_conversations thread. When a follow-up
-- message arrives on the same conversation_id, the evidence pipeline
-- (runResolveInquiry, specialist-consult) checks for facts already
-- established THIS conversation (account_ref resolved, category
-- determined, the evidence_run_id it came from) and reuses them
-- instead of re-deriving from scratch. One row per (conversation_id,
-- fact_key) — upsert, not append; a fact is a current-state slot, not
-- an event log (that is what de_messages/evidence_runs already are).
--
-- ── SCOPE 2: de_experience (item 24) ──
-- Long-term, across the DE's WHOLE history, independent of any one
-- conversation. When a work item reaches a terminal decision (an
-- evidence_run's decision, or an action_executions outcome), record a
-- STRUCTURED experience fact: what happened, what was decided, the
-- outcome — keyed by de_id/specialist_id + category + external_ref —
-- retrievable later when the SAME subject encounters a similar
-- situation ("I've handled this exact account/issue before, here's
-- what happened"). This is what the founder meant by "previous handled
-- tasks" that the audit found was only half-true: the evidence
-- pipeline's history-check step already searches EXTERNAL system
-- history (past tickets/conversations in the connected SoR); this adds
-- the DE's OWN internal memory of its own past decisions, which did
-- not exist before this migration.
--
-- ACCESS-GRANT DECISION (deliberate, documented per the founder's own
-- framing of this as a judgment call): experience retrieval respects
-- the SAME data_access_grants (029) ladder as everything else. If a
-- DE's grant to a category is revoked, it can no longer recall
-- experience filed under that category — even experience it
-- personally generated while it still had access. Rationale: a
-- revoked grant means "this subject should no longer see this
-- category's data, full stop" — including its own past interactions
-- with it. Leaking prior citations through a memory back door would
-- silently undermine the entire access-grant model the rest of the
-- platform enforces. The experience ROW is never deleted on revoke
-- (the audit/history stays intact for humans and for other subjects
-- who DO hold the grant) — only THIS subject's retrieval of it is
-- gated, exactly like every other data_access_grants check in this
-- codebase (resolve_access, category_op, execute_action).
-- ============================================================

-- ============================================================
-- 1. TABLE: conversation_facts — structured, per-conversation state.
-- ============================================================
create table if not exists conversation_facts (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  conversation_id uuid not null references de_conversations(id) on delete cascade,
  fact_key        text not null,   -- e.g. 'account_ref', 'category', 'evidence_run_id'
  fact_value      jsonb not null,  -- literal value, never generated prose
  established_at  timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (conversation_id, fact_key)
);

create index if not exists conversation_facts_tenant_idx on conversation_facts(tenant_id);
create index if not exists conversation_facts_conv_idx on conversation_facts(conversation_id);

alter table conversation_facts enable row level security;

drop policy if exists "conversation_facts_tenant_select" on conversation_facts;
create policy "conversation_facts_tenant_select" on conversation_facts
  for select
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));
-- writes: SECURITY DEFINER RPC / service-role only (specialist-consult)

drop trigger if exists conversation_facts_updated_at on conversation_facts;
create trigger conversation_facts_updated_at
  before update on conversation_facts
  for each row execute function update_updated_at();

-- ============================================================
-- RPC: set_conversation_fact — upsert ONE structured fact. Idempotent;
-- re-establishing the same fact_key just refreshes the value/timestamp
-- (a later turn's re-resolution intentionally overwrites, e.g. if the
-- customer names a DIFFERENT account mid-thread — "extend, don't
-- blindly pin forever").
-- ============================================================
create or replace function set_conversation_fact(
  p_tenant_id       uuid,
  p_conversation_id uuid,
  p_fact_key        text,
  p_fact_value      jsonb
) returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
begin
  insert into conversation_facts (tenant_id, conversation_id, fact_key, fact_value)
  values (p_tenant_id, p_conversation_id, p_fact_key, p_fact_value)
  on conflict (conversation_id, fact_key) do update set
    fact_value = excluded.fact_value,
    updated_at = now()
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function set_conversation_fact(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function set_conversation_fact(uuid, uuid, text, jsonb) to service_role;

-- ============================================================
-- RPC: get_conversation_facts — read all facts for a conversation, as
-- a plain key->value jsonb object (structured, not summarized). Called
-- at the TOP of runResolveInquiry when a conversation_id is supplied,
-- so a follow-up turn can reuse account_ref/category/evidence_run_id
-- already established instead of re-deriving them from scratch.
-- ============================================================
create or replace function get_conversation_facts(
  p_tenant_id       uuid,
  p_conversation_id uuid
) returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(jsonb_object_agg(fact_key, fact_value), '{}'::jsonb)
  from conversation_facts
  where tenant_id = p_tenant_id and conversation_id = p_conversation_id;
$$;

revoke all on function get_conversation_facts(uuid, uuid) from public, anon, authenticated;
grant execute on function get_conversation_facts(uuid, uuid) to service_role;

-- ============================================================
-- 2. TABLE: de_experience — cross-session structured experience.
-- fact_summary is a jsonb object with THREE plain fields only —
-- what_happened, decision_made, outcome — every value composed
-- server-side by string interpolation from real columns already on
-- evidence_run_decisions/action_executions (decision enum, reasoning
-- text already stored, receipt text already stored). NEVER a free-
-- text field the caller supplies; NEVER an LLM summary. Category is
-- the same 9-value category-contract enum used everywhere else — no
-- department-specific shape.
-- ============================================================
create table if not exists de_experience (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references tenants(id) on delete cascade,
  subject_kind              text not null check (subject_kind in ('de', 'specialist')),
  subject_id                uuid not null,
  category                  text not null check (category in (
                               'crm', 'helpdesk', 'knowledge_base', 'erp_financials', 'billing',
                               'payroll_hcm', 'pos', 'product_system', 'other')),
  external_ref              text not null,   -- the account/record this experience is about
  fact_summary              jsonb not null,  -- {what_happened, decision_made, outcome} — plain fields
  source_evidence_run_id    uuid references evidence_runs(id) on delete set null,
  source_action_execution_id uuid references action_executions(id) on delete set null,
  created_at                timestamptz not null default now()
);

create index if not exists de_experience_tenant_idx on de_experience(tenant_id, created_at desc);
create index if not exists de_experience_subject_idx on de_experience(tenant_id, subject_kind, subject_id, category, external_ref);

alter table de_experience enable row level security;

drop policy if exists "de_experience_tenant_select" on de_experience;
create policy "de_experience_tenant_select" on de_experience
  for select
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));
-- writes: SECURITY DEFINER RPC / service-role only (record_inquiry_decision,
-- record_action_execution — never written directly by any edge function)

-- ============================================================
-- RPC: resolve_category_access — category-only sibling of resolve_access
-- (029). resolve_access requires a specific connector_id (it looks up
-- category FROM the connector row); experience memory is filed by
-- CATEGORY, not by any one connector, so retrieval needs to ask "does
-- this subject hold at least `needed` on this category" without a
-- connector in hand. Same ladder, same table, same default-deny —
-- this is the SAME resolution mechanism entered one level higher, not
-- a parallel access system. A connector-specific override still wins
-- if one exists (checked first, exactly like resolve_access's own
-- order), falling back to the category-level grant, falling back to
-- deny.
-- ============================================================
create or replace function resolve_category_access(
  p_tenant_id    uuid,
  p_subject_kind text,
  p_subject_id   uuid,
  p_category     text,
  p_needed       text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
stable
as $$
declare
  v_has jsonb := '[]'::jsonb;
  v_via text;
  v_lvl integer := -1;
  v_row record;
begin
  -- 1. Any connector-specific grant on a connector OF this category —
  --    take the HIGHEST permission level found (mirrors "specific beats
  --    general" from resolve_access, generalized across all connectors
  --    of the category rather than just one).
  for v_row in
    select g.permission from data_access_grants g
    join connectors c on c.id = g.resource_id and c.tenant_id = p_tenant_id and c.category = p_category
    where g.tenant_id = p_tenant_id and g.subject_kind = p_subject_kind and g.subject_id = p_subject_id
      and g.resource_kind = 'connector'
  loop
    if access_permission_level(v_row.permission) > v_lvl then
      v_lvl := access_permission_level(v_row.permission);
      v_via := 'connector';
    end if;
  end loop;

  -- 2. Category-level grant, only if no connector-specific grant beat it.
  if v_lvl < 0 then
    select permission into v_row from data_access_grants
     where tenant_id = p_tenant_id and subject_kind = p_subject_kind and subject_id = p_subject_id
       and resource_kind = 'category' and resource_category = p_category;
    if found then
      v_lvl := access_permission_level(v_row.permission);
      v_via := 'category';
    end if;
  end if;

  if v_lvl < 0 then
    return jsonb_build_object('allowed', false, 'reason', 'no_grant', 'needed', p_needed, 'has', null, 'via', null);
  end if;
  if v_lvl >= access_permission_level(p_needed) then
    return jsonb_build_object('allowed', true, 'reason', 'granted', 'needed', p_needed, 'via', v_via);
  end if;
  return jsonb_build_object('allowed', false, 'reason', 'insufficient_permission', 'needed', p_needed, 'via', v_via);
end;
$$;

revoke all on function resolve_category_access(uuid, text, uuid, text, text) from public, anon, authenticated;
grant execute on function resolve_category_access(uuid, text, uuid, text, text) to service_role;

-- ============================================================
-- RPC: record_de_experience — THE SINGLE WRITER for de_experience.
-- INTERNAL ONLY — called from record_inquiry_decision and
-- record_action_execution below (never called directly by an edge
-- function body), so every experience fact is guaranteed to cite a
-- real source_evidence_run_id or source_action_execution_id. All three
-- fact_summary fields are composed HERE from the literal params passed
-- in — no caller ever supplies free text for what_happened/
-- decision_made/outcome directly.
-- ============================================================
create or replace function record_de_experience(
  p_tenant_id                  uuid,
  p_subject_kind               text,
  p_subject_id                 uuid,
  p_category                   text,
  p_external_ref               text,
  p_what_happened              text,
  p_decision_made               text,
  p_outcome                    text,
  p_source_evidence_run_id     uuid,
  p_source_action_execution_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
begin
  if p_subject_kind is null or p_subject_id is null or p_category is null or p_external_ref is null or p_external_ref = '' then
    return null; -- honest no-op: an experience fact needs a resolvable subject + category + external_ref
  end if;
  insert into de_experience (
    tenant_id, subject_kind, subject_id, category, external_ref,
    fact_summary, source_evidence_run_id, source_action_execution_id
  ) values (
    p_tenant_id, p_subject_kind, p_subject_id, p_category, p_external_ref,
    jsonb_build_object(
      'what_happened', p_what_happened,
      'decision_made', p_decision_made,
      'outcome', p_outcome
    ),
    p_source_evidence_run_id, p_source_action_execution_id
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function record_de_experience(uuid, text, uuid, text, text, text, text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function record_de_experience(uuid, text, uuid, text, text, text, text, text, uuid, uuid) to service_role;

-- ============================================================
-- RPC: resolve_experience — THE RETRIEVAL primitive, access-grant-
-- checked. Called as a new evidence-pipeline step ("prior experience")
-- for the SAME subject the rest of the run is already scoped to, for
-- the SAME external_ref (account/record) the inquiry named. Returns at
-- most p_limit most-recent rows, newest first. If access is denied,
-- returns an honest empty/denied envelope — never silently substitutes
-- someone else's grant, never fabricates a "no prior experience" when
-- the truth is "not allowed to look."
-- ============================================================
create or replace function resolve_experience(
  p_tenant_id    uuid,
  p_subject_kind text,
  p_subject_id   uuid,
  p_category     text,
  p_external_ref text,
  p_limit        integer default 3
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
stable
as $$
declare
  v_verdict jsonb;
  v_rows    jsonb;
begin
  if p_external_ref is null or p_external_ref = '' then
    return jsonb_build_object('allowed', true, 'rows', '[]'::jsonb);
  end if;

  v_verdict := resolve_category_access(p_tenant_id, p_subject_kind, p_subject_id, p_category, 'search');
  if not coalesce((v_verdict->>'allowed')::boolean, false) then
    return jsonb_build_object('allowed', false, 'reason', v_verdict->>'reason', 'rows', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(row_to_json(e)), '[]'::jsonb) into v_rows
  from (
    select id, fact_summary, source_evidence_run_id, source_action_execution_id, created_at
    from de_experience
    where tenant_id = p_tenant_id and subject_kind = p_subject_kind and subject_id = p_subject_id
      and category = p_category and external_ref = p_external_ref
    order by created_at desc
    limit greatest(1, least(p_limit, 10))
  ) e;

  return jsonb_build_object('allowed', true, 'rows', v_rows);
end;
$$;

revoke all on function resolve_experience(uuid, text, uuid, text, text, integer) from public, anon, authenticated;
grant execute on function resolve_experience(uuid, text, uuid, text, text, integer) to service_role;

-- ============================================================
-- 3. WIRE INTO record_inquiry_decision (034) — extend, don't
-- duplicate. Adds ONE new nullable parameter (p_source_category,
-- backward compatible, same additive-parameter pattern 043 just used
-- for trust_apply_level) and, on a TERMINAL decision with a resolvable
-- external_ref + category + subject, writes a de_experience row citing
-- THIS evidence_run. Terminal = every decision this function already
-- handles except none are excluded — 'skipped_no_access' is itself a
-- real outcome worth remembering ("I could not look last time either"
-- is structurally honest experience, not noise) EXCEPT it has no
-- resolvable subject-with-access by definition, so the access-grant
-- check inside record_de_experience's caller context is irrelevant —
-- it is filed as the subject's own experience regardless (the row
-- exists; RETRIEVAL is what respects the grant, not recording).
-- ============================================================
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
  p_source_category text default null
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
    confidence, guardrail_rule_id, trust_level, reasoning, human_task_id, source_category
  ) values (
    p_tenant_id, p_evidence_run_id, p_connector_id, p_external_ref, p_source, p_decision,
    p_confidence, p_guardrail_rule_id, p_trust_level, p_reasoning, v_task_id, p_source_category
  )
  on conflict (evidence_run_id) do update set
    decision = excluded.decision, confidence = excluded.confidence,
    guardrail_rule_id = excluded.guardrail_rule_id, trust_level = excluded.trust_level,
    reasoning = excluded.reasoning, human_task_id = coalesce(evidence_run_decisions.human_task_id, excluded.human_task_id),
    source_category = coalesce(excluded.source_category, evidence_run_decisions.source_category)
  returning id into v_row_id;

  -- ── DE MEMORY (migration 044) — record a structured experience fact
  -- for THIS terminal decision, citing this evidence_run. Composed
  -- entirely from literal params already passed to this function; no
  -- free text beyond what record_inquiry_decision itself already
  -- receives and stores in evidence_run_decisions.reasoning.
  select de_id, specialist_id, account_ref into v_run from evidence_runs where id = p_evidence_run_id;
  if v_run.de_id is not null then
    v_subject_kind := 'de'; v_subject_id := v_run.de_id;
  elsif v_run.specialist_id is not null then
    v_subject_kind := 'specialist'; v_subject_id := v_run.specialist_id;
  end if;
  -- external_ref for the experience row: prefer the item's own
  -- external_ref (a ticket/CRM record id), falling back to the
  -- evidence_run's account_ref (the human-invoked-with-account-name
  -- shape) — whichever identifies "the thing this was about."
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

revoke all on function record_inquiry_decision(uuid, uuid, uuid, text, text, text, integer, uuid, integer, text, text, text) from public, anon, authenticated;
grant execute on function record_inquiry_decision(uuid, uuid, uuid, text, text, text, integer, uuid, integer, text, text, text) to service_role;

-- Drop the old 11-arg signature outright (not left dangling) — the one
-- caller (specialist-consult) moves to the 12-arg form in this same
-- deploy, same discipline as 043's trust_apply_level cutover.
drop function if exists record_inquiry_decision(uuid, uuid, uuid, text, text, text, integer, uuid, integer, text, text);

-- ============================================================
-- 4. WIRE INTO record_action_execution (035) — same additive-parameter
-- pattern. On a TERMINAL action outcome (auto_executed, executed_
-- after_approval, human_gated_destructive, human_gated_trust,
-- guardrail_blocked, failed — i.e. everything this function already
-- handles), write a de_experience row citing THIS action_executions
-- row when a category + external_ref are resolvable from the params
-- already validated by connector-hub (action params commonly carry
-- external_ref/account_name — read honestly, not guessed).
-- ============================================================
create or replace function record_action_execution(
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
  p_task_detail          text
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
  if p_decision in ('human_gated_destructive', 'human_gated_trust') then
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

revoke all on function record_action_execution(uuid, uuid, uuid, text, uuid, text, jsonb, text, boolean, boolean, text, text, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function record_action_execution(uuid, uuid, uuid, text, uuid, text, jsonb, text, boolean, boolean, text, text, text, jsonb, text, text) to service_role;

-- ============================================================
-- audit_events: add the 'de_memory' category (parallel to
-- evidence_step/inquiry_triage/action_execution — keeps Activity/Audit
-- filterable on memory events specifically). Not currently written by
-- any function here (experience/fact writes are frequent, low-level
-- plumbing — the SOURCE evidence_step/inquiry_triage/action_execution
-- audit entries already cover the "why" narrative); reserved for the
-- UI-facing "continuing from earlier" / "prior experience cited"
-- surface events the frontend layer may choose to log explicitly.
-- ============================================================
alter table audit_events drop constraint if exists audit_events_category_check;
alter table audit_events add constraint audit_events_category_check
  check (category in (
    'resolved', 'escalated', 'approval', 'guardrail_check', 'guardrail_block',
    'config_change', 'playbook_step', 'invoice',
    'connector_sync', 'connector_action', 'evidence_step', 'access_control',
    'knowledge_revision', 'inquiry_triage', 'action_execution', 'de_memory'
  ));
