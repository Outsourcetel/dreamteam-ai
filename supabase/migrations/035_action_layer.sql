-- ============================================================
-- Migration 035: THE GENERALIZED ACTION LAYER
--
-- Founder's core correction (verbatim, 2026-07-06): "we are not
-- replicating any other support bot but a human who will not just
-- understand the request and get information from the available
-- systems... but also will act where required... build scalable DEs,
-- playbooks, guardrails, specialists" (see memory/
-- feedback_de_genericity_test.md — this migration is the direct fix
-- for the gap it documents: "Acting/writing is NOT yet generalized").
--
-- THE ASYMMETRY THIS FIXES: category_contracts (migration 027) already
-- gives every DE/playbook a domain-agnostic READ contract — any
-- category, any connected system, same pipeline (search_*/get_* ops).
-- Writing had no equivalent: only a whitelisted Scribe action_key enum
-- (add_internal_note, update_status — Zendesk only) and one hardcoded
-- invoice-send path existed. This migration adds the WRITE-side
-- contract, symmetric in spirit to category_contracts/adapter_templates.
--
-- RESEARCH GROUNDING (cited, not reinvented):
--   - MCP tool annotations (readOnlyHint/destructiveHint/idempotentHint/
--     openWorldHint) — the emerging standard risk vocabulary for
--     classifying what a tool/action does. action_definitions.risk
--     jsonb uses this exact vocabulary: {destructive: bool, idempotent:
--     bool} at minimum.
--   - Typed action contracts + shadow -> suggest -> autonomy
--     progressive-trust model (2026 enterprise agent research): this
--     maps directly onto the EXISTING earned-trust ladder (migration
--     025, de_autonomy/trust_policies) — NO new trust system invented.
--     Actions get a new de_autonomy/trust_policies action_category
--     'action_execute', composed through the SAME guardrail-always-
--     wins / trust-narrows-within-it rule generateInvoice and
--     decide_inquiry_triage already use.
--   - NEW composition rule on top (platform-level, non-negotiable):
--     DESTRUCTIVE ACTIONS ALWAYS REQUIRE HUMAN APPROVAL, no trust tier
--     can override that. This sits even above "guardrail always wins" —
--     it is not a guardrail_rules row (which a tenant could edit/
--     disable); it is a hard-coded floor in decide_action_execution()
--     itself, unconfigurable per department.
--   - Receipts pattern: every executed action produces a plain-
--     language summary ("Updated ticket #4521's status from Open to
--     Resolved"), never a raw JSON diff, surfaced on the audit event
--     and the human_task (when one exists).
--   - Dry-run/preview: reuses the exact concept proven in playbook-
--     execute's `body.preview` flag — render the request, never call
--     out, nothing persisted.
--
-- WHAT THIS DOES:
--   1. action_definitions — the write-side sibling of category_ops:
--      a registered, typed action any DE/playbook/Scribe flow can
--      target. provider='template' actions render through an EXTENDED
--      adapter_templates.actions map (reusing the exact same
--      variable-substitution/dot-path machinery as the read-side ops,
--      just for POST/PUT/PATCH/DELETE with bodies); provider='zendesk'
--      (or other named providers) actions call a small native code
--      path in connector-hub.
--   2. scribe_requests gains action_definition_id (nullable FK) —
--      ADDITIVE. The action_key enum and existing rows are untouched;
--      backward compatibility is mandatory, not best-effort.
--   3. de_autonomy / trust_policies gain the 'action_execute' category
--      — the SAME dial mechanism, reused, not reinvented.
--   4. decide_action_execution() — the composition function, written
--      once, called by connector-hub's execute_action for every
--      action regardless of category. destructive-always-gates is
--      checked FIRST, unconditionally, before trust or guardrails are
--      even consulted (a destructive action never even asks the trust
--      dial "would you allow this" — it always routes to a human).
--   5. action_executions — the audit/receipt ledger: one row per
--      preview or execute call, plain-language receipt, dedupe key for
--      non-idempotent actions.
--
-- HONEST LIMITS (documented, not hidden):
--   - Only a handful of actions are seeded (2 legacy Zendesk + 1 new
--     Zendesk public-reply + 1 generic_rest test action). Genericity of
--     the MECHANISM is what this migration proves, not action-count
--     breadth — a tenant/admin can register more via the same rows
--     without new code, which is the actual claim being made.
--   - The trigger/polling layer (migration 034: poll_support_inbox) is
--     explicitly OUT OF SCOPE here — a follow-up build generalizes
--     that. This migration is action-EXECUTION only.
-- ============================================================

-- ============================================================
-- TABLE: action_definitions — the WRITE-side sibling of category_ops.
-- ============================================================
create table if not exists action_definitions (
  id              uuid primary key default gen_random_uuid(),
  scope           text not null check (scope in ('platform', 'tenant')),
  tenant_id       uuid references tenants(id) on delete cascade,
  category        text not null check (category in (
                    'crm', 'helpdesk', 'knowledge_base', 'erp_financials', 'billing',
                    'payroll_hcm', 'pos', 'product_system', 'other')),
  action_key      text not null,
  label           text not null,
  description     text not null default '',
  provider        text not null,        -- 'template' | 'zendesk' | (future named providers)
  template_id     uuid references adapter_templates(id) on delete set null,
  param_schema    jsonb not null default '[]'::jsonb,
  -- risk annotations — MCP tool-annotation vocabulary (readOnlyHint/
  -- destructiveHint/idempotentHint/openWorldHint). We model the two
  -- that change execution behavior directly; open-world/read-only are
  -- implied (an action_definition is inherently NOT read-only).
  risk            jsonb not null default '{"destructive": true, "idempotent": false}'::jsonb,
  -- execution recipe:
  --   provider='template' -> { method, path_template, body_template,
  --                            response? } (rendered via adapter_templates
  --                            actions map, same substitution engine as ops)
  --   provider='zendesk' (or other native) -> { execution_key } naming
  --                            the connector-hub native code path
  execution       jsonb not null default '{}'::jsonb,
  status          text not null default 'active' check (status in ('active', 'disabled')),
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint action_definitions_scope_shape check (
    (scope = 'platform' and tenant_id is null) or
    (scope = 'tenant' and tenant_id is not null)
  ),
  constraint action_definitions_provider_shape check (
    (provider = 'template' and template_id is not null) or
    (provider <> 'template')
  ),
  unique (scope, tenant_id, category, action_key)
);

create index if not exists action_definitions_category_idx on action_definitions(category);
create index if not exists action_definitions_tenant_idx on action_definitions(tenant_id) where tenant_id is not null;

alter table action_definitions enable row level security;

-- platform rows readable by all authenticated; tenant rows tenant-scoped
drop policy if exists "action_definitions_read" on action_definitions;
create policy "action_definitions_read" on action_definitions
  for select
  using (
    scope = 'platform'
    or tenant_id in (select tenant_id from profiles where user_id = auth.uid())
  );
-- writes only via the SECURITY DEFINER RPC below (validation gate)

drop trigger if exists action_definitions_updated_at on action_definitions;
create trigger action_definitions_updated_at
  before update on action_definitions
  for each row execute function update_updated_at();

-- ============================================================
-- RPC: upsert_action_definition — validated write path.
-- ============================================================
create or replace function upsert_action_definition(
  p_id          uuid,
  p_scope       text,
  p_tenant_id   uuid,
  p_category    text,
  p_action_key  text,
  p_label       text,
  p_description text,
  p_provider    text,
  p_template_id uuid,
  p_param_schema jsonb,
  p_risk        jsonb,
  p_execution   jsonb
) returns action_definitions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row action_definitions;
  v_user uuid := auth.uid();
  v_role text;
  v_tenant_check uuid;
begin
  if p_scope not in ('platform', 'tenant') then
    raise exception 'scope must be platform or tenant';
  end if;
  if p_scope = 'tenant' and p_tenant_id is null then
    raise exception 'tenant scope requires tenant_id';
  end if;
  if p_scope = 'platform' and p_tenant_id is not null then
    raise exception 'platform scope must not carry a tenant_id';
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    if p_scope = 'platform' then
      raise exception 'only the platform (service role) can define platform-scope actions';
    end if;
    select tenant_id, role into v_tenant_check, v_role from profiles where user_id = v_user;
    if v_tenant_check is distinct from p_tenant_id then
      raise exception 'not a member of this tenant';
    end if;
    if v_role not in ('tenant_owner', 'tenant_admin') then
      raise exception 'only workspace owners/admins can register actions';
    end if;
  end if;

  if p_provider = 'template' and p_template_id is null then
    raise exception 'template provider requires template_id';
  end if;
  if not (p_risk ? 'destructive') or not (p_risk ? 'idempotent') then
    raise exception 'risk must include destructive and idempotent booleans';
  end if;

  insert into action_definitions (
    id, scope, tenant_id, category, action_key, label, description,
    provider, template_id, param_schema, risk, execution, created_by
  ) values (
    coalesce(p_id, gen_random_uuid()), p_scope, p_tenant_id, p_category, p_action_key, p_label, p_description,
    p_provider, p_template_id, coalesce(p_param_schema, '[]'::jsonb), p_risk, coalesce(p_execution, '{}'::jsonb), v_user
  )
  on conflict (id) do update set
    category = excluded.category, action_key = excluded.action_key,
    label = excluded.label, description = excluded.description,
    provider = excluded.provider, template_id = excluded.template_id,
    param_schema = excluded.param_schema, risk = excluded.risk,
    execution = excluded.execution, updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function upsert_action_definition(uuid, text, uuid, text, text, text, text, text, uuid, jsonb, jsonb, jsonb) from public;
grant execute on function upsert_action_definition(uuid, text, uuid, text, text, text, text, text, uuid, jsonb, jsonb, jsonb) to authenticated, service_role;

-- ============================================================
-- scribe_requests: additive action_definition_id — the action_key
-- CHECK constraint and every existing row are UNTOUCHED. New action
-- keys widen the whitelist (backward compatible); a request may cite
-- an action_definition (new path) while still carrying its action_key
-- (old path) for the duration of the transition.
-- ============================================================
alter table scribe_requests add column if not exists action_definition_id uuid references action_definitions(id) on delete set null;
alter table scribe_requests drop constraint if exists scribe_requests_action_key_check;
alter table scribe_requests add constraint scribe_requests_action_key_check
  check (action_key in ('add_internal_note', 'update_status', 'reply_to_ticket', 'create_test_record'));

create index if not exists scribe_requests_action_definition_idx on scribe_requests(action_definition_id) where action_definition_id is not null;

-- ============================================================
-- connector_actions: widen the registry gate's action_key enum to
-- match (the existing enabled/disabled toggle per connector should
-- also cover the new Zendesk action).
-- ============================================================
alter table connector_actions drop constraint if exists connector_actions_action_key_check;
alter table connector_actions add constraint connector_actions_action_key_check
  check (action_key in ('add_internal_note', 'update_status', 'reply_to_ticket'));

-- ============================================================
-- de_autonomy / trust_policies: add 'action_execute' category — the
-- SAME dial mechanism as invoice_auto_send/answer_dock/answer_widget,
-- reused for non-destructive action auto-execution. Unit: confidence
-- is not meaningful here; we reuse max_amount_cents=NULL / enabled +
-- a level-based ladder via trust_level_settings, mirroring answer_*'s
-- confidence-ladder SHAPE but keyed on trust LEVEL directly (no
-- external confidence signal exists for an arbitrary action) — level
-- 1/2/3 simply means "enabled once earned level >= 1", the amount/
-- confidence columns stay null for this category.
-- ============================================================
alter table de_autonomy drop constraint if exists de_autonomy_action_type_check;
alter table de_autonomy add constraint de_autonomy_action_type_check
  check (action_type in ('invoice_auto_send', 'answer_dock', 'answer_widget', 'action_execute'));

alter table trust_policies drop constraint if exists trust_policies_action_category_check;
alter table trust_policies add constraint trust_policies_action_category_check
  check (action_category in ('invoice_auto_send', 'answer_dock', 'answer_widget', 'action_execute'));

-- trust_level_settings gains the action_execute branch (append-only —
-- existing branches for invoice_auto_send / answer_* are untouched).
create or replace function trust_level_settings(p_category text, p_level integer)
returns jsonb
language sql immutable
as $$
  select case
    when p_level <= 0 then jsonb_build_object('enabled', false, 'max_amount_cents', null, 'min_confidence', null)
    when p_category = 'invoice_auto_send' then jsonb_build_object(
      'enabled', true,
      'max_amount_cents', (array[100000, 500000, 1000000])[least(p_level, 3)],
      'min_confidence', null)
    when p_category = 'action_execute' then jsonb_build_object(
      'enabled', true, 'max_amount_cents', null, 'min_confidence', null)
    else jsonb_build_object(
      'enabled', true,
      'max_amount_cents', null,
      'min_confidence', (array[90, 75, 60])[least(p_level, 3)])
  end;
$$;

-- ============================================================
-- TABLE: action_executions — the receipt/audit ledger. One row per
-- preview or execute call. Plain-language receipt always populated on
-- execute; preview rows are traceability-only (mode='preview', never
-- called the external system).
-- ============================================================
create table if not exists action_executions (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  action_definition_id uuid not null references action_definitions(id) on delete cascade,
  connector_id         uuid not null references connectors(id) on delete cascade,
  subject_kind         text check (subject_kind in ('de', 'specialist')),
  subject_id           uuid,
  mode                 text not null check (mode in ('preview', 'execute')),
  params               jsonb not null default '{}'::jsonb,
  decision             text not null check (decision in (
                          'previewed', 'auto_executed', 'human_gated_destructive',
                          'human_gated_trust', 'guardrail_blocked', 'access_denied',
                          'executed_after_approval', 'rejected', 'failed'
                        )),
  destructive          boolean not null default true,
  idempotent           boolean not null default false,
  dedupe_key           text,
  request_summary      text not null default '',   -- plain-language preview of what would happen
  receipt              text,                       -- plain-language summary of what DID happen (execute only)
  result               jsonb,
  task_id              uuid references human_tasks(id) on delete set null,
  created_at           timestamptz not null default now()
);

create index if not exists action_executions_tenant_idx on action_executions(tenant_id, created_at desc);
create index if not exists action_executions_task_idx on action_executions(task_id) where task_id is not null;
create index if not exists action_executions_dedupe_idx on action_executions(action_definition_id, dedupe_key) where dedupe_key is not null;

alter table action_executions enable row level security;
drop policy if exists "action_executions_tenant_select" on action_executions;
create policy "action_executions_tenant_select" on action_executions
  for select
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));
-- writes: service role only (connector-hub)

