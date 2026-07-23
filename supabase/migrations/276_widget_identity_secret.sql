-- 276_widget_identity_secret.sql
-- ============================================================================
-- Per-widget-key HMAC secret for identity verification (T2.3). The tenant's OWN
-- server signs (end_user_ref, account_ref) with this secret and passes the hash
-- into the widget boot (Intercom/Zendesk pattern); the verify RPC (mig 277)
-- recomputes the HMAC in-database and never lets the secret leave Postgres.
--
-- Storage mirrors the established credential precedent (connector_secrets):
-- RLS ENABLED with NO policies = deny-all to every client; only SECURITY DEFINER
-- RPCs and service_role can touch it. The secret is returned to the admin
-- exactly ONCE at generation and never again. (System-wide encryption-at-rest
-- via Vault is a broader hardening that would also cover connector_secrets;
-- tracked separately, not a widget-specific gap.)
-- GLOBAL, additive.
-- ============================================================================

CREATE TABLE IF NOT EXISTS widget_key_secrets (
  widget_key_id uuid PRIMARY KEY REFERENCES widget_keys(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  secret        text NOT NULL,              -- 256-bit hex; deny-all RLS + SECDEF-only
  algo          text NOT NULL DEFAULT 'hmac-sha256',
  created_at    timestamptz NOT NULL DEFAULT now(),
  rotated_at    timestamptz
);
ALTER TABLE widget_key_secrets ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: RLS-enabled + zero policies = deny-all for every
-- client role. Access is exclusively through the SECDEF RPCs below + service_role.

-- ── Generate / rotate the secret (owner/admin of the key's tenant) ──────────
-- Returns the plaintext secret exactly once. Rotating invalidates every hash
-- the tenant's server previously issued (break-glass), so it's an explicit act.
CREATE OR REPLACE FUNCTION public.rotate_widget_identity_secret(p_widget_key_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_secret text; v_is_new boolean;
BEGIN
  SELECT tenant_id INTO v_tenant FROM widget_keys WHERE id = p_widget_key_id;
  IF v_tenant IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'widget_key_not_found');
  END IF;
  IF coalesce(auth.role(), '') <> 'service_role'
     AND NOT (v_tenant = public.auth_tenant_id()
              AND public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin'])) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_permitted');
  END IF;

  v_secret := encode(gen_random_bytes(32), 'hex');   -- 256-bit, 64 hex chars
  SELECT NOT EXISTS (SELECT 1 FROM widget_key_secrets WHERE widget_key_id = p_widget_key_id) INTO v_is_new;
  INSERT INTO widget_key_secrets (widget_key_id, tenant_id, secret)
  VALUES (p_widget_key_id, v_tenant, v_secret)
  ON CONFLICT (widget_key_id) DO UPDATE SET secret = EXCLUDED.secret, rotated_at = now();
  RETURN jsonb_build_object('ok', true, 'secret', v_secret, 'is_new', v_is_new);
END $$;
REVOKE ALL ON FUNCTION public.rotate_widget_identity_secret(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rotate_widget_identity_secret(uuid) TO authenticated, service_role;

-- ── Is a secret configured? (owner/admin; boolean only, never the value) ────
CREATE OR REPLACE FUNCTION public.widget_identity_configured(p_widget_key_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_has boolean; v_rot timestamptz;
BEGIN
  SELECT tenant_id INTO v_tenant FROM widget_keys WHERE id = p_widget_key_id;
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'widget_key_not_found'); END IF;
  IF coalesce(auth.role(), '') <> 'service_role'
     AND NOT (v_tenant = public.auth_tenant_id()
              AND public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin','tenant_manager'])) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_permitted');
  END IF;
  SELECT EXISTS (SELECT 1 FROM widget_key_secrets WHERE widget_key_id = p_widget_key_id),
         (SELECT rotated_at FROM widget_key_secrets WHERE widget_key_id = p_widget_key_id)
    INTO v_has, v_rot;
  RETURN jsonb_build_object('ok', true, 'configured', coalesce(v_has, false), 'rotated_at', v_rot);
END $$;
REVOKE ALL ON FUNCTION public.widget_identity_configured(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.widget_identity_configured(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
