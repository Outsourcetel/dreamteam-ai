import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Modal } from '../../../design/primitives';
import { useAuth } from '../../../context/AuthContext';
import type { Page } from '../../../types';
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
// Renewals — the LIVE view.
//
// This file used to open with three hand-written tables: six invented
// accounts with ARR figures and health scores, three "expansion
// opportunities" attributed to an owner called Casey, and two professional-
// services engagements. They sat directly above a section that loads real
// accounts, invoices and playbook runs, which is the worst possible
// arrangement — a reader cannot tell which numbers are theirs.
//
// They were never rendered: the exported component returns
// <LiveCustomerRenewal> and nothing else, and none of the three had a JSX
// call site. Unreachable is not the same as harmless, though. The next
// person to wire up a "Renewals Pipeline" would have found a ready-made one
// full of fiction. Removed rather than left as a trap.
// ============================================================

// ── LIVE mode: real renewal invoices from Supabase ─────────────
const invoiceStatusLabel: Record<InvoiceStatus, string> = {
  pending_generation: 'Pending generation',
  awaiting_approval: 'Awaiting approval',
  sent: 'Invoice sent',
  paid: 'Paid ✓',
  overdue: 'Overdue',
};

const invoiceStatusClass: Record<InvoiceStatus, string> = {
  pending_generation: 'text-dt-support',
  awaiting_approval: 'text-amber-300',
  sent: 'text-indigo-300',
  paid: 'text-emerald-400',
  overdue: 'text-rose-400',
};

// ── Playbook run step timeline (live) ─────────────────────────
const stepChip: Record<RunStep['status'], { label: string; cls: string }> = {
  pending: { label: 'pending', cls: 'bg-dt-panel text-dt-muted' },
  done: { label: 'done', cls: 'bg-emerald-500/15 text-emerald-300' },
  waiting: { label: 'waiting on human', cls: 'bg-amber-500/15 text-amber-300' },
  skipped: { label: 'skipped', cls: 'bg-dt-panel text-dt-support' },
  failed: { label: 'failed', cls: 'bg-red-500/15 text-red-300' },
  cancelled: { label: 'cancelled', cls: 'bg-red-500/15 text-red-300' },
};

