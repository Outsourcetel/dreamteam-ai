-- 328_guardrail_pattern_grouping_fix.sql
-- ============================================================================
-- The guardrail matcher was enforcing broader rules than anyone wrote.
--
-- Every blocking guardrail -- in four edge functions AND here in
-- decide_action_execution, the gate that decides whether a Digital Employee may
-- execute a real action in a real system -- matched patterns like this:
--
--     foreach v_frag in array string_to_array(v_rule.pattern, '|') loop
--       v_hit := v_text ~ v_frag;
--
-- Splitting on '|' and THEN matching each fragment as a regex is
-- self-defeating: the regex engine already understands '|'. Splitting first
-- destroys any grouping the author wrote. The live PII rule
--
--     what is your (pin|cvv|password|ssn|social security)|tell me your (...)|...
--
-- -- precise, fires only when the employee ASKS for a secret -- was shredded
-- into the bare fragments 'cvv', 'password', 'ssn', so it fired on ANY mention.
--
-- MEASURED, not assumed. Replayed all 17 historical guardrail blocks whose
-- draft text survives in human_tasks. 5 of the 14 that still reproduce under
-- today's patterns were caused purely by this shredding -- including a credit
-- union employee telling a customer "do NOT share your SSN with anyone who
-- contacts you", blocked five separate times by the rule that exists to stop it
-- ASKING for an SSN. The rule punished the exact behaviour it was written to
-- produce.
--
-- This is a governance-integrity defect, not merely a quality one: the rule
-- ENFORCED was broader than the rule DISPLAYED in the UI and agreed to by the
-- customer. No one ever wrote "block any answer containing the letters ssn".
--
-- BLAST RADIUS, audited across all 85 active blocking patterns on the platform:
-- exactly ONE uses grouping, and NONE use [ ] { } * + ? or backslash escapes.
-- For the other 84, 'a|b|c' means the same thing whether you split it or
-- compile it whole -- so this is a no-op for them and restores authored intent
-- on the one. Un-compilable patterns still fall back to LITERAL fragment
-- matching (never regex), so a malformed pattern cannot silently stop blocking.
--
-- Reproduced verbatim from the live definition (pg_get_functiondef); the ONLY
-- change is the matching block. GLOBAL, no flag: a rule should mean what it says.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.decide_action_execution(p_tenant_id uuid, p_action_label text, p_category text, p_destructive boolean, p_de_id uuid DEFAULT NULL::uuid, p_amount_cents bigint DEFAULT NULL::bigint, p_action_type text DEFAULT 'action_execute'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
    -- mig 328: match the WHOLE pattern as ONE case-insensitive regex. The old
    -- loop split on '|' first and then matched each fragment, which shredded any
    -- grouping the rule author wrote -- turning
    --   what is your (pin|cvv|password|ssn|social security)|tell me your (...)
    -- into the bare fragments 'cvv', 'password', 'ssn'. Verified against 17 real
    -- historical blocks: that shredding, not the rule, caused the false positives.
    -- POSIX ~* understands | and () exactly as the rule author intended.
    begin
      v_hit := v_text ~* v_rule.pattern;
    exception when others then
      -- Not a valid regex -> the author meant literal phrases split by '|'.
      v_hit := false;
      foreach v_frag in array string_to_array(v_rule.pattern, '|') loop
        v_frag := trim(both from lower(v_frag));
        if v_frag <> '' and position(v_frag in v_text) > 0 then v_hit := true; exit; end if;
      end loop;
    end;
      if v_hit then
        return jsonb_build_object('decision', 'guardrail_blocked',
          'guardrail_rule_id', v_rule.id, 'guardrail_rule', v_rule.rule, 'trust_level', null,
          'reasoning', format('Blocked: guardrail rule "%s" matched this action — routed to a human regardless of trust. Guardrails always win over the trust dial.', v_rule.rule));
      end if;
    end loop;
  end loop;

  -- 1.5) Amount guardrail (require_approval_over_cents).
  if p_amount_cents is not null then
    select threshold into v_threshold
    from guardrail_rules_for_de(p_tenant_id, p_de_id, array['require_approval_over_cents'])
    where active
    order by (case scope when 'employee' then 0 when 'playbook' then 1 when 'department' then 2 when 'workspace' then 3 else 4 end), updated_at desc
    limit 1;
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
$function$;

NOTIFY pgrst, 'reload schema';
