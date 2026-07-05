-- ============================================================
-- Migration 025: Earned-Trust Progression
--   Autonomy is EARNED per action category from measured evidence,
--   promoted by a human, demoted automatically on regression.
--   "Promote slow, demote fast."
--
--   COMPOSITION RULE (unchanged, migration 016): guardrails always
--   cap. Promotion only widens the trust dial (de_autonomy) WITHIN
--   guardrails — this migration never touches guardrail logic.
--
--   1. trust_policies — one row per tenant x action_category:
--      current earned level (0..3), promotion criteria (jsonb),
--      pending-promotion bookkeeping. Levels map onto de_autonomy
--      via trust_level_settings() (the ladder).
--   2. compute_trust_evidence() — server-computed evidence from
--      three sources: eval_runs (Proving Ground pass rate),
--      human_tasks outcomes (approval rate), audit_events
--      guardrail blocks. The client never asserts evidence.
--   3. request_trust_promotion() — recomputes evidence, requires
--      eligible, creates a trust_promotion human task with the
--      evidence snapshot. apply_trust_promotion() (decideHumanTask
--      hook #4) RE-VERIFIES evidence at apply time (stale-check),
--      blocks self-approval, then moves the dial one level up.
--   4. Automatic demotion — triggers on eval_runs completion
--      (pass rate below the policy floor) and on guardrail_block
--      audit events: drop one level immediately (never below
--      baseline), audit trust_demoted, create an informational
--      trust_demotion_notice task. No human gate on the way down.
--
--   Audit events use the existing 'config_change' category with
--   detail.kind = 'trust_*' (same pattern as eval_run events in
--   018) — the audit_events category constraint is untouched.
-- ============================================================

-- ============================================================
-- human_tasks: add trust task types
-- ============================================================
alter table human_tasks drop constraint if exists human_tasks_type_check;
alter table human_tasks add constraint human_tasks_type_check
  check (type in (
    'approval_gate', 'review_gate', 'escalation', 'override', 'training_feedback',
    'trust_promotion', 'trust_demotion_notice'
  ));

-- ============================================================
-- TABLE: trust_policies
-- ============================================================
create table if not exists trust_policies (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  -- The tenant's primary DE (nullable: de_autonomy is tenant-scoped
  -- today; de_id is recorded for the coming per-DE dial).
  de_id            uuid references digital_employees(id) on delete set null,
  action_category  text not null
                     check (action_category in ('invoice_auto_send', 'answer_dock', 'answer_widget')),
  baseline_level   integer not null default 0 check (baseline_level between 0 and 3),
  current_level    integer not null default 0 check (current_level between 0 and 3),
  target_level     integer generated always as (least(current_level + 1, 3)) stored,
  -- Promotion criteria. All keys required by compute_trust_evidence:
  --   window_days, min_eval_pass_rate (0..1), min_eval_samples,
  --   min_human_approval_rate (0..1), min_human_samples,
  --   max_guardrail_blocks (default 0).
  criteria         jsonb not null default '{
                     "window_days": 30,
                     "min_eval_pass_rate": 0.9,
                     "min_eval_samples": 25,
                     "min_human_approval_rate": 0.9,
                     "min_human_samples": 5,
                     "max_guardrail_blocks": 0
                   }'::jsonb,
  status           text not null default 'active' check (status in ('active', 'paused')),
  -- Pending promotion bookkeeping (set by request_trust_promotion,
  -- cleared by apply_trust_promotion).
  pending_task_id  uuid,
  pending_evidence jsonb,
  requested_by     uuid,
  requested_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, action_category)
);

create index if not exists trust_policies_tenant_idx on trust_policies(tenant_id);

alter table trust_policies enable row level security;

-- Read-only for tenant members; ALL writes go through the
-- SECURITY DEFINER RPCs below (evidence and level changes must be
-- server-computed — the client never asserts them).
drop policy if exists "trust_policies_tenant_read" on trust_policies;
create policy "trust_policies_tenant_read" on trust_policies
  for select
  using (tenant_id in (select tenant_id from profiles where user_id = auth.uid()));

