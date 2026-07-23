-- 306_trust_ladder_per_employee.sql
-- ============================================================================
-- GI-3 (Governance Integrity) — make earned trust GENUINELY per-employee.
--
-- THE GAP: mig 108 already made the storage + resolver per-DE — de_autonomy and
-- trust_policies got a de_id column, resolve_de_autonomy cascades
-- de_id → de_id+source → tenant-wide, and trust_apply_level gained a p_de_id
-- parameter (6-arg). But the LADDER — the functions that actually MOVE the
-- dial — never pass it:
--   • apply_trust_promotion (live = mig 059) calls trust_apply_level with only
--     5 args, so p_de_id defaults NULL → a promotion earned on ONE employee's
--     evidence widens the TENANT-WIDE dial for that category. Every other DE in
--     the category inherits autonomy it never earned. (Over-grant = the unsafe
--     direction — this is the security-relevant half.)
--   • trust_demote (mig 025) has no de_id at all and writes tenant-wide too.
--
-- Why BOTH must change together: once promotion writes a per-DE de_autonomy row,
-- the resolver finds that row FIRST — so a tenant-wide demotion (de_id NULL)
-- can no longer claw back that employee's level. Fixing promotion alone would
-- make a promoted employee effectively UN-DEMOTABLE, breaking the "demote fast"
-- safety guarantee. So demotion is threaded per-DE in the same migration.
--
-- Faithful reproduction: the promotion body is mig 059 verbatim; the demotion
-- body + its two triggers are mig 025 verbatim — the ONLY changes are the de_id
-- (and source_category, for precise scope) threaded into the trust_apply_level
-- and trust_demote calls, plus de_id added to the audit detail. GLOBAL.
-- ============================================================================

-- 1. Promotion: thread v_policy.de_id (+ source_category) into the dial write --
CREATE OR REPLACE FUNCTION public.apply_trust_promotion(p_task_id uuid, p_decision text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
declare
  v_policy    trust_policies;
  v_evidence  jsonb;
  v_new       integer;
  v_label     text;
  v_is_active boolean;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected';
  end if;

  select * into v_policy from trust_policies where pending_task_id = p_task_id;
  if not found then
    return jsonb_build_object('applied', false, 'reason', 'no_pending_policy');
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    select coalesce(is_active, true) into v_is_active from profiles where user_id = auth.uid() and tenant_id = v_policy.tenant_id;
    if v_is_active is null or not v_is_active then
      raise exception 'not a member of this tenant';
    end if;
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
  -- GI-3: scope the dial write to THIS employee (v_policy.de_id) — a NULL de_id
  -- keeps the historical tenant-wide behavior for tenant-scoped policies.
  perform trust_apply_level(v_policy.tenant_id, v_policy.action_category, v_new, auth.uid(), v_policy.source_category, v_policy.de_id);

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
      'action_category', v_policy.action_category, 'de_id', v_policy.de_id,
      'from_level', v_policy.current_level,
      'to_level', v_new, 'task_id', p_task_id, 'approved_by', auth.uid(),
      'requested_by', v_policy.requested_by, 'evidence', v_evidence,
      'dial_settings', trust_level_settings(v_policy.action_category, v_new),
      'composition', 'autonomy_narrows_within_guardrails')
  );

  return jsonb_build_object('applied', true, 'new_level', v_new);
end;
$$;
REVOKE ALL ON FUNCTION public.apply_trust_promotion(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.apply_trust_promotion(uuid, text) TO authenticated, service_role;

-- 2. Demotion: add de_id (+ source_category), target the EXACT policy, and
--    write the dial back at that same scope so a per-DE promotion is demotable.
--    The 4-arg signature is replaced by the 6-arg (DROP first: adding params via
--    CREATE OR REPLACE would create an overload, not replace).
DROP FUNCTION IF EXISTS trust_demote(uuid, text, text, jsonb);
CREATE OR REPLACE FUNCTION trust_demote(
  p_tenant_id       uuid,
  p_category        text,
  p_reason          text,
  p_evidence        jsonb,
  p_de_id           uuid  default null,
  p_source_category text  default null
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
declare
  v_policy trust_policies;
  v_new    integer;
  v_label  text;
begin
  -- Target the EXACT policy (per-DE + per-source), not an arbitrary tenant/
  -- category row. NULL de_id / source_category match the tenant-wide policy.
  select * into v_policy
  from trust_policies
  where tenant_id = p_tenant_id and action_category = p_category
    and de_id is not distinct from p_de_id
    and source_category is not distinct from p_source_category
    and status = 'active' and current_level > baseline_level
  for update;
  if not found then
    return;
  end if;

  v_new := greatest(v_policy.current_level - 1, v_policy.baseline_level);
  v_label := replace(p_category, '_', ' ');

  -- GI-3: demote at the SAME scope the promotion was granted at.
  perform trust_apply_level(p_tenant_id, p_category, v_new, null, p_source_category, p_de_id);
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
      'action_category', p_category, 'de_id', p_de_id, 'from_level', v_policy.current_level,
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
REVOKE ALL ON FUNCTION trust_demote(uuid, text, text, jsonb, uuid, text) FROM public, anon, authenticated;
-- internal — invoked by triggers only

-- 3. Demotion trigger #1 (eval regression): pass each policy's de_id + source. --
CREATE OR REPLACE FUNCTION trust_check_eval_regression()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
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
        jsonb_build_object('eval_run_id', new.id, 'passed', new.passed, 'total', new.total, 'pass_rate', round(v_rate, 4)),
        v_policy.de_id, v_policy.source_category
      );
    end loop;
  exception when others then
    raise warning 'trust_check_eval_regression: %', sqlerrm;
  end;
  return new;
end;
$$;

-- 4. Demotion trigger #2 (guardrail block): pass each policy's de_id + source. --
CREATE OR REPLACE FUNCTION trust_check_guardrail_block()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
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
        jsonb_build_object('audit_event_id', new.id, 'blocked_action', new.action),
        v_policy.de_id, v_policy.source_category
      );
    end loop;
  exception when others then
    raise warning 'trust_check_guardrail_block: %', sqlerrm;
  end;
  return new;
end;
$$;
