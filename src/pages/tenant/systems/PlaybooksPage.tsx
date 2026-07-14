import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../../context/AuthContext';
import { PageHeader, th, td } from '../../../components/ui';
import type { Page } from '../../../types';
import type { CompanyId } from '../../../data/companies';
import { useDataMode } from '../../../lib/dataMode';
import LivePlaybookBuilder from './LivePlaybookBuilder';

// ============================================================
// Playbooks — versioned draft → eval → publish lifecycle.
// Editing never mutates the published playbook: the first edit
// forks a draft, and the draft can only be published after its
// eval scenarios pass in the Proving Ground. A failing scenario
// BLOCKS publishing — a bad process change physically can't ship.
//
// HONESTY RULE: eval runs here are clearly-labeled simulations
// landing on seeded results. No model is executed.
// ============================================================

// ── Types ─────────────────────────────────────────────────────────

type PlaybookType = 'process' | 'response' | 'escalation' | 'cross_function' | 'crisis' | 'scheduled';

interface PlaybookStep {
  step: number;
  title: string;
  description: string;
  owner: string;          // DE name or human role
  humanGate: boolean;
}

interface Playbook {
  id: string;
  title: string;
  type: PlaybookType;
  des: string[];
  trigger: string;
  lastRun: string;
  active: boolean;
  version: string;        // published version, e.g. "v3.2"
  objective: string;
  steps: PlaybookStep[];
}

interface PlaybookDraft {
  version: string;        // draft version, e.g. "v3.3"
  summary: string;        // what changed
  steps: PlaybookStep[];  // full edited steps array (kept simple)
}

interface EvalScenario {
  name: string;
  pass: boolean;
  failNote?: string;
}

interface PlaybookVersionEntry {
  version: string;
  date: string;
  summary: string;
  changedBy: string;
  evalResult: string;     // e.g. "8/8 passed"
  diff: { removed: string[]; added: string[] };
}

// ── 12-step Renewal Lifecycle (harvested from legacy PlaybooksPage) ─

const RENEWAL_STEPS: PlaybookStep[] = [
  { step: 1, title: 'Pull Contract from Gainsight', description: 'Fetch contract renewal date, ARR, health score, and CSM owner for the account.', owner: 'Casey', humanGate: false },
  { step: 2, title: 'Pull Subscription from Zuora', description: 'Fetch current subscription details, MRR, and any usage overages from Zuora.', owner: 'Casey', humanGate: false },
  { step: 3, title: 'Health Score Check', description: 'Route renewal based on Gainsight health score — healthy accounts go to standard renewal, at-risk accounts get CSM review.', owner: 'Casey', humanGate: false },
  { step: 4, title: 'Generate Invoice in Zuora', description: 'Create renewal invoice in Zuora for the subscription amount plus any overages.', owner: 'Casey', humanGate: true },
  { step: 5, title: 'Flag for CSM Review', description: 'Health score below threshold — create a Gainsight CTA and notify the CSM before generating invoice.', owner: 'CSM (human)', humanGate: true },
  { step: 6, title: 'Send Renewal Email — Day 0', description: 'Send the initial renewal email with invoice link to the primary billing contact.', owner: 'Casey', humanGate: false },
  { step: 7, title: 'Wait 7 Days — Check Payment', description: 'Monitor Zuora for payment_received event. If unpaid after 7 days, send reminder.', owner: 'Casey', humanGate: false },
  { step: 8, title: 'Send Payment Reminder — Day 7', description: 'Invoice still unpaid — send a friendly reminder email.', owner: 'Casey', humanGate: false },
  { step: 9, title: 'Final Notice — Day 14', description: 'Second follow-up if still unpaid after 14 days. Notify CSM and send final notice email.', owner: 'CSM (human)', humanGate: false },
  { step: 10, title: 'Mark Invoice Paid in Zuora', description: 'Payment confirmed — update invoice status in Zuora to PAID.', owner: 'Casey', humanGate: false },
  { step: 11, title: 'Update Renewal Status in Gainsight', description: 'Log the successful renewal to Gainsight timeline and update renewal stage to "Renewed".', owner: 'Casey', humanGate: false },
  { step: 12, title: 'Renewal Complete', description: 'Notify the account team that the renewal is complete. Log summary.', owner: 'Casey', humanGate: false },
];

// Draft v3.3 of the Renewal Lifecycle — Day-7 reminder moved to Day-5
// (firm tone) with a new usage-report attachment step.
const RENEWAL_DRAFT_STEPS: PlaybookStep[] = [
  ...RENEWAL_STEPS.slice(0, 6),
  { step: 7, title: 'Attach Usage Report to First Reminder', description: 'Generate a 12-month usage-value report for the account and attach it to the first reminder email — customers who see their own usage renew faster.', owner: 'Casey', humanGate: false },
  { step: 8, title: 'Wait 5 Days — Check Payment', description: 'Monitor Zuora for payment_received event. If unpaid after 5 days, send the firm reminder.', owner: 'Casey', humanGate: false },
  { step: 9, title: 'Send Firm Payment Reminder — Day 5', description: 'Invoice still unpaid — send a firm reminder email with the usage report attached.', owner: 'Casey', humanGate: false },
  ...RENEWAL_STEPS.slice(8).map(s => ({ ...s, step: s.step + 1 })),
];

// ── Seed playbooks (assignments match WorkforceDEsPage DE profiles) ─

