import React, { useEffect, useState } from 'react';
import { useAuth } from '../../../context/AuthContext';
import { COMPANY_SUMMARY } from '../../../data/companies';
import type { CompanyId } from '../../../data/companies';
import { PageHeader, th, td } from '../../../components/ui';
import type { KEntity, KAudience, KType } from './KnowledgeLibraryPage';
import type { Page } from '../../../types';
import { useDataMode } from '../../../lib/dataMode';
import { CustomerApiError } from '../../../lib/customerApi';
import { LiveLoadingSkeleton, MissingTablesNotice, LiveEmptyState } from '../../../components/LiveDataStates';
import {
  listKnowledgeGapClusters, listKnowledgeGapPolicies, getKnowledgeGapClusterDetail,
  listKnowledgeRevisionRequests, resolveKnowledgeRevision,
} from '../../../lib/knowledgeApi';
import type { KnowledgeGapCluster, KnowledgeGapPolicy, KnowledgeGapClusterMember, KnowledgeRevisionRequest } from '../../../lib/knowledgeApi';
import { listDigitalEmployees } from '../../../lib/digitalEmployeesApi';
import type { DigitalEmployee } from '../../../lib/digitalEmployeesApi';
import { supabase } from '../../../supabase';

// ============================================================
// Gap Detection — THE FLAGSHIP PAGE. The self-healing loop:
// DE query misses / escalations → gap signal → Resolution Agent
// searches historical resolutions → Knowledge Drafting Agent
// proposes an article → human approves → DEs auto-retrain.
// Open-gap counts MUST match companies.ts (TCP 5 / PWC 3).
// "Webhook retry logic" (23 queries) reuses the exact wording
// from the dashboard activity feed.
// ============================================================

type GapStatus = 'detected' | 'investigating' | 'draft_ready' | 'approved' | 'retrained';
type SignalSource = 'DE query miss' | 'Human escalation' | 'Low-confidence answer';

interface GapSignal { time: string; text: string }
interface GapFinding { ref: string; title: string; note: string }
interface GapDraft {
  title: string;
  paragraphs: string[];
  entity: KEntity;
  audience: KAudience;
  type: KType;
  confidence: number;
  sources: string[];
}

interface Gap {
  id: string;
  title: string;
  source: SignalSource;
  description: string;
  frequency: string;
  de: string;
  severity: 'high' | 'medium' | 'low';
  status: GapStatus;
  signals: GapSignal[];
  searched: number;
  findings: GapFinding[];
  draft?: GapDraft;
  retrainedNote?: string;
}

