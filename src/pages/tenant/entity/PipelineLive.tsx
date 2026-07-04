import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../../context/AuthContext';
import { PageHeader, th, td } from '../../../components/ui';
import {
  listOpportunities, createOpportunity, updateOpportunity, moveStage, closeWon, closeLost,
  getPipelineSummary, importOpportunitiesCsv,
  STAGE_LABELS, SALES_STAGES,
} from '../../../lib/pipelineApi';
import type { Opportunity, OppStage, PipelineSummaryRow, OpportunityImportRow } from '../../../lib/pipelineApi';
import { listAccounts, fmtMoneyK, parseCsv, CustomerApiError } from '../../../lib/customerApi';
import type { CustomerAccount } from '../../../lib/customerApi';
import { listPublishedVersions, installStarterTemplate } from '../../../lib/onboardingApi';
import type { TemplateVersion } from '../../../lib/onboardingApi';
import { LiveLoadingSkeleton, MissingTablesNotice, LiveEmptyState } from '../../../components/LiveDataStates';

// ============================================================
// BD + Sales — LIVE pipeline (migration 023).
//
// DESIGN CALL — one opportunities table, two lenses: BD and Sales are
// the same pipeline data (opportunities), not two systems. The BD page
// is the top-of-funnel lens (prospect stage: add, import, qualify);
// the Sales page is the deal lens (qualified → proposal → negotiation
// → won/lost: table + stage select, no drag-drop in v1). "Qualify" on
// BD literally moves the row into the Sales lens — one source of
// truth, zero re-entry, which is exactly the lifecycle promise.
//
// SoR DOCTRINE: your CRM stays your CRM. This is a working cache /
// action workspace; native mode + CSV import are the bootstrap for
// tenants without a CRM; the Salesforce/HubSpot connector is the sync
// upgrade (source + external_ref are already carried on every row).
//
// THE LIFECYCLE SPINE: Won flow → account created/linked → optional
// onboarding kickoff (022) → health monitoring (021) → renewal plays
// (020). Winning a deal closes the Customer Lifecycle loop.
// ============================================================

const inputCls = 'bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-3 py-2 placeholder-slate-500 focus:outline-none focus:border-indigo-500';

const stageChip = (s: OppStage) =>
  s === 'won' ? 'bg-emerald-500/15 text-emerald-300'
  : s === 'lost' ? 'bg-red-500/15 text-red-300'
  : s === 'negotiation' ? 'bg-emerald-500/15 text-emerald-300'
  : s === 'proposal' ? 'bg-indigo-500/15 text-indigo-300'
  : s === 'qualified' ? 'bg-sky-500/15 text-sky-300'
  : 'bg-slate-700/50 text-slate-300';

const fmtAmount = (cents: number | null) => (cents == null ? '—' : fmtMoneyK(cents));

// ── SoR framing banner ────────────────────────────────────────────
function SorBanner() {
  return (
    <div className="mb-5 flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3">
      <span className="text-slate-500">◎</span>
      <p className="text-xs text-slate-400">
        <span className="text-slate-300 font-medium">Your CRM stays your CRM.</span> This pipeline is a
        working cache for your Digital Employees to act on — native mode is your bootstrap if you don't
        have a CRM yet. CRM sync arrives with the Salesforce/HubSpot connector.
      </p>
    </div>
  );
}