const TCP_PLAYBOOKS: Playbook[] = [
  {
    id: 'renewal_lifecycle', title: 'Renewal Lifecycle Playbook', type: 'process', des: ['Casey'],
    trigger: 'Scheduled — 45 days before renewal date', lastRun: '2 hrs ago', active: true, version: 'v3.2',
    objective: 'End-to-end renewal management: detect upcoming renewals, generate invoices in Zuora, send email cadence, and confirm payment.',
    steps: RENEWAL_STEPS,
  },
  {
    id: 'inbound_support', title: 'Inbound Support Resolution', type: 'process', des: ['Alex'],
    trigger: 'Event — new Zendesk ticket', lastRun: '4 min ago', active: true, version: 'v2.4',
    objective: 'Classify, resolve, or route every inbound support ticket within SLA.',
    steps: [
      { step: 1, title: 'Classify Ticket', description: 'Determine severity, topic, and customer tier from ticket content.', owner: 'Alex', humanGate: false },
      { step: 2, title: 'Knowledge Lookup', description: 'Search product docs, API reference, and troubleshooting guides.', owner: 'Alex', humanGate: false },
      { step: 3, title: 'Draft & Send Resolution', description: 'Respond if confidence ≥ 65%; otherwise route to review gate.', owner: 'Alex', humanGate: false },
      { step: 4, title: 'Escalate if Unresolved', description: 'Hand off to L2 Engineering with full context if resolution fails.', owner: 'L2 Engineering (human)', humanGate: true },
    ],
  },
  {
    id: 'auth_access', title: 'Auth & Access Issues', type: 'response', des: ['Alex'],
    trigger: 'Event — ticket tagged auth/2FA/SSO', lastRun: '2 hrs ago', active: true, version: 'v1.6',
    objective: 'Fast-path playbook for authentication, 2FA reset, and SSO configuration issues.',
    steps: [
      { step: 1, title: 'Verify Identity', description: 'Confirm requester identity per security SOP before any account change.', owner: 'Alex', humanGate: false },
      { step: 2, title: 'Apply Standard Fix', description: '2FA reset, session revoke, or SSO metadata refresh per runbook.', owner: 'Alex', humanGate: false },
      { step: 3, title: 'Security Review for Admin Accounts', description: 'Changes to admin-level accounts require human security sign-off.', owner: 'Security (human)', humanGate: true },
    ],
  },
  {
    id: 'critical_outage', title: 'Critical Outage Response', type: 'crisis', des: ['Alex'],
    trigger: 'Event — status page incident opened', lastRun: '12 days ago', active: true, version: 'v1.2',
    objective: 'Coordinate customer communication during a P1 outage.',
    steps: [
      { step: 1, title: 'Acknowledge All Inbound', description: 'Auto-acknowledge tickets referencing the incident with status-page link.', owner: 'Alex', humanGate: false },
      { step: 2, title: 'Approve Holding Statement', description: 'Incident commander approves customer-facing holding statement.', owner: 'Incident Commander (human)', humanGate: true },
      { step: 3, title: 'Broadcast Updates', description: 'Send updates to affected customers every 30 minutes until resolved.', owner: 'Alex', humanGate: false },
      { step: 4, title: 'Post-Incident Follow-up', description: 'Send RCA summary to affected accounts after resolution.', owner: 'Alex', humanGate: false },
    ],
  },
  {
    id: 'l2_escalation', title: 'L2 Escalation Handoff', type: 'escalation', des: ['Alex'],
    trigger: 'Threshold — confidence below 55%', lastRun: '23 min ago', active: true, version: 'v2.0',
    objective: 'Package full context and route unresolvable tickets to L2 Engineering.',
    steps: [
      { step: 1, title: 'Compile Context Bundle', description: 'Ticket history, reproduction steps, environment, and attempted fixes.', owner: 'Alex', humanGate: false },
      { step: 2, title: 'Create Linked Jira Issue', description: 'Open ENG issue with the context bundle attached.', owner: 'Alex', humanGate: false },
      { step: 3, title: 'L2 Triage', description: 'Engineering triages within the 2-day escalation SLA.', owner: 'L2 Engineering (human)', humanGate: true },
    ],
  },
  {
    id: 'weekly_digest', title: 'Weekly Support Digest', type: 'scheduled', des: ['Alex'],
    trigger: 'Scheduled — Fridays 16:00', lastRun: '6 days ago', active: false, version: 'v1.1',
    objective: 'Summarize ticket volume, topics, and KB gaps for the support leadership team.',
    steps: [
      { step: 1, title: 'Aggregate Week Metrics', description: 'Volume, resolution rate, escalations, top topics.', owner: 'Alex', humanGate: false },
      { step: 2, title: 'Send Digest', description: 'Email digest to support leadership distribution list.', owner: 'Alex', humanGate: false },
    ],
  },
  {
    id: 'at_risk_response', title: 'At-Risk Renewal Response', type: 'response', des: ['Casey'],
    trigger: 'Event — Gainsight health score drops below 50', lastRun: '1 day ago', active: true, version: 'v1.8',
    objective: 'Immediate response cadence when an account turns at-risk inside the renewal window.',
    steps: [
      { step: 1, title: 'Pull Risk Signals', description: 'Usage decline, support volume, NPS, and outstanding invoices.', owner: 'Casey', humanGate: false },
      { step: 2, title: 'Draft Save Offer', description: 'Propose retention offer within template discount limits (max 20% without VP approval).', owner: 'Casey', humanGate: false },
      { step: 3, title: 'AE Approval', description: 'Account Executive approves the save offer before it is sent.', owner: 'Account Executive (human)', humanGate: true },
    ],
  },
  {
    id: 'at_risk_save', title: 'At-Risk Account Save', type: 'cross_function', des: ['Casey', 'Alex'],
    trigger: 'Event — at-risk flag on account with open P1 ticket', lastRun: '2 days ago', active: true, version: 'v1.3',
    objective: 'Cross-function save play: Casey coordinates the commercial response while Alex resolves the underlying support issue.',
    steps: [
      { step: 1, title: 'Correlate Risk & Support Data', description: 'Casey links the at-risk flag to open tickets and recent escalations.', owner: 'Casey', humanGate: false },
      { step: 2, title: 'Prioritize Ticket Resolution', description: 'Alex bumps the account’s open tickets to priority queue and resolves or escalates.', owner: 'Alex', humanGate: false },
      { step: 3, title: 'Save-Plan Approval', description: 'CSM lead approves the combined technical + commercial save plan.', owner: 'CSM Lead (human)', humanGate: true },
      { step: 4, title: 'Execute & Monitor', description: 'Casey sends the commercial response; both DEs monitor health score for 14 days.', owner: 'Casey', humanGate: false },
    ],
  },
  {
    id: 'renewal_cadence', title: 'Renewal Email Cadence', type: 'scheduled', des: ['Casey'],
    trigger: 'Scheduled — daily 09:00', lastRun: '5 hrs ago', active: true, version: 'v2.1',
    objective: 'Send day-0 / day-7 / day-14 renewal emails per account renewal stage.',
    steps: [
      { step: 1, title: 'Scan Renewal Pipeline', description: 'Find accounts due a cadence touch today.', owner: 'Casey', humanGate: false },
      { step: 2, title: 'Send Stage Email', description: 'Send the appropriate cadence template via Gainsight.', owner: 'Casey', humanGate: false },
    ],
  },
  {
    id: 'churn_prevention', title: 'Churn Prevention Escalation', type: 'escalation', des: ['Casey'],
    trigger: 'Event — renewal declined or no response by day 21', lastRun: '3 days ago', active: true, version: 'v1.4',
    objective: 'Escalate stalled renewals to the account team before the contract lapses.',
    steps: [
      { step: 1, title: 'Flag Stalled Renewal', description: 'Mark renewal at-risk in Gainsight with full timeline.', owner: 'Casey', humanGate: false },
      { step: 2, title: 'AE Takeover', description: 'Account Executive takes over the commercial conversation.', owner: 'Account Executive (human)', humanGate: true },
    ],
  },
  {
    id: 'new_hire_onboarding', title: 'New Hire Onboarding Flow', type: 'process', des: ['Riley'],
    trigger: 'Event — offer accepted in Greenhouse', lastRun: '1 day ago', active: true, version: 'v2.2',
    objective: 'Provision accounts, schedule orientation, and complete the day-1 checklist for every new hire.',
    steps: [
      { step: 1, title: 'Create Workday Record', description: 'Create employee record from the accepted offer.', owner: 'Riley', humanGate: false },
      { step: 2, title: 'Provision Access', description: 'Request accounts and equipment per role template.', owner: 'Riley', humanGate: false },
      { step: 3, title: 'HRBP Compensation Check', description: 'HRBP confirms compensation setup before payroll enrollment.', owner: 'HRBP (human)', humanGate: true },
      { step: 4, title: 'Day-1 Checklist', description: 'Send welcome pack and schedule orientation sessions.', owner: 'Riley', humanGate: false },
    ],
  },
  {
    id: 'hr_policy_response', title: 'HR Policy Response', type: 'response', des: ['Riley'],
    trigger: 'Event — employee HR question received', lastRun: '3 hrs ago', active: true, version: 'v1.9',
    objective: 'Answer policy and benefits questions from the HR knowledge base with strict PII handling.',
    steps: [
      { step: 1, title: 'Policy Lookup', description: 'Search HR policies and benefits handbook.', owner: 'Riley', humanGate: false },
      { step: 2, title: 'Respond or Route', description: 'Answer if confidence ≥ 70%; sensitive topics route to HRBP.', owner: 'Riley', humanGate: false },
      { step: 3, title: 'HRBP Review for Sensitive Topics', description: 'Compensation, visa, and disciplinary questions require a human.', owner: 'HRBP (human)', humanGate: true },
    ],
  },
  {
    id: 'headcount_report', title: 'Monthly Headcount Report', type: 'scheduled', des: ['Riley'],
    trigger: 'Scheduled — 1st of month 08:00', lastRun: '2 days ago', active: true, version: 'v1.0',
    objective: 'Compile headcount, attrition, and open-role metrics for leadership.',
    steps: [
      { step: 1, title: 'Aggregate Workforce Data', description: 'Pull headcount and attrition from Workday, open roles from Greenhouse.', owner: 'Riley', humanGate: false },
      { step: 2, title: 'Distribute Report', description: 'Send report to leadership distribution list.', owner: 'Riley', humanGate: false },
    ],
  },
];

