import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../../context/AuthContext';
import { PageHeader, th, td } from '../../../components/ui';
import {
  listAccounts, createAccount, fmtMoneyK, fmtMoney, CustomerApiError,
} from '../../../lib/customerApi';
import type { CustomerAccount } from '../../../lib/customerApi';
import {
  getHealthConfig, saveHealthConfig, recomputeHealth, getAccountSignals, describeComponents,
  DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS,
} from '../../../lib/successApi';
import type { HealthWeights, HealthThresholds, AccountSignals, HealthComponents } from '../../../lib/successApi';
import { listDefinitions, startDefinitionRun } from '../../../lib/playbookBuilderApi';
import type { PlaybookDefinition } from '../../../lib/playbookBuilderApi';
import { LiveLoadingSkeleton, MissingTablesNotice, LiveEmptyState } from '../../../components/LiveDataStates';
import ImportCustomersModal from '../../../components/ImportCustomersModal';

// ============================================================
// Customer Success — LIVE (migration 021).
// Health is COMPUTED from real signals with a transparent component
// breakdown; weights/thresholds are tenant-configurable; at-risk
// accounts feed the account_at_risk playbook trigger.
// Health history is not tracked in v1 (only the latest breakdown);
// activity recency reads from activity_events only.
// ============================================================

const healthColor = (h: number) => (h >= 70 ? 'bg-emerald-500' : h >= 45 ? 'bg-amber-500' : 'bg-red-500');
const healthText = (h: number) => (h >= 70 ? 'text-emerald-300' : h >= 45 ? 'text-amber-300' : 'text-red-300');

const inputCls = 'bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-3 py-2 placeholder-slate-500 focus:outline-none focus:border-indigo-500';

