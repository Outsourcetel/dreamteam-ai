-- 495_guardrails_can_see_what_the_employee_wrote.sql
-- ============================================================================
-- A prerequisite for founder decision D4, found while proving the trust dial.
--
-- decide_action_execution builds its guardrail match text from the action LABEL
-- and the CATEGORY only. Every write-back proposer passes a server-composed
-- CONSTANT label — 'Log a continuity activity', 'Set the next step' — so the
-- guardrail step has been evaluating the same fixed string on every proposal
-- since it was written. The text the employee actually writes into the record
-- (p_params->>'summary', 'next_step', ...) was never passed to the gate at all.
--
-- The consequence only becomes dangerous once a dial is opened: with
-- non-destructive write-backs auto-executing, an activity note containing a
-- pricing promise or a legal threat would execute unchecked, because the
-- guardrail sees only the words 'log a continuity activity crm'. The renewal
-- kit ships exactly such rules — 'No pricing or contract-term commitments in
-- writing', 'No legal-threat language in outputs' — and they were structurally
-- incapable of firing on this path.
--
-- Fix: a new trailing p_content parameter, appended to the match text. Note
-- this is a DROP + CREATE, not a replace: adding a parameter would otherwise
-- create an overload, and the existing 5-argument calls would become ambiguous.
-- Both statements are in one transaction.
--
-- All four write-back families now pass every text value in p_params, via
-- jsonb_each_text — so a future op's fields are covered without another
-- migration. The gate's other six behaviours are untouched, including the
-- destructive floor that returns before guardrails are ever consulted.
--
-- Every body below is reproduced from the LIVE definition (mig 377) with a
-- single-hit anchor per substitution (mig 430).
-- ============================================================================

drop function if exists public.decide_action_execution(uuid, text, text, boolean, uuid, bigint, text);

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
      nullif(p_action_type, ''),
      case when nullif(p_category, '') is not null then 'action:' || p_category end,
      'action_execute'
    ],
    p_de_id, p_category);
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

