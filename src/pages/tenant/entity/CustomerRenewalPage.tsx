import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../../context/AuthContext';
import type { Page } from '../../../types';

// ============================================================
// Renewal & Expansion — Customer entity
// RenewalsPipeline migrated from FinanceControlTowerPage
// (Zuora/Gainsight renewal table + Generate Invoice modal).
// Attributed to Casey (TCP) / Morgan (PWC).
// ============================================================

type RenewalStatus =
  | 'Invoice sent'
  | 'Pending generation'
  | 'Awaiting approval — $15,600'
  | 'Invoice approved — sending'
  | 'Overdue — 8 days'
  | 'Paid ✓'
  | 'Draft';

interface RenewalRow {
  account: string;
  arr: string;
  arrNum: number;
  health: number;
  renewalDate: string;
  status: RenewalStatus;
}

// Meridian's $15,600 invoice is generated and sits in the Human Tasks approval
// queue (task t1) — this table mirrors that state instead of contradicting it.
const INITIAL_RENEWALS: RenewalRow[] = [
  { account: 'Lakeshore Analytics', arr: '$84K', arrNum: 84000, health: 72, renewalDate: 'Jul 31', status: 'Invoice sent' },
  { account: 'Meridian Group', arr: '$156K', arrNum: 156000, health: 58, renewalDate: 'Aug 5', status: 'Awaiting approval — $15,600' },
  { account: 'Apex Systems', arr: '$43K', arrNum: 43000, health: 34, renewalDate: 'Aug 12', status: 'Overdue — 8 days' },
  { account: 'Northfield Co', arr: '$210K', arrNum: 210000, health: 81, renewalDate: 'Aug 18', status: 'Paid ✓' },
  { account: 'Harbor Tech', arr: '$67K', arrNum: 67000, health: 61, renewalDate: 'Aug 22', status: 'Draft' },
  { account: 'Brightline Studios', arr: '$52K', arrNum: 52000, health: 76, renewalDate: 'Aug 28', status: 'Pending generation' },
];

const EXPANSION_OPPS = [
  { account: 'Northfield Co', opportunity: 'Enterprise tier upgrade', value: '$48K ARR uplift', signal: 'Usage at 92% of plan limit', owner: 'Casey' },
  { account: 'Harbor Tech', opportunity: 'Add-on: Analytics module', value: '$18K ARR uplift', signal: '3 analytics feature requests logged', owner: 'Casey' },
  { account: 'Lakeshore Analytics', opportunity: 'Seat expansion (+40 seats)', value: '$22K ARR uplift', signal: 'New department onboarded last month', owner: 'Human (AE)' },
];

const PWC_RENEWALS = [
  { engagement: 'Crestview Holdings — Advisory', fees: '$120K', partner: 'D. Whitmore', renewalDate: 'Aug 15', status: 'Proposal drafted' },
  { engagement: 'Sterling Group — Tax Compliance', fees: '$85K', partner: 'L. Ahmed', renewalDate: 'Sep 1', status: 'Reminder queued' },
];

// Compact dunning-cadence stage per account — mirrors the
// "Collections — cadence status" section on Financial Health
// (steps from the Renewal Lifecycle Playbook: Day-0 → Day-7 → Day-14 → escalate).
const CADENCE_STAGE: Record<string, { label: string; cls: string }> = {
  'Lakeshore Analytics': { label: 'Day-0 ✓', cls: 'text-indigo-300' },
  'Apex Systems': { label: 'Paused (P1)', cls: 'text-amber-300' },
};

function cadenceStage(row: RenewalRow): { label: string; cls: string } {
  if (row.status === 'Paid ✓' || row.status === 'Invoice approved — sending') return { label: '—', cls: 'text-slate-600' };
  return CADENCE_STAGE[row.account] ?? { label: '—', cls: 'text-slate-600' };
}

function healthIndicator(score: number) {
  if (score >= 70) return '🟢';
  if (score >= 40) return '🟡';
  return '🔴';
}

