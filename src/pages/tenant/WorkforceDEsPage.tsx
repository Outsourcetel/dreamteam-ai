import React, { useState, useEffect } from 'react'
import { useAuth } from '../../context/AuthContext'
import type { Page } from '../../types'
import { getPeople, ROSTER_SELECT_KEY, type Person } from '../../data/people'
import { useDataMode } from '../../lib/dataMode'
import LiveWorkforceDEs from './LiveWorkforceDEs'
import { AmendmentWizard } from '../../components/AmendmentWizard'
import { DEAuthorityPanel } from '../../components/DEAuthorityPanel'
import { SophieEscalationRules } from '../../components/SophieEscalationRules'
import { DEKnowledgeScopePanel } from '../../components/DEKnowledgeScopePanel'
import { DEPreApprovalRulesPanel } from '../../components/DEPreApprovalRulesPanel'
import { SophieConfigurationSummary } from '../../components/SophieConfigurationSummary'
import { PendingAmendmentsWidget } from '../../components/PendingAmendmentsWidget'
import { MetricsDisplay } from '../../components/MetricsDisplay'
import { DEConfigurationTab } from '../../components/DEConfigurationTab'
import { SophieConfigurationEditor } from '../../components/SophieConfigurationEditor'
import { AmendmentMetricsPanel } from '../../components/AmendmentMetricsPanel'

// ── Types ─────────────────────────────────────────────────────────

type DEStatus = 'active' | 'degraded' | 'at_risk' | 'offline'
type DEEntity = 'customer' | 'vendor' | 'workforce' | 'specialist'

interface KnowledgeConfig {
  collections: { name: string; accessLevel: 'read' | 'read_write'; coverage: number }[]
  types: { type: string; enabled: boolean; confidenceFloor: number }[]
  gapDetection: boolean
  gapSensitivity: 'low' | 'medium' | 'high'
}

interface SOP {
  id: string; title: string; category: string; version: string; lastUpdated: string; status: 'active' | 'draft' | 'archived'
}

interface PlaybookAssignment {
  id: string; title: string; type: 'process' | 'response' | 'escalation' | 'cross_function' | 'crisis' | 'scheduled'; active: boolean; priority: number
}

interface SystemAccess {
  id: string; name: string; type: string; accessLevel: 'read' | 'read_write' | 'admin'; status: 'connected' | 'error' | 'disconnected'; lastSync: string
}

interface GuardrailConfig {
  industryTemplate: string
  customerOverrides: { id: string; rule: string; type: 'allow' | 'restrict'; addedBy: string; date: string }[]
  deRestrictions: string[]
  piiHandling: 'mask' | 'hash' | 'redact' | 'allowed'
  contentFilter: 'strict' | 'standard' | 'permissive'
  version: string
  lastUpdated: string
}

interface HumanLoopConfig {
  touchpoints: {
    type: 'approval_gate' | 'review_gate' | 'escalation' | 'override' | 'training_feedback'
    label: string; enabled: boolean; confidenceThreshold: number; amountThreshold?: number; escalateTo: string; slaDays: number
  }[]
}

interface AuditEntry {
  id: string; timestamp: string; action: string; outcome: string; type: 'resolved' | 'escalated' | 'kb_gap' | 'error' | 'config_change'
}

export interface DEProfile {
  id: string
  name: string
  role: string
  entity: DEEntity
  status: DEStatus
  confidence: number
  escalationRate: number
  resolutionRate: number
  avgResponseTime: string
  errorRate: number
  trainingStatus: 'certified' | 'in_training' | 'needs_recert'
  lastTrained: string
  nextRecert: string
  language: string
  timezone: string
  channels: string[]
  description: string
  knowledge: KnowledgeConfig
  sops: SOP[]
  playbooks: PlaybookAssignment[]
  systems: SystemAccess[]
  guardrails: GuardrailConfig
  humanLoop: HumanLoopConfig
  auditLog: AuditEntry[]
}

// ── Seed Data ─────────────────────────────────────────────────────

export const TCP_DES: DEProfile[] = [
  {
    id: 'alex', name: 'Alex', role: 'Customer Support DE', entity: 'customer',
    status: 'active', confidence: 91, escalationRate: 12, resolutionRate: 88, avgResponseTime: '1.2 min', errorRate: 2,
    trainingStatus: 'certified', lastTrained: '2026-05-14', nextRecert: '2026-11-14',
    language: 'English', timezone: 'UTC-5 (EST)', channels: ['Chat', 'Email', 'API'],
    description: 'Handles all inbound customer support requests — tickets, troubleshooting, documentation lookup, and escalation routing. Primary DE for Customer Lifecycle.',
    knowledge: {
      collections: [
        { name: 'Product Docs', accessLevel: 'read', coverage: 94 },
        { name: 'API Reference', accessLevel: 'read', coverage: 87 },
        { name: 'Troubleshooting Guides', accessLevel: 'read', coverage: 91 },
        { name: 'Customer History', accessLevel: 'read_write', coverage: 78 },
      ],
      types: [
        { type: 'Reference', enabled: true, confidenceFloor: 75 },
        { type: 'Procedural', enabled: true, confidenceFloor: 80 },
        { type: 'Regulatory', enabled: false, confidenceFloor: 85 },
        { type: 'Institutional', enabled: true, confidenceFloor: 70 },
        { type: 'Customer (PII)', enabled: true, confidenceFloor: 90 },
        { type: 'Competitive', enabled: false, confidenceFloor: 85 },
        { type: 'Training', enabled: true, confidenceFloor: 75 },
      ],
      gapDetection: true, gapSensitivity: 'high',
    },
    sops: [
      { id: 's1', title: 'New Ticket Intake', category: 'Support', version: '2.1', lastUpdated: '2026-04-01', status: 'active' },
      { id: 's2', title: 'Severity Classification', category: 'Support', version: '1.4', lastUpdated: '2026-03-15', status: 'active' },
      { id: 's3', title: 'Escalation Protocol', category: 'Escalation', version: '3.0', lastUpdated: '2026-05-01', status: 'active' },
      { id: 's4', title: 'Customer Communication Standards', category: 'Communication', version: '1.2', lastUpdated: '2026-02-10', status: 'active' },
      { id: 's5', title: 'Knowledge Article Submission', category: 'Knowledge', version: '1.0', lastUpdated: '2026-01-20', status: 'draft' },
    ],
    playbooks: [
      { id: 'p1', title: 'Inbound Support Resolution', type: 'process', active: true, priority: 1 },
      { id: 'p2', title: 'Auth & Access Issues', type: 'response', active: true, priority: 2 },
      { id: 'p3', title: 'Critical Outage Response', type: 'crisis', active: true, priority: 3 },
      { id: 'p4', title: 'L2 Escalation Handoff', type: 'escalation', active: true, priority: 4 },
      { id: 'p5', title: 'Weekly Support Digest', type: 'scheduled', active: false, priority: 5 },
    ],
    systems: [
      { id: 'sys1', name: 'Zendesk', type: 'Support', accessLevel: 'read_write', status: 'connected', lastSync: '2 min ago' },
      { id: 'sys2', name: 'Confluence', type: 'Knowledge', accessLevel: 'read', status: 'connected', lastSync: '15 min ago' },
      { id: 'sys3', name: 'Jira', type: 'Project', accessLevel: 'read', status: 'connected', lastSync: '5 min ago' },
      { id: 'sys4', name: 'Salesforce', type: 'CRM', accessLevel: 'read', status: 'connected', lastSync: '1 hr ago' },
    ],
    guardrails: {
      industryTemplate: 'Technology / SaaS',
      customerOverrides: [
        { id: 'co1', rule: 'Never quote competitor pricing', type: 'restrict', addedBy: 'Admin', date: '2026-03-01' },
        { id: 'co2', rule: 'Always offer free trial extension on churn risk', type: 'allow', addedBy: 'CSM Lead', date: '2026-04-15' },
      ],
      deRestrictions: ['No billing adjustments >$500 without approval', 'No contract modifications', 'No SLA commitments not in standard tier'],
      piiHandling: 'mask',
      contentFilter: 'standard',
      version: '2.3',
      lastUpdated: '2026-05-01',
    },
    humanLoop: {
      touchpoints: [
        { type: 'approval_gate', label: 'Approval Gate', enabled: true, confidenceThreshold: 0, amountThreshold: 500, escalateTo: 'Priya Sharma (VP Customer Operations)', slaDays: 1 },
        { type: 'review_gate', label: 'Review Gate', enabled: true, confidenceThreshold: 65, escalateTo: 'Maya Osei (Support Lead)', slaDays: 1 },
        { type: 'escalation', label: 'Escalation', enabled: true, confidenceThreshold: 55, escalateTo: 'L2 Engineering', slaDays: 2 },
        { type: 'override', label: 'Override', enabled: true, confidenceThreshold: 0, escalateTo: 'Priya Sharma (VP Customer Operations)', slaDays: 1 },
        { type: 'training_feedback', label: 'Training Feedback', enabled: true, confidenceThreshold: 0, escalateTo: 'Training Team', slaDays: 5 },
      ],
    },
    auditLog: [
      { id: 'a1', timestamp: '2026-07-03 14:22', action: 'Resolved ticket #4821 — "How do I reset 2FA?"', outcome: 'Resolved', type: 'resolved' },
      { id: 'a2', timestamp: '2026-07-03 13:58', action: 'Escalated ticket #4819 — API auth bug', outcome: 'Escalated to L2', type: 'escalated' },
      { id: 'a3', timestamp: '2026-07-03 12:15', action: 'Submitted KB article — "Rate limiting guide"', outcome: 'Pending review', type: 'kb_gap' },
      { id: 'a4', timestamp: '2026-07-03 11:00', action: 'Resolved ticket #4815 — billing question', outcome: 'Resolved', type: 'resolved' },
      { id: 'a5', timestamp: '2026-07-02 16:30', action: 'Guardrails config updated (v2.3)', outcome: 'Config change', type: 'config_change' },
      { id: 'a6', timestamp: '2026-07-02 15:10', action: 'Resolved 8 tickets — batch shift', outcome: 'Resolved', type: 'resolved' },
      { id: 'a7', timestamp: '2026-07-02 09:00', action: 'KB gap flagged — "Webhook retry logic"', outcome: 'Gap logged', type: 'kb_gap' },
    ],
  },
  {
    id: 'casey', name: 'Casey', role: 'Renewal DE', entity: 'customer',
    status: 'active', confidence: 88, escalationRate: 8, resolutionRate: 92, avgResponseTime: '3.4 min', errorRate: 1,
    trainingStatus: 'certified', lastTrained: '2026-04-20', nextRecert: '2026-10-20',
    language: 'English', timezone: 'UTC-5 (EST)', channels: ['Email', 'API'],
    description: 'Manages the full renewal lifecycle — contract review, invoice generation via Zuora, email cadences via Gainsight, payment confirmation, and renewal close.',
    knowledge: {
      collections: [
        { name: 'Contract Templates', accessLevel: 'read', coverage: 96 },
        { name: 'Pricing Tiers', accessLevel: 'read', coverage: 100 },
        { name: 'Customer History', accessLevel: 'read_write', coverage: 82 },
        { name: 'Zuora KB', accessLevel: 'read', coverage: 89 },
      ],
      types: [
        { type: 'Reference', enabled: true, confidenceFloor: 80 },
        { type: 'Procedural', enabled: true, confidenceFloor: 85 },
        { type: 'Regulatory', enabled: true, confidenceFloor: 90 },
        { type: 'Institutional', enabled: true, confidenceFloor: 75 },
        { type: 'Customer (PII)', enabled: true, confidenceFloor: 95 },
        { type: 'Competitive', enabled: false, confidenceFloor: 85 },
        { type: 'Training', enabled: true, confidenceFloor: 80 },
      ],
      gapDetection: true, gapSensitivity: 'medium',
    },
    sops: [
      { id: 's1', title: 'Renewal Initiation', category: 'Renewals', version: '3.2', lastUpdated: '2026-05-01', status: 'active' },
      { id: 's2', title: 'Invoice Generation via Zuora', category: 'Billing', version: '2.0', lastUpdated: '2026-04-10', status: 'active' },
      { id: 's3', title: 'At-Risk Account Protocol', category: 'Risk', version: '1.5', lastUpdated: '2026-03-20', status: 'active' },
    ],
    playbooks: [
      { id: 'p1', title: 'Renewal Lifecycle Playbook', type: 'process', active: true, priority: 1 },
      { id: 'p2', title: 'At-Risk Renewal Response', type: 'response', active: true, priority: 2 },
      { id: 'p3', title: 'Renewal Email Cadence', type: 'scheduled', active: true, priority: 3 },
      { id: 'p4', title: 'Churn Prevention Escalation', type: 'escalation', active: true, priority: 4 },
    ],
    systems: [
      { id: 'sys1', name: 'Zuora', type: 'Billing', accessLevel: 'read_write', status: 'connected', lastSync: '5 min ago' },
      { id: 'sys2', name: 'Gainsight', type: 'CS Platform', accessLevel: 'read_write', status: 'connected', lastSync: '10 min ago' },
      { id: 'sys3', name: 'Salesforce', type: 'CRM', accessLevel: 'read_write', status: 'connected', lastSync: '30 min ago' },
    ],
    guardrails: {
      industryTemplate: 'Technology / SaaS',
      customerOverrides: [
        { id: 'co1', rule: 'Max 20% discount without VP approval', type: 'restrict', addedBy: 'Finance', date: '2026-02-01' },
      ],
      deRestrictions: ['No contract term changes >12 months without legal', 'No write-offs >$2,500'],
      piiHandling: 'mask',
      contentFilter: 'standard',
      version: '1.8',
      lastUpdated: '2026-04-01',
    },
    humanLoop: {
      touchpoints: [
        { type: 'approval_gate', label: 'Approval Gate', enabled: true, confidenceThreshold: 0, amountThreshold: 10000, escalateTo: 'Jai Patel (Finance Manager)', slaDays: 1 },
        { type: 'review_gate', label: 'Review Gate', enabled: true, confidenceThreshold: 70, escalateTo: 'Taylor Smith (Senior CSM)', slaDays: 2 },
        { type: 'escalation', label: 'Escalation', enabled: true, confidenceThreshold: 60, escalateTo: 'Account Executive', slaDays: 1 },
        { type: 'override', label: 'Override', enabled: false, confidenceThreshold: 0, escalateTo: 'VP Sales', slaDays: 1 },
        { type: 'training_feedback', label: 'Training Feedback', enabled: true, confidenceThreshold: 0, escalateTo: 'Training Team', slaDays: 5 },
      ],
    },
    auditLog: [
      { id: 'a1', timestamp: '2026-07-03 14:10', action: 'Generated invoice — Meridian Group $15,600', outcome: 'Pending approval', type: 'escalated' },
      { id: 'a2', timestamp: '2026-07-03 11:30', action: 'Sent renewal email cadence — 3 accounts', outcome: 'Sent', type: 'resolved' },
      { id: 'a3', timestamp: '2026-07-02 15:00', action: 'Flagged at-risk — Apex Systems', outcome: 'Escalated to AE', type: 'escalated' },
      { id: 'a4', timestamp: '2026-07-01 09:00', action: 'Renewal close — Harbor Tech $67,000', outcome: 'Closed Won', type: 'resolved' },
    ],
  },
  {
    id: 'riley', name: 'Riley', role: 'HR & People DE', entity: 'workforce',
    status: 'active', confidence: 83, escalationRate: 14, resolutionRate: 79, avgResponseTime: '5.1 min', errorRate: 4,
    trainingStatus: 'needs_recert', lastTrained: '2025-12-01', nextRecert: '2026-06-01',
    language: 'English', timezone: 'UTC-5 (EST)', channels: ['Chat', 'Email'],
    description: 'Handles all internal workforce requests — onboarding, offboarding, leave management, HR policy queries, and org chart maintenance.',
    knowledge: {
      collections: [
        { name: 'HR Policies', accessLevel: 'read', coverage: 88 },
        { name: 'Benefits Handbook', accessLevel: 'read', coverage: 94 },
        { name: 'Onboarding Templates', accessLevel: 'read_write', coverage: 76 },
        { name: 'Employee Records', accessLevel: 'read_write', coverage: 67 },
      ],
      types: [
        { type: 'Reference', enabled: true, confidenceFloor: 75 },
        { type: 'Procedural', enabled: true, confidenceFloor: 80 },
        { type: 'Regulatory', enabled: true, confidenceFloor: 90 },
        { type: 'Institutional', enabled: true, confidenceFloor: 70 },
        { type: 'Customer (PII)', enabled: false, confidenceFloor: 90 },
        { type: 'Competitive', enabled: false, confidenceFloor: 85 },
        { type: 'Training', enabled: true, confidenceFloor: 75 },
      ],
      gapDetection: true, gapSensitivity: 'medium',
    },
    sops: [
      { id: 's1', title: 'New Employee Onboarding', category: 'Onboarding', version: '4.1', lastUpdated: '2026-01-10', status: 'active' },
      { id: 's2', title: 'Leave Request Processing', category: 'Leave', version: '2.3', lastUpdated: '2026-02-01', status: 'active' },
      { id: 's3', title: 'Offboarding Checklist', category: 'Offboarding', version: '1.9', lastUpdated: '2026-03-05', status: 'active' },
    ],
    playbooks: [
      { id: 'p1', title: 'New Hire Onboarding Flow', type: 'process', active: true, priority: 1 },
      { id: 'p2', title: 'HR Policy Response', type: 'response', active: true, priority: 2 },
      { id: 'p3', title: 'Monthly Headcount Report', type: 'scheduled', active: true, priority: 3 },
    ],
    systems: [
      { id: 'sys1', name: 'Workday', type: 'HRIS', accessLevel: 'read_write', status: 'error', lastSync: '2 hrs ago' },
      { id: 'sys2', name: 'Greenhouse', type: 'ATS', accessLevel: 'read', status: 'connected', lastSync: '1 hr ago' },
      { id: 'sys3', name: 'Lattice', type: 'Performance', accessLevel: 'read', status: 'connected', lastSync: '45 min ago' },
    ],
    guardrails: {
      industryTemplate: 'Technology / SaaS',
      customerOverrides: [],
      deRestrictions: ['No compensation data without HRBP approval', 'No termination actions', 'No immigration or visa advice'],
      piiHandling: 'hash',
      contentFilter: 'strict',
      version: '1.5',
      lastUpdated: '2026-01-15',
    },
    humanLoop: {
      touchpoints: [
        { type: 'approval_gate', label: 'Approval Gate', enabled: true, confidenceThreshold: 0, escalateTo: 'Dana Whitfield (HRBP)', slaDays: 2 },
        { type: 'review_gate', label: 'Review Gate', enabled: true, confidenceThreshold: 70, escalateTo: 'Dana Whitfield (HRBP)', slaDays: 2 },
        { type: 'escalation', label: 'Escalation', enabled: true, confidenceThreshold: 60, escalateTo: 'Dana Whitfield (HRBP)', slaDays: 3 },
        { type: 'override', label: 'Override', enabled: false, confidenceThreshold: 0, escalateTo: 'HR Director', slaDays: 1 },
        { type: 'training_feedback', label: 'Training Feedback', enabled: true, confidenceThreshold: 0, escalateTo: 'Training Team', slaDays: 5 },
      ],
    },
    auditLog: [
      { id: 'a1', timestamp: '2026-07-03 13:00', action: 'Processed onboarding — new hire Jordan K.', outcome: 'Complete', type: 'resolved' },
      { id: 'a2', timestamp: '2026-07-03 10:00', action: 'Workday connector timeout', outcome: 'Error — retrying', type: 'error' },
      { id: 'a3', timestamp: '2026-07-02 14:00', action: 'Leave request approved — P. Sharma', outcome: 'Approved', type: 'resolved' },
      { id: 'a4', timestamp: '2026-07-01 11:00', action: 'Recertification overdue — flagged', outcome: 'Needs recertification', type: 'error' },
    ],
  },
]

