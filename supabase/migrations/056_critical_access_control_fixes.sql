-- Migration 056: five confirmed, live-exploitable critical access-control
-- bugs found by an adversarial testing pass across platform access, remote
-- access, and RPC authorization (2026-07-07). Every one below was
-- independently re-verified against the live database before being fixed
-- here -- not just taken on a report's word.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. handle_new_user(): stop trusting client-supplied `layer`/`role` at
-- signup. Migration 038 already stopped trusting a client-supplied
-- tenant_id for exactly this reason (tenant-takeover) but left `layer`
-- and `role` reading straight from `raw_user_meta_data` -- fully
-- attacker-controlled at `supabase.auth.signUp()` time. Since
-- is_platform_admin() checks ONLY `layer = 'platform'`, and isDTUser on
-- the frontend also matches specific `role` strings, a single anonymous
-- signup call with `{"layer":"platform","role":"platform_super_admin"}`
-- in its metadata created a fully-privileged platform account with zero
-- invite, zero confirmation, zero RPC. Confirmed live.
--
-- Fix: both columns are always hardcoded to their safe defaults,
-- regardless of what a client sends. Real privilege assignment only ever
-- happens afterward through a controlled path: complete_signup() sets
-- tenant_owner for a genuine new org founder; redeem_platform_invite()
-- sets platform-layer role/layer for an actually-invited team member.
-- full_name/avatar remain sourced from metadata -- harmless display
-- preferences, not authorization-bearing.
-- ---------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  insert into public.profiles (user_id, full_name, avatar, role, layer, tenant_id)
  values (
    new.id,
    new.raw_user_meta_data->>'full_name',
    new.raw_user_meta_data->>'avatar',
    'agent',
    'tenant',
    null
  ) on conflict (user_id) do nothing;
  return new;
end;
$function$;

-- ---------------------------------------------------------------------
-- 2. profiles: the "Users can update own profile" policy has
-- `with_check = null` -- completely unconstrained. Any authenticated
-- user can PATCH their own row to set layer='platform',
-- role='platform_super_admin', tenant_id=<any other real tenant>, or
-- is_active=true, bypassing the entire invite system and every tenant
-- boundary in one raw REST call. Confirmed live (self-hijack to
-- platform admin, self-reassignment into Acme Telecom).
--
-- Fix: column-level REVOKE, not a WITH CHECK subquery -- self-referential
-- subqueries in an UPDATE's WITH CHECK against the very table being
-- updated are a well-known correctness trap (Halloween-problem-adjacent
-- semantics), whereas Postgres column privileges are checked before RLS
-- ever evaluates, are unambiguous, and only postgres/service_role need
-- them (every legitimate mutation of these four columns already goes
-- through a SECURITY DEFINER RPC -- complete_signup, redeem_platform_invite,
-- invite/revoke, apply_trust_promotion-adjacent flows -- none of which are
-- affected, since SECURITY DEFINER functions run as their owner, not the
-- calling role). anon should never have held UPDATE on these columns
-- either (found granted; revoked here too).
-- ---------------------------------------------------------------------

revoke update (role, layer, tenant_id, is_active) on public.profiles from anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. is_platform_admin(): checked only `layer = 'platform'`, never
-- `is_active`. A deactivated platform-layer account (is_active=false)
-- could still call start_platform_remote_access directly via RPC and
-- open a live, audited-but-unauthorized remote-access session --
-- confirmed live. is_active enforcement was documented as intentionally
-- app-layer-only for ordinary tenant users (a separate, larger gap not
-- fixed here -- flagged for its own follow-up), but the platform-owner
-- gate is exactly the one place this codebase already funnels every
-- check through a single shared function, so fixing it here closes the
-- gap for every is_platform_admin()-gated RPC and RLS policy at once.
-- ---------------------------------------------------------------------

create or replace function public.is_platform_admin()
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from public.profiles
    where user_id = auth.uid() and layer = 'platform' and coalesce(is_active, true) = true
  );
$function$;

-- ---------------------------------------------------------------------
-- 4. end_platform_remote_access(): the session lookup had no
-- `operator_user_id = auth.uid()` check, so ANY platform admin could end
-- ANY other platform admin's active session by session_key alone --
-- confirmed live. Worse, the resulting audit row copied the ORIGINAL
-- operator's name onto the 'end' event, misattributing who really ended
-- it, and because the lookup didn't require operator match, the
-- original operator's own subsequent auth_tenant_id() resolution could
-- still see their session as unmatched-and-live even after someone else
-- "ended" it. Also had no guard against ending an already-ended
-- session_key (duplicate 'end' rows).
--
-- Fix: only the original operator can end their own session; a session
-- that already has a matching 'end' row cannot be ended again.
-- ---------------------------------------------------------------------

