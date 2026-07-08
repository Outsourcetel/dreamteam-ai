-- ============================================================
-- Migration 102: lets edge functions honor an active, audited Remote
-- Access session the same way direct DB/RLS access already does.
--
-- Found while browser-verifying the Knowledge Ingestion page: 10 edge
-- functions (ingest-chunks, connector-hub, connector-zendesk,
-- specialist-consult, agentic-step-execute, playbook-execute x2,
-- onboarding-verify, mcp-client, eval-run, check-ip-allowlist) each
-- resolve the caller's tenant with `select tenant_id from profiles
-- where user_id = auth.uid()`. That's correct for an ordinary tenant
-- user, but a platform admin's own profile has tenant_id = null by
-- design — so every one of these functions 403s with 'no_tenant' (or,
-- for check-ip-allowlist, silently no-ops) when called with a real
-- platform admin's own browser JWT during a genuine Remote Access
-- session, even though `auth_tenant_id()` already solves exactly this
-- for direct table/RLS access (migration 058's remote-access-session
-- fallback branch). The client-side godModeTenantIdOverride mechanism
-- (customerApi.ts) papers over this for direct Supabase table reads,
-- but has no way to reach server-side edge-function logic.
--
-- This function ports auth_tenant_id()'s exact verification (most
-- recent platform_access_events row for this operator is a 'start'
-- event within the last 12 hours) to something an edge function can
-- call directly, given the operator's user id AND the tenant they
-- claim to be Remote-Accessing. Requiring the claimed tenant to match
-- that real, recent session's actual tenant_id means a platform admin
-- can never simply assert an arbitrary tenant in a request body and
-- have it trusted -- the assertion is checked against a real, durable
-- audit record of an active session for exactly that tenant.
-- ============================================================

create or replace function public.resolve_remote_access_tenant(p_operator_user_id uuid, p_asserted_tenant_id uuid)
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  select e.tenant_id
  from platform_access_events e
  where e.operator_user_id = p_operator_user_id
    and e.event = 'start'
    and e.tenant_id = p_asserted_tenant_id
    and e.created_at > now() - interval '12 hours'
    and exists (
      select 1 from profiles p
      where p.user_id = p_operator_user_id and p.layer = 'platform' and coalesce(p.is_active, true) = true
    )
    and e.id = (
      select e2.id from platform_access_events e2
      where e2.operator_user_id = p_operator_user_id
      order by e2.created_at desc
      limit 1
    )
  limit 1;
$function$;

revoke all on function public.resolve_remote_access_tenant(uuid, uuid) from public, anon, authenticated;
grant execute on function public.resolve_remote_access_tenant(uuid, uuid) to service_role;
