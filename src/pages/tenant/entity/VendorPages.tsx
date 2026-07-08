import React from 'react';
import { useAuth } from '../../../context/AuthContext';
import type { Page } from '../../../types';
import type { CompanyId } from '../../../data/companies';
import { PageHeader, th, td } from '../../../components/ui';
import { useDataMode } from '../../../lib/dataMode';
import { LiveEmptyState } from '../../../components/LiveDataStates';

// ============================================================
// Vendor entity pages: Overview, Sourcing, Contracts, Management.
// No DE assigned to the Vendor entity yet (both companies) —
// consistent with DashboardPage entity cards.
//
// Deliberately scoped OUT of the entity/outcome-model rebuild
// (founder decision, 2026-07-09): Vendor Management stays a design
// preview, not a real backend. What changed here is honesty, not
// scope — a LIVE tenant used to see this exact seeded TCP/PWC demo
// data unconditionally, which is exactly the kind of "fake data
// presented as real" this project treats as a bug everywhere else.
// Every page below now shows a real empty state for live tenants
// (matching the Dashboard's own "Not yet on the production track"
// cards for this entity) and keeps the untouched design-preview
// content for demo mode.
// ============================================================

function VendorNotYetAvailable({ title, setPage }: { title: string; setPage?: (p: Page) => void }) {
  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageHeader title={title} subtitle="Vendors & Partners" />
      <LiveEmptyState
        icon="◈"
        title="Vendor management isn't built yet"
        body="This entity is still a design preview, not a real workspace feature. Real vendor records, contracts, and relationship tracking aren't available for live workspaces yet."
        primaryLabel={setPage ? 'Back to Command Centre' : undefined}
        onPrimary={setPage ? () => setPage('dashboard') : undefined}
      />
    </div>
  );
}



// ── Overview ───────────────────────────────────────────────────

interface VendorStage {
  page: Page;
  label: string;
  icon: string;
  stat: string;
  statColor: string;
}

const VENDOR_STAGES: Record<CompanyId, VendorStage[]> = {
  tcp: [
    { page: 'entity_vendor_sourcing', label: 'Sourcing', icon: '◎', stat: '3 evaluations open', statColor: 'text-indigo-300' },
    { page: 'entity_vendor_contracts', label: 'Contracts', icon: '§', stat: '3 expiring in 60 days', statColor: 'text-amber-300' },
    { page: 'entity_vendor_management', label: 'Relationship Mgmt', icon: '⟳', stat: '12 active vendors', statColor: 'text-emerald-300' },
  ],
  pwc: [
    { page: 'entity_vendor_sourcing', label: 'Sourcing', icon: '◎', stat: '2 evaluations open', statColor: 'text-indigo-300' },
    { page: 'entity_vendor_contracts', label: 'Contracts', icon: '§', stat: '1 expiring in 60 days', statColor: 'text-amber-300' },
    { page: 'entity_vendor_management', label: 'Relationship Mgmt', icon: '⟳', stat: '2 under review', statColor: 'text-amber-300' },
  ],
};

const VENDOR_STATS: Record<CompanyId, { label: string; value: string; sub: string; color: string }[]> = {
  tcp: [
    { label: 'Active vendors', value: '12', sub: 'across 6 categories', color: 'text-white' },
    { label: 'Contracts expiring', value: '3', sub: 'in the next 60 days', color: 'text-amber-300' },
    { label: 'Annual spend', value: '$340K', sub: 'FY2026 committed', color: 'text-indigo-300' },
  ],
  pwc: [
    { label: 'Active vendors', value: '8', sub: 'across 4 categories', color: 'text-white' },
    { label: 'Under review', value: '2', sub: 'quarterly vendor review', color: 'text-amber-300' },
    { label: 'Annual spend', value: '$520K', sub: 'FY2026 committed', color: 'text-indigo-300' },
  ],
};

