-- CRITICAL FIX: new customer signup was completely broken and failed
-- silently. Root-caused live during a founder walkthrough on 2026-07-06.
--
-- Root cause chain:
-- 1. LoginPage.tsx's handleSignUp did a client-side `supabase.from('tenants')
--    .insert(...)` immediately after `supabase.auth.signUp()`. The `tenants`
--    table has exactly ONE RLS policy (`tn_sel`, SELECT-only, id =
--    auth_tenant_id()) -- there has never been an INSERT policy, so this
--    insert has ALWAYS silently failed for every real signup.
-- 2. The failure was caught and treated as non-fatal ("Non-fatal if tenants
--    table doesn't exist yet"), and the UI unconditionally showed
--    "Organization created (checkmark)" -- a lie. Confirmed live: a real
--    signup (dana.okafor.test@gmail.com / "Harbor Peak Consulting") produced
--    a profiles row with tenant_id = NULL and role tenant_owner, and NO row
--    in tenants at all, while the UI showed success.
-- 3. Independently, this project requires email confirmation, so
--    supabase.auth.signUp() does not return a usable authenticated session
--    until the user confirms -- tenant creation must never be attempted
--    synchronously inside the signup call regardless of RLS.
-- 4. Worse: AuthContext computed isLiveTenant = false whenever tenantId was
--    falsy, silently routing the affected user into the seeded TCP/PWC demo
--    tenant with zero indication anything was wrong.
--
-- Fix (this migration): a SECURITY DEFINER RPC that runs AFTER the user has
-- a real, confirmed session, does the tenant creation + profile linking
-- itself (bypassing the SELECT-only tenants RLS by design, as owner), and is
-- idempotent + guarded against demo-tenant assignment. LoginPage.tsx and
-- AuthContext.tsx are updated separately (same commit) to stop attempting
-- client-side tenant inserts and to route users with a confirmed session but
-- no tenant_id to a new "set up your organization" screen instead of demo
-- mode.

create or replace function public.complete_signup(p_org_name text, p_industry text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user   uuid := auth.uid();
  v_profile profiles;
  v_slug   text;
  v_base_slug text;
  v_suffix int := 0;
  v_tenant tenants;
  v_demo_tenant_id constant uuid := 'a0000000-0000-0000-0000-000000000001';
begin
  -- Only a genuinely authenticated caller may provision a tenant. No
  -- anon/service_role path here -- a real customer must be logged in with
  -- their own confirmed session; there is no legitimate reason for a
  -- service-role/edge-function context to call this on someone's behalf.
  if v_user is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated',
      'detail', 'You must be signed in to set up an organization.');
  end if;

  if coalesce(btrim(p_org_name), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'org_name_required');
  end if;

  select * into v_profile from profiles where user_id = v_user;
  if v_profile.id is null then
    return jsonb_build_object('ok', false, 'error', 'no_profile',
      'detail', 'No profile found for this user. Please contact support.');
  end if;

  -- Idempotency / security: a user can only ever provision one tenant this
  -- way. This also blocks the RPC from being (ab)used to hijack or re-point
  -- an already-provisioned account onto a different tenant.
  if v_profile.tenant_id is not null then
    return jsonb_build_object('ok', false, 'error', 'already_has_tenant',
      'tenant_id', v_profile.tenant_id,
      'detail', 'This account is already linked to an organization.');
  end if;

  -- Build a unique slug from the org name; fall back to a numeric suffix on
  -- collision rather than trusting Date.now()-style client uniqueness.
  v_base_slug := lower(regexp_replace(btrim(p_org_name), '[^a-zA-Z0-9]+', '-', 'g'));
  v_base_slug := trim(both '-' from v_base_slug);
  if coalesce(v_base_slug, '') = '' then
    v_base_slug := 'org';
  end if;
  v_slug := v_base_slug;
  while exists (select 1 from tenants where slug = v_slug) loop
    v_suffix := v_suffix + 1;
    v_slug := v_base_slug || '-' || v_suffix::text;
  end loop;

  -- tenants.plan is constrained to starter/growth/enterprise (no 'trial'
  -- value exists for plan) -- 'trial' is a valid *status*, not a plan.
  -- New self-serve signups start on the starter plan with trial status.
  insert into tenants (name, slug, industry, plan, status, settings)
  values (btrim(p_org_name), v_slug, nullif(btrim(coalesce(p_industry, '')), ''), 'starter', 'trial', '{}'::jsonb)
  returning * into v_tenant;

  -- Defense-in-depth: this path can never produce the demo tenant's UUID
  -- (gen_random_uuid() practically can't collide with it anyway, but make
  -- the intent explicit and fail loudly if it somehow ever did).
  if v_tenant.id = v_demo_tenant_id then
    raise exception 'Refusing to provision the reserved demo tenant id';
  end if;

  -- Link the caller's own profile to the new tenant. role stays
  -- tenant_owner (already set at signup time); we don't touch it here so we
  -- never downgrade/upgrade a role via this path.
  update profiles
  set tenant_id = v_tenant.id,
      updated_at = now()
  where user_id = v_user
    and tenant_id is null; -- re-assert idempotency guard under the update itself

  if not found then
    -- Someone else (a concurrent call) already linked this profile in the
    -- gap between our check and our update. Roll back the tenant we just
    -- created rather than leaving an orphaned row.
    delete from tenants where id = v_tenant.id;
    return jsonb_build_object('ok', false, 'error', 'already_has_tenant',
      'detail', 'This account is already linked to an organization.');
  end if;

  -- audit_events.category is a fixed enum (see audit_events_category_check)
  -- with no dedicated "tenant lifecycle" value; 'config_change' is the
  -- closest existing fit for "a new organization record was created."
  perform append_audit_event(
    v_tenant.id,
    coalesce(v_profile.full_name, 'owner'),
    'human',
    'Organization "' || v_tenant.name || '" created at signup by ' || coalesce(v_profile.full_name, 'the account owner'),
    'config_change',
    jsonb_build_object('kind', 'tenant_provisioned', 'tenant_id', v_tenant.id,
      'tenant_name', v_tenant.name, 'slug', v_tenant.slug, 'industry', v_tenant.industry,
      'user_id', v_user)
  );

  return jsonb_build_object('ok', true, 'tenant_id', v_tenant.id, 'slug', v_tenant.slug, 'name', v_tenant.name);
end;
$function$;

-- Only real authenticated end-users provision their own tenant this way.
revoke all on function public.complete_signup(text, text) from public, anon, authenticated;
grant execute on function public.complete_signup(text, text) to authenticated;

-- ---------------------------------------------------------------
-- Defense-in-depth gap check (explicitly requested): the existing
-- guard_against_demo_tenant_assignment trigger + function (migration 038)
-- only fire/check on INSERT into profiles. This RPC assigns tenant_id via
-- UPDATE (a brand new profile already exists, created NULL-tenant by the
-- signup trigger), which the INSERT-only guard never covers. complete_signup
-- itself is safe by construction here -- v_tenant.id always comes from
-- gen_random_uuid() inside this same function, never from client input, so
-- it cannot produce the demo tenant's UUID -- but relying solely on one
-- writer's internal discipline is exactly the pattern this codebase's
-- security passes have flagged before. Widen BOTH the trigger's firing event
-- AND the function's own TG_OP check to also cover UPDATE OF tenant_id, so
-- ANY future writer of profiles.tenant_id (not just this RPC) is covered.
-- Additive only -- the INSERT behavior and error message are unchanged.
create or replace function public.guard_against_demo_tenant_assignment()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.tenant_id = 'a0000000-0000-0000-0000-000000000001'::uuid THEN
    RAISE EXCEPTION 'Cannot assign new signups to the demo tenant (a0000000-0000-0000-0000-000000000001). This tenant is reserved for the seeded product demo only.';
  END IF;
  RETURN NEW;
END;
$function$;

drop trigger if exists trg_guard_demo_tenant on profiles;
create trigger trg_guard_demo_tenant
  before insert or update of tenant_id on profiles
  for each row
  execute function guard_against_demo_tenant_assignment();
