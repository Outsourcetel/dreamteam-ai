-- ============================================================
-- 141 — user-OAuth (authorization-code) infrastructure.
--
-- Unlocks the connector cluster that requires "Sign in with…" OAuth
-- (QuickBooks, Xero, Clio, Gusto, Procore, …) and lets SharePoint/Drive/
-- Teams later offer per-user sign-in. Design:
--   • Platform OAuth APP credentials (our client_id/secret per provider)
--     live in Vault-encrypted platform_config: oauth:{provider}:client_id /
--     :client_secret. Set once by a platform admin.
--   • oauth-start edge fn creates a connector + a single-use CSRF state.
--   • oauth-callback edge fn (public) exchanges the code for tokens and
--     stores them as the connector's secret (Vault, via the sysadmin setter).
--   • connector-hub refreshes the access token from the refresh token.
-- ============================================================

-- Single-use CSRF/link state for the redirect round-trip. service_role only
-- (written by oauth-start, read+deleted by oauth-callback — both run as the
-- service role). Enable RLS with no authenticated policies.
create table if not exists oauth_connect_states (
  state         text primary key,
  tenant_id     uuid not null references tenants(id) on delete cascade,
  connector_id  uuid not null references connectors(id) on delete cascade,
  provider      text not null,
  redirect_uri  text not null,
  created_at    timestamptz not null default now()
);
create index if not exists oauth_states_created_idx on oauth_connect_states(created_at);
alter table oauth_connect_states enable row level security;

-- Platform admin: set an OAuth app's client_id + secret (Vault-encrypted via
-- platform_config). SECURITY DEFINER runs as owner so it can call the
-- service-role-gated platform_config_set.
create or replace function public.set_oauth_app(p_provider text, p_client_id text, p_client_secret text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_platform_admin() then
    raise exception 'only platform admins can configure OAuth apps';
  end if;
  if p_provider !~ '^[a-z0-9_]+$' then
    raise exception 'invalid provider';
  end if;
  perform platform_config_set(jsonb_build_object(
    'oauth:' || p_provider || ':client_id', coalesce(p_client_id, ''),
    'oauth:' || p_provider || ':client_secret', coalesce(p_client_secret, '')
  ));
end $$;

-- Which OAuth apps are configured (client_id present) — non-sensitive, for
-- the connect UI. Returns provider keys only, never the secret.
create or replace function public.oauth_app_status()
returns table(provider text) language sql security definer set search_path = public as $$
  select split_part(key, ':', 2)
  from platform_config
  where key like 'oauth:%:client_id' and secret_id is not null;
$$;

-- Service-role token storage for a connector (the callback + refresh run as
-- service_role with no auth.uid(), so they can't use set_connector_secret
-- which is owner/admin gated). Mirrors its Vault upsert, trusted context.
create or replace function public.set_connector_secret_sysadmin(p_connector_id uuid, p_secret text)
returns void language plpgsql security definer set search_path = public, vault as $$
declare v_existing uuid;
begin
  select secret_id into v_existing from connector_secrets where connector_id = p_connector_id;
  if v_existing is null then
    insert into connector_secrets (connector_id, secret_id, updated_at)
      values (p_connector_id, vault.create_secret(p_secret, 'connector_secret:' || p_connector_id, 'OAuth tokens via oauth-callback'), now());
  else
    perform vault.update_secret(v_existing, p_secret);
    update connector_secrets set updated_at = now() where connector_id = p_connector_id;
  end if;
end $$;

revoke all on function public.set_oauth_app(text, text, text) from public, anon;
grant execute on function public.set_oauth_app(text, text, text) to authenticated, service_role;
revoke all on function public.oauth_app_status() from public, anon;
grant execute on function public.oauth_app_status() to authenticated, service_role;
revoke all on function public.set_connector_secret_sysadmin(uuid, text) from public, anon, authenticated;
grant execute on function public.set_connector_secret_sysadmin(uuid, text) to service_role;
