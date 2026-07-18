-- ═══════════════════════════════════════════════════════════════
-- 178 — Per-DE agent identity: delegation tokens (Frontier-20 #14)
--
-- The 2026 "Okta for AI agents" pattern (ID-JAG): instead of handing an
-- external caller the all-powerful tenant API key, issue a SHORT-LIVED,
-- DOWNSCOPED token bound to ONE digital employee and audited back to the
-- ORIGINATING ACTION (the work item / conversation / human task that
-- justified issuing it). Blast radius of a leaked credential drops from
-- "the whole tenant, forever" to "this DE, these scopes, minutes".
--
--   • de_delegation_tokens — hashed at rest (sha256, mig-090 pattern);
--     the raw token (dt_dg_…) exists only in the issuance response.
--   • issue / verify / revoke RPCs — service-role only. verify enforces
--     hash + expiry + revocation + max_uses + scope, and bumps the use
--     counter atomically.
--   • REAL CONSUMER: the A2A endpoint accepts X-Delegation-Token as a
--     downscoped alternative to the tenant API key (scope 'a2a.message',
--     token's DE must BE the addressed agent).
--
-- SKIPPED (founder-blocked, per roadmap): real IdP federation
-- (Okta/Entra token exchange). These are the local rails it would plug
-- into; issuance stays platform-internal until then.
-- ═══════════════════════════════════════════════════════════════

create table if not exists de_delegation_tokens (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  de_id            uuid not null references digital_employees(id) on delete cascade,
  token_hash       text not null unique,
  scopes           text[] not null default '{}',
  -- audit-to-originating-action: WHY this token exists
  originating_kind text check (originating_kind in ('work_item', 'conversation', 'human_task', 'objective', 'manual')),
  originating_ref  uuid,
  issued_at        timestamptz not null default now(),
  expires_at       timestamptz not null,
  max_uses         integer not null default 25 check (max_uses between 1 and 1000),
  used_count       integer not null default 0,
  revoked_at       timestamptz,
  created_by       uuid
);
create index if not exists de_delegation_tokens_de_idx on de_delegation_tokens (tenant_id, de_id, issued_at desc);

alter table de_delegation_tokens enable row level security;
drop policy if exists de_delegation_tokens_read on de_delegation_tokens;
create policy de_delegation_tokens_read on de_delegation_tokens for select using (
  tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
  or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'));

-- ── issue: returns the raw token EXACTLY ONCE ──
create or replace function public.issue_de_delegation_token(
  p_de_id uuid, p_scopes text[], p_originating_kind text default 'manual',
  p_originating_ref uuid default null, p_ttl_seconds integer default 900, p_max_uses integer default 25
) returns jsonb
language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare v_tenant uuid; v_raw text; v_id uuid; v_ttl integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'issue_de_delegation_token is service-role only';
  end if;
  select tenant_id into v_tenant from digital_employees where id = p_de_id;
  if v_tenant is null then raise exception 'de not found'; end if;
  if p_scopes is null or array_length(p_scopes, 1) is null then
    raise exception 'at least one scope required — delegation tokens are downscoped by definition';
  end if;
  v_ttl := greatest(60, least(3600, coalesce(p_ttl_seconds, 900)));   -- 1 min .. 1 hour, hard cap

  v_raw := 'dt_dg_' || encode(gen_random_bytes(24), 'hex');
  insert into de_delegation_tokens (tenant_id, de_id, token_hash, scopes, originating_kind, originating_ref, expires_at, max_uses, created_by)
  values (v_tenant, p_de_id, encode(digest(v_raw, 'sha256'), 'hex'), p_scopes,
          p_originating_kind, p_originating_ref, now() + make_interval(secs => v_ttl),
          greatest(1, least(1000, coalesce(p_max_uses, 25))), auth.uid())
  returning id into v_id;

  return jsonb_build_object('token', v_raw, 'token_id', v_id, 'de_id', p_de_id,
                            'scopes', p_scopes, 'expires_in_seconds', v_ttl);
end;
$function$;

-- ── verify: hash + expiry + revocation + uses + scope, atomically ──
create or replace function public.verify_de_delegation_token(p_raw text, p_required_scope text)
returns jsonb
language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare v_row de_delegation_tokens;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'verify_de_delegation_token is service-role only';
  end if;

  -- Atomic claim-a-use: the WHERE carries every validity condition, so a
  -- burst of parallel calls can never exceed max_uses.
  update de_delegation_tokens
     set used_count = used_count + 1
   where token_hash = encode(digest(coalesce(p_raw, ''), 'sha256'), 'hex')
     and revoked_at is null
     and expires_at > now()
     and used_count < max_uses
     and p_required_scope = any(scopes)
   returning * into v_row;

  if v_row.id is null then return jsonb_build_object('valid', false); end if;
  return jsonb_build_object('valid', true, 'tenant_id', v_row.tenant_id, 'de_id', v_row.de_id,
                            'scopes', v_row.scopes, 'token_id', v_row.id,
                            'originating_kind', v_row.originating_kind, 'originating_ref', v_row.originating_ref);
end;
$function$;

-- ── revoke ──
create or replace function public.revoke_de_delegation_token(p_token_id uuid)
returns void
language plpgsql security definer set search_path to 'public' as $function$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'revoke_de_delegation_token is service-role only';
  end if;
  update de_delegation_tokens set revoked_at = now() where id = p_token_id and revoked_at is null;
end;
$function$;

revoke all on function public.issue_de_delegation_token(uuid, text[], text, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.verify_de_delegation_token(text, text) from public, anon, authenticated;
revoke all on function public.revoke_de_delegation_token(uuid) from public, anon, authenticated;
grant execute on function public.issue_de_delegation_token(uuid, text[], text, uuid, integer, integer) to service_role;
grant execute on function public.verify_de_delegation_token(text, text) to service_role;
grant execute on function public.revoke_de_delegation_token(uuid) to service_role;
