import React from 'react';
import { useAuth } from '../../../context/AuthContext';
import type { Page } from '../../../types';
import type { CompanyId } from '../../../data/companies';
import { useDataMode } from '../../../lib/dataMode';
import ImportCustomersModal from '../../../components/ImportCustomersModal';

// ── Seed data (reconciled with src/data/companies.ts) ──────────

interface JourneyStage {
  page: Page;
  label: string;
  icon: string;
  stat: string;
  statColor: string;
}

const JOURNEY_STAGES: Record<CompanyId, JourneyStage[]> = {
  tcp: [
    { page: 'entity_customer_bd', label: 'Business Development', icon: '◎', stat: '14 prospects', statColor: 'text-indigo-300' },
    { page: 'entity_customer_sales', label: 'Sales', icon: '↗', stat: '12 open opps', statColor: 'text-indigo-300' },
    { page: 'entity_customer_onboarding', label: 'Onboarding', icon: '⚙', stat: '2 projects', statColor: 'text-amber-300' },
    { page: 'entity_customer_support', label: 'Support', icon: '💬', stat: '47 tickets', statColor: 'text-emerald-300' },
    { page: 'entity_customer_success', label: 'Success', icon: '♥', stat: '3 at-risk', statColor: 'text-red-300' },
    { page: 'entity_customer_renewal', label: 'Renewal & Expansion', icon: '⟳', stat: '8 due this quarter', statColor: 'text-amber-300' },
  ],
  pwc: [
    { page: 'entity_customer_bd', label: 'Business Development', icon: '◎', stat: '6 pursuits', statColor: 'text-indigo-300' },
    { page: 'entity_customer_sales', label: 'Sales', icon: '↗', stat: '3 proposals', statColor: 'text-indigo-300' },
    { page: 'entity_customer_onboarding', label: 'Onboarding', icon: '⚙', stat: '1 engagement setup', statColor: 'text-amber-300' },
    { page: 'entity_customer_support', label: 'Support', icon: '💬', stat: '—', statColor: 'text-slate-500' },
    { page: 'entity_customer_success', label: 'Success', icon: '♥', stat: '4 engagements', statColor: 'text-emerald-300' },
    { page: 'entity_customer_renewal', label: 'Renewal & Expansion', icon: '⟳', stat: '2 renewals', statColor: 'text-amber-300' },
  ],
};

interface AssignedDE {
  name: string;
  role: string;
  confidence: number;
  health: 'green' | 'amber' | 'red';
}

const ASSIGNED_DES: Record<CompanyId, AssignedDE[]> = {
  tcp: [
    { name: 'Alex', role: 'Customer Support DE', confidence: 91, health: 'green' },
    { name: 'Casey', role: 'Renewal DE', confidence: 88, health: 'green' },
  ],
  pwc: [
    { name: 'Morgan', role: 'Client Relations DE', confidence: 87, health: 'green' },
  ],
};

interface ActivityItem {
  stage: string;
  time: string;
  text: string;
  tone: 'ok' | 'warn' | 'alert' | 'info';
}

const ACTIVITY: Record<CompanyId, ActivityItem[]> = {
  tcp: [
    { stage: 'Support', time: '2 min ago', text: 'Alex resolved — "How do I reset 2FA?" (94% confidence)', tone: 'ok' },
    { stage: 'Support', time: '8 min ago', text: 'Alex escalated — API auth bug to L2 (Apex Systems)', tone: 'warn' },
    { stage: 'Renewal', time: '22 min ago', text: 'Casey sent renewal invoice — Harbor Tech $67K', tone: 'ok' },
    { stage: 'Success', time: '45 min ago', text: 'Casey flagged at-risk — Apex Systems (health: 34)', tone: 'alert' },
    { stage: 'Onboarding', time: '1 hr ago', text: 'DE uploaded 138 employees to Humanity.com — Lakeshore Analytics project', tone: 'ok' },
    { stage: 'Sales', time: '2 hrs ago', text: 'Meridian Group opportunity moved to Negotiation — $156K', tone: 'info' },
    { stage: 'BD', time: '3 hrs ago', text: 'New prospect qualified — Lakeside Retail (inbound demo request)', tone: 'info' },
    { stage: 'Renewal', time: '4 hrs ago', text: 'Casey generated Zuora invoice — Meridian Group renewal', tone: 'ok' },
  ],
  pwc: [
    { stage: 'Success', time: '5 min ago', text: 'Morgan completed client check-in — Harbor Financial engagement', tone: 'ok' },
    { stage: 'Onboarding', time: '30 min ago', text: 'Engagement setup 60% complete — KYC documents verified', tone: 'info' },
    { stage: 'Renewal', time: '45 min ago', text: 'Morgan drafted renewal proposal — Crestview Holdings', tone: 'ok' },
    { stage: 'BD', time: '1 hr ago', text: 'New pursuit added — mid-market advisory mandate', tone: 'info' },
    { stage: 'Sales', time: '2 hrs ago', text: 'Proposal sent — Beacon Capital tax advisory', tone: 'info' },
    { stage: 'Success', time: '3 hrs ago', text: 'Quarterly engagement review scheduled — 4 active engagements', tone: 'info' },
    { stage: 'Renewal', time: '5 hrs ago', text: 'Renewal reminder queued — Sterling Group engagement', tone: 'ok' },
    { stage: 'Success', time: '1 day ago', text: 'Morgan completed KYC — new client onboarding', tone: 'ok' },
  ],
};

