-- Migration 115: complete_signup() never granted real ownership.
--
-- Found in the 2026-07-09 adversarial go-live audit, independently
-- verified against the live database before fixing: handle_new_user()
-- (migration 056, a correct and deliberate privilege-escalation fix)
-- hardcodes every brand-new signup to role='agent' — an intentionally
-- inert placeholder, not a real tenant role — closing a hole where
-- client-supplied signup metadata could mint a platform admin.
--
-- But complete_signup() (049 -> 068 -> 086, the RPC that actually
-- creates a tenant and links the founder to it) was never updated to
-- compensate: it only ever set tenant_id, never role. 049's own
-- original comment ("role stays tenant_owner — already set at signup
-- time") was true before 056 shipped and silently became false after,
-- with nothing re-deriving it. Confirmed live: every self-serve
-- founder since migration 056 has been permanently stuck at
-- role='agent' — not a valid tenant role anywhere in the frontend
-- (canAccessPage's isTenantRole allow-list doesn't include it), and
-- with no self-service way out, since every role-correcting RPC
-- (update_team_member_role etc.) itself requires the caller to
-- already be a tenant_owner/tenant_admin. handleSetPage's
-- canAccessPage gate silently no-ops every nav click with zero error
-- shown — confirmed directly in AuthContext.tsx before writing this
-- fix.
--
-- The fix: whoever completes org setup for a tenant they just
-- created (the tenant_id is null guard means this can only ever fire
-- once, for a genuinely new signup) is definitionally that tenant's
-- owner. Same signature as the live function — a plain create-or-
-- replace, no drop needed, no overload risk.
-- ============================================================
create or replace function complete_signup(p_org_name text, p_industry text default null)
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

  if v_profile.tenant_id is not null then
    return jsonb_build_object('ok', false, 'error', 'already_has_tenant',
      'tenant_id', v_profile.tenant_id,
      'detail', 'This account is already linked to an organization.');
  end if;

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

  insert into tenants (name, slug, industry, plan, status, settings, trial_ends_at)
  values (btrim(p_org_name), v_slug, nullif(btrim(coalesce(p_industry, '')), ''), 'starter', 'trial', '{}'::jsonb, now() + interval '14 days')
  returning * into v_tenant;

  if v_tenant.id = v_demo_tenant_id then
    raise exception 'Refusing to provision the reserved demo tenant id';
  end if;

  -- role='tenant_owner' added here — this UPDATE only ever fires once
  -- per user (tenant_id is null guard), for the tenant this same user
  -- just created above, so granting real ownership at this exact
  -- point is safe and correct, not a broadened grant.
  update profiles
  set tenant_id = v_tenant.id,
      role = 'tenant_owner',
      updated_at = now()
  where user_id = v_user
    and tenant_id is null;

  if not found then
    delete from tenants where id = v_tenant.id;
    return jsonb_build_object('ok', false, 'error', 'already_has_tenant',
      'detail', 'This account is already linked to an organization.');
  end if;

  -- Provision every default-enabled feature for this brand-new tenant
  -- (account_de/finance_de create their starter DE; the other 5 flags
  -- have nothing to provision — they gate at runtime, already default-
  -- on the moment is_feature_enabled_internal is checked with no
  -- override row present).
  perform reconcile_tenant_feature(v_tenant.id, fr.key, true)
  from feature_registry fr
  where fr.default_enabled = true;

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

-- Grants unchanged (same signature) — re-affirmed defensively.
revoke all on function complete_signup(text, text) from public;
revoke all on function complete_signup(text, text) from anon;
grant execute on function complete_signup(text, text) to authenticated, service_role;
