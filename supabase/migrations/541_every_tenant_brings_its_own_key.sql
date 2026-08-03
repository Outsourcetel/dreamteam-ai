-- 541_every_tenant_brings_its_own_key.sql
-- ============================================================================
-- One API key has been carrying every tenant on this platform.
--
-- platform_config is a flat key/value table with NO tenant_id — the row is
-- literally 'ANTHROPIC_API_KEY'. getAIKey(admin, keyName) takes no tenant
-- either: it reads that single global row and falls back to a Deno env secret.
-- Meanwhile every tenant's Settings page shows an "enter your Anthropic key"
-- field which calls platform_config_set — a function gated on the PLATFORM
-- 'billing.manage' capability, so a tenant admin cannot actually use it, and a
-- platform admin who does sets the key for everyone.
--
-- So the field is unusable by the people it is shown to, and effective for
-- exactly one key shared by all sixteen tenants.
--
-- ── WHY THIS IS THE PRIORITY ───────────────────────────────────────────────
-- Beyond the obvious blast radius, it determines WHO THE PROVIDER'S CUSTOMER
-- IS. With one key, this platform looks like it is redistributing model access
-- to sixteen organisations. With per-tenant keys, each tenant holds its own
-- relationship, its own limits and its own policy exposure, and this platform
-- is software they run rather than an intermediary reselling a model.
--
-- ── TWO MODES, DECLARED PER TENANT ─────────────────────────────────────────
--   'byo'      the tenant supplies its own key. If it is missing, calls REFUSE
--              with a clear reason. There is deliberately no silent fallback:
--              silent fallback is precisely how one key came to carry sixteen
--              tenants without anyone noticing.
--   'platform' the platform's key may be used when the tenant has none — the
--              "we provide it, we bill you for tokens" arrangement.
--
-- Default is 'platform', because that is what every existing tenant is doing
-- today and a migration must not change behaviour by surprise. Flipping a
-- tenant to 'byo' is a deliberate act.
-- ============================================================================

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS llm_key_mode text NOT NULL DEFAULT 'platform';

DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_llm_key_mode_check') THEN
    ALTER TABLE public.tenants ADD CONSTRAINT tenants_llm_key_mode_check
      CHECK (llm_key_mode = ANY (ARRAY['byo', 'platform']));
  END IF;
END $c$;

COMMENT ON COLUMN public.tenants.llm_key_mode IS
  'byo = this tenant supplies its own model API keys and calls REFUSE without them. platform = the platform key may be used when the tenant has none (we provide it and bill for tokens). Default platform preserves existing behaviour; byo is a deliberate choice.';

CREATE TABLE IF NOT EXISTS public.tenant_llm_credentials (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  provider_key     text NOT NULL,          -- ANTHROPIC_API_KEY, OPENAI_API_KEY, ...
  secret_id        uuid NOT NULL,          -- vault, never the value itself
  status           text NOT NULL DEFAULT 'untested'
                   CHECK (status IN ('untested', 'working', 'failing')),
  last_verified_at timestamptz,
  last_error       text,
  added_by         uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider_key)
);

ALTER TABLE public.tenant_llm_credentials ENABLE ROW LEVEL SECURITY;
-- Deliberately NO select policy that exposes secret_id to tenant users. The
-- status RPC below tells the UI what it needs without handing out a handle to
-- the secret.
REVOKE ALL ON TABLE public.tenant_llm_credentials FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.tenant_llm_credentials IS
  'Per-tenant model provider keys, held in Vault. The value is never selectable — read only by resolve_llm_key under service role. status/last_verified_at exist so a bad key shows as bad on the settings screen instead of failing silently at 3am.';