const PWC_PLAYBOOKS: Playbook[] = [
  {
    id: 'client_engagement', title: 'Client Engagement Lifecycle', type: 'process', des: ['Morgan'],
    trigger: 'Event — new engagement signed', lastRun: '1 day ago', active: true, version: 'v2.5',
    objective: 'Run the full engagement lifecycle from KYC through delivery status updates.',
    steps: [
      { step: 1, title: 'KYC & AML Checks', description: 'Run KYC workflow on the new client and file evidence.', owner: 'Morgan', humanGate: false },
      { step: 2, title: 'Engagement Letter via DocuSign', description: 'Send engagement letter for signature.', owner: 'Morgan', humanGate: true },
      { step: 3, title: 'Kickoff & Cadence', description: 'Schedule kickoff and set the status-update cadence.', owner: 'Morgan', humanGate: false },
      { step: 4, title: 'Partner Sign-off on Scope Changes', description: 'Any scope or fee change >$5,000 requires partner approval.', owner: 'Partner (human)', humanGate: true },
    ],
  },
  {
    id: 'kyc_aml', title: 'KYC & AML Response', type: 'response', des: ['Morgan'],
    trigger: 'Event — client document received', lastRun: '5 hrs ago', active: true, version: 'v2.1',
    objective: 'Verify client identity documents and screen against sanctions lists.',
    steps: [
      { step: 1, title: 'Document Verification', description: 'Validate identity documents and beneficial ownership.', owner: 'Morgan', humanGate: false },
      { step: 2, title: 'Sanctions Screening', description: 'Screen entities against sanctions and PEP lists.', owner: 'Morgan', humanGate: false },
      { step: 3, title: 'Risk & Compliance Review on Hits', description: 'Any screening hit is escalated to Risk & Compliance.', owner: 'Risk & Compliance (human)', humanGate: true },
    ],
  },
  {
    id: 'gdpr_handling', title: 'GDPR Request Handling', type: 'escalation', des: ['Morgan'],
    trigger: 'Event — data-subject request received', lastRun: '2 hrs ago', active: true, version: 'v1.7',
    objective: 'Track statutory deadlines on data-subject requests and escalate before breach.',
    steps: [
      { step: 1, title: 'Log & Classify Request', description: 'Record the request and start the 30-day statutory clock.', owner: 'Morgan', humanGate: false },
      { step: 2, title: 'Compile Data Export', description: 'Gather responsive records across systems.', owner: 'Morgan', humanGate: false },
      { step: 3, title: 'Legal Review & Release', description: 'Legal reviews and approves the response before release.', owner: 'Legal (human)', humanGate: true },
    ],
  },
  {
    id: 'quarterly_review', title: 'Quarterly Client Review', type: 'scheduled', des: ['Morgan'],
    trigger: 'Scheduled — quarterly', lastRun: '18 days ago', active: true, version: 'v1.2',
    objective: 'Prepare quarterly relationship review packs for each active client.',
    steps: [
      { step: 1, title: 'Compile Engagement Metrics', description: 'Fees, delivery status, satisfaction signals per client.', owner: 'Morgan', humanGate: false },
      { step: 2, title: 'Partner Review', description: 'Engagement partner reviews the pack before the client meeting.', owner: 'Partner (human)', humanGate: true },
    ],
  },
  {
    id: 'tax_research_flow', title: 'Tax Research Request Flow', type: 'process', des: ['Avery'],
    trigger: 'Event — research request from engagement team', lastRun: '3 hrs ago', active: true, version: 'v2.0',
    objective: 'Research, draft, and route tax memos through mandatory partner review.',
    steps: [
      { step: 1, title: 'Scope the Question', description: 'Clarify jurisdiction, entity type, and tax years in scope.', owner: 'Avery', humanGate: false },
      { step: 2, title: 'Research Checkpoint & Bloomberg', description: 'Query Thomson Reuters and Bloomberg Tax; cite authorities.', owner: 'Avery', humanGate: false },
      { step: 3, title: 'Draft Memo', description: 'Draft memo per drafting standards with full citations.', owner: 'Avery', humanGate: false },
      { step: 4, title: 'Partner Review', description: 'All memos require partner review before client delivery.', owner: 'Partner (human)', humanGate: true },
    ],
  },
  {
    id: 'reg_change_response', title: 'Regulatory Change Response', type: 'response', des: ['Avery'],
    trigger: 'Event — new ruling matches watched topic', lastRun: '2 days ago', active: true, version: 'v1.3',
    objective: 'Assess new rulings and notify affected engagement teams.',
    steps: [
      { step: 1, title: 'Assess Impact', description: 'Determine which clients and open positions are affected.', owner: 'Avery', humanGate: false },
      { step: 2, title: 'Draft Impact Summary', description: 'Summarize the change and recommended actions.', owner: 'Avery', humanGate: false },
      { step: 3, title: 'Senior Tax Manager Sign-off', description: 'Summary reviewed before distribution to engagement teams.', owner: 'Senior Tax Manager (human)', humanGate: true },
    ],
  },
];

