import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../../context/AuthContext';
import type { Page } from '../../../types';
import type { CompanyId } from '../../../data/companies';
import { PageHeader, th, td } from '../../../components/ui';
import { useDataMode } from '../../../lib/dataMode';
import { listAccounts, createAccount, fmtMoneyK, CustomerApiError } from '../../../lib/customerApi';
import type { CustomerAccount } from '../../../lib/customerApi';
import { LiveLoadingSkeleton, MissingTablesNotice, LiveEmptyState } from '../../../components/LiveDataStates';
import ImportCustomersModal from '../../../components/ImportCustomersModal';

// ============================================================
// Customer journey pages: Business Development, Sales, Success.
// Lighter than the migrated pages but fully seeded and
// company-aware. Numbers reconciled with companies.ts and
// DashboardPage ($2.1M TCP pipeline, 12 opps, 3 at-risk, etc).
// ============================================================



// ── Business Development ───────────────────────────────────────

interface Prospect {
  company: string;
  stage: string;
  source: string;
  owner: string;
  ownerIsDE: boolean;
  lastTouch: string;
}

const PROSPECTS: Record<CompanyId, Prospect[]> = {
  tcp: [
    { company: 'Lakeside Retail', stage: 'Qualified', source: 'Inbound demo request', owner: 'J. Cooper', ownerIsDE: false, lastTouch: '3 hrs ago' },
    { company: 'Vertex Logistics', stage: 'Contacted', source: 'Outbound sequence', owner: 'S. Mitchell', ownerIsDE: false, lastTouch: '1 day ago' },
    { company: 'BluePeak Media', stage: 'New', source: 'Webinar signup', owner: 'J. Cooper', ownerIsDE: false, lastTouch: '1 day ago' },
    { company: 'Orchard Health', stage: 'Qualified', source: 'Referral — Northfield Co', owner: 'S. Mitchell', ownerIsDE: false, lastTouch: '2 days ago' },
    { company: 'Ridgeline Manufacturing', stage: 'Contacted', source: 'Trade show', owner: 'J. Cooper', ownerIsDE: false, lastTouch: '2 days ago' },
    { company: 'Summit Legal', stage: 'New', source: 'Content download', owner: 'Unassigned', ownerIsDE: false, lastTouch: '3 days ago' },
    { company: 'Cobalt Energy', stage: 'Nurture', source: 'Outbound sequence', owner: 'S. Mitchell', ownerIsDE: false, lastTouch: '5 days ago' },
    { company: 'Fairview Foods', stage: 'Nurture', source: 'Website chat', owner: 'J. Cooper', ownerIsDE: false, lastTouch: '1 week ago' },
  ],
  pwc: [
    { company: 'Beacon Capital', stage: 'Qualified', source: 'Partner referral', owner: 'D. Whitmore', ownerIsDE: false, lastTouch: '2 hrs ago' },
    { company: 'Ironwood Estates', stage: 'Contacted', source: 'Existing client expansion', owner: 'L. Ahmed', ownerIsDE: false, lastTouch: '1 day ago' },
    { company: 'Meridian Trust', stage: 'New', source: 'Industry event', owner: 'D. Whitmore', ownerIsDE: false, lastTouch: '2 days ago' },
    { company: 'Halcyon Ventures', stage: 'Qualified', source: 'Partner referral', owner: 'L. Ahmed', ownerIsDE: false, lastTouch: '3 days ago' },
    { company: 'Stonebridge Group', stage: 'Nurture', source: 'Alumni network', owner: 'D. Whitmore', ownerIsDE: false, lastTouch: '1 week ago' },
    { company: 'Crescent Partners', stage: 'Nurture', source: 'Industry event', owner: 'L. Ahmed', ownerIsDE: false, lastTouch: '2 weeks ago' },
  ],
};

const FUNNEL: Record<CompanyId, { stage: string; count: number; color: string }[]> = {
  tcp: [
    { stage: 'Prospects', count: 14, color: 'bg-indigo-500' },
    { stage: 'Contacted', count: 9, color: 'bg-indigo-400' },
    { stage: 'Qualified', count: 5, color: 'bg-emerald-500' },
    { stage: 'Handed to Sales', count: 3, color: 'bg-emerald-400' },
  ],
  pwc: [
    { stage: 'Pursuits', count: 6, color: 'bg-indigo-500' },
    { stage: 'Contacted', count: 4, color: 'bg-indigo-400' },
    { stage: 'Qualified', count: 2, color: 'bg-emerald-500' },
    { stage: 'Proposal stage', count: 1, color: 'bg-emerald-400' },
  ],
};