function StatusChip({ status }: { status: CustomerAccount['status'] }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${
      status === 'churned' ? 'bg-slate-700/50 text-slate-400'
      : status === 'at_risk' ? 'bg-red-500/15 text-red-300'
      : 'bg-emerald-500/15 text-emerald-300'
    }`}>{status.replace('_', ' ')}</span>
  );
}

function BreakdownPopover({ c }: { c: HealthComponents }) {
  const rows: Array<{ label: string; count: string; penalty: number; weight: number }> = [
    { label: 'Open tickets', count: String(c.open_tickets?.count ?? 0), penalty: c.open_tickets?.penalty ?? 0, weight: c.open_tickets?.weight ?? 0 },
    { label: 'Escalations', count: String(c.escalations?.count ?? 0), penalty: c.escalations?.penalty ?? 0, weight: c.escalations?.weight ?? 0 },
    { label: 'Overdue invoices', count: String(c.overdue_invoices?.count ?? 0), penalty: c.overdue_invoices?.penalty ?? 0, weight: c.overdue_invoices?.weight ?? 0 },
    { label: 'Activity recency', count: c.activity_recency?.days_since == null ? 'never' : `${c.activity_recency.days_since}d ago`, penalty: c.activity_recency?.penalty ?? 0, weight: c.activity_recency?.weight ?? 0 },
  ];
  return (
    <div className="absolute z-30 top-full left-0 mt-1.5 w-72 rounded-xl border border-slate-700 bg-slate-900 shadow-2xl p-3">
      <p className="text-[11px] font-semibold text-white mb-2">Health breakdown — score {c.score}</p>
      <div className="space-y-1">
        {rows.map(r => (
          <div key={r.label} className="flex items-center justify-between text-[11px]">
            <span className="text-slate-400">{r.label} <span className="text-slate-600">({r.count})</span></span>
            <span className={r.penalty > 0 ? 'text-red-300 font-medium' : 'text-slate-600'}>
              {r.penalty > 0 ? `−${r.penalty}` : '0'} <span className="text-slate-600">/ {r.weight}</span>
            </span>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-slate-600 mt-2">100 − penalties = score · computed {new Date(c.computed_at).toLocaleString()}</p>
    </div>
  );
}

// ── Account detail drawer ─────────────────────────────────────────
function AccountDrawer({ account, onClose, onChanged }: {
  account: CustomerAccount; onClose: () => void; onChanged: () => void;
}) {
  const [signals, setSignals] = useState<AccountSignals | null>(null);
  const [defs, setDefs] = useState<PlaybookDefinition[]>([]);
  const [selDef, setSelDef] = useState('');
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [s, d] = await Promise.all([getAccountSignals(account.id), listDefinitions()]);
        setSignals(s);
        setDefs(d.filter(x => x.status === 'published'));
      } catch (e) { setErr((e as Error).message); }
    })();
  }, [account.id]);

  const runPlaybook = async () => {
    if (!selDef) return;
    setRunning(true); setRunMsg(null); setErr(null);
    try {
      const res = await startDefinitionRun(selDef, account.id);
      setRunMsg(`Run ${res.status}${res.task_id ? ' — waiting on human approval' : ''}`);
      onChanged();
    } catch (e) { setErr((e as Error).message); }
    finally { setRunning(false); }
  };

  const c = account.health_components ?? null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md h-full overflow-y-auto bg-slate-900 border-l border-slate-700 p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-1">
          <h3 className="text-white font-semibold">{account.name}</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-white text-lg leading-none">✕</button>
        </div>
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <StatusChip status={account.status} />
          <span className={`text-xs font-semibold ${healthText(account.health_score)}`}>health {account.health_score}</span>
          <span className="text-xs text-slate-400">{fmtMoneyK(account.arr_cents)} ARR</span>
          {account.renewal_date && <span className="text-xs text-slate-500">renews {account.renewal_date}</span>}
          {account.csm && <span className="text-xs text-slate-500">CSM {account.csm}</span>}
        </div>

        {err && <div className="mb-3 rounded-xl border border-rose-800/50 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{err}</div>}

        {/* Why this score */}
        <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3 mb-4">
          <p className="text-[11px] font-semibold text-white mb-1">Why this score</p>
          <p className="text-xs text-slate-400">{describeComponents(c)}</p>
          <p className="text-[10px] text-slate-600 mt-1.5">Health history is not tracked yet (v1 shows the latest computed breakdown only).</p>
        </div>

        {!signals ? <LiveLoadingSkeleton rows={3} /> : (
          <>
            <Section title={`Open tickets (${signals.openTickets.length})`}>
              {signals.openTickets.length === 0 ? <Empty text="No open tickets." /> : signals.openTickets.map(t => (
                <div key={t.id} className="flex items-center justify-between gap-2 text-xs py-1">
                  <span className="text-slate-300 truncate">{t.subject}</span>
                  <span className={`px-1.5 py-0.5 rounded whitespace-nowrap ${t.status === 'escalated' ? 'bg-red-500/15 text-red-300' : 'bg-slate-800 text-slate-400'}`}>{t.priority} · {t.status}</span>
                </div>
              ))}
            </Section>
            <Section title={`Overdue invoices (${signals.overdueInvoices.length})`}>
              {signals.overdueInvoices.length === 0 ? <Empty text="No overdue invoices." /> : signals.overdueInvoices.map(inv => (
                <div key={inv.id} className="flex items-center justify-between text-xs py-1">
                  <span className="text-slate-300">{fmtMoney(inv.amount_cents)}</span>
                  <span className="text-red-300">due {inv.due_date}</span>
                </div>
              ))}
            </Section>
            <Section title="Recent activity">
              {signals.recentActivity.length === 0 ? <Empty text="No activity recorded for this account yet." /> : signals.recentActivity.map(a => (
                <div key={a.id} className="text-xs py-1">
                  <span className="text-slate-400">{a.text}</span>
                  <span className="text-slate-600 ml-1.5">{new Date(a.created_at).toLocaleDateString()}</span>
                </div>
              ))}
            </Section>
            <Section title="At-risk trigger fires">
              {signals.atRiskFires.length === 0 ? <Empty text="No event-trigger fires for this account." /> : signals.atRiskFires.map(f => (
                <div key={f.id} className="flex items-center justify-between gap-2 text-xs py-1">
                  <span className="text-slate-400 truncate">{f.detail || f.status}</span>
                  <span className={`px-1.5 py-0.5 rounded whitespace-nowrap ${
                    f.status === 'started' ? 'bg-emerald-500/15 text-emerald-300'
                    : f.status === 'skipped_dedup' ? 'bg-slate-800 text-slate-500'
                    : f.status === 'error' ? 'bg-red-500/15 text-red-300' : 'bg-indigo-500/15 text-indigo-300'
                  }`}>{f.status.replace('_', ' ')}</span>
                </div>
              ))}
            </Section>
          </>
        )}

        {/* Run playbook */}
        <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3 mt-4">
          <p className="text-[11px] font-semibold text-white mb-2">Run a playbook on this account</p>
          {defs.length === 0 ? (
            <p className="text-xs text-slate-500">No published playbooks yet — build one in Playbooks.</p>
          ) : (
            <div className="flex gap-2">
              <select className={`${inputCls} flex-1 !py-1.5 !text-xs`} value={selDef} onChange={e => setSelDef(e.target.value)}>
                <option value="">Pick a playbook…</option>
                {defs.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <button onClick={() => void runPlaybook()} disabled={running || !selDef}
                className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-40 transition-colors whitespace-nowrap">
                {running ? 'Starting…' : 'Run'}
              </button>
            </div>
          )}
          {runMsg && <p className="text-[11px] text-emerald-300 mt-2">✓ {runMsg}</p>}
        </div>
      </div>
    </div>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3 mb-3">
    <p className="text-[11px] font-semibold text-white mb-1.5">{title}</p>
    {children}
  </div>
);
const Empty = ({ text }: { text: string }) => <p className="text-xs text-slate-600">{text}</p>;

// ── Health config panel ───────────────────────────────────────────
function HealthConfigPanel({ weights, thresholds, lastComputed, onSaved, onRecomputed }: {
  weights: HealthWeights; thresholds: HealthThresholds; lastComputed: string | null;
  onSaved: (w: HealthWeights, t: HealthThresholds) => void;
  onRecomputed: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [w, setW] = useState(weights);
  const [t, setT] = useState(thresholds);
  const [busy, setBusy] = useState<'save' | 'compute' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { setW(weights); setT(thresholds); }, [weights, thresholds]);

  const save = async () => {
    setBusy('save'); setErr(null);
    try { await saveHealthConfig(w, t); onSaved(w, t); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };
  const recompute = async () => {
    setBusy('compute'); setErr(null);
    try {
      const r = await recomputeHealth(true);
      onRecomputed(`Recomputed ${r.computed} account${r.computed === 1 ? '' : 's'} — ${r.status_flips ?? 0} status change${(r.status_flips ?? 0) === 1 ? '' : 's'}`);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };

  const slider = (key: keyof HealthWeights, label: string) => (
    <label key={key} className="block">
      <span className="flex justify-between text-[11px] text-slate-400 mb-1">
        <span>{label}</span><span className="text-white font-medium">{w[key]}</span>
      </span>
      <input type="range" min={0} max={50} value={w[key]} className="w-full accent-indigo-500"
        onChange={e => setW({ ...w, [key]: Number(e.target.value) })} />
    </label>
  );

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50 mb-5">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-5 py-3 text-left">
        <span className="text-sm font-semibold text-white">Health scoring config</span>
        <span className="text-xs text-slate-500">
          {lastComputed ? `last computed ${new Date(lastComputed).toLocaleString()}` : 'not computed yet'} {open ? '▴' : '▾'}
        </span>
      </button>
      {open && (
        <div className="px-5 pb-5">
          <p className="text-[11px] text-slate-500 mb-3">
            Weights are the maximum penalty each signal can subtract from 100. Nightly recompute runs server-side; the page also refreshes stale scores on load.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 mb-4">
            {slider('open_tickets', 'Open tickets')}
            {slider('escalations', 'Escalations')}
            {slider('overdue_invoices', 'Overdue invoices')}
            {slider('activity_recency', 'Activity recency')}
          </div>
          <div className="flex items-center gap-4 mb-4 flex-wrap">
            <label className="text-[11px] text-slate-400 flex items-center gap-1.5">
              at-risk below
              <input type="number" min={0} max={100} value={t.at_risk_below} className={`${inputCls} !w-16 !py-1 !text-xs`}
                onChange={e => setT({ ...t, at_risk_below: Number(e.target.value) })} />
            </label>
            <label className="text-[11px] text-slate-400 flex items-center gap-1.5">
              healthy above
              <input type="number" min={0} max={100} value={t.healthy_above} className={`${inputCls} !w-16 !py-1 !text-xs`}
                onChange={e => setT({ ...t, healthy_above: Number(e.target.value) })} />
            </label>
          </div>
          {err && <p className="text-[11px] text-rose-400 mb-2">✗ {err}</p>}
          <div className="flex gap-2">
            <button onClick={() => void save()} disabled={busy !== null}
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-40 transition-colors">
              {busy === 'save' ? 'Saving…' : 'Save config'}
            </button>
            <button onClick={() => void recompute()} disabled={busy !== null}
              className="text-xs px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500 disabled:opacity-40 transition-colors">
              {busy === 'compute' ? 'Recomputing…' : 'Recompute now'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────
export default function CustomerSuccessLive() {
  const { liveTenantName } = useAuth();
  const [accounts, setAccounts] = useState<CustomerAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [missingTables, setMissingTables] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [weights, setWeights] = useState<HealthWeights>(DEFAULT_WEIGHTS);
  const [thresholds, setThresholds] = useState<HealthThresholds>(DEFAULT_THRESHOLDS);
  const [lastComputed, setLastComputed] = useState<string | null>(null);
  const [popoverId, setPopoverId] = useState<string | null>(null);
  const [drawerAccount, setDrawerAccount] = useState<CustomerAccount | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newArr, setNewArr] = useState('');
  const [newCsm, setNewCsm] = useState('');
  const [saving, setSaving] = useState(false);

  const loadAccounts = useCallback(async () => {
    setAccounts(await listAccounts());
    const cfg = await getHealthConfig();
    if (cfg) {
      setWeights({ ...DEFAULT_WEIGHTS, ...cfg.weights });
      setThresholds({ ...DEFAULT_THRESHOLDS, ...cfg.thresholds });
      setLastComputed(cfg.last_computed_at);
    }
  }, []);

  const refresh = useCallback(async (opportunisticCompute: boolean) => {
    setLoading(true); setError(null);
    try {
      await loadAccounts();
      setMissingTables(false);
      if (opportunisticCompute) {
        // cheap: server no-ops unless the last compute is > 1h old
        try {
          const r = await recomputeHealth(false);
          if (!r.skipped && r.computed > 0) await loadAccounts();
        } catch { /* stale-compute is best-effort — table view stays correct */ }
      }
    } catch (err) {
      if (err instanceof CustomerApiError && err.missingTables) setMissingTables(true);
      else setError((err as Error)?.message || 'Failed to load accounts.');
    } finally {
      setLoading(false);
    }
  }, [loadAccounts]);

  useEffect(() => { void refresh(true); }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);

  const stats = useMemo(() => {
    const atRisk = accounts.filter(a => a.status === 'at_risk');
    const nonChurned = accounts.filter(a => a.status !== 'churned');
    const avg = nonChurned.length ? Math.round(nonChurned.reduce((s, a) => s + a.health_score, 0) / nonChurned.length) : 0;
    return {
      total: accounts.length,
      atRisk: atRisk.length,
      avgHealth: avg,
      arrAtRisk: atRisk.reduce((s, a) => s + a.arr_cents, 0),
    };
  }, [accounts]);

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
      void refresh(false);
    } catch (err) {
      setError((err as Error)?.message || 'Failed to add account.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6" onClick={() => setPopoverId(null)}>
      <div className="flex items-start justify-between flex-wrap gap-3">
        <PageHeader
          title="Customer Success — Customer Lifecycle"
          subtitle={`${liveTenantName || 'Your company'} · health computed from tickets, invoices, and activity`}
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

      {toast && <div className="mb-4 rounded-xl border border-emerald-800/50 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-300">✓ {toast}</div>}
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
        <>
          {/* Header stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
            {[
              { label: 'Accounts', value: String(stats.total), color: 'text-white' },
              { label: 'At risk', value: String(stats.atRisk), color: stats.atRisk > 0 ? 'text-red-300' : 'text-emerald-300' },
              { label: 'Avg health', value: String(stats.avgHealth), color: healthText(stats.avgHealth) },
              { label: 'ARR at risk', value: fmtMoneyK(stats.arrAtRisk), color: stats.arrAtRisk > 0 ? 'text-red-300' : 'text-slate-300' },
            ].map(s => (
              <div key={s.label} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">{s.label}</p>
                <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
              </div>
            ))}
          </div>

          <HealthConfigPanel
            weights={weights} thresholds={thresholds} lastComputed={lastComputed}
            onSaved={(w, t) => { setWeights(w); setThresholds(t); setToast('Health config saved — recompute to apply the new weights.'); }}
            onRecomputed={msg => { setToast(msg); void refresh(false); }}
          />

          {/* Accounts table */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
            <h3 className="text-sm font-semibold text-white mb-1">Account health</h3>
            <p className="text-[11px] text-slate-500 mb-3">Click a health bar for the component breakdown · click a row for signal detail.</p>
            <div className="overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-slate-800">
                    {['Account', 'Health', 'Status', 'ARR', 'Renewal', 'CSM', 'Last activity'].map(h => <th key={h} className={th}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a, i) => {
                    const risk = a.status === 'at_risk';
                    const days = a.health_components?.activity_recency?.days_since;
                    return (
                      <tr key={a.id} onClick={() => setDrawerAccount(a)}
                        className={`border-b border-slate-800/60 transition-colors cursor-pointer ${risk ? 'bg-red-500/5 hover:bg-red-500/10' : 'hover:bg-slate-800/30'} ${i === accounts.length - 1 ? 'border-b-0' : ''}`}>
                        <td className={`${td} font-medium ${risk ? 'text-red-200' : 'text-white'}`}>{a.name}</td>
                        <td className={td} onClick={e => e.stopPropagation()}>
                          <div className="relative">
                            <button className="flex items-center gap-2 min-w-[110px] w-full"
                              title={describeComponents(a.health_components)}
                              onClick={() => setPopoverId(popoverId === a.id ? null : a.id)}>
                              <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${healthColor(a.health_score)}`} style={{ width: `${a.health_score}%` }} />
                              </div>
                              <span className={`text-xs font-medium w-6 text-right ${healthText(a.health_score)}`}>{a.health_score}</span>
                            </button>
                            {popoverId === a.id && a.health_components && <BreakdownPopover c={a.health_components} />}
                            {popoverId === a.id && !a.health_components && (
                              <div className="absolute z-30 top-full left-0 mt-1.5 w-56 rounded-xl border border-slate-700 bg-slate-900 shadow-2xl p-3 text-[11px] text-slate-400">
                                Not computed yet — use “Recompute now” in the health config panel.
                              </div>
                            )}
                          </div>
                        </td>
                        <td className={td}><StatusChip status={a.status} /></td>
                        <td className={`${td} text-slate-300 text-xs`}>{fmtMoneyK(a.arr_cents)}</td>
                        <td className={`${td} text-slate-500 text-xs whitespace-nowrap`}>{a.renewal_date || '—'}</td>
                        <td className={`${td} text-slate-400 text-xs`}>{a.csm || '—'}</td>
                        <td className={`${td} text-slate-500 text-xs whitespace-nowrap`}>
                          {days == null ? (a.health_components ? 'never' : '—') : days === 0 ? 'today' : `${days}d ago`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {drawerAccount && (
        <AccountDrawer account={drawerAccount} onClose={() => setDrawerAccount(null)} onChanged={() => void refresh(false)} />
      )}

      {/* Add account modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <h3 className="text-white font-semibold mb-4">Add account</h3>
            <div className="space-y-3 mb-5">
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1">Account name</label>
                <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Acme Corp" className={`w-full ${inputCls}`} />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1">ARR ($/year)</label>
                <input value={newArr} onChange={e => setNewArr(e.target.value)} placeholder="84000" type="number" className={`w-full ${inputCls}`} />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1">CSM</label>
                <input value={newCsm} onChange={e => setNewCsm(e.target.value)} placeholder="P. Sharma" className={`w-full ${inputCls}`} />
              </div>
            </div>
            <div className="flex gap-3">
              <button onClick={() => void addAccount()} disabled={saving || !newName.trim()}
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
        <ImportCustomersModal initialTab="accounts" onClose={() => setShowImport(false)} onImported={() => void refresh(false)} />
      )}
    </div>
  );
}