const toneBorder = (t: ActivityItem['tone']) =>
  t === 'ok' ? 'border-l-emerald-500' : t === 'warn' ? 'border-l-amber-500' : t === 'alert' ? 'border-l-red-500' : 'border-l-slate-600';

const healthDot = (h: AssignedDE['health']) =>
  h === 'green' ? 'bg-emerald-400' : h === 'amber' ? 'bg-amber-400' : 'bg-red-400';

const CustomerOverviewPage = ({ setPage }: { setPage: (p: Page) => void }) => {
  const { activeCompanyId, activeCompany, liveTenantName } = useAuth();
  const stages = JOURNEY_STAGES[activeCompanyId];
  const des = ASSIGNED_DES[activeCompanyId];
  const activity = ACTIVITY[activeCompanyId];
  const dataMode = useDataMode();
  const [showImport, setShowImport] = React.useState(false);

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Customer Lifecycle</h1>
          <p className="text-slate-400 text-sm mt-1">One relationship, end-to-end — no handoffs</p>
          <p className="text-xs text-slate-600 mt-0.5">
            {dataMode === 'live' ? (liveTenantName || 'Your company') : `${activeCompany.name} · ${activeCompany.industry}`}
          </p>
          {dataMode === 'live' && (
            <p className="text-[11px] text-slate-500 mt-1">Jump to any stage below to manage it. Import your customers to populate this view.</p>
          )}
        </div>
        {dataMode === 'live' && (
          <button
            onClick={() => setShowImport(true)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 transition-colors"
          >
            + Import
          </button>
        )}
      </div>
      {showImport && (
        <ImportCustomersModal initialTab="accounts" onClose={() => setShowImport(false)} onImported={() => {}} />
      )}

      {/* Journey bar */}
      <div className="mb-8">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Customer journey</h2>
        <div className="flex items-stretch gap-1 overflow-x-auto pb-2">
          {stages.map((s, i) => (
            <React.Fragment key={s.page}>
              <button
                onClick={() => setPage(s.page)}
                className="flex-shrink-0 w-40 text-left rounded-xl p-3.5 border border-slate-800 bg-slate-900 hover:border-indigo-500/50 hover:bg-indigo-500/5 transition-all group"
              >
                <div className="text-lg mb-1.5">{s.icon}</div>
                <p className="text-xs font-semibold text-white leading-tight mb-1 group-hover:text-indigo-200">{s.label}</p>
                {dataMode === 'live'
                  ? <p className="text-xs font-medium text-slate-500">Open →</p>
                  : <p className={`text-xs font-medium ${s.statColor}`}>{s.stat}</p>}
              </button>
              {i < stages.length - 1 && (
                <div className="flex-shrink-0 self-center text-slate-700 text-lg px-0.5">→</div>
              )}
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* Assigned DEs */}
      <div className="mb-8">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Digital Employees on this entity</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {dataMode === 'live' ? (
            <button
              onClick={() => setPage('workforce_des')}
              className="col-span-full flex items-center justify-center rounded-xl p-4 border border-dashed border-slate-800 text-xs text-slate-500 hover:border-slate-600"
            >
              Assign Digital Employees to your customer stages from the Roster →
            </button>
          ) : des.map(de => (
            <button
              key={de.name}
              onClick={() => setPage('workforce_des')}
              className="flex items-center gap-3 text-left rounded-xl p-4 border border-slate-800 bg-slate-900 hover:border-slate-600 transition-all"
            >
              <div className="w-10 h-10 rounded-full bg-indigo-600 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
                {de.name[0]}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full ${healthDot(de.health)}`} />
                  <span className="text-sm font-semibold text-white">{de.name}</span>
                </div>
                <p className="text-xs text-slate-400 truncate">{de.role}</p>
              </div>
              <div className="text-right flex-shrink-0">
                <p className="text-sm font-bold text-emerald-400">{de.confidence}%</p>
                <p className="text-[10px] text-slate-500">confidence</p>
              </div>
            </button>
          ))}
          {dataMode !== 'live' && activeCompanyId === 'tcp' && (
            <div className="flex items-center justify-center rounded-xl p-4 border border-dashed border-slate-800 text-xs text-slate-600">
              BD & Sales handled by humans — no DE assigned yet
            </div>
          )}
        </div>
      </div>

      {/* Cross-stage activity */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <h2 className="text-sm font-semibold text-white mb-4">Recent cross-stage activity</h2>
        <div className="space-y-2">
          {dataMode === 'live' && (
            <p className="text-xs text-slate-500 py-2">Activity across your customer stages will appear here as your Digital Employees work.</p>
          )}
          {dataMode !== 'live' && activity.map((item, i) => (
            <div key={i} className={`border-l-2 pl-3 py-1 ${toneBorder(item.tone)}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2 flex-1 min-w-0">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 flex-shrink-0 mt-0.5">{item.stage}</span>
                  <p className="text-xs text-slate-300 leading-relaxed">{item.text}</p>
                </div>
                <span className="text-xs text-slate-600 flex-shrink-0">{item.time}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default CustomerOverviewPage;
