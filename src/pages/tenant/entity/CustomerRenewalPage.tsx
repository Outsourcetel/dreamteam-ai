import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../../../context/AuthContext';
import type { Page } from '../../../types';
import { useDataMode } from '../../../lib/dataMode';
import {
  listAccounts, listInvoices, generateInvoice, updateInvoice,
  fmtMoneyK, CustomerApiError, INVOICE_APPROVAL_THRESHOLD_CENTS,
} from '../../../lib/customerApi';
import type { CustomerAccount, RenewalInvoice, InvoiceStatus } from '../../../lib/customerApi';
import { getApprovalThresholdCents } from '../../../lib/guardrailApi';
import { useVocabulary } from '../../../lib/vocabulary';
import { startRenewalRun, listPlaybookRuns } from '../../../lib/playbookApi';
import type { PlaybookRun, RunStep } from '../../../lib/playbookApi';
import { LiveLoadingSkeleton, MissingTablesNotice, LiveEmptyState } from '../../../components/LiveDataStates';

// ============================================================
// Renewal & Expansion — Customer Lifecycle
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

// ── LIVE mode: real renewal invoices from Supabase ─────────────
const invoiceStatusLabel: Record<InvoiceStatus, string> = {
  pending_generation: 'Pending generation',
  awaiting_approval: 'Awaiting approval',
  sent: 'Invoice sent',
  paid: 'Paid ✓',
  overdue: 'Overdue',
};

const invoiceStatusClass: Record<InvoiceStatus, string> = {
  pending_generation: 'text-slate-400',
  awaiting_approval: 'text-amber-300',
  sent: 'text-indigo-300',
  paid: 'text-emerald-400',
  overdue: 'text-rose-400',
};

// ── Playbook run step timeline (live) ─────────────────────────
const stepChip: Record<RunStep['status'], { label: string; cls: string }> = {
  pending: { label: 'pending', cls: 'bg-slate-800 text-slate-500' },
  done: { label: 'done', cls: 'bg-emerald-500/15 text-emerald-300' },
  waiting: { label: 'waiting on human', cls: 'bg-amber-500/15 text-amber-300' },
  skipped: { label: 'skipped', cls: 'bg-slate-800 text-slate-400' },
  failed: { label: 'failed', cls: 'bg-red-500/15 text-red-300' },
  cancelled: { label: 'cancelled', cls: 'bg-red-500/15 text-red-300' },
};

function RunTimeline({ run, setPage }: { run: PlaybookRun; setPage: (p: Page) => void }) {
  const acct = (run.steps[0]?.detail || '').split(' · ')[0] || 'Account';
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-white">{acct}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">{run.playbook_key}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300" title="Executed by the playbook-execute edge function — the run survives closed tabs">server-run</span>
        </div>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${
          run.status === 'completed' ? 'bg-emerald-500/15 text-emerald-300'
          : run.status === 'waiting_approval' ? 'bg-amber-500/15 text-amber-300'
          : run.status === 'cancelled' ? 'bg-red-500/15 text-red-300'
          : 'bg-indigo-500/15 text-indigo-300'
        }`}>{run.status === 'waiting_approval' ? 'waiting on human' : run.status}</span>
      </div>
      <ol className="space-y-1.5">
        {run.steps.map((s, i) => (
          <li key={s.key} className="flex items-start gap-2 text-xs">
            <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] flex-shrink-0 ${
              s.status === 'done' ? 'bg-emerald-500/20 text-emerald-300'
              : s.status === 'waiting' ? 'bg-amber-500/20 text-amber-300'
              : s.status === 'cancelled' || s.status === 'failed' ? 'bg-red-500/20 text-red-300'
              : 'bg-slate-800 text-slate-500'
            }`}>{s.status === 'done' ? '✓' : i + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={s.status === 'pending' ? 'text-slate-500' : 'text-slate-200'}>{s.label}</span>
                <span className={`text-[9px] px-1.5 py-px rounded ${stepChip[s.status].cls}`}>{stepChip[s.status].label}</span>
              </div>
              {s.detail && <p className="text-[10px] text-slate-500 mt-0.5">{s.detail}</p>}
            </div>
          </li>
        ))}
      </ol>
      {run.status === 'waiting_approval' && (
        <button onClick={() => setPage('ops_human_tasks')}
          className="mt-3 text-xs px-3 py-1.5 rounded-lg border text-amber-300 border-amber-800/50 hover:border-amber-500 transition-all">
          Decide in Human Tasks →
        </button>
      )}
    </div>
  );
}

