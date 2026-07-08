-- ============================================================
-- Migration 087: encrypt platform_config values at rest using
-- Supabase Vault, closing readiness-review finding #13.
--
-- platform_config.value was a plain `text` column — the Anthropic/
-- OpenAI/Google provider keys entered via Settings > AI Engine were
-- stored unencrypted. Confirmed via exhaustive grep across every edge
-- function and migration: NOTHING currently reads platform_config's
-- value for actual use (every real LLM call reads Deno.env's
-- ANTHROPIC_API_KEY, a Supabase edge-function secret configured
-- separately in the dashboard, completely disconnected from this
-- table). That's a real, separate functional gap worth the founder's
-- attention -- flagged in project memory, deliberately not solved
-- here (this migration is scoped to the encryption-at-rest ask, not a
-- rearchitecture of how keys reach edge functions).
--
-- Fix: store a reference to a Supabase Vault secret instead of the
-- raw value. Vault (pgsodium-backed, already enabled on this project)
-- is the correct tool here rather than hand-rolled pgcrypto -- Supabase
-- manages the master key, and `vault.decrypted_secrets` is only
-- selectable by postgres/service_role (confirmed live), never by
-- anon/authenticated.
--
-- Existing data (2 real rows: RESEND_API_KEY, an alert-email entry)
-- is migrated into Vault before the plaintext column is dropped --
-- not orphaned.
-- ============================================================

alter table platform_config add column if not exists secret_id uuid;

-- Migrate any existing plaintext values into Vault before the column
-- that held them is removed.
do $$
declare
  r record;
  v_secret_id uuid;
begin
  for r in select key, value from platform_config where secret_id is null and value is not null loop
    v_secret_id := vault.create_secret(r.value, 'platform_config:' || r.key, 'Migrated from plaintext platform_config.value (2026-07-08)');
    update platform_config set secret_id = v_secret_id where key = r.key;
  end loop;
end $$;

create or replace function platform_config_set(p_entries jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  k text;
  v text;
  v_existing uuid;
begin
  if not resolve_platform_capability(auth.uid(), 'billing.manage') then
    raise exception 'not authorized';
  end if;

  for k, v in select * from jsonb_each_text(p_entries)
  loop
    select secret_id into v_existing from platform_config where key = k;

    if v_existing is not null then
      perform vault.update_secret(v_existing, v);
      update platform_config set updated_at = now() where key = k;
    else
      insert into platform_config (key, secret_id, updated_at)
      values (k, vault.create_secret(v, 'platform_config:' || k, 'Set via platform_config_set'), now());
    end if;
  end loop;

  return true;
end;
$$;

create or replace function platform_config_has_key(p_key text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not resolve_platform_capability(auth.uid(), 'billing.manage') then
    raise exception 'not authorized';
  end if;
  return exists (select 1 from platform_config where key = p_key and secret_id is not null);
end;
$$;

-- ── platform_config_get: the accessor a future edge-function
-- integration would use to actually consume a stored key.
-- service_role only -- never exposed to authenticated/anon, since this
-- returns the raw decrypted secret value. Nothing calls this yet
-- (see header comment) -- it exists so the storage layer is ready the
-- moment the founder decides to wire Settings' AI Engine keys into the
-- real answer pipeline instead of the separate Deno.env secret.
-- ============================================================
create or replace function platform_config_get(p_key text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_value text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'not authorized';
  end if;
  select vs.decrypted_secret into v_value
  from platform_config pc
  join vault.decrypted_secrets vs on vs.id = pc.secret_id
  where pc.key = p_key;
  return v_value;
end;
$$;

revoke all on function platform_config_set(jsonb) from public, anon, authenticated;
grant execute on function platform_config_set(jsonb) to authenticated;
revoke all on function platform_config_has_key(text) from public, anon, authenticated;
grant execute on function platform_config_has_key(text) to authenticated;
revoke all on function platform_config_get(text) from public, anon, authenticated;
grant execute on function platform_config_get(text) to service_role;

-- The plaintext data is cleared (the actual security fix -- no secret
-- values sit in the DB unencrypted anymore) but the `value` column
-- itself is deliberately left in place rather than dropped. Dropping a
-- column is irreversible in this codebase (no rollback mechanism
-- exists for any migration) -- clearing the data achieves the same
-- security outcome without a one-way schema change; the empty column
-- can be dropped later in a follow-up migration once this is confirmed
-- working end-to-end.
alter table platform_config alter column value drop not null;
update platform_config set value = null where value is not null;