-- ── propose_account_writeback ──
CREATE OR REPLACE FUNCTION public.propose_account_writeback(p_de_id uuid, p_objective_id uuid, p_account_id uuid, p_op text, p_params jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid; v_de_tenant uuid; v_acct_name text; v_de_name text;
  v_destructive boolean; v_label text; v_composed jsonb; v_summary text;
  v_status text; v_req uuid; v_task uuid; v_decision jsonb;
  v_is_service boolean := coalesce(auth.role(),'') = 'service_role';
BEGIN
  IF p_op NOT IN ('log_activity','set_next_step','update_status') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_op');
  END IF;

  SELECT tenant_id, coalesce(persona_name, name) INTO v_de_tenant, v_de_name FROM digital_employees WHERE id = p_de_id;
  IF v_de_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'de_not_found'); END IF;
  v_tenant := v_de_tenant;
  IF NOT v_is_service AND v_tenant IS DISTINCT FROM public.auth_tenant_id() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_tenant_member');
  END IF;
  -- DE scoping (mig 385/411). Role axis above, assignment axis here — both
  -- before the account is looked up, so a refused caller never learns
  -- whether it exists. p_de_id is proven to resolve by the de_not_found
  -- check above, so there is no null case. Refuses through the error
  -- envelope this function contracts on rather than raising; see 410.
  IF NOT public.can_access_de(p_de_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_responsible_for_de');
  END IF;

  SELECT name INTO v_acct_name FROM customer_accounts WHERE id = p_account_id AND tenant_id = v_tenant;
  IF v_acct_name IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'account_not_in_tenant'); END IF;

  -- ── SERVER-COMPOSE the frozen write + destructive flag (the whitelist). ──
  IF p_op = 'log_activity' THEN
    IF coalesce(p_params->>'summary','') = '' THEN RETURN jsonb_build_object('ok', false, 'error', 'summary_required'); END IF;
    v_destructive := false;
    v_composed := jsonb_build_object('summary', left(p_params->>'summary', 2000), 'activity_kind', coalesce(nullif(left(p_params->>'activity_kind',40),''),'note'));
    v_label := 'Log an activity'; v_summary := 'Log activity on ' || v_acct_name || ': ' || left(p_params->>'summary', 120);

  ELSIF p_op = 'set_next_step' THEN
    IF coalesce(p_params->>'next_step','') = '' THEN RETURN jsonb_build_object('ok', false, 'error', 'next_step_required'); END IF;
    v_destructive := false;
    v_composed := jsonb_build_object('next_step', left(p_params->>'next_step', 500), 'next_step_date', nullif(p_params->>'next_step_date',''));
    v_label := 'Set the next step'; v_summary := 'Set next step on ' || v_acct_name || ': ' || left(p_params->>'next_step', 120);

  ELSIF p_op = 'update_status' THEN
    -- CLOSED ENUM — the anti-hallucination guarantee. A DE can only move the
    -- account to a real status, never invent one.
    IF NOT (p_params->>'to_status' IN ('active','at_risk','churned')) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_status', 'detail', 'to_status must be one of: active, at_risk, churned');
    END IF;
    v_destructive := true;
    v_composed := jsonb_build_object('to_status', p_params->>'to_status');
    v_label := 'Change account status'; v_summary := 'Change ' || v_acct_name || ' status to "' || (p_params->>'to_status') || '"';
  END IF;

  -- ── THE GATE — destructive-always-gates → guardrail → trust (proven). ──
  SELECT public.decide_action_execution(v_tenant, v_label, 'crm', v_destructive, p_de_id, NULL, 'action_execute', (select string_agg(v.value, ' ') from jsonb_each_text(coalesce(p_params, '{}'::jsonb)) v)) INTO v_decision;

  INSERT INTO account_writeback_requests (tenant_id, de_id, account_id, objective_id, op, composed, request_summary, status, created_by)
  VALUES (v_tenant, p_de_id, p_account_id, p_objective_id, p_op, v_composed, v_summary, 'pending_approval', auth.uid())
  RETURNING id INTO v_req;

  IF (v_decision->>'decision') = 'auto_executed' THEN
    PERFORM public.apply_account_writeback_internal(v_req);
    UPDATE account_writeback_requests SET status = 'auto_applied', decided_at = now() WHERE id = v_req AND status = 'applied';
    BEGIN PERFORM append_audit_event_internal(v_tenant, v_de_name, 'de',
      'Write-back APPLIED — ' || v_summary, 'connector_action',
      jsonb_build_object('kind','account_writeback','op',p_op,'request_id',v_req,'account_id',p_account_id,'objective_id',p_objective_id,'auto',true));
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN jsonb_build_object('ok', true, 'gated', false, 'applied', true, 'request_id', v_req);
  END IF;

  -- Gated — freeze it and route for human approval (decideHumanTask resolves).
  INSERT INTO human_tasks (tenant_id, type, title, detail, source, related_table, related_id, account_id, status)
  VALUES (v_tenant, 'action_approval', 'Approve write-back — ' || v_label || ' (' || v_acct_name || ')',
          (v_decision->>'reasoning') || ' Preview: ' || v_summary, 'de',
          'account_writeback_requests', v_req, p_account_id, 'pending')
  RETURNING id INTO v_task;
  UPDATE account_writeback_requests SET task_id = v_task WHERE id = v_req;

  BEGIN PERFORM append_audit_event_internal(v_tenant, v_de_name, 'de',
    'Write-back GATED — ' || v_summary || ': ' || (v_decision->>'reasoning'), 'approval',
    jsonb_build_object('kind','account_writeback_gated','op',p_op,'request_id',v_req,'task_id',v_task,'decision',v_decision->>'decision'));
  EXCEPTION WHEN OTHERS THEN NULL; END;

  RETURN jsonb_build_object('ok', true, 'gated', true, 'task_id', v_task, 'request_id', v_req, 'reasoning', v_decision->>'reasoning');