drop trigger if exists trust_policies_updated_at on trust_policies;
create trigger trust_policies_updated_at
  before update on trust_policies
  for each row execute function update_updated_at();

-- ============================================================
-- The ladder: what each earned level means on the trust dial.
--   invoice_auto_send  L0 off · L1 ≤$1,000 · L2 ≤$5,000 · L3 ≤$10,000
--   answer_dock/widget L0 off · L1 conf≥90 · L2 conf≥75 · L3 conf≥60
-- ============================================================
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
    else jsonb_build_object(
      'enabled', true,
      'max_amount_cents', null,
      'min_confidence', (array[90, 75, 60])[least(p_level, 3)])
  end;
$$;

-- Apply an earned level to the trust dial (de_autonomy upsert).
create or replace function trust_apply_level(p_tenant_id uuid, p_category text, p_level integer, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_s jsonb := trust_level_settings(p_category, p_level);
begin
  insert into de_autonomy (tenant_id, action_type, enabled, max_amount_cents, min_confidence, updated_by)
  values (
    p_tenant_id, p_category,
    (v_s->>'enabled')::boolean,
    nullif(v_s->>'max_amount_cents', '')::bigint,
    nullif(v_s->>'min_confidence', '')::integer,
    p_actor
  )
  on conflict (tenant_id, action_type) do update set
    enabled          = excluded.enabled,
    max_amount_cents = excluded.max_amount_cents,
    min_confidence   = excluded.min_confidence,
    updated_by       = excluded.updated_by,
    updated_at       = now();
end;
$$;
revoke all on function trust_apply_level(uuid, text, integer, uuid) from public;
-- internal helper — not granted to authenticated

-- ============================================================
-- RPC: seed_trust_policies — sensible defaults for the CALLER's
-- tenant (all three de_autonomy categories, linked to the tenant's
-- first DE if one exists). Demo tenant untouched: refuses to seed
-- the seeded demo tenant so the demo story keeps its own machinery.
-- ============================================================
create or replace function seed_trust_policies()
returns setof trust_policies
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tenant uuid;
  v_de     uuid;
begin
  select tenant_id into v_tenant from profiles where user_id = auth.uid() limit 1;
  if v_tenant is null then
    raise exception 'no tenant for the current session';
  end if;
  if v_tenant = 'a0000000-0000-0000-0000-000000000001'::uuid then
    raise exception 'demo tenant uses the demo story — earned trust is a live-tenant feature';
  end if;

  select id into v_de from digital_employees where tenant_id = v_tenant order by created_at limit 1;

  insert into trust_policies (tenant_id, de_id, action_category, criteria)
  values
    (v_tenant, v_de, 'invoice_auto_send', '{"window_days":30,"min_eval_pass_rate":0.9,"min_eval_samples":25,"min_human_approval_rate":0.9,"min_human_samples":5,"max_guardrail_blocks":0}'::jsonb),
    (v_tenant, v_de, 'answer_dock',       '{"window_days":30,"min_eval_pass_rate":0.9,"min_eval_samples":25,"min_human_approval_rate":0.9,"min_human_samples":0,"max_guardrail_blocks":0}'::jsonb),
    (v_tenant, v_de, 'answer_widget',     '{"window_days":30,"min_eval_pass_rate":0.95,"min_eval_samples":40,"min_human_approval_rate":0.9,"min_human_samples":0,"max_guardrail_blocks":0}'::jsonb)
  on conflict (tenant_id, action_category) do nothing;

  return query select * from trust_policies where tenant_id = v_tenant order by action_category;
end;
$$;
revoke all on function seed_trust_policies() from public;
grant execute on function seed_trust_policies() to authenticated;

-- ============================================================
-- Evidence computation (internal): all three sources, one window.
-- ============================================================
create or replace function trust_evidence_for(p_policy trust_policies)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  c              jsonb := p_policy.criteria;
  v_window       integer := coalesce((c->>'window_days')::integer, 30);
  v_since        timestamptz := now() - make_interval(days => coalesce((c->>'window_days')::integer, 30));
  -- eval evidence
  v_eval_total   bigint := 0;
  v_eval_passed  bigint := 0;
  v_eval_rate    numeric := 0;
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
  -- Source 1: Proving Ground — finished eval runs in the window.
  select coalesce(sum(total), 0), coalesce(sum(passed), 0)
    into v_eval_total, v_eval_passed
  from eval_runs
  where tenant_id = p_policy.tenant_id
    and finished_at is not null
    and finished_at >= v_since
    and status in ('passed', 'failed');
  v_eval_rate := case when v_eval_total > 0 then round(v_eval_passed::numeric / v_eval_total, 4) else 0 end;

  -- Source 2: human task outcomes in the window. invoice category
  -- reads invoice approval gates; answer categories read
  -- escalation / review outcomes (sparse until LLM activation —
  -- min_human_samples defaults to 0 there, honestly noted).
  select count(*), count(*) filter (where status = 'approved')
    into v_h_total, v_h_approved
  from human_tasks
  where tenant_id = p_policy.tenant_id
    and status in ('approved', 'rejected')
    and decided_at is not null
    and decided_at >= v_since
    and case
      when p_policy.action_category = 'invoice_auto_send'
        then (related_table = 'renewal_invoices' or type = 'approval_gate')
      else type in ('escalation', 'review_gate')
    end;
  v_h_rate := case when v_h_total > 0 then round(v_h_approved::numeric / v_h_total, 4) else 0 end;

  -- Source 3: guardrail blocks in the window (tenant-wide).
  select count(*) into v_blocks
  from audit_events
  where tenant_id = p_policy.tenant_id
    and category = 'guardrail_block'
    and created_at >= v_since;

  v_criteria := jsonb_build_array(
    jsonb_build_object(
      'key', 'eval_pass_rate', 'label', 'Evaluation pass rate',
      'actual', v_eval_rate, 'required', v_min_rate,
      'met', (v_eval_total >= v_min_samples and v_eval_rate >= v_min_rate),
      'detail', format('%s of %s evaluated answers passed in the last %s days', v_eval_passed, v_eval_total, v_window)),
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
$$;
revoke all on function trust_evidence_for(trust_policies) from public;

-- ============================================================
-- RPC: compute_trust_evidence(de_id, action_category)
-- Membership-guarded; evidence is always server-computed.
-- ============================================================
create or replace function compute_trust_evidence(p_de_id uuid, p_action_category text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_tenant uuid;
  v_policy trust_policies;
begin
  select tenant_id into v_tenant from profiles where user_id = auth.uid() limit 1;
  if v_tenant is null then
    raise exception 'not a member of any tenant';
  end if;

  select * into v_policy
  from trust_policies
  where tenant_id = v_tenant
    and action_category = p_action_category
    and (p_de_id is null or de_id is null or de_id = p_de_id)
  limit 1;
  if not found then
    raise exception 'no trust policy for category %', p_action_category;
  end if;

  return trust_evidence_for(v_policy);
end;
$$;
revoke all on function compute_trust_evidence(uuid, text) from public;
grant execute on function compute_trust_evidence(uuid, text) to authenticated, service_role;

-- ============================================================
-- RPC: request_trust_promotion — recomputes evidence server-side,
-- REJECTS if not eligible, else creates the trust_promotion human
-- task with the evidence snapshot and audits the request.
-- ============================================================
create or replace function request_trust_promotion(p_policy_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_policy   trust_policies;
  v_evidence jsonb;
  v_task_id  uuid;
  v_label    text;
begin
  select * into v_policy from trust_policies where id = p_policy_id;
  if not found then
    raise exception 'trust policy not found';
  end if;
  if not exists (select 1 from profiles where user_id = auth.uid() and tenant_id = v_policy.tenant_id) then
    raise exception 'not a member of this tenant';
  end if;
  if v_policy.status <> 'active' then
    raise exception 'trust policy is paused';
  end if;
  if v_policy.current_level >= 3 then
    raise exception 'already at the highest trust level';
  end if;
  if v_policy.pending_task_id is not null
     and exists (select 1 from human_tasks where id = v_policy.pending_task_id and status = 'pending') then
    raise exception 'a promotion request is already awaiting approval';
  end if;

  v_evidence := trust_evidence_for(v_policy);
  if not coalesce((v_evidence->>'eligible')::boolean, false) then
    raise exception 'not eligible for promotion — evidence does not yet meet the policy criteria';
  end if;

  v_label := replace(v_policy.action_category, '_', ' ');
  insert into human_tasks (tenant_id, type, title, detail, source, related_table, related_id)
  values (
    v_policy.tenant_id, 'trust_promotion',
    format('Trust promotion — %s to level %s', v_label, v_policy.current_level + 1),
    format('Evidence met all criteria: %s. Approving widens autonomy one step — still capped by guardrails.',
      (select string_agg(x->>'detail', ' · ') from jsonb_array_elements(v_evidence->'criteria') x)),
    'system', 'trust_policies', v_policy.id
  )
  returning id into v_task_id;

  update trust_policies
  set pending_task_id = v_task_id,
      pending_evidence = v_evidence,
      requested_by = auth.uid(),
      requested_at = now()
  where id = v_policy.id;

  perform append_audit_event(
    v_policy.tenant_id, 'Trust engine', 'system',
    format('Trust promotion requested — %s level %s → %s (evidence eligible)',
      v_label, v_policy.current_level, v_policy.current_level + 1),
    'config_change',
    jsonb_build_object('kind', 'trust_promotion_requested', 'policy_id', v_policy.id,
      'action_category', v_policy.action_category, 'from_level', v_policy.current_level,
      'to_level', v_policy.current_level + 1, 'task_id', v_task_id,
      'requested_by', auth.uid(), 'evidence', v_evidence)
  );

  return jsonb_build_object('ok', true, 'task_id', v_task_id, 'evidence', v_evidence);
end;
$$;
revoke all on function request_trust_promotion(uuid) from public;
grant execute on function request_trust_promotion(uuid) to authenticated;

-- ============================================================
-- RPC: apply_trust_promotion — decideHumanTask hook #4.
-- On approval: blocks self-approval, RE-VERIFIES evidence is STILL
-- eligible (stale-check), then moves de_autonomy one level up and
-- audits trust_promoted with the fresh evidence + approver.
-- On rejection: audits trust_promotion_rejected. Idempotent: no
-- pending policy for the task → no-op.
-- ============================================================
create or replace function apply_trust_promotion(p_task_id uuid, p_decision text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_policy   trust_policies;
  v_evidence jsonb;
  v_new      integer;
  v_label    text;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected';
  end if;

  select * into v_policy from trust_policies where pending_task_id = p_task_id;
  if not found then
    return jsonb_build_object('applied', false, 'reason', 'no_pending_policy');
  end if;

  if coalesce(auth.role(), '') <> 'service_role' and not exists (
    select 1 from profiles where user_id = auth.uid() and tenant_id = v_policy.tenant_id
  ) then
    raise exception 'not a member of this tenant';
  end if;

  v_label := replace(v_policy.action_category, '_', ' ');

  if p_decision = 'rejected' then
    update trust_policies
    set pending_task_id = null, pending_evidence = null, requested_by = null, requested_at = null
    where id = v_policy.id;
    perform append_audit_event(
      v_policy.tenant_id, 'You', 'human',
      format('Trust promotion rejected — %s stays at level %s', v_label, v_policy.current_level),
      'config_change',
      jsonb_build_object('kind', 'trust_promotion_rejected', 'policy_id', v_policy.id,
        'action_category', v_policy.action_category, 'level', v_policy.current_level,
        'task_id', p_task_id, 'decided_by', auth.uid())
    );
    return jsonb_build_object('applied', false, 'reason', 'rejected');
  end if;

  -- Self-approval block: the requester cannot approve their own promotion.
  if auth.uid() is not null and v_policy.requested_by is not null and auth.uid() = v_policy.requested_by then
    perform append_audit_event(
      v_policy.tenant_id, 'Trust engine', 'system',
      format('Trust promotion blocked — requester cannot approve their own request (%s)', v_label),
      'config_change',
      jsonb_build_object('kind', 'trust_promotion_blocked_self_approval', 'policy_id', v_policy.id,
        'action_category', v_policy.action_category, 'task_id', p_task_id, 'user_id', auth.uid())
    );
    raise exception 'the requester cannot approve their own promotion — a different teammate must approve';
  end if;

  -- Stale-check: evidence could have regressed since the request.
  v_evidence := trust_evidence_for(v_policy);
  if not coalesce((v_evidence->>'eligible')::boolean, false) then
    update trust_policies
    set pending_task_id = null, pending_evidence = null, requested_by = null, requested_at = null
    where id = v_policy.id;
    perform append_audit_event(
      v_policy.tenant_id, 'Trust engine', 'system',
      format('Trust promotion rejected as stale — %s evidence regressed since the request', v_label),
      'config_change',
      jsonb_build_object('kind', 'trust_promotion_stale', 'policy_id', v_policy.id,
        'action_category', v_policy.action_category, 'task_id', p_task_id,
        'evidence_at_request', v_policy.pending_evidence, 'evidence_at_apply', v_evidence)
    );
    raise exception 'evidence regressed since the request — promotion rejected as stale';
  end if;

  v_new := least(v_policy.current_level + 1, 3);
  perform trust_apply_level(v_policy.tenant_id, v_policy.action_category, v_new, auth.uid());

  update trust_policies
  set current_level = v_new,
      pending_task_id = null, pending_evidence = null, requested_by = null, requested_at = null
  where id = v_policy.id;

  perform append_audit_event(
    v_policy.tenant_id, 'You', 'human',
    format('Trust promoted — %s level %s → %s (evidence re-verified at apply time; still capped by guardrails)',
      v_label, v_policy.current_level, v_new),
    'config_change',
    jsonb_build_object('kind', 'trust_promoted', 'policy_id', v_policy.id,
      'action_category', v_policy.action_category, 'from_level', v_policy.current_level,
      'to_level', v_new, 'task_id', p_task_id, 'approved_by', auth.uid(),
      'requested_by', v_policy.requested_by, 'evidence', v_evidence,
      'dial_settings', trust_level_settings(v_policy.action_category, v_new),
      'composition', 'autonomy_narrows_within_guardrails')
  );

  return jsonb_build_object('applied', true, 'new_level', v_new);
end;
$$;
revoke all on function apply_trust_promotion(uuid, text) from public;
grant execute on function apply_trust_promotion(uuid, text) to authenticated, service_role;

-- ============================================================
-- Automatic demotion — server-side and immediate. "Demote fast."
-- ============================================================
create or replace function trust_demote(p_tenant_id uuid, p_category text, p_reason text, p_evidence jsonb)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_policy trust_policies;
  v_new    integer;
  v_label  text;
begin
  select * into v_policy
  from trust_policies
  where tenant_id = p_tenant_id and action_category = p_category
    and status = 'active' and current_level > baseline_level
  for update;
  if not found then
    return;
  end if;

  v_new := greatest(v_policy.current_level - 1, v_policy.baseline_level);
  v_label := replace(p_category, '_', ' ');

  perform trust_apply_level(p_tenant_id, p_category, v_new, null);
  update trust_policies
  set current_level = v_new,
      pending_task_id = null, pending_evidence = null, requested_by = null, requested_at = null
  where id = v_policy.id;

  perform append_audit_event(
    p_tenant_id, 'Trust engine', 'system',
    format('Trust demoted — %s level %s → %s (%s). Demotion is automatic and immediate.',
      v_label, v_policy.current_level, v_new, p_reason),
    'config_change',
    jsonb_build_object('kind', 'trust_demoted', 'policy_id', v_policy.id,
      'action_category', p_category, 'from_level', v_policy.current_level,
      'to_level', v_new, 'reason', p_reason, 'evidence', p_evidence)
  );

  insert into human_tasks (tenant_id, type, title, detail, source, related_table, related_id)
  values (
    p_tenant_id, 'trust_demotion_notice',
    format('Trust reduced — %s dropped to level %s', v_label, v_new),
    format('Reason: %s. The dial was lowered automatically to stay safe. Approve to acknowledge — trust can be re-earned through the same evidence path.', p_reason),
    'system', 'trust_policies', v_policy.id
  );
end;
$$;
revoke all on function trust_demote(uuid, text, text, jsonb) from public;
-- internal — invoked by triggers only

-- Trigger 1: eval-run completion. When a run finishes with a pass
-- rate below any promoted policy's floor → demote that category.
-- Exception-swallowing: a demotion failure must never break the
-- eval-run edge function's status write.
create or replace function trust_check_eval_regression()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_rate   numeric;
  v_policy record;
begin
  if new.finished_at is null or new.status not in ('passed', 'failed') or coalesce(new.total, 0) = 0 then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.finished_at is not null then
    return new; -- only fire on the completion transition
  end if;

  v_rate := new.passed::numeric / new.total;
  begin
    for v_policy in
      select * from trust_policies
      where tenant_id = new.tenant_id and status = 'active' and current_level > baseline_level
        and v_rate < coalesce((criteria->>'min_eval_pass_rate')::numeric, 0.9)
    loop
      perform trust_demote(
        new.tenant_id, v_policy.action_category,
        format('evaluation pass rate fell to %s%% — below the %s%% floor',
          round(v_rate * 100), round(coalesce((v_policy.criteria->>'min_eval_pass_rate')::numeric, 0.9) * 100)),
        jsonb_build_object('eval_run_id', new.id, 'passed', new.passed, 'total', new.total, 'pass_rate', round(v_rate, 4))
      );
    end loop;
  exception when others then
    raise warning 'trust_check_eval_regression: %', sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists trust_eval_regression on eval_runs;
create trigger trust_eval_regression
  after insert or update on eval_runs
  for each row execute function trust_check_eval_regression();

-- Trigger 2: guardrail block. Any guardrail_block audit event
-- demotes every promoted category for that tenant (max_guardrail_blocks
-- defaults to 0 — one strike). Exception-swallowing: a demotion
-- failure must never break append_audit_event.
create or replace function trust_check_guardrail_block()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_policy record;
begin
  if new.category <> 'guardrail_block' then
    return new;
  end if;
  begin
    for v_policy in
      select * from trust_policies
      where tenant_id = new.tenant_id and status = 'active' and current_level > baseline_level
        and coalesce((criteria->>'max_guardrail_blocks')::integer, 0) = 0
    loop
      perform trust_demote(
        new.tenant_id, v_policy.action_category,
        'a guardrail block occurred — zero-tolerance policy',
        jsonb_build_object('audit_event_id', new.id, 'blocked_action', new.action)
      );
    end loop;
  exception when others then
    raise warning 'trust_check_guardrail_block: %', sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists trust_guardrail_block on audit_events;
create trigger trust_guardrail_block
  after insert on audit_events
  for each row execute function trust_check_guardrail_block();