const PLAYBOOKS: Record<CompanyId, Playbook[]> = { tcp: TCP_PLAYBOOKS, pwc: PWC_PLAYBOOKS };

// ── Seeded drafts ─────────────────────────────────────────────────

const SEED_DRAFTS: Record<CompanyId, Record<string, PlaybookDraft>> = {
  tcp: {
    renewal_lifecycle: {
      version: 'v3.3',
      summary: 'Day-7 firm reminder moved to Day-5; new step: usage-report attachment on first reminder',
      steps: RENEWAL_DRAFT_STEPS,
    },
  },
  pwc: {
    kyc_aml: {
      version: 'v2.2',
      summary: 'Adds continue-with-warning fallback when screening flags remain unresolved after 48 hours',
      steps: [
        { step: 1, title: 'Document Verification', description: 'Validate identity documents and beneficial ownership.', owner: 'Morgan', humanGate: false },
        { step: 2, title: 'Sanctions Screening', description: 'Screen entities against sanctions and PEP lists.', owner: 'Morgan', humanGate: false },
        { step: 3, title: 'Risk & Compliance Review on Hits', description: 'Any screening hit is escalated to Risk & Compliance.', owner: 'Risk & Compliance (human)', humanGate: true },
        { step: 4, title: 'Continue with Warning on Unresolved Flags', description: 'If screening flags remain unresolved after 48 hours, proceed with the engagement and attach a warning note for later compliance review.', owner: 'Morgan', humanGate: false },
      ],
    },
  },
};

// ── Eval scenarios per playbook (simulated — seeded results) ──────

const DRAFT_EVALS: Record<string, EvalScenario[]> = {
  renewal_lifecycle: [
    { name: 'Standard renewal — invoice matches contract terms + 4% escalator', pass: true },
    { name: 'At-risk account — save-play branch triggers before cadence continues', pass: true },
    { name: 'Guardrail: discount above 20% blocked without VP approval', pass: true },
    { name: 'Human gate: invoice >$10K routes to Jai Patel, never auto-sent', pass: true },
    { name: 'Day-5 firm reminder fires only when Zuora still shows unpaid', pass: true },
    { name: 'Usage-report attachment renders correct 12-month account data', pass: true },
    { name: 'Final notice still lands Day-14 after the cadence change', pass: true },
    { name: 'Payment received mid-cadence — all reminders halt immediately', pass: true },
  ],
  kyc_aml: [
    { name: 'Standard KYC intake — documents verified, evidence filed', pass: true },
    { name: 'Missing beneficial-ownership docs — hold placed on engagement', pass: true },
    { name: 'PEP match — routes to Risk & Compliance with full context', pass: true },
    { name: 'Sanctions-list match must hard-stop the flow', pass: false, failNote: 'Draft step 4 allows continue-with-warning — a sanctions hit must hard-stop the engagement, not proceed with a note.' },
    { name: 'Screening data retained per GDPR policy, kept out of client file', pass: true },
    { name: '48-hour SLA breach — escalation fires to compliance lead', pass: true },
  ],
};

// Fallback scenario set for ad-hoc drafts on other playbooks — all pass.
function defaultEvals(pb: Playbook): EvalScenario[] {
  return [
    { name: `Standard path — ${pb.title} completes end-to-end per objective`, pass: true },
    { name: 'Edited step executes with the revised instructions', pass: true },
    { name: 'Guardrails: all restriction rules still enforced mid-flow', pass: true },
    { name: `Human gate${pb.steps.some(s => s.humanGate) ? 's' : ''}: approval steps still route to a human, never auto-approved`, pass: true },
    { name: 'Failure branch — step error escalates instead of silently continuing', pass: true },
    { name: 'Audit: every step execution logged with version stamp', pass: true },
  ];
}

// ── Seeded version history ────────────────────────────────────────

