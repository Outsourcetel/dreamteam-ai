import { useState, useEffect, useCallback } from 'react';

export type RiskLevel = 'low' | 'medium' | 'high';
export type CapabilityStatus = 'active' | 'disabled' | 'draft';

export interface BusinessCapability {
  id: string;
  name: string;
  description: string;
  workspace: string;
  icon: string;
  status: CapabilityStatus;
  assignedDEs: string[];
  requiredConnectors: string[];
  requiredKnowledge: string[];
  approvalRequired: boolean;
  riskLevel: RiskLevel;
  inputs: string[];
  outputs: string[];
  runCount: number;
  lastRun?: string;
  avgConfidence?: number;
  avgHandleTime?: string;
}

const DEFAULT_CAPABILITIES: BusinessCapability[] = [
  // Support
  { id: 'cap_answer_query', name: 'Answer Customer Query', description: 'Respond to an inbound customer question using KB + conversation history', workspace: 'Support', icon: '💬', status: 'active', assignedDEs: ['de_support'], requiredConnectors: ['zendesk'], requiredKnowledge: ['Product', 'Support Scripts', 'Onboarding'], approvalRequired: false, riskLevel: 'low', inputs: ['customer_message', 'conversation_history'], outputs: ['response_text', 'confidence_score', 'citations'], runCount: 4821, lastRun: '2 min ago', avgConfidence: 0.87, avgHandleTime: '8s' },
  { id: 'cap_issue_refund', name: 'Issue Credit / Refund', description: 'Process a customer refund within configured value limits', workspace: 'Support', icon: '↩', status: 'active', assignedDEs: ['de_billing'], requiredConnectors: ['stripe', 'zendesk'], requiredKnowledge: ['Billing'], approvalRequired: true, riskLevel: 'high', inputs: ['customer_id', 'amount', 'reason'], outputs: ['refund_confirmation', 'audit_entry'], runCount: 142, lastRun: '1 hr ago', avgConfidence: 0.91, avgHandleTime: '14s' },
  { id: 'cap_escalate_human', name: 'Escalate to Human', description: 'Identify when a conversation needs human intervention and route to the right team', workspace: 'Support', icon: '⬆', status: 'active', assignedDEs: ['de_support', 'de_billing'], requiredConnectors: ['zendesk', 'slack'], requiredKnowledge: ['Support Scripts'], approvalRequired: false, riskLevel: 'medium', inputs: ['conversation_context', 'escalation_reason'], outputs: ['escalation_ticket', 'human_handoff_summary'], runCount: 287, lastRun: '34 min ago', avgConfidence: 0.79, avgHandleTime: '5s' },
  { id: 'cap_summarise_case', name: 'Summarise Case History', description: 'Produce a concise summary of all customer interactions and open issues', workspace: 'Support', icon: '≡', status: 'active', assignedDEs: ['de_support', 'de_cs'], requiredConnectors: ['zendesk'], requiredKnowledge: [], approvalRequired: false, riskLevel: 'low', inputs: ['customer_id', 'date_range'], outputs: ['case_summary_md', 'open_issues_list'], runCount: 618, lastRun: '12 min ago', avgConfidence: 0.93, avgHandleTime: '6s' },

  // Revenue
  { id: 'cap_qualify_lead', name: 'Qualify Lead', description: 'Score and qualify inbound leads against ICP criteria from CRM and enrichment data', workspace: 'Revenue', icon: '◉', status: 'active', assignedDEs: ['de_sales'], requiredConnectors: ['salesforce'], requiredKnowledge: ['Product'], approvalRequired: false, riskLevel: 'low', inputs: ['lead_data', 'company_info'], outputs: ['qualification_score', 'icp_match', 'next_action'], runCount: 931, lastRun: '8 min ago', avgConfidence: 0.82, avgHandleTime: '11s' },
  { id: 'cap_draft_outreach', name: 'Draft Outreach', description: 'Generate personalised outreach copy based on prospect research and product fit', workspace: 'Revenue', icon: '✉', status: 'active', assignedDEs: ['de_sales'], requiredConnectors: ['salesforce'], requiredKnowledge: ['Product', 'Onboarding'], approvalRequired: true, riskLevel: 'medium', inputs: ['prospect_id', 'outreach_goal', 'tone'], outputs: ['email_draft', 'linkedin_message_draft'], runCount: 524, lastRun: '25 min ago', avgConfidence: 0.78, avgHandleTime: '18s' },
  { id: 'cap_research_account', name: 'Research Account', description: 'Deep-dive research on a target account: news, financials, org chart, buying signals', workspace: 'Revenue', icon: '⚲', status: 'active', assignedDEs: ['de_sales', 'de_cs'], requiredConnectors: ['salesforce'], requiredKnowledge: [], approvalRequired: false, riskLevel: 'low', inputs: ['company_name', 'domain'], outputs: ['account_brief', 'key_contacts', 'buying_signals'], runCount: 312, lastRun: '1 hr ago', avgConfidence: 0.85, avgHandleTime: '22s' },
  { id: 'cap_update_crm', name: 'Update CRM Record', description: 'Write call notes, update deal stage, log activities in Salesforce after customer interactions', workspace: 'Revenue', icon: '↺', status: 'active', assignedDEs: ['de_sales'], requiredConnectors: ['salesforce'], requiredKnowledge: [], approvalRequired: false, riskLevel: 'low', inputs: ['deal_id', 'call_transcript'], outputs: ['crm_update_confirmation', 'summary_note'], runCount: 1204, lastRun: '3 min ago', avgConfidence: 0.94, avgHandleTime: '7s' },

  // Finance
  { id: 'cap_detect_exception', name: 'Detect Transaction Exception', description: 'Flag anomalous transactions against policy rules and historical patterns', workspace: 'Finance', icon: '⚠', status: 'active', assignedDEs: ['de_finance'], requiredConnectors: ['stripe'], requiredKnowledge: ['Finance Procedures', 'Compliance'], approvalRequired: false, riskLevel: 'medium', inputs: ['transaction_batch'], outputs: ['exception_list', 'severity_scores', 'audit_entry'], runCount: 2088, lastRun: '5 min ago', avgConfidence: 0.89, avgHandleTime: '3s' },
  { id: 'cap_reconcile', name: 'Reconcile Statement', description: 'Match bank statement lines to ledger entries and surface unmatched items', workspace: 'Finance', icon: '=', status: 'active', assignedDEs: ['de_finance'], requiredConnectors: ['stripe'], requiredKnowledge: ['Finance Procedures'], approvalRequired: true, riskLevel: 'high', inputs: ['bank_statement', 'ledger_export'], outputs: ['reconciliation_report', 'unmatched_items'], runCount: 47, lastRun: '2 days ago', avgConfidence: 0.96, avgHandleTime: '45s' },

  // HR
  { id: 'cap_onboard_employee', name: 'Onboard New Employee', description: 'Trigger onboarding sequence: accounts, checklist, welcome pack, buddy assignment', workspace: 'HR', icon: '⊕', status: 'active', assignedDEs: ['de_hr'], requiredConnectors: ['bamboohr', 'slack'], requiredKnowledge: ['Onboarding', 'HR Policies'], approvalRequired: true, riskLevel: 'medium', inputs: ['employee_record', 'start_date', 'department'], outputs: ['onboarding_checklist', 'system_access_requests', 'welcome_message'], runCount: 23, lastRun: '3 days ago', avgConfidence: 0.88, avgHandleTime: '30s' },
  { id: 'cap_answer_hr_policy', name: 'Answer HR Policy Question', description: 'Respond to employee questions about leave, benefits, policies using HR KB', workspace: 'HR', icon: '?', status: 'active', assignedDEs: ['de_hr'], requiredConnectors: [], requiredKnowledge: ['HR Policies', 'Compliance'], approvalRequired: false, riskLevel: 'low', inputs: ['employee_question'], outputs: ['policy_answer', 'relevant_articles'], runCount: 389, lastRun: '15 min ago', avgConfidence: 0.86, avgHandleTime: '9s' },

  // Compliance
  { id: 'cap_flag_compliance', name: 'Flag Compliance Risk', description: 'Scan conversation or document for policy violations and raise alerts', workspace: 'Compliance', icon: '⛛', status: 'draft', assignedDEs: ['de_compliance'], requiredConnectors: [], requiredKnowledge: ['Compliance', 'Legal'], approvalRequired: false, riskLevel: 'medium', inputs: ['document_or_conversation'], outputs: ['risk_flags', 'policy_references', 'recommended_actions'], runCount: 0, avgHandleTime: '—' },
];