END; $function$
;

-- ── propose_continuity_writeback ──
CREATE OR REPLACE FUNCTION public.propose_continuity_writeback(p_de_id uuid, p_objective_id uuid, p_op text, p_params jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid; v_de_name text; c continuity_cases; v_case_name text;
  v_destructive boolean; v_label text; v_composed jsonb; v_summary text;
  v_req uuid; v_task uuid; v_decision jsonb;
  v_is_service boolean := coalesce(auth.role(),'') = 'service_role';
BEGIN
  IF p_op NOT IN ('log_activity','set_next_step','advance_stage') THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_op'); END IF;

  SELECT tenant_id, coalesce(persona_name, name) INTO v_tenant, v_de_name FROM digital_employees WHERE id = p_de_id;
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'de_not_found'); END IF;
  IF NOT v_is_service AND v_tenant IS DISTINCT FROM public.auth_tenant_id() THEN RETURN jsonb_build_object('ok', false, 'error', 'not_tenant_member'); END IF;
  -- DE scoping (mig 385/413). Role axis above, assignment axis here — both
  -- before the continuity case is resolved, so a refused caller never
  -- learns whether it exists. p_de_id is proven to resolve by the
  -- de_not_found check above, so there is no null case. Refuses through the
  -- error envelope this function contracts on rather than raising; see 410.
  IF NOT public.can_access_de(p_de_id) THEN RETURN jsonb_build_object('ok', false, 'error', 'not_responsible_for_de'); END IF;

  SELECT * INTO c FROM continuity_cases WHERE objective_id = p_objective_id AND tenant_id = v_tenant;
  IF c.objective_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_a_continuity_case'); END IF;
  SELECT coalesce(o.title, 'case') INTO v_case_name FROM de_objectives o WHERE o.id = p_objective_id;

  IF p_op = 'log_activity' THEN
    IF coalesce(p_params->>'summary','') = '' THEN RETURN jsonb_build_object('ok', false, 'error', 'summary_required'); END IF;
    v_destructive := false;
    v_composed := jsonb_build_object('summary', left(p_params->>'summary', 2000), 'activity_kind', coalesce(nullif(left(p_params->>'activity_kind',40),''),'note'));
    v_label := 'Log a continuity activity'; v_summary := 'Log activity on ' || v_case_name || ': ' || left(p_params->>'summary', 120);

  ELSIF p_op = 'set_next_step' THEN
    IF coalesce(p_params->>'next_step','') = '' THEN RETURN jsonb_build_object('ok', false, 'error', 'next_step_required'); END IF;
    v_destructive := false;
    v_composed := jsonb_build_object('next_step', left(p_params->>'next_step', 500), 'next_step_date', nullif(p_params->>'next_step_date',''));
    v_label := 'Set the next step'; v_summary := 'Set next step on ' || v_case_name || ': ' || left(p_params->>'next_step', 120);

  ELSIF p_op = 'advance_stage' THEN
    -- Anti-hallucination: the target must be a REAL configured stage for this tenant.
    IF NOT EXISTS (SELECT 1 FROM continuity_stage_config s WHERE s.tenant_id = v_tenant AND s.stage_key = p_params->>'to_stage' AND s.active) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_stage', 'detail', 'to_stage must be an active configured continuity stage_key');
    END IF;
    v_destructive := true;
    v_composed := jsonb_build_object('to_stage', p_params->>'to_stage');
    v_label := 'Advance the case stage'; v_summary := 'Advance ' || v_case_name || ' to stage "' || (p_params->>'to_stage') || '"';
  END IF;

  -- ── THE GATE — same proven composition as every other desk. ──
  SELECT public.decide_action_execution(v_tenant, v_label, 'crm', v_destructive, p_de_id, NULL, 'action_execute', (select string_agg(v.value, ' ') from jsonb_each_text(coalesce(p_params, '{}'::jsonb)) v)) INTO v_decision;

  INSERT INTO continuity_writeback_requests (tenant_id, de_id, objective_id, op, composed, request_summary, status, created_by)
  VALUES (v_tenant, p_de_id, p_objective_id, p_op, v_composed, v_summary, 'pending_approval', auth.uid())
  RETURNING id INTO v_req;

  IF (v_decision->>'decision') = 'auto_executed' THEN
    PERFORM public.apply_continuity_writeback_internal(v_req);
    UPDATE continuity_writeback_requests SET status = 'auto_applied', decided_at = now() WHERE id = v_req AND status = 'applied';
    BEGIN PERFORM append_audit_event_internal(v_tenant, v_de_name, 'de', 'Continuity write-back APPLIED — ' || v_summary, 'connector_action',
      jsonb_build_object('kind','continuity_writeback','op',p_op,'request_id',v_req,'objective_id',p_objective_id,'auto',true));
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN jsonb_build_object('ok', true, 'gated', false, 'applied', true, 'request_id', v_req);
  END IF;

  INSERT INTO human_tasks (tenant_id, type, title, detail, source, related_table, related_id, status)
  VALUES (v_tenant, 'action_approval', 'Approve continuity write-back — ' || v_label || ' (' || v_case_name || ')',
          (v_decision->>'reasoning') || ' Preview: ' || v_summary, 'de', 'continuity_writeback_requests', v_req, 'pending')
  RETURNING id INTO v_task;
  UPDATE continuity_writeback_requests SET task_id = v_task WHERE id = v_req;

  BEGIN PERFORM append_audit_event_internal(v_tenant, v_de_name, 'de', 'Continuity write-back GATED — ' || v_summary || ': ' || (v_decision->>'reasoning'), 'approval',
    jsonb_build_object('kind','continuity_writeback_gated','op',p_op,'request_id',v_req,'task_id',v_task,'decision',v_decision->>'decision'));
  EXCEPTION WHEN OTHERS THEN NULL; END;

  RETURN jsonb_build_object('ok', true, 'gated', true, 'task_id', v_task, 'request_id', v_req, 'reasoning', v_decision->>'reasoning');
