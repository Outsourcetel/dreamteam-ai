// Shared tenant-resolution helper for edge functions (migration 102).
// A platform admin's own profile has tenant_id = null by design, so
// the old pattern (select tenant_id from profiles where user_id =
// auth.uid()) always returns null for them — meaning every edge
// function using it 403'd whenever called with a real platform
// admin's own browser JWT during an active Remote Access session,
// even though direct DB/RLS access already handles this correctly
// (auth_tenant_id()'s remote-access-session fallback, migration 058).
//
// This mirrors that same real, audited verification at the edge-
// function layer: a platform admin can assert a target tenant_id in
// the request body, but it's only honored if resolve_remote_access_tenant
// confirms a real, recent (within 12h) platform_access_events 'start'
// row exists for that exact operator + tenant — the same check
// auth_tenant_id() already performs for table access.
export async function resolveTenantWithRemoteAccess(
  admin: any,
  userId: string,
  profileTenantId: string | null | undefined,
  profileLayer: string | null | undefined,
  bodyTenantId: string | null | undefined,
): Promise<string | null> {
  if (profileTenantId) return profileTenantId;
  if (profileLayer === 'platform' && bodyTenantId) {
    const { data, error } = await admin.rpc('resolve_remote_access_tenant', {
      p_operator_user_id: userId,
      p_asserted_tenant_id: bodyTenantId,
    });
    if (error) { console.error('resolve_remote_access_tenant:', error.message); return null; }
    return data ?? null;
  }
  return null;
}
