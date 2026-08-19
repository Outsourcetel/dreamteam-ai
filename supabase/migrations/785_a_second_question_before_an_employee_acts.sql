-- WHY: spec §3.6 — two questions, both required, now on the employee path.
-- Everything that answered "has this employee EARNED this?" is UNCHANGED:
-- guardrails, the destructive floor, the amount threshold, the spend caps and
-- resolve_de_autonomy_chain. This adds the risk question immediately before
-- the auto_executed return — the only return that lets an action through
-- without a human.
--
-- Body generated from the live pg_get_functiondef with two anchored edits; the
-- generator REFUSES if either anchor is missing, so a concurrent edit cannot
-- be silently overwritten.

begin;
CREATE OR REPLACE FUNCTION public.decide_action_execution(p_tenant_id uuid, p_action_label text, p_category text, p_destructive boolean, p_de_id uuid DEFAULT NULL::uuid, p_amount_cents bigint DEFAULT NULL::bigint, p_action_type text DEFAULT 'action_execute'::text, p_content text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_rule      record;
  -- mig 495: the CONTENT is scanned too. Until now this text was the
  -- server-composed LABEL plus the category — both fixed constants per op —
  -- so guardrails evaluated the same string on every proposal and could never
  -- see what the employee actually wrote. A rule like "no pricing commitments
  -- in writing" was structurally incapable of firing on a write-back.
  v_text      text := lower(coalesce(p_action_label, '') || ' ' || coalesce(p_category, '') || ' ' || coalesce(p_content, ''));
  v_autonomy  record;
  v_risk jsonb;
  v_frag      text;
  v_hit       boolean;
  v_threshold bigint;
  v_period    text;
  v_spent     bigint;
begin
  -- 0) DESTRUCTIVE ALWAYS GATES.
  -- ⚠ THE STOP BUTTON, CHECKED BEFORE ANYTHING ELSE (mig 623). A pause has
  -- to stop everything, including what would otherwise have been allowed, so
  -- it sits above the destructive floor rather than beside the trust dial.
  if public.workforce_autonomy_paused(p_tenant_id) then
    return jsonb_build_object('decision', 'human_gated_paused',
      'guardrail_rule_id', null, 'guardrail_rule', null, 'trust_level', null,
      'reasoning', format('Autonomy is stopped for this whole workspace, so "%s" goes to a person. Nothing runs on its own until someone restarts the workforce.', p_action_label));
  end if;

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
    -- code split on '|' FIRST and then matched each fragment as its own regex,
    -- which shredded any grouping the rule author wrote -- turning
    --   what is your (pin|cvv|password|ssn|social security)|tell me your (...)
    -- into the bare fragments 'cvv', 'password', 'ssn', so the rule fired on ANY
    -- mention of them. POSIX ~* understands | and () as the author intended.
    begin
      v_hit := v_text ~* v_rule.pattern;
    exception when others then
      -- Not a valid regex -> the author meant literal phrases split by '|'.
      -- Literal only, never regex: a fragment that failed to compile as part of
      -- a whole is not meaningful as a regex on its own.
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

  -- 2) Trust dial (per-employee cascade), resolved through the fallback
  --    chain: the registered action's own key first, then its whole
  --    category, then the generic gate. Every generic-gate seed sits at
  --    enabled=false, so nothing opens by itself — this makes per-action
  --    trust representable, and that is all it does. The destructive
  --    floor, guardrails, the amount threshold and spend caps all
  --    returned above before this line is ever reached.
  select * into v_autonomy from resolve_de_autonomy_chain(
    p_tenant_id,
    array[
      -- ⚠ SPECIFIC FIRST (mig 618). Reversed, the generic key matched
      -- whenever any row existed and 'action:<category>' was never reached,
      -- which is why a per-category rule had never once been consulted.
      case when nullif(p_category, '') is not null then 'action:' || p_category end,
      nullif(p_action_type, ''),
      'action_execute'
    ],
    p_de_id, p_category);
  -- ── THE SECOND QUESTION (spec §3.6), on the employee path ────────────
  -- Everything above answered "has this employee EARNED this?" — guardrails,
  -- the destructive floor, the amount threshold, the spend caps and the
  -- earned-trust chain. All of it is unchanged. This asks the other question:
  -- "does this particular action need more scrutiny?"
  --
  -- It sits immediately before the auto_executed return because that is THE
  -- ONLY return in this function that lets an action through without a human.
  -- Every other path already ends at a person.
  --
  -- ⚠ THE MAPPING IS CONSTRAINED, NOT CHOSEN. action_executions.decision
  -- carries a CHECK of ten values, so a new one would RAISE on insert inside
  -- record_action_execution. deny therefore becomes 'access_denied' — in the
  -- CHECK, semantically exact, and never once used live, so it cannot be
  -- confused with an existing meaning. 'guardrail_blocked' was rejected: five
  -- functions branch on it, and an authority denial is not a guardrail hit.
  -- Callers are safe either way — eight functions gate on = 'auto_executed',
  -- so anything else means "do not execute".
  --
  -- With authority_rules EMPTY this is exactly a no-op.
  v_risk := evaluate_authority(
    p_tenant_id,
    case when p_de_id is null then 'all' else 'de' end,
    p_de_id,
    p_category,
    case when p_amount_cents is null then '{}'::jsonb
         else jsonb_build_object('amount_cents', p_amount_cents) end);

  if v_risk->>'outcome' = 'deny' then
    return jsonb_build_object('decision', 'access_denied',
      'guardrail_rule_id', null, 'guardrail_rule', null, 'trust_level', null,
      'reasoning', format('Refused: a workspace authority rule denies this. %s',
        coalesce(v_risk->'reasons'->0->>'why', 'No reason was recorded.')));
  end if;

  if v_risk->>'outcome' in ('require_human','require_second_approver') then
    return jsonb_build_object('decision', 'human_gated_trust',
      'guardrail_rule_id', null, 'guardrail_rule', null, 'trust_level', null,
      'reasoning', format('Needs approval: a workspace authority rule asks for a person here. %s',
        coalesce(v_risk->'reasons'->0->>'why', 'No reason was recorded.')));
  end if;

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
$function$
;

commit;
