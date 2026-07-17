-- ═══════════════════════════════════════════════════════════════
-- 153 — SECURITY: close a cross-tenant read on guardrail_rules_for_de
--
-- THE HOLE
-- Migration 133 extracted guardrail_rules_for_de() as the shared
-- resolver behind decide_inquiry_triage / decide_work_item_triage /
-- decide_action_execution. Those three kept their service_role-only
-- grants, but the extracted helper was granted to `authenticated` and
-- its body has no tenant-membership check -- it simply trusts the
-- p_tenant_id argument:
--     select g.* from guardrail_rules g where g.tenant_id = p_tenant_id
-- Signup is self-serve, so ANY authenticated user could POST to
-- /rest/v1/rpc/guardrail_rules_for_de with an arbitrary victim tenant
-- id and read that tenant's blocked-phrase / blocked-topic config.
-- Bounded (config, not customer data; needs the victim's tenant UUID)
-- but it is a real break of the isolation this product is built on.
--
-- THE FIX: revoke `authenticated`. Nothing in the browser calls this.
-- Its only three callers are edge functions -- de-answer/index.ts:104,
-- specialist-consult/index.ts:110, widget-ask/index.ts:93 -- and all
-- three call it with a service-role client, which is unaffected.
--
-- WHY NOT the usual `is_platform_admin() OR profiles.tenant_id = ...`
-- body guard used elsewhere: this function is on the ENFORCEMENT path.
-- Service-role callers have a null auth.uid(), so such a guard would
-- match zero rows for exactly the three callers that matter, and the
-- function returns `setof guardrail_rules` -- an empty set reads as
-- "no guardrails apply". That fails OPEN: every DE would silently stop
-- being blocked, with no error. A quiet total loss of guardrail
-- enforcement is far worse than the config read this closes. Revoking
-- the grant removes the attack surface without touching the hot path.
-- ═══════════════════════════════════════════════════════════════

revoke execute on function guardrail_rules_for_de(uuid, uuid, text[], uuid) from authenticated;

-- Re-assert the intended end state (idempotent, and documents it).
revoke all on function guardrail_rules_for_de(uuid, uuid, text[], uuid) from public, anon;
grant execute on function guardrail_rules_for_de(uuid, uuid, text[], uuid) to service_role;
