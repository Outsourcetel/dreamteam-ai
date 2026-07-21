import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../../context/AuthContext';
import type { Page } from '../../../types';
import { getSupportOverview, subscribeSupport } from '../../../lib/supportInboxApi';
import type { SupportOverview } from '../../../lib/supportInboxApi';
import { LiveLoadingSkeleton, LiveEmptyState } from '../../../components/LiveDataStates';

// ============================================================
// Support Command Center — the operator's one-glance view of the
// support operation. Reads tenant-wide de_conversations aggregates
// (status / severity / category / channel) plus open escalations and
// pending drafts. Surfaces the deterministic triage (mig 233); degrades
// gracefully when triage isn't applied yet. Read-only; no hot path.
// ============================================================

const SEVERITY_LABEL: Record<string, string> = { sev1: 'Critical (sev1)', sev2: 'High (sev2)', sev3: 'Medium (sev3)', sev4: 'Low (sev4)' };
const SEVERITY_CLS: Record<string, string> = { sev1: 'text-rose-400', sev2: 'text-amber-300', sev3: 'text-indigo-300', sev4: 'text-slate-400' };
const STATUS_LABEL: Record<string, string> = { ai_handling: 'AI handling', needs_human: 'Needs human', human_owned: 'Human owned', resolved: 'Resolved' };

function StatCard({ label, value, sub, color = 'text-white' }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
      <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">{label}</p>
      <p className={`text-xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

function Breakdown({ title, data, labelOf, clsOf }: {
  title: string;
  data: Record<string, number>;
  labelOf?: (k: string) => string;
  clsOf?: (k: string) => string;
}) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const max = entries.reduce((m, [, n]) => Math.max(m, n), 0) || 1;
  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-5">
      <h3 className="text-sm font-semibold text-white mb-3">{title}</h3>
      {entries.length === 0 ? (
        <p className="text-xs text-slate-500">No data yet.</p>
      ) : (
        <div className="space-y-2">
          {entries.map(([k, n]) => (
            <div key={k}>
              <div className="flex items-center justify-between text-xs mb-0.5">
                <span className={clsOf ? clsOf(k) : 'text-slate-300'}>{labelOf ? labelOf(k) : k.replace(/_/g, ' ')}</span>
                <span className="text-slate-400 font-medium">{n}</span>
              </div>
              <div className="h-1.5 rounded-full bg-slate-700/60 overflow-hidden">
                <div className="h-full rounded-full bg-indigo-500/60" style={{ width: `${Math.round((n / max) * 100)}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const SupportCommandCenterPage = ({ setPage }: { setPage: (p: Page) => void }) => {
  const { liveTenantName } = useAuth();
  const [ov, setOv] = useState<SupportOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try { setOv(await getSupportOverview()); }
    catch (err) { setError((err as Error)?.message || 'Failed to load the support overview.'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => subscribeSupport(() => void refresh()), [refresh]);

  const resolved = ov?.byStatus['resolved'] ?? 0;

  return (
    <div className="flex-1 overflow-auto bg-slate-900 p-6">
      <div className="mb-6 flex items-start justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-white">Support Command Center</h1>
          <p className="text-slate-400 text-sm mt-1">
            {liveTenantName || 'Your company'} · One-glance view of the support operation — volume, status, severity and what needs a human.
          </p>
        </div>
        <button onClick={() => setPage('support_inbox')}
          className="text-xs px-3 py-1.5 rounded-lg border border-slate-600 text-slate-300 hover:border-slate-500 transition-colors">
          Open Support Inbox →
        </button>
      </div>

      {error && <div className="mb-4 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{error}</div>}

      {loading ? (
        <LiveLoadingSkeleton rows={4} />
      ) : !ov || ov.total === 0 ? (
        <LiveEmptyState
          icon="✉"
          title="No support conversations yet"
          body="When customers reach support through the widget, email or portal, they'll appear here — triaged by category and severity, with what needs a human surfaced first."
          primaryLabel="Open Support Inbox"
          onPrimary={() => setPage('support_inbox')}
        />
      ) : (
        <div className="space-y-5">
          {/* Stat cards */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <StatCard label="Conversations" value={ov.total} sub="widget / email / portal / chat" />
            <StatCard label="Needs a human" value={ov.needsHuman} color={ov.needsHuman ? 'text-amber-300' : 'text-emerald-300'} />
            <StatCard label="Open escalations" value={ov.openEscalations} color={ov.openEscalations ? 'text-rose-400' : 'text-emerald-300'} sub="in Human Tasks" />
            <StatCard label="Drafts pending" value={ov.draftsPending} color={ov.draftsPending ? 'text-indigo-300' : 'text-slate-400'} sub="awaiting approval" />
            <StatCard label="Resolved" value={resolved} color="text-emerald-300" />
          </div>

          {/* Breakdowns */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Breakdown title="By status" data={ov.byStatus} labelOf={(k) => STATUS_LABEL[k] ?? k.replace(/_/g, ' ')} />
            {ov.triageEnabled ? (
              <Breakdown title="By severity (deterministic triage)" data={ov.bySeverity}
                labelOf={(k) => SEVERITY_LABEL[k] ?? k} clsOf={(k) => SEVERITY_CLS[k] ?? 'text-slate-300'} />
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-800/30 p-5">
                <h3 className="text-sm font-semibold text-white mb-1">By severity</h3>
                <p className="text-xs text-slate-500">Deterministic triage isn't active yet. Once it's applied, conversations are auto-classified by severity and category at intake.</p>
              </div>
            )}
            {ov.triageEnabled && Object.keys(ov.byCategory).length > 0 && (
              <Breakdown title="By category (deterministic triage)" data={ov.byCategory} />
            )}
            <Breakdown title="By channel" data={ov.byChannel} />
            <Breakdown title="By priority" data={ov.byPriority}
              clsOf={(k) => k === 'urgent' ? 'text-rose-400' : k === 'high' ? 'text-amber-300' : 'text-slate-300'} />
          </div>
        </div>
      )}
    </div>
  );
};

export default SupportCommandCenterPage;
