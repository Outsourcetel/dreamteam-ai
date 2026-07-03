import React, { useState } from 'react';
import { useAuth } from '../../../context/AuthContext';
import type { Page } from '../../../types';
import type { CompanyId } from '../../../data/companies';
import { th, td } from '../../../components/ui';

// ============================================================
// Outcome pages — cross-entity metric lenses.
// Numbers reconciled with DashboardPage COMPANY_DATA
// (TCP: $2.1M pipeline, 3 releases, $248K AR, 2 alerts;
//  PWC: $4.2M fees, 2 filings due Jul 15, $890K WIP, 2 alerts),
// CustomerSalesPage ($2.1M / 12 opps) and CustomerRenewalPage
// (8 renewals / $1.2M ARR / $248K invoices pending).
// OutcomeFinancialPage carries forward the AP/AR + exception
// review UI from the retired FinanceControlTowerPage.
// ============================================================


type Trend = 'up' | 'stable' | 'warn' | 'alert';

const trendMeta: Record<Trend, { icon: string; label: string; color: string }> = {
  up: { icon: '↑', label: 'Trending up', color: 'text-emerald-400' },
  stable: { icon: '→', label: 'Stable', color: 'text-slate-400' },
  warn: { icon: '↓', label: 'Needs attention', color: 'text-amber-400' },
  alert: { icon: '⚠', label: 'Alert', color: 'text-red-400' },
};

function OutcomeHeader({ title, metric, trend, legacy, subtitle }: {
  title: string; metric: string; trend: Trend; legacy: string[]; subtitle: string;
}) {
  const t = trendMeta[trend];
  return (
    <div className="mb-6">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-2xl font-bold text-white">{title}</h1>
        <span className="text-sm font-medium text-white bg-slate-800 rounded-lg px-2.5 py-1">{metric}</span>
        <span className={`flex items-center gap-1 text-xs ${t.color}`}>
          <span>{t.icon}</span><span>{t.label}</span>
        </span>
      </div>
      <p className="text-slate-400 text-sm mt-1">{subtitle}</p>
      <div className="mt-3 flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] text-slate-600">Legacy departments:</span>
        {legacy.map(d => (
          <span key={d} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-500">{d}</span>
        ))}
      </div>
    </div>
  );
}

function KpiCards({ items }: { items: { label: string; value: string; sub: string; color: string }[] }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
      {items.map(k => (
        <div key={k.label} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">{k.label}</p>
          <p className={`text-xl font-bold ${k.color}`}>{k.value}</p>
          <p className="text-xs text-slate-500 mt-0.5">{k.sub}</p>
        </div>
      ))}
    </div>
  );
}

