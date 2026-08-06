-- 632 — a spend limit the spender can raise.
--
-- `set_tenant_monthly_budget` lets a tenant_owner or tenant_admin set their own
-- workspace's monthly AI token budget, capped at 10,000,000 — a hundred times
-- the 100k default. That is deliberate, and for a workspace running on its OWN
-- provider account it is exactly right: their key, their bill, their call.
--
-- ⚠⚠ BUT IT NEVER ASKS WHOSE MONEY IT IS. All 16 workspaces are currently
-- `llm_key_mode = 'platform'` — meaning the tokens are billed to DreamTeam AI's
-- provider account, not theirs. So today the check reads:
--
--     a customer may raise, by a factor of one hundred, the ceiling on
--     spending that WE pay for.
--
-- That is the same defect as an approval limit the approver can edit. A ceiling
-- the spender controls is not a control; it is a suggestion with a number next
-- to it.
--
-- The fix is one condition, not a new permission model: **self-serve is allowed
-- only where the workspace pays.**
--
--     llm_key_mode = 'byo'       → owner/admin may set it (their provider account)
--     llm_key_mode = 'platform'  → platform only (ours)
--
-- ⚠ A platform admin (`tenants.manage`) is unaffected in either mode — that
-- path already bypasses the whole block and still does.
--
-- ⚠ The 10,000,000 self-serve cap is DELIBERATELY LEFT ALONE. In byo mode it
-- arguably protects nobody, since the spend is on the customer's own account —
-- but removing it is a separate commercial decision, and changing two things in
-- one migration is how you lose track of which one caused the surprise.
--
-- ⚠ Reading, not writing: tenants keep full visibility of their usage and their
-- limit. This removes the ability to CHANGE a number that is not theirs, not
-- the ability to see it.

begin;

create or replace function public.set_tenant_monthly_budget(p_tenant_id uuid, p_budget integer)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_demo_tenant_id constant uuid := 'a0000000-0000-0000-0000-000000000001';
  v_max_self_serve_budget constant integer := 10000000; -- 100x the 100k default; revisit once real plan-based billing exists
  v_caller_tenant uuid;
  v_role text;
  v_is_active boolean;
  v_mode text;
  v_is_platform boolean := resolve_platform_capability(auth.uid(), 'tenants.manage');
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if p_tenant_id = v_demo_tenant_id then
    raise exception 'the demo tenant''s budget cannot be changed';
  end if;
  if p_budget is null or p_budget < 0 then
    raise exception 'budget must be a non-negative number';
  end if;

  if not v_is_platform then
    select tenant_id, role, coalesce(is_active, true) into v_caller_tenant, v_role, v_is_active
    from profiles where user_id = auth.uid();

    if v_caller_tenant is distinct from p_tenant_id or v_role not in ('tenant_owner', 'tenant_admin') then
      raise exception 'only an owner or admin of this organization may change the token budget';
    end if;
    if not v_is_active then
      raise exception 'account is deactivated';
    end if;

    -- ⚠ WHOSE MONEY. This is the whole migration. Everything else in this
    -- function is unchanged from before.
    select llm_key_mode into v_mode from tenants where id = p_tenant_id;
    if coalesce(v_mode, 'platform') <> 'byo' then
      raise exception 'this workspace runs on DreamTeam AI''s provider account, so its token budget is set by your plan — connect your own provider key to control it yourself, or contact us to change it';
    end if;

    -- Self-serve (non-platform-admin) callers are capped. A platform
    -- admin (tenants.manage) can still set a higher budget by hand for
    -- a legitimate enterprise customer who genuinely needs more.
    if p_budget > v_max_self_serve_budget then
      raise exception 'requested budget exceeds the self-serve limit (%); contact DreamTeam AI to raise it', v_max_self_serve_budget;
    end if;
  end if;

  update tenants set monthly_token_budget = p_budget, updated_at = now() where id = p_tenant_id;

  return jsonb_build_object('ok', true, 'tenant_id', p_tenant_id, 'monthly_token_budget', p_budget);
end;
$function$;

-- ⚠ Same grant posture as everything else touched this week: revoke from
-- public AND the named roles Supabase grants by default, then hand back only
-- what the app needs. `authenticated` IS needed here — a byo-mode owner calls
-- this from the browser — but it must be an explicit decision, not an
-- inherited default ([[security_default_execute_grant]], mig 630).
revoke all on function set_tenant_monthly_budget(uuid, integer) from public, anon;
grant execute on function set_tenant_monthly_budget(uuid, integer) to authenticated, service_role;

do $verify$
declare
  v_acl text;
  v_src text;
begin
  select array_to_string(proacl::text[], ' '), prosrc into v_acl, v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'set_tenant_monthly_budget';

  -- The condition is present…
  if v_src not like '%llm_key_mode%' then
    raise exception 'the whose-money check is not in the function body';
  end if;
  -- …and the platform bypass survived. Losing it would mean nobody could set a
  -- platform-mode budget at all, turning a governance fix into an outage.
  if v_src not like '%v_is_platform%' then
    raise exception 'the platform-admin bypass was lost — no one could set a platform-mode budget';
  end if;

  if v_acl like '%anon=X%' then
    raise exception 'still callable by anon';
  end if;
  if v_acl not like '%authenticated=X%' then
    raise exception 'authenticated lost execute — a byo owner could no longer set their own budget';
  end if;

  raise notice 'budget self-serve now requires byo mode; platform bypass and authenticated grant intact';
end;
$verify$;

commit;
