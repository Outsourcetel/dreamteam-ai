// ============================================================
// KNOWLEDGE SEED DATA — extracted from the retired AgentWorkforcePage
// Used by KnowledgeDataPage (Phase-4 migration pending)
// ============================================================

// ---- Local types used by this page ----
type ConnectorCategory =
  | 'crm'
  | 'billing'
  | 'hr'
  | 'support'
  | 'analytics'
  | 'storage'
  | 'communication'
  | 'custom';

type ConnectorStatus = 'connected' | 'disconnected' | 'error' | 'syncing';
type FieldPermission = 'read' | 'write' | 'none';

// ---- Local data types for knowledge/connectors used in Knowledge & Data tab ----
type KnowledgeItemType =
  | 'article'
  | 'release_note'
  | 'resolved_ticket'
  | 'file'
  | 'video'
  | 'policy';

interface KnowledgeSubSectionLocal {
  id: string;
  label: string;
  articleCount: number;
}
interface KnowledgeSectionLocal {
  id: string;
  label: string;
  subSections: KnowledgeSubSectionLocal[];
}
interface KnowledgeModuleLocal {
  id: string;
  label: string;
  sections: KnowledgeSectionLocal[];
}
interface KnowledgeProductLocal {
  id: string;
  label: string;
  color: string;
  modules: KnowledgeModuleLocal[];
}

interface KnowledgeItem {
  id: string;
  title: string;
  type: KnowledgeItemType;
  audience: string;
  productId: string;
  moduleId: string;
  sectionId: string;
  subSectionId: string;
  tags: string[];
  subTags: string[];
  summary: string;
  author: string;
  version: string;
  createdAt: string;
  updatedAt: string;
  freshnessScore: number;
  viewCount: number;
  helpfulRating: number;
  embedStatus: 'indexed' | 'pending' | 'stale' | 'failed';
  chunkCount: number;
}

interface ImportedFile {
  id: string;
  name: string;
  type: string;
  size: string;
  uploadedAt: string;
  uploadedBy: string;
  status: 'indexed' | 'processing' | 'failed';
  chunkCount: number;
  productId?: string;
  moduleId?: string;
  sectionId?: string;
  audience: string;
  tags: string[];
}

interface ConnectorField {
  name: string;
  type: string;
  description: string;
  pii: boolean;
  defaultPermission: FieldPermission;
}

interface ConnectorObject {
  name: string;
  label: string;
  fields: ConnectorField[];
}

interface AgentBinding {
  agentId: string;
  objects: {
    objectName: string;
    fieldPermissions: Record<string, FieldPermission>;
  }[];
}

interface RegisteredConnector {
  id: string;
  name: string;
  category: ConnectorCategory;
  icon: string;
  status: ConnectorStatus;
  lastSync: string;
  syncFrequency: string;
  recordCount: number;
  objects: ConnectorObject[];
  agentBindings: AgentBinding[];
}

// ============================================================
// DATA — knowledge tags
// ============================================================

export const knowledgeTags: { id: string; label: string }[] = [
  { id: 't1', label: 'policy' },
  { id: 't2', label: 'onboarding' },
  { id: 't3', label: 'compliance' },
  { id: 't4', label: 'product' },
  { id: 't5', label: 'pricing' },
  { id: 't6', label: 'hr' },
  { id: 't7', label: 'finance' },
  { id: 't8', label: 'support' },
  { id: 't9', label: 'legal' },
  { id: 't10', label: 'technical' },
];

// ============================================================
// DATA — knowledge taxonomy
// ============================================================

