import React, { useEffect, useState } from 'react';
import { PageHeader } from '../../../components/ui';
import { CATEGORY_SHORT } from '../../../lib/categoryContracts';
import { fetchIdentityInventory, IdentitySubject } from '../../../lib/identityInventoryApi';
import { PERMISSION_LABELS, AccessPermission } from '../../../lib/accessGrantsApi';
import { LiveLoadingSkeleton, LiveEmptyState } from '../../../components/LiveDataStates';

// ============================================================
// GOVERNANCE — Identity & Credentials (migration 044).
//
// Gap-analysis item 26: the single view a security-conscious
// prospect or auditor asks for first — "which digital worker holds
// which live credential and grant, across every connected system?"
// This is a READ-ONLY report over data_access_grants, connectors,
// trust_policies and action_definitions. It never shows a secret
// value — only whether one is stored, and its health.
// ============================================================

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;

const PERMISSION_PLAIN: Record<AccessPermission, string> = {
  search: 'can search',
  read: 'can read',
  ingest: 'can ingest into knowledge',
  write_back: 'can write to',
};

function trustSentence(level: number | null, autonomyEnabled: boolean | null): string {
  if (level === null) return 'No trust policy set for this system yet — every action here is human-approved.';
  if (level === 0) return `Trust level 0 — always requires human approval before acting here.`;
  const auto = autonomyEnabled
    ? 'non-destructive actions may auto-execute; destructive actions are always human-approved (platform floor).'
    : 'auto-execution is not yet enabled for this workspace, so approval is still required.';
  return `Trust level ${level} — ${auto}`;
}

