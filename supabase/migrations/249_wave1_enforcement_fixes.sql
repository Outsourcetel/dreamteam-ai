-- 249_wave1_enforcement_fixes.sql
-- ============================================================================
-- WAVE 1 of the Employee File truth audit (docs/15, founder-approved
-- 2026-07-22). Two enforcement fixes, both faithful reproductions of the
-- LIVE function bodies with one surgical change each:
--
--  1. decide_action_execution — the blocking-guardrail check now honors
--     SCOPE via guardrail_rules_for_de (workspace + this employee's
--     employee/department rules), exactly like the answer paths. Before,
--     it applied EVERY tenant blocking rule to every DE's actions.
--     (Reproduced from mig 235, the current live body.)
--
--  2. claim_de_work_items — the work queue now refuses items whose employee
--     is paused/retired/archived or not active, closing the last lifecycle
--     hole (every other surface already refused unavailable employees).
--     Skipped items simply stay queued and resume when the employee does.
--     (Reproduced from mig 156.)
-- ============================================================================

-- ── 1. decide_action_execution (from mig 235 + scope-aware guardrails) ──────
CREATE OR REPLACE FUNCTION decide_action_execution(
  p_tenant_id     uuid,
  p_action_label  text,
  p_category      text,
  p_destructive   boolean,
  p_de_id         uuid default null,
  p_amount_cents  bigint default null,
  p_action_type   text default 'action_execute'
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions
AS $$
declare
  v_rule      record;
  v_text      text := lower(coalesce(p_action_label, '') || ' ' || coalesce(p_category, ''));
  v_autonomy  record;
  v_frag      text;
  v_hit       boolean;
  v_threshold bigint;
  v_period    text;
  v_spent     bigint;
begin
  -- 0) DESTRUCTIVE ALWAYS GATES.
  if coalesce(p_destructive, true) then
    return jsonb_build_object('decision', 'human_gated_destructive',
      'guardrail_rule_id', null, 'guardrail_rule', null, 'trust_level', null,
      'reasoning', format('This action is marked destructive — it always requires human approval regardless of trust level. This is a platform safety floor, not a per-department setting: "%s" will never auto-execute.', p_action_label));
  end if;

  -- 1) Guardrail check (blocked_phrase / blocked_topic — always win).
  --    WAVE-1 FIX: scope-aware via guardrail_rules_for_de (workspace + this
  --    employee's employee/department rules) instead of every tenant rule.
  for v_rule in
    select id, rule, pattern
    from guardrail_rules_for_de(p_tenant_id, p_de_id,
                                array['blocked_phrase', 'blocked_topic'])
    where severity = 'blocking'
  loop
    if v_rule.pattern is null then continue; end if;
    foreach v_frag in array string_to_array(v_rule.pattern, '|') loop
      v_frag := trim(both from lower(v_frag));
      if v_frag = '' then continue; end if;
      begin v_hit := v_text ~ v_frag;
      exception when others then v_hit := position(v_frag in v_text) > 0; end;
      if v_hit then
        return jsonb_build_object('decision', 'guardrail_blocked',
          'guardrail_rule_id', v_rule.id, 'guardrail_rule', v_rule.rule, 'trust_level', null,
          'reasoning', format('Blocked: guardrail rule "%s" matched this action — routed to a human regardless of trust. Guardrails always win over the trust dial.', v_rule.rule));
      end if;
    end loop;
  end loop;

  -- 1.5) Amount guardrail (require_approval_over_cents).
  if p_amount_cents is not null then
    select threshold into v_threshold from guardrail_rules
    where tenant_id = p_tenant_id and rule_type = 'require_approval_over_cents' and active
    order by updated_at desc limit 1;
    v_threshold := coalesce(v_threshold, 1000000);
    if p_amount_cents > v_threshold then
      return jsonb_build_object('decision', 'human_gated_trust',
        'guardrail_rule_id', null, 'guardrail_rule', 'require_approval_over_cents', 'trust_level', null,
        'reasoning', format('Needs approval: "%s" is for $%s, above this workspace''s $%s approval threshold. Amounts over the threshold always get a human, regardless of the trust dial.', p_action_label, round(p_amount_cents / 100.0), round(v_threshold / 100.0)));
    end if;
  end if;

  -- 1.6) SPEND CAPS (additive, GUARDED) — only DEs with a configured spend_cap
  --      rule are affected. Sums this period's ledger + this action's amount and
  --      gates to a human if it would breach the cap. A DE with no cap: no-op.
  if p_de_id is not null and p_amount_cents is not null then
    for v_rule in
      select rule_type, threshold from guardrail_rules
      where tenant_id = p_tenant_id and active
        and rule_type in ('spend_cap_daily_cents', 'spend_cap_monthly_cents')
        and (scope = 'workspace' or (scope = 'employee' and scope_ref = p_de_id::text))
        and threshold is not null
      order by threshold asc
    loop
      if v_rule.rule_type = 'spend_cap_daily_cents' then
        v_period := to_char(current_date, 'YYYY-MM-DD');
        select coalesce(sum(cents), 0) into v_spent from de_spend_ledger
          where tenant_id = p_tenant_id and de_id = p_de_id and period_kind = 'day' and period_key = v_period;
      else
        v_period := to_char(current_date, 'YYYY-MM');
        select coalesce(sum(cents), 0) into v_spent from de_spend_ledger
          where tenant_id = p_tenant_id and de_id = p_de_id and period_kind = 'month' and period_key = v_period;
      end if;
      if v_spent + p_amount_cents > v_rule.threshold then
        return jsonb_build_object('decision', 'human_gated_trust',
          'guardrail_rule_id', null, 'guardrail_rule', v_rule.rule_type, 'trust_level', null,
          'reasoning', format('Needs approval: this $%s spend would take %s spend to $%s, over the $%s cap. Spend over the cap always gets a human.',
            round(p_amount_cents / 100.0),
            case when v_rule.rule_type = 'spend_cap_daily_cents' then 'today''s' else 'this month''s' end,
            round((v_spent + p_amount_cents) / 100.0), round(v_rule.threshold / 100.0)));
      end if;
    end loop;
  end if;

  -- 2) Trust dial (per-employee cascade).
  select * into v_autonomy from resolve_de_autonomy(p_tenant_id, p_action_type, p_de_id, p_category);
  if coalesce(v_autonomy.enabled, false)
     and (p_amount_cents is null
          or (v_autonomy.max_amount_cents is not null and p_amount_cents <= v_autonomy.max_amount_cents)) then
    return jsonb_build_object('decision', 'auto_executed',
      'guardrail_rule_id', null, 'guardrail_rule', null, 'trust_level', 1,
      'reasoning', case
        when p_amount_cents is not null then
          format('Auto-executed: "%s" ($%s) is within both the workspace approval threshold and the earned trust-dial limit of $%s%s, and no guardrail blocked it.',
            p_action_label, round(p_amount_cents / 100.0), round(v_autonomy.max_amount_cents / 100.0),
            case when p_de_id is not null then ' resolved for this employee' else '' end)
        else
          format('Auto-executed: "%s" is not destructive, no guardrail blocked it, and the trust dial%s allows auto-executing non-destructive actions for %s.',
            p_action_label, case when p_de_id is not null then ' (resolved for this employee)' else '' end, p_category)
      end);
  end if;

  return jsonb_build_object('decision', 'human_gated_trust',
    'guardrail_rule_id', null, 'guardrail_rule', null, 'trust_level', null,
    'reasoning', case
      when not coalesce(v_autonomy.enabled, false) then
        format('Needs approval: "%s" is not destructive, but the trust dial has not enabled auto-execution for %s %s actions yet (Governance -> Trust & Architecture).',
          p_action_label, case when p_de_id is not null then 'this employee''s' else 'this workspace''s' end, p_category)
      else
        format('Needs approval: "%s" ($%s) exceeds the trust-dial limit of %s earned so far.',
          p_action_label, round(coalesce(p_amount_cents, 0) / 100.0),
          coalesce('$' || round(v_autonomy.max_amount_cents / 100.0)::text, 'no amount'))
    end);
