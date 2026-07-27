import type { Page, UserRole } from '../types';

// navAccess — the REAL nav authorization used across the app (Sidebar,
// AuthContext). Renamed from mockData.ts (2026-07-20 review): the former
// mockTenants demo array was dead and removed long ago.
//
// ════════════════════════════════════════════════════════════════════════════
// PHASE 1 of docs/29-permissions-and-de-reporting-line.md (founder-approved
// 2026-07-27). Every page now declares its tier, and the default is DENY.
//
// ⚠ WHY DEFAULT-DENY. This file used to end in `return true` — any page not
// named in a tier list was visible to every tenant role. That is not a policy,
// it is the absence of one, and it produced two real bugs on the same day:
//
//   · systems_connectors was open to everyone while the action it exists for
//     (set_connector_secret) required owner/admin in the database, so we showed
//     people a page whose primary button could not work for them
//   · ops_activity — the tenant-WIDE activity log, every action by every human
//     and every digital employee — was readable by read_only accounts
//
// Neither was decided. Both were defaults. With DENY as the default, a new page
// is invisible until somebody states who it is for, which turns "we forgot" into
// a missing-nav-item bug (loud, harmless) instead of an access leak (silent).
//
// ⚠ THIS FILE IS NOT A SECURITY BOUNDARY. It hides navigation. Real enforcement
// is per-action in the database — RLS policies and checks inside SECURITY
// DEFINER functions. Connectors was the good example: open in the nav, closed
// in the database, so nothing ever leaked. Never let this file be the only gate.
// ════════════════════════════════════════════════════════════════════════════

const DT_ROLES: UserRole[] = ['dt_super_admin', 'dt_god_access', 'dt_support', 'dt_billing'];

const OWNER: UserRole[] = ['tenant_owner'];
const ADMIN: UserRole[] = ['tenant_owner', 'tenant_admin'];
const MANAGE: UserRole[] = ['tenant_owner', 'tenant_admin', 'tenant_manager'];
/** Manage tier plus the knowledge specialist — curating knowledge is their job. */
const KNOWLEDGE: UserRole[] = [...MANAGE, 'knowledge_manager'];
/** Manage tier plus the approver — clearing the approval queue is their job. */
const APPROVALS: UserRole[] = [...MANAGE, 'approver'];
/** Every tenant role, including read_only. Write protection is server-side:
 *  RLS write policies have excluded read_only since migration 136. */
const ALL_TENANT: UserRole[] = [...MANAGE, 'knowledge_manager', 'approver', 'tenant_user', 'read_only'];

/**
 * Every page, and who may open it. A page missing from this map is DENIED.
 *
 * Tiers marked "extrapolated" are not in the founder-approved matrix in
 * docs/29 §4 — they were assigned here by the tighten-first rule: where a page
 * carries money, payroll, risk or people data and no decision exists, it starts
 * at MANAGE. Loosening later is a one-line change with a known blast radius;
 * discovering a junior seat has been reading payroll is not.
 *
 * Safe to be strict right now: only tenant_owner and tenant_admin are assigned
 * to anyone across all live workspaces, so every tier below ADMIN is currently
 * unobservable in production.
 */
