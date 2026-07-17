-- ═══════════════════════════════════════════════════════════════
-- 157 — Safe write-actions (rollback + idempotency) + deterministic
-- computation guardrail (roadmap muscles #6, #7)
--
-- #7 SAFE ACTIONS: action_executions already models preview vs execute,
-- destructive/idempotent, dedupe_key, and human-gated decisions
-- (migration ~058). Two gaps remained for a DE to DO things safely:
--   • ROLLBACK — record a compensating action against a prior execution.
--   • IDEMPOTENCY enforcement — the dedupe_key had only a non-unique
--     index. We do NOT add a unique constraint: the ledger is
--     append-only (7 historical rows already share a key, e.g. the
--     gated-then-approved double-row), and you don't put a unique
--     constraint on an audit log. Instead the executor calls
--     check_action_idempotency() BEFORE running and short-circuits to
--     the prior receipt — write-time idempotency, the correct pattern.
--
-- #6 DETERMINISTIC COMPUTE: LLMs approximate arithmetic; fatal for
-- billing/finance/medical-billing. New guardrail rule_type
-- 'require_computed_number' lets a tenant assert "this DE must not state
-- a number it didn't compute with a tool." The compute EDGE FUNCTION
-- (deployed separately) is the tool: pure deterministic math with a
-- verifiable receipt, no model in the loop. Also adds 'require_citation'
-- (grounding) to the same vocabulary.
-- ═══════════════════════════════════════════════════════════════

-- ── #7a rollback columns ──
alter table action_definitions
  add column if not exists reversible boolean not null default false,
  add column if not exists rollback   jsonb   not null default '{}'::jsonb;  -- compensating-action recipe

alter table action_executions
  add column if not exists rolled_back_at   timestamptz,
  add column if not exists rollback_of       uuid references action_executions(id) on delete set null,
  add column if not exists rollback_receipt  text;

-- ── #7b write-time idempotency lookup ──
-- Returns the prior SUCCESSFUL execute for this (action, dedupe_key), if
-- any, so the executor returns that receipt instead of running again.
create or replace function public.check_action_idempotency(
  p_tenant_id           uuid,
  p_action_definition_id uuid,
  p_dedupe_key          text
) returns table (execution_id uuid, receipt text, executed_at timestamptz)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select e.id, e.receipt, e.created_at
  from action_executions e
  where e.tenant_id = p_tenant_id
    and e.action_definition_id = p_action_definition_id
    and e.dedupe_key = p_dedupe_key
    and e.dedupe_key is not null
    and e.mode = 'execute'
    and e.decision in ('auto_executed', 'executed_after_approval')
    and e.rolled_back_at is null
  order by e.created_at desc
  limit 1;
$function$;

-- ── #7c record a rollback (appends a compensating execution + marks the
-- original). Service-role only — driven by the executor. ──
create or replace function public.record_action_rollback(
  p_original_execution_id uuid,
  p_receipt               text,
  p_result                jsonb default null
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_orig action_executions;
  v_new  uuid;
begin
  select * into v_orig from action_executions where id = p_original_execution_id;
  if v_orig.id is null then raise exception 'original execution not found'; end if;

  insert into action_executions (
    tenant_id, action_definition_id, connector_id, subject_kind, subject_id,
    mode, params, decision, destructive, idempotent, dedupe_key,
    request_summary, receipt, result, rollback_of
  ) values (
    v_orig.tenant_id, v_orig.action_definition_id, v_orig.connector_id, v_orig.subject_kind, v_orig.subject_id,
    'execute', v_orig.params, 'executed_after_approval', v_orig.destructive, v_orig.idempotent, null,
    'Rollback of execution ' || p_original_execution_id::text, p_receipt, p_result, p_original_execution_id
  ) returning id into v_new;

  update action_executions
     set rolled_back_at = now(), rollback_receipt = p_receipt
   where id = p_original_execution_id;
  return v_new;
end;
$function$;

-- ── #6 extend the guardrail rule vocabulary ──
alter table guardrail_rules drop constraint if exists guardrail_rules_rule_type_check;
alter table guardrail_rules add constraint guardrail_rules_rule_type_check
  check (rule_type in (
    -- existing live vocabulary (must stay a superset — 'frustration_signal'
    -- was added by a later migration and is in use; dropping it would
    -- violate existing rows).
    'blocked_topic', 'blocked_phrase', 'require_approval_over_cents', 'max_discount_pct',
    'frustration_signal',
    -- new this migration:
    'require_computed_number',   -- a stated number must carry a compute receipt
    'require_citation'           -- a factual claim must carry a knowledge citation
  ));

revoke all on function public.check_action_idempotency(uuid, uuid, text) from public, anon;
grant execute on function public.check_action_idempotency(uuid, uuid, text) to authenticated, service_role;
revoke all on function public.record_action_rollback(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_action_rollback(uuid, text, jsonb) to service_role;
