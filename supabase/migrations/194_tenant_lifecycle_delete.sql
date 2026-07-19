-- ═══════════════════════════════════════════════════════════════
-- 194 — Tenant lifecycle: a governed DELETE to complete the
-- activate / suspend / delete control set.
--
-- Activate + suspend already exist: set_tenant_status (migration 081),
-- capability-gated on 'tenants.manage', demo-tenant-protected. What was
-- missing was a safe way to permanently remove a tenant — the founder
-- wants a clean tenant list, and hand-running a cascade DELETE trips the
-- audit_events append-only guard (audit_events cascades from tenants).
--
-- This migration:
--   1. Makes audit_events immutability PURGE-AWARE — it still blocks every
--      ordinary UPDATE/DELETE, but permits a DELETE inside a transaction
--      that has explicitly opted in via a transaction-local flag. Only
--      delete_tenant sets that flag, and only for its own transaction, so
--      the append-only guarantee is intact everywhere else.
--   2. Adds delete_tenant(p_tenant_id, p_confirm_slug) — capability-gated,
--      with hard safety rails: demo-protected, can't delete your own
--      tenant, must be SUSPENDED first (deliberate two-step), slug must be
--      typed to confirm, and refuses tenants that still have sub-tenants.
--
-- GLOBAL by construction: schema + functions only, no tenant-specific
-- rows — the control reaches every existing and future tenant.
-- ═══════════════════════════════════════════════════════════════

-- ── 1) purge-aware immutability guard ──
-- UPDATE is ALWAYS rejected. DELETE is rejected unless the session has set
-- the transaction-local flag app.allow_audit_purge = 'on' (only
-- delete_tenant does this). current_setting(..., true) returns NULL when
-- the GUC was never set, so the default posture stays "immutable".
create or replace function public.audit_events_immutable()
returns trigger language plpgsql as $function$
begin
  if TG_OP = 'DELETE' and coalesce(current_setting('app.allow_audit_purge', true), '') = 'on' then
    return OLD;  -- sanctioned cascade purge during a governed tenant deletion
  end if;
  raise exception 'audit_events is immutable — records can only be appended';
end;
$function$;

-- ── 2) delete_tenant ──
create or replace function public.delete_tenant(p_tenant_id uuid, p_confirm_slug text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_demo_tenant_id constant uuid := 'a0000000-0000-0000-0000-000000000001';
  v_t tenants;
  v_self uuid;
  v_children int;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not resolve_platform_capability(auth.uid(), 'tenants.manage') then
    raise exception 'only a platform team member with tenant-management access may delete a tenant';
  end if;

  select * into v_t from tenants where id = p_tenant_id;
  if not found then
    raise exception 'tenant not found';
  end if;

  -- hard rails ----------------------------------------------------------
  if p_tenant_id = v_demo_tenant_id then
    raise exception 'the demo tenant cannot be deleted';
  end if;

  select tenant_id into v_self from profiles where user_id = auth.uid();
  if v_self is not distinct from p_tenant_id then
    raise exception 'you cannot delete the tenant you belong to';
  end if;

  -- deletion is permanent: require the tenant to be suspended first, so it
  -- is never a single click away from a live workspace.
  if v_t.status <> 'suspended' then
    raise exception 'suspend the tenant before deleting it — deletion is permanent and irreversible';
  end if;

  -- type-to-confirm at the data layer too, not just in the UI.
  if coalesce(p_confirm_slug, '') <> v_t.slug then
    raise exception 'confirmation text must exactly match the tenant slug (%)', v_t.slug;
  end if;

  -- refuse if sub-tenants still hang off this one (delete/reassign first).
  select count(*) into v_children from tenants where parent_tenant_id = p_tenant_id;
  if v_children > 0 then
    raise exception 'this tenant still has % sub-tenant(s) — delete or reassign them first', v_children;
  end if;

  -- clear the FK children the ON DELETE cascade will NOT take (these
  -- reference tenants with NO ACTION): provisioning-request pointers and
  -- platform access-event rows.
  delete from tenant_provisioning_requests
    where proposed_parent_tenant_id = p_tenant_id or created_tenant_id = p_tenant_id;
  delete from platform_access_events where tenant_id = p_tenant_id;

  -- sanction the audit_events cascade purge for THIS transaction only.
  perform set_config('app.allow_audit_purge', 'on', true);

  -- everything else (profiles, DEs, playbooks, knowledge, audit_events, …)
  -- cascades from the tenants row.
  delete from tenants where id = p_tenant_id;

  return jsonb_build_object('ok', true, 'deleted_tenant', p_tenant_id, 'name', v_t.name, 'slug', v_t.slug);
end;
$function$;

revoke all on function public.delete_tenant(uuid, text) from public, anon, authenticated;
grant execute on function public.delete_tenant(uuid, text) to authenticated;
