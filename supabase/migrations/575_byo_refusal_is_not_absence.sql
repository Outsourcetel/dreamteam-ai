-- 575: a BYO refusal and a missing config row are different answers.
--
-- FOUND 2026-08-04 (voice spike). resolve_llm_key returned source='none' for
-- BOTH of these situations:
--   (a) the workspace is set to bring its own key and has not — a considered
--       REFUSAL that must never silently borrow the platform's credential;
--   (b) neither the workspace nor platform_config has the key AT ALL — mere
--       absence, where the caller's next stop (the Deno.env secret, which
--       resolve_llm_key cannot see from SQL) is legitimate.
--
-- getAIKey (aiKeys.ts) treats source='none' as the refusal and stops. Correct
-- for (a); for (b) it silently DELETED providers from the failover chain:
-- BEDROCK_API_KEY lives only in Deno.env, so every tenant-scoped caller lost
-- Bedrock — and with the platform Anthropic key currently dead (401, separate
-- founder action to replace), the tenant-scoped chain failed outright while
-- the no-tenant path rode Bedrock fine. Proven live via voice-turn.
--
-- Fix: the BYO case now says source='byo_refused'. Plain 'none' stays absence.
-- aiKeys.ts (same commit) blocks only on 'byo_refused' and falls through to
-- the platform path — platform_config, then env — for 'none'.
begin;

create or replace function public.resolve_llm_key(p_tenant_id uuid, p_provider_key text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
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
    -- mig 575: distinct source, so the caller can tell refusal from absence.
    RETURN jsonb_build_object('ok', false, 'source', 'byo_refused', 'reason',
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

do $do$
declare v jsonb;
begin
  -- hq is a platform-key workspace: a key platform_config lacks entirely must
  -- read as ABSENCE ('none'), never refusal.
  v := resolve_llm_key('5bb802e1-8e92-4eef-9a7a-ac348785d43f', 'BEDROCK_API_KEY');
  if v->>'source' = 'byo_refused' then
    raise exception '575: platform-mode workspace reads as BYO-refused';
  end if;
  if v->>'source' not in ('none', 'platform', 'tenant') then
    raise exception '575: unexpected source %', v->>'source';
  end if;
  raise notice '575: refusal and absence are now distinct (hq BEDROCK -> %)', v->>'source';
end $do$;

commit;