const TCP_GAPS: Gap[] = [
  {
    id: 'g1', title: 'Webhook retry logic', source: 'DE query miss',
    description: 'Customers asking how failed webhook deliveries are retried — no article covers retry intervals, backoff, or the dead-letter queue.',
    frequency: '23 queries in 14 days', de: 'Alex', severity: 'high', status: 'draft_ready',
    signals: [
      { time: '2026-07-02 09:00', text: 'Alex query miss: "How many times does the platform retry a failed webhook?"' },
      { time: '2026-06-29 15:41', text: 'Alex low-confidence answer (54%) on webhook redelivery — escalated to L2' },
      { time: '2026-06-25 11:20', text: 'Ticket #4712 escalated: customer webhook endpoint down 3 hrs, asked about replay' },
      { time: '2026-06-21 10:05', text: 'Alex query miss: "Is there a dead-letter queue for undelivered webhooks?"' },
    ],
    searched: 1240,
    findings: [
      { ref: 'Ticket #3981', title: 'Webhook redelivery after endpoint outage', note: 'L2 engineer documented the 5-attempt exponential backoff (1m/5m/30m/2h/12h)' },
      { ref: 'Ticket #4102', title: 'Missing events after 24h downtime', note: 'Resolution confirmed the 72h dead-letter retention window' },
      { ref: 'Jira ENG-2214', title: 'Webhook retry policy spec', note: 'Engineering design doc with the authoritative retry table' },
      { ref: 'Slack #support-eng', title: 'Retry FAQ thread (Mar 2026)', note: 'Senior support summarized replay-from-dashboard steps' },
    ],
    draft: {
      title: 'Webhook delivery retries, backoff, and replay',
      paragraphs: [
        'When a webhook delivery fails (non-2xx response or a 10-second timeout), the platform automatically retries up to 5 times with exponential backoff: 1 minute, 5 minutes, 30 minutes, 2 hours, and 12 hours after the original attempt. Each retry includes the same event payload and an X-Delivery-Attempt header so receiving systems can deduplicate.',
        'After the fifth failed attempt, the event moves to a dead-letter queue where it is retained for 72 hours. During that window, administrators can replay individual events or the entire queue from Settings → Webhooks → Failed deliveries. Replayed events preserve their original event ID and timestamp.',
        'If an endpoint fails continuously for 24 hours, the subscription is automatically paused and the account owner is notified by email. Re-enabling the endpoint from the dashboard triggers an automatic replay of all dead-lettered events that are still within retention.',
      ],
      entity: 'Customer', audience: 'Customer DEs', type: 'Procedural', confidence: 87,
      sources: ['Ticket #3981', 'Ticket #4102', 'Jira ENG-2214', 'Slack #support-eng thread'],
    },
  },
  {
    id: 'g2', title: 'SSO SAML edge cases', source: 'Human escalation',
    description: 'Escalations around SAML assertion clock skew, multi-IdP setups, and attribute mapping failures not covered by the current SSO guide.',
    frequency: '11 queries in 14 days', de: 'Alex', severity: 'medium', status: 'investigating',
    signals: [
      { time: '2026-07-01 16:22', text: 'Escalation: enterprise customer SAML login loop — clock skew >5 min' },
      { time: '2026-06-27 09:48', text: 'Alex query miss: "Can one tenant use two identity providers at once?"' },
      { time: '2026-06-24 14:03', text: 'Low-confidence answer (61%) on custom attribute mapping — flagged for review' },
    ],
    searched: 1240,
    findings: [
      { ref: 'Ticket #4455', title: 'SAML clock skew resolution', note: 'Fixed by widening tolerance to 5 min; workaround documented in ticket only' },
      { ref: 'Ticket #4519', title: 'Dual IdP configuration', note: 'Solutions engineer built a working config — never written up' },
    ],
  },
  {
    id: 'g3', title: 'Multi-currency invoicing', source: 'DE query miss',
    description: 'Casey cannot answer how renewals are invoiced when the contract currency differs from the billing entity currency.',
    frequency: '7 queries in 14 days', de: 'Casey', severity: 'medium', status: 'detected',
    signals: [
      { time: '2026-06-30 10:15', text: 'Casey query miss: "Invoice a EUR contract from the US billing entity?"' },
      { time: '2026-06-26 13:40', text: 'Casey query miss: "Which FX rate date applies to renewal invoices?"' },
      { time: '2026-06-20 09:30', text: 'Renewal escalated to Finance — currency mismatch on Meridian Group invoice' },
    ],
    searched: 0,
    findings: [],
  },
  {
    id: 'g4', title: 'Contractor onboarding steps', source: 'Human escalation',
    description: 'Riley\'s onboarding templates cover employees only — contractor flow (no benefits, different provisioning) is undocumented.',
    frequency: '5 queries in 14 days', de: 'Riley', severity: 'low', status: 'detected',
    signals: [
      { time: '2026-06-28 11:00', text: 'HR escalation: contractor onboarded with full-employee checklist by mistake' },
      { time: '2026-06-23 15:20', text: 'Riley query miss: "Do contractors get benefits enrollment links?"' },
      { time: '2026-06-18 10:45', text: 'Riley query miss: "Contractor laptop provisioning — same as FTE?"' },
    ],
    searched: 0,
    findings: [],
  },
  {
    id: 'g5', title: 'API rate limit tiers after upgrade', source: 'Low-confidence answer',
    description: 'The rate limiting guide predates the June plan restructure — Alex answers with stale per-tier limits.',
    frequency: '9 queries in 14 days', de: 'Alex', severity: 'high', status: 'draft_ready',
    signals: [
      { time: '2026-07-02 14:12', text: 'Alex low-confidence answer (58%): quoted pre-June Enterprise limits' },
      { time: '2026-06-28 16:35', text: 'Customer disputed rate limit figure from Alex — escalated to support lead' },
      { time: '2026-06-24 09:55', text: 'Alex query miss: "What are burst limits on the new Growth tier?"' },
    ],
    searched: 1240,
    findings: [
      { ref: 'Jira ENG-2380', title: 'June 2026 rate limit restructure', note: 'Authoritative new per-tier table (Starter 60/min, Growth 300/min, Enterprise 1,200/min)' },
      { ref: 'Ticket #4688', title: 'Enterprise burst limit clarification', note: 'Engineering confirmed 2× burst for 60 seconds on all tiers' },
      { ref: 'Confluence RFC-88', title: 'Rate limit headers spec', note: 'X-RateLimit-* header semantics documented' },
    ],
    draft: {
      title: 'API rate limits by plan tier (June 2026 update)',
      paragraphs: [
        'Following the June 2026 plan restructure, API rate limits are enforced per workspace as follows: Starter — 60 requests/minute, Growth — 300 requests/minute, Enterprise — 1,200 requests/minute. Limits apply across all API keys in a workspace combined, not per key.',
        'All tiers support a burst allowance of 2× the sustained limit for up to 60 seconds, after which requests receive HTTP 429 with a Retry-After header. Current usage is exposed on every response via X-RateLimit-Limit, X-RateLimit-Remaining, and X-RateLimit-Reset headers.',
        'Customers upgrading mid-cycle receive the new tier\'s limits within 5 minutes of the plan change taking effect. Webhook deliveries and bulk export jobs are governed by separate quotas and do not count against the request-per-minute limit.',
      ],
      entity: 'Customer', audience: 'Customer DEs', type: 'Reference', confidence: 91,
      sources: ['Jira ENG-2380', 'Ticket #4688', 'Confluence RFC-88'],
    },
  },
  {
    id: 'g6', title: 'Billing address change mid-cycle', source: 'DE query miss',
    description: 'How tax recalculation works when a customer changes billing address mid-subscription — resolved and retrained.',
    frequency: '12 queries in 30 days', de: 'Alex', severity: 'medium', status: 'retrained',
    signals: [
      { time: '2026-06-05 10:20', text: 'Alex query miss: "Does changing billing address re-trigger tax calculation?"' },
      { time: '2026-06-02 14:10', text: 'Ticket #4390 escalated: sales tax mismatch after address change' },
    ],
    searched: 1180,
    findings: [
      { ref: 'Ticket #4390', title: 'Tax recalculation on address change', note: 'Finance documented the proration + recalculation flow' },
    ],
    draft: {
      title: 'Tax recalculation when the billing address changes',
      paragraphs: [
        'When a billing address changes mid-cycle, tax is recalculated on the next invoice — not retroactively. The new jurisdiction\'s rates apply from the effective date of the change, prorated by day for the remainder of the billing period.',
        'For annual plans, no interim invoice is issued; the adjustment appears as a line item on the renewal invoice. Customers can request an interim true-up invoice through support if required by their procurement process.',
      ],
      entity: 'Customer', audience: 'Customer DEs', type: 'Reference', confidence: 93,
      sources: ['Ticket #4390'],
    },
    retrainedNote: 'Retrained: Alex ✓ 2026-07-01',
  },
];

