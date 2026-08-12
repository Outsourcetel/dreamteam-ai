-- 732 — a workspace created from the console is still administrable
--
-- 730 moved the platform_admin self-connector out of
-- provision_onboarding_architect (the Onboarding Architect DE, "Ada") and into
-- provision_tenant_baseline_internal, so that retiring Ada would not silently
-- take a workspace's ability to administer itself with her. That was right,
-- and it was incomplete: it moved the connector from a path that covers EVERY
-- tenant to a path that does not.
--
-- provision_onboarding_architect runs from provision_onboarding_architect_trg,
-- an AFTER INSERT ON public.tenants FOR EACH ROW trigger. It fires on every
-- tenant row, however that row got there. provision_tenant_baseline_internal
-- has no trigger; it is called from exactly two places —
--   * complete_signup, and
--   * approve_subtenant_request
-- — and there is a THIRD way a tenants row is created: public.request_subtenant.
-- Its self-serve branch (a platform admin with tenants.provision, or an owner
-- of a parent tenant carrying allow_self_serve_subtenants) inserts the tenants
-- row itself and returns, never touching the baseline. It is live UI, not a
-- dormant RPC: src/lib/api.ts:264 -> PlatformConsolePage.tsx's "Provision
-- Tenant" modal.
--
-- Today that path still ends up with a connector, because Ada's trigger is
-- still creating one. The whole point of 730 was that this stops being true.
-- The moment feature_registry.onboarding_architect flips to default_enabled =
-- false, provision_onboarding_architect returns {skipped: flag_off} before it
-- reaches the helper, and a tenant provisioned from the platform console has:
--   * a Workspace Assistant (auto_provision_new_tenant, a separate AFTER
--     INSERT trigger, gives every tenant one), and
--   * no platform_admin connector.
-- get_agentic_tools_for_de then offers that assistant zero actions with
-- requires_role = 'workforce_assistant' — proven live on the one tenant
-- already in that state (the Demo Workspace: 0 admin connectors, 0 such tools,
-- against 1 and 4 for every other workspace) — and nobody can administer the
-- workspace.
--
-- ── WHY THE NARROW FIX, NOT A CALL TO THE FULL BASELINE ───────────────────
-- The obvious edit is `perform provision_tenant_baseline_internal(v_tenant.id)`
-- on that branch, which would also close this. It is deliberately NOT what
-- this migration does. The baseline does much more than the connector:
-- reconcile_tenant_feature over every default_enabled feature, seven starter
-- guardrail rules, seed_approval_baseline, the "SaaS onboarding — starter"
-- template and its published v1, and an audit event. A self-serve sub-tenant
-- receives none of that today. Giving it all of that is a behavioural change
-- to what a self-serve workspace IS — a decision worth making deliberately,
-- with someone who wants that outcome — not a side effect of closing an
-- admin-plumbing hole. This migration restores exactly what the tenant already
-- gets today, from a path that survives Ada's retirement, and changes nothing
-- else. While the flag is on it is a no-op: the AFTER INSERT trigger has
-- already run by the time the next statement in request_subtenant executes, so
-- the helper finds Ada's connector and returns its id.
--
-- Unguarded, matching the two existing call sites: complete_signup and
-- approve_subtenant_request both `perform provision_tenant_baseline_internal(...)`
-- with no exception handler, so a provisioning failure rolls the whole
-- creation back rather than handing someone a half-built workspace. The
-- trigger swallows errors because a trigger must never block tenant creation;
-- an RPC that is creating the tenant on purpose is the opposite case.

begin;