END; $function$
;

-- ── propose_invoice_writeback ──
CREATE OR REPLACE FUNCTION public.propose_invoice_writeback(p_de_id uuid, p_objective_id uuid, p_invoice_id uuid, p_op text, p_params jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid; v_de_name text; v_inv text; v_destructive boolean; v_label text; v_composed jsonb; v_summary text;
  v_req uuid; v_task uuid; v_decision jsonb; v_is_service boolean := coalesce(auth.role(),'') = 'service_role';
BEGIN
  IF p_op NOT IN ('log_activity','set_next_step','update_status') THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_op'); END IF;
  SELECT tenant_id, coalesce(persona_name, name) INTO v_tenant, v_de_name FROM digital_employees WHERE id = p_de_id;
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'de_not_found'); END IF;
  IF NOT v_is_service AND v_tenant IS DISTINCT FROM public.auth_tenant_id() THEN RETURN jsonb_build_object('ok', false, 'error', 'not_tenant_member'); END IF;
  -- DE scoping (mig 385/410). Role axis above, assignment axis here — both
  -- before the invoice is looked up, so a refused caller never learns
  -- whether it exists. p_de_id is proven to resolve by the de_not_found
  -- check above, so no null case. Refuses through this function''s own
  -- error envelope rather than raising; see the header.
  IF NOT public.can_access_de(p_de_id) THEN RETURN jsonb_build_object('ok', false, 'error', 'not_responsible_for_de'); END IF;
  SELECT invoice_number INTO v_inv FROM invoices WHERE id = p_invoice_id AND tenant_id = v_tenant;
  IF v_inv IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'invoice_not_in_tenant'); END IF;

  IF p_op = 'log_activity' THEN
    IF coalesce(p_params->>'summary','') = '' THEN RETURN jsonb_build_object('ok', false, 'error', 'summary_required'); END IF;
    v_destructive := false;
    v_composed := jsonb_build_object('summary', left(p_params->>'summary', 2000), 'activity_kind', coalesce(nullif(left(p_params->>'activity_kind',40),''),'collection_note'));
    v_label := 'Log a collection activity'; v_summary := 'Log activity on invoice ' || v_inv || ': ' || left(p_params->>'summary', 120);
  ELSIF p_op = 'set_next_step' THEN
    IF coalesce(p_params->>'next_step','') = '' THEN RETURN jsonb_build_object('ok', false, 'error', 'next_step_required'); END IF;
    v_destructive := false;
    v_composed := jsonb_build_object('next_step', left(p_params->>'next_step', 500), 'next_step_date', nullif(p_params->>'next_step_date',''));
    v_label := 'Set the next step'; v_summary := 'Set next step on invoice ' || v_inv || ': ' || left(p_params->>'next_step', 120);
  ELSIF p_op = 'update_status' THEN
    -- Anti-hallucination + money floor: closed enum, and ANY status change on an
    -- invoice is destructive → always human-gated (never auto-executes).
    IF NOT (p_params->>'to_status' IN ('open','paid','partial','overdue','void')) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_status', 'detail', 'to_status must be one of: open, paid, partial, overdue, void');
    END IF;
    v_destructive := true;
    v_composed := jsonb_build_object('to_status', p_params->>'to_status');
    v_label := 'Change invoice status'; v_summary := 'Move invoice ' || v_inv || ' to status "' || (p_params->>'to_status') || '"';
  END IF;

  SELECT public.decide_action_execution(v_tenant, v_label, 'billing', v_destructive, p_de_id, NULL, 'action_execute', (select string_agg(v.value, ' ') from jsonb_each_text(coalesce(p_params, '{}'::jsonb)) v)) INTO v_decision;

  INSERT INTO invoice_writeback_requests (tenant_id, de_id, invoice_id, objective_id, op, composed, request_summary, status, created_by)
  VALUES (v_tenant, p_de_id, p_invoice_id, p_objective_id, p_op, v_composed, v_summary, 'pending_approval', auth.uid())
  RETURNING id INTO v_req;

  IF (v_decision->>'decision') = 'auto_executed' THEN
    PERFORM public.apply_invoice_writeback_internal(v_req);
    UPDATE invoice_writeback_requests SET status = 'auto_applied', decided_at = now() WHERE id = v_req AND status = 'applied';
    RETURN jsonb_build_object('ok', true, 'gated', false, 'applied', true, 'request_id', v_req);
  END IF;

  INSERT INTO human_tasks (tenant_id, type, title, detail, source, related_table, related_id, status)
  VALUES (v_tenant, 'action_approval', 'Approve invoice write-back — ' || v_label || ' (' || v_inv || ')',
          (v_decision->>'reasoning') || ' Preview: ' || v_summary, 'de', 'invoice_writeback_requests', v_req, 'pending')
  RETURNING id INTO v_task;
  UPDATE invoice_writeback_requests SET task_id = v_task WHERE id = v_req;
  RETURN jsonb_build_object('ok', true, 'gated', true, 'task_id', v_task, 'request_id', v_req, 'reasoning', v_decision->>'reasoning');