export const PWC_DES: DEProfile[] = [
  {
    id: 'morgan', name: 'Morgan', role: 'Client Relations DE', entity: 'customer',
    status: 'active', confidence: 87, escalationRate: 10, resolutionRate: 85, avgResponseTime: '2.8 min', errorRate: 2,
    trainingStatus: 'certified', lastTrained: '2026-05-10', nextRecert: '2026-11-10',
    language: 'English', timezone: 'UTC-5 (EST)', channels: ['Email', 'Chat'],
    description: 'Manages client communications, engagement intake, KYC workflows, and client satisfaction monitoring across all active PWC engagements.',
    knowledge: {
      collections: [
        { name: 'Client Engagement Docs', accessLevel: 'read_write', coverage: 91 },
        { name: 'Service Methodology', accessLevel: 'read', coverage: 88 },
        { name: 'Regulatory Library', accessLevel: 'read', coverage: 84 },
        { name: 'Client History', accessLevel: 'read_write', coverage: 79 },
      ],
      types: [
        { type: 'Reference', enabled: true, confidenceFloor: 80 },
        { type: 'Procedural', enabled: true, confidenceFloor: 85 },
        { type: 'Regulatory', enabled: true, confidenceFloor: 92 },
        { type: 'Institutional', enabled: true, confidenceFloor: 75 },
        { type: 'Customer (PII)', enabled: true, confidenceFloor: 95 },
        { type: 'Competitive', enabled: false, confidenceFloor: 90 },
        { type: 'Training', enabled: true, confidenceFloor: 80 },
      ],
      gapDetection: true, gapSensitivity: 'high',
    },
    sops: [
      { id: 's1', title: 'Client Onboarding & KYC', category: 'Onboarding', version: '5.0', lastUpdated: '2026-04-15', status: 'active' },
      { id: 's2', title: 'Engagement Status Update', category: 'Communication', version: '2.1', lastUpdated: '2026-03-01', status: 'active' },
      { id: 's3', title: 'Client Complaint Protocol', category: 'Risk', version: '1.3', lastUpdated: '2026-01-10', status: 'active' },
      { id: 's4', title: 'GDPR Data Request Handling', category: 'Compliance', version: '2.0', lastUpdated: '2026-05-01', status: 'active' },
    ],
    playbooks: [
      { id: 'p1', title: 'Client Engagement Lifecycle', type: 'process', active: true, priority: 1 },
      { id: 'p2', title: 'KYC & AML Response', type: 'response', active: true, priority: 2 },
      { id: 'p3', title: 'GDPR Request Handling', type: 'escalation', active: true, priority: 3 },
      { id: 'p4', title: 'Quarterly Client Review', type: 'scheduled', active: true, priority: 4 },
    ],
    systems: [
      { id: 'sys1', name: 'Salesforce', type: 'CRM', accessLevel: 'read_write', status: 'connected', lastSync: '10 min ago' },
      { id: 'sys2', name: 'SharePoint', type: 'Document Mgmt', accessLevel: 'read_write', status: 'connected', lastSync: '20 min ago' },
      { id: 'sys3', name: 'DocuSign', type: 'eSignature', accessLevel: 'read_write', status: 'connected', lastSync: '1 hr ago' },
    ],
    guardrails: {
      industryTemplate: 'Financial Services',
      customerOverrides: [
        { id: 'co1', rule: 'Require partner sign-off on all client commitments >$50K', type: 'restrict', addedBy: 'Risk', date: '2026-02-10' },
      ],
      deRestrictions: ['No legal advice without attorney review', 'No regulatory filings without partner approval', 'No fee adjustments >$5,000'],
      piiHandling: 'redact',
      contentFilter: 'strict',
      version: '3.1',
      lastUpdated: '2026-05-01',
    },
    humanLoop: {
      touchpoints: [
        { type: 'approval_gate', label: 'Approval Gate', enabled: true, confidenceThreshold: 0, amountThreshold: 5000, escalateTo: 'Rina Tanaka (Engagement Manager)', slaDays: 1 },
        { type: 'review_gate', label: 'Review Gate', enabled: true, confidenceThreshold: 72, escalateTo: 'James Whitfield (Managing Partner)', slaDays: 1 },
        { type: 'escalation', label: 'Escalation', enabled: true, confidenceThreshold: 60, escalateTo: 'Aisha Osei (Risk & Compliance)', slaDays: 1 },
        { type: 'override', label: 'Override', enabled: true, confidenceThreshold: 0, escalateTo: 'James Whitfield (Managing Partner)', slaDays: 1 },
        { type: 'training_feedback', label: 'Training Feedback', enabled: true, confidenceThreshold: 0, escalateTo: 'Training Team', slaDays: 5 },
      ],
    },
    auditLog: [
      { id: 'a1', timestamp: '2026-07-03 14:00', action: 'GDPR request — overdue response escalated', outcome: 'Escalated to partner', type: 'escalated' },
      { id: 'a2', timestamp: '2026-07-03 11:00', action: 'KYC completed — new engagement #E-2247', outcome: 'Passed', type: 'resolved' },
      { id: 'a3', timestamp: '2026-07-02 16:00', action: 'Sent engagement update — Harbor Financial', outcome: 'Sent', type: 'resolved' },
    ],
  },
  {
    id: 'avery', name: 'Avery', role: 'Tax Research DE', entity: 'specialist',
    status: 'active', confidence: 91, escalationRate: 16, resolutionRate: 82, avgResponseTime: '4.2 min', errorRate: 1,
    trainingStatus: 'certified', lastTrained: '2026-06-01', nextRecert: '2026-12-01',
    language: 'English', timezone: 'UTC-5 (EST)', channels: ['Chat', 'API'],
    description: 'Specialist DE focused on tax research, memo drafting, and regulatory interpretation across corporate, international, and individual tax matters.',
    knowledge: {
      collections: [
        { name: 'Tax Code Library', accessLevel: 'read', coverage: 96 },
        { name: 'Case Law Database', accessLevel: 'read', coverage: 89 },
        { name: 'Internal Tax Memos', accessLevel: 'read_write', coverage: 82 },
        { name: 'IRS Guidance', accessLevel: 'read', coverage: 98 },
      ],
      types: [
        { type: 'Reference', enabled: true, confidenceFloor: 85 },
        { type: 'Procedural', enabled: true, confidenceFloor: 85 },
        { type: 'Regulatory', enabled: true, confidenceFloor: 95 },
        { type: 'Institutional', enabled: true, confidenceFloor: 80 },
        { type: 'Customer (PII)', enabled: false, confidenceFloor: 95 },
        { type: 'Competitive', enabled: false, confidenceFloor: 90 },
        { type: 'Training', enabled: true, confidenceFloor: 80 },
      ],
      gapDetection: true, gapSensitivity: 'high',
    },
    sops: [
      { id: 's1', title: 'Tax Research Methodology', category: 'Research', version: '4.0', lastUpdated: '2026-05-01', status: 'active' },
      { id: 's2', title: 'Memo Drafting Standards', category: 'Documentation', version: '3.2', lastUpdated: '2026-04-01', status: 'active' },
      { id: 's3', title: 'Partner Review Escalation', category: 'Review', version: '2.0', lastUpdated: '2026-03-15', status: 'active' },
    ],
    playbooks: [
      { id: 'p1', title: 'Tax Research Request Flow', type: 'process', active: true, priority: 1 },
      { id: 'p2', title: 'Regulatory Change Response', type: 'response', active: true, priority: 2 },
      { id: 'p3', title: 'Complex Issue Escalation', type: 'escalation', active: true, priority: 3 },
    ],
    systems: [
      { id: 'sys1', name: 'Thomson Reuters', type: 'Tax Research', accessLevel: 'read', status: 'connected', lastSync: '1 hr ago' },
      { id: 'sys2', name: 'Bloomberg Tax', type: 'Tax Research', accessLevel: 'read', status: 'connected', lastSync: '1 hr ago' },
      { id: 'sys3', name: 'SharePoint', type: 'Document Mgmt', accessLevel: 'read_write', status: 'connected', lastSync: '30 min ago' },
    ],
    guardrails: {
      industryTemplate: 'Financial Services',
      customerOverrides: [],
      deRestrictions: ['All memos require partner review before client delivery', 'No oral advice — written only', 'No PCAOB independence conflicts'],
      piiHandling: 'redact',
      contentFilter: 'strict',
      version: '2.4',
      lastUpdated: '2026-06-01',
    },
    humanLoop: {
      touchpoints: [
        { type: 'approval_gate', label: 'Approval Gate', enabled: false, confidenceThreshold: 0, escalateTo: 'James Whitfield (Managing Partner)', slaDays: 1 },
        { type: 'review_gate', label: 'Review Gate', enabled: true, confidenceThreshold: 85, escalateTo: 'James Whitfield (Managing Partner)', slaDays: 1 },
        { type: 'escalation', label: 'Escalation', enabled: true, confidenceThreshold: 65, escalateTo: 'Senior Tax Manager', slaDays: 2 },
        { type: 'override', label: 'Override', enabled: true, confidenceThreshold: 0, escalateTo: 'James Whitfield (Managing Partner)', slaDays: 1 },
        { type: 'training_feedback', label: 'Training Feedback', enabled: true, confidenceThreshold: 0, escalateTo: 'Training Team', slaDays: 5 },
      ],
    },
    auditLog: [
      { id: 'a1', timestamp: '2026-07-03 14:05', action: 'Completed Q2 corporate tax memo — Crestline Corp', outcome: 'Sent to partner review', type: 'escalated' },
      { id: 'a2', timestamp: '2026-07-03 09:00', action: 'Research — FATCA dual-national issue', outcome: 'KB gap logged', type: 'kb_gap' },
      { id: 'a3', timestamp: '2026-07-02 15:00', action: 'Memo completed — R&D credit analysis', outcome: 'Delivered', type: 'resolved' },
      { id: 'a4', timestamp: '2026-07-01 13:00', action: 'Reviewed IRS Notice 2026-14', outcome: 'Summary filed', type: 'resolved' },
    ],
  },
]

