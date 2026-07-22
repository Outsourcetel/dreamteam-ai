import React from 'react';
import { useAuth } from '../../../context/AuthContext';
import type { Page } from '../../../types';
import { useDataMode } from '../../../lib/dataMode';
import { listTickets, updateTicket, CustomerApiError } from '../../../lib/customerApi';
import type { SupportTicket, TicketStatus } from '../../../lib/customerApi';
import { LiveLoadingSkeleton, MissingTablesNotice, LiveEmptyState } from '../../../components/LiveDataStates';
import ImportCustomersModal from '../../../components/ImportCustomersModal';

// ============================================================
// Support — Customer Lifecycle
// Migrated from CustomerPortalPage (portal_overview): Service
// Control Room + Setup Wizard, attributed to Alex (TCP).
// PWC has no active Support function → empty state.
// ============================================================

const SEED_PROFILES = [
  { id: 'p1', name: 'Priya Sharma' },
  { id: 'p2', name: 'Taylor Smith' },
  { id: 'p3', name: 'Jordan Lee' },
];

const SEED_ESCALATIONS = [
  { id: 'e1', question: 'Invoice discrepancy on account #7712', reason: 'Low confidence', confidence: 61, waiting: '8m', status: 'open' },
  { id: 'e2', question: 'API auth failure after key rotation', reason: 'No answer found', confidence: 42, waiting: '23m', status: 'assigned' },
  { id: 'e3', question: 'Customer requested a human — cancellation', reason: 'Customer requested human', confidence: 88, waiting: '1h 5m', status: 'open' },
];

interface SetupState {
  step: number;
  completed: boolean;
  kbCategories?: string[];
  deId?: string;
  threshold?: number;
}

// ── LIVE mode: real support tickets from Supabase ──────────────
const statusStyle = (s: TicketStatus) =>
  s === 'open' ? 'bg-indigo-500/15 text-indigo-300'
  : s === 'pending' ? 'bg-amber-500/15 text-amber-300'
  : s === 'escalated' ? 'bg-rose-500/15 text-rose-300'
  : 'bg-emerald-500/15 text-emerald-300';

const priorityStyle = (p: string) =>
  p === 'p1' ? 'text-rose-300' : p === 'p2' ? 'text-amber-300' : 'text-dt-support';