-- ============================================================
-- human_tasks: new type 'action_approval' (destructive-gate / trust-gate
-- task for a pending action execution).
-- ============================================================
alter table human_tasks drop constraint if exists human_tasks_type_check;
alter table human_tasks add constraint human_tasks_type_check
  check (type in ('approval_gate', 'review_gate', 'escalation', 'override',
                  'training_feedback', 'trust_promotion', 'trust_demotion_notice',
                  'checklist', 'knowledge_revision', 'inquiry_review', 'action_approval'));

-- ============================================================
-- decide_action_execution — THE COMPOSITION FUNCTION for the action
-- layer, mirroring decide_inquiry_triage / generateInvoice 1:1 with
-- ONE new rule stacked on top:
--
--   0. DESTRUCTIVE-ALWAYS-GATES (NEW, platform floor, non-negotiable):
--      if the action's risk.destructive = true -> ALWAYS
--      'human_gated_destructive'. This check runs BEFORE guardrails
--      and BEFORE trust are even consulted — no guardrail rule and no
--      trust tier can short-circuit it. This is not stored as a
--      guardrail_rules row (a tenant could disable/edit those); it is
--      hard-coded here, matching the founder's explicit requirement
--      that this composition sit even above "guardrail always wins."
--   1. GUARDRAIL CHECK (existing doctrine, always wins over trust):
--      any active blocking guardrail_rules row whose pattern matches
--      the action's label/category -> 'guardrail_blocked', regardless
--      of trust level.
--   2. TRUST DIAL (de_autonomy 'action_execute', SAME table/mechanism
--      invoice_auto_send/answer_widget already use): enabled AND
--      current trust level > baseline -> 'auto_executed'; otherwise
--      'human_gated_trust'.
-- ============================================================
create or replace function decide_action_execution(
  p_tenant_id     uuid,
  p_action_label  text,
  p_category      text,
  p_destructive   boolean
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_rule     record;
  v_text     text := lower(coalesce(p_action_label, '') || ' ' || coalesce(p_category, ''));
  v_autonomy record;
  v_enabled  boolean;
  v_frag     text;
  v_hit      boolean;
begin
  -- 0) DESTRUCTIVE ALWAYS GATES — checked first, unconditionally.
  -- No guardrail lookup, no trust lookup. This is the platform safety
  -- floor: a destructive action is ALWAYS human-approved, full stop.
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

  -- 2) Trust dial (de_autonomy, action_type='action_execute') — the
  --    SAME table/mechanism invoice_auto_send/answer_widget already use.
  select enabled into v_autonomy
  from de_autonomy where tenant_id = p_tenant_id and action_type = 'action_execute';
  v_enabled := coalesce(v_autonomy.enabled, false);

  if v_enabled then
    return jsonb_build_object(
      'decision', 'auto_executed',
      'guardrail_rule_id', null, 'guardrail_rule', null, 'trust_level', 1,
      'reasoning', format('Auto-executed: "%s" is not destructive, no guardrail blocked it, and this workspace has earned enough trust to auto-execute non-destructive actions.', p_action_label)
    );
  end if;

  return jsonb_build_object(
    'decision', 'human_gated_trust',
    'guardrail_rule_id', null, 'guardrail_rule', null, 'trust_level', null,
    'reasoning', format('Needs approval: "%s" is not destructive, but this workspace has not yet enabled auto-execution for non-destructive actions (Governance -> Trust & Architecture).', p_action_label)
  );
