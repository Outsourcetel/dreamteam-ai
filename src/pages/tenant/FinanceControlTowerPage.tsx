import React, { useState } from 'react';
import * as api from '../../lib/api';
import type { AuthUser, Tenant } from '../../types';

const FIN_EXC_META: Record<string, { label: string; tone: string }> = {
  unmatched_bank_txn: { label: 'Unmatched bank txn', tone: 'rose' },
  duplicate_invoice: { label: 'Duplicate bill/invoice', tone: 'rose' },
  missing_receipt: { label: 'Missing receipt', tone: 'amber' },
  unusual_spend: { label: 'Unusual spend', tone: 'rose' },
  late_customer_payment: { label: 'Late customer payment', tone: 'amber' },
  uncategorized_txn: { label: 'Uncategorized txn', tone: 'sky' },
  revenue_payment_mismatch: { label: 'Revenue/payment mismatch', tone: 'violet' },
};

const finMoney = (n: number | null | undefined) =>
  (n == null ? 0 : n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function FinHeader(props: any) {
  const { workspace, onDetect, busy } = props;
  return (
    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
      <div>
        <p className="text-[11px] uppercase tracking-widest text-indigo-300">Finance Operations Control Tower</p>
        <h1 className="text-2xl font-bold text-white">Month-End Close &amp; Reconciliation</h1>
        {workspace && <p className="text-sm text-slate-400 mt-1">{workspace.name} · {workspace.period_start} → {workspace.period_end} · {workspace.status}</p>}
      </div>
      {onDetect && (
        <button onClick={onDetect} disabled={busy}
          className="rounded-lg bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2">{busy ? 'Running reconciliation…' : 'Run reconciliation'}</button>
      )}
    </div>
  );
}

function FinStat(props: any) {
  const { label, value, sub, bar, tone } = props;
  const toneCls = tone === 'rose' ? 'text-rose-300' : tone === 'amber' ? 'text-amber-300' : tone === 'emerald' ? 'text-emerald-300' : 'text-white';
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className={'mt-1 text-2xl font-bold ' + toneCls}>{value}</p>
      {sub && <p className="text-xs text-slate-500 mt-1">{sub}</p>}
      {bar != null && (
        <div className="mt-3 h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
          <div className="h-full rounded-full bg-indigo-400" style={{ width: Math.min(100, bar) + '%' }} />
        </div>
      )}
    </div>
  );
}


