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
import HireEmployeeWizard from '../../components/HireEmployeeWizard';
import AISessionPanel from '../../components/AISessionPanel';
import {
  listKpiMetrics, createKpiMetric, recordKpiReading, slugifyKey,
  listSkillCategories, createTenantSkill, listCertificationTypes,
  getCustomEscalationRules, saveCustomEscalationRules,
} from '../../lib/roleConfigApi';
import type { KpiMetric, SkillCategory, CertificationType, EscalationRule } from '../../lib/roleConfigApi';
import DeWorkbenchPanel from './DeWorkbench';
import {
  listDigitalEmployees, createDigitalEmployee, updateDigitalEmployee, getDEConfigHistory,
  transferDeOwnership, checkDeRetirementReadiness, retireDigitalEmployee,
  listDeConsultationGrants, createDeConsultationGrant, setDeConsultationGrantActive,
  listDeProfileFields, addDeProfileField, setDeAttributes, setExternalReplyMode,
} from '../../lib/digitalEmployeesApi';
import type {
  DigitalEmployee, DEConfigHistoryEntry, RetirementReadiness, DEConsultationGrant,
  DeProfileField,
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
    <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6">
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
              <div key={a.id} className={`flex items-center gap-3 text-xs rounded-lg px-3 py-2 ${a.active ? 'bg-slate-900/60' : 'bg-slate-900/30 opacity-60'}`}>
                <span className="w-6 h-6 rounded-lg bg-slate-700 text-slate-400 flex items-center justify-center text-[11px] font-bold flex-shrink-0">{a.priority}</span>
                <button onClick={() => setPage('systems_playbooks')} className="text-slate-200 hover:text-indigo-300 transition-colors truncate flex-1 text-left">
                  {def?.name ?? 'Unknown playbook'}
                </button>
                {!a.active && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-500 flex-shrink-0">paused</span>}
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
            className="bg-slate-900 border border-slate-600 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-slate-500 !w-64">
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
          className="text-xs px-3 py-1.5 rounded-lg border border-slate-600 text-slate-300 hover:text-white hover:border-slate-500 disabled:opacity-40 transition-colors">
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
  const [hiring, setHiring] = useState(false);
  // Which employee the plain-language editor is open for, if any.
  const [editingDe, setEditingDe] = useState<{ id: string; label: string } | null>(null);
  // Retired/archived employees are kept but hidden until asked for.
  const [showRetired, setShowRetired] = useState(false);
  const [retiredCount, setRetiredCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [personaName, setPersonaName] = useState('');
  const [department, setDepartment] = useState('');
  const [description, setDescription] = useState('');

  const refresh = useCallback(async () => {
    try {
      // Fetch both so the "retired" count is honest without a second trip.
      const all = await listDigitalEmployees(true);
      const active = all.filter(d => !['retired', 'archived'].includes(String(d.lifecycle_status)));
      setRetiredCount(all.length - active.length);
      setDes(showRetired ? all : active);
      setError(null);
    } catch (err) {
      setError((err as Error)?.message || 'Failed to load the roster.');
    }
    try {
      const h = await listDeHealth();
      setHealth(Object.fromEntries(h.map(x => [x.de_id, x])));
    } catch { /* health is supplementary — a roster still renders without it */ }
  }, [showRetired]);

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
    <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6">
      <div className="mb-1 flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-base font-semibold text-white">Your Digital Employees</h3>
        {!adding && (
          <div className="flex items-center gap-2">
            {/* Retiring an employee used to leave it in this list forever,
                so the action looked like it had done nothing. */}
            {retiredCount > 0 && (
              <button onClick={() => setShowRetired(v => !v)}
                className="text-[11px] px-2 py-1 rounded-md border border-slate-700 text-slate-500 hover:text-slate-300 hover:border-slate-600 transition-colors">
                {showRetired ? 'Hide retired' : `Show retired (${retiredCount})`}
              </button>
            )}
            <button onClick={() => setHiring(true)}
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors">
              ✨ Hire with AI
            </button>
            <button onClick={() => setAdding(true)}
              className="text-xs px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 font-medium transition-colors">
              + Add manually
            </button>
          </div>
        )}
      </div>
      {hiring && (
        <HireEmployeeWizard
          onClose={() => setHiring(false)}
          onFinished={() => { void refresh(); }}
        />
      )}
      {editingDe && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setEditingDe(null)}>
          <div className="w-full max-w-2xl h-[600px] max-h-[85vh]" onClick={(e) => e.stopPropagation()}>
            <AISessionPanel
              subjectKind="de"
              subjectId={editingDe.id}
              subjectLabel={editingDe.label}
              onChanged={() => { void refresh(); }}
              onClose={() => setEditingDe(null)}
            />
          </div>
        </div>
      )}
      <p className="text-xs text-slate-500 mb-4">
        Every Digital Employee working for {des.length > 0 ? 'your company' : 'you'} today. Each one is configured independently below —
        data access, playbooks, and trust build up the same way for every department.
      </p>

      {error && <div className="mb-3 rounded-xl border border-rose-800/50 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</div>}

      <div className="space-y-2 mb-3">
        {des.map(de => (
          // Row is a div, not a button: "Edit with AI" is a second action and
          // a button cannot legally nest inside another button.
          <div key={de.id}
            className="w-full flex items-center gap-3 text-xs rounded-lg px-3 py-2.5 bg-slate-900/60 hover:bg-slate-800 hover:ring-1 hover:ring-indigo-500/40 transition-all">
            <button onClick={() => onSelect(de)} className="flex items-center gap-3 min-w-0 flex-1 text-left">
              <div className="w-8 h-8 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-semibold flex-shrink-0">
                {(de.persona_name || de.name).charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-slate-200 font-medium">{de.persona_name || de.name}</span>
                  {de.persona_name && <span className="text-slate-500">— {de.name}</span>}
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${de.status === 'active' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-700 text-slate-500'}`}>{de.status}</span>
                  {health[de.id] && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${DE_HEALTH_LABELS[health[de.id].state]?.color}`}>
                      {DE_HEALTH_LABELS[health[de.id].state]?.label ?? health[de.id].state}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-slate-500 mt-0.5 truncate">{de.department || de.category} · {de.description || 'No description yet.'}</p>
              </div>
            </button>
            <button onClick={() => setEditingDe({ id: de.id, label: de.persona_name || de.name })}
              title="Describe what to change, in plain language"
              className="flex-shrink-0 text-[11px] px-2 py-1 rounded-md bg-slate-800 hover:bg-indigo-600/30 border border-slate-700 hover:border-indigo-500/50 text-slate-400 hover:text-indigo-200 transition-colors">
              ✨ Edit with AI
            </button>
            <button onClick={() => onSelect(de)} aria-label={`Open ${de.name}`}
              className="text-slate-600 hover:text-slate-300 flex-shrink-0">→</button>
          </div>
        ))}
        {des.length === 0 && <p className="text-xs text-slate-500">No Digital Employees yet — add your first one below.</p>}
      </div>

      {adding && (
        <div className="rounded-xl border border-slate-600 bg-slate-900/60 p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-slate-400">
              Role / label (required)
              <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Account Success DE"
                className="mt-1 w-full bg-slate-800 border border-slate-600 rounded-lg px-2.5 py-1.5 text-slate-200 text-xs focus:border-indigo-500 focus:outline-none" />
            </label>
            <label className="text-xs text-slate-400">
              Persona name (optional)
              <input value={personaName} onChange={e => setPersonaName(e.target.value)} placeholder="e.g. Jordan"
                className="mt-1 w-full bg-slate-800 border border-slate-600 rounded-lg px-2.5 py-1.5 text-slate-200 text-xs focus:border-indigo-500 focus:outline-none" />
            </label>
          </div>
          <label className="text-xs text-slate-400 block">
            Department
            <input value={department} onChange={e => setDepartment(e.target.value)} placeholder="e.g. Account Success"
              className="mt-1 w-full bg-slate-800 border border-slate-600 rounded-lg px-2.5 py-1.5 text-slate-200 text-xs focus:border-indigo-500 focus:outline-none" />
          </label>
          <label className="text-xs text-slate-400 block">
            What does this Digital Employee do?
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} placeholder="Plain language — what this DE is responsible for"
              className="mt-1 w-full bg-slate-800 border border-slate-600 rounded-lg px-2.5 py-1.5 text-slate-200 text-xs focus:border-indigo-500 focus:outline-none" />
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
    <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6">
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
            <div key={t.label} className="rounded-xl border border-slate-700 bg-slate-900/60 p-3">
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
    <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6">
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
    : 'bg-slate-700 text-slate-500';

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6">
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
            <div key={inc.id} className="rounded-lg bg-slate-900/60">
              <button onClick={() => { setOpenId(k => k === inc.id ? null : inc.id); setNote(''); }}
                className="w-full flex items-center gap-3 text-left px-3 py-2 text-xs">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${sevDot(inc.severity)}`} />
                <span className="flex-1 text-slate-300 truncate">{inc.title}</span>
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-500 flex-shrink-0">{INCIDENT_KIND_LABELS[inc.kind] ?? inc.kind}</span>
                {inc.de_id === null && <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-500 flex-shrink-0">workspace-wide</span>}
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
                        className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-[11px] rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-indigo-500"
                      />
                      <div className="flex gap-2">
                        {inc.status === 'open' && (
                          <button onClick={() => void review(inc.id, 'reviewed')} disabled={busy}
                            className="px-2.5 py-1 rounded-lg bg-indigo-600/30 border border-indigo-500/40 text-indigo-300 hover:bg-indigo-600/50 disabled:opacity-50">
                            Mark reviewed
                          </button>
                        )}
                        <button onClick={() => void review(inc.id, 'closed')} disabled={busy}
                          className="px-2.5 py-1 rounded-lg bg-slate-700 border border-slate-600 text-slate-300 hover:bg-slate-600 disabled:opacity-50">
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
// ── Skills panel — evidence-assessed proficiency (DE-C1, migration
// 127). Five platform skills, each from a real 30-day signal. Never
// self-reported; "not yet assessed" is an honest state, not a gap.
// Auto-assessment caps at level 4 — level 5 is human-awarded.
type SkillRow = {
  skill_key: string; name: string; category: string; description: string | null;
  signal_label: string | null; sort_order: number; is_custom: boolean;
  proficiency: number | null; sample_size: number; signal_value: number | null; detail: string;
};
const SKILL_CATEGORY_LABEL: Record<string, string> = {
  domain: 'Domain', process: 'Process', communication: 'Communication',
  analytical: 'Analytical', integration: 'Integration',
};
const PROFICIENCY_NAME = ['', 'Foundational', 'Developing', 'Proficient', 'Advanced', 'Expert'];
function DeSkillsPanel({ de }: { de: DigitalEmployee }) {
  const [skills, setSkills] = useState<SkillRow[] | null>(null);
  const [assessing, setAssessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Categories come from the catalog so a workspace can define its own.
  const [categories, setCategories] = useState<SkillCategory[]>([]);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCat, setNewCat] = useState('domain');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    // list_de_skills (mig 206) returns every skill in scope — built-ins with
    // their assessment, plus workspace skills whether or not anyone has rated
    // them. Reading de_skills directly meant a newly-defined skill had no row
    // yet and so was invisible.
    const { data, error: err } = await supabase.rpc('list_de_skills', { p_de_id: de.id });
    if (err) { setError(err.message); return; }
    setSkills((data ?? []) as SkillRow[]);
  }, [de.id]);

  const loadCategories = useCallback(async () => {
    try {
      const list = await listSkillCategories();
      setCategories(list);
      setNewCat(prev => list.some(c => c.key === prev) ? prev : (list[0]?.key ?? 'domain'));
    } catch { /* labels fall back to SKILL_CATEGORY_LABEL */ }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadCategories(); }, [loadCategories]);

  const catLabel = (key: string) =>
    categories.find(c => c.key === key)?.label ?? SKILL_CATEGORY_LABEL[key] ?? key;

  const addSkill = async () => {
    const name = newName.trim();
    if (!name) return;
    setSaving(true); setError(null);
    try {
      await createTenantSkill({ skillKey: slugifyKey(name), name, category: newCat });
      setAdding(false); setNewName('');
      await load();
    } catch (e) { setError((e as Error).message); }
    setSaving(false);
  };

  const rateSkill = async (skillKey: string, level: number | null) => {
    setSaving(true); setError(null);
    const { error: err } = await supabase.rpc('set_de_skill_proficiency', {
      p_de_id: de.id, p_skill_key: skillKey, p_proficiency: level, p_note: null,
    });
    if (err) setError(err.message);
    await load();
    setSaving(false);
  };

  const assess = async () => {
    setAssessing(true); setError(null);
    const { error: err } = await supabase.rpc('assess_de_skills');
    if (err) setError(err.message);
    await load();
    setAssessing(false);
  };

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Skills</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-500/15 text-teal-300">evidence-assessed</span>
        <button onClick={() => void assess()} disabled={assessing}
          className="ml-auto text-xs px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-50">
          {assessing ? 'Assessing…' : 'Assess now'}
        </button>
      </div>
      <p className="text-[11px] text-slate-500 mb-3">
        Proficiency is measured from real 30-day evidence, never self-reported. Level 5 (Expert) is
        awarded by a person, not the assessment — so it tops out at Advanced automatically.
      </p>
      {error && <p className="text-xs text-rose-300 mb-2">{error}</p>}
      {skills === null ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : skills.length === 0 ? (
        <p className="text-xs text-slate-500">No assessment yet — run one with “Assess now”.</p>
      ) : (
        <div className="space-y-3">
          {skills.map(s => {
            const cat = s.category ?? '';
            const assessed = s.proficiency != null;
            return (
              <div key={s.skill_key} className="rounded-xl border border-slate-700 bg-slate-900 p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-white font-medium">{s.name ?? s.skill_key}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-400">{catLabel(cat)}</span>
                  {/* Says plainly where the number came from. */}
                  {s.is_custom && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300">rated by a person</span>
                  )}
                  {assessed ? (
                    <span className={`ml-auto text-xs font-semibold ${
                      s.proficiency! >= 4 ? 'text-emerald-300' : s.proficiency! >= 3 ? 'text-teal-300' : 'text-amber-300'}`}>
                      L{s.proficiency} · {PROFICIENCY_NAME[s.proficiency!]}
                    </span>
                  ) : (
                    <span className="ml-auto text-xs text-slate-600">Not yet assessed</span>
                  )}
                </div>
                {/* proficiency dots 1..5 */}
                {assessed && (
                  <div className="flex gap-1 mt-2">
                    {[1, 2, 3, 4, 5].map(l => (
                      <span key={l} className={`h-1.5 flex-1 rounded-full ${
                        l <= s.proficiency! ? (s.proficiency! >= 4 ? 'bg-emerald-400' : s.proficiency! >= 3 ? 'bg-teal-400' : 'bg-amber-400')
                        : l === 5 ? 'bg-slate-700 border border-dashed border-slate-600' : 'bg-slate-700'}`} />
                    ))}
                  </div>
                )}
                <p className="text-[11px] text-slate-500 mt-1.5">{s.detail}</p>
                {/* Built-in proficiency stays evidence-only and is never
                    settable by hand; only workspace skills get this. */}
                {s.is_custom && (
                  <div className="flex items-center gap-1.5 mt-2">
                    <span className="text-[10px] text-slate-600 mr-1">Rate:</span>
                    {[1, 2, 3, 4, 5].map(l => (
                      <button key={l} disabled={saving}
                        onClick={() => void rateSkill(s.skill_key, l)}
                        className={`text-[10px] w-6 h-6 rounded border transition-colors ${
                          s.proficiency === l
                            ? 'bg-sky-500/20 border-sky-500/50 text-sky-200'
                            : 'border-slate-700 text-slate-500 hover:border-slate-500 hover:text-slate-300'}`}>
                        {l}
                      </button>
                    ))}
                    {s.proficiency != null && (
                      <button onClick={() => void rateSkill(s.skill_key, null)} disabled={saving}
                        className="text-[10px] text-slate-600 hover:text-rose-300 ml-1">Clear</button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!adding ? (
        <button onClick={() => setAdding(true)} className="mt-3 text-[11px] text-indigo-400 hover:text-indigo-300">
          + Add a skill your business cares about
        </button>
      ) : (
        <div className="mt-3 rounded-xl border border-slate-600 bg-slate-900/60 p-3 space-y-2">
          <p className="text-[11px] text-slate-400">
            Add a skill specific to your work. The platform has no way to measure it automatically,
            so you rate it yourself — it will be labelled &ldquo;rated by a person&rdquo; wherever it appears,
            to keep it distinct from the evidence-assessed ones above.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Telecom provisioning"
              className="flex-1 min-w-[180px] bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500" />
            <select value={newCat} onChange={e => setNewCat(e.target.value)}
              className="bg-slate-800 border border-slate-600 text-slate-300 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500">
              {(categories.length ? categories : Object.keys(SKILL_CATEGORY_LABEL).map(k => ({ key: k, label: SKILL_CATEGORY_LABEL[k], sort_order: 0, is_custom: false })))
                .map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </div>
          <div className="flex gap-2">
            <button onClick={() => void addSkill()} disabled={saving || !newName.trim()}
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40">
              {saving ? 'Adding…' : 'Add skill'}
            </button>
            <button onClick={() => { setAdding(false); setNewName(''); }}
              className="text-xs text-slate-500 hover:text-slate-300">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Certifications & Reviews panel (DE-C3, migration 129). Durable,
// expiring certifications issued by a named human; quarterly
// performance reviews with honest verdicts (insufficient data is a
// verdict, not a gap to hide). A 'below' review opens a PIP in the
// Development panel below, with a written consequence.
type CertRow = {
  id: string; cert_type: string; scope: string; note: string;
  issued_by_name: string; issued_at: string; expires_at: string; status: string;
};
type ReviewRow = {
  id: string; period_start: string; verdict: string; summary: string; status: string; created_at: string;
};
function DeCertificationsPanel({ de }: { de: DigitalEmployee }) {
  const [certs, setCerts] = useState<CertRow[] | null>(null);
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [showCertify, setShowCertify] = useState(false);
  const [certType, setCertType] = useState('workspace');
  const [certTypes, setCertTypes] = useState<CertificationType[]>([
    // Built-in fallback so the selector is never empty mid-fetch.
    { key: 'workspace', label: 'Workspace', description: null, sort_order: 10, is_custom: false },
    { key: 'compliance', label: 'Compliance', description: null, sort_order: 20, is_custom: false },
    { key: 'capability', label: 'Capability', description: null, sort_order: 30, is_custom: false },
  ]);
  const [scope, setScope] = useState('');
  const [note, setNote] = useState('');
  const [validDays, setValidDays] = useState('180');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data: c, error: cErr }, { data: r }] = await Promise.all([
      supabase.from('de_certifications')
        .select('id, cert_type, scope, note, issued_by_name, issued_at, expires_at, status')
        .eq('de_id', de.id).order('issued_at', { ascending: false }).limit(10),
      supabase.from('de_performance_reviews')
        .select('id, period_start, verdict, summary, status, created_at')
        .eq('de_id', de.id).order('created_at', { ascending: false }).limit(3),
    ]);
    if (cErr) { setError(cErr.message); return; }
    setCerts((c ?? []) as CertRow[]);
    setReviews((r ?? []) as ReviewRow[]);
  }, [de.id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    // Replace the built-in fallback with this workspace's real list.
    void listCertificationTypes().then(t => { if (t.length) setCertTypes(t); }).catch(() => { /* keep fallback */ });
  }, []);

  const run = async (fn: () => PromiseLike<{ error: { message: string } | null }>) => {
    setBusy(true); setError(null);
    const { error: err } = await fn();
    if (err) setError(err.message);
    await load();
    setBusy(false);
  };

  const certify = () => run(async () => {
    const res = await supabase.rpc('certify_digital_employee', {
      p_de_id: de.id, p_cert_type: certType, p_scope: scope.trim(), p_note: note.trim(),
      p_valid_days: Math.max(1, Math.min(730, Math.round(Number(validDays) || 180))),
    });
    if (!res.error) { setScope(''); setNote(''); setShowCertify(false); }
    return res;
  });

  const daysLeft = (expiresAt: string) => Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86400000);

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Certifications & Reviews</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-500/15 text-teal-300">expiring attestations</span>
        <button onClick={() => setShowCertify(s => !s)}
          className="ml-auto text-xs px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200">
          {showCertify ? 'Cancel' : 'Certify…'}
        </button>
      </div>
      <p className="text-[11px] text-slate-500 mb-3">
        A certification is a named person attesting this employee is fit for purpose — it expires and
        must be renewed. Quarterly reviews record an honest verdict from real metrics; a below-threshold
        verdict opens an improvement plan with a written consequence.
      </p>
      {error && <p className="text-xs text-rose-300 mb-2">{error}</p>}

      {showCertify && (
        <div className="mb-4 rounded-xl border border-slate-700 bg-slate-900 p-3 space-y-2">
          <div className="flex gap-2">
            {/* Types come from certification_types (mig 205) so a workspace
                can add its own — e.g. an industry accreditation. */}
            <select value={certType} onChange={e => setCertType(e.target.value)} disabled={busy}
              title={certTypes.find(t => t.key === certType)?.description ?? undefined}
              className="bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-2 py-2 focus:outline-none focus:border-indigo-500">
              {certTypes.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
            <input type="text" value={scope} onChange={e => setScope(e.target.value)} placeholder="Scope — e.g. helpdesk replies"
              className="flex-1 bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500" />
            <input type="number" min={1} max={730} value={validDays} onChange={e => setValidDays(e.target.value)}
              title="Validity (days)"
              className="w-20 bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-2 py-2 focus:outline-none focus:border-indigo-500" />
          </div>
          <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="What did you review? (required)"
            className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500" />
          <button onClick={() => void certify()} disabled={busy || !note.trim()}
            className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40">
            Issue certification
          </button>
        </div>
      )}

      {certs === null ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : certs.length === 0 ? (
        <p className="text-xs text-slate-500 mb-3">No certifications yet — advancing the lifecycle to Certified issues one automatically.</p>
      ) : (
        <div className="space-y-1.5 mb-4">
          {certs.map(c => {
            const left = daysLeft(c.expires_at);
            return (
              <div key={c.id} className="flex items-center gap-2 text-xs flex-wrap">
                <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                  c.status === 'active' ? (left <= 14 ? 'bg-amber-500/15 text-amber-300' : 'bg-emerald-500/15 text-emerald-300')
                  : c.status === 'expired' ? 'bg-rose-500/15 text-rose-300' : 'bg-slate-700 text-slate-500'}`}>
                  {c.status === 'active' ? (left <= 14 ? `expires in ${left}d` : 'active') : c.status}
                </span>
                <span className="text-slate-300">{certTypes.find(t => t.key === c.cert_type)?.label ?? c.cert_type}</span>
                {c.scope && <span className="text-slate-500">· {c.scope}</span>}
                <span className="text-slate-600">by {c.issued_by_name} · until {new Date(c.expires_at).toLocaleDateString()}</span>
                {c.status === 'active' && (
                  <button onClick={() => { const reason = window.prompt('Revocation reason (required):'); if (reason?.trim()) void run(() => supabase.rpc('revoke_de_certification', { p_cert_id: c.id, p_reason: reason.trim() })); }}
                    disabled={busy}
                    className="ml-auto text-[10px] text-slate-600 hover:text-rose-300">
                    Revoke
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-2 mb-1.5">
        <p className="text-[11px] uppercase tracking-wide text-slate-500">Performance reviews</p>
        <button onClick={() => void run(() => supabase.rpc('run_de_performance_review'))} disabled={busy}
          className="ml-auto text-[10px] text-indigo-400 hover:text-indigo-300 disabled:opacity-50">
          {busy ? 'Working…' : 'Run review now'}
        </button>
      </div>
      {reviews.length === 0 ? (
        <p className="text-xs text-slate-500">No reviews yet — they run quarterly, or on demand.</p>
      ) : (
        <div className="space-y-2">
          {reviews.map(r => (
            <div key={r.id} className="rounded-xl border border-slate-700 bg-slate-900 p-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                  r.verdict === 'meets' ? 'bg-emerald-500/15 text-emerald-300'
                  : r.verdict === 'below' ? 'bg-amber-500/15 text-amber-300'
                  : 'bg-slate-700 text-slate-400'}`}>
                  {r.verdict === 'insufficient_data' ? 'insufficient data' : r.verdict}
                </span>
                <span className="text-[11px] text-slate-500">quarter starting {r.period_start}</span>
                {r.status === 'open' ? (
                  <button onClick={() => void run(() => supabase.rpc('acknowledge_de_performance_review', { p_review_id: r.id }))}
                    disabled={busy}
                    className="ml-auto text-[10px] text-indigo-400 hover:text-indigo-300">
                    Acknowledge
                  </button>
                ) : (
                  <span className="ml-auto text-[10px] text-slate-600">acknowledged</span>
                )}
              </div>
              <p className="text-[11px] text-slate-400 mt-1.5">{r.summary}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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
    <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Development</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300">evidence-grounded</span>
      </div>
      <p className="text-xs text-slate-500 mb-4">
        Proposed from real 8-week performance data (escalation rate, confidence, error rate, guardrail patterns) — or added manually. While one is open, this employee shows as "Improving."
      </p>
      {err && <div className="mb-3 rounded-lg border border-rose-800/50 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{err}</div>}

      <div className="flex gap-2 mb-3">
        <button onClick={scan} disabled={scanning} className="text-xs px-3 py-1.5 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-700 transition-colors disabled:opacity-50">
          {scanning ? 'Scanning…' : 'Scan for development needs'}
        </button>
        <button onClick={() => setShowAdd(s => !s)} className="text-xs px-3 py-1.5 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-700 transition-colors">
          + Add manually
        </button>
      </div>

      {showAdd && (
        <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-3 space-y-2 mb-3">
          <textarea value={desc} onChange={e => setDesc(e.target.value)} rows={2} placeholder="What does this employee need to work on?"
            className="w-full rounded-lg bg-slate-800 border border-slate-700 px-2 py-1.5 text-xs text-white" />
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowAdd(false)} disabled={busy} className="text-[11px] px-2 py-1 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-700">Cancel</button>
            <button onClick={addManual} disabled={busy} className="text-[11px] px-2 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white">{busy ? 'Adding…' : 'Add item'}</button>
          </div>
        </div>
      )}

      {open.length === 0 ? (
        <p className="text-xs text-slate-500">No open development items — nothing evidence-based flagged, and none added manually.</p>
      ) : (
        <div className="space-y-1.5 mb-3">
          {open.map(item => (
            <div key={item.id} className="rounded-lg bg-slate-900/60 px-3 py-2 text-xs">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-400 mr-1.5">{item.source === 'detected' ? 'detected' : 'manual'}</span>
                  <span className="text-slate-300">{item.description}</span>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                  {item.status === 'proposed' && (
                    <button onClick={() => setStatus(item.id, 'in_progress')} disabled={busy} className="text-[10px] px-2 py-0.5 rounded bg-sky-500/15 text-sky-300 hover:bg-sky-500/25">Start</button>
                  )}
                  <button onClick={() => setStatus(item.id, 'completed')} disabled={busy} className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25">Complete</button>
                  <button onClick={() => setStatus(item.id, 'dismissed')} disabled={busy} className="text-[10px] px-2 py-0.5 rounded bg-slate-700 text-slate-500 hover:bg-slate-600">Dismiss</button>
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
          <input value={name} onChange={e => setName(e.target.value)} className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white" />
        </label>
        <label className="block text-xs text-slate-400">Persona name (optional)
          <input value={personaName} onChange={e => setPersonaName(e.target.value)} className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white" />
        </label>
        <label className="block text-xs text-slate-400">Description
          <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white" />
        </label>
        <label className="block text-xs text-slate-400">Department
          <input value={department} onChange={e => setDepartment(e.target.value)} className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white" />
        </label>
        <label className="block text-xs text-slate-400">Confidence threshold (0-100)
          <input type="number" min={0} max={100} value={confidenceThreshold} onChange={e => setConfidenceThreshold(e.target.value)} className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white" />
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input type="checkbox" checked={requiredApproval} onChange={e => setRequiredApproval(e.target.checked)} />
          Require human approval by default
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} disabled={busy} className="text-xs px-3 py-1.5 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-700 transition-colors disabled:opacity-50">Cancel</button>
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
            <select value={target} onChange={e => setTarget(e.target.value)} className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white">
              <option value="">Select a team member…</option>
              {candidates.map(m => <option key={m.userId} value={m.userId}>{m.fullName} ({m.role})</option>)}
            </select>
          </label>
        )}
        <label className="block text-xs text-slate-400">Note (optional)
          <input value={note} onChange={e => setNote(e.target.value)} className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white" placeholder="Why this transfer is happening" />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} disabled={busy} className="text-xs px-3 py-1.5 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-700 transition-colors disabled:opacity-50">Cancel</button>
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
          <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white" />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} disabled={busy} className="text-xs px-3 py-1.5 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-700 transition-colors disabled:opacity-50">Cancel</button>
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
    <div className="mt-5 pt-5 border-t border-slate-700">
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
            <div key={g.id} className="flex items-center justify-between rounded-lg bg-slate-900/60 px-3 py-1.5 text-xs">
              <span className="text-slate-300">{nameById[g.target_de_id] || 'Unknown'} <span className="text-slate-600">· {g.category}</span></span>
              <button onClick={() => toggle(g)} disabled={busy} className={`text-[10px] px-2 py-0.5 rounded ${g.active ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-700 text-slate-500'}`}>
                {g.active ? 'active' : 'inactive'}
              </button>
            </div>
          ))}
        </div>
      )}

      {showAdd ? (
        <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-3 space-y-2 mb-3">
          <select value={targetId} onChange={e => setTargetId(e.target.value)} className="w-full rounded-lg bg-slate-800 border border-slate-700 px-2 py-1.5 text-xs text-white">
            <option value="">Consult which employee…</option>
            {roster.map(d => <option key={d.id} value={d.id}>{d.persona_name || d.name}</option>)}
          </select>
          <select value={category} onChange={e => setCategory(e.target.value)} className="w-full rounded-lg bg-slate-800 border border-slate-700 px-2 py-1.5 text-xs text-white">
            <option value="">On which category…</option>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowAdd(false)} disabled={busy} className="text-[11px] px-2 py-1 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-700">Cancel</button>
            <button onClick={addGrant} disabled={busy} className="text-[11px] px-2 py-1 rounded-lg bg-teal-600 hover:bg-teal-500 text-white">{busy ? 'Adding…' : 'Add grant'}</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowAdd(true)} className="text-[11px] px-2.5 py-1 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-700 mb-3">
          + Grant a consultation
        </button>
      )}

      {asTarget !== null && asTarget.length > 0 && (
        <>
          <p className="text-xs text-slate-400 mb-1">Consulted by:</p>
          <div className="space-y-1">
            {asTarget.map(g => (
              <div key={g.id} className="rounded-lg bg-slate-900/60 px-3 py-1.5 text-xs text-slate-400">
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
    <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Governance</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300">config v{de.config_version}</span>
        {retired && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-400">retired — read-only</span>}
      </div>
      <p className="text-xs text-slate-500 mb-4">
        Who's accountable for this employee, every configuration change on record, and how retirement works.
      </p>

      <div className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-3 mb-3">
        <div>
          <p className="text-xs text-slate-500">Owner</p>
          <p className="text-sm text-slate-200">{ownerName}</p>
        </div>
        {!retired && (
          <button onClick={() => setModal('transfer')} className="text-xs px-3 py-1.5 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-700 transition-colors">
            Transfer
          </button>
        )}
      </div>

      <div className="flex gap-2 mb-3">
        {!retired && (
          <button onClick={() => setModal('edit')} className="text-xs px-3 py-1.5 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-700 transition-colors">
            Edit configuration
          </button>
        )}
        <button onClick={loadHistory} className="text-xs px-3 py-1.5 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-700 transition-colors">
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
              <div key={h.id} className="rounded-lg bg-slate-900/60 px-3 py-2 text-[11px]">
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
    <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6">
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
            <span key={g.id} className="text-xs px-2.5 py-1 rounded-lg bg-slate-900 border border-slate-700 text-slate-300">
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
    <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6">
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
              className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
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

// ── Identity & Purpose panel (DE-C4, migration 130). These fields
// are consumed for real: display_title + purpose_statement feed the
// system prompt of every answer this employee gives (dePersona), and
// responsibilities are a lifecycle identity criterion (126).
function DeIdentityPanel({ de, onUpdated }: { de: DigitalEmployee; onUpdated: (d: DigitalEmployee) => void }) {
  const [title, setTitle] = useState(de.display_title ?? '');
  const [purpose, setPurpose] = useState(de.purpose_statement ?? '');
  const [outcome, setOutcome] = useState(de.primary_business_outcome ?? '');
  const [resp, setResp] = useState((de.responsibilities ?? []).join('\n'));
  // Migration 136 — standard workforce-record fields.
  const [empCode, setEmpCode] = useState(de.employee_code ?? '');
  const [location, setLocation] = useState(de.location ?? '');
  const [costCenter, setCostCenter] = useState(de.cost_center ?? '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true); setError(null);
    const { data, error: err } = await supabase.rpc('set_de_identity', {
      p_de_id: de.id,
      p_display_title: title.trim(),
      p_purpose_statement: purpose.trim(),
      p_primary_business_outcome: outcome.trim(),
      p_responsibilities: resp.split('\n').map(r => r.trim()).filter(Boolean),
      p_employee_code: empCode.trim(),
      p_location: location.trim(),
      p_cost_center: costCenter.trim(),
    });
    if (err) setError(err.message);
    else { setSaved(true); setTimeout(() => setSaved(false), 2500); if (data) onUpdated(data as DigitalEmployee); }
    setBusy(false);
  };

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Identity & Purpose</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300">feeds every answer</span>
      </div>
      <p className="text-[11px] text-slate-500 mb-3">
        The title and purpose written here go straight into this employee's working instructions —
        every customer answer is given in this identity. Responsibilities also unlock the lifecycle's
        identity criterion.
      </p>
      {error && <p className="text-xs text-rose-300 mb-2">{error}</p>}
      <div className="space-y-2">
        <input type="text" value={title} disabled={busy} onChange={e => setTitle(e.target.value)}
          placeholder="Display title — e.g. Customer Support Specialist"
          className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-50" />
        <textarea value={purpose} disabled={busy} onChange={e => setPurpose(e.target.value)} rows={2}
          placeholder="Purpose statement — one to three sentences on what this employee exists to do"
          className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-50" />
        <input type="text" value={outcome} disabled={busy} onChange={e => setOutcome(e.target.value)}
          placeholder="Primary business outcome — e.g. Reduce average resolution time by 40%"
          className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-50" />
        <textarea value={resp} disabled={busy} onChange={e => setResp(e.target.value)} rows={3}
          placeholder={'Responsibilities — one per line, e.g.\nAnswer customer product questions\nDraft ticket replies for approval'}
          className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-50" />
        {/* Standard workforce-record fields (migration 136) — org bookkeeping,
            NOT fed into the answering persona. */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input type="text" value={empCode} disabled={busy} onChange={e => setEmpCode(e.target.value)}
            placeholder="Employee code — e.g. DE-0042"
            className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-50" />
          <input type="text" value={location} disabled={busy} onChange={e => setLocation(e.target.value)}
            placeholder="Location — e.g. HQ / EU region"
            className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-50" />
          <input type="text" value={costCenter} disabled={busy} onChange={e => setCostCenter(e.target.value)}
            placeholder="Cost center — e.g. CC-SUPPORT"
            className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-50" />
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button onClick={() => void save()} disabled={busy}
          className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Save identity'}
        </button>
        {saved && <span className="text-xs text-emerald-400">Saved — takes effect on the next answer</span>}
      </div>
    </div>
  );
}

// ── Custom profile fields (migration 136): tenant-defined field
// definitions (de_profile_fields) + per-DE values (attributes jsonb,
// written via set_de_attributes → config-versioned + audited).
function DeProfileFieldsPanel({ de, onUpdated }: { de: DigitalEmployee; onUpdated: (d: DigitalEmployee) => void }) {
  const [fields, setFields] = useState<DeProfileField[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [newKey, setNewKey] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newType, setNewType] = useState<'text' | 'number' | 'date'>('text');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listDeProfileFields().then(setFields).catch(() => setFields([]));
  }, []);
  useEffect(() => {
    const v: Record<string, string> = {};
    for (const [k, val] of Object.entries(de.attributes ?? {})) v[k] = String(val);
    setValues(v);
  }, [de.id, de.attributes]);

  const addField = async () => {
    const key = newKey.trim();
    if (!key) return;
    setBusy(true); setError(null);
    try {
      const f = await addDeProfileField({
        field_key: key, label: newLabel.trim() || key, field_type: newType,
        position: fields.length + 1,
      });
      setFields(prev => [...prev, f]);
      setNewKey(''); setNewLabel('');
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const payload: Record<string, string | number | null> = {};
      for (const f of fields) {
        const raw = (values[f.field_key] ?? '').trim();
        payload[f.field_key] = raw === '' ? null : (f.field_type === 'number' ? Number(raw) || 0 : raw);
      }
      const updated = await setDeAttributes(de.id, payload);
      onUpdated(updated);
      setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6">
      <h3 className="text-base font-semibold text-white mb-1">Profile fields</h3>
      <p className="text-[11px] text-slate-500 mb-3">
        Your workspace's own employee-record fields — defined once, shown on every profile.
        Changes are config-versioned and land in the audit history like any other profile edit.
      </p>
      {error && <p className="text-xs text-rose-300 mb-2">{error}</p>}
      {fields.length === 0 ? (
        <p className="text-xs text-slate-500 mb-3">No custom fields defined yet — add the first below.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
          {fields.map(f => (
            <div key={f.id}>
              <label className="text-[11px] text-slate-400 block mb-1">{f.label}</label>
              <input value={values[f.field_key] ?? ''} disabled={busy}
                type={f.field_type === 'number' ? 'number' : f.field_type === 'date' ? 'date' : 'text'}
                onChange={e => setValues(prev => ({ ...prev, [f.field_key]: e.target.value }))}
                className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-50" />
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-3 mb-4">
        {fields.length > 0 && (
          <button onClick={() => void save()} disabled={busy}
            className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50">
            {busy ? 'Saving…' : 'Save fields'}
          </button>
        )}
        {saved && <span className="text-xs text-emerald-400">Saved</span>}
      </div>
      <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-3">
        <p className="text-[11px] font-medium text-slate-400 mb-2">Add a field (applies to every employee's profile)</p>
        <div className="flex gap-2 flex-wrap items-end">
          <input value={newKey} placeholder="field_key (e.g. region)" disabled={busy}
            onChange={e => setNewKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
            className="w-40 bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500" />
          <input value={newLabel} placeholder="Label (e.g. Region)" disabled={busy}
            onChange={e => setNewLabel(e.target.value)}
            className="w-44 bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500" />
          <select value={newType} disabled={busy} onChange={e => setNewType(e.target.value as 'text' | 'number' | 'date')}
            className="bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-2 py-2 focus:outline-none focus:border-indigo-500">
            <option value="text">Text</option><option value="number">Number</option><option value="date">Date</option>
          </select>
          <button onClick={() => void addField()} disabled={busy || !newKey.trim()}
            className="text-xs px-3 py-1.5 rounded-lg border border-slate-600 text-slate-300 hover:text-white hover:border-slate-500 disabled:opacity-50 transition-colors">
            Add field
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Availability panel (DE-C4). Schedule only — enforced on inbox
// polling: off-schedule falls through the same chain as paused
// (team backup → specialist). Reactive Q&A stays available.
type Availability = { mode: string; timezone?: string; start_hour?: number; end_hour?: number; days?: number[] };
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function DeAvailabilityPanel({ de, onUpdated }: { de: DigitalEmployee; onUpdated: (d: DigitalEmployee) => void }) {
  const avail = (de.availability ?? { mode: 'always_on' }) as Availability;
  const [mode, setMode] = useState(avail.mode ?? 'always_on');
  const [tz, setTz] = useState(avail.timezone ?? 'UTC');
  const [startH, setStartH] = useState(String(avail.start_hour ?? 9));
  const [endH, setEndH] = useState(String(avail.end_hour ?? 17));
  const [days, setDays] = useState<number[]>(avail.days ?? [1, 2, 3, 4, 5]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true); setError(null);
    const { data, error: err } = await supabase.rpc('set_de_availability', {
      p_de_id: de.id, p_mode: mode, p_timezone: tz.trim() || 'UTC',
      p_start_hour: Math.max(0, Math.min(23, Math.round(Number(startH) || 9))),
      p_end_hour: Math.max(1, Math.min(24, Math.round(Number(endH) || 17))),
      p_days: days,
    });
    if (err) setError(err.message);
    else { setSaved(true); setTimeout(() => setSaved(false), 2500); if (data) onUpdated(data as DigitalEmployee); }
    setBusy(false);
  };

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Availability</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-400">
          {mode === 'always_on' ? 'always on' : 'business hours'}
        </span>
      </div>
      <p className="text-[11px] text-slate-500 mb-3">
        Off-schedule, this employee stops picking up inbox work — its team backup or the specialist
        desk covers, exactly like when it's paused. Reactive Q&A (widget/chat) stays available.
      </p>
      {error && <p className="text-xs text-rose-300 mb-2">{error}</p>}
      <div className="flex items-center gap-2 flex-wrap">
        <select value={mode} disabled={busy} onChange={e => setMode(e.target.value)}
          className="bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-2 py-2 focus:outline-none focus:border-indigo-500">
          <option value="always_on">Always on</option>
          <option value="business_hours">Business hours</option>
        </select>
        {mode === 'business_hours' && (
          <>
            <input type="text" value={tz} disabled={busy} onChange={e => setTz(e.target.value)} placeholder="Timezone, e.g. America/New_York"
              className="w-44 bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-2 py-2 focus:outline-none focus:border-indigo-500" />
            <input type="number" min={0} max={23} value={startH} disabled={busy} onChange={e => setStartH(e.target.value)} title="Start hour"
              className="w-16 bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-2 py-2 focus:outline-none focus:border-indigo-500" />
            <span className="text-xs text-slate-500">to</span>
            <input type="number" min={1} max={24} value={endH} disabled={busy} onChange={e => setEndH(e.target.value)} title="End hour"
              className="w-16 bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-2 py-2 focus:outline-none focus:border-indigo-500" />
          </>
        )}
        <button onClick={() => void save()} disabled={busy}
          className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="text-xs text-emerald-400">Saved</span>}
      </div>
      {mode === 'business_hours' && (
        <div className="mt-2 flex gap-1.5 flex-wrap">
          {DAY_LABELS.map((label, i) => {
            const day = i + 1;
            const on = days.includes(day);
            return (
              <button key={day} disabled={busy}
                onClick={() => setDays(prev => on ? prev.filter(d => d !== day) : [...prev, day].sort())}
                className={`text-[10px] px-2 py-1 rounded-lg border ${on ? 'border-indigo-500 bg-indigo-500/15 text-indigo-200' : 'border-slate-700 bg-slate-900 text-slate-600'}`}>
                {label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── AI Engine panel (Wave 1.2, migration 132). Which Claude model this
// employee answers with. The choice list is the platform-managed
// pricing table (ai_model_pricing) — a pickable model always has real
// cost tracking. Blank = the platform default.
const MODEL_LABELS: Record<string, string> = {
  'claude-sonnet-5': 'Claude Sonnet 5 — balanced (default)',
  'claude-haiku-4-5': 'Claude Haiku 4.5 — fastest, most economical',
  'claude-opus-4-8': 'Claude Opus 4.8 — most capable',
};
// Customer send mode — draft-for-approval vs auto-send for external chat
// replies. Reads/writes the DE's external_reply_mode (the channel obeys it).
function DeReplyModePanel({ de, onUpdated }: { de: DigitalEmployee; onUpdated: (d: DigitalEmployee) => void }) {
  const [mode, setMode] = useState<'draft' | 'auto'>(de.external_reply_mode === 'auto' ? 'auto' : 'draft');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setMode(de.external_reply_mode === 'auto' ? 'auto' : 'draft'); }, [de.id, de.external_reply_mode]);

  const choose = async (next: 'draft' | 'auto') => {
    if (next === mode || busy) return;
    setBusy(true); setError(null);
    const prev = mode;
    setMode(next);
    try {
      await setExternalReplyMode(de.id, next);
      onUpdated({ ...de, external_reply_mode: next });
    } catch (err) {
      setMode(prev);
      setError((err as Error)?.message || 'Failed to save.');
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Customer replies</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300">external chat</span>
      </div>
      <p className="text-[11px] text-slate-400 mb-4">How this employee's answers reach customers in the support chat. Guardrails and the confidence floor always apply either way.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {([
          { key: 'draft' as const, title: 'Draft for approval', desc: 'Every answer waits for a teammate to approve before the customer sees it. Safest — start here.' },
          { key: 'auto' as const, title: 'Auto-send', desc: 'Confident, guardrail-clean answers send on their own. Low-confidence ones still go to a human.' },
        ]).map(o => (
          <button
            key={o.key}
            onClick={() => void choose(o.key)}
            disabled={busy}
            className={`text-left rounded-xl border p-4 transition-colors disabled:opacity-60 ${mode === o.key ? (o.key === 'auto' ? 'border-emerald-500/60 bg-emerald-500/10' : 'border-indigo-500/60 bg-indigo-500/10') : 'border-slate-700 bg-slate-900/40 hover:border-slate-600'}`}
          >
            <div className="flex items-center gap-2">
              <span className={`w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 ${mode === o.key ? (o.key === 'auto' ? 'border-emerald-400 bg-emerald-400' : 'border-indigo-400 bg-indigo-400') : 'border-slate-600'}`} />
              <span className="text-sm font-medium text-white">{o.title}</span>
            </div>
            <p className="text-[11px] text-slate-400 mt-1.5 pl-5">{o.desc}</p>
          </button>
        ))}
      </div>
      {error && <p className="text-[11px] text-rose-400 mt-2">{error}</p>}
    </div>
  );
}

function DeModelPanel({ de, onUpdated }: { de: DigitalEmployee; onUpdated: (d: DigitalEmployee) => void }) {
  const [models, setModels] = useState<Array<{ model_id: string; input_price_per_million: number; output_price_per_million: number }>>([]);
  const [selected, setSelected] = useState(de.model_id || 'claude-sonnet-5');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void supabase.from('ai_model_pricing')
      .select('model_id, input_price_per_million, output_price_per_million')
      .order('input_price_per_million')
      .then(({ data }) => setModels((data ?? []) as typeof models));
  }, []);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const updated = await updateDigitalEmployee(de.id, { modelId: selected || 'claude-sonnet-5' });
      setSaved(true); setTimeout(() => setSaved(false), 2500);
      onUpdated(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save.');
    }
    setBusy(false);
  };

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">AI Engine</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-400">
          {de.model_id && MODEL_LABELS[de.model_id] ? de.model_id : 'platform default'}
        </span>
      </div>
      <p className="text-[11px] text-slate-500 mb-3">
        The Claude model this employee thinks with. Every listed model has verified pricing, so the
        Economics and cost numbers stay real whichever you choose. Takes effect on the next answer.
      </p>
      {error && <p className="text-xs text-rose-300 mb-2">{error}</p>}
      <div className="flex items-center gap-2 flex-wrap">
        <select value={selected} disabled={busy} onChange={e => setSelected(e.target.value)}
          className="flex-1 min-w-[260px] bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-50">
          {models.map(m => (
            <option key={m.model_id} value={m.model_id}>
              {MODEL_LABELS[m.model_id] ?? m.model_id} · ${m.input_price_per_million}/{'$'}{m.output_price_per_million} per M tokens
            </option>
          ))}
        </select>
        <button onClick={() => void save()} disabled={busy || selected === (de.model_id || 'claude-sonnet-5')}
          className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40">
          {busy ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="text-xs text-emerald-400">Saved</span>}
      </div>
    </div>
  );
}

// ── KPIs panel (DE-C4). Targets are stored; CURRENT is computed live
// from the same real metrics the Performance page uses — never stale,
// never fabricated. No measurable sample → "no data yet", not zero.
type KpiStatus = {
  kpi_id: string; name: string; metric_key: string; target: number;
  direction: string; current: number | null; met: boolean | null; sample: number;
};
// The KPI list used to be a constant here, which is exactly why a workspace
// could not track anything the platform had not thought of. It now comes from
// kpi_metric_catalog (migration 205) via list_kpi_metrics().
function DeKpisPanel({ de }: { de: DigitalEmployee }) {
  const [kpis, setKpis] = useState<KpiStatus[] | null>(null);
  // The metric list is now this workspace's catalog (built-ins + its own),
  // not a constant compiled into the page.
  const [metrics, setMetrics] = useState<KpiMetric[]>([]);
  const [metricKey, setMetricKey] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [defining, setDefining] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newDir, setNewDir] = useState<'higher' | 'lower'>('higher');
  const [newUnit, setNewUnit] = useState('');
  const [reading, setReading] = useState<{ key: string; name: string } | null>(null);
  const [readingValue, setReadingValue] = useState('');

  const selected = metrics.find(m => m.metric_key === metricKey) ?? null;

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.rpc('get_de_kpi_status', { p_de_id: de.id });
    if (err) { setError(err.message); return; }
    setKpis((data ?? []) as KpiStatus[]);
  }, [de.id]);

  const loadMetrics = useCallback(async () => {
    try {
      const list = await listKpiMetrics();
      setMetrics(list);
      setMetricKey(prev => (prev && list.some(m => m.metric_key === prev)) ? prev : (list[0]?.metric_key ?? ''));
    } catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadMetrics(); }, [loadMetrics]);

  const run = async (fn: () => PromiseLike<{ error: { message: string } | null }>) => {
    setBusy(true); setError(null);
    const { error: err } = await fn();
    if (err) setError(err.message);
    await load();
    setBusy(false);
  };

  const add = () => {
    if (!selected || target.trim() === '') return;
    void run(() => supabase.rpc('set_de_kpi', {
      p_de_id: de.id, p_metric_key: selected.metric_key, p_name: selected.label,
      p_target: Number(target), p_direction: selected.direction,
    }));
    setTarget('');
  };

  const defineMetric = async () => {
    const label = newLabel.trim();
    if (!label) return;
    setBusy(true); setError(null);
    try {
      const key = slugifyKey(label);
      await createKpiMetric({ metricKey: key, label, direction: newDir, unit: newUnit.trim() || undefined });
      await loadMetrics();
      setMetricKey(key);
      setDefining(false); setNewLabel(''); setNewUnit('');
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const saveReading = async () => {
    if (!reading || readingValue.trim() === '') return;
    setBusy(true); setError(null);
    try {
      await recordKpiReading({ deId: de.id, metricKey: reading.key, value: Number(readingValue) });
      setReading(null); setReadingValue('');
      await load();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Goals & KPIs</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-500/15 text-teal-300">measured live</span>
      </div>
      <p className="text-[11px] text-slate-500 mb-3">
        Targets you set against metrics this workspace tracks. Built-in metrics are computed from real
        activity at view time — never stored, stale, or invented. Metrics you define yourself show a
        value once you record a reading.
      </p>
      {error && <p className="text-xs text-rose-300 mb-2">{error}</p>}
      {kpis === null ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : kpis.length === 0 ? (
        <p className="text-xs text-slate-500 mb-3">No KPIs set yet.</p>
      ) : (
        <div className="space-y-1.5 mb-3">
          {kpis.map(k => (
            <div key={k.kpi_id} className="flex items-center gap-2 text-xs flex-wrap">
              <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                k.met === null ? 'bg-slate-700 text-slate-500'
                : k.met ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>
                {k.met === null ? 'no data yet' : k.met ? 'on target' : 'off target'}
              </span>
              <span className="text-slate-300">{k.name}</span>
              <span className="text-slate-500">
                {k.current === null ? '—' : k.current} / target {k.direction === 'higher' ? '≥' : '≤'} {k.target}
                {k.sample > 0 ? ` · ${k.sample} sampled` : ''}
              </span>
              {/* Manual metrics need somebody to record the number — without
                  this they would sit at "—" forever and look broken. */}
              {metrics.find(m => m.metric_key === k.metric_key)?.source === 'manual' && (
                <button onClick={() => { setReading({ key: k.metric_key, name: k.name }); setReadingValue(''); }}
                  disabled={busy}
                  className="text-[10px] text-indigo-400 hover:text-indigo-300">
                  Record value
                </button>
              )}
              <button onClick={() => void run(() => supabase.rpc('set_de_kpi', { p_de_id: de.id, p_metric_key: k.metric_key, p_name: k.name, p_target: null, p_direction: k.direction }))}
                disabled={busy}
                className="ml-auto text-[10px] text-slate-600 hover:text-rose-300">
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {reading && (
        <div className="mb-3 rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-3 space-y-2">
          <p className="text-xs text-slate-300">Record a value for <span className="font-medium">{reading.name}</span></p>
          <div className="flex items-center gap-2">
            <input type="number" value={readingValue} autoFocus
              onChange={e => setReadingValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void saveReading(); }}
              placeholder="Value"
              className="w-32 bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500" />
            <button onClick={() => void saveReading()} disabled={busy || readingValue.trim() === ''}
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40">Save</button>
            <button onClick={() => setReading(null)} className="text-xs text-slate-500 hover:text-slate-300">Cancel</button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <select value={metricKey} disabled={busy || metrics.length === 0} onChange={e => setMetricKey(e.target.value)}
          className="flex-1 bg-slate-900 border border-slate-700 text-slate-300 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500">
          {metrics.map(m => (
            <option key={m.metric_key} value={m.metric_key}>
              {m.label}{m.unit ? ` (${m.unit})` : ''}{m.source === 'manual' ? ' — you record this' : ''}
            </option>
          ))}
        </select>
        <input type="number" value={target} disabled={busy} onChange={e => setTarget(e.target.value)} placeholder="Target"
          className="w-24 bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500" />
        <button onClick={add} disabled={busy || target.trim() === '' || !selected}
          className="text-xs px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-40">
          Add KPI
        </button>
      </div>

      {!defining ? (
        <button onClick={() => setDefining(true)} className="mt-2 text-[11px] text-indigo-400 hover:text-indigo-300">
          + Track a metric of your own
        </button>
      ) : (
        <div className="mt-3 rounded-xl border border-slate-600 bg-slate-900/60 p-3 space-y-2">
          <p className="text-[11px] text-slate-400">
            Define a measure that matters to your business. The platform can&apos;t compute it, so you record the value yourself.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="e.g. First-call resolution"
              className="flex-1 min-w-[180px] bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500" />
            <input value={newUnit} onChange={e => setNewUnit(e.target.value)} placeholder="Unit (%, hrs)"
              className="w-28 bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500" />
            <select value={newDir} onChange={e => setNewDir(e.target.value as 'higher' | 'lower')}
              className="bg-slate-800 border border-slate-600 text-slate-300 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500">
              <option value="higher">Higher is better</option>
              <option value="lower">Lower is better</option>
            </select>
          </div>
          {newLabel.trim() && (
            <p className="text-[10px] text-slate-600">Saved as <code>{slugifyKey(newLabel)}</code></p>
          )}
          <div className="flex gap-2">
            <button onClick={() => void defineMetric()} disabled={busy || !newLabel.trim()}
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40">Create</button>
            <button onClick={() => { setDefining(false); setNewLabel(''); setNewUnit(''); }}
              className="text-xs text-slate-500 hover:text-slate-300">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Economics panel (DE-C5, migration 131). FTE Equivalent and ROI
// exist ONLY downstream of baselines the workspace types in (§12.3:
// "configured by the Organisation, not invented by the platform").
// Real counts and real AI cost always show; the value math shows
// "configure to calculate" until the baselines exist.
type Economics = {
  window_days: number;
  counts: { inquiries_handled: number; actions_executed: number; conversations_answered: number };
  baselines: { inquiry_minutes: number | null; action_minutes: number | null; conversation_minutes: number | null; avg_fte_cost_monthly_usd: number | null };
  hours_saved: number | null; fte_equivalent: number | null; de_cost_usd: number;
  human_cost_equivalent_usd: number | null; monthly_saving_usd: number | null; roi_ratio: number | null;
  unconfigured: string[]; configured: boolean;
};
function DeEconomicsPanel({ de }: { de: DigitalEmployee }) {
  const [eco, setEco] = useState<Economics | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [fteCost, setFteCost] = useState('');
  const [inqMin, setInqMin] = useState('');
  const [actMin, setActMin] = useState('');
  const [convMin, setConvMin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.rpc('get_de_economics', {
      p_tenant_id: de.tenant_id, p_de_id: de.id, p_days: 30,
    });
    if (err) { setError(err.message); return; }
    const e = data as Economics;
    setEco(e);
    setFteCost(e.baselines.avg_fte_cost_monthly_usd?.toString() ?? '');
    setInqMin(e.baselines.inquiry_minutes?.toString() ?? '');
    setActMin(e.baselines.action_minutes?.toString() ?? '');
    setConvMin(e.baselines.conversation_minutes?.toString() ?? '');
  }, [de.id, de.tenant_id]);
  useEffect(() => { void load(); }, [load]);

  const saveBaselines = async () => {
    setBusy(true); setError(null);
    const num = (s: string) => (s.trim() === '' ? null : Number(s));
    const { error: err } = await supabase.rpc('set_workforce_baselines', {
      p_avg_fte_cost_monthly_usd: num(fteCost),
      p_inquiry_minutes: num(inqMin),
      p_action_minutes: num(actMin),
      p_conversation_minutes: num(convMin),
    });
    if (err) setError(err.message);
    else setShowConfig(false);
    await load();
    setBusy(false);
  };

  const money = (n: number | null) => n === null ? '—' : `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Economics</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-500/15 text-teal-300">your baselines, never estimated</span>
        <button onClick={() => setShowConfig(s => !s)}
          className="ml-auto text-xs px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200">
          {showConfig ? 'Cancel' : 'Baselines…'}
        </button>
      </div>
      <p className="text-[11px] text-slate-500 mb-3">
        Work counts and AI cost are always real. Hours saved, FTE equivalent, and ROI are computed
        only from baselines <span className="text-slate-300">you</span> configure — how long a human
        takes per task and what a human FTE costs. The platform never invents these.
      </p>
      {error && <p className="text-xs text-rose-300 mb-2">{error}</p>}

      {showConfig && (
        <div className="mb-4 rounded-xl border border-slate-700 bg-slate-900 p-3 space-y-2">
          <p className="text-[10px] uppercase tracking-wide text-amber-300/80">Workspace-wide — applies to every employee</p>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] text-slate-500">Human minutes per inbox item
              <input type="number" min={0.1} step={0.5} value={inqMin} disabled={busy} onChange={e => setInqMin(e.target.value)} placeholder="e.g. 6"
                className="mt-0.5 w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500" />
            </label>
            <label className="text-[11px] text-slate-500">Human minutes per action
              <input type="number" min={0.1} step={0.5} value={actMin} disabled={busy} onChange={e => setActMin(e.target.value)} placeholder="e.g. 8"
                className="mt-0.5 w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500" />
            </label>
            <label className="text-[11px] text-slate-500">Human minutes per conversation
              <input type="number" min={0.1} step={0.5} value={convMin} disabled={busy} onChange={e => setConvMin(e.target.value)} placeholder="e.g. 4"
                className="mt-0.5 w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500" />
            </label>
            <label className="text-[11px] text-slate-500">Human FTE cost / month (USD, fully loaded)
              <input type="number" min={1} value={fteCost} disabled={busy} onChange={e => setFteCost(e.target.value)} placeholder="e.g. 6000"
                className="mt-0.5 w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500" />
            </label>
          </div>
          <button onClick={() => void saveBaselines()} disabled={busy}
            className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50">
            {busy ? 'Saving…' : 'Save baselines'}
          </button>
        </div>
      )}

      {eco === null ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
            <div className="rounded-xl border border-slate-700 bg-slate-900 p-3">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">Work · 30 days</p>
              <p className="text-sm text-white font-semibold mt-1">
                {eco.counts.inquiries_handled + eco.counts.actions_executed + eco.counts.conversations_answered}
              </p>
              <p className="text-[10px] text-slate-600">{eco.counts.inquiries_handled} inbox · {eco.counts.actions_executed} actions · {eco.counts.conversations_answered} conv.</p>
            </div>
            <div className="rounded-xl border border-slate-700 bg-slate-900 p-3">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">AI cost</p>
              <p className="text-sm text-white font-semibold mt-1">{money(eco.de_cost_usd)}</p>
              <p className="text-[10px] text-slate-600">real token spend</p>
            </div>
            <div className="rounded-xl border border-slate-700 bg-slate-900 p-3">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">Hours saved</p>
              <p className="text-sm text-white font-semibold mt-1">{eco.hours_saved ?? '—'}</p>
              <p className="text-[10px] text-slate-600">{eco.fte_equivalent !== null ? `${eco.fte_equivalent} FTE equivalent` : 'configure to calculate'}</p>
            </div>
            <div className="rounded-xl border border-slate-700 bg-slate-900 p-3">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">ROI</p>
              <p className="text-sm text-white font-semibold mt-1">{eco.roi_ratio !== null ? `${eco.roi_ratio}x` : '—'}</p>
              <p className="text-[10px] text-slate-600">
                {eco.monthly_saving_usd !== null ? `≈ ${money(eco.monthly_saving_usd)}/month saved` : 'configure to calculate'}
              </p>
            </div>
          </div>
          {eco.unconfigured.length > 0 && (
            <p className="text-[11px] text-amber-300/90">
              Configure to calculate: {eco.unconfigured.map(u => u.split('_').join(' ')).join(', ')} — set them under “Baselines…”.
            </p>
          )}
        </>
      )}
    </div>
  );
}

// ── Lifecycle panel — the governance gate made visible (DE-B4,
// migration 126). The chain is designed → configured → trained →
// tested → certified → published → assigned → active; every "Advance"
// is criteria-checked server-side (advance_de_lifecycle), certification
// requires a named reviewer note, and pause/resume have real teeth
// (a paused employee stops polling, answering, and running playbooks).
const LIFECYCLE_CHAIN = ['designed', 'configured', 'trained', 'tested', 'certified', 'published', 'assigned', 'active'] as const;
const STAGE_LABELS: Record<string, string> = {
  designed: 'Designed', configured: 'Configured', trained: 'Trained', tested: 'Tested',
  certified: 'Certified', published: 'Published', assigned: 'Assigned', active: 'Active',
  improving: 'Improving', paused: 'Paused', retired: 'Retired', archived: 'Archived',
};
type LifecycleReadiness = {
  stage: string; status: string;
  criteria: Record<string, Record<string, boolean | string>>;
};
function DeLifecyclePanel({ de, onUpdated }: { de: DigitalEmployee; onUpdated: (d: DigitalEmployee) => void }) {
  const [readiness, setReadiness] = useState<LifecycleReadiness | null>(null);
  const [events, setEvents] = useState<Array<{ id: string; from_stage: string; to_stage: string; actor_label: string; note: string | null; created_at: string }>>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data: r, error: rErr }, { data: ev }] = await Promise.all([
      supabase.rpc('compute_de_lifecycle_readiness', { p_de_id: de.id }),
      supabase.from('de_lifecycle_events')
        .select('id, from_stage, to_stage, actor_label, note, created_at')
        .eq('de_id', de.id).order('created_at', { ascending: false }).limit(5),
    ]);
    if (rErr) { setError(rErr.message); return; }
    setReadiness(r as LifecycleReadiness);
    setEvents((ev ?? []) as typeof events);
  }, [de.id]);
  useEffect(() => { void load(); }, [load]);

  const stage = readiness?.stage ?? de.lifecycle_status ?? 'designed';
  const chainIdx = (LIFECYCLE_CHAIN as readonly string[]).indexOf(stage);
  const nextStage = chainIdx >= 0 && chainIdx < LIFECYCLE_CHAIN.length - 1 ? LIFECYCLE_CHAIN[chainIdx + 1] : null;
  const nextCriteria = nextStage && readiness ? readiness.criteria[nextStage] : null;
  const criteriaEntries = nextCriteria
    ? Object.entries(nextCriteria).filter(([k, v]) => typeof v === 'boolean') as Array<[string, boolean]>
    : [];
  const allMet = criteriaEntries.length > 0 && criteriaEntries.every(([, v]) => v);
  const isPaused = stage === 'paused';
  const isClosed = stage === 'retired' || stage === 'archived';
  const isOperational = stage === 'active' || stage === 'improving';

  const run = async (fn: () => PromiseLike<{ error: { message: string } | null }>) => {
    setBusy(true); setError(null);
    const { error: err } = await fn();
    if (err) setError(err.message);
    setNote('');
    await load();
    setBusy(false);
    // Refresh the parent card's stage badge without a full reload.
    const { data: fresh } = await supabase.from('digital_employees').select('*').eq('id', de.id).maybeSingle();
    if (fresh) onUpdated(fresh as DigitalEmployee);
  };

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Lifecycle</h3>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${
          isOperational ? 'bg-emerald-500/15 text-emerald-300'
          : isPaused ? 'bg-amber-500/15 text-amber-300'
          : isClosed ? 'bg-slate-700 text-slate-500'
          : 'bg-indigo-500/15 text-indigo-300'}`}>
          {STAGE_LABELS[stage] ?? stage}
        </span>
      </div>
      <p className="text-[11px] text-slate-500 mb-3">
        Stage is a governance gate, not a label: proactive work (inbox, actions, playbooks) needs
        Assigned or beyond, and each advance checks real criteria. Reactive Q&A stays available
        pre-launch — that is the proving ground.
      </p>
      {error && <p className="text-xs text-rose-300 mb-2">{error}</p>}

      {/* Stage ladder */}
      <div className="flex flex-wrap items-center gap-1 mb-4">
        {LIFECYCLE_CHAIN.map((s, i) => (
          <span key={s} className="flex items-center gap-1">
            <span className={`text-[10px] px-2 py-1 rounded-lg border ${
              s === stage ? 'border-indigo-500 bg-indigo-500/15 text-indigo-200 font-semibold'
              : chainIdx >= 0 && i < chainIdx ? 'border-slate-700 bg-slate-900 text-emerald-400'
              : 'border-slate-700 bg-slate-900 text-slate-600'}`}>
              {chainIdx >= 0 && i < chainIdx ? '✓ ' : ''}{STAGE_LABELS[s]}
            </span>
            {i < LIFECYCLE_CHAIN.length - 1 && <span className="text-slate-600 text-[10px]">→</span>}
          </span>
        ))}
        {(stage === 'improving' || isPaused || isClosed) && (
          <span className="text-[10px] px-2 py-1 rounded-lg border border-amber-600/40 bg-amber-500/10 text-amber-300 ml-1">
            {STAGE_LABELS[stage]}
          </span>
        )}
      </div>

      {/* Next-stage criteria */}
      {!isPaused && !isClosed && nextStage && nextCriteria && (
        <div className="mb-4">
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1.5">
            To reach {STAGE_LABELS[nextStage]}
          </p>
          <div className="space-y-1">
            {criteriaEntries.map(([k, met]) => (
              <p key={k} className={`text-xs ${met ? 'text-emerald-400' : 'text-slate-400'}`}>
                {met ? '✓' : '○'} {k.split('_').join(' ')}
              </p>
            ))}
            {typeof nextCriteria.detail === 'string' && (
              <p className="text-[10px] text-slate-600 mt-1">{nextCriteria.detail}</p>
            )}
          </div>
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            {nextStage === 'certified' && (
              <input
                type="text" value={note} disabled={busy}
                onChange={e => setNote(e.target.value)}
                placeholder="Certification note — what did you review?"
                className="flex-1 min-w-[220px] bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
              />
            )}
            <button
              onClick={() => void run(() => supabase.rpc('advance_de_lifecycle', { p_de_id: de.id, p_to_stage: nextStage, p_note: note.trim() || null }))}
              disabled={busy || !allMet || (nextStage === 'certified' && !note.trim())}
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40">
              {busy ? 'Working…' : nextStage === 'certified' ? 'Certify' : `Advance to ${STAGE_LABELS[nextStage]}`}
            </button>
            {!allMet && <span className="text-[10px] text-slate-600">Criteria above must be met first.</span>}
          </div>
        </div>
      )}

      {/* Pause / resume */}
      {!isClosed && (
        <div className="mb-4 flex items-center gap-2 flex-wrap">
          <input
            type="text" value={note} disabled={busy}
            onChange={e => setNote(e.target.value)}
            placeholder={isPaused ? 'Resume note — what was investigated?' : 'Pause reason (required)'}
            className="flex-1 min-w-[220px] bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-amber-500 disabled:opacity-50"
          />
          {isPaused ? (
            <button
              onClick={() => void run(() => supabase.rpc('resume_digital_employee', { p_de_id: de.id, p_note: note.trim() }))}
              disabled={busy || !note.trim()}
              className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40">
              Resume
            </button>
          ) : (
            <button
              onClick={() => void run(() => supabase.rpc('pause_digital_employee', { p_de_id: de.id, p_reason: note.trim() }))}
              disabled={busy || !note.trim()}
              className="text-xs px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-40">
              Pause
            </button>
          )}
        </div>
      )}

      {/* Recent transitions */}
      {events.length > 0 && (
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1.5">Recent transitions</p>
          <div className="space-y-1">
            {events.map(ev => (
              <p key={ev.id} className="text-[11px] text-slate-500">
                <span className="text-slate-400">{STAGE_LABELS[ev.from_stage] ?? ev.from_stage} → {STAGE_LABELS[ev.to_stage] ?? ev.to_stage}</span>
                {' '}· {ev.actor_label}{ev.note ? ` — ${ev.note.slice(0, 100)}` : ''}
                {' '}· {new Date(ev.created_at).toLocaleDateString()}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Escalation rules panel — per-employee with workspace fallback ──
// Frustration threshold + always-escalate topics (migration 124).
// The same cascade as the trust dial: this employee's own rules win,
// else the workspace default, else the platform default (50, none).
// Guardrails always outrank these; the confidence floor lives on the
// trust dial and is deliberately not duplicated here.
type EscalationRow = { de_id: string | null; frustration_threshold: number | null; always_escalate_topics: string[] };
function DeEscalationPanel({ deId }: { deId: string }) {
  const [deRow, setDeRow] = useState<EscalationRow | null>(null);
  const [tenantRow, setTenantRow] = useState<EscalationRow | null>(null);
  const [threshold, setThreshold] = useState('');
  const [topics, setTopics] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Named rules in the workspace's own words (mig 205 custom_rules).
  const [customRules, setCustomRules] = useState<EscalationRule[]>([]);
  const [ruleName, setRuleName] = useState('');
  const [ruleWhen, setRuleWhen] = useState('');
  const [ruleAction, setRuleAction] = useState<'escalate' | 'require_approval'>('escalate');

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.from('de_escalation_rules')
      .select('de_id, frustration_threshold, always_escalate_topics')
      .or(`de_id.eq.${deId},de_id.is.null`);
    if (err) { setError(err.message); return; }
    const rows = (data ?? []) as EscalationRow[];
    const mine = rows.find(r => r.de_id === deId) ?? null;
    setDeRow(mine);
    setTenantRow(rows.find(r => r.de_id === null) ?? null);
    setThreshold(mine?.frustration_threshold != null ? String(mine.frustration_threshold) : '');
    setTopics((mine?.always_escalate_topics ?? []).join(', '));
  }, [deId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void getCustomEscalationRules(deId).then(setCustomRules).catch(() => { /* stays empty */ });
  }, [deId]);

  const addRule = () => {
    const name = ruleName.trim(), when = ruleWhen.trim();
    if (!name || !when) return;
    void persistRules([...customRules, { name, when, action: ruleAction, enabled: true }]);
    setRuleName(''); setRuleWhen('');
  };

  const persistRules = async (next: EscalationRule[]) => {
    setBusy(true); setError(null);
    try {
      await saveCustomEscalationRules(deId, next);
      setCustomRules(next);
      setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const isPersonal = deRow !== null;
  const effectiveThreshold = deRow?.frustration_threshold ?? tenantRow?.frustration_threshold ?? 50;
  const effectiveTopics = (deRow?.always_escalate_topics?.length ? deRow.always_escalate_topics
    : tenantRow?.always_escalate_topics) ?? [];

  const save = async () => {
    setBusy(true); setError(null);
    const thr = threshold.trim() === '' ? null
      : Math.max(0, Math.min(100, Math.round(Number(threshold) || 0)));
    const list = topics.split(',').map(t => t.trim()).filter(Boolean);
    const { error: err } = await supabase.rpc('set_de_escalation_rules', {
      p_de_id: deId, p_frustration_threshold: thr, p_topics: list,
    });
    if (err) setError(err.message);
    else { setSaved(true); setTimeout(() => setSaved(false), 2500); }
    await load();
    setBusy(false);
  };

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Escalation rules</h3>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${isPersonal ? 'bg-indigo-500/15 text-indigo-300' : 'bg-slate-700 text-slate-400'}`}>
          {isPersonal ? 'personal' : 'workspace default'}
        </span>
      </div>
      <p className="text-[11px] text-slate-500 mb-3">
        When this employee hands work to a human no matter how confident it is. Guardrails always
        outrank these; the confidence floor lives on the trust dial below.
      </p>
      {error && <p className="text-xs text-rose-300 mb-2">{error}</p>}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Frustration threshold</p>
          <input
            type="number" min={0} max={100} value={threshold} disabled={busy}
            onChange={e => setThreshold(e.target.value)}
            placeholder={`inherited (${tenantRow?.frustration_threshold ?? 50})`}
            className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
          />
          <p className="text-[10px] text-slate-600 mt-1">
            A customer scoring ≥ {effectiveThreshold}% on frustration signals always gets a human. Blank = inherit.
          </p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Always-escalate topics</p>
          <input
            type="text" value={topics} disabled={busy}
            onChange={e => setTopics(e.target.value)}
            placeholder="e.g. refund, contract renewal"
            className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
          />
          <p className="text-[10px] text-slate-600 mt-1">
            Comma-separated phrases — any match routes to a human regardless of confidence.
            {effectiveTopics.length > 0 && !isPersonal ? ` Inherited: ${effectiveTopics.join(', ')}.` : ''}
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button onClick={() => void save()} disabled={busy}
          className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="text-xs text-emerald-400">Saved</span>}
        {isPersonal && (
          <span className="text-[10px] text-slate-600">Clear both fields and save to fall back to the workspace default.</span>
        )}
      </div>

      {/* Named rules in your own words. The two fields above cover the two
          cases the platform can detect on its own; this covers everything
          specific to how your business actually works. */}
      <div className="mt-5 pt-4 border-t border-slate-700">
        <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Your own rules</p>
        <p className="text-[10px] text-slate-600 mb-3">
          Describe a situation in plain language and say what should happen. Applied alongside the
          settings above — guardrails still outrank everything here.
        </p>

        {customRules.length > 0 && (
          <div className="space-y-1.5 mb-3">
            {customRules.map((r, i) => (
              <div key={i} className="flex items-start gap-2 text-xs rounded-lg border border-slate-700 bg-slate-900 px-3 py-2">
                <input type="checkbox" checked={r.enabled} disabled={busy}
                  onChange={() => void persistRules(customRules.map((x, j) => j === i ? { ...x, enabled: !x.enabled } : x))}
                  className="mt-0.5 accent-indigo-500" />
                <div className="min-w-0 flex-1">
                  <span className={r.enabled ? 'text-slate-200' : 'text-slate-500 line-through'}>{r.name}</span>
                  <p className="text-[10px] text-slate-500 mt-0.5">{r.when}</p>
                </div>
                <span className={`text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap ${
                  r.action === 'escalate' ? 'bg-amber-500/15 text-amber-300' : 'bg-sky-500/15 text-sky-300'}`}>
                  {r.action === 'escalate' ? 'hand to a human' : 'needs approval'}
                </span>
                <button onClick={() => void persistRules(customRules.filter((_, j) => j !== i))} disabled={busy}
                  className="text-[10px] text-slate-600 hover:text-rose-300">Remove</button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <input value={ruleName} disabled={busy} onChange={e => setRuleName(e.target.value)}
            placeholder="Rule name — e.g. Legal threat"
            className="w-44 bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500" />
          <input value={ruleWhen} disabled={busy} onChange={e => setRuleWhen(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addRule(); }}
            placeholder="When — e.g. the customer mentions a lawyer or a regulator"
            className="flex-1 min-w-[220px] bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500" />
          <select value={ruleAction} disabled={busy} onChange={e => setRuleAction(e.target.value as 'escalate' | 'require_approval')}
            className="bg-slate-900 border border-slate-700 text-slate-300 text-xs rounded-lg px-2 py-2 focus:outline-none focus:border-indigo-500">
            <option value="escalate">Hand to a human</option>
            <option value="require_approval">Needs approval first</option>
          </select>
          <button onClick={addRule} disabled={busy || !ruleName.trim() || !ruleWhen.trim()}
            className="text-xs px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-40">
            Add rule
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Workforce Teams panel — fallback chains (DE-C2, migration 128).
// Rank 1 = primary responder; higher ranks are backups that take over
// a shared work source automatically when everyone ranked above them
// is paused or unavailable. Teams never grant access — a backup still
// needs its own grant on the source (Control Fabric stays sovereign).
type TeamRow = { id: string; name: string; purpose: string; status: string };
type TeamMemberRow = {
  id: string; team_id: string; de_id: string; fallback_rank: number;
  digital_employees: { name: string; persona_name: string | null; lifecycle_status: string; status: string } | null;
};
function TeamsPanel() {
  const [teams, setTeams] = useState<TeamRow[] | null>(null);
  const [members, setMembers] = useState<TeamMemberRow[]>([]);
  const [des, setDes] = useState<Array<{ id: string; name: string; lifecycle_status: string }>>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [addDe, setAddDe] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data: t, error: tErr }, { data: m }, { data: d }] = await Promise.all([
      supabase.from('workforce_teams').select('id, name, purpose, status').eq('status', 'active').order('created_at'),
      supabase.from('workforce_team_members')
        .select('id, team_id, de_id, fallback_rank, digital_employees(name, persona_name, lifecycle_status, status)')
        .order('fallback_rank'),
      supabase.from('digital_employees').select('id, name, lifecycle_status')
        .not('lifecycle_status', 'in', '(retired,archived)').order('name'),
    ]);
    if (tErr) { setError(tErr.message); return; }
    setTeams((t ?? []) as TeamRow[]);
    setMembers((m ?? []) as unknown as TeamMemberRow[]);
    setDes((d ?? []) as typeof des);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => PromiseLike<{ error: { message: string } | null }>) => {
    setBusy(true); setError(null);
    const { error: err } = await fn();
    if (err) setError(err.message);
    await load();
    setBusy(false);
  };

  const createTeam = () => run(async () => {
    const res = await supabase.rpc('upsert_workforce_team', { p_name: name.trim(), p_purpose: purpose.trim() });
    if (!res.error) { setName(''); setPurpose(''); setShowCreate(false); }
    return res;
  });

  const addMember = (teamId: string) => {
    const deId = addDe[teamId];
    if (!deId) return;
    const teamMembers = members.filter(m => m.team_id === teamId);
    const nextRank = teamMembers.length === 0 ? 1 : Math.max(...teamMembers.map(m => m.fallback_rank)) + 1;
    void run(() => supabase.rpc('set_workforce_team_member', { p_team_id: teamId, p_de_id: deId, p_fallback_rank: nextRank }));
    setAddDe(prev => ({ ...prev, [teamId]: '' }));
  };

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6 mt-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Workforce Teams</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300">fallback chains</span>
        <button onClick={() => setShowCreate(s => !s)}
          className="ml-auto text-xs px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200">
          {showCreate ? 'Cancel' : '+ New team'}
        </button>
      </div>
      <p className="text-[11px] text-slate-500 mb-3">
        Within a team, the highest-ranked available employee owns each shared inbox; backups take
        over automatically when it is paused or unavailable, and the specialist desk covers after
        that. Teams never grant access — a backup still needs its own grant on the system it covers.
      </p>
      {error && <p className="text-xs text-rose-300 mb-2">{error}</p>}

      {showCreate && (
        <div className="mb-4 rounded-xl border border-slate-700 bg-slate-900 p-3 space-y-2">
          <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Team name — e.g. Support Workforce"
            className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500" />
          <input type="text" value={purpose} onChange={e => setPurpose(e.target.value)} placeholder="Purpose (optional)"
            className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500" />
          <button onClick={() => void createTeam()} disabled={busy || !name.trim()}
            className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40">
            Create team
          </button>
        </div>
      )}

      {teams === null ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : teams.length === 0 ? (
        <p className="text-xs text-slate-500">No teams yet — a team defines who owns an inbox and who covers when they can’t.</p>
      ) : (
        <div className="space-y-4">
          {teams.map(team => {
            const teamMembers = members.filter(m => m.team_id === team.id).sort((a, b) => a.fallback_rank - b.fallback_rank);
            const memberIds = new Set(teamMembers.map(m => m.de_id));
            return (
              <div key={team.id} className="rounded-xl border border-slate-700 bg-slate-900 p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-white font-medium">{team.name}</span>
                  <button onClick={() => { if (window.confirm(`Archive "${team.name}"? Its fallback chain will stop applying.`)) void run(() => supabase.rpc('archive_workforce_team', { p_team_id: team.id })); }}
                    disabled={busy}
                    className="ml-auto text-[10px] text-slate-500 hover:text-rose-300">
                    Archive
                  </button>
                </div>
                {team.purpose && <p className="text-[11px] text-slate-500 mt-0.5">{team.purpose}</p>}
                <div className="mt-2 space-y-1">
                  {teamMembers.length === 0 && <p className="text-[11px] text-slate-600">No members yet.</p>}
                  {teamMembers.map(m => {
                    const de = m.digital_employees;
                    const eligible = de && ['assigned', 'active', 'improving'].includes(de.lifecycle_status) && de.status === 'active';
                    return (
                      <div key={m.id} className="flex items-center gap-2 text-xs">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] ${m.fallback_rank === 1 ? 'bg-indigo-500/15 text-indigo-300' : 'bg-slate-700 text-slate-400'}`}>
                          {m.fallback_rank === 1 ? 'Primary' : `Backup #${m.fallback_rank - 1}`}
                        </span>
                        <span className="text-slate-300">{de?.persona_name || de?.name || 'Unknown'}</span>
                        <span className={`text-[10px] ${eligible ? 'text-emerald-400' : 'text-amber-400'}`}>
                          {eligible ? 'on duty' : (de?.lifecycle_status ?? '')}
                        </span>
                        <button onClick={() => void run(() => supabase.rpc('set_workforce_team_member', { p_team_id: team.id, p_de_id: m.de_id, p_fallback_rank: null }))}
                          disabled={busy}
                          className="ml-auto text-[10px] text-slate-600 hover:text-rose-300">
                          Remove
                        </button>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <select value={addDe[team.id] ?? ''} disabled={busy}
                    onChange={e => setAddDe(prev => ({ ...prev, [team.id]: e.target.value }))}
                    className="flex-1 bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500">
                    <option value="">Add a member…</option>
                    {des.filter(d => !memberIds.has(d.id)).map(d => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                  <button onClick={() => addMember(team.id)} disabled={busy || !addDe[team.id]}
                    className="text-xs px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-40">
                    Add
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// The per-employee detail view groups ~20 panels under these sub-tabs so
// it reads as a profile, not one endless scroll. Order = how you'd get to
// know an employee: who they are → what they can do → how much you trust
// them → how they're growing → the paper trail.
const DETAIL_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'workbench', label: 'Workbench' },
  { key: 'capabilities', label: 'Capabilities' },
  { key: 'trust', label: 'Trust & Autonomy' },
  { key: 'development', label: 'Development' },
  { key: 'governance', label: 'Governance' },
] as const;
type DetailTab = typeof DETAIL_TABS[number]['key'];

export default function LiveWorkforceDEs({ setPage }: { setPage: (p: Page) => void }) {
  const { liveTenantName } = useAuth();
  const [selectedDe, setSelectedDe] = useState<DigitalEmployee | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('overview');
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
  // Reset to the first sub-tab only when a DIFFERENT employee is opened —
  // not on same-employee saves (which replace selectedDe via onUpdated).
  useEffect(() => { setDetailTab('overview'); }, [selectedDe?.id]);

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
      <div className="flex-1 overflow-auto bg-slate-900 p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Digital Employees</h1>
          <p className="text-slate-400 text-sm mt-1">
            {liveTenantName || 'Your company'} · Click an employee to see their profile — trust dial, charter, performance, and more
          </p>
        </div>
        <div className="max-w-3xl">
          <RosterPanel onSelect={setSelectedDe} />
          <TeamsPanel />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto bg-slate-900 p-6">
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
          <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-semibold text-xl">
                {(selectedDe.persona_name || selectedDe.name).charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 flex-wrap">
                  <h2 className="text-base font-semibold text-white">{selectedDe.persona_name || selectedDe.name}</h2>
                  {selectedDe.persona_name && <span className="text-xs text-slate-400">{selectedDe.name}</span>}
                  <span className={`text-xs px-2 py-0.5 rounded-full ${selectedDe.status === 'active' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-700 text-slate-500'}`}>{selectedDe.status}</span>
                  <DeHealthInline deId={selectedDe.id} />
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  {selectedDe.description || 'No description set yet.'}
                </p>
              </div>
            </div>
          </div>

          {/* Sub-tab nav — groups the ~20 panels so this reads as a
              profile, not one endless scroll. flex-wrap (not overflow) so
              it never shows a horizontal scrollbar; on narrow screens the
              tabs wrap to a second row instead. */}
          <div className="flex flex-wrap items-center gap-1 border-b border-slate-700">
            {DETAIL_TABS.map(t => (
              <button
                key={t.key}
                onClick={() => setDetailTab(t.key)}
                className={`px-4 py-2.5 text-sm font-medium rounded-t-lg border-b-2 -mb-px transition-colors ${
                  detailTab === t.key
                    ? 'border-indigo-500 text-white bg-slate-800/40'
                    : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/20'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Overview — who this employee is */}
          {detailTab === 'overview' && (
            <div className="space-y-6">
              <DeIdentityPanel de={selectedDe} onUpdated={setSelectedDe} />
              <DeProfileFieldsPanel de={selectedDe} onUpdated={setSelectedDe} />
              {/* Availability — schedule with team/specialist coverage (DE-C4) */}
              <DeAvailabilityPanel de={selectedDe} onUpdated={setSelectedDe} />
              {/* Performance — real per-DE data */}
              <DePerformancePanel deId={selectedDe.id} />
            </div>
          )}

          {/* Workbench — the live muscles: memory, work queue, reasoning,
              exceptions, certification, training, compliance (migs 155-163) */}
          {detailTab === 'workbench' && (
            <DeWorkbenchPanel deId={selectedDe.id} />
          )}

          {/* Capabilities — what this employee can do and reach */}
          {detailTab === 'capabilities' && (
            <div className="space-y-6">
              {/* AI Engine — per-employee model choice (Wave 1.2) */}
              <DeModelPanel de={selectedDe} onUpdated={setSelectedDe} />
              {/* Customer reply mode — draft vs auto-send for external chat */}
              <DeReplyModePanel de={selectedDe} onUpdated={setSelectedDe} />
              {/* DE operating charter */}
              <OperatingCharterPanel deId={selectedDe.id} setPage={setPage} />
              <DeKnowledgeScopePanel deId={selectedDe.id} />
              {/* The DE-centered hub (2026-07-11 restructure): what this
                  employee can touch (Control Fabric grants) and who it
                  consults (primary/secondary specialists, migration 122) */}
              <DeSystemAccessPanel deId={selectedDe.id} setPage={setPage} />
              <DeSpecialistsPanel deId={selectedDe.id} />
              <DeEscalationPanel deId={selectedDe.id} />
            </div>
          )}

          {/* Development — how this employee is growing */}
          {detailTab === 'development' && (
            <div className="space-y-6">
              <DeSkillsPanel de={selectedDe} />
              <DeKpisPanel de={selectedDe} />
              <DeEconomicsPanel de={selectedDe} />
              <DeCertificationsPanel de={selectedDe} />
              <DeDevelopmentPanel de={selectedDe} />
            </div>
          )}

          {/* Governance — the paper trail, ownership and incidents */}
          {detailTab === 'governance' && (
            <div className="space-y-6">
              {/* Governance — config editing/versioning, ownership/transfer, retirement */}
              <DeGovernancePanel de={selectedDe} onUpdated={setSelectedDe} />
              <DeIncidentsPanel de={selectedDe} setPage={setPage} />
            </div>
          )}

          {/* Trust & Autonomy — lifecycle gate, per-action dial, earned ladder */}
          {detailTab === 'trust' && (
            <div className="space-y-6">
              {/* Lifecycle — the governance gate (DE-B4) */}
              <DeLifecyclePanel de={selectedDe} onUpdated={setSelectedDe} />

          {/* Trust dial */}
          <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6">
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
                  <div key={type} className="rounded-xl border border-slate-700 bg-slate-900/60 p-4">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm text-slate-200 font-medium">{meta.label}</span>
                          {isPersonal[type] ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300" title="This value is set for this employee specifically.">
                              Personal
                            </span>
                          ) : (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-500" title="No personal override — this employee follows the workspace-wide default.">
                              Workspace default
                            </span>
                          )}
                          {rows[type] && exceedsEarned(type, rows[type].enabled, rows[type].max_amount_cents, rows[type].min_confidence) && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300" title="This dial is set above the level the DE has earned from evidence. Still capped by guardrails.">
                              Manual override
                            </span>
                          )}
                          {meta.dormant && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-500" title="Stored now; enforced when the DE brain is activated (R1)">
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
                            className="w-28 bg-slate-800 border border-slate-600 rounded-lg px-2 py-1.5 text-slate-200 text-xs focus:border-indigo-500 focus:outline-none"
                          />
                        </label>
                      ) : (
                        <label className="flex items-center gap-2 text-xs text-slate-400">
                          Min confidence %
                          <input
                            type="number" min={0} max={100} value={d.confidence} placeholder="e.g. 75"
                            onChange={e => setDrafts(prev => ({ ...prev, [type]: { ...d, confidence: e.target.value } }))}
                            className="w-20 bg-slate-800 border border-slate-600 rounded-lg px-2 py-1.5 text-slate-200 text-xs focus:border-indigo-500 focus:outline-none"
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
          <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-6">
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
                  <div key={type} className="rounded-xl border border-slate-700 bg-slate-900/60 p-4">
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
                              <div className="flex-1 h-1.5 rounded-full bg-slate-700 overflow-hidden">
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
      )}
    </div>
  );
}