export const VendorOverviewPage = ({ setPage }: { setPage: (p: Page) => void }) => {
  const { activeCompanyId, activeCompany } = useAuth();
  const dataMode = useDataMode();
  const stages = VENDOR_STAGES[activeCompanyId];
  const stats = VENDOR_STATS[activeCompanyId];

  if (dataMode === 'live') return <VendorNotYetAvailable title="Vendors & Partners" setPage={setPage} />;

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Vendors &amp; Partners</h1>
        <p className="text-slate-400 text-sm mt-1">One relationship per vendor, end-to-end</p>
        <p className="text-xs text-slate-600 mt-0.5">{activeCompany.name} · {activeCompany.industry}</p>
      </div>

      {/* Automation opportunity callout */}
      <div className="mb-6 flex items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 flex-wrap">
        <div className="flex items-start gap-2 min-w-0 flex-1">
          <span className="text-amber-400 mt-0.5">◈</span>
          <div>
            <p className="text-xs font-semibold text-amber-300">Automation opportunity</p>
            <p className="text-xs text-slate-400 mt-0.5">
              {activeCompanyId === 'tcp'
                ? 'Vendor operations run manually today — ~14 hrs/month of human effort across sourcing, contract tracking and renewals. Hiring a Vendor DE typically automates 70% of it. 3 contracts expire in the next 60 days — a DE would already be preparing renewal reviews.'
                : 'Vendor operations run manually today — ~10 hrs/month of human effort across 8 active vendors. Hiring a Vendor DE typically automates 70% of it. 2 vendors are under quarterly review — a DE would already have the review packets prepared.'}
            </p>
          </div>
        </div>
        <button onClick={() => setPage('workforce_des')} className="text-xs font-medium text-indigo-400 hover:text-indigo-300 transition-colors flex-shrink-0">
          Explore Vendor DE →
        </button>
      </div>

      {/* Journey bar */}
      <div className="mb-8">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Vendor journey</h2>
        <div className="flex items-stretch gap-1 overflow-x-auto pb-2">
          {stages.map((s, i) => (
            <React.Fragment key={s.page}>
              <button
                onClick={() => setPage(s.page)}
                className="flex-shrink-0 w-48 text-left rounded-xl p-3.5 border border-slate-800 bg-slate-900 hover:border-indigo-500/50 hover:bg-indigo-500/5 transition-all group"
              >
                <div className="text-lg mb-1.5">{s.icon}</div>
                <p className="text-xs font-semibold text-white leading-tight mb-1 group-hover:text-indigo-200">{s.label}</p>
                <p className={`text-xs font-medium ${s.statColor}`}>{s.stat}</p>
              </button>
              {i < stages.length - 1 && (
                <div className="flex-shrink-0 self-center text-slate-700 text-lg px-0.5">→</div>
              )}
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-3 gap-3">
        {stats.map(s => (
          <div key={s.label} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">{s.label}</p>
            <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
            <p className="text-xs text-slate-500 mt-0.5">{s.sub}</p>
          </div>
        ))}
      </div>
    </div>
  );
};

// ── Sourcing ───────────────────────────────────────────────────

interface Evaluation {
  vendor: string;
  category: string;
  stage: string;
  score: number | null;
  owner: string;
}

const EVALUATIONS: Record<CompanyId, Evaluation[]> = {
  tcp: [
    { vendor: 'Grafana Cloud', category: 'Observability', stage: 'Scoring', score: 82, owner: 'R. Patel' },
    { vendor: 'Snowflake', category: 'Data Warehouse', stage: 'Demo scheduled', score: null, owner: 'R. Patel' },
    { vendor: 'Vanta', category: 'Compliance Automation', stage: 'Scoring', score: 88, owner: 'K. Douglas' },
    { vendor: 'Lattice', category: 'HR Software', stage: 'RFP sent', score: null, owner: 'K. Douglas' },
    { vendor: 'Cloudflare', category: 'Edge / CDN', stage: 'Shortlisted', score: 91, owner: 'R. Patel' },
  ],
  pwc: [
    { vendor: 'Thomson Reuters ONESOURCE', category: 'Tax Software', stage: 'Scoring', score: 86, owner: 'P. Nolan' },
    { vendor: 'Kira Systems', category: 'Contract Analysis', stage: 'Demo scheduled', score: null, owner: 'P. Nolan' },
    { vendor: 'Egnyte', category: 'Document Mgmt', stage: 'RFP sent', score: null, owner: 'F. Osei' },
    { vendor: 'Workiva', category: 'Reporting', stage: 'Shortlisted', score: 84, owner: 'F. Osei' },
    { vendor: 'Diligent', category: 'GRC Platform', stage: 'Scoring', score: 77, owner: 'P. Nolan' },
  ],
};

const RFPS: Record<CompanyId, { title: string; status: string; due: string; responses: string; tone: 'active' | 'closing' | 'draft' }[]> = {
  tcp: [
    { title: 'HR software replacement', status: 'Responses open', due: 'Jul 21', responses: '2 of 4 received', tone: 'active' },
    { title: 'Observability consolidation', status: 'Closing soon', due: 'Jul 10', responses: '3 of 3 received', tone: 'closing' },
  ],
  pwc: [
    { title: 'Document management refresh', status: 'Responses open', due: 'Jul 28', responses: '1 of 3 received', tone: 'active' },
    { title: 'GRC platform selection', status: 'Draft', due: 'Aug 15', responses: 'Not yet issued', tone: 'draft' },
  ],
};

const evalStageBadge = (stage: string) => {
  if (stage === 'Shortlisted') return 'bg-emerald-500/15 text-emerald-300';
  if (stage === 'Scoring') return 'bg-indigo-500/15 text-indigo-300';
  if (stage === 'Demo scheduled') return 'bg-sky-500/15 text-sky-300';
  return 'bg-slate-700/50 text-slate-300';
};

export const VendorSourcingPage = ({ setPage: _setPage }: { setPage?: (p: Page) => void }) => {
  const { activeCompanyId } = useAuth();
  const dataMode = useDataMode();
  const evals = EVALUATIONS[activeCompanyId];
  const rfps = RFPS[activeCompanyId];

  if (dataMode === 'live') return <VendorNotYetAvailable title="Sourcing — Vendor entity" setPage={_setPage} />;

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageHeader title="Sourcing — Vendor entity" subtitle="Vendor evaluations, RFPs, and selection — currently human-led" />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
          <h3 className="text-sm font-semibold text-white mb-3">Active evaluations</h3>
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-slate-800">
                  {['Vendor', 'Category', 'Stage', 'Score', 'Owner'].map(h => <th key={h} className={th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {evals.map((e, i) => (
                  <tr key={e.vendor} className={`border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors ${i === evals.length - 1 ? 'border-b-0' : ''}`}>
                    <td className={`${td} font-medium text-white`}>{e.vendor}</td>
                    <td className={`${td} text-slate-400 text-xs`}>{e.category}</td>
                    <td className={td}><span className={`text-xs px-2 py-0.5 rounded-full ${evalStageBadge(e.stage)}`}>{e.stage}</span></td>
                    <td className={`${td} text-xs ${e.score != null ? (e.score >= 85 ? 'text-emerald-300' : 'text-slate-300') : 'text-slate-600'}`}>{e.score != null ? `${e.score}/100` : '—'}</td>
                    <td className={`${td} text-slate-300 text-xs`}>{e.owner} <span className="text-slate-600">(human)</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
          <h3 className="text-sm font-semibold text-white mb-4">RFP status</h3>
          <div className="space-y-3">
            {rfps.map(r => (
              <div key={r.title} className={`rounded-xl border p-3 ${r.tone === 'closing' ? 'border-amber-500/30 bg-amber-500/5' : 'border-slate-800 bg-slate-900'}`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-white">{r.title}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${r.tone === 'closing' ? 'bg-amber-500/15 text-amber-300' : r.tone === 'draft' ? 'bg-slate-800 text-slate-400' : 'bg-indigo-500/15 text-indigo-300'}`}>{r.status}</span>
                </div>
                <p className="text-xs text-slate-500">Due {r.due} · {r.responses}</p>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-slate-500 mt-4">
            A Vendor DE could score RFP responses against your rubric automatically — no DE is assigned to this entity yet.
          </p>
        </div>
      </div>
    </div>
  );
};

// ── Contracts ──────────────────────────────────────────────────

interface Contract {
  vendor: string;
  type: string;
  valuePerYear: string;
  start: string;
  expiry: string;
  autoRenew: boolean;
  status: 'Active' | 'Expiring soon' | 'In renegotiation';
}

const CONTRACTS: Record<CompanyId, Contract[]> = {
  tcp: [
    { vendor: 'AWS', type: 'Cloud infrastructure', valuePerYear: '$96K', start: 'Sep 2024', expiry: 'Aug 28, 2026', autoRenew: false, status: 'Expiring soon' },
    { vendor: 'Twilio', type: 'Communications API', valuePerYear: '$34K', start: 'Aug 2024', expiry: 'Aug 14, 2026', autoRenew: false, status: 'Expiring soon' },
    { vendor: 'DataDog', type: 'Observability', valuePerYear: '$42K', start: 'Jul 2025', expiry: 'Jul 31, 2026', autoRenew: true, status: 'Expiring soon' },
    { vendor: 'Salesforce', type: 'CRM', valuePerYear: '$88K', start: 'Jan 2025', expiry: 'Dec 31, 2026', autoRenew: true, status: 'Active' },
    { vendor: 'Zendesk', type: 'Support platform', valuePerYear: '$47K', start: 'Mar 2025', expiry: 'Feb 28, 2027', autoRenew: true, status: 'Active' },
    { vendor: 'Workday', type: 'HRIS', valuePerYear: '$33K', start: 'Nov 2025', expiry: 'Oct 31, 2027', autoRenew: true, status: 'Active' },
  ],
  pwc: [
    { vendor: 'Thomson Reuters', type: 'Tax research library', valuePerYear: '$210K', start: 'Jan 2025', expiry: 'Aug 20, 2026', autoRenew: false, status: 'Expiring soon' },
    { vendor: 'CaseWare', type: 'Audit software', valuePerYear: '$145K', start: 'Apr 2025', expiry: 'Mar 31, 2027', autoRenew: true, status: 'Active' },
    { vendor: 'Iron Mountain', type: 'Records management', valuePerYear: '$65K', start: 'Jun 2024', expiry: 'May 31, 2027', autoRenew: true, status: 'In renegotiation' },
    { vendor: 'LexisNexis', type: 'Legal research', valuePerYear: '$100K', start: 'Oct 2025', expiry: 'Sep 30, 2027', autoRenew: true, status: 'Active' },
  ],
};

const contractStatusBadge = (s: Contract['status']) => {
  if (s === 'Expiring soon') return 'bg-amber-500/15 text-amber-300';
  if (s === 'In renegotiation') return 'bg-sky-500/15 text-sky-300';
  return 'bg-emerald-500/15 text-emerald-300';
};

export const VendorContractsPage = ({ setPage: _setPage }: { setPage?: (p: Page) => void }) => {
  const { activeCompanyId } = useAuth();
  const dataMode = useDataMode();
  const contracts = CONTRACTS[activeCompanyId];
  const expiring = contracts.filter(c => c.status === 'Expiring soon');
  const isTcp = activeCompanyId === 'tcp';

  if (dataMode === 'live') return <VendorNotYetAvailable title="Contracts — Vendor entity" setPage={_setPage} />;

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageHeader
        title="Contracts — Vendor entity"
        subtitle={isTcp ? '6 active vendor contracts — 3 expiring within 60 days' : '4 active vendor contracts — 1 expiring within 60 days'}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
          <h3 className="text-sm font-semibold text-white mb-3">Contract register</h3>
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-slate-800">
                  {['Vendor', 'Type', 'Value / yr', 'Start', 'Expiry', 'Auto-renew', 'Status'].map(h => <th key={h} className={th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {contracts.map((c, i) => {
                  const warn = c.status === 'Expiring soon';
                  return (
                    <tr key={c.vendor} className={`border-b border-slate-800/60 transition-colors ${warn ? 'bg-amber-500/5 hover:bg-amber-500/10' : 'hover:bg-slate-800/30'} ${i === contracts.length - 1 ? 'border-b-0' : ''}`}>
                      <td className={`${td} font-medium ${warn ? 'text-amber-200' : 'text-white'}`}>{c.vendor}</td>
                      <td className={`${td} text-slate-400 text-xs`}>{c.type}</td>
                      <td className={`${td} text-slate-300`}>{c.valuePerYear}</td>
                      <td className={`${td} text-slate-400 text-xs whitespace-nowrap`}>{c.start}</td>
                      <td className={`${td} text-xs whitespace-nowrap ${warn ? 'text-amber-300' : 'text-slate-400'}`}>{c.expiry}</td>
                      <td className={`${td} text-xs ${c.autoRenew ? 'text-emerald-400' : 'text-slate-500'}`}>{c.autoRenew ? 'Yes' : 'No'}</td>
                      <td className={td}><span className={`text-xs px-2 py-0.5 rounded-full ${contractStatusBadge(c.status)}`}>{c.status}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5 h-fit">
          <h3 className="text-sm font-semibold text-amber-200 mb-1">Expiring soon</h3>
          <p className="text-xs text-slate-500 mb-4">{expiring.length} contract{expiring.length === 1 ? '' : 's'} within 60 days</p>
          <div className="space-y-3">
            {expiring.map(c => (
              <div key={c.vendor} className="rounded-xl border border-slate-800 bg-slate-900 p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-white">{c.vendor}</span>
                  <span className="text-xs text-amber-300">{c.expiry}</span>
                </div>
                <p className="text-xs text-slate-500 mb-2">{c.type} · {c.valuePerYear}/yr · {c.autoRenew ? 'auto-renews' : 'no auto-renew'}</p>
                <button className="text-xs px-2.5 py-1 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700 transition-colors">
                  Draft renewal review
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

// ── Relationship Management ────────────────────────────────────

const SCORECARDS: Record<CompanyId, { label: string; value: string; sub: string; color: string }[]> = {
  tcp: [
    { label: 'On-time delivery', value: '96%', sub: 'across 12 vendors, trailing 90 days', color: 'text-emerald-300' },
    { label: 'SLA compliance', value: '99.2%', sub: '1 breach this quarter (DataDog)', color: 'text-emerald-300' },
    { label: 'Spend YTD', value: '$187K', sub: 'of $340K annual committed', color: 'text-white' },
    { label: 'Open issues', value: '2', sub: '1 billing dispute, 1 SLA credit', color: 'text-amber-300' },
  ],
  pwc: [
    { label: 'On-time delivery', value: '93%', sub: 'across 8 vendors, trailing 90 days', color: 'text-emerald-300' },
    { label: 'SLA compliance', value: '98.1%', sub: '2 breaches this quarter', color: 'text-amber-300' },
    { label: 'Spend YTD', value: '$291K', sub: 'of $520K annual committed', color: 'text-white' },
    { label: 'Open issues', value: '3', sub: '2 vendors under review', color: 'text-amber-300' },
  ],
};

const REVIEWS: Record<CompanyId, { vendor: string; quarter: string; date: string; owner: string; status: string }[]> = {
  tcp: [
    { vendor: 'AWS', quarter: 'Q3 2026', date: 'Jul 22', owner: 'R. Patel', status: 'Scheduled' },
    { vendor: 'Salesforce', quarter: 'Q3 2026', date: 'Aug 5', owner: 'K. Douglas', status: 'Scheduled' },
    { vendor: 'Zendesk', quarter: 'Q3 2026', date: 'Aug 19', owner: 'R. Patel', status: 'Prep in progress' },
    { vendor: 'DataDog', quarter: 'Q2 2026', date: 'Jun 12', owner: 'R. Patel', status: 'Completed' },
  ],
  pwc: [
    { vendor: 'Thomson Reuters', quarter: 'Q3 2026', date: 'Jul 18', owner: 'P. Nolan', status: 'Prep in progress' },
    { vendor: 'Iron Mountain', quarter: 'Q3 2026', date: 'Jul 30', owner: 'F. Osei', status: 'Under review' },
    { vendor: 'CaseWare', quarter: 'Q3 2026', date: 'Aug 12', owner: 'P. Nolan', status: 'Scheduled' },
    { vendor: 'LexisNexis', quarter: 'Q2 2026', date: 'Jun 3', owner: 'F. Osei', status: 'Completed' },
  ],
};

const reviewBadge = (s: string) => {
  if (s === 'Completed') return 'bg-emerald-500/15 text-emerald-300';
  if (s === 'Under review') return 'bg-amber-500/15 text-amber-300';
  if (s === 'Prep in progress') return 'bg-indigo-500/15 text-indigo-300';
  return 'bg-slate-700/50 text-slate-300';
};

export const VendorManagementPage = ({ setPage: _setPage }: { setPage?: (p: Page) => void }) => {
  const { activeCompanyId } = useAuth();
  const dataMode = useDataMode();
  const cards = SCORECARDS[activeCompanyId];
  const reviews = REVIEWS[activeCompanyId];

  if (dataMode === 'live') return <VendorNotYetAvailable title="Relationship Management — Vendor entity" setPage={_setPage} />;

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageHeader title="Relationship Management — Vendor entity" subtitle="Vendor performance scorecards and quarterly business reviews" />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {cards.map(c => (
          <div key={c.label} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">{c.label}</p>
            <p className={`text-xl font-bold ${c.color}`}>{c.value}</p>
            <p className="text-xs text-slate-500 mt-0.5">{c.sub}</p>
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
        <h3 className="text-sm font-semibold text-white mb-3">Quarterly review schedule</h3>
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-slate-800">
                {['Vendor', 'Quarter', 'Date', 'Owner', 'Status'].map(h => <th key={h} className={th}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {reviews.map((r, i) => (
                <tr key={r.vendor} className={`border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors ${i === reviews.length - 1 ? 'border-b-0' : ''}`}>
                  <td className={`${td} font-medium text-white`}>{r.vendor}</td>
                  <td className={`${td} text-slate-400 text-xs`}>{r.quarter}</td>
                  <td className={`${td} text-slate-300 text-xs whitespace-nowrap`}>{r.date}</td>
                  <td className={`${td} text-slate-300 text-xs`}>{r.owner} <span className="text-slate-600">(human)</span></td>
                  <td className={td}><span className={`text-xs px-2 py-0.5 rounded-full ${reviewBadge(r.status)}`}>{r.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[11px] text-slate-500">
          A Vendor DE could prepare QBR packs automatically from spend, SLA, and issue data — this entity is currently human-run.
        </p>
      </div>
    </div>
  );
};