// Reads the Human Tasks decisions overlay — task 't1' (tcp) is the Meridian
// Group invoice approval. When approved there, this table reflects it live.
function meridianDecision(): string | undefined {
  try {
    const stored = localStorage.getItem('dt_ops_tasks_tcp');
    if (stored) return (JSON.parse(stored) as Record<string, string>)['t1'];
  } catch { /* noop */ }
  return undefined;
}

function applyMeridianDecision(rows: RenewalRow[]): RenewalRow[] {
  if (meridianDecision() !== 'approved') return rows;
  return rows.map(r => r.account === 'Meridian Group' && r.status === 'Awaiting approval — $15,600'
    ? { ...r, status: 'Invoice approved — sending' as RenewalStatus }
    : r);
}

function RenewalsPipeline({ setPage }: { setPage?: (p: any) => void }) {
  const [rows, setRows] = useState<RenewalRow[]>(() => applyMeridianDecision(INITIAL_RENEWALS));

  // Live sync with Human Tasks decisions.
  useEffect(() => {
    const refresh = () => setRows(prev => applyMeridianDecision(prev));
    window.addEventListener('dt-state-changed', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('dt-state-changed', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [invoiceModal, setInvoiceModal] = useState<{ account: string; arr: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, type });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  };

  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const handleAction = (row: RenewalRow) => {
    if (row.status === 'Awaiting approval — $15,600') {
      if (setPage) setPage('ops_human_tasks');
    } else if (row.status === 'Pending generation') {
      setInvoiceModal({ account: row.account, arr: row.arr });
    } else if (row.status === 'Draft') {
      setRows(prev => prev.map(r => r.account === row.account ? { ...r, status: 'Invoice sent' } : r));
      showToast(`Invoice emailed to billing@${row.account.toLowerCase().replace(/\s+/g, '')}.com`);
    } else if (row.status === 'Overdue — 8 days') {
      showToast(`CSM notified via Gainsight CTA for ${row.account}`);
    } else if (row.status === 'Invoice sent') {
      showToast(`Opening ${row.account} in Zuora…`);
    }
  };

  const confirmGenerateInvoice = () => {
    if (!invoiceModal) return;
    const invId = 'INV-' + Math.floor(Math.random() * 900000 + 100000);
    setRows(prev => prev.map(r => r.account === invoiceModal.account ? { ...r, status: 'Invoice sent' } : r));
    setInvoiceModal(null);
    showToast(`Invoice ${invId} created in Zuora`);
  };

  const actionLabel = (status: RenewalStatus): string | null => {
    if (status === 'Invoice sent') return 'View';
    if (status === 'Pending generation') return 'Generate Invoice';
    if (status === 'Awaiting approval — $15,600') return 'View approval →';
    if (status === 'Invoice approved — sending') return null;
    if (status === 'Overdue — 8 days') return 'Escalate';
    if (status === 'Paid ✓') return null;
    if (status === 'Draft') return 'Send Invoice';
    return null;
  };

  const actionStyle = (status: RenewalStatus): string => {
    if (status === 'Overdue — 8 days') return 'text-rose-400 border-rose-800/50 hover:border-rose-600';
    if (status === 'Pending generation') return 'text-indigo-300 border-indigo-800/50 hover:border-indigo-500';
    if (status === 'Awaiting approval — $15,600') return 'text-amber-300 border-amber-800/50 hover:border-amber-500';
    return 'text-slate-300 border-slate-700 hover:border-slate-500';
  };

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6">
      {/* Title row */}
      <div className="flex items-center justify-between mb-5 flex-wrap gap-2">
        <div>
          <h3 className="text-base font-semibold text-white">Renewals Pipeline</h3>
          <p className="text-xs text-slate-500 mt-0.5">Upcoming renewals detected via Zuora webhooks · Managed by Casey</p>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-slate-400">
          <span>Powered by</span>
          <span className="px-2 py-0.5 bg-slate-800 border border-slate-700 rounded-lg text-slate-300">💳 Zuora</span>
          <span className="px-2 py-0.5 bg-slate-800 border border-slate-700 rounded-lg text-slate-300">📊 Gainsight</span>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-3 gap-3 mb-5">
        {[
          { label: 'Renewals due in 30 days', value: '8 accounts', sub: '$1.2M ARR', color: 'text-white' },
          { label: 'Invoices pending payment', value: '3', sub: '$248K', color: 'text-amber-300' },
          { label: 'Renewed this month', value: '12', sub: '$890K', color: 'text-emerald-300' },
        ].map(s => (
          <div key={s.label} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">{s.label}</p>
            <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
            <p className="text-xs text-slate-500 mt-0.5">{s.sub}</p>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-slate-800 text-left">
              {['Account', 'ARR', 'Health', 'Renewal Date', 'Invoice Status', 'Cadence', 'Action'].map(h => (
                <th key={h} className="py-2.5 px-4 text-[11px] uppercase tracking-wide text-slate-500 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const btn = actionLabel(row.status);
              return (
                <tr key={row.account} className={`border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors ${i === rows.length - 1 ? 'border-b-0' : ''}`}>
                  <td className="py-3 px-4 font-medium text-white">{row.account}</td>
                  <td className="py-3 px-4 text-slate-300">{row.arr}</td>
                  <td className="py-3 px-4 text-slate-300 whitespace-nowrap">{healthIndicator(row.health)} {row.health}</td>
                  <td className="py-3 px-4 text-slate-300">{row.renewalDate}</td>
                  <td className="py-3 px-4">
                    <span className={`text-xs ${
                      row.status === 'Paid ✓' || row.status === 'Invoice approved — sending' ? 'text-emerald-400' :
                      row.status === 'Overdue — 8 days' ? 'text-rose-400' :
                      row.status === 'Awaiting approval — $15,600' ? 'text-amber-300' :
                      row.status === 'Invoice sent' ? 'text-indigo-300' :
                      'text-slate-400'
                    }`}>{row.status}</span>
                  </td>
                  <td className="py-3 px-4 whitespace-nowrap">
                    {(() => { const c = cadenceStage(row); return <span className={`text-xs ${c.cls}`}>{c.label}</span>; })()}
                  </td>
                  <td className="py-3 px-4">
                    {btn ? (
                      <button
                        onClick={() => handleAction(row)}
                        className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${actionStyle(row.status)}`}
                      >
                        {btn}
                      </button>
                    ) : <span className="text-slate-600 text-xs">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Footer note */}
      <div className="mt-4 flex items-center justify-between flex-wrap gap-2">
        <p className="text-[11px] text-slate-500">
          This pipeline is powered by the Customer Renewal Workflow playbook. Upcoming renewals are detected automatically via Zuora webhooks.
        </p>
        {setPage && (
          <button
            onClick={() => setPage('systems_playbooks')}
            className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors flex-shrink-0"
          >
            View Playbook →
          </button>
        )}
      </div>

      {/* Generate Invoice Modal */}
      {invoiceModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <h3 className="text-white font-semibold mb-2">Generate Zuora Invoice</h3>
            <p className="text-sm text-slate-300 mb-5">
              Generate Zuora invoice for <span className="text-white font-medium">{invoiceModal.account}</span> — <span className="text-indigo-300 font-medium">{invoiceModal.arr}</span>?
            </p>
            <div className="flex gap-3">
              <button
                onClick={confirmGenerateInvoice}
                className="flex-1 py-2 text-sm font-medium rounded-lg text-white bg-indigo-600 hover:bg-indigo-500 transition-all"
              >
                Confirm
              </button>
              <button
                onClick={() => setInvoiceModal(null)}
                className="flex-1 py-2 text-sm rounded-lg border border-slate-700 text-slate-300 hover:border-slate-500 transition-all"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-[100] px-4 py-3 rounded-xl border shadow-xl text-sm font-medium transition-all ${
          toast.type === 'success'
            ? 'bg-emerald-900/90 border-emerald-700/50 text-emerald-300'
            : 'bg-rose-900/90 border-rose-700/50 text-rose-300'
        }`}>
          {toast.message}
        </div>
      )}
    </div>
  );
}

// ── Expansion opportunities (TCP) ──────────────────────────────
function ExpansionOpportunities() {
  return (
    <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-900/50 p-6">
      <div className="mb-4">
        <h3 className="text-base font-semibold text-white">Expansion Opportunities</h3>
        <p className="text-xs text-slate-500 mt-0.5">Upsell signals surfaced by Casey from usage and account data</p>
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-slate-800 text-left">
              {['Account', 'Opportunity', 'Value', 'Signal', 'Owner'].map(h => (
                <th key={h} className="py-2.5 px-4 text-[11px] uppercase tracking-wide text-slate-500 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {EXPANSION_OPPS.map((o, i) => (
              <tr key={o.account + o.opportunity} className={`border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors ${i === EXPANSION_OPPS.length - 1 ? 'border-b-0' : ''}`}>
                <td className="py-3 px-4 font-medium text-white">{o.account}</td>
                <td className="py-3 px-4 text-slate-300">{o.opportunity}</td>
                <td className="py-3 px-4 text-emerald-300">{o.value}</td>
                <td className="py-3 px-4 text-slate-400 text-xs">{o.signal}</td>
                <td className="py-3 px-4">
                  <span className={`text-xs px-2 py-0.5 rounded ${o.owner === 'Casey' ? 'bg-indigo-500/15 text-indigo-300' : 'bg-slate-800 text-slate-400'}`}>{o.owner}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── PWC variant ────────────────────────────────────────────────
function PwcRenewals() {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6">
      <div className="mb-4">
        <h3 className="text-base font-semibold text-white">Engagement Renewals</h3>
        <p className="text-xs text-slate-500 mt-0.5">Upcoming engagement renewals · Managed by Morgan</p>
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-slate-800 text-left">
              {['Engagement', 'Annual Fees', 'Partner', 'Renewal Date', 'Status'].map(h => (
                <th key={h} className="py-2.5 px-4 text-[11px] uppercase tracking-wide text-slate-500 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PWC_RENEWALS.map((r, i) => (
              <tr key={r.engagement} className={`border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors ${i === PWC_RENEWALS.length - 1 ? 'border-b-0' : ''}`}>
                <td className="py-3 px-4 font-medium text-white">{r.engagement}</td>
                <td className="py-3 px-4 text-slate-300">{r.fees}</td>
                <td className="py-3 px-4 text-slate-300">{r.partner}</td>
                <td className="py-3 px-4 text-slate-300">{r.renewalDate}</td>
                <td className="py-3 px-4 text-xs text-indigo-300">{r.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-[11px] text-slate-500">Morgan drafts renewal proposals and reminder cadences; partners approve before anything is sent.</p>
    </div>
  );
}

const CustomerRenewalPage = ({ setPage }: { setPage: (p: Page) => void }) => {
  const { activeCompanyId, activeCompany } = useAuth();
  const isTcp = activeCompanyId === 'tcp';

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Renewal &amp; Expansion — Customer entity</h1>
        <p className="text-slate-400 text-sm mt-1">
          {isTcp
            ? 'Casey manages the full renewal lifecycle — invoices via Zuora, cadences via Gainsight, and expansion signals'
            : `Morgan manages engagement renewals for ${activeCompany.name} — proposals, reminders, and partner approvals`}
        </p>
      </div>
      {isTcp ? (
        <>
          <RenewalsPipeline setPage={setPage} />
          <ExpansionOpportunities />
        </>
      ) : (
        <PwcRenewals />
      )}
    </div>
  );
};

export default CustomerRenewalPage;