// ── Training modules seed ──────────────────────────────────────────

const TRAINING_MODULES: Record<string, { name: string; progress: number; status: 'complete' | 'in_progress' | 'not_started'; lastCompleted: string }[]> = {
  alex: [
    { name: 'Product Knowledge — Core Platform', progress: 100, status: 'complete', lastCompleted: '2026-05-14' },
    { name: 'Escalation Protocols', progress: 100, status: 'complete', lastCompleted: '2026-05-10' },
    { name: 'Communication Standards', progress: 100, status: 'complete', lastCompleted: '2026-05-01' },
    { name: 'PII Handling & GDPR Basics', progress: 78, status: 'in_progress', lastCompleted: '—' },
    { name: 'Advanced Troubleshooting', progress: 45, status: 'in_progress', lastCompleted: '—' },
  ],
  casey: [
    { name: 'Renewal Lifecycle Management', progress: 100, status: 'complete', lastCompleted: '2026-04-20' },
    { name: 'Zuora Billing Platform', progress: 100, status: 'complete', lastCompleted: '2026-04-15' },
    { name: 'Contract Review & Terms', progress: 100, status: 'complete', lastCompleted: '2026-04-10' },
    { name: 'Gainsight Email Cadences', progress: 88, status: 'in_progress', lastCompleted: '—' },
    { name: 'At-Risk Account Playbook', progress: 62, status: 'in_progress', lastCompleted: '—' },
  ],
  riley: [
    { name: 'Onboarding & Offboarding Process', progress: 100, status: 'complete', lastCompleted: '2025-12-01' },
    { name: 'Leave Management Policy', progress: 100, status: 'complete', lastCompleted: '2025-11-20' },
    { name: 'Workday HRIS Fundamentals', progress: 65, status: 'in_progress', lastCompleted: '—' },
    { name: 'GDPR & Employee Data', progress: 40, status: 'in_progress', lastCompleted: '—' },
    { name: 'Performance Review Process', progress: 0, status: 'not_started', lastCompleted: '—' },
  ],
  morgan: [
    { name: 'KYC & AML Fundamentals', progress: 100, status: 'complete', lastCompleted: '2026-05-10' },
    { name: 'Client Communication Standards', progress: 100, status: 'complete', lastCompleted: '2026-05-05' },
    { name: 'GDPR & Data Privacy', progress: 100, status: 'complete', lastCompleted: '2026-04-28' },
    { name: 'Engagement Management', progress: 91, status: 'in_progress', lastCompleted: '—' },
    { name: 'Risk Escalation Protocols', progress: 55, status: 'in_progress', lastCompleted: '—' },
  ],
  avery: [
    { name: 'Tax Code Fundamentals', progress: 100, status: 'complete', lastCompleted: '2026-06-01' },
    { name: 'Corporate Tax Research', progress: 100, status: 'complete', lastCompleted: '2026-05-25' },
    { name: 'Memo Drafting Standards', progress: 100, status: 'complete', lastCompleted: '2026-05-20' },
    { name: 'International Tax (FATCA/FBAR)', progress: 72, status: 'in_progress', lastCompleted: '—' },
    { name: 'Thomson Reuters Platform', progress: 100, status: 'complete', lastCompleted: '2026-05-15' },
  ],
}

// ── Memory / learning topics seed ─────────────────────────────────

const LEARNING_TOPICS: Record<string, string[]> = {
  alex: ['Customer authentication issues', 'Rate limiting questions', 'Billing FAQ'],
  casey: ['Renewal objection handling', 'Zuora invoice edge cases'],
  riley: ['Leave policy clarifications', 'Onboarding checklists', 'HR benefit queries'],
  morgan: ['KYC documentation gaps', 'Client complaint handling'],
  avery: ['FATCA dual-national interpretations', 'R&D credit eligibility', 'State tax nexus questions'],
}

// ── Helper components ──────────────────────────────────────────────

function StatusDot({ status }: { status: DEStatus }) {
  const color = status === 'active' ? 'bg-emerald-400' : status === 'degraded' ? 'bg-amber-400' : status === 'at_risk' ? 'bg-red-400' : 'bg-slate-600'
  return <span className={`inline-block w-2 h-2 rounded-full ${color} flex-shrink-0`} />
}

