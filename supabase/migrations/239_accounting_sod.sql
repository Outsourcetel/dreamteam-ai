-- 239_accounting_sod.sql
-- ============================================================================
-- Money-safety — separation of duties + dual control (READY-SCAFFOLDING).
--
-- Built at founder request, eyes-open. SoD has nothing to enforce over YET:
-- Accounting is deliberately propose-only (no posting flow exists), and every
-- DE-proposed write is already prepared-by-DE / approved-by-human (so
-- preparer ≠ approver is structurally true). This ships the reusable POLICY +
-- CHECK so that the moment a real posting / high-value write flow exists, it
-- enforces SoD in one line — rather than inventing accounting-only logic later.
--
--   • sod_policies — per-tenant, per-scope config: require a distinct approver,
--     and a dual-approval amount threshold (a 2nd, different approver above it).
--   • check_approval_sod() — a resolver calls this before applying a high-value
--     approval; returns {ok, reason}. Reusable for accounting postings, billing
--     credits, refunds — any human-approved money action.
--
-- INERT until a write/approval flow calls it — no behavior change on apply.
-- Uses shared policy infra (not accounting-only hardcoding). GLOBAL.
-- ============================================================================

CREATE TABLE IF NOT EXISTS sod_policies (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope                     text NOT NULL DEFAULT 'accounting',   -- domain this applies to (accounting | billing | …)
  require_distinct_approver boolean NOT NULL DEFAULT true,        -- approver must differ from the preparer
  dual_approval_over_cents  bigint,                               -- above this, a 2nd distinct approver is required
  active                    boolean NOT NULL DEFAULT true,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, scope)
);
ALTER TABLE sod_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sod_policies_tenant_read ON sod_policies;
CREATE POLICY sod_policies_tenant_read ON sod_policies
  FOR SELECT USING (tenant_id = public.auth_tenant_id());
DROP POLICY IF EXISTS sod_policies_admin_write ON sod_policies;
CREATE POLICY sod_policies_admin_write ON sod_policies
  FOR ALL USING (tenant_id = public.auth_tenant_id() AND public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin']))
  WITH CHECK (tenant_id = public.auth_tenant_id() AND public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin']));

-- Is this approval allowed under SoD? A resolver calls it before applying a
-- high-value / posting action. No policy configured for the scope → allow.
CREATE OR REPLACE FUNCTION public.check_approval_sod(
  p_tenant_id     uuid,
  p_scope         text,
  p_preparer_user uuid,
  p_approver_user uuid,
  p_amount_cents  bigint DEFAULT NULL,
  p_prior_approver uuid  DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE p sod_policies;
BEGIN
  SELECT * INTO p FROM sod_policies WHERE tenant_id = p_tenant_id AND scope = p_scope AND active;
  IF p.id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'no SoD policy configured for this scope');
  END IF;
  -- 1) Preparer ≠ approver.
  IF p.require_distinct_approver
     AND p_preparer_user IS NOT NULL AND p_approver_user IS NOT NULL
     AND p_preparer_user = p_approver_user THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'The approver cannot be the person who prepared this — separation of duties.');
  END IF;
  -- 2) Dual control above the threshold — needs a second, DIFFERENT approver.
  IF p.dual_approval_over_cents IS NOT NULL AND coalesce(p_amount_cents, 0) > p.dual_approval_over_cents THEN
    IF p_prior_approver IS NULL OR p_prior_approver = p_approver_user THEN
      RETURN jsonb_build_object('ok', false, 'reason',
        format('This is over $%s — it requires a second, different approver (dual control).', round(p.dual_approval_over_cents / 100.0)));
    END IF;
  END IF;
  RETURN jsonb_build_object('ok', true, 'reason', 'separation of duties satisfied');
END; $$;
REVOKE ALL ON FUNCTION public.check_approval_sod(uuid, text, uuid, uuid, bigint, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.check_approval_sod(uuid, text, uuid, uuid, bigint, uuid) TO authenticated, service_role;