function LiveCustomerSupport() {
  const { liveTenantName } = useAuth();
  const [tickets, setTickets] = React.useState<SupportTicket[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [missingTables, setMissingTables] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [showImport, setShowImport] = React.useState(false);
  const [statusFilter, setStatusFilter] = React.useState<TicketStatus | 'all'>('all');

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTickets(await listTickets());
      setMissingTables(false);
    } catch (err) {
      if (err instanceof CustomerApiError && err.missingTables) setMissingTables(true);
      else setError((err as Error)?.message || 'Failed to load tickets.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { void refresh(); }, [refresh]);

  const resolveTicket = async (t: SupportTicket) => {
    try {
      await updateTicket(t.id, { status: 'resolved', resolved_at: new Date().toISOString() });
      void refresh();
    } catch (err) {
      setError((err as Error)?.message || 'Failed to update ticket.');
    }
  };

  const open = tickets.filter(t => t.status === 'open').length;
  const escalated = tickets.filter(t => t.status === 'escalated').length;
  const resolved = tickets.filter(t => t.status === 'resolved').length;
  const visible = statusFilter === 'all' ? tickets : tickets.filter(t => t.status === statusFilter);

  return (
    <div className="p-6">
      <div className="mb-5 flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Support — Customer Lifecycle</h1>
          <p className="text-dt-support text-sm mt-1">{liveTenantName || 'Your company'} · Live support queue</p>
        </div>
        {!missingTables && !loading && tickets.length > 0 && (
          <button onClick={() => setShowImport(true)} className="px-3 py-1.5 rounded-lg text-xs text-dt-support border border-dt-border-strong hover:border-dt-border-strong hover:text-white transition-colors">
            + Import CSV
          </button>
        )}
      </div>

      {error && <div className="mb-4 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{error}</div>}

      {loading ? (
        <LiveLoadingSkeleton rows={5} />
      ) : missingTables ? (
        <MissingTablesNotice />
      ) : tickets.length === 0 ? (
        <LiveEmptyState
          icon="💬"
          title="No support tickets yet"
          body="Import your existing ticket backlog, or tickets will appear here as they're created."
          primaryLabel="Import CSV"
          onPrimary={() => setShowImport(true)}
        />
      ) : (
        <>
          {/* Stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
            {[
              { label: 'Total tickets', value: tickets.length, color: 'text-white' },
              { label: 'Open', value: open, color: open > 0 ? 'text-indigo-300' : 'text-emerald-300' },
              { label: 'Escalated', value: escalated, color: escalated > 0 ? 'text-rose-300' : 'text-emerald-300' },
              { label: 'Resolved', value: resolved, color: 'text-emerald-300' },
            ].map(s => (
              <div key={s.label} className="bg-dt-card border border-dt-border rounded-xl p-4">
                <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-1">{s.label}</p>
                <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
              </div>
            ))}
          </div>

          {/* Filter */}
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            {(['all', 'open', 'pending', 'escalated', 'resolved'] as const).map(f => (
              <button key={f} onClick={() => setStatusFilter(f)}
                className={`px-3 py-1.5 rounded-full text-xs transition-colors ${statusFilter === f ? 'bg-indigo-600 text-white' : 'bg-dt-card border border-dt-border text-dt-support hover:text-dt-body'}`}>
                {f === 'all' ? 'All' : f[0].toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>

          {/* Table */}
          <div className="rounded-2xl border border-dt-border bg-dt-card p-5">
            <div className="overflow-x-auto rounded-xl border border-dt-border">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-dt-border text-left">
                    {['Subject', 'Priority', 'Status', 'Assignee', 'Confidence', 'Created', ''].map((h, i) => (
                      <th key={i} className="py-2.5 px-4 text-[11px] uppercase tracking-wide text-dt-muted font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((t, i) => (
                    <tr key={t.id} className={`border-b border-dt-border hover:bg-dt-panel transition-colors ${i === visible.length - 1 ? 'border-b-0' : ''}`}>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-white">{t.subject}</span>
                          {t.source === 'zendesk' && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-700/30 flex-shrink-0" title={`Synced from Zendesk${t.external_ref ? ` — ticket #${t.external_ref}` : ''} (Zendesk remains the system of record)`}>
                              Zendesk
                            </span>
                          )}
                        </div>
                        {t.body && <div className="text-xs text-dt-muted truncate max-w-md">{t.body}</div>}
                      </td>
                      <td className={`py-3 px-4 text-xs font-bold uppercase ${priorityStyle(t.priority)}`}>{t.priority}</td>
                      <td className="py-3 px-4">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${statusStyle(t.status)}`}>{t.status}</span>
                      </td>
                      <td className="py-3 px-4 text-xs text-dt-support">{t.assignee === 'de' ? 'Digital Employee' : 'Human'}</td>
                      <td className="py-3 px-4 text-xs text-dt-support">{t.de_confidence != null ? `${t.de_confidence}%` : '—'}</td>
                      <td className="py-3 px-4 text-xs text-dt-muted whitespace-nowrap">{new Date(t.created_at).toLocaleDateString()}</td>
                      <td className="py-3 px-4">
                        {t.status !== 'resolved' && (
                          <button onClick={() => void resolveTicket(t)} className="text-xs px-2.5 py-1 rounded-lg border border-dt-border-strong text-dt-support hover:border-emerald-500 hover:text-emerald-300 transition-colors">
                            Resolve
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {visible.length === 0 && (
                    <tr><td colSpan={7} className="py-6 px-4 text-center text-xs text-dt-muted">No tickets match this filter.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {showImport && (
        <ImportCustomersModal initialTab="tickets" onClose={() => setShowImport(false)} onImported={() => void refresh()} />
      )}
    </div>
  );
}

const CustomerSupportPage = ({ setPage }: { setPage: (p: Page) => void }) => {
  const dataMode = useDataMode();
  if (dataMode === 'live') return <LiveCustomerSupport />;
  return <DemoCustomerSupportPage setPage={setPage} />;
};

const DemoCustomerSupportPage = ({ setPage }: { setPage: (p: Page) => void }) => {
  const { activeCompanyId, activeCompany } = useAuth();
  const accentColor = '#6366f1';
  const storageKey = 'dt_service_setup_cs_' + activeCompanyId;

  // ── Service Control Room state ─────────────────────────────────
  const [setupState, setSetupState] = React.useState<SetupState>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) return JSON.parse(saved);
    } catch {}
    return { step: 1, completed: true }; // demo default: service already live
  });

  const saveSetup = (next: SetupState) => {
    setSetupState(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch {}
  };

  // Wizard step fields
  const [wizStep1Selected, setWizStep1Selected] = React.useState<string[]>([]);
  const [wizKbCats, setWizKbCats] = React.useState<{ name: string; audience: string; enabled: boolean }[]>([
    { name: 'General FAQ', audience: 'Customer', enabled: true },
    { name: 'Billing & Payments', audience: 'Customer', enabled: true },
    { name: 'Account & Access', audience: 'Customer', enabled: true },
    { name: 'Product Features', audience: 'Both', enabled: true },
    { name: 'Troubleshooting', audience: 'Customer', enabled: true },
  ]);
  const [wizFreshness, setWizFreshness] = React.useState(30);
  const [wizCoverage, setWizCoverage] = React.useState(5);
  const [wizDeName, setWizDeName] = React.useState('TCP Support Agent');
  const [wizPersona, setWizPersona] = React.useState('Alex');
  const [wizModel, setWizModel] = React.useState('haiku');
  const [wizThreshold, setWizThreshold] = React.useState(75);
  const [wizHallucination, setWizHallucination] = React.useState(true);
  const [wizSafety, setWizSafety] = React.useState(true);
  const [wizT1Assignee, setWizT1Assignee] = React.useState('');
  const [wizT2Assignee, setWizT2Assignee] = React.useState('');
  const [wizT3Assignee, setWizT3Assignee] = React.useState('');
  const [wizAlertEmail, setWizAlertEmail] = React.useState('');
  const [wizGoLiveAnim, setWizGoLiveAnim] = React.useState(false);
  const crEscCount = SEED_ESCALATIONS.length;

  // ── PWC: Support is not an active function ─────────────────────
  if (activeCompanyId !== 'tcp') {
    return (
      <div className="flex-1 flex flex-col overflow-auto bg-dt-page p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Support — Customer Lifecycle</h1>
          <p className="text-dt-support text-sm mt-1">{activeCompany.name} · Client support function</p>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-center">
          <div className="w-12 h-12 rounded-xl bg-dt-card border border-dt-border flex items-center justify-center text-xl mb-4">💬</div>
          <h2 className="text-lg font-semibold text-dt-body mb-2">Support is not an active function for {activeCompany.name}</h2>
          <p className="text-sm text-dt-muted max-w-sm mb-6">
            {activeCompany.name} handles client questions through its engagement teams. Activate this
            function to assign a Digital Employee to Support.
          </p>
          <button className="px-4 py-2 rounded-lg text-sm text-dt-support border border-dt-border-strong hover:border-dt-border-strong hover:text-white transition-colors">
            Activate function
          </button>
        </div>
      </div>
    );
  }

  // Quick-access action bar (always shown)
  const OverviewActionBar = () => (
    <div className="flex flex-wrap items-center gap-2 mb-5">
      <button onClick={() => setPage('eu_chat' as Page)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-dt-panel hover:bg-dt-panel text-xs text-dt-support border border-dt-border-strong transition-colors">
        <span>💬</span> Customer View
      </button>
      <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/10 text-xs text-amber-400 border border-amber-500/30">
        <span>⚠</span> Escalations ({crEscCount})
      </span>
      <button onClick={() => setPage('knowledge_library' as Page)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-dt-panel hover:bg-dt-panel text-xs text-dt-support border border-dt-border-strong transition-colors">
        <span>◈</span> Knowledge Hub
      </button>
      <button onClick={() => setPage('workforce_des' as Page)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-dt-panel hover:bg-dt-panel text-xs text-dt-support border border-dt-border-strong transition-colors">
        <span>⚡</span> Configure DE
      </button>
    </div>
  );

  // ── WIZARD (migrated from CustomerPortalPage) ──────────────────
  const WizardView = () => {
    const step = setupState.step || 1;
    const steps = ['Connect Sources', 'Scope Knowledge', 'Configure DE', 'Quality Gates', 'Escalation', 'Go Live'];
    const advanceTo = (n: number) => saveSetup({ ...setupState, step: n });

    return (
      <div>
        {/* Skip link */}
        <div className="flex justify-end mb-3">
          <button onClick={() => saveSetup({ ...setupState, completed: true })} className="text-xs text-dt-muted hover:text-dt-support transition-colors">
            Already set up? Skip to overview →
          </button>
        </div>

        {/* Step progress */}
        <div className="flex items-center gap-0 mb-8 overflow-x-auto pb-1">
          {steps.map((s, i) => {
            const n = i + 1;
            const done = n < step;
            const active = n === step;
            return (
              <React.Fragment key={i}>
                <div className="flex flex-col items-center flex-shrink-0">
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-colors ${
                    done ? 'bg-emerald-500 border-emerald-500 text-white' :
                    active ? 'border-indigo-500 text-indigo-400 bg-indigo-500/10' :
                    'border-dt-border-strong text-dt-faint bg-dt-card'
                  }`}>
                    {done ? '✓' : n}
                  </div>
                  <span className={`text-xs mt-1 whitespace-nowrap ${active ? 'text-white' : done ? 'text-emerald-400' : 'text-dt-faint'}`}>{s}</span>
                </div>
                {i < steps.length - 1 && (
                  <div className={`flex-1 h-0.5 mx-1 min-w-[16px] ${n < step ? 'bg-emerald-500' : 'bg-dt-panel'}`} />
                )}
              </React.Fragment>
            );
          })}
        </div>

        {/* Step 1 */}
        {step === 1 && (
          <div className="bg-dt-card border border-dt-border rounded-xl p-6">
            <h2 className="text-lg font-semibold text-white mb-1">Where does TCP's knowledge live?</h2>
            <p className="text-sm text-dt-support mb-5">Connect your documentation sources. DreamTeam will pull in and index this content automatically.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
              {[
                { id: 'confluence', label: 'Confluence', desc: 'Your team wiki and documentation', fields: [{ label: 'Confluence URL', type: 'text' }, { label: 'Space Key', type: 'text' }, { label: 'API Token', type: 'password' }] },
                { id: 'zendesk', label: 'Zendesk Help Center', desc: 'Customer-facing help articles', fields: [{ label: 'Subdomain', type: 'text' }, { label: 'API Key', type: 'password' }] },
                { id: 'gdrive', label: 'Google Drive', desc: 'Documents and files in Drive', fields: [] },
                { id: 'manual', label: 'Manual / File Upload', desc: 'Upload PDFs, Word docs, CSVs', fields: [] },
              ].map(src => {
                const sel = wizStep1Selected.includes(src.id);
                return (
                  <div key={src.id} onClick={() => setWizStep1Selected(prev => sel ? prev.filter(x => x !== src.id) : [...prev, src.id])}
                    className={`p-4 rounded-lg border cursor-pointer transition-all ${sel ? 'border-indigo-500 bg-indigo-500/5' : 'border-dt-border-strong bg-dt-panel hover:border-dt-border-strong'}`}>
                    <div className="flex items-start justify-between mb-1">
                      <span className="text-sm font-medium text-white">{src.label}</span>
                      {sel && <span className="text-xs text-emerald-400">✓ Selected</span>}
                    </div>
                    <p className="text-xs text-dt-support mb-3">{src.desc}</p>
                    {sel && src.fields.length > 0 && src.fields.map((f, fi) => (
                      <input key={fi} type={f.type} placeholder={f.label} onClick={e => e.stopPropagation()}
                        className="w-full mb-2 px-2 py-1.5 bg-dt-card border border-dt-border-strong rounded text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500" />
                    ))}
                    {sel && src.id === 'gdrive' && (
                      <button onClick={e => { e.stopPropagation(); }} className="text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white">Connect Google Drive</button>
                    )}
                    {sel && src.id === 'manual' && (
                      <input type="file" multiple onClick={e => e.stopPropagation()} className="text-xs text-dt-support" />
                    )}
                  </div>
                );
              })}
            </div>
            <div className="flex justify-end">
              <button onClick={() => advanceTo(2)} className="px-4 py-2 rounded-lg text-sm font-medium text-white" style={{ backgroundColor: accentColor }}>Next →</button>
            </div>
          </div>
        )}

        {/* Step 2 */}
        {step === 2 && (
          <div className="bg-dt-card border border-dt-border rounded-xl p-6">
            <h2 className="text-lg font-semibold text-white mb-1">How is TCP's knowledge structured?</h2>
            <p className="text-sm text-dt-support mb-5">Define the knowledge categories your Support DE will use. This prevents the DE from mixing up product areas or giving answers from the wrong context.</p>
            <div className="space-y-2 mb-4">
              {wizKbCats.map((cat, i) => (
                <div key={i} className="flex items-center gap-3 p-2.5 bg-dt-panel rounded-lg">
                  <input value={cat.name} onChange={e => setWizKbCats(prev => prev.map((c, ci) => ci === i ? { ...c, name: e.target.value } : c))}
                    className="flex-1 bg-transparent text-sm text-white border-b border-dt-border-strong focus:outline-none focus:border-indigo-500 py-0.5" />
                  <select value={cat.audience} onChange={e => setWizKbCats(prev => prev.map((c, ci) => ci === i ? { ...c, audience: e.target.value } : c))}
                    className="px-2 py-1 bg-dt-card border border-dt-border-strong rounded text-xs text-white focus:outline-none">
                    <option>Customer</option><option>Internal</option><option>Both</option>
                  </select>
                  <button onClick={() => setWizKbCats(prev => prev.map((c, ci) => ci === i ? { ...c, enabled: !c.enabled } : c))}
                    className={`w-9 h-5 rounded-full transition-colors ${cat.enabled ? 'bg-emerald-500' : 'bg-slate-600'}`}>
                    <div className={`w-3 h-3 bg-white rounded-full transition-transform mx-1 ${cat.enabled ? 'translate-x-4' : ''}`} />
                  </button>
                  <button onClick={() => setWizKbCats(prev => prev.filter((_, ci) => ci !== i))} className="text-dt-faint hover:text-red-400 text-xs">✕</button>
                </div>
              ))}
              <button onClick={() => setWizKbCats(prev => [...prev, { name: 'New Category', audience: 'Customer', enabled: true }])}
                className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1">+ Add category</button>
            </div>
            <p className="text-xs text-dt-muted mb-4">The DE will only search articles in enabled categories.</p>
            <div className="grid grid-cols-2 gap-4 p-3 bg-dt-panel rounded-lg mb-5">
              <div>
                <label className="text-xs text-dt-support block mb-1">Flag articles older than</label>
                <div className="flex items-center gap-2">
                  <input type="number" value={wizFreshness} onChange={e => setWizFreshness(+e.target.value)} className="w-16 px-2 py-1 bg-dt-card border border-dt-border-strong rounded text-xs text-white focus:outline-none" />
                  <span className="text-xs text-dt-muted">days for review</span>
                </div>
              </div>
              <div>
                <label className="text-xs text-dt-support block mb-1">Alert when fewer than</label>
                <div className="flex items-center gap-2">
                  <input type="number" value={wizCoverage} onChange={e => setWizCoverage(+e.target.value)} className="w-16 px-2 py-1 bg-dt-card border border-dt-border-strong rounded text-xs text-white focus:outline-none" />
                  <span className="text-xs text-dt-muted">articles cover a topic</span>
                </div>
              </div>
            </div>
            <div className="flex justify-between">
              <button onClick={() => advanceTo(1)} className="px-4 py-2 rounded-lg text-sm text-dt-support hover:text-white border border-dt-border-strong hover:border-dt-border-strong">← Back</button>
              <button onClick={() => { saveSetup({ ...setupState, step: 3, kbCategories: wizKbCats.filter(c => c.enabled).map(c => c.name) }); }} className="px-4 py-2 rounded-lg text-sm font-medium text-white" style={{ backgroundColor: accentColor }}>Next →</button>
            </div>
          </div>
        )}

        {/* Step 3 */}
        {step === 3 && (
          <div className="bg-dt-card border border-dt-border rounded-xl p-6">
            <h2 className="text-lg font-semibold text-white mb-1">Set up your Support DE</h2>
            <p className="text-sm text-dt-support mb-5">Configure the Digital Employee that will handle TCP's customer queries.</p>
            <div className="space-y-3 mb-4 p-4 bg-dt-panel rounded-lg">
              <div><label className="text-xs text-dt-support block mb-1">DE Name</label>
                <input value={wizDeName} onChange={e => setWizDeName(e.target.value)} className="w-full px-3 py-2 bg-dt-card border border-dt-border-strong rounded text-sm text-white focus:outline-none focus:border-indigo-500" /></div>
              <div><label className="text-xs text-dt-support block mb-1">Persona Name</label>
                <input value={wizPersona} onChange={e => setWizPersona(e.target.value)} className="w-full px-3 py-2 bg-dt-card border border-dt-border-strong rounded text-sm text-white focus:outline-none focus:border-indigo-500" /></div>
              <div><label className="text-xs text-dt-support block mb-1">Model</label>
                <select value={wizModel} onChange={e => setWizModel(e.target.value)} className="w-full px-3 py-2 bg-dt-card border border-dt-border-strong rounded text-sm text-white focus:outline-none focus:border-indigo-500">
                  <option value="haiku">Claude Haiku — Fast & cost-efficient</option>
                  <option value="sonnet">Claude Sonnet — Balanced</option>
                  <option value="opus">Claude Opus — Most capable</option>
                </select></div>
            </div>
            <div className="p-3 bg-dt-panel rounded-lg mb-5">
              <p className="text-xs text-dt-support mb-2">KB Scope — this DE will answer from these categories:</p>
              <div className="flex flex-wrap gap-2">
                {(setupState.kbCategories || wizKbCats.filter(c => c.enabled).map(c => c.name)).map((cat, i) => (
                  <span key={i} className="px-2 py-0.5 rounded-full text-xs bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">{cat}</span>
                ))}
              </div>
              <p className="text-xs text-dt-muted mt-2">This DE will only answer questions covered by these categories.</p>
            </div>
            <div className="flex justify-between">
              <button onClick={() => advanceTo(2)} className="px-4 py-2 rounded-lg text-sm text-dt-support hover:text-white border border-dt-border-strong hover:border-dt-border-strong">← Back</button>
              <button onClick={() => saveSetup({ ...setupState, step: 4, deId: 'alex' })} className="px-4 py-2 rounded-lg text-sm font-medium text-white" style={{ backgroundColor: accentColor }}>Next →</button>
            </div>
          </div>
        )}

        {/* Step 4 */}
        {step === 4 && (
          <div className="bg-dt-card border border-dt-border rounded-xl p-6">
            <h2 className="text-lg font-semibold text-white mb-1">When should the DE escalate?</h2>
            <p className="text-sm text-dt-support mb-5">Set the rules that determine when AI handles it vs. when a human takes over.</p>
            {/* Confidence dial */}
            <div className="flex flex-col items-center mb-6">
              <div className="relative w-48 h-24 mb-3">
                <div className="absolute inset-0 rounded-t-full border-4 border-dt-border-strong" style={{ borderBottomColor: 'transparent', borderBottomLeftRadius: 0, borderBottomRightRadius: 0 }} />
                <div className="absolute inset-0 rounded-t-full border-4 border-amber-500" style={{
                  borderBottomColor: 'transparent', borderBottomLeftRadius: 0, borderBottomRightRadius: 0,
                  clipPath: `polygon(0 100%, 50% 100%, 50% 0, 0 0)`,
                }} />
                <div className="absolute inset-0 rounded-t-full border-4 border-emerald-500" style={{
                  borderBottomColor: 'transparent', borderBottomLeftRadius: 0, borderBottomRightRadius: 0,
                  clipPath: `polygon(50% 100%, 100% 100%, 100% 0, 50% 0)`,
                }} />
                <div className="absolute bottom-0 left-1/2 -translate-x-1/2 text-center">
                  <span className="text-2xl font-bold text-white">{wizThreshold}%</span>
                </div>
              </div>
              <input type="range" min={50} max={95} value={wizThreshold} onChange={e => setWizThreshold(+e.target.value)}
                className="w-48 accent-indigo-500 mb-3" />
              <div className="flex gap-6 text-xs">
                <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded bg-amber-500" /><span className="text-amber-300">Below threshold → Escalate</span></div>
                <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded bg-emerald-500" /><span className="text-emerald-300">Above threshold → DE answers</span></div>
              </div>
              <p className="text-xs text-dt-muted mt-2">At {wizThreshold}% confidence, the DE escalates ~{Math.round((100 - wizThreshold) / 3)}% of queries</p>
            </div>
            <div className="space-y-2 mb-5">
              {[
                { label: 'Confidence Reviewer', desc: 'Blocks answers below threshold', always: true, val: true, set: () => {} },
                { label: 'Hallucination Detector', desc: 'Flags answers not supported by KB', always: false, val: wizHallucination, set: setWizHallucination },
                { label: 'Safety Guard', desc: 'Blocks sensitive/harmful responses', always: false, val: wizSafety, set: setWizSafety },
              ].map((bot, i) => (
                <div key={i} className="flex items-center justify-between p-3 bg-dt-panel rounded-lg">
                  <div>
                    <p className="text-sm text-white">{bot.label}</p>
                    <p className="text-xs text-dt-support">{bot.desc}</p>
                  </div>
                  <button disabled={bot.always} onClick={() => !bot.always && bot.set((v: any) => !v)}
                    className={`w-10 h-5 rounded-full transition-colors ${bot.val ? 'bg-emerald-500' : 'bg-slate-600'} ${bot.always ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}>
                    <div className={`w-3 h-3 bg-white rounded-full mx-1 transition-transform ${bot.val ? 'translate-x-5' : ''}`} />
                  </button>
                </div>
              ))}
            </div>
            <div className="flex justify-between">
              <button onClick={() => advanceTo(3)} className="px-4 py-2 rounded-lg text-sm text-dt-support hover:text-white border border-dt-border-strong hover:border-dt-border-strong">← Back</button>
              <button onClick={() => saveSetup({ ...setupState, step: 5, threshold: wizThreshold })} className="px-4 py-2 rounded-lg text-sm font-medium text-white" style={{ backgroundColor: accentColor }}>Next →</button>
            </div>
          </div>
        )}

        {/* Step 5 */}
        {step === 5 && (
          <div className="bg-dt-card border border-dt-border rounded-xl p-6">
            <h2 className="text-lg font-semibold text-white mb-1">Who handles escalations?</h2>
            <p className="text-sm text-dt-support mb-5">Define who gets alerted and in what order when the DE can't resolve a query.</p>
            <div className="space-y-3 mb-5">
              {[
                { tier: 1, val: wizT1Assignee, set: setWizT1Assignee, trigger: `confidence < ${wizThreshold}%`, channel: 'In-app' },
                { tier: 2, val: wizT2Assignee, set: setWizT2Assignee, trigger: 'After 30 min unresolved', channel: 'Email' },
                { tier: 3, val: wizT3Assignee, set: setWizT3Assignee, trigger: 'After 2 hrs escalated', channel: 'Both' },
              ].map(t => (
                <div key={t.tier} className="flex items-center gap-3 p-3 bg-dt-panel rounded-lg">
                  <span className="text-xs font-bold text-dt-support w-12 flex-shrink-0">Tier {t.tier}</span>
                  <select value={t.val} onChange={e => t.set(e.target.value)}
                    className="flex-1 px-2 py-1.5 bg-dt-card border border-dt-border-strong rounded text-xs text-white focus:outline-none focus:border-indigo-500">
                    <option value="">— Assignee —</option>
                    {SEED_PROFILES.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <span className="text-xs text-dt-muted flex-shrink-0 hidden sm:inline">{t.trigger}</span>
                  <span className="text-xs px-2 py-0.5 rounded bg-slate-600 text-dt-support flex-shrink-0">{t.channel}</span>
                </div>
              ))}
            </div>
            <div className="mb-5">
              <label className="text-xs text-dt-support block mb-1">Escalation alerts email</label>
              <input value={wizAlertEmail} onChange={e => setWizAlertEmail(e.target.value)} placeholder="alerts@company.com"
                className="w-full px-3 py-2 bg-dt-panel border border-dt-border-strong rounded text-sm text-white focus:outline-none focus:border-indigo-500" />
            </div>
            <div className="flex justify-between">
              <button onClick={() => advanceTo(4)} className="px-4 py-2 rounded-lg text-sm text-dt-support hover:text-white border border-dt-border-strong hover:border-dt-border-strong">← Back</button>
              <button onClick={() => advanceTo(6)} className="px-4 py-2 rounded-lg text-sm font-medium text-white" style={{ backgroundColor: accentColor }}>Next →</button>
            </div>
          </div>
        )}

        {/* Step 6 */}
        {step === 6 && (
          <div className="bg-dt-card border border-dt-border rounded-xl p-6">
            <h2 className="text-lg font-semibold text-white mb-1">Review your setup</h2>
            <p className="text-sm text-dt-support mb-5">Everything looks good. Here's a summary before we activate your Support service.</p>
            <div className="bg-dt-panel border border-dt-border-strong rounded-xl divide-y divide-slate-600 mb-6">
              <div className="p-4">
                <p className="text-xs text-dt-muted uppercase tracking-wide mb-1">Customer Support Service — TCP</p>
              </div>
              <div className="p-4">
                <p className="text-sm font-medium text-white mb-1">Knowledge Sources</p>
                {wizStep1Selected.length > 0 ? wizStep1Selected.map(s => <span key={s} className="text-xs text-dt-support mr-2">{s}</span>) : <span className="text-xs text-dt-muted">Connector selected</span>}
                <p className="text-xs text-dt-support mt-1">Categories: {wizKbCats.filter(c => c.enabled).map(c => c.name).join(', ')}</p>
              </div>
              <div className="p-4">
                <p className="text-sm font-medium text-white mb-1">Digital Employee</p>
                <p className="text-xs text-dt-support">{wizPersona} ({wizDeName})</p>
                <p className="text-xs text-dt-support">Model: Claude {wizModel.charAt(0).toUpperCase() + wizModel.slice(1)}</p>
                <p className="text-xs text-dt-support">KB Scope: {(setupState.kbCategories || []).length || wizKbCats.filter(c => c.enabled).length} categories</p>
              </div>
              <div className="p-4">
                <p className="text-sm font-medium text-white mb-1">Quality Gates</p>
                <p className="text-xs text-dt-support">Confidence threshold: {setupState.threshold || wizThreshold}%</p>
                <p className="text-xs text-dt-support">Hallucination detection: {wizHallucination ? 'On' : 'Off'}</p>
              </div>
              <div className="p-4">
                <p className="text-sm font-medium text-white mb-1">Escalation Path</p>
                {[
                  { tier: 'T1', id: wizT1Assignee, note: '(in-app)' },
                  { tier: 'T2', id: wizT2Assignee, note: '(email, 30min)' },
                  { tier: 'T3', id: wizT3Assignee, note: '(both, 2hr)' },
                ].map(t => {
                  const p = SEED_PROFILES.find(x => x.id === t.id);
                  return p ? <p key={t.tier} className="text-xs text-dt-support">{t.tier} → {p.name} {t.note}</p> : null;
                })}
              </div>
            </div>
            <div className="flex justify-between items-center">
              <button onClick={() => advanceTo(5)} className="px-4 py-2 rounded-lg text-sm text-dt-support hover:text-white border border-dt-border-strong hover:border-dt-border-strong">← Back</button>
              <button
                onClick={() => {
                  setWizGoLiveAnim(true);
                  setTimeout(() => saveSetup({ ...setupState, completed: true }), 1500);
                }}
                className={`px-6 py-2.5 rounded-lg text-sm font-semibold text-white transition-all ${wizGoLiveAnim ? 'bg-emerald-500' : 'bg-emerald-600 hover:bg-emerald-500'}`}
              >
                {wizGoLiveAnim ? '✓ Customer Support is live!' : 'Activate Service'}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  // ── CONTROL ROOM (migrated from CustomerPortalPage) ────────────
  const ControlRoom = () => {
    const deName = 'Alex';
    const threshold = setupState.threshold || wizThreshold || 75;

    const feedItems = [
      { type: 'resolved', time: '2 min ago', text: 'Query resolved by Alex — "How do I reset my password?"', confidence: 94 },
      { type: 'escalated', time: '8 min ago', text: 'Escalated to Priya Sharma — "Invoice discrepancy on account #7712"', confidence: 61 },
      { type: 'kb_added', time: '22 min ago', text: 'New article published: "How to update billing email"', author: 'Taylor Smith' },
      { type: 'resolved', time: '31 min ago', text: 'Query resolved — "What are your support hours?"', confidence: 88 },
      { type: 'sla_breach', time: '45 min ago', text: 'SLA breach — escalation unresolved after 67 minutes' },
      { type: 'kb_stale', time: '2 hrs ago', text: 'Article flagged as stale: "API Authentication Guide" — last updated 31 days ago' },
      { type: 'resolved', time: '3 hrs ago', text: 'Query resolved — "Cancel subscription"', confidence: 79 },
      { type: 'escalated', time: '4 hrs ago', text: 'Resolved by human — Sarah added answer to KB suggestion', confidence: 58 },
    ];

    const feedBorderColor = (type: string) => {
      if (type === 'resolved') return 'border-l-emerald-500';
      if (type === 'escalated') return 'border-l-amber-500';
      if (type === 'kb_added') return 'border-l-blue-500';
      if (type === 'sla_breach') return 'border-l-red-500';
      return 'border-l-slate-600';
    };

    const feedIcon = (type: string) => {
      if (type === 'resolved') return '✓';
      if (type === 'escalated') return '⚡';
      if (type === 'kb_added') return '◈';
      if (type === 'sla_breach') return '⚠';
      return '○';
    };

    return (
      <div>
        {/* Top bar */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-lg font-semibold text-white">Service Control Room</h2>
            <p className="text-xs text-dt-support">Customer Support — TCP · Handled by Alex · All systems operational</p>
          </div>
          <button onClick={() => saveSetup({ ...setupState, completed: false, step: 1 })}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-dt-panel hover:bg-dt-panel text-xs text-dt-support border border-dt-border-strong transition-colors">
            ⚙ Reconfigure
          </button>
        </div>

        {/* A) Status row */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
          <div className="bg-dt-card border border-dt-border rounded-xl p-3">
            <p className="text-xs text-dt-muted mb-1">Active DE</p>
            <div className="flex items-center gap-1.5 mb-0.5">
              <div className="w-2 h-2 rounded-full bg-emerald-400" />
              <p className="text-sm font-semibold text-white truncate">{deName}</p>
            </div>
            <button onClick={() => setPage('workforce_des' as Page)} className="text-xs text-indigo-400 hover:text-indigo-300">View DE →</button>
          </div>
          <div className="bg-dt-card border border-dt-border rounded-xl p-3">
            <p className="text-xs text-dt-muted mb-1">Open Tickets</p>
            <p className="text-sm font-semibold text-white">47</p>
            <p className="text-xs text-dt-muted">in the queue</p>
          </div>
          <div className="bg-dt-card border border-dt-border rounded-xl p-3">
            <p className="text-xs text-dt-muted mb-1">Confidence Score</p>
            <p className="text-sm font-semibold text-white">Avg 84%</p>
            <p className="text-xs text-emerald-400">↑ 3% this week</p>
          </div>
          <div className="bg-dt-card border border-dt-border rounded-xl p-3">
            <p className="text-xs text-dt-muted mb-1">Resolution Rate</p>
            <p className="text-sm font-semibold text-white">88%</p>
            <p className="text-xs text-dt-muted">self-served by Alex</p>
          </div>
          <div className="bg-dt-card border border-dt-border rounded-xl p-3">
            <p className="text-xs text-dt-muted mb-1">Open Escalations</p>
            <p className="text-sm font-semibold text-white">{crEscCount}</p>
            <p className="text-xs text-amber-400">awaiting humans</p>
          </div>
        </div>

        {/* B) Workflow pipeline */}
        <div className="bg-dt-card border border-dt-border rounded-xl p-4 mb-5">
          <h3 className="text-xs font-semibold text-dt-support uppercase tracking-wide mb-4">How a query flows through your service</h3>
          {/* Main horizontal path */}
          <div className="flex items-start gap-1 overflow-x-auto pb-2">
            {[
              { icon: '💬', name: 'Customer Query', sub1: 'From portal widget', sub2: '1,284 today', active: false },
              { icon: '⚡', name: deName, sub1: `Claude ${(wizModel || 'haiku').charAt(0).toUpperCase() + (wizModel || 'haiku').slice(1)} · active`, sub2: 'Support DE', active: true },
              { icon: '◈', name: 'KB Search', sub1: `${(setupState.kbCategories || []).length || 5} categories`, sub2: 'Avg 3 results/query', active: false },
              { icon: '◉', name: 'Confidence Gate', sub1: `Threshold: ${threshold}%`, sub2: '88% pass rate', active: false },
              { icon: '✓', name: 'Response', sub1: 'Delivered in <2s', sub2: 'CSAT: 91%', active: false },
            ].map((node, i) => (
              <React.Fragment key={i}>
                <div className={`flex-shrink-0 w-32 rounded-xl p-3 border transition-all ${node.active ? 'border-indigo-500/50 bg-indigo-500/5' : 'border-dt-border bg-dt-page'}`}>
                  <div className="text-lg mb-1">{node.icon}</div>
                  <p className="text-xs font-semibold text-white leading-tight mb-1">{node.name}</p>
                  <p className="text-xs text-dt-muted leading-tight">{node.sub1}</p>
                  <p className="text-xs text-dt-faint leading-tight">{node.sub2}</p>
                </div>
                {i < 4 && <div className="flex-shrink-0 self-center text-dt-faint text-lg px-0.5">→</div>}
              </React.Fragment>
            ))}
          </div>
          {/* Escalation branch */}
          <div className="ml-56 mt-1 border-l-2 border-dt-border-strong pl-4">
            <div className="text-xs text-amber-400 mb-2">↓ 12% escalate (below {threshold}%)</div>
            <div className="flex items-start gap-2 flex-wrap">
              {[
                { label: 'Tier 1', detail: `${SEED_PROFILES.find(p => p.id === wizT1Assignee)?.name || 'Priya Sharma'} · In-app`, sub: 'Avg response: 8min' },
                { label: 'Tier 2', detail: 'After 30min · Email', sub: '' },
                { label: 'Human Reply', detail: '→ reply sent', sub: '' },
                { label: 'Add to KB?', detail: '+ Suggestion shown', sub: '', link: true },
              ].map((node, i) => (
                <React.Fragment key={i}>
                  <div
                    onClick={() => node.link ? setPage('knowledge_library' as Page) : undefined}
                    className={`flex-shrink-0 px-3 py-2 rounded-lg border border-dt-border bg-dt-page ${node.link ? 'cursor-pointer hover:border-indigo-500/50' : ''}`}>
                    <p className="text-xs font-semibold text-dt-support">{node.label}</p>
                    <p className="text-xs text-dt-muted">{node.detail}</p>
                    {node.sub && <p className="text-xs text-dt-faint">{node.sub}</p>}
                  </div>
                  {i < 3 && <div className="self-center text-dt-faint text-sm">→</div>}
                </React.Fragment>
              ))}
            </div>
          </div>
        </div>

        {/* C + D) Side by side panels */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
          {/* C) Knowledge Health */}
          <div className="bg-dt-card border border-dt-border rounded-xl p-4">
            <h3 className="text-sm font-semibold text-white mb-4">Knowledge Health</h3>
            {/* Coverage */}
            <div className="mb-4">
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-dt-support">Coverage</span>
                <span className="text-dt-support">47 articles · {(setupState.kbCategories || []).length || 5} categories</span>
              </div>
              <div className="h-2 bg-dt-panel rounded-full mb-1">
                <div className="h-full rounded-full bg-indigo-500" style={{ width: '78%' }} />
              </div>
              <p className="text-xs text-amber-400">⚠ Troubleshooting has no articles — add some to improve DE accuracy</p>
            </div>
            {/* Freshness */}
            <div className="mb-4">
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-dt-support">Freshness</span>
                <span className="text-emerald-400">38 fresh</span>
              </div>
              <div className="h-2 bg-dt-panel rounded-full mb-2">
                <div className="h-full rounded-full bg-emerald-500" style={{ width: '87%' }} />
              </div>
              <div className="space-y-1">
                {[{ title: 'API Authentication Guide', days: 31 }, { title: 'Legacy Billing FAQ', days: 38 }, { title: 'SSO Setup (v1)', days: 45 }].map((a, i) => (
                  <div key={i} className="flex items-center justify-between text-xs py-1 border-b border-dt-border">
                    <span className="text-dt-support truncate flex-1">{a.title}</span>
                    <span className="text-dt-muted ml-2">Last updated {a.days}d ago</span>
                    <button onClick={() => setPage('knowledge_library' as Page)} className="ml-2 text-indigo-400 hover:text-indigo-300">Review →</button>
                  </div>
                ))}
              </div>
            </div>
            {/* Gaps */}
            <div>
              <p className="text-xs text-dt-support mb-2">Gaps detected — 3 unanswered topics this week</p>
              {[{ topic: 'Cancellation process', count: 47 }, { topic: 'API rate limits', count: 31 }].map((g, i) => (
                <div key={i} className="flex items-center justify-between text-xs py-1 border-b border-dt-border">
                  <span className="text-dt-support">{g.topic}</span>
                  <span className="text-dt-muted">{g.count} queries</span>
                  <button onClick={() => setPage('knowledge_library' as Page)} className="ml-2 text-emerald-400 hover:text-emerald-300">Add article →</button>
                </div>
              ))}
            </div>
          </div>

          {/* D) Live Activity feed */}
          <div className="bg-dt-card border border-dt-border rounded-xl p-4">
            <h3 className="text-sm font-semibold text-white mb-4">Live Activity</h3>
            <div className="space-y-2">
              {feedItems.map((item, i) => (
                <div key={i} className={`border-l-2 pl-3 py-1 ${feedBorderColor(item.type)}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-1.5 flex-1 min-w-0">
                      <span className="text-xs flex-shrink-0 mt-0.5">{feedIcon(item.type)}</span>
                      <p className="text-xs text-dt-support leading-relaxed">{item.text}</p>
                    </div>
                    <div className="flex-shrink-0 flex flex-col items-end gap-0.5">
                      <span className="text-xs text-dt-faint">{item.time}</span>
                      {(item as any).confidence !== undefined && (
                        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${(item as any).confidence >= 75 ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>
                          {(item as any).confidence}%
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* E) Escalation queue */}
        <div className="bg-dt-card border border-dt-border rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white mb-1">Escalation Queue</h3>
          <p className="text-xs text-dt-support mb-3">Questions Alex handed off to a human — claim one, reply, and resolve it back to the customer.</p>
          <div className="space-y-1.5">
            {SEED_ESCALATIONS.map(row => (
              <div key={row.id} className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border border-dt-border bg-dt-inset">
                <div className="min-w-0">
                  <p className="text-sm text-dt-body truncate">{row.question}</p>
                  <p className="text-[10px] text-dt-muted mt-0.5">{row.reason} · conf {row.confidence}% · waiting {row.waiting}</p>
                </div>
                <span className={`text-[10px] px-1.5 py-0.5 rounded border flex-shrink-0 ${row.status === 'assigned' ? 'bg-amber-500/15 text-amber-300 border-amber-500/30' : 'bg-rose-500/15 text-rose-300 border-rose-500/30'}`}>{row.status}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-white">Support — Customer Lifecycle</h1>
        <p className="text-dt-support text-sm mt-1">Alex serves your customers 24/7 — answering questions, resolving issues, and taking action on their behalf</p>
      </div>
      <OverviewActionBar />
      {setupState.completed ? <ControlRoom /> : <WizardView />}
    </div>
  );
};

export default CustomerSupportPage;