end;
$$;
REVOKE ALL ON FUNCTION decide_action_execution(uuid, text, text, boolean, uuid, bigint, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION decide_action_execution(uuid, text, text, boolean, uuid, bigint, text) TO service_role;

-- ── 2. claim_de_work_items (from mig 156 + lifecycle guard) ─────────────────
CREATE OR REPLACE FUNCTION public.claim_de_work_items(
  p_limit  integer default 10,
  p_worker text default 'worker',
  p_tenant_id uuid default null
) RETURNS SETOF de_work_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
begin
  return query
  with due as (
    select w.id
    from de_work_items w
    join digital_employees de on de.id = w.de_id
    where w.status = 'queued'
      and w.scheduled_for <= now()
      and (p_tenant_id is null or w.tenant_id = p_tenant_id)
      -- WAVE-1 FIX: an unavailable employee's items stay queued — every other
      -- surface refuses paused/retired employees; the work queue now does too.
      and de.status = 'active'
      and de.lifecycle_status not in ('paused', 'retired', 'archived')
      and (w.depends_on is null
           or exists (select 1 from de_work_items d where d.id = w.depends_on and d.status = 'done'))
    order by w.scheduled_for asc
    limit greatest(1, least(100, p_limit))
    for update skip locked
  )
  update de_work_items w
     set status = 'running', locked_at = now(), locked_by = p_worker,
         attempts = w.attempts + 1, updated_at = now()
    from due
   where w.id = due.id
  returning w.*;
end;
$$;
REVOKE ALL ON FUNCTION public.claim_de_work_items(integer, text, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_de_work_items(integer, text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
