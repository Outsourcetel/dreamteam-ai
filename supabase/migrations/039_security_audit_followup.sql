-- Migration 039: Adversarial multi-tenant isolation audit — follow-up fix
-- (renumbered from 038 to 039 to stay sequential after the 037/038 rename
-- above — already applied to the live DB, this is a file-naming-only fix)
--
-- increment_metric_tenant(p_tenant_id uuid, p_metric text, p_delta bigint)
-- was missed in migration 037's revoke list. Live adversarial test (this
-- audit): an UNAUTHENTICATED caller (anon key, no JWT at all) called
--   POST /rest/v1/rpc/increment_metric_tenant
--   {"p_tenant_id": "<Acme Telecom's real tenant>", "p_metric": "...", "p_delta": 999}
-- and successfully wrote an arbitrary usage_metrics row for Acme Telecom
-- with zero authentication (confirmed live, then cleaned up). The function
-- body's only guard was `if auth.uid() is not null then raise exception
-- 'service role only'` — but calling with the anon key and no bearer JWT
-- ALSO makes auth.uid() null, so the guard doesn't actually distinguish
-- "genuine service-role caller" from "no caller at all". Root cause:
-- confirmed via grep that increment_metric_tenant is only ever called from
-- supabase/functions/de-answer/index.ts and specialist-consult/index.ts,
-- both using the service-role admin client — there is no legitimate
-- end-user calling pattern. Fix: revoke EXECUTE from anon/authenticated
-- entirely (service_role's own grant, inherited via PUBLIC at function
-- creation time, is untouched).
REVOKE EXECUTE ON FUNCTION increment_metric_tenant(uuid, text, bigint) FROM anon, authenticated;

-- p_workspace_period_end(p_workspace_id uuid) — flagged NEEDS-REVIEW in the
-- same audit: no auth check, returns a single date for any workspace id.
-- Low sensitivity on its own, but it's a cross-tenant metadata leak /
-- workspace-id enumeration oracle, and grep confirms zero call sites in
-- src/ or supabase/functions/ (positional-parameter-style name suggests an
-- internal helper that was never meant to be called directly). Revoke.
REVOKE EXECUTE ON FUNCTION p_workspace_period_end(uuid) FROM anon, authenticated;

-- The following three were already correctly un-granted to anon/authenticated
-- (verified via has_function_privilege against the live DB) — no live risk,
-- but documenting explicitly here so the "safe because never granted" fact
-- is recorded in migration history rather than only being implicit/accidental:
--   - append_audit_event_internal(uuid, text, text, text, text, jsonb):
--     no membership check in its own body; safe today only because it has
--     never been granted to anon/authenticated. All real call sites pass a
--     tenant_id already validated by the calling SECURITY DEFINER function
--     (close_opportunity_won, onboarding_check_complete, etc).
--   - compute_tenant_health_service(uuid): same shape — internal-only by
--     the absence of a grant, not by an internal check.
--   - trust_evidence_for(trust_policies): accepts a full composite-type row
--     rather than a bare tenant_id, which would let a caller construct an
--     arbitrary fake row if ever granted — currently safe only because it
--     has never been granted to anon/authenticated.
-- Explicit belt-and-suspenders REVOKE (idempotent no-op today, but removes
-- any ambiguity for a future migration that might otherwise assume default
-- PUBLIC grants are fine to leave alone):
REVOKE EXECUTE ON FUNCTION append_audit_event_internal(uuid, text, text, text, text, jsonb) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION compute_tenant_health_service(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION trust_evidence_for(trust_policies) FROM anon, authenticated;