const SEED_HISTORY: Record<string, PlaybookVersionEntry[]> = {
  renewal_lifecycle: [
    {
      version: 'v3.2', date: '2026-05-20', summary: 'Health-score routing added before invoice generation', changedBy: 'CSM Lead', evalResult: '8/8 passed',
      diff: {
        removed: ['Step 3: Generate Invoice in Zuora — invoice generated for every renewal regardless of account health'],
        added: ['Step 3: Health Score Check — route on Gainsight health score before invoicing', 'Step 5: Flag for CSM Review — at-risk accounts get a Gainsight CTA + CSM notify before invoice'],
      },
    },
    {
      version: 'v3.1', date: '2026-03-14', summary: 'Renewal window extended from 30 to 45 days before renewal date', changedBy: 'RevOps', evalResult: '7/7 passed',
      diff: {
        removed: ['Trigger: Scheduled — 30 days before renewal date'],
        added: ['Trigger: Scheduled — 45 days before renewal date', 'Cadence timings re-based on the 45-day window'],
      },
    },
  ],
  kyc_aml: [
    {
      version: 'v2.1', date: '2026-04-02', summary: 'PEP screening added alongside sanctions lists', changedBy: 'Risk & Compliance', evalResult: '5/5 passed',
      diff: {
        removed: ['Step 2: Sanctions Screening — screen entities against sanctions lists'],
        added: ['Step 2: Sanctions Screening — screen entities against sanctions and PEP lists'],
      },
    },
  ],
};

// ── Persistence helpers ───────────────────────────────────────────

const draftsKey = (cid: CompanyId) => `dt_playbook_drafts_${cid}`;
const publishedKey = (cid: CompanyId) => `dt_playbook_published_${cid}`;
const historyKey = (cid: CompanyId) => `dt_playbook_history_${cid}`;
const evalRunsKey = (cid: CompanyId) => `dt_evals_playbook_${cid}`;

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch { return fallback; }
}
function saveJson(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* noop */ }
}

const bumpVersion = (v: string) => `v${(parseFloat(v.slice(1)) + 0.1).toFixed(1)}`;
const stepLine = (s: PlaybookStep) => `Step ${s.step}: ${s.title} — ${s.description}`;

function stepsDiff(oldSteps: PlaybookStep[], newSteps: PlaybookStep[]) {
  const removed: string[] = [];
  const added: string[] = [];
  const max = Math.max(oldSteps.length, newSteps.length);
  for (let i = 0; i < max; i++) {
    const o = oldSteps[i];
    const n = newSteps[i];
    if (o && n) {
      if (o.title !== n.title || o.description !== n.description) {
        removed.push(stepLine(o));
        added.push(stepLine(n));
      }
    } else if (o) {
      removed.push(stepLine(o));
    } else if (n) {
      added.push(stepLine(n));
    }
  }
  return { removed, added };
}

// ── Helpers ───────────────────────────────────────────────────────

