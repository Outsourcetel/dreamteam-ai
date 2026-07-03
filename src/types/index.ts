// ============================================================
// TYPES - 3-LAYER ARCHITECTURE
// ============================================================

export type PlatformPage =
  | 'platform_home'
  | 'platform_tenants'
  | 'platform_health'
  | 'platform_revenue'
  | 'platform_remote_access';

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

  // ── Intelligence ──────────────────────────────────
  | 'intelligence_performance'  // DE analytics
  | 'intelligence_insights'     // Business insights & anomalies

  // ── Governance ────────────────────────────────────
  | 'gov_compliance'            // Industry guardrails & compliance templates
  | 'gov_audit'                 // Immutable audit trail
  | 'gov_security'              // Access, SSO, API keys, sessions

  // ── Company Setup ─────────────────────────────────
  | 'company_setup'

  // ── Legacy pages (kept pending Phase-4 migration) ─
  | 'hub_overview'
  | 'hub_articles'
  | 'hub_review'
  | 'hub_ingestion'
  | 'hub_training'
  | 'hub_analytics'
  | 'security'
  | 'admin_overview'
  | 'admin_rbac'
  | 'admin_approvals'
  | 'admin_audit'
  | 'admin_compliance'
  | 'connectors'
  | 'settings'
  | 'knowledge_data'
  | 'knowledge_taxonomy'
  | 'knowledge_connectors'
  | 'knowledge_files'
  | 'audit_log'
  | 'users'
  | 'playbooks';

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
  | 'tenant_user';

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
}

// ---- Knowledge types ----

export type KnowledgeItemType = 'article' | 'faq' | 'sop' | 'policy' | 'training';
export type KnowledgeAudience = 'customer' | 'internal' | 'both';
export type EmbedStatus = 'embedded' | 'pending' | 'draft';

export interface KnowledgeItem {
  id: string;
  title: string;
  type: KnowledgeItemType;
  audience: KnowledgeAudience;
  productId: string;
  moduleId: string;
  sectionId: string;
  tags: string[];
  status: EmbedStatus;
  updatedAt: string;
  author: string;
  views: number;
  helpful: number;
}

export type ConnectorCategory = 'crm' | 'billing' | 'hr' | 'support' | 'analytics' | 'storage';
export type ConnectorStatus = 'connected' | 'disconnected' | 'error';
export type FieldPermission = 'read' | 'write' | 'none';

export interface ConnectorField {
  name: string;
  type: string;
  description: string;
  pii: boolean;
}

export interface ConnectorObject {
  name: string;
  fields: ConnectorField[];
  fieldPermissions: Record<string, FieldPermission>;
}

export interface AgentConnectorBinding {
  agentId: string;
  permissions: ('read' | 'write' | 'trigger')[];
}

export interface RegisteredConnector {
  id: string;
  name: string;
  category: ConnectorCategory;
  status: ConnectorStatus;
  icon: string;
  description: string;
  objects: ConnectorObject[];
  agentBindings: AgentConnectorBinding[];
  lastSynced: string;
}

export interface ImportedFile {
  id: string;
  name: string;
  type: string;
  size: string;
  uploadedBy: string;
  uploadedAt: string;
  status: 'indexed' | 'processing' | 'failed';
  productId: string;
  moduleId: string;
  audience: KnowledgeAudience;
  tags: string[];
  chunkCount: number;
}