const STORAGE_KEY = 'dt_capabilities';

function load(): BusinessCapability[] | null {
  try { const r = localStorage.getItem(STORAGE_KEY); return r ? JSON.parse(r) : null; } catch { return null; }
}
function save(s: BusinessCapability[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {}
}

export function useCapabilities() {
  const [capabilities, setCapabilities] = useState<BusinessCapability[]>(() => load() ?? DEFAULT_CAPABILITIES);

  useEffect(() => { save(capabilities); }, [capabilities]);

  const toggleCapability = useCallback((id: string) => {
    setCapabilities(prev => prev.map(c =>
      c.id === id ? { ...c, status: c.status === 'active' ? 'disabled' : 'active' } : c
    ));
  }, []);

  const setApprovalRequired = useCallback((id: string, required: boolean) => {
    setCapabilities(prev => prev.map(c => c.id === id ? { ...c, approvalRequired: required } : c));
  }, []);

  const setRiskLevel = useCallback((id: string, level: RiskLevel) => {
    setCapabilities(prev => prev.map(c => c.id === id ? { ...c, riskLevel: level } : c));
  }, []);

  const assignDE = useCallback((id: string, deIds: string[]) => {
    setCapabilities(prev => prev.map(c => c.id === id ? { ...c, assignedDEs: deIds } : c));
  }, []);

  return { capabilities, toggleCapability, setApprovalRequired, setRiskLevel, assignDE };
}