const PWC_GAPS: Gap[] = [
  {
    id: 'g1', title: 'FATCA filing for dual-nationals', source: 'DE query miss',
    description: 'Avery repeatedly misses on FATCA reporting obligations for dual-national clients — thresholds, treaty tie-breakers, and Form 8938 vs. FBAR overlap.',
    frequency: '14 queries in 21 days', de: 'Avery', severity: 'high', status: 'draft_ready',
    signals: [
      { time: '2026-07-03 09:00', text: 'Avery research task — FATCA dual-national issue, KB gap logged' },
      { time: '2026-06-28 14:30', text: 'Avery query miss: "Form 8938 threshold for dual-nationals residing abroad?"' },
      { time: '2026-06-22 11:15', text: 'Partner escalation: dual-national client filing position needed same-day' },
      { time: '2026-06-17 10:00', text: 'Avery low-confidence answer (62%) on treaty tie-breaker interaction with FATCA' },
    ],
    searched: 2380,
    findings: [
      { ref: 'Memo TM-2024-118', title: 'FATCA obligations — US/UK dual citizens', note: 'Partner-reviewed memo covering the residence tie-breaker analysis' },
      { ref: 'Memo TM-2025-042', title: 'Form 8938 vs. FBAR filing matrix', note: 'Threshold comparison table for individuals abroad' },
      { ref: 'Engagement #E-1893', title: 'Dual-national voluntary disclosure', note: 'Full resolution file incl. IRS correspondence' },
      { ref: 'IRS Notice 2026-14', title: 'Digital asset reporting update', note: 'Extends FATCA specified-asset definitions' },
    ],
    draft: {
      title: 'FATCA reporting for dual-national clients: thresholds and treaty interaction',
      paragraphs: [
        'Dual-national clients who are US persons remain subject to FATCA reporting regardless of their second citizenship. For individuals residing abroad, Form 8938 filing thresholds are elevated: $200,000 in specified foreign financial assets on the last day of the tax year, or $300,000 at any point during the year ($400,000/$600,000 for married filing jointly).',
        'A treaty residence tie-breaker under Article 4 does not eliminate FATCA obligations. Even where a client is treated as a resident of the treaty partner for income tax purposes, Form 8938 and FBAR obligations continue to apply as long as the client remains a US citizen. The FBAR (FinCEN 114) threshold remains $10,000 aggregate across foreign accounts, with no elevation for residence abroad.',
        'Where prior-year filings were missed, evaluate eligibility for the Streamlined Foreign Offshore Procedures before any quiet disclosure. See Engagement #E-1893 for a worked resolution including penalty abatement correspondence. All client-specific positions require partner review before delivery.',
      ],
      entity: 'Customer', audience: 'Specialist DEs', type: 'Regulatory', confidence: 89,
      sources: ['Memo TM-2024-118', 'Memo TM-2025-042', 'Engagement #E-1893', 'IRS Notice 2026-14'],
    },
  },
  {
    id: 'g2', title: 'Crypto asset audit methodology', source: 'Human escalation',
    description: 'No methodology guidance for auditing crypto asset holdings — existence testing, valuation sources, and custody verification.',
    frequency: '6 queries in 21 days', de: 'Avery', severity: 'medium', status: 'investigating',
    signals: [
      { time: '2026-06-30 15:00', text: 'Audit senior escalation: client holds BTC treasury — no testing methodology on file' },
      { time: '2026-06-25 10:40', text: 'Avery query miss: "Acceptable pricing sources for year-end crypto valuation?"' },
      { time: '2026-06-19 13:25', text: 'Avery query miss: "On-chain confirmation as audit evidence of existence?"' },
    ],
    searched: 2380,
    findings: [
      { ref: 'Engagement #E-2011', title: 'Fintech client digital asset audit', note: 'Team improvised procedures — workpapers usable as a template' },
      { ref: 'AICPA PA guide (external)', title: 'Digital assets practice aid', note: 'Referenced but never internalized into methodology' },
    ],
  },
  {
    id: 'g3', title: 'New engagement conflict-check workflow', source: 'Low-confidence answer',
    description: 'Morgan gives inconsistent answers on the updated independence conflict-check steps for new engagements post-restructure.',
    frequency: '8 queries in 21 days', de: 'Morgan', severity: 'medium', status: 'detected',
    signals: [
      { time: '2026-07-01 11:30', text: 'Morgan low-confidence answer (64%) on conflict-check sequencing for new engagement #E-2251' },
      { time: '2026-06-26 09:15', text: 'Morgan query miss: "Does the new workflow require risk sign-off before or after KYC?"' },
      { time: '2026-06-20 16:50', text: 'Risk & Compliance escalation: engagement opened before conflict check completed' },
    ],
    searched: 0,
    findings: [],
  },
];

