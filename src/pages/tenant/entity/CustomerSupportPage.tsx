import React from 'react';
import { useAuth } from '../../../context/AuthContext';
import type { Page } from '../../../types';
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

const CustomerSupportPage = (_props: { setPage: (p: Page) => void }) => <LiveCustomerSupport />;

export default CustomerSupportPage;
