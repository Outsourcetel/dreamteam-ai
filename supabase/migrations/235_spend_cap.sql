-- 235_spend_cap.sql
-- ============================================================================
-- Money-safety #1 — per-period SPEND CAPS (Google Ads highest financial risk).
--
-- Google Ads already ships strong money guardrails (no budget increase / new
-- campaign / new geo without approval; $1k per-action approval floor — mig 230).
-- What it lacked is a PERIOD cap: "no more than $X spend today / this month."
-- This adds that as a real, config-driven guardrail enforced in the SAME action
-- gate every DE already uses:
--
--   • de_spend_ledger — per-DE, per-period spend accumulation.
--   • record_de_spend() — the spend executor calls this when spend actually
--     happens; idempotent per period.
--   • spend_cap_daily_cents / spend_cap_monthly_cents — new guardrail rule_types
--     (a threshold in guardrail_rules, employee- or workspace-scoped).
--   • decide_action_execution — an ADDITIVE, GUARDED step: it runs ONLY for a DE
--     that actually has a spend_cap rule, sums that period's ledger + this
--     action's amount, and gates to a human if it would breach the cap. Every
--     pre-existing branch is reproduced byte-for-byte; a DE with no cap is
--     completely unaffected, so the blast radius is exactly the DEs that opt in.
--
-- Honest scope: the cap + the enforcement mechanism are real now (they gate any
-- spend action routed through the gate). The LEDGER is populated by
-- record_de_spend(), which the real Google Ads spend executor calls once the Ads
-- connector + credentials exist — until then a hired Google Ads DE still can't
-- actually spend, and the per-action $1k floor + blocked-phrase rails already
-- apply. GLOBAL.
-- ============================================================================

-- 1. The spend ledger ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS de_spend_ledger (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  de_id       uuid NOT NULL REFERENCES digital_employees(id) ON DELETE CASCADE,
  period_kind text NOT NULL CHECK (period_kind IN ('day','month')),
  period_key  text NOT NULL,          -- 'YYYY-MM-DD' (day) or 'YYYY-MM' (month)
  cents       bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, de_id, period_kind, period_key)
);
ALTER TABLE de_spend_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS de_spend_ledger_tenant_read ON de_spend_ledger;
CREATE POLICY de_spend_ledger_tenant_read ON de_spend_ledger
  FOR SELECT USING (tenant_id = public.auth_tenant_id());
-- No tenant write policy: only the spend executor (service) records spend.

-- 2. record_de_spend — called by the spend executor when spend executes --------
CREATE OR REPLACE FUNCTION public.record_de_spend(p_tenant_id uuid, p_de_id uuid, p_cents bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF coalesce(p_cents, 0) <= 0 THEN RETURN; END IF;
  INSERT INTO de_spend_ledger (tenant_id, de_id, period_kind, period_key, cents)
    VALUES (p_tenant_id, p_de_id, 'day', to_char(current_date, 'YYYY-MM-DD'), p_cents)
    ON CONFLICT (tenant_id, de_id, period_kind, period_key)
      DO UPDATE SET cents = de_spend_ledger.cents + excluded.cents, updated_at = now();
  INSERT INTO de_spend_ledger (tenant_id, de_id, period_kind, period_key, cents)
    VALUES (p_tenant_id, p_de_id, 'month', to_char(current_date, 'YYYY-MM'), p_cents)
    ON CONFLICT (tenant_id, de_id, period_kind, period_key)
      DO UPDATE SET cents = de_spend_ledger.cents + excluded.cents, updated_at = now();
END; $$;
REVOKE ALL ON FUNCTION public.record_de_spend(uuid,uuid,bigint) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.record_de_spend(uuid,uuid,bigint) TO service_role;

-- 3. decide_action_execution — reproduce faithfully + add the guarded cap step -
--    (Every pre-existing branch is byte-for-byte the mig-125 logic; only the new
--    "1.6) Spend caps" block is added, and it no-ops for DEs without a cap rule.)
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
  for v_rule in
    select id, rule, pattern from guardrail_rules
    where tenant_id = p_tenant_id and active and severity = 'blocking'
      and rule_type in ('blocked_phrase', 'blocked_topic')
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
revoke all on function decide_action_execution(uuid, text, text, boolean, uuid, bigint, text) from public, anon, authenticated;
grant execute on function decide_action_execution(uuid, text, text, boolean, uuid, bigint, text) to service_role;

-- 3b. Widen the guardrail rule_type vocabulary (must stay a SUPERSET) ---------
--     Reproduces the current list (mig 157) + the two new spend-cap types.
ALTER TABLE guardrail_rules DROP CONSTRAINT IF EXISTS guardrail_rules_rule_type_check;
ALTER TABLE guardrail_rules ADD CONSTRAINT guardrail_rules_rule_type_check
  CHECK (rule_type IN (
    'blocked_topic', 'blocked_phrase', 'require_approval_over_cents', 'max_discount_pct',
    'frustration_signal', 'require_computed_number', 'require_citation',
    'spend_cap_daily_cents', 'spend_cap_monthly_cents'
  ));

-- 4. Seed conservative default caps on the Google Ads archetype ---------------
-- A freshly-hired Google Ads DE has a safety cap from day one; the tenant raises
-- it via the setup interview / guardrail config.
UPDATE role_archetypes SET guardrail_templates = guardrail_templates || jsonb_build_array(
  jsonb_build_object('rule','Daily ad-spend cap (raise in setup)','rule_type','spend_cap_daily_cents','threshold','50000','severity','blocking'),
  jsonb_build_object('rule','Monthly ad-spend cap (raise in setup)','rule_type','spend_cap_monthly_cents','threshold','1000000','severity','blocking')
) WHERE key = 'google_ads'
  AND NOT (guardrail_templates::text LIKE '%spend_cap_daily_cents%');

-- Re-stamp existing Google Ads DEs so they pick up the caps (idempotent).
DO $$
DECLARE d record;
BEGIN
  FOR d IN
    SELECT de.id FROM digital_employees de WHERE de.catalog_id = 'google_ads'
  LOOP
    BEGIN PERFORM public.install_role_kit(d.id, 'google_ads');
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'install_role_kit skipped for DE %: %', d.id, SQLERRM; END;
  END LOOP;
END $$;