// ── Summary strip (shared by both lenses) ─────────────────────────
function SummaryStrip({ summary }: { summary: PipelineSummaryRow[] }) {
  const bystage = (s: OppStage) => summary.find(r => r.stage === s);
  const openTotal = summary.filter(r => !['won', 'lost'].includes(r.stage))
    .reduce((acc, r) => acc + r.amount_cents, 0);
  const winRate = summary.find(r => r.win_rate_90d != null)?.win_rate_90d ?? null;
  const cards = [
    { label: 'Open pipeline', value: fmtMoneyK(openTotal), color: 'text-white' },
    ...(['prospect', 'qualified', 'proposal', 'negotiation'] as OppStage[]).map(s => ({
      label: STAGE_LABELS[s],
      value: `${bystage(s)?.opp_count ?? 0} · ${fmtAmount(bystage(s)?.amount_cents ?? 0)}`,
      color: 'text-slate-200',
    })),
    { label: 'Win rate (90d)', value: winRate == null ? '—' : `${winRate}%`, color: winRate == null ? 'text-slate-500' : winRate >= 50 ? 'text-emerald-300' : 'text-amber-300' },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-5">
      {cards.map(c => (
        <div key={c.label} className="bg-slate-900 border border-slate-800 rounded-xl p-3">
          <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">{c.label}</p>
          <p className={`text-sm font-bold ${c.color}`}>{c.value}</p>
        </div>
      ))}
    </div>
  );
}

// ── CSV import modal (opportunities flavor of the 011 pattern) ────
interface FieldDef { key: keyof OpportunityImportRow; label: string; required?: boolean; aliases: string[] }
const OPP_FIELDS: FieldDef[] = [
  { key: 'company', label: 'Company', required: true, aliases: ['company', 'company name', 'account', 'account name', 'prospect'] },
  { key: 'name', label: 'Opportunity name', aliases: ['name', 'opportunity', 'opportunity name', 'deal', 'deal name'] },
  { key: 'stage', label: 'Stage', aliases: ['stage', 'status', 'phase'] },
  { key: 'amount', label: 'Amount', aliases: ['amount', 'value', 'deal size', 'arr', 'acv'] },
  { key: 'close_date', label: 'Close date (YYYY-MM-DD)', aliases: ['close date', 'close_date', 'closes', 'expected close'] },
  { key: 'owner', label: 'Owner', aliases: ['owner', 'rep', 'salesperson', 'account executive', 'ae'] },
];

function ImportOpportunitiesModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [csvText, setCsvText] = useState('');
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [mappedFor, setMappedFor] = useState('');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ imported: number; errors: { row: number; message: string }[] } | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  const parsed = useMemo(() => {
    if (!csvText.trim()) return null;
    const rows = parseCsv(csvText);
    if (rows.length < 1) return null;
    return { headers: rows[0].map(h => h.trim()), dataRows: rows.slice(1) };
  }, [csvText]);

  const mapKey = parsed ? parsed.headers.join('|') : '';
  if (parsed && mappedFor !== mapKey) {
    const m: Record<string, number> = {};
    const used = new Set<number>();
    for (const f of OPP_FIELDS) {
      const idx = parsed.headers.findIndex((h, i) => !used.has(i) && f.aliases.includes(h.trim().toLowerCase()));
      if (idx >= 0) { m[f.key] = idx; used.add(idx); }
    }
    setMapping(m); setMappedFor(mapKey); setResult(null); setFatal(null);
  }

  const mappedRows = useMemo(() => {
    if (!parsed) return [];
    return parsed.dataRows.map(cells => {
      const obj: OpportunityImportRow = {};
      for (const f of OPP_FIELDS) {
        const idx = mapping[f.key];
        if (idx !== undefined && idx >= 0) obj[f.key] = (cells[idx] ?? '').trim();
      }
      return obj;
    });
  }, [parsed, mapping]);

  const requiredMapped = OPP_FIELDS.filter(f => f.required).every(f => mapping[f.key] !== undefined && mapping[f.key] >= 0);

  const runImport = async () => {
    if (!parsed || mappedRows.length === 0) return;
    setImporting(true); setFatal(null); setResult(null);
    try {
      const res = await importOpportunitiesCsv(mappedRows);
      setResult(res);
      if (res.imported > 0) onImported();
    } catch (err) {
      setFatal((err as Error)?.message || 'Import failed.');
    } finally { setImporting(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between p-5 border-b border-slate-800">
          <div>
            <h3 className="text-white font-semibold">Import pipeline (bootstrap)</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              One-time bootstrap from a CRM export — your CRM remains the system of record. Won/lost rows import as open stages (closing is guarded).
            </p>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg bg-slate-800 text-slate-400 hover:text-white flex items-center justify-center text-xs">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-slate-400">CSV data</label>
              <label className="text-xs text-indigo-400 hover:text-indigo-300 cursor-pointer">
                Upload file
                <input type="file" accept=".csv,text/csv,text/plain" className="hidden"
                  onChange={e => {
                    const f = e.target.files?.[0];
                    if (f) { const r = new FileReader(); r.onload = () => setCsvText(String(r.result || '')); r.readAsText(f); }
                    e.target.value = '';
                  }} />
              </label>
            </div>
            <textarea value={csvText} onChange={e => setCsvText(e.target.value)} rows={5}
              placeholder={'company,name,stage,amount,close_date,owner\nLakeside Retail,Lakeside — Growth,qualified,$96K,2026-07-25,S. Mitchell'}
              className="w-full bg-slate-950 border border-slate-700 text-white text-xs font-mono rounded-xl px-3 py-2.5 placeholder-slate-600 focus:outline-none focus:border-indigo-500" />
          </div>
          {parsed && (
            <div>
              <p className="text-xs font-medium text-slate-400 mb-2">Column mapping — {parsed.dataRows.length} data row(s)</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {OPP_FIELDS.map(f => (
                  <div key={f.key} className="flex items-center gap-2 bg-slate-800/60 rounded-lg px-2.5 py-1.5">
                    <span className="text-xs text-slate-300 flex-1 truncate">{f.label}{f.required && <span className="text-rose-400"> *</span>}</span>
                    <select value={mapping[f.key] ?? -1}
                      onChange={e => setMapping(prev => ({ ...prev, [f.key]: Number(e.target.value) }))}
                      className="bg-slate-950 border border-slate-700 rounded text-xs text-white px-2 py-1 focus:outline-none focus:border-indigo-500 max-w-[140px]">
                      <option value={-1}>— skip —</option>
                      {parsed.headers.map((h, i) => <option key={i} value={i}>{h || `(column ${i + 1})`}</option>)}
                    </select>
                  </div>
                ))}
              </div>
              {!requiredMapped && <p className="text-xs text-amber-400 mt-2">Map the required column(s) marked * to continue.</p>}
            </div>
          )}
          {fatal && <div className="rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{fatal}</div>}
          {result && (
            <div className="rounded-xl border border-slate-700 bg-slate-800/60 px-4 py-3 text-xs">
              <p className="text-emerald-300 font-medium mb-1">{result.imported} row(s) imported.</p>
              {result.errors.length > 0 && (
                <ul className="list-disc ml-4 text-amber-400/80 space-y-0.5">
                  {result.errors.slice(0, 8).map(e => <li key={e.row}>Row {e.row}: {e.message}</li>)}
                  {result.errors.length > 8 && <li>…and {result.errors.length - 8} more</li>}
                </ul>
              )}
            </div>
          )}
        </div>
        <div className="p-5 border-t border-slate-800 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-slate-300 border border-slate-700 hover:border-slate-500 transition-colors">
            {result ? 'Done' : 'Cancel'}
          </button>
          <button onClick={() => void runImport()} disabled={!parsed || mappedRows.length === 0 || !requiredMapped || importing}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
            {importing ? 'Importing…' : 'Import opportunities'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Won flow modal — the lifecycle handoff ────────────────────────
function WonModal({ opp, onClose, onWon }: {
  opp: Opportunity; onClose: () => void;
  onWon: (msg: string) => void;
}) {
  const [accounts, setAccounts] = useState<CustomerAccount[]>([]);
  const [versions, setVersions] = useState<TemplateVersion[]>([]);
  const [linkAccountId, setLinkAccountId] = useState<string>('');
  const [startOnboarding, setStartOnboarding] = useState(true);
  const [versionId, setVersionId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [accts, vers] = await Promise.all([listAccounts(), listPublishedVersions()]);
        setAccounts(accts);
        setVersions(vers);
        if (vers.length > 0) setVersionId(vers[0].id);
        // suggest an existing account whose name matches the company
        const match = accts.find(a => a.name.trim().toLowerCase() === (opp.company_name || opp.name).trim().toLowerCase());
        if (match) setLinkAccountId(match.id);
      } catch { /* pickers degrade gracefully */ }
    })();
  }, [opp]);

  const installStarter = async () => {
    setInstalling(true); setErr(null);
    try {
      await installStarterTemplate();
      const vers = await listPublishedVersions();
      setVersions(vers);
      if (vers.length > 0) setVersionId(vers[0].id);
    } catch (e) { setErr((e as Error).message); }
    finally { setInstalling(false); }
  };

  const confirm = async () => {
    setBusy(true); setErr(null);
    try {
      const res = await closeWon({
        opportunityId: opp.id,
        linkAccountId: linkAccountId || null,
        createOnboarding: startOnboarding && !!versionId,
        templateVersionId: startOnboarding ? (versionId || null) : null,
      });
      const acctName = linkAccountId
        ? (accounts.find(a => a.id === linkAccountId)?.name ?? 'account')
        : (opp.company_name || opp.name);
      onWon(res.project_id
        ? `Deal won — account "${acctName}" is live and onboarding has started. Track it in WHO WE SERVE → Onboarding & Success.`
        : `Deal won — account "${acctName}" is live in Customer Success.${res.onboarding_error ? ` (Onboarding: ${res.onboarding_error.replace(/_/g, ' ')})` : ''}`);
      onClose();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-md shadow-2xl">
        <h3 className="text-white font-semibold mb-1">Close won — {opp.name}</h3>
        <p className="text-xs text-slate-500 mb-4">
          Winning creates the customer account and hands the relationship to the lifecycle:
          onboarding → health monitoring → renewals. No re-entry.
        </p>

        <div className="space-y-3 mb-5">
          <div>
            <label className="text-xs font-medium text-slate-400 block mb-1">Customer account</label>
            <select value={linkAccountId} onChange={e => setLinkAccountId(e.target.value)} className={`w-full ${inputCls}`}>
              <option value="">Create new — “{opp.company_name || opp.name}”</option>
              {accounts.map(a => <option key={a.id} value={a.id}>Link existing — {a.name}</option>)}
            </select>
            {!linkAccountId && (
              <p className="text-[10px] text-slate-600 mt-1">
                New account ARR = deal amount ({fmtAmount(opp.amount_cents)}) — adjust later in Customer Success if needed.
              </p>
            )}
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={startOnboarding} onChange={e => setStartOnboarding(e.target.checked)} className="accent-indigo-500" />
            Start onboarding immediately
          </label>
          {startOnboarding && (
            versions.length === 0 ? (
              <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                <p className="text-xs text-slate-500 mb-2">No published onboarding template yet.</p>
                <button onClick={() => void installStarter()} disabled={installing}
                  className="text-xs px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500 disabled:opacity-40 transition-colors">
                  {installing ? 'Installing…' : 'Install the 10-step starter template'}
                </button>
              </div>
            ) : (
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1">Onboarding template</label>
                <select value={versionId} onChange={e => setVersionId(e.target.value)} className={`w-full ${inputCls}`}>
                  {versions.map(v => <option key={v.id} value={v.id}>{v.name} · v{v.version} ({v.items.length} items)</option>)}
                </select>
              </div>
            )
          )}
        </div>

        {err && <p className="text-xs text-rose-400 mb-3">✗ {err}</p>}
        <div className="flex gap-3">
          <button onClick={() => void confirm()} disabled={busy || (startOnboarding && versions.length > 0 && !versionId)}
            className="flex-1 py-2 text-sm font-medium rounded-lg text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 transition-all">
            {busy ? 'Closing…' : 'Confirm won'}
          </button>
          <button onClick={onClose} className="flex-1 py-2 text-sm rounded-lg border border-slate-700 text-slate-300 hover:border-slate-500 transition-all">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Lost flow modal — reason required ─────────────────────────────
function LostModal({ opp, onClose, onLost }: { opp: Opportunity; onClose: () => void; onLost: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true); setErr(null);
    try { await closeLost(opp.id, reason.trim()); onLost(); onClose(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
        <h3 className="text-white font-semibold mb-1">Close lost — {opp.name}</h3>
        <p className="text-xs text-slate-500 mb-4">A reason is required — lost reasons feed your win/loss learning loop.</p>
        <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3}
          placeholder="e.g. Went with incumbent — pricing" className={`w-full ${inputCls} mb-3`} />
        {err && <p className="text-xs text-rose-400 mb-3">✗ {err}</p>}
        <div className="flex gap-3">
          <button onClick={() => void confirm()} disabled={busy || !reason.trim()}
            className="flex-1 py-2 text-sm font-medium rounded-lg text-white bg-red-600 hover:bg-red-500 disabled:opacity-50 transition-all">
            {busy ? 'Closing…' : 'Confirm lost'}
          </button>
          <button onClick={onClose} className="flex-1 py-2 text-sm rounded-lg border border-slate-700 text-slate-300 hover:border-slate-500 transition-all">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Shared data hook ──────────────────────────────────────────────
function usePipeline() {
  const [opps, setOpps] = useState<Opportunity[]>([]);
  const [summary, setSummary] = useState<PipelineSummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [missingTables, setMissingTables] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [o, s] = await Promise.all([listOpportunities(), getPipelineSummary()]);
      setOpps(o); setSummary(s); setMissingTables(false);
    } catch (err) {
      if (err instanceof CustomerApiError && err.missingTables) setMissingTables(true);
      else setError((err as Error)?.message || 'Failed to load pipeline.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  return { opps, summary, loading, missingTables, error, refresh };
}

function useToast(): [string | null, (m: string) => void] {
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(id);
  }, [toast]);
  return [toast, setToast];
}

// ══════════════════════════════════════════════════════════════════
// BD lens — top of funnel: prospects, add, import, qualify.
// ══════════════════════════════════════════════════════════════════
export function CustomerBDLive() {
  const { liveTenantName } = useAuth();
  const { opps, summary, loading, missingTables, error, refresh } = usePipeline();
  const [toast, setToast] = useToast();
  const [showImport, setShowImport] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newCompany, setNewCompany] = useState('');
  const [newName, setNewName] = useState('');
  const [newOwner, setNewOwner] = useState('');
  const [saving, setSaving] = useState(false);
  const [qualifying, setQualifying] = useState<string | null>(null);

  const prospects = useMemo(() => opps.filter(o => o.stage === 'prospect'), [opps]);
  const qualifiedCount = useMemo(() => opps.filter(o => o.stage === 'qualified').length, [opps]);

  const addProspect = async () => {
    if (!newCompany.trim()) return;
    setSaving(true);
    try {
      await createOpportunity({
        name: newName.trim() || `${newCompany.trim()} — opportunity`,
        company_name: newCompany.trim(),
        stage: 'prospect',
        owner: newOwner.trim(),
      });
      setShowAdd(false); setNewCompany(''); setNewName(''); setNewOwner('');
      void refresh();
    } catch (e) { setToast((e as Error).message); }
    finally { setSaving(false); }
  };

  const qualify = async (o: Opportunity) => {
    setQualifying(o.id);
    try {
      await moveStage(o.id, 'qualified');
      setToast(`${o.company_name || o.name} qualified — now in the Sales pipeline.`);
      void refresh();
    } catch (e) { setToast((e as Error).message); }
    finally { setQualifying(null); }
  };

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <PageHeader
          title="Business Development — Customer Lifecycle"
          subtitle={`${liveTenantName || 'Your company'} · top of funnel — qualify prospects into the Sales pipeline`}
        />
        {!missingTables && !loading && (
          <div className="flex gap-2">
            <button onClick={() => setShowImport(true)} className="px-3 py-1.5 rounded-lg text-xs text-slate-300 border border-slate-700 hover:border-slate-500 hover:text-white transition-colors">
              + Import CSV
            </button>
            <button onClick={() => setShowAdd(true)} className="px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 transition-colors">
              + Add prospect
            </button>
          </div>
        )}
      </div>

      <SorBanner />
      {toast && <div className="mb-4 rounded-xl border border-emerald-800/50 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-300">✓ {toast}</div>}
      {error && <div className="mb-4 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{error}</div>}

      {loading ? <LiveLoadingSkeleton rows={5} /> : missingTables ? <MissingTablesNotice /> : (
        <>
          <SummaryStrip summary={summary} />
          {prospects.length === 0 ? (
            <LiveEmptyState
              icon="◎"
              title="No prospects yet"
              body={`Add prospects by hand or bootstrap from a CRM export. ${qualifiedCount > 0 ? `${qualifiedCount} qualified deal(s) are already in the Sales pipeline.` : 'Qualified prospects move into the Sales pipeline automatically.'}`}
              primaryLabel="Import CSV"
              onPrimary={() => setShowImport(true)}
              secondaryLabel="Add prospect"
              onSecondary={() => setShowAdd(true)}
            />
          ) : (
            <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
              <h3 className="text-sm font-semibold text-white mb-1">Prospect list</h3>
              <p className="text-[11px] text-slate-500 mb-3">Qualify a prospect to hand it to the Sales lens — same pipeline, next stage.</p>
              <div className="overflow-x-auto rounded-xl border border-slate-800">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800">
                      {['Company', 'Opportunity', 'Owner', 'Source', 'Added', ''].map((h, i) => <th key={i} className={th}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {prospects.map((p, i) => (
                      <tr key={p.id} className={`border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors ${i === prospects.length - 1 ? 'border-b-0' : ''}`}>
                        <td className={`${td} font-medium text-white`}>{p.company_name || '—'}</td>
                        <td className={`${td} text-slate-300 text-xs`}>{p.name}</td>
                        <td className={`${td} text-slate-400 text-xs`}>{p.owner || 'Unassigned'}</td>
                        <td className={`${td} text-xs`}>
                          <span className={`px-2 py-0.5 rounded-full ${p.source === 'native' ? 'bg-slate-700/50 text-slate-300' : 'bg-indigo-500/15 text-indigo-300'}`}>{p.source}</span>
                        </td>
                        <td className={`${td} text-slate-500 text-xs whitespace-nowrap`}>{new Date(p.created_at).toLocaleDateString()}</td>
                        <td className={`${td} text-right`}>
                          <button onClick={() => void qualify(p)} disabled={qualifying === p.id}
                            className="text-xs px-2.5 py-1 rounded-lg bg-sky-600/20 text-sky-300 hover:bg-sky-600/40 disabled:opacity-40 transition-colors whitespace-nowrap">
                            {qualifying === p.id ? 'Qualifying…' : 'Qualify →'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <h3 className="text-white font-semibold mb-4">Add prospect</h3>
            <div className="space-y-3 mb-5">
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1">Company</label>
                <input value={newCompany} onChange={e => setNewCompany(e.target.value)} placeholder="Acme Corp" className={`w-full ${inputCls}`} />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1">Opportunity name (optional)</label>
                <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Acme — Growth plan" className={`w-full ${inputCls}`} />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1">Owner</label>
                <input value={newOwner} onChange={e => setNewOwner(e.target.value)} placeholder="J. Cooper" className={`w-full ${inputCls}`} />
              </div>
            </div>
            <div className="flex gap-3">
              <button onClick={() => void addProspect()} disabled={saving || !newCompany.trim()}
                className="flex-1 py-2 text-sm font-medium rounded-lg text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 transition-all">
                {saving ? 'Saving…' : 'Add prospect'}
              </button>
              <button onClick={() => setShowAdd(false)} className="flex-1 py-2 text-sm rounded-lg border border-slate-700 text-slate-300 hover:border-slate-500 transition-all">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {showImport && <ImportOpportunitiesModal onClose={() => setShowImport(false)} onImported={() => void refresh()} />}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// Sales lens — qualified → proposal → negotiation → won/lost.
// Table + stage select (no drag-drop in v1 — honest simplicity).
// ══════════════════════════════════════════════════════════════════
export function CustomerSalesLive() {
  const { liveTenantName } = useAuth();
  const { opps, summary, loading, missingTables, error, refresh } = usePipeline();
  const [toast, setToast] = useToast();
  const [stageFilter, setStageFilter] = useState<'open' | OppStage>('open');
  const [wonOpp, setWonOpp] = useState<Opportunity | null>(null);
  const [lostOpp, setLostOpp] = useState<Opportunity | null>(null);
  const [editing, setEditing] = useState<string | null>(null);   // opp id being edited
  const [editAmount, setEditAmount] = useState('');
  const [editClose, setEditClose] = useState('');

  const deals = useMemo(() => {
    const inSales = opps.filter(o => o.stage !== 'prospect');
    if (stageFilter === 'open') return inSales.filter(o => SALES_STAGES.includes(o.stage));
    return inSales.filter(o => o.stage === stageFilter);
  }, [opps, stageFilter]);

  const prospectCount = useMemo(() => opps.filter(o => o.stage === 'prospect').length, [opps]);

  const onStageSelect = async (o: Opportunity, next: string) => {
    if (next === o.stage) return;
    if (next === 'won') { setWonOpp(o); return; }
    if (next === 'lost') { setLostOpp(o); return; }
    try {
      await moveStage(o.id, next as Exclude<OppStage, 'won' | 'lost'>);
      void refresh();
    } catch (e) { setToast((e as Error).message); }
  };

  const startEdit = (o: Opportunity) => {
    setEditing(o.id);
    setEditAmount(o.amount_cents == null ? '' : String(Math.round(o.amount_cents / 100)));
    setEditClose(o.close_date ?? '');
  };
  const saveEdit = async (o: Opportunity) => {
    try {
      await updateOpportunity(o.id, {
        amount_cents: editAmount.trim() === '' ? null : Math.round((parseFloat(editAmount) || 0) * 100),
        close_date: /^\d{4}-\d{2}-\d{2}$/.test(editClose) ? editClose : null,
      });
      setEditing(null);
      void refresh();
    } catch (e) { setToast((e as Error).message); }
  };

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageHeader
        title="Sales — Customer Lifecycle"
        subtitle={`${liveTenantName || 'Your company'} · qualified deals through to won/lost — winning hands off to Onboarding automatically`}
      />
      <SorBanner />
      {toast && <div className="mb-4 rounded-xl border border-emerald-800/50 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-300">✓ {toast}</div>}
      {error && <div className="mb-4 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{error}</div>}

      {loading ? <LiveLoadingSkeleton rows={5} /> : missingTables ? <MissingTablesNotice /> : (
        <>
          <SummaryStrip summary={summary} />
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
            <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
              <div>
                <h3 className="text-sm font-semibold text-white">Pipeline</h3>
                <p className="text-[11px] text-slate-500">
                  Change the stage inline · Won opens the account + onboarding handoff · Lost requires a reason.
                  {prospectCount > 0 && ` ${prospectCount} prospect(s) are still in the BD lens.`}
                </p>
              </div>
              <div className="flex gap-1 bg-slate-800 rounded-xl p-1">
                {(['open', 'won', 'lost'] as const).map(f => (
                  <button key={f} onClick={() => setStageFilter(f)}
                    className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${stageFilter === f ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`}>
                    {f === 'open' ? 'Open' : STAGE_LABELS[f]}
                  </button>
                ))}
              </div>
            </div>
            {deals.length === 0 ? (
              <p className="text-xs text-slate-500 py-6 text-center">
                {stageFilter === 'open'
                  ? 'No open deals — qualify prospects in Business Development to fill the pipeline.'
                  : `No ${stageFilter} deals yet.`}
              </p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-slate-800">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800">
                      {['Opportunity', 'Company', 'Amount', 'Stage', 'Close date', 'Owner', ''].map((h, i) => <th key={i} className={th}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {deals.map((o, i) => {
                      const closed = o.stage === 'won' || o.stage === 'lost';
                      return (
                        <tr key={o.id} className={`border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors ${i === deals.length - 1 ? 'border-b-0' : ''}`}>
                          <td className={`${td} font-medium text-white`}>
                            {o.name}
                            {o.stage === 'lost' && o.lost_reason && <p className="text-[10px] text-slate-500 font-normal mt-0.5">Lost: {o.lost_reason}</p>}
                          </td>
                          <td className={`${td} text-slate-400 text-xs`}>{o.company_name || '—'}</td>
                          <td className={`${td} text-slate-300 text-xs`}>
                            {editing === o.id ? (
                              <input value={editAmount} onChange={e => setEditAmount(e.target.value)} type="number" placeholder="96000"
                                className={`${inputCls} !w-24 !py-1 !text-xs`} />
                            ) : fmtAmount(o.amount_cents)}
                          </td>
                          <td className={td}>
                            {closed ? (
                              <span className={`text-xs px-2 py-0.5 rounded-full ${stageChip(o.stage)}`}>{STAGE_LABELS[o.stage]}</span>
                            ) : (
                              <select value={o.stage} onChange={e => void onStageSelect(o, e.target.value)}
                                className="bg-slate-950 border border-slate-700 rounded-lg text-xs text-white px-2 py-1 focus:outline-none focus:border-indigo-500">
                                {(['qualified', 'proposal', 'negotiation'] as OppStage[]).map(s => (
                                  <option key={s} value={s}>{STAGE_LABELS[s]}</option>
                                ))}
                                <option value="won">✓ Won…</option>
                                <option value="lost">✗ Lost…</option>
                              </select>
                            )}
                          </td>
                          <td className={`${td} text-slate-400 text-xs whitespace-nowrap`}>
                            {editing === o.id ? (
                              <input value={editClose} onChange={e => setEditClose(e.target.value)} type="date"
                                className={`${inputCls} !py-1 !text-xs`} />
                            ) : (o.close_date || '—')}
                          </td>
                          <td className={`${td} text-slate-400 text-xs`}>{o.owner || '—'}</td>
                          <td className={`${td} text-right whitespace-nowrap`}>
                            {!closed && (editing === o.id ? (
                              <span className="flex gap-1 justify-end">
                                <button onClick={() => void saveEdit(o)} className="text-xs px-2 py-1 rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 transition-colors">Save</button>
                                <button onClick={() => setEditing(null)} className="text-xs px-2 py-1 rounded-lg border border-slate-700 text-slate-400 hover:text-white transition-colors">✕</button>
                              </span>
                            ) : (
                              <button onClick={() => startEdit(o)} className="text-xs px-2 py-1 rounded-lg border border-slate-700 text-slate-400 hover:text-white hover:border-slate-500 transition-colors">Edit</button>
                            ))}
                            {o.stage === 'won' && o.account_id && (
                              <span className="text-[10px] text-emerald-400/80">→ account live</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {wonOpp && <WonModal opp={wonOpp} onClose={() => setWonOpp(null)} onWon={m => { setToast(m); void refresh(); }} />}
      {lostOpp && <LostModal opp={lostOpp} onClose={() => setLostOpp(null)} onLost={() => { setToast('Deal closed as lost — reason recorded.'); void refresh(); }} />}
    </div>
  );
}
