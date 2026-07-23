-- 277_bind_verified_identity.sql
-- ============================================================================
-- The crypto core of the verified-identity primitive (T2.3). Recomputes the
-- widget HMAC IN-DATABASE (pgcrypto) so the secret never leaves Postgres,
-- constant-time compares, and — only on a match — binds the conversation and
-- returns a PER-TURN verification result the caller uses to gate memory.
--
-- Adversary fixes folded in (wf_d0585fd8-8a5, widget track):
--   * PER-TURN result: this RPC returns {verified, memory_ref, account_id} for
--     THIS request. The memory gate consumes the RETURN VALUE, never the stored
--     row — so a reused conversation / forged message can't inherit an identity.
--   * IMMUTABLE bind: a conversation already bound to a DIFFERENT verified key
--     is never rebound (hijack/account-flip guard); such a turn returns unverified.
--   * Canonical base64url is stripped of the newlines/padding Postgres encode()
--     emits, so it byte-matches a Node/PHP/Python base64url (test vector below).
--   * account_id resolved ONLY from the tenant-curated allow-list keyed on the
--     VERIFIED ref — never from the raw request body.
--   * blank verified ref => unverified (the empty-key bucket can never form).
-- GLOBAL, additive. verify RPC is service_role-only (the widget-ask edge fn,
-- which holds the service key, is the sole caller).
-- ============================================================================

-- ── Tenant-curated contact → account allow-list ─────────────────────────────
CREATE TABLE IF NOT EXISTS customer_account_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  end_user_ref text NOT NULL,
  account_id  uuid NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS customer_account_contacts_ref_uidx
  ON customer_account_contacts (tenant_id, lower(btrim(end_user_ref)));
ALTER TABLE customer_account_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cac_read ON customer_account_contacts;
CREATE POLICY cac_read ON customer_account_contacts FOR SELECT
  USING (tenant_id = public.auth_tenant_id());
-- Writes: owner/admin only, and the account must belong to the SAME tenant
-- (an attacker seat can't attach a contact to a foreign-tenant account).
DROP POLICY IF EXISTS cac_write ON customer_account_contacts;
CREATE POLICY cac_write ON customer_account_contacts FOR ALL
  USING (tenant_id = public.auth_tenant_id()
         AND public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin']))
  WITH CHECK (tenant_id = public.auth_tenant_id()
         AND public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin'])
         AND account_id IN (SELECT id FROM customer_accounts WHERE tenant_id = public.auth_tenant_id()));

-- ── base64url (RFC 4648 §5) matching a client-side b64url exactly ───────────
-- Postgres encode(...,'base64') wraps every 76 chars with a newline and keeps
-- '=' padding; strip both, then +/ -> -_ , so PG and Node/PHP/Python agree.
CREATE OR REPLACE FUNCTION public.b64url(p_in text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT translate(
           replace(replace(rtrim(encode(convert_to(coalesce(p_in,''),'UTF8'),'base64'), '='), chr(10), ''), chr(13), ''),
           '+/', '-_');
$$;

-- ── verify + bind (service_role only) ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.verify_and_bind_widget_identity(
  p_widget_key_id  uuid,
  p_conversation_id uuid,
  p_end_user_ref   text,
  p_account_ref    text,
  p_user_hash      text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_tenant uuid; v_secret text; v_canon text; v_expected text; v_provided text;
  v_key text; v_account_id uuid; v_existing text; v_r bytea; v_ok boolean;
BEGIN
  SELECT tenant_id INTO v_tenant FROM widget_keys WHERE id = p_widget_key_id AND active;
  IF v_tenant IS NULL THEN
    RETURN jsonb_build_object('verified', false, 'reason', 'unknown_widget_key');
  END IF;

  SELECT secret INTO v_secret FROM widget_key_secrets WHERE widget_key_id = p_widget_key_id;
  IF v_secret IS NULL THEN
    -- No identity verification configured for this widget → legitimately
    -- unverified (expected, silent). Answers still flow; no identity memory.
    RETURN jsonb_build_object('verified', false, 'reason', 'no_secret');
  END IF;

  v_provided := lower(btrim(coalesce(p_user_hash, '')));
  IF v_provided = '' THEN
    RETURN jsonb_build_object('verified', false, 'reason', 'no_hash');
  END IF;

  v_key := nullif(lower(btrim(coalesce(p_end_user_ref, ''))), '');
  IF v_key IS NULL THEN
    RETURN jsonb_build_object('verified', false, 'reason', 'blank_ref');
  END IF;

  -- canonical(end_user_ref, account_ref) — account_ref BOUND into the signature
  v_canon := 'dtwidget.v1' || chr(10)
             || 'euid=' || b64url(p_end_user_ref) || chr(10)
             || 'acct=' || b64url(coalesce(p_account_ref, ''));
  v_expected := lower(encode(hmac(v_canon, v_secret, 'sha256'::text), 'hex'));

  -- constant-time compare via double-HMAC with a per-call random key: timing
  -- reveals nothing about v_expected because both sides are blinded by v_r.
  v_r := gen_random_bytes(32);
  v_ok := length(v_provided) = 64
          AND hmac(decode(v_provided, 'hex'), v_r, 'sha256'::text) = hmac(decode(v_expected, 'hex'), v_r, 'sha256'::text);
  IF NOT v_ok THEN
    RETURN jsonb_build_object('verified', false, 'reason', 'mismatch');
  END IF;

  -- account_id resolved ONLY from the tenant allow-list, keyed on the verified ref
  SELECT account_id INTO v_account_id FROM customer_account_contacts
    WHERE tenant_id = v_tenant AND lower(btrim(end_user_ref)) = v_key;

  -- immutable bind: never rebind a conversation already carrying a DIFFERENT key
  SELECT verified_identity_key INTO v_existing FROM de_conversations
    WHERE id = p_conversation_id AND tenant_id = v_tenant;
  IF v_existing IS NOT NULL AND v_existing <> v_key THEN
    -- possible hijack (someone else's verified thread) → deny memory this turn
    RETURN jsonb_build_object('verified', false, 'reason', 'identity_conflict');
  END IF;
  IF v_existing IS NULL THEN
    UPDATE de_conversations
       SET identity_verified = true, verified_identity_key = v_key,
           identity_method = 'widget_hmac',
           account_id = COALESCE(account_id, v_account_id)
     WHERE id = p_conversation_id AND tenant_id = v_tenant;
  ELSIF v_account_id IS NOT NULL THEN
    -- same identity already bound; fill account_id if it wasn't set before
    UPDATE de_conversations SET account_id = COALESCE(account_id, v_account_id)
     WHERE id = p_conversation_id AND tenant_id = v_tenant;
  END IF;

  RETURN jsonb_build_object(
    'verified', true,
    'method', 'widget_hmac',
    'verified_key', v_key,
    'memory_ref', 'widget_hmac:' || v_key,   -- method-namespaced (no cross-method stitch)
    'account_id', v_account_id);
END $$;
REVOKE ALL ON FUNCTION public.verify_and_bind_widget_identity(uuid, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_and_bind_widget_identity(uuid, uuid, text, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';