-- ---------------------------------------------------------------------------
-- request_subtenant — reproduced verbatim from the live pg_get_functiondef
-- except for ONE addition: the helper call on the self-serve branch, directly
-- after the tenants row is created. Nothing else is touched: not the
-- authorisation checks, not the slug loop, not the pending-approval branch,
-- not the returned payload.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_subtenant(p_parent_tenant_id uuid, p_name text, p_industry text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

    -- mig 732: this branch is the third tenant-creation path and the only one
    -- that never reaches provision_tenant_baseline_internal. Until now the
    -- platform_admin connector arrived here purely as a side effect of the
    -- AFTER INSERT trigger that hires the Onboarding Architect (mig 730 moved
    -- the row into a shared helper but the trigger is still what calls it on
    -- this path). Retiring that employee — a one-row feature_registry update —
    -- would otherwise leave a console-provisioned workspace with a Workspace
    -- Assistant and no way to administer it. Idempotent, and a no-op while the
    -- trigger is still doing it: the AFTER INSERT triggers have already fired
    -- by the time this statement runs, so the helper finds the existing row.
    perform provision_platform_admin_connector_internal(v_tenant.id);

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

-- ── Grants, re-issued and then asserted in BOTH directions ────────────────
-- `create or replace` preserves whatever grants the function already had, so
-- this changes nothing today (checked live before writing: anon false,
-- authenticated TRUE, service_role TRUE, PUBLIC false). It is re-issued so
-- this migration is self-sufficient rather than only auditing, and asserted
-- because a REVOKE is a request, not a description of where you ended up
-- (migs 610/630/722, and 731 for these exact three functions).
--
-- ⚠ request_subtenant is NOT one of the *_internal helpers: `authenticated`
-- MUST hold EXECUTE, because the UI calls it as the signed-in user
-- (src/lib/api.ts:264) and the function does its own authorisation inside —
-- resolve_platform_capability, the parent-tenant owner/admin check, the
-- is_active check. Asserting only "anon cannot" would pass against a function
-- nobody can call at all, which is its own outage.
revoke execute on function public.request_subtenant(uuid, text, text) from public, anon;
grant  execute on function public.request_subtenant(uuid, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Verification.
--
-- Arm 2 is the one that matters and it was proven capable of failing BEFORE
-- this migration was written, against production, not reasoned about: run with
-- the fix absent it returned exactly `request_subtenant`. That is the whole
-- finding, printed by the check that is supposed to catch it.
--
-- Arm 1 (text present) on its own would pass if someone pasted the call at the
-- top of the function where it can never run, so arm 1b asserts POSITION: the
-- call must sit after the tenants insert and before the self_serve return, i.e.
-- on the branch that creates the tenant. None of these can be intercepted by an
-- earlier constraint — they are catalog reads followed by a raise.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def   text;
  v_ins   int;
  v_call  int;
  v_ret   int;
  v_paths int;
  v_gap   text;
  v_bad   text[] := '{}';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'request_subtenant';
  if v_def is null then
    raise exception '732: public.request_subtenant does not exist';
  end if;

  -- Arm 1: the call landed.
  v_call := strpos(v_def, 'provision_platform_admin_connector_internal');
  if v_call = 0 then
    raise exception '732: request_subtenant never reaches provision_platform_admin_connector_internal';
  end if;

  -- Arm 1b: ...on the self-serve branch, between the tenants insert and the
  -- self_serve return. Present-but-unreachable is the shape a text-only check
  -- would bless.
  v_ins := strpos(v_def, 'insert into tenants');
  v_ret := strpos(v_def, '''self_serve''');
  if v_ins = 0 or v_ret = 0 then
    raise exception '732: could not locate the self-serve branch in request_subtenant — the body drifted and this check can no longer prove anything';
  end if;
  if not (v_ins < v_call and v_call < v_ret) then
    raise exception '732: the connector helper call is not on the self-serve branch (insert at %, call at %, self_serve return at %)', v_ins, v_call, v_ret;
  end if;

  -- Arm 2: and it is not the only path. EVERY function that inserts a tenants
  -- row must reach the admin connector, directly or through the baseline.
  select count(*),
         coalesce(string_agg(p.proname, ', ') filter (
           where pg_get_functiondef(p.oid) !~* 'provision_platform_admin_connector_internal|provision_tenant_baseline_internal'
         ), null)
    into v_paths, v_gap
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind in ('f','p')
     and p.prosrc ~* 'insert\s+into\s+(public\.)?tenants\y';

  -- Arm 3, the vacuity guard: zero paths examined reads exactly like zero
  -- gaps found. Three tenant-creation paths exist at this point in the
  -- migration order — complete_signup, approve_subtenant_request,
  -- request_subtenant — so any other number means the enumeration drifted and
  -- arm 2 proved nothing.
  if v_paths <> 3 then
    raise exception '732 vacuity guard: found % function(s) that insert a tenants row, expected exactly 3 — arm 2 compared nothing it was meant to', v_paths;
  end if;
  if v_gap is not null then
    raise exception '732: these tenant-creation path(s) never reach the platform_admin connector: %', v_gap;
  end if;

  -- Arm 4: grants, both directions.
  if has_function_privilege('public', 'public.request_subtenant(uuid, text, text)', 'execute') then
    v_bad := array_append(v_bad, 'PUBLIC can execute request_subtenant — should not'::text);
  end if;
  if has_function_privilege('anon', 'public.request_subtenant(uuid, text, text)', 'execute') then
    v_bad := array_append(v_bad, 'anon can execute request_subtenant — should not'::text);
  end if;
  if not has_function_privilege('authenticated', 'public.request_subtenant(uuid, text, text)', 'execute') then
    v_bad := array_append(v_bad, 'authenticated CANNOT execute request_subtenant — the Provision Tenant modal would 404'::text);
  end if;
  if not has_function_privilege('service_role', 'public.request_subtenant(uuid, text, text)', 'execute') then
    v_bad := array_append(v_bad, 'service_role CANNOT execute request_subtenant'::text);
  end if;
  if coalesce(array_length(v_bad, 1), 0) > 0 then
    raise exception '732: % of 4 grant assertion(s) failed: %', array_length(v_bad, 1), array_to_string(v_bad, ' | ');
  end if;

  raise notice '732: all 3 tenant-creation paths reach the platform_admin connector; helper call is on the self-serve branch; 4 grant assertions passed';
end $$;

commit;