create or replace function public.end_platform_remote_access(p_session_key uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_start platform_access_events;
begin
  if not is_platform_admin() then
    raise exception 'only a platform admin may end a remote access session';
  end if;

  select * into v_start from platform_access_events
  where session_key = p_session_key and event = 'start' and operator_user_id = auth.uid()
  order by created_at desc limit 1;

  if not found then
    raise exception 'no matching remote access session found to end';
  end if;

  if exists (select 1 from platform_access_events where session_key = p_session_key and event = 'end') then
    raise exception 'this remote access session has already been ended';
  end if;

  insert into platform_access_events (tenant_id, operator_user_id, operator_name, event, session_key, detail)
  values (v_start.tenant_id, auth.uid(), v_start.operator_name, 'end', p_session_key,
    jsonb_build_object('duration_seconds', extract(epoch from (now() - v_start.created_at))));

  return jsonb_build_object('ok', true, 'session_key', p_session_key);
end;
$function$;

-- ---------------------------------------------------------------------
-- 5. upsert_action_definition(): the ON CONFLICT (id) DO UPDATE path
-- verifies the CALLER is a member of p_tenant_id, but never re-checks
-- that an EXISTING row (when p_id names one) actually belongs to that
-- same tenant. tenant_id itself isn't in the UPDATE SET list, but every
-- other column is -- so a tenant admin who knows or guesses another
-- tenant's action_definitions.id can silently overwrite its category,
-- risk flags (including destructive/idempotent), and execution recipe
-- with their own attacker-controlled values, while the row keeps
-- pointing at the victim tenant. Found by static analysis, confirmed by
-- reading the live function body directly.
-- ---------------------------------------------------------------------

create or replace function public.upsert_action_definition(
  p_id uuid, p_scope text, p_tenant_id uuid, p_category text, p_action_key text,
  p_label text, p_description text, p_provider text, p_template_id uuid,
  p_param_schema jsonb, p_risk jsonb, p_execution jsonb
)
returns action_definitions
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row action_definitions;
  v_user uuid := auth.uid();
  v_role text;
  v_tenant_check uuid;
  v_existing_tenant uuid;
begin
  if p_scope not in ('platform', 'tenant') then
    raise exception 'scope must be platform or tenant';
  end if;
  if p_scope = 'tenant' and p_tenant_id is null then
    raise exception 'tenant scope requires tenant_id';
  end if;
  if p_scope = 'platform' and p_tenant_id is not null then
    raise exception 'platform scope must not carry a tenant_id';
  end if;

  if p_id is not null then
    select tenant_id into v_existing_tenant from action_definitions where id = p_id;
    if found and v_existing_tenant is distinct from p_tenant_id then
      raise exception 'action definition % belongs to a different tenant', p_id;
    end if;
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    if p_scope = 'platform' then
      raise exception 'only the platform (service role) can define platform-scope actions';
    end if;
    select tenant_id, role into v_tenant_check, v_role from profiles where user_id = v_user;
    if v_tenant_check is distinct from p_tenant_id then
      raise exception 'not a member of this tenant';
    end if;
    if v_role not in ('tenant_owner', 'tenant_admin') then
      raise exception 'only workspace owners/admins can register actions';
    end if;
  end if;

  if p_provider = 'template' and p_template_id is null then
    raise exception 'template provider requires template_id';
  end if;
  if not (p_risk ? 'destructive') or not (p_risk ? 'idempotent') then
    raise exception 'risk must include destructive and idempotent booleans';
  end if;

  insert into action_definitions (
    id, scope, tenant_id, category, action_key, label, description,
    provider, template_id, param_schema, risk, execution, created_by
  ) values (
    coalesce(p_id, gen_random_uuid()), p_scope, p_tenant_id, p_category, p_action_key, p_label, p_description,
    p_provider, p_template_id, coalesce(p_param_schema, '[]'::jsonb), p_risk, coalesce(p_execution, '{}'::jsonb), v_user
  )
  on conflict (id) do update set
    category = excluded.category, action_key = excluded.action_key,
    label = excluded.label, description = excluded.description,
    provider = excluded.provider, template_id = excluded.template_id,
    param_schema = excluded.param_schema, risk = excluded.risk,
    execution = excluded.execution, updated_at = now()
  returning * into v_row;

  return v_row;
end;
$function$;
