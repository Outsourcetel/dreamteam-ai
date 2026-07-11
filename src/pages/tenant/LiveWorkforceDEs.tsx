import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../supabase';
import type { Page } from '../../types';
import { CustomerApiError, fmtMoneyK } from '../../lib/customerApi';
import { getApprovalThresholdCents } from '../../lib/guardrailApi';
import {
  listAutonomy, upsertAutonomy, resolveAutonomy, getApprovalEvidence,
  AUTONOMY_ACTION_META,
} from '../../lib/autonomyApi';
import type { DEAutonomy, AutonomyActionType, ApprovalEvidence } from '../../lib/autonomyApi';
import {
  listTrustPolicies, seedTrustPolicies, computeTrustEvidence, requestTrustPromotion,
  listTrustHistory, trustLevelSettings, TRUST_LEVEL_LABELS,
} from '../../lib/trustApi';
import type { TrustPolicy, TrustEvidence, TrustHistoryEvent, TrustCategory } from '../../lib/trustApi';
import { appendAuditEvent } from '../../lib/guardrailApi';
import {
  listDefinitions, listDEPlaybookAssignments, assignPlaybookToDE,
  reprioritizeAssignment, setAssignmentActive, removeAssignment,
} from '../../lib/playbookBuilderApi';
import type { PlaybookDefinition, DEPlaybookAssignment } from '../../lib/playbookBuilderApi';
import { LiveLoadingSkeleton, MissingTablesNotice } from '../../components/LiveDataStates';
import { ConfirmDeleteModal } from '../../components';
import {
  listDigitalEmployees, createDigitalEmployee, updateDigitalEmployee, getDEConfigHistory,
  transferDeOwnership, checkDeRetirementReadiness, retireDigitalEmployee,
  listDeConsultationGrants, createDeConsultationGrant, setDeConsultationGrantActive,
} from '../../lib/digitalEmployeesApi';
import type {
  DigitalEmployee, DEConfigHistoryEntry, RetirementReadiness, DEConsultationGrant,
} from '../../lib/digitalEmployeesApi';
import { useUsers } from '../../lib/useUsers';
import Modal from '../../components/Modal';
import {
  listDeHealth, DE_HEALTH_LABELS, listDeDevelopmentItems, detectDeDevelopmentNeeds,
  createDeDevelopmentItem, updateDeDevelopmentItemStatus,
} from '../../lib/deHealthApi';
import type { DEHealth, DEDevelopmentItem } from '../../lib/deHealthApi';
import { getDePerformanceMetrics } from '../../lib/api';
import type { DePerformanceMetrics } from '../../lib/api';
import { listAuditEvents } from '../../lib/guardrailApi';
import type { AuditEvent } from '../../lib/guardrailApi';
import { listDocScopes } from '../../lib/knowledgeApi';

// ============================================================
// Workforce — LIVE mode (R5): the first live DE-profile surface.
// One real DE (Alex — Customer Support DE) + the Trust dial panel:
// per-action autonomy thresholds stored in de_autonomy, with an
// evidence line computed from the immutable audit trail.
//
// COMPOSITION RULE (mirrors generateInvoice / playbook-execute):
// autonomy NARROWS within guardrails, never overrides them — an
// invoice auto-sends only when it passes BOTH the guardrail approval
// threshold AND the trust-dial max. Raising the dial can never
// authorize something a guardrail forbids.
// ============================================================

const ACTION_ORDER: AutonomyActionType[] = ['invoice_auto_send', 'answer_dock', 'answer_widget'];

interface RowDraft { enabled: boolean; amount: string; confidence: string }

function draftFrom(a: DEAutonomy | undefined): RowDraft {
  return {
    enabled: a?.enabled ?? false,
    amount: a?.max_amount_cents != null ? String(Math.round(a.max_amount_cents / 100)) : '',
    confidence: a?.min_confidence != null ? String(a.min_confidence) : '',
  };
}

