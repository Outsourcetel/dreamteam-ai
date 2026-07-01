import { useState, useEffect, useCallback } from 'react';

export interface DEConnectorBinding {
  connectorId: string;
  connectorName: string;
  deIds: string[];
  permission: 'read' | 'read-write';
}

export interface DEKnowledgeScope {
  deId: string;
  deName: string;
  categories: Record<string, 'trusted' | 'restricted' | 'none'>;
}

export type ActionPermission = 'allow' | 'approval_required' | 'block';

export interface ActionRule {
  id: string;
  actionType: string;
  description: string;
  workspace: string;
  riskLevel: 'low' | 'medium' | 'high';
  permission: ActionPermission;
  valueLimit?: number; // max $ value before requiring approval
  deScope: 'all' | string[]; // which DEs this rule applies to
}

const DEFAULT_CONNECTORS = [
  { id: 'salesforce', name: 'Salesforce', category: 'CRM' },
  { id: 'zendesk', name: 'Zendesk', category: 'Support' },
  { id: 'stripe', name: 'Stripe', category: 'Finance' },
  { id: 'confluence', name: 'Confluence', category: 'Knowledge' },
  { id: 'slack', name: 'Slack', category: 'Communication' },
  { id: 'google_drive', name: 'Google Drive', category: 'Storage' },
  { id: 'bamboohr', name: 'BambooHR', category: 'HR' },
  { id: 'webhook', name: 'Webhook', category: 'Developer' },
];

const DEFAULT_KB_CATEGORIES = [
  'Onboarding', 'Security', 'Billing', 'Product', 'HR Policies',
  'Compliance', 'Support Scripts', 'Finance Procedures', 'Legal', 'Uploaded',
];

const DEFAULT_DES = [
  { id: 'de_support', name: 'Support Specialist' },
  { id: 'de_billing', name: 'Billing Specialist' },
  { id: 'de_hr', name: 'HR Advisor' },
  { id: 'de_sales', name: 'Sales Assist' },
  { id: 'de_cs', name: 'CS Account DE' },
  { id: 'de_compliance', name: 'Compliance Officer' },
  { id: 'de_knowledge', name: 'Knowledge Curator' },
  { id: 'de_finance', name: 'Finance Analyst' },
];

const DEFAULT_BINDINGS: DEConnectorBinding[] = [
  { connectorId: 'zendesk', connectorName: 'Zendesk', deIds: ['de_support', 'de_cs'], permission: 'read-write' },
  { connectorId: 'stripe', connectorName: 'Stripe', deIds: ['de_billing', 'de_finance'], permission: 'read' },
  { connectorId: 'salesforce', connectorName: 'Salesforce', deIds: ['de_sales', 'de_cs'], permission: 'read-write' },
  { connectorId: 'confluence', connectorName: 'Confluence', deIds: ['de_support', 'de_knowledge', 'de_hr'], permission: 'read' },
  { connectorId: 'slack', connectorName: 'Slack', deIds: ['de_support', 'de_cs', 'de_hr'], permission: 'read-write' },
  { connectorId: 'bamboohr', connectorName: 'BambooHR', deIds: ['de_hr'], permission: 'read-write' },
  { connectorId: 'google_drive', connectorName: 'Google Drive', deIds: ['de_knowledge', 'de_compliance'], permission: 'read' },
  { connectorId: 'webhook', connectorName: 'Webhook', deIds: [], permission: 'read' },
];

const DEFAULT_KNOWLEDGE_SCOPES: DEKnowledgeScope[] = [
  { deId: 'de_support', deName: 'Support Specialist', categories: { Onboarding: 'trusted', Security: 'restricted', Billing: 'trusted', Product: 'trusted', 'HR Policies': 'none', Compliance: 'restricted', 'Support Scripts': 'trusted', 'Finance Procedures': 'none', Legal: 'none', Uploaded: 'trusted' } },
  { deId: 'de_billing', deName: 'Billing Specialist', categories: { Onboarding: 'none', Security: 'restricted', Billing: 'trusted', Product: 'restricted', 'HR Policies': 'none', Compliance: 'trusted', 'Support Scripts': 'restricted', 'Finance Procedures': 'trusted', Legal: 'restricted', Uploaded: 'restricted' } },
  { deId: 'de_hr', deName: 'HR Advisor', categories: { Onboarding: 'trusted', Security: 'restricted', Billing: 'none', Product: 'none', 'HR Policies': 'trusted', Compliance: 'trusted', 'Support Scripts': 'none', 'Finance Procedures': 'none', Legal: 'trusted', Uploaded: 'restricted' } },
  { deId: 'de_sales', deName: 'Sales Assist', categories: { Onboarding: 'trusted', Security: 'none', Billing: 'restricted', Product: 'trusted', 'HR Policies': 'none', Compliance: 'restricted', 'Support Scripts': 'none', 'Finance Procedures': 'none', Legal: 'none', Uploaded: 'trusted' } },
  { deId: 'de_compliance', deName: 'Compliance Officer', categories: { Onboarding: 'trusted', Security: 'trusted', Billing: 'trusted', Product: 'trusted', 'HR Policies': 'trusted', Compliance: 'trusted', 'Support Scripts': 'trusted', 'Finance Procedures': 'trusted', Legal: 'trusted', Uploaded: 'restricted' } },
  { deId: 'de_finance', deName: 'Finance Analyst', categories: { Onboarding: 'none', Security: 'restricted', Billing: 'trusted', Product: 'none', 'HR Policies': 'none', Compliance: 'trusted', 'Support Scripts': 'none', 'Finance Procedures': 'trusted', Legal: 'trusted', Uploaded: 'restricted' } },
];