function LiveCustomerRenewal({ setPage }: { setPage: (p: Page) => void }) {
  const { liveTenantName } = useAuth();
  const vocab = useVocabulary();
  const [accounts, setAccounts] = useState<CustomerAccount[]>([]);
  const [invoices, setInvoices] = useState<RenewalInvoice[]>([]);
  const [runs, setRuns] = useState<PlaybookRun[]>([]);
  const [thresholdCents, setThresholdCents] = useState(INVOICE_APPROVAL_THRESHOLD_CENTS);
  const [loading, setLoading] = useState(true);
  const [missingTables, setMissingTables] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [genModal, setGenModal] = useState<CustomerAccount | null>(null);
  const [generating, setGenerating] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  };
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [accts, invs, thr] = await Promise.all([listAccounts(), listInvoices(), getApprovalThresholdCents()]);
      setAccounts(accts);
      setInvoices(invs);
      setThresholdCents(thr.cents);
      setMissingTables(false);
      // Playbook runs are additive P3 — tolerate a missing table quietly.
      try { setRuns(await listPlaybookRuns()); } catch { setRuns([]); }
    } catch (err) {
      if (err instanceof CustomerApiError && err.missingTables) setMissingTables(true);
      else setError((err as Error)?.message || 'Failed to load renewals.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const onChange = () => void refresh();
    window.addEventListener('dt-state-changed', onChange);
    return () => window.removeEventListener('dt-state-changed', onChange);
  }, [refresh]);

  const runPlaybook = async (account: CustomerAccount) => {
    setRunningId(account.id);
    setError(null);
    try {
      const run = await startRenewalRun(account);
      showToast(run.status === 'waiting_approval'
        ? `Renewal playbook paused at the human gate — invoice for ${account.name} awaits approval`
        : `Renewal playbook completed for ${account.name} — invoice sent`);
      void refresh();
    } catch (err) {
      setError((err as Error)?.message || 'Playbook run failed.');
    } finally {
      setRunningId(null);
    }
  };

  const confirmGenerate = async () => {
    if (!genModal) return;
    setGenerating(true);
    try {
      const { gated } = await generateInvoice(genModal);
      setGenModal(null);
      showToast(gated
        ? `Invoice for ${genModal.name} exceeds ${fmtMoneyK(thresholdCents)} — routed to Human Tasks for approval`
        : `Invoice sent to ${genModal.name}`);
      void refresh();
    } catch (err) {
      setError((err as Error)?.message || 'Failed to generate invoice.');
      setGenModal(null);
    } finally {
      setGenerating(false);
    }
  };

  const markPaid = async (inv: RenewalInvoice) => {
    try {
      await updateInvoice(inv.id, { status: 'paid' });
      showToast('Invoice marked as paid');
      void refresh();
    } catch (err) {
      setError((err as Error)?.message || 'Failed to update invoice.');
    }
  };

  // Accounts with no live (non-paid) invoice can generate one.
  const accountsWithOpenInvoice = new Set(invoices.filter(i => i.status !== 'paid').map(i => i.account_id));
  const generatable = accounts.filter(a => a.status !== 'churned' && !accountsWithOpenInvoice.has(a.id));

  const awaitingApproval = invoices.filter(i => i.status === 'awaiting_approval');
  const outstandingCents = invoices.filter(i => i.status === 'sent' || i.status === 'overdue').reduce((s, i) => s + i.amount_cents, 0);
  const paidCents = invoices.filter(i => i.status === 'paid').reduce((s, i) => s + i.amount_cents, 0);

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">{vocab.renewal_label} &amp; Expansion — {vocab.party_singular} Lifecycle</h1>
        <p className="text-slate-400 text-sm mt-1">{liveTenantName || 'Your company'} · Live {vocab.renewal_label.toLowerCase()} pipeline — invoices above {fmtMoneyK(thresholdCents)} route through a human approval gate (guardrail-configured)</p>
      </div>

      {error && <div className="mb-4 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{error}</div>}

      {loading ? (
        <LiveLoadingSkeleton rows={5} />
      ) : missingTables ? (
        <MissingTablesNotice />
      ) : accounts.length === 0 ? (
        <LiveEmptyState
          icon="↻"
          title="No accounts to renew yet"
          body={`Add or import your ${vocab.party_plural.toLowerCase()} first — ${vocab.renewal_label.toLowerCase()}s are generated from each record's ${vocab.value_metric} and ${vocab.renewal_label.toLowerCase()} dates.`}
          primaryLabel="Go to Customer Success"
          onPrimary={() => setPage('entity_customer_success')}
        />
      ) : (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6">
          {/* Stat cards */}
          <div className="grid grid-cols-3 gap-3 mb-5">
            {[
              { label: 'Invoices outstanding', value: fmtMoneyK(outstandingCents), sub: `${invoices.filter(i => i.status === 'sent' || i.status === 'overdue').length} invoice(s)`, color: 'text-white' },
              { label: 'Awaiting approval', value: String(awaitingApproval.length), sub: awaitingApproval.length > 0 ? fmtMoneyK(awaitingApproval.reduce((s, i) => s + i.amount_cents, 0)) : '—', color: awaitingApproval.length > 0 ? 'text-amber-300' : 'text-emerald-300' },
              { label: 'Collected', value: fmtMoneyK(paidCents), sub: `${invoices.filter(i => i.status === 'paid').length} paid`, color: 'text-emerald-300' },
            ].map(s => (
              <div key={s.label} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">{s.label}</p>
                <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
                <p className="text-xs text-slate-500 mt-0.5">{s.sub}</p>
              </div>
            ))}
          </div>

          {/* Invoices table */}
          <h3 className="text-sm font-semibold text-white mb-3">Renewal invoices</h3>
          {invoices.length === 0 ? (
            <p className="text-xs text-slate-500 mb-5">No invoices yet — generate one from the accounts below.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-800 mb-6">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-slate-800 text-left">
                    {[vocab.party_singular, 'Amount', 'Status', 'Due date', 'Action'].map(h => (
                      <th key={h} className="py-2.5 px-4 text-[11px] uppercase tracking-wide text-slate-500 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv, i) => (
                    <tr key={inv.id} className={`border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors ${i === invoices.length - 1 ? 'border-b-0' : ''}`}>
                      <td className="py-3 px-4 font-medium text-white">{inv.customer_accounts?.name || '—'}</td>
                      <td className="py-3 px-4 text-slate-300">{fmtMoneyK(inv.amount_cents)}</td>
                      <td className="py-3 px-4">
                        <span className={`text-xs ${invoiceStatusClass[inv.status]}`}>{invoiceStatusLabel[inv.status]}</span>
                      </td>
                      <td className="py-3 px-4 text-slate-400 text-xs whitespace-nowrap">{inv.due_date || '—'}</td>
                      <td className="py-3 px-4">
                        {inv.status === 'awaiting_approval' ? (
                          <button onClick={() => setPage('ops_human_tasks')} className="text-xs px-3 py-1.5 rounded-lg border text-amber-300 border-amber-800/50 hover:border-amber-500 transition-all">
                            View approval →
                          </button>
                        ) : inv.status === 'sent' || inv.status === 'overdue' ? (
                          <button onClick={() => void markPaid(inv)} className="text-xs px-3 py-1.5 rounded-lg border text-slate-300 border-slate-700 hover:border-emerald-500 hover:text-emerald-300 transition-all">
                            Mark paid
                          </button>
                        ) : <span className="text-slate-600 text-xs">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Generate section */}
          <h3 className="text-sm font-semibold text-white mb-1">Generate renewal invoices</h3>
          <p className="text-xs text-slate-500 mb-3">
            Accounts without an open invoice. Amounts above {fmtMoneyK(thresholdCents)} require human approval before sending. "Run playbook" executes the full renewal_v1 flow — check → invoice → guardrail → human gate → send — with every step audited.
          </p>
          {generatable.length === 0 ? (
            <p className="text-xs text-slate-500">Every active account already has an open invoice.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-slate-800 text-left">
                    {[vocab.party_singular, vocab.value_metric, `${vocab.renewal_label} date`, 'Action'].map(h => (
                      <th key={h} className="py-2.5 px-4 text-[11px] uppercase tracking-wide text-slate-500 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {generatable.map((a, i) => (
                    <tr key={a.id} className={`border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors ${i === generatable.length - 1 ? 'border-b-0' : ''}`}>
                      <td className="py-3 px-4 font-medium text-white">{a.name}</td>
                      <td className="py-3 px-4 text-slate-300">{fmtMoneyK(a.arr_cents)}</td>
                      <td className="py-3 px-4 text-slate-400 text-xs whitespace-nowrap">{a.renewal_date || '—'}</td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <button onClick={() => setGenModal(a)} className="text-xs px-3 py-1.5 rounded-lg border text-indigo-300 border-indigo-800/50 hover:border-indigo-500 transition-all">
                            Generate Invoice
                          </button>
                          <button onClick={() => void runPlaybook(a)} disabled={runningId !== null}
                            className="text-xs px-3 py-1.5 rounded-lg border text-violet-300 border-violet-800/50 hover:border-violet-500 disabled:opacity-50 transition-all whitespace-nowrap">
                            {runningId === a.id ? 'Running…' : '▶ Run playbook'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Playbook runs */}
          {runs.length > 0 && (
            <div className="mt-6">
              <h3 className="text-sm font-semibold text-white mb-1">Renewal playbook runs</h3>
              <p className="text-xs text-slate-500 mb-3">
                Live step timeline — runs pause at the human gate when an invoice exceeds the guardrail threshold, and resume when the approval is decided.
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                {runs.slice(0, 6).map(r => <RunTimeline key={r.id} run={r} setPage={setPage} />)}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Generate invoice modal */}
      {genModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <h3 className="text-white font-semibold mb-2">Generate renewal invoice</h3>
            <p className="text-sm text-slate-300 mb-2">
              Generate renewal invoice for <span className="text-white font-medium">{genModal.name}</span> —{' '}
              <span className="text-indigo-300 font-medium">{fmtMoneyK(genModal.arr_cents)}</span>?
            </p>
            {genModal.arr_cents > thresholdCents && (
              <p className="text-xs text-amber-300 mb-4">Above the {fmtMoneyK(thresholdCents)} guardrail threshold — will route to Human Tasks for approval before sending.</p>
            )}
            <div className="flex gap-3 mt-3">
              <button onClick={() => void confirmGenerate()} disabled={generating}
                className="flex-1 py-2 text-sm font-medium rounded-lg text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 transition-all">
                {generating ? 'Generating…' : 'Confirm'}
              </button>
              <button onClick={() => setGenModal(null)} className="flex-1 py-2 text-sm rounded-lg border border-slate-700 text-slate-300 hover:border-slate-500 transition-all">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 z-[100] px-4 py-3 rounded-xl border shadow-xl text-sm font-medium bg-emerald-900/90 border-emerald-700/50 text-emerald-300">
          {toast}
        </div>
      )}
    </div>
  );
}

const CustomerRenewalPage = ({ setPage }: { setPage: (p: Page) => void }) => {
  const dataMode = useDataMode();
  if (dataMode === 'live') return <LiveCustomerRenewal setPage={setPage} />;
  return <DemoCustomerRenewalPage setPage={setPage} />;
};

const DemoCustomerRenewalPage = ({ setPage }: { setPage: (p: Page) => void }) => {
  const { activeCompanyId, activeCompany } = useAuth();
  const isTcp = activeCompanyId === 'tcp';

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Renewal &amp; Expansion — Customer Lifecycle</h1>
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
