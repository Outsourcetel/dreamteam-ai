import type { AuthUser, Tenant, Page, UserRole } from '../types';

export const mockTenants: Tenant[] = [
  {
    id: 't1',
    name: 'Acme Corp',
    slug: 'acme',
    primaryColor: '#6366f1',
    plan: 'enterprise',
    status: 'active',
    agentsActive: 8,
    usersCount: 142,
    monthlyTokens: 2400000,
    tokenLimit: 5000000,
    createdAt: '2024-01-15',
    industry: 'SaaS',
    contactEmail: 'admin@acme.com',
  },
  {
    id: 't2',
    name: 'Globex Inc',
    slug: 'globex',
    primaryColor: '#10b981',
    plan: 'growth',
    status: 'active',
    agentsActive: 5,
    usersCount: 67,
    monthlyTokens: 980000,
    tokenLimit: 2000000,
    createdAt: '2024-03-20',
    industry: 'Manufacturing',
    contactEmail: 'it@globex.com',
  },
  {
    id: 't3',
    name: 'Initech Solutions',
    slug: 'initech',
    primaryColor: '#f59e0b',
    plan: 'starter',
    status: 'trial',
    agentsActive: 2,
    usersCount: 18,
    monthlyTokens: 120000,
    tokenLimit: 500000,
    createdAt: '2024-05-01',
    industry: 'Finance',
    contactEmail: 'cto@initech.com',
  },
  {
    id: 't4',
    name: 'Hooli Technologies',
    slug: 'hooli',
    primaryColor: '#ef4444',
    plan: 'enterprise',
    status: 'active',
    agentsActive: 12,
    usersCount: 340,
    monthlyTokens: 8100000,
    tokenLimit: 10000000,
    createdAt: '2023-11-08',
    industry: 'Technology',
    contactEmail: 'ops@hooli.com',
  },
  {
    id: 't5',
    name: 'Pied Piper',
    slug: 'piedpiper',
    primaryColor: '#8b5cf6',
    plan: 'growth',
    status: 'suspended',
    agentsActive: 0,
    usersCount: 22,
    monthlyTokens: 0,
    tokenLimit: 2000000,
    createdAt: '2024-02-14',
    industry: 'SaaS',
    contactEmail: 'admin@piedpiper.com',
  },
  {
    id: 't6',
    name: 'Umbrella Medical',
    slug: 'umbrella',
    primaryColor: '#0ea5e9',
    plan: 'enterprise',
    status: 'active',
    agentsActive: 7,
    usersCount: 89,
    monthlyTokens: 3200000,
    tokenLimit: 5000000,
    createdAt: '2024-04-03',
    industry: 'Healthcare',
    contactEmail: 'digital@umbrella.com',
  },
];

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
