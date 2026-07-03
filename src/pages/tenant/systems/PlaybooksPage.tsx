import React, { useState, useEffect } from 'react';
import { useAuth } from '../../../context/AuthContext';
import { PageHeader, th, td } from '../../../components/ui';
import type { Page } from '../../../types';
import type { CompanyId } from '../../../data/companies';

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
  objective: string;
  steps: PlaybookStep[];
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

// ── Seed playbooks (assignments match WorkforceDEsPage DE profiles) ─

const TCP_PLAYBOOKS: Playbook[] = [
  {
    id: 'renewal_lifecycle', title: 'Renewal Lifecycle Playbook', type: 'process', des: ['Casey'],
    trigger: 'Scheduled — 45 days before renewal date', lastRun: '2 hrs ago', active: true,
    objective: 'End-to-end renewal management: detect upcoming renewals, generate invoices in Zuora, send email cadence, and confirm payment.',
    steps: RENEWAL_STEPS,
  },
  {
    id: 'inbound_support', title: 'Inbound Support Resolution', type: 'process', des: ['Alex'],
    trigger: 'Event — new Zendesk ticket', lastRun: '4 min ago', active: true,
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
    trigger: 'Event — ticket tagged auth/2FA/SSO', lastRun: '2 hrs ago', active: true,
    objective: 'Fast-path playbook for authentication, 2FA reset, and SSO configuration issues.',
    steps: [
      { step: 1, title: 'Verify Identity', description: 'Confirm requester identity per security SOP before any account change.', owner: 'Alex', humanGate: false },
      { step: 2, title: 'Apply Standard Fix', description: '2FA reset, session revoke, or SSO metadata refresh per runbook.', owner: 'Alex', humanGate: false },
      { step: 3, title: 'Security Review for Admin Accounts', description: 'Changes to admin-level accounts require human security sign-off.', owner: 'Security (human)', humanGate: true },
    ],
  },
  {
    id: 'critical_outage', title: 'Critical Outage Response', type: 'crisis', des: ['Alex'],
    trigger: 'Event — status page incident opened', lastRun: '12 days ago', active: true,
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
    trigger: 'Threshold — confidence below 55%', lastRun: '23 min ago', active: true,
    objective: 'Package full context and route unresolvable tickets to L2 Engineering.',
    steps: [
      { step: 1, title: 'Compile Context Bundle', description: 'Ticket history, reproduction steps, environment, and attempted fixes.', owner: 'Alex', humanGate: false },
      { step: 2, title: 'Create Linked Jira Issue', description: 'Open ENG issue with the context bundle attached.', owner: 'Alex', humanGate: false },
      { step: 3, title: 'L2 Triage', description: 'Engineering triages within the 2-day escalation SLA.', owner: 'L2 Engineering (human)', humanGate: true },
    ],
  },
  {
    id: 'weekly_digest', title: 'Weekly Support Digest', type: 'scheduled', des: ['Alex'],
    trigger: 'Scheduled — Fridays 16:00', lastRun: '6 days ago', active: false,
    objective: 'Summarize ticket volume, topics, and KB gaps for the support leadership team.',
    steps: [
      { step: 1, title: 'Aggregate Week Metrics', description: 'Volume, resolution rate, escalations, top topics.', owner: 'Alex', humanGate: false },
      { step: 2, title: 'Send Digest', description: 'Email digest to support leadership distribution list.', owner: 'Alex', humanGate: false },
    ],
  },
  {
    id: 'at_risk_response', title: 'At-Risk Renewal Response', type: 'response', des: ['Casey'],
    trigger: 'Event — Gainsight health score drops below 50', lastRun: '1 day ago', active: true,
    objective: 'Immediate response cadence when an account turns at-risk inside the renewal window.',
    steps: [
      { step: 1, title: 'Pull Risk Signals', description: 'Usage decline, support volume, NPS, and outstanding invoices.', owner: 'Casey', humanGate: false },
      { step: 2, title: 'Draft Save Offer', description: 'Propose retention offer within template discount limits (max 20% without VP approval).', owner: 'Casey', humanGate: false },
      { step: 3, title: 'AE Approval', description: 'Account Executive approves the save offer before it is sent.', owner: 'Account Executive (human)', humanGate: true },
    ],
  },
  {
    id: 'at_risk_save', title: 'At-Risk Account Save', type: 'cross_function', des: ['Casey', 'Alex'],
    trigger: 'Event — at-risk flag on account with open P1 ticket', lastRun: '2 days ago', active: true,
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
    trigger: 'Scheduled — daily 09:00', lastRun: '5 hrs ago', active: true,
    objective: 'Send day-0 / day-7 / day-14 renewal emails per account renewal stage.',
    steps: [
      { step: 1, title: 'Scan Renewal Pipeline', description: 'Find accounts due a cadence touch today.', owner: 'Casey', humanGate: false },
      { step: 2, title: 'Send Stage Email', description: 'Send the appropriate cadence template via Gainsight.', owner: 'Casey', humanGate: false },
    ],
  },
  {
    id: 'churn_prevention', title: 'Churn Prevention Escalation', type: 'escalation', des: ['Casey'],
    trigger: 'Event — renewal declined or no response by day 21', lastRun: '3 days ago', active: true,
    objective: 'Escalate stalled renewals to the account team before the contract lapses.',
    steps: [
      { step: 1, title: 'Flag Stalled Renewal', description: 'Mark renewal at-risk in Gainsight with full timeline.', owner: 'Casey', humanGate: false },
      { step: 2, title: 'AE Takeover', description: 'Account Executive takes over the commercial conversation.', owner: 'Account Executive (human)', humanGate: true },
    ],
  },
  {
    id: 'new_hire_onboarding', title: 'New Hire Onboarding Flow', type: 'process', des: ['Riley'],
    trigger: 'Event — offer accepted in Greenhouse', lastRun: '1 day ago', active: true,
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
    trigger: 'Event — employee HR question received', lastRun: '3 hrs ago', active: true,
    objective: 'Answer policy and benefits questions from the HR knowledge base with strict PII handling.',
    steps: [
      { step: 1, title: 'Policy Lookup', description: 'Search HR policies and benefits handbook.', owner: 'Riley', humanGate: false },
      { step: 2, title: 'Respond or Route', description: 'Answer if confidence ≥ 70%; sensitive topics route to HRBP.', owner: 'Riley', humanGate: false },
      { step: 3, title: 'HRBP Review for Sensitive Topics', description: 'Compensation, visa, and disciplinary questions require a human.', owner: 'HRBP (human)', humanGate: true },
    ],
  },
  {
    id: 'headcount_report', title: 'Monthly Headcount Report', type: 'scheduled', des: ['Riley'],
    trigger: 'Scheduled — 1st of month 08:00', lastRun: '2 days ago', active: true,
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
    trigger: 'Event — new engagement signed', lastRun: '1 day ago', active: true,
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
    trigger: 'Event — client document received', lastRun: '5 hrs ago', active: true,
    objective: 'Verify client identity documents and screen against sanctions lists.',
    steps: [
      { step: 1, title: 'Document Verification', description: 'Validate identity documents and beneficial ownership.', owner: 'Morgan', humanGate: false },
      { step: 2, title: 'Sanctions Screening', description: 'Screen entities against sanctions and PEP lists.', owner: 'Morgan', humanGate: false },
      { step: 3, title: 'Risk & Compliance Review on Hits', description: 'Any screening hit is escalated to Risk & Compliance.', owner: 'Risk & Compliance (human)', humanGate: true },
    ],
  },
  {
    id: 'gdpr_handling', title: 'GDPR Request Handling', type: 'escalation', des: ['Morgan'],
    trigger: 'Event — data-subject request received', lastRun: '2 hrs ago', active: true,
    objective: 'Track statutory deadlines on data-subject requests and escalate before breach.',
    steps: [
      { step: 1, title: 'Log & Classify Request', description: 'Record the request and start the 30-day statutory clock.', owner: 'Morgan', humanGate: false },
      { step: 2, title: 'Compile Data Export', description: 'Gather responsive records across systems.', owner: 'Morgan', humanGate: false },
      { step: 3, title: 'Legal Review & Release', description: 'Legal reviews and approves the response before release.', owner: 'Legal (human)', humanGate: true },
    ],
  },
  {
    id: 'quarterly_review', title: 'Quarterly Client Review', type: 'scheduled', des: ['Morgan'],
    trigger: 'Scheduled — quarterly', lastRun: '18 days ago', active: true,
    objective: 'Prepare quarterly relationship review packs for each active client.',
    steps: [
      { step: 1, title: 'Compile Engagement Metrics', description: 'Fees, delivery status, satisfaction signals per client.', owner: 'Morgan', humanGate: false },
      { step: 2, title: 'Partner Review', description: 'Engagement partner reviews the pack before the client meeting.', owner: 'Partner (human)', humanGate: true },
    ],
  },
  {
    id: 'tax_research_flow', title: 'Tax Research Request Flow', type: 'process', des: ['Avery'],
    trigger: 'Event — research request from engagement team', lastRun: '3 hrs ago', active: true,
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
    trigger: 'Event — new ruling matches watched topic', lastRun: '2 days ago', active: true,
    objective: 'Assess new rulings and notify affected engagement teams.',
    steps: [
      { step: 1, title: 'Assess Impact', description: 'Determine which clients and open positions are affected.', owner: 'Avery', humanGate: false },
      { step: 2, title: 'Draft Impact Summary', description: 'Summarize the change and recommended actions.', owner: 'Avery', humanGate: false },
      { step: 3, title: 'Senior Tax Manager Sign-off', description: 'Summary reviewed before distribution to engagement teams.', owner: 'Senior Tax Manager (human)', humanGate: true },
    ],
  },
];