end;
$$;

revoke all on function decide_action_execution(uuid, text, text, boolean) from public;
grant execute on function decide_action_execution(uuid, text, text, boolean) to service_role;

-- ============================================================
-- record_action_execution — SECURITY DEFINER writer for
-- action_executions (+ optional human_task creation). Single entry
-- point so connector-hub never writes these tables directly.
-- ============================================================
create or replace function record_action_execution(
  p_tenant_id            uuid,
  p_action_definition_id uuid,
  p_connector_id         uuid,
  p_subject_kind         text,
  p_subject_id           uuid,
  p_mode                 text,     -- 'preview' | 'execute'
  p_params               jsonb,
  p_decision             text,
  p_destructive          boolean,
  p_idempotent           boolean,
  p_dedupe_key           text,
  p_request_summary      text,
  p_receipt              text,
  p_result               jsonb,
  p_task_title           text,     -- used only if a human_task is created
  p_task_detail          text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_task_id uuid;
  v_row_id  uuid;
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

  -- Backfill related_id on the task now that we know the execution row id.
  if v_task_id is not null then
    update human_tasks set related_id = v_row_id where id = v_task_id;
  end if;

  return jsonb_build_object('id', v_row_id, 'task_id', v_task_id);
end;
$$;

revoke all on function record_action_execution(uuid, uuid, uuid, text, uuid, text, jsonb, text, boolean, boolean, text, text, text, jsonb, text, text) from public;
grant execute on function record_action_execution(uuid, uuid, uuid, text, uuid, text, jsonb, text, boolean, boolean, text, text, text, jsonb, text, text) to service_role;

-- ============================================================
-- resolve_action_execution_for_task — decideHumanTask's action_approval
-- resolution hook target: given a task_id, find the pending
-- action_executions row (human_gated_*) so the edge function can
-- actually execute (approve) or mark rejected.
-- ============================================================
create or replace function resolve_action_execution_for_task(p_task_id uuid)
returns action_executions
language sql
stable
security definer
set search_path = public
as $$
  select * from action_executions where task_id = p_task_id
  order by created_at desc limit 1;
$$;
revoke all on function resolve_action_execution_for_task(uuid) from public;
grant execute on function resolve_action_execution_for_task(uuid) to service_role, authenticated;

-- ============================================================
-- audit_events: add the action_execution category (parallel to
-- connector_action / inquiry_triage — keeps Activity/Audit filterable).
-- ============================================================
alter table audit_events drop constraint if exists audit_events_category_check;
alter table audit_events add constraint audit_events_category_check
  check (category in (
    'resolved', 'escalated', 'approval', 'guardrail_check', 'guardrail_block',
    'config_change', 'playbook_step', 'invoice',
    'connector_sync', 'connector_action', 'evidence_step', 'access_control',
    'knowledge_revision', 'inquiry_triage', 'action_execution'
  ));

-- ============================================================
-- adapter_templates: no schema change needed (definition is jsonb) —
-- the `actions` map convention lives entirely in the TypeScript
-- AdapterDefinition type (supabase/functions/_shared/adapterTemplates.ts
-- + src/lib/adapterTemplates.ts), validated by the same
-- validateAdapterDefinition function, extended to also validate an
-- `actions` map parallel to `ops`.
-- ============================================================

-- ============================================================
-- SEED: platform-scope action_definitions for the two EXISTING Scribe
-- actions (backward compatibility — nothing regresses) + one NEW
-- Zendesk action proving the category has more than the original two,
-- + a template-provider generic_rest action for live verification.
-- ============================================================
do $$
declare
  v_add_note_id uuid;
  v_update_status_id uuid;
  v_reply_id uuid;
begin
  -- add_internal_note — existing Scribe action, provider='zendesk'
  -- native code path (execution_key names the connector-hub branch).
  insert into action_definitions (scope, tenant_id, category, action_key, label, description, provider, template_id, param_schema, risk, execution)
  values (
    'platform', null, 'helpdesk', 'add_internal_note',
    'Add an internal note to a ticket',
    'Posts a private (agent-only) note on a Zendesk ticket. Never visible to the customer.',
    'zendesk', null,
    '[{"name":"external_ref","type":"string","required":true,"help":"The ticket number to add the note to"},{"name":"note","type":"string","required":true,"help":"The note text (server-composed from a consultation citation in the Scribe flow)"}]'::jsonb,
    '{"destructive": false, "idempotent": false}'::jsonb,
    '{"execution_key": "zendesk_add_internal_note"}'::jsonb
  )
  on conflict (scope, tenant_id, category, action_key) do nothing
  returning id into v_add_note_id;

  -- update_status — existing Scribe action. Marked destructive: it
  -- changes externally visible ticket state a customer may see
  -- (solved/hold) — the honest, conservative risk call for v1.
  insert into action_definitions (scope, tenant_id, category, action_key, label, description, provider, template_id, param_schema, risk, execution)
  values (
    'platform', null, 'helpdesk', 'update_status',
    'Update a ticket''s status',
    'Changes a Zendesk ticket''s status (open/pending/hold/solved). Visible to the customer in most Zendesk setups.',
    'zendesk', null,
    '[{"name":"external_ref","type":"string","required":true,"help":"The ticket number to update"},{"name":"status","type":"string","required":true,"help":"One of: open, pending, hold, solved"}]'::jsonb,
    '{"destructive": true, "idempotent": true}'::jsonb,
    '{"execution_key": "zendesk_update_status"}'::jsonb
  )
  on conflict (scope, tenant_id, category, action_key) do nothing
  returning id into v_update_status_id;

  -- reply_to_ticket — NEW action proving the helpdesk category has
  -- more than the original two narrow actions. Zendesk's ticket
  -- comment API (PUT /api/v2/tickets/{id}.json with
  -- ticket.comment.public=true) is publicly documented and safe to
  -- add as a native execution_key — same code shape as
  -- update_status, just public:true and a body field instead of a
  -- status field. Destructive=true (a public reply reaches the
  -- customer immediately and cannot be unsent) — always human-gated.
  insert into action_definitions (scope, tenant_id, category, action_key, label, description, provider, template_id, param_schema, risk, execution)
  values (
    'platform', null, 'helpdesk', 'reply_to_ticket',
    'Reply to a customer on a ticket',
    'Posts a PUBLIC reply on a Zendesk ticket — the customer sees this immediately. Always requires human approval (destructive: a sent reply cannot be unsent).',
    'zendesk', null,
    '[{"name":"external_ref","type":"string","required":true,"help":"The ticket number to reply on"},{"name":"body","type":"string","required":true,"help":"The reply text the customer will see"}]'::jsonb,
    '{"destructive": true, "idempotent": false}'::jsonb,
    '{"execution_key": "zendesk_reply_to_ticket"}'::jsonb
  )
  on conflict (scope, tenant_id, category, action_key) do nothing
  returning id into v_reply_id;
end $$;

-- ============================================================
-- README note (documentation-only, no schema effect) — kept short;
-- full narrative lives in docs/boundary and memory files per the
-- founder's "plain language everywhere" rule.
-- ============================================================
