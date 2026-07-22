import React, { useState, useEffect } from 'react';
import { useAuth } from '../../../context/AuthContext';
import { PageHeader, th, td } from '../../../components/ui';
import type { Page } from '../../../types';
import type { CompanyId } from '../../../data/companies';
import { useDataMode } from '../../../lib/dataMode';
import { CustomerApiError } from '../../../lib/customerApi';
import { LiveLoadingSkeleton, MissingTablesNotice, LiveEmptyState } from '../../../components/LiveDataStates';
import {
  listLearnedBehaviorClusters, listLearningPolicies, getLearnedBehaviorClusterDetail,
  approveLearnedBehavior, rejectLearnedBehavior,
} from '../../../lib/selfLearningApi';
import type { LearnedBehaviorCluster, LearningPolicy, LearnedBehaviorClusterMember } from '../../../lib/selfLearningApi';
import { listDigitalEmployees } from '../../../lib/digitalEmployeesApi';
import type { DigitalEmployee } from '../../../lib/digitalEmployeesApi';
import { supabase } from '../../../supabase';

// ── Types ─────────────────────────────────────────────────────────

interface DELearningRow {
  id: string;
  name: string;
  role: string;
  learningRate: 'low' | 'medium' | 'high';
  topics: number;           // matches WorkforceDEsPage LEARNING_TOPICS counts
  pendingValidations: number;
  lastApproved: string;
}

interface PendingValidation {
  id: string;
  de: string;
  behavior: string;
  context: string;
  evidence: string;
  proposedAt: string;
}

interface LearnedBehavior {
  id: string;
  date: string;
  de: string;
  behavior: string;
  approver: string;
}

// ── Seed data ─────────────────────────────────────────────────────

const DE_ROWS: Record<CompanyId, DELearningRow[]> = {
  tcp: [
    { id: 'alex', name: 'Alex', role: 'Customer Support DE', learningRate: 'medium', topics: 3, pendingValidations: 0, lastApproved: 'Billing FAQ shortcut — 2026-06-18' },
    { id: 'casey', name: 'Casey', role: 'Renewal DE', learningRate: 'medium', topics: 2, pendingValidations: 0, lastApproved: 'Renewal objection phrasing — 2026-06-02' },
    { id: 'riley', name: 'Riley', role: 'HR & People DE', learningRate: 'medium', topics: 3, pendingValidations: 1, lastApproved: 'Leave-policy clarification — 2026-05-12' },
  ],
  pwc: [
    { id: 'morgan', name: 'Morgan', role: 'Client Relations DE', learningRate: 'low', topics: 2, pendingValidations: 0, lastApproved: 'KYC document checklist — 2026-06-10' },
    { id: 'avery', name: 'Avery', role: 'Tax Research DE', learningRate: 'medium', topics: 3, pendingValidations: 0, lastApproved: 'Citation format preference — 2026-06-22' },
  ],
};

// Riley's pending validation — same behavior text as WorkforceDEsPage Audit & Memory tab
const PENDING: Record<CompanyId, PendingValidation[]> = {
  tcp: [
    {
      id: 'val_riley_1',
      de: 'Riley',
      behavior: 'When leave request is submitted by same employee twice in 24 hrs, auto-reject duplicate.',
      context: 'Riley observed HR manually rejecting duplicate leave submissions with identical rationale each time, and proposes automating the rejection with a notification to the employee.',
      evidence: '9 duplicate submissions in the last 60 days — all manually rejected by HR with the same reason. Zero false positives in the pattern window.',
      proposedAt: '2026-07-03 · 3 hrs ago',
    },
  ],
  pwc: [],
};

const HISTORY: Record<CompanyId, LearnedBehavior[]> = {
  tcp: [
    { id: 'lb1', date: '2026-06-18', de: 'Alex', behavior: 'Answer common billing FAQ ("Where is my invoice?") with direct portal link instead of full explanation.', approver: 'M. Osei (Support Lead)' },
    { id: 'lb2', date: '2026-06-02', de: 'Casey', behavior: 'Lead renewal objection responses with usage-value summary before pricing discussion.', approver: 'Renewal Manager' },
    { id: 'lb3', date: '2026-05-12', de: 'Riley', behavior: 'Include carry-over balance in every leave-policy answer during Q1/Q2.', approver: 'HR Manager' },
    { id: 'lb4', date: '2026-04-28', de: 'Alex', behavior: 'Auto-attach rate-limit reference table when a 429 error is mentioned.', approver: 'M. Osei (Support Lead)' },
    { id: 'lb5', date: '2026-04-10', de: 'Casey', behavior: 'Send renewal-confirmation summary to CSM as well as the customer.', approver: 'CSM Lead' },
  ],
  pwc: [
    { id: 'lb1', date: '2026-06-22', de: 'Avery', behavior: 'Cite both Checkpoint and Bloomberg Tax authorities when positions differ between sources.', approver: 'Tax Partner' },
    { id: 'lb2', date: '2026-06-10', de: 'Morgan', behavior: 'Send KYC document checklist proactively at engagement signing.', approver: 'Engagement Partner' },
    { id: 'lb3', date: '2026-05-20', de: 'Morgan', behavior: 'Flag engagements with no client contact in 21 days for a status touch.', approver: 'Engagement Manager' },
    { id: 'lb4', date: '2026-05-05', de: 'Avery', behavior: 'Open memos with a one-paragraph plain-English conclusion before the technical analysis.', approver: 'Tax Partner' },
  ],
};

