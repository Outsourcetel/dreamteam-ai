-- 326_frustration_threshold_calibration.sql
-- ============================================================================
-- Calibrate the frustration dial BEFORE it goes live for the first time.
--
-- resolve_de_escalation has always returned `coalesce(<de row>, <tenant row>, 50)`.
-- Until now that 50 was harmless: nothing on the answer path computed a
-- sentiment value, so the threshold was never compared against anything. The
-- judgment-layer build (mig 325 + de-answer/widget-ask) makes the employee
-- report its own read of the person, which finally feeds this dial.
--
-- Verified before changing it (2026-07-25): across ALL tenants, exactly one
-- de_escalation_rules row exists and its frustration_threshold is NULL. So NO
-- human has ever chosen a threshold — every DE is sitting on the hardcoded
-- fallback. Turning the dial on at 50 would therefore escalate on "moderately
-- unhappy but the conversation is working", for 15 employees, on a number
-- nobody picked. That is exactly the over-escalation the founder hit live.
--
-- 80 matches the documented scale the model is calibrated against
-- (_shared/conversation.ts CUSTOMER_STATE_SPEC): 70-100 = "stuck, going in
-- circles, escalating, or threatening to leave". A tenant that explicitly sets
-- its own threshold still wins — this only moves the never-chosen default.
--
-- Note this does NOT weaken escalation: an upset customer already escalates
-- via the model's own needs_escalation judgment, which is unchanged. This dial
-- is the deterministic backstop underneath it. GLOBAL.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.resolve_de_escalation(p_tenant_id uuid, p_de_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(frustration_threshold integer, always_escalate_topics text[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    coalesce(
      (select r.frustration_threshold from de_escalation_rules r
       where r.tenant_id = p_tenant_id and r.de_id = p_de_id and p_de_id is not null and r.frustration_threshold is not null),
      (select r.frustration_threshold from de_escalation_rules r
       where r.tenant_id = p_tenant_id and r.de_id is null and r.frustration_threshold is not null),
      80
    ) as frustration_threshold,
    coalesce(
      (select nullif(r.always_escalate_topics, '{}') from de_escalation_rules r
       where r.tenant_id = p_tenant_id and r.de_id = p_de_id and p_de_id is not null),
      (select nullif(r.always_escalate_topics, '{}') from de_escalation_rules r
       where r.tenant_id = p_tenant_id and r.de_id is null),
      '{}'::text[]
    ) as always_escalate_topics;
$function$;

COMMENT ON FUNCTION public.resolve_de_escalation(uuid, uuid) IS
  'Per-DE escalation ruleset with tenant fallback. frustration_threshold is compared against the `sentiment` signal (0-100 = how much the person needs a human) supplied by the answer paths. Platform default 80 (mig 326) — the never-chosen fallback, calibrated to "stuck / escalating", not "mildly unhappy".';

NOTIFY pgrst, 'reload schema';
