-- 580 — the credential path for connecting a system was writing to a column
-- nothing reads, in plaintext.
--
-- THE DEFECT. set_connector_secret is what the UI calls on every connect. It
-- did this:
--
--     insert into connector_secrets (connector_id, secret)
--     values (p_connector_id, p_secret)
--
-- It writes `secret` and never populates `secret_id`. But every reader —
-- connector-hub, mcp-client, connector-zendesk, playbook-execute,
-- specialist-consult — goes through the view:
--
--     connector_secrets_decrypted =
--       connector_secrets JOIN vault.decrypted_secrets ON vs.id = cs.secret_id
--
-- With secret_id NULL the join drops the row, so the credential is INVISIBLE
-- to everything that needs it. The RPC returns success, the connector is
-- created, and then every call to that system fails to authenticate with no
-- indication why.
--
-- Found while connecting Stripe's MCP server: the secret stored fine, the
-- connector tested "degraded", and Stripe answered 401. The stored credential
-- could not be read by the code that was supposed to send it.
--
-- SECOND PROBLEM, same line: the credential sat in PLAINTEXT in an ordinary
-- table, while the whole point of connector_secrets.secret_id is that
-- credentials live encrypted in Vault. Anyone with read access to that table
-- had the raw key.
--
-- Both were the same missing step, so this fixes both: write to Vault, record
-- the reference, keep nothing in the clear.

create or replace function public.set_connector_secret(
  p_connector_id uuid,
  p_secret       text
) returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tenant   uuid;
  v_existing uuid;
  v_name     text := 'connector:' || p_connector_id::text;
begin
  select tenant_id into v_tenant from connectors where id = p_connector_id;
  if v_tenant is null then
    raise exception 'connector not found';
  end if;

  -- Unchanged authorization: service role, or an owner/admin/manager of the
  -- workspace that owns the connector.
  if coalesce(auth.role(), '') <> 'service_role'
     and not (v_tenant = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner', 'tenant_admin', 'tenant_manager']))
  then
    raise exception 'only workspace owners/admins can set a connector''s credential';
  end if;

  -- Prefer the reference already on the row; fall back to finding the vault
  -- entry by name, so a re-connect after a partial write reuses it rather than
  -- colliding on vault.secrets' unique name.
  select secret_id into v_existing from connector_secrets where connector_id = p_connector_id;
  if v_existing is null then
    select id into v_existing from vault.secrets where name = v_name;
  end if;

  if v_existing is not null then
    perform vault.update_secret(v_existing, p_secret);
    update connector_secrets
       set secret_id = v_existing, secret = null, updated_at = now()
     where connector_id = p_connector_id;
    if not found then
      insert into connector_secrets (connector_id, secret_id, secret)
      values (p_connector_id, v_existing, null);
    end if;
  else
    insert into connector_secrets (connector_id, secret_id, secret)
    values (p_connector_id, vault.create_secret(p_secret, v_name, 'Connector credential'), null)
    on conflict (connector_id) do update
      set secret_id = excluded.secret_id, secret = null, updated_at = now();
  end if;
end $$;

revoke all on function public.set_connector_secret(uuid, text) from public, anon;
grant execute on function public.set_connector_secret(uuid, text) to authenticated, service_role;

comment on function public.set_connector_secret(uuid, text) is
  'Stores a connector credential in Vault and records the reference. Writes NOTHING in plaintext — readers resolve through connector_secrets_decrypted, which joins on secret_id.';

-- Rescue anything already written the broken way: move it into Vault, point
-- the row at it, and clear the plaintext. Without this the credential stays
-- both unreadable and exposed.
do $$
declare
  r      record;
  v_id   uuid;
  v_name text;
  n int := 0;
begin
  for r in select connector_id, secret from connector_secrets
            where secret is not null and secret_id is null
  loop
    v_name := 'connector:' || r.connector_id::text;
    select id into v_id from vault.secrets where name = v_name;
    if v_id is null then
      v_id := vault.create_secret(r.secret, v_name, 'Connector credential (recovered from plaintext, mig 580)');
    else
      perform vault.update_secret(v_id, r.secret);
    end if;
    update connector_secrets
       set secret_id = v_id, secret = null, updated_at = now()
     where connector_id = r.connector_id;
    n := n + 1;
  end loop;
  raise notice 'recovered % plaintext connector credential(s) into Vault', n;
end $$;