const stageBadge = (stage: string) => {
  if (stage === 'Qualified') return 'bg-emerald-500/15 text-emerald-300';
  if (stage === 'Contacted') return 'bg-indigo-500/15 text-indigo-300';
  if (stage === 'Nurture') return 'bg-amber-500/15 text-amber-300';
  return 'bg-slate-700/50 text-slate-300';
};

export const CustomerBDPage = ({ setPage: _setPage }: { setPage?: (p: Page) => void }) => {
  const { activeCompanyId, activeCompany } = useAuth();
  const prospects = PROSPECTS[activeCompanyId];
  const funnel = FUNNEL[activeCompanyId];
  const maxCount = funnel[0].count;
  const isTcp = activeCompanyId === 'tcp';

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageHeader
        title="Business Development — Customer Lifecycle"
        subtitle={isTcp ? '14 active prospects moving toward Sales' : `6 active pursuits across ${activeCompany.name} practice areas`}
      />

      <div className="mb-5 flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3">
        <span className="text-slate-500">◎</span>
        <p className="text-xs text-slate-400">
          DE not yet assigned to Business Development — this stage is handled by humans. Activity is still
          tracked here so a DE can take over qualification later.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Prospect table */}
        <div className="lg:col-span-2 rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
          <h3 className="text-sm font-semibold text-white mb-3">{isTcp ? 'Prospect list' : 'Pursuit list'}</h3>
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-slate-800">
                  {['Company', 'Stage', 'Source', 'Owner', 'Last Touch'].map(h => <th key={h} className={th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {prospects.map((p, i) => (
                  <tr key={p.company} className={`border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors ${i === prospects.length - 1 ? 'border-b-0' : ''}`}>
                    <td className={`${td} font-medium text-white`}>{p.company}</td>
                    <td className={td}><span className={`text-xs px-2 py-0.5 rounded-full ${stageBadge(p.stage)}`}>{p.stage}</span></td>
                    <td className={`${td} text-slate-400 text-xs`}>{p.source}</td>
                    <td className={`${td} text-slate-300 text-xs`}>{p.owner} <span className="text-slate-600">({p.ownerIsDE ? 'DE' : 'human'})</span></td>
                    <td className={`${td} text-slate-500 text-xs whitespace-nowrap`}>{p.lastTouch}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Funnel */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
          <h3 className="text-sm font-semibold text-white mb-4">Pipeline funnel</h3>
          <div className="space-y-3">
            {funnel.map(f => (
              <div key={f.stage}>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="text-slate-400">{f.stage}</span>
                  <span className="text-white font-medium">{f.count}</span>
                </div>
                <div className="h-3 bg-slate-800 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full ${f.color}`} style={{ width: `${(f.count / maxCount) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-slate-500 mt-4">
            {isTcp
              ? 'Conversion prospect → qualified: 36% this quarter.'
              : 'Pursuits are sourced primarily through partner referrals and industry events.'}
          </p>
        </div>
      </div>
    </div>
  );
};

// ── Sales ──────────────────────────────────────────────────────

interface Opportunity {
  name: string;
  value: string;
  stage: string;
  closeDate: string;
  owner: string;
}

const OPPORTUNITIES: Record<CompanyId, Opportunity[]> = {
  tcp: [
    { name: 'Ironbridge Systems — Enterprise', value: '$156K', stage: 'Negotiation', closeDate: 'Jul 18', owner: 'J. Cooper' },
    { name: 'Lakeside Retail — Growth', value: '$96K', stage: 'Proposal', closeDate: 'Jul 25', owner: 'S. Mitchell' },
    { name: 'Vertex Logistics — Growth', value: '$84K', stage: 'Demo', closeDate: 'Aug 1', owner: 'J. Cooper' },
    { name: 'Orchard Health — Enterprise', value: '$210K', stage: 'Proposal', closeDate: 'Aug 8', owner: 'S. Mitchell' },
    { name: 'BluePeak Media — Starter', value: '$36K', stage: 'Discovery', closeDate: 'Aug 15', owner: 'J. Cooper' },
    { name: 'Ridgeline Manufacturing — Growth', value: '$120K', stage: 'Demo', closeDate: 'Aug 22', owner: 'S. Mitchell' },
    { name: 'Summit Legal — Starter', value: '$42K', stage: 'Discovery', closeDate: 'Aug 29', owner: 'J. Cooper' },
    { name: 'Cobalt Energy — Enterprise', value: '$340K', stage: 'Negotiation', closeDate: 'Sep 5', owner: 'S. Mitchell' },
    { name: 'Fairview Foods — Growth', value: '$88K', stage: 'Discovery', closeDate: 'Sep 12', owner: 'J. Cooper' },
    { name: 'Harborview Clinics — Growth', value: '$132K', stage: 'Demo', closeDate: 'Sep 19', owner: 'S. Mitchell' },
    { name: 'Atlas Freight — Enterprise', value: '$496K', stage: 'Proposal', closeDate: 'Sep 26', owner: 'J. Cooper' },
    { name: 'Juniper Analytics — Growth', value: '$300K', stage: 'Discovery', closeDate: 'Oct 3', owner: 'S. Mitchell' },
  ],
  pwc: [
    { name: 'Beacon Capital — Tax Advisory', value: '$180K', stage: 'Proposal sent', closeDate: 'Jul 30', owner: 'D. Whitmore' },
    { name: 'Halcyon Ventures — Audit', value: '$240K', stage: 'Proposal sent', closeDate: 'Aug 12', owner: 'L. Ahmed' },
    { name: 'Ironwood Estates — Advisory', value: '$95K', stage: 'Proposal drafting', closeDate: 'Aug 28', owner: 'D. Whitmore' },
  ],
};

const oppStageBadge = (stage: string) => {
  if (stage.startsWith('Negotiation')) return 'bg-emerald-500/15 text-emerald-300';
  if (stage.startsWith('Proposal')) return 'bg-indigo-500/15 text-indigo-300';
  if (stage === 'Demo') return 'bg-sky-500/15 text-sky-300';
  return 'bg-slate-700/50 text-slate-300';
};

export const CustomerSalesPage = ({ setPage: _setPage }: { setPage?: (p: Page) => void }) => {
  const { activeCompanyId, activeCompany } = useAuth();
  const opps = OPPORTUNITIES[activeCompanyId];
  const isTcp = activeCompanyId === 'tcp';
  const totalLabel = isTcp ? '$2.1M' : '$515K';

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageHeader
        title="Sales — Customer Lifecycle"
        subtitle={isTcp ? 'Pipeline management, proposals, demos, and deal closing' : `Proposals in flight across ${activeCompany.name} practice areas`}
      />

      {/* Stat cards */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        {[
          { label: 'Total pipeline value', value: totalLabel, sub: isTcp ? '12 open opportunities' : '3 open proposals', color: 'text-white' },
          { label: isTcp ? 'In negotiation' : 'Proposals sent', value: isTcp ? '2' : '2', sub: isTcp ? '$496K combined' : '$420K combined', color: 'text-emerald-300' },
          { label: 'Avg deal size', value: isTcp ? '$175K' : '$172K', sub: 'this quarter', color: 'text-indigo-300' },
        ].map(s => (
          <div key={s.label} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">{s.label}</p>
            <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
            <p className="text-xs text-slate-500 mt-0.5">{s.sub}</p>
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
        <h3 className="text-sm font-semibold text-white mb-3">Open opportunities</h3>
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-slate-800">
                {['Opportunity', 'Value', 'Stage', 'Close Date', 'Owner'].map(h => <th key={h} className={th}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {opps.map((o, i) => (
                <tr key={o.name} className={`border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors ${i === opps.length - 1 ? 'border-b-0' : ''}`}>
                  <td className={`${td} font-medium text-white`}>{o.name}</td>
                  <td className={`${td} text-slate-300`}>{o.value}</td>
                  <td className={td}><span className={`text-xs px-2 py-0.5 rounded-full ${oppStageBadge(o.stage)}`}>{o.stage}</span></td>
                  <td className={`${td} text-slate-400 text-xs whitespace-nowrap`}>{o.closeDate}</td>
                  <td className={`${td} text-slate-300 text-xs`}>{o.owner}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[11px] text-slate-500">
          Sales is currently human-led. Won deals hand off automatically to Onboarding — no re-entry, no dropped context.
        </p>
      </div>
    </div>
  );
};

// ── Customer Success ───────────────────────────────────────────

interface Account {
  name: string;
  health: number;
  arr: string;
  csm: string;
  trend: 'up' | 'down' | 'flat';
  note?: string;
}

const ACCOUNTS: Record<CompanyId, Account[]> = {
  tcp: [
    { name: 'Northfield Co', health: 81, arr: '$210K', csm: 'P. Sharma', trend: 'up' },
    { name: 'Lakeshore Analytics', health: 72, arr: '$84K', csm: 'P. Sharma', trend: 'flat' },
    { name: 'Harbor Tech', health: 61, arr: '$67K', csm: 'T. Smith', trend: 'up' },
    { name: 'Meridian Group', health: 58, arr: '$156K', csm: 'T. Smith', trend: 'down', note: 'Renewal at risk — invoice pending' },
    { name: 'Brightline Studios', health: 76, arr: '$52K', csm: 'P. Sharma', trend: 'up' },
    { name: 'Kestrel Systems', health: 68, arr: '$91K', csm: 'J. Lee', trend: 'flat' },
    { name: 'Apex Systems', health: 34, arr: '$43K', csm: 'J. Lee', trend: 'down', note: 'Open P1 escalation — API auth failure' },
    { name: 'Silverpine Labs', health: 44, arr: '$38K', csm: 'T. Smith', trend: 'down', note: 'Usage dropped 40% in 30 days' },
    { name: 'Crownfield Insurance', health: 39, arr: '$74K', csm: 'P. Sharma', trend: 'down', note: 'Champion left the company' },
    { name: 'Oakhurst Retail', health: 83, arr: '$110K', csm: 'J. Lee', trend: 'up' },
    { name: 'Pinnacle Freight', health: 71, arr: '$66K', csm: 'T. Smith', trend: 'flat' },
    { name: 'Waverly Health', health: 78, arr: '$95K', csm: 'P. Sharma', trend: 'up' },
  ],
  pwc: [
    { name: 'Harbor Financial — Audit', health: 82, arr: '$310K', csm: 'D. Whitmore', trend: 'up' },
    { name: 'Crestview Holdings — Advisory', health: 74, arr: '$120K', csm: 'L. Ahmed', trend: 'flat' },
    { name: 'Sterling Group — Tax', health: 69, arr: '$85K', csm: 'D. Whitmore', trend: 'flat' },
    { name: 'Beacon Capital — Advisory', health: 47, arr: '$60K', csm: 'L. Ahmed', trend: 'down', note: 'Deliverable deadline slipped twice' },
  ],
};

const healthColor = (h: number) => (h >= 70 ? 'bg-emerald-500' : h >= 45 ? 'bg-amber-500' : 'bg-red-500');
const healthText = (h: number) => (h >= 70 ? 'text-emerald-300' : h >= 45 ? 'text-amber-300' : 'text-red-300');
const trendIcon = (t: Account['trend']) => (t === 'up' ? '↑' : t === 'down' ? '↓' : '→');

// ── LIVE mode: real accounts from Supabase ─────────────────────
function LiveCustomerSuccess() {
  const { liveTenantName } = useAuth();
  const [accounts, setAccounts] = useState<CustomerAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [missingTables, setMissingTables] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newArr, setNewArr] = useState('');
  const [newCsm, setNewCsm] = useState('');
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setAccounts(await listAccounts());
      setMissingTables(false);
    } catch (err) {
      if (err instanceof CustomerApiError && err.missingTables) setMissingTables(true);
      else setError((err as Error)?.message || 'Failed to load accounts.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const addAccount = async () => {
    if (!newName.trim()) return;
    setSaving(true);
    try {
      await createAccount({
        name: newName.trim(),
        arr_cents: Math.round((parseFloat(newArr) || 0) * 100),
        csm: newCsm.trim(),
      });
      setShowAdd(false);
      setNewName(''); setNewArr(''); setNewCsm('');
      void refresh();
    } catch (err) {
      setError((err as Error)?.message || 'Failed to add account.');
    } finally {
      setSaving(false);
    }
  };

  const atRisk = accounts.filter(a => a.status === 'at_risk' || a.health_score < 45);

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <PageHeader
          title="Customer Success — Customer Lifecycle"
          subtitle={`${liveTenantName || 'Your company'} · ${accounts.length} account${accounts.length === 1 ? '' : 's'} · ${atRisk.length} at risk`}
        />
        {!missingTables && !loading && accounts.length > 0 && (
          <div className="flex gap-2">
            <button onClick={() => setShowImport(true)} className="px-3 py-1.5 rounded-lg text-xs text-slate-300 border border-slate-700 hover:border-slate-500 hover:text-white transition-colors">
              + Import CSV
            </button>
            <button onClick={() => setShowAdd(true)} className="px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 transition-colors">
              + Add account
            </button>
          </div>
        )}
      </div>

      {error && <div className="mb-4 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{error}</div>}

      {loading ? (
        <LiveLoadingSkeleton rows={5} />
      ) : missingTables ? (
        <MissingTablesNotice />
      ) : accounts.length === 0 ? (
        <LiveEmptyState
          icon="◎"
          title="No accounts yet"
          body="Bring your customer accounts into DreamTeam so your Digital Employees can monitor health, renewals, and support in one place."
          primaryLabel="Import CSV"
          onPrimary={() => setShowImport(true)}
          secondaryLabel="Add account"
          onSecondary={() => setShowAdd(true)}
        />
      ) : (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
          <h3 className="text-sm font-semibold text-white mb-3">Account health</h3>
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-slate-800">
                  {['Account', 'Health', 'ARR', 'CSM', 'Status', 'Renewal'].map(h => <th key={h} className={th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {accounts.map((a, i) => {
                  const risk = a.status === 'at_risk' || a.health_score < 45;
                  return (
                    <tr key={a.id} className={`border-b border-slate-800/60 transition-colors ${risk ? 'bg-red-500/5 hover:bg-red-500/10' : 'hover:bg-slate-800/30'} ${i === accounts.length - 1 ? 'border-b-0' : ''}`}>
                      <td className={`${td} font-medium ${risk ? 'text-red-200' : 'text-white'}`}>{a.name}</td>
                      <td className={td}>
                        <div className="flex items-center gap-2 min-w-[110px]">
                          <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${healthColor(a.health_score)}`} style={{ width: `${a.health_score}%` }} />
                          </div>
                          <span className={`text-xs font-medium w-6 text-right ${healthText(a.health_score)}`}>{a.health_score}</span>
                        </div>
                      </td>
                      <td className={`${td} text-slate-300 text-xs`}>{fmtMoneyK(a.arr_cents)}</td>
                      <td className={`${td} text-slate-400 text-xs`}>{a.csm || '—'}</td>
                      <td className={td}>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${
                          a.status === 'churned' ? 'bg-slate-700/50 text-slate-400'
                          : a.status === 'at_risk' ? 'bg-red-500/15 text-red-300'
                          : 'bg-emerald-500/15 text-emerald-300'
                        }`}>{a.status.replace('_', ' ')}</span>
                      </td>
                      <td className={`${td} text-slate-500 text-xs whitespace-nowrap`}>{a.renewal_date || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add account modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <h3 className="text-white font-semibold mb-4">Add account</h3>
            <div className="space-y-3 mb-5">
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1">Account name</label>
                <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Acme Corp"
                  className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-3 py-2 placeholder-slate-500 focus:outline-none focus:border-indigo-500" />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1">ARR ($/year)</label>
                <input value={newArr} onChange={e => setNewArr(e.target.value)} placeholder="84000" type="number"
                  className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-3 py-2 placeholder-slate-500 focus:outline-none focus:border-indigo-500" />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1">CSM</label>
                <input value={newCsm} onChange={e => setNewCsm(e.target.value)} placeholder="P. Sharma"
                  className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-3 py-2 placeholder-slate-500 focus:outline-none focus:border-indigo-500" />
              </div>
            </div>
            <div className="flex gap-3">
              <button onClick={addAccount} disabled={saving || !newName.trim()}
                className="flex-1 py-2 text-sm font-medium rounded-lg text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 transition-all">
                {saving ? 'Saving…' : 'Add account'}
              </button>
              <button onClick={() => setShowAdd(false)} className="flex-1 py-2 text-sm rounded-lg border border-slate-700 text-slate-300 hover:border-slate-500 transition-all">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showImport && (
        <ImportCustomersModal initialTab="accounts" onClose={() => setShowImport(false)} onImported={() => void refresh()} />
      )}
    </div>
  );
}

export const CustomerSuccessPage = ({ setPage }: { setPage?: (p: Page) => void }) => {
  const dataMode = useDataMode();
  if (dataMode === 'live') return <LiveCustomerSuccess />;
  return <DemoCustomerSuccess setPage={setPage} />;
};

const DemoCustomerSuccess = ({ setPage }: { setPage?: (p: Page) => void }) => {
  const { activeCompanyId, activeCompany } = useAuth();
  const accounts = ACCOUNTS[activeCompanyId];
  const isTcp = activeCompanyId === 'tcp';
  const atRisk = accounts.filter(a => a.health < 45);

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageHeader
        title="Customer Success — Customer Lifecycle"
        subtitle={isTcp
          ? `12 accounts monitored — ${atRisk.length} at-risk flagged by Casey`
          : `4 active engagements monitored for ${activeCompany.name}`}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Account health table */}
        <div className="lg:col-span-2 rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
          <h3 className="text-sm font-semibold text-white mb-3">{isTcp ? 'Account health' : 'Engagement health'}</h3>
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-slate-800">
                  {[isTcp ? 'Account' : 'Engagement', 'Health', 'ARR', 'CSM', 'Trend'].map(h => <th key={h} className={th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {accounts.map((a, i) => {
                  const risk = a.health < 45;
                  return (
                    <tr key={a.name} className={`border-b border-slate-800/60 transition-colors ${risk ? 'bg-red-500/5 hover:bg-red-500/10' : 'hover:bg-slate-800/30'} ${i === accounts.length - 1 ? 'border-b-0' : ''}`}>
                      <td className={`${td} font-medium ${risk ? 'text-red-200' : 'text-white'}`}>{a.name}</td>
                      <td className={td}>
                        <div className="flex items-center gap-2 min-w-[110px]">
                          <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${healthColor(a.health)}`} style={{ width: `${a.health}%` }} />
                          </div>
                          <span className={`text-xs font-medium w-6 text-right ${healthText(a.health)}`}>{a.health}</span>
                        </div>
                      </td>
                      <td className={`${td} text-slate-300 text-xs`}>{a.arr}</td>
                      <td className={`${td} text-slate-400 text-xs`}>{a.csm}</td>
                      <td className={`${td} text-xs ${a.trend === 'up' ? 'text-emerald-400' : a.trend === 'down' ? 'text-red-400' : 'text-slate-500'}`}>{trendIcon(a.trend)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* At-risk action panel */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
          <h3 className="text-sm font-semibold text-white mb-1">At-risk accounts</h3>
          <p className="text-xs text-slate-500 mb-4">
            {isTcp ? 'Flagged by Casey from health, usage, and escalation signals' : 'Flagged by Morgan from engagement delivery signals'}
          </p>
          <div className="space-y-3">
            {atRisk.map(a => (
              <div key={a.name} className="rounded-xl border border-red-500/30 bg-red-500/5 p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-red-200">{a.name}</span>
                  <span className="text-xs font-bold text-red-300">health {a.health}</span>
                </div>
                {a.note && <p className="text-xs text-slate-400 mb-2">{a.note}</p>}
                <div className="flex gap-2">
                  <button className="text-xs px-2.5 py-1 rounded-lg bg-red-600/20 text-red-300 hover:bg-red-600/40 transition-colors">Open save play</button>
                  {setPage && (
                    <button onClick={() => setPage('entity_customer_renewal')} className="text-xs px-2.5 py-1 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700 transition-colors">
                      View renewal →
                    </button>
                  )}
                </div>
              </div>
            ))}
            {atRisk.length === 0 && (
              <p className="text-xs text-slate-500">No at-risk accounts right now.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
