-- Migration 092: Security & Access page rebuild, part 4 — real IP
-- allowlist. The page's IP allowlist card wrote to localStorage only --
-- nothing else ever read it, and there was no server-side concept of a
-- tenant's allowed IP ranges at all.
--
-- Enforcement is CLIENT-SIDE (a check-ip-allowlist edge function called
-- once per session, forcing sign-out on a mismatch) rather than Vercel
-- Edge Middleware -- true request-time middleware enforcement turned out
-- to require reading the session from a cookie, but this app stores its
-- Supabase session in localStorage only (the supabase-js default), which
-- middleware cannot see at all. Making middleware work would mean first
-- migrating the whole app's session storage to cookies, a separate,
-- much larger auth-architecture change -- founder-scoped decision to
-- ship the honest, real, client-side version instead (same "real but not
-- network-perimeter" pattern as the session-timeout enforcement in
-- migration 091).
-- =====================================================================

create table if not exists tenant_ip_allowlists (
  tenant_id  uuid primary key references tenants(id) on delete cascade,
  enabled    boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(user_id)
);

create table if not exists tenant_ip_allowlist_entries (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  ip_range   cidr not null,
  label      text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid references profiles(user_id)
);

create index if not exists tenant_ip_allowlist_entries_tenant_idx on tenant_ip_allowlist_entries(tenant_id);

alter table tenant_ip_allowlists enable row level security;
alter table tenant_ip_allowlist_entries enable row level security;

drop policy if exists tenant_ip_allowlists_no_direct_access on tenant_ip_allowlists;
create policy tenant_ip_allowlists_no_direct_access on tenant_ip_allowlists
  for all using (false) with check (false);

drop policy if exists tenant_ip_allowlist_entries_no_direct_access on tenant_ip_allowlist_entries;
create policy tenant_ip_allowlist_entries_no_direct_access on tenant_ip_allowlist_entries
  for all using (false) with check (false);

-- ── get_tenant_ip_allowlist ──
-- Any member of the tenant (or a platform admin) can read.
create or replace function public.get_tenant_ip_allowlist(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_enabled boolean;
  v_entries jsonb;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not (
    is_platform_admin()
    or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = p_tenant_id)
  ) then
    raise exception 'not authorized to view this workspace''s IP allowlist';
  end if;

  select coalesce(a.enabled, false) into v_enabled from tenant_ip_allowlists a where a.tenant_id = p_tenant_id;
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'ip_range', host(e.ip_range) || '/' || masklen(e.ip_range), 'label', e.label) order by e.created_at), '[]'::jsonb)
    into v_entries
    from tenant_ip_allowlist_entries e where e.tenant_id = p_tenant_id;

  return jsonb_build_object('enabled', coalesce(v_enabled, false), 'entries', v_entries);
end;
$function$;

revoke all on function public.get_tenant_ip_allowlist(uuid) from public, anon;
grant execute on function public.get_tenant_ip_allowlist(uuid) to authenticated;

-- ── set_tenant_ip_allowlist_enabled ──
create or replace function public.set_tenant_ip_allowlist_enabled(p_tenant_id uuid, p_enabled boolean)
returns jsonb
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
    raise exception 'only workspace owners/admins can change the IP allowlist';
  end if;
  if p_enabled and not exists (select 1 from tenant_ip_allowlist_entries where tenant_id = p_tenant_id) then
    raise exception 'add at least one IP range before turning this on -- otherwise every sign-in would be blocked';
  end if;

  insert into tenant_ip_allowlists (tenant_id, enabled, updated_by)
  values (p_tenant_id, p_enabled, auth.uid())
  on conflict (tenant_id) do update set enabled = excluded.enabled, updated_at = now(), updated_by = excluded.updated_by;

  perform append_audit_event_internal(
    p_tenant_id, 'You', 'human',
    format('IP allowlist %s', case when p_enabled then 'enabled' else 'disabled' end),
    'config_change',
    jsonb_build_object('kind', 'ip_allowlist_toggled', 'enabled', p_enabled)
  );

  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.set_tenant_ip_allowlist_enabled(uuid, boolean) from public, anon;