const PAGE_ACCESS: Partial<Record<Page, UserRole[]>> = {
  // ── Platform operators only — never a customer's nav ──────────────────────
  platform_home: [],
  platform_tenants: [],
  platform_team: [],
  platform_health: [],
  platform_revenue: [],
  platform_security: [],
  // Trust & Architecture is an internal transparency doc ("how DreamTeam is
  // built · what we haven't done yet"), not a tenant feature.
  gov_trust: [],

  // ── Everyday workspace ────────────────────────────────────────────────────
  dashboard: ALL_TENANT,
  workforce_des: ALL_TENANT,
  workforce_de_file: ALL_TENANT,
  workforce_chat: ALL_TENANT,
  support_inbox: ALL_TENANT,
  browser_operator: ALL_TENANT,
  systems_playbooks: ALL_TENANT,
  knowledge_library: ALL_TENANT,
  eu_chat: ALL_TENANT,

  // ── Customers and the journey hubs ────────────────────────────────────────
  entity_customer: ALL_TENANT,
  entity_customer_bd: ALL_TENANT,
  entity_customer_sales: ALL_TENANT,
  entity_customer_onboarding: ALL_TENANT,
  entity_customer_support: ALL_TENANT,
  entity_customer_success: ALL_TENANT,
  entity_customer_renewal: ALL_TENANT,
  entity_commercial_continuity: ALL_TENANT,

  // ── Vendors (descoped for live tenants, routes kept for deep links) ───────
  entity_vendor: ALL_TENANT,
  entity_vendor_sourcing: ALL_TENANT,
  entity_vendor_contracts: ALL_TENANT,
  entity_vendor_management: ALL_TENANT,

  // ── Our People — payroll is extrapolated to MANAGE (human pay data) ───────
  entity_workforce: ALL_TENANT,
  entity_workforce_talent: ALL_TENANT,
  entity_workforce_onboarding: ALL_TENANT,
  entity_workforce_development: ALL_TENANT,
  entity_workforce_payroll: MANAGE,

  // ── Outcomes — money and risk extrapolated to MANAGE ──────────────────────
  outcomes: ALL_TENANT,
  outcome_revenue: ALL_TENANT,
  outcome_delivery: ALL_TENANT,
  outcome_financial: MANAGE,
  outcome_risk: MANAGE,

  // ── Specialists — finance and people extrapolated to MANAGE ───────────────
  specialist_technical: ALL_TENANT,
  specialist_legal: ALL_TENANT,
  specialist_finance_deep: MANAGE,
  specialist_people: MANAGE,

  // ── Knowledge curation ────────────────────────────────────────────────────
  knowledge_ingestion: KNOWLEDGE,
  knowledge_gaps: KNOWLEDGE,
  knowledge_quality: KNOWLEDGE,
  // Deciding who may READ knowledge is workspace administration, not curation.
  knowledge_permissions: ADMIN,

  // ── Approvals ─────────────────────────────────────────────────────────────
  ops_human_tasks: APPROVALS,

  // ── Tenant-wide activity (see the header note) ────────────────────────────
  ops_activity: MANAGE,
  ops_de_activity: MANAGE,

  // ── Support configuration ─────────────────────────────────────────────────
  support_command_center: MANAGE,
  support_triage_rules: MANAGE,

  // ── Workforce analytics and evaluation ────────────────────────────────────
  intelligence_performance: MANAGE,
  intelligence_learning: MANAGE,
  intelligence_evals: MANAGE,
  intelligence_insights: MANAGE,

  // ── Governance ────────────────────────────────────────────────────────────
  gov_compliance: MANAGE,
  gov_audit: MANAGE,
  gov_data_access: MANAGE,
  gov_identity_inventory: MANAGE,
  gov_security: ADMIN,

  // ── Connected systems — MANAGE by founder decision 1 (docs/29 §1) ─────────
  // ⚠ This one is NOT just a nav tier. Managers were granted real connector
  // access, which required adding tenant_manager to set_connector_secret — the
  // function that stores credentials for a customer's systems of record. The
  // nav and the database must stay in agreement here; if that grant is ever
  // reverted, this must move back to ADMIN in the same change.
  systems_connectors: MANAGE,

  // ── Workspace administration ──────────────────────────────────────────────
  company_setup: ADMIN,
  onboarding_architect: ADMIN,
  settings: ADMIN,
  users: ADMIN,
};

export const canAccessPage = (role: UserRole, page: Page, layer?: 'platform' | 'tenant' | 'end_user'): boolean => {
  const isDtRole = DT_ROLES.includes(role) || layer === 'platform';

  const allowed = PAGE_ACCESS[page];
  // Default DENY. An unlisted page is a page nobody has decided about.
  if (!allowed) return false;

  // An empty list means platform operators only.
  if (allowed.length === 0) return isDtRole;
  // Platform operators see every tenant page — that is what remote access is.
  if (isDtRole) return true;

  return allowed.includes(role);
};

// ════════════════════════════════════════════════════════════════════════════
// Settings tabs — founder decisions 2 and 3 (docs/29 §1, §4)
//
// Settings is one page holding very different things: workspace vocabulary
// sits beside billing, SSO, data export and workspace deletion. Tiering the
// whole page to ADMIN would keep managers out of settings they legitimately
// own; tiering it to MANAGE would hand them billing. So the tabs are tiered
// individually.
//
// Decision 3: Owner outranks Admin on exactly two things — billing, and
// deleting the workspace. Everything else they share. An Admin who can do both
// is an Owner with a different label.
// ════════════════════════════════════════════════════════════════════════════

export type SettingsTab =
  | 'general' | 'ai_engine' | 'usage' | 'widget'
  | 'identity' | 'data' | 'billing' | 'security';

const SETTINGS_TAB_ACCESS: Record<SettingsTab, UserRole[]> = {
  // Name, industry, vocabulary, tone — the settings a manager actually owns.
  general: MANAGE,
  // Spend visibility is useful to a manager running a team of DEs.
  usage: MANAGE,
  // Embed keys and the public widget — an external surface.
  widget: ADMIN,
  // Domains, SSO enforcement, SCIM provisioning — controls who gets in at all.
  identity: ADMIN,
  // Export is admin; DELETION inside this tab is owner-only and enforced
  // separately in the database, not by hiding the tab.
  data: ADMIN,
  // Decision 3.
  billing: OWNER,
  security: ADMIN,
  // Shared platform-wide LLM keys — DreamTeam staff only, never a tenant's.
  ai_engine: [],
};

/**
 * May this role open this Settings tab?
 *
 * Same contract as canAccessPage: an empty list means platform staff only, and
 * platform staff see everything else. Hiding a tab is presentation — the
 * destructive actions inside (delete workspace, rotate keys) are enforced in
 * the database regardless of what the UI renders.
 */
export const canAccessSettingsTab = (
  role: UserRole,
  tab: SettingsTab,
  layer?: 'platform' | 'tenant' | 'end_user',
): boolean => {
  const isDtRole = DT_ROLES.includes(role) || layer === 'platform';
  const allowed = SETTINGS_TAB_ACCESS[tab];
  if (!allowed) return false;
  if (allowed.length === 0) return isDtRole;
  if (isDtRole) return true;
  return allowed.includes(role);
};