const DEFAULT_ACTION_RULES: ActionRule[] = [
  { id: 'ar1', actionType: 'Issue credit / refund', description: 'DE issues monetary credit or refund to a customer account', workspace: 'Finance', riskLevel: 'high', permission: 'approval_required', valueLimit: 100, deScope: ['de_billing'] },
  { id: 'ar2', actionType: 'Send customer email', description: 'DE sends an email to a customer on behalf of the organisation', workspace: 'Support', riskLevel: 'medium', permission: 'approval_required', deScope: 'all' },
  { id: 'ar3', actionType: 'Update CRM record', description: 'DE modifies a CRM contact, deal, or account record', workspace: 'Revenue', riskLevel: 'low', permission: 'allow', deScope: ['de_sales', 'de_cs'] },
  { id: 'ar4', actionType: 'Archive knowledge article', description: 'DE archives or removes an article from the Knowledge Hub', workspace: 'Knowledge', riskLevel: 'medium', permission: 'approval_required', deScope: ['de_knowledge', 'de_compliance'] },
  { id: 'ar5', actionType: 'Export customer data', description: 'DE generates or exports a dataset containing customer information', workspace: 'Admin', riskLevel: 'high', permission: 'approval_required', deScope: 'all' },
  { id: 'ar6', actionType: 'Reset user credentials', description: 'DE triggers a password reset or 2FA change for a user', workspace: 'Support', riskLevel: 'high', permission: 'approval_required', deScope: ['de_support'] },
  { id: 'ar7', actionType: 'Create HR record', description: 'DE creates or modifies an employee record in the HRIS', workspace: 'HR', riskLevel: 'medium', permission: 'approval_required', deScope: ['de_hr'] },
  { id: 'ar8', actionType: 'Answer customer question', description: 'DE responds to an inbound customer query via chat or email', workspace: 'Support', riskLevel: 'low', permission: 'allow', deScope: ['de_support', 'de_billing'] },
  { id: 'ar9', actionType: 'Flag compliance issue', description: 'DE raises a compliance flag on a conversation or document', workspace: 'Compliance', riskLevel: 'low', permission: 'allow', deScope: ['de_compliance'] },
  { id: 'ar10', actionType: 'Process invoice / payment', description: 'DE initiates, approves, or records a financial transaction', workspace: 'Finance', riskLevel: 'high', permission: 'block', deScope: ['de_finance', 'de_billing'] },
];

const STORAGE_KEY = 'dt_control_fabric';

interface ControlFabricState {
  bindings: DEConnectorBinding[];
  knowledgeScopes: DEKnowledgeScope[];
  actionRules: ActionRule[];
}

function load(): ControlFabricState | null {
  try { const r = localStorage.getItem(STORAGE_KEY); return r ? JSON.parse(r) : null; } catch { return null; }
}
function save(s: ControlFabricState) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {}
}

export function useControlFabric() {
  const [state, setState] = useState<ControlFabricState>(() => load() ?? {
    bindings: DEFAULT_BINDINGS,
    knowledgeScopes: DEFAULT_KNOWLEDGE_SCOPES,
    actionRules: DEFAULT_ACTION_RULES,
  });

  useEffect(() => { save(state); }, [state]);

  const toggleDEConnector = useCallback((connectorId: string, deId: string) => {
    setState(prev => ({
      ...prev,
      bindings: prev.bindings.map(b =>
        b.connectorId === connectorId
          ? { ...b, deIds: b.deIds.includes(deId) ? b.deIds.filter(id => id !== deId) : [...b.deIds, deId] }
          : b
      ),
    }));
  }, []);

  const setConnectorPermission = useCallback((connectorId: string, permission: 'read' | 'read-write') => {
    setState(prev => ({
      ...prev,
      bindings: prev.bindings.map(b => b.connectorId === connectorId ? { ...b, permission } : b),
    }));
  }, []);

  const setKnowledgeScope = useCallback((deId: string, category: string, level: 'trusted' | 'restricted' | 'none') => {
    setState(prev => ({
      ...prev,
      knowledgeScopes: prev.knowledgeScopes.map(s =>
        s.deId === deId ? { ...s, categories: { ...s.categories, [category]: level } } : s
      ),
    }));
  }, []);

  const setActionRule = useCallback((ruleId: string, permission: ActionPermission, valueLimit?: number) => {
    setState(prev => ({
      ...prev,
      actionRules: prev.actionRules.map(r =>
        r.id === ruleId ? { ...r, permission, ...(valueLimit !== undefined ? { valueLimit } : {}) } : r
      ),
    }));
  }, []);

  return {
    bindings: state.bindings,
    knowledgeScopes: state.knowledgeScopes,
    actionRules: state.actionRules,
    connectors: DEFAULT_CONNECTORS,
    digitalEmployees: DEFAULT_DES,
    kbCategories: DEFAULT_KB_CATEGORIES,
    toggleDEConnector,
    setConnectorPermission,
    setKnowledgeScope,
    setActionRule,
  };
}