-- ── set one ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_tenant_llm_key(
  p_tenant_id uuid, p_provider_key text, p_value text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_existing uuid; v_secret uuid; v_name text;
BEGIN
  IF coalesce(trim(p_value), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'A key is required.');
  END IF;
  IF p_provider_key !~ '^[A-Z0-9_]{3,60}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Unrecognised provider key name.');
  END IF;

  -- A tenant's own owner/admin may set their tenant's key. A platform admin may
  -- set it for any tenant. Service role for automation. Nobody else.
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
    IF NOT (is_platform_admin()
            OR (EXISTS (SELECT 1 FROM profiles p
                         WHERE p.user_id = auth.uid() AND p.tenant_id = p_tenant_id)
                AND auth_has_tenant_role(ARRAY['tenant_owner', 'tenant_admin']))) THEN
      RAISE EXCEPTION 'not authorized to set this workspace''s model key';
    END IF;
  END IF;

  SELECT secret_id INTO v_existing FROM tenant_llm_credentials
   WHERE tenant_id = p_tenant_id AND provider_key = p_provider_key;

  IF v_existing IS NOT NULL THEN
    PERFORM vault.update_secret(v_existing, trim(p_value));
    UPDATE tenant_llm_credentials
       SET status = 'untested', last_verified_at = NULL, last_error = NULL, updated_at = now()
     WHERE tenant_id = p_tenant_id AND provider_key = p_provider_key;
  ELSE
    v_name := 'tenant_llm:' || p_tenant_id::text || ':' || p_provider_key;
    -- A vault secret can outlive the row that pointed at it — an aborted
    -- transaction leaves the secret behind, and vault.secrets has a unique index
    -- on name, so a naive create_secret would fail for ever afterwards. Adopt an
    -- existing secret of this name instead of colliding with it.
    SELECT id INTO v_secret FROM vault.secrets WHERE name = v_name;
    IF v_secret IS NOT NULL THEN
      PERFORM vault.update_secret(v_secret, trim(p_value));
    ELSE
      v_secret := vault.create_secret(trim(p_value), v_name, 'Set via set_tenant_llm_key');
    END IF;
    INSERT INTO tenant_llm_credentials (tenant_id, provider_key, secret_id, added_by)
    VALUES (p_tenant_id, p_provider_key, v_secret, auth.uid());
  END IF;

  RETURN jsonb_build_object('ok', true, 'provider_key', p_provider_key);
END $fn$;

CREATE OR REPLACE FUNCTION public.clear_tenant_llm_key(p_tenant_id uuid, p_provider_key text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_secret uuid;
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
    IF NOT (is_platform_admin()
            OR (EXISTS (SELECT 1 FROM profiles p
                         WHERE p.user_id = auth.uid() AND p.tenant_id = p_tenant_id)
                AND auth_has_tenant_role(ARRAY['tenant_owner', 'tenant_admin']))) THEN
      RAISE EXCEPTION 'not authorized';
    END IF;
  END IF;
  -- Take the vault secret with the row. Deleting only the row would leave the
  -- credential decryptable in vault for ever, which is the opposite of what
  -- "remove my key" means.
  DELETE FROM tenant_llm_credentials
   WHERE tenant_id = p_tenant_id AND provider_key = p_provider_key
   RETURNING secret_id INTO v_secret;
  IF v_secret IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = v_secret;
  END IF;
  RETURN jsonb_build_object('ok', true);
END $fn$;

-- ── what the settings screen may know: everything except the value ─────────
CREATE OR REPLACE FUNCTION public.tenant_llm_key_status(p_tenant_id uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_mode text; v_keys jsonb;
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
    IF NOT (is_platform_admin() OR EXISTS (SELECT 1 FROM profiles p
              WHERE p.user_id = auth.uid() AND p.tenant_id = p_tenant_id)) THEN
      RAISE EXCEPTION 'not authorized';
    END IF;
  END IF;

  SELECT llm_key_mode INTO v_mode FROM tenants WHERE id = p_tenant_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'provider_key', c.provider_key, 'status', c.status,
           'last_verified_at', c.last_verified_at, 'last_error', c.last_error)
         ORDER BY c.provider_key), '[]'::jsonb)
    INTO v_keys FROM tenant_llm_credentials c WHERE c.tenant_id = p_tenant_id;

  RETURN jsonb_build_object('ok', true, 'mode', v_mode, 'keys', v_keys);
END $fn$;

