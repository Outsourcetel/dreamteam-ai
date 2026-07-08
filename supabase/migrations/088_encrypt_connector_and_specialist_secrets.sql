-- ============================================================
-- Migration 088: encrypt connector_secrets and
-- specialist_source_secrets at rest via Supabase Vault — same fix as
-- migration 087 (platform_config), applied to the two other tables
-- found to share the identical plaintext pattern during the
-- pre-launch readiness review. connector_secrets' own migration
-- (017) already flagged this explicitly: "Vault/KMS encryption is the
-- hardening step."
--
-- Both tables are confirmed empty in production (0 rows, verified
-- live before writing this migration) -- there is no real customer
-- credential at risk of being lost or corrupted by this change. The
-- risk here is purely code-correctness in the edge functions that
-- read these secrets (connector-hub, connector-zendesk,
-- specialist-consult, playbook-execute, mcp-client) -- those are
-- updated in a companion change, verified with synthetic test data,
-- never real customer credentials.
--
-- Same non-destructive pattern as 087: plaintext columns are made
-- nullable and stop being populated going forward, but are not
-- dropped (irreversible DDL, no rollback mechanism exists in this
-- codebase for any migration).
-- ============================================================

alter table connector_secrets add column if not exists secret_id uuid;
alter table connector_secrets alter column secret drop not null;

alter table specialist_source_secrets add column if not exists secret_id uuid;
alter table specialist_source_secrets alter column secret drop not null;

create or replace function public.set_connector_secret(p_connector_id uuid, p_secret text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_existing uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not exists (
    select 1
    from connectors c
    join profiles p on p.tenant_id = c.tenant_id
    where c.id = p_connector_id and p.user_id = auth.uid() and coalesce(p.is_active, true) = true
      and p.role = any (array['tenant_owner', 'tenant_admin'])
  ) then
    raise exception 'only workspace owners/admins can set a connector''s credential';
  end if;

  select secret_id into v_existing from connector_secrets where connector_id = p_connector_id;

  if v_existing is not null then
    perform vault.update_secret(v_existing, p_secret);
    update connector_secrets set updated_at = now() where connector_id = p_connector_id;
  else
    insert into connector_secrets (connector_id, secret_id, updated_at)
    values (p_connector_id, vault.create_secret(p_secret, 'connector_secret:' || p_connector_id, 'Set via set_connector_secret'), now());
  end if;
end;
$function$;

create or replace function public.purge_connector_secret(p_connector_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_secret_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not exists (
    select 1
    from connectors c
    join profiles p on p.tenant_id = c.tenant_id
    where c.id = p_connector_id and p.user_id = auth.uid() and coalesce(p.is_active, true) = true
      and p.role = any (array['tenant_owner', 'tenant_admin'])
  ) then
    raise exception 'only workspace owners/admins can remove a connector''s credential';
  end if;

  select secret_id into v_secret_id from connector_secrets where connector_id = p_connector_id;
  delete from connector_secrets where connector_id = p_connector_id;
  if v_secret_id is not null then
    delete from vault.secrets where id = v_secret_id;
  end if;
end;
$function$;

create or replace function public.set_specialist_source_secret(p_source_id uuid, p_secret text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_existing uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not exists (
    select 1
    from specialist_sources s
    join specialist_profiles sp on sp.id = s.profile_id
    join profiles p on p.tenant_id = sp.tenant_id
    where s.id = p_source_id and p.user_id = auth.uid() and coalesce(p.is_active, true) = true
  ) then
    raise exception 'not a member of this source''s tenant';
  end if;

  select secret_id into v_existing from specialist_source_secrets where source_id = p_source_id;

  if v_existing is not null then
    perform vault.update_secret(v_existing, p_secret);
    update specialist_source_secrets set updated_at = now() where source_id = p_source_id;
  else
    insert into specialist_source_secrets (source_id, secret_id, updated_at)
    values (p_source_id, vault.create_secret(p_secret, 'specialist_source_secret:' || p_source_id, 'Set via set_specialist_source_secret'), now());
  end if;
end;
$function$;

-- ── Decrypted read views: the accessor edge functions use with the
-- service role instead of selecting the plaintext `secret` column
-- directly. Not exposed to anon/authenticated -- same restriction as
-- vault.decrypted_secrets itself (service_role/postgres only,
-- confirmed live).
-- ============================================================
create or replace view connector_secrets_decrypted as
select cs.connector_id, vs.decrypted_secret as secret
from connector_secrets cs
join vault.decrypted_secrets vs on vs.id = cs.secret_id;

revoke all on connector_secrets_decrypted from public, anon, authenticated;
grant select on connector_secrets_decrypted to service_role;

create or replace view specialist_source_secrets_decrypted as
select sss.source_id, vs.decrypted_secret as secret
from specialist_source_secrets sss
join vault.decrypted_secrets vs on vs.id = sss.secret_id;

revoke all on specialist_source_secrets_decrypted from public, anon, authenticated;
grant select on specialist_source_secrets_decrypted to service_role;
