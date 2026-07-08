-- ============================================================
-- Migration 086: trial expiry + a real way to control a tenant's plan.
--
-- From the pre-launch readiness review (2026-07-08), findings #2/#11:
-- a self-serve signup got a fully-working, permanent trial with no
-- automatic expiry, and `tenants.plan` had zero behavioral effect —
-- worse, there was no RPC or UI anywhere that could even CHANGE a
-- tenant's plan once created (every signup path hardcodes 'starter').
-- Founder's explicit call: fix trial-expiry and plan-enforcement now;
-- real self-serve billing/payment collection is a separate, later
-- decision (bill manually for now).
--
-- Scope, deliberately bounded: this closes (a) automatic trial
-- cutoff, and (b) makes "plan" a real, founder-controlled concept
-- with a genuine behavioral effect (the AI-usage token budget).
-- Deliberately NOT in scope here: actually blocking a DE's response
-- once a tenant is over its token budget — that requires auditing and
-- changing every edge function that calls an LLM provider, which is
-- real surgery across live production AI-response paths and deserves
-- its own careful, dedicated pass rather than being bundled in here.
-- ============================================================

alter table tenants add column if not exists trial_ends_at timestamptz;

comment on column tenants.trial_ends_at is
  'When a status=''trial'' tenant automatically moves to ''suspended'' (see expire_trials()). Null for non-trial tenants.';

-- ── 1. Trial length at creation: 14 days, set at every self-serve
-- creation path. Both complete_signup and request_subtenant's
-- self-serve branch create status=''trial'' tenants -- both updated
-- here, byte-identical to their prior live definitions except for the
-- added trial_ends_at value.
-- ============================================================

create or replace function public.complete_signup(p_org_name text, p_industry text default null::text)
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

  update profiles
  set tenant_id = v_tenant.id,
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

