import React, { useState, useEffect, useRef } from 'react'
import { AuthUser, Tenant, Page } from '../../types'
import { Badge, StatCard, Modal, PageTabs, AGENT_TABS } from '../../components'
import { useDigitalEmployees } from '../../lib/useDigitalEmployees'
import type { StoredDE } from '../../lib/useDigitalEmployees'
import HireModal from '../../components/HireModal'
import { DE_CATALOG } from '../../lib/deCatalog'
import type { CatalogDE } from '../../lib/deCatalog'
import { DETestPanel } from '../../components/DETestPanel'
import { MODELS, PROVIDER_LABELS, TIER_COLORS, TASK_TYPES, DEFAULT_MODEL_ID, DEFAULT_PROVIDER } from '../../lib/models'
import type { ModelProvider } from '../../lib/models'
import { fetchKnowledgeArticles, fetchTenantProfiles } from '../../lib/api'
import type { DBProfile } from '../../lib/api'

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

interface ValidationBot {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  threshold: number;
  action: 'flag' | 'block' | 'escalate' | 'log';
}

interface PipelineStage {
  id: string;
  name: string;
  type: 'retrieval' | 'reasoning' | 'validation' | 'action' | 'response';
  enabled: boolean;
  config: Record<string, any>;
}

interface AgentModelConfig {
  provider: 'anthropic' | 'openai' | 'google' | 'custom';
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  ragEnabled: boolean;
  ragTopK: number;
  contextWindow: number;
  fallback_model?: string;
  fallback_provider?: string;
  latency_threshold_ms?: number;
  route_by_task?: boolean;
  task_routes?: { simple: { model: string; provider: string }; complex: { model: string; provider: string }; code: { model: string; provider: string } };
  token_budget?: { monthly_limit: number; hard_limit: boolean };
  persona?: { tone: string; opening_greeting: string; closing_signature: string; avoid_phrases: string; always_mention: string };
  escalation_tiers?: Array<{ tier: number; assignee_id: string; trigger_confidence: number; after_minutes: number; channel: 'inapp' | 'email' | 'both' }>;
}

interface AgentDef {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: 'Customer' | 'Internal';
  status: 'active' | 'idle' | 'disabled';
  capabilities: string[];
  triggers: string[];
  actions: string[];
  requiredApproval: boolean;
  confidenceThreshold: number;
  tasksThisMonth: number;
  successRate: number;
  knowledgeSources: string[];
  memoryEnabled: boolean;
  multiAgentEnabled: boolean;
  subAgents: string[];
  modelConfig: AgentModelConfig;
  pipeline: PipelineStage[];
  validationBots: ValidationBot[];
}

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