interface SignalConfig {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  weight: number;
}

const DEFAULT_SIGNALS: SignalConfig[] = [
  { id: 'thumbs', label: 'Thumbs up / down', description: 'Direct feedback on DE responses from customers and employees', enabled: true, weight: 30 },
  { id: 'escalation', label: 'Escalation outcomes', description: 'What the human did after a DE escalated — the strongest correction signal', enabled: true, weight: 40 },
  { id: 'corrections', label: 'Correction edits', description: 'Human edits to DE drafts before sending (reviews, approvals)', enabled: true, weight: 20 },
  { id: 'csat', label: 'CSAT scores', description: 'Post-interaction satisfaction surveys where connected', enabled: false, weight: 10 },
];

// ── Small components ──────────────────────────────────────────────

function Toggle({ enabled, onChange, disabled }: { enabled: boolean; onChange?: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      onClick={() => !disabled && onChange && onChange(!enabled)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${enabled ? 'bg-indigo-600' : 'bg-slate-600'} ${disabled ? 'opacity-70 cursor-not-allowed' : ''}`}
    >
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : 'translate-x-1'}`} />
    </button>
  );
}

// ── Page ──────────────────────────────────────────────────────────

function DemoSelfLearningPage({ setPage }: { setPage: (p: Page) => void }) {
  const { activeCompanyId } = useAuth();
  const lsKey = `dt_learning_org_${activeCompanyId}`;
  const validationKey = `dt_learning_validations_${activeCompanyId}`;

  interface OrgConfig {
    learningEnabled: boolean;
    defaultRate: 'low' | 'medium' | 'high';
    signals: SignalConfig[];
  }

  const loadConfig = (): OrgConfig => {
    try {
      const s = localStorage.getItem(lsKey);
      if (s) return JSON.parse(s);
    } catch { /* noop */ }
    return { learningEnabled: true, defaultRate: 'medium', signals: DEFAULT_SIGNALS.map(x => ({ ...x })) };
  };

  const loadDecisions = (): Record<string, 'approved' | 'rejected'> => {
    try {
      const s = localStorage.getItem(validationKey);
      if (s) return JSON.parse(s);
    } catch { /* noop */ }
    return {};
  };

  const [config, setConfig] = useState<OrgConfig>(loadConfig);
  const [decisions, setDecisions] = useState<Record<string, 'approved' | 'rejected'>>(loadDecisions);

  useEffect(() => {
    setConfig(loadConfig());
    setDecisions(loadDecisions());
  }, [activeCompanyId]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveConfig = (next: OrgConfig) => {
    setConfig(next);
    try { localStorage.setItem(lsKey, JSON.stringify(next)) } catch { /* noop */ }
  };

  const decide = (id: string, decision: 'approved' | 'rejected') => {
    setDecisions(prev => {
      const next = { ...prev, [id]: decision };
      try { localStorage.setItem(validationKey, JSON.stringify(next)) } catch { /* noop */ }
      return next;
    });
  };

  const allPending = PENDING[activeCompanyId];
  const openPending = allPending.filter(p => !decisions[p.id]);
  const deRows = DE_ROWS[activeCompanyId].map(r => ({
    ...r,
    pendingValidations: allPending.filter(p => p.de === r.name && !decisions[p.id]).length,
  }));
  const history = HISTORY[activeCompanyId];

  const updateSignal = (id: string, patch: Partial<SignalConfig>) =>
    saveConfig({ ...config, signals: config.signals.map(s => s.id === id ? { ...s, ...patch } : s) });

  return (
    <div className="p-6">
      <PageHeader
        title="Self-Learning"
        subtitle="Org-level learning policy — what DEs are allowed to learn, from which signals, and the human validation gate every learned behavior passes through"
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6">
        {/* Org policy */}
        <div className="bg-dt-card border border-dt-border rounded-2xl p-5">
          <p className="text-xs font-medium text-dt-muted uppercase tracking-wider mb-4">Org Learning Policy</p>
          <div className="space-y-3">
            <div className="flex items-center justify-between bg-dt-page rounded-lg px-3 py-2.5">
              <div>
                <p className="text-sm text-dt-body">Global self-learning</p>
                <p className="text-[11px] text-dt-muted">Master switch for learning across all DEs</p>
              </div>
              <Toggle enabled={config.learningEnabled} onChange={v => saveConfig({ ...config, learningEnabled: v })} />
            </div>
            <div className="flex items-center justify-between bg-dt-page rounded-lg px-3 py-2.5">
              <p className="text-sm text-dt-body">Default learning rate</p>
              <div className="flex gap-3">
                {(['low', 'medium', 'high'] as const).map(r => (
                  <label key={r} className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" checked={config.defaultRate === r} onChange={() => saveConfig({ ...config, defaultRate: r })} className="accent-indigo-500" />
                    <span className="text-xs text-dt-support capitalize">{r}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between bg-dt-page rounded-lg px-3 py-2.5 border border-dt-border">
              <div>
                <p className="text-sm text-dt-body flex items-center gap-1.5">Mandatory human validation <span className="text-dt-muted">🔒</span></p>
                <p className="text-[11px] text-dt-muted">Validation gate cannot be disabled — all learned behaviors require human approval</p>
              </div>
              <Toggle enabled disabled />
            </div>
          </div>
          <p className="text-[11px] text-dt-faint mt-3">
            Per-DE learning configs live in each DE profile (Audit &amp; Memory tab).{' '}
            <button onClick={() => setPage('workforce_des')} className="text-indigo-400 hover:text-indigo-300 transition-colors">Open Digital Employees →</button>
          </p>
        </div>

        {/* Feedback signals */}
        <div className="bg-dt-card border border-dt-border rounded-2xl p-5">
          <p className="text-xs font-medium text-dt-muted uppercase tracking-wider mb-1">Feedback Signals</p>
          <p className="text-[11px] text-dt-muted mb-4">Which signals feed learning, and how heavily each is weighted</p>
          <div className="space-y-3">
            {config.signals.map(s => (
              <div key={s.id} className="bg-dt-page rounded-lg px-3 py-2.5">
                <div className="flex items-center justify-between mb-1">
                  <div>
                    <p className="text-sm text-dt-body">{s.label}</p>
                    <p className="text-[11px] text-dt-muted">{s.description}</p>
                  </div>
                  <Toggle enabled={s.enabled} onChange={v => updateSignal(s.id, { enabled: v })} />
                </div>
                <div className="flex items-center gap-3 mt-2">
                  <input
                    type="range" min={0} max={100} value={s.weight}
                    disabled={!s.enabled}
                    onChange={e => updateSignal(s.id, { weight: Number(e.target.value) })}
                    className="flex-1 accent-indigo-500 disabled:opacity-40"
                  />
                  <span className={`text-xs w-10 text-right ${s.enabled ? 'text-dt-support' : 'text-dt-faint'}`}>{s.weight}%</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Pending validations queue */}
      <div className="bg-dt-card border border-dt-border rounded-2xl p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-xs font-medium text-dt-muted uppercase tracking-wider">Pending Validations — org-wide</p>
            <p className="text-[11px] text-dt-muted mt-0.5">Learned behaviors proposed by DEs, awaiting human approval before activation</p>
          </div>
          <span className={`text-xs px-2 py-1 rounded-full ${openPending.length > 0 ? 'bg-amber-500/15 text-amber-400' : 'bg-emerald-500/15 text-emerald-400'}`}>
            {openPending.length} pending
          </span>
        </div>
        {openPending.length === 0 ? (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 flex items-center gap-3">
            <span className="text-emerald-400">✓</span>
            <p className="text-sm text-emerald-300">
              No behaviors awaiting validation.
              {allPending.some(p => decisions[p.id]) && <span className="text-dt-support text-xs"> Recent decisions are reflected in each DE profile.</span>}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {openPending.map(p => (
              <div key={p.id} className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-6 h-6 rounded-full bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 text-[10px] font-semibold">{p.de[0]}</span>
                  <span className="text-xs text-dt-support">{p.de} · proposed {p.proposedAt}</span>
                </div>
                <p className="text-sm text-dt-title font-medium mb-2">"{p.behavior}"</p>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-xs mb-3">
                  <div className="bg-dt-page rounded-lg p-3">
                    <p className="text-dt-muted uppercase tracking-wide text-[10px] mb-1">Context</p>
                    <p className="text-dt-support leading-relaxed">{p.context}</p>
                  </div>
                  <div className="bg-dt-page rounded-lg p-3">
                    <p className="text-dt-muted uppercase tracking-wide text-[10px] mb-1">Evidence</p>
                    <p className="text-dt-support leading-relaxed">{p.evidence}</p>
                  </div>
                </div>
                <p className="text-[11px] text-dt-support mb-3">
                  Eval prepared: 3 scenarios will verify this behavior in the Proving Ground before it ships.{' '}
                  <button onClick={() => setPage('intelligence_evals')} className="text-indigo-400 hover:text-indigo-300 transition-colors">Open Proving Ground →</button>
                </p>
                <div className="flex items-center gap-2">
                  <button onClick={() => decide(p.id, 'approved')} className="bg-emerald-600 hover:bg-emerald-500 text-white text-sm px-4 py-1.5 rounded-lg transition-colors">Approve</button>
                  <button onClick={() => decide(p.id, 'rejected')} className="bg-red-600/30 hover:bg-red-600/50 text-red-400 text-sm px-4 py-1.5 rounded-lg border border-red-500/30 transition-colors">Reject</button>
                  <button onClick={() => setPage('workforce_des')} className="ml-auto text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
                    View in {p.de}'s profile →
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Per-DE learning status */}
      <div className="rounded-2xl border border-dt-border bg-dt-card overflow-hidden mb-6">
        <div className="px-5 pt-4 pb-2">
          <p className="text-xs font-medium text-dt-muted uppercase tracking-wider">Per-DE Learning Status</p>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-dt-inset">
            <tr>
              <th className={th}>DE</th>
              <th className={th}>Learning rate</th>
              <th className={th}>Topics</th>
              <th className={th}>Pending validations</th>
              <th className={th}>Last approved behavior</th>
              <th className={th}></th>
            </tr>
          </thead>
          <tbody>
            {deRows.map(r => (
              <tr key={r.id} className="border-t border-dt-border">
                <td className={td}>
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-full bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 text-[10px] font-semibold">{r.name[0]}</span>
                    <div>
                      <p className="text-dt-body text-xs font-medium">{r.name}</p>
                      <p className="text-[10px] text-dt-muted">{r.role}</p>
                    </div>
                  </div>
                </td>
                <td className={`${td} text-xs text-dt-support capitalize`}>{r.learningRate}</td>
                <td className={`${td} text-xs text-dt-support`}>{r.topics}</td>
                <td className={td}>
                  {r.pendingValidations > 0
                    ? <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400">{r.pendingValidations} pending</span>
                    : <span className="text-xs text-dt-muted">0</span>}
                </td>
                <td className={`${td} text-xs text-dt-support`}>{r.lastApproved}</td>
                <td className={td}>
                  <button onClick={() => setPage('workforce_des')} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">Profile →</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Learned-behavior history */}
      <div className="rounded-2xl border border-dt-border bg-dt-card overflow-hidden">
        <div className="px-5 pt-4 pb-2">
          <p className="text-xs font-medium text-dt-muted uppercase tracking-wider">Learned-Behavior History</p>
          <p className="text-[11px] text-dt-muted mt-0.5">Approved behaviors now active in production — every entry carries its human approver</p>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-dt-inset">
            <tr>
              <th className={th}>Date</th>
              <th className={th}>DE</th>
              <th className={th}>Behavior</th>
              <th className={th}>Approved by</th>
            </tr>
          </thead>
          <tbody>
            {history.map(h => (
              <tr key={h.id} className="border-t border-dt-border">
                <td className={`${td} text-xs text-dt-muted font-mono whitespace-nowrap`}>{h.date}</td>
                <td className={`${td} text-xs text-dt-support`}>{h.de}</td>
                <td className={`${td} text-xs text-dt-support leading-relaxed`}>{h.behavior}</td>
                <td className={`${td} text-xs text-dt-support whitespace-nowrap`}>{h.approver}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================
// LIVE mode — real automatic learned-behavior detection (migration
// 103). Same detect -> cluster -> promote -> human-review -> resolve
// pipeline shape as Knowledge Gaps (070), but the SIGNAL is a human
// actually correcting or overriding a DE decision, not an unanswered
// question. Two verdict types, never mixed in one cluster:
//   - 'correction'  — a human REJECTED the DE's needs-review answer.
//     Approving proposes a brand-new guardrail_rules row.
//   - 'overcaution' — a human APPROVED despite the DE flagging it,
//     repeatedly, against the SAME guardrail rule. Approving loosens
//     or deactivates that specific rule.
// Activation is real: the resulting guardrail_rules row/edit takes
// effect on the very next evaluation for every DE type immediately —
// no retraining step, no "24h to take effect" delay to fake.
// ============================================================

type RepInfo = { inquiry: string; created_at: string };

const VERDICT_META: Record<LearnedBehaviorCluster['verdict_type'], { label: string; cls: string }> = {
  correction: { label: 'Correction', cls: 'bg-rose-500/20 text-rose-400' },
  overcaution: { label: 'Overcaution', cls: 'bg-sky-500/20 text-sky-400' },
};

const LIVE_STATUS_META: Record<LearnedBehaviorCluster['status'], { label: string; cls: string }> = {
  open: { label: 'Open', cls: 'bg-slate-600/50 text-dt-support' },
  proposed: { label: 'Proposed — awaiting review', cls: 'bg-amber-500/20 text-amber-400' },
  resolved: { label: 'Resolved', cls: 'bg-emerald-500/20 text-emerald-400' },
};

function severityTier(c: LearnedBehaviorCluster, policy: LearningPolicy | null): { label: string; cls: string } {
  if (c.recurred_after_fix) return { label: 'Recurred after fix', cls: 'text-red-400' };
  const bar = policy?.min_cluster_size ?? 3;
  if (c.severity_score >= bar * 1.5) return { label: 'High', cls: 'text-red-400' };
  if (c.severity_score >= bar) return { label: 'Medium', cls: 'text-amber-400' };
  return { label: 'Low', cls: 'text-dt-support' };
}

// ── docs/19 G4: the learning digest — the self-evolution organs get a voice.
// One founder-legible read of what the workforce learned (mig 256), composed
// from evidence the machinery was already writing: gaps, amendments +
// amendment_metrics fitness, certifications, eval trends, ramp times.
interface LearningDigest {
  period: { days: number; since: string };
  volume: { work_done: number; conversations: number; escalations: number };
  knowledge: { docs_added: number; docs_by_source: Record<string, number>; gaps_detected: number; gaps_resolved: number };
  quality: { evals: number; avg_score: number; prev_evals: number; prev_avg_score: number; delta: number | null; drift: boolean };
  amendments: { proposed: number; adopted: number; fitness_avg_delta: number | null; fitness_samples: number };
  certifications: { runs: number; passed: number };
  ramp: Array<{ who: string; hired_at: string; trust_level: string | null; days_to_first_cert: number | null }>;
}

function LearningDigestPanel() {
  const [digest, setDigest] = useState<LearningDigest | null>(null);
  const [days, setDays] = useState(7);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    supabase.rpc('get_workforce_learning_digest', { p_days: days }).then(({ data, error }) => {
      if (cancelled) return;
      if (error || !data?.ok) { setHidden(true); return; }
      setDigest(data as LearningDigest);
    });
    return () => { cancelled = true; };
  }, [days]);

  if (hidden || digest === null) return null;
  const { volume, knowledge, quality, amendments, certifications, ramp } = digest;
  const selfAuthored = Object.entries(knowledge.docs_by_source)
    .filter(([s]) => s !== 'manual' && s !== 'upload').reduce((n, [, v]) => n + v, 0);
  const trend = quality.delta == null ? 'holding steady (building signal)'
    : quality.delta > 1 ? `up ${quality.delta} points` : quality.delta < -1 ? `down ${Math.abs(quality.delta)} points` : 'steady';
  const chip = 'text-xs px-2.5 py-1 rounded-full border border-dt-border bg-dt-inset text-dt-support';

  return (
    <div className="rounded-2xl border border-dt-border bg-dt-card p-5 mb-6">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
        <h2 className="text-sm font-semibold text-dt-title">What your workforce learned — last {digest.period.days} days</h2>
        <div className="flex gap-1">
          {[7, 30].map(d => (
            <button key={d} onClick={() => setDays(d)}
              className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${days === d ? 'border-indigo-500 text-white' : 'border-dt-border text-dt-muted hover:text-dt-body'}`}>
              {d}d
            </button>
          ))}
        </div>
      </div>

      <p className="text-sm text-dt-body">
        Completed <span className="font-medium">{volume.work_done}</span> pieces of work across{' '}
        <span className="font-medium">{volume.conversations}</span> conversation{volume.conversations === 1 ? '' : 's'}, added{' '}
        <span className="font-medium">{knowledge.docs_added}</span> knowledge document{knowledge.docs_added === 1 ? '' : 's'}
        {selfAuthored > 0 && <> ({selfAuthored} self-authored from its own detected gaps)</>}, and answer quality is{' '}
        <span className="font-medium">{trend}</span>
        {quality.evals > 0 && <> across {quality.evals} judged answers (avg {quality.avg_score})</>}.
      </p>

      {quality.drift && (
        <div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-300">
          Drift watch: judged answer quality dropped {Math.abs(quality.delta ?? 0)} points vs the prior period
          (avg {quality.prev_avg_score} → {quality.avg_score}). Review recent knowledge and amendment changes before promoting anyone's trust.
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 mt-3">
        <span className={chip}>🕳 {knowledge.gaps_detected} gap{knowledge.gaps_detected === 1 ? '' : 's'} detected · {knowledge.gaps_resolved} resolved</span>
        <span className={chip}>✍ {amendments.adopted} amendment{amendments.adopted === 1 ? '' : 's'} adopted{amendments.fitness_samples > 0 && amendments.fitness_avg_delta != null ? ` · fitness ${amendments.fitness_avg_delta > 0 ? '+' : ''}${amendments.fitness_avg_delta}` : ''}</span>
        <span className={chip}>🎓 {certifications.passed}/{certifications.runs} certification{certifications.runs === 1 ? '' : 's'} passed</span>
        <span className={chip}>✋ {volume.escalations} escalation{volume.escalations === 1 ? '' : 's'} to a human</span>
      </div>

      {ramp.some(r => r.days_to_first_cert != null) && (
        <div className="mt-4">
          <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-1.5">Ramp — hire to first passed certification</p>
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            {ramp.filter(r => r.days_to_first_cert != null).slice(0, 8).map(r => (
              <span key={r.who} className="text-xs text-dt-support">
                <span className="text-dt-body font-medium">{r.who}</span> · {r.days_to_first_cert}d{r.trust_level ? ` · now ${r.trust_level}` : ''}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function LiveSelfLearning({ setPage }: { setPage: (p: Page) => void }) {
  const [clusters, setClusters] = useState<LearnedBehaviorCluster[]>([]);
  const [policies, setPolicies] = useState<LearningPolicy[]>([]);
  const [des, setDes] = useState<DigitalEmployee[]>([]);
  const [repInfo, setRepInfo] = useState<Record<string, RepInfo>>({});
  const [loading, setLoading] = useState(true);
  const [missingTables, setMissingTables] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ members: LearnedBehaviorClusterMember[]; inquiries: Record<string, RepInfo> } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [overridePattern, setOverridePattern] = useState('');
  const [toast, setToast] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, p, d] = await Promise.all([
        listLearnedBehaviorClusters(), listLearningPolicies(), listDigitalEmployees(),
      ]);
      setClusters(c);
      setPolicies(p);
      setDes(d);
      setMissingTables(false);

      const repIds = Array.from(new Set(c.map(cl => cl.representative_run_id)));
      if (repIds.length > 0) {
        const { data: runs, error: runsErr } = await supabase
          .from('evidence_runs').select('id, inquiry, created_at').in('id', repIds);
        if (runsErr) throw runsErr;
        setRepInfo(Object.fromEntries((runs ?? []).map((row: any) => [row.id, { inquiry: row.inquiry, created_at: row.created_at }])));
      } else {
        setRepInfo({});
      }
    } catch (err) {
      if (err instanceof CustomerApiError && err.missingTables) setMissingTables(true);
      else setError((err as Error)?.message || 'Failed to load learned behaviors.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    const cluster = clusters.find(c => c.id === selectedId);
    if (!cluster) return;
    setOverridePattern('');
    setDetailLoading(true);
    getLearnedBehaviorClusterDetail(cluster)
      .then(setDetail)
      .catch(err => setError((err as Error)?.message || 'Failed to load this pattern\'s evidence.'))
      .finally(() => setDetailLoading(false));
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const deById = new Map(des.map(d => [d.id, d]));
  const policyFor = (category: string | null): LearningPolicy | null =>
    policies.find(p => p.category === category) ?? policies.find(p => p.category === null) ?? null;

  const decide = async (clusterId: string, decision: 'approved' | 'rejected') => {
    setDeciding(true);
    try {
      if (decision === 'approved') {
        const result = await approveLearnedBehavior(clusterId, overridePattern.trim() || undefined);
        if (!result.ok) throw new Error(result.error || 'Approval failed.');
        setToast('Approved — the guardrail took effect immediately for every Digital Employee.');
      } else {
        const result = await rejectLearnedBehavior(clusterId);
        if (!result.ok) throw new Error(result.error || 'Rejection failed.');
        setToast('Rejected — this pattern reopened and will keep accumulating for the next detection pass.');
      }
      await refresh();
    } catch (err) {
      setError((err as Error)?.message || 'Failed to record decision.');
    } finally {
      setDeciding(false);
    }
  };

  const openCount = clusters.filter(c => c.status === 'open').length;
  const proposedCount = clusters.filter(c => c.status === 'proposed').length;
  const resolvedCount = clusters.filter(c => c.status === 'resolved').length;
  const recurredCount = clusters.filter(c => c.recurred_after_fix).length;
  const correctionCount = clusters.filter(c => c.verdict_type === 'correction').length;
  const overcautionCount = clusters.filter(c => c.verdict_type === 'overcaution').length;

  const loopNodes = [
    { label: 'Pattern detected', count: openCount, icon: '◉' },
    { label: 'Proposed for review', count: proposedCount, icon: '✎' },
    { label: 'Resolved', count: resolvedCount, icon: '↗' },
  ];

  const selected = clusters.find(c => c.id === selectedId) ?? null;
  const selectedRep = selected ? repInfo[selected.representative_run_id] : undefined;
  const selectedDe = selected ? deById.get(selected.de_id) : undefined;
  const selectedPolicy = selected ? policyFor(selected.category) : null;

  return (
    <div className="p-6 relative">
      <PageHeader
        title="Self-Learning"
        subtitle="Automatic detection of recurring human corrections — when a Digital Employee keeps getting the same kind of decision overridden by a person, it's grouped into a pattern here and a real policy change is proposed for review."
      />

      <LearningDigestPanel />

      {error && <div className="mb-4 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{error}</div>}

      {loading ? (
        <LiveLoadingSkeleton rows={4} />
      ) : missingTables ? (
        <MissingTablesNotice />
      ) : clusters.length === 0 ? (
        <LiveEmptyState
          icon="◎"
          title="No learned-behavior patterns yet"
          body="This runs automatically every 5 minutes: when several similar decisions are repeatedly corrected or overridden by the same kind of human verdict, they're grouped into a pattern here for review. Nothing has crossed that threshold yet for this workspace — it depends on Human Tasks review decisions actually accumulating over time."
          primaryLabel="Go to Human Tasks"
          onPrimary={() => setPage('ops_human_tasks')}
        />
      ) : (
        <>
          <div className="rounded-2xl border border-dt-border bg-dt-card p-5 mb-6">
            <div className="flex items-stretch gap-2 overflow-x-auto pb-1">
              {loopNodes.map((n, i) => (
                <React.Fragment key={n.label}>
                  <div className="flex-1 min-w-[100px] rounded-xl border border-dt-border bg-dt-page p-3 text-center">
                    <p className="text-indigo-400 text-sm">{n.icon}</p>
                    <p className="text-xs font-semibold text-dt-support mt-1">{n.label}</p>
                    <p className="text-lg font-bold text-white mt-0.5">{n.count}</p>
                  </div>
                  {i < loopNodes.length - 1 && <span className="self-center text-dt-faint flex-shrink-0">→</span>}
                </React.Fragment>
              ))}
            </div>
            <p className="text-[11px] text-dt-muted mt-2">
              {correctionCount} correction pattern{correctionCount === 1 ? '' : 's'} (the DE was wrong) · {overcautionCount} overcaution pattern{overcautionCount === 1 ? '' : 's'} (the DE was needlessly cautious).
              {recurredCount > 0 && <span className="text-red-400"> {recurredCount} recurred after a fix was applied — that fix may not have held.</span>}
            </p>
          </div>

          <div className="rounded-2xl border border-dt-border bg-dt-card overflow-hidden">
            <table className="w-full text-sm text-dt-support">
              <thead className="bg-dt-card border-b border-dt-border">
                <tr>
                  <th className={th}>Pattern</th>
                  <th className={th}>DE</th>
                  <th className={th}>Verdict</th>
                  <th className={th}>Members</th>
                  <th className={th}>Severity</th>
                  <th className={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {clusters.map(c => {
                  const rep = repInfo[c.representative_run_id];
                  const de = deById.get(c.de_id);
                  const tier = severityTier(c, policyFor(c.category));
                  return (
                    <tr key={c.id} onClick={() => setSelectedId(c.id)} className="border-b border-dt-border hover:bg-dt-panel cursor-pointer transition-colors">
                      <td className={td}>
                        <p className="text-white font-medium max-w-md truncate">{rep?.inquiry ?? '(loading…)'}</p>
                        <p className="text-xs text-dt-muted mt-0.5">first seen {new Date(c.first_seen_at).toLocaleDateString()}</p>
                      </td>
                      <td className={td}>
                        {de ? (
                          <span className="flex items-center gap-1.5">
                            <span className="w-5 h-5 rounded-full bg-indigo-600 flex items-center justify-center text-white text-[9px] font-bold">{de.name[0]}</span>
                            <span className="text-xs">{de.name}</span>
                          </span>
                        ) : <span className="text-xs text-dt-faint">—</span>}
                      </td>
                      <td className={td}><span className={`text-xs px-2 py-0.5 rounded-full font-medium ${VERDICT_META[c.verdict_type]?.cls}`}>{VERDICT_META[c.verdict_type]?.label ?? c.verdict_type}</span></td>
                      <td className={`${td} text-xs text-dt-support`}>{c.member_count}</td>
                      <td className={td}><span className={`text-xs font-medium ${tier.cls}`}>{tier.label}</span></td>
                      <td className={td}><span className={`text-xs px-2 py-0.5 rounded-full font-medium ${LIVE_STATUS_META[c.status]?.cls}`}>{LIVE_STATUS_META[c.status]?.label ?? c.status}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {selected && (
            <div className="fixed inset-0 z-40 flex justify-end" onClick={() => setSelectedId(null)}>
              <div className="absolute inset-0 bg-black/50" />
              <div onClick={e => e.stopPropagation()} className="relative w-full max-w-xl h-full bg-dt-card border-l border-dt-border overflow-y-auto p-6">
                <div className="flex items-start justify-between mb-1">
                  <h2 className="text-lg font-semibold text-white">{selectedRep?.inquiry ?? 'Pattern detail'}</h2>
                  <button onClick={() => setSelectedId(null)} className="text-dt-muted hover:text-white text-lg leading-none">✕</button>
                </div>
                <div className="flex items-center gap-2 mb-5 flex-wrap">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${VERDICT_META[selected.verdict_type].cls}`}>{VERDICT_META[selected.verdict_type].label}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${LIVE_STATUS_META[selected.status].cls}`}>{LIVE_STATUS_META[selected.status].label}</span>
                  <span className="text-xs text-dt-muted">{selected.member_count} similar decision{selected.member_count === 1 ? '' : 's'}{selectedPolicy ? ` in a ${selectedPolicy.window_days}-day window` : ''}{selectedDe ? ` · ${selectedDe.name}` : ''}</span>
                </div>

                {typeof selected.pre_fix_avg_confidence === 'number' && (
                  <div className="mb-5 bg-dt-page rounded-lg px-3 py-2">
                    <p className="text-xs text-dt-support">Average confidence when this pattern was detected: <span className="text-white font-medium">{selected.pre_fix_avg_confidence}%</span></p>
                  </div>
                )}

                <p className="text-xs font-medium text-dt-muted uppercase tracking-wider mb-2">1 · Signal — the decisions behind this pattern</p>
                {detailLoading ? (
                  <div className="mb-6"><LiveLoadingSkeleton rows={2} /></div>
                ) : (
                  <div className="space-y-2 mb-6">
                    {(detail?.members ?? []).map(m => {
                      const info = detail?.inquiries[m.evidence_run_id];
                      return (
                        <div key={m.id} className="bg-dt-page rounded-lg px-3 py-2">
                          <p className="text-xs text-dt-support">{info?.inquiry ?? '(inquiry text unavailable)'}</p>
                          <p className="text-[10px] text-dt-faint mt-0.5">
                            {info ? new Date(info.created_at).toLocaleString() : ''}
                            {m.similarity_to_representative !== null ? ` · ${Math.round(m.similarity_to_representative * 100)}% similar to the representative decision` : ''}
                          </p>
                        </div>
                      );
                    })}
                    {(detail?.members ?? []).length === 0 && !detailLoading && (
                      <p className="text-xs text-dt-muted">No member decisions loaded.</p>
                    )}
                  </div>
                )}

                {selected.proposed_rule && (
                  <>
                    <p className="text-xs font-medium text-dt-muted uppercase tracking-wider mb-2">2 · Proposed change</p>
                    <div className="rounded-xl border border-dt-border bg-dt-page p-4 mb-6">
                      {selected.proposed_rule.action === 'insert_guardrail_rule' ? (
                        <>
                          <p className="text-sm font-semibold text-white mb-1">New guardrail rule</p>
                          <p className="text-xs text-dt-support mb-2">Pattern: <span className="font-mono text-dt-support">{selected.proposed_rule.suggested_pattern}</span></p>
                        </>
                      ) : (
                        <>
                          <p className="text-sm font-semibold text-white mb-1">Loosen existing rule: {selected.proposed_rule.current_rule_label}</p>
                          <p className="text-xs text-dt-support mb-2">Current pattern: <span className="font-mono text-dt-support">{selected.proposed_rule.current_pattern}</span></p>
                        </>
                      )}
                      <p className="text-xs text-dt-support leading-relaxed">{selected.proposed_rule.rationale}</p>
                    </div>
                  </>
                )}

                {selected.status === 'proposed' && (
                  <>
                    <p className="text-xs font-medium text-dt-muted uppercase tracking-wider mb-2">3 · Human review</p>
                    {selected.verdict_type === 'correction' && (
                      <div className="mb-3">
                        <label className="text-[11px] text-dt-muted block mb-1">Pattern to block (edit before approving)</label>
                        <input
                          type="text"
                          value={overridePattern || selected.proposed_rule?.suggested_pattern || ''}
                          onChange={e => setOverridePattern(e.target.value)}
                          className="w-full bg-dt-page border border-dt-border-strong rounded-lg px-3 py-2 text-xs text-dt-body font-mono"
                        />
                      </div>
                    )}
                    {selected.verdict_type === 'overcaution' && (
                      <p className="text-[11px] text-dt-muted mb-3">
                        Approving without changes deactivates "{selected.proposed_rule?.current_rule_label}" — edit the pattern below to narrow it instead of removing it entirely.
                      </p>
                    )}
                    {selected.verdict_type === 'overcaution' && (
                      <div className="mb-3">
                        <label className="text-[11px] text-dt-muted block mb-1">Narrow the pattern instead of deactivating (optional)</label>
                        <input
                          type="text"
                          value={overridePattern}
                          onChange={e => setOverridePattern(e.target.value)}
                          placeholder={selected.proposed_rule?.current_pattern || ''}
                          className="w-full bg-dt-page border border-dt-border-strong rounded-lg px-3 py-2 text-xs text-dt-body font-mono"
                        />
                      </div>
                    )}
                    <div className="flex gap-2 mb-6">
                      <button
                        disabled={deciding}
                        onClick={() => void decide(selected.id, 'approved')}
                        className="flex-1 text-sm px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium">
                        {deciding ? '…' : 'Approve'}
                      </button>
                      <button
                        disabled={deciding}
                        onClick={() => void decide(selected.id, 'rejected')}
                        className="text-sm px-3 py-2 rounded-lg border border-dt-border-strong text-dt-support hover:border-red-500/50 hover:text-red-400 disabled:opacity-50">
                        Reject
                      </button>
                    </div>
                  </>
                )}
                {selected.status === 'resolved' && (
                  <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 mb-6">
                    <p className="text-xs text-emerald-300">Resolved{selected.fix_applied_at ? ` on ${new Date(selected.fix_applied_at).toLocaleDateString()}` : ''} — the guardrail change is live.</p>
                    {selected.recurred_after_fix && (
                      <p className="text-xs text-red-300 mt-1">This pattern has since recurred {selected.recurrence_count} time{selected.recurrence_count === 1 ? '' : 's'} after that fix — the underlying issue may not have been fully resolved.</p>
                    )}
                  </div>
                )}
                {selected.status === 'open' && (
                  <p className="text-xs text-dt-muted mb-6">
                    Still accumulating — needs {Math.max(0, (selectedPolicy?.min_cluster_size ?? 3) - selected.member_count)} more similar decision{Math.max(0, (selectedPolicy?.min_cluster_size ?? 3) - selected.member_count) === 1 ? '' : 's'} before it's promoted to a reviewable proposal.
                  </p>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-dt-panel border border-emerald-500/40 text-sm text-dt-title rounded-xl px-4 py-3 shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}

export default function SelfLearningPage({ setPage }: { setPage: (p: Page) => void }) {
  const dataMode = useDataMode();
  if (dataMode === 'live') return <LiveSelfLearning setPage={setPage} />;
  return <DemoSelfLearningPage setPage={setPage} />;
}