// ── "How this DE operates" — the operating charter panel ───────────
// Which playbooks this DE runs, and in what priority order (lowest
// number first) when several active playbooks match the same trigger.
function OperatingCharterPanel({ deId, setPage }: { deId: string; setPage: (p: Page) => void }) {
  const [defs, setDefs] = useState<PlaybookDefinition[]>([]);
  const [assignments, setAssignments] = useState<DEPlaybookAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [pickId, setPickId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<DEPlaybookAssignment | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [d, a] = await Promise.all([listDefinitions(), listDEPlaybookAssignments(deId)]);
      setDefs(d.filter(x => x.status === 'published'));
      setAssignments(a);
    } catch (err) {
      setError((err as Error)?.message || 'Failed to load the operating charter.');
    } finally {
      setLoading(false);
    }
  }, [deId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const unassigned = defs.filter(d => !assignments.some(a => a.playbook_id === d.id));

  const add = async () => {
    if (!pickId) return;
    setBusy(true); setError(null);
    try {
      const nextPriority = (assignments.reduce((m, a) => Math.max(m, a.priority), 0) || 0) + 10;
      await assignPlaybookToDE(deId, pickId, nextPriority);
      setPickId(''); setAdding(false);
      await refresh();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  const move = async (a: DEPlaybookAssignment, dir: -1 | 1) => {
    const sorted = [...assignments].sort((x, y) => x.priority - y.priority);
    const idx = sorted.findIndex(x => x.id === a.id);
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    const other = sorted[swapIdx];
    setBusy(true);
    try {
      await Promise.all([
        reprioritizeAssignment(a.id, other.priority),
        reprioritizeAssignment(other.id, a.priority),
      ]);
      await refresh();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  if (loading) return null;

  const sorted = [...assignments].sort((x, y) => x.priority - y.priority);

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">How this DE operates</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-500/15 text-teal-300">operating charter</span>
      </div>
      <p className="text-xs text-slate-500 mb-4">
        The playbooks assigned to this DE, in priority order. When more than one active playbook matches the same
        trigger, the lowest-numbered priority runs first. Drag with the arrows to reprioritize.
      </p>

      {error && <div className="mb-3 rounded-xl border border-rose-800/50 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</div>}

      {sorted.length === 0 ? (
        <p className="text-xs text-slate-500 mb-3">No playbooks assigned yet — this DE only runs playbooks it's directly assigned.</p>
      ) : (
        <div className="space-y-1.5 mb-3">
          {sorted.map((a, i) => {
            const def = defs.find(d => d.id === a.playbook_id);
            return (
              <div key={a.id} className={`flex items-center gap-3 text-xs rounded-lg px-3 py-2 ${a.active ? 'bg-slate-950/60' : 'bg-slate-950/30 opacity-60'}`}>
                <span className="w-6 h-6 rounded-lg bg-slate-800 text-slate-400 flex items-center justify-center text-[11px] font-bold flex-shrink-0">{a.priority}</span>
                <button onClick={() => setPage('systems_playbooks')} className="text-slate-200 hover:text-indigo-300 transition-colors truncate flex-1 text-left">
                  {def?.name ?? 'Unknown playbook'}
                </button>
                {!a.active && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-500 flex-shrink-0">paused</span>}
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button onClick={() => void move(a, -1)} disabled={busy || i === 0} className="text-slate-500 hover:text-slate-300 disabled:opacity-30">↑</button>
                  <button onClick={() => void move(a, 1)} disabled={busy || i === sorted.length - 1} className="text-slate-500 hover:text-slate-300 disabled:opacity-30">↓</button>
                  <button onClick={() => void (async () => { setBusy(true); try { await setAssignmentActive(a.id, !a.active); await refresh(); } finally { setBusy(false); } })()} disabled={busy}
                    className="text-slate-500 hover:text-slate-300 disabled:opacity-30 ml-1">{a.active ? 'pause' : 'resume'}</button>
                  <button onClick={() => setRemoveTarget(a)} disabled={busy}
                    className="text-slate-600 hover:text-rose-400 disabled:opacity-30 ml-1">remove</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {adding ? (
        <div className="flex items-center gap-2 flex-wrap">
          <select value={pickId} onChange={e => setPickId(e.target.value)}
            className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-slate-500 !w-64">
            <option value="">Pick a published playbook…</option>
            {unassigned.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <button onClick={() => void add()} disabled={busy || !pickId}
            className="text-xs px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-500 text-white font-medium disabled:opacity-40 transition-colors">
            {busy ? 'Adding…' : 'Add'}
          </button>
          <button onClick={() => setAdding(false)} className="text-xs text-slate-500 hover:text-slate-300">Cancel</button>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} disabled={unassigned.length === 0}
          className="text-xs px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500 disabled:opacity-40 transition-colors">
          + Assign a playbook
        </button>
      )}
      {unassigned.length === 0 && !adding && defs.length > 0 && (
        <p className="mt-2 text-[11px] text-slate-600">Every published playbook is already assigned.</p>
      )}
      {defs.length === 0 && (
        <p className="mt-2 text-[11px] text-slate-600">No published playbooks yet — build one in Playbooks first.</p>
      )}
      {removeTarget && (
        <ConfirmDeleteModal
          title="Remove playbook assignment"
          message={`Remove "${defs.find(d => d.id === removeTarget.playbook_id)?.name ?? 'this playbook'}" from this DE? It will stop running for this DE immediately — you can re-assign it later if needed.`}
          confirmLabel="Remove"
          onClose={() => setRemoveTarget(null)}
          onConfirm={async () => { await removeAssignment(removeTarget.id); setRemoveTarget(null); await refresh(); }}
        />
      )}
    </div>
  );
}

// ── Roster + "Add a Digital Employee" — the generic persona-creation
// capability (migration 037). Domain-agnostic: creates ANY future DE,
// not just Account/Finance/etc. Simple enough for a non-technical
// admin: name + role label are the only required fields.
function RosterPanel({ onSelect }: { onSelect: (de: DigitalEmployee) => void }) {
  const [des, setDes] = useState<DigitalEmployee[] | null>(null);
  const [health, setHealth] = useState<Record<string, DEHealth>>({});
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [personaName, setPersonaName] = useState('');
  const [department, setDepartment] = useState('');
  const [description, setDescription] = useState('');

  const refresh = useCallback(async () => {
    try {
      setDes(await listDigitalEmployees());
      setError(null);
    } catch (err) {
      setError((err as Error)?.message || 'Failed to load the roster.');
    }
    try {
      const h = await listDeHealth();
      setHealth(Object.fromEntries(h.map(x => [x.de_id, x])));
    } catch { /* health is supplementary — a roster still renders without it */ }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const submit = async () => {
    if (!name.trim()) { setError('Give the new Digital Employee a name or role label.'); return; }
    setBusy(true); setError(null);
    try {
      await createDigitalEmployee({
        name: name.trim(),
        personaName: personaName.trim() || undefined,
        department: department.trim() || undefined,
        description: description.trim() || undefined,
      });
      setName(''); setPersonaName(''); setDepartment(''); setDescription('');
      setAdding(false);
      await refresh();
    } catch (err) {
      setError((err as Error)?.message || 'Failed to create the Digital Employee. Only workspace owners/admins can do this.');
    } finally {
      setBusy(false);
    }
  };

  if (des === null) return null;

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6">
      <div className="mb-1 flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-base font-semibold text-white">Your Digital Employees</h3>
        {!adding && (
          <button onClick={() => setAdding(true)}
            className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors">
            + Add a Digital Employee
          </button>
        )}
      </div>
      <p className="text-xs text-slate-500 mb-4">
        Every Digital Employee working for {des.length > 0 ? 'your company' : 'you'} today. Each one is configured independently below —
        data access, playbooks, and trust build up the same way for every department.
      </p>

      {error && <div className="mb-3 rounded-xl border border-rose-800/50 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</div>}

      <div className="space-y-2 mb-3">
        {des.map(de => (
          <button key={de.id} onClick={() => onSelect(de)}
            className="w-full flex items-center gap-3 text-xs rounded-lg px-3 py-2.5 bg-slate-950/60 hover:bg-slate-900 hover:ring-1 hover:ring-indigo-500/40 transition-all text-left">
            <div className="w-8 h-8 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-semibold flex-shrink-0">
              {(de.persona_name || de.name).charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-slate-200 font-medium">{de.persona_name || de.name}</span>
                {de.persona_name && <span className="text-slate-500">— {de.name}</span>}
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${de.status === 'active' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}>{de.status}</span>
                {health[de.id] && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${DE_HEALTH_LABELS[health[de.id].state].color}`}>
                    {DE_HEALTH_LABELS[health[de.id].state].label}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-500 mt-0.5 truncate">{de.department || de.category} · {de.description || 'No description yet.'}</p>
            </div>
            <span className="text-slate-600 flex-shrink-0">→</span>
          </button>
        ))}
        {des.length === 0 && <p className="text-xs text-slate-500">No Digital Employees yet — add your first one below.</p>}
      </div>

      {adding && (
        <div className="rounded-xl border border-slate-700 bg-slate-950/60 p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-slate-400">
              Role / label (required)
              <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Account Success DE"
                className="mt-1 w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-200 text-xs focus:border-indigo-500 focus:outline-none" />
            </label>
            <label className="text-xs text-slate-400">
              Persona name (optional)
              <input value={personaName} onChange={e => setPersonaName(e.target.value)} placeholder="e.g. Jordan"
                className="mt-1 w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-200 text-xs focus:border-indigo-500 focus:outline-none" />
            </label>
          </div>
          <label className="text-xs text-slate-400 block">
            Department
            <input value={department} onChange={e => setDepartment(e.target.value)} placeholder="e.g. Account Success"
              className="mt-1 w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-200 text-xs focus:border-indigo-500 focus:outline-none" />
          </label>
          <label className="text-xs text-slate-400 block">
            What does this Digital Employee do?
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} placeholder="Plain language — what this DE is responsible for"
              className="mt-1 w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-200 text-xs focus:border-indigo-500 focus:outline-none" />
          </label>
          <p className="text-[11px] text-slate-500">
            Starts supervised with no data access and no playbooks — you (or an admin) grant those next, the same way for every DE.
          </p>
          <div className="flex items-center gap-2">
            <button onClick={() => void submit()} disabled={busy}
              className="text-xs px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-500 text-white font-medium disabled:opacity-40 transition-colors">
              {busy ? 'Creating…' : 'Create'}
            </button>
            <button onClick={() => setAdding(false)} className="text-xs text-slate-500 hover:text-slate-300">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Performance — real per-DE metrics (migrations 093-096), filtered
// client-side from the tenant-wide RPC to this one employee. ──────
function DePerformancePanel({ deId }: { deId: string }) {
  const [metrics, setMetrics] = useState<DePerformanceMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data: profile } = await supabase.from('profiles').select('tenant_id').single();
      const tenantId = profile?.tenant_id;
      if (!tenantId) { if (!cancelled) setLoading(false); return; }
      const all = await getDePerformanceMetrics(tenantId);
      if (!cancelled) {
        setMetrics(all.find(m => m.de_id === deId) ?? null);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [deId]);

  if (loading) return null;

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Performance</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300">real metrics</span>
      </div>
      <p className="text-xs text-slate-500 mb-5">Computed from this employee's own decisions and runs — not estimated.</p>

      {!metrics || metrics.total_decisions === 0 ? (
        <p className="text-xs text-slate-500">No decisions recorded yet for this employee.</p>
      ) : (
        <div className="grid grid-cols-4 gap-3">
          {[
            { label: 'Resolution', value: `${metrics.resolution_rate}%` },
            { label: 'Confidence', value: `${metrics.avg_confidence}%` },
            { label: 'Escalation', value: `${metrics.escalation_rate}%` },
            { label: 'Error rate', value: `${metrics.error_rate}%` },
          ].map(t => (
            <div key={t.label} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
              <div className="text-[11px] text-slate-500">{t.label}</div>
              <div className="text-lg font-semibold text-slate-100 mt-0.5">{t.value}</div>
            </div>
          ))}
        </div>
      )}
      {metrics && metrics.total_decisions > 0 && (
        <p className="mt-4 text-[11px] text-slate-500">
          {metrics.total_decisions} inquiries this period{metrics.high_frustration_count > 0 ? ` · ${metrics.high_frustration_count} auto-escalated for frustration` : ''}
        </p>
      )}
    </div>
  );
}

// ── Knowledge scope — real per-DE knowledge_doc_scopes count
// (migration 030). No doc list here on purpose — the Knowledge
// Library is where you manage scoping; this is a status summary. ──
function DeKnowledgeScopePanel({ deId }: { deId: string }) {
  const [scopedCount, setScopedCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const scopes = await listDocScopes();
        let n = 0;
        for (const subjects of Object.values(scopes)) {
          if (subjects.some(s => s.kind === 'de' && s.id === deId)) n++;
        }
        if (!cancelled) setScopedCount(n);
      } catch { if (!cancelled) setScopedCount(0); }
    })();
    return () => { cancelled = true; };
  }, [deId]);

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Knowledge scope</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-500/15 text-teal-300">control fabric</span>
      </div>
      <p className="text-xs text-slate-500">
        This employee reads every company-wide document, plus{' '}
        <span className="text-slate-300">{scopedCount === null ? '…' : scopedCount}</span>{' '}
        document{scopedCount === 1 ? '' : 's'} specifically scoped to it.
      </p>
      <p className="mt-3 text-[11px] text-slate-500">
        Manage scoping from the Knowledge Library — each document's "Who can use this" setting.
      </p>
    </div>
  );
}

// ── Incidents — real guardrail-block audit events attributed to this
// DE, given their own identity instead of living unlabeled inside the
// tenant-wide Audit Trail. Data already existed (audit_events,
// category='guardrail_block'); this is a filtered, labeled view over
// it, not new detection. ────────────────────────────────────────────
// The durable Incident Record (migration 123, constitution §3.16):
// real rows with an open→reviewed→closed lifecycle, captured every
// 5 minutes from guardrail blocks, automatic trust demotions, failed
// eval runs, and human-rejected actions. Replaces the old read-only
// name-matched audit view.
interface DEIncident {
  id: string; de_id: string | null; kind: string; severity: string;
  title: string; detail: Record<string, unknown>;
  status: 'open' | 'reviewed' | 'closed';
  resolution_note: string | null; occurred_at: string;
}
const INCIDENT_KIND_LABELS: Record<string, string> = {
  guardrail_block: 'guardrail', trust_demotion: 'trust demotion',
  eval_regression: 'eval failure', action_rejected: 'rejected action',
};
function DeIncidentsPanel({ de, setPage }: { de: DigitalEmployee; setPage: (p: Page) => void }) {
  const [incidents, setIncidents] = useState<DEIncident[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('de_incidents')
      .select('id, de_id, kind, severity, title, detail, status, resolution_note, occurred_at')
      .or(`de_id.eq.${de.id},de_id.is.null`)
      .order('occurred_at', { ascending: false })
      .limit(50);
    if (err) { setIncidents([]); return; }
    setIncidents((data ?? []) as DEIncident[]);
  }, [de.id]);
  useEffect(() => { void load(); }, [load]);

  const review = async (id: string, status: 'reviewed' | 'closed') => {
    setBusy(true); setError(null);
    const { error: err } = await supabase.rpc('review_de_incident', {
      p_incident_id: id, p_status: status, p_resolution_note: note.trim() || null,
    });
    if (err) setError(err.message);
    else { setNote(''); setOpenId(null); }
    await load();
    setBusy(false);
  };

  if (incidents === null) return null;

  const openCount = incidents.filter(i => i.status === 'open').length;
  const sevDot = (s: string) => s === 'critical' ? 'bg-rose-500' : s === 'warning' ? 'bg-amber-500' : 'bg-slate-500';
  const statusChip = (s: string) =>
    s === 'open' ? 'bg-amber-500/15 text-amber-300'
    : s === 'reviewed' ? 'bg-indigo-500/15 text-indigo-300'
    : 'bg-slate-800 text-slate-500';

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Incidents</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300">durable record</span>
        {openCount > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">{openCount} open</span>}
      </div>
      <p className="text-xs text-slate-500 mb-5">
        Guardrail blocks, automatic trust demotions, failed eval runs, and human-rejected actions —
        captured every 5 minutes as reviewable records. Review or close each with a resolution note;
        every decision is audited.
      </p>
      {error && <p className="text-xs text-rose-300 mb-2">{error}</p>}

      {incidents.length === 0 ? (
        <p className="text-xs text-slate-500">No incidents on record — a clean history.</p>
      ) : (
        <div className="space-y-1.5">
          {incidents.map(inc => (
            <div key={inc.id} className="rounded-lg bg-slate-950/60">
              <button onClick={() => { setOpenId(k => k === inc.id ? null : inc.id); setNote(''); }}
                className="w-full flex items-center gap-3 text-left px-3 py-2 text-xs">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${sevDot(inc.severity)}`} />
                <span className="flex-1 text-slate-300 truncate">{inc.title}</span>
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-500 flex-shrink-0">{INCIDENT_KIND_LABELS[inc.kind] ?? inc.kind}</span>
                {inc.de_id === null && <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-500 flex-shrink-0">workspace-wide</span>}
                <span className={`text-[9px] px-1.5 py-0.5 rounded flex-shrink-0 ${statusChip(inc.status)}`}>{inc.status}</span>
                <span className="text-slate-600 flex-shrink-0">{new Date(inc.occurred_at).toLocaleDateString()}</span>
              </button>
              {openId === inc.id && (
                <div className="px-3 pb-3 text-[11px] text-slate-500 space-y-2">
                  {typeof inc.detail?.reasoning === 'string' && <p className="text-slate-400">{inc.detail.reasoning as string}</p>}
                  {typeof inc.detail?.action === 'string' && <p className="text-slate-400">{inc.detail.action as string}</p>}
                  {typeof inc.detail?.request_summary === 'string' && <p className="text-slate-400">{inc.detail.request_summary as string}</p>}
                  {inc.resolution_note && <p>Resolution: <span className="text-slate-300">{inc.resolution_note}</span></p>}
                  <p>Occurred {new Date(inc.occurred_at).toLocaleString()} · provenance-linked to the immutable audit record.</p>
                  {inc.status !== 'closed' && (
                    <div className="pt-1 space-y-2">
                      <input
                        value={note}
                        onChange={e => setNote(e.target.value)}
                        placeholder="Resolution note (optional)"
                        className="w-full bg-slate-900 border border-slate-800 text-slate-200 text-[11px] rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-indigo-500"
                      />
                      <div className="flex gap-2">
                        {inc.status === 'open' && (
                          <button onClick={() => void review(inc.id, 'reviewed')} disabled={busy}
                            className="px-2.5 py-1 rounded-lg bg-indigo-600/30 border border-indigo-500/40 text-indigo-300 hover:bg-indigo-600/50 disabled:opacity-50">
                            Mark reviewed
                          </button>
                        )}
                        <button onClick={() => void review(inc.id, 'closed')} disabled={busy}
                          className="px-2.5 py-1 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 disabled:opacity-50">
                          Close incident
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="mt-4 text-[11px] text-slate-500">
        <button onClick={() => setPage('gov_audit')} className="text-indigo-400 hover:text-indigo-300 transition-colors">
          View the full Audit Trail →
        </button>
      </p>
    </div>
  );
}

// ── Health — a real, composed signal (Wave 5, migration 112). Self-
// contained: fetches the whole tenant's health list and filters to
// this DE, matching the other per-DE panels' pattern. ──────────────
function DeHealthInline({ deId }: { deId: string }) {
  const [health, setHealth] = useState<DEHealth | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    listDeHealth().then(all => { if (!cancelled) setHealth(all.find(h => h.de_id === deId) ?? null); })
      .catch(() => { if (!cancelled) setHealth(null); });
    return () => { cancelled = true; };
  }, [deId]);
  if (!health) return null;
  const meta = DE_HEALTH_LABELS[health.state];
  return (
    <>
      <span className={`text-xs px-2 py-0.5 rounded-full ${meta.color}`} title={JSON.stringify(health.signals)}>
        {meta.label}
      </span>
      {health.cost_per_task_usd !== null && (
        <span className="text-[11px] text-slate-500">${health.cost_per_task_usd.toFixed(3)}/task</span>
      )}
    </>
  );
}

// ── Development — evidence-grounded Development Plan items (Wave 4,
// migration 112). Proposed from real 8-week performance data or
// created manually; never fabricated categories. ───────────────────
function DeDevelopmentPanel({ de }: { de: DigitalEmployee }) {
  const [items, setItems] = useState<DEDevelopmentItem[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setItems(await listDeDevelopmentItems(de.id)); } catch { setItems([]); }
  }, [de.id]);

  useEffect(() => { void load(); }, [load]);

  const scan = async () => {
    setScanning(true); setErr(null);
    try { await detectDeDevelopmentNeeds(); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not scan for development needs.'); }
    finally { setScanning(false); }
  };

  const addManual = async () => {
    if (!desc.trim()) { setErr('Describe the development need.'); return; }
    setBusy(true); setErr(null);
    try { await createDeDevelopmentItem(de.id, { description: desc.trim() }); setDesc(''); setShowAdd(false); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not create the item.'); }
    finally { setBusy(false); }
  };

  const setStatus = async (itemId: string, status: DEDevelopmentItem['status']) => {
    setBusy(true);
    try { await updateDeDevelopmentItemStatus(itemId, status); await load(); }
    finally { setBusy(false); }
  };

  if (items === null) return null;
  const open = items.filter(i => i.status === 'proposed' || i.status === 'in_progress');
  const resolved = items.filter(i => i.status === 'completed' || i.status === 'dismissed');

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Development</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300">evidence-grounded</span>
      </div>
      <p className="text-xs text-slate-500 mb-4">
        Proposed from real 8-week performance data (escalation rate, confidence, error rate, guardrail patterns) — or added manually. While one is open, this employee shows as "Improving."
      </p>
      {err && <div className="mb-3 rounded-lg border border-rose-800/50 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{err}</div>}

      <div className="flex gap-2 mb-3">
        <button onClick={scan} disabled={scanning} className="text-xs px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 transition-colors disabled:opacity-50">
          {scanning ? 'Scanning…' : 'Scan for development needs'}
        </button>
        <button onClick={() => setShowAdd(s => !s)} className="text-xs px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 transition-colors">
          + Add manually
        </button>
      </div>

      {showAdd && (
        <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 space-y-2 mb-3">
          <textarea value={desc} onChange={e => setDesc(e.target.value)} rows={2} placeholder="What does this employee need to work on?"
            className="w-full rounded-lg bg-slate-900 border border-slate-800 px-2 py-1.5 text-xs text-white" />
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowAdd(false)} disabled={busy} className="text-[11px] px-2 py-1 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800">Cancel</button>
            <button onClick={addManual} disabled={busy} className="text-[11px] px-2 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white">{busy ? 'Adding…' : 'Add item'}</button>
          </div>
        </div>
      )}

      {open.length === 0 ? (
        <p className="text-xs text-slate-500">No open development items — nothing evidence-based flagged, and none added manually.</p>
      ) : (
        <div className="space-y-1.5 mb-3">
          {open.map(item => (
            <div key={item.id} className="rounded-lg bg-slate-950/60 px-3 py-2 text-xs">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 mr-1.5">{item.source === 'detected' ? 'detected' : 'manual'}</span>
                  <span className="text-slate-300">{item.description}</span>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                  {item.status === 'proposed' && (
                    <button onClick={() => setStatus(item.id, 'in_progress')} disabled={busy} className="text-[10px] px-2 py-0.5 rounded bg-sky-500/15 text-sky-300 hover:bg-sky-500/25">Start</button>
                  )}
                  <button onClick={() => setStatus(item.id, 'completed')} disabled={busy} className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25">Complete</button>
                  <button onClick={() => setStatus(item.id, 'dismissed')} disabled={busy} className="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-500 hover:bg-slate-700">Dismiss</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {resolved.length > 0 && (
        <p className="text-[11px] text-slate-600">{resolved.length} resolved item{resolved.length === 1 ? '' : 's'} on record.</p>
      )}
    </div>
  );
}

// ── Governance — config editing/versioning, ownership/transfer,
// retirement with real dependency checks (Wave 2, migration 110). ──

function EditDEModal({ de, onClose, onSaved }: { de: DigitalEmployee; onClose: () => void; onSaved: (de: DigitalEmployee) => void }) {
  const [name, setName] = useState(de.name);
  const [personaName, setPersonaName] = useState(de.persona_name ?? '');
  const [description, setDescription] = useState(de.description);
  const [department, setDepartment] = useState(de.department);
  const [confidenceThreshold, setConfidenceThreshold] = useState(String(de.confidence_threshold));
  const [requiredApproval, setRequiredApproval] = useState(de.required_approval);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const updated = await updateDigitalEmployee(de.id, {
        name: name.trim() || undefined,
        personaName: personaName.trim(),
        description,
        department,
        confidenceThreshold: Number(confidenceThreshold) || undefined,
        requiredApproval,
      });
      onSaved(updated);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save changes.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Edit ${de.persona_name || de.name}`} onClose={onClose}>
      <div className="space-y-3">
        {err && <div className="rounded-lg border border-rose-800/50 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{err}</div>}
        <label className="block text-xs text-slate-400">Name
          <input value={name} onChange={e => setName(e.target.value)} className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-sm text-white" />
        </label>
        <label className="block text-xs text-slate-400">Persona name (optional)
          <input value={personaName} onChange={e => setPersonaName(e.target.value)} className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-sm text-white" />
        </label>
        <label className="block text-xs text-slate-400">Description
          <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-sm text-white" />
        </label>
        <label className="block text-xs text-slate-400">Department
          <input value={department} onChange={e => setDepartment(e.target.value)} className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-sm text-white" />
        </label>
        <label className="block text-xs text-slate-400">Confidence threshold (0-100)
          <input type="number" min={0} max={100} value={confidenceThreshold} onChange={e => setConfidenceThreshold(e.target.value)} className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-sm text-white" />
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input type="checkbox" checked={requiredApproval} onChange={e => setRequiredApproval(e.target.checked)} />
          Require human approval by default
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} disabled={busy} className="text-xs px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 transition-colors disabled:opacity-50">Cancel</button>
          <button onClick={save} disabled={busy} className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50">{busy ? 'Saving…' : 'Save changes'}</button>
        </div>
      </div>
    </Modal>
  );
}

function TransferOwnerModal({ de, onClose, onSaved }: { de: DigitalEmployee; onClose: () => void; onSaved: (de: DigitalEmployee) => void }) {
  const { members, loading: membersLoading } = useUsers();
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const candidates = members.filter(m => m.status === 'active' && m.userId !== de.owner_id);

  const save = async () => {
    if (!target) { setErr('Choose a new owner.'); return; }
    setBusy(true); setErr(null);
    try {
      const updated = await transferDeOwnership(de.id, target, note.trim() || undefined);
      onSaved(updated);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not transfer ownership.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Transfer ownership of ${de.persona_name || de.name}`} onClose={onClose}>
      <div className="space-y-3">
        {err && <div className="rounded-lg border border-rose-800/50 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{err}</div>}
        {membersLoading ? (
          <p className="text-xs text-slate-500">Loading team…</p>
        ) : candidates.length === 0 ? (
          <p className="text-xs text-slate-500">No other active team members to transfer to.</p>
        ) : (
          <label className="block text-xs text-slate-400">New owner
            <select value={target} onChange={e => setTarget(e.target.value)} className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-sm text-white">
              <option value="">Select a team member…</option>
              {candidates.map(m => <option key={m.userId} value={m.userId}>{m.fullName} ({m.role})</option>)}
            </select>
          </label>
        )}
        <label className="block text-xs text-slate-400">Note (optional)
          <input value={note} onChange={e => setNote(e.target.value)} className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-sm text-white" placeholder="Why this transfer is happening" />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} disabled={busy} className="text-xs px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 transition-colors disabled:opacity-50">Cancel</button>
          <button onClick={save} disabled={busy || candidates.length === 0} className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50">{busy ? 'Transferring…' : 'Transfer ownership'}</button>
        </div>
      </div>
    </Modal>
  );
}

function RetireDEModal({ de, onClose, onRetired }: { de: DigitalEmployee; onClose: () => void; onRetired: (de: DigitalEmployee) => void }) {
  const [readiness, setReadiness] = useState<RetirementReadiness | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    checkDeRetirementReadiness(de.id).then(r => { if (!cancelled) setReadiness(r); }).catch(e => { if (!cancelled) setErr(e instanceof Error ? e.message : 'Could not check readiness.'); });
    return () => { cancelled = true; };
  }, [de.id]);

  const confirm = async () => {
    if (!reason.trim()) { setErr('A retirement reason is required.'); return; }
    setBusy(true); setErr(null);
    try {
      const updated = await retireDigitalEmployee(de.id, reason.trim());
      onRetired(updated);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not retire this employee.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Retire ${de.persona_name || de.name}`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-xs text-slate-400">
          Retirement is terminal — a retired employee cannot be reactivated. Configuration locks read-only and the full history is retained.
        </p>
        {err && <div className="rounded-lg border border-rose-800/50 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{err}</div>}
        {readiness === null ? (
          <p className="text-xs text-slate-500">Checking for open dependencies…</p>
        ) : readiness.ready ? (
          <div className="rounded-lg border border-emerald-800/50 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
            No open dependencies — clear to retire.
          </div>
        ) : (
          <div className="rounded-lg border border-amber-800/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-300 space-y-1">
            <p className="font-medium">Cannot retire yet — resolve first:</p>
            {readiness.blockers.map(b => <p key={b.kind}>• {b.message}</p>)}
          </div>
        )}
        <label className="block text-xs text-slate-400">Reason for retirement (required)
          <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-sm text-white" />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} disabled={busy} className="text-xs px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 transition-colors disabled:opacity-50">Cancel</button>
          <button onClick={confirm} disabled={busy || !readiness?.ready} className="text-xs px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white transition-colors disabled:opacity-50">{busy ? 'Retiring…' : 'Retire this employee'}</button>
        </div>
      </div>
    </Modal>
  );
}

// ── Consultations — bounded DE-to-DE delegation (Wave 3, migration
// 111). NOT full Composition: single-hop, governance-gated by an
// explicit allow-list this panel manages. ──────────────────────────
function ConsultationsPanel({ de }: { de: DigitalEmployee }) {
  const [asRequester, setAsRequester] = useState<DEConsultationGrant[] | null>(null);
  const [asTarget, setAsTarget] = useState<DEConsultationGrant[] | null>(null);
  const [roster, setRoster] = useState<DigitalEmployee[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [nameById, setNameById] = useState<Record<string, string>>({});
  const [showAdd, setShowAdd] = useState(false);
  const [targetId, setTargetId] = useState('');
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [grants, des, cats] = await Promise.all([
        listDeConsultationGrants(de.id),
        listDigitalEmployees(),
        supabase.from('system_categories').select('key').order('key'),
      ]);
      setAsRequester(grants.asRequester);
      setAsTarget(grants.asTarget);
      setRoster(des.filter(d => d.id !== de.id && d.lifecycle_status !== 'retired'));
      setNameById(Object.fromEntries(des.map(d => [d.id, d.persona_name || d.name])));
      setCategories(((cats.data ?? []) as Array<{ key: string }>).map(c => c.key));
    } catch {
      setAsRequester([]); setAsTarget([]);
    }
  }, [de.id]);

  useEffect(() => { void load(); }, [load]);

  const addGrant = async () => {
    if (!targetId || !category) { setErr('Choose a target employee and a category.'); return; }
    setBusy(true); setErr(null);
    try {
      await createDeConsultationGrant(de.id, targetId, category);
      setShowAdd(false); setTargetId(''); setCategory('');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create the consultation grant.');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (grant: DEConsultationGrant) => {
    setBusy(true);
    try { await setDeConsultationGrantActive(grant.id, !grant.active); await load(); }
    finally { setBusy(false); }
  };

  if (asRequester === null) return null;

  return (
    <div className="mt-5 pt-5 border-t border-slate-800">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h4 className="text-sm font-semibold text-slate-200">Consultations</h4>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-500/15 text-teal-300">bounded, single-hop</span>
      </div>
      <p className="text-[11px] text-slate-500 mb-3">
        A governed, one-question handoff to another employee — the answer comes from the OTHER employee's own access, never widening this one's.
        Not full delegation: no chains, no fan-out.
      </p>
      {err && <div className="mb-2 rounded-lg border border-rose-800/50 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{err}</div>}

      <p className="text-xs text-slate-400 mb-1">Can consult:</p>
      {asRequester.length === 0 ? (
        <p className="text-xs text-slate-600 mb-3">No consultation grants yet.</p>
      ) : (
        <div className="space-y-1 mb-3">
          {asRequester.map(g => (
            <div key={g.id} className="flex items-center justify-between rounded-lg bg-slate-950/60 px-3 py-1.5 text-xs">
              <span className="text-slate-300">{nameById[g.target_de_id] || 'Unknown'} <span className="text-slate-600">· {g.category}</span></span>
              <button onClick={() => toggle(g)} disabled={busy} className={`text-[10px] px-2 py-0.5 rounded ${g.active ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-800 text-slate-500'}`}>
                {g.active ? 'active' : 'inactive'}
              </button>
            </div>
          ))}
        </div>
      )}

      {showAdd ? (
        <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 space-y-2 mb-3">
          <select value={targetId} onChange={e => setTargetId(e.target.value)} className="w-full rounded-lg bg-slate-900 border border-slate-800 px-2 py-1.5 text-xs text-white">
            <option value="">Consult which employee…</option>
            {roster.map(d => <option key={d.id} value={d.id}>{d.persona_name || d.name}</option>)}
          </select>
          <select value={category} onChange={e => setCategory(e.target.value)} className="w-full rounded-lg bg-slate-900 border border-slate-800 px-2 py-1.5 text-xs text-white">
            <option value="">On which category…</option>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowAdd(false)} disabled={busy} className="text-[11px] px-2 py-1 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800">Cancel</button>
            <button onClick={addGrant} disabled={busy} className="text-[11px] px-2 py-1 rounded-lg bg-teal-600 hover:bg-teal-500 text-white">{busy ? 'Adding…' : 'Add grant'}</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowAdd(true)} className="text-[11px] px-2.5 py-1 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 mb-3">
          + Grant a consultation
        </button>
      )}

      {asTarget !== null && asTarget.length > 0 && (
        <>
          <p className="text-xs text-slate-400 mb-1">Consulted by:</p>
          <div className="space-y-1">
            {asTarget.map(g => (
              <div key={g.id} className="rounded-lg bg-slate-950/60 px-3 py-1.5 text-xs text-slate-400">
                {nameById[g.requester_de_id] || 'Unknown'} <span className="text-slate-600">· {g.category} · {g.active ? 'active' : 'inactive'}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function DeGovernancePanel({ de, onUpdated }: { de: DigitalEmployee; onUpdated: (de: DigitalEmployee) => void }) {
  const { members } = useUsers();
  const [history, setHistory] = useState<DEConfigHistoryEntry[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [modal, setModal] = useState<'edit' | 'transfer' | 'retire' | null>(null);
  const ownerName = members.find(m => m.userId === de.owner_id)?.fullName ?? (de.owner_id ? 'Unknown' : 'Unassigned');
  const retired = de.lifecycle_status === 'retired';

  const loadHistory = async () => {
    setShowHistory(s => !s);
    if (history === null) {
      try { setHistory(await getDEConfigHistory(de.id)); } catch { setHistory([]); }
    }
  };

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Governance</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300">config v{de.config_version}</span>
        {retired && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">retired — read-only</span>}
      </div>
      <p className="text-xs text-slate-500 mb-4">
        Who's accountable for this employee, every configuration change on record, and how retirement works.
      </p>

      <div className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3 mb-3">
        <div>
          <p className="text-xs text-slate-500">Owner</p>
          <p className="text-sm text-slate-200">{ownerName}</p>
        </div>
        {!retired && (
          <button onClick={() => setModal('transfer')} className="text-xs px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 transition-colors">
            Transfer
          </button>
        )}
      </div>

      <div className="flex gap-2 mb-3">
        {!retired && (
          <button onClick={() => setModal('edit')} className="text-xs px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 transition-colors">
            Edit configuration
          </button>
        )}
        <button onClick={loadHistory} className="text-xs px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 transition-colors">
          {showHistory ? 'Hide' : 'View'} config history
        </button>
        {!retired && (
          <button onClick={() => setModal('retire')} className="ml-auto text-xs px-3 py-1.5 rounded-lg border border-red-900/50 text-red-400 hover:bg-red-950/40 transition-colors">
            Retire
          </button>
        )}
      </div>

      {showHistory && (
        history === null ? (
          <p className="text-xs text-slate-500">Loading history…</p>
        ) : history.length === 0 ? (
          <p className="text-xs text-slate-500">No configuration changes on record yet.</p>
        ) : (
          <div className="space-y-1.5">
            {history.map(h => (
              <div key={h.id} className="rounded-lg bg-slate-950/60 px-3 py-2 text-[11px]">
                <div className="flex items-center gap-2 text-slate-400">
                  <span className="capitalize text-slate-300">{h.operation.toLowerCase()}</span>
                  <span>by {h.actor_name || 'unknown'}</span>
                  <span className="ml-auto text-slate-600">{new Date(h.created_at).toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {!retired && <ConsultationsPanel de={de} />}

      {modal === 'edit' && <EditDEModal de={de} onClose={() => setModal(null)} onSaved={onUpdated} />}
      {modal === 'transfer' && <TransferOwnerModal de={de} onClose={() => setModal(null)} onSaved={onUpdated} />}
      {modal === 'retire' && <RetireDEModal de={de} onClose={() => setModal(null)} onRetired={onUpdated} />}
    </div>
  );
}

// ── System access panel — "what this employee can touch" ──────────
// Reads the DE's own data_access_grants (Control Fabric, migration
// 029): per connector/category, at what permission. Read-only here;
// managed centrally under Governance → Data Access.
function DeSystemAccessPanel({ deId, setPage }: { deId: string; setPage: (p: Page) => void }) {
  const [grants, setGrants] = useState<Array<{ id: string; resource_kind: string; resource_id: string | null; resource_category: string | null; permission: string }> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void supabase.from('data_access_grants')
      .select('id, resource_kind, resource_id, resource_category, permission')
      .eq('subject_kind', 'de').eq('subject_id', deId)
      .then(({ data }) => { if (!cancelled) setGrants((data ?? []) as typeof grants); });
    return () => { cancelled = true; };
  }, [deId]);

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">What this employee can touch</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-500/15 text-teal-300">default-deny</span>
      </div>
      <p className="text-[11px] text-slate-500 mb-3">
        System access via the Control Fabric — a grant is necessary, never sufficient, for a write
        (guardrails and approval gates still apply on top).
      </p>
      {grants === null ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : grants.length === 0 ? (
        <p className="text-xs text-slate-500">No system access granted — this employee can’t search, read, or act on any connected system yet.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {grants.map(g => (
            <span key={g.id} className="text-xs px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-800 text-slate-300">
              {g.resource_category ?? 'specific connector'}
              <span className={`ml-2 font-semibold ${g.permission === 'write_back' ? 'text-amber-300' : 'text-teal-300'}`}>{g.permission.replace('_', '-')}</span>
            </span>
          ))}
        </div>
      )}
      <button onClick={() => setPage('gov_data_access')} className="mt-3 text-xs text-indigo-400 hover:text-indigo-300">
        Manage under Governance → Data Access →
      </button>
    </div>
  );
}

// ── Specialists panel — primary & secondary consult desks ──────────
// A DE consults its PRIMARY specialist first; if that profile is
// paused, the SECONDARY. Playbook steps using profile_key "auto"
// resolve through this assignment (migration 122).
function DeSpecialistsPanel({ deId }: { deId: string }) {
  const [specialists, setSpecialists] = useState<Array<{ id: string; name: string; key: string; status: string }>>([]);
  const [assigned, setAssigned] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data: sps }, { data: rows, error: err }] = await Promise.all([
      supabase.from('specialist_profiles').select('id, name, key, status').order('created_at'),
      supabase.rpc('list_de_specialists', { p_de_id: deId }),
    ]);
    if (err) { setError(err.message); return; }
    setSpecialists((sps ?? []) as typeof specialists);
    const map: Record<number, string> = {};
    for (const r of (rows ?? []) as Array<{ rank: number; specialist_id: string }>) map[r.rank] = r.specialist_id;
    setAssigned(map);
  }, [deId]);
  useEffect(() => { void load(); }, [load]);

  const setRank = async (rank: 1 | 2, specialistId: string) => {
    setBusy(true); setError(null);
    const { error: err } = await supabase.rpc('set_de_specialist', {
      p_de_id: deId, p_rank: rank, p_specialist_id: specialistId || null,
    });
    if (err) setError(err.message);
    await load();
    setBusy(false);
  };

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Specialists</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300">consult desks</span>
      </div>
      <p className="text-[11px] text-slate-500 mb-3">
        When this employee needs help beyond its own knowledge, it consults its primary specialist —
        and falls back to the secondary if the primary is paused. Playbook “Consult specialist” steps
        set to <span className="text-slate-300">auto</span> resolve through this assignment.
      </p>
      {error && <p className="text-xs text-rose-300 mb-2">{error}</p>}
      <div className="grid grid-cols-2 gap-3">
        {([1, 2] as const).map(rank => (
          <div key={rank}>
            <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">{rank === 1 ? 'Primary' : 'Secondary'}</p>
            <select
              value={assigned[rank] ?? ''}
              disabled={busy}
              onChange={e => void setRank(rank, e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
            >
              <option value="">— none —</option>
              {specialists.map(sp => (
                <option key={sp.id} value={sp.id}>
                  {sp.name}{sp.status !== 'active' ? ' (paused)' : ''}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function LiveWorkforceDEs({ setPage }: { setPage: (p: Page) => void }) {
  const { liveTenantName } = useAuth();
  const [selectedDe, setSelectedDe] = useState<DigitalEmployee | null>(null);
  // Whether each action type's resolved value came from THIS employee's
  // own override (true) or the workspace-wide default (false) — drives
  // the "personal / workspace default" badge on the dial.
  const [isPersonal, setIsPersonal] = useState<Record<string, boolean>>({});
  const [rows, setRows] = useState<Record<string, DEAutonomy>>({});
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [evidence, setEvidence] = useState<ApprovalEvidence | null>(null);
  const [thresholdCents, setThresholdCents] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [missingTables, setMissingTables] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  // Earned trust
  const [policies, setPolicies] = useState<Record<string, TrustPolicy>>({});
  const [trustEvidence, setTrustEvidence] = useState<Record<string, TrustEvidence>>({});
  const [trustHistory, setTrustHistory] = useState<TrustHistoryEvent[]>([]);
  const [trustError, setTrustError] = useState<string | null>(null);
  const [requestingId, setRequestingId] = useState<string | null>(null);
  const [requestedId, setRequestedId] = useState<string | null>(null);

  const refreshTrust = useCallback(async () => {
    try {
      let list = await listTrustPolicies();
      if (list.length === 0) list = await seedTrustPolicies();
      const byCat: Record<string, TrustPolicy> = {};
      for (const p of list) byCat[p.action_category] = p;
      setPolicies(byCat);
      const ev: Record<string, TrustEvidence> = {};
      await Promise.all(list.map(async p => {
        try { ev[p.action_category] = await computeTrustEvidence(p.action_category, p.de_id); } catch { /* per-card */ }
      }));
      setTrustEvidence(ev);
      try { setTrustHistory(await listTrustHistory(8)); } catch { setTrustHistory([]); }
      setTrustError(null);
    } catch (err) {
      setTrustError((err as Error)?.message || 'Failed to load earned trust.');
    }
  }, []);

  const refresh = useCallback(async (deId: string) => {
    setLoading(true);
    setError(null);
    try {
      const [resolved, list, thr] = await Promise.all([
        Promise.all(ACTION_ORDER.map(t => resolveAutonomy(t, deId))),
        listAutonomy(),
        getApprovalThresholdCents(),
      ]);
      const byType: Record<string, DEAutonomy> = {};
      const personal: Record<string, boolean> = {};
      ACTION_ORDER.forEach((t, idx) => {
        const r = resolved[idx];
        // Synthesize a DEAutonomy-shaped row from the resolved values —
        // the "id" is cosmetic here since resolution can fall through
        // several tiers with no single backing row.
        byType[t] = {
          id: `resolved:${t}`, tenant_id: '', action_type: t, de_id: deId, source_category: null,
          enabled: r.enabled, max_amount_cents: r.max_amount_cents, min_confidence: r.min_confidence,
          updated_by: null, created_at: '', updated_at: '',
        };
        personal[t] = list.some(a => a.action_type === t && a.de_id === deId);
      });
      setRows(byType);
      setIsPersonal(personal);
      setThresholdCents(thr.cents);
      setDrafts(Object.fromEntries(ACTION_ORDER.map(t => [t, draftFrom(byType[t])])));
      setMissingTables(false);
      try { setEvidence(await getApprovalEvidence()); } catch { setEvidence(null); }
      void refreshTrust();
    } catch (err) {
      if (err instanceof CustomerApiError && err.missingTables) setMissingTables(true);
      else setError((err as Error)?.message || 'Failed to load the trust dial.');
    } finally {
      setLoading(false);
    }
  }, [refreshTrust]);

  useEffect(() => { if (selectedDe) void refresh(selectedDe.id); }, [selectedDe, refresh]);

  /** Does a dial setting exceed what's been EARNED for its category? */
  const exceedsEarned = useCallback((type: AutonomyActionType, enabled: boolean, maxCents: number | null, minConf: number | null): boolean => {
    const policy = policies[type];
    if (!policy || !enabled) return false;
    const earned = trustLevelSettings(type as TrustCategory, policy.current_level);
    if (!earned.enabled) return true;
    if (earned.max_amount_cents !== null && (maxCents ?? Infinity) > earned.max_amount_cents) return true;
    if (earned.min_confidence !== null && (minConf ?? 0) < earned.min_confidence) return true;
    return false;
  }, [policies]);

  const requestPromotion = async (policy: TrustPolicy) => {
    setRequestingId(policy.id);
    setTrustError(null);
    try {
      await requestTrustPromotion(policy.id);
      setRequestedId(policy.id);
      setTimeout(() => setRequestedId(k => (k === policy.id ? null : k)), 4000);
      await refreshTrust();
    } catch (err) {
      setTrustError((err as Error)?.message || 'Promotion request failed.');
    } finally {
      setRequestingId(null);
    }
  };

  const save = async (type: AutonomyActionType) => {
    const d = drafts[type];
    if (!d || !selectedDe) return;
    setSavingKey(type);
    setError(null);
    try {
      const meta = AUTONOMY_ACTION_META[type];
      const row = await upsertAutonomy(type, {
        enabled: d.enabled,
        max_amount_cents: meta.unit === 'amount' && d.amount.trim() !== ''
          ? Math.max(0, Math.round(Number(d.amount) || 0)) * 100 : null,
        min_confidence: meta.unit === 'confidence' && d.confidence.trim() !== ''
          ? Math.max(0, Math.min(100, Math.round(Number(d.confidence) || 0))) : null,
      }, selectedDe.id);
      setIsPersonal(prev => ({ ...prev, [type]: true }));
      // Manual raise above the earned level → recorded as an override so
      // the earned path stays the celebrated one (still guardrail-capped).
      if (exceedsEarned(type, row.enabled, row.max_amount_cents, row.min_confidence)) {
        try {
          await appendAuditEvent({
            actor: 'You', actor_type: 'human', category: 'config_change',
            action: `Manual trust override — ${meta.label} set above the earned level`,
            detail: {
              kind: 'trust_manual_override', action_category: type,
              earned_level: policies[type]?.current_level ?? 0,
              enabled: row.enabled, max_amount_cents: row.max_amount_cents, min_confidence: row.min_confidence,
              composition: 'autonomy_narrows_within_guardrails',
            },
          });
        } catch { /* audit best-effort; upsert already audited */ }
      }
      setRows(prev => ({ ...prev, [type]: row }));
      setDrafts(prev => ({ ...prev, [type]: draftFrom(row) }));
      setSavedKey(type);
      setTimeout(() => setSavedKey(k => (k === type ? null : k)), 2500);
    } catch (err) {
      setError((err as Error)?.message || 'Failed to save.');
    } finally {
      setSavingKey(null);
    }
  };

  const evidenceLine = evidence && evidence.total > 0
    ? `${evidence.total} invoice approval${evidence.total === 1 ? '' : 's'} on record, ${evidence.approved} approved unchanged (${evidence.approvedPct}%)${evidence.approvedPct >= 80 ? ' — consider raising the limit' : ''}`
    : 'No invoice approvals on record yet — evidence accrues as the DE routes invoices through the human gate.';

  if (!selectedDe) {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Digital Employees</h1>
          <p className="text-slate-400 text-sm mt-1">
            {liveTenantName || 'Your company'} · Click an employee to see their profile — trust dial, charter, performance, and more
          </p>
        </div>
        <div className="max-w-3xl">
          <RosterPanel onSelect={setSelectedDe} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <div className="mb-6">
        <button onClick={() => setSelectedDe(null)} className="text-xs text-slate-400 hover:text-slate-200 mb-3 transition-colors">
          ← All Digital Employees
        </button>
        <h1 className="text-2xl font-bold text-white">{selectedDe.persona_name || selectedDe.name}</h1>
        <p className="text-slate-400 text-sm mt-1">
          {liveTenantName || 'Your company'} · {selectedDe.department || selectedDe.category}
        </p>
      </div>

      {error && <div className="mb-4 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{error}</div>}

      {loading ? (
        <LiveLoadingSkeleton rows={4} />
      ) : missingTables ? (
        <MissingTablesNotice />
      ) : (
        <div className="max-w-3xl space-y-6">
          {/* DE card — real identity, not a hardcoded persona */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-semibold text-xl">
                {(selectedDe.persona_name || selectedDe.name).charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 flex-wrap">
                  <h2 className="text-base font-semibold text-white">{selectedDe.persona_name || selectedDe.name}</h2>
                  {selectedDe.persona_name && <span className="text-xs text-slate-400">{selectedDe.name}</span>}
                  <span className={`text-xs px-2 py-0.5 rounded-full ${selectedDe.status === 'active' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}>{selectedDe.status}</span>
                  <DeHealthInline deId={selectedDe.id} />
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  {selectedDe.description || 'No description set yet.'}
                </p>
              </div>
            </div>
          </div>

          {/* DE operating charter */}
          <OperatingCharterPanel deId={selectedDe.id} setPage={setPage} />

          {/* Performance, knowledge scope, incidents, development — real per-DE data */}
          <DePerformancePanel deId={selectedDe.id} />
          <DeKnowledgeScopePanel deId={selectedDe.id} />

          {/* The DE-centered hub (2026-07-11 restructure): what this
              employee can touch (Control Fabric grants) and who it
              consults (primary/secondary specialists, migration 122) */}
          <DeSystemAccessPanel deId={selectedDe.id} setPage={setPage} />
          <DeSpecialistsPanel deId={selectedDe.id} />
          <DeIncidentsPanel de={selectedDe} setPage={setPage} />
          <DeDevelopmentPanel de={selectedDe} />

          {/* Governance — config editing/versioning, ownership/transfer, retirement */}
          <DeGovernancePanel de={selectedDe} onUpdated={setSelectedDe} />

          {/* Trust dial */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6">
            <div className="mb-1 flex items-center gap-2 flex-wrap">
              <h3 className="text-base font-semibold text-white">Trust dial</h3>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300">per-action autonomy</span>
            </div>
            <p className="text-[11px] text-slate-500 mb-2">
              Personal to {selectedDe.persona_name || selectedDe.name} — set a value here and it applies to this employee only.
              Leave a card at its workspace default and this employee follows the shared setting instead.
            </p>
            <p className="text-xs text-slate-500 mb-1">
              Autonomy narrows <em>within</em> guardrails — it never overrides them. An invoice auto-sends only when it passes
              both the {thresholdCents !== null ? fmtMoneyK(thresholdCents) : 'guardrail'} approval threshold <em>and</em> the trust-dial limit.
            </p>
            <p className="text-xs text-slate-400 mb-5">
              Evidence: <span className="text-slate-300">{evidenceLine}</span>
            </p>

            <div className="space-y-4">
              {ACTION_ORDER.map(type => {
                const meta = AUTONOMY_ACTION_META[type];
                const d = drafts[type] ?? { enabled: false, amount: '', confidence: '' };
                return (
                  <div key={type} className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm text-slate-200 font-medium">{meta.label}</span>
                          {isPersonal[type] ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300" title="This value is set for this employee specifically.">
                              Personal
                            </span>
                          ) : (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-500" title="No personal override — this employee follows the workspace-wide default.">
                              Workspace default
                            </span>
                          )}
                          {rows[type] && exceedsEarned(type, rows[type].enabled, rows[type].max_amount_cents, rows[type].min_confidence) && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300" title="This dial is set above the level the DE has earned from evidence. Still capped by guardrails.">
                              Manual override
                            </span>
                          )}
                          {meta.dormant && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-500" title="Stored now; enforced when the DE brain is activated (R1)">
                              dormant until activation
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-slate-500 mt-1">{meta.description}</p>
                      </div>
                      <label className="flex items-center gap-2 cursor-pointer flex-shrink-0">
                        <input
                          type="checkbox"
                          checked={d.enabled}
                          onChange={e => setDrafts(prev => ({ ...prev, [type]: { ...d, enabled: e.target.checked } }))}
                          className="accent-indigo-500"
                        />
                        <span className="text-xs text-slate-400">{d.enabled ? 'Enabled' : 'Off'}</span>
                      </label>
                    </div>
                    <div className="mt-3 flex items-center gap-3 flex-wrap">
                      {meta.unit === 'amount' ? (
                        <label className="flex items-center gap-2 text-xs text-slate-400">
                          Max amount $
                          <input
                            type="number" min={0} value={d.amount} placeholder="e.g. 5000"
                            onChange={e => setDrafts(prev => ({ ...prev, [type]: { ...d, amount: e.target.value } }))}
                            className="w-28 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-slate-200 text-xs focus:border-indigo-500 focus:outline-none"
                          />
                        </label>
                      ) : (
                        <label className="flex items-center gap-2 text-xs text-slate-400">
                          Min confidence %
                          <input
                            type="number" min={0} max={100} value={d.confidence} placeholder="e.g. 75"
                            onChange={e => setDrafts(prev => ({ ...prev, [type]: { ...d, confidence: e.target.value } }))}
                            className="w-20 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-slate-200 text-xs focus:border-indigo-500 focus:outline-none"
                          />
                        </label>
                      )}
                      <button
                        onClick={() => void save(type)}
                        disabled={savingKey !== null}
                        className="text-xs px-3 py-1.5 rounded-lg border text-indigo-300 border-indigo-800/50 hover:border-indigo-500 disabled:opacity-50 transition-all"
                      >
                        {savingKey === type ? 'Saving…' : savedKey === type ? 'Saved ✓' : 'Save'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <p className="mt-4 text-[11px] text-slate-500">
              Every change is recorded as a config_change event on the immutable audit trail.{' '}
              <button onClick={() => setPage('gov_audit')} className="text-indigo-400 hover:text-indigo-300 transition-colors">
                View Audit Trail →
              </button>
            </p>
          </div>

          {/* Earned Trust */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6">
            <div className="mb-1 flex items-center gap-2 flex-wrap">
              <h3 className="text-base font-semibold text-white">Earned trust</h3>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300">promote slow · demote fast</span>
            </div>
            <p className="text-[11px] text-amber-400/80 mb-2">
              The earned-progression ladder is still workspace-wide today, not yet per employee — the personal dial above can be set below or above it, but the ladder itself tracks evidence for the whole workspace.
            </p>
            <p className="text-xs text-slate-500 mb-5">
              Your workspace earns wider autonomy from measured evidence — evaluation results, human review outcomes, and a clean guardrail record.
              A teammate approves each step up; any regression drops the level automatically. Guardrails always cap what's possible.
            </p>

            {trustError && <div className="mb-4 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{trustError}</div>}

            <div className="space-y-4">
              {ACTION_ORDER.map(type => {
                const policy = policies[type];
                const ev = trustEvidence[type];
                if (!policy) return null;
                const meta = AUTONOMY_ACTION_META[type];
                return (
                  <div key={type} className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm text-slate-200 font-medium">{meta.label}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300">
                            {TRUST_LEVEL_LABELS[policy.current_level] ?? `Level ${policy.current_level}`}
                          </span>
                          {ev?.eligible && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">Eligible for promotion</span>
                          )}
                          {policy.pending_task_id && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">Awaiting approval</span>
                          )}
                        </div>
                      </div>
                      {ev && !ev.at_max_level && (
                        <button
                          onClick={() => void requestPromotion(policy)}
                          disabled={!ev.eligible || requestingId !== null || policy.pending_task_id !== null}
                          className="text-xs px-3 py-1.5 rounded-lg border text-emerald-300 border-emerald-800/50 hover:border-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex-shrink-0"
                          title={ev.eligible ? 'Sends a promotion request to Human Tasks — a teammate approves it' : 'Evidence has not yet met every criterion'}
                        >
                          {requestingId === policy.id ? 'Requesting…' : requestedId === policy.id ? 'Requested ✓' : `Request promotion to ${TRUST_LEVEL_LABELS[policy.target_level]}`}
                        </button>
                      )}
                    </div>

                    {ev ? (
                      <div className="mt-3 space-y-2">
                        {ev.criteria.map(c => {
                          const pct = c.required > 0 ? Math.min(100, Math.round((Number(c.actual) / Number(c.required)) * 100)) : 100;
                          const inverse = c.key === 'guardrail_blocks';
                          return (
                            <div key={c.key} className="flex items-center gap-3">
                              <div className="w-44 flex-shrink-0 text-[11px] text-slate-400">{c.label}</div>
                              <div className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${c.met ? 'bg-emerald-500' : 'bg-slate-600'}`}
                                  style={{ width: `${inverse ? (c.met ? 100 : 100) : pct}%`, opacity: inverse && !c.met ? 0.3 : 1 }}
                                />
                              </div>
                              <div className={`w-56 flex-shrink-0 text-[11px] ${c.met ? 'text-emerald-400' : 'text-slate-500'}`} title={c.detail}>
                                {c.met ? '✓ ' : ''}{c.detail}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="mt-3 text-[11px] text-slate-500">Evidence not available yet.</p>
                    )}
                  </div>
                );
              })}
            </div>

            {trustHistory.length > 0 && (
              <div className="mt-5">
                <h4 className="text-xs font-semibold text-slate-300 mb-2">Promotion history</h4>
                <ul className="space-y-1.5">
                  {trustHistory.map(h => (
                    <li key={h.id} className="text-[11px] text-slate-500 flex items-start gap-2">
                      <span className={`mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                        h.kind === 'trust_promoted' ? 'bg-emerald-500' :
                        h.kind === 'trust_demoted' ? 'bg-rose-500' :
                        h.kind === 'trust_manual_override' ? 'bg-amber-500' : 'bg-slate-600'
                      }`} />
                      <span className="flex-1">{h.action}</span>
                      <span className="flex-shrink-0 text-slate-600">{new Date(h.created_at).toLocaleDateString()}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p className="mt-4 text-[11px] text-slate-500">
              Evidence is computed on the server from the Proving Ground, human reviews, and the guardrail record — never asserted by the browser.
              Promotions and demotions are recorded on the immutable audit trail.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