function FinanceControlTowerPage(props: any) {
  const { user, tenant, accentColor, setPage } = props;
  const tenantId: string | null = user?.tenantId || tenant?.id || null;
  const isUuid = (v: any) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  const live = isUuid(tenantId);

  const [workspace, setWorkspace] = React.useState<any>(null);
  const [metrics, setMetrics] = React.useState<any>(null);
  const [exceptions, setExceptions] = React.useState<any[]>([]);
  const [tasks, setTasks] = React.useState<any[]>([]);
  const [evidence, setEvidence] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<any>(null);
  const [treatment, setTreatment] = React.useState<string>('');
  const [tab, setTab] = React.useState<string>('dashboard');
  const [toast, setToast] = React.useState<string>('');
  const [docs, setDocs] = React.useState<any[]>([]);
  const [docType, setDocType] = React.useState<string>('bank_statement');
  const [parsedRows, setParsedRows] = React.useState<Record<string, string>[]>([]);
  const [fileName, setFileName] = React.useState<string>('');
  const [ingesting, setIngesting] = React.useState<boolean>(false);
  // Invoice state
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  const [invCustName, setInvCustName] = useState('');
  const [invCustEmail, setInvCustEmail] = useState('');
  const [invDate, setInvDate] = useState(new Date().toISOString().split('T')[0]);
  const [invDueDate, setInvDueDate] = useState(() => { const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString().split('T')[0]; });
  const [invLines, setInvLines] = useState([{ desc: '', qty: 1, price: 0 }]);
  const [invNotes, setInvNotes] = useState('');
  const [invTerms, setInvTerms] = useState('Per contract terms');
  const [invAutoSend, setInvAutoSend] = useState(true);
  const [invSending, setInvSending] = useState(false);
  const [sentInvoices, setSentInvoices] = useState<any[]>([]);

  React.useEffect(() => {
    if (tab === 'upload' && workspace && tenantId) {
      api.fetchDocuments(tenantId, workspace.id).then((d) => setDocs(d as any));
    }
  }, [tab, workspace, tenantId]);

  const reload = React.useCallback(async (wsId: string) => {
    if (!tenantId) return;
    const [m, ex, tk, ev] = await Promise.all([
      api.fetchFinanceMetrics(tenantId, wsId),
      api.fetchExceptions(tenantId, wsId),
      api.fetchCloseTasks(tenantId, wsId),
      api.fetchAuditEvidence(tenantId, wsId),
    ]);
    setMetrics(m); setExceptions(ex); setTasks(tk as any[]); setEvidence(ev as any[]);
  }, [tenantId]);

  React.useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      if (!live || !tenantId) { setLoading(false); return; }
      const ws = await api.fetchFinanceWorkspaces(tenantId);
      if (!active) return;
      const w = ws[0] || null;
      setWorkspace(w);
      if (w) await reload(w.id);
      if (active) setLoading(false);
    })();
    return () => { active = false; };
  }, [tenantId, live, reload]);

  const handleDetect = async () => {
    if (!workspace || !tenantId) return;
    setBusy('detect');
    const n = await api.runExceptionDetection(tenantId, workspace.id);
    await reload(workspace.id);
    setBusy(null);
    setToast('Reconciliation run complete — ' + n + ' open exceptions.');
    setTimeout(() => setToast(''), 4000);
  };

  const handleDecision = async (decision: 'approved' | 'rejected') => {
    if (!selected || !tenantId) return;
    const treat = treatment.trim() || (decision === 'approved'
      ? (selected.proposed_action || 'Approved as proposed')
      : 'Rejected — no action taken');
    setBusy(selected.id);
    const res = await api.resolveException(selected.id, decision, treat, user?.id || '', user?.name || 'Reviewer');
    setBusy(null);
    if (res.ok) {
      setToast('Decision recorded — audit evidence #' + (res.evidenceId || '').slice(0, 8));
      setSelected(null); setTreatment('');
      await reload(workspace.id);
    } else {
      setToast('Could not record decision: ' + (res.error || 'unknown error'));
    }
    setTimeout(() => setToast(''), 4000);
  };

  // ---------- DEMO FALLBACK (no real tenant logged in) ----------
  if (!live) {
    return (
      <div className="p-8 text-slate-300">
        <FinHeader accentColor={accentColor} />
        <div className="mt-6 rounded-xl border border-amber-500/30 bg-amber-500/10 p-6">
          <p className="text-amber-300 font-medium">Demo account</p>
          <p className="mt-2 text-sm text-slate-300 max-w-2xl">
            The Finance Control Tower runs on live, tenant-isolated finance data. Sign in with a
            provisioned tenant account to load the seeded demo company (October 2026 close) with real
            general ledger, bank, AP/AR, payroll and Stripe data plus AI-detected reconciliation exceptions.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className="p-8 text-slate-400">Loading finance workspace…</div>;
  }
  if (!workspace) {
    return (
      <div className="p-8 text-slate-300">
        <FinHeader accentColor={accentColor} />
        <div className="mt-6 rounded-xl border border-slate-700 bg-slate-900/60 p-6">
          <p className="text-slate-200 font-medium">No close workspace yet</p>
          <p className="mt-2 text-sm text-slate-400">Create a monthly close workspace to begin.</p>
        </div>
      </div>
    );
  }

  const openExc = exceptions.filter((e) => e.status === 'open');
  const accent = accentColor || '#6366f1';

  return (
    <div className="p-6 md:p-8">
      <FinHeader accentColor={accent} workspace={workspace} onDetect={handleDetect} busy={busy === 'detect'} />
      {toast && (
        <div className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-300">{toast}</div>
      )}
      <div className="mt-5 flex gap-1 border-b border-slate-800">
        {[['dashboard','Dashboard'],['invoices','Invoices'],['exceptions','Exceptions ('+openExc.length+')'],['tasks','Close tasks'],['audit','Audit evidence'],['upload','Upload & connect']].map(([id,label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ' + (tab===id ? 'border-indigo-400 text-white' : 'border-transparent text-slate-400 hover:text-slate-200')}>{label}</button>
        ))}
      </div>

      {tab === 'dashboard' && metrics && (
        <>
          <div className="mt-6 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            <FinStat label="Close progress" value={metrics.closeProgress + '%'} sub={metrics.tasksDone + ' of ' + metrics.tasksTotal + ' tasks'} bar={metrics.closeProgress} />
            <FinStat label="Unresolved exceptions" value={String(metrics.openExceptions)} sub={metrics.resolvedExceptions + ' resolved'} tone={metrics.openExceptions ? 'rose' : 'emerald'} />
            <FinStat label="Cash position" value={finMoney(metrics.cashPosition)} sub="Operating bank (period)" />
            <FinStat label="Audit evidence" value={metrics.evidenceCompleteness + '%'} sub="Decisions documented" bar={metrics.evidenceCompleteness} />
            <FinStat label="AR overdue" value={finMoney(metrics.arOverdue)} sub="Outstanding receivables" tone={metrics.arOverdue ? 'amber' : 'emerald'} />
            <FinStat label="AP due" value={finMoney(metrics.apDue)} sub="Payables outstanding" tone={metrics.apDue ? 'amber' : 'emerald'} />
            <FinStat label="Unmatched bank lines" value={String(metrics.unmatched)} sub="Need reconciliation" tone={metrics.unmatched ? 'rose' : 'emerald'} />
            <FinStat label="Total exceptions" value={String(metrics.totalExceptions)} sub="Detected this close" />
          </div>
          <div className="mt-8 rounded-2xl border border-slate-800 bg-slate-900/50 p-5 flex items-center justify-between flex-wrap gap-2">
            <p className="text-sm text-slate-400">The Renewals Pipeline now lives in the Customer entity.</p>
            {setPage && (
              <button onClick={() => setPage('entity_customer_renewal')} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">Go to Renewal &amp; Expansion →</button>
            )}
          </div>
        </>
      )}

      {tab === 'invoices' && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">Invoices</h2>
            <button onClick={() => setShowInvoiceModal(true)} className="px-4 py-2 text-sm font-medium rounded-lg text-white" style={{ backgroundColor: accent }}>+ Generate Invoice</button>
          </div>
          {sentInvoices.length > 0 && (
            <table className="w-full text-sm border-collapse mb-6">
              <thead><tr className="border-b border-slate-800 text-left text-xs text-slate-500">{['Customer','Email','Date','Due','Total','Status'].map(h => <th key={h} className="py-2 pr-4">{h}</th>)}</tr></thead>
              <tbody>{sentInvoices.map((inv, i) => <tr key={i} className="border-b border-slate-800 text-slate-300"><td className="py-2 pr-4">{inv.custName}</td><td className="py-2 pr-4">{inv.custEmail}</td><td className="py-2 pr-4">{inv.date}</td><td className="py-2 pr-4">{inv.dueDate}</td><td className="py-2 pr-4">{finMoney(inv.total)}</td><td className="py-2 pr-4 text-emerald-400">{inv.sent ? 'Sent' : 'Draft'}</td></tr>)}</tbody>
            </table>
          )}
          {sentInvoices.length === 0 && <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-8 text-center text-slate-500 text-sm">No invoices generated yet. Click "Generate Invoice" to create your first one.</div>}

          {/* Invoice Modal */}
          {showInvoiceModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
              <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-white font-semibold text-lg">Generate Invoice</h3>
                  <button onClick={() => setShowInvoiceModal(false)} className="text-slate-500 hover:text-slate-200 text-xl">×</button>
                </div>
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div><label className="text-xs text-slate-400 block mb-1">Customer Name</label><input value={invCustName} onChange={e => setInvCustName(e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none" /></div>
                  <div><label className="text-xs text-slate-400 block mb-1">Customer Email</label><input type="email" value={invCustEmail} onChange={e => setInvCustEmail(e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none" /></div>
                  <div><label className="text-xs text-slate-400 block mb-1">Invoice Date</label><input type="date" value={invDate} onChange={e => setInvDate(e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none" /></div>
                  <div><label className="text-xs text-slate-400 block mb-1">Due Date</label><input type="date" value={invDueDate} onChange={e => setInvDueDate(e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none" /></div>
                </div>
                <div className="mb-4">
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs text-slate-400">Line Items</label>
                    <button onClick={() => setInvLines(l => [...l, { desc: '', qty: 1, price: 0 }])} className="text-xs text-indigo-400 hover:text-indigo-300">+ Add Row</button>
                  </div>
                  <div className="space-y-2">
                    <div className="grid grid-cols-12 gap-2 text-xs text-slate-500"><div className="col-span-6">Description</div><div className="col-span-2">Qty</div><div className="col-span-3">Unit Price</div><div className="col-span-1"></div></div>
                    {invLines.map((line, i) => (
                      <div key={i} className="grid grid-cols-12 gap-2">
                        <input className="col-span-6 bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none" value={line.desc} onChange={e => setInvLines(l => l.map((x, j) => j === i ? { ...x, desc: e.target.value } : x))} placeholder="Service or product" />
                        <input type="number" className="col-span-2 bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none" value={line.qty} onChange={e => setInvLines(l => l.map((x, j) => j === i ? { ...x, qty: Number(e.target.value) } : x))} />
                        <input type="number" className="col-span-3 bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none" value={line.price} onChange={e => setInvLines(l => l.map((x, j) => j === i ? { ...x, price: Number(e.target.value) } : x))} />
                        <button onClick={() => setInvLines(l => l.filter((_, j) => j !== i))} className="col-span-1 text-slate-600 hover:text-red-400 text-sm">×</button>
                      </div>
                    ))}
                  </div>
                  <div className="text-right text-sm font-medium text-white mt-2">Total: {finMoney(invLines.reduce((s, l) => s + l.qty * l.price, 0))}</div>
                </div>
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div><label className="text-xs text-slate-400 block mb-1">Notes</label><textarea value={invNotes} onChange={e => setInvNotes(e.target.value)} rows={2} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none" /></div>
                  <div><label className="text-xs text-slate-400 block mb-1">Terms</label><textarea value={invTerms} onChange={e => setInvTerms(e.target.value)} rows={2} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none" /></div>
                </div>
                <label className="flex items-center gap-2 mb-4 cursor-pointer">
                  <input type="checkbox" checked={invAutoSend} onChange={() => setInvAutoSend(v => !v)} className="accent-indigo-500" />
                  <span className="text-sm text-slate-300">Send automatically to customer email</span>
                </label>
                {/* Preview */}
                <div className="rounded-xl border border-slate-700 bg-slate-950 p-4 mb-4 text-sm">
                  <div className="text-xs uppercase tracking-wide text-slate-500 mb-3">Invoice Preview</div>
                  <div className="flex justify-between mb-2"><span className="text-slate-400">Customer:</span><span className="text-white">{invCustName || '—'}</span></div>
                  <div className="flex justify-between mb-2"><span className="text-slate-400">Email:</span><span className="text-white">{invCustEmail || '—'}</span></div>
                  <div className="flex justify-between mb-2"><span className="text-slate-400">Date:</span><span className="text-white">{invDate}</span></div>
                  <div className="flex justify-between mb-4"><span className="text-slate-400">Due:</span><span className="text-white">{invDueDate}</span></div>
                  {invLines.map((l, i) => l.desc && <div key={i} className="flex justify-between text-xs text-slate-300 mb-1"><span>{l.desc} × {l.qty}</span><span>{finMoney(l.qty * l.price)}</span></div>)}
                  <div className="flex justify-between font-bold text-white border-t border-slate-700 pt-2 mt-2"><span>Total</span><span>{finMoney(invLines.reduce((s, l) => s + l.qty * l.price, 0))}</span></div>
                  {invNotes && <p className="text-xs text-slate-500 mt-2">{invNotes}</p>}
                  <p className="text-xs text-slate-600 mt-1">{invTerms}</p>
                </div>
                <button
                  disabled={invSending || !invCustName || !invCustEmail}
                  onClick={async () => {
                    if (!tenantId) return;
                    setInvSending(true);
                    const total = invLines.reduce((s, l) => s + l.qty * l.price, 0);
                    const body = `Invoice from DreamTeam AI\n\nCustomer: ${invCustName}\nDate: ${invDate}\nDue: ${invDueDate}\n\nItems:\n${invLines.filter(l => l.desc).map(l => `- ${l.desc} × ${l.qty} = $${(l.qty * l.price).toFixed(2)}`).join('\n')}\n\nTotal: $${total.toFixed(2)}\n\n${invNotes ? 'Notes: ' + invNotes + '\n' : ''}${invTerms}`;
                    let sent = false;
                    if (invAutoSend && invCustEmail) {
                      const r = await api.sendDEEmail({ tenantId, toEmail: invCustEmail, toName: invCustName, subject: `Invoice — Due ${invDueDate}`, body, templateType: 'invoice' });
                      sent = r.ok;
                    }
                    setSentInvoices(prev => [...prev, { custName: invCustName, custEmail: invCustEmail, date: invDate, dueDate: invDueDate, total, sent }]);
                    setToast(sent ? `Invoice sent to ${invCustEmail}` : 'Invoice saved (not sent)');
                    setTimeout(() => setToast(''), 4000);
                    setShowInvoiceModal(false);
                    setInvCustName(''); setInvCustEmail(''); setInvLines([{ desc: '', qty: 1, price: 0 }]); setInvNotes('');
                    setInvSending(false);
                  }}
                  className="w-full py-2.5 text-sm font-medium rounded-lg text-white disabled:opacity-50" style={{ backgroundColor: accent }}>
                  {invSending ? 'Generating…' : invAutoSend ? 'Generate & Send' : 'Generate'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'exceptions' && (
        <div className="mt-6 grid grid-cols-1 lg:grid-cols-5 gap-5">
          <div className="lg:col-span-3 space-y-3">
            {openExc.length === 0 && <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-6 text-emerald-300 text-sm">All exceptions resolved. Close is clean.</div>}
            {openExc.map((e) => {
              const meta = FIN_EXC_META[e.exception_type] || { label: e.exception_type, tone: 'slate' };
              return (
                <button key={e.id} onClick={() => { setSelected(e); setTreatment(''); }}
                  className={'w-full text-left rounded-xl border p-4 transition ' + (selected && selected.id===e.id ? 'border-indigo-400 bg-slate-800/70' : 'border-slate-800 bg-slate-900/50 hover:border-slate-600')}>
                  <div className="flex items-center justify-between gap-3">
                    <span className={'text-[11px] uppercase tracking-wide px-2 py-0.5 rounded bg-' + meta.tone + '-500/15 text-' + meta.tone + '-300'}>{meta.label}</span>
                    <span className="text-xs text-slate-500">conf {(e.confidence*100).toFixed(0)}%{e.is_risky ? ' · risky' : ''}</span>
                  </div>
                  <p className="mt-2 text-sm font-medium text-slate-100">{e.title}</p>
                  {e.amount != null && <p className="text-xs text-slate-400 mt-1">{finMoney(e.amount)}</p>}
                </button>
              );
            })}
          </div>
          <div className="lg:col-span-2">
            {!selected && <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6 text-sm text-slate-400">Select an exception to review the AI proposal and approve or reject.</div>}
            {selected && (
              <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-5">
                <p className="text-sm font-semibold text-white">{selected.title}</p>
                {selected.is_risky && <span className="inline-block mt-2 text-[11px] px-2 py-0.5 rounded bg-rose-500/15 text-rose-300">Risky — never auto-executed</span>}
                <div className="mt-3 text-xs text-slate-400">Detail</div>
                <p className="text-sm text-slate-200">{selected.detail}</p>
                <div className="mt-3 text-xs text-slate-400">AI reasoning ({(selected.confidence*100).toFixed(0)}% confidence)</div>
                <p className="text-sm text-slate-300">{selected.ai_reasoning}</p>
                <div className="mt-3 text-xs text-slate-400">Proposed action</div>
                <p className="text-sm text-indigo-200">{selected.proposed_action}</p>
                <div className="mt-4 text-xs text-slate-400">Final treatment (logged to audit)</div>
                <textarea value={treatment} onChange={(ev) => setTreatment((ev.target as HTMLTextAreaElement).value)} rows={3}
                  placeholder={selected.proposed_action || 'Describe the treatment…'}
                  className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-400" />
                <div className="mt-4 flex gap-2">
                  <button disabled={busy===selected.id} onClick={() => handleDecision('approved')}
                    className="flex-1 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-900 text-sm font-semibold py-2">Approve</button>
                  <button disabled={busy===selected.id} onClick={() => handleDecision('rejected')}
                    className="flex-1 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-100 text-sm font-semibold py-2">Reject</button>
                </div>
                <p className="mt-3 text-[11px] text-slate-500">Approver: {user?.name || 'Reviewer'} · decision is timestamped and immutable.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'tasks' && (
        <div className="mt-6 space-y-2">
          {tasks.map((t) => (
            <div key={t.id} className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-3">
              <div>
                <p className="text-sm text-slate-100">{t.title}</p>
                <p className="text-[11px] uppercase tracking-wide text-slate-500">{t.category}</p>
              </div>
              <span className={'text-xs px-2 py-1 rounded ' + (t.status==='done' ? 'bg-emerald-500/15 text-emerald-300' : t.status==='in_progress' ? 'bg-sky-500/15 text-sky-300' : t.status==='blocked' ? 'bg-rose-500/15 text-rose-300' : 'bg-slate-700/50 text-slate-300')}>{t.status.replace('_',' ')}</span>
            </div>
          ))}
        </div>
      )}

      {tab === 'audit' && (
        <div className="mt-6 space-y-2">
          {evidence.length === 0 && <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6 text-sm text-slate-400">No decisions recorded yet. Approve or reject an exception to create audit evidence.</div>}
          {evidence.map((a) => (
            <div key={a.id} className="rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-3">
              <div className="flex items-center justify-between">
                <span className={'text-xs px-2 py-0.5 rounded ' + (a.action==='approved' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300')}>{a.action}</span>
                <span className="text-[11px] text-slate-500">{new Date(a.created_at).toLocaleString()}</span>
              </div>
              <p className="mt-2 text-sm text-slate-200">{a.final_treatment}</p>
              <p className="mt-1 text-[11px] text-slate-500">Evidence: {a.source_evidence} · approver {a.approver_name} · conf {a.confidence != null ? (a.confidence*100).toFixed(0)+'%' : 'n/a'}</p>
            </div>
          ))}
        </div>
      )}

      {tab === 'upload' && (
        <div className="mt-6 grid grid-cols-1 lg:grid-cols-5 gap-5">
          <div className="lg:col-span-2 space-y-4">
            <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
              <p className="text-sm font-medium text-slate-200">Upload &amp; connect a source</p>
              <p className="mt-1 text-xs text-slate-500">CSV is parsed in your browser (zero data leaves until you ingest). PDFs are stored for manual review.</p>
              <label className="mt-4 block text-xs text-slate-400">Source type</label>
              <select value={docType} onChange={(e) => { setDocType(e.target.value); setParsedRows([]); setFileName(''); }}
                className="mt-1 w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-slate-200">
                {api.FIN_DOC_TYPES.map((d) => (<option key={d.value} value={d.value}>{d.label}</option>))}
              </select>
              <p className="mt-1 text-[11px] text-slate-500">Expected columns: {(api.FIN_DOC_TYPES.find((d) => d.value === docType) || {hint: ''}).hint}</p>
              <label className="mt-4 block text-xs text-slate-400">File</label>
              <input type="file" accept=".csv,.pdf" onChange={(e) => {
                const f = e.target.files && e.target.files[0]; if (!f) return;
                setFileName(f.name);
                if (docType === 'invoice_pdf' || f.name.toLowerCase().endsWith('.pdf')) { setParsedRows([]); return; }
                const rd = new FileReader();
                rd.onload = () => { try { setParsedRows(api.parseCsvClientSide(String(rd.result || ''))); } catch (err) { setParsedRows([]); } };
                rd.readAsText(f);
              }} className="mt-1 w-full text-xs text-slate-300" />
              <button disabled={!workspace || !fileName || ingesting} onClick={async () => {
                if (!workspace || !tenantId) return; setIngesting(true);
                const res = await api.ingestDocument(tenantId, workspace.id, docType, fileName, parsedRows, (user && user.id) || null);
                setIngesting(false);
                if (res.ok) {
                  setToast(res.status === 'needs_review' ? 'PDF stored for manual review.' : ('Ingested ' + (res.ingested || 0) + ' of ' + (res.total || 0) + ' rows. Run reconciliation to detect exceptions.'));
                  setParsedRows([]); setFileName('');
                  const d = await api.fetchDocuments(tenantId, workspace.id); setDocs(d as any);
                } else { setToast('Ingest failed: ' + (res.error || 'unknown')); }
                setTimeout(() => setToast(''), 5000);
              }} className="mt-4 w-full rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
                style={{ backgroundColor: accent }}>
                {ingesting ? 'Ingesting…' : 'Normalize & ingest'}
              </button>
            </div>
            {parsedRows.length > 0 && (
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
                <p className="text-xs text-slate-400">Preview — {parsedRows.length} rows parsed</p>
                <div className="mt-2 max-h-48 overflow-auto text-[11px] text-slate-300">
                  {parsedRows.slice(0, 8).map((r, i) => (
                    <div key={i} className="border-b border-slate-800 py-1">{Object.keys(r).map((k) => k + '=' + r[k]).join('  ·  ')}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="lg:col-span-3 space-y-2">
            <p className="text-sm font-medium text-slate-200">Uploaded documents</p>
            {docs.length === 0 && (<div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 text-sm text-slate-500">No documents ingested yet.</div>)}
            {docs.map((d) => (
              <div key={d.id} className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-200">{d.filename}</span>
                  <span className={'text-xs px-2 py-0.5 rounded ' + (d.status === 'ingested' ? 'bg-emerald-500/15 text-emerald-300' : d.status === 'needs_review' ? 'bg-amber-500/15 text-amber-300' : 'bg-slate-700 text-slate-300')}>{d.status}</span>
                </div>
                <p className="mt-1 text-[11px] text-slate-500">{d.doc_type} · {d.parse_summary || (d.row_count + ' rows')}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default FinanceControlTowerPage;