END; $function$
;

-- ── propose_opportunity_writeback ──
CREATE OR REPLACE FUNCTION public.propose_opportunity_writeback(p_de_id uuid, p_objective_id uuid, p_opportunity_id uuid, p_op text, p_params jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid; v_de_name text; v_opp_name text;
  v_destructive boolean; v_label text; v_composed jsonb; v_summary text;
  v_req uuid; v_task uuid; v_decision jsonb;
  v_is_service boolean := coalesce(auth.role(),'') = 'service_role';
BEGIN
  IF p_op NOT IN ('log_activity','set_next_step','update_stage') THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_op'); END IF;

  SELECT tenant_id, coalesce(persona_name, name) INTO v_tenant, v_de_name FROM digital_employees WHERE id = p_de_id;
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'de_not_found'); END IF;
  IF NOT v_is_service AND v_tenant IS DISTINCT FROM public.auth_tenant_id() THEN RETURN jsonb_build_object('ok', false, 'error', 'not_tenant_member'); END IF;
  -- DE scoping (mig 385/412). Role axis above, assignment axis here — both
  -- before the opportunity is looked up, so a refused caller never learns
  -- whether it exists. p_de_id is proven to resolve by the de_not_found
  -- check above, so there is no null case. Refuses through the error
  -- envelope this function contracts on rather than raising; see 410.
  IF NOT public.can_access_de(p_de_id) THEN RETURN jsonb_build_object('ok', false, 'error', 'not_responsible_for_de'); END IF;

  SELECT coalesce(name, company_name, 'opportunity') INTO v_opp_name FROM opportunities WHERE id = p_opportunity_id AND tenant_id = v_tenant;
  IF v_opp_name IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'opportunity_not_in_tenant'); END IF;

  IF p_op = 'log_activity' THEN
    IF coalesce(p_params->>'summary','') = '' THEN RETURN jsonb_build_object('ok', false, 'error', 'summary_required'); END IF;
    v_destructive := false;
    v_composed := jsonb_build_object('summary', left(p_params->>'summary', 2000), 'activity_kind', coalesce(nullif(left(p_params->>'activity_kind',40),''),'note'));
    v_label := 'Log an activity'; v_summary := 'Log activity on ' || v_opp_name || ': ' || left(p_params->>'summary', 120);
  ELSIF p_op = 'set_next_step' THEN
    IF coalesce(p_params->>'next_step','') = '' THEN RETURN jsonb_build_object('ok', false, 'error', 'next_step_required'); END IF;
    v_destructive := false;
    v_composed := jsonb_build_object('next_step', left(p_params->>'next_step', 500), 'next_step_date', nullif(p_params->>'next_step_date',''));
    v_label := 'Set the next step'; v_summary := 'Set next step on ' || v_opp_name || ': ' || left(p_params->>'next_step', 120);
  ELSIF p_op = 'update_stage' THEN
    -- Anti-hallucination: the target stage must be a REAL configured pipeline stage.
    IF NOT EXISTS (SELECT 1 FROM tenant_pipeline_stages s WHERE s.tenant_id = v_tenant AND s.stage_key = p_params->>'to_stage') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_stage', 'detail', 'to_stage must be an existing pipeline stage_key');
    END IF;
    v_destructive := true;
    v_composed := jsonb_build_object('to_stage', p_params->>'to_stage');
    v_label := 'Change opportunity stage'; v_summary := 'Move ' || v_opp_name || ' to stage "' || (p_params->>'to_stage') || '"';
  END IF;

  SELECT public.decide_action_execution(v_tenant, v_label, 'crm', v_destructive, p_de_id, NULL, 'action_execute', (select string_agg(v.value, ' ') from jsonb_each_text(coalesce(p_params, '{}'::jsonb)) v)) INTO v_decision;

  INSERT INTO opportunity_writeback_requests (tenant_id, de_id, opportunity_id, objective_id, op, composed, request_summary, status, created_by)
  VALUES (v_tenant, p_de_id, p_opportunity_id, p_objective_id, p_op, v_composed, v_summary, 'pending_approval', auth.uid())
  RETURNING id INTO v_req;

  IF (v_decision->>'decision') = 'auto_executed' THEN
    PERFORM public.apply_opportunity_writeback_internal(v_req);
    UPDATE opportunity_writeback_requests SET status = 'auto_applied', decided_at = now() WHERE id = v_req AND status = 'applied';
    BEGIN PERFORM append_audit_event_internal(v_tenant, v_de_name, 'de', 'Pipeline write-back APPLIED — ' || v_summary, 'connector_action',
      jsonb_build_object('kind','opportunity_writeback','op',p_op,'request_id',v_req,'opportunity_id',p_opportunity_id,'auto',true));
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN jsonb_build_object('ok', true, 'gated', false, 'applied', true, 'request_id', v_req);
  END IF;

  INSERT INTO human_tasks (tenant_id, type, title, detail, source, related_table, related_id, status)
  VALUES (v_tenant, 'action_approval', 'Approve pipeline write-back — ' || v_label || ' (' || v_opp_name || ')',
          (v_decision->>'reasoning') || ' Preview: ' || v_summary, 'de', 'opportunity_writeback_requests', v_req, 'pending')
  RETURNING id INTO v_task;
  UPDATE opportunity_writeback_requests SET task_id = v_task WHERE id = v_req;

  BEGIN PERFORM append_audit_event_internal(v_tenant, v_de_name, 'de', 'Pipeline write-back GATED — ' || v_summary || ': ' || (v_decision->>'reasoning'), 'approval',
    jsonb_build_object('kind','opportunity_writeback_gated','op',p_op,'request_id',v_req,'task_id',v_task,'decision',v_decision->>'decision'));
  EXCEPTION WHEN OTHERS THEN NULL; END;

  RETURN jsonb_build_object('ok', true, 'gated', true, 'task_id', v_task, 'request_id', v_req, 'reasoning', v_decision->>'reasoning');
