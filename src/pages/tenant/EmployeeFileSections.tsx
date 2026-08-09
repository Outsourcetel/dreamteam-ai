// ════════════════════════════════════════════════════════════
// Employee File — the sections.
//
// Split out of LiveWorkforceDEs.tsx unchanged: every declaration below was
// cut and pasted, not rewritten. The roster page and these panels shared
// exactly one declaration (useCanManageDe, imported below) and no state, so
// the two halves were never one page — they were two, in one file.
//
// Rendered by ./EmployeeFilePage. The roster page does NOT import from here.
// ════════════════════════════════════════════════════════════

import { useIsTenantManager, useCanOpenPage } from '../../lib/useRoleGate';
import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../supabase';
import type { Page } from '../../types';
import { fmtMoneyK } from '../../lib/customerApi';
import { getApprovalThresholdCents } from '../../lib/guardrailApi';
import { setAutonomyDial, getApprovalEvidence } from '../../lib/autonomyApi';
import type { ApprovalEvidence } from '../../lib/autonomyApi';
import {
  computeTrustEvidence, requestTrustPromotion, listTrustHistory, listDeTrustSurface,
  seedDeTrustPolicy, setTrustLadder, getDeGateStatus, trustLevelName, earnedLadderSettings,
  TRUST_LADDER_MODE_LABELS, TRUST_LEVEL_LABELS, compileTrustPlan,
} from '../../lib/trustApi';
import type {
  TrustEvidence, TrustHistoryEvent, TrustSurfaceEntry, TrustLadderLevel, TrustLadderMode,
  TrustPlanDraft, TrustPlanCapabilityDraft, TrustPlanSide,
} from '../../lib/trustApi';
import { appendAuditEvent } from '../../lib/guardrailApi';
import { listDefinitions, setDefinitionDeBinding } from '../../lib/playbookBuilderApi';
import type { PlaybookDefinition } from '../../lib/playbookBuilderApi';
import { LiveLoadingSkeleton } from '../../components/LiveDataStates';
import ScopedGuardrails from '../../components/ScopedGuardrails';
import {
  getKpiMetricsForDe, createKpiMetric, recordKpiReading, slugifyKey, listSkillCategories,
  createTenantSkill, getCustomEscalationRules, saveCustomEscalationRules, getEscalationSignals,
  OPERATORS_BY_TYPE,
} from '../../lib/roleConfigApi';
import type {
  KpiMetric, SkillCategory, EscalationRule, EscCondition, EscalationSignal,
} from '../../lib/roleConfigApi';
import { DeCertificationPanel, DeCompliancePanel } from './DeWorkbench';
import ResponsiblePeoplePanel from '../../components/de/ResponsiblePeoplePanel';
import DEActionDials from '../../components/de/DEActionDials';
import { Button, Chip, Banner, EmptyState, Drawer, Field, Modal, INPUT_CLS } from '../../design/primitives';
import {
  listDigitalEmployees, updateDigitalEmployee, getDEConfigHistory, checkDeRetirementReadiness,
  retireDigitalEmployee, listDeConsultationGrants, createDeConsultationGrant,
  setDeConsultationGrantActive, setExternalReplyMode, getDeAnswerSafeguards,
  type DeAnswerSafeguards, setDeAnswerSafeguards, listDeTaskRequests, assignTaskToDe, respondDeTask,
  setDeSupervisor,
} from '../../lib/digitalEmployeesApi';
import type {
  DigitalEmployee, DEConfigHistoryEntry, RetirementReadiness, DEConsultationGrant, DETaskRequest,
} from '../../lib/digitalEmployeesApi';
import {
  listDeDevelopmentItems, detectDeDevelopmentNeeds, createDeDevelopmentItem,
  updateDeDevelopmentItemStatus, listDeImprovementOutcomes,
} from '../../lib/deHealthApi';
import type { DEDevelopmentItem, DEDevelopmentAttempt, DEImprovementOutcome } from '../../lib/deHealthApi';
import { listDocScopes } from '../../lib/knowledgeApi';
import { useCanManageDe } from './LiveWorkforceDEs';

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

interface RowDraft { enabled: boolean; amount: string; confidence: string }