export const knowledgeTaxonomy: KnowledgeProductLocal[] = [
  {
    id: 'p1',
    label: 'DreamTeam Platform',
    color: '#6366f1',
    modules: [
      {
        id: 'm1',
        label: 'Getting Started',
        sections: [
          {
            id: 's1',
            label: 'Onboarding',
            subSections: [
              { id: 'ss1', label: 'Account Setup', articleCount: 8 },
              { id: 'ss2', label: 'First Login', articleCount: 4 },
              { id: 'ss3', label: 'Workspace Configuration', articleCount: 6 },
            ],
          },
          {
            id: 's2',
            label: 'Quick Start Guides',
            subSections: [
              { id: 'ss4', label: 'Admin Quick Start', articleCount: 5 },
              { id: 'ss5', label: 'End-User Quick Start', articleCount: 3 },
            ],
          },
        ],
      },
      {
        id: 'm2',
        label: 'Agent Management',
        sections: [
          {
            id: 's3',
            label: 'Creating Agents',
            subSections: [
              { id: 'ss6', label: 'Agent Templates', articleCount: 12 },
              { id: 'ss7', label: 'Custom Agent Builder', articleCount: 9 },
              { id: 'ss8', label: 'Agent Cloning', articleCount: 3 },
            ],
          },
          {
            id: 's4',
            label: 'Agent Configuration',
            subSections: [
              { id: 'ss9', label: 'LLM Model Selection', articleCount: 7 },
              { id: 'ss10', label: 'Pipeline Design', articleCount: 11 },
              { id: 'ss11', label: 'Validation Bots', articleCount: 6 },
            ],
          },
          {
            id: 's5',
            label: 'Agent Monitoring',
            subSections: [
              { id: 'ss12', label: 'Performance Metrics', articleCount: 5 },
              { id: 'ss13', label: 'Failure Alerts', articleCount: 4 },
            ],
          },
        ],
      },
      {
        id: 'm3',
        label: 'Knowledge Hub',
        sections: [
          {
            id: 's6',
            label: 'Content Management',
            subSections: [
              { id: 'ss14', label: 'Article Creation', articleCount: 7 },
              { id: 'ss15', label: 'Taxonomy Management', articleCount: 5 },
              { id: 'ss16', label: 'Bulk Import', articleCount: 4 },
            ],
          },
          {
            id: 's7',
            label: 'Ingestion & Sync',
            subSections: [
              { id: 'ss17', label: 'Connector Ingestion', articleCount: 8 },
              { id: 'ss18', label: 'Release Note Sync', articleCount: 3 },
              { id: 'ss19', label: 'Ticket Learning', articleCount: 6 },
            ],
          },
        ],
      },
      {
        id: 'm4',
        label: 'Billing & Subscriptions',
        sections: [
          {
            id: 's8',
            label: 'Plans & Pricing',
            subSections: [
              { id: 'ss20', label: 'Plan Comparison', articleCount: 5 },
              { id: 'ss21', label: 'Token Budgets', articleCount: 4 },
              { id: 'ss22', label: 'Upgrade Paths', articleCount: 3 },
            ],
          },
          {
            id: 's9',
            label: 'Invoices & Payments',
            subSections: [
              { id: 'ss23', label: 'Invoice Downloads', articleCount: 3 },
              { id: 'ss24', label: 'Payment Methods', articleCount: 4 },
              { id: 'ss25', label: 'Refund Policy', articleCount: 5 },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'p2',
    label: 'Customer Portal',
    color: '#10b981',
    modules: [
      {
        id: 'm5',
        label: 'Customer Self-Service',
        sections: [
          {
            id: 's10',
            label: 'Account Management',
            subSections: [
              { id: 'ss26', label: 'Profile Settings', articleCount: 6 },
              { id: 'ss27', label: 'Password & Security', articleCount: 8 },
              { id: 'ss28', label: 'Team Members', articleCount: 4 },
            ],
          },
          {
            id: 's11',
            label: 'AI Chat Help',
            subSections: [
              { id: 'ss29', label: 'How to use AI Chat', articleCount: 5 },
              { id: 'ss30', label: 'Agent Capabilities', articleCount: 7 },
              { id: 'ss31', label: 'Escalation Process', articleCount: 3 },
            ],
          },
        ],
      },
      {
        id: 'm6',
        label: 'Support & Tickets',
        sections: [
          {
            id: 's12',
            label: 'Ticket Management',
            subSections: [
              { id: 'ss32', label: 'Creating Tickets', articleCount: 4 },
              { id: 'ss33', label: 'Ticket Statuses', articleCount: 3 },
              { id: 'ss34', label: 'Priority Levels', articleCount: 2 },
            ],
          },
          {
            id: 's13',
            label: 'Workforce Actions',
            subSections: [
              { id: 'ss35', label: 'Requesting Actions', articleCount: 6 },
              { id: 'ss36', label: 'Approvals Explained', articleCount: 4 },
              { id: 'ss37', label: 'Audit Trail', articleCount: 3 },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'p3',
    label: 'Integrations & APIs',
    color: '#f59e0b',
    modules: [
      {
        id: 'm7',
        label: 'API Reference',
        sections: [
          {
            id: 's14',
            label: 'Authentication',
            subSections: [
              { id: 'ss38', label: 'API Keys', articleCount: 4 },
              { id: 'ss39', label: 'OAuth 2.0', articleCount: 5 },
              { id: 'ss40', label: 'Webhook Secrets', articleCount: 3 },
            ],
          },
          {
            id: 's15',
            label: 'Endpoints',
            subSections: [
              { id: 'ss41', label: 'Agent Endpoints', articleCount: 12 },
              { id: 'ss42', label: 'Knowledge Endpoints', articleCount: 8 },
              { id: 'ss43', label: 'Webhook Events', articleCount: 9 },
            ],
          },
        ],
      },
      {
        id: 'm8',
        label: 'Native Integrations',
        sections: [
          {
            id: 's16',
            label: 'CRM',
            subSections: [
              { id: 'ss44', label: 'Salesforce Setup', articleCount: 7 },
              { id: 'ss45', label: 'HubSpot Setup', articleCount: 6 },
              { id: 'ss46', label: 'Pipedrive Setup', articleCount: 4 },
            ],
          },
          {
            id: 's17',
            label: 'Helpdesk',
            subSections: [
              { id: 'ss47', label: 'Zendesk Setup', articleCount: 8 },
              { id: 'ss48', label: 'Intercom Setup', articleCount: 6 },
              { id: 'ss49', label: 'Freshdesk Setup', articleCount: 5 },
            ],
          },
        ],
      },
    ],
  },
];

export const mockKnowledgeItems: KnowledgeItem[] = [
  {
    id: 'ki1',
    title: 'How to Request a Refund',
    type: 'article',
    audience: 'Customer',
    productId: 'p1',
    moduleId: 'm4',
    sectionId: 's9',
    subSectionId: 'ss25',
    tags: ['billing', 'refund'],
    subTags: ['refund', 'credit'],
    summary:
      'Step-by-step guide for customers requesting refunds through the portal or by contacting support.',
    author: 'Sarah Kim',
    version: '2.1',
    createdAt: '2025-11-01',
    updatedAt: '2026-06-10',
    freshnessScore: 98,
    viewCount: 4821,
    helpfulRating: 94,
    embedStatus: 'indexed',
    chunkCount: 6,
  },
  {
    id: 'ki2',
    title: 'Understanding Your Invoice',
    type: 'article',
    audience: 'Both',
    productId: 'p1',
    moduleId: 'm4',
    sectionId: 's9',
    subSectionId: 'ss23',
    tags: ['billing'],
    subTags: ['invoice', 'payment'],
    summary:
      'Explains each line item on the DreamTeam monthly invoice including token usage, seat costs, and add-ons.',
    author: 'James Patel',
    version: '3.0',
    createdAt: '2025-09-15',
    updatedAt: '2026-05-22',
    freshnessScore: 95,
    viewCount: 3210,
    helpfulRating: 91,
    embedStatus: 'indexed',
    chunkCount: 8,
  },
  {
    id: 'ki3',
    title: 'Setting Up Two-Factor Authentication',
    type: 'article',
    audience: 'Customer',
    productId: 'p2',
    moduleId: 'm5',
    sectionId: 's10',
    subSectionId: 'ss27',
    tags: ['security'],
    subTags: ['2fa', 'password'],
    summary:
      'Complete guide to enabling and managing 2FA on your account using authenticator apps or SMS.',
    author: 'Maria Chen',
    version: '1.4',
    createdAt: '2025-08-20',
    updatedAt: '2026-06-01',
    freshnessScore: 99,
    viewCount: 5643,
    helpfulRating: 97,
    embedStatus: 'indexed',
    chunkCount: 5,
  },
  {
    id: 'ki4',
    title: 'Agent Pipeline Design Best Practices',
    type: 'article',
    audience: 'Internal',
    productId: 'p1',
    moduleId: 'm2',
    sectionId: 's4',
    subSectionId: 'ss10',
    tags: ['agents'],
    subTags: ['pipeline', 'configuration'],
    summary:
      'Internal guide covering optimal pipeline stage ordering, confidence threshold tuning, and validation bot selection for different use cases.',
    author: 'Alex Rivera',
    version: '1.2',
    createdAt: '2026-01-10',
    updatedAt: '2026-06-15',
    freshnessScore: 100,
    viewCount: 892,
    helpfulRating: 98,
    embedStatus: 'indexed',
    chunkCount: 14,
  },
  {
    id: 'ki5',
    title: 'Salesforce CRM Integration Setup',
    type: 'article',
    audience: 'Both',
    productId: 'p3',
    moduleId: 'm8',
    sectionId: 's16',
    subSectionId: 'ss44',
    tags: ['integrations'],
    subTags: ['crm', 'oauth'],
    summary:
      'Complete walkthrough for connecting Salesforce to DreamTeam including OAuth flow, field mapping, and sync configuration.',
    author: 'Jordan Blake',
    version: '2.3',
    createdAt: '2025-10-05',
    updatedAt: '2026-04-18',
    freshnessScore: 87,
    viewCount: 2107,
    helpfulRating: 89,
    embedStatus: 'indexed',
    chunkCount: 11,
  },
  {
    id: 'ki6',
    title: 'Release Notes v4.2 — Agent Enhancements',
    type: 'release_note',
    audience: 'Both',
    productId: 'p1',
    moduleId: 'm2',
    sectionId: 's4',
    subSectionId: 'ss9',
    tags: ['release-notes'],
    subTags: ['v4-2', 'improvements'],
    summary:
      'New multi-model routing, sub-agent orchestration improvements, and validation bot thresholds made configurable per action type.',
    author: 'Product Team',
    version: '4.2',
    createdAt: '2026-05-01',
    updatedAt: '2026-05-01',
    freshnessScore: 100,
    viewCount: 8941,
    helpfulRating: 96,
    embedStatus: 'indexed',
    chunkCount: 7,
  },
  {
    id: 'ki7',
    title: 'Resolved: Billing Agent double-charge on plan upgrade',
    type: 'resolved_ticket',
    audience: 'Internal',
    productId: 'p1',
    moduleId: 'm4',
    sectionId: 's8',
    subSectionId: 'ss22',
    tags: ['billing', 'troubleshooting'],
    subTags: ['subscription', 'known-issues'],
    summary:
      'Root cause analysis and resolution for billing agent incorrectly triggering two charges on same-day plan upgrades. Patched in v4.1.3.',
    author: 'Support Team',
    version: '4.1.3',
    createdAt: '2026-03-14',
    updatedAt: '2026-03-14',
    freshnessScore: 92,
    viewCount: 441,
    helpfulRating: 100,
    embedStatus: 'indexed',
    chunkCount: 4,
  },
  {
    id: 'ki8',
    title: 'RBAC Roles and Permissions Reference',
    type: 'policy',
    audience: 'Internal',
    productId: 'p1',
    moduleId: 'm1',
    sectionId: 's1',
    subSectionId: 'ss3',
    tags: ['security'],
    subTags: ['rbac', 'permissions'],
    summary:
      'Complete reference for all 8 RBAC roles across DT Platform and Tenant tiers — what each role can access, configure, and execute.',
    author: 'Alex Rivera',
    version: '2.0',
    createdAt: '2025-07-01',
    updatedAt: '2026-06-01',
    freshnessScore: 96,
    viewCount: 1823,
    helpfulRating: 99,
    embedStatus: 'indexed',
    chunkCount: 9,
  },
  {
    id: 'ki9',
    title: 'How to Submit a Support Ticket',
    type: 'article',
    audience: 'Customer',
    productId: 'p2',
    moduleId: 'm6',
    sectionId: 's12',
    subSectionId: 'ss32',
    tags: ['troubleshooting'],
    subTags: ['faq'],
    summary:
      'Guide for customers on submitting, tracking, and escalating support tickets through the Customer Portal.',
    author: 'Sarah Kim',
    version: '1.0',
    createdAt: '2025-06-15',
    updatedAt: '2026-03-10',
    freshnessScore: 88,
    viewCount: 9102,
    helpfulRating: 93,
    embedStatus: 'indexed',
    chunkCount: 5,
  },
  {
    id: 'ki10',
    title: 'Knowledge Taxonomy Design Guide',
    type: 'article',
    audience: 'Internal',
    productId: 'p1',
    moduleId: 'm3',
    sectionId: 's6',
    subSectionId: 'ss15',
    tags: ['knowledge'],
    subTags: ['taxonomy', 'articles'],
    summary:
      'Internal guide for content authors on how to correctly classify articles using the Product-Module-Section-SubSection hierarchy and tagging system.',
    author: 'Jordan Blake',
    version: '1.1',
    createdAt: '2026-02-01',
    updatedAt: '2026-06-18',
    freshnessScore: 100,
    viewCount: 347,
    helpfulRating: 97,
    embedStatus: 'indexed',
    chunkCount: 8,
  },
  {
    id: 'ki11',
    title: 'Plan Upgrade Guide — Enterprise Features',
    type: 'article',
    audience: 'Customer',
    productId: 'p1',
    moduleId: 'm4',
    sectionId: 's8',
    subSectionId: 'ss22',
    tags: ['billing'],
    subTags: ['subscription', 'upgrade'],
    summary:
      'Everything included in the Enterprise plan upgrade: dedicated support, unlimited agents, custom SLA, and white-labelling.',
    author: 'James Patel',
    version: '2.0',
    createdAt: '2026-01-20',
    updatedAt: '2026-06-05',
    freshnessScore: 97,
    viewCount: 3421,
    helpfulRating: 95,
    embedStatus: 'indexed',
    chunkCount: 6,
  },
  {
    id: 'ki12',
    title: 'SSO Configuration with Okta',
    type: 'article',
    audience: 'Both',
    productId: 'p3',
    moduleId: 'm7',
    sectionId: 's14',
    subSectionId: 'ss39',
    tags: ['security', 'integrations'],
    subTags: ['sso', 'oauth'],
    summary:
      'Step-by-step for configuring single sign-on using Okta as the identity provider with SAML 2.0 or OIDC.',
    author: 'Maria Chen',
    version: '1.3',
    createdAt: '2025-12-01',
    updatedAt: '2026-05-10',
    freshnessScore: 94,
    viewCount: 1654,
    helpfulRating: 96,
    embedStatus: 'indexed',
    chunkCount: 10,
  },
];

export const mockImportedFiles: ImportedFile[] = [
  {
    id: 'f1',
    name: 'HR_Policy_Handbook_2026.pdf',
    type: 'PDF',
    size: '2.4 MB',
    uploadedAt: '2026-06-01',
    uploadedBy: 'Alex Rivera',
    status: 'indexed',
    chunkCount: 142,
    productId: 'p1',
    moduleId: 'm1',
    sectionId: 's1',
    audience: 'Internal',
    tags: ['onboarding', 'security'],
  },
  {
    id: 'f2',
    name: 'Product_Pricing_Sheet_Q2_2026.xlsx',
    type: 'XLSX',
    size: '340 KB',
    uploadedAt: '2026-06-10',
    uploadedBy: 'Jordan Blake',
    status: 'indexed',
    chunkCount: 28,
    productId: 'p1',
    moduleId: 'm4',
    sectionId: 's8',
    audience: 'Both',
    tags: ['billing'],
  },
  {
    id: 'f3',
    name: 'Compliance_Audit_Report_2025.docx',
    type: 'DOCX',
    size: '1.1 MB',
    uploadedAt: '2026-04-15',
    uploadedBy: 'Maria Chen',
    status: 'indexed',
    chunkCount: 87,
    productId: 'p1',
    moduleId: 'm1',
    audience: 'Internal',
    tags: ['security', 'troubleshooting'],
  },
  {
    id: 'f4',
    name: 'Customer_Onboarding_Deck.pptx',
    type: 'PPTX',
    size: '5.2 MB',
    uploadedAt: '2026-05-20',
    uploadedBy: 'Sarah Kim',
    status: 'indexed',
    chunkCount: 64,
    productId: 'p2',
    moduleId: 'm5',
    audience: 'Customer',
    tags: ['onboarding'],
  },
  {
    id: 'f5',
    name: 'API_Reference_v4.2.md',
    type: 'MD',
    size: '890 KB',
    uploadedAt: '2026-06-15',
    uploadedBy: 'Alex Rivera',
    status: 'indexed',
    chunkCount: 211,
    productId: 'p3',
    moduleId: 'm7',
    audience: 'Both',
    tags: ['integrations'],
  },
  {
    id: 'f6',
    name: 'Sales_Battlecard_Competitive_Analysis.pdf',
    type: 'PDF',
    size: '1.8 MB',
    uploadedAt: '2026-06-18',
    uploadedBy: 'Jordan Blake',
    status: 'processing',
    chunkCount: 0,
    audience: 'Internal',
    tags: ['agents'],
  },
];

export const registeredConnectors: RegisteredConnector[] = [
  {
    id: 'dc1',
    name: 'Salesforce CRM',
    category: 'crm',
    icon: 'SF',
    status: 'connected',
    lastSync: '5 min ago',
    syncFrequency: 'Real-time',
    recordCount: 14821,
    objects: [
      {
        name: 'Contact',
        label: 'Contact',
        fields: [
          { name: 'id', type: 'string', description: 'Unique contact ID', pii: false, defaultPermission: 'read' },
          { name: 'firstName', type: 'string', description: 'First name', pii: true, defaultPermission: 'read' },
          { name: 'lastName', type: 'string', description: 'Last name', pii: true, defaultPermission: 'read' },
          { name: 'email', type: 'string', description: 'Email address', pii: true, defaultPermission: 'read' },
          { name: 'accountId', type: 'string', description: 'Parent account ID', pii: false, defaultPermission: 'read' },
          { name: 'lastActivity', type: 'date', description: 'Last interaction date', pii: false, defaultPermission: 'read' },
        ],
      },
      {
        name: 'Account',
        label: 'Account / Company',
        fields: [
          { name: 'id', type: 'string', description: 'Account ID', pii: false, defaultPermission: 'read' },
          { name: 'name', type: 'string', description: 'Company name', pii: false, defaultPermission: 'read' },
          { name: 'plan', type: 'string', description: 'Subscription plan', pii: false, defaultPermission: 'read' },
          { name: 'mrr', type: 'number', description: 'Monthly recurring revenue', pii: false, defaultPermission: 'none' },
          { name: 'healthScore', type: 'number', description: 'Account health score', pii: false, defaultPermission: 'read' },
        ],
      },
      {
        name: 'Opportunity',
        label: 'Deal / Opportunity',
        fields: [
          { name: 'id', type: 'string', description: 'Opportunity ID', pii: false, defaultPermission: 'read' },
          { name: 'name', type: 'string', description: 'Deal name', pii: false, defaultPermission: 'read' },
          { name: 'stage', type: 'string', description: 'Deal stage', pii: false, defaultPermission: 'read' },
          { name: 'amount', type: 'number', description: 'Deal value', pii: false, defaultPermission: 'none' },
          { name: 'closeDate', type: 'date', description: 'Expected close date', pii: false, defaultPermission: 'read' },
        ],
      },
    ],
    agentBindings: [
      {
        agentId: 'a8',
        objects: [
          { objectName: 'Contact', fieldPermissions: { id: 'read', firstName: 'read', lastName: 'read', email: 'read', accountId: 'read', lastActivity: 'read' } },
          { objectName: 'Account', fieldPermissions: { id: 'read', name: 'read', plan: 'read', mrr: 'none', healthScore: 'read' } },
          { objectName: 'Opportunity', fieldPermissions: { id: 'read', name: 'read', stage: 'read', amount: 'none', closeDate: 'read' } },
        ],
      },
    ],
  },
  {
    id: 'dc2',
    name: 'Stripe Billing',
    category: 'billing',
    icon: 'ST',
    status: 'connected',
    lastSync: '2 min ago',
    syncFrequency: 'Real-time',
    recordCount: 8234,
    objects: [
      {
        name: 'Customer',
        label: 'Billing Customer',
        fields: [
          { name: 'id', type: 'string', description: 'Stripe customer ID', pii: false, defaultPermission: 'read' },
          { name: 'email', type: 'string', description: 'Billing email', pii: true, defaultPermission: 'read' },
          { name: 'balance', type: 'number', description: 'Current balance / credit', pii: false, defaultPermission: 'read' },
          { name: 'defaultPaymentMethod', type: 'string', description: 'Default payment method ID', pii: false, defaultPermission: 'none' },
        ],
      },
      {
        name: 'Invoice',
        label: 'Invoice',
        fields: [
          { name: 'id', type: 'string', description: 'Invoice ID', pii: false, defaultPermission: 'read' },
          { name: 'amount', type: 'number', description: 'Invoice total in cents', pii: false, defaultPermission: 'read' },
          { name: 'status', type: 'string', description: 'paid / open / void', pii: false, defaultPermission: 'read' },
          { name: 'periodStart', type: 'date', description: 'Billing period start', pii: false, defaultPermission: 'read' },
          { name: 'periodEnd', type: 'date', description: 'Billing period end', pii: false, defaultPermission: 'read' },
          { name: 'lineItems', type: 'array', description: 'Invoice line items', pii: false, defaultPermission: 'read' },
        ],
      },
      {
        name: 'Subscription',
        label: 'Subscription',
        fields: [
          { name: 'id', type: 'string', description: 'Subscription ID', pii: false, defaultPermission: 'read' },
          { name: 'plan', type: 'string', description: 'Plan name', pii: false, defaultPermission: 'read' },
          { name: 'status', type: 'string', description: 'active / past_due / cancelled', pii: false, defaultPermission: 'read' },
          { name: 'currentPeriodEnd', type: 'date', description: 'Next billing date', pii: false, defaultPermission: 'read' },
          { name: 'cancelAtPeriodEnd', type: 'boolean', description: 'Cancellation scheduled', pii: false, defaultPermission: 'read' },
        ],
      },
    ],
    agentBindings: [
      {
        agentId: 'a3',
        objects: [
          { objectName: 'Customer', fieldPermissions: { id: 'read', email: 'read', balance: 'read', defaultPaymentMethod: 'none' } },
          { objectName: 'Invoice', fieldPermissions: { id: 'read', amount: 'read', status: 'read', periodStart: 'read', periodEnd: 'read', lineItems: 'read' } },
          { objectName: 'Subscription', fieldPermissions: { id: 'read', plan: 'read', status: 'read', currentPeriodEnd: 'read', cancelAtPeriodEnd: 'read' } },
        ],
      },
    ],
  },
  {
    id: 'dc3',
    name: 'BambooHR',
    category: 'hr',
    icon: 'HR',
    status: 'connected',
    lastSync: '1 hr ago',
    syncFrequency: 'Every 4 hours',
    recordCount: 342,
    objects: [
      {
        name: 'Employee',
        label: 'Employee Record',
        fields: [
          { name: 'id', type: 'string', description: 'Employee ID', pii: false, defaultPermission: 'read' },
          { name: 'firstName', type: 'string', description: 'First name', pii: true, defaultPermission: 'read' },
          { name: 'lastName', type: 'string', description: 'Last name', pii: true, defaultPermission: 'read' },
          { name: 'department', type: 'string', description: 'Department', pii: false, defaultPermission: 'read' },
          { name: 'role', type: 'string', description: 'Job title', pii: false, defaultPermission: 'read' },
          { name: 'startDate', type: 'date', description: 'Employment start date', pii: false, defaultPermission: 'read' },
          { name: 'salary', type: 'number', description: 'Annual salary', pii: true, defaultPermission: 'none' },
          { name: 'leaveBalance', type: 'number', description: 'Remaining leave days', pii: false, defaultPermission: 'read' },
        ],
      },
      {
        name: 'LeaveRequest',
        label: 'Leave Request',
        fields: [
          { name: 'id', type: 'string', description: 'Request ID', pii: false, defaultPermission: 'read' },
          { name: 'employeeId', type: 'string', description: 'Employee reference', pii: false, defaultPermission: 'read' },
          { name: 'type', type: 'string', description: 'Leave type', pii: false, defaultPermission: 'read' },
          { name: 'status', type: 'string', description: 'approved / pending / rejected', pii: false, defaultPermission: 'read' },
          { name: 'startDate', type: 'date', description: 'Leave start date', pii: false, defaultPermission: 'read' },
          { name: 'endDate', type: 'date', description: 'Leave end date', pii: false, defaultPermission: 'read' },
        ],
      },
    ],
    agentBindings: [
      {
        agentId: 'a2',
        objects: [
          { objectName: 'Employee', fieldPermissions: { id: 'read', firstName: 'read', lastName: 'read', department: 'read', role: 'read', startDate: 'read', salary: 'none', leaveBalance: 'read' } },
          { objectName: 'LeaveRequest', fieldPermissions: { id: 'read', employeeId: 'read', type: 'read', status: 'read', startDate: 'read', endDate: 'read' } },
        ],
      },
      {
        agentId: 'a7',
        objects: [
          { objectName: 'Employee', fieldPermissions: { id: 'read', firstName: 'read', lastName: 'read', department: 'read', role: 'read', startDate: 'read', salary: 'none', leaveBalance: 'read' } },
        ],
      },
    ],
  },
  {
    id: 'dc4',
    name: 'Zendesk Support',
    category: 'support',
    icon: 'ZD',
    status: 'connected',
    lastSync: '10 min ago',
    syncFrequency: 'Every 15 min',
    recordCount: 42187,
    objects: [
      {
        name: 'Ticket',
        label: 'Support Ticket',
        fields: [
          { name: 'id', type: 'number', description: 'Ticket number', pii: false, defaultPermission: 'read' },
          { name: 'subject', type: 'string', description: 'Ticket subject', pii: false, defaultPermission: 'read' },
          { name: 'status', type: 'string', description: 'open / pending / solved / closed', pii: false, defaultPermission: 'read' },
          { name: 'priority', type: 'string', description: 'low / normal / high / urgent', pii: false, defaultPermission: 'read' },
          { name: 'tags', type: 'array', description: 'Ticket tags', pii: false, defaultPermission: 'read' },
          { name: 'resolution', type: 'string', description: 'Resolution summary', pii: false, defaultPermission: 'read' },
        ],
      },
      {
        name: 'Article',
        label: 'Help Center Article',
        fields: [
          { name: 'id', type: 'number', description: 'Article ID', pii: false, defaultPermission: 'read' },
          { name: 'title', type: 'string', description: 'Article title', pii: false, defaultPermission: 'read' },
          { name: 'body', type: 'string', description: 'Full article body', pii: false, defaultPermission: 'read' },
          { name: 'section', type: 'string', description: 'Help section', pii: false, defaultPermission: 'read' },
          { name: 'updatedAt', type: 'date', description: 'Last updated', pii: false, defaultPermission: 'read' },
        ],
      },
    ],
    agentBindings: [
      {
        agentId: 'a1',
        objects: [
          { objectName: 'Ticket', fieldPermissions: { id: 'read', subject: 'read', status: 'read', priority: 'read', tags: 'read', resolution: 'read' } },
          { objectName: 'Article', fieldPermissions: { id: 'read', title: 'read', body: 'read', section: 'read', updatedAt: 'read' } },
        ],
      },
    ],
  },
  {
    id: 'dc5',
    name: 'Google Analytics',
    category: 'analytics',
    icon: 'GA',
    status: 'connected',
    lastSync: '1 hr ago',
    syncFrequency: 'Daily',
    recordCount: 0,
    objects: [
      {
        name: 'PageView',
        label: 'Page Views',
        fields: [
          { name: 'page', type: 'string', description: 'Page path', pii: false, defaultPermission: 'read' },
          { name: 'sessions', type: 'number', description: 'Session count', pii: false, defaultPermission: 'read' },
          { name: 'bounceRate', type: 'number', description: 'Bounce rate %', pii: false, defaultPermission: 'read' },
          { name: 'avgDuration', type: 'number', description: 'Avg session duration', pii: false, defaultPermission: 'read' },
        ],
      },
    ],
    agentBindings: [
      {
        agentId: 'a8',
        objects: [
          { objectName: 'PageView', fieldPermissions: { page: 'read', sessions: 'read', bounceRate: 'read', avgDuration: 'read' } },
        ],
      },
    ],
  },
  {
    id: 'dc6',
    name: 'Google Drive / Files',
    category: 'storage',
    icon: 'GD',
    status: 'connected',
    lastSync: '30 min ago',
    syncFrequency: 'Every hour',
    recordCount: 1847,
    objects: [
      {
        name: 'File',
        label: 'File / Document',
        fields: [
          { name: 'id', type: 'string', description: 'File ID', pii: false, defaultPermission: 'read' },
          { name: 'name', type: 'string', description: 'File name', pii: false, defaultPermission: 'read' },
          { name: 'mimeType', type: 'string', description: 'MIME type', pii: false, defaultPermission: 'read' },
          { name: 'content', type: 'string', description: 'Parsed text content', pii: false, defaultPermission: 'read' },
          { name: 'modifiedAt', type: 'date', description: 'Last modified', pii: false, defaultPermission: 'read' },
        ],
      },
    ],
    agentBindings: [
      {
        agentId: 'a1',
        objects: [
          { objectName: 'File', fieldPermissions: { id: 'read', name: 'read', mimeType: 'read', content: 'read', modifiedAt: 'read' } },
        ],
      },
      {
        agentId: 'a7',
        objects: [
          { objectName: 'File', fieldPermissions: { id: 'read', name: 'read', mimeType: 'read', content: 'read', modifiedAt: 'read' } },
        ],
      },
    ],
  },
];

