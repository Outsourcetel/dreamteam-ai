import type { Page, UserRole } from '../types';

// NOTE: this file is named mockData.ts for historical reasons, but the
// only thing left in it — canAccessPage — is the REAL nav authorization
// used across the app (Sidebar, AuthContext). The former mockTenants
// demo array was dead (zero references) and was removed. Worth renaming
// this file to something like navAccess.ts in a follow-up.

export const canAccessPage = (role: UserRole, page: Page, layer?: 'platform' | 'tenant' | 'end_user'): boolean => {
  const isDtRole = [
    'dt_super_admin',
    'dt_god_access',
    'dt_support',
    'dt_billing',
  ].includes(role) || layer === 'platform';
  // Every real tenant role from useUsers' TenantRole — this list missing
  // knowledge_manager/approver/read_only meant those three roles could be
  // invited but could never navigate to ANY page (handleSetPage silently
  // no-ops on a false return here, with no error shown).
  const isTenantRole = [
    'tenant_owner',
    'tenant_admin',
    'tenant_manager',
    'knowledge_manager',
    'approver',
    'tenant_user',
    'read_only',
  ].includes(role);
  const dtOnlyPages = [
    'platform_home',
    'platform_tenants',
    'platform_team',
    'platform_remote_access',
    'platform_health',
    'platform_revenue',
    'platform_security',
    // Trust & Architecture is an internal transparency/architecture doc
    // ("how DreamTeam is built · what we haven't done yet"), NOT a tenant
    // feature — platform operators only, never a customer's nav.
    'gov_trust',
  ];
  if (dtOnlyPages.includes(page)) return isDtRole;
  if (isDtRole) return true;
  if (!isTenantRole) return false;

  // Wave 5 — per-role page tiers WITHIN the tenant (was: any tenant role
  // saw every tenant page). Matches the intent of the ROLE_PERMISSIONS
  // matrix the Security page already displays:
  //   ADMIN tier  — workspace administration: owners/admins only.
  //   MANAGE tier — governance & workforce config: + department managers.
  //   Everything else — all tenant roles (read_only's protection is
  //   server-side: RLS write policies exclude it since migration 136).
  const ADMIN_PAGES: Page[] = ['settings', 'users', 'gov_security', 'company_setup'];
  const MANAGE_PAGES: Page[] = ['gov_compliance', 'gov_data_access', 'gov_identity_inventory'];
  if (ADMIN_PAGES.includes(page)) {
    return ['tenant_owner', 'tenant_admin'].includes(role);
  }
  if (MANAGE_PAGES.includes(page)) {
    return ['tenant_owner', 'tenant_admin', 'tenant_manager'].includes(role);
  }
  return true;
};