function draftFromDial(d: { enabled: boolean; max_amount_cents: number | null; min_confidence: number | null } | null): RowDraft {
  return {
    enabled: d?.enabled ?? false,
    amount: d?.max_amount_cents != null ? String(Math.round(d.max_amount_cents / 100)) : '',
    confidence: d?.min_confidence != null ? String(d.min_confidence) : '',
  };
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
    <div className="rounded-2xl border border-dt-border bg-dt-card p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Knowledge scope</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-500/15 text-teal-300">control fabric</span>
      </div>
      <p className="text-xs text-dt-muted">
        This employee reads every company-wide document, plus{' '}
        <span className="text-dt-support">{scopedCount === null ? '…' : scopedCount}</span>{' '}
        document{scopedCount === 1 ? '' : 's'} specifically scoped to it.
      </p>
      <p className="mt-3 text-[11px] text-dt-muted">
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
// Exported: rendered on the Employee File's Record tab (docs/31 — incidents
// are the disciplinary half of the employment record, not a governance rule).
export function DeIncidentsPanel({ de, setPage }: { de: DigitalEmployee; setPage: (p: Page) => void }) {
  const canOpenAudit = useCanOpenPage('gov_audit');
  const canManage = useCanManageDe();
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
    : 'bg-dt-panel text-dt-muted';

  return (
    <div className="rounded-2xl border border-dt-border bg-dt-card p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Incidents</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300">durable record</span>
        {openCount > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">{openCount} open</span>}
      </div>
      <p className="text-xs text-dt-muted mb-5">
        Guardrail blocks, automatic trust demotions, failed eval runs, and human-rejected actions —
        captured every 5 minutes as reviewable records. Review or close each with a resolution note;
        every decision is audited.
      </p>
      {error && <p className="text-xs text-rose-300 mb-2">{error}</p>}

      {incidents.length === 0 ? (
        <p className="text-xs text-dt-muted">No incidents on record — a clean history.</p>
      ) : (
        <div className="space-y-1.5">
          {incidents.map(inc => (
            <div key={inc.id} className="rounded-lg bg-dt-inset">
              <button onClick={() => { setOpenId(k => k === inc.id ? null : inc.id); setNote(''); }}
                className="w-full flex items-center gap-3 text-left px-3 py-2 text-xs">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${sevDot(inc.severity)}`} />
                <span className="flex-1 text-dt-support truncate">{inc.title}</span>
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-dt-panel text-dt-muted flex-shrink-0">{INCIDENT_KIND_LABELS[inc.kind] ?? inc.kind}</span>
                {inc.de_id === null && <span className="text-[9px] px-1.5 py-0.5 rounded bg-dt-panel text-dt-muted flex-shrink-0">workspace-wide</span>}
                <span className={`text-[9px] px-1.5 py-0.5 rounded flex-shrink-0 ${statusChip(inc.status)}`}>{inc.status}</span>
                <span className="text-dt-faint flex-shrink-0">{new Date(inc.occurred_at).toLocaleDateString()}</span>
              </button>
              {openId === inc.id && (
                <div className="px-3 pb-3 text-[11px] text-dt-muted space-y-2">
                  {typeof inc.detail?.reasoning === 'string' && <p className="text-dt-support">{inc.detail.reasoning as string}</p>}
                  {typeof inc.detail?.action === 'string' && <p className="text-dt-support">{inc.detail.action as string}</p>}
                  {typeof inc.detail?.request_summary === 'string' && <p className="text-dt-support">{inc.detail.request_summary as string}</p>}
                  {inc.resolution_note && <p>Resolution: <span className="text-dt-support">{inc.resolution_note}</span></p>}
                  <p>Occurred {new Date(inc.occurred_at).toLocaleString()} · provenance-linked to the immutable audit record.</p>
                  {inc.status !== 'closed' && (
                    <div className="pt-1 space-y-2">
                      <input
                        value={note}
                        onChange={e => setNote(e.target.value)}
                        placeholder="Resolution note (optional)"
                        className="w-full bg-dt-card border border-dt-border text-dt-body text-[11px] rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-indigo-500"
                      />
                      <div className="flex gap-2">
                        {inc.status === 'open' && (
                          <button onClick={() => void review(inc.id, 'reviewed')} disabled={busy || !canManage}
                            className="px-2.5 py-1 rounded-lg bg-indigo-600/30 border border-indigo-500/40 text-indigo-300 hover:bg-indigo-600/50 disabled:opacity-50">
                            Mark reviewed
                          </button>
                        )}
                        <button onClick={() => void review(inc.id, 'closed')} disabled={busy || !canManage}
                          className="px-2.5 py-1 rounded-lg bg-dt-panel border border-dt-border-strong text-dt-support hover:bg-dt-panel disabled:opacity-50">
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
      {canOpenAudit && (
        <p className="mt-4 text-xs text-dt-muted">
          <button onClick={() => setPage('gov_audit')} className="text-indigo-400 hover:text-indigo-300 transition-colors">
            View the full Audit Trail →
          </button>
        </p>
      )}
    </div>
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
export function DeSkillsPanel({ de }: { de: DigitalEmployee }) {
  const canManage = useCanManageDe();
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
    <div className="rounded-2xl border border-dt-border bg-dt-card p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Skills</h3><span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-panel text-dt-muted" title="An honest record for your review — nothing reads it to gate or route work yet (truth audit docs/15).">record - not a gate yet</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-500/15 text-teal-300">evidence-assessed</span>
        {/* docs/31 Q8: the add-skill flow shipped in migs 205/206 and was used
            by nobody, ever — because its entry point was an 11px footnote
            link. Same flow, real button, where eyes actually land. */}
        <button onClick={() => setAdding(true)}
          className="ml-auto text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white">
          + Add a skill your business cares about
        </button>
        <button onClick={() => void assess()} disabled={assessing || !canManage}
          className="text-xs px-3 py-1.5 rounded-lg bg-dt-panel hover:bg-dt-panel text-dt-body disabled:opacity-50">
          {assessing ? 'Assessing…' : 'Assess now'}
        </button>
      </div>
      <p className="text-[11px] text-dt-muted mb-3">
        Proficiency is measured from real 30-day evidence, never self-reported. Level 5 (Expert) is
        awarded by a person, not the assessment — so it tops out at Advanced automatically.
      </p>
      {error && <p className="text-xs text-rose-300 mb-2">{error}</p>}
      {skills === null ? (
        <p className="text-xs text-dt-muted">Loading…</p>
      ) : skills.length === 0 ? (
        <p className="text-xs text-dt-muted">No assessment yet — run one with “Assess now”, or add a skill your business cares about and rate it yourself.</p>
      ) : (
        <div className="space-y-3">
          {skills.map(s => {
            const cat = s.category ?? '';
            const assessed = s.proficiency != null;
            return (
              <div key={s.skill_key} className="rounded-xl border border-dt-border bg-dt-page p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-white font-medium">{s.name ?? s.skill_key}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-panel text-dt-support">{catLabel(cat)}</span>
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
                    <span className="ml-auto text-xs text-dt-faint">Not yet assessed</span>
                  )}
                </div>
                {/* proficiency dots 1..5 */}
                {assessed && (
                  <div className="flex gap-1 mt-2">
                    {[1, 2, 3, 4, 5].map(l => (
                      <span key={l} className={`h-1.5 flex-1 rounded-full ${
                        l <= s.proficiency! ? (s.proficiency! >= 4 ? 'bg-emerald-400' : s.proficiency! >= 3 ? 'bg-teal-400' : 'bg-amber-400')
                        : l === 5 ? 'bg-dt-panel border border-dashed border-dt-border-strong' : 'bg-dt-panel'}`} />
                    ))}
                  </div>
                )}
                <p className="text-[11px] text-dt-muted mt-1.5">{s.detail}</p>
                {/* Built-in proficiency stays evidence-only and is never
                    settable by hand; only workspace skills get this. */}
                {s.is_custom && (
                  <div className="flex items-center gap-1.5 mt-2">
                    <span className="text-[10px] text-dt-faint mr-1">Rate:</span>
                    {[1, 2, 3, 4, 5].map(l => (
                      <button key={l} disabled={saving || !canManage}
                        onClick={() => void rateSkill(s.skill_key, l)}
                        className={`text-[10px] w-6 h-6 rounded border transition-colors ${
                          s.proficiency === l
                            ? 'bg-sky-500/20 border-sky-500/50 text-sky-200'
                            : 'border-dt-border text-dt-muted hover:border-dt-border-strong hover:text-dt-support'}`}>
                        {l}
                      </button>
                    ))}
                    {s.proficiency != null && (
                      <button onClick={() => void rateSkill(s.skill_key, null)} disabled={saving || !canManage}
                        className="text-[10px] text-dt-faint hover:text-rose-300 ml-1">Clear</button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {adding && (
        <div className="mt-3 rounded-xl border border-dt-border-strong bg-dt-inset p-3 space-y-2">
          <p className="text-[11px] text-dt-support">
            Add a skill specific to your work. The platform has no way to measure it automatically,
            so you rate it yourself — it will be labelled &ldquo;rated by a person&rdquo; wherever it appears,
            to keep it distinct from the evidence-assessed ones above.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Telecom provisioning"
              className="flex-1 min-w-[180px] bg-dt-card border border-dt-border-strong text-dt-body text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500" />
            <select value={newCat} onChange={e => setNewCat(e.target.value)}
              className="bg-dt-card border border-dt-border-strong text-dt-support text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500">
              {(categories.length ? categories : Object.keys(SKILL_CATEGORY_LABEL).map(k => ({ key: k, label: SKILL_CATEGORY_LABEL[k], sort_order: 0, is_custom: false })))
                .map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </div>
          <div className="flex gap-2">
            <button onClick={() => void addSkill()} disabled={saving || !canManage || !newName.trim()}
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40">
              {saving ? 'Adding…' : 'Add skill'}
            </button>
            <button onClick={() => { setAdding(false); setNewName(''); }}
              className="text-xs text-dt-muted hover:text-dt-support">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Performance reviews panel (DE-C3, migration 129). Quarterly
// performance reviews with honest verdicts (insufficient data is a
// verdict, not a gap to hide). A 'below' review opens a PIP in the
// Development panel below, with a written consequence.
// The human-attestation certifications UI that used to share this panel
// (de_certifications — 0 rows ever written, docs/31 cut list) is gone;
// the real, exam-based certification flow lives in the Workbench's
// Certification tab (role_certifications) and is untouched.
// metrics_snapshot is written by every review and was read by nothing
// (docs/31 Q8 "written-never-read") — its live shape is
// { skills: [{ skill, value, proficiency }], ...metric aggregates }.
type ReviewSkillSnap = { skill: string; value: number | null; proficiency: number | null };
type ReviewRow = {
  id: string; period_start: string; verdict: string; summary: string; status: string; created_at: string;
  metrics_snapshot: { skills?: ReviewSkillSnap[] } | null;
};
export function DeReviewsPanel({ de }: { de: DigitalEmployee }) {
  const canManage = useCanManageDe();
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: r, error: rErr } = await supabase.from('de_performance_reviews')
      .select('id, period_start, verdict, summary, status, created_at, metrics_snapshot')
      .eq('de_id', de.id).order('created_at', { ascending: false }).limit(3);
    if (rErr) { setError(rErr.message); return; }
    setReviews((r ?? []) as ReviewRow[]);
  }, [de.id]);
  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => PromiseLike<{ error: { message: string } | null }>) => {
    setBusy(true); setError(null);
    const { error: err } = await fn();
    if (err) setError(err.message);
    await load();
    setBusy(false);
  };

  return (
    <div className="rounded-2xl border border-dt-border bg-dt-card p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Performance reviews</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-500/15 text-teal-300">real metrics</span>
      </div>
      <p className="text-[11px] text-dt-muted mb-3">
        Quarterly reviews record an honest verdict from real metrics; a below-threshold
        verdict opens an improvement plan with a written consequence.
      </p>
      {error && <p className="text-xs text-rose-300 mb-2">{error}</p>}

      <div className="flex items-center gap-2 mb-1.5">
        <button onClick={() => void run(() => supabase.rpc('run_de_performance_review'))} disabled={busy || !canManage}
          className="ml-auto text-[10px] text-indigo-400 hover:text-indigo-300 disabled:opacity-50">
          {busy ? 'Working…' : 'Run review now'}
        </button>
      </div>
      {reviews.length === 0 ? (
        <p className="text-xs text-dt-muted">No reviews yet — they run quarterly, or on demand.</p>
      ) : (
        <div className="space-y-2">
          {reviews.map(r => (
            <div key={r.id} className="rounded-xl border border-dt-border bg-dt-page p-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                  r.verdict === 'meets' ? 'bg-emerald-500/15 text-emerald-300'
                  : r.verdict === 'below' ? 'bg-amber-500/15 text-amber-300'
                  : 'bg-dt-panel text-dt-support'}`}>
                  {r.verdict === 'insufficient_data' ? 'insufficient data' : r.verdict}
                </span>
                <span className="text-[11px] text-dt-muted">quarter starting {r.period_start}</span>
                {r.status === 'open' ? (
                  <button onClick={() => void run(() => supabase.rpc('acknowledge_de_performance_review', { p_review_id: r.id }))}
                    disabled={busy || !canManage}
                    className="ml-auto text-[10px] text-indigo-400 hover:text-indigo-300">
                    Acknowledge
                  </button>
                ) : (
                  <span className="ml-auto text-[10px] text-dt-faint">acknowledged</span>
                )}
              </div>
              <p className="text-[11px] text-dt-support mt-1.5">{r.summary}</p>
              {/* The skills snapshot each review captures — stored since the
                  first review and rendered nowhere until docs/31 Q10. */}
              {(() => {
                const snaps = r.metrics_snapshot?.skills ?? [];
                if (snaps.length === 0) return null;
                const measured = snaps.filter(s => s.proficiency != null);
                return measured.length === 0 ? (
                  <p className="text-[10px] text-dt-faint mt-1.5">Skills at review time: none were measurable yet.</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {measured.map(s => (
                      <span key={s.skill} className="text-[10px] px-1.5 py-0.5 rounded bg-dt-inset text-dt-support">
                        {s.skill.replace(/_/g, ' ')} · L{s.proficiency}{PROFICIENCY_NAME[s.proficiency!] ? ` ${PROFICIENCY_NAME[s.proficiency!]}` : ''}
                      </span>
                    ))}
                  </div>
                );
              })()}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The two detector kinds the daily program can honestly work (a verified,
// human-approved knowledge fix repairs answers). Run-error and guardrail
// patterns have NO automated fix path — the card says so instead of faking
// coverage.
const MACHINE_WIRED_TYPES: DEDevelopmentItem['item_type'][] = ['confidence_gap', 'escalation_spike'];
const HUMAN_ONLY_DETECTED_TYPES: DEDevelopmentItem['item_type'][] = ['error_rate', 'guardrail_pattern'];

/** Plain-language outcome of one machine attempt, resolved against the
 *  improvement drafts that exist for this DE. */
function attemptLine(a: DEDevelopmentAttempt, outcomes: DEImprovementOutcome[]): string {
  const when = new Date(a.at).toLocaleDateString([], { month: 'short', day: 'numeric' });
  if (a.action === 'no_candidate') {
    const times = a.times && a.times > 1 ? ` (checked ${a.times} mornings)` : '';
    return `${when}: The platform looked for improvable evidence — nothing it could act on yet${times}.`;
  }
  const what = a.action === 'knowledge_gap_refresh'
    ? 'refreshed knowledge on a question this employee could not answer'
    : 'drafted a knowledge fix for a below-standard answer';
  const match = outcomes.find(o =>
    (a.gap_cluster_id && o.gap_cluster_id === a.gap_cluster_id) ||
    (a.judgment_id && o.judgment_id === a.judgment_id));
  const outcome = !match ? 'attempt dispatched, result pending'
    : match.status === 'review_pending' ? `draft "${match.proposed_title ?? 'untitled'}" proved better in replay — waiting your review`
    : match.status === 'approved' ? 'a human approved the draft — applying'
    : match.status === 'applied' ? 'approved and published to this employee’s knowledge'
    : match.status === 'rejected' ? 'a human rejected the draft'
    : match.status === 'failed_replay' ? 'the draft did not prove better in replay — nothing was sent for review'
    : 'drafting and verifying now';
  const shared = a.shared ? ' One draft covers both open signals on this employee.' : '';
  return `${when}: The platform attempted: ${what} — ${outcome}.${shared}`;
}

export function DeDevelopmentPanel({ de }: { de: DigitalEmployee }) {
  const canManage = useCanManageDe();
  const [items, setItems] = useState<DEDevelopmentItem[] | null>(null);
  const [outcomes, setOutcomes] = useState<DEImprovementOutcome[]>([]);
  const [scanning, setScanning] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setItems(await listDeDevelopmentItems(de.id)); } catch { setItems([]); }
    try { setOutcomes(await listDeImprovementOutcomes(de.id)); } catch { setOutcomes([]); }
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
  // docs/31 Q10: a failed PIP used to vanish — the filters didn't know the
  // status existed. It renders now, in red. (The founder decided: this is a
  // PROGRAM — the machine works open confidence/escalation items daily and
  // records every attempt on the item; the two kinds it can't honestly fix
  // are labelled human-only below.)
  const failed = items.filter(i => i.status === 'failed');
  const resolved = items.filter(i => i.status === 'completed' || i.status === 'dismissed');
  const typeLabel = (t: DEDevelopmentItem['item_type'], source: string) =>
    t === 'pip' ? 'PIP' : t === 'skill_gap' ? 'skill gap' : source === 'detected' ? 'detected' : 'manual';
  const fmtDue = (d: string | null) => d ? new Date(d + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' }) : null;

  return (
    <div className="rounded-2xl border border-dt-border bg-dt-card p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Development program</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300">evidence-grounded</span>
      </div>
      <p className="text-xs text-dt-muted mb-4">
        Proposed from real 8-week performance data (escalation rate, confidence, error rate, guardrail patterns) — or added manually.
        The platform works open confidence and escalation items itself each morning: it drafts a knowledge fix, proves it by replay, and a human approves before anything publishes.
        Run-error and guardrail patterns stay with you — no automated fix honestly covers them.
        While one is open, this employee shows as "Improving."
      </p>
      {err && <div className="mb-3 rounded-lg border border-rose-800/50 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{err}</div>}

      <div className="flex gap-2 mb-3">
        <button onClick={scan} disabled={scanning || !canManage} className="text-xs px-3 py-1.5 rounded-lg border border-dt-border-strong text-dt-support hover:bg-dt-panel transition-colors disabled:opacity-50">
          {scanning ? 'Scanning…' : 'Scan for development needs'}
        </button>
        <button onClick={() => setShowAdd(s => !s)} className="text-xs px-3 py-1.5 rounded-lg border border-dt-border-strong text-dt-support hover:bg-dt-panel transition-colors">
          + Add manually
        </button>
      </div>

      {showAdd && (
        <div className="rounded-lg border border-dt-border bg-dt-inset p-3 space-y-2 mb-3">
          <textarea value={desc} onChange={e => setDesc(e.target.value)} rows={2} placeholder="What does this employee need to work on?"
            className="w-full rounded-lg bg-dt-card border border-dt-border px-2 py-1.5 text-xs text-white" />
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowAdd(false)} disabled={busy} className="text-[11px] px-2 py-1 rounded-lg border border-dt-border-strong text-dt-support hover:bg-dt-panel">Cancel</button>
            <button onClick={addManual} disabled={busy || !canManage} className="text-[11px] px-2 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white">{busy ? 'Adding…' : 'Add item'}</button>
          </div>
        </div>
      )}

      {open.length === 0 ? (
        <p className="text-xs text-dt-muted">No open development items — nothing evidence-based flagged, and none added manually.</p>
      ) : (
        <div className="space-y-1.5 mb-3">
          {open.map(item => (
            <div key={item.id} className={`rounded-lg px-3 py-2 text-xs ${item.item_type === 'pip' ? 'bg-amber-500/5 border border-amber-500/30' : 'bg-dt-inset'}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded mr-1.5 ${item.item_type === 'pip' ? 'bg-amber-500/15 text-amber-300' : 'bg-dt-panel text-dt-support'}`}>{typeLabel(item.item_type, item.source)}</span>
                  <span className="text-dt-support">{item.description}</span>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                  {item.status === 'proposed' && (
                    <button onClick={() => setStatus(item.id, 'in_progress')} disabled={busy || !canManage} className="text-[10px] px-2 py-0.5 rounded bg-sky-500/15 text-sky-300 hover:bg-sky-500/25">Start</button>
                  )}
                  <button onClick={() => setStatus(item.id, 'completed')} disabled={busy || !canManage} className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25">Complete</button>
                  <button onClick={() => setStatus(item.id, 'dismissed')} disabled={busy || !canManage} className="text-[10px] px-2 py-0.5 rounded bg-dt-panel text-dt-muted hover:bg-dt-panel">Dismiss</button>
                </div>
              </div>
              {/* A PIP is a formal plan with a deadline and a written consequence
                  — both stored since mig 129 and displayed nowhere until now. */}
              {item.item_type === 'pip' && (item.due_date || item.consequence) && (
                <p className="text-[11px] text-amber-200/80 mt-1.5">
                  {item.due_date && <>Due {fmtDue(item.due_date)}.</>}
                  {item.due_date && item.consequence && ' '}
                  {item.consequence && <>If not met: {item.consequence}</>}
                </p>
              )}
              {/* The machine-attempt trail (docs/31 decision #3). Wired kinds
                  show what the program did, in plain language; the two kinds
                  no driver honestly fixes are labelled human-only. */}
              {item.source === 'detected' && MACHINE_WIRED_TYPES.includes(item.item_type) && (
                (item.attempts?.length ?? 0) > 0 ? (
                  <div className="mt-1.5 space-y-0.5">
                    {(item.attempts ?? []).slice(-3).reverse().map((a, i) => (
                      <p key={i} className="text-[11px] text-sky-200/80">{attemptLine(a, outcomes)}</p>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-dt-faint mt-1.5">No machine attempts recorded yet — the program works this item on its daily cycle.</p>
                )
              )}
              {item.source === 'detected' && HUMAN_ONLY_DETECTED_TYPES.includes(item.item_type) && (
                <p className="text-[11px] text-dt-faint mt-1.5">Human-only: no automated fix path honestly covers this signal — it needs your judgment.</p>
              )}
            </div>
          ))}
        </div>
      )}

      {failed.length > 0 && (
        <div className="space-y-1.5 mb-3">
          {failed.map(item => (
            <div key={item.id} className="rounded-lg border border-rose-800/50 bg-rose-500/10 px-3 py-2 text-xs">
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 mr-1.5">{typeLabel(item.item_type, item.source)} · failed</span>
              <span className="text-rose-200/90">{item.description}</span>
              {item.consequence && <p className="text-[11px] text-rose-300/80 mt-1">Written consequence: {item.consequence}</p>}
              <p className="text-[10px] text-rose-300/60 mt-1">The deadline passed without recovery. The incident this raised is on this employee's record.</p>
            </div>
          ))}
        </div>
      )}

      {resolved.length > 0 && (
        <p className="text-[11px] text-dt-faint">{resolved.length} resolved item{resolved.length === 1 ? '' : 's'} on record.</p>
      )}
    </div>
  );
}

// ── Governance — config editing/versioning, ownership/transfer,
// retirement with real dependency checks (Wave 2, migration 110). ──

function EditDEModal({ de, onClose, onSaved }: { de: DigitalEmployee; onClose: () => void; onSaved: (de: DigitalEmployee) => void }) {
  const canManage = useCanManageDe();
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
        <label className="block text-xs text-dt-support">Name
          <input value={name} onChange={e => setName(e.target.value)} className="mt-1 w-full rounded-lg bg-dt-page border border-dt-border px-3 py-2 text-sm text-white" />
        </label>
        <label className="block text-xs text-dt-support">Persona name (optional)
          <input value={personaName} onChange={e => setPersonaName(e.target.value)} className="mt-1 w-full rounded-lg bg-dt-page border border-dt-border px-3 py-2 text-sm text-white" />
        </label>
        <label className="block text-xs text-dt-support">Description
          <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} className="mt-1 w-full rounded-lg bg-dt-page border border-dt-border px-3 py-2 text-sm text-white" />
        </label>
        <label className="block text-xs text-dt-support">Department
          <input value={department} onChange={e => setDepartment(e.target.value)} className="mt-1 w-full rounded-lg bg-dt-page border border-dt-border px-3 py-2 text-sm text-white" />
        </label>
        <label className="block text-xs text-dt-support">Confidence threshold (0-100)
          <input type="number" min={0} max={100} value={confidenceThreshold} onChange={e => setConfidenceThreshold(e.target.value)} className="mt-1 w-full rounded-lg bg-dt-page border border-dt-border px-3 py-2 text-sm text-white" />
        </label>
        <label className="flex items-center gap-2 text-xs text-dt-support">
          <input type="checkbox" checked={requiredApproval} onChange={e => setRequiredApproval(e.target.checked)} />
          Require human approval by default
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} disabled={busy} className="text-xs px-3 py-1.5 rounded-lg border border-dt-border-strong text-dt-support hover:bg-dt-panel transition-colors disabled:opacity-50">Cancel</button>
          <button onClick={save} disabled={busy || !canManage} className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50">{busy ? 'Saving…' : 'Save changes'}</button>
        </div>
      </div>
    </Modal>
  );
}

function RetireDEModal({ de, onClose, onRetired }: { de: DigitalEmployee; onClose: () => void; onRetired: (de: DigitalEmployee) => void }) {
  const canManage = useCanManageDe();
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
        <p className="text-xs text-dt-support">
          Retirement is terminal — a retired employee cannot be reactivated. Configuration locks read-only and the full history is retained.
        </p>
        {err && <div className="rounded-lg border border-rose-800/50 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{err}</div>}
        {readiness === null ? (
          <p className="text-xs text-dt-muted">Checking for open dependencies…</p>
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
        <label className="block text-xs text-dt-support">Reason for retirement (required)
          <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} className="mt-1 w-full rounded-lg bg-dt-page border border-dt-border px-3 py-2 text-sm text-white" />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} disabled={busy} className="text-xs px-3 py-1.5 rounded-lg border border-dt-border-strong text-dt-support hover:bg-dt-panel transition-colors disabled:opacity-50">Cancel</button>
          <button onClick={confirm} disabled={busy || !readiness?.ready || !canManage} className="text-xs px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white transition-colors disabled:opacity-50">{busy ? 'Retiring…' : 'Retire this employee'}</button>
        </div>
      </div>
    </Modal>
  );
}

// ── Consultations — bounded DE-to-DE delegation (Wave 3, migration
// 111). NOT full Composition: single-hop, governance-gated by an
// explicit allow-list this panel manages. ──────────────────────────
const TASK_STATUS_STYLE: Record<string, string> = {
  requested: 'bg-amber-500/15 text-amber-300',
  accepted: 'bg-indigo-500/15 text-indigo-300',
  in_progress: 'bg-indigo-500/15 text-indigo-300',
  completed: 'bg-emerald-500/15 text-emerald-300',
  failed: 'bg-red-500/15 text-red-300',
  declined: 'bg-slate-600/50 text-dt-support',
};

// T1.2: human view of cross-DE delegation — tasks assigned to / by this DE,
// plus an owner/admin "assign a task" control (the RPC rejects non-admins).
function DelegationPanel({ de }: { de: DigitalEmployee }) {
  const canManage = useCanManageDe();
  const [inbound, setInbound] = useState<DETaskRequest[] | null>(null);
  const [outbound, setOutbound] = useState<DETaskRequest[] | null>(null);
  const [roster, setRoster] = useState<DigitalEmployee[]>([]);
  const [nameById, setNameById] = useState<Record<string, string>>({});
  const [showAdd, setShowAdd] = useState(false);
  const [toId, setToId] = useState('');
  const [title, setTitle] = useState('');
  const [context, setContext] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [tasks, des] = await Promise.all([listDeTaskRequests(de.id), listDigitalEmployees()]);
      setInbound(tasks.inbound); setOutbound(tasks.outbound);
      setRoster(des.filter(d => d.id !== de.id && d.status !== 'retired'));
      setNameById(Object.fromEntries(des.map(d => [d.id, d.persona_name || d.name])));
    } catch (e) { setErr(String(e)); }
  }, [de.id]);
  useEffect(() => { void load(); }, [load]);

  const assign = async () => {
    if (!toId || !title.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await assignTaskToDe(toId, title.trim(), context.trim() || undefined);
      if (!r.ok) { setErr(r.detail || r.error || 'Could not assign the task.'); return; }
      setShowAdd(false); setTitle(''); setContext(''); setToId('');
      await load();
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };
  const respond = async (id: string, status: string) => {
    setBusy(true); setErr(null);
    try { await respondDeTask(id, status); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  const badge = (s: string) => <span className={`text-[10px] px-1.5 py-0.5 rounded ${TASK_STATUS_STYLE[s] || 'bg-slate-600/50 text-dt-support'}`}>{s.replace('_', ' ')}</span>;
  const who = (id: string | null) => id ? (nameById[id] || 'a colleague') : 'You';

  return (
    <div className="mt-4 pt-4 border-t border-dt-border">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold text-dt-title">Delegated tasks</h4>
        <button onClick={() => setShowAdd(s => !s)} className="text-[11px] text-indigo-400 hover:text-indigo-300">{showAdd ? 'Cancel' : '+ Assign a task'}</button>
      </div>
      {err && <p className="text-[11px] text-red-300 mb-2">{err}</p>}
      {showAdd && (
        <div className="bg-dt-card border border-dt-border rounded-lg p-2.5 mb-2 space-y-2">
          <select value={toId} onChange={e => setToId(e.target.value)} className="w-full bg-dt-panel border border-dt-border rounded px-2 py-1 text-xs text-dt-body">
            <option value="">Choose a colleague…</option>
            {roster.map(d => <option key={d.id} value={d.id}>{d.persona_name || d.name}</option>)}
          </select>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Task title" className="w-full bg-dt-panel border border-dt-border rounded px-2 py-1 text-xs text-dt-body" />
          <textarea value={context} onChange={e => setContext(e.target.value)} placeholder="Context (optional)" rows={2} className="w-full bg-dt-panel border border-dt-border rounded px-2 py-1 text-xs text-dt-body" />
          <button onClick={() => void assign()} disabled={busy || !toId || !title.trim() || !canManage} className="text-[11px] px-2.5 py-1 rounded bg-indigo-600 text-white disabled:opacity-50">Assign</button>
          <p className="text-[10px] text-dt-faint">Only workspace owners/admins can assign. The colleague picks it up as their own tracked task under their own governance.</p>
        </div>
      )}
      <p className="text-[10px] uppercase tracking-wide text-dt-faint mb-1">Assigned to {de.persona_name || de.name}</p>
      {inbound && inbound.length === 0 && <p className="text-[11px] text-dt-muted mb-2">Nothing assigned.</p>}
      <div className="space-y-1 mb-3">
        {(inbound ?? []).map(t => (
          <div key={t.id} className="flex items-center gap-2 text-xs text-dt-support">
            <span className="flex-1 truncate">{t.title} <span className="text-dt-faint">· from {who(t.from_de_id)}</span></span>
            {badge(t.status)}
            {['requested', 'accepted', 'in_progress'].includes(t.status) && (
              <>
                <button onClick={() => void respond(t.id, 'completed')} disabled={busy} className="text-[10px] text-emerald-400 hover:text-emerald-200">done</button>
                <button onClick={() => void respond(t.id, 'declined')} disabled={busy} className="text-[10px] text-dt-muted hover:text-dt-support">decline</button>
              </>
            )}
          </div>
        ))}
      </div>
      {(outbound ?? []).length > 0 && (
        <>
          <p className="text-[10px] uppercase tracking-wide text-dt-faint mb-1">Assigned by {de.persona_name || de.name}</p>
          <div className="space-y-1">
            {(outbound ?? []).map(t => (
              <div key={t.id} className="flex items-center gap-2 text-xs text-dt-support">
                <span className="flex-1 truncate">{t.title} <span className="text-dt-faint">· to {who(t.to_de_id)}</span></span>
                {badge(t.status)}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Colleagues & help (docs/31 Q6) — ONE panel writing the ENFORCED table.
// de_consultation_grants is what the runtime actually reads. A grant is
// membership; its category is audit-only — nothing branches on it. The
// specialist half of this panel (the on/off toggle and the ranked
// Primary/Secondary chooser) went with the role; what remains is
// colleague-to-colleague, which is what every grant now means. Granting is
// MANUAL only — auto-grant at hire is founder decision #2, still open.
interface ConsultableRow { target_de_id: string; name: string; grant_kind: string }

function ColleaguesHelpPanel({ de }: { de: DigitalEmployee }) {
  // de_consultation_grants is owner/admin in RLS — deciding which employee
  // may ask another for help is a permissions act. The toggle does not read
  // the row back, so a refusal would have looked like a successful flip
  // that silently reverted on the next load.
  const canEditGrants = useCanManageDe();
  const [consultable, setConsultable] = useState<ConsultableRow[]>([]);
  const [asRequester, setAsRequester] = useState<DEConsultationGrant[] | null>(null);
  const [asTarget, setAsTarget] = useState<DEConsultationGrant[]>([]);
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
      const [{ data: cons, error: consErr }, grants, des, cats] = await Promise.all([
        supabase.rpc('list_consultable_for_de', { p_de_id: de.id }),
        listDeConsultationGrants(de.id),
        listDigitalEmployees(),
        supabase.from('system_categories').select('key').order('key'),
      ]);
      // mig 662 gave this function a can_access_de guard, and a denial RAISES.
      // .rpc() resolves on a Postgres error — swallowing it here would render
      // "no colleagues" for what is actually a refusal.
      if (consErr) throw new Error(consErr.message);
      // supabase.rpc on a json-returning function may hand back the array
      // directly or a JSON string depending on the client — normalise both.
      const consList = typeof cons === 'string' ? JSON.parse(cons) : cons;
      setConsultable((Array.isArray(consList) ? consList : []) as ConsultableRow[]);
      setAsRequester(grants.asRequester);
      setAsTarget(grants.asTarget);
      setRoster(des.filter(d => d.id !== de.id && d.lifecycle_status !== 'retired'));
      setNameById(Object.fromEntries(des.map(d => [d.id, d.persona_name || d.name])));
      setCategories(((cats.data ?? []) as Array<{ key: string }>).map(c => c.key));
    } catch (e) {
      setAsRequester([]); setAsTarget([]);
      setErr(e instanceof Error ? e.message : 'Could not load colleagues & help.');
    }
  }, [de.id]);

  useEffect(() => { void load(); }, [load]);

  // The specialist toggle and the ranked primary/secondary consult desks went
  // with the role. Help is granted colleague-to-colleague below, which is what
  // every live grant now means anyway.

  const addGrant = async () => {
    if (!targetId || !category) { setErr('Choose a colleague and a category.'); return; }
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

  const toggleGrant = async (grant: DEConsultationGrant) => {
    setBusy(true);
    try { await setDeConsultationGrantActive(grant.id, !grant.active); await load(); }
    finally { setBusy(false); }
  };

  const name = de.persona_name || de.name;

  return (
    <div className="rounded-2xl border border-dt-border bg-dt-card p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Who can this employee ask for help?</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-500/15 text-teal-300">governed, single-hop</span>
      </div>
      <p className="text-[11px] text-dt-muted mb-3">
        A governed, one-question handoff to a colleague — the answer comes from the OTHER employee's own
        access, never widening this one's. No chains, no fan-out. Nothing here happens automatically:
        you grant help; {name} may then use it.
      </p>
      {err && <div className="mb-2 rounded-lg border border-rose-800/50 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{err}</div>}

      {asRequester === null ? (
        <p className="text-xs text-dt-muted">Loading…</p>
      ) : (
        <>
          {/* The grants themselves — the CRUD moved here from Governance. */}
          <p className="text-xs text-dt-support mb-1">Help granted:</p>
          {asRequester.length === 0 ? (
            <p className="text-xs text-dt-faint mb-3">No help granted yet — {name} works alone until you grant some.</p>
          ) : (
            <div className="space-y-1 mb-3">
              {asRequester.map(g => (
                <div key={g.id} className="flex items-center justify-between rounded-lg bg-dt-inset px-3 py-1.5 text-xs">
                  <span className="text-dt-support">{nameById[g.target_de_id] || 'Unknown'} <span className="text-dt-faint">· {g.category}</span></span>
                  <button onClick={() => toggleGrant(g)} disabled={busy || !canEditGrants} className={`text-[10px] px-2 py-0.5 rounded ${g.active ? 'bg-emerald-500/15 text-emerald-300' : 'bg-dt-panel text-dt-muted'}`}>
                    {g.active ? 'active' : 'inactive'}
                  </button>
                </div>
              ))}
            </div>
          )}

          {showAdd ? (
            <div className="rounded-lg border border-dt-border bg-dt-inset p-3 space-y-2 mb-3">
              <select value={targetId} onChange={e => setTargetId(e.target.value)} className="w-full rounded-lg bg-dt-card border border-dt-border px-2 py-1.5 text-xs text-white">
                <option value="">Ask which colleague…</option>
                {roster.map(d => <option key={d.id} value={d.id}>{d.persona_name || d.name}</option>)}
              </select>
              <select value={category} onChange={e => setCategory(e.target.value)} className="w-full rounded-lg bg-dt-card border border-dt-border px-2 py-1.5 text-xs text-white">
                <option value="">On which category…</option>
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <div className="flex justify-end gap-2">
                <button onClick={() => setShowAdd(false)} disabled={busy} className="text-[11px] px-2 py-1 rounded-lg border border-dt-border-strong text-dt-support hover:bg-dt-panel">Cancel</button>
                <button onClick={addGrant} disabled={busy || !canEditGrants} className="text-[11px] px-2 py-1 rounded-lg bg-teal-600 hover:bg-teal-500 text-white">{busy ? 'Adding…' : 'Add grant'}</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setShowAdd(true)} className="text-[11px] px-2.5 py-1 rounded-lg border border-dt-border-strong text-dt-support hover:bg-dt-panel mb-3">
              + Grant help from a colleague
            </button>
          )}

          {/* Display truth — what this employee can ACTUALLY reach right now,
              straight from list_consultable_for_de. */}
          {consultable.length > 0 && (
            <div className="mt-1 pt-3 border-t border-dt-border">
              <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-2">Can consult</p>
              <div className="flex flex-wrap gap-1.5">
                {consultable.map(c => (
                  <span key={c.target_de_id}
                    className="text-[11px] px-2 py-1 rounded-lg border bg-dt-panel border-dt-border-strong text-dt-support">
                    {c.name}
                    <span className="text-dt-muted ml-1">peer</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {asTarget.length > 0 && (
            <div className="mt-3">
              <p className="text-xs text-dt-support mb-1">Asked by:</p>
              <div className="space-y-1">
                {asTarget.map(g => (
                  <div key={g.id} className="rounded-lg bg-dt-inset px-3 py-1.5 text-xs text-dt-support">
                    {nameById[g.requester_de_id] || 'Unknown'} <span className="text-dt-faint">· {g.category} · {g.active ? 'active' : 'inactive'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Delegated tasks belong to the same "colleagues" cluster (docs/31 Q6).
          Founder decision #4 (cut vs keep) is OPEN — moved here unchanged. */}
      <DelegationPanel de={de} />
    </div>
  );
}

// ── Consultations & delegations — READ-ONLY audit view for Governance.
// Setup lives on Profile & Capabilities (Colleagues & help); this is the
// record of what actually happened. spec_consultations attributes the
// requester by KIND (employee / playbook / person), not by name — shown
// honestly rather than guessed.
function ConsultationsAuditPanel({ de }: { de: DigitalEmployee }) {
  const [tasks, setTasks] = useState<{ inbound: DETaskRequest[]; outbound: DETaskRequest[] } | null>(null);
  const [nameById, setNameById] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // The specialist consultation log went with the role; what remains is
        // delegation — one employee handing a tracked sub-task to another.
        const [t, des] = await Promise.all([
          listDeTaskRequests(de.id), listDigitalEmployees(),
        ]);
        if (cancelled) return;
        setTasks(t);
        setNameById(Object.fromEntries(des.map(d => [d.id, d.persona_name || d.name])));
      } catch {
        if (!cancelled) setTasks({ inbound: [], outbound: [] });
      }
    })();
    return () => { cancelled = true; };
  }, [de.id]);

  const who = (id: string | null) => id ? (nameById[id] || 'a colleague') : 'You';
  const REQUESTER_LABEL: Record<string, string> = { de: 'an employee', playbook: 'a playbook', human: 'a person' };
  const allTasks = [...(tasks?.inbound ?? []), ...(tasks?.outbound ?? [])]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 6);

  return (
    <div className="mt-4 pt-4 border-t border-dt-border">
      <div className="flex items-center gap-2 mb-1">
        <h4 className="text-xs font-semibold text-dt-title">Consultations & delegations — audit view</h4>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-panel text-dt-muted">read-only</span>
      </div>
      <p className="text-[10px] text-dt-faint mb-2">
        Who asked for help and what came of it. Setup lives on Profile &amp; Capabilities.
      </p>
      {tasks === null ? (
        <p className="text-[11px] text-dt-muted">Loading…</p>
      ) : (
        <>
          {allTasks.length === 0 && (
            <p className="text-[11px] text-dt-muted mb-2">No delegations recorded for this employee yet.</p>
          )}
          {allTasks.length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] uppercase tracking-wide text-dt-faint">Delegated tasks</p>
              {allTasks.map(t => (
                <div key={t.id} className="rounded-lg bg-dt-inset px-3 py-1.5 text-[11px] text-dt-support flex items-center gap-2">
                  <span className="flex-1 truncate">{t.title}</span>
                  <span className="text-dt-faint whitespace-nowrap">{who(t.from_de_id)} → {who(t.to_de_id)} · {t.status.replace('_', ' ')}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DeGovernancePanel({ de, onUpdated }: { de: DigitalEmployee; onUpdated: (de: DigitalEmployee) => void }) {
  const canManage = useCanManageDe();
  const [history, setHistory] = useState<DEConfigHistoryEntry[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [modal, setModal] = useState<'edit' | 'retire' | null>(null);
  const retired = de.lifecycle_status === 'retired';
  const [supBusy, setSupBusy] = useState(false);
  const toggleSupervisor = async (next: boolean) => {
    if (supBusy) return;
    setSupBusy(true);
    try { await setDeSupervisor(de.id, next); onUpdated({ ...de, is_supervisor: next }); }
    catch (e) { console.error('setDeSupervisor', e); }
    finally { setSupBusy(false); }
  };

  const loadHistory = async () => {
    setShowHistory(s => !s);
    if (history === null) {
      try { setHistory(await getDEConfigHistory(de.id)); } catch { setHistory([]); }
    }
  };

  return (
    <div className="rounded-2xl border border-dt-border bg-dt-card p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Governance</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300">config v{de.config_version}</span>
        {retired && <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-panel text-dt-support">retired — read-only</span>}
      </div>
      <p className="text-xs text-dt-muted mb-4">
        Every configuration change on record, who supervises routing, what help was actually used, and how retirement works.
      </p>

      {/* docs/31 Q11: the "Owner" column was a dead limb (0 of 116 DEs ever
          had one; no security rule read it). The real accountability model —
          de_assignments, primary/manager/executive — renders as the
          Responsible people panel at the top of this Governance section. */}

      <div className="flex gap-2 mb-3">
        {!retired && (
          <button onClick={() => setModal('edit')} className="text-xs px-3 py-1.5 rounded-lg border border-dt-border-strong text-dt-support hover:bg-dt-panel transition-colors">
            Edit configuration
          </button>
        )}
        <button onClick={loadHistory} className="text-xs px-3 py-1.5 rounded-lg border border-dt-border-strong text-dt-support hover:bg-dt-panel transition-colors">
          {showHistory ? 'Hide' : 'View'} config history
        </button>
      </div>

      {showHistory && (
        history === null ? (
          <p className="text-xs text-dt-muted">Loading history…</p>
        ) : history.length === 0 ? (
          <p className="text-xs text-dt-muted">No configuration changes on record yet.</p>
        ) : (
          <div className="space-y-1.5">
            {history.map(h => (
              <div key={h.id} className="rounded-lg bg-dt-inset px-3 py-2 text-[11px]">
                <div className="flex items-center gap-2 text-dt-support">
                  <span className="capitalize text-dt-support">{h.operation.toLowerCase()}</span>
                  <span>by {h.actor_name || 'unknown'}</span>
                  <span className="ml-auto text-dt-faint">{new Date(h.created_at).toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {!retired && (
        <div className="mt-4 pt-4 border-t border-dt-border">
          <label className="flex items-center gap-2 text-xs text-dt-support">
            <input type="checkbox" checked={!!de.is_supervisor} disabled={supBusy || !canManage}
              onChange={(e) => void toggleSupervisor(e.target.checked)} />
            <span className="font-semibold text-dt-title">Supervisor / router</span>
          </label>
          {de.is_supervisor && (
            <p className="text-[11px] text-dt-faint mt-1">
              Incoming in-app questions route to the teammate best matched by responsibility, using this employee's consultation grants (Profile &amp; Capabilities → Who can this employee ask for help?). If none match, {de.persona_name || de.name} answers directly.
            </p>
          )}
        </div>
      )}

      {/* Read-only record of consultations & delegations — setup moved to
          Profile & Capabilities (docs/31 Q6); governance keeps the audit. */}
      <ConsultationsAuditPanel de={de} />

      {!retired && (
        <div className="mt-4 pt-4 border-t border-dt-border">
          <button onClick={() => setModal('retire')} className="text-xs px-3 py-1.5 rounded-lg border border-red-900/50 text-red-400 hover:bg-red-950/40 transition-colors">
            Retire this employee
          </button>
          <p className="text-[10px] text-dt-faint mt-1">Retirement runs real dependency checks first — nothing is silently orphaned.</p>
        </div>
      )}

      {modal === 'edit' && <EditDEModal de={de} onClose={() => setModal(null)} onSaved={onUpdated} />}
      {modal === 'retire' && <RetireDEModal de={de} onClose={() => setModal(null)} onRetired={onUpdated} />}
    </div>
  );
}

// ── System access panel — "what this employee can touch" ──────────
// Reads the DE's own data_access_grants (Control Fabric, migration
// 029): per connector/category, at what permission. Read-only here;
// managed centrally under Governance → Data Access.
function DeSystemAccessPanel({ deId, setPage }: { deId: string; setPage: (p: Page) => void }) {
  const canOpenDataAccess = useCanOpenPage('gov_data_access');
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
    <div className="rounded-2xl border border-dt-border bg-dt-card p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">What this employee can touch</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-500/15 text-teal-300">default-deny</span>
      </div>
      <p className="text-[11px] text-dt-muted mb-3">
        System access via the Control Fabric — a grant is necessary, never sufficient, for a write
        (guardrails and approval gates still apply on top).
      </p>
      {grants === null ? (
        <p className="text-xs text-dt-muted">Loading…</p>
      ) : grants.length === 0 ? (
        <p className="text-xs text-dt-muted">No system access granted — this employee can’t search, read, or act on any connected system yet.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {grants.map(g => (
            <span key={g.id} className="text-xs px-2.5 py-1 rounded-lg bg-dt-page border border-dt-border text-dt-support">
              {g.resource_category ?? 'specific connector'}
              <span className={`ml-2 font-semibold ${g.permission === 'write_back' ? 'text-amber-300' : 'text-teal-300'}`}>{g.permission.replace('_', '-')}</span>
            </span>
          ))}
        </div>
      )}
      {canOpenDataAccess && (
        <button onClick={() => setPage('gov_data_access')} className="mt-3 text-xs text-indigo-400 hover:text-indigo-300">
          Manage under Governance → Data Access →
        </button>
      )}
    </div>
  );
}

// (The old "Specialists" panel that lived here — the Primary/Secondary
// matrix writing de_specialist_assignments, a table no runtime path
// reads — was replaced by ColleaguesHelpPanel above, which writes the
// ENFORCED de_consultation_grants table. docs/31 Q6.)

// ── Voice & Conversation panel (migration 325/327). The employee's MANNER,
// kept deliberately separate from Identity & Purpose: identity says who it is,
// this says how it sounds. Facts are untouched either way — every factual claim
// still comes from the knowledge documents, which is what certification grades.
function DeVoicePanel({ de, onUpdated }: { de: DigitalEmployee; onUpdated: (d: DigitalEmployee) => void }) {
  const canManage = useCanManageDe();
  const [voice, setVoice] = useState((de as { voice?: string | null }).voice ?? '');
  const [turns, setTurns] = useState(String((de as { context_turns?: number }).context_turns ?? 8));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true); setError(null);
    const n = parseInt(turns, 10);
    const { data, error: err } = await supabase.rpc('set_de_voice', {
      p_de_id: de.id,
      p_voice: voice.trim(),
      p_context_turns: Number.isFinite(n) ? Math.max(0, Math.min(30, n)) : 8,
    });
    if (err) setError(err.message);
    else { setSaved(true); setTimeout(() => setSaved(false), 2500); if (data) onUpdated(data as DigitalEmployee); }
    setBusy(false);
  };

  return (
    <div className="rounded-2xl border border-dt-border bg-dt-card p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Voice &amp; Conversation</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300">feeds every answer</span>
        {!voice.trim() && <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-page text-dt-muted border border-dt-border">using house voice</span>}
      </div>
      <p className="text-[11px] text-dt-muted mb-3">
        How this employee should <em>sound</em> — tone, warmth, how long its replies run. Leave it blank
        and it uses the house voice: reads the room, matches the person's register, skips the padding.
        This never loosens the facts; every factual claim still comes from the knowledge documents.
      </p>
      {error && <p className="text-xs text-rose-300 mb-2">{error}</p>}
      <div className="space-y-2">
        <textarea value={voice} disabled={busy} onChange={e => setVoice(e.target.value)} rows={3}
          placeholder={'Voice — e.g. Calm and precise. Never more than three sentences unless asked for detail. Plain English, no jargon, no exclamation marks.'}
          className="w-full bg-dt-page border border-dt-border text-dt-body text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-50" />
        <label className="flex items-center gap-2 text-[11px] text-dt-muted">
          <span className="whitespace-nowrap">Remembers the last</span>
          <input type="number" min={0} max={30} value={turns} disabled={busy}
            onChange={e => setTurns(e.target.value)}
            className="w-16 bg-dt-page border border-dt-border text-dt-body text-xs rounded-lg px-2 py-1 focus:outline-none focus:border-indigo-500 disabled:opacity-50" />
          <span>messages of a conversation. 0 answers each message in isolation; higher costs more per reply.</span>
        </label>
      </div>
      <div className="mt-3 flex items-center gap-3">
        {/* set_de_voice is owner/admin-gated in the database. */}
        <button onClick={() => void save()} disabled={busy || !canManage}
          className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Save voice'}
        </button>
        {!canManage && <span className="text-[11px] text-dt-muted">Changing this needs an owner or admin.</span>}
        {saved && <span className="text-xs text-emerald-400">Saved — takes effect on the next answer</span>}
      </div>
    </div>
  );
}

// ── Identity & Purpose panel (DE-C4, migration 130). These fields
// are consumed for real: display_title + purpose_statement feed the
// system prompt of every answer this employee gives (dePersona), and
// responsibilities are a lifecycle identity criterion (126).
function DeIdentityPanel({ de, onUpdated }: { de: DigitalEmployee; onUpdated: (d: DigitalEmployee) => void }) {
  const canManage = useCanManageDe();
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
    <div className="rounded-2xl border border-dt-border bg-dt-card p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Identity & Purpose</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300">feeds every answer</span>
      </div>
      <p className="text-[11px] text-dt-muted mb-3">
        The title and purpose written here go straight into this employee's working instructions —
        every customer answer is given in this identity. Responsibilities also unlock the lifecycle's
        identity criterion.
      </p>
      {error && <p className="text-xs text-rose-300 mb-2">{error}</p>}
      <div className="space-y-2">
        <input type="text" value={title} disabled={busy} onChange={e => setTitle(e.target.value)}
          placeholder="Display title — e.g. Customer Support Specialist"
          className="w-full bg-dt-page border border-dt-border text-dt-body text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-50" />
        <textarea value={purpose} disabled={busy} onChange={e => setPurpose(e.target.value)} rows={2}
          placeholder="Purpose statement — one to three sentences on what this employee exists to do"
          className="w-full bg-dt-page border border-dt-border text-dt-body text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-50" />
        <input type="text" value={outcome} disabled={busy} onChange={e => setOutcome(e.target.value)}
          placeholder="Primary business outcome — e.g. Reduce average resolution time by 40%"
          className="w-full bg-dt-page border border-dt-border text-dt-body text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-50" />
        <textarea value={resp} disabled={busy} onChange={e => setResp(e.target.value)} rows={3}
          placeholder={'Responsibilities — one per line, e.g.\nAnswer customer product questions\nDraft ticket replies for approval'}
          className="w-full bg-dt-page border border-dt-border text-dt-body text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-50" />
        {/* Standard workforce-record fields (migration 136) — org bookkeeping,
            NOT fed into the answering persona. */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input type="text" value={empCode} disabled={busy} onChange={e => setEmpCode(e.target.value)}
            placeholder="Employee code — e.g. DE-0042"
            className="w-full bg-dt-page border border-dt-border text-dt-body text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-50" />
          <input type="text" value={location} disabled={busy} onChange={e => setLocation(e.target.value)}
            placeholder="Location — e.g. HQ / EU region"
            className="w-full bg-dt-page border border-dt-border text-dt-body text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-50" />
          <input type="text" value={costCenter} disabled={busy} onChange={e => setCostCenter(e.target.value)}
            placeholder="Cost center — e.g. CC-SUPPORT"
            className="w-full bg-dt-page border border-dt-border text-dt-body text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-50" />
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        {/* set_de_identity is owner/admin-gated in the database. */}
        <button onClick={() => void save()} disabled={busy || !canManage}
          className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Save identity'}
        </button>
        {!canManage && <span className="text-[11px] text-dt-muted">Changing this needs an owner or admin.</span>}
        {saved && <span className="text-xs text-emerald-400">Saved — takes effect on the next answer</span>}
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
  const canManage = useCanManageDe();
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
    <div className="rounded-2xl border border-dt-border bg-dt-card p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Availability</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-panel text-dt-support">
          {mode === 'always_on' ? 'always on' : 'business hours'}
        </span>
      </div>
      <p className="text-[11px] text-dt-muted mb-3">
        Off-schedule, this employee stops picking up inbox work — its team backup or the specialist
        desk covers, exactly like when it's paused. Reactive Q&A (widget/chat) stays available.
      </p>
      {error && <p className="text-xs text-rose-300 mb-2">{error}</p>}
      <div className="flex items-center gap-2 flex-wrap">
        <select value={mode} disabled={busy} onChange={e => setMode(e.target.value)}
          className="bg-dt-page border border-dt-border text-dt-body text-xs rounded-lg px-2 py-2 focus:outline-none focus:border-indigo-500">
          <option value="always_on">Always on</option>
          <option value="business_hours">Business hours</option>
        </select>
        {mode === 'business_hours' && (
          <>
            <input type="text" value={tz} disabled={busy} onChange={e => setTz(e.target.value)} placeholder="Timezone, e.g. America/New_York"
              className="w-44 bg-dt-page border border-dt-border text-dt-body text-xs rounded-lg px-2 py-2 focus:outline-none focus:border-indigo-500" />
            <input type="number" min={0} max={23} value={startH} disabled={busy} onChange={e => setStartH(e.target.value)} title="Start hour"
              className="w-16 bg-dt-page border border-dt-border text-dt-body text-xs rounded-lg px-2 py-2 focus:outline-none focus:border-indigo-500" />
            <span className="text-xs text-dt-muted">to</span>
            <input type="number" min={1} max={24} value={endH} disabled={busy} onChange={e => setEndH(e.target.value)} title="End hour"
              className="w-16 bg-dt-page border border-dt-border text-dt-body text-xs rounded-lg px-2 py-2 focus:outline-none focus:border-indigo-500" />
          </>
        )}
        {/* set_de_availability is owner/admin-gated in the database. */}
        <button onClick={() => void save()} disabled={busy || !canManage}
          className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Save'}
        </button>
        {!canManage && <span className="text-[11px] text-dt-muted">Changing this needs an owner or admin.</span>}
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
                className={`text-[10px] px-2 py-1 rounded-lg border ${on ? 'border-indigo-500 bg-indigo-500/15 text-indigo-200' : 'border-dt-border bg-dt-page text-dt-faint'}`}>
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
  const canManage = useCanManageDe();
  const [mode, setMode] = useState<'draft' | 'auto'>(de.external_reply_mode === 'auto' ? 'auto' : 'draft');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Wave-2 disclosure (truth audit docs/15): the PUBLIC WIDGET is fronted by
  // ONE employee tenant-wide (oldest auto-send, else oldest eligible) — the
  // same selection widget-ask makes. Without this line, per-employee toggles
  // silently reassign or no-op the widget with no visible cause.
  const [front, setFront] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void supabase.from('digital_employees')
      .select('id, name, persona_name, external_reply_mode, lifecycle_status, created_at')
      .not('lifecycle_status', 'in', '(paused,retired,archived,designed)')
      .order('created_at', { ascending: true }).limit(20)
      .then(({ data }) => {
        if (cancelled) return;
        const f = (data ?? []).find((d) => d.external_reply_mode === 'auto') ?? (data ?? [])[0] ?? null;
        setFront(f ? { id: f.id, name: f.persona_name ?? f.name } : null);
      });
    return () => { cancelled = true; };
  }, [de.id, de.external_reply_mode]);
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
    <div className="rounded-2xl border border-dt-border bg-dt-card p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Customer replies</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300">external chat</span>
      </div>
      <p className="text-[11px] text-dt-support mb-2">How this employee's answers reach customers in the support chat. Guardrails and the confidence floor always apply either way.</p>
      {front && (
        <p className={`text-[11px] mb-4 px-3 py-2 rounded-lg ${front.id === de.id ? 'bg-emerald-500/10 text-emerald-300' : 'bg-dt-inset text-dt-muted'}`}>
          {front.id === de.id
            ? '★ This employee currently fronts your public chat widget — every widget visitor talks to them.'
            : `Your public chat widget is currently fronted by ${front.name} (one employee fronts it for the whole workspace — the oldest set to auto-send). This setting governs this employee's own replies in the dock, and the widget only if they become the front.`}
        </p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {([
          { key: 'draft' as const, title: 'Draft for approval', desc: 'Every answer waits for a teammate to approve before the customer sees it. Safest — start here.' },
          { key: 'auto' as const, title: 'Auto-send', desc: 'Confident, guardrail-clean answers send on their own. Low-confidence ones still go to a human.' },
        ]).map(o => (
          <button
            key={o.key}
            onClick={() => void choose(o.key)}
            disabled={busy || !canManage}
            className={`text-left rounded-xl border p-4 transition-colors disabled:opacity-60 ${mode === o.key ? (o.key === 'auto' ? 'border-emerald-500/60 bg-emerald-500/10' : 'border-indigo-500/60 bg-indigo-500/10') : 'border-dt-border bg-dt-inset hover:border-dt-border-strong'}`}
          >
            <div className="flex items-center gap-2">
              <span className={`w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 ${mode === o.key ? (o.key === 'auto' ? 'border-emerald-400 bg-emerald-400' : 'border-indigo-400 bg-indigo-400') : 'border-dt-border-strong'}`} />
              <span className="text-sm font-medium text-white">{o.title}</span>
            </div>
            <p className="text-[11px] text-dt-support mt-1.5 pl-5">{o.desc}</p>
          </button>
        ))}
      </div>
      {error && <p className="text-[11px] text-rose-400 mt-2">{error}</p>}
    </div>
  );
}

// Governs de-answer — the Workbench, knowledge Q&A, the teammate dock and
// agent-to-agent calls. NOT the customer widget: that is "Customer replies"
// above. The two are separate paths and conflating them is how the wrong
// employee ends up trusted on the wrong surface.
//
// This check could not be switched on by anyone until migrations 554-556: the
// config table it reads did not exist, its writer had an ambiguous ON CONFLICT,
// and the answer-side read looked at `.data` on an array. See migration 554.
function DeAnswerSafeguardsPanel({ de }: { de: DigitalEmployee }) {
  const [cfg, setCfg] = useState<DeAnswerSafeguards | null>(null);   // null = still loading
  const [busy, setBusy] = useState<keyof DeAnswerSafeguards | null>(null);
  const [error, setError] = useState<string | null>(null);
  const who = de.persona_name || de.name;

  useEffect(() => {
    let cancelled = false;
    setCfg(null); setError(null);
    void getDeAnswerSafeguards(de.id)
      .then(s => { if (!cancelled) setCfg(s); })
      .catch(e => {
        if (cancelled) return;
        setError((e as Error)?.message || 'Could not read these settings.');
        // Show the safe reading rather than a blank card, but the error line
        // above says the values are not trustworthy.
        setCfg({ pre_send_audit_enabled: false, reply_mode_enabled: false });
      });
    return () => { cancelled = true; };
  }, [de.id]);

  const choose = async (key: keyof DeAnswerSafeguards, next: boolean) => {
    if (busy || !cfg || next === cfg[key]) return;
    setBusy(key); setError(null);
    const prev = cfg;
    setCfg({ ...cfg, [key]: next });                 // optimistic
    try {
      await setDeAnswerSafeguards(de.id, { [key]: next });
    } catch (err) {
      setCfg(prev);                                  // and honest when it fails
      setError((err as Error)?.message || 'Failed to save.');
    } finally { setBusy(null); }
  };

  const Choice = ({ field, off, on }: {
    field: keyof DeAnswerSafeguards;
    off: { title: string; desc: string };
    on: { title: string; desc: string };
  }) => (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {([{ key: false, ...off }, { key: true, ...on }]).map(o => {
        const active = cfg?.[field] === o.key;
        return (
          <button
            key={String(o.key)}
            onClick={() => void choose(field, o.key)}
            disabled={busy !== null}
            className={`text-left rounded-xl border p-4 transition-colors disabled:opacity-60 ${active ? (o.key ? 'border-emerald-500/60 bg-emerald-500/10' : 'border-dt-border-strong bg-dt-inset') : 'border-dt-border bg-dt-inset hover:border-dt-border-strong'}`}
          >
            <div className="flex items-center gap-2">
              <span className={`w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 ${active ? (o.key ? 'border-emerald-400 bg-emerald-400' : 'border-dt-muted bg-dt-muted') : 'border-dt-border-strong'}`} />
              <span className="text-sm font-medium text-white">{o.title}</span>
            </div>
            <p className="text-[11px] text-dt-support mt-1.5 pl-5">{o.desc}</p>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="rounded-2xl border border-dt-border bg-dt-card p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Answer safeguards</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-inset text-dt-muted">internal answers</span>
      </div>
      <p className="text-[11px] text-dt-support mb-5">
        These cover the Workbench, knowledge questions and the teammate dock. Replies to
        <em> customers</em> are a separate path, governed by Customer replies above.
      </p>

      {cfg === null ? (
        <div className="space-y-5">
          <div className="h-[92px] rounded-xl border border-dt-border bg-dt-inset animate-pulse" />
          <div className="h-[92px] rounded-xl border border-dt-border bg-dt-inset animate-pulse" />
        </div>
      ) : (
        <div className="space-y-5">
          <div>
            <p className="text-xs font-medium text-white mb-2">Approve before sending</p>
            <Choice
              field="reply_mode_enabled"
              off={{ title: 'Send directly', desc: `${who} answers the asker itself once the answer clears guardrails.` }}
              on={{ title: 'Hold for approval', desc: 'Every answer waits as a "Reply to approve" task until a teammate signs it off.' }}
            />
            {cfg.reply_mode_enabled && (
              <p className="text-[11px] text-amber-300/90 mt-2">
                Nobody is answered until someone clears the queue — check Human tasks regularly,
                or {who} will look unresponsive.
              </p>
            )}
          </div>

          <div>
            <p className="text-xs font-medium text-white mb-2">Quality check</p>
            <Choice
              field="pre_send_audit_enabled"
              off={{ title: 'Off', desc: 'Answers send as soon as they clear the confidence floor and guardrails.' }}
              on={{ title: 'Check the sources first', desc: 'A second read checks the answer against the sources it cited. Costs an extra model call.' }}
            />
          </div>
        </div>
      )}

      {(cfg?.reply_mode_enabled || cfg?.pre_send_audit_enabled) && (
        <p className="text-[11px] text-dt-muted mt-4">
          Anything held back lands in Human tasks — the same queue escalations use, so
          nothing waits somewhere nobody looks.
        </p>
      )}
      {error && <p className="text-[11px] text-rose-400 mt-2">{error}</p>}
    </div>
  );
}

function DeModelPanel({ de, onUpdated }: { de: DigitalEmployee; onUpdated: (d: DigitalEmployee) => void }) {
  const canManage = useCanManageDe();
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
    <div className="rounded-2xl border border-dt-border bg-dt-card p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">AI Engine</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-panel text-dt-support">
          {de.model_id && MODEL_LABELS[de.model_id] ? de.model_id : 'platform default'}
        </span>
      </div>
      <p className="text-[11px] text-dt-muted mb-3">
        The Claude model this employee thinks with. Every listed model has verified pricing, so the
        Economics and cost numbers stay real whichever you choose. Takes effect on the next answer.
      </p>
      {error && <p className="text-xs text-rose-300 mb-2">{error}</p>}
      <div className="flex items-center gap-2 flex-wrap">
        <select value={selected} disabled={busy} onChange={e => setSelected(e.target.value)}
          className="flex-1 min-w-[260px] bg-dt-page border border-dt-border text-dt-body text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-50">
          {models.map(m => (
            <option key={m.model_id} value={m.model_id}>
              {MODEL_LABELS[m.model_id] ?? m.model_id} · ${m.input_price_per_million}/{'$'}{m.output_price_per_million} per M tokens
            </option>
          ))}
        </select>
        <button onClick={() => void save()} disabled={busy || !canManage || selected === (de.model_id || 'claude-sonnet-5')}
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
export function DeKpisPanel({ de }: { de: DigitalEmployee }) {
  const canManage = useCanManageDe();
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
      // Role-aware: metrics that suit this employee's domain come first (mig 263).
      const list = await getKpiMetricsForDe(de.id);
      setMetrics(list);
      const firstApplicable = list.find(m => m.applicable !== false) ?? list[0];
      setMetricKey(prev => (prev && list.some(m => m.metric_key === prev)) ? prev : (firstApplicable?.metric_key ?? ''));
    } catch (e) { setError((e as Error).message); }
  }, [de.id]);

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
    <div className="rounded-2xl border border-dt-border bg-dt-card p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Goals & KPIs</h3><span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-panel text-dt-muted" title="An honest record for your review — nothing reads it to gate or route work yet (truth audit docs/15).">record - not a gate yet</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-500/15 text-teal-300">measured live</span>
      </div>
      <p className="text-[11px] text-dt-muted mb-3">
        Targets you set against metrics this workspace tracks. Built-in metrics are computed from real
        activity at view time — never stored, stale, or invented. Metrics you define yourself show a
        value once you record a reading.
      </p>
      {error && <p className="text-xs text-rose-300 mb-2">{error}</p>}
      {kpis === null ? (
        <p className="text-xs text-dt-muted">Loading…</p>
      ) : kpis.length === 0 ? (
        <p className="text-xs text-dt-muted mb-3">No KPIs set yet.</p>
      ) : (
        <div className="space-y-1.5 mb-3">
          {kpis.map(k => {
            // docs/31 Q9 quick win: units are STORED on the metric catalog and
            // were never rendered — "92% / target ≥ 95%", not two bare numbers.
            // Client-side join against the already-loaded metrics list; the
            // shared RPC (get_de_kpi_status, also read by LiveOutcomesPage)
            // stays untouched.
            const metric = metrics.find(m => m.metric_key === k.metric_key);
            const u = metric?.unit ?? '';
            const withUnit = (v: number | null) => v === null ? '—' : u === '%' ? `${v}%` : u ? `${v} ${u}` : String(v);
            return (
            <div key={k.kpi_id} className="flex items-center gap-2 text-xs flex-wrap">
              <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                k.met === null ? 'bg-dt-panel text-dt-muted'
                : k.met ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>
                {k.met === null ? 'no data yet' : k.met ? 'on target' : 'off target'}
              </span>
              <span className="text-dt-support">{k.name}</span>
              <span className="text-dt-muted">
                {withUnit(k.current)} / target {k.direction === 'higher' ? '≥' : '≤'} {withUnit(k.target)}
                {k.sample > 0 ? ` · ${k.sample} sampled` : ''}
              </span>
              {/* Where the number comes from — measured by the platform, or
                  typed in by a person (the metric catalog knows). */}
              {metric && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-panel text-dt-faint">
                  {metric.source === 'manual' ? 'you record this' : metric.source === 'action' ? 'auto from actions' : 'auto-tracked'}
                </span>
              )}
              {/* Manual metrics need somebody to record the number — without
                  this they would sit at "—" forever and look broken. */}
              {metric?.source === 'manual' && (
                <button onClick={() => { setReading({ key: k.metric_key, name: k.name }); setReadingValue(''); }}
                  disabled={busy || !canManage}
                  className="text-[10px] text-indigo-400 hover:text-indigo-300">
                  Record value
                </button>
              )}
              <button onClick={() => void run(() => supabase.rpc('set_de_kpi', { p_de_id: de.id, p_metric_key: k.metric_key, p_name: k.name, p_target: null, p_direction: k.direction }))}
                disabled={busy || !canManage}
                className="ml-auto text-[10px] text-dt-faint hover:text-rose-300">
                Remove
              </button>
            </div>
            );
          })}
        </div>
      )}

      {reading && (
        <div className="mb-3 rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-3 space-y-2">
          <p className="text-xs text-dt-support">Record a value for <span className="font-medium">{reading.name}</span></p>
          <div className="flex items-center gap-2">
            <input type="number" value={readingValue} autoFocus disabled={!canManage}
              onChange={e => setReadingValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void saveReading(); }}
              placeholder="Value"
              className="w-32 bg-dt-page border border-dt-border text-dt-body text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500" />
            <button onClick={() => void saveReading()} disabled={busy || !canManage || readingValue.trim() === ''}
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40">Save</button>
            <button onClick={() => setReading(null)} className="text-xs text-dt-muted hover:text-dt-support">Cancel</button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <select value={metricKey} disabled={busy || metrics.length === 0} onChange={e => setMetricKey(e.target.value)}
          className="flex-1 bg-dt-page border border-dt-border text-dt-support text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500">
          {(() => {
            const label = (m: KpiMetric) => `${m.label}${m.unit ? ` (${m.unit})` : ''}${m.source === 'manual' ? ' — you record this' : m.source === 'action' ? ' — auto from actions' : ''}`;
            const opt = (m: KpiMetric) => <option key={m.metric_key} value={m.metric_key}>{label(m)}</option>;
            const suited = metrics.filter(m => m.applicable !== false);
            const other = metrics.filter(m => m.applicable === false);
            // Only split into groups when role-awareness actually distinguishes them.
            if (other.length === 0) return metrics.map(opt);
            return [
              <optgroup key="suited" label="Suited to this role">{suited.map(opt)}</optgroup>,
              <optgroup key="other" label="Other metrics">{other.map(opt)}</optgroup>,
            ];
          })()}
        </select>
        <input type="number" value={target} disabled={busy || !canManage} onChange={e => setTarget(e.target.value)} placeholder="Target"
          className="w-24 bg-dt-page border border-dt-border text-dt-body text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500" />
        <button onClick={add} disabled={busy || !canManage || target.trim() === '' || !selected}
          className="text-xs px-3 py-1.5 rounded-lg bg-dt-panel hover:bg-dt-panel text-dt-body disabled:opacity-40">
          Add KPI
        </button>
      </div>

      {!defining ? (
        <button onClick={() => setDefining(true)} className="mt-2 text-[11px] text-indigo-400 hover:text-indigo-300">
          + Track a metric of your own
        </button>
      ) : (
        <div className="mt-3 rounded-xl border border-dt-border-strong bg-dt-inset p-3 space-y-2">
          <p className="text-[11px] text-dt-support">
            Define a measure that matters to your business. The platform can&apos;t compute it, so you record the value yourself.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="e.g. First-call resolution"
              className="flex-1 min-w-[180px] bg-dt-card border border-dt-border-strong text-dt-body text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500" />
            <input value={newUnit} onChange={e => setNewUnit(e.target.value)} placeholder="Unit (%, hrs)"
              className="w-28 bg-dt-card border border-dt-border-strong text-dt-body text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500" />
            <select value={newDir} onChange={e => setNewDir(e.target.value as 'higher' | 'lower')}
              className="bg-dt-card border border-dt-border-strong text-dt-support text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500">
              <option value="higher">Higher is better</option>
              <option value="lower">Lower is better</option>
            </select>
          </div>
          {newLabel.trim() && (
            <p className="text-[10px] text-dt-faint">Saved as <code>{slugifyKey(newLabel)}</code></p>
          )}
          <div className="flex gap-2">
            <button onClick={() => void defineMetric()} disabled={busy || !canManage || !newLabel.trim()}
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40">Create</button>
            <button onClick={() => { setDefining(false); setNewLabel(''); setNewUnit(''); }}
              className="text-xs text-dt-muted hover:text-dt-support">Cancel</button>
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
export function DeEconomicsPanel({ de }: { de: DigitalEmployee }) {
  const canManage = useCanManageDe();
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
    <div className="rounded-2xl border border-dt-border bg-dt-card p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Economics</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-500/15 text-teal-300">your baselines, never estimated</span>
        <button onClick={() => setShowConfig(s => !s)}
          className="ml-auto text-xs px-3 py-1.5 rounded-lg bg-dt-panel hover:bg-dt-panel text-dt-body">
          {showConfig ? 'Cancel' : 'Baselines…'}
        </button>
      </div>
      <p className="text-[11px] text-dt-muted mb-3">
        Work counts and AI cost are always real. Hours saved, FTE equivalent, and ROI are computed
        only from baselines <span className="text-dt-support">you</span> configure — how long a human
        takes per task and what a human FTE costs. The platform never invents these.
      </p>
      {error && <p className="text-xs text-rose-300 mb-2">{error}</p>}

      {showConfig && (
        <div className="mb-4 rounded-xl border border-dt-border bg-dt-page p-3 space-y-2">
          <p className="text-[10px] uppercase tracking-wide text-amber-300/80">Workspace-wide — applies to every employee</p>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] text-dt-muted">Human minutes per inbox item
              <input type="number" min={0.1} step={0.5} value={inqMin} disabled={busy || !canManage} onChange={e => setInqMin(e.target.value)} placeholder="e.g. 6"
                className="mt-0.5 w-full bg-dt-card border border-dt-border text-dt-body text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500" />
            </label>
            <label className="text-[11px] text-dt-muted">Human minutes per action
              <input type="number" min={0.1} step={0.5} value={actMin} disabled={busy || !canManage} onChange={e => setActMin(e.target.value)} placeholder="e.g. 8"
                className="mt-0.5 w-full bg-dt-card border border-dt-border text-dt-body text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500" />
            </label>
            <label className="text-[11px] text-dt-muted">Human minutes per conversation
              <input type="number" min={0.1} step={0.5} value={convMin} disabled={busy || !canManage} onChange={e => setConvMin(e.target.value)} placeholder="e.g. 4"
                className="mt-0.5 w-full bg-dt-card border border-dt-border text-dt-body text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500" />
            </label>
            <label className="text-[11px] text-dt-muted">Human FTE cost / month (USD, fully loaded)
              <input type="number" min={1} value={fteCost} disabled={busy || !canManage} onChange={e => setFteCost(e.target.value)} placeholder="e.g. 6000"
                className="mt-0.5 w-full bg-dt-card border border-dt-border text-dt-body text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500" />
            </label>
          </div>
          <button onClick={() => void saveBaselines()} disabled={busy || !canManage}
            className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50">
            {busy ? 'Saving…' : 'Save baselines'}
          </button>
        </div>
      )}

      {eco === null ? (
        <p className="text-xs text-dt-muted">Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
            <div className="rounded-xl border border-dt-border bg-dt-page p-3">
              <p className="text-[10px] uppercase tracking-wide text-dt-muted">Work · 30 days</p>
              <p className="text-sm text-white font-semibold mt-1">
                {eco.counts.inquiries_handled + eco.counts.actions_executed + eco.counts.conversations_answered}
              </p>
              <p className="text-[10px] text-dt-faint">{eco.counts.inquiries_handled} inbox · {eco.counts.actions_executed} actions · {eco.counts.conversations_answered} conv.</p>
            </div>
            <div className="rounded-xl border border-dt-border bg-dt-page p-3">
              <p className="text-[10px] uppercase tracking-wide text-dt-muted">AI cost</p>
              <p className="text-sm text-white font-semibold mt-1">{money(eco.de_cost_usd)}</p>
              <p className="text-[10px] text-dt-faint">real token spend</p>
            </div>
            <div className="rounded-xl border border-dt-border bg-dt-page p-3">
              <p className="text-[10px] uppercase tracking-wide text-dt-muted">Hours saved</p>
              <p className="text-sm text-white font-semibold mt-1">{eco.hours_saved ?? '—'}</p>
              <p className="text-[10px] text-dt-faint">{eco.fte_equivalent !== null ? `${eco.fte_equivalent} FTE equivalent` : 'configure to calculate'}</p>
            </div>
            <div className="rounded-xl border border-dt-border bg-dt-page p-3">
              <p className="text-[10px] uppercase tracking-wide text-dt-muted">ROI</p>
              <p className="text-sm text-white font-semibold mt-1">{eco.roi_ratio !== null ? `${eco.roi_ratio}x` : '—'}</p>
              <p className="text-[10px] text-dt-faint">
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
  const canManage = useCanManageDe();
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
    <div className="rounded-2xl border border-dt-border bg-dt-card p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Lifecycle</h3>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${
          isOperational ? 'bg-emerald-500/15 text-emerald-300'
          : isPaused ? 'bg-amber-500/15 text-amber-300'
          : isClosed ? 'bg-dt-panel text-dt-muted'
          : 'bg-indigo-500/15 text-indigo-300'}`}>
          {STAGE_LABELS[stage] ?? stage}
        </span>
      </div>
      <p className="text-[11px] text-dt-muted mb-3">
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
              : chainIdx >= 0 && i < chainIdx ? 'border-dt-border bg-dt-page text-emerald-400'
              : 'border-dt-border bg-dt-page text-dt-faint'}`}>
              {chainIdx >= 0 && i < chainIdx ? '✓ ' : ''}{STAGE_LABELS[s]}
            </span>
            {i < LIFECYCLE_CHAIN.length - 1 && <span className="text-dt-faint text-[10px]">→</span>}
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
          <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-1.5">
            To reach {STAGE_LABELS[nextStage]}
          </p>
          <div className="space-y-1">
            {criteriaEntries.map(([k, met]) => (
              <p key={k} className={`text-xs ${met ? 'text-emerald-400' : 'text-dt-support'}`}>
                {met ? '✓' : '○'} {k.split('_').join(' ')}
              </p>
            ))}
            {typeof nextCriteria.detail === 'string' && (
              <p className="text-[10px] text-dt-faint mt-1">{nextCriteria.detail}</p>
            )}
          </div>
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            {nextStage === 'certified' && (
              <input
                type="text" value={note} disabled={busy}
                onChange={e => setNote(e.target.value)}
                placeholder="Certification note — what did you review?"
                className="flex-1 min-w-[220px] bg-dt-page border border-dt-border text-dt-body text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
              />
            )}
            <button
              onClick={() => void run(() => supabase.rpc('advance_de_lifecycle', { p_de_id: de.id, p_to_stage: nextStage, p_note: note.trim() || null }))}
              disabled={busy || !canManage || !allMet || (nextStage === 'certified' && !note.trim())}
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40">
              {busy ? 'Working…' : nextStage === 'certified' ? 'Certify' : `Advance to ${STAGE_LABELS[nextStage]}`}
            </button>
            {!allMet && <span className="text-[10px] text-dt-faint">Criteria above must be met first.</span>}
            {!canManage && <span className="text-[10px] text-dt-faint">Only an owner or admin can move an employee through its stages.</span>}
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
            className="flex-1 min-w-[220px] bg-dt-page border border-dt-border text-dt-body text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-amber-500 disabled:opacity-50"
          />
          {/* Stopping or restarting an employee is owner/admin in the database.
              Offering it to anyone else produced an error, not a pause. */}
          {isPaused ? (
            <button
              onClick={() => void run(() => supabase.rpc('resume_digital_employee', { p_de_id: de.id, p_note: note.trim() }))}
              disabled={busy || !canManage || !note.trim()}
              className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40">
              Resume
            </button>
          ) : (
            <button
              onClick={() => void run(() => supabase.rpc('pause_digital_employee', { p_de_id: de.id, p_reason: note.trim() }))}
              disabled={busy || !canManage || !note.trim()}
              className="text-xs px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-40">
              Pause
            </button>
          )}
          {!canManage && <span className="text-[11px] text-dt-muted">Pausing or restarting needs an owner or admin.</span>}
        </div>
      )}

      {/* Recent transitions */}
      {events.length > 0 && (
        <div>
          <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-1.5">Recent transitions</p>
          <div className="space-y-1">
            {events.map(ev => (
              <p key={ev.id} className="text-[11px] text-dt-muted">
                <span className="text-dt-support">{STAGE_LABELS[ev.from_stage] ?? ev.from_stage} → {STAGE_LABELS[ev.to_stage] ?? ev.to_stage}</span>
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
export function DeEscalationPanel({ deId }: { deId: string }) {
  const canManage = useCanManageDe();
  const [deRow, setDeRow] = useState<EscalationRow | null>(null);
  const [tenantRow, setTenantRow] = useState<EscalationRow | null>(null);
  const [threshold, setThreshold] = useState('');
  const [topics, setTopics] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Named rules with generic conditions (mig 262 custom_rules).
  const [customRules, setCustomRules] = useState<EscalationRule[]>([]);
  const [signals, setSignals] = useState<EscalationSignal[]>([]);
  const [ruleName, setRuleName] = useState('');
  const [ruleAction, setRuleAction] = useState<'escalate' | 'require_approval'>('escalate');
  const [ruleMatch, setRuleMatch] = useState<'all' | 'any'>('all');
  const [conds, setConds] = useState<EscCondition[]>([{ signal: '', op: '', value: '' }]);

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
    void getEscalationSignals().then(setSignals).catch(() => { /* stays empty */ });
  }, [deId]);

  const sigOf = (key: string) => signals.find(s => s.key === key);
  const setCond = (i: number, patch: Partial<EscCondition>) =>
    setConds(cs => cs.map((c, j) => j === i ? { ...c, ...patch } : c));
  const readyConds = conds.filter(c => c.signal && c.op && (c.value !== '' || c.op === 'is_true' || c.op === 'is_false'));

  const addRule = () => {
    const name = ruleName.trim();
    if (!name || readyConds.length === 0) return;
    // Coerce values by the signal's type so the evaluator compares correctly.
    const conditions: EscCondition[] = readyConds.map(c => {
      const t = sigOf(c.signal)?.value_type;
      const value = t === 'number' ? Number(c.value) : t === 'boolean' ? (c.op === 'is_true') : String(c.value);
      return { signal: c.signal, op: c.op, value };
    });
    void persistRules([...customRules, { name, action: ruleAction, enabled: true, match: ruleMatch, conditions }]);
    setRuleName(''); setRuleMatch('all'); setConds([{ signal: '', op: '', value: '' }]);
  };

  // Render a rule's conditions (or a legacy keyword row) in plain language.
  const describeRule = (r: EscalationRule): string => {
    if (r.conditions?.length) {
      return r.conditions.map(c => {
        const s = sigOf(c.signal); const opLabel = OPERATORS_BY_TYPE[s?.value_type ?? 'text']?.find(o => o.op === c.op)?.label ?? c.op;
        return `${s?.label ?? c.signal} ${opLabel}${c.op === 'is_true' || c.op === 'is_false' ? '' : ` ${c.value}`}`;
      }).join(r.match === 'any' ? '  OR  ' : '  AND  ');
    }
    return r.when ? `message contains "${r.when}"` : '—';
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
    <div className="rounded-2xl border border-dt-border bg-dt-card p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Escalation rules</h3>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${isPersonal ? 'bg-indigo-500/15 text-indigo-300' : 'bg-dt-panel text-dt-support'}`}>
          {isPersonal ? 'personal' : 'workspace default'}
        </span>
      </div>
      <p className="text-[11px] text-dt-muted mb-3">
        When this employee hands work to a human no matter how confident it is. Guardrails always
        outrank these; the confidence floor lives on the trust dial below.
      </p>
      {error && <p className="text-xs text-rose-300 mb-2">{error}</p>}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-1">Frustration threshold</p>
          <input
            type="number" min={0} max={100} value={threshold} disabled={busy || !canManage}
            onChange={e => setThreshold(e.target.value)}
            placeholder={`inherited (${tenantRow?.frustration_threshold ?? 50})`}
            className="w-full bg-dt-page border border-dt-border text-dt-body text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
          />
          <p className="text-[10px] text-dt-faint mt-1">
            A customer scoring ≥ {effectiveThreshold}% on frustration signals always gets a human. Blank = inherit.
          </p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-1">Always-escalate topics</p>
          <input
            type="text" value={topics} disabled={busy || !canManage}
            onChange={e => setTopics(e.target.value)}
            placeholder="e.g. refund, contract renewal"
            className="w-full bg-dt-page border border-dt-border text-dt-body text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
          />
          <p className="text-[10px] text-dt-faint mt-1">
            Comma-separated phrases — any match routes to a human regardless of confidence.
            {effectiveTopics.length > 0 && !isPersonal ? ` Inherited: ${effectiveTopics.join(', ')}.` : ''}
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button onClick={() => void save()} disabled={busy || !canManage}
          className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="text-xs text-emerald-400">Saved</span>}
        {isPersonal && (
          <span className="text-[10px] text-dt-faint">Clear both fields and save to fall back to the workspace default.</span>
        )}
      </div>

      {/* Named rules in your own words. The two fields above cover the two
          cases the platform can detect on its own; this covers everything
          specific to how your business actually works. */}
      <div className="mt-5 pt-4 border-t border-dt-border">
        <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-1">Your own rules</p>
        <p className="text-[10px] text-dt-faint mb-3">
          Describe a situation in plain language and say what should happen. Applied alongside the
          settings above — guardrails still outrank everything here.
        </p>

        {customRules.length > 0 && (
          <div className="space-y-1.5 mb-3">
            {customRules.map((r, i) => (
              <div key={i} className="flex items-start gap-2 text-xs rounded-lg border border-dt-border bg-dt-page px-3 py-2">
                <input type="checkbox" checked={r.enabled} disabled={busy || !canManage}
                  onChange={() => void persistRules(customRules.map((x, j) => j === i ? { ...x, enabled: !x.enabled } : x))}
                  className="mt-0.5 accent-indigo-500" />
                <div className="min-w-0 flex-1">
                  <span className={r.enabled ? 'text-dt-body' : 'text-dt-muted line-through'}>{r.name}</span>
                  <p className="text-[10px] text-dt-muted mt-0.5 font-mono">{describeRule(r)}</p>
                </div>
                <span className={`text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap ${
                  r.action === 'escalate' ? 'bg-amber-500/15 text-amber-300' : 'bg-sky-500/15 text-sky-300'}`}>
                  {r.action === 'escalate' ? 'hand to a human' : 'needs approval'}
                </span>
                <button onClick={() => void persistRules(customRules.filter((_, j) => j !== i))} disabled={busy || !canManage}
                  className="text-[10px] text-dt-faint hover:text-rose-300">Remove</button>
              </div>
            ))}
          </div>
        )}

        {/* Generic condition builder — signals come from the catalog, so a
            support DE composes message/confidence conditions and a finance DE
            composes amount conditions with the same tool. */}
        <div className="rounded-lg border border-dt-border bg-dt-page p-3 space-y-2">
          <input value={ruleName} disabled={busy || !canManage} onChange={e => setRuleName(e.target.value)}
            placeholder="Rule name — e.g. Large payment, Legal threat"
            className="w-full bg-dt-card border border-dt-border text-dt-body text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500" />

          <p className="text-[10px] uppercase tracking-wide text-dt-muted">Escalate when {conds.length > 1 ? (
            <select value={ruleMatch} onChange={e => setRuleMatch(e.target.value as 'all' | 'any')}
              className="bg-dt-card border border-dt-border text-dt-support text-[10px] rounded px-1 py-0.5 focus:outline-none">
              <option value="all">all</option><option value="any">any</option>
            </select>
          ) : 'these are true'}{conds.length > 1 ? ' of these are true' : ''}</p>

          {conds.map((c, i) => {
            const sType = sigOf(c.signal)?.value_type;
            const ops = OPERATORS_BY_TYPE[sType ?? ''] ?? [];
            const boolOp = c.op === 'is_true' || c.op === 'is_false';
            return (
              <div key={i} className="flex items-center gap-1.5 flex-wrap">
                <select value={c.signal} disabled={busy || !canManage}
                  onChange={e => setCond(i, { signal: e.target.value, op: '', value: '' })}
                  className="bg-dt-card border border-dt-border text-dt-body text-xs rounded-lg px-2 py-2 focus:outline-none focus:border-indigo-500">
                  <option value="">Pick a signal…</option>
                  {signals.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
                <select value={c.op} disabled={busy || !c.signal}
                  onChange={e => setCond(i, { op: e.target.value })}
                  className="bg-dt-card border border-dt-border text-dt-support text-xs rounded-lg px-2 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-40">
                  <option value="">condition…</option>
                  {ops.map(o => <option key={o.op} value={o.op}>{o.label}</option>)}
                </select>
                {!boolOp && (
                  <input value={String(c.value)} disabled={busy || !c.op}
                    onChange={e => setCond(i, { value: e.target.value })}
                    inputMode={sType === 'number' ? 'numeric' : 'text'}
                    placeholder={sType === 'number' ? 'value' : 'text…'}
                    className="w-28 bg-dt-card border border-dt-border text-dt-body text-xs rounded-lg px-2 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-40" />
                )}
                {sigOf(c.signal)?.help && <span className="text-[10px] text-dt-faint">{sigOf(c.signal)!.help}</span>}
                {conds.length > 1 && (
                  <button onClick={() => setConds(cs => cs.filter((_, j) => j !== i))} className="text-[10px] text-dt-faint hover:text-rose-300">×</button>
                )}
              </div>
            );
          })}

          <div className="flex items-center gap-2 flex-wrap pt-1">
            <button onClick={() => setConds(cs => [...cs, { signal: '', op: '', value: '' }])} disabled={busy || !canManage}
              className="text-[11px] text-dt-support hover:text-dt-body">+ add a condition</button>
            <div className="ml-auto flex items-center gap-2">
              <select value={ruleAction} disabled={busy || !canManage} onChange={e => setRuleAction(e.target.value as 'escalate' | 'require_approval')}
                className="bg-dt-card border border-dt-border text-dt-support text-xs rounded-lg px-2 py-2 focus:outline-none focus:border-indigo-500">
                <option value="escalate">Hand to a human</option>
                <option value="require_approval">Needs approval first</option>
              </select>
              <button onClick={addRule} disabled={busy || !ruleName.trim() || readyConds.length === 0}
                className="text-xs px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40">
                Add rule
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── ONE EMPLOYEE, ONE PAGE (founder structural fix 2026-07-22) ────────────
// The old in-roster detail panel is gone: clicking an employee opens their
// Employee File (/workforce/employee?de=…), the single profile. The panels
// that lived here are exported below as DeProfileSections and rendered by
// EmployeeFilePage — one Workbench, one profile, one naming convention.

// ════════════════════════════════════════════════════════════════════
// Trust & Autonomy — surface-derived (trust program, docs/31 Q7,
// Architecture B). One card per capability this employee ACTUALLY has
// (list_de_trust_surface): its answer channels, reachable registered
// actions, and its playbooks — replacing the old hardcoded 3-entry list.
// Per card: the manager-named label, the earned level under the ladder's
// own level names, a compiled plain-English meaning of the current dial,
// server-computed evidence with the promotion request (UNCHANGED RPCs),
// a manual dial override labeled as an override, and a ladder editor.
// Destructive actions render read-only — the destructive gate sits ABOVE
// the dial in every enforcement path, so no level can ever open them.
// ════════════════════════════════════════════════════════════════════

const GATE_REASON_COPY: Record<string, string> = {
  stale_certification: 'Certification is stale — the configuration changed after the last exam. Re-run the certification exam to refresh it.',
  failed_certification: 'The last certification exam was failed. A passing exam restores autonomy.',
  expired_certification: 'A governance certification has expired. Re-issue or re-certify to restore autonomy.',
  open_critical_incident: 'An open critical incident is on this employee’s record. Review and close it (Record → Incidents) to restore autonomy.',
  degraded_metrics: 'Recent run error rate is elevated (over the last 56 days). Autonomy restores automatically as new runs succeed.',
  metrics_check_unavailable: 'The performance check could not run; autonomy is paused conservatively until it recovers.',
  never_certified: 'This employee has never passed its role’s certification exam, and this workspace requires certification before autonomy.',
  certification_check_unavailable: 'The certification check could not run; autonomy is paused conservatively until it recovers.',
};

const fmtDollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString()}`;

/** Compiled, client-side plain-English meaning of what this capability does
 *  at its CURRENT enforced dial (the resolver's answer, not a guess). */
function capabilityMeaning(entry: TrustSurfaceEntry): string {
  if (!entry.dialable) {
    return 'The destructive gate sits above the trust dial — a person confirms every run, and no trust level can change that.';
  }
  const dial = entry.dial;
  const answers = entry.enforcement.uses_confidence;
  // Invoice wording only for the invoice playbook itself — other playbook
  // capabilities (the key axis is unfrozen) take the generic playbook copy.
  const isInvoice = entry.capability_key === 'invoice_auto_send';
  if (!dial || !dial.enabled) {
    if (answers) return 'Drafts every answer for a person to approve — nothing goes out unaided.';
    if (isInvoice) return 'Never sends alone — every invoice waits at the human gate.';
    return entry.kind === 'playbook'
      ? 'Never runs alone — every run of this playbook waits at the human gate.'
      : 'Never acts alone — every run waits for a human approval.';
  }
  if (answers) {
    return dial.min_confidence != null
      ? `Answers on its own at ${dial.min_confidence}%+ confidence — below that, it drafts for approval.`
      : 'Answers on its own — the built-in 60% confidence floor applies; below it, answers draft for approval.';
  }
  if (dial.max_amount_cents != null) {
    if (isInvoice) return `Sends automatically up to ${fmtDollars(dial.max_amount_cents)} — anything larger goes to you.`;
    return entry.kind === 'playbook'
      ? `Runs automatically up to ${fmtDollars(dial.max_amount_cents)} — anything larger goes to a person.`
      : `Acts automatically up to ${fmtDollars(dial.max_amount_cents)} — anything larger goes to a person.`;
  }
  return 'Acts on its own with no amount cap set here — guardrails and spend caps still apply above the dial.';
}

/** Does the ENFORCED dial exceed what this employee has earned?
 *  true → labeled as a manual override; false → within the earned level;
 *  null → cannot be known client-side (rendered as absence, never a guess). */
function dialExceedsEarned(entry: TrustSurfaceEntry): boolean | null {
  const policy = entry.policy;
  const dial = entry.dial;
  if (!policy || !dial || !dial.enabled) return false;
  const earned = earnedLadderSettings(policy, policy.current_level);
  if (earned === null) return null;
  if (!earned.enabled) return true;
  if (earned.max_amount_cents !== null && (dial.max_amount_cents ?? Infinity) > earned.max_amount_cents) return true;
  if (earned.min_confidence !== null && (dial.min_confidence ?? 0) < earned.min_confidence) return true;
  return false;
}

/** The legacy built-in ladder, expressed in the new vocabulary — the drawer's
 *  starting point when a policy has no custom ladder yet. Mirrors the
 *  server's immutable reward tables ($1k/$5k/$10k, 90/75/60). Level 0 is
 *  implicit (always a human-gated draft) and never stored. */
function defaultLadderFor(entry: TrustSurfaceEntry): TrustLadderLevel[] {
  if (entry.enforcement.uses_confidence) {
    return [
      { level: 1, name: TRUST_LEVEL_LABELS[1], mode: 'act_within_limits', settings: { min_confidence: 90 } },
      { level: 2, name: TRUST_LEVEL_LABELS[2], mode: 'act_within_limits', settings: { min_confidence: 75 } },
      { level: 3, name: TRUST_LEVEL_LABELS[3], mode: 'act_within_limits', settings: { min_confidence: 60 } },
    ];
  }
  return [
    { level: 1, name: TRUST_LEVEL_LABELS[1], mode: 'act_within_limits', settings: { max_amount_cents: 100000 } },
    { level: 2, name: TRUST_LEVEL_LABELS[2], mode: 'act_within_limits', settings: { max_amount_cents: 500000 } },
    { level: 3, name: TRUST_LEVEL_LABELS[3], mode: 'act_within_limits', settings: { max_amount_cents: 1000000 } },
  ];
}

const LADDER_MODES: TrustLadderMode[] = ['draft', 'act_with_approval', 'act_within_limits', 'act'];

interface LadderLevelDraft { name: string; mode: TrustLadderMode; amount: string; confidence: string }

/** The ladder editor — per-level name, one of the four modes, and ONLY the
 *  numeric field(s) this capability's enforcement actually reads. Writes
 *  set_trust_ladder; all real validation is server-side (modes never narrow,
 *  limits only widen with level). Level 0 is IMPLICIT — always a human-gated
 *  draft, never stored — so the editable rows are levels 1..max_level and
 *  each stored entry carries its explicit level (the server requires it). */
function LadderEditorDrawer({ entry, deName, onClose, onSaved }: {
  entry: TrustSurfaceEntry; deName: string; onClose: () => void; onSaved: () => Promise<void>;
}) {
  // ⚠ set_trust_ladder is owner/admin, and this page is ALL_TENANT. The
  // "Customize levels…" button that opens this drawer carried no gate, so
  // anyone could reach Save and be refused. READING the ladder is worth
  // keeping open — it explains what the employee is allowed to decide — so
  // the drawer opens for everyone and only the writes are held back.
  const canEditLadder = useCanManageDe();
  const policy = entry.policy;
  const [displayName, setDisplayName] = useState(policy?.display_name ?? '');
  const toDraft = (l: TrustLadderLevel): LadderLevelDraft => ({
    name: l.name ?? '',
    mode: l.mode,
    amount: l.settings?.max_amount_cents != null ? String(Math.round(l.settings.max_amount_cents / 100)) : '',
    confidence: l.settings?.min_confidence != null ? String(l.settings.min_confidence) : '',
  });
  // Row i edits level i+1 (contiguous — a sparse stored ladder is normalized
  // to contiguous levels on the next save).
  const [levels, setLevels] = useState<LadderLevelDraft[]>(() =>
    ((policy?.ladder && policy.ladder.length > 0)
      ? [...policy.ladder].sort((a, b) => a.level - b.level)
      : defaultLadderFor(entry)).map(toDraft));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!policy) return null; // no policy row → nothing to customize (the card explains why)

  const maxLevel = policy.max_level ?? 3;

  const setLevel = (i: number, patch: Partial<LadderLevelDraft>) =>
    setLevels(prev => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const ladder: TrustLadderLevel[] = levels.map((l, idx) => {
        const settings: { min_confidence?: number; max_amount_cents?: number } = {};
        // Settings only where the mode executes AND the field is one this
        // capability's enforcement reads — the server validates the same.
        if (l.mode === 'act_within_limits' || l.mode === 'act') {
          if (entry.enforcement.uses_confidence && l.confidence.trim() !== '') {
            settings.min_confidence = Math.max(0, Math.min(100, Math.round(Number(l.confidence) || 0)));
          }
          if (entry.enforcement.uses_amount && l.amount.trim() !== '') {
            settings.max_amount_cents = Math.max(1, Math.round(Number(l.amount) || 0)) * 100;
          }
        }
        return {
          level: idx + 1, // stored entries are levels 1..max_level; 0 is implicit
          name: l.name.trim(),
          mode: l.mode,
          ...(Object.keys(settings).length > 0 ? { settings } : {}),
        };
      });
      const opts: { ladder: TrustLadderLevel[]; displayName?: string } = { ladder };
      const dn = displayName.trim();
      if (dn && dn !== (policy.display_name ?? '')) opts.displayName = dn;
      await setTrustLadder(policy.id, opts);
      await onSaved();
      onClose();
    } catch (e) {
      setErr((e as Error)?.message || 'The ladder was not saved.');
    } finally { setBusy(false); }
  };

  const reset = async () => {
    setBusy(true); setErr(null);
    try {
      // The explicit clear flag — a null ladder would arrive as SQL NULL
      // ("unchanged") through PostgREST and silently no-op the reset.
      await setTrustLadder(policy.id, { clearLadder: true });
      await onSaved();
      onClose();
    } catch (e) {
      setErr((e as Error)?.message || 'The reset was not applied.');
    } finally { setBusy(false); }
  };

  return (
    <Drawer title={`Customize levels — ${policy.display_name || entry.label}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-xs text-dt-support">
          Each level is a promise about what {deName} may do alone once that level is <em>earned</em> —
          levels are still earned from evidence and approved by a person. Changing a level here changes
          what it means, not which level is held. Guardrails, destructive gates and spend caps sit above
          every level and cannot be overridden by any ladder.
        </p>

        <Field label="What you call this capability" hint="Shown on the card and in promotion requests.">
          <input value={displayName} onChange={e => setDisplayName(e.target.value)}
            placeholder={entry.label} className={INPUT_CLS} />
        </Field>

        <div className="space-y-3">
          {/* Level 0 — implicit, never stored, never editable. */}
          <div className="rounded-xl border border-dt-border bg-dt-inset p-4">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold text-dt-body">Level 0</span>
              {policy.current_level === 0 && <Chip tone="accent">current</Chip>}
              <span className="text-[10px] text-dt-muted">always drafts — un-earned trust never acts</span>
            </div>
          </div>
          {levels.map((l, i) => (
            <div key={i} className="rounded-xl border border-dt-border bg-dt-inset p-4 space-y-2.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-semibold text-dt-body">Level {i + 1}</span>
                {policy.current_level === i + 1 && <Chip tone="accent">current</Chip>}
                {i === levels.length - 1 && levels.length > 1 && (
                  <button onClick={() => setLevels(prev => prev.slice(0, -1))}
                    className="ml-auto text-[11px] text-dt-muted hover:text-rose-300 transition-colors">Remove</button>
                )}
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <label className="flex items-center gap-2 text-xs text-dt-support">
                  Name
                  <input value={l.name} onChange={e => setLevel(i, { name: e.target.value })}
                    placeholder={TRUST_LEVEL_LABELS[i + 1] ?? `Level ${i + 1}`}
                    className="w-40 bg-dt-card border border-dt-border-strong rounded-lg px-2 py-1.5 text-dt-body text-xs focus:border-indigo-500 focus:outline-none" />
                </label>
                <label className="flex items-center gap-2 text-xs text-dt-support">
                  Mode
                  <select value={l.mode}
                    onChange={e => setLevel(i, { mode: e.target.value as TrustLadderMode })}
                    className="bg-dt-card border border-dt-border-strong rounded-lg px-2 py-1.5 text-dt-body text-xs focus:border-indigo-500 focus:outline-none disabled:opacity-60">
                    {LADDER_MODES.map(m => <option key={m} value={m}>{TRUST_LADDER_MODE_LABELS[m]}</option>)}
                  </select>
                </label>
              </div>
              {(l.mode === 'act_within_limits' || l.mode === 'act') && (
                <div className="flex items-center gap-3 flex-wrap">
                  {entry.enforcement.uses_amount && (
                    <label className="flex items-center gap-2 text-xs text-dt-support">
                      Max amount $
                      <input type="number" min={1} value={l.amount} placeholder="e.g. 1000"
                        onChange={e => setLevel(i, { amount: e.target.value })}
                        className="w-28 bg-dt-card border border-dt-border-strong rounded-lg px-2 py-1.5 text-dt-body text-xs focus:border-indigo-500 focus:outline-none" />
                    </label>
                  )}
                  {entry.enforcement.uses_confidence && (
                    <label className="flex items-center gap-2 text-xs text-dt-support">
                      Min confidence %
                      <input type="number" min={0} max={100} value={l.confidence} placeholder="e.g. 75"
                        onChange={e => setLevel(i, { confidence: e.target.value })}
                        className="w-24 bg-dt-card border border-dt-border-strong rounded-lg px-2 py-1.5 text-dt-body text-xs focus:border-indigo-500 focus:outline-none" />
                    </label>
                  )}
                  {l.mode === 'act_within_limits' && (
                    <span className="text-[10px] text-dt-muted">within-limits needs at least one limit</span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {levels.length < maxLevel && (
          <Button kind="ghost" size="sm"
            onClick={() => setLevels(prev => [...prev, { name: `Level ${prev.length + 1}`, mode: 'act_within_limits', amount: '', confidence: '' }])}>
            + Add level {levels.length + 1}
          </Button>
        )}

        {err && <Banner tone="danger">{err}</Banner>}

        <div className="flex items-center gap-2 flex-wrap pt-1">
          <Button kind="primary" size="sm" disabled={busy || !canEditLadder} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save ladder'}
          </Button>
          {policy.ladder && policy.ladder.length > 0 && (
            <Button kind="secondary" size="sm" disabled={busy || !canEditLadder} onClick={() => void reset()}
              title="Back to the engine's built-in levels ($1k/$5k/$10k caps, 90/75/60 confidence floors).">
              Reset to built-in levels
            </Button>
          )}
          <Button kind="ghost" size="sm" disabled={busy} onClick={onClose}>Cancel</Button>
        </div>
        <p className="text-[10px] text-dt-muted">
          Modes must not narrow as levels rise, and limits must widen — the server refuses a ladder that
          shrinks with trust. An already-earned level is re-applied through the engine so the enforced
          dial keeps meaning what the new ladder says.
        </p>
      </div>
    </Drawer>
  );
}

/** One surface entry as a card. Destructive entries render read-only. */
function TrustSurfaceCard({ entry, ev, draft, saving, saved, requesting, requested, canOverride, approvalNote, onDraft, onSaveDial, onRequestPromotion, onOpenLadder }: {
  entry: TrustSurfaceEntry;
  ev: TrustEvidence | undefined;
  draft: RowDraft;
  saving: boolean; saved: boolean;
  requesting: boolean; requested: boolean;
  /** set_de_autonomy is owner/admin-gated in the database — below that the
   *  override controls are shown read-only instead of refusing on save. */
  canOverride: boolean;
  /** Human-approval evidence line (invoice card only); null = not loaded. */
  approvalNote: string | null;
  onDraft: (d: RowDraft) => void;
  onSaveDial: () => void;
  onRequestPromotion: () => void;
  onOpenLadder: () => void;
}) {
  if (!entry.dialable) {
    return (
      <div className="rounded-xl border border-dt-border bg-dt-inset p-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-dt-body font-medium">{entry.label}</span>
          <Chip tone="warn">always requires approval</Chip>
        </div>
        <p className="text-[11px] text-dt-muted mt-1">{capabilityMeaning(entry)}</p>
      </div>
    );
  }

  const policy = entry.policy;
  const exceeds = dialExceedsEarned(entry);
  return (
    <div className="rounded-xl border border-dt-border bg-dt-inset p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-dt-body font-medium">{policy?.display_name || entry.label}</span>
            {policy && <Chip tone="accent">{trustLevelName(policy, policy.current_level)}</Chip>}
            {policy && (policy.de_id === null ? (
              <span title="No policy for this employee specifically yet — this capability follows the workspace-wide default.">
                <Chip tone="neutral">Workspace default</Chip>
              </span>
            ) : (
              <span title="This policy is set for this employee specifically.">
                <Chip tone="neutral">This employee</Chip>
              </span>
            ))}
            {ev?.eligible && <Chip tone="ok">Eligible for promotion</Chip>}
            {policy?.pending_task_id && <Chip tone="warn">Awaiting approval</Chip>}
            {exceeds === true && (
              <span title="The dial is set above the level this employee has earned from evidence. Still capped by guardrails.">
                <Chip tone="warn">Manual override</Chip>
              </span>
            )}
          </div>
          <p className="text-[11px] text-dt-support mt-1">{capabilityMeaning(entry)}</p>
          {entry.capability_key === 'invoice_auto_send' && approvalNote && (
            <p className="text-[11px] text-dt-muted mt-1">Evidence: {approvalNote}</p>
          )}
        </div>
        {policy && ev && !ev.at_max_level && (
          <button
            onClick={onRequestPromotion}
            disabled={!ev.eligible || requesting || policy.pending_task_id !== null}
            className="text-xs px-3 py-1.5 rounded-lg border text-emerald-300 border-emerald-800/50 hover:border-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex-shrink-0"
            title={ev.eligible ? 'Sends a promotion request to Human Tasks — a teammate approves it' : 'Evidence has not yet met every criterion'}
          >
            {requesting ? 'Requesting…' : requested ? 'Requested ✓' : `Request promotion to ${trustLevelName(policy, policy.target_level)}`}
          </button>
        )}
      </div>

      {policy ? (
        ev ? (
          <div className="mt-3 space-y-2">
            {ev.criteria.map(c => {
              const pct = c.required > 0 ? Math.min(100, Math.round((Number(c.actual) / Number(c.required)) * 100)) : 100;
              const inverse = c.key === 'guardrail_blocks';
              return (
                <div key={c.key} className="flex items-center gap-3">
                  <div className="w-44 flex-shrink-0 text-[11px] text-dt-support">{c.label}</div>
                  <div className="flex-1 h-1.5 rounded-full bg-dt-panel overflow-hidden">
                    <div
                      className={`h-full rounded-full ${c.met ? 'bg-emerald-500' : 'bg-slate-600'}`}
                      style={{ width: `${inverse ? 100 : pct}%`, opacity: inverse && !c.met ? 0.3 : 1 }}
                    />
                  </div>
                  <div className={`w-56 flex-shrink-0 text-[11px] ${c.met ? 'text-emerald-400' : 'text-dt-muted'}`} title={c.detail}>
                    {c.met ? '✓ ' : ''}{c.detail}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="mt-3 text-[11px] text-dt-muted">Evidence not available yet.</p>
        )
      ) : (
        <p className="mt-3 text-[11px] text-dt-muted">
          No trust policy yet — a manager opening this page creates one automatically (level 0, human-gated).
        </p>
      )}

      <div className="mt-3 flex items-center gap-3 flex-wrap">
        <label className={`flex items-center gap-2 ${canOverride ? 'cursor-pointer' : 'opacity-60'}`}>
          <input type="checkbox" checked={draft.enabled} disabled={!canOverride}
            onChange={e => onDraft({ ...draft, enabled: e.target.checked })}
            className="accent-indigo-500" />
          <span className="text-xs text-dt-support">{draft.enabled ? 'Enabled' : 'Off'}</span>
        </label>
        {entry.enforcement.uses_amount && (
          <label className="flex items-center gap-2 text-xs text-dt-support">
            Max amount $
            <input type="number" min={0} value={draft.amount} placeholder="e.g. 5000" disabled={!canOverride}
              onChange={e => onDraft({ ...draft, amount: e.target.value })}
              className="w-28 bg-dt-card border border-dt-border-strong rounded-lg px-2 py-1.5 text-dt-body text-xs focus:border-indigo-500 focus:outline-none disabled:opacity-60" />
          </label>
        )}
        {entry.enforcement.uses_confidence && (
          <label className="flex items-center gap-2 text-xs text-dt-support">
            Min confidence %
            <input type="number" min={0} max={100} value={draft.confidence} placeholder="e.g. 75" disabled={!canOverride}
              onChange={e => onDraft({ ...draft, confidence: e.target.value })}
              className="w-20 bg-dt-card border border-dt-border-strong rounded-lg px-2 py-1.5 text-dt-body text-xs focus:border-indigo-500 focus:outline-none disabled:opacity-60" />
          </label>
        )}
        {canOverride && (
          <button onClick={onSaveDial} disabled={saving}
            className="text-xs px-3 py-1.5 rounded-lg border text-indigo-300 border-indigo-800/50 hover:border-indigo-500 disabled:opacity-50 transition-all">
            {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save override'}
          </button>
        )}
        {policy && (
          <button onClick={onOpenLadder}
            className="text-xs px-3 py-1.5 rounded-lg border border-dt-border-strong text-dt-support hover:text-dt-body hover:border-dt-muted transition-all">
            Customize levels…
          </button>
        )}
      </div>
      {canOverride ? (
        <p className="mt-2 text-[10px] text-dt-muted">
          The dial is a manual override for this employee only — setting it above the earned level is
          recorded as an override on the audit trail. Guardrails always cap what it can allow.
        </p>
      ) : (
        <p className="mt-2 text-[10px] text-dt-muted">
          Manual dial overrides need an owner or admin — trust still widens the normal way, through
          earned, approved promotions.
        </p>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// "Describe how you want trust to work" — the plain-language trust-plan
// composer (docs/31 Q7 Phase 2). The plan compiles SERVER-side against
// this employee's real trust surface and the live validate_trust_ladder
// (compile-trust-plan edge fn) into a DRAFT — the compile's only server
// side effect is one audit row. Applying happens HERE, per capability,
// through the SAME validated setTrustLadder writer the ladder drawer
// uses — there is no other write path. Client-side the composer is
// un-gated exactly like "Customize levels…": the compile refuses
// non-managers server-side (403 insufficient_role) and set_trust_ladder
// is manager-gated in the database; a refusal renders as an honest
// error, never a silent no-op.
// ════════════════════════════════════════════════════════════════════

/** Exactly the criteria keys the evidence engine reads (mirrors the edge
 *  fn's CRITERIA_KEYS) — display labels only, never asserted as truth. */
const TRUST_CRITERIA_DISPLAY: Record<string, { label: string; kind: 'days' | 'rate' | 'count' }> = {
  window_days: { label: 'evidence window', kind: 'days' },
  min_eval_pass_rate: { label: 'min eval pass rate', kind: 'rate' },
  min_eval_samples: { label: 'min eval samples', kind: 'count' },
  min_human_approval_rate: { label: 'min human approval rate', kind: 'rate' },
  min_human_samples: { label: 'min human approvals', kind: 'count' },
  max_guardrail_blocks: { label: 'max guardrail blocks', kind: 'count' },
};

function trustCriteriaLines(criteria: Record<string, number> | null): string[] {
  if (!criteria) return [];
  return Object.entries(criteria).map(([k, v]) => {
    const meta = TRUST_CRITERIA_DISPLAY[k];
    if (!meta) return `${k}: ${v}`; // unknown key — shown raw, never hidden
    if (meta.kind === 'rate') return `${meta.label} ${Math.round(v * 100)}%`;
    if (meta.kind === 'days') return `${meta.label} ${v} day${v === 1 ? '' : 's'}`;
    return `${meta.label} ${v}`;
  });
}

function trustLadderLevelLine(l: TrustLadderLevel): string {
  const limits: string[] = [];
  if (l.settings?.max_amount_cents != null) limits.push(`up to ${fmtDollars(l.settings.max_amount_cents)}`);
  if (l.settings?.min_confidence != null) limits.push(`at ${l.settings.min_confidence}%+ confidence`);
  return `${l.name?.trim() || `Level ${l.level}`} — ${TRUST_LADDER_MODE_LABELS[l.mode] ?? l.mode}${limits.length > 0 ? ` (${limits.join(', ')})` : ''}`;
}

/** One side of the diff (current vs proposed). A null/empty ladder renders
 *  as the engine's built-in levels — the same wording the drawer uses. */
function TrustPlanSideCol({ heading, side, accent }: { heading: string; side: TrustPlanSide; accent?: boolean }) {
  const criteria = trustCriteriaLines(side.criteria);
  return (
    <div className={`rounded-lg border p-3 ${accent ? 'border-indigo-800/50 bg-indigo-500/5' : 'border-dt-border bg-dt-card'}`}>
      <p className="text-[10px] uppercase tracking-wide text-dt-faint mb-1.5">{heading}</p>
      <p className="text-xs font-medium text-dt-body mb-1">{side.display_name}</p>
      {!side.ladder || side.ladder.length === 0 ? (
        <p className="text-[11px] text-dt-muted">Engine’s built-in levels (no custom ladder).</p>
      ) : (
        <ul className="space-y-0.5">
          {[...side.ladder].sort((a, b) => a.level - b.level).map(l => (
            <li key={l.level} className="text-[11px] text-dt-support">
              <span className="text-dt-muted">L{l.level}</span> · {trustLadderLevelLine(l)}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1.5 text-[10px] text-dt-muted">
        {criteria.length > 0 ? `Promotion evidence: ${criteria.join(' · ')}` : 'No promotion evidence criteria set here.'}
      </p>
    </div>
  );
}

type TrustPlanApplyState = { status: 'applying' | 'applied' | 'error'; message?: string };

function TrustPlanComposerPanel({ deId, deName, surface, onApplied }: {
  deId: string;
  deName: string;
  /** The section's loaded surface — apply targets each capability's policy row. */
  surface: TrustSurfaceEntry[] | null;
  /** The section's own load path (load(false, key)) — preserves in-progress
   *  edits on the other cards exactly like a dial save does. */
  onApplied: (capabilityKey: string) => Promise<void>;
}) {
  // Applying a compiled plan writes through set_trust_ladder, same as the
  // drawer — owner/admin, on an ALL_TENANT page. Composing and reading the
  // plan stays open; committing it does not.
  const canApplyLadder = useCanManageDe();
  const [planText, setPlanText] = useState('');
  const [compiling, setCompiling] = useState(false);
  const [compileErr, setCompileErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<TrustPlanDraft | null>(null);
  const [apply, setApply] = useState<Record<string, TrustPlanApplyState>>({});
  const [applyingAll, setApplyingAll] = useState(false);

  const tooShort = planText.trim().length < 20; // the server refuses under 20 chars

  const compile = async () => {
    setCompiling(true);
    setCompileErr(null);
    // A fresh compile always discards the previous draft first — an AI
    // failure below then renders as FAILURE with no draft, never as an
    // empty draft or a stale one.
    setDraft(null);
    setApply({});
    try {
      setDraft(await compileTrustPlan(deId, planText.trim()));
    } catch (e) {
      setCompileErr((e as Error)?.message || 'The trust plan could not be compiled.');
    } finally {
      setCompiling(false);
    }
  };

  const policyFor = (key: string) => (surface ?? []).find(e => e.capability_key === key)?.policy ?? null;

  const applyOne = async (cap: TrustPlanCapabilityDraft) => {
    const key = cap.capability_key;
    const policy = policyFor(key);
    if (!policy) {
      // The surface lazy-seeds per-employee policies on load; if that seed
      // failed there is nothing to write to — said plainly, applied nothing.
      setApply(prev => ({ ...prev, [key]: { status: 'error', message: 'no trust policy row exists for this employee yet, so there is nothing to apply the ladder to — the note above the cards explains why seeding may have been refused.' } }));
      return;
    }
    setApply(prev => ({ ...prev, [key]: { status: 'applying' } }));
    try {
      // The ONE write path: the same server-validated writer the drawer uses.
      const opts: { ladder: TrustLadderLevel[]; displayName?: string; criteria?: Record<string, number> } = { ladder: cap.proposed.ladder };
      if (cap.proposed.criteria && Object.keys(cap.proposed.criteria).length > 0) opts.criteria = cap.proposed.criteria;
      if (cap.proposed.display_name && cap.proposed.display_name !== cap.current.display_name) opts.displayName = cap.proposed.display_name;
      await setTrustLadder(policy.id, opts);
      await onApplied(key);
      setApply(prev => ({ ...prev, [key]: { status: 'applied' } }));
    } catch (e) {
      // A failed card stays visibly unapplied — no silent partial success.
      setApply(prev => ({ ...prev, [key]: { status: 'error', message: (e as Error)?.message || 'the ladder was not applied.' } }));
    }
  };

  const applyAll = async () => {
    if (!draft) return;
    setApplyingAll(true);
    // Sequential on purpose: each card's outcome is surfaced individually,
    // and one failure never blocks (or hides behind) the others.
    for (const cap of draft.capabilities) {
      if (!cap.changed) continue;
      if (apply[cap.capability_key]?.status === 'applied') continue;
      await applyOne(cap);
    }
    setApplyingAll(false);
  };

  const changed = draft?.capabilities.filter(c => c.changed) ?? [];
  const unapplied = changed.filter(c => apply[c.capability_key]?.status !== 'applied');
  const anyApplying = applyingAll || Object.values(apply).some(s => s.status === 'applying');
  const emptyDraft = draft !== null && draft.capabilities.length === 0
    && draft.guardrail_suggestions.length === 0 && draft.unmapped.length === 0;

  return (
    <div className="rounded-2xl border border-dt-border bg-dt-card p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Describe how you want trust to work</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300">compiles to a draft · you approve every change</span>
      </div>
      <p className="text-[11px] text-dt-muted mb-3">
        Write the plan in plain words — what {deName} may do alone, up to what limits, and what evidence
        earns more. It compiles against {deName}'s real capabilities using the same validator that guards
        every ladder write, and comes back as a draft below. Nothing changes until you apply a card;
        absolute prohibitions become guardrail suggestions for the separate guardrail flow. Compiling a
        plan requires a manager, admin or owner role.
      </p>

      <textarea
        value={planText}
        onChange={e => setPlanText(e.target.value)}
        rows={4}
        maxLength={8000}
        placeholder={`e.g. ${deName} can send payment reminders on its own up to $500. After 50 clean sends over 30 days, raise the limit to $2,000. Anything about refunds always comes to me.`}
        className={`${INPUT_CLS} resize-y min-h-[92px]`}
      />

      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <Button kind="primary" size="sm" disabled={compiling || tooShort} onClick={() => void compile()}>
          {compiling ? 'Compiling…' : 'Compile to a draft'}
        </Button>
        {tooShort && planText.trim().length > 0 && (
          <span className="text-[11px] text-dt-muted">At least a sentence (20 characters) — the compiler refuses less.</span>
        )}
        {draft !== null && (
          <Button kind="ghost" size="sm" disabled={anyApplying} onClick={() => { setDraft(null); setApply({}); }}>
            Discard draft
          </Button>
        )}
      </div>

      {compileErr && (
        <div className="mt-3">
          <Banner tone="danger">Compile failed — no draft was produced. {compileErr}</Banner>
        </div>
      )}

      {draft !== null && (
        <div className="mt-4 space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-semibold text-dt-body">Draft review</h4>
            <span className="text-[11px] text-dt-muted">
              {changed.length} proposed change{changed.length === 1 ? '' : 's'}
              {draft.unmapped.length > 0 ? ` · ${draft.unmapped.length} unmapped` : ''}
              {draft.guardrail_suggestions.length > 0 ? ` · ${draft.guardrail_suggestions.length} guardrail suggestion${draft.guardrail_suggestions.length === 1 ? '' : 's'}` : ''}
            </span>
            {unapplied.length > 1 && (
              <Button kind="secondary" size="sm" className="ml-auto" disabled={anyApplying || !canApplyLadder} onClick={() => void applyAll()}>
                {applyingAll ? 'Applying…' : `Apply all ${unapplied.length} changes`}
              </Button>
            )}
          </div>

          {emptyDraft && (
            <p className="text-xs text-dt-muted">
              The compiler returned an empty draft — no ladder proposals, no guardrail suggestions and
              nothing unmapped. Try describing the plan differently.
            </p>
          )}

          {draft.capabilities.map(cap => {
            const st = apply[cap.capability_key];
            const criteriaKept = cap.changed && st?.status !== 'applied'
              && cap.proposed.criteria === null
              && !!cap.current.criteria && Object.keys(cap.current.criteria).length > 0;
            return (
              <div key={cap.capability_key} className="rounded-xl border border-dt-border bg-dt-inset p-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-dt-body font-medium">{cap.proposed.display_name || cap.label}</span>
                  {cap.proposed.display_name !== cap.label && (
                    <span className="text-[11px] text-dt-muted">({cap.label})</span>
                  )}
                  {st?.status === 'applied' ? (
                    <Chip tone="ok">Applied ✓</Chip>
                  ) : cap.changed ? (
                    <Chip tone="accent">proposed change</Chip>
                  ) : (
                    <Chip tone="neutral">no change</Chip>
                  )}
                  {cap.changed && st?.status !== 'applied' && (
                    <Button kind="secondary" size="sm" className="ml-auto" disabled={anyApplying || !canApplyLadder} onClick={() => void applyOne(cap)}>
                      {st?.status === 'applying' ? 'Applying…' : 'Apply this ladder'}
                    </Button>
                  )}
                </div>
                {cap.explanation && <p className="text-[11px] text-dt-support mt-1">{cap.explanation}</p>}
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <TrustPlanSideCol heading="Current" side={cap.current} />
                  <TrustPlanSideCol heading="Proposed" side={cap.proposed} accent />
                </div>
                {criteriaKept && (
                  <p className="mt-2 text-[10px] text-amber-400/80">
                    The draft proposes no promotion evidence, but this capability has criteria today —
                    applying keeps the existing criteria as they are (this flow never clears criteria).
                  </p>
                )}
                {st?.status === 'error' && (
                  <p className="mt-2 text-[11px] text-rose-300">Not applied — {st.message}</p>
                )}
              </div>
            );
          })}

          {draft.unmapped.length > 0 && (
            <div className="rounded-xl border border-dt-border bg-dt-inset p-4">
              <p className="text-xs font-semibold text-dt-body mb-1">Could not be mapped</p>
              <p className="text-[11px] text-dt-muted mb-2">
                These parts of the plan did not compile into any valid ladder — nothing was guessed for them.
              </p>
              <ul className="space-y-1.5">
                {draft.unmapped.map((u, i) => (
                  <li key={i} className="text-[11px] text-dt-support">
                    {u.text && <span className="text-dt-body">“{u.text}”</span>}
                    {u.text && u.why && <span className="text-dt-muted"> — </span>}
                    {u.why && <span className="text-dt-muted">{u.why}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {draft.guardrail_suggestions.length > 0 && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
              <p className="text-xs font-semibold text-amber-300 mb-1">Guardrail suggestions — not applied here</p>
              <p className="text-[11px] text-amber-200/90 mb-2">
                Absolute prohibitions are guardrails, not trust levels — guardrails outrank every ladder.
                Nothing below is applied by this page: add the ones you want on the Governance tab, where
                guardrails get their own review.
              </p>
              <ul className="space-y-1.5">
                {draft.guardrail_suggestions.map((g, i) => (
                  <li key={i} className="text-[11px] text-amber-100/90">
                    {g.description}
                    {g.rationale && <span className="text-amber-200/70"> — {g.rationale}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <p className="mt-4 text-[10px] text-dt-muted">
        Each compile is recorded on the audit trail as draft-only. Applying a card writes through the same
        server-validated ladder writer as “Customize levels…” — modes must not narrow and limits must widen
        as levels rise, and the server refuses anything else.
      </p>
    </div>
  );
}

export function DeTrustAutonomySection({ de, setPage, onUpdated }: {
  de: DigitalEmployee; setPage: (p: Page) => void; onUpdated: (d: DigitalEmployee) => void;
}) {
  const { authedUser, isDTUser } = useAuth();
  // set_de_autonomy (the manual-override write) is owner/admin-gated in the
  // database — known limit, founder-decision territory. Below that tier the
  // override controls render read-only instead of refusing after an edit.
  const canOverride = isDTUser || ['tenant_owner', 'tenant_admin'].includes(authedUser?.role ?? '');
  const canOpenAuditFromPlan = useCanOpenPage('gov_audit');
  const [surface, setSurface] = useState<TrustSurfaceEntry[] | null>(null);
  const [gate, setGate] = useState<{ gated: boolean; reasons: string[] } | null>(null);
  const [thresholdCents, setThresholdCents] = useState<number | null>(null);
  const [approvalEvidence, setApprovalEvidence] = useState<ApprovalEvidence | null>(null);
  const [evidence, setEvidence] = useState<Record<string, TrustEvidence>>({});
  const [history, setHistory] = useState<TrustHistoryEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [seedNote, setSeedNote] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [requestingId, setRequestingId] = useState<string | null>(null);
  const [requestedId, setRequestedId] = useState<string | null>(null);
  const [trustError, setTrustError] = useState<string | null>(null);
  const [ladderFor, setLadderFor] = useState<TrustSurfaceEntry | null>(null);

  const name = de.persona_name || de.name;

  const load = useCallback(async (initial: boolean, refreshKey?: string) => {
    if (initial) setLoading(true);
    setError(null);
    try {
      let entries = await listDeTrustSurface(de.id);

      // Lazy-seed the PER-EMPLOYEE policy per surface entry (idempotent,
      // level 0 — no behavior change; the server refuses destructive
      // capabilities and non-managers). An entry whose governing policy is
      // the WORKSPACE-wide row (de_id null) is just as seedable as one with
      // no policy at all — the reader returns the workspace row when no
      // per-employee row exists, so without this the per-employee policy
      // could never be born and per-DE evidence would never apply. A failed
      // seed renders as ABSENCE on its card, never as a claim that a policy
      // exists.
      const missing = entries.filter(e => e.dialable && (!e.policy || e.policy.de_id === null));
      if (missing.length > 0) {
        const results = await Promise.allSettled(missing.map(e => seedDeTrustPolicy(de.id, e.capability_key)));
        const anyOk = results.some(r => r.status === 'fulfilled');
        if (anyOk) {
          try { entries = await listDeTrustSurface(de.id); } catch { /* keep the first read */ }
        }
        setSeedNote(results.some(r => r.status === 'rejected')
          ? 'Some capabilities have no policy for this employee specifically yet — creating one requires a manager assigned to this employee.'
          : null);
      } else {
        setSeedNote(null);
      }

      setSurface(entries);
      setDrafts(prev => {
        const fresh = Object.fromEntries(entries.filter(e => e.dialable).map(e => [e.capability_key, draftFromDial(e.dial)]));
        if (initial) return fresh;
        // A reload must not clobber in-progress edits on OTHER cards: only
        // the card just saved (refreshKey) — plus any newly appeared keys —
        // takes the server's resolved values; everything the user was
        // editing stays as typed.
        const merged: Record<string, RowDraft> = { ...fresh };
        for (const k of Object.keys(prev)) {
          if (k !== refreshKey && k in merged) merged[k] = prev[k];
        }
        return merged;
      });

      // Server-computed evidence per policied entry — failures stay per-card.
      const ev: Record<string, TrustEvidence> = {};
      await Promise.all(entries.filter(e => e.policy).map(async e => {
        try { ev[e.capability_key] = await computeTrustEvidence(e.capability_key, e.policy!.de_id); } catch { /* per-card absence */ }
      }));
      setEvidence(ev);
    } catch (err) {
      setSurface(null);
      setError((err as Error)?.message || 'Failed to load the trust surface.');
    }
    // Independent reads: a failure renders as absence, never as a false claim.
    setGate(await getDeGateStatus(de.id));
    try { setThresholdCents((await getApprovalThresholdCents()).cents); } catch { setThresholdCents(null); }
    try { setApprovalEvidence(await getApprovalEvidence()); } catch { setApprovalEvidence(null); }
    try { setHistory(await listTrustHistory(8)); } catch { setHistory([]); }
    if (initial) setLoading(false);
  }, [de.id]);

  useEffect(() => { void load(true); }, [load]);

  const saveDial = async (entry: TrustSurfaceEntry) => {
    const d = drafts[entry.capability_key];
    if (!d) return;
    setSavingKey(entry.capability_key);
    setError(null);
    try {
      const label = entry.policy?.display_name || entry.label;
      // mig 496: a record write-back is governed by the gate's own key
      // (action_execute + category), not by the card's capability key. Writing
      // the capability-shaped key would produce a dial that reads ON here and
      // changes nothing at runtime — the resolver returns at the first
      // action_type that has any row, and 'action_execute' rows exist in every
      // provisioned tenant. Same distinction the surface makes when reading.
      // ⚠ USED TO WRITE 'action_execute' HERE, deliberately: the resolver
      // returned at the first action_type with any row, workspace
      // 'action_execute' rows existed everywhere, and so a category-shaped key
      // would have shown ON in this UI while changing nothing at runtime.
      // Migration 618 reversed the ladder (specific key asked FIRST) and
      // deleted the workspace rows, so the specific key is now the one that
      // decides — and writing the generic one here would be overridden by the
      // per-category dial on the employee's Trust & Autonomy tab. One key, one
      // answer.
      const isWriteback = entry.capability_key.startsWith('writeback:');
      const writebackCategory = isWriteback ? entry.capability_key.slice('writeback:'.length) : null;
      const row = await setAutonomyDial(
        writebackCategory ? `action:${writebackCategory}` : entry.capability_key,
        label,
        {
          enabled: d.enabled,
          max_amount_cents: entry.enforcement.uses_amount && d.amount.trim() !== ''
            ? Math.max(0, Math.round(Number(d.amount) || 0)) * 100 : null,
          min_confidence: entry.enforcement.uses_confidence && d.confidence.trim() !== ''
            ? Math.max(0, Math.min(100, Math.round(Number(d.confidence) || 0))) : null,
        },
        de.id,
        writebackCategory,
      );
      // Label it as an override when it exceeds the earned ladder level.
      const earned = entry.policy ? earnedLadderSettings(entry.policy, entry.policy.current_level) : null;
      const exceeds = earned !== null && row.enabled && (
        !earned.enabled
        || (earned.max_amount_cents !== null && (row.max_amount_cents ?? Infinity) > earned.max_amount_cents)
        || (earned.min_confidence !== null && (row.min_confidence ?? 0) < earned.min_confidence)
      );
      if (exceeds) {
        try {
          await appendAuditEvent({
            actor: 'You', actor_type: 'human', category: 'config_change',
            action: `Manual trust override — ${label} set above the earned level`,
            detail: {
              kind: 'trust_manual_override', action_category: entry.capability_key, de_id: de.id,
              earned_level: entry.policy?.current_level ?? 0,
              enabled: row.enabled, max_amount_cents: row.max_amount_cents, min_confidence: row.min_confidence,
              composition: 'autonomy_narrows_within_guardrails',
            },
          });
        } catch { /* audit best-effort; the dial write already audited */ }
      }
      // Re-resolve the enforced dial for the SAVED card only — never trust
      // the draft, and never clobber edits in progress on the other cards.
      await load(false, entry.capability_key);
      setSavedKey(entry.capability_key);
      setTimeout(() => setSavedKey(k => (k === entry.capability_key ? null : k)), 2500);
    } catch (err) {
      setError((err as Error)?.message || 'Failed to save.');
    } finally {
      setSavingKey(null);
    }
  };

  const requestPromotion = async (entry: TrustSurfaceEntry) => {
    const policy = entry.policy;
    if (!policy) return;
    setRequestingId(policy.id);
    setTrustError(null);
    try {
      await requestTrustPromotion(policy.id);
      setRequestedId(policy.id);
      setTimeout(() => setRequestedId(k => (k === policy.id ? null : k)), 4000);
      await load(false);
    } catch (err) {
      setTrustError((err as Error)?.message || 'Promotion request failed.');
    } finally {
      setRequestingId(null);
    }
  };

  if (loading) return <LiveLoadingSkeleton rows={4} />;

  const entries = surface ?? [];
  const top = entries.filter(e => e.kind === 'answer' || e.kind === 'playbook');
  const cats = entries.filter(e => e.kind === 'action_category');
  const actions = entries.filter(e => e.kind === 'action');
  const orphanActions = actions.filter(a => !cats.some(c => c.category === a.category));

  // Human-approval evidence for the invoice card (getApprovalEvidence — the
  // same read the old panel mounted). Rendered as ABSENCE when unavailable.
  const approvalNote = approvalEvidence
    ? (approvalEvidence.total > 0
        ? `${approvalEvidence.total} invoice approval${approvalEvidence.total === 1 ? '' : 's'} on record, ${approvalEvidence.approved} approved unchanged (${approvalEvidence.approvedPct}%)${approvalEvidence.approvedPct >= 80 ? ' — consider raising the limit' : ''}`
        : 'No invoice approvals on record yet — evidence accrues as invoices route through the human gate.')
    : null;

  const renderCard = (entry: TrustSurfaceEntry) => (
    <TrustSurfaceCard
      key={entry.capability_key}
      entry={entry}
      ev={evidence[entry.capability_key]}
      draft={drafts[entry.capability_key] ?? draftFromDial(entry.dial)}
      saving={savingKey === entry.capability_key}
      saved={savedKey === entry.capability_key}
      requesting={requestingId !== null && requestingId === entry.policy?.id}
      requested={requestedId !== null && requestedId === entry.policy?.id}
      canOverride={canOverride}
      approvalNote={entry.capability_key === 'invoice_auto_send' ? approvalNote : null}
      onDraft={d => setDrafts(prev => ({ ...prev, [entry.capability_key]: d }))}
      onSaveDial={() => void saveDial(entry)}
      onRequestPromotion={() => void requestPromotion(entry)}
      onOpenLadder={() => setLadderFor(entry)}
    />
  );

  return (
    <div className="space-y-6">
      {error && <div className="rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{error}</div>}

      {/* Lifecycle — the governance gate (DE-B4) */}
      <DeLifecyclePanel de={de} onUpdated={onUpdated} />

      {/* What this employee may do on its own, one dial per system it can
          actually reach (migs 618/619). Sits above the earned-trust ladder
          because it is the rule that decides; the ladder below is the evidence
          that argues for changing it. */}
      <DEActionDials deId={de.id} canEdit={canOverride} />

      {/* Certification — moved in from the Workbench (docs/31 step 8): a
          failed or stale exam is what mechanically clamps autonomy through
          the mig-258 records gate, so it lives beside the trust machinery. */}
      <DeCertificationPanel deId={de.id} />

      {/* The records gate silently clamps EVERY dial below — surface it.
          Read via the existing get_de_gate_status RPC (the EmployeeFilePage
          read); when the status cannot be read, nothing is claimed. */}
      {gate?.gated && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <p className="text-xs font-medium text-amber-300">
            The records gate is clamping every dial on this page — until it clears, {name} drafts for
            approval no matter what the dials below say.
          </p>
          <ul className="mt-1 text-xs text-amber-200/90 space-y-0.5">
            {gate.reasons.map(r => <li key={r}>· {GATE_REASON_COPY[r] ?? r}</li>)}
          </ul>
        </div>
      )}
      {gate !== null && !gate.gated && (
        <p className="text-[11px] text-dt-muted">
          Records gate: clear — the dials below apply as configured.
        </p>
      )}

      {/* The trust surface — one card per capability this employee has */}
      <div className="rounded-2xl border border-dt-border bg-dt-card p-6">
        <div className="mb-1 flex items-center gap-2 flex-wrap">
          <h3 className="text-base font-semibold text-white">What {name} may do alone</h3>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300">derived from this employee's actual work</span>
        </div>
        <p className="text-[11px] text-dt-muted mb-2">
          These cards come from what {name} actually does — its answer channels, the actions reachable
          through your connected systems, and its playbooks. Trust is earned per capability from measured
          evidence; a teammate approves each step up, and any regression drops the level automatically.
        </p>
        <p className="text-xs text-dt-muted mb-4">
          Autonomy narrows <em>within</em> guardrails — it never overrides them. An action runs unaided only
          when it passes {thresholdCents !== null ? `the ${fmtMoneyK(thresholdCents)} guardrail approval threshold` : 'the guardrail approval threshold'} <em>and</em> the
          trust dial, and destructive actions always stop for a person.
        </p>

        {seedNote && <p className="text-[11px] text-amber-400/80 mb-3">{seedNote}</p>}
        {trustError && <div className="mb-4 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{trustError}</div>}

        {surface === null ? (
          <EmptyState icon="🔒" headline="The trust surface could not be loaded">
            Nothing is shown rather than guessed — the error above has the details.
          </EmptyState>
        ) : entries.length === 0 ? (
          <EmptyState icon="🔒" headline="No capabilities derived for this employee">
            The server derived nothing this employee can do — no answer channels, reachable actions or playbooks.
          </EmptyState>
        ) : (
          <div className="space-y-4">
            {top.map(renderCard)}
            {cats.map(cat => (
              <div key={cat.capability_key} className="space-y-3">
                {renderCard(cat)}
                {actions.filter(a => a.category === cat.category).length > 0 && (
                  <div className="ml-4 space-y-3 border-l border-dt-border pl-4">
                    {actions.filter(a => a.category === cat.category).map(renderCard)}
                  </div>
                )}
              </div>
            ))}
            {orphanActions.map(renderCard)}
          </div>
        )}

        <p className="mt-4 text-[11px] text-dt-muted">
          Every change is recorded as a config_change event on the audit trail.{' '}
          {canOpenAuditFromPlan && (
            <button onClick={() => setPage('gov_audit')} className="text-indigo-400 hover:text-indigo-300 transition-colors">
              View Audit Trail →
            </button>
          )}
        </p>
      </div>

      {/* Plain-language trust plans — compiled server-side into a draft,
          applied per capability through the SAME setTrustLadder writer as
          the drawer. The refresh path is the section's own load(false, key)
          so in-progress edits on other cards are never clobbered. */}
      <TrustPlanComposerPanel
        deId={de.id}
        deName={name}
        surface={surface}
        onApplied={k => load(false, k)}
      />

      {/* Promotion history */}
      <div className="rounded-2xl border border-dt-border bg-dt-card p-6">
        <h3 className="text-base font-semibold text-white mb-1">Promotion history</h3>
        <p className="text-[11px] text-dt-muted mb-3">
          Promotions, demotions and manual overrides, from the immutable audit trail. Evidence is computed
          on the server — scoped to this employee where the policy is employee-scoped — and never asserted
          by the browser.
        </p>
        {history.length === 0 ? (
          <p className="text-xs text-dt-muted">No promotions or demotions recorded yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {history.map(h => (
              <li key={h.id} className="text-[11px] text-dt-muted flex items-start gap-2">
                <span className={`mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                  h.kind === 'trust_promoted' ? 'bg-emerald-500' :
                  h.kind === 'trust_demoted' ? 'bg-rose-500' :
                  h.kind === 'trust_manual_override' ? 'bg-amber-500' : 'bg-slate-600'
                }`} />
                <span className="flex-1">{h.action}</span>
                <span className="flex-shrink-0 text-dt-faint">{new Date(h.created_at).toLocaleDateString()}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {ladderFor && (
        <LadderEditorDrawer
          entry={ladderFor}
          deName={name}
          onClose={() => setLadderFor(null)}
          onSaved={() => load(false, ladderFor.capability_key)}
        />
      )}
    </div>
  );
}

/** Attached procedures — the ONE playbook model (Wave 2, docs/15). Lists the
 *  playbook_definitions bound to this DE (the same set get_de_briefing injects
 *  into the autonomous loop since mig 250), with attach/detach and builder
 *  links. Replaces the inert Operating Charter (its assignment table FK'd the
 *  empty legacy `playbooks` table and had no runtime consumer). */
function AttachedProceduresPanel({ deId, setPage }: { deId: string; setPage: (p: Page) => void }) {
  // Attaching or detaching a procedure writes playbook_definitions, which
  // RLS gives to owner/admin/manager. Seeing WHICH procedures an employee
  // follows is worth leaving open — it is half of understanding what it
  // does — so only the two bindings are held back.
  const canBindProcedures = useIsTenantManager();
  const [defs, setDefs] = useState<PlaybookDefinition[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState('');

  const load = useCallback(async () => {
    try { setDefs(await listDefinitions()); } catch (e) { setError((e as Error).message); setDefs([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const mine = (defs ?? []).filter(d => d.de_id === deId);
  const unbound = (defs ?? []).filter(d => d.de_id !== deId && d.status !== 'archived');

  return (
    <div className="rounded-2xl border border-dt-border bg-dt-card p-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Attached procedures</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300">steers autonomous work</span>
      </div>
      <p className="text-[11px] text-dt-muted mb-4">
        Published procedures attached here are injected into this employee's working brief — up to four, newest first.
        Drafts show below but only published ones steer work.
      </p>
      {error && <p className="text-xs text-rose-300 mb-3">{error}</p>}
      {defs === null ? (
        <p className="text-xs text-dt-muted">Loading procedures…</p>
      ) : (
        <>
          {mine.length === 0 ? (
            <p className="text-sm text-dt-muted mb-3">No procedure attached yet — this employee works from knowledge and judgment alone.</p>
          ) : (
            <div className="divide-y divide-dt-border mb-3">
              {mine.map(d => (
                <div key={d.id} className="flex items-center gap-3 py-2.5">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${d.status === 'published' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>{d.status}</span>
                  <span className="text-sm text-dt-body flex-1 truncate">{d.name}</span>
                  <span className="text-[11px] text-dt-muted">v{d.version} · {Array.isArray(d.steps) ? d.steps.length : 0} steps</span>
                  <button onClick={() => setPage('systems_playbooks')} className="text-xs text-indigo-400 hover:text-indigo-300">Open in builder</button>
                  <button disabled={busy || !canBindProcedures} onClick={() => void act(() => setDefinitionDeBinding(d.id, null))}
                    className="text-xs text-dt-muted hover:text-rose-300 disabled:opacity-40">Detach</button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <select value={pick} onChange={e => setPick(e.target.value)}
              className="flex-1 bg-dt-page border border-dt-border rounded-lg px-3 py-1.5 text-sm text-dt-body">
              <option value="">Attach an existing procedure…</option>
              {unbound.map(d => <option key={d.id} value={d.id}>{d.name} ({d.status}){d.de_id ? ' — attached elsewhere' : ''}</option>)}
            </select>
            <button disabled={busy || !canBindProcedures || !pick} onClick={() => void act(async () => { await setDefinitionDeBinding(pick, deId); setPick(''); })}
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50">Attach</button>
          </div>
        </>
      )}
    </div>
  );
}

// The "Improve this employee" block lived here and has been removed.
//
// It was a SECOND way to decide an amendment, built on six RPCs that were
// never created — so it silently showed an empty list forever and its wizard
// could not submit. The real flow was never this: `entity-amend` proposes,
// writes `workforce_entity_amendments`, and raises a HUMAN TASK; a person
// decides it in the ordinary approval queue through `decide_human_task`; and
// `trg_sync_entity_amendment` applies or rejects the amendment from that
// decision. That path is live and has already carried amendments through.
//
// ⚠ Rebuilding the six RPCs would have been worse than leaving it broken:
// they would have approved amendments WITHOUT `decide_human_task`, which is
// where approval authority, the pending-only guard and the audit event live.
// A bypass around the approval gate is not a feature.

/** The merged profile sections consumed by EmployeeFilePage — the single
 *  employee page. Keys mirror its tab keys. (docs/31 steps 7-8: the old
 *  'capabilities' section merged into 'profile'; 'development' dissolved
 *  into the Performance tab, its panels exported above.) */
export type DeProfileSectionKey = 'profile' | 'trust' | 'governance';

export function DeProfileSections({ de, section, setPage, onUpdated }: {
  de: DigitalEmployee; section: DeProfileSectionKey; setPage: (p: Page) => void; onUpdated: (d: DigitalEmployee) => void;
}) {
  if (section === 'profile') {
    // ONE setup tab (docs/31 step 7): who the employee is, then how it is
    // configured — identity first, capabilities config second, and the
    // Colleagues & help cluster (the enforced consultation grants +
    // delegated tasks) closing the section.
    return (
      <div className="space-y-6">
        <DeIdentityPanel de={de} onUpdated={onUpdated} />
        <DeVoicePanel de={de} onUpdated={onUpdated} />
        <DeAvailabilityPanel de={de} onUpdated={onUpdated} />
        <DeModelPanel de={de} onUpdated={onUpdated} />
        <DeReplyModePanel de={de} onUpdated={onUpdated} />
        <DeAnswerSafeguardsPanel de={de} />
        <AttachedProceduresPanel deId={de.id} setPage={setPage} />
        <DeKnowledgeScopePanel deId={de.id} />
        <DeSystemAccessPanel deId={de.id} setPage={setPage} />
        <DeEscalationPanel deId={de.id} />
        {/* A retired employee asks nobody for help and delegates nothing — the
            guard DeGovernancePanel used to hold, restored after the move. */}
        {de.lifecycle_status !== 'retired' && <ColleaguesHelpPanel de={de} />}
      </div>
    );
  }
  if (section === 'trust') return <DeTrustAutonomySection de={de} setPage={setPage} onUpdated={onUpdated} />;
  if (section === 'governance') {
    // docs/31 step 9 order: Responsible people (the real accountability
    // model, moved from Record), guardrails, compliance packs (from the
    // Workbench), then config/supervisor/audit/retirement.
    return (
      <div className="space-y-6">
        <ResponsiblePeoplePanel deId={de.id} deName={de.persona_name || de.name} />
        <ScopedGuardrails scope="employee" scopeRef={de.id} entityLabel={de.persona_name || de.name} />
        <DeCompliancePanel />
        <DeGovernancePanel de={de} onUpdated={onUpdated} />
        {/* Incidents moved to the Record tab — they are the record. */}
      </div>
    );
  }
  return null;
}