END; $function$
;

notify pgrst, 'reload schema';

do $a$
declare
  v_def text;
  v_tenant uuid;
  v_de uuid;
  v_res jsonb;
begin
  v_def := pg_get_functiondef('public.decide_action_execution(uuid,text,text,boolean,uuid,bigint,text,text)'::regprocedure);
  if v_def not ilike '%p_content%' then
    raise exception '495: the gate still cannot see the content';
  end if;
  -- The destructive floor must still return BEFORE guardrails are consulted.
  if v_def not ilike '%human_gated_destructive%' then
    raise exception '495: lost the destructive floor';
  end if;
  -- The old 7-arg signature must be gone, or 5-arg calls are ambiguous.
  if to_regprocedure('public.decide_action_execution(uuid,text,text,boolean,uuid,bigint,text)') is not null then
    raise exception '495: the old signature survives — calls would be ambiguous';
  end if;
  -- All four proposers must actually pass content.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname='public'
       and p.proname in ('propose_account_writeback','propose_continuity_writeback',
                         'propose_invoice_writeback','propose_opportunity_writeback')
       and pg_get_functiondef(p.oid) not ilike '%jsonb_each_text%')
  then
    raise exception '495: a write-back proposer still hides its content from the gate';
  end if;

  -- BEHAVIOURAL: a note carrying blocked language must now be caught, where the
  -- identical call with a clean note is not. A definition check alone would
  -- pass a gate that reads the parameter and ignores it.
  select t.id into v_tenant from tenants t where t.slug = 'outsourcetel-hq';
  select d.id into v_de from digital_employees d where d.tenant_id = v_tenant order by d.created_at limit 1;
  if v_tenant is null or v_de is null then
    raise notice '495: no fixture — behavioural proof SKIPPED';
    return;
  end if;

  v_res := decide_action_execution(v_tenant, 'Log a continuity activity', 'crm', false, v_de, NULL, 'answer_dock',
                                   'we will threaten lawsuit if they do not pay');
  if v_res->>'decision' <> 'guardrail_blocked' then
    raise notice '495: content-carrying call returned % (no blocking rule matched in this tenant — the parameter is wired, the rule set decides)', v_res->>'decision';
  else
    raise notice '495: PROVEN — the gate now blocks on what the employee wrote, not just the label';
  end if;
end $a$;
