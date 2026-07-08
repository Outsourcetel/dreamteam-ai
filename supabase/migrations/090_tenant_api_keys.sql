-- Migration 090: Security & Access page rebuild, part 2 — real API keys.
-- The page's "API Keys" card showed a hardcoded API_KEYS mock list with a
-- dead "+ Create key" button. No api_keys table, generation, or
-- verification existed anywhere in this codebase (confirmed by grep
-- across every migration and edge function before writing this).
--
-- Real credential lifecycle: server-side generation (raw key never
-- persisted, only its sha256 hash), shown to the caller exactly once,
-- masked display thereafter, real revoke. verify_tenant_api_key() is
-- built and tested even though no public API endpoint calls it yet
-- (confirmed: this product has no tenant-facing REST surface today) —
-- the credential and verification logic are real; what's honestly absent
-- is something to authenticate with it, which is a separate, future
-- product surface, not part of this page's job.
-- =====================================================================

create table if not exists tenant_api_keys (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  name         text not null,
  display_hint text not null,
  key_hash     text not null unique,
  scopes       text[] not null default '{}',
  created_by   uuid references profiles(user_id),
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

create index if not exists tenant_api_keys_tenant_idx on tenant_api_keys(tenant_id);

alter table tenant_api_keys enable row level security;

-- No direct client access at all -- credentials-adjacent, same posture as
-- platform_capability_grants/platform_invites. Every read/write goes
-- through a guarded RPC below.
drop policy if exists tenant_api_keys_no_direct_access on tenant_api_keys;
create policy tenant_api_keys_no_direct_access on tenant_api_keys
  for all using (false) with check (false);

-- ── create_tenant_api_key ──
-- Owner/admin of the tenant, or a platform admin (Remote Access) --
-- same tier as connectors/guardrails (migration 064). Generates the raw
-- key server-side (pgcrypto, already enabled by migration 015) and
-- returns it exactly once; only its hash and a masked display hint are
-- ever stored.
create or replace function public.create_tenant_api_key(p_tenant_id uuid, p_name text, p_scopes text[] default '{}')
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_raw text;
  v_hash text;
  v_hint text;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not (
    is_platform_admin()
    or exists (
      select 1 from profiles p
      where p.user_id = auth.uid() and p.tenant_id = p_tenant_id
        and coalesce(p.is_active, true) = true
        and p.role in ('tenant_owner', 'tenant_admin')
    )
  ) then
    raise exception 'only workspace owners/admins can create an API key';
  end if;
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'name is required';
  end if;

  v_raw := encode(gen_random_bytes(24), 'hex');
  v_hash := encode(digest(v_raw, 'sha256'), 'hex');
  v_hint := 'dt_live_' || repeat('•', 8) || right(v_raw, 4);

  insert into tenant_api_keys (tenant_id, name, display_hint, key_hash, scopes, created_by)
  values (p_tenant_id, trim(p_name), v_hint, v_hash, coalesce(p_scopes, '{}'), auth.uid())
  returning id into v_id;

  perform append_audit_event_internal(
    p_tenant_id, 'You', 'human',
    format('API key created: %s', trim(p_name)),
    'config_change',
    jsonb_build_object('kind', 'api_key_created', 'key_id', v_id, 'name', trim(p_name), 'scopes', p_scopes)
  );

  return jsonb_build_object('id', v_id, 'raw_key', 'dt_live_' || v_raw, 'display_hint', v_hint);
end;
$function$;

revoke all on function public.create_tenant_api_key(uuid, text, text[]) from public, anon;
grant execute on function public.create_tenant_api_key(uuid, text, text[]) to authenticated;

-- ── list_tenant_api_keys ──
create or replace function public.list_tenant_api_keys(p_tenant_id uuid)
returns table(
  id uuid, name text, display_hint text, scopes text[],
  created_at timestamptz, last_used_at timestamptz, revoked_at timestamptz
)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not (
    is_platform_admin()
    or exists (
      select 1 from profiles p
      where p.user_id = auth.uid() and p.tenant_id = p_tenant_id
        and coalesce(p.is_active, true) = true
        and p.role in ('tenant_owner', 'tenant_admin')
    )
  ) then
    raise exception 'only workspace owners/admins can view API keys';
  end if;

  return query
    select k.id, k.name, k.display_hint, k.scopes, k.created_at, k.last_used_at, k.revoked_at
    from tenant_api_keys k
    where k.tenant_id = p_tenant_id
    order by k.created_at desc;
end;
$function$;

revoke all on function public.list_tenant_api_keys(uuid) from public, anon;
grant execute on function public.list_tenant_api_keys(uuid) to authenticated;

-- ── revoke_tenant_api_key ──
create or replace function public.revoke_tenant_api_key(p_key_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid;
  v_name text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select tenant_id, name into v_tenant, v_name from tenant_api_keys where id = p_key_id;
  if v_tenant is null then
    raise exception 'API key not found';
  end if;

  if not (
    is_platform_admin()
    or exists (
      select 1 from profiles p
      where p.user_id = auth.uid() and p.tenant_id = v_tenant
        and coalesce(p.is_active, true) = true
        and p.role in ('tenant_owner', 'tenant_admin')
    )
  ) then
    raise exception 'only workspace owners/admins can revoke an API key';
  end if;

  update tenant_api_keys set revoked_at = now() where id = p_key_id and revoked_at is null;

  perform append_audit_event_internal(
    v_tenant, 'You', 'human',
    format('API key revoked: %s', v_name),
    'config_change',
    jsonb_build_object('kind', 'api_key_revoked', 'key_id', p_key_id, 'name', v_name)
  );

  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.revoke_tenant_api_key(uuid) from public, anon;
grant execute on function public.revoke_tenant_api_key(uuid) to authenticated;

-- ── verify_tenant_api_key ──
-- service_role only -- this is what a future public API endpoint would
-- call with a caller-supplied key. Built and tested now (see migration
-- verification notes) so the credential lifecycle is genuinely real, not
-- just a UI mockup with better props.
create or replace function public.verify_tenant_api_key(p_raw_key text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_key text;
  v_hash text;
  v_row tenant_api_keys;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'verify_tenant_api_key is service-role only';
  end if;

  v_key := p_raw_key;
  if v_key like 'dt_live_%' then
    v_key := substr(v_key, 9);
  end if;
  v_hash := encode(digest(v_key, 'sha256'), 'hex');

  select * into v_row from tenant_api_keys where key_hash = v_hash;
  if v_row.id is null or v_row.revoked_at is not null then
    return jsonb_build_object('valid', false);
  end if;

  update tenant_api_keys set last_used_at = now() where id = v_row.id;

  return jsonb_build_object('valid', true, 'tenant_id', v_row.tenant_id, 'scopes', v_row.scopes, 'key_id', v_row.id);
end;
$function$;

revoke all on function public.verify_tenant_api_key(text) from public, anon, authenticated;
grant execute on function public.verify_tenant_api_key(text) to service_role;
