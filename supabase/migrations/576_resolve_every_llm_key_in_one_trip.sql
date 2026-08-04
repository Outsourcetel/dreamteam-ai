-- 576 — resolve the whole provider chain in ONE round trip.
--
-- Every LLM call resolves ten config keys (four provider credentials plus
-- region/prefix/model-map/order/models). Each one was its own RPC, and each
-- one that resolved to "absent" then made TWO MORE RPCs with a 400ms sleep
-- between them, because getPlatformAIKey retries to cover a transient Vault
-- hiccup and cannot tell a hiccup from a key that was simply never set.
--
-- Five of the ten keys ARE legitimately absent on this platform (Bedrock's
-- credential is env-only; OpenAI and Gemini are unconfigured tiers), so the
-- common path paid that sleep every time. Measured at 0.6-1.2s per call —
-- invisible in chat, dead air on a phone call.
--
-- This is the same resolution logic as resolve_llm_key (mig 541 + 575),
-- applied to a set. It is NOT a new policy: tenant credential wins, a 'byo'
-- workspace with no key of its own is REFUSED rather than silently borrowing
-- the platform's, and plain absence stays distinct from refusal so that
-- env-only providers survive in a tenant-scoped chain.
--
-- resolve_llm_key stays exactly as it is — single-key callers are unchanged.

create or replace function public.resolve_llm_keys(
  p_tenant_id uuid,
  p_keys text[]
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_key    text;
  v_secret uuid;
  v_val    text;
  v_mode   text;
  v_out    jsonb := '{}'::jsonb;
begin
  -- Same guard as resolve_llm_key, written against auth.ROLE: anon shares a
  -- NULL uid with service_role (mig 330), so only the role string keeps anon
  -- away from a live credential.
  if auth.role() is not null and auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  if p_keys is null or array_length(p_keys, 1) is null then
    return v_out;
  end if;

  -- One lookup of the workspace's mode, not one per key.
  if p_tenant_id is not null then
    select llm_key_mode into v_mode from tenants where id = p_tenant_id;
  end if;

  foreach v_key in array p_keys loop
    v_secret := null;
    v_val    := null;

    if p_tenant_id is not null then
      select c.secret_id into v_secret
        from tenant_llm_credentials c
       where c.tenant_id = p_tenant_id and c.provider_key = v_key;

      if v_secret is not null then
        select decrypted_secret into v_val from vault.decrypted_secrets where id = v_secret;
        if coalesce(v_val, '') <> '' then
          v_out := v_out || jsonb_build_object(v_key,
            jsonb_build_object('ok', true, 'key', v_val, 'source', 'tenant'));
          continue;
        end if;
      end if;

      if coalesce(v_mode, 'platform') = 'byo' then
        v_out := v_out || jsonb_build_object(v_key, jsonb_build_object(
          'ok', false, 'source', 'byo_refused', 'reason',
          format('This workspace is set to use its own %s and none is configured. Add it in Settings > AI Engine, or switch the workspace to the platform key.', v_key)));
        continue;
      end if;
    end if;

    -- Platform secret, read straight from the vault for the same reason
    -- resolve_llm_key does: nesting platform_config_get would re-run a guard
    -- this function has already satisfied.
    v_val := null;
    select s.decrypted_secret into v_val
      from vault.decrypted_secrets s
      join platform_config pc on pc.secret_id = s.id
     where pc.key = v_key;

    if coalesce(v_val, '') <> '' then
      v_out := v_out || jsonb_build_object(v_key,
        jsonb_build_object('ok', true, 'key', v_val, 'source', 'platform'));
    else
      -- Absence, NOT refusal. The caller falls through to its env secret,
      -- which is the only reason env-only Bedrock stays in the chain.
      v_out := v_out || jsonb_build_object(v_key, jsonb_build_object(
        'ok', false, 'source', 'none', 'reason',
        format('No %s is configured for this workspace or for the platform.', v_key)));
    end if;
  end loop;

  return v_out;
end $$;

revoke all on function public.resolve_llm_keys(uuid, text[]) from public, anon, authenticated;
grant execute on function public.resolve_llm_keys(uuid, text[]) to service_role;

comment on function public.resolve_llm_keys(uuid, text[]) is
  'Batch twin of resolve_llm_key: resolves many provider keys in one round trip with identical tenant/byo/platform semantics. Added for the voice channel, where per-key round trips were audible as dead air.';