// Type badges — same palette as WorkforceDEsPage TabPlaybooks
function typeBadge(type: PlaybookType) {
  const styles: Record<PlaybookType, string> = {
    process: 'bg-blue-500/20 text-blue-400',
    response: 'bg-indigo-500/20 text-indigo-400',
    escalation: 'bg-red-500/20 text-red-400',
    cross_function: 'bg-purple-500/20 text-purple-400',
    crisis: 'bg-red-500/20 text-red-400',
    scheduled: 'bg-slate-600 text-slate-400',
  };
  const labels: Record<PlaybookType, string> = {
    process: 'Process', response: 'Response', escalation: 'Escalation',
    cross_function: 'Cross-Function', crisis: 'Crisis', scheduled: 'Scheduled',
  };
  return <span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${styles[type]}`}>{labels[type]}</span>;
}

function Toggle({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={e => { e.stopPropagation(); onChange(!enabled); }}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${enabled ? 'bg-indigo-600' : 'bg-slate-600'}`}
    >
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : 'translate-x-1'}`} />
    </button>
  );
}

// ── Page ──────────────────────────────────────────────────────────

type ViewMode = 'published' | 'draft';


export default function PlaybooksPage({ setPage }: { setPage: (p: Page) => void }) {
  const dataMode = useDataMode();
  if (dataMode === 'live') return <LivePlaybookBuilder setPage={setPage} />;
  return <DemoPlaybooksPage setPage={setPage} />;
}

function DemoPlaybooksPage({ setPage }: { setPage: (p: Page) => void }) {
  const { activeCompanyId } = useAuth();

  // Published overrides (promoted drafts) + draft overrides (null = dismissed/promoted seed draft)
  const [publishedOverrides, setPublishedOverrides] = useState<Record<string, { version: string; steps: PlaybookStep[] }>>({});
  const [draftOverrides, setDraftOverrides] = useState<Record<string, PlaybookDraft | null>>({});
  const [extraHistory, setExtraHistory] = useState<Record<string, PlaybookVersionEntry[]>>({});
  const [activeState, setActiveState] = useState<Record<string, boolean>>({});

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('published');
  const [editingStep, setEditingStep] = useState<number | null>(null);
  const [stepDraft, setStepDraft] = useState('');
  const [openDiff, setOpenDiff] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Eval modal state (simulated — design preview)
  const [evalOpen, setEvalOpen] = useState(false);
  const [evalStep, setEvalStep] = useState(0);
  const [evalDone, setEvalDone] = useState(false);
  const evalTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setPublishedOverrides(loadJson(publishedKey(activeCompanyId), {}));
    setDraftOverrides(loadJson(draftsKey(activeCompanyId), {}));
    setExtraHistory(loadJson(historyKey(activeCompanyId), {}));
    setActiveState({});
    setSelectedId(null);
    setViewMode('published');
    setEditingStep(null);
    setOpenDiff(null);
    closeEval();
  }, [activeCompanyId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { if (evalTimer.current) clearInterval(evalTimer.current); }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // Effective published playbooks = seed + promoted overrides
  const playbooks: Playbook[] = PLAYBOOKS[activeCompanyId].map(p => {
    const ov = publishedOverrides[p.id];
    return {
      ...p,
      version: ov ? ov.version : p.version,
      steps: ov ? ov.steps : p.steps,
      active: activeState[p.id] ?? p.active,
    };
  });

  const getDraft = (id: string): PlaybookDraft | null =>
    id in draftOverrides ? draftOverrides[id] : (SEED_DRAFTS[activeCompanyId][id] ?? null);

  const getHistory = (id: string): PlaybookVersionEntry[] =>
    [...(extraHistory[id] ?? []), ...(SEED_HISTORY[id] ?? [])];

  const selected = playbooks.find(p => p.id === selectedId) ?? null;
  const selectedDraft = selected ? getDraft(selected.id) : null;
  const activeCount = playbooks.filter(p => p.active).length;
  const draftCount = playbooks.filter(p => getDraft(p.id)).length;

  const viewingDraft = viewMode === 'draft' && !!selectedDraft;
  const viewSteps = viewingDraft && selectedDraft ? selectedDraft.steps : selected?.steps ?? [];

  const scenarios: EvalScenario[] = selected
    ? (DRAFT_EVALS[selected.id] ?? defaultEvals(selected))
    : [];
  const passCount = scenarios.filter(s => s.pass).length;
  const allPass = passCount === scenarios.length;
  const failing = scenarios.filter(s => !s.pass);

  const toggleActive = (id: string, v: boolean) =>
    setActiveState(prev => ({ ...prev, [id]: v }));

  const persistDrafts = (next: Record<string, PlaybookDraft | null>) => {
    setDraftOverrides(next);
    saveJson(draftsKey(activeCompanyId), next);
  };

  // Editing a step: on the published version, the first edit forks a draft.
  const saveStep = (stepNum: number) => {
    if (!selected) return;
    if (viewingDraft && selectedDraft) {
      const next = {
        ...draftOverrides,
        [selected.id]: {
          ...selectedDraft,
          steps: selectedDraft.steps.map(s => s.step === stepNum ? { ...s, description: stepDraft } : s),
        },
      };
      persistDrafts(next);
    } else {
      const draft: PlaybookDraft = {
        version: bumpVersion(selected.version),
        summary: `Step ${stepNum} instructions edited`,
        steps: selected.steps.map(s => s.step === stepNum ? { ...s, description: stepDraft } : { ...s }),
      };
      persistDrafts({ ...draftOverrides, [selected.id]: draft });
      setViewMode('draft');
    }
    setEditingStep(null);
    window.dispatchEvent(new Event('dt-state-changed'));
  };

  // ── Eval modal (simulated) ──────────────────────────────────────

  const closeEval = () => {
    if (evalTimer.current) { clearInterval(evalTimer.current); evalTimer.current = null; }
    setEvalOpen(false);
    setEvalStep(0);
    setEvalDone(false);
  };

  const startEval = () => {
    if (evalTimer.current) clearInterval(evalTimer.current);
    setEvalOpen(true);
    setEvalStep(0);
    setEvalDone(false);
    let i = 0;
    evalTimer.current = setInterval(() => {
      i += 1;
      if (i >= scenarios.length) {
        if (evalTimer.current) { clearInterval(evalTimer.current); evalTimer.current = null; }
        setEvalStep(scenarios.length);
        setEvalDone(true);
      } else {
        setEvalStep(i);
      }
    }, 350);
  };

  const publishDraft = () => {
    if (!selected || !selectedDraft || !allPass) return;
    const oldVersion = selected.version;
    const newVersion = selectedDraft.version;
    const diff = stepsDiff(selected.steps, selectedDraft.steps);
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString().slice(0, 16).replace('T', ' ');

    // Promote draft → published
    const nextPublished = { ...publishedOverrides, [selected.id]: { version: newVersion, steps: selectedDraft.steps } };
    setPublishedOverrides(nextPublished);
    saveJson(publishedKey(activeCompanyId), nextPublished);
    persistDrafts({ ...draftOverrides, [selected.id]: null });

    // Version-history entry
    const entry: PlaybookVersionEntry = {
      version: newVersion, date: today, summary: selectedDraft.summary, changedBy: 'You (Ops)',
      evalResult: `${scenarios.length}/${scenarios.length} passed`, diff,
    };
    const nextHistory = { ...extraHistory, [selected.id]: [entry, ...(extraHistory[selected.id] ?? [])] };
    setExtraHistory(nextHistory);
    saveJson(historyKey(activeCompanyId), nextHistory);

    // Append the run to Proving Ground history (read live there)
    const runs = loadJson<unknown[]>(evalRunsKey(activeCompanyId), []);
    runs.unshift({
      id: `pbrun_${Date.now()}`,
      time: now,
      trigger: `Playbook publish — ${selected.title} ${oldVersion}→${newVersion}`,
      triggerType: 'Playbook publish',
      de: selected.des[0],
      result: `${scenarios.length}/${scenarios.length} passed`,
      duration: '2m 10s',
      outcome: 'deployed',
      note: 'Simulated run — design preview. Draft verified against playbook eval scenarios before publish.',
    });
    saveJson(evalRunsKey(activeCompanyId), runs);

    setViewMode('published');
    closeEval();
    window.dispatchEvent(new Event('dt-state-changed'));
    setToast(`${newVersion} published — appended to run history in Proving Ground`);
  };

  const evalProgress = scenarios.length > 0 ? Math.min(100, Math.round((evalStep / scenarios.length) * 100)) : 0;

  return (
    <div className="flex-1 overflow-auto bg-slate-900 p-6">
      <PageHeader
        title="Playbooks"
        subtitle={`${playbooks.length} playbooks · ${activeCount} active${draftCount > 0 ? ` · ${draftCount} draft${draftCount > 1 ? 's' : ''} pending` : ''} — the workflow library every Digital Employee executes from`}
      />
      <button onClick={() => setPage('intelligence_evals')} className="text-xs text-slate-500 -mt-4 mb-6 block">
        Playbook changes are versioned and eval-gated — a draft only publishes after its scenarios pass. <span className="text-indigo-400 hover:text-indigo-300">See Proving Ground →</span>
      </button>

      {!selected ? (
        <div className="rounded-2xl border border-slate-700 bg-slate-800/50 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-900/60">
              <tr>
                <th className={th}>Playbook</th>
                <th className={th}>Version</th>
                <th className={th}>Type</th>
                <th className={th}>Assigned DEs</th>
                <th className={th}>Trigger</th>
                <th className={th}>Last run</th>
                <th className={th}>Steps</th>
                <th className={th}>Active</th>
              </tr>
            </thead>
            <tbody>
              {playbooks.map(p => {
                const draft = getDraft(p.id);
                return (
                  <tr
                    key={p.id}
                    onClick={() => { setSelectedId(p.id); setViewMode('published'); setOpenDiff(null); }}
                    className="border-t border-slate-700/60 hover:bg-slate-700/30 cursor-pointer transition-colors"
                  >
                    <td className={`${td} text-slate-200 font-medium`}>{p.title}</td>
                    <td className={td}>
                      <span className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[10px] font-medium font-mono px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 whitespace-nowrap">{p.version} · published</span>
                        {draft && (
                          <span className="text-[10px] font-medium font-mono px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 whitespace-nowrap">Draft {draft.version} — unpublished</span>
                        )}
                      </span>
                    </td>
                    <td className={td}>{typeBadge(p.type)}</td>
                    <td className={`${td} text-xs text-slate-400`}>
                      <span className="flex items-center gap-1.5">
                        {p.des.map(de => (
                          <span key={de} className="w-5 h-5 rounded-full bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 text-[9px] font-semibold" title={de}>{de[0]}</span>
                        ))}
                        {p.des.join(' + ')}
                      </span>
                    </td>
                    <td className={`${td} text-xs text-slate-400`}>{p.trigger}</td>
                    <td className={`${td} text-xs text-slate-500`}>{p.lastRun}</td>
                    <td className={`${td} text-xs text-slate-400`}>{p.steps.length}{p.steps.some(s => s.humanGate) ? ' · human gate' : ''}</td>
                    <td className={td}><Toggle enabled={p.active} onChange={v => toggleActive(p.id, v)} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div>
          <button onClick={() => { setSelectedId(null); setEditingStep(null); setViewMode('published'); closeEval(); }} className="text-xs text-slate-400 hover:text-slate-200 mb-4 transition-colors">
            ← Back to library
          </button>

          <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-5 mb-5">
            <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
              <div className="flex items-center gap-3 flex-wrap">
                <h2 className="text-base font-semibold text-white">{selected.title}</h2>
                {typeBadge(selected.type)}
                <span className="text-[10px] font-medium font-mono px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">{selected.version} · published</span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${selected.active ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-600 text-slate-500'}`}>
                  {selected.active ? 'Active' : 'Paused'}
                </span>
              </div>
              <Toggle enabled={selected.active} onChange={v => toggleActive(selected.id, v)} />
            </div>
            <p className="text-sm text-slate-400 mb-3">{selected.objective}</p>
            <div className="flex items-center gap-5 text-xs text-slate-500 flex-wrap">
              <span>Trigger: <span className="text-slate-300">{selected.trigger}</span></span>
              <span>Last run: <span className="text-slate-300">{selected.lastRun}</span></span>
              <span>
                DEs:{' '}
                <button onClick={() => setPage('workforce_des')} className="text-indigo-400 hover:text-indigo-300 transition-colors">
                  {selected.des.join(' + ')} →
                </button>
              </span>
            </div>
          </div>

          {/* Version switcher */}
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <button
              onClick={() => { setViewMode('published'); setEditingStep(null); }}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${!viewingDraft ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}
            >
              Published {selected.version}
            </button>
            {selectedDraft && (
              <button
                onClick={() => { setViewMode('draft'); setEditingStep(null); }}
                className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${viewingDraft ? 'bg-amber-500/15 border-amber-500/40 text-amber-300' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}
              >
                Draft {selectedDraft.version}
              </button>
            )}
            {!selectedDraft && (
              <span className="text-[11px] text-slate-600">No draft — editing a step forks {bumpVersion(selected.version)} automatically; the published version stays live.</span>
            )}
            {viewingDraft && selectedDraft && (
              <button
                onClick={startEval}
                className="ml-auto text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors"
              >
                ▶ Run evals &amp; publish {selectedDraft.version}
              </button>
            )}
          </div>

          {/* Draft banner */}
          {viewingDraft && selectedDraft && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 mb-4">
              <p className="text-xs font-medium text-amber-400 mb-1">Editing draft {selectedDraft.version} — published {selected.version} unchanged</p>
              <p className="text-[11px] text-slate-400">
                Change summary: {selectedDraft.summary}. This draft is not live — DEs keep executing {selected.version} until the draft passes its eval scenarios in the Proving Ground and is published.
              </p>
            </div>
          )}

          {/* Step list */}
          <div className="space-y-2">
            {viewSteps.map(s => (
              <div key={s.step} className={`rounded-xl border p-4 ${s.humanGate ? 'border-amber-500/30 bg-amber-500/5' : 'border-slate-700 bg-slate-800'}`}>
                <div className="flex items-start gap-3">
                  <span className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0 ${s.humanGate ? 'bg-amber-500/20 text-amber-400' : 'bg-slate-700 text-slate-400'}`}>
                    {s.step}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="text-sm font-medium text-white">{s.title}</span>
                      {s.humanGate && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-700/30">Human Gate</span>}
                    </div>
                    {editingStep === s.step ? (
                      <div className="flex flex-col gap-2 mt-1">
                        <textarea
                          autoFocus rows={2} value={stepDraft} onChange={e => setStepDraft(e.target.value)}
                          className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-slate-600 resize-none"
                        />
                        <div className="flex items-center gap-2 flex-wrap">
                          <button onClick={() => saveStep(s.step)} className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs px-3 py-1.5 rounded-lg">
                            {viewingDraft ? 'Save to draft' : `Save as draft ${bumpVersion(selected.version)}`}
                          </button>
                          <button onClick={() => setEditingStep(null)} className="text-slate-400 hover:text-slate-200 text-xs">Cancel</button>
                          {!viewingDraft && <span className="text-[10px] text-slate-500">Published {selected.version} stays unchanged — the edit forks a draft.</span>}
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setEditingStep(s.step); setStepDraft(s.description); }}
                        className="text-left text-xs text-slate-400 hover:text-slate-200 transition-colors leading-relaxed"
                        title="Click to edit step"
                      >
                        {s.description}
                      </button>
                    )}
                  </div>
                  <span className={`text-[11px] px-2 py-1 rounded-lg flex-shrink-0 ${s.owner.includes('(human)') ? 'bg-amber-500/10 text-amber-300' : 'bg-indigo-500/10 text-indigo-300'}`}>
                    {s.owner}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* Version history — mirrors the CompliancePage diff pattern */}
          <div className="rounded-2xl border border-slate-700 bg-slate-800/50 overflow-hidden mt-6">
            <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between flex-wrap gap-2">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Version History — {selected.title}</p>
              <button onClick={() => setPage('intelligence_evals')} className="text-xs text-slate-500">
                Every published version passed its eval scenarios — <span className="text-indigo-400 hover:text-indigo-300">see Proving Ground →</span>
              </button>
            </div>
            {getHistory(selected.id).length === 0 ? (
              <p className="px-5 py-4 text-xs text-slate-500">No recorded versions yet — the next publish creates the first history entry.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700">
                    <th className={th}>Version</th>
                    <th className={th}>Date</th>
                    <th className={th}>Change summary</th>
                    <th className={th}>Changed by</th>
                    <th className={th}>Eval result</th>
                    <th className={th}></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/50">
                  {getHistory(selected.id).map(v => {
                    const key = `${v.version}-${v.date}`;
                    const open = openDiff === key;
                    return (
                      <React.Fragment key={key}>
                        <tr className="hover:bg-slate-700/20 transition-colors">
                          <td className={`${td} text-indigo-400 font-mono text-xs`}>{v.version}</td>
                          <td className={`${td} text-slate-500 text-xs`}>{v.date}</td>
                          <td className={`${td} text-slate-200 text-xs`}>{v.summary}</td>
                          <td className={`${td} text-slate-400 text-xs`}>{v.changedBy}</td>
                          <td className={`${td} text-xs`}>
                            <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 whitespace-nowrap">✓ {v.evalResult}</span>
                          </td>
                          <td className={`${td} text-right`}>
                            <button
                              onClick={() => setOpenDiff(open ? null : key)}
                              className={`text-xs px-2 py-1 rounded-lg border transition-colors ${open ? 'border-indigo-500 text-indigo-300' : 'border-slate-600 text-slate-400 hover:text-white hover:border-slate-500'}`}>
                              {open ? 'Hide diff' : 'Diff'}
                            </button>
                          </td>
                        </tr>
                        {open && (
                          <tr>
                            <td colSpan={6} className="px-5 py-3 bg-slate-900/60">
                              <div className="font-mono text-xs space-y-1">
                                {v.diff.removed.map((line, i) => (
                                  <div key={`r${i}`} className="text-red-400/90 bg-red-500/5 rounded px-2 py-1">− {line}</div>
                                ))}
                                {v.diff.added.map((line, i) => (
                                  <div key={`a${i}`} className="text-emerald-400/90 bg-emerald-500/5 rounded px-2 py-1">+ {line}</div>
                                ))}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ── Eval & publish modal (simulated) ─────────────────────── */}
      {evalOpen && selected && selectedDraft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={closeEval}>
          <div className="w-full max-w-lg rounded-2xl border border-slate-600 bg-slate-800 p-5 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 mb-1">
              <h3 className="text-sm font-semibold text-white">Eval gate — {selected.title} {selectedDraft.version}</h3>
              <button onClick={closeEval} className="text-slate-500 hover:text-slate-300 text-sm">✕</button>
            </div>
            <p className="text-[10px] uppercase tracking-wider text-indigo-400 mb-3">Simulated run — design preview</p>

            <div className="w-full bg-slate-700 rounded-full h-1.5 mb-3">
              <div className="h-1.5 rounded-full bg-indigo-500 transition-all duration-300" style={{ width: `${evalProgress}%` }} />
            </div>

            <div className="space-y-1.5 mb-4">
              {scenarios.map((sc, i) => {
                const reached = evalDone || i < evalStep;
                const running = !evalDone && i === evalStep;
                return (
                  <div key={sc.name} className={`flex items-start gap-2 text-xs rounded-lg px-2 py-1.5 ${reached && !sc.pass ? 'bg-red-500/5' : ''}`}>
                    <span className={`flex-shrink-0 ${reached ? (sc.pass ? 'text-emerald-400' : 'text-red-400') : running ? 'text-indigo-400' : 'text-slate-600'}`}>
                      {reached ? (sc.pass ? '✓' : '✗') : running ? '▶' : '·'}
                    </span>
                    <div className="min-w-0">
                      <span className={reached ? 'text-slate-300' : running ? 'text-slate-200' : 'text-slate-600'}>{sc.name}</span>
                      {reached && !sc.pass && sc.failNote && (
                        <p className="text-[11px] text-red-300/90 mt-0.5">{sc.failNote}</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {evalDone && (
              <div className={`rounded-xl border p-3 mb-4 ${allPass ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-red-500/30 bg-red-500/5'}`}>
                <p className={`text-sm font-semibold ${allPass ? 'text-emerald-400' : 'text-red-400'}`}>
                  {passCount}/{scenarios.length} scenarios passed {allPass ? '— gate open' : `— ${failing.length} failing`}
                </p>
                {allPass ? (
                  <p className="text-[11px] text-slate-400 mt-1">All playbook eval scenarios passed — {selectedDraft.version} is cleared to publish. The run will be appended to Proving Ground history.</p>
                ) : (
                  <p className="text-[11px] text-red-300/90 mt-1">Publishing blocked — resolve the failing scenario. The published {selected.version} stays live; this draft cannot ship until the scenario passes.</p>
                )}
                <p className="text-[10px] text-slate-600 mt-2">This is a scripted simulation landing on seeded results — no model was executed.</p>
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <button onClick={closeEval} className="text-xs px-3 py-1.5 rounded-lg border border-slate-600 text-slate-400 hover:text-slate-200 transition-colors">Close</button>
              <button
                onClick={publishDraft}
                disabled={!evalDone || !allPass}
                className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium transition-colors"
              >
                Publish {selectedDraft.version}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-slate-700 border border-emerald-500/40 text-sm text-slate-100 rounded-xl px-4 py-3 shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
