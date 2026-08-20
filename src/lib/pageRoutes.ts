// ── URL ↔ Page mapping ──────────────────────────────────────────
//
// Lives here, not in App.tsx, because TWO modules have to agree on it:
// URLSync reconciles the two directions, and AuthContext has to know
// whether a cold load is a deep link before it picks a landing page.
// When only App.tsx knew, the restore path chose dashboard blind and
// clobbered the deep link a beat after URLSync had adopted it.

import type { Page } from '../types';
// Record<Page, string> (not Record<string, string>) so adding a new Page
// without a URL mapping is a compile error, not a silently-dead nav link —
// an unmapped page used to make URLSync bounce every click straight back.
export const PAGE_TO_URL: Record<Page, string> = {
  platform_home:                '/platform',
  platform_tenants:             '/platform/tenants',
  platform_team:                '/platform/team',
  platform_security:            '/platform/security',
  platform_health:              '/platform/health',
  platform_revenue:             '/platform/revenue',
  platform_ai_engine:           '/platform/ai-engine',
  platform_demand:              '/platform/demand',
  dashboard:              '/dashboard',
  users:                  '/users',
  organisation:                 '/organisation',
  my_profile:                   '/my-profile',
  // Short on purpose — this is a URL people type on a phone keyboard.
  mobile:                       '/m',
  settings:               '/settings',
  eu_chat:                '/chat',
  // Entities
  entity_customer:            '/customer',
  entity_customer_bd:         '/customer/bd',
  entity_customer_sales:      '/customer/sales',
  entity_customer_onboarding: '/customer/onboarding',
  entity_customer_support:    '/customer/support',
  entity_customer_success:    '/customer/success',
  entity_customer_renewal:    '/customer/renewal',
  entity_commercial_continuity: '/customer/continuity',
  // ⚠ CLOSED 2026-08-20 — /vendor, /vendor/sourcing, /vendor/contracts,
  // /vendor/management, /workforce-entity and its four sub-paths are GONE from
  // this map, so URL_TO_PAGE (the exact reverse, built below) no longer knows
  // those nine addresses at all. A bookmarked /vendor therefore never becomes a
  // pending deep link in URLSync: the effect is one replace-navigation to
  // /dashboard, which is what the person already had open. No blank screen, no
  // crash, no "page not found" for a page that was never theirs to lose.
  //
  // Deleting the URL was not enough on its own and is not the only guard — the
  // nine keys are out of the `Page` union too, which is what makes re-adding a
  // line here a compile error rather than a decision. See src/types/index.ts.
  // Outcomes
  outcomes:           '/outcomes',
  outcome_revenue:    '/outcomes/revenue',
  outcome_delivery:   '/outcomes/delivery',
  outcome_financial:  '/outcomes/financial',
  outcome_risk:       '/outcomes/risk',
  // Workforce (DEs)
  workforce_des:       '/workforce/des',
  workforce_hire:      '/workforce/hire',
  workforce_de_file:   '/workforce/employee',
  workforce_chat:      '/workforce/chat',
  // Knowledge
  knowledge_library:   '/knowledge/library',
  knowledge_ingestion: '/knowledge/ingestion',
  knowledge_gaps:      '/knowledge/gaps',
  knowledge_quality:   '/knowledge/quality',
  knowledge_permissions: '/knowledge/permissions',
  // Systems
  systems_connectors: '/systems/connectors',
  systems_mcp: '/systems/mcp',
  systems_playbooks:  '/systems/playbooks',
  // Operations
  ops_human_tasks: '/ops/tasks',
  ops_activity:    '/ops/activity',
  ops_de_activity: '/ops/de-activity',
  support_command_center: '/support/command-center',
  support_triage_rules: '/support/triage-rules',
  support_inbox: '/support/inbox',
  support_calls: '/support/calls',
  browser_operator: '/autonomy/browser-operator',
  // Intelligence
  intelligence_performance: '/intelligence/performance',
  intelligence_learning:    '/intelligence/learning',
  intelligence_evals:       '/intelligence/proving-ground',
  intelligence_insights:    '/intelligence/insights',
  // Governance
  gov_compliance: '/governance/compliance',
  gov_audit:      '/governance/audit',
  gov_security:   '/governance/security',
  gov_trust:      '/governance/trust',
  gov_data_access: '/governance/data-access',
  gov_identity_inventory: '/governance/identity-credentials',
  // Setup
  company_setup:  '/setup',
  onboarding_architect: '/setup/quick-start',
  discovery_interview: '/setup/discovery',
  discovery_proposals: '/setup/discovery-proposals',
};

export const URL_TO_PAGE: Record<string, Page> = Object.fromEntries(
  Object.entries(PAGE_TO_URL).map(([page, url]) => [url, page as Page])
);
