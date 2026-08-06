-- 633 — "who pays" is set from the console, by something that actually works.
--
-- `llm_key_mode` decides whether a workspace's model calls are billed to
-- DreamTeam AI's provider account or to the customer's own. It is a commercial
-- term. Until now the only way to change it was
-- `supabase.from('tenants').update({ llm_key_mode })` from the tenant Settings
-- page — and `tenants` carries RLS with **only a SELECT policy**, so that write
-- matched zero rows for EVERY caller, platform admins included. PostgREST
-- reports zero rows as success, so the radio reported success and changed
-- nothing, for as long as it has existed.
--
-- Two consequences worth separating:
--   · the customer-facing control was a lie (removed from the tenant page)
--   · there was NO working way to set it at all, for anyone
--
-- This adds the working way, in the place the decision belongs: an RPC gated on
-- the same `tenants.manage` capability that already guards plan changes, so the
-- platform console can set it per tenant.
--
-- ⚠ SECURITY DEFINER because it must bypass the RLS that (correctly) forbids
-- direct writes to `tenants`. The capability check inside is the real gate —
-- and it is checked against auth.uid(), so a service-role caller with no user
-- gets nothing. Same shape as set_tenant_plan.
--
-- ⚠ Changing this changes who pays, so it writes an audit event. A billing term
-- that can be flipped without a trace is not a term, it is a rumour.

begin;

create or replace function public.set_tenant_llm_key_mode(p_tenant_id uuid, p_mode text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_prev text;
  v_name text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  -- The gate. Deliberately the SAME capability as set_tenant_plan: both decide
  -- what a customer is charged for.
  if not resolve_platform_capability(auth.uid(), 'tenants.manage') then
    raise exception 'only DreamTeam AI staff may change which account pays for a workspace';
  end if;
  if p_mode is null or p_mode not in ('platform', 'byo') then
    raise exception 'mode must be platform or byo';
  end if;

  select llm_key_mode, name into v_prev, v_name from tenants where id = p_tenant_id;
  if v_name is null then
    raise exception 'workspace not found';
  end if;

  if v_prev is not distinct from p_mode then
    return jsonb_build_object('ok', true, 'tenant_id', p_tenant_id, 'llm_key_mode', p_mode, 'changed', false);
  end if;

  update tenants set llm_key_mode = p_mode, updated_at = now() where id = p_tenant_id;

  perform append_audit_event(p_tenant_id, 'DreamTeam AI', 'platform',
    format('Billing for AI usage changed from "%s" to "%s". %s',
           v_prev, p_mode,
           case when p_mode = 'byo'
                then 'This workspace now pays its own provider account, and may set its own token budget.'
                else 'DreamTeam AI now pays for this workspace''s usage, and its token budget is set by its plan.' end),
    'config_change',
    jsonb_build_object('kind', 'llm_key_mode_changed', 'from', v_prev, 'to', p_mode));

  return jsonb_build_object('ok', true, 'tenant_id', p_tenant_id, 'llm_key_mode', p_mode, 'changed', true);
end;
$$;

revoke all on function set_tenant_llm_key_mode(uuid, text) from public, anon;
grant execute on function set_tenant_llm_key_mode(uuid, text) to authenticated, service_role;

do $verify$
declare
  v_acl  text;
  v_n    int;
  v_mode text;
begin
  select array_to_string(proacl::text[], ' ') into v_acl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'set_tenant_llm_key_mode';

  if v_acl like '%anon=X%' then raise exception 'callable by anon'; end if;
  if v_acl not like '%authenticated=X%' then
    raise exception 'authenticated cannot call it — the console runs as a signed-in user';
  end if;

  -- Exactly one — a defaulted-parameter overload here would make every call
  -- ambiguous, which is how 618 broke the action gate.
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'set_tenant_llm_key_mode';
  if v_n <> 1 then raise exception '% overloads of set_tenant_llm_key_mode', v_n; end if;

  -- ⚠ And nothing was silently changed on the way in: every workspace should
  -- still be on 'platform', because this migration only adds the ability to
  -- change it.
  select count(*) into v_n from tenants where coalesce(llm_key_mode, 'platform') <> 'platform';
  if v_n > 0 then
    raise exception '% workspace(s) are no longer on platform mode — this migration should change nobody', v_n;
  end if;

  raise notice 'set_tenant_llm_key_mode is live, platform-gated, and changed nobody';
end;
$verify$;

commit;