function ContributingDEs({ des, note, setPage }: {
  des: { name: string; role: string; contribution: string }[];
  note?: string;
  setPage?: (p: Page) => void;
}) {
  return (
    <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
      <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Contributing Digital Employees</h3>
      {des.length === 0 ? (
        <p className="text-xs text-slate-500">{note || 'No DEs contribute to this outcome yet — handled by humans.'}</p>
      ) : (
        <div className="flex flex-wrap gap-3">
          {des.map(de => (
            <button
              key={de.name}
              onClick={() => setPage && setPage('workforce_des')}
              className="flex items-center gap-3 text-left rounded-xl px-4 py-3 border border-slate-800 bg-slate-900 hover:border-slate-600 transition-all"
            >
              <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">{de.name[0]}</div>
              <div>
                <p className="text-sm font-semibold text-white">{de.name} <span className="text-slate-500 font-normal text-xs">· {de.role}</span></p>
                <p className="text-xs text-slate-400">{de.contribution}</p>
              </div>
            </button>
          ))}
        </div>
      )}
      {des.length > 0 && note && <p className="mt-3 text-[11px] text-slate-500">{note}</p>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Revenue & Growth
// ═══════════════════════════════════════════════════════════════

const TCP_PIPELINE_STAGES = [
  { stage: 'Discovery', value: '$466K', count: 4, pct: 22, color: 'bg-slate-500' },
  { stage: 'Demo', value: '$336K', count: 3, pct: 16, color: 'bg-sky-500' },
  { stage: 'Proposal', value: '$802K', count: 3, pct: 38, color: 'bg-indigo-500' },
  { stage: 'Negotiation', value: '$496K', count: 2, pct: 24, color: 'bg-emerald-500' },
];

const PWC_SERVICE_LINES = [
  { line: 'Audit & Assurance', value: '$1.8M', engagements: 5, pct: 43, color: 'bg-indigo-500' },
  { line: 'Tax', value: '$1.3M', engagements: 6, pct: 31, color: 'bg-sky-500' },
  { line: 'Advisory', value: '$1.1M', engagements: 4, pct: 26, color: 'bg-emerald-500' },
];

const TCP_MRR = [
  { month: 'Feb', value: 148 }, { month: 'Mar', value: 152 }, { month: 'Apr', value: 155 },
  { month: 'May', value: 161 }, { month: 'Jun', value: 168 }, { month: 'Jul', value: 172 },
];

export const OutcomeRevenuePage = ({ setPage }: { setPage: (p: Page) => void }) => {
  const { activeCompanyId } = useAuth();
  const isTcp = activeCompanyId === 'tcp';
  const maxMrr = Math.max(...TCP_MRR.map(m => m.value));

  const kpis = isTcp
    ? [
        { label: 'Open pipeline', value: '$2.1M', sub: '12 open opportunities', color: 'text-white' },
        { label: 'Renewals in flight', value: '$1.2M ARR', sub: '8 accounts due in 30 days', color: 'text-amber-300' },
        { label: 'Expansion opps', value: '$88K', sub: '3 upsell signals from Casey', color: 'text-emerald-300' },
        { label: 'MRR', value: '$172K', sub: '+2.4% month over month', color: 'text-emerald-300' },
      ]
    : [
        { label: 'Fees in progress', value: '$4.2M', sub: 'across 15 engagements', color: 'text-white' },
        { label: 'Proposals out', value: '$420K', sub: '2 proposals awaiting response', color: 'text-indigo-300' },
        { label: 'Renewals in flight', value: '$205K', sub: '2 engagement renewals', color: 'text-amber-300' },
        { label: 'Realization rate', value: '87%', sub: 'billed vs standard rates', color: 'text-emerald-300' },
      ];

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <OutcomeHeader
        title="Revenue & Growth"
        metric={isTcp ? '$2.1M pipeline' : '$4.2M fees in progress'}
        trend="up"
        legacy={isTcp ? ['Sales', 'Marketing'] : ['Business Development', 'Engagement Mgmt']}
        subtitle="Cross-entity revenue lens — pipeline, renewals, and expansion in one view"
      />

      <KpiCards items={kpis} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Main breakdown */}
        <div className="lg:col-span-2 rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <h3 className="text-sm font-semibold text-white">{isTcp ? 'Pipeline by stage' : 'Fees by service line'}</h3>
            <button onClick={() => setPage('entity_customer_sales')} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
              {isTcp ? 'View opportunities →' : 'View proposals →'}
            </button>
          </div>
          <div className="space-y-4">
            {(isTcp ? TCP_PIPELINE_STAGES : PWC_SERVICE_LINES.map(l => ({ stage: l.line, value: l.value, count: l.engagements, pct: l.pct, color: l.color }))).map(s => (
              <div key={s.stage}>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="text-slate-400">{s.stage} <span className="text-slate-600">· {s.count} {isTcp ? 'opps' : 'engagements'}</span></span>
                  <span className="text-white font-medium">{s.value}</span>
                </div>
                <div className="h-3 bg-slate-800 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full ${s.color}`} style={{ width: `${s.pct}%` }} />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-4 text-[11px] text-slate-500">
            {isTcp
              ? 'Stage totals sum to the $2.1M open pipeline tracked on the Sales page.'
              : 'Service-line totals sum to $4.2M fees in progress across the practice.'}
          </p>
        </div>

        {/* Side panel */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
          {isTcp ? (
            <>
              <h3 className="text-sm font-semibold text-white mb-4">MRR trend ($K)</h3>
              <div className="flex items-end gap-2 h-32 mb-2">
                {TCP_MRR.map(m => (
                  <div key={m.month} className="flex-1 flex flex-col items-center gap-1">
                    <div className="w-full bg-indigo-500/70 rounded-t" style={{ height: `${(m.value / maxMrr) * 100}%` }} />
                    <span className="text-[10px] text-slate-500">{m.month}</span>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-slate-500 mb-4">$148K → $172K over 6 months.</p>
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
                <p className="text-xs text-amber-300 font-medium mb-1">Renewal watch</p>
                <p className="text-xs text-slate-400 mb-2">$248K in renewal invoices pending payment — 1 overdue (Apex Systems).</p>
                <button onClick={() => setPage('entity_customer_renewal')} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
                  Go to Renewal &amp; Expansion →
                </button>
              </div>
            </>
          ) : (
            <>
              <h3 className="text-sm font-semibold text-white mb-4">Renewals in flight</h3>
              <div className="space-y-3 mb-4">
                {[
                  { name: 'Crestview Holdings — Advisory', fees: '$120K', status: 'Proposal drafted' },
                  { name: 'Sterling Group — Tax Compliance', fees: '$85K', status: 'Reminder queued' },
                ].map(r => (
                  <div key={r.name} className="rounded-xl border border-slate-800 bg-slate-900 p-3">
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-xs font-medium text-white">{r.name}</span>
                      <span className="text-xs text-slate-300">{r.fees}</span>
                    </div>
                    <p className="text-[11px] text-indigo-300">{r.status}</p>
                  </div>
                ))}
              </div>
              <button onClick={() => setPage('entity_customer_renewal')} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
                Go to Renewal &amp; Expansion →
              </button>
            </>
          )}
        </div>
      </div>

      <ContributingDEs
        setPage={setPage}
        des={isTcp
          ? [{ name: 'Casey', role: 'Renewal DE', contribution: 'Runs the $1.2M renewal pipeline and surfaces expansion signals' }]
          : [{ name: 'Morgan', role: 'Client Relations DE', contribution: 'Drafts renewal proposals and reminder cadences' }]}
        note={isTcp ? 'New-business pipeline (BD & Sales) is human-led.' : 'New-business pursuits are partner-led.'}
      />
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// Delivery — Product & Engineering (TCP) / Practice Delivery (PWC)
// ═══════════════════════════════════════════════════════════════

const TCP_RELEASES = [
  { version: 'v4.2', date: 'Jul 10', scope: 'SSO improvements, webhook retry logic, 14 bug fixes', status: 'Code freeze' },
  { version: 'v4.3', date: 'Aug 7', scope: 'Analytics module GA, usage-based billing hooks', status: 'In development' },
  { version: 'v5.0', date: 'Sep 18', scope: 'New API surface, multi-region support', status: 'Planning' },
];

const PWC_ENGAGEMENTS = [
  { engagement: 'Harbor Financial — Audit', partner: 'D. Whitmore', due: 'Sep 30', progress: 62, filing: false },
  { engagement: 'Sterling Group — Q2 Tax Filing', partner: 'L. Ahmed', due: 'Jul 15', progress: 88, filing: true },
  { engagement: 'Beacon Capital — Q2 Tax Filing', partner: 'L. Ahmed', due: 'Jul 15', progress: 74, filing: true },
  { engagement: 'Crestview Holdings — Advisory', partner: 'D. Whitmore', due: 'Aug 29', progress: 45, filing: false },
];

const releaseBadge = (s: string) => {
  if (s === 'Code freeze') return 'bg-amber-500/15 text-amber-300';
  if (s === 'In development') return 'bg-indigo-500/15 text-indigo-300';
  return 'bg-slate-700/50 text-slate-300';
};

export const OutcomeDeliveryPage = ({ setPage }: { setPage: (p: Page) => void }) => {
  const { activeCompanyId } = useAuth();
  const isTcp = activeCompanyId === 'tcp';

  const kpis = isTcp
    ? [
        { label: 'Releases planned', value: '3', sub: 'next: v4.2 on Jul 10', color: 'text-white' },
        { label: 'Open incidents', value: '1', sub: 'P1 — API auth failure (Apex Systems)', color: 'text-red-300' },
        { label: 'Deploy frequency', value: '4.2/wk', sub: 'trailing 30 days', color: 'text-emerald-300' },
        { label: 'MTTR', value: '38 min', sub: 'trailing 90 days', color: 'text-emerald-300' },
      ]
    : [
        { label: 'Active engagements', value: '4', sub: 'across 3 service lines', color: 'text-white' },
        { label: 'Filings due Jul 15', value: '2', sub: 'Sterling Group, Beacon Capital', color: 'text-amber-300' },
        { label: 'Utilization', value: '78%', sub: 'practice-wide, this month', color: 'text-emerald-300' },
        { label: 'On-time delivery', value: '92%', sub: 'trailing 12 months', color: 'text-emerald-300' },
      ];

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <OutcomeHeader
        title={isTcp ? 'Product & Engineering' : 'Practice Delivery'}
        metric={isTcp ? '3 releases planned' : '2 filings due Jul 15'}
        trend={isTcp ? 'stable' : 'warn'}
        legacy={isTcp ? ['Engineering', 'Product', 'QA'] : ['Tax', 'Audit', 'Advisory']}
        subtitle={isTcp
          ? 'Delivery lens — release train, incidents, and engineering throughput'
          : 'Delivery lens — engagement progress, filing deadlines, and utilization'}
      />

      <KpiCards items={kpis} />

      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
        <h3 className="text-sm font-semibold text-white mb-3">{isTcp ? 'Release train' : 'Engagement progress'}</h3>
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-slate-800">
                {(isTcp ? ['Version', 'Target date', 'Scope', 'Status'] : ['Engagement', 'Partner', 'Due', 'Progress']).map(h => <th key={h} className={th}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {isTcp
                ? TCP_RELEASES.map((r, i) => (
                    <tr key={r.version} className={`border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors ${i === TCP_RELEASES.length - 1 ? 'border-b-0' : ''}`}>
                      <td className={`${td} font-medium text-white`}>{r.version}</td>
                      <td className={`${td} text-slate-300 text-xs whitespace-nowrap`}>{r.date}</td>
                      <td className={`${td} text-slate-400 text-xs`}>{r.scope}</td>
                      <td className={td}><span className={`text-xs px-2 py-0.5 rounded-full ${releaseBadge(r.status)}`}>{r.status}</span></td>
                    </tr>
                  ))
                : PWC_ENGAGEMENTS.map((e, i) => (
                    <tr key={e.engagement} className={`border-b border-slate-800/60 transition-colors ${e.filing ? 'bg-amber-500/5 hover:bg-amber-500/10' : 'hover:bg-slate-800/30'} ${i === PWC_ENGAGEMENTS.length - 1 ? 'border-b-0' : ''}`}>
                      <td className={`${td} font-medium ${e.filing ? 'text-amber-200' : 'text-white'}`}>{e.engagement}{e.filing && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">DUE JUL 15</span>}</td>
                      <td className={`${td} text-slate-300 text-xs`}>{e.partner}</td>
                      <td className={`${td} text-xs whitespace-nowrap ${e.filing ? 'text-amber-300' : 'text-slate-400'}`}>{e.due}</td>
                      <td className={td}>
                        <div className="flex items-center gap-2 min-w-[120px]">
                          <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${e.progress >= 80 ? 'bg-emerald-500' : 'bg-indigo-500'}`} style={{ width: `${e.progress}%` }} />
                          </div>
                          <span className="text-xs text-slate-300 w-8 text-right">{e.progress}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
        {isTcp && (
          <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/5 p-3 flex items-center justify-between flex-wrap gap-2">
            <p className="text-xs text-slate-300"><span className="text-red-300 font-medium">Open P1:</span> API auth failure affecting Apex Systems — escalated by Alex to L2 Engineering.</p>
            <button onClick={() => setPage('entity_customer_support')} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors flex-shrink-0">View in Support →</button>
          </div>
        )}
      </div>

      <ContributingDEs
        setPage={setPage}
        des={isTcp ? [] : [{ name: 'Avery', role: 'Tax Research DE', contribution: 'Drafts tax memos and reviews workpapers feeding these engagements' }]}
        note={isTcp ? 'Engineering delivery is fully human-led today. Alex feeds escalated bugs into the incident queue.' : undefined}
      />
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// Financial Health — carries forward the Finance Control Tower
// (AP/AR, exception review with approve/reject, cash position)
// ═══════════════════════════════════════════════════════════════

interface FinException {
  id: string;
  type: string;
  tone: 'rose' | 'amber' | 'sky';
  title: string;
  amount: string;
  detail: string;
  reasoning: string;
  proposed: string;
  confidence: number;
  risky: boolean;
}

const EXCEPTIONS: Record<CompanyId, FinException[]> = {
  tcp: [
    {
      id: 'ex1', type: 'Late customer payment', tone: 'amber', title: 'Apex Systems renewal invoice overdue', amount: '$43,000',
      detail: 'Renewal invoice unpaid 8 days past due. Account health 34 — open P1 escalation.',
      reasoning: 'Payment history was on-time for 18 months; overdue coincides with the open P1 support escalation, suggesting a withheld payment rather than credit risk.',
      proposed: 'Notify CSM via Gainsight CTA and pause dunning until P1 resolution.', confidence: 84, risky: false,
    },
    {
      id: 'ex2', type: 'Duplicate bill/invoice', tone: 'rose', title: 'Possible duplicate — DataDog June invoice', amount: '$3,500',
      detail: 'Two invoices with matching amount and period from DataDog ingested 3 days apart.',
      reasoning: 'Invoice numbers differ by suffix only (-A/-B); line items identical. 92% match on OCR comparison.',
      proposed: 'Hold the second invoice and request confirmation from vendor AP.', confidence: 92, risky: true,
    },
    {
      id: 'ex3', type: 'Uncategorized txn', tone: 'sky', title: '4 bank transactions uncategorized', amount: '$6,120',
      detail: 'Card transactions from the offsite week lack GL categories.',
      reasoning: 'Merchant codes map to travel & events with 88% historical accuracy.',
      proposed: 'Categorize as T&E — Offsite and attach receipts request.', confidence: 88, risky: false,
    },
  ],
  pwc: [
    {
      id: 'ex1', type: 'Revenue/WIP mismatch', tone: 'rose', title: 'Harbor Financial — WIP exceeds billing schedule', amount: '$120,000',
      detail: 'Recorded WIP is 2 months ahead of the agreed billing milestones.',
      reasoning: 'Timesheets show audit fieldwork accelerated; the billing schedule was never re-baselined after scope expansion.',
      proposed: 'Issue interim bill for completed fieldwork phase per engagement letter clause 4.2.', confidence: 81, risky: true,
    },
    {
      id: 'ex2', type: 'Late client payment', tone: 'amber', title: 'Beacon Capital advisory invoice 45 days past due', amount: '$28,000',
      detail: 'Second reminder sent; no response from client AP.',
      reasoning: 'Client engagement health is 47 with slipped deliverables — payment delay likely linked to dissatisfaction.',
      proposed: 'Route to engagement partner before further dunning.', confidence: 79, risky: false,
    },
    {
      id: 'ex3', type: 'Missing timesheet', tone: 'sky', title: '3 staff missing timesheets for Sterling filing', amount: '—',
      detail: 'WIP for the Jul 15 filing cannot be finalized until hours are posted.',
      reasoning: 'All three staff show calendar activity on the engagement during the missing period.',
      proposed: 'Send timesheet completion nudges with Jul 10 deadline.', confidence: 95, risky: false,
    },
  ],
};

const AR_AGING: Record<CompanyId, { bucket: string; amount: string; pct: number; color: string }[]> = {
  tcp: [
    { bucket: 'Current', amount: '$118K', pct: 48, color: 'bg-emerald-500' },
    { bucket: '1–30 days', amount: '$62K', pct: 25, color: 'bg-indigo-500' },
    { bucket: '31–60 days', amount: '$41K', pct: 16, color: 'bg-amber-500' },
    { bucket: '60+ days', amount: '$27K', pct: 11, color: 'bg-red-500' },
  ],
  pwc: [
    { bucket: 'Current', amount: '$392K', pct: 44, color: 'bg-emerald-500' },
    { bucket: '1–30 days', amount: '$248K', pct: 28, color: 'bg-indigo-500' },
    { bucket: '31–60 days', amount: '$160K', pct: 18, color: 'bg-amber-500' },
    { bucket: '60+ days', amount: '$90K', pct: 10, color: 'bg-red-500' },
  ],
};

const exToneBadge = (tone: FinException['tone']) =>
  tone === 'rose' ? 'bg-rose-500/15 text-rose-300' : tone === 'amber' ? 'bg-amber-500/15 text-amber-300' : 'bg-sky-500/15 text-sky-300';

export const OutcomeFinancialPage = ({ setPage }: { setPage: (p: Page) => void }) => {
  const { activeCompanyId } = useAuth();
  const isTcp = activeCompanyId === 'tcp';
  const [resolved, setResolved] = useState<Record<string, 'approved' | 'rejected'>>({});
  const [selected, setSelected] = useState<FinException | null>(null);
  const [toast, setToast] = useState('');

  const exceptions = EXCEPTIONS[activeCompanyId];
  const aging = AR_AGING[activeCompanyId];
  const openExceptions = exceptions.filter(e => !resolved[e.id]);

  const decide = (decision: 'approved' | 'rejected') => {
    if (!selected) return;
    setResolved(prev => ({ ...prev, [selected.id]: decision }));
    setToast(`Decision recorded — ${decision}. Audit evidence logged.`);
    setSelected(null);
    setTimeout(() => setToast(''), 3500);
  };

  const kpis = isTcp
    ? [
        { label: 'AR outstanding', value: '$248K', sub: '3 renewal invoices pending payment', color: 'text-amber-300' },
        { label: 'AP due', value: '$74K', sub: 'next 30 days', color: 'text-white' },
        { label: 'Cash position', value: '$1.9M', sub: 'operating account', color: 'text-emerald-300' },
        { label: 'Open exceptions', value: String(openExceptions.length), sub: `${exceptions.length - openExceptions.length} resolved this session`, color: openExceptions.length ? 'text-rose-300' : 'text-emerald-300' },
      ]
    : [
        { label: 'WIP unbilled', value: '$890K', sub: 'across 15 engagements', color: 'text-white' },
        { label: 'AR outstanding', value: '$890K', sub: 'see aging below', color: 'text-amber-300' },
        { label: 'Cash position', value: '$3.4M', sub: 'operating account', color: 'text-emerald-300' },
        { label: 'Open exceptions', value: String(openExceptions.length), sub: `${exceptions.length - openExceptions.length} resolved this session`, color: openExceptions.length ? 'text-rose-300' : 'text-emerald-300' },
      ];

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <OutcomeHeader
        title="Financial Health"
        metric={isTcp ? '$248K AR outstanding' : '$890K WIP unbilled'}
        trend={isTcp ? 'warn' : 'stable'}
        legacy={isTcp ? ['Finance', 'Accounting'] : ['Finance', 'Billing & Collections']}
        subtitle="Cross-entity financial lens — AR/AP, cash, and AI-detected reconciliation exceptions"
      />

      {toast && (
        <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-300">{toast}</div>
      )}

      <KpiCards items={kpis} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Aging */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 h-fit">
          <h3 className="text-sm font-semibold text-white mb-1">{isTcp ? 'AR aging — $248K' : 'WIP unbilled aging — $890K'}</h3>
          <p className="text-xs text-slate-500 mb-4">{isTcp ? 'Outstanding receivables by bucket' : 'Unbilled work-in-progress by age'}</p>
          <div className="space-y-3">
            {aging.map(a => (
              <div key={a.bucket}>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="text-slate-400">{a.bucket}</span>
                  <span className="text-white font-medium">{a.amount}</span>
                </div>
                <div className="h-2.5 bg-slate-800 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full ${a.color}`} style={{ width: `${a.pct}%` }} />
                </div>
              </div>
            ))}
          </div>
          {isTcp && (
            <button onClick={() => setPage('entity_customer_renewal')} className="mt-4 text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
              Renewal invoices live in the Customer entity →
            </button>
          )}
        </div>

        {/* Exceptions queue + review panel */}
        <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-white">Exceptions queue</h3>
            {openExceptions.length === 0 && (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-5 text-emerald-300 text-sm">All exceptions resolved. Books are clean.</div>
            )}
            {openExceptions.map(e => (
              <button
                key={e.id}
                onClick={() => setSelected(e)}
                className={`w-full text-left rounded-xl border p-4 transition ${selected?.id === e.id ? 'border-indigo-400 bg-slate-800/70' : 'border-slate-800 bg-slate-900/50 hover:border-slate-600'}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className={`text-[11px] uppercase tracking-wide px-2 py-0.5 rounded ${exToneBadge(e.tone)}`}>{e.type}</span>
                  <span className="text-xs text-slate-500">conf {e.confidence}%{e.risky ? ' · risky' : ''}</span>
                </div>
                <p className="mt-2 text-sm font-medium text-slate-100">{e.title}</p>
                <p className="text-xs text-slate-400 mt-1">{e.amount}</p>
              </button>
            ))}
          </div>

          <div>
            <h3 className="text-sm font-semibold text-white mb-3">Review</h3>
            {!selected ? (
              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 text-sm text-slate-400">
                Select an exception to review the AI proposal and approve or reject. Decisions are logged as audit evidence.
              </div>
            ) : (
              <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-5">
                <p className="text-sm font-semibold text-white">{selected.title}</p>
                {selected.risky && <span className="inline-block mt-2 text-[11px] px-2 py-0.5 rounded bg-rose-500/15 text-rose-300">Risky — never auto-executed</span>}
                <div className="mt-3 text-xs text-slate-400">Detail</div>
                <p className="text-sm text-slate-200">{selected.detail}</p>
                <div className="mt-3 text-xs text-slate-400">AI reasoning ({selected.confidence}% confidence)</div>
                <p className="text-sm text-slate-300">{selected.reasoning}</p>
                <div className="mt-3 text-xs text-slate-400">Proposed action</div>
                <p className="text-sm text-indigo-200">{selected.proposed}</p>
                <div className="mt-4 flex gap-2">
                  <button onClick={() => decide('approved')} className="flex-1 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-900 text-sm font-semibold py-2 transition-colors">Approve</button>
                  <button onClick={() => decide('rejected')} className="flex-1 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-100 text-sm font-semibold py-2 transition-colors">Reject</button>
                </div>
                <p className="mt-3 text-[11px] text-slate-500">Decisions are timestamped and immutable in the audit trail.</p>
              </div>
            )}
          </div>
        </div>
      </div>

      <ContributingDEs
        setPage={setPage}
        des={isTcp
          ? [{ name: 'Casey', role: 'Renewal DE', contribution: 'Generates renewal invoices in Zuora — $248K currently pending payment' }]
          : [{ name: 'Morgan', role: 'Client Relations DE', contribution: 'Queues billing reminders and drafts credit notes for partner approval' }]}
        note="Reconciliation exception detection runs automatically; every treatment requires human approval."
      />
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// Risk & Compliance
// ═══════════════════════════════════════════════════════════════

interface RiskAlert {
  title: string;
  severity: 'high' | 'medium';
  detail: string;
  owner: string;
  age: string;
}

const RISK_ALERTS: Record<CompanyId, RiskAlert[]> = {
  tcp: [
    {
      title: 'SOC 2 evidence collection overdue', severity: 'high',
      detail: 'Q2 access-review evidence for 3 systems (Zendesk, Salesforce, Workday) has not been uploaded. Auditor checkpoint is Jul 20.',
      owner: 'K. Douglas (Security)', age: '6 days',
    },
    {
      title: 'GDPR data-request SLA at risk', severity: 'medium',
      detail: 'One data-subject access request is at day 24 of the 30-day statutory window. Export prepared; awaiting legal review.',
      owner: 'Legal', age: '24 days open',
    },
  ],
  pwc: [
    {
      title: 'Independence check pending — new audit client', severity: 'high',
      detail: 'Partner independence confirmation outstanding for the Harbor Financial audit expansion. Fieldwork cannot proceed past Jul 20 without it.',
      owner: 'Quality & Risk', age: '4 days',
    },
    {
      title: 'GDPR data request — response overdue', severity: 'high',
      detail: 'A client data-subject request has passed its statutory deadline and was escalated to a human. Response draft awaiting sign-off.',
      owner: 'Morgan → Legal', age: '2 hrs since escalation',
    },
  ],
};

const COMPLIANCE_CALENDAR: Record<CompanyId, { item: string; date: string; status: string }[]> = {
  tcp: [
    { item: 'SOC 2 Type II auditor checkpoint', date: 'Jul 20', status: 'At risk' },
    { item: 'Quarterly access review', date: 'Jul 31', status: 'Scheduled' },
    { item: 'Pen test (annual)', date: 'Sep 15', status: 'Scheduled' },
    { item: 'GDPR processing-record refresh', date: 'Oct 1', status: 'Scheduled' },
  ],
  pwc: [
    { item: 'Independence confirmations — audit clients', date: 'Jul 20', status: 'At risk' },
    { item: 'AML/KYC file review (quarterly)', date: 'Aug 15', status: 'Scheduled' },
    { item: 'Quality review — sampled engagements', date: 'Sep 1', status: 'Scheduled' },
    { item: 'Regulator annual return', date: 'Oct 31', status: 'Scheduled' },
  ],
};

export const OutcomeRiskPage = ({ setPage }: { setPage: (p: Page) => void }) => {
  const { activeCompanyId } = useAuth();
  const isTcp = activeCompanyId === 'tcp';
  const alerts = RISK_ALERTS[activeCompanyId];
  const calendar = COMPLIANCE_CALENDAR[activeCompanyId];

  const kpis = [
    { label: 'Compliance alerts', value: '2', sub: 'open — detailed below', color: 'text-red-300' },
    { label: 'Guardrail violations', value: isTcp ? '1' : '0', sub: isTcp ? 'blocked this month, all DEs' : 'this month, all DEs', color: isTcp ? 'text-amber-300' : 'text-emerald-300' },
    { label: 'Approval gates', value: '100%', sub: 'high-risk actions gated', color: 'text-emerald-300' },
    { label: 'Audit coverage', value: isTcp ? '100%' : '100%', sub: 'DE actions logged immutably', color: 'text-white' },
  ];

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <OutcomeHeader
        title="Risk & Compliance"
        metric="2 compliance alerts"
        trend="alert"
        legacy={isTcp ? ['Legal', 'Security', 'Compliance'] : ['Risk & Compliance', 'Legal', 'Quality']}
        subtitle="Cross-entity risk lens — compliance alerts, guardrails, and the audit calendar"
      />

      <KpiCards items={kpis} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Alerts */}
        <div className="lg:col-span-2 space-y-3">
          <h3 className="text-sm font-semibold text-white">Open compliance alerts</h3>
          {alerts.map(a => (
            <div key={a.title} className={`rounded-xl border p-4 ${a.severity === 'high' ? 'border-red-500/30 bg-red-500/5' : 'border-amber-500/30 bg-amber-500/5'}`}>
              <div className="flex items-center justify-between gap-3 mb-1 flex-wrap">
                <span className={`text-sm font-medium ${a.severity === 'high' ? 'text-red-200' : 'text-amber-200'}`}>{a.title}</span>
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded ${a.severity === 'high' ? 'bg-red-500/15 text-red-300' : 'bg-amber-500/15 text-amber-300'}`}>{a.severity}</span>
                  <span className="text-xs text-slate-500">{a.age}</span>
                </div>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed mb-2">{a.detail}</p>
              <p className="text-[11px] text-slate-500">Owner: {a.owner}</p>
            </div>
          ))}

          {/* Guardrail violation log */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 mt-2">
            <h3 className="text-sm font-semibold text-white mb-1">Guardrail violation log</h3>
            <p className="text-xs text-slate-500 mb-4">Every blocked or overridden DE action appears here</p>
            {isTcp ? (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-5 flex items-start gap-3">
                <span className="text-amber-400 text-lg">⚑</span>
                <div>
                  <p className="text-sm text-amber-300 font-medium">1 block this month</p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    BLOCKED: Alex attempted SLA commitment outside standard tier — guardrail DE-R2 (2026-07-03 09:45). The guardrail worked as designed; no customer impact.
                  </p>
                  <button onClick={() => setPage('gov_audit')} className="mt-2 text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
                    View in Audit Trail →
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-5 flex items-center gap-3">
                <span className="text-emerald-400 text-lg">✓</span>
                <div>
                  <p className="text-sm text-emerald-300 font-medium">0 violations this month</p>
                  <p className="text-xs text-slate-400 mt-0.5">All DE actions stayed within configured guardrails and approval gates.</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Compliance calendar */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 h-fit">
          <h3 className="text-sm font-semibold text-white mb-3">Compliance calendar</h3>
          <div className="space-y-2">
            {calendar.map(c => (
              <div key={c.item} className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-xs text-slate-200 leading-tight">{c.item}</p>
                  <p className="text-[10px] text-slate-500 mt-0.5">{c.date}</p>
                </div>
                <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${c.status === 'At risk' ? 'bg-red-500/15 text-red-300' : 'bg-slate-800 text-slate-400'}`}>{c.status}</span>
              </div>
            ))}
          </div>
          <button onClick={() => setPage('gov_compliance')} className="mt-4 text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
            Open Compliance &amp; Guardrails →
          </button>
        </div>
      </div>

      <ContributingDEs
        setPage={setPage}
        des={isTcp
          ? [
              { name: 'Alex', role: 'Customer Support DE', contribution: 'PII masking enforced; no billing changes >$500 without approval' },
              { name: 'Casey', role: 'Renewal DE', contribution: 'Invoice generation gated behind human approval' },
              { name: 'Riley', role: 'HR & People DE', contribution: 'Recertification overdue — flagged in Workforce' },
            ]
          : [
              { name: 'Morgan', role: 'Client Relations DE', contribution: 'KYC checks logged; GDPR escalation routed to Legal' },
              { name: 'Avery', role: 'Tax Research DE', contribution: 'All memos gated behind partner review' },
            ]}
        note="Every DE operates inside industry guardrail templates with an immutable audit trail."
      />
    </div>
  );
};
