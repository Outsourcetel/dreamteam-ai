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
  | 'dashboard'
  | 'agents'
  | 'agent_overview'
  | 'agent_builder'
  | 'agent_testing'
  | 'agent_deployments'
  | 'hub_overview'
  | 'hub_articles'
  | 'hub_ingestion'
  | 'hub_training'
  | 'hub_analytics'
  | 'portal_overview'
  | 'portal_conversations'
  | 'portal_actions'
  | 'portal_approvals'
  | 'portal_tickets'
  | 'portal_escalations'
  | 'portal_settings'
  | 'insight'
  | 'swarm'
  | 'security'
  | 'admin_overview'
  | 'admin_rbac'
  | 'admin_approvals'
  | 'admin_audit'
  | 'admin_compliance'
  | 'integrations'
  | 'connectors'
  | 'settings'
  | 'knowledge_data'
  | 'knowledge_taxonomy'
  | 'knowledge_connectors'
  | 'knowledge_files'
  | 'finance'
  | 'revenue'
  | 'hr';

export type EndUserPage = 'chat' | 'history' | 'profile';

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

export type KnowledgeTag = {
  id: string;
  label: string;
  color: string;
};

export type KnowledgeSubSection = { id: string; label: string };
export type KnowledgeSection = {
  id: string;
  label: string;
  subsections: KnowledgeSubSection[];
};
export type KnowledgeModule = {
  id: string;
  label: string;
  icon: string;
  sections: KnowledgeSection[];
};
export type KnowledgeProduct = {
  id: string;
  label: string;
  color: string;
  modules: KnowledgeModule[];
};

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

export interface ValidationBot {
  id: string;
  name: string;
  rule: string;
  action: 'flag' | 'block' | 'escalate';
}

export interface PipelineStage {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  config: Record<string, any>;
}

export interface AgentModelConfig {
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  fallbackModel: string;
}

export interface AgentDef {
  id: string;
  name: string;
  description: string;
  audience: KnowledgeAudience;
  status: 'active' | 'draft' | 'paused';
  pipeline: PipelineStage[];
  validators: ValidationBot[];
  modelConfig: AgentModelConfig;
  connectors: string[];
  intents: string[];
  confidenceThreshold: number;
  autoResolveThreshold: number;
  escalationThreshold: number;
}