create or replace function request_subtenant(p_parent_tenant_id uuid, p_name text, p_industry text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user       uuid := auth.uid();
  v_role       text;
  v_caller_tenant uuid;
  v_is_active  boolean;
  v_parent     tenants;
  v_is_platform boolean := resolve_platform_capability(auth.uid(), 'tenants.provision');
  v_slug       text;
  v_base_slug  text;
  v_suffix     int := 0;
  v_tenant     tenants;
  v_request_id uuid;
  v_demo_tenant_id constant uuid := 'a0000000-0000-0000-0000-000000000001';
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  if coalesce(btrim(p_name), '') = '' then
    raise exception 'proposed tenant name is required';
  end if;

  if p_parent_tenant_id is null then
    if not v_is_platform then
      raise exception 'only a platform admin with tenant-provisioning access may create a new top-level tenant';
    end if;
  else
    if p_parent_tenant_id = v_demo_tenant_id then
      raise exception 'the demo tenant cannot be used as a parent tenant';
    end if;

    select * into v_parent from tenants where id = p_parent_tenant_id;
    if not found then
      raise exception 'parent tenant not found';
    end if;

    select role, tenant_id, coalesce(is_active, true) into v_role, v_caller_tenant, v_is_active from profiles where user_id = v_user;

    if not v_is_platform then
      if v_caller_tenant is distinct from p_parent_tenant_id or v_role not in ('tenant_owner', 'tenant_admin') then
        raise exception 'only an owner or admin of the parent tenant may request a sub-tenant';
      end if;
      if not v_is_active then
        raise exception 'account is deactivated';
      end if;
    end if;
  end if;

  if v_is_platform or (p_parent_tenant_id is not null and v_parent.allow_self_serve_subtenants) then
    v_base_slug := lower(regexp_replace(btrim(p_name), '[^a-zA-Z0-9]+', '-', 'g'));
    v_base_slug := trim(both '-' from v_base_slug);
    if coalesce(v_base_slug, '') = '' then
      v_base_slug := 'org';
    end if;
    v_slug := v_base_slug;
    while exists (select 1 from tenants where slug = v_slug) loop
      v_suffix := v_suffix + 1;
      v_slug := v_base_slug || '-' || v_suffix::text;
    end loop;

    insert into tenants (name, slug, industry, plan, status, settings, parent_tenant_id, trial_ends_at)
    values (btrim(p_name), v_slug, nullif(btrim(coalesce(p_industry, '')), ''), 'starter', 'trial', '{}'::jsonb, p_parent_tenant_id, now() + interval '14 days')
    returning * into v_tenant;

    insert into tenant_provisioning_requests
      (requested_by_user_id, proposed_parent_tenant_id, proposed_name, proposed_industry, status, reviewed_by, decided_at, created_tenant_id)
    values
      (v_user, p_parent_tenant_id, btrim(p_name), p_industry, 'approved', v_user, now(), v_tenant.id)
    returning id into v_request_id;

    return jsonb_build_object('ok', true, 'path', 'self_serve', 'tenant_id', v_tenant.id, 'slug', v_tenant.slug, 'request_id', v_request_id);
  end if;

  insert into tenant_provisioning_requests
    (requested_by_user_id, proposed_parent_tenant_id, proposed_name, proposed_industry, status)
  values
    (v_user, p_parent_tenant_id, btrim(p_name), p_industry, 'pending')
  returning id into v_request_id;

  return jsonb_build_object('ok', true, 'path', 'pending_platform_approval', 'request_id', v_request_id);
end;
$function$;

revoke all on function public.request_subtenant(uuid, text, text) from public, anon;
grant execute on function public.request_subtenant(uuid, text, text) to authenticated;

-- ── 2. Automatic expiry — a daily cron, not folded into the existing
-- 5-minute playbook dispatcher: trial expiry only ever needs to be
-- checked once a day, and keeping it a separate job makes it trivial
-- to reason about independently of playbook/support-inbox/staleness
-- concerns already living in that job.
-- ============================================================
create or replace function public.expire_trials()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_demo_tenant_id constant uuid := 'a0000000-0000-0000-0000-000000000001';
  v_count int;
begin
  with expired as (
    update tenants
    set status = 'suspended', updated_at = now()
    where status = 'trial'
      and trial_ends_at is not null
      and trial_ends_at < now()
      and id <> v_demo_tenant_id
    returning id, name
  )
  select count(*) into v_count from expired;

  return coalesce(v_count, 0);
end;
$function$;

revoke all on function public.expire_trials() from public, anon, authenticated;
grant execute on function public.expire_trials() to service_role;

select cron.schedule(
  'trial-expiry-daily',
  '0 6 * * *',
  $$select expire_trials()$$
);

-- ── 3. A real way to set a tenant's plan — didn't exist anywhere
-- before this migration. Platform-admin only (tenants.manage), same
-- shape as set_tenant_status (081). Changing plan resets the token
-- budget to that plan's standard default, so "plan" has an immediate,
-- visible effect rather than being cosmetic -- the founder can still
-- manually raise a specific tenant's budget afterward via the
-- existing self-serve path (capped, migration 084) if a customer
-- genuinely needs more than their plan's default.
-- ============================================================
create or replace function public.set_tenant_plan(p_tenant_id uuid, p_plan text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_demo_tenant_id constant uuid := 'a0000000-0000-0000-0000-000000000001';
  v_found boolean;
  v_new_budget integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not resolve_platform_capability(auth.uid(), 'tenants.manage') then
    raise exception 'only a platform team member with tenant-management access may change a tenant''s plan';
  end if;
  if p_plan not in ('starter', 'growth', 'enterprise') then
    raise exception 'unrecognized plan: %', p_plan;
  end if;
  if p_tenant_id = v_demo_tenant_id then
    raise exception 'the demo tenant''s plan cannot be changed';
  end if;

  select true into v_found from tenants where id = p_tenant_id;
  if not found then
    raise exception 'tenant not found';
  end if;

  v_new_budget := case p_plan
    when 'starter' then 100000
    when 'growth' then 500000
    when 'enterprise' then 2000000
  end;

  update tenants set plan = p_plan, monthly_token_budget = v_new_budget, updated_at = now() where id = p_tenant_id;

  return jsonb_build_object('ok', true, 'tenant_id', p_tenant_id, 'plan', p_plan, 'monthly_token_budget', v_new_budget);
end;
$function$;

revoke all on function public.set_tenant_plan(uuid, text) from public, anon, authenticated;
grant execute on function public.set_tenant_plan(uuid, text) to authenticated;
