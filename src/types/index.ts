// ============================================================
// TYPES - 3-LAYER ARCHITECTURE
// ============================================================

export type PlatformPage =
  | 'platform_home'
  | 'platform_tenants'
  | 'platform_team'
  | 'platform_health'
  | 'platform_revenue'
  | 'platform_security'
  | 'platform_ai_engine'
  // What customers asked for that we cannot staff (migrations 744 + 750).
  | 'platform_demand';

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
  // ⚠ CLOSED 2026-08-20 — the nine Vendor/Partner and Workforce-entity keys
  // were REMOVED FROM THIS UNION, not merely denied. They were descoped by the
  // founder on 2026-07-09 ("Vendor Management and Workforce/HR both stay
  // design-preview demos, not real backends"), but stayed routed, stayed
  // mapped to a URL, and stayed ALL_TENANT in navAccess — so /vendor,
  // /workforce-entity and their seven sub-paths rendered fabricated TCP/PWC
  // demo data to anyone who typed the address. The Sidebar had hidden the nav
  // entries since Wave 3; hiding a link is not closing a route.
  //
  // Removing the keys from the union IS the enforcement, and it is why this
  // note sits in a type file: PAGE_TO_URL is Record<Page, string> and
  // PAGE_ACCESS is Partial<Record<Page, UserRole[]>>, so re-adding a URL or a
  // tier for any of the nine is now a COMPILE ERROR in two other files rather
  // than a one-line policy edit nobody reviews. Deleted with them:
  // src/pages/tenant/entity/VendorPages.tsx and WorkforcePages.tsx (both
  // recoverable at a5f03af6), their App.tsx routes, their Sidebar block and
  // their DEChatDock branches. Pinned by tests/closed-pages.test.ts.
  //
  // ⚠ workforce_chat is NOT part of this and stays open by decision — the
  // founder named the vendor and workforce-ENTITY pages only.

  // ── Outcomes (what the company achieves) ─────────
  | 'outcomes'                  // Wave 3: THE single real reporting surface (live tenants)
  | 'outcome_revenue'           // Revenue & pipeline health
  | 'outcome_delivery'          // Product/service delivery (industry-named)
  | 'outcome_financial'         // Financial health: AP/AR, reporting, tax
  | 'outcome_risk'              // Risk & Compliance

  // ── Workforce (DE management) ─────────────────────
  | 'workforce_des'             // Digital Employees roster (incl. individual profiles)
  | 'workforce_hire'            // Hiring wizard — a page, not a modal (handoff 11)
  | 'workforce_de_file'         // Employee File — one DE's page (?de=<id> deep link)
  | 'workforce_chat'            // Conversational Workforce Hub (manage DEs via chat)

  // ── Knowledge ─────────────────────────────────────
  | 'knowledge_library'         // Knowledge library
  | 'knowledge_ingestion'       // Ingest sources
  | 'knowledge_gaps'            // Gap detection & resolution
  | 'knowledge_quality'         // Freshness, coverage, confidence
  | 'knowledge_permissions'     // Who can see what — spaces, presets, effective access

  // ── Systems ───────────────────────────────────────
  | 'systems_connectors'        // All integrations
  | 'systems_mcp'               // MCP servers — connect, tool inventory, allowlist (the home MCP never had)
  | 'systems_playbooks'         // Workflow library

  // ── Operations ────────────────────────────────────
  | 'ops_human_tasks'           // Approval gates, escalations, review
  | 'ops_activity'              // Activity log
  | 'ops_de_activity'           // Live "DE at work" queue — proactive triage (migration 034)
  | 'support_command_center'    // Support Command Center — operator one-glance view
  | 'support_triage_rules'      // Support triage-rules editor (config for mig 233)
  | 'support_inbox'             // Support inbox — human side of the conversation=ticket (Phase 2)
  | 'support_calls'             // Calls — voice-channel review: transcript, recording, messages left (docs/42)
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
  | 'discovery_interview'    // The plain-English setup conversation — offered at first login, re-openable from Setup
  | 'discovery_proposals'    // "What we recommend" — what that conversation drafted, accepted item by item

  // ── Admin ─────────────────────────────────────────
  | 'settings'
  | 'users'
  | 'organisation'
  | 'my_profile'

  // ── Phone ─────────────────────────────────────────
  // ONE surface, not a shrunken copy of the other fifty-five (handoff 13).
  // Deliberately a ROUTE rather than a breakpoint, so no desktop layout is
  // ever asked to reflow to 375px: decisions, alerts, and a read-only summary
  // of the day. Everything else says "this needs a bigger screen".
  | 'mobile';

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
  /**
   * Relations this person holds on ANY digital employee, from de_assignments
   * (migration 385) — the ASSIGNMENT axis of docs/29, kept separate from
   * `role` on purpose. Used by canAccessPage to open pages the role tier
   * alone would deny (e.g. a DE's reporting-line manager reaching its
   * approvals queue). Undefined means "not loaded yet" and is treated as
   * none, so nav can only widen once it arrives, never narrow.
   */
  deRelations?: Array<'primary' | 'manager' | 'executive'>;
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
  /** Which provider account this workspace's model calls are billed to.
   *  'platform' = ours (its token budget is set by its plan, platform-side);
   *  'byo' = its own keys, its own bill, and it may set its own budget.
   *  Set only from the platform console via set_tenant_llm_key_mode (mig 633). */
  llmKeyMode?: 'platform' | 'byo';
}