function EntityBadge({ entity }: { entity: DEEntity }) {
  const styles: Record<DEEntity, string> = {
    customer: 'bg-indigo-500/20 text-indigo-400',
    vendor: 'bg-amber-500/20 text-amber-400',
    workforce: 'bg-teal-500/20 text-teal-400',
    specialist: 'bg-purple-500/20 text-purple-400',
  }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${styles[entity]}`}>
      {entity.charAt(0).toUpperCase() + entity.slice(1)}
    </span>
  )
}

function Toggle({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!enabled)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${enabled ? 'bg-indigo-600' : 'bg-slate-600'}`}
    >
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : 'translate-x-1'}`} />
    </button>
  )
}

function confidenceColor(val: number): string {
  if (val >= 80) return 'text-emerald-400'
  if (val >= 60) return 'text-amber-400'
  return 'text-red-400'
}

// ── Tab 1: Profile ─────────────────────────────────────────────────

function TabProfile({ de, companyId, onSuggestImprovement }: { de: DEProfile; companyId: string; onSuggestImprovement?: () => void }) {
  const lsKey = `dt_de_profile_${companyId}_${de.id}`
  const saved: Record<string, unknown> = (() => { try { const s = localStorage.getItem(lsKey); return s ? JSON.parse(s) : {} } catch { return {} } })()

  const [status, setStatus] = useState<'active' | 'inactive'>((saved.status as 'active' | 'inactive') ?? (de.status === 'active' ? 'active' : 'inactive'))
  const [role, setRole] = useState((saved.role as string) ?? de.role)
  const [entity, setEntity] = useState<DEEntity>((saved.entity as DEEntity) ?? de.entity)
  const [language, setLanguage] = useState((saved.language as string) ?? de.language)
  const [timezone, setTimezone] = useState((saved.timezone as string) ?? de.timezone)
  const [channels, setChannels] = useState<string[]>((saved.channels as string[]) ?? de.channels)
  const [description, setDescription] = useState((saved.description as string) ?? de.description)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<string>('')

  const saveAll = (patch: Record<string, unknown> = {}) => {
    const data = { status, role, entity, language, timezone, channels, description, ...patch }
    try { localStorage.setItem(lsKey, JSON.stringify(data)) } catch { /* noop */ }
    setEditing(null)
  }

  const allChannels = ['Chat', 'Email', 'API', 'Phone']
  const toggleChannel = (ch: string) => {
    const next = channels.includes(ch) ? channels.filter(c => c !== ch) : [...channels, ch]
    setChannels(next)
    try { localStorage.setItem(lsKey, JSON.stringify({ status, role, entity, language, timezone, channels: next, description })) } catch { /* noop */ }
  }

  return (
    <div className="grid grid-cols-2 gap-6 p-6">
      {/* Left: editable fields */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-3">Identity & Configuration</p>

        {/* Status */}
        <div className="flex items-start justify-between py-2.5 border-b border-slate-700">
          <span className="text-xs text-slate-500 w-36 flex-shrink-0 pt-0.5">Status</span>
          <div className="flex gap-2">
            {(['active', 'inactive'] as const).map(s => (
              <button key={s} onClick={() => { setStatus(s); saveAll({ status: s }) }}
                className={`text-xs px-3 py-1 rounded-lg border transition-colors ${status === s ? (s === 'active' ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400' : 'bg-red-500/20 border-red-500/40 text-red-400') : 'border-slate-600 text-slate-500 hover:border-slate-600'}`}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Role */}
        <div className="flex items-start justify-between py-2.5 border-b border-slate-700">
          <span className="text-xs text-slate-500 w-36 flex-shrink-0 pt-0.5">Role</span>
          {editing === 'role' ? (
            <div className="flex items-center gap-2 flex-1">
              <input autoFocus className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-slate-600" value={draft} onChange={e => setDraft(e.target.value)} />
              <button onClick={() => { setRole(draft); saveAll({ role: draft }) }} className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-3 py-1.5 rounded-lg">Save</button>
              <button onClick={() => setEditing(null)} className="text-slate-400 hover:text-slate-200 text-sm">Cancel</button>
            </div>
          ) : (
            <button onClick={() => { setEditing('role'); setDraft(role) }} className="flex-1 text-left text-sm text-slate-200 hover:text-indigo-400 transition-colors">{role}</button>
          )}
        </div>

        {/* Entity */}
        <div className="flex items-start justify-between py-2.5 border-b border-slate-700">
          <span className="text-xs text-slate-500 w-36 flex-shrink-0 pt-0.5">Entity</span>
          <select value={entity} onChange={e => { const v = e.target.value as DEEntity; setEntity(v); saveAll({ entity: v }) }}
            className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-slate-600">
            {(['customer', 'vendor', 'workforce', 'specialist'] as DEEntity[]).map(e => (
              <option key={e} value={e}>{e.charAt(0).toUpperCase() + e.slice(1)}</option>
            ))}
          </select>
        </div>

        {/* Language */}
        <div className="flex items-start justify-between py-2.5 border-b border-slate-700">
          <span className="text-xs text-slate-500 w-36 flex-shrink-0 pt-0.5">Language</span>
          {editing === 'language' ? (
            <div className="flex items-center gap-2 flex-1">
              <input autoFocus className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-slate-600" value={draft} onChange={e => setDraft(e.target.value)} />
              <button onClick={() => { setLanguage(draft); saveAll({ language: draft }) }} className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-3 py-1.5 rounded-lg">Save</button>
              <button onClick={() => setEditing(null)} className="text-slate-400 hover:text-slate-200 text-sm">Cancel</button>
            </div>
          ) : (
            <button onClick={() => { setEditing('language'); setDraft(language) }} className="flex-1 text-left text-sm text-slate-200 hover:text-indigo-400 transition-colors">{language}</button>
          )}
        </div>

        {/* Timezone */}
        <div className="flex items-start justify-between py-2.5 border-b border-slate-700">
          <span className="text-xs text-slate-500 w-36 flex-shrink-0 pt-0.5">Timezone</span>
          {editing === 'timezone' ? (
            <div className="flex items-center gap-2 flex-1">
              <input autoFocus className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-slate-600" value={draft} onChange={e => setDraft(e.target.value)} />
              <button onClick={() => { setTimezone(draft); saveAll({ timezone: draft }) }} className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-3 py-1.5 rounded-lg">Save</button>
              <button onClick={() => setEditing(null)} className="text-slate-400 hover:text-slate-200 text-sm">Cancel</button>
            </div>
          ) : (
            <button onClick={() => { setEditing('timezone'); setDraft(timezone) }} className="flex-1 text-left text-sm text-slate-200 hover:text-indigo-400 transition-colors">{timezone}</button>
          )}
        </div>

        {/* Channels */}
        <div className="py-2.5 border-b border-slate-700">
          <p className="text-xs text-slate-500 mb-2">Channels</p>
          <div className="flex flex-wrap gap-2">
            {allChannels.map(ch => (
              <button key={ch} onClick={() => toggleChannel(ch)}
                className={`text-xs px-3 py-1 rounded-full border transition-colors ${channels.includes(ch) ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-400' : 'border-slate-600 text-slate-500 hover:border-slate-600'}`}>
                {ch}
              </button>
            ))}
          </div>
        </div>

        {/* Description */}
        <div className="py-2.5">
          <p className="text-xs text-slate-500 mb-2">Description</p>
          {editing === 'description' ? (
            <div className="flex flex-col gap-2">
              <textarea autoFocus rows={4} className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-slate-600 resize-none" value={draft} onChange={e => setDraft(e.target.value)} />
              <div className="flex gap-2">
                <button onClick={() => { setDescription(draft); saveAll({ description: draft }) }} className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-3 py-1.5 rounded-lg">Save</button>
                <button onClick={() => setEditing(null)} className="text-slate-400 hover:text-slate-200 text-sm">Cancel</button>
              </div>
            </div>
          ) : (
            <button onClick={() => { setEditing('description'); setDraft(description) }} className="text-left text-sm text-slate-300 hover:text-indigo-400 transition-colors leading-relaxed">{description}</button>
          )}
        </div>
      </div>

      {/* Right: quick stats */}
      <div className="space-y-4">
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Performance Snapshot</p>
            {onSuggestImprovement && (
              <button onClick={onSuggestImprovement} className="text-indigo-600 hover:text-indigo-400 text-xs px-2.5 py-1 rounded-lg border border-indigo-500/30 hover:border-indigo-500/50 transition-colors">✨ Suggest improvement</button>
            )}
          </div>
          <div className="space-y-3">
            {[
              { label: 'AI Confidence', value: `${de.confidence}%`, color: confidenceColor(de.confidence) },
              { label: 'Escalation Rate', value: `${de.escalationRate}%`, color: de.escalationRate > 20 ? 'text-red-400' : de.escalationRate > 12 ? 'text-amber-400' : 'text-emerald-400' },
              { label: 'Resolution Rate', value: `${de.resolutionRate}%`, color: de.resolutionRate >= 85 ? 'text-emerald-400' : de.resolutionRate >= 70 ? 'text-amber-400' : 'text-red-400' },
              { label: 'Avg Response Time', value: de.avgResponseTime, color: 'text-slate-200' },
              { label: 'Error Rate', value: `${de.errorRate}%`, color: de.errorRate > 10 ? 'text-red-400' : de.errorRate > 4 ? 'text-amber-400' : 'text-emerald-400' },
            ].map(m => (
              <div key={m.label} className="flex justify-between items-center bg-slate-900 rounded-lg px-3 py-2">
                <span className="text-xs text-slate-500">{m.label}</span>
                <span className={`text-sm font-medium ${m.color}`}>{m.value}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-3">Training & Certification</p>
          <div className="space-y-2">
            <div className="flex justify-between bg-slate-900 rounded-lg px-3 py-2">
              <span className="text-xs text-slate-500">Status</span>
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${de.trainingStatus === 'certified' ? 'bg-emerald-500/20 text-emerald-400' : de.trainingStatus === 'in_training' ? 'bg-blue-500/20 text-blue-400' : 'bg-red-500/20 text-red-400'}`}>
                {de.trainingStatus === 'certified' ? 'Certified' : de.trainingStatus === 'in_training' ? 'In Training' : 'Needs Recertification'}
              </span>
            </div>
            <div className="flex justify-between bg-slate-900 rounded-lg px-3 py-2">
              <span className="text-xs text-slate-500">Last Trained</span>
              <span className="text-sm text-slate-200">{de.lastTrained}</span>
            </div>
            <div className="flex justify-between bg-slate-900 rounded-lg px-3 py-2">
              <span className="text-xs text-slate-500">Next Recertification</span>
              <span className="text-sm text-slate-200">{de.nextRecert}</span>
            </div>
          </div>
        </div>

        {/* Pending Amendments Widget */}
        <PendingAmendmentsWidget
          entity_kind="de"
          entity_id={de.id}
          onAmendmentsChange={(count) => {
            if (count === 0) {
              // Reload if amendments were cleared
              window.location.reload()
            }
          }}
        />

        {/* Customer-Defined Metrics */}
        {activeCompanyId && (
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-3">Metrics</p>
            <MetricsDisplay
              tenant_id={activeCompanyId}
              de_id={de.id}
              tags={['support']}
              columns={1}
            />
          </div>
        )}
      </div>
    </div>
  )
}

// ── Tab 2: Training ────────────────────────────────────────────────

function TabTraining({ de, setPage }: { de: DEProfile; setPage: (p: Page) => void }) {
  const modules = TRAINING_MODULES[de.id] ?? []
  const [lastTrained, setLastTrained] = useState(de.lastTrained)
  const [nextRecert, setNextRecert] = useState(de.nextRecert)
  const [certInterval, setCertInterval] = useState('180')
  const [threshold, setThreshold] = useState('85')

  return (
    <div className="p-6 space-y-6">
      {/* Status banner */}
      <div className={`rounded-xl p-4 flex items-center gap-4 border ${de.trainingStatus === 'certified' ? 'bg-emerald-500/10 border-emerald-500/30' : de.trainingStatus === 'in_training' ? 'bg-blue-500/10 border-blue-500/30' : 'bg-red-500/10 border-red-500/30'}`}>
        <div className={`text-3xl font-bold ${de.trainingStatus === 'certified' ? 'text-emerald-400' : de.trainingStatus === 'in_training' ? 'text-blue-400' : 'text-red-400'}`}>
          {de.trainingStatus === 'certified' ? '✓' : de.trainingStatus === 'in_training' ? '↻' : '!'}
        </div>
        <div>
          <p className={`text-sm font-semibold ${de.trainingStatus === 'certified' ? 'text-emerald-400' : de.trainingStatus === 'in_training' ? 'text-blue-400' : 'text-red-400'}`}>
            {de.trainingStatus === 'certified' ? 'Certified' : de.trainingStatus === 'in_training' ? 'In Training' : 'Needs Recertification'}
          </p>
          <p className="text-xs text-slate-400 mt-0.5">
            {de.trainingStatus === 'needs_recert'
              ? `Recertification was due on ${de.nextRecert} — 2 failing scenarios in the eval suite, see Proving Ground.`
              : 'All required modules passed. Certification is backed by a passing eval suite.'}
          </p>
          <button onClick={() => setPage('intelligence_evals')} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors mt-1">
            View eval suite →
          </button>
        </div>
      </div>

      {/* Config */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-3">Certification Configuration</p>
        <div className="grid grid-cols-2 gap-4">
          {[
            { label: 'Last Trained', val: lastTrained, set: setLastTrained, type: 'date' },
            { label: 'Next Recertification', val: nextRecert, set: setNextRecert, type: 'date' },
            { label: 'Recertification Interval (days)', val: certInterval, set: setCertInterval, type: 'number' },
            { label: 'Pass Threshold (%)', val: threshold, set: setThreshold, type: 'number' },
          ].map(f => (
            <div key={f.label}>
              <label className="text-xs text-slate-500 block mb-1">{f.label}</label>
              <input type={f.type} value={f.val} onChange={e => f.set(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-slate-600" />
            </div>
          ))}
        </div>
      </div>

      {/* Modules table */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-3">Training Modules</p>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-slate-500 border-b border-slate-700">
              <th className="text-left pb-2 font-medium">Module</th>
              <th className="text-left pb-2 font-medium w-32">Progress</th>
              <th className="text-left pb-2 font-medium w-28">Status</th>
              <th className="text-left pb-2 font-medium w-32">Last Completed</th>
            </tr>
          </thead>
          <tbody>
            {modules.map((m, i) => (
              <tr key={i} className="border-b border-slate-700/50 last:border-0">
                <td className="py-2.5 text-slate-200">{m.name}</td>
                <td className="py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 bg-slate-700 rounded-full h-1.5">
                      <div className={`h-1.5 rounded-full ${m.progress === 100 ? 'bg-emerald-500' : m.progress > 0 ? 'bg-indigo-500' : 'bg-slate-600'}`} style={{ width: `${m.progress}%` }} />
                    </div>
                    <span className="text-xs text-slate-400 w-8">{m.progress}%</span>
                  </div>
                </td>
                <td className="py-2.5">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${m.status === 'complete' ? 'bg-emerald-500/20 text-emerald-400' : m.status === 'in_progress' ? 'bg-blue-500/20 text-blue-400' : 'bg-slate-600 text-slate-500'}`}>
                    {m.status === 'complete' ? 'Complete' : m.status === 'in_progress' ? 'In Progress' : 'Not Started'}
                  </span>
                </td>
                <td className="py-2.5 text-slate-400 text-xs">{m.lastCompleted}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Tab 3: Knowledge ───────────────────────────────────────────────

function TabKnowledge({ de }: { de: DEProfile }) {
  const [types, setTypes] = useState(de.knowledge.types.map(t => ({ ...t })))
  const [gapDetection, setGapDetection] = useState(de.knowledge.gapDetection)
  const [gapSensitivity, setGapSensitivity] = useState(de.knowledge.gapSensitivity)

  return (
    <div className="p-6 space-y-6">
      {/* Collections */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Knowledge Collections</p>
          <button className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-3 py-1.5 rounded-lg">+ Add</button>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-slate-500 border-b border-slate-700">
              <th className="text-left pb-2 font-medium">Collection</th>
              <th className="text-left pb-2 font-medium w-28">Access Level</th>
              <th className="text-left pb-2 font-medium w-40">Coverage</th>
              <th className="w-20"></th>
            </tr>
          </thead>
          <tbody>
            {de.knowledge.collections.map((c, i) => (
              <tr key={i} className="border-b border-slate-700/50 last:border-0">
                <td className="py-2.5 text-slate-200">{c.name}</td>
                <td className="py-2.5">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${c.accessLevel === 'read_write' ? 'bg-indigo-500/20 text-indigo-400' : 'bg-slate-600 text-slate-400'}`}>
                    {c.accessLevel === 'read_write' ? 'Read/Write' : 'Read'}
                  </span>
                </td>
                <td className="py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 bg-slate-700 rounded-full h-1.5">
                      <div className={`h-1.5 rounded-full ${c.coverage >= 90 ? 'bg-emerald-500' : c.coverage >= 75 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${c.coverage}%` }} />
                    </div>
                    <span className="text-xs text-slate-400 w-8">{c.coverage}%</span>
                  </div>
                </td>
                <td className="py-2.5 text-center">
                  <button className="text-slate-500 hover:text-red-400 text-xs transition-colors">Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Knowledge Types */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-3">Knowledge Type Access</p>
        <div className="space-y-2">
          {types.map((t, i) => (
            <div key={i} className="flex items-center gap-4 bg-slate-900 rounded-lg px-3 py-2.5">
              <Toggle enabled={t.enabled} onChange={v => setTypes(prev => prev.map((p, j) => j === i ? { ...p, enabled: v } : p))} />
              <span className="text-sm text-slate-200 flex-1">{t.type}</span>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">Confidence floor</span>
                <input type="number" min={0} max={100} value={t.confidenceFloor}
                  onChange={e => setTypes(prev => prev.map((p, j) => j === i ? { ...p, confidenceFloor: Number(e.target.value) } : p))}
                  className="w-16 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-sm text-slate-200 focus:outline-none focus:border-slate-600" />
                <span className="text-xs text-slate-500">%</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Gap Detection */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-3">Gap Detection</p>
        <div className="flex items-center justify-between bg-slate-900 rounded-lg px-3 py-2.5 mb-3">
          <span className="text-sm text-slate-200">Enable gap detection</span>
          <Toggle enabled={gapDetection} onChange={setGapDetection} />
        </div>
        <div className="flex items-center gap-4 px-1">
          <span className="text-xs text-slate-500">Sensitivity</span>
          {(['low', 'medium', 'high'] as const).map(s => (
            <label key={s} className="flex items-center gap-2 cursor-pointer">
              <input type="radio" checked={gapSensitivity === s} onChange={() => setGapSensitivity(s)} className="accent-indigo-500" />
              <span className="text-sm text-slate-300 capitalize">{s}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Tab 4: SOPs ────────────────────────────────────────────────────

function TabSOPs({ de }: { de: DEProfile }) {
  const [sops, setSops] = useState(de.sops.map(s => ({ ...s })))
  const [showAdd, setShowAdd] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newCat, setNewCat] = useState('')
  const [newVer, setNewVer] = useState('')
  const [openMenu, setOpenMenu] = useState<string | null>(null)

  const addSOP = () => {
    if (!newTitle) return
    setSops(prev => [...prev, { id: 's' + Date.now(), title: newTitle, category: newCat, version: newVer || '1.0', lastUpdated: '2026-07-03', status: 'draft' as const }])
    setNewTitle(''); setNewCat(''); setNewVer(''); setShowAdd(false)
  }

  const statusBadge = (s: SOP['status']) => {
    const styles = { active: 'bg-emerald-500/20 text-emerald-400', draft: 'bg-amber-500/20 text-amber-400', archived: 'bg-slate-600 text-slate-500' }
    return <span className={`text-xs px-2 py-0.5 rounded-full ${styles[s]}`}>{s.charAt(0).toUpperCase() + s.slice(1)}</span>
  }

  return (
    <div className="p-6 space-y-4">
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Standard Operating Procedures</p>
          <button onClick={() => setShowAdd(v => !v)} className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-3 py-1.5 rounded-lg">+ Add SOP</button>
        </div>
        {showAdd && (
          <div className="bg-slate-900 border border-slate-600 rounded-xl p-4 mb-4 flex flex-col gap-3">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs text-slate-500 block mb-1">Title</label>
                <input value={newTitle} onChange={e => setNewTitle(e.target.value)} className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-slate-600" placeholder="SOP title..." />
              </div>
              <div>
                <label className="text-xs text-slate-500 block mb-1">Category</label>
                <input value={newCat} onChange={e => setNewCat(e.target.value)} className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-slate-600" placeholder="Category..." />
              </div>
              <div>
                <label className="text-xs text-slate-500 block mb-1">Version</label>
                <input value={newVer} onChange={e => setNewVer(e.target.value)} className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-slate-600" placeholder="1.0" />
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={addSOP} className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-3 py-1.5 rounded-lg">Add</button>
              <button onClick={() => setShowAdd(false)} className="text-slate-400 hover:text-slate-200 text-sm">Cancel</button>
            </div>
          </div>
        )}
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-slate-500 border-b border-slate-700">
              <th className="text-left pb-2 font-medium">Title</th>
              <th className="text-left pb-2 font-medium w-28">Category</th>
              <th className="text-left pb-2 font-medium w-20">Version</th>
              <th className="text-left pb-2 font-medium w-28">Last Updated</th>
              <th className="text-left pb-2 font-medium w-20">Status</th>
              <th className="w-10"></th>
            </tr>
          </thead>
          <tbody>
            {sops.map(s => (
              <tr key={s.id} className="border-b border-slate-700/50 last:border-0 relative">
                <td className="py-2.5 text-slate-200">{s.title}</td>
                <td className="py-2.5 text-slate-400 text-xs">{s.category}</td>
                <td className="py-2.5 text-slate-400 text-xs">{s.version}</td>
                <td className="py-2.5 text-slate-400 text-xs">{s.lastUpdated}</td>
                <td className="py-2.5">{statusBadge(s.status)}</td>
                <td className="py-2.5 relative">
                  <button onClick={() => setOpenMenu(openMenu === s.id ? null : s.id)} className="text-slate-500 hover:text-slate-300 text-base px-1">•••</button>
                  {openMenu === s.id && (
                    <div className="absolute right-0 top-8 bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-10 min-w-32">
                      <button onClick={() => { setSops(prev => prev.map(p => p.id === s.id ? { ...p, status: 'active' as const } : p)); setOpenMenu(null) }} className="block w-full text-left px-3 py-2 text-sm text-slate-200 hover:bg-slate-600">Activate</button>
                      <button onClick={() => { setSops(prev => prev.map(p => p.id === s.id ? { ...p, status: 'archived' as const } : p)); setOpenMenu(null) }} className="block w-full text-left px-3 py-2 text-sm text-slate-200 hover:bg-slate-600">Archive</button>
                      <button onClick={() => setOpenMenu(null)} className="block w-full text-left px-3 py-2 text-sm text-slate-200 hover:bg-slate-600">View</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Tab 5: Playbooks ───────────────────────────────────────────────

function TabPlaybooks({ de }: { de: DEProfile }) {
  const [playbooks, setPlaybooks] = useState([...de.playbooks].sort((a, b) => a.priority - b.priority))

  const typeBadge = (type: PlaybookAssignment['type']) => {
    const styles: Record<PlaybookAssignment['type'], string> = {
      process: 'bg-blue-500/20 text-blue-400',
      response: 'bg-indigo-500/20 text-indigo-400',
      escalation: 'bg-red-500/20 text-red-400',
      cross_function: 'bg-purple-500/20 text-purple-400',
      crisis: 'bg-red-500/20 text-red-400',
      scheduled: 'bg-slate-600 text-slate-400',
    }
    const labels: Record<PlaybookAssignment['type'], string> = {
      process: 'Process', response: 'Response', escalation: 'Escalation',
      cross_function: 'Cross-Function', crisis: 'Crisis', scheduled: 'Scheduled',
    }
    return <span className={`text-xs px-2 py-0.5 rounded-full ${styles[type]}`}>{labels[type]}</span>
  }

  const move = (id: string, dir: 'up' | 'down') => {
    setPlaybooks(prev => {
      const arr = [...prev]
      const idx = arr.findIndex(p => p.id === id)
      const swap = dir === 'up' ? idx - 1 : idx + 1
      if (swap < 0 || swap >= arr.length) return arr
      const tmp = arr[idx].priority; arr[idx].priority = arr[swap].priority; arr[swap].priority = tmp
      return arr.sort((a, b) => a.priority - b.priority)
    })
  }

  return (
    <div className="p-6">
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-3">Assigned Playbooks</p>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-slate-500 border-b border-slate-700">
              <th className="text-left pb-2 font-medium w-16">Priority</th>
              <th className="text-left pb-2 font-medium">Title</th>
              <th className="text-left pb-2 font-medium w-32">Type</th>
              <th className="text-left pb-2 font-medium w-20">Active</th>
              <th className="w-16"></th>
            </tr>
          </thead>
          <tbody>
            {playbooks.map((p, i) => (
              <tr key={p.id} className="border-b border-slate-700/50 last:border-0">
                <td className="py-2.5 text-slate-400 text-xs font-mono">#{p.priority}</td>
                <td className="py-2.5 text-slate-200">{p.title}</td>
                <td className="py-2.5">{typeBadge(p.type)}</td>
                <td className="py-2.5">
                  <Toggle enabled={p.active} onChange={v => setPlaybooks(prev => prev.map(pb => pb.id === p.id ? { ...pb, active: v } : pb))} />
                </td>
                <td className="py-2.5">
                  <div className="flex gap-1">
                    <button onClick={() => move(p.id, 'up')} disabled={i === 0} className="text-slate-500 hover:text-slate-300 disabled:opacity-30 text-base px-1">↑</button>
                    <button onClick={() => move(p.id, 'down')} disabled={i === playbooks.length - 1} className="text-slate-500 hover:text-slate-300 disabled:opacity-30 text-base px-1">↓</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Tab 6: Systems & Data ──────────────────────────────────────────

function TabSystems({ de }: { de: DEProfile }) {
  const [systems, setSystems] = useState(de.systems.map(s => ({ ...s })))

  const statusDot = (status: SystemAccess['status']) => {
    const color = status === 'connected' ? 'bg-emerald-400' : status === 'error' ? 'bg-red-400' : 'bg-slate-600'
    return <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
  }

  const accessBadge = (level: SystemAccess['accessLevel']) => {
    const styles = { read: 'bg-blue-500/20 text-blue-400', read_write: 'bg-indigo-500/20 text-indigo-400', admin: 'bg-amber-500/20 text-amber-400' }
    const labels = { read: 'Read', read_write: 'Read/Write', admin: 'Admin' }
    return <span className={`text-xs px-2 py-0.5 rounded-full ${styles[level]}`}>{labels[level]}</span>
  }

  return (
    <div className="p-6">
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Connected Systems</p>
          <button className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-3 py-1.5 rounded-lg">+ Connect System</button>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-slate-500 border-b border-slate-700">
              <th className="text-left pb-2 font-medium">System</th>
              <th className="text-left pb-2 font-medium w-28">Type</th>
              <th className="text-left pb-2 font-medium w-28">Access Level</th>
              <th className="text-left pb-2 font-medium w-24">Status</th>
              <th className="text-left pb-2 font-medium w-28">Last Sync</th>
              <th className="text-left pb-2 font-medium w-32">Actions</th>
            </tr>
          </thead>
          <tbody>
            {systems.map(s => (
              <tr key={s.id} className="border-b border-slate-700/50 last:border-0">
                <td className="py-2.5 text-slate-200 font-medium">{s.name}</td>
                <td className="py-2.5 text-xs text-slate-400">{s.type}</td>
                <td className="py-2.5">{accessBadge(s.accessLevel)}</td>
                <td className="py-2.5">
                  <div className="flex items-center gap-1.5">
                    {statusDot(s.status)}
                    <span className="text-xs text-slate-400 capitalize">{s.status}</span>
                  </div>
                </td>
                <td className="py-2.5 text-xs text-slate-400">{s.lastSync}</td>
                <td className="py-2.5">
                  <div className="flex gap-2">
                    <button onClick={() => setSystems(prev => prev.map(p => p.id === s.id ? { ...p, status: 'disconnected' as const } : p))} className="text-xs text-red-400 hover:text-red-300 transition-colors">Revoke</button>
                    <button onClick={() => setSystems(prev => prev.map(p => p.id === s.id ? { ...p, lastSync: 'just now', status: 'connected' as const } : p))} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">Refresh</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Tab 7: Guardrails ──────────────────────────────────────────────

function TabGuardrails({ de }: { de: DEProfile }) {
  const [overrides, setOverrides] = useState(de.guardrails.customerOverrides.map(o => ({ ...o })))
  const [restrictions, setRestrictions] = useState([...de.guardrails.deRestrictions])
  const [piiHandling, setPiiHandling] = useState(de.guardrails.piiHandling)
  const [contentFilter, setContentFilter] = useState(de.guardrails.contentFilter)
  const [showAddOverride, setShowAddOverride] = useState(false)
  const [newRule, setNewRule] = useState('')
  const [newType, setNewType] = useState<'allow' | 'restrict'>('restrict')
  const [newRestriction, setNewRestriction] = useState('')
  const [showAddRestriction, setShowAddRestriction] = useState(false)

  return (
    <div className="p-6 space-y-6">
      {/* Industry Template */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-3">Industry Template</p>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-slate-200">{de.guardrails.industryTemplate}</p>
            <p className="text-xs text-slate-500 mt-1">v{de.guardrails.version} · Updated {de.guardrails.lastUpdated}</p>
          </div>
          <button className="text-slate-400 hover:text-slate-200 text-sm border border-slate-600 rounded-lg px-3 py-1.5">Change Template</button>
        </div>
      </div>

      {/* Customer Overrides */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Customer Overrides</p>
          <button onClick={() => setShowAddOverride(v => !v)} className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-3 py-1.5 rounded-lg">+ Add Override</button>
        </div>
        {showAddOverride && (
          <div className="bg-slate-900 border border-slate-600 rounded-lg p-3 mb-3 flex gap-3 items-end flex-wrap">
            <div className="flex-1 min-w-48">
              <label className="text-xs text-slate-500 block mb-1">Rule</label>
              <input value={newRule} onChange={e => setNewRule(e.target.value)} className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-slate-600" placeholder="Rule description..." />
            </div>
            <div>
              <label className="text-xs text-slate-500 block mb-1">Type</label>
              <select value={newType} onChange={e => setNewType(e.target.value as 'allow' | 'restrict')} className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-slate-600">
                <option value="restrict">Restrict</option>
                <option value="allow">Allow</option>
              </select>
            </div>
            <button onClick={() => { if (newRule) { setOverrides(prev => [...prev, { id: 'co' + Date.now(), rule: newRule, type: newType, addedBy: 'Admin', date: '2026-07-03' }]); setNewRule(''); setShowAddOverride(false) } }} className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-3 py-1.5 rounded-lg">Add</button>
            <button onClick={() => setShowAddOverride(false)} className="text-slate-400 hover:text-slate-200 text-sm">Cancel</button>
          </div>
        )}
        {overrides.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-4">No overrides configured.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500 border-b border-slate-700">
                <th className="text-left pb-2 font-medium">Rule</th>
                <th className="text-left pb-2 font-medium w-20">Type</th>
                <th className="text-left pb-2 font-medium w-24">Added By</th>
                <th className="text-left pb-2 font-medium w-24">Date</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody>
              {overrides.map(o => (
                <tr key={o.id} className="border-b border-slate-700/50 last:border-0">
                  <td className="py-2.5 text-slate-200">{o.rule}</td>
                  <td className="py-2.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${o.type === 'allow' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                      {o.type.charAt(0).toUpperCase() + o.type.slice(1)}
                    </span>
                  </td>
                  <td className="py-2.5 text-xs text-slate-400">{o.addedBy}</td>
                  <td className="py-2.5 text-xs text-slate-400">{o.date}</td>
                  <td className="py-2.5">
                    <button onClick={() => setOverrides(prev => prev.filter(p => p.id !== o.id))} className="text-slate-500 hover:text-red-400 text-sm transition-colors">×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* DE Restrictions */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">DE Restrictions</p>
          <button onClick={() => setShowAddRestriction(v => !v)} className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-3 py-1.5 rounded-lg">+ Add Restriction</button>
        </div>
        {showAddRestriction && (
          <div className="flex gap-2 mb-3">
            <input value={newRestriction} onChange={e => setNewRestriction(e.target.value)} className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-slate-600" placeholder="Restriction rule..." />
            <button onClick={() => { if (newRestriction) { setRestrictions(prev => [...prev, newRestriction]); setNewRestriction(''); setShowAddRestriction(false) } }} className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-3 py-1.5 rounded-lg">Add</button>
            <button onClick={() => setShowAddRestriction(false)} className="text-slate-400 hover:text-slate-200 text-sm">Cancel</button>
          </div>
        )}
        <div className="space-y-2">
          {restrictions.map((r, i) => (
            <div key={i} className="flex items-center justify-between bg-slate-900 rounded-lg px-3 py-2">
              <span className="text-sm text-slate-300">{r}</span>
              <button onClick={() => setRestrictions(prev => prev.filter((_, j) => j !== i))} className="text-slate-500 hover:text-red-400 transition-colors ml-4">×</button>
            </div>
          ))}
        </div>
      </div>

      {/* Settings */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-3">Settings</p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-slate-500 block mb-1">PII Handling</label>
            <select value={piiHandling} onChange={e => setPiiHandling(e.target.value as typeof piiHandling)} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-slate-600">
              <option value="mask">Mask</option>
              <option value="hash">Hash</option>
              <option value="redact">Redact</option>
              <option value="allowed">Allowed</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1">Content Filter</label>
            <select value={contentFilter} onChange={e => setContentFilter(e.target.value as typeof contentFilter)} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-slate-600">
              <option value="strict">Strict</option>
              <option value="standard">Standard</option>
              <option value="permissive">Permissive</option>
            </select>
          </div>
        </div>
        <p className="text-xs text-slate-600 mt-4">All guardrail changes are versioned and auditable. Current: v{de.guardrails.version}</p>
      </div>
    </div>
  )
}

// ── Tab 8: Human Loop ──────────────────────────────────────────────

type Touchpoint = HumanLoopConfig['touchpoints'][number]

function TabHumanLoop({ de, companyId }: { de: DEProfile; companyId: string }) {
  const lsKey = `dt_de_humanloop_${companyId}_${de.id}`
  const saved: Touchpoint[] | null = (() => { try { const s = localStorage.getItem(lsKey); return s ? JSON.parse(s) : null } catch { return null } })()
  const [touchpoints, setTouchpoints] = useState<Touchpoint[]>(saved ?? de.humanLoop.touchpoints.map(t => ({ ...t })))

  const update = (i: number, patch: Partial<Touchpoint>) => {
    setTouchpoints(prev => {
      const next = prev.map((t, j) => j === i ? { ...t, ...patch } : t)
      try { localStorage.setItem(lsKey, JSON.stringify(next)) } catch { /* noop */ }
      return next
    })
  }

  const typeLabels: Record<string, string> = {
    approval_gate: 'APPROVAL GATE',
    review_gate: 'REVIEW GATE',
    escalation: 'ESCALATION',
    override: 'OVERRIDE',
    training_feedback: 'TRAINING FEEDBACK',
  }

  return (
    <div className="p-6 space-y-4">
      {touchpoints.map((tp, i) => (
        <div key={tp.type} className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="flex items-center justify-between mb-4">
            <span className="text-xs font-semibold text-slate-300 bg-slate-700 px-2 py-1 rounded">{typeLabels[tp.type] ?? tp.type.toUpperCase()}</span>
            <Toggle enabled={tp.enabled} onChange={v => update(i, { enabled: v })} />
          </div>
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-3">Triggers when:</p>
          <div className="space-y-3">
            <div className="flex items-center gap-3 bg-slate-900 rounded-lg px-3 py-2">
              <span className="text-xs text-slate-400 w-44">Confidence threshold</span>
              <input type="number" min={0} max={100} value={tp.confidenceThreshold}
                onChange={e => update(i, { confidenceThreshold: Number(e.target.value) })}
                className="w-16 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-sm text-slate-200 focus:outline-none focus:border-slate-600" />
              <span className="text-xs text-slate-500">% (0 = always require)</span>
            </div>
            {tp.amountThreshold !== undefined && (
              <div className="flex items-center gap-3 bg-slate-900 rounded-lg px-3 py-2">
                <span className="text-xs text-slate-400 w-44">Amount threshold</span>
                <span className="text-sm text-slate-500">$</span>
                <input type="number" value={tp.amountThreshold ?? ''}
                  onChange={e => update(i, { amountThreshold: e.target.value ? Number(e.target.value) : undefined })}
                  className="w-24 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-sm text-slate-200 focus:outline-none focus:border-slate-600" placeholder="leave blank to disable" />
              </div>
            )}
            <div className="flex items-center gap-3 bg-slate-900 rounded-lg px-3 py-2">
              <span className="text-xs text-slate-400 w-44">Escalate to</span>
              <input type="text" value={tp.escalateTo} onChange={e => update(i, { escalateTo: e.target.value })}
                className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-sm text-slate-200 focus:outline-none focus:border-slate-600" />
            </div>
            <div className="flex items-center gap-3 bg-slate-900 rounded-lg px-3 py-2">
              <span className="text-xs text-slate-400 w-44">Response SLA</span>
              <input type="number" min={1} value={tp.slaDays} onChange={e => update(i, { slaDays: Number(e.target.value) })}
                className="w-16 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-sm text-slate-200 focus:outline-none focus:border-slate-600" />
              <span className="text-xs text-slate-500">day(s)</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Tab 9: Performance ─────────────────────────────────────────────

const TASKS_THIS_MONTH: Record<string, number> = { alex: 847, casey: 312, riley: 178, morgan: 241, avery: 94 }

function TabPerformance({ de, companyId }: { de: DEProfile; companyId: string }) {
  const lsKey = `dt_de_perf_thresholds_${companyId}_${de.id}`
  const saved: Record<string, { amber: string; red: string }> = (() => { try { const s = localStorage.getItem(lsKey); return s ? JSON.parse(s) : {} } catch { return {} } })()
  const [period, setPeriod] = useState<'7d' | '30d' | '90d'>('30d')
  const [thresholds, setThresholds] = useState<Record<string, { amber: string; red: string }>>(saved)

  const metrics = [
    { key: 'resolution', label: 'Resolution Rate', value: `${de.resolutionRate}%`, color: de.resolutionRate >= 85 ? 'text-emerald-400' : de.resolutionRate >= 70 ? 'text-amber-400' : 'text-red-400' },
    { key: 'confidence', label: 'AI Confidence (avg)', value: `${de.confidence}%`, color: confidenceColor(de.confidence) },
    { key: 'escalation', label: 'Escalation Rate', value: `${de.escalationRate}%`, color: de.escalationRate > 20 ? 'text-red-400' : de.escalationRate > 12 ? 'text-amber-400' : 'text-emerald-400' },
    { key: 'response', label: 'Avg Response Time', value: de.avgResponseTime, color: 'text-slate-200' },
    { key: 'error', label: 'Error Rate', value: `${de.errorRate}%`, color: de.errorRate > 10 ? 'text-red-400' : de.errorRate > 4 ? 'text-amber-400' : 'text-emerald-400' },
    { key: 'tasks', label: 'Tasks This Month', value: String(TASKS_THIS_MONTH[de.id] ?? 0), color: 'text-slate-200' },
  ]

  const setThreshold = (key: string, field: 'amber' | 'red', val: string) => {
    setThresholds(prev => {
      const next = { ...prev, [key]: { ...prev[key], [field]: val } }
      try { localStorage.setItem(lsKey, JSON.stringify(next)) } catch { /* noop */ }
      return next
    })
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Performance Metrics</p>
        <div className="flex bg-slate-800 border border-slate-700 rounded-lg p-0.5 gap-0.5">
          {(['7d', '30d', '90d'] as const).map(p => (
            <button key={p} onClick={() => setPeriod(p)} className={`px-3 py-1 text-xs rounded-md transition-colors ${period === p ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>{p}</button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        {metrics.map(m => (
          <div key={m.key} className="bg-slate-800 border border-slate-700 rounded-xl p-4">
            <p className="text-xs text-slate-500 mb-1">{m.label}</p>
            <p className={`text-2xl font-bold mb-3 ${m.color}`}>{m.value}</p>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs text-amber-500 w-24">Amber threshold</span>
                <input type="text" value={thresholds[m.key]?.amber ?? ''} onChange={e => setThreshold(m.key, 'amber', e.target.value)}
                  className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-0.5 text-xs text-slate-300 focus:outline-none focus:border-slate-600" placeholder="e.g. 75%" />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-red-500 w-24">Red threshold</span>
                <input type="text" value={thresholds[m.key]?.red ?? ''} onChange={e => setThreshold(m.key, 'red', e.target.value)}
                  className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-0.5 text-xs text-slate-300 focus:outline-none focus:border-slate-600" placeholder="e.g. 60%" />
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 flex items-center gap-4 flex-wrap">
        <span className="text-xs text-slate-500">vs company average:</span>
        <span className="text-xs text-slate-400">Resolution <span className="text-slate-200">84%</span></span>
        <span className="text-slate-600">|</span>
        <span className="text-xs text-slate-400">Confidence <span className="text-slate-200">88%</span></span>
        <span className="text-slate-600">|</span>
        <span className="text-xs text-slate-400">Escalation <span className="text-slate-200">11%</span></span>
      </div>
    </div>
  )
}

// ── Tab 10: Audit & Memory ─────────────────────────────────────────

function TabAudit({ de }: { de: DEProfile }) {
  const [selfLearning, setSelfLearning] = useState(true)
  const [learningRate, setLearningRate] = useState<'low' | 'medium' | 'high'>('medium')
  const [topics, setTopics] = useState<string[]>(LEARNING_TOPICS[de.id] ?? [])
  const [newTopic, setNewTopic] = useState('')
  const [showTopicInput, setShowTopicInput] = useState(false)
  const [showValidation, setShowValidation] = useState(false)
  const hasValidation = de.id === 'riley'

  const auditTypeDot = (type: AuditEntry['type']) => {
    const colors: Record<AuditEntry['type'], string> = {
      resolved: 'bg-emerald-400',
      escalated: 'bg-amber-400',
      kb_gap: 'bg-blue-400',
      error: 'bg-red-400',
      config_change: 'bg-slate-500',
    }
    return <span className={`inline-block w-2 h-2 rounded-full ${colors[type]} flex-shrink-0`} />
  }

  return (
    <div className="p-6 space-y-6">
      {/* Pending Amendments */}
      <PendingAmendmentsWidget entity_kind="de" entity_id={de.id} />

      {/* Audit Log */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Audit Log</p>
          <button className="text-slate-400 hover:text-slate-200 text-sm border border-slate-600 rounded-lg px-3 py-1.5">Export Log</button>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-slate-500 border-b border-slate-700">
              <th className="text-left pb-2 font-medium w-36">Timestamp</th>
              <th className="text-left pb-2 font-medium">Action</th>
              <th className="text-left pb-2 font-medium w-40">Outcome</th>
              <th className="text-center pb-2 font-medium w-16">Type</th>
            </tr>
          </thead>
          <tbody>
            {de.auditLog.map(a => (
              <tr key={a.id} className="border-b border-slate-700/50 last:border-0">
                <td className="py-2.5 text-xs text-slate-500 font-mono">{a.timestamp}</td>
                <td className="py-2.5 text-slate-200 text-sm">{a.action}</td>
                <td className="py-2.5 text-xs text-slate-400">{a.outcome}</td>
                <td className="py-2.5">
                  <div className="flex items-center justify-center">{auditTypeDot(a.type)}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Memory & Self-Learning */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 space-y-4">
        <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Memory & Self-Learning</p>
        <div className="flex items-center justify-between bg-slate-900 rounded-lg px-3 py-2.5">
          <span className="text-sm text-slate-200">Self-learning enabled</span>
          <Toggle enabled={selfLearning} onChange={setSelfLearning} />
        </div>
        <div className="flex items-center gap-4 px-1">
          <span className="text-xs text-slate-500">Learning rate</span>
          {(['low', 'medium', 'high'] as const).map(r => (
            <label key={r} className="flex items-center gap-2 cursor-pointer">
              <input type="radio" checked={learningRate === r} onChange={() => setLearningRate(r)} className="accent-indigo-500" />
              <span className="text-sm text-slate-300 capitalize">{r}</span>
            </label>
          ))}
        </div>
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-slate-500">Approved topic priorities</p>
            <button onClick={() => setShowTopicInput(v => !v)} className="text-xs text-indigo-400 hover:text-indigo-300">+ Add topic</button>
          </div>
          {showTopicInput && (
            <div className="flex gap-2 mb-2">
              <input value={newTopic} onChange={e => setNewTopic(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && newTopic) { setTopics(p => [...p, newTopic]); setNewTopic(''); setShowTopicInput(false) } }}
                className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-slate-600" placeholder="Topic..." autoFocus />
              <button onClick={() => { if (newTopic) { setTopics(p => [...p, newTopic]); setNewTopic(''); setShowTopicInput(false) } }} className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-3 py-1.5 rounded-lg">Add</button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {topics.map((t, i) => (
              <span key={i} className="flex items-center gap-1 text-xs bg-slate-700 border border-slate-600 rounded-full px-3 py-1 text-slate-300">
                {t}
                <button onClick={() => setTopics(p => p.filter((_, j) => j !== i))} className="text-slate-500 hover:text-red-400 ml-1">×</button>
              </span>
            ))}
          </div>
        </div>
        <div className="bg-slate-900 border border-slate-700 rounded-lg p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-400">
              {hasValidation ? '1 behavior awaiting human validation' : '0 behaviors awaiting validation'}
            </span>
            {hasValidation && (
              <button onClick={() => setShowValidation(v => !v)} className="text-xs text-indigo-400 hover:text-indigo-300">
                {showValidation ? 'Collapse' : 'Review'}
              </button>
            )}
          </div>
          {showValidation && hasValidation && (
            <div className="mt-3 bg-slate-800 border border-slate-600 rounded-lg p-3">
              <p className="text-xs text-slate-500 mb-1">Proposed behavior</p>
              <p className="text-sm text-slate-200 mb-3">When leave request is submitted by same employee twice in 24 hrs, auto-reject duplicate.</p>
              <div className="flex gap-2">
                <button onClick={() => setShowValidation(false)} className="bg-emerald-600 hover:bg-emerald-500 text-white text-sm px-3 py-1.5 rounded-lg">Approve</button>
                <button onClick={() => setShowValidation(false)} className="bg-red-600/30 hover:bg-red-600/50 text-red-400 text-sm px-3 py-1.5 rounded-lg border border-red-500/30">Reject</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Human profile panel ────────────────────────────────────────────

function TrendArrow({ trend }: { trend: 'up' | 'down' | 'flat' }) {
  if (trend === 'up') return <span className="text-amber-400">↑</span>
  if (trend === 'down') return <span className="text-emerald-400">↓</span>
  return <span className="text-slate-500">→</span>
}

function HumanProfile({ person, des, onSelectDE, setPage }: {
  person: Person
  des: DEProfile[]
  onSelectDE: (id: string) => void
  setPage: (p: Page) => void
}) {
  const partners = des.filter(d => person.worksWith.includes(d.id))
  return (
    <div className="flex-1 overflow-y-auto">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-700 flex items-center gap-4">
        <div className={`w-10 h-10 rounded-full flex items-center justify-center font-semibold text-sm ${person.color} border border-slate-600`}>
          {person.avatarInitials}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="text-base font-semibold text-slate-100">{person.name}</h2>
            <span className="text-xs text-slate-400">{person.title}</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-600 text-slate-300">Human</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-700 text-slate-400">{person.team}</span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">{person.email}</p>
        </div>
      </div>

      <div className="p-6 grid grid-cols-2 gap-6">
        {/* Partnership */}
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-3">Partnership — works with</p>
          <div className="space-y-2">
            {partners.map(de => (
              <button key={de.id} onClick={() => onSelectDE(de.id)}
                className="w-full flex items-center gap-3 bg-slate-900 hover:bg-slate-700/70 rounded-lg px-3 py-2.5 transition-colors text-left">
                <div className="w-8 h-8 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-semibold text-sm">
                  {de.name[0]}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-200">{de.name}</p>
                  <p className="text-xs text-slate-500">{de.role}</p>
                </div>
                <span className="text-xs text-indigo-400">Profile →</span>
              </button>
            ))}
            {partners.length === 0 && <p className="text-sm text-slate-500">No DE partnerships yet.</p>}
          </div>
        </div>

        {/* Gate duties */}
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Gate duties</p>
            <button onClick={() => setPage('ops_human_tasks')} className="text-xs text-amber-400 hover:text-amber-300 transition-colors">
              {person.pendingItems} pending →
            </button>
          </div>
          <div className="space-y-2">
            {person.approves.map((a, i) => (
              <div key={i} className="flex items-start gap-2 bg-slate-900 rounded-lg px-3 py-2">
                <span className="text-indigo-400 text-xs mt-0.5">✋</span>
                <span className="text-sm text-slate-300 leading-snug">{a}</span>
              </div>
            ))}
          </div>
        </div>

        {/* This week's load */}
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">This week's load</p>
            <span className="text-sm"><TrendArrow trend={person.loadTrend} /></span>
          </div>
          <div className="grid grid-cols-2 gap-2 mb-3">
            {[
              { label: 'Approvals', value: person.weeklyLoad.approvals },
              { label: 'Escalations', value: person.weeklyLoad.escalations },
              { label: 'Reviews', value: person.weeklyLoad.reviews },
              { label: 'Avg response', value: `${person.weeklyLoad.avgResponseHrs} hrs` },
            ].map(m => (
              <div key={m.label} className="bg-slate-900 rounded-lg px-3 py-2">
                <p className="text-xs text-slate-500">{m.label}</p>
                <p className="text-lg font-semibold text-slate-200">{m.value}</p>
              </div>
            ))}
          </div>
          {person.loadTrend === 'up' && person.loadInsight && (
            <button onClick={() => setPage('intelligence_evals')}
              className="w-full text-left bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2.5 hover:bg-amber-500/15 transition-colors">
              <p className="text-xs text-amber-300 leading-relaxed">{person.loadInsight}</p>
            </button>
          )}
        </div>

        {/* Expertise */}
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-3">Expertise</p>
          <div className="flex flex-wrap gap-2 mb-3">
            {person.expertiseTags.map(t => (
              <span key={t} className="text-xs bg-slate-700 border border-slate-600 rounded-full px-3 py-1 text-slate-300">{t}</span>
            ))}
          </div>
          <p className="text-xs text-slate-500">
            Consulted by DEs <span className="text-slate-200 font-medium">{person.consultedByDEs} times</span> this month
          </p>
        </div>
      </div>
    </div>
  )
}

// ── Org view ───────────────────────────────────────────────────────

function OrgView({ des, people, isTCP, onSelectDE, onSelectHuman, setPage }: {
  des: DEProfile[]
  people: Person[]
  isTCP: boolean
  onSelectDE: (id: string) => void
  onSelectHuman: (id: string) => void
  setPage: (p: Page) => void
}) {
  const columns: { key: DEEntity; label: string }[] = [
    { key: 'customer', label: isTCP ? 'Customer' : 'Clients' },
    { key: 'vendor', label: 'Vendors' },
    { key: 'workforce', label: 'Our People' },
    { key: 'specialist', label: 'Specialists' },
  ]
  const shown = columns.filter(c =>
    c.key === 'vendor' || des.some(d => d.entity === c.key) || people.some(p => p.orgColumn === c.key)
  )

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <p className="text-xs text-slate-500 mb-4">How the mixed workforce maps onto the entities it serves — Digital Employees and humans, side by side.</p>
      <div className={`grid gap-4`} style={{ gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))` }}>
        {shown.map(col => {
          const colDEs = des.filter(d => d.entity === col.key)
          const colHumans = people.filter(p => p.orgColumn === col.key)
          return (
            <div key={col.key} className="bg-slate-800 border border-slate-700 rounded-xl p-4">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 pb-2 border-b border-slate-700">{col.label}</p>
              <div className="space-y-2">
                {colDEs.map(de => (
                  <button key={de.id} onClick={() => onSelectDE(de.id)}
                    className="w-full flex items-center gap-2.5 bg-slate-900 hover:bg-slate-700/70 border border-slate-700 rounded-lg px-3 py-2 transition-colors text-left">
                    <div className="w-7 h-7 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-semibold text-xs flex-shrink-0">
                      {de.name[0]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <StatusDot status={de.status} />
                        <span className="text-sm text-slate-200 truncate">{de.name}</span>
                      </div>
                      <p className="text-[11px] text-slate-500 truncate">{de.role}</p>
                    </div>
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300 flex-shrink-0">DE</span>
                  </button>
                ))}
                {colHumans.map(p => (
                  <button key={p.id} onClick={() => onSelectHuman(p.id)}
                    className="w-full flex items-center gap-2.5 bg-slate-900 hover:bg-slate-700/70 border border-slate-700 rounded-lg px-3 py-2 transition-colors text-left">
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center font-semibold text-[10px] flex-shrink-0 border border-slate-600 ${p.color}`}>
                      {p.avatarInitials}
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="text-sm text-slate-200 truncate block">{p.name}</span>
                      <p className="text-[11px] text-slate-500 truncate">{p.title}</p>
                    </div>
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-600 text-slate-300 flex-shrink-0">H</span>
                  </button>
                ))}
                {col.key === 'vendor' && colDEs.length === 0 && (
                  <button onClick={() => setPage('entity_vendor')}
                    className="w-full border border-dashed border-slate-600 rounded-lg px-3 py-3 text-left hover:border-indigo-500/50 hover:bg-indigo-500/5 transition-colors">
                    <p className="text-xs font-medium text-slate-400">No DE serving Vendors yet</p>
                    <p className="text-[11px] text-indigo-400 mt-1">Automation opportunity →</p>
                  </button>
                )}
                {colDEs.length === 0 && colHumans.length === 0 && col.key !== 'vendor' && (
                  <p className="text-xs text-slate-600 py-2 text-center">—</p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────

const TABS = ['Profile', 'Training', 'Knowledge', 'SOPs', 'Playbooks', 'Systems', 'Guardrails', 'Human Loop', 'Performance', 'Audit', 'Authority', 'Escalation', 'Knowledge Scope', 'Approval', 'Configuration', 'Sophie Config', 'Metrics']

type RosterSelection = { kind: 'de' | 'human'; id: string }

export default function WorkforceDEsPage({ setPage }: { setPage: (p: Page) => void }) {
  const dataMode = useDataMode()
  if (dataMode === 'live') return <LiveWorkforceDEs setPage={setPage} />
  return <DemoWorkforceDEsPage setPage={setPage} />
}

function DemoWorkforceDEsPage({ setPage }: { setPage: (p: Page) => void }) {
  const { activeCompanyId } = useAuth()
  const des = activeCompanyId === 'tcp' ? TCP_DES : PWC_DES
  const people = getPeople(activeCompanyId)
  const [selected, setSelected] = useState<RosterSelection>({ kind: 'de', id: des[0].id })
  const [activeTab, setActiveTab] = useState(0)
  const [view, setView] = useState<'roster' | 'org'>('roster')
  const [amendmentOpen, setAmendmentOpen] = useState(false)

  useEffect(() => {
    const newDes = activeCompanyId === 'tcp' ? TCP_DES : PWC_DES
    const newPeople = getPeople(activeCompanyId)
    // Handoff from other pages (Human Tasks, etc.) — preselect a person.
    let handoff: RosterSelection | null = null
    try {
      const raw = localStorage.getItem(ROSTER_SELECT_KEY)
      if (raw) {
        localStorage.removeItem(ROSTER_SELECT_KEY)
        if (newPeople.some(p => p.id === raw)) handoff = { kind: 'human', id: raw }
        else if (newDes.some(d => d.id === raw)) handoff = { kind: 'de', id: raw }
      }
    } catch { /* noop */ }
    setSelected(handoff ?? { kind: 'de', id: newDes[0].id })
    setActiveTab(0)
  }, [activeCompanyId])

  const selectedDE = selected.kind === 'de' ? (des.find(d => d.id === selected.id) ?? des[0]) : des[0]
  const selectedHuman = selected.kind === 'human' ? people.find(p => p.id === selected.id) : undefined

  const selectDE = (id: string) => { setSelected({ kind: 'de', id }); setActiveTab(0); setView('roster') }
  const selectHuman = (id: string) => { setSelected({ kind: 'human', id }); setView('roster') }

  const renderTab = () => {
    switch (activeTab) {
      case 0: return <TabProfile de={selectedDE} companyId={activeCompanyId} onSuggestImprovement={() => setAmendmentOpen(true)} />
      case 1: return <TabTraining de={selectedDE} setPage={setPage} />
      case 2: return <TabKnowledge de={selectedDE} />
      case 3: return <TabSOPs de={selectedDE} />
      case 4: return <TabPlaybooks de={selectedDE} />
      case 5: return <TabSystems de={selectedDE} />
      case 6: return <TabGuardrails de={selectedDE} />
      case 7: return <TabHumanLoop de={selectedDE} companyId={activeCompanyId} />
      case 8: return <TabPerformance de={selectedDE} companyId={activeCompanyId} />
      case 9: return <TabAudit de={selectedDE} />
      case 10: return <DEAuthorityPanel de={selectedDE} />
      case 11: return <SophieEscalationRules de={selectedDE} />
      case 12: return <DEKnowledgeScopePanel de={selectedDE} />
      case 13: return <DEPreApprovalRulesPanel de={selectedDE} />
      case 14: return <DEConfigurationTab de={selectedDE} tenant_id={activeCompanyId} />
      case 15: return <SophieConfigurationEditor de={selectedDE} />
      case 16: return <AmendmentMetricsPanel entityKind="de" entityId={selectedDE.id} />
      default: return null
    }
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-900">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-slate-700 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Workforce HQ</h1>
          <p className="text-xs text-slate-500 mt-0.5">Humans and Digital Employees — one team · {des.length} DEs · {people.length} humans</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex bg-slate-800 border border-slate-700 rounded-lg p-0.5 gap-0.5">
            {(['roster', 'org'] as const).map(v => (
              <button key={v} onClick={() => setView(v)}
                className={`px-3 py-1.5 text-xs rounded-md transition-colors ${view === v ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
                {v === 'roster' ? 'Roster' : 'Org view'}
              </button>
            ))}
          </div>
          <button className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-4 py-2 rounded-lg transition-colors">+ New DE</button>
        </div>
      </div>

      {view === 'org' ? (
        <OrgView des={des} people={people} isTCP={activeCompanyId === 'tcp'} onSelectDE={selectDE} onSelectHuman={selectHuman} setPage={setPage} />
      ) : (
      /* Body: split panel */
      <div className="flex flex-1 overflow-hidden">
        {/* Left: mixed roster */}
        <div className="w-60 flex-shrink-0 bg-slate-800 border-r border-slate-700 overflow-y-auto">
          <div className="p-3 space-y-1">
            <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider px-2 pt-1 pb-1">Digital Employees ({des.length})</p>
            {des.map(de => (
              <button
                key={de.id}
                onClick={() => selectDE(de.id)}
                className={`w-full text-left rounded-xl p-3 transition-colors ${selected.kind === 'de' && selected.id === de.id ? 'bg-slate-700 border border-slate-600' : 'hover:bg-slate-700/50'}`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <StatusDot status={de.status} />
                  <span className="text-sm font-medium text-slate-100">{de.name}</span>
                </div>
                <p className="text-xs text-slate-400 ml-4 leading-tight mb-1.5">{de.role}</p>
                <div className="ml-4">
                  <EntityBadge entity={de.entity} />
                </div>
              </button>
            ))}
            <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider px-2 pt-3 pb-1">Humans ({people.length})</p>
            {people.map(p => (
              <button
                key={p.id}
                onClick={() => selectHuman(p.id)}
                className={`w-full text-left rounded-xl p-2.5 transition-colors flex items-center gap-2.5 ${selected.kind === 'human' && selected.id === p.id ? 'bg-slate-700 border border-slate-600' : 'hover:bg-slate-700/50'}`}
              >
                <div className={`w-7 h-7 rounded-full flex items-center justify-center font-semibold text-[10px] flex-shrink-0 border border-slate-600 ${p.color}`}>
                  {p.avatarInitials}
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-slate-100 truncate block">{p.name}</span>
                  <p className="text-xs text-slate-400 leading-tight truncate">{p.title}</p>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Right: DE profile or human profile */}
        {selectedHuman ? (
          <HumanProfile person={selectedHuman} des={des} onSelectDE={selectDE} setPage={setPage} />
        ) : (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* DE header */}
          <div className="flex-shrink-0 px-6 py-4 border-b border-slate-700 flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-semibold text-lg">
              {selectedDE.name[0]}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 flex-wrap">
                <h2 className="text-base font-semibold text-slate-100">{selectedDE.name}</h2>
                <span className="text-xs text-slate-400">{selectedDE.role}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${selectedDE.status === 'active' ? 'bg-emerald-500/20 text-emerald-400' : selectedDE.status === 'degraded' ? 'bg-amber-500/20 text-amber-400' : selectedDE.status === 'at_risk' ? 'bg-red-500/20 text-red-400' : 'bg-slate-600 text-slate-500'}`}>
                  {selectedDE.status.replace('_', ' ')}
                </span>
                <EntityBadge entity={selectedDE.entity} />
              </div>
              <p className="text-xs text-slate-500 mt-0.5 truncate">{selectedDE.description}</p>
            </div>
          </div>

          {/* Tab bar */}
          <div className="flex-shrink-0 flex border-b border-slate-700 overflow-x-auto">
            {TABS.map((tab, i) => (
              <button
                key={tab}
                onClick={() => setActiveTab(i)}
                className={`px-3 py-2.5 text-sm whitespace-nowrap border-b-2 transition-colors ${activeTab === i ? 'border-indigo-500 text-slate-200' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
              >
                {tab}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto">
            {renderTab()}
          </div>
        </div>
        )}
      </div>
      )}

      {/* Amendment wizard modal */}
      {amendmentOpen && (
        <AmendmentWizard
          entity_kind="de"
          entity_id={selectedDE.id}
          entity_name={selectedDE.name}
          onClose={() => setAmendmentOpen(false)}
          onSuccess={() => setAmendmentOpen(false)}
        />
      )}
    </div>
  )
}