// ── DE Catalog Section Component ──────────────────────────────
const DECatalogSection = ({
  accentColor,
  enabledIds,
  onEnable,
}: {
  accentColor: string;
  enabledIds: string[];
  onEnable: (cat: CatalogDE) => void;
}) => {
  const [expanded, setExpanded] = useState(true);
  const [catFilter, setCatFilter] = useState<'all' | 'Customer' | 'Internal'>('all');

  const available = DE_CATALOG.filter(c => {
    const alreadyEnabled = enabledIds.some(id =>
      // match by catalog id stored in hook, or by name if seeded from defaults
      id === c.id || id.startsWith('a') // default agents don't block catalog
    );
    // Only block if explicitly hired from catalog (id starts with cat_)
    const blockByExactId = enabledIds.includes(c.id);
    return !blockByExactId;
  });

  const filtered = available.filter(c => catFilter === 'all' || c.category === catFilter);

  return (
    <div className="mt-8 border-t border-slate-800 pt-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold text-white">Digital Employee Catalog</h2>
          <p className="text-xs text-slate-500 mt-0.5">{available.length} Digital Employees available to enable for your organization</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex gap-1 bg-slate-800 rounded-lg p-1">
            {(['all', 'Customer', 'Internal'] as const).map(f => (
              <button key={f} onClick={() => setCatFilter(f)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all ${catFilter === f ? 'text-white' : 'text-slate-400 hover:text-white'}`}
                style={catFilter === f ? { backgroundColor: accentColor } : {}}>
                {f === 'all' ? 'All' : f}
              </button>
            ))}
          </div>
          <button onClick={() => setExpanded(e => !e)}
            className="text-xs text-slate-500 hover:text-slate-300 transition-all">
            {expanded ? '▲ Collapse' : '▼ Expand'}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(cat => (
            <div key={cat.id} className="bg-slate-900 border border-slate-800 rounded-xl p-4 hover:border-slate-700 transition-all flex flex-col">
              <div className="flex items-start gap-3 mb-3">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg font-bold text-white flex-shrink-0"
                  style={{ backgroundColor: accentColor + '25' }}>
                  {cat.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-white">{cat.name}</div>
                  <div className="text-xs text-slate-500">{cat.department}</div>
                </div>
                <span className={`text-xs px-1.5 py-0.5 rounded flex-shrink-0 ${cat.category === 'Customer' ? 'text-blue-400 bg-blue-400/10' : 'text-purple-400 bg-purple-400/10'}`}>
                  {cat.category}
                </span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed mb-3 flex-1">{cat.description}</p>
              <div className="flex flex-wrap gap-1 mb-4">
                {cat.tags.map(t => (
                  <span key={t} className="text-xs px-1.5 py-0.5 rounded bg-slate-800 text-slate-500">{t}</span>
                ))}
              </div>
              <div className="flex items-center justify-between pt-3 border-t border-slate-800">
                <div className="text-xs text-slate-600">{cat.defaultThreshold}% threshold · {cat.defaultChannels.length} channels</div>
                <button
                  onClick={() => onEnable(cat)}
                  className="text-xs px-3 py-1.5 rounded-lg text-white font-medium transition-all"
                  style={{ backgroundColor: accentColor }}>
                  Enable
                </button>
              </div>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="col-span-3 py-8 text-center text-slate-600 text-sm">
              All Digital Employees in this category are already enabled.
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────

const defaultAgents: AgentDef[] = [
  {
    id: 'a1',
    name: 'Support Agent',
    description:
      'Handles tier-1 customer support using the knowledge base. Retrieves articles, reasons over context, validates confidence, and responds or escalates.',
    icon: 'S',
    category: 'Customer',
    status: 'active',
    capabilities: ['KB Search', 'Ticket Creation', 'Email Dispatch', 'Customer Lookup'],
    triggers: ['New chat message', 'Email received', 'Ticket created'],
    actions: ['Search KB', 'Reply to customer', 'Create ticket', 'Escalate to human'],
    requiredApproval: false,
    confidenceThreshold: 80,
    tasksThisMonth: 1284,
    successRate: 96,
    knowledgeSources: ['Product KB', 'Release Notes', 'Past Resolved Tickets'],
    memoryEnabled: true,
    multiAgentEnabled: true,
    subAgents: ['a5'],
    modelConfig: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      temperature: 0.3,
      maxTokens: 2048,
      systemPrompt:
        'You are a helpful support agent. Use the retrieved knowledge to answer questions accurately. If confidence is below threshold, escalate to a human agent.',
      ragEnabled: true,
      ragTopK: 5,
      contextWindow: 100000,
    },
    pipeline: [
      { id: 'p1', name: 'Intent Classification', type: 'reasoning', enabled: true, config: { model: 'fast', threshold: 0.7 } },
      { id: 'p2', name: 'KB Retrieval', type: 'retrieval', enabled: true, config: { topK: 5, minScore: 0.6, sources: 'all' } },
      { id: 'p3', name: 'Context Reasoning', type: 'reasoning', enabled: true, config: { temperature: 0.3, chainOfThought: true } },
      { id: 'p4', name: 'Validation Gate', type: 'validation', enabled: true, config: { minConfidence: 80, blockBelow: 60 } },
      { id: 'p5', name: 'Response Generation', type: 'response', enabled: true, config: { tone: 'helpful', maxLength: 300 } },
    ],
    validationBots: [
      { id: 'v1', name: 'Confidence Reviewer', type: 'confidence_reviewer', enabled: true, threshold: 80, action: 'escalate' },
      { id: 'v2', name: 'Knowledge Checker', type: 'knowledge_checker', enabled: true, threshold: 70, action: 'flag' },
      { id: 'v3', name: 'Safety Guard', type: 'safety_guard', enabled: true, threshold: 95, action: 'block' },
      { id: 'v4', name: 'Hallucination Detector', type: 'hallucination_detector', enabled: true, threshold: 85, action: 'escalate' },
    ],
  },
  {
    id: 'a2',
    name: 'Onboarding Agent',
    description:
      'Guides new employees through onboarding. Answers HR questions, assigns training modules, and sends personalised welcome communications.',
    icon: 'O',
    category: 'Internal',
    status: 'active',
    capabilities: ['HR KB Access', 'Email Notifications', 'Training Assignment', 'Progress Tracking'],
    triggers: ['New employee added', 'Onboarding form submitted', 'Day-1 trigger'],
    actions: ['Send welcome email', 'Assign training modules', 'Answer HR questions', 'Update HR system'],
    requiredApproval: false,
    confidenceThreshold: 85,
    tasksThisMonth: 342,
    successRate: 99,
    knowledgeSources: ['HR Policies', 'Training Catalogue', 'Employee Handbook'],
    memoryEnabled: true,
    multiAgentEnabled: false,
    subAgents: [],
    modelConfig: {
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.2,
      maxTokens: 1500,
      systemPrompt:
        'You are an HR onboarding assistant. Guide new employees warmly and accurately through their first days. Always reference official HR policies.',
      ragEnabled: true,
      ragTopK: 4,
      contextWindow: 128000,
    },
    pipeline: [
      { id: 'p1', name: 'Employee Context Load', type: 'retrieval', enabled: true, config: { source: 'hr_system', fields: 'role,dept,startDate' } },
      { id: 'p2', name: 'Policy Retrieval', type: 'retrieval', enabled: true, config: { topK: 4, source: 'hr_kb' } },
      { id: 'p3', name: 'Personalised Reasoning', type: 'reasoning', enabled: true, config: { temperature: 0.2, personalise: true } },
      { id: 'p4', name: 'Compliance Check', type: 'validation', enabled: true, config: { checkPolicy: true } },
      { id: 'p5', name: 'Response + Action', type: 'action', enabled: true, config: { canEmail: true, canAssignTraining: true } },
    ],
    validationBots: [
      { id: 'v1', name: 'Confidence Reviewer', type: 'confidence_reviewer', enabled: true, threshold: 85, action: 'escalate' },
      { id: 'v2', name: 'Compliance Bot', type: 'compliance_bot', enabled: true, threshold: 90, action: 'block' },
      { id: 'v3', name: 'Safety Guard', type: 'safety_guard', enabled: true, threshold: 95, action: 'block' },
    ],
  },
  {
    id: 'a3',
    name: 'Billing Agent',
    description:
      'Manages billing inquiries, subscription changes, invoice generation, and refund requests with full audit trail and approval gates for transactions.',
    icon: 'B',
    category: 'Customer',
    status: 'active',
    capabilities: ['Invoice Lookup', 'Subscription Management', 'Refund Processing', 'Payment Plans'],
    triggers: ['Billing inquiry', 'Payment failed', 'Upgrade/downgrade request', 'Refund request'],
    actions: ['Lookup invoice', 'Apply credit', 'Process refund', 'Update subscription', 'Send receipt'],
    requiredApproval: true,
    confidenceThreshold: 92,
    tasksThisMonth: 567,
    successRate: 98,
    knowledgeSources: ['Billing Policies', 'Pricing Catalogue', 'Customer Accounts'],
    memoryEnabled: true,
    multiAgentEnabled: true,
    subAgents: ['a6'],
    modelConfig: {
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.1,
      maxTokens: 1024,
      systemPrompt:
        'You are a billing specialist. Handle financial queries with precision. Never process refunds or subscription changes without reaching 92% confidence. Flag borderline cases for human review.',
      ragEnabled: true,
      ragTopK: 3,
      contextWindow: 128000,
    },
    pipeline: [
      { id: 'p1', name: 'Account Retrieval', type: 'retrieval', enabled: true, config: { source: 'billing_system', authenticate: true } },
      { id: 'p2', name: 'Intent + Amount Parse', type: 'reasoning', enabled: true, config: { extractAmount: true, extractPeriod: true } },
      { id: 'p3', name: 'Policy Check', type: 'validation', enabled: true, config: { checkRefundPolicy: true, checkPeriod: true } },
      { id: 'p4', name: 'Risk Assessment', type: 'validation', enabled: true, config: { maxAutoAmount: 100, requireApprovalAbove: 100 } },
      { id: 'p5', name: 'Transaction Execution', type: 'action', enabled: true, config: { requireApproval: true, auditLog: true } },
    ],
    validationBots: [
      { id: 'v1', name: 'Confidence Reviewer', type: 'confidence_reviewer', enabled: true, threshold: 92, action: 'block' },
      { id: 'v2', name: 'Compliance Bot', type: 'compliance_bot', enabled: true, threshold: 90, action: 'escalate' },
      { id: 'v3', name: 'Safety Guard', type: 'safety_guard', enabled: true, threshold: 99, action: 'block' },
      { id: 'v4', name: 'Hallucination Detector', type: 'hallucination_detector', enabled: true, threshold: 90, action: 'block' },
    ],
  },
  {
    id: 'a4',
    name: 'Account Agent',
    description:
      'Handles account management requests — password resets, profile updates, access management, and 2FA. Operates with conservative confidence thresholds.',
    icon: 'A',
    category: 'Customer',
    status: 'active',
    capabilities: ['Profile Management', 'Access Control', 'Security Actions', 'Notifications'],
    triggers: ['Account change request', 'Security alert', 'Profile update'],
    actions: ['Reset password', 'Update profile', 'Revoke session', 'Enable 2FA', 'Send verification'],
    requiredApproval: true,
    confidenceThreshold: 90,
    tasksThisMonth: 892,
    successRate: 97,
    knowledgeSources: ['Security Policies', 'Account FAQs', 'Identity KB'],
    memoryEnabled: false,
    multiAgentEnabled: false,
    subAgents: [],
    modelConfig: {
      provider: 'anthropic',
      model: 'claude-haiku-3-5',
      temperature: 0.1,
      maxTokens: 512,
      systemPrompt:
        'You are a security-focused account management agent. Always verify identity signals before taking account actions. When in doubt, do not act.',
      ragEnabled: true,
      ragTopK: 2,
      contextWindow: 200000,
    },
    pipeline: [
      { id: 'p1', name: 'Identity Verification', type: 'validation', enabled: true, config: { requireSessionToken: true, checkMFA: true } },
      { id: 'p2', name: 'Request Classification', type: 'reasoning', enabled: true, config: { classifyRisk: true } },
      { id: 'p3', name: 'Policy Retrieval', type: 'retrieval', enabled: true, config: { source: 'security_kb', topK: 2 } },
      { id: 'p4', name: 'Risk Gate', type: 'validation', enabled: true, config: { highRiskActions: 'revokeSession,resetPassword', requireApproval: true } },
      { id: 'p5', name: 'Secure Action', type: 'action', enabled: true, config: { auditLog: true, notifyUser: true } },
    ],
    validationBots: [
      { id: 'v1', name: 'Confidence Reviewer', type: 'confidence_reviewer', enabled: true, threshold: 90, action: 'block' },
      { id: 'v2', name: 'Safety Guard', type: 'safety_guard', enabled: true, threshold: 98, action: 'block' },
      { id: 'v3', name: 'Compliance Bot', type: 'compliance_bot', enabled: true, threshold: 92, action: 'escalate' },
    ],
  },
  {
    id: 'a5',
    name: 'Knowledge Curator',
    description:
      'Validates retrieved knowledge for accuracy, freshness, and completeness. Acts as a sub-agent that other agents invoke before generating responses.',
    icon: 'K',
    category: 'Internal',
    status: 'active',
    capabilities: ['KB Validation', 'Content Freshness Check', 'Source Ranking', 'Gap Detection'],
    triggers: ['Sub-agent call from Support Agent', 'Scheduled KB audit', 'New article published'],
    actions: ['Validate KB chunk', 'Score relevance', 'Flag outdated content', 'Suggest knowledge gaps'],
    requiredApproval: false,
    confidenceThreshold: 75,
    tasksThisMonth: 4521,
    successRate: 94,
    knowledgeSources: ['All KB Sources', 'Vector Index', 'Release Notes'],
    memoryEnabled: false,
    multiAgentEnabled: false,
    subAgents: [],
    modelConfig: {
      provider: 'google',
      model: 'gemini-2-flash',
      temperature: 0.0,
      maxTokens: 512,
      systemPrompt:
        'You are a knowledge quality auditor. Score retrieved chunks for relevance, accuracy, and freshness. Return a structured confidence score for each chunk.',
      ragEnabled: false,
      ragTopK: 0,
      contextWindow: 1000000,
    },
    pipeline: [
      { id: 'p1', name: 'Chunk Ingestion', type: 'retrieval', enabled: true, config: { acceptsChunks: true } },
      { id: 'p2', name: 'Freshness Check', type: 'validation', enabled: true, config: { maxAgeDays: 90, warnAt: 60 } },
      { id: 'p3', name: 'Relevance Scoring', type: 'reasoning', enabled: true, config: { scoreMethod: 'semantic+keyword' } },
      { id: 'p4', name: 'Quality Report', type: 'response', enabled: true, config: { format: 'structured_json' } },
    ],
    validationBots: [
      { id: 'v1', name: 'Hallucination Detector', type: 'hallucination_detector', enabled: true, threshold: 80, action: 'flag' },
    ],
  },
  {
    id: 'a6',
    name: 'Compliance Bot',
    description:
      'Reviews proposed agent actions for compliance with policies, regulations, and tenant-specific rules before authorising execution.',
    icon: 'C',
    category: 'Internal',
    status: 'active',
    capabilities: ['Policy Enforcement', 'Regulatory Check', 'Risk Classification', 'Audit Trail'],
    triggers: ['Pre-execution hook from any agent', 'Scheduled audit', 'Policy change event'],
    actions: ['Approve action', 'Reject action', 'Flag for human review', 'Log audit event'],
    requiredApproval: false,
    confidenceThreshold: 95,
    tasksThisMonth: 2103,
    successRate: 99,
    knowledgeSources: ['Compliance Policies', 'Regulatory DB', 'Tenant Rules'],
    memoryEnabled: false,
    multiAgentEnabled: false,
    subAgents: [],
    modelConfig: {
      provider: 'anthropic',
      model: 'claude-opus-4-5',
      temperature: 0.0,
      maxTokens: 256,
      systemPrompt:
        'You are a compliance enforcement agent. Evaluate proposed actions against policies. Return APPROVE, REJECT, or ESCALATE with reasoning.',
      ragEnabled: true,
      ragTopK: 5,
      contextWindow: 200000,
    },
    pipeline: [
      { id: 'p1', name: 'Policy Retrieval', type: 'retrieval', enabled: true, config: { source: 'compliance_kb', topK: 5 } },
      { id: 'p2', name: 'Action Analysis', type: 'reasoning', enabled: true, config: { structuredOutput: true, format: 'approve|reject|escalate' } },
      { id: 'p3', name: 'Audit Logging', type: 'action', enabled: true, config: { alwaysLog: true, immutable: true } },
    ],
    validationBots: [],
  },
  {
    id: 'a7',
    name: 'HR Knowledge Agent',
    description:
      'Answers internal employee questions about HR policies, benefits, leave, and payroll by querying the internal knowledge base.',
    icon: 'H',
    category: 'Internal',
    status: 'active',
    capabilities: ['HR Policy Lookup', 'Leave Calculator', 'Benefits Info', 'Payroll FAQ'],
    triggers: ['Employee question via chat', 'HR ticket created', 'Leave request'],
    actions: ['Answer HR query', 'Calculate leave balance', 'Link to policy doc', 'Create HR ticket'],
    requiredApproval: false,
    confidenceThreshold: 82,
    tasksThisMonth: 728,
    successRate: 95,
    knowledgeSources: ['HR Policies', 'Benefits Handbook', 'Payroll Guide'],
    memoryEnabled: true,
    multiAgentEnabled: true,
    subAgents: ['a5'],
    modelConfig: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      temperature: 0.3,
      maxTokens: 1024,
      systemPrompt:
        'You are an internal HR assistant. Answer employee questions using official HR documentation. Be precise with numbers like leave balances and salary figures.',
      ragEnabled: true,
      ragTopK: 4,
      contextWindow: 128000,
    },
    pipeline: [
      { id: 'p1', name: 'Employee Auth', type: 'validation', enabled: true, config: { requireEmployeeId: true } },
      { id: 'p2', name: 'HR KB Retrieval', type: 'retrieval', enabled: true, config: { source: 'hr_kb', topK: 4 } },
      { id: 'p3', name: 'Answer Reasoning', type: 'reasoning', enabled: true, config: { temperature: 0.3, citeSource: true } },
      { id: 'p4', name: 'Confidence Gate', type: 'validation', enabled: true, config: { minConfidence: 82 } },
      { id: 'p5', name: 'Response', type: 'response', enabled: true, config: { includeSources: true } },
    ],
    validationBots: [
      { id: 'v1', name: 'Confidence Reviewer', type: 'confidence_reviewer', enabled: true, threshold: 82, action: 'escalate' },
      { id: 'v2', name: 'Knowledge Checker', type: 'knowledge_checker', enabled: true, threshold: 75, action: 'flag' },
    ],
  },
  {
    id: 'a8',
    name: 'Sales Intelligence Agent',
    description:
      'Assists the sales team with prospect research, product comparisons, pricing guidance, and CRM updates based on internal knowledge and product data.',
    icon: 'I',
    category: 'Internal',
    status: 'idle',
    capabilities: ['Product Comparison', 'Pricing Lookup', 'Prospect Research', 'CRM Update'],
    triggers: ['Sales team request', 'CRM record created', 'Deal stage change'],
    actions: ['Research prospect', 'Generate comparison doc', 'Suggest pricing', 'Update CRM record'],
    requiredApproval: false,
    confidenceThreshold: 78,
    tasksThisMonth: 203,
    successRate: 91,
    knowledgeSources: ['Product Catalogue', 'Pricing Engine', 'Competitive Intel', 'CRM Data'],
    memoryEnabled: true,
    multiAgentEnabled: false,
    subAgents: [],
    modelConfig: {
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.5,
      maxTokens: 2048,
      systemPrompt:
        'You are a sales intelligence assistant. Help the sales team with accurate product info, competitive positioning, and deal strategies.',
      ragEnabled: true,
      ragTopK: 6,
      contextWindow: 128000,
    },
    pipeline: [
      { id: 'p1', name: 'CRM + Product Retrieval', type: 'retrieval', enabled: true, config: { sources: 'crm,product_kb,competitive_intel' } },
      { id: 'p2', name: 'Synthesis & Reasoning', type: 'reasoning', enabled: true, config: { temperature: 0.5, businessContext: true } },
      { id: 'p3', name: 'Confidence Gate', type: 'validation', enabled: true, config: { minConfidence: 78 } },
      { id: 'p4', name: 'Output + CRM Write', type: 'action', enabled: true, config: { canUpdateCRM: true, requireManagerApproval: false } },
    ],
    validationBots: [
      { id: 'v1', name: 'Confidence Reviewer', type: 'confidence_reviewer', enabled: true, threshold: 78, action: 'flag' },
      { id: 'v2', name: 'Hallucination Detector', type: 'hallucination_detector', enabled: true, threshold: 80, action: 'flag' },
    ],
  },
];

// ============================================================
// DEFAULT StoredDE seed (mirrors defaultAgents for first load)
// ============================================================
const defaultStoredDEs: StoredDE[] = defaultAgents.map(a => ({
  id: a.id,
  name: a.name,
  description: a.description,
  icon: a.icon,
  category: a.category,
  department: a.category === 'Customer' ? 'Customer Success' : 'Operations',
  workspace: '',
  lifecycle_status: 'active',
  trust_level: 'supervised' as const,
  responsibilities: [],
  tags: [],
  status: a.status,
  capabilities: a.actions,
  channels: ['chat', 'email'],
  knowledgeSources: a.knowledgeSources,
  confidenceThreshold: a.confidenceThreshold,
  requiredApproval: a.requiredApproval,
  createdAt: new Date().toISOString(),
  tasksThisMonth: a.tasksThisMonth,
  successRate: a.successRate,
  model_provider: a.modelConfig.provider === 'google' ? 'google' : a.modelConfig.provider === 'openai' ? 'openai' : 'anthropic',
  model_id: a.modelConfig.model,
}));

// ============================================================
// COMPONENT
// ============================================================

const AgentWorkforcePage = ({
  user,
  tenant,
  page,
  setPage,
}: {
  user?: AuthUser;
  tenant?: Tenant;
  page: Page;
  setPage: (p: Page) => void;
}) => {
  const { employees, hire, update, toggleStatus } = useDigitalEmployees(tenant?.id, defaultStoredDEs, user?.id);
  const [showHireModal, setShowHireModal] = useState(false);

  // Keep a mutable agents list for the existing detail-view UI (which uses AgentDef shape)
  const [agents, setAgents] = useState<AgentDef[]>(defaultAgents);
  const [filter, setFilter] = useState<'all' | 'active' | 'idle' | 'disabled'>(
    'all'
  );
  const [catFilter, setCatFilter] = useState<'all' | 'Customer' | 'Internal'>(
    'all'
  );
  const [selectedAgent, setSelectedAgent] = useState<AgentDef | null>(null);
  const [configTab, setConfigTab] = useState<
    'overview' | 'persona' | 'model' | 'pipeline' | 'validators' | 'actions' | 'knowledge'
  >('overview');
  const [showTestPanel, setShowTestPanel] = useState(false);
  const accentColor = tenant?.primaryColor || '#6366f1';

  // Model picker state (synced when a DE is selected)
  const [pickerProv, setPickerProv] = useState<ModelProvider>(DEFAULT_PROVIDER);
  const [pickerId, setPickerId] = useState<string>(DEFAULT_MODEL_ID);
  const [pickerTaskType, setPickerTaskType] = useState<string>('chat');
  const [pickerEscModelId, setPickerEscModelId] = useState<string>('claude-sonnet-5');
  const [pickerEscThreshold, setPickerEscThreshold] = useState<number>(60);
  const [modelSaveStatus, setModelSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');

  // Overview tab controlled state
  const [ovName, setOvName] = useState('');
  const [ovPersona, setOvPersona] = useState('');
  const [ovDescription, setOvDescription] = useState('');
  const [ovStatus, setOvStatus] = useState<'active' | 'idle' | 'disabled'>('active');
  const [ovAudience, setOvAudience] = useState<'Customer' | 'Internal'>('Customer');
  const [ovThreshold, setOvThreshold] = useState(75);
  const [ovApproval, setOvApproval] = useState(false);
  const [ovSaveStatus, setOvSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  // KB Scope (Phase 1 Fix A)
  const [ovKbScope, setOvKbScope] = useState<string[]>([]);
  const [kbCategories, setKbCategories] = useState<string[]>([]);
  // Escalation Handler (Phase 1 Fix B)
  const [ovEscHandler, setOvEscHandler] = useState('');
  const [teamProfiles, setTeamProfiles] = useState<DBProfile[]>([]);
  // DE Action Types (Phase 2B)
  const [canSendEmail, setCanSendEmail] = useState(false);
  const [canGenerateDocs, setCanGenerateDocs] = useState(false);
  const [canReadConnectors, setCanReadConnectors] = useState(false);
  const [canWriteConnectors, setCanWriteConnectors] = useState(false);
  const [canJournalEntries, setCanJournalEntries] = useState(false);

  // Fallback & Routing (Model tab)
  const [modelFallbackEnabled, setModelFallbackEnabled] = useState(false);
  const [fallbackProvider, setFallbackProvider] = useState<ModelProvider>(DEFAULT_PROVIDER);
  const [fallbackModelId, setFallbackModelId] = useState(DEFAULT_MODEL_ID);
  const [latencyThresholdMs, setLatencyThresholdMs] = useState(5000);
  const [modelRouteByTask, setModelRouteByTask] = useState(false);
  const [taskRouteSimpleModel, setTaskRouteSimpleModel] = useState(DEFAULT_MODEL_ID);
  const [taskRouteSimpleProv, setTaskRouteSimpleProv] = useState<ModelProvider>(DEFAULT_PROVIDER);
  const [taskRouteComplexModel, setTaskRouteComplexModel] = useState(DEFAULT_MODEL_ID);
  const [taskRouteComplexProv, setTaskRouteComplexProv] = useState<ModelProvider>(DEFAULT_PROVIDER);
  const [taskRouteCodeModel, setTaskRouteCodeModel] = useState(DEFAULT_MODEL_ID);
  const [taskRouteCodeProv, setTaskRouteCodeProv] = useState<ModelProvider>(DEFAULT_PROVIDER);

  // Token Budget (Model tab)
  const [tokenBudgetMonthly, setTokenBudgetMonthly] = useState(0);
  const [tokenBudgetHard, setTokenBudgetHard] = useState(false);

  // Persona tab
  const [personaTone, setPersonaTone] = useState<'professional' | 'empathetic' | 'technical' | 'friendly' | 'formal' | 'custom'>('professional');
  const [personaOpening, setPersonaOpening] = useState('');
  const [personaClosing, setPersonaClosing] = useState('');
  const [personaAvoid, setPersonaAvoid] = useState('');
  const [personaAlwaysMention, setPersonaAlwaysMention] = useState('');
  const [personaSystemPrompt, setPersonaSystemPrompt] = useState('');
  const [personaSaveStatus, setPersonaSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [showPromptHistory, setShowPromptHistory] = useState(false);

  // Escalation Tiers (Overview tab)
  type EscTier = { tier: number; assignee_id: string; trigger_confidence: number; after_minutes: number; channel: 'inapp' | 'email' | 'both' };
  const [escalationTiers, setEscalationTiers] = useState<EscTier[]>([
    { tier: 1, assignee_id: '', trigger_confidence: 60, after_minutes: 0, channel: 'inapp' },
    { tier: 2, assignee_id: '', trigger_confidence: 60, after_minutes: 30, channel: 'both' },
    { tier: 3, assignee_id: '', trigger_confidence: 60, after_minutes: 120, channel: 'email' },
  ]);
  const [expandedTiers, setExpandedTiers] = useState<number[]>([1]);

  // Load KB categories + team profiles when tenant is known
  useEffect(() => {
    if (!tenant?.id) return;
    fetchKnowledgeArticles(tenant.id).then(articles => {
      const cats = Array.from(new Set(articles.map(a => a.category).filter(Boolean) as string[]));
      setKbCategories(cats);
    });
    fetchTenantProfiles(tenant.id).then(profiles => setTeamProfiles(profiles));
  }, [tenant?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync employees from hook into the AgentDef list used by card/detail views
  useEffect(() => {
    setAgents(prev => {
      const existingIds = new Set(prev.map(a => a.id));
      const newOnes = employees
        .filter(e => !existingIds.has(e.id))
        .map(e => ({
          ...defaultAgents[0], // sensible defaults for new DEs
          id: e.id,
          name: e.name,
          description: e.description,
          icon: e.icon,
          category: e.category,
          status: e.status,
          capabilities: e.capabilities,
          actions: e.capabilities,
          knowledgeSources: e.knowledgeSources,
          confidenceThreshold: e.confidenceThreshold,
          requiredApproval: e.requiredApproval,
          tasksThisMonth: e.tasksThisMonth,
          successRate: e.successRate,
        }));
      // Sync status changes from hook back to detail list
      const synced = prev.map(a => {
        const live = employees.find(e => e.id === a.id);
        return live ? { ...a, status: live.status } : a;
      });
      return [...synced, ...newOnes];
    });
  }, [employees]);

  // Sync model picker + overview fields when a DE is selected
  useEffect(() => {
    if (!selectedAgent) return;
    const stored = employees.find(e => e.id === selectedAgent.id);
    setPickerProv((stored?.model_provider as ModelProvider) ?? DEFAULT_PROVIDER);
    setPickerId(stored?.model_id ?? DEFAULT_MODEL_ID);
    setPickerTaskType(stored?.task_type ?? 'chat');
    setPickerEscModelId(stored?.escalation_model_id ?? 'claude-sonnet-5');
    setPickerEscThreshold(stored?.escalation_threshold ?? 60);
    setModelSaveStatus('idle');
    // Overview
    setOvName(stored?.name ?? selectedAgent.name);
    setOvPersona(stored?.persona_name ?? '');
    setOvDescription(stored?.description ?? selectedAgent.description);
    setOvStatus((stored?.status ?? selectedAgent.status) as any);
    setOvAudience((stored?.category ?? selectedAgent.category) as any);
    setOvThreshold(stored?.confidenceThreshold ?? selectedAgent.confidenceThreshold ?? 75);
    setOvApproval(stored?.requiredApproval ?? selectedAgent.requiredApproval ?? false);
    setOvSaveStatus('idle');
    // KB Scope
    setOvKbScope(stored?.knowledgeSources ?? []);
    // Escalation Handler
    setOvEscHandler((stored as any)?.model_config?.escalation_handler_id ?? '');
    // Action types
    const caps = stored?.capabilities ?? ['answer_kb'];
    setCanSendEmail(caps.includes('send_email'));
    setCanGenerateDocs(caps.includes('generate_docs'));
    setCanReadConnectors(caps.includes('read_connectors'));
    setCanWriteConnectors(caps.includes('write_connectors'));
    setCanJournalEntries(caps.includes('journal_entries'));
    // Fallback / routing
    const mc = (stored as any)?.model_config || {};
    setModelFallbackEnabled(!!mc.fallback_model);
    setFallbackProvider((mc.fallback_provider as ModelProvider) || DEFAULT_PROVIDER);
    setFallbackModelId(mc.fallback_model || DEFAULT_MODEL_ID);
    setLatencyThresholdMs(mc.latency_threshold_ms || 5000);
    setModelRouteByTask(!!mc.route_by_task);
    setTaskRouteSimpleProv((mc.task_routes?.simple?.provider as ModelProvider) || DEFAULT_PROVIDER);
    setTaskRouteSimpleModel(mc.task_routes?.simple?.model || DEFAULT_MODEL_ID);
    setTaskRouteComplexProv((mc.task_routes?.complex?.provider as ModelProvider) || DEFAULT_PROVIDER);
    setTaskRouteComplexModel(mc.task_routes?.complex?.model || DEFAULT_MODEL_ID);
    setTaskRouteCodeProv((mc.task_routes?.code?.provider as ModelProvider) || DEFAULT_PROVIDER);
    setTaskRouteCodeModel(mc.task_routes?.code?.model || DEFAULT_MODEL_ID);
    // Token budget
    setTokenBudgetMonthly(mc.token_budget?.monthly_limit || 0);
    setTokenBudgetHard(mc.token_budget?.hard_limit || false);
    // Persona
    const p = mc.persona || {};
    setPersonaTone(p.tone || 'professional');
    setPersonaOpening(p.opening_greeting || '');
    setPersonaClosing(p.closing_signature || '');
    setPersonaAvoid(p.avoid_phrases || '');
    setPersonaAlwaysMention(p.always_mention || '');
    setPersonaSystemPrompt(stored?.model_config ? (mc as any).systemPrompt || '' : selectedAgent?.modelConfig?.systemPrompt || '');
    // Escalation tiers
    if (mc.escalation_tiers?.length) {
      setEscalationTiers(mc.escalation_tiers);
    } else {
      setEscalationTiers([
        { tier: 1, assignee_id: '', trigger_confidence: 60, after_minutes: 0, channel: 'inapp' },
        { tier: 2, assignee_id: '', trigger_confidence: 60, after_minutes: 30, channel: 'both' },
        { tier: 3, assignee_id: '', trigger_confidence: 60, after_minutes: 120, channel: 'email' },
      ]);
    }
    setExpandedTiers([1]);
  }, [selectedAgent?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = agents.filter(
    (a) =>
      (filter === 'all' || a.status === filter) &&
      (catFilter === 'all' || a.category === catFilter)
  );

  const statusColor = (s: string) =>
    s === 'active'
      ? 'bg-emerald-500'
      : s === 'idle'
      ? 'bg-amber-500'
      : 'bg-slate-600';

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageTabs tabs={AGENT_TABS} page={page} setPage={setPage} accentColor={accentColor} />
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Digital Employees</h1>
          <p className="text-slate-400 text-sm mt-1">
            Configure Digital Employees that assist customers and internal staff — with
            full audit and approval controls
          </p>
        </div>
        <button
          onClick={() => setShowHireModal(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-medium"
          style={{ backgroundColor: accentColor }}
        >
          + Hire Digital Employee
        </button>
      </div>

      {/* Agentic Pipeline Banner */}
      <div className="mb-6 bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">
          How Digital Employees Work — Workforce Pipeline
        </div>
        <div className="flex items-center gap-2 overflow-x-auto">
          {[
            {
              step: '1',
              label: 'Query Received',
              desc: 'Chat / email / trigger',
              color: 'bg-blue-900 text-blue-300',
            },
            {
              step: '2',
              label: 'Intent & Routing',
              desc: 'Best agent selected',
              color: 'bg-indigo-900 text-indigo-300',
            },
            {
              step: '3',
              label: 'KB Retrieval',
              desc: 'RAG over knowledge base',
              color: 'bg-purple-900 text-purple-300',
            },
            {
              step: '4',
              label: 'LLM Reasoning',
              desc: 'Chain-of-thought with model',
              color: 'bg-violet-900 text-violet-300',
            },
            {
              step: '5',
              label: 'Validation Bots',
              desc: 'Confidence + Safety + Compliance',
              color: 'bg-yellow-900 text-yellow-300',
            },
            {
              step: '6',
              label: 'Respond or Escalate',
              desc: 'Auto-act or human review',
              color: 'bg-emerald-900 text-emerald-300',
            },
          ].map((s, idx, arr) => (
            <div key={s.step} className="flex items-center gap-2 flex-shrink-0">
              <div
                className={`px-3 py-2 rounded-lg ${s.color} text-center min-w-[120px]`}
              >
                <div className="text-xs font-bold mb-0.5">{s.label}</div>
                <div className="text-xs opacity-70">{s.desc}</div>
              </div>
              {idx < arr.length - 1 && (
                <span className="text-slate-600 text-lg">{'>'}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard
          label="Digital Employees"
          value={String(agents.length)}
          icon="⚡"
          color="blue"
        />
        <StatCard
          label="Active"
          value={String(agents.filter((a) => a.status === 'active').length)}
          icon="◈"
          color="emerald"
        />
        <StatCard
          label="Customer-Facing"
          value={String(agents.filter((a) => a.category === 'Customer').length)}
          icon="✉"
          color="purple"
        />
        <StatCard
          label="Internal"
          value={String(agents.filter((a) => a.category === 'Internal').length)}
          icon="⊟"
          color="amber"
        />
      </div>

      <div className="flex items-center gap-3 mb-5">
        <div className="flex gap-1 bg-slate-800 rounded-lg p-1">
          {(['all', 'active', 'idle', 'disabled'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all capitalize ${
                filter === f ? 'text-white' : 'text-slate-400 hover:text-white'
              }`}
              style={filter === f ? { backgroundColor: accentColor } : {}}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="flex gap-1 bg-slate-800 rounded-lg p-1">
          {(['all', 'Customer', 'Internal'] as const).map((c) => (
            <button
              key={c}
              onClick={() => setCatFilter(c)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                catFilter === c
                  ? 'text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
              style={catFilter === c ? { backgroundColor: accentColor } : {}}
            >
              {c === 'all' ? 'All' : c}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map((agent) => (
          <div
            key={agent.id}
            className="bg-slate-900 border border-slate-800 rounded-xl p-5 hover:border-slate-700 transition-all cursor-pointer"
            onClick={() => {
              setSelectedAgent(agent);
              setConfigTab('overview');
            }}
          >
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-3">
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center text-lg font-bold text-white"
                  style={{ backgroundColor: accentColor + '30' }}
                >
                  {agent.icon}
                </div>
                <div>
                  <div className="text-sm font-semibold text-white">
                    {agent.name}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${statusColor(
                        agent.status
                      )}`}
                    />
                    <span className="text-xs text-slate-500 capitalize">
                      {agent.status}
                    </span>
                  </div>
                </div>
              </div>
              <label
                className="relative inline-flex items-center cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleStatus(agent.id);
                }}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={agent.status === 'active'}
                  readOnly
                />
                <div
                  className={`w-9 h-5 rounded-full transition-all ${
                    agent.status === 'active'
                      ? 'bg-emerald-500'
                      : 'bg-slate-700'
                  }`}
                >
                  <div
                    className={`w-4 h-4 bg-white rounded-full shadow transition-all mt-0.5 ${
                      agent.status === 'active' ? 'ml-4' : 'ml-0.5'
                    }`}
                  />
                </div>
              </label>
            </div>
            <p className="text-xs text-slate-400 mb-3 leading-relaxed">
              {agent.description}
            </p>
            <div className="flex flex-wrap gap-1 mb-3">
              <Badge
                label={agent.category}
                color={agent.category === 'Customer' ? 'blue' : 'purple'}
              />
              {agent.requiredApproval && (
                <Badge label="Approval required" color="amber" />
              )}
            </div>
            {/* Model + pipeline info */}
            <div className="flex items-center gap-2 mb-3 text-xs">
              <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-400">
                {agent.modelConfig.provider === 'anthropic'
                  ? 'Anthropic'
                  : agent.modelConfig.provider === 'openai'
                  ? 'OpenAI'
                  : agent.modelConfig.provider === 'google'
                  ? 'Google'
                  : 'Custom'}
              </span>
              <span className="text-slate-500">{agent.modelConfig.model}</span>
              <span className="ml-auto text-slate-600">
                {agent.pipeline.filter((p) => p.enabled).length} stages
              </span>
              <span className="text-slate-600">|</span>
              <span className="text-slate-600">
                {agent.validationBots.filter((v) => v.enabled).length}{' '}
                validators
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-center">
              <div className="bg-slate-800/50 rounded-lg py-2">
                <div className="text-sm font-bold text-white">
                  {agent.tasksThisMonth.toLocaleString()}
                </div>
                <div className="text-xs text-slate-500">tasks/mo</div>
              </div>
              <div className="bg-slate-800/50 rounded-lg py-2">
                <div className="text-sm font-bold text-emerald-400">
                  {agent.successRate}%
                </div>
                <div className="text-xs text-slate-500">success rate</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Digital Employee Catalog ── */}
      <DECatalogSection
        accentColor={accentColor}
        enabledIds={employees.map(e => e.id)}
        onEnable={(cat) => {
          hire({
            name: cat.name,
            description: cat.description,
            icon: cat.icon,
            category: cat.category,
            department: cat.department,
            status: 'active',
            capabilities: cat.defaultCapabilities,
            channels: cat.defaultChannels,
            knowledgeSources: cat.defaultKnowledgeSources,
            confidenceThreshold: cat.defaultThreshold,
            requiredApproval: cat.defaultApprovalRequired,
          });
        }}
      />

      {selectedAgent && (
        <Modal
          title={'Configure: ' + selectedAgent.name}
          onClose={() => setSelectedAgent(null)}
        >
          {/* Tab bar */}
          <div className="flex gap-1 mb-6 p-1 bg-slate-800 rounded-lg flex-wrap">
            {(
              [
                'overview',
                'persona',
                'model',
                'pipeline',
                'validators',
                'actions',
                'knowledge',
              ] as const
            ).map((t) => (
              <button
                key={t}
                className={`flex-1 py-2 px-2 rounded-md text-xs font-medium capitalize transition-colors ${
                  configTab === t
                    ? 'text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                style={configTab === t ? { backgroundColor: accentColor } : {}}
                onClick={() => setConfigTab(t)}
              >
                {t === 'validators'
                  ? 'Validators'
                  : t === 'knowledge'
                  ? 'Knowledge & Data'
                  : t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {/* === OVERVIEW TAB === */}
          {configTab === 'overview' && (
            <div className="space-y-4">
              {/* Name + Persona */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-slate-400 block mb-1.5 tracking-wider">NAME</label>
                  <input
                    value={ovName}
                    onChange={e => setOvName(e.target.value)}
                    placeholder="e.g. Support Assistant"
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-400 block mb-1.5 tracking-wider">PERSONA NAME <span className="font-normal text-slate-600">(shown to customers)</span></label>
                  <input
                    value={ovPersona}
                    onChange={e => setOvPersona(e.target.value)}
                    placeholder="e.g. Aria, Max, Alex…"
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              {/* Description */}
              <div>
                <label className="text-xs font-semibold text-slate-400 block mb-1.5 tracking-wider">DESCRIPTION <span className="font-normal text-slate-600">(what this DE does)</span></label>
                <textarea
                  value={ovDescription}
                  onChange={e => setOvDescription(e.target.value)}
                  rows={3}
                  placeholder="Describe what this Digital Employee handles, its scope, and any limits on what it should answer."
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 resize-none"
                />
              </div>

              {/* Status + Audience */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-slate-400 block mb-1.5 tracking-wider">STATUS</label>
                  <select
                    value={ovStatus}
                    onChange={e => setOvStatus(e.target.value as any)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500"
                  >
                    <option value="active">Active — answering customers</option>
                    <option value="idle">Idle — paused</option>
                    <option value="disabled">Disabled — offline</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-400 block mb-1.5 tracking-wider">AUDIENCE</label>
                  <select
                    value={ovAudience}
                    onChange={e => setOvAudience(e.target.value as any)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500"
                  >
                    <option value="Customer">Customer-facing</option>
                    <option value="Internal">Internal Staff</option>
                  </select>
                </div>
              </div>

              {/* Escalation Tiers */}
              <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4">
                <label className="text-xs font-semibold text-slate-400 block mb-3 tracking-wider">ESCALATION TIERS</label>
                <div className="space-y-2">
                  {escalationTiers.map((tier) => {
                    const isExpanded = expandedTiers.includes(tier.tier);
                    const tierLabel = tier.tier === 1 ? 'Tier 1 — First escalation' : tier.tier === 2 ? `Tier 2 — If unresolved after ${tier.after_minutes}min` : `Tier 3 — Manager escalation`;
                    return (
                      <div key={tier.tier} className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
                        <button
                          onClick={() => setExpandedTiers(prev => prev.includes(tier.tier) ? prev.filter(t => t !== tier.tier) : [...prev, tier.tier])}
                          className="w-full flex items-center justify-between px-3 py-2.5 text-left"
                        >
                          <span className="text-xs font-medium text-slate-300">{tierLabel}</span>
                          <span className="text-slate-600 text-xs">{isExpanded ? '▲' : '▼'}</span>
                        </button>
                        {isExpanded && (
                          <div className="px-3 pb-3 space-y-2 border-t border-slate-800 pt-2">
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className="text-xs text-slate-500 block mb-1">Assignee</label>
                                <select
                                  value={tier.assignee_id}
                                  onChange={e => setEscalationTiers(prev => prev.map(t => t.tier === tier.tier ? { ...t, assignee_id: e.target.value } : t))}
                                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none"
                                >
                                  <option value="">First available</option>
                                  {teamProfiles.map(p => (
                                    <option key={p.id} value={p.id}>{p.full_name || p.id}</option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <label className="text-xs text-slate-500 block mb-1">Channel</label>
                                <select
                                  value={tier.channel}
                                  onChange={e => setEscalationTiers(prev => prev.map(t => t.tier === tier.tier ? { ...t, channel: e.target.value as any } : t))}
                                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none"
                                >
                                  <option value="inapp">In-app notification</option>
                                  <option value="email">Email</option>
                                  <option value="both">Both</option>
                                </select>
                              </div>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className="text-xs text-slate-500 block mb-1">Trigger at confidence &lt;</label>
                                <div className="flex items-center gap-1">
                                  <input
                                    type="number" min={0} max={100} value={tier.trigger_confidence}
                                    onChange={e => setEscalationTiers(prev => prev.map(t => t.tier === tier.tier ? { ...t, trigger_confidence: Number(e.target.value) } : t))}
                                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none"
                                  />
                                  <span className="text-xs text-slate-500">%</span>
                                </div>
                              </div>
                              {tier.tier > 1 && (
                                <div>
                                  <label className="text-xs text-slate-500 block mb-1">After unresolved (min)</label>
                                  <input
                                    type="number" min={0} value={tier.after_minutes}
                                    onChange={e => setEscalationTiers(prev => prev.map(t => t.tier === tier.tier ? { ...t, after_minutes: Number(e.target.value) } : t))}
                                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none"
                                  />
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Confidence threshold */}
              <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-semibold text-slate-400 tracking-wider">CONFIDENCE THRESHOLD</label>
                  <span className="text-white text-sm font-bold font-mono">{ovThreshold}%</span>
                </div>
                <input
                  type="range" min={30} max={95} value={ovThreshold}
                  onChange={e => setOvThreshold(Number(e.target.value))}
                  className="w-full accent-indigo-500"
                />
                <div className="flex justify-between text-xs text-slate-600 mt-1">
                  <span>30% — escalate often</span>
                  <span>95% — rarely escalate</span>
                </div>
                <p className="text-xs text-slate-500 mt-2">
                  When the AI's confidence in its answer falls below this, the conversation is escalated to your team.
                </p>
              </div>

              {/* Approval required */}
              <div className="flex items-center justify-between bg-slate-800/60 border border-slate-700 rounded-xl px-4 py-3">
                <div>
                  <div className="text-sm text-white">Require human approval before acting</div>
                  <div className="text-xs text-slate-500 mt-0.5">All DE actions go to the approval queue before execution</div>
                </div>
                <button
                  onClick={() => setOvApproval(v => !v)}
                  className={`w-10 h-6 rounded-full relative transition-colors flex-shrink-0 ${ovApproval ? 'bg-indigo-500' : 'bg-slate-700'}`}
                  style={ovApproval ? { backgroundColor: accentColor } : {}}
                >
                  <div className={`w-4 h-4 bg-white rounded-full absolute top-1 transition-all ${ovApproval ? 'left-5' : 'left-1'}`} />
                </button>
              </div>

              {/* Knowledge Scope */}
              <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4">
                <div className="mb-2">
                  <label className="text-xs font-semibold text-slate-400 tracking-wider">KNOWLEDGE SCOPE</label>
                  <p className="text-xs text-slate-500 mt-0.5">Restrict this DE to specific KB categories. No selection = unrestricted access.</p>
                </div>
                {kbCategories.length === 0 ? (
                  <p className="text-xs text-slate-600">No KB categories found — publish articles with categories to enable scoping.</p>
                ) : (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {kbCategories.map(cat => {
                      const sel = ovKbScope.includes(cat);
                      return (
                        <button
                          key={cat}
                          onClick={() => setOvKbScope(prev => sel ? prev.filter(c => c !== cat) : [...prev, cat])}
                          className={`px-3 py-1 rounded-full text-xs font-medium border transition-all ${sel ? 'border-indigo-500 bg-indigo-500/20 text-indigo-300' : 'border-slate-700 bg-slate-800 text-slate-400 hover:border-slate-500'}`}
                          style={sel ? { borderColor: accentColor, backgroundColor: accentColor + '25', color: accentColor } : {}}
                        >{cat}</button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* What this DE can do */}
              <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4">
                <label className="text-xs font-semibold text-slate-400 block mb-3 tracking-wider">WHAT THIS DE CAN DO</label>
                <div className="space-y-2">
                  {[
                    { label: 'Answer questions', sub: 'From Knowledge Base', key: 'answer_kb', state: true, disabled: true },
                    { label: 'Send emails', sub: 'Outbound emails to customers or team', key: 'send_email', state: canSendEmail, set: setCanSendEmail },
                    { label: 'Generate documents', sub: 'Invoices, reports, summaries', key: 'generate_docs', state: canGenerateDocs, set: setCanGenerateDocs },
                    { label: 'Read connector data', sub: 'Query connected data sources', key: 'read_connectors', state: canReadConnectors, set: setCanReadConnectors },
                    { label: 'Write to connectors', sub: 'Create/update records in external systems', key: 'write_connectors', state: canWriteConnectors, set: setCanWriteConnectors },
                    { label: 'Make journal entries', sub: 'Post to accounting systems', key: 'journal_entries', state: canJournalEntries, set: setCanJournalEntries },
                  ].map(item => (
                    <label key={item.key} className={`flex items-start gap-3 ${item.disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
                      <input
                        type="checkbox"
                        checked={item.state}
                        disabled={item.disabled}
                        onChange={() => !item.disabled && item.set && item.set((v: boolean) => !v)}
                        className="mt-0.5 accent-indigo-500"
                      />
                      <div>
                        <div className="text-sm text-white">{item.label}</div>
                        <div className="text-xs text-slate-500">{item.sub}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {/* Save */}
              <div className="flex items-center gap-3 pt-1">
                <button
                  onClick={async () => {
                    const stored = employees.find(e => e.id === selectedAgent?.id);
                    if (!stored) return;
                    setOvSaveStatus('saving');
                    const caps = ['answer_kb', ...(canSendEmail ? ['send_email'] : []), ...(canGenerateDocs ? ['generate_docs'] : []), ...(canReadConnectors ? ['read_connectors'] : []), ...(canWriteConnectors ? ['write_connectors'] : []), ...(canJournalEntries ? ['journal_entries'] : [])];
                    const existingModelConfig = (stored as any).model_config || {};
                    await update(stored.id, {
                      name: ovName,
                      persona_name: ovPersona,
                      description: ovDescription,
                      status: ovStatus,
                      category: ovAudience,
                      confidenceThreshold: ovThreshold,
                      requiredApproval: ovApproval,
                      knowledgeSources: ovKbScope,
                      capabilities: caps,
                    } as any);
                    // Store escalation tiers + handler in model_config
                    if (tenant?.id) {
                      const { supabase: sb } = await import('../../supabase');
                      await sb.from('digital_employees').update({ model_config: { ...existingModelConfig, escalation_handler_id: ovEscHandler || null, escalation_tiers: escalationTiers } }).eq('id', stored.id).eq('tenant_id', tenant.id);
                    }
                    setOvSaveStatus('saved');
                    setTimeout(() => setOvSaveStatus('idle'), 3000);
                  }}
                  disabled={ovSaveStatus === 'saving'}
                  className="px-5 py-2 text-white text-xs font-medium rounded-xl transition-all disabled:opacity-60"
                  style={{ backgroundColor: accentColor }}
                >
                  {ovSaveStatus === 'saving' ? 'Saving…' : 'Save Configuration'}
                </button>
                {ovSaveStatus === 'saved' && <span className="text-xs text-emerald-400">Saved — active on next customer query</span>}
              </div>
            </div>
          )}

          {/* === PERSONA TAB === */}
          {configTab === 'persona' && (() => {
            const tonePresets: Array<{ id: typeof personaTone; label: string; desc: string }> = [
              { id: 'professional', label: 'Professional', desc: 'Clear, direct, business-appropriate. No slang.' },
              { id: 'empathetic', label: 'Empathetic', desc: 'Warm, understanding, validates customer feelings before answering.' },
              { id: 'technical', label: 'Technical', desc: 'Precise, uses technical terminology, assumes high knowledge.' },
              { id: 'friendly', label: 'Friendly', desc: 'Casual, approachable, uses first names, slight humor OK.' },
              { id: 'formal', label: 'Formal', desc: 'Formal register, no contractions, conservative language.' },
              { id: 'custom', label: 'Custom', desc: 'Define your own tone below.' },
            ];
            const promptHistoryKey = `dt_prompt_history_${selectedAgent?.id}`;
            const promptHistory: Array<{ savedAt: string; prompt: string }> = (() => {
              try { return JSON.parse(localStorage.getItem(promptHistoryKey) || '[]'); } catch { return []; }
            })();
            const generatePrompt = () => {
              const toneDesc = tonePresets.find(t => t.id === personaTone)?.desc || '';
              const name = ovPersona || ovName || selectedAgent?.name || 'this assistant';
              let p = `You are ${name}, a digital employee.\n\nTone: ${toneDesc}`;
              if (personaOpening) p += `\n\nOpening: ${personaOpening}`;
              if (personaClosing) p += `\n\nClosing: ${personaClosing}`;
              if (personaAvoid) p += `\n\nAvoid these phrases: ${personaAvoid}`;
              if (personaAlwaysMention) p += `\n\nAlways mention: ${personaAlwaysMention}`;
              setPersonaSystemPrompt(p);
            };
            const savePersona = async () => {
              const stored = employees.find(e => e.id === selectedAgent?.id);
              if (!stored) return;
              setPersonaSaveStatus('saving');
              const mc = (stored as any)?.model_config || {};
              const history = promptHistory.slice(0, 4);
              if (personaSystemPrompt) {
                history.unshift({ savedAt: new Date().toISOString(), prompt: personaSystemPrompt });
                localStorage.setItem(promptHistoryKey, JSON.stringify(history.slice(0, 5)));
              }
              if (tenant?.id) {
                const { supabase: sb } = await import('../../supabase');
                await sb.from('digital_employees').update({ model_config: { ...mc, persona: { tone: personaTone, opening_greeting: personaOpening, closing_signature: personaClosing, avoid_phrases: personaAvoid, always_mention: personaAlwaysMention }, systemPrompt: personaSystemPrompt } }).eq('id', stored.id).eq('tenant_id', tenant.id);
              }
              setPersonaSaveStatus('saved');
              setTimeout(() => setPersonaSaveStatus('idle'), 3000);
            };
            return (
              <div className="space-y-5">
                {/* 1. Tone & Style */}
                <div>
                  <label className="text-xs font-semibold text-slate-400 block mb-2 tracking-wider">TONE & STYLE</label>
                  <div className="grid grid-cols-2 gap-2">
                    {tonePresets.map(tp => (
                      <button key={tp.id} onClick={() => setPersonaTone(tp.id)}
                        className={`text-left p-3 rounded-xl border transition-all ${personaTone === tp.id ? 'border-indigo-500 bg-indigo-500/10' : 'border-slate-700 bg-slate-800/50 hover:border-slate-600'}`}
                        style={personaTone === tp.id ? { borderColor: accentColor, backgroundColor: accentColor + '15' } : {}}>
                        <div className="text-xs font-semibold text-white mb-0.5">{tp.label}</div>
                        <div className="text-xs text-slate-400 leading-tight">{tp.desc}</div>
                      </button>
                    ))}
                  </div>
                  {personaTone === 'custom' && (
                    <textarea
                      rows={2}
                      placeholder="Describe the tone you want this DE to use…"
                      className="mt-2 w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 resize-none"
                    />
                  )}
                </div>

                {/* 2. Voice & Signature */}
                <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4 space-y-3">
                  <label className="text-xs font-semibold text-slate-400 block tracking-wider">VOICE & SIGNATURE</label>
                  <div className="text-xs text-slate-500">Responding as: <span className="text-slate-300 font-medium">{ovPersona || ovName || selectedAgent?.name || '—'}</span></div>
                  <div>
                    <label className="text-xs text-slate-500 block mb-1">Opening greeting</label>
                    <input value={personaOpening} onChange={e => setPersonaOpening(e.target.value)}
                      placeholder="e.g. Hi there! I'm Aria, your support specialist."
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 block mb-1">Closing signature</label>
                    <input value={personaClosing} onChange={e => setPersonaClosing(e.target.value)}
                      placeholder="e.g. Let me know if there's anything else I can help with!"
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 block mb-1">Avoid these phrases <span className="text-slate-600">(comma-separated)</span></label>
                    <textarea value={personaAvoid} onChange={e => setPersonaAvoid(e.target.value)} rows={2}
                      placeholder="e.g. I'm sorry, unfortunately, I can't help with that"
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 resize-none" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 block mb-1">Always mention</label>
                    <textarea value={personaAlwaysMention} onChange={e => setPersonaAlwaysMention(e.target.value)} rows={2}
                      placeholder="e.g. If escalating, always mention our 24hr callback guarantee"
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 resize-none" />
                  </div>
                </div>

                {/* 3. System Prompt Builder */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold text-slate-400 tracking-wider">SYSTEM PROMPT</label>
                    <div className="flex items-center gap-2">
                      <div className="relative">
                        <button onClick={() => setShowPromptHistory(v => !v)}
                          className="text-xs px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-400 hover:text-white transition-all">
                          History
                        </button>
                        {showPromptHistory && promptHistory.length > 0 && (
                          <div className="absolute right-0 top-7 z-10 w-72 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden">
                            {promptHistory.map((h, i) => (
                              <button key={i} onClick={() => { setPersonaSystemPrompt(h.prompt); setShowPromptHistory(false); }}
                                className="w-full text-left px-3 py-2.5 hover:bg-slate-800 border-b border-slate-800 last:border-0 transition-all">
                                <div className="text-xs text-slate-400">{new Date(h.savedAt).toLocaleString()}</div>
                                <div className="text-xs text-slate-500 truncate mt-0.5">{h.prompt.slice(0, 60)}…</div>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <button onClick={generatePrompt}
                        className="text-xs px-3 py-1 rounded-lg text-white transition-all"
                        style={{ backgroundColor: accentColor }}>
                        Generate from settings
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-slate-500">Auto-generated from settings above, or override manually. Synced with Model tab.</p>
                  <textarea
                    value={personaSystemPrompt}
                    onChange={e => setPersonaSystemPrompt(e.target.value)}
                    rows={6}
                    maxLength={4096}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 resize-none font-mono"
                    placeholder="System prompt will appear here after clicking 'Generate from settings', or type your own…"
                  />
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-600">{personaSystemPrompt.length} / 4096 chars</span>
                  </div>
                </div>

                <div className="flex items-center gap-3 pt-1">
                  <button onClick={savePersona} disabled={personaSaveStatus === 'saving'}
                    className="px-5 py-2 text-white text-xs font-medium rounded-xl transition-all disabled:opacity-60"
                    style={{ backgroundColor: accentColor }}>
                    {personaSaveStatus === 'saving' ? 'Saving…' : 'Save Persona'}
                  </button>
                  {personaSaveStatus === 'saved' && <span className="text-xs text-emerald-400">Persona saved</span>}
                </div>
              </div>
            );
          })()}

          {/* === MODEL TAB === */}
          {configTab === 'model' && (
            <div className="space-y-4">
              {/* Provider filter tabs */}
              <div className="flex gap-1 bg-slate-800 rounded-lg p-1 w-fit">
                {(['anthropic', 'openai', 'google'] as ModelProvider[]).map(prov => (
                  <button key={prov} onClick={() => setPickerProv(prov)}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all capitalize ${pickerProv === prov ? 'text-white' : 'text-slate-400 hover:text-white'}`}
                    style={pickerProv === prov ? { backgroundColor: accentColor } : {}}>
                    {PROVIDER_LABELS[prov]}
                  </button>
                ))}
              </div>

              {/* Model cards */}
              <div className="grid grid-cols-1 gap-2">
                {MODELS.filter(m => m.provider === pickerProv).map(m => {
                  const isSelected = pickerId === m.id;
                  return (
                    <button key={m.id} onClick={() => setPickerId(m.id)}
                      className={`w-full text-left p-3 rounded-xl border transition-all ${isSelected ? 'border-indigo-500 bg-indigo-500/10' : 'border-slate-700 bg-slate-800/50 hover:border-slate-600'}`}
                      style={isSelected ? { borderColor: accentColor, backgroundColor: accentColor + '15' } : {}}>
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <div className="text-sm font-medium text-white">{m.name}</div>
                          {m.recommended && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-400/10 text-emerald-400">Recommended</span>
                          )}
                          <span className={`text-xs px-1.5 py-0.5 rounded ${TIER_COLORS[m.tier]}`}>{m.tier}</span>
                        </div>
                        {isSelected && <span className="text-xs font-medium" style={{ color: accentColor }}>✓ Selected</span>}
                      </div>
                      <div className="text-xs text-slate-400 mb-2">{m.badge}</div>
                      <div className="flex items-center gap-4 text-xs text-slate-500">
                        <span>Input <span className="text-slate-300">${m.inputCostPer1M}/M tokens</span></span>
                        <span>Output <span className="text-slate-300">${m.outputCostPer1M}/M tokens</span></span>
                        <span>Context <span className="text-slate-300">{m.contextK}k tokens</span></span>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Cost estimate */}
              {(() => {
                const m = MODELS.find(x => x.id === pickerId);
                if (!m) return null;
                const estPerQuery = ((400 * m.inputCostPer1M) + (150 * m.outputCostPer1M)) / 1_000_000;
                return (
                  <div className="bg-slate-800/50 rounded-xl p-3 text-xs text-slate-400">
                    <span className="font-medium text-slate-300">Estimated cost per query:</span>{' '}
                    ~${estPerQuery.toFixed(4)} (based on ~400 input + 150 output tokens)
                    {' · '}
                    1,000 queries ≈ ${(estPerQuery * 1000).toFixed(2)}
                  </div>
                );
              })()}

              {/* Escalation config */}
              <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700">
                <div className="text-xs font-semibold text-slate-300 mb-3 uppercase tracking-wide">Tiered Escalation</div>
                <p className="text-xs text-slate-500 mb-4">
                  If the primary model is below the escalation threshold, it automatically retries with a stronger model before creating an approval request.
                </p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-slate-400 block mb-1.5">Escalation model</label>
                    <select
                      value={pickerEscModelId}
                      onChange={e => setPickerEscModelId(e.target.value)}
                      className="w-full bg-slate-800 border border-slate-700 text-white text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
                    >
                      {MODELS.filter(m => m.tier !== 'economy').map(m => (
                        <option key={m.id} value={m.id}>{PROVIDER_LABELS[m.provider]} — {m.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 block mb-1.5">
                      Escalation threshold: <span className="text-white font-mono">{pickerEscThreshold}%</span>
                    </label>
                    <input
                      type="range" min={20} max={80} value={pickerEscThreshold}
                      onChange={e => setPickerEscThreshold(Number(e.target.value))}
                      className="w-full accent-indigo-500"
                    />
                    <div className="flex justify-between text-xs text-slate-600 mt-1">
                      <span>20% — escalate often</span>
                      <span>80% — rarely escalate</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Task type */}
              <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700">
                <div className="text-xs font-semibold text-slate-300 mb-1 uppercase tracking-wide">Task Type</div>
                <p className="text-xs text-slate-500 mb-3">
                  Declares what this DE mainly does. If you haven't manually selected a model above, the system auto-selects the best model for this task type.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {TASK_TYPES.map(tt => (
                    <button key={tt.id} onClick={() => setPickerTaskType(tt.id)}
                      className={`text-left p-2.5 rounded-lg border transition-all ${pickerTaskType === tt.id ? 'border-indigo-500 bg-indigo-500/10' : 'border-slate-700 hover:border-slate-600'}`}
                      style={pickerTaskType === tt.id ? { borderColor: accentColor, backgroundColor: accentColor + '15' } : {}}>
                      <div className="text-xs font-medium text-white mb-0.5">{tt.icon} {tt.label}</div>
                      <div className="text-xs text-slate-500">{tt.description}</div>
                      <div className="text-xs text-slate-600 mt-1">Auto-model: {tt.bestModelId.split('-').slice(0, 3).join('-')}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Fallback & Routing */}
              <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700 space-y-3">
                <div className="text-xs font-semibold text-slate-300 uppercase tracking-wide">Fallback &amp; Routing</div>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm text-white">Enable fallback model</div>
                    <div className="text-xs text-slate-500">Used if primary model fails or exceeds latency threshold</div>
                  </div>
                  <button onClick={() => setModelFallbackEnabled(v => !v)}
                    className={`w-10 h-6 rounded-full relative transition-colors flex-shrink-0 ${modelFallbackEnabled ? 'bg-indigo-500' : 'bg-slate-700'}`}
                    style={modelFallbackEnabled ? { backgroundColor: accentColor } : {}}>
                    <div className={`w-4 h-4 bg-white rounded-full absolute top-1 transition-all ${modelFallbackEnabled ? 'left-5' : 'left-1'}`} />
                  </button>
                </div>
                {modelFallbackEnabled && (
                  <div className="space-y-3 pt-1">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs text-slate-400 block mb-1">Fallback provider</label>
                        <select value={fallbackProvider} onChange={e => setFallbackProvider(e.target.value as ModelProvider)}
                          className="w-full bg-slate-800 border border-slate-700 text-white text-xs rounded-lg px-3 py-2 focus:outline-none">
                          {(['anthropic', 'openai', 'google'] as ModelProvider[]).map(p => (
                            <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-slate-400 block mb-1">Fallback model</label>
                        <select value={fallbackModelId} onChange={e => setFallbackModelId(e.target.value)}
                          className="w-full bg-slate-800 border border-slate-700 text-white text-xs rounded-lg px-3 py-2 focus:outline-none">
                          {MODELS.filter(m => m.provider === fallbackProvider).map(m => (
                            <option key={m.id} value={m.id}>{m.name}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div>
                      <label className="text-xs text-slate-400 block mb-1">Latency threshold (ms)</label>
                      <input type="number" min={500} max={60000} value={latencyThresholdMs}
                        onChange={e => setLatencyThresholdMs(Number(e.target.value))}
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none" />
                      <p className="text-xs text-slate-600 mt-1">If primary model fails or exceeds latency threshold ({latencyThresholdMs}ms), fall back automatically.</p>
                    </div>
                  </div>
                )}
                <div className="flex items-center justify-between pt-1 border-t border-slate-700">
                  <div>
                    <div className="text-sm text-white">Route by task type</div>
                    <div className="text-xs text-slate-500">Different models for different task types — cost efficiency</div>
                  </div>
                  <button onClick={() => setModelRouteByTask(v => !v)}
                    className={`w-10 h-6 rounded-full relative transition-colors flex-shrink-0 ${modelRouteByTask ? 'bg-indigo-500' : 'bg-slate-700'}`}
                    style={modelRouteByTask ? { backgroundColor: accentColor } : {}}>
                    <div className={`w-4 h-4 bg-white rounded-full absolute top-1 transition-all ${modelRouteByTask ? 'left-5' : 'left-1'}`} />
                  </button>
                </div>
                {modelRouteByTask && (
                  <div className="space-y-2">
                    {[
                      { label: 'Simple Q&A', prov: taskRouteSimpleProv, setProv: setTaskRouteSimpleProv, model: taskRouteSimpleModel, setModel: setTaskRouteSimpleModel },
                      { label: 'Complex Reasoning', prov: taskRouteComplexProv, setProv: setTaskRouteComplexProv, model: taskRouteComplexModel, setModel: setTaskRouteComplexModel },
                      { label: 'Code / Structured Output', prov: taskRouteCodeProv, setProv: setTaskRouteCodeProv, model: taskRouteCodeModel, setModel: setTaskRouteCodeModel },
                    ].map(row => (
                      <div key={row.label} className="grid grid-cols-3 gap-2 items-center">
                        <span className="text-xs text-slate-400">{row.label}</span>
                        <select value={row.prov} onChange={e => row.setProv(e.target.value as ModelProvider)}
                          className="bg-slate-800 border border-slate-700 text-white text-xs rounded-lg px-2 py-1.5 focus:outline-none">
                          {(['anthropic', 'openai', 'google'] as ModelProvider[]).map(p => (
                            <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
                          ))}
                        </select>
                        <select value={row.model} onChange={e => row.setModel(e.target.value)}
                          className="bg-slate-800 border border-slate-700 text-white text-xs rounded-lg px-2 py-1.5 focus:outline-none">
                          {MODELS.filter(m => m.provider === row.prov).map(m => (
                            <option key={m.id} value={m.id}>{m.name}</option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Token Budget */}
              {(() => {
                const stored = employees.find(e => e.id === selectedAgent?.id);
                const estimatedTokens = (stored?.tasksThisMonth ?? selectedAgent?.tasksThisMonth ?? 0) * 500;
                const budgetPct = tokenBudgetMonthly > 0 ? Math.min(100, Math.round((estimatedTokens / tokenBudgetMonthly) * 100)) : 0;
                return (
                  <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700 space-y-3">
                    <div className="text-xs font-semibold text-slate-300 uppercase tracking-wide">Token Budget</div>
                    <div>
                      <label className="text-xs text-slate-400 block mb-1">Monthly token limit <span className="text-slate-600">(0 = unlimited)</span></label>
                      <input type="number" min={0} value={tokenBudgetMonthly}
                        onChange={e => setTokenBudgetMonthly(Number(e.target.value))}
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none" />
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-slate-500">~{estimatedTokens.toLocaleString()} tokens used this month (estimated)</span>
                        {tokenBudgetMonthly > 0 && <span className="text-xs text-slate-400">{budgetPct}%</span>}
                      </div>
                      <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full transition-all ${budgetPct > 90 ? 'bg-red-500' : budgetPct > 70 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                          style={{ width: tokenBudgetMonthly > 0 ? `${budgetPct}%` : '0%' }} />
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm text-white">Block DE when budget exceeded</div>
                        <div className="text-xs text-slate-500">When off — warn only</div>
                      </div>
                      <button onClick={() => setTokenBudgetHard(v => !v)}
                        className={`w-10 h-6 rounded-full relative transition-colors flex-shrink-0 ${tokenBudgetHard ? 'bg-red-500' : 'bg-slate-700'}`}>
                        <div className={`w-4 h-4 bg-white rounded-full absolute top-1 transition-all ${tokenBudgetHard ? 'left-5' : 'left-1'}`} />
                      </button>
                    </div>
                  </div>
                );
              })()}

              {/* Save */}
              <div className="flex items-center gap-3 pt-1">
                <button
                  onClick={async () => {
                    const stored = employees.find(e => e.id === selectedAgent?.id);
                    if (!stored) return;
                    await update(stored.id, {
                      model_provider: pickerProv,
                      model_id: pickerId,
                      task_type: pickerTaskType,
                      escalation_model_id: pickerEscModelId,
                      escalation_threshold: pickerEscThreshold,
                    });
                    // Save extended model config
                    if (tenant?.id) {
                      const { supabase: sb } = await import('../../supabase');
                      const mc = (stored as any)?.model_config || {};
                      await sb.from('digital_employees').update({ model_config: { ...mc, fallback_model: modelFallbackEnabled ? fallbackModelId : null, fallback_provider: modelFallbackEnabled ? fallbackProvider : null, latency_threshold_ms: latencyThresholdMs, route_by_task: modelRouteByTask, task_routes: modelRouteByTask ? { simple: { model: taskRouteSimpleModel, provider: taskRouteSimpleProv }, complex: { model: taskRouteComplexModel, provider: taskRouteComplexProv }, code: { model: taskRouteCodeModel, provider: taskRouteCodeProv } } : null, token_budget: { monthly_limit: tokenBudgetMonthly, hard_limit: tokenBudgetHard } } }).eq('id', stored.id).eq('tenant_id', tenant.id);
                    }
                    setModelSaveStatus('saved');
                    setTimeout(() => setModelSaveStatus('idle'), 3000);
                  }}
                  className="px-5 py-2 text-white text-xs font-medium rounded-xl transition-all"
                  style={{ backgroundColor: accentColor }}
                >
                  Save Intelligence Config
                </button>
                {modelSaveStatus === 'saved' && <span className="text-xs text-emerald-400">Saved — active on next query</span>}
              </div>

              <div className="text-xs text-slate-700 pt-1">
                KB semantic search always uses OpenAI embeddings regardless of which response model is selected.
              </div>
            </div>
          )}

          {/* === PIPELINE TAB === */}
          {configTab === 'pipeline' && (
            <div className="space-y-3">
              <div className="text-xs text-slate-400 mb-3">
                The pipeline defines how this agent processes each incoming
                request — from retrieval through reasoning to response. Drag to
                reorder stages.
              </div>
              {selectedAgent.pipeline.map((stage, idx) => {
                const stageColors: Record<string, string> = {
                  retrieval: 'text-blue-400 bg-blue-900',
                  reasoning: 'text-purple-400 bg-purple-900',
                  validation: 'text-yellow-400 bg-yellow-900',
                  action: 'text-emerald-400 bg-emerald-900',
                  response: 'text-indigo-400 bg-indigo-900',
                };
                const color =
                  stageColors[stage.type] || 'text-slate-400 bg-slate-700';
                return (
                  <div
                    key={stage.id}
                    className="bg-slate-800 rounded-lg p-3 border border-slate-700"
                  >
                    <div className="flex items-center gap-3 mb-2">
                      <span className="text-slate-600 text-sm font-mono w-5">
                        {idx + 1}.
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${color}`}
                      >
                        {stage.type}
                      </span>
                      <span className="text-white text-sm font-medium flex-1">
                        {stage.name}
                      </span>
                      <label className="flex items-center gap-1 cursor-pointer">
                        <input
                          type="checkbox"
                          defaultChecked={stage.enabled}
                          className="accent-indigo-500"
                        />
                        <span className="text-xs text-slate-400">Enabled</span>
                      </label>
                    </div>
                    <div className="flex flex-wrap gap-2 pl-8">
                      {Object.entries(stage.config).map(([k, v]) => (
                        <span
                          key={k}
                          className="px-2 py-0.5 bg-slate-700 rounded text-xs text-slate-400"
                        >
                          <span className="text-slate-500">{k}:</span>{' '}
                          <span className="text-slate-300">{String(v)}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
              <button className="w-full py-2 rounded border border-dashed border-slate-600 text-slate-500 text-sm hover:border-indigo-500 hover:text-indigo-400 transition-colors">
                + Add Pipeline Stage
              </button>
            </div>
          )}

          {/* === VALIDATORS TAB === */}
          {configTab === 'validators' && (
            <div className="space-y-3">
              <div className="text-xs text-slate-400 mb-3">
                Validation bots run automatically at each reasoning step. They
                can flag, block, or escalate based on confidence scores, policy
                violations, or detected hallucinations.
              </div>
              {selectedAgent.validationBots.length === 0 && (
                <div className="text-center py-8 text-slate-500 text-sm">
                  No validators configured for this agent.
                </div>
              )}
              {selectedAgent.validationBots.map((bot) => {
                const botIcons: Record<string, string> = {
                  confidence_reviewer: 'CR',
                  knowledge_checker: 'KC',
                  safety_guard: 'SG',
                  compliance_bot: 'CB',
                  hallucination_detector: 'HD',
                };
                const botColors: Record<string, string> = {
                  confidence_reviewer: 'bg-blue-900 text-blue-300',
                  knowledge_checker: 'bg-indigo-900 text-indigo-300',
                  safety_guard: 'bg-red-900 text-red-300',
                  compliance_bot: 'bg-yellow-900 text-yellow-300',
                  hallucination_detector: 'bg-orange-900 text-orange-300',
                };
                const actionColors: Record<string, string> = {
                  flag: 'text-yellow-400',
                  block: 'text-red-400',
                  escalate: 'text-orange-400',
                  log: 'text-slate-400',
                };
                return (
                  <div
                    key={bot.id}
                    className="bg-slate-800 rounded-lg p-4 border border-slate-700"
                  >
                    <div className="flex items-start gap-3">
                      <span
                        className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                          botColors[bot.type] || 'bg-slate-700 text-slate-300'
                        }`}
                      >
                        {botIcons[bot.type] || '?'}
                      </span>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-white text-sm font-medium">
                            {bot.name}
                          </span>
                          <label className="flex items-center gap-1 cursor-pointer ml-auto">
                            <input
                              type="checkbox"
                              defaultChecked={bot.enabled}
                              className="accent-indigo-500"
                            />
                            <span className="text-xs text-slate-400">
                              Active
                            </span>
                          </label>
                        </div>
                        <div className="text-xs text-slate-500 mb-2 capitalize">
                          {bot.type.replace(/_/g, ' ')}
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <div className="text-xs text-slate-500 mb-1">
                              Threshold
                            </div>
                            <div className="flex items-center gap-2">
                              <input
                                type="range"
                                min={50}
                                max={99}
                                defaultValue={bot.threshold}
                                className="flex-1 accent-indigo-500"
                              />
                              <span className="text-white text-xs font-bold w-8 text-right">
                                {bot.threshold}%
                              </span>
                            </div>
                          </div>
                          <div>
                            <div className="text-xs text-slate-500 mb-1">
                              If threshold breached
                            </div>
                            <select
                              className="bg-slate-700 text-white text-xs rounded px-2 py-1 w-full"
                              defaultValue={bot.action}
                            >
                              <option value="flag">Flag for review</option>
                              <option value="block">Block response</option>
                              <option value="escalate">
                                Escalate to human
                              </option>
                              <option value="log">Log only</option>
                            </select>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              <button className="w-full py-2 rounded border border-dashed border-slate-600 text-slate-500 text-sm hover:border-indigo-500 hover:text-indigo-400 transition-colors">
                + Add Validation Bot
              </button>
            </div>
          )}

          {/* === ACTIONS TAB === */}
          {configTab === 'actions' && (
            <div className="space-y-4">
              <div className="text-xs text-slate-400 mb-3">
                Define what this agent is permitted to do — read-only queries,
                write actions, or financial transactions — and whether each
                requires human approval.
              </div>
              <div className="space-y-2">
                {selectedAgent.actions.map((action) => {
                  const isTransaction =
                    action.toLowerCase().includes('refund') ||
                    action.toLowerCase().includes('payment') ||
                    action.toLowerCase().includes('charge') ||
                    action.toLowerCase().includes('subscription');
                  const isWrite =
                    action.toLowerCase().includes('create') ||
                    action.toLowerCase().includes('update') ||
                    action.toLowerCase().includes('send') ||
                    action.toLowerCase().includes('assign') ||
                    action.toLowerCase().includes('reset');
                  const actionType = isTransaction
                    ? 'transaction'
                    : isWrite
                    ? 'write'
                    : 'read';
                  const typeColors: Record<string, string> = {
                    read: 'bg-blue-900 text-blue-300',
                    write: 'bg-yellow-900 text-yellow-300',
                    transaction: 'bg-red-900 text-red-300',
                  };
                  return (
                    <div
                      key={action}
                      className="bg-slate-800 rounded-lg p-3 flex items-center gap-3"
                    >
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${typeColors[actionType]}`}
                      >
                        {actionType}
                      </span>
                      <span className="text-slate-200 text-sm flex-1">
                        {action}
                      </span>
                      <label className="flex items-center gap-1 cursor-pointer text-xs text-slate-400">
                        <input
                          type="checkbox"
                          defaultChecked={actionType === 'transaction'}
                          className="accent-orange-500"
                        />
                        Approval required
                      </label>
                      <label className="flex items-center gap-1 cursor-pointer text-xs text-slate-400">
                        <input
                          type="checkbox"
                          defaultChecked={true}
                          className="accent-indigo-500"
                        />
                        Audit log
                      </label>
                    </div>
                  );
                })}
              </div>
              <button className="w-full py-2 rounded border border-dashed border-slate-600 text-slate-500 text-sm hover:border-indigo-500 hover:text-indigo-400 transition-colors">
                + Add Permitted Action
              </button>
              <div className="bg-slate-800 rounded-lg p-4">
                <div className="text-xs text-slate-400 mb-3 font-semibold uppercase tracking-wide">
                  Global Action Policy
                </div>
                <label className="flex items-center gap-2 mb-2 cursor-pointer">
                  <input
                    type="checkbox"
                    defaultChecked={selectedAgent.requiredApproval}
                    className="accent-orange-500"
                  />
                  <span className="text-slate-300 text-sm">
                    Require human approval for ALL actions (override)
                  </span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    defaultChecked={true}
                    className="accent-indigo-500"
                  />
                  <span className="text-slate-300 text-sm">
                    Always audit-log every action taken
                  </span>
                </label>
              </div>
            </div>
          )}

          {/* === KNOWLEDGE & DATA TAB === */}
          {configTab === 'knowledge' && (
            <div className="space-y-4">
              <div className="text-xs text-slate-400 mb-3">
                Configure exactly which knowledge articles, data connector
                fields, and imported files this agent can retrieve during its
                RAG pipeline.
              </div>

              {/* Knowledge Sources — taxonomy picker */}
              <div className="bg-slate-800 rounded-lg p-4">
                <div className="text-xs text-slate-400 mb-3 font-semibold uppercase tracking-wide">
                  Knowledge Sources (KB Articles)
                </div>
                <div className="space-y-2">
                  {knowledgeTaxonomy.map((prod) => {
                    const items = mockKnowledgeItems.filter(
                      (i) => i.productId === prod.id
                    );
                    const connected = selectedAgent.knowledgeSources.some((s) =>
                      s
                        .toLowerCase()
                        .includes(prod.label.toLowerCase().split(' ')[0])
                    );
                    return (
                      <div
                        key={prod.id}
                        className="flex items-start gap-3 p-2 rounded-lg bg-slate-750 border border-slate-700"
                      >
                        <input
                          type="checkbox"
                          defaultChecked={connected}
                          className="mt-0.5 accent-indigo-500 flex-shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span
                              className="w-2 h-2 rounded-full flex-shrink-0"
                              style={{ backgroundColor: prod.color }}
                            />
                            <span className="text-sm text-white font-medium">
                              {prod.label}
                            </span>
                            <span className="text-xs text-slate-500 ml-auto">
                              {items.length} articles
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {prod.modules.slice(0, 3).map((mod) => (
                              <span
                                key={mod.id}
                                className="px-1.5 py-0.5 bg-slate-700 text-slate-400 rounded text-xs"
                              >
                                {mod.label}
                              </span>
                            ))}
                            {prod.modules.length > 3 && (
                              <span className="text-xs text-slate-600">
                                +{prod.modules.length - 3} more
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Data Connectors — field-level scope */}
              <div className="bg-slate-800 rounded-lg p-4">
                <div className="text-xs text-slate-400 mb-3 font-semibold uppercase tracking-wide">
                  Data Connector Bindings
                </div>
                <div className="space-y-2">
                  {registeredConnectors.map((dc) => {
                    const binding = dc.agentBindings.find(
                      (b) => b.agentId === selectedAgent.id
                    );
                    const isBound = !!binding;
                    const catColors2: Record<ConnectorCategory, string> = {
                      crm: 'bg-blue-900 text-blue-300',
                      billing: 'bg-emerald-900 text-emerald-300',
                      hr: 'bg-purple-900 text-purple-300',
                      support: 'bg-orange-900 text-orange-300',
                      analytics: 'bg-yellow-900 text-yellow-300',
                      storage: 'bg-slate-700 text-slate-300',
                      communication: 'bg-indigo-900 text-indigo-300',
                      custom: 'bg-red-900 text-red-300',
                    };
                    return (
                      <div
                        key={dc.id}
                        className={`p-3 rounded-lg border ${
                          isBound
                            ? 'border-indigo-700 bg-indigo-950/20'
                            : 'border-slate-700 bg-slate-750'
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <input
                            type="checkbox"
                            defaultChecked={isBound}
                            className="accent-indigo-500 flex-shrink-0"
                          />
                          <span className="w-6 h-6 rounded bg-slate-700 flex items-center justify-center text-xs font-bold text-slate-300 flex-shrink-0">
                            {dc.icon}
                          </span>
                          <span className="text-sm text-white font-medium">
                            {dc.name}
                          </span>
                          <span
                            className={`px-1.5 py-0.5 rounded text-xs ${
                              catColors2[dc.category]
                            }`}
                          >
                            {dc.category}
                          </span>
                          <span
                            className={`text-xs ml-auto ${
                              dc.status === 'connected'
                                ? 'text-emerald-400'
                                : 'text-slate-500'
                            }`}
                          >
                            {dc.status}
                          </span>
                        </div>
                        {isBound && binding && (
                          <div className="ml-8 mt-1.5 flex flex-wrap gap-1">
                            {binding.objects.map((obj) => {
                              const readable = Object.entries(
                                obj.fieldPermissions
                              )
                                .filter(([, v]) => v === 'read')
                                .map(([k]) => k);
                              const writable = Object.entries(
                                obj.fieldPermissions
                              )
                                .filter(([, v]) => v === 'write')
                                .map(([k]) => k);
                              return (
                                <div key={obj.objectName} className="text-xs">
                                  <span className="text-slate-500">
                                    {obj.objectName}:{' '}
                                  </span>
                                  {readable.length > 0 && (
                                    <span className="text-emerald-500">
                                      read({readable.slice(0, 3).join(', ')}
                                      {readable.length > 3 ? '...' : ''})
                                    </span>
                                  )}
                                  {writable.length > 0 && (
                                    <span className="text-yellow-500 ml-1">
                                      write({writable.join(', ')})
                                    </span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {!isBound && (
                          <div className="ml-8 text-xs text-slate-600 mt-0.5">
                            {dc.objects.length} objects available — enable to
                            configure field permissions
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Imported Files */}
              <div className="bg-slate-800 rounded-lg p-4">
                <div className="text-xs text-slate-400 mb-3 font-semibold uppercase tracking-wide">
                  Imported Files Access
                </div>
                <div className="space-y-1.5">
                  {mockImportedFiles
                    .filter((f) => f.status === 'indexed')
                    .map((file) => {
                      const fileTypeColors: Record<string, string> = {
                        PDF: 'text-red-400',
                        XLSX: 'text-emerald-400',
                        DOCX: 'text-blue-400',
                        PPTX: 'text-orange-400',
                        MD: 'text-slate-400',
                      };
                      return (
                        <div key={file.id} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            defaultChecked={
                              file.audience === 'Both' ||
                              (file.audience === 'Internal' &&
                                selectedAgent.category === 'Internal')
                            }
                            className="accent-indigo-500 flex-shrink-0"
                          />
                          <span
                            className={`text-xs font-bold ${
                              fileTypeColors[file.type] || 'text-slate-400'
                            }`}
                          >
                            {file.type}
                          </span>
                          <span className="text-xs text-slate-300 flex-1 truncate">
                            {file.name}
                          </span>
                          <span className="text-xs text-slate-600">
                            {file.chunkCount} chunks
                          </span>
                          <span
                            className={`px-1.5 py-0.5 rounded text-xs bg-slate-700 ${
                              file.audience === 'Customer'
                                ? 'text-indigo-300'
                                : file.audience === 'Internal'
                                ? 'text-slate-300'
                                : 'text-teal-300'
                            }`}
                          >
                            {file.audience}
                          </span>
                        </div>
                      );
                    })}
                </div>
              </div>

              {/* Retrieval Priority */}
              <div className="bg-slate-800 rounded-lg p-4">
                <div className="text-xs text-slate-400 mb-3 font-semibold uppercase tracking-wide">
                  Retrieval Priority Order
                </div>
                <div className="text-xs text-slate-500 mb-2">
                  Sources are queried in this order during RAG retrieval. Drag
                  to reorder.
                </div>
                <div className="space-y-1.5">
                  {[
                    '1. Knowledge Base Articles',
                    '2. Data Connectors (live)',
                    '3. Imported Files',
                    '4. Insight Engine Queries',
                  ].map((item, idx) => (
                    <div
                      key={idx}
                      className="flex items-center gap-2 p-2 bg-slate-700 rounded-lg cursor-move"
                    >
                      <span className="text-slate-600 text-xs">{'='}</span>
                      <span className="text-xs text-slate-300">{item}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Test DE — live conversation with real KB retrieval */}
              {tenant?.id && (
                <div className="bg-slate-800 rounded-lg p-4" style={{ minHeight: 320 }}>
                  <div className="text-xs text-slate-400 mb-3 font-semibold uppercase tracking-wide flex items-center justify-between">
                    <span>Test This DE</span>
                    <span className="text-slate-600 normal-case font-normal">Live · uses your knowledge base</span>
                  </div>
                  <div style={{ height: 300 }} className="flex flex-col">
                    <DETestPanel
                      tenantId={tenant.id}
                      deId={employees.find(e => e.name === selectedAgent?.name)?.id}
                      deName={selectedAgent?.name ?? 'Digital Employee'}
                      accentColor={accentColor}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-slate-700">
            <button
              onClick={() => setSelectedAgent(null)}
              className="px-4 py-2 rounded-lg bg-slate-700 text-slate-300 text-sm hover:bg-slate-600"
            >
              Cancel
            </button>
            <button
              className="px-4 py-2 rounded-lg text-white text-sm font-medium hover:opacity-90"
              style={{ backgroundColor: accentColor }}
            >
              Save Configuration
            </button>
          </div>
        </Modal>
      )}

      {showHireModal && (
        <HireModal
          accentColor={accentColor}
          onClose={() => setShowHireModal(false)}
          onHire={(de) => {
            hire(de);
            setShowHireModal(false);
          }}
        />
      )}
    </div>
  );
};

export default AgentWorkforcePage;