const STATUS_META: Record<GapStatus, { label: string; cls: string }> = {
  detected: { label: 'Detected', cls: 'bg-slate-700/50 text-slate-300' },
  investigating: { label: 'Investigating', cls: 'bg-sky-500/20 text-sky-400' },
  draft_ready: { label: 'Draft ready', cls: 'bg-amber-500/20 text-amber-400' },
  approved: { label: 'Approved', cls: 'bg-emerald-500/20 text-emerald-400' },
  retrained: { label: 'Retrained', cls: 'bg-indigo-500/20 text-indigo-400' },
};

const SEVERITY_CLS = { high: 'text-red-400', medium: 'text-amber-400', low: 'text-slate-400' } as const;

const DemoKnowledgeGapsPage = () => {
  const { activeCompanyId, handleSetPage } = useAuth();
  const companyId = activeCompanyId as CompanyId;
  const gaps = companyId === 'tcp' ? TCP_GAPS : PWC_GAPS;
  const summary = COMPANY_SUMMARY[companyId];
  const lsKey = `dt_kb_gaps_${companyId}`;

  const [overrides, setOverrides] = useState<Record<string, GapStatus>>(() => {
    try { const s = localStorage.getItem(lsKey); return s ? JSON.parse(s) : {}; } catch { return {}; }
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => { setSelectedId(null); }, [companyId]);
  useEffect(() => {
    try { const s = localStorage.getItem(lsKey); setOverrides(s ? JSON.parse(s) : {}); } catch { setOverrides({}); }
  }, [lsKey]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const statusOf = (g: Gap): GapStatus => overrides[g.id] ?? g.status;
  const setStatus = (id: string, s: GapStatus) => {
    const next = { ...overrides, [id]: s };
    setOverrides(next);
    try {
      localStorage.setItem(lsKey, JSON.stringify(next));
      window.dispatchEvent(new Event('dt-state-changed'));
    } catch { /* noop */ }
  };

  const openGaps = gaps.filter(g => !['approved', 'retrained'].includes(statusOf(g)));
  const draftsAwaiting = gaps.filter(g => statusOf(g) === 'draft_ready').length;
  const resolvedThisMonth = gaps.filter(g => ['approved', 'retrained'].includes(statusOf(g))).length + (companyId === 'tcp' ? 3 : 2);
  const avgResolution = companyId === 'tcp' ? '4.2 days' : '5.8 days';
  const selected = gaps.find(g => g.id === selectedId) ?? null;

  const loopCounts = {
    detected: gaps.filter(g => statusOf(g) === 'detected').length,
    investigating: gaps.filter(g => statusOf(g) === 'investigating').length,
    draft: draftsAwaiting,
    approval: draftsAwaiting,
    published: gaps.filter(g => statusOf(g) === 'approved').length,
    retrained: gaps.filter(g => statusOf(g) === 'retrained').length,
  };

  const loopNodes = [
    { label: 'Gap detected', count: loopCounts.detected, icon: '◉' },
    { label: 'Resolution Agent', count: loopCounts.investigating, icon: '⌕' },
    { label: 'Draft', count: loopCounts.draft, icon: '✎' },
    { label: 'Human approval', count: loopCounts.approval, icon: '☑' },
    { label: 'Publish', count: loopCounts.published, icon: '↗' },
    { label: 'DE retrain', count: loopCounts.retrained, icon: '↻' },
  ];

  return (
    <div className="flex-1 overflow-y-auto bg-slate-950 p-6 relative">
      <PageHeader title="Gap Detection" subtitle="The self-healing loop — DE query misses become gap signals, the Resolution Agent mines historical resolutions, a draft article is proposed, and a human approves before DEs retrain." />

      {/* Loop diagram strip */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 mb-6">
        <div className="flex items-stretch gap-2 overflow-x-auto pb-1">
          {loopNodes.map((n, i) => (
            <React.Fragment key={n.label}>
              <div className="flex-1 min-w-[100px] rounded-xl border border-slate-800 bg-slate-950 p-3 text-center">
                <p className="text-indigo-400 text-sm">{n.icon}</p>
                <p className="text-xs font-semibold text-slate-300 mt-1">{n.label}</p>
                <p className="text-lg font-bold text-white mt-0.5">{n.count}</p>
              </div>
              {i < loopNodes.length - 1 && <span className="self-center text-slate-600 flex-shrink-0">→</span>}
            </React.Fragment>
          ))}
        </div>
        <p className="text-[11px] text-slate-500 mt-2">Approved articles automatically queue affected DEs for retraining within 24 hours — closing the loop.</p>
      </div>

      {/* Header stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Open gaps</p>
          {/* seeded to match companies.ts kbGaps (TCP 5 / PWC 3) until user actions change it */}
          <p className="text-xl font-bold text-amber-300">{Object.keys(overrides).length === 0 ? summary.kbGaps : openGaps.length}</p>
          <p className="text-xs text-slate-500 mt-0.5">detected · investigating · draft ready</p>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Resolved this month</p>
          <p className="text-xl font-bold text-emerald-300">{resolvedThisMonth}</p>
          <p className="text-xs text-slate-500 mt-0.5">gaps closed via the loop</p>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Avg resolution time</p>
          <p className="text-xl font-bold text-white">{avgResolution}</p>
          <p className="text-xs text-slate-500 mt-0.5">signal → published article</p>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Drafts awaiting approval</p>
          <p className="text-xl font-bold text-indigo-300">{draftsAwaiting}</p>
          <p className="text-xs text-slate-500 mt-0.5">auto-drafted by the Knowledge Drafting Agent</p>
        </div>
      </div>

      {/* Gap table */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 overflow-hidden">
        <table className="w-full text-sm text-slate-300">
          <thead className="bg-slate-900 border-b border-slate-800">
            <tr>
              <th className={th}>Gap</th>
              <th className={th}>Signal source</th>
              <th className={th}>Frequency</th>
              <th className={th}>Affected DE</th>
              <th className={th}>Severity</th>
              <th className={th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {gaps.map(g => {
              const st = statusOf(g);
              return (
                <tr key={g.id} onClick={() => setSelectedId(g.id)} className="border-b border-slate-800/60 hover:bg-slate-800/40 cursor-pointer transition-colors">
                  <td className={td}>
                    <p className="text-white font-medium">{g.title}</p>
                    <p className="text-xs text-slate-500 mt-0.5 max-w-md">{g.description}</p>
                  </td>
                  <td className={`${td} text-xs text-slate-400`}>{g.source}</td>
                  <td className={`${td} text-xs text-slate-300`}>{g.frequency}</td>
                  <td className={td}>
                    <span className="flex items-center gap-1.5">
                      <span className="w-5 h-5 rounded-full bg-indigo-600 flex items-center justify-center text-white text-[9px] font-bold">{g.de[0]}</span>
                      <span className="text-xs">{g.de}</span>
                    </span>
                  </td>
                  <td className={td}><span className={`text-xs font-medium capitalize ${SEVERITY_CLS[g.severity]}`}>{g.severity}</span></td>
                  <td className={td}><span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_META[st]?.cls}`}>{STATUS_META[st]?.label ?? st}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Detail panel — full loop */}
      {selected && (() => {
        const st = statusOf(selected);
        return (
          <div className="fixed inset-0 z-40 flex justify-end" onClick={() => setSelectedId(null)}>
            <div className="absolute inset-0 bg-black/50" />
            <div onClick={e => e.stopPropagation()} className="relative w-full max-w-xl h-full bg-slate-900 border-l border-slate-800 overflow-y-auto p-6">
              <div className="flex items-start justify-between mb-1">
                <h2 className="text-lg font-semibold text-white">{selected.title}</h2>
                <button onClick={() => setSelectedId(null)} className="text-slate-500 hover:text-white text-lg leading-none">✕</button>
              </div>
              <div className="flex items-center gap-2 mb-5">
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_META[st]?.cls}`}>{STATUS_META[st]?.label ?? st}</span>
                <span className="text-xs text-slate-500">{selected.frequency} · affects {selected.de}</span>
              </div>

              {/* 1. Signal */}
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">1 · Signal</p>
              <div className="space-y-2 mb-6">
                {selected.signals.map(s => (
                  <div key={s.time} className="bg-slate-950 rounded-lg px-3 py-2">
                    <p className="text-xs text-slate-300">{s.text}</p>
                    <p className="text-[10px] text-slate-600 mt-0.5">{s.time}</p>
                  </div>
                ))}
              </div>

              {/* 2. Resolution Agent findings */}
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">2 · Resolution Agent findings</p>
              {selected.searched > 0 ? (
                <div className="mb-6">
                  <p className="text-xs text-sky-400 mb-2">Searched {selected.searched.toLocaleString()} historical resolutions — found {selected.findings.length} relevant</p>
                  <div className="space-y-2">
                    {selected.findings.map(f => (
                      <div key={f.ref} className="bg-slate-950 rounded-lg px-3 py-2 border border-slate-800">
                        <div className="flex justify-between">
                          <span className="text-xs font-medium text-white">{f.title}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-400 flex-shrink-0 ml-2">{f.ref}</span>
                        </div>
                        <p className="text-[11px] text-slate-400 mt-0.5">{f.note}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-slate-500 mb-6">Resolution Agent has not started — gap queued for investigation.</p>
              )}

              {/* 3. Drafted article */}
              {selected.draft && (
                <>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">3 · Drafted article</p>
                  <div className="rounded-xl border border-slate-800 bg-slate-950 p-4 mb-6">
                    <p className="text-sm font-semibold text-white mb-2">{selected.draft.title}</p>
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-400">{selected.draft.entity}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">{selected.draft.audience}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">{selected.draft.type}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400">est. confidence {selected.draft.confidence}%</span>
                    </div>
                    <div className="space-y-2">
                      {selected.draft.paragraphs.map((p, i) => (
                        <p key={i} className="text-xs text-slate-300 leading-relaxed">{p}</p>
                      ))}
                    </div>
                    <p className="text-[10px] text-slate-500 mt-3">Sources cited: {selected.draft.sources.join(' · ')}</p>
                  </div>
                </>
              )}

              {/* 4. Human gate */}
              {st === 'draft_ready' && selected.draft && (
                <>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">4 · Human gate</p>
                  <div className="flex gap-2 mb-6">
                    <button
                      onClick={() => { setStatus(selected.id, 'approved'); setToast('Article published — affected DEs will retrain within 24h'); }}
                      className="flex-1 text-sm px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium">
                      Approve & publish
                    </button>
                    <button
                      onClick={() => { setStatus(selected.id, 'investigating'); setToast('Changes requested — returned to the Drafting Agent'); }}
                      className="text-sm px-3 py-2 rounded-lg border border-slate-700 text-slate-300 hover:border-slate-500">
                      Request changes
                    </button>
                    <button
                      onClick={() => { setStatus(selected.id, 'detected'); setToast('Draft rejected — gap remains open'); }}
                      className="text-sm px-3 py-2 rounded-lg border border-slate-700 text-slate-400 hover:border-red-500/50 hover:text-red-400">
                      Reject
                    </button>
                  </div>
                </>
              )}
              {st === 'approved' && (
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 mb-6">
                  <p className="text-xs text-emerald-300">Approved & published — {selected.de} queued for retraining (within 24h).</p>
                </div>
              )}

              {/* 5. Retrain status */}
              {(st === 'retrained' || selected.retrainedNote) && (
                <>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">5 · Retrain status</p>
                  <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-3">
                    <p className="text-xs text-indigo-300">{selected.retrainedNote ?? `Retrained: ${selected.de} ✓`}</p>
                    <p className="text-[11px] text-slate-400 mt-1.5">
                      Published articles are added to the owning DE's eval suite.{' '}
                      <button onClick={() => handleSetPage('intelligence_evals')} className="text-indigo-400 hover:text-indigo-300 transition-colors">Open Proving Ground →</button>
                    </p>
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })()}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-slate-800 border border-emerald-500/40 text-sm text-slate-100 rounded-xl px-4 py-3 shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
};

// ============================================================
// LIVE mode — real automatic detection (migration 070): a cluster of
// similar low-confidence inquiries, promoted into a real
// knowledge_revision_requests draft once it crosses the tenant's
// configured min_cluster_size. Approve/reject uses the SAME RPCs
// (apply_knowledge_revision / reject_knowledge_revision) the Human
// Tasks queue's "KNOWLEDGE" items already call — this page is just a
// richer, gap-specific view onto the same real data.
//
// Real states are simpler than the demo's invented 5-stage lifecycle:
// open (accumulating members) → revision_requested (a draft is
// pending human review) → resolved (applied) or back to open
// (rejected). There is no tracked "investigating" phase and no
// tracked "retrained" event — those stayed as demo-only concepts
// rather than being faked with real data that doesn't exist.
// ============================================================

type RepInfo = { inquiry: string; de_id: string | null; created_at: string };

function severityTier(c: KnowledgeGapCluster, policy: KnowledgeGapPolicy | null): { label: string; cls: string } {
  if (c.recurred_after_fix) return { label: 'Recurred after fix', cls: 'text-red-400' };
  const bar = policy?.min_cluster_size ?? 3;
  if (c.severity_score >= bar * 1.5) return { label: 'High', cls: 'text-red-400' };
  if (c.severity_score >= bar) return { label: 'Medium', cls: 'text-amber-400' };
  return { label: 'Low', cls: 'text-slate-400' };
}

const LIVE_STATUS_META: Record<KnowledgeGapCluster['status'], { label: string; cls: string }> = {
  open: { label: 'Open', cls: 'bg-slate-700/50 text-slate-300' },
  revision_requested: { label: 'Draft pending review', cls: 'bg-amber-500/20 text-amber-400' },
  resolved: { label: 'Resolved', cls: 'bg-emerald-500/20 text-emerald-400' },
};

function LiveKnowledgeGaps({ setPage }: { setPage: (p: Page) => void }) {
  const [clusters, setClusters] = useState<KnowledgeGapCluster[]>([]);
  const [policies, setPolicies] = useState<KnowledgeGapPolicy[]>([]);
  const [revisions, setRevisions] = useState<KnowledgeRevisionRequest[]>([]);
  const [des, setDes] = useState<DigitalEmployee[]>([]);
  const [repInfo, setRepInfo] = useState<Record<string, RepInfo>>({});
  const [loading, setLoading] = useState(true);
  const [missingTables, setMissingTables] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ members: KnowledgeGapClusterMember[]; inquiries: Record<string, RepInfo> } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, p, r, d] = await Promise.all([
        listKnowledgeGapClusters(), listKnowledgeGapPolicies(), listKnowledgeRevisionRequests(), listDigitalEmployees(),
      ]);
      setClusters(c);
      setPolicies(p);
      setRevisions(r);
      setDes(d);
      setMissingTables(false);

      const repIds = Array.from(new Set(c.map(cl => cl.representative_run_id)));
      if (repIds.length > 0) {
        const { data: runs, error: runsErr } = await supabase
          .from('evidence_runs').select('id, inquiry, de_id, created_at').in('id', repIds);
        if (runsErr) throw runsErr;
        setRepInfo(Object.fromEntries((runs ?? []).map((row: any) => [row.id, { inquiry: row.inquiry, de_id: row.de_id, created_at: row.created_at }])));
      } else {
        setRepInfo({});
      }
    } catch (err) {
      if (err instanceof CustomerApiError && err.missingTables) setMissingTables(true);
      else setError((err as Error)?.message || 'Failed to load knowledge gaps.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    const cluster = clusters.find(c => c.id === selectedId);
    if (!cluster) return;
    setDetailLoading(true);
    getKnowledgeGapClusterDetail(cluster)
      .then(setDetail)
      .catch(err => setError((err as Error)?.message || 'Failed to load this gap\'s evidence.'))
      .finally(() => setDetailLoading(false));
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const deById = new Map(des.map(d => [d.id, d]));
  const revisionById = new Map(revisions.map(r => [r.id, r]));
  const policyFor = (category: string | null): KnowledgeGapPolicy | null =>
    policies.find(p => p.category === category) ?? policies.find(p => p.category === null) ?? null;

  const decide = async (requestId: string, decision: 'approved' | 'rejected') => {
    setDeciding(true);
    try {
      await resolveKnowledgeRevision(requestId, decision);
      setToast(decision === 'approved'
        ? 'Article published — the knowledge base was updated immediately.'
        : 'Draft rejected — this gap reopened and will keep accumulating for the next detection pass.');
      await refresh();
    } catch (err) {
      setError((err as Error)?.message || 'Failed to record decision.');
    } finally {
      setDeciding(false);
    }
  };

  const openCount = clusters.filter(c => c.status === 'open').length;
  const pendingCount = clusters.filter(c => c.status === 'revision_requested').length;
  const resolvedCount = clusters.filter(c => c.status === 'resolved').length;
  const recurredCount = clusters.filter(c => c.recurred_after_fix).length;

  const loopNodes = [
    { label: 'Gap detected', count: openCount, icon: '◉' },
    { label: 'Draft pending review', count: pendingCount, icon: '✎' },
    { label: 'Resolved', count: resolvedCount, icon: '↗' },
  ];

  const selected = clusters.find(c => c.id === selectedId) ?? null;
  const selectedRevision = selected?.revision_request_id ? revisionById.get(selected.revision_request_id) ?? null : null;
  const selectedRep = selected ? repInfo[selected.representative_run_id] : undefined;
  const selectedDe = selectedRep?.de_id ? deById.get(selectedRep.de_id) : undefined;
  const selectedPolicy = selected ? policyFor(selected.category) : null;

  return (
    <div className="flex-1 overflow-y-auto bg-slate-950 p-6 relative">
      <PageHeader title="Gap Detection" subtitle="Automatic detection of recurring low-confidence answers — clusters of similar questions become a draft knowledge update for a human to review, no manual flagging required." />

      {error && <div className="mb-4 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{error}</div>}

      {loading ? (
        <LiveLoadingSkeleton rows={4} />
      ) : missingTables ? (
        <MissingTablesNotice />
      ) : clusters.length === 0 ? (
        <LiveEmptyState
          icon="◎"
          title="No knowledge gaps detected yet"
          body="This runs automatically every 5 minutes: when several similar questions score below your confidence floor with no matching knowledge, they're grouped into a gap here for review. Nothing has crossed that pattern yet for this workspace."
          primaryLabel="Go to Knowledge Library"
          onPrimary={() => setPage('knowledge_library')}
        />
      ) : (
        <>
          {/* Loop diagram strip — real states only */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 mb-6">
            <div className="flex items-stretch gap-2 overflow-x-auto pb-1">
              {loopNodes.map((n, i) => (
                <React.Fragment key={n.label}>
                  <div className="flex-1 min-w-[100px] rounded-xl border border-slate-800 bg-slate-950 p-3 text-center">
                    <p className="text-indigo-400 text-sm">{n.icon}</p>
                    <p className="text-xs font-semibold text-slate-300 mt-1">{n.label}</p>
                    <p className="text-lg font-bold text-white mt-0.5">{n.count}</p>
                  </div>
                  {i < loopNodes.length - 1 && <span className="self-center text-slate-600 flex-shrink-0">→</span>}
                </React.Fragment>
              ))}
            </div>
            <p className="text-[11px] text-slate-500 mt-2">
              Detection and clustering run every 5 minutes against real, low-confidence inquiries — approving a draft updates the knowledge base immediately.
              {recurredCount > 0 && <span className="text-red-400"> {recurredCount} gap{recurredCount === 1 ? '' : 's'} recurred after a fix was applied — the earlier fix may not have worked.</span>}
            </p>
          </div>

          {/* Gap table */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 overflow-hidden">
            <table className="w-full text-sm text-slate-300">
              <thead className="bg-slate-900 border-b border-slate-800">
                <tr>
                  <th className={th}>Gap</th>
                  <th className={th}>Category</th>
                  <th className={th}>Members</th>
                  <th className={th}>Affected DE</th>
                  <th className={th}>Severity</th>
                  <th className={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {clusters.map(c => {
                  const rep = repInfo[c.representative_run_id];
                  const de = rep?.de_id ? deById.get(rep.de_id) : undefined;
                  const rev = c.revision_request_id ? revisionById.get(c.revision_request_id) : undefined;
                  const title = rev?.proposed_title ?? rep?.inquiry ?? '(loading…)';
                  const tier = severityTier(c, policyFor(c.category));
                  return (
                    <tr key={c.id} onClick={() => setSelectedId(c.id)} className="border-b border-slate-800/60 hover:bg-slate-800/40 cursor-pointer transition-colors">
                      <td className={td}>
                        <p className="text-white font-medium max-w-md truncate">{title}</p>
                        <p className="text-xs text-slate-500 mt-0.5">first seen {new Date(c.first_seen_at).toLocaleDateString()}</p>
                      </td>
                      <td className={`${td} text-xs text-slate-400`}>{c.category ?? 'any'}</td>
                      <td className={`${td} text-xs text-slate-300`}>{c.member_count}</td>
                      <td className={td}>
                        {de ? (
                          <span className="flex items-center gap-1.5">
                            <span className="w-5 h-5 rounded-full bg-indigo-600 flex items-center justify-center text-white text-[9px] font-bold">{de.name[0]}</span>
                            <span className="text-xs">{de.name}</span>
                          </span>
                        ) : <span className="text-xs text-slate-600">—</span>}
                      </td>
                      <td className={td}><span className={`text-xs font-medium ${tier.cls}`}>{tier.label}</span></td>
                      <td className={td}><span className={`text-xs px-2 py-0.5 rounded-full font-medium ${LIVE_STATUS_META[c.status]?.cls}`}>{LIVE_STATUS_META[c.status]?.label ?? c.status}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Detail panel */}
          {selected && (
            <div className="fixed inset-0 z-40 flex justify-end" onClick={() => setSelectedId(null)}>
              <div className="absolute inset-0 bg-black/50" />
              <div onClick={e => e.stopPropagation()} className="relative w-full max-w-xl h-full bg-slate-900 border-l border-slate-800 overflow-y-auto p-6">
                <div className="flex items-start justify-between mb-1">
                  <h2 className="text-lg font-semibold text-white">{selectedRevision?.proposed_title ?? selectedRep?.inquiry ?? 'Gap detail'}</h2>
                  <button onClick={() => setSelectedId(null)} className="text-slate-500 hover:text-white text-lg leading-none">✕</button>
                </div>
                <div className="flex items-center gap-2 mb-5 flex-wrap">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${LIVE_STATUS_META[selected.status].cls}`}>{LIVE_STATUS_META[selected.status].label}</span>
                  <span className="text-xs text-slate-500">{selected.member_count} similar question{selected.member_count === 1 ? '' : 's'}{selectedPolicy ? ` in a ${selectedPolicy.window_days}-day window` : ''}{selectedDe ? ` · affects ${selectedDe.name}` : ''}</span>
                </div>

                {typeof selected.pre_fix_avg_confidence === 'number' && (
                  <div className="mb-5 bg-slate-950 rounded-lg px-3 py-2">
                    <p className="text-xs text-slate-400">Average confidence when this pattern was detected: <span className="text-white font-medium">{selected.pre_fix_avg_confidence}%</span></p>
                  </div>
                )}

                {/* 1. Signal — real cluster members, real inquiry text */}
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">1 · Signal — the questions behind this pattern</p>
                {detailLoading ? (
                  <div className="mb-6"><LiveLoadingSkeleton rows={2} /></div>
                ) : (
                  <div className="space-y-2 mb-6">
                    {(detail?.members ?? []).map(m => {
                      const info = detail?.inquiries[m.evidence_run_id];
                      return (
                        <div key={m.id} className="bg-slate-950 rounded-lg px-3 py-2">
                          <p className="text-xs text-slate-300">{info?.inquiry ?? '(inquiry text unavailable)'}</p>
                          <p className="text-[10px] text-slate-600 mt-0.5">
                            {info ? new Date(info.created_at).toLocaleString() : ''}
                            {m.similarity_to_representative !== null ? ` · ${Math.round(m.similarity_to_representative * 100)}% similar to the representative question` : ''}
                          </p>
                        </div>
                      );
                    })}
                    {(detail?.members ?? []).length === 0 && !detailLoading && (
                      <p className="text-xs text-slate-500">No member questions loaded.</p>
                    )}
                  </div>
                )}

                {/* 2. Drafted revision — real proposed_body_md, server-composed from the evidence above */}
                {selectedRevision && (
                  <>
                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">2 · Proposed knowledge update</p>
                    <div className="rounded-xl border border-slate-800 bg-slate-950 p-4 mb-6">
                      <p className="text-sm font-semibold text-white mb-2">{selectedRevision.proposed_title}</p>
                      <pre className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap font-sans">{selectedRevision.proposed_body_md}</pre>
                    </div>
                  </>
                )}

                {/* 3. Human gate — real approve/reject via the same RPCs Human Tasks uses */}
                {selected.status === 'revision_requested' && selectedRevision && selectedRevision.status === 'pending_approval' && (
                  <>
                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">3 · Human review</p>
                    <div className="flex gap-2 mb-6">
                      <button
                        disabled={deciding}
                        onClick={() => void decide(selectedRevision.id, 'approved')}
                        className="flex-1 text-sm px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium">
                        {deciding ? '…' : 'Approve & publish'}
                      </button>
                      <button
                        disabled={deciding}
                        onClick={() => void decide(selectedRevision.id, 'rejected')}
                        className="text-sm px-3 py-2 rounded-lg border border-slate-700 text-slate-400 hover:border-red-500/50 hover:text-red-400 disabled:opacity-50">
                        Reject
                      </button>
                    </div>
                  </>
                )}
                {selected.status === 'resolved' && (
                  <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 mb-6">
                    <p className="text-xs text-emerald-300">Resolved — a knowledge update was published{selected.fix_applied_at ? ` on ${new Date(selected.fix_applied_at).toLocaleDateString()}` : ''}.</p>
                    {selected.recurred_after_fix && (
                      <p className="text-xs text-red-300 mt-1">This gap has since recurred {selected.recurrence_count} time{selected.recurrence_count === 1 ? '' : 's'} after that fix — the underlying question may not have been fully resolved.</p>
                    )}
                  </div>
                )}
                {selected.status === 'open' && (
                  <p className="text-xs text-slate-500 mb-6">
                    Still accumulating — needs {Math.max(0, (selectedPolicy?.min_cluster_size ?? 3) - selected.member_count)} more similar question{Math.max(0, (selectedPolicy?.min_cluster_size ?? 3) - selected.member_count) === 1 ? '' : 's'} before it's promoted to a reviewable draft.
                  </p>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-slate-800 border border-emerald-500/40 text-sm text-slate-100 rounded-xl px-4 py-3 shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}

export default function KnowledgeGapsPage({ setPage }: { setPage?: (p: Page) => void }) {
  const dataMode = useDataMode();
  if (dataMode === 'live') return <LiveKnowledgeGaps setPage={setPage ?? (() => {})} />;
  return <DemoKnowledgeGapsPage />;
}