grant execute on function public.set_tenant_ip_allowlist_enabled(uuid, boolean) to authenticated;

-- ── add_tenant_ip_allowlist_entry ──
create or replace function public.add_tenant_ip_allowlist_entry(p_tenant_id uuid, p_ip_range text, p_label text default '')
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid;
  v_cidr cidr;
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
    raise exception 'only workspace owners/admins can add an IP range';
  end if;

  begin
    v_cidr := p_ip_range::cidr;
  exception when others then
    raise exception '"%" is not a valid IP address or CIDR range (e.g. 192.168.1.0/24)', p_ip_range;
  end;

  insert into tenant_ip_allowlist_entries (tenant_id, ip_range, label, created_by)
  values (p_tenant_id, v_cidr, coalesce(trim(p_label), ''), auth.uid())
  returning id into v_id;

  perform append_audit_event_internal(
    p_tenant_id, 'You', 'human',
    format('IP range added to allowlist: %s', v_cidr),
    'config_change',
    jsonb_build_object('kind', 'ip_allowlist_entry_added', 'entry_id', v_id, 'ip_range', v_cidr::text)
  );

  return jsonb_build_object('id', v_id);
end;
$function$;

revoke all on function public.add_tenant_ip_allowlist_entry(uuid, text, text) from public, anon;
grant execute on function public.add_tenant_ip_allowlist_entry(uuid, text, text) to authenticated;

-- ── remove_tenant_ip_allowlist_entry ──
create or replace function public.remove_tenant_ip_allowlist_entry(p_entry_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select tenant_id into v_tenant from tenant_ip_allowlist_entries where id = p_entry_id;
  if v_tenant is null then
    raise exception 'IP range not found';
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
    raise exception 'only workspace owners/admins can remove an IP range';
  end if;

  delete from tenant_ip_allowlist_entries where id = p_entry_id;

  perform append_audit_event_internal(
    v_tenant, 'You', 'human',
    'IP range removed from allowlist',
    'config_change',
    jsonb_build_object('kind', 'ip_allowlist_entry_removed', 'entry_id', p_entry_id)
  );

  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.remove_tenant_ip_allowlist_entry(uuid) from public, anon;
grant execute on function public.remove_tenant_ip_allowlist_entry(uuid) to authenticated;

-- ── check_ip_against_tenant_allowlist ──
-- service_role only -- called from the check-ip-allowlist edge function,
-- which is the one place that can see a caller's real IP (via
-- x-forwarded-for) since this app's client-side JS cannot. FAIL-OPEN by
-- design: any unexpected error (bad IP format, missing tenant row) must
-- never actively lock a real user out.
create or replace function public.check_ip_against_tenant_allowlist(p_tenant_id uuid, p_ip text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_enabled boolean;
  v_matched boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'check_ip_against_tenant_allowlist is service-role only';
  end if;

  select enabled into v_enabled from tenant_ip_allowlists where tenant_id = p_tenant_id;
  if v_enabled is not true then
    return jsonb_build_object('allowed', true, 'reason', 'not_enabled');
  end if;

  select exists(
    select 1 from tenant_ip_allowlist_entries e
    where e.tenant_id = p_tenant_id and p_ip::inet <<= e.ip_range
  ) into v_matched;

  return jsonb_build_object('allowed', v_matched, 'reason', case when v_matched then 'matched' else 'no_match' end);
exception when others then
  return jsonb_build_object('allowed', true, 'reason', 'error_fail_open');
end;
$function$;

revoke all on function public.check_ip_against_tenant_allowlist(uuid, text) from public, anon, authenticated;
grant execute on function public.check_ip_against_tenant_allowlist(uuid, text) to service_role;