const PLAYBOOKS: Record<CompanyId, Playbook[]> = { tcp: TCP_PLAYBOOKS, pwc: PWC_PLAYBOOKS };

// ── Helpers ───────────────────────────────────────────────────────

// Type badges — same palette as WorkforceDEsPage TabPlaybooks
function typeBadge(type: PlaybookType) {
  const styles: Record<PlaybookType, string> = {
    process: 'bg-blue-500/20 text-blue-400',
    response: 'bg-indigo-500/20 text-indigo-400',
    escalation: 'bg-red-500/20 text-red-400',
    cross_function: 'bg-purple-500/20 text-purple-400',
    crisis: 'bg-red-500/20 text-red-400',
    scheduled: 'bg-slate-700 text-slate-400',
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
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${enabled ? 'bg-indigo-600' : 'bg-slate-700'}`}
    >
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : 'translate-x-1'}`} />
    </button>
  );
}

// ── Page ──────────────────────────────────────────────────────────

export default function PlaybooksPage({ setPage }: { setPage: (p: Page) => void }) {
  const { activeCompanyId } = useAuth();
  const seed = PLAYBOOKS[activeCompanyId];
  const [playbooks, setPlaybooks] = useState(seed.map(p => ({ ...p })));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingStep, setEditingStep] = useState<number | null>(null);
  const [stepDraft, setStepDraft] = useState('');

  useEffect(() => {
    setPlaybooks(PLAYBOOKS[activeCompanyId].map(p => ({ ...p, steps: p.steps.map(s => ({ ...s })) })));
    setSelectedId(null);
    setEditingStep(null);
  }, [activeCompanyId]);

  const selected = playbooks.find(p => p.id === selectedId) ?? null;
  const activeCount = playbooks.filter(p => p.active).length;

  const toggleActive = (id: string, v: boolean) =>
    setPlaybooks(prev => prev.map(p => p.id === id ? { ...p, active: v } : p));

  const saveStep = (stepNum: number) => {
    if (!selected) return;
    setPlaybooks(prev => prev.map(p => p.id === selected.id
      ? { ...p, steps: p.steps.map(s => s.step === stepNum ? { ...s, description: stepDraft } : s) }
      : p));
    setEditingStep(null);
  };

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageHeader
        title="Playbooks"
        subtitle={`${playbooks.length} playbooks · ${activeCount} active — the workflow library every Digital Employee executes from`}
      />

      {!selected ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/50 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-950/60">
              <tr>
                <th className={th}>Playbook</th>
                <th className={th}>Type</th>
                <th className={th}>Assigned DEs</th>
                <th className={th}>Trigger</th>
                <th className={th}>Last run</th>
                <th className={th}>Steps</th>
                <th className={th}>Active</th>
              </tr>
            </thead>
            <tbody>
              {playbooks.map(p => (
                <tr
                  key={p.id}
                  onClick={() => setSelectedId(p.id)}
                  className="border-t border-slate-800/60 hover:bg-slate-800/30 cursor-pointer transition-colors"
                >
                  <td className={`${td} text-slate-200 font-medium`}>{p.title}</td>
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
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div>
          <button onClick={() => { setSelectedId(null); setEditingStep(null); }} className="text-xs text-slate-400 hover:text-slate-200 mb-4 transition-colors">
            ← Back to library
          </button>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 mb-5">
            <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
              <div className="flex items-center gap-3 flex-wrap">
                <h2 className="text-base font-semibold text-white">{selected.title}</h2>
                {typeBadge(selected.type)}
                <span className={`text-xs px-2 py-0.5 rounded-full ${selected.active ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-700 text-slate-500'}`}>
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

          {/* Step list */}
          <div className="space-y-2">
            {selected.steps.map(s => (
              <div key={s.step} className={`rounded-xl border p-4 ${s.humanGate ? 'border-amber-500/30 bg-amber-500/5' : 'border-slate-800 bg-slate-900'}`}>
                <div className="flex items-start gap-3">
                  <span className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0 ${s.humanGate ? 'bg-amber-500/20 text-amber-400' : 'bg-slate-800 text-slate-400'}`}>
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
                          className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-slate-600 resize-none"
                        />
                        <div className="flex gap-2">
                          <button onClick={() => saveStep(s.step)} className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs px-3 py-1.5 rounded-lg">Save</button>
                          <button onClick={() => setEditingStep(null)} className="text-slate-400 hover:text-slate-200 text-xs">Cancel</button>
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
        </div>
      )}
    </div>
  );
}