function RunTimeline({ run, setPage }: { run: PlaybookRun; setPage: (p: Page) => void }) {
  const acct = (run.steps[0]?.detail || '').split(' · ')[0] || 'Account';
  return (
    <div className="rounded-xl border border-dt-border bg-dt-inset p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-white">{acct}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-panel text-dt-support font-mono">{run.playbook_key}</span>
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
              : 'bg-dt-panel text-dt-muted'
            }`}>{s.status === 'done' ? '✓' : i + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={s.status === 'pending' ? 'text-dt-muted' : 'text-dt-body'}>{s.label}</span>
                <span className={`text-[10px] px-1.5 py-px rounded ${stepChip[s.status].cls}`}>{stepChip[s.status].label}</span>
              </div>
              {s.detail && <p className="text-[10px] text-dt-muted mt-0.5">{s.detail}</p>}
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
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">{vocab.renewal_label} &amp; Expansion — {vocab.party_singular} Lifecycle</h1>
        <p className="text-dt-support text-sm mt-1">{liveTenantName || 'Your company'} · Live {vocab.renewal_label.toLowerCase()} pipeline — invoices above {fmtMoneyK(thresholdCents)} route through a human approval gate (guardrail-configured)</p>
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
        <div className="rounded-2xl border border-dt-border bg-dt-card p-6">
          {/* Stat cards */}
          <div className="grid grid-cols-3 gap-3 mb-5">
            {[
              { label: 'Invoices outstanding', value: fmtMoneyK(outstandingCents), sub: `${invoices.filter(i => i.status === 'sent' || i.status === 'overdue').length} invoice(s)`, color: 'text-white' },
              { label: 'Awaiting approval', value: String(awaitingApproval.length), sub: awaitingApproval.length > 0 ? fmtMoneyK(awaitingApproval.reduce((s, i) => s + i.amount_cents, 0)) : '—', color: awaitingApproval.length > 0 ? 'text-amber-300' : 'text-emerald-300' },
              { label: 'Collected', value: fmtMoneyK(paidCents), sub: `${invoices.filter(i => i.status === 'paid').length} paid`, color: 'text-emerald-300' },
            ].map(s => (
              <div key={s.label} className="bg-dt-card border border-dt-border rounded-xl p-4">
                <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-1">{s.label}</p>
                <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
                <p className="text-xs text-dt-muted mt-0.5">{s.sub}</p>
              </div>
            ))}
          </div>

          {/* Invoices table */}
          <h3 className="text-sm font-semibold text-white mb-3">Renewal invoices</h3>
          {invoices.length === 0 ? (
            <p className="text-xs text-dt-muted mb-5">No invoices yet — generate one from the accounts below.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-dt-border mb-6">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-dt-border text-left">
                    {[vocab.party_singular, 'Amount', 'Status', 'Due date', 'Action'].map(h => (
                      <th key={h} className="py-2.5 px-4 text-[11px] uppercase tracking-wide text-dt-muted font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv, i) => (
                    <tr key={inv.id} className={`border-b border-dt-border hover:bg-dt-panel transition-colors ${i === invoices.length - 1 ? 'border-b-0' : ''}`}>
                      <td className="py-3 px-4 font-medium text-white">{inv.customer_accounts?.name || '—'}</td>
                      <td className="py-3 px-4 text-dt-support">{fmtMoneyK(inv.amount_cents)}</td>
                      <td className="py-3 px-4">
                        <span className={`text-xs ${invoiceStatusClass[inv.status]}`}>{invoiceStatusLabel[inv.status]}</span>
                      </td>
                      <td className="py-3 px-4 text-dt-support text-xs whitespace-nowrap">{inv.due_date || '—'}</td>
                      <td className="py-3 px-4">
                        {inv.status === 'awaiting_approval' ? (
                          <button onClick={() => setPage('ops_human_tasks')} className="text-xs px-3 py-1.5 rounded-lg border text-amber-300 border-amber-800/50 hover:border-amber-500 transition-all">
                            View approval →
                          </button>
                        ) : inv.status === 'sent' || inv.status === 'overdue' ? (
                          <button onClick={() => void markPaid(inv)} className="text-xs px-3 py-1.5 rounded-lg border text-dt-support border-dt-border-strong hover:border-emerald-500 hover:text-emerald-300 transition-all">
                            Mark paid
                          </button>
                        ) : <span className="text-dt-faint text-xs">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Generate section */}
          <h3 className="text-sm font-semibold text-white mb-1">Generate renewal invoices</h3>
          <p className="text-xs text-dt-muted mb-3">
            Accounts without an open invoice. Amounts above {fmtMoneyK(thresholdCents)} require human approval before sending. "Run playbook" executes the full renewal_v1 flow — check → invoice → guardrail → human gate → send — with every step audited.
          </p>
          {generatable.length === 0 ? (
            <p className="text-xs text-dt-muted">Every active account already has an open invoice.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-dt-border">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-dt-border text-left">
                    {[vocab.party_singular, vocab.value_metric, `${vocab.renewal_label} date`, 'Action'].map(h => (
                      <th key={h} className="py-2.5 px-4 text-[11px] uppercase tracking-wide text-dt-muted font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {generatable.map((a, i) => (
                    <tr key={a.id} className={`border-b border-dt-border hover:bg-dt-panel transition-colors ${i === generatable.length - 1 ? 'border-b-0' : ''}`}>
                      <td className="py-3 px-4 font-medium text-white">{a.name}</td>
                      <td className="py-3 px-4 text-dt-support">{fmtMoneyK(a.arr_cents)}</td>
                      <td className="py-3 px-4 text-dt-support text-xs whitespace-nowrap">{a.renewal_date || '—'}</td>
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
              <p className="text-xs text-dt-muted mb-3">
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
        <Modal size="sm" onClose={() => setGenModal(null)} title="Generate renewal invoice">
          <div>
            <p className="text-sm text-dt-support mb-2">
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
              <button onClick={() => setGenModal(null)} className="flex-1 py-2 text-sm rounded-lg border border-dt-border-strong text-dt-support hover:border-dt-border-strong transition-all">
                Cancel
              </button>
            </div>
          </div>
        </Modal>
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
  return <LiveCustomerRenewal setPage={setPage} />;
};

export default CustomerRenewalPage;
