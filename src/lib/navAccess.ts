import type { Page, UserRole } from '../types';

// navAccess — the REAL nav authorization used across the app (Sidebar,
// AuthContext). Renamed from mockData.ts (2026-07-20 review): the former
// mockTenants demo array was dead and removed long ago.

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
  //
  // ── systems_connectors is ADMIN because its main action already is ────────
  // The page had NO tier, so it fell through to "every tenant role" — while
  // the action it exists for is gated in the database:
  //   set_connector_secret → auth_has_tenant_role(['tenant_owner','tenant_admin'])
  // Nothing was ever exposed: a tenant_user could open the page but the
  // database refused to store a credential. The defect was that we showed
  // people a screen whose primary button was guaranteed to fail for them,
  // which reads as a broken product rather than as a permission boundary.
  // Tiering the page to match its own enforcement is the honest version.
  // Deliberately ADMIN and not MANAGE, so the page and set_connector_secret
  // agree exactly — a manager who could open it still could not connect
  // anything, which is the same confusion one rung down.
  //
  // ── ops_activity is MANAGE because it is tenant-WIDE ──────────────────────
  // The Activity Log reads activity_events scoped by tenant_id, NOT by user:
  // it is every action every human and every digital employee took across the
  // whole workspace. It was open to every role, so the most junior seat — and
  // read_only — could read the entire organisation's activity. That is a
  // governance surface, not ambient workspace furniture. MANAGE rather than
  // ADMIN because department managers are exactly who reviews what the
  // workforce did.
  // ⚠ This one is a PRODUCT decision, not a bug fix: it trades workspace
  // transparency for need-to-know. Founder-approved 2026-07-27. If a customer
  // wants an open activity feed, the honest alternative is a per-user view
  // (your own actions plus your own DEs') rather than reopening the
  // tenant-wide one to everybody.
  const ADMIN_PAGES: Page[] = ['settings', 'users', 'gov_security', 'company_setup', 'systems_connectors'];
  const MANAGE_PAGES: Page[] = ['gov_compliance', 'gov_data_access', 'gov_identity_inventory', 'ops_activity'];
  if (ADMIN_PAGES.includes(page)) {
    return ['tenant_owner', 'tenant_admin'].includes(role);
  }
  if (MANAGE_PAGES.includes(page)) {
    return ['tenant_owner', 'tenant_admin', 'tenant_manager'].includes(role);
  }
  return true;
};