function healthMeta(status: string, lastOkAt: string | null, lastErrorAt: string | null, failures: number) {
  if (status === 'disconnected') return { label: 'Not connected', cls: 'bg-slate-600/40 text-slate-400 border-slate-600' };
  if (failures > 0 || status === 'error') {
    return {
      label: `Failing${failures ? ` (${failures} in a row)` : ''}`,
      cls: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
    };
  }
  if (lastOkAt) return { label: `Healthy — last OK ${fmtDate(lastOkAt)}`, cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' };
  return { label: 'Never checked', cls: 'bg-slate-600/40 text-slate-400 border-slate-600' };
}

function SubjectCard({ s }: { s: IdentitySubject }) {
  const [open, setOpen] = useState(true);
  const kindLabel = s.kind === 'de' ? 'Digital Employee' : 'Specialist';

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-800/50 mb-4 overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-3 px-5 py-4 text-left hover:bg-slate-800/80 transition"
      >
        <div>
          <p className="text-sm font-semibold text-white">{s.label}{s.label !== s.name ? <span className="text-slate-500 font-normal"> ({s.name})</span> : null}</p>
          <p className="text-[11px] text-slate-500 mt-0.5">{kindLabel} · {s.role} · {s.status}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-700 text-slate-400 border border-slate-600 whitespace-nowrap">
            {s.systems.length} connected system{s.systems.length === 1 ? '' : 's'}
          </span>
          <span className="text-slate-500">{open ? '▾' : '▸'}</span>
        </div>
      </button>

      {open && (
        <div className="border-t border-slate-700 px-5 py-4">
          {s.systems.length === 0 ? (
            <p className="text-xs text-slate-500 py-2">No access anywhere — this identity currently holds no grant on any connected system.</p>
          ) : (
            <div className="space-y-3">
              {s.systems.map((sys) => {
                const health = healthMeta(sys.connectorStatus, sys.lastOkAt, sys.lastErrorAt, sys.consecutiveFailures);
                return (
                  <div key={sys.connectorId} className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div>
                        <p className="text-xs font-medium text-white">
                          {sys.connectorName}
                          <span className="text-slate-500 font-normal"> — {CATEGORY_SHORT[sys.category] ?? sys.category}</span>
                        </p>
                        <p className="text-[11px] text-slate-400 mt-1">
                          {s.label} <span className="text-slate-300">{PERMISSION_PLAIN[sys.permission]}</span> this system
                          {' '}<span className="text-slate-600">({PERMISSION_LABELS[sys.permission]}, via {sys.permissionVia === 'connector' ? 'a system-specific grant' : 'a category default'})</span>.
                        </p>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap justify-end">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full border whitespace-nowrap ${health.cls}`}>{health.label}</span>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full border whitespace-nowrap ${
                          sys.hasCredential
                            ? 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30'
                            : 'bg-slate-600/40 text-slate-400 border-slate-600'
                        }`}>
                          {sys.hasCredential ? 'Credential stored' : 'No stored credential'}
                        </span>
                      </div>
                    </div>

                    <p className="text-[11px] text-slate-500 mt-2">
                      {trustSentence(sys.trustCurrentLevel, sys.autonomyEnabled)}
                    </p>

                    {sys.permission === 'write_back' && sys.possibleActions.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-slate-700/60">
                        <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">
                          Could invoke here if a write is triggered:
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {sys.possibleActions.map((a) => (
                            <span
                              key={a.action_key}
                              title={a.destructive ? 'Destructive — always requires human approval, regardless of trust level.' : 'Non-destructive — may auto-execute once trust allows it.'}
                              className={`text-[10px] px-2 py-0.5 rounded-full border whitespace-nowrap ${
                                a.destructive
                                  ? 'bg-amber-500/10 text-amber-300 border-amber-500/25'
                                  : 'bg-slate-700 text-slate-300 border-slate-600'
                              }`}
                            >
                              {a.label}{a.destructive ? ' ⚠' : ''}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function IdentityInventoryPage() {
  const [subjects, setSubjects] = useState<IdentitySubject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const rows = await fetchIdentityInventory();
        if (!cancelled) setSubjects(rows);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(/no tenant/i.test(msg)
          ? 'This is a live-workspace feature — sign into your live workspace to see which digital employees and specialists hold which credentials. (Demo companies have no real connected systems to report on.)'
          : msg);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const totalGrants = subjects.reduce((n, s) => n + s.systems.length, 0);
  const withCredentials = subjects.reduce((n, s) => n + s.systems.filter((x) => x.hasCredential).length, 0);
  const failing = subjects.reduce((n, s) => n + s.systems.filter((x) => x.consecutiveFailures > 0 || x.connectorStatus === 'error').length, 0);
  const canWrite = subjects.reduce((n, s) => n + s.systems.filter((x) => x.permission === 'write_back').length, 0);

  return (
    <div className="flex-1 overflow-y-auto bg-slate-900 p-6">
      <PageHeader
        title="Identity & Credentials"
        subtitle="Every digital employee and specialist, every connected system it can touch, and how — one view for a security review. No secret value is ever shown here, only whether one is stored."
      />
      {error && <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 mb-4 text-xs text-red-300">{error}</div>}

      {!loading && !error && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4">
            <p className="text-2xl font-bold text-white">{subjects.length}</p>
            <p className="text-[11px] text-slate-500 mt-1">Identities (DEs + specialists)</p>
          </div>
          <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4">
            <p className="text-2xl font-bold text-white">{totalGrants}</p>
            <p className="text-[11px] text-slate-500 mt-1">Active grants across all systems</p>
          </div>
          <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4">
            <p className="text-2xl font-bold text-white">{withCredentials}</p>
            <p className="text-[11px] text-slate-500 mt-1">Systems with a stored credential</p>
          </div>
          <div className={`rounded-xl border p-4 ${failing > 0 ? 'border-rose-500/30 bg-rose-500/5' : 'border-slate-700 bg-slate-800/50'}`}>
            <p className={`text-2xl font-bold ${failing > 0 ? 'text-rose-300' : 'text-white'}`}>{failing}</p>
            <p className="text-[11px] text-slate-500 mt-1">Currently failing connections</p>
          </div>
        </div>
      )}

      {loading ? (
        <LiveLoadingSkeleton rows={4} />
      ) : !error && subjects.length === 0 ? (
        <div className="mb-6">
          <LiveEmptyState icon="◎" title="No digital employees or specialists yet" body="Once you hire one, its credentials and grants appear here." />
        </div>
      ) : (
        subjects.map((s) => <SubjectCard key={`${s.kind}:${s.id}`} s={s} />)
      )}

      {!loading && !error && (
        <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-5 mt-2">
          <h3 className="text-sm font-semibold text-white mb-2">What this view covers (honest)</h3>
          <ul className="text-[11px] text-slate-500 space-y-1.5 list-disc pl-4">
            <li><span className="text-slate-300">Covered:</span> every grant in Data Access, cross-referenced with real connector health, earned trust level, and the actions each identity could invoke — {canWrite} grant{canWrite === 1 ? '' : 's'} currently include write-back.</li>
            <li><span className="text-slate-300">Never shown:</span> the actual credential/secret value — this page only reports whether one is stored (a boolean), matching how connector credentials are stored platform-wide (service-role-only, no client read path exists at all).</li>
            <li><span className="text-slate-300">Trust level shown is per action-category</span> ("action_execute"), not per individual action — the same dial that governs whether that identity's writes on this system can ever auto-execute.</li>
            <li><span className="text-slate-300">To change access:</span> use Governance → Data Access. This page is reporting only; it makes no changes.</li>
          </ul>
        </div>
      )}
    </div>
  );
}