-- ── the resolution, and the only place a value is ever read ────────────────
CREATE OR REPLACE FUNCTION public.resolve_llm_key(p_tenant_id uuid, p_provider_key text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_secret uuid; v_val text; v_mode text;
BEGIN
  -- Service role (or a superuser/migration context, where auth.role() is NULL)
  -- ONLY. Written against auth.ROLE, never "auth.uid() is null" — anon shares a
  -- NULL uid with service role (mig 330) but its role is the string 'anon', so
  -- checking the role is what actually keeps anon out of a live credential.
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT c.secret_id INTO v_secret FROM tenant_llm_credentials c
   WHERE c.tenant_id = p_tenant_id AND c.provider_key = p_provider_key;

  IF v_secret IS NOT NULL THEN
    SELECT decrypted_secret INTO v_val FROM vault.decrypted_secrets WHERE id = v_secret;
    IF coalesce(v_val, '') <> '' THEN
      RETURN jsonb_build_object('ok', true, 'key', v_val, 'source', 'tenant');
    END IF;
  END IF;

  SELECT llm_key_mode INTO v_mode FROM tenants WHERE id = p_tenant_id;

  IF coalesce(v_mode, 'platform') = 'byo' THEN
    -- No silent fallback. This workspace said it brings its own key.
    RETURN jsonb_build_object('ok', false, 'source', 'none', 'reason',
      format('This workspace is set to use its own %s and none is configured. Add it in Settings > AI Engine, or switch the workspace to the platform key.', p_provider_key));
  END IF;

  -- Read the platform secret directly rather than through platform_config_get:
  -- that function carries its own service-role guard, which this already
  -- satisfies above, and nesting it makes this fail in any context where the
  -- outer guard passes but the inner one does not.
  v_val := NULL;
  SELECT decrypted_secret INTO v_val
    FROM vault.decrypted_secrets s
    JOIN platform_config pc ON pc.secret_id = s.id
   WHERE pc.key = p_provider_key;

  IF coalesce(v_val, '') <> '' THEN
    RETURN jsonb_build_object('ok', true, 'key', v_val, 'source', 'platform');
  END IF;

  RETURN jsonb_build_object('ok', false, 'source', 'none', 'reason',
    format('No %s is configured for this workspace or for the platform.', p_provider_key));
END $fn$;

REVOKE ALL ON FUNCTION public.resolve_llm_key(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_tenant_llm_key(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.clear_tenant_llm_key(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tenant_llm_key_status(uuid) FROM PUBLIC, anon;

notify pgrst, 'reload schema';

DO $a$
DECLARE
  v_tenant uuid; v_other uuid; v_res jsonb; v_status jsonb; v_err text;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'outsourcetel-hq';
  SELECT id INTO v_other  FROM tenants WHERE id <> v_tenant LIMIT 1;

  -- ── a tenant key is stored and resolves as the TENANT's ─────────────────
  v_res := set_tenant_llm_key(v_tenant, 'ANTHROPIC_API_KEY', 'sk-ant-541-selftest-value');
  IF NOT (v_res->>'ok')::boolean THEN RAISE EXCEPTION '541: could not set a tenant key: %', v_res; END IF;

  v_res := resolve_llm_key(v_tenant, 'ANTHROPIC_API_KEY');
  IF (v_res->>'source') <> 'tenant' THEN
    RAISE EXCEPTION '541: the tenant key did not win over the platform key (source %)', v_res->>'source';
  END IF;
  IF (v_res->>'key') <> 'sk-ant-541-selftest-value' THEN
    RAISE EXCEPTION '541: the stored key did not round-trip through Vault';
  END IF;

  -- ── and it does NOT leak to any other tenant ────────────────────────────
  -- The whole point: one workspace's credential must never serve another.
  IF v_other IS NOT NULL THEN
    v_res := resolve_llm_key(v_other, 'ANTHROPIC_API_KEY');
    IF (v_res->>'source') = 'tenant' THEN
      RAISE EXCEPTION '541: another workspace resolved to a tenant credential it does not own';
    END IF;
  END IF;

  -- ── byo mode REFUSES rather than silently falling back ──────────────────
  PERFORM clear_tenant_llm_key(v_tenant, 'ANTHROPIC_API_KEY');
  UPDATE tenants SET llm_key_mode = 'byo' WHERE id = v_tenant;
  v_res := resolve_llm_key(v_tenant, 'ANTHROPIC_API_KEY');
  IF (v_res->>'ok')::boolean THEN
    RAISE EXCEPTION '541: a byo workspace with no key still resolved one — silent fallback survives';
  END IF;
  IF (v_res->>'reason') NOT LIKE '%own ANTHROPIC_API_KEY%' THEN
    RAISE EXCEPTION '541: the refusal does not say what is missing: %', v_res;
  END IF;

  -- ── platform mode still works, so nothing breaks today ──────────────────
  UPDATE tenants SET llm_key_mode = 'platform' WHERE id = v_tenant;
  v_res := resolve_llm_key(v_tenant, 'ANTHROPIC_API_KEY');
  IF (v_res->>'source') NOT IN ('platform', 'none') THEN
    RAISE EXCEPTION '541: platform mode resolved unexpectedly: %', v_res;
  END IF;

  -- ── the status view never returns a key value ───────────────────────────
  PERFORM set_tenant_llm_key(v_tenant, 'ANTHROPIC_API_KEY', 'sk-ant-541-selftest-value');
  v_status := tenant_llm_key_status(v_tenant);
  IF v_status::text LIKE '%selftest-value%' THEN
    RAISE EXCEPTION '541: the settings status RPC leaks the key value';
  END IF;
  IF jsonb_array_length(v_status->'keys') = 0 THEN
    RAISE EXCEPTION '541: the settings screen cannot see that a key is set';
  END IF;

  -- Restore: this was a probe, not a configuration.
  PERFORM clear_tenant_llm_key(v_tenant, 'ANTHROPIC_API_KEY');
  IF EXISTS (SELECT 1 FROM tenant_llm_credentials WHERE tenant_id = v_tenant) THEN
    RAISE EXCEPTION '541: the self-test left a credential behind';
  END IF;

  RAISE NOTICE '541: per-tenant keys live — a tenant key wins, never leaks across workspaces, byo refuses instead of falling back, and the settings screen never sees a value';
END $a$;
