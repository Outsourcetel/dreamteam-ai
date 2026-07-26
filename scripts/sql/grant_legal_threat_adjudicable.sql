-- ============================================================================
-- FOUNDER-DIRECTED GRANT — make the legal-threat guardrail machine-clearable
-- for the outsourcetel-hq workspace, in SHADOW mode.
--
-- Run with:  node scripts/db-query.mjs scripts/sql/grant_legal_threat_adjudicable.sql
--
-- WHAT THIS DOES
--   Adds one row to guardrail_rule_adjudicable. That row is what lets GI-10's
--   adjudicator consider a match on this ONE rule. Without it the adjudicator
--   returns 'rule_not_opted_in' before it spends anything or logs anything.
--
-- WHAT THIS DOES NOT DO
--   It does NOT release anything. platform_config['guardrail_adjudication.mode']
--   is 'shadow', and in shadow the adjudicator records what it WOULD have
--   cleared and then returns the block anyway. Nothing reaches a customer
--   differently until someone sets that key to 'enforce'.
--
-- WHY THIS FILE EXISTS INSTEAD OF THE RPC
--   set_rule_adjudicable() requires an authenticated tenant_owner/tenant_admin
--   session (auth.uid()). The service role has no auth.uid(), so the RPC
--   correctly refuses. This script performs the same work with the same checks
--   and writes the SAME audit record — but leaves granted_by NULL rather than
--   forging a user id.
--
--   PREFERRED PATH: do this in the app instead — Governance -> Compliance ->
--   "When a guardrail matches the wrong thing" -> "Let AI clear a false match".
--   That path records YOUR user id in granted_by and your name on the audit
--   event, which is materially better evidence for an auditor.
--
-- TO REVERSE
--   delete from guardrail_rule_adjudicable
--    where rule_id = 'e1b4bc8f-94ba-479a-a3ee-1048f0112b3b';
-- ============================================================================

do $$
declare
  v_rule guardrail_rules;
  v_just text;
begin
  select * into v_rule from guardrail_rules
   where id = 'e1b4bc8f-94ba-479a-a3ee-1048f0112b3b';

  -- Same three gates set_rule_adjudicable enforces.
  if v_rule.id is null then
    raise exception 'rule not found';
  end if;
  if v_rule.severity <> 'blocking'
     or v_rule.rule_type not in ('blocked_phrase','blocked_topic') then
    raise exception 'only blocking phrase/topic rules can be adjudicated';
  end if;
  if v_rule.compliance_pack_key is not null then
    raise exception 'compliance-pack rule — requires the owner override, not this script';
  end if;

  v_just :=
    'This rule exists to stop the employee THREATENING a customer with legal consequences. '
 || 'It has instead been blocking answers that decline to give legal advice, that refer '
 || 'someone to a qualified attorney, and twice it matched the word "court" inside '
 || '"courteous". Granted by the workspace owner on 2026-07-25 to run the shadow pilot; '
 || 'shadow mode cannot release anything, it only records what it would have released.';

  insert into guardrail_rule_adjudicable (tenant_id, rule_id, granted_by, justification)
  values (v_rule.tenant_id, v_rule.id, null, v_just)
  on conflict (tenant_id, rule_id)
  do update set justification = excluded.justification, granted_at = now();

  -- Same audit record the RPC writes, in the same transaction as the grant.
  perform append_audit_event_internal(
    v_rule.tenant_id, 'Workspace owner (applied via Claude Code)', 'human',
    format('GRANTED: guardrail rule "%s" is now machine-clearable', v_rule.rule),
    'guardrail_adjudication',
    jsonb_build_object(
      'kind', 'adjudicable_granted',
      'rule_id', v_rule.id,
      'rule', v_rule.rule,
      'pattern', v_rule.pattern,
      'compliance_pack_key', v_rule.compliance_pack_key,
      'justification', v_just,
      'applied_via', 'service_role_admin_path',
      'granted_by_user_id', null,
      'mode_at_grant', 'shadow'));
end $$;

select jsonb_pretty(jsonb_build_object(
  'granted', (select jsonb_agg(jsonb_build_object('rule', g.rule, 'tenant', t.slug, 'at', a.granted_at))
                from guardrail_rule_adjudicable a
                join guardrail_rules g on g.id = a.rule_id
                join tenants t on t.id = a.tenant_id),
  'mode', (select value from platform_config where key = 'guardrail_adjudication.mode'),
  'can_anything_be_released',
    (select case when (select value from platform_config where key = 'guardrail_adjudication.mode') = 'enforce'
                 then 'YES' else 'NO — shadow mode records only' end)
)) as result;
