// ============================================================
// TYPES - 3-LAYER ARCHITECTURE
// ============================================================

export type PlatformPage =
  | 'platform_home'
  | 'platform_tenants'
  | 'platform_team'
  | 'platform_health'
  | 'platform_revenue'
  | 'platform_security';

export type TenantPage =
  // ── Home ──────────────────────────────────────────
  | 'dashboard'

  // ── Entities (what the company serves/manages) ───
  // Customer entity
  | 'entity_customer'           // Customer lifecycle overview
  | 'entity_customer_bd'        // Business Development sub-function
  | 'entity_customer_sales'     // Sales sub-function
  | 'entity_customer_onboarding'// Onboarding & Implementation
  | 'entity_customer_support'   // Support
  | 'entity_customer_success'   // Customer Success
  | 'entity_customer_renewal'   // Renewal & Expansion
  | 'entity_commercial_continuity' // Commercial Continuity (renewals, reorders, warranties, vendor)
  // Vendor/Partner entity
  | 'entity_vendor'
  | 'entity_vendor_sourcing'
  | 'entity_vendor_contracts'
  | 'entity_vendor_management'
  // Workforce entity
  | 'entity_workforce'
  | 'entity_workforce_talent'
  | 'entity_workforce_onboarding'
  | 'entity_workforce_development'
  | 'entity_workforce_payroll'

  // ── Outcomes (what the company achieves) ─────────
  | 'outcomes'                  // Wave 3: THE single real reporting surface (live tenants)
  | 'outcome_revenue'           // Revenue & pipeline health
  | 'outcome_delivery'          // Product/service delivery (industry-named)
  | 'outcome_financial'         // Financial health: AP/AR, reporting, tax
  | 'outcome_risk'              // Risk & Compliance

  // ── Specialist Functions (called on demand) ───────
  | 'specialist_technical'
  | 'specialist_legal'
  | 'specialist_finance_deep'
  | 'specialist_people'

  // ── Workforce (DE management) ─────────────────────
  | 'workforce_des'             // Digital Employees roster (incl. individual profiles)
  | 'workforce_chat'            // Conversational Workforce Hub (manage DEs via chat)

  // ── Knowledge ─────────────────────────────────────
  | 'knowledge_library'         // Knowledge library
  | 'knowledge_ingestion'       // Ingest sources
  | 'knowledge_gaps'            // Gap detection & resolution
  | 'knowledge_quality'         // Freshness, coverage, confidence

  // ── Systems ───────────────────────────────────────
  | 'systems_connectors'        // All integrations
  | 'systems_playbooks'         // Workflow library

  // ── Operations ────────────────────────────────────
  | 'ops_human_tasks'           // Approval gates, escalations, review
  | 'ops_activity'              // Activity log
  | 'ops_de_activity'           // Live "DE at work" queue — proactive triage (migration 034)
  | 'support_command_center'    // Support Command Center — operator one-glance view
  | 'support_triage_rules'      // Support triage-rules editor (config for mig 233)
  | 'support_inbox'             // Support inbox — human side of the conversation=ticket (Phase 2)
  | 'browser_operator'         // Browser Operator — governed DE browser automation (mig 182/241)

  // ── Intelligence ──────────────────────────────────
  | 'intelligence_performance'  // DE analytics
  | 'intelligence_learning'     // Org-level self-learning configuration
  | 'intelligence_evals'        // Proving Ground — DE eval harness
  | 'intelligence_insights'     // Business insights & anomalies

  // ── Governance ────────────────────────────────────
  | 'gov_compliance'            // Industry guardrails & compliance templates
  | 'gov_audit'                 // Immutable audit trail
  | 'gov_security'              // Access, SSO, API keys, sessions
  | 'gov_trust'                 // Trust & Architecture — security-review posture
  | 'gov_data_access'           // Data Access — per-DE/specialist × system grants (default-deny)
  | 'gov_identity_inventory'    // Identity & Credentials — every DE/specialist's grants, trust & connector health, one view

  // ── Company Setup ─────────────────────────────────
  | 'company_setup'
  | 'onboarding_architect'   // Quick Start — Ada proposes your DreamTeam setup

  // ── Admin ─────────────────────────────────────────
  | 'settings'
  | 'users';

export type EndUserPage = 'eu_chat';

export type Page = PlatformPage | TenantPage | EndUserPage;

export type UserRole =
  | 'dt_super_admin'
  | 'dt_god_access'
  | 'dt_support'
  | 'dt_billing'
  | 'tenant_owner'
  | 'tenant_admin'
  | 'tenant_manager'
  // Wave 5: the three assignable roles this union was silently missing —
  // they were second-class at the type level (see useUsers.ts TenantRole).
  | 'knowledge_manager'
  | 'approver'
  | 'tenant_user'
  | 'read_only';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  tenantId?: string | null;
  avatar?: string;
  layer?: 'platform' | 'tenant' | 'end_user';
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  logo?: string;
  primaryColor: string;
  accentColor?: string;
  plan: 'starter' | 'growth' | 'enterprise';
  status: 'active' | 'trial' | 'suspended';
  agentsActive: number;
  usersCount: number;
  monthlyTokens: number;
  tokenLimit: number;
  createdAt: string;
  industry: string;
  contactEmail: string;
  /** Wave 4 — per-tenant work-object relabeling (see lib/vocabulary.ts). */
  vocabulary?: Record<string, string>;
  // Tenant hierarchy (migration 050) — parentTenantId null = top-level tenant.
  parentTenantId?: string | null;
  allowSelfServeSubtenants?: boolean;
  trialEndsAt?: string | null;
}
