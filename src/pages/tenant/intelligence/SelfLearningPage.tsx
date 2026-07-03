import React, { useState, useEffect } from 'react';
import { useAuth } from '../../../context/AuthContext';
import { PageHeader, th, td } from '../../../components/ui';
import type { Page } from '../../../types';
import type { CompanyId } from '../../../data/companies';

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
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${enabled ? 'bg-indigo-600' : 'bg-slate-700'} ${disabled ? 'opacity-70 cursor-not-allowed' : ''}`}
    >
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : 'translate-x-1'}`} />
    </button>
  );
}

// ── Page ──────────────────────────────────────────────────────────

export default function SelfLearningPage({ setPage }: { setPage: (p: Page) => void }) {
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
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageHeader
        title="Self-Learning"
        subtitle="Org-level learning policy — what DEs are allowed to learn, from which signals, and the human validation gate every learned behavior passes through"
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6">
        {/* Org policy */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-4">Org Learning Policy</p>
          <div className="space-y-3">
            <div className="flex items-center justify-between bg-slate-950 rounded-lg px-3 py-2.5">
              <div>
                <p className="text-sm text-slate-200">Global self-learning</p>
                <p className="text-[11px] text-slate-500">Master switch for learning across all DEs</p>
              </div>
              <Toggle enabled={config.learningEnabled} onChange={v => saveConfig({ ...config, learningEnabled: v })} />
            </div>
            <div className="flex items-center justify-between bg-slate-950 rounded-lg px-3 py-2.5">
              <p className="text-sm text-slate-200">Default learning rate</p>
              <div className="flex gap-3">
                {(['low', 'medium', 'high'] as const).map(r => (
                  <label key={r} className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" checked={config.defaultRate === r} onChange={() => saveConfig({ ...config, defaultRate: r })} className="accent-indigo-500" />
                    <span className="text-xs text-slate-300 capitalize">{r}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between bg-slate-950 rounded-lg px-3 py-2.5 border border-slate-800">
              <div>
                <p className="text-sm text-slate-200 flex items-center gap-1.5">Mandatory human validation <span className="text-slate-500">🔒</span></p>
                <p className="text-[11px] text-slate-500">Validation gate cannot be disabled — all learned behaviors require human approval</p>
              </div>
              <Toggle enabled disabled />
            </div>
          </div>
          <p className="text-[11px] text-slate-600 mt-3">
            Per-DE learning configs live in each DE profile (Audit &amp; Memory tab).{' '}
            <button onClick={() => setPage('workforce_des')} className="text-indigo-400 hover:text-indigo-300 transition-colors">Open Digital Employees →</button>
          </p>
        </div>

        {/* Feedback signals */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1">Feedback Signals</p>
          <p className="text-[11px] text-slate-500 mb-4">Which signals feed learning, and how heavily each is weighted</p>
          <div className="space-y-3">
            {config.signals.map(s => (
              <div key={s.id} className="bg-slate-950 rounded-lg px-3 py-2.5">
                <div className="flex items-center justify-between mb-1">
                  <div>
                    <p className="text-sm text-slate-200">{s.label}</p>
                    <p className="text-[11px] text-slate-500">{s.description}</p>
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
                  <span className={`text-xs w-10 text-right ${s.enabled ? 'text-slate-300' : 'text-slate-600'}`}>{s.weight}%</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Pending validations queue */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Pending Validations — org-wide</p>
            <p className="text-[11px] text-slate-500 mt-0.5">Learned behaviors proposed by DEs, awaiting human approval before activation</p>
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
              {allPending.some(p => decisions[p.id]) && <span className="text-slate-400 text-xs"> Recent decisions are reflected in each DE profile.</span>}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {openPending.map(p => (
              <div key={p.id} className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-6 h-6 rounded-full bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 text-[10px] font-semibold">{p.de[0]}</span>
                  <span className="text-xs text-slate-400">{p.de} · proposed {p.proposedAt}</span>
                </div>
                <p className="text-sm text-slate-100 font-medium mb-2">"{p.behavior}"</p>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-xs mb-3">
                  <div className="bg-slate-950 rounded-lg p-3">
                    <p className="text-slate-500 uppercase tracking-wide text-[10px] mb-1">Context</p>
                    <p className="text-slate-300 leading-relaxed">{p.context}</p>
                  </div>
                  <div className="bg-slate-950 rounded-lg p-3">
                    <p className="text-slate-500 uppercase tracking-wide text-[10px] mb-1">Evidence</p>
                    <p className="text-slate-300 leading-relaxed">{p.evidence}</p>
                  </div>
                </div>
                <p className="text-[11px] text-slate-400 mb-3">
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
      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 overflow-hidden mb-6">
        <div className="px-5 pt-4 pb-2">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Per-DE Learning Status</p>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-slate-950/60">
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
              <tr key={r.id} className="border-t border-slate-800/60">
                <td className={td}>
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-full bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 text-[10px] font-semibold">{r.name[0]}</span>
                    <div>
                      <p className="text-slate-200 text-xs font-medium">{r.name}</p>
                      <p className="text-[10px] text-slate-500">{r.role}</p>
                    </div>
                  </div>
                </td>
                <td className={`${td} text-xs text-slate-300 capitalize`}>{r.learningRate}</td>
                <td className={`${td} text-xs text-slate-300`}>{r.topics}</td>
                <td className={td}>
                  {r.pendingValidations > 0
                    ? <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400">{r.pendingValidations} pending</span>
                    : <span className="text-xs text-slate-500">0</span>}
                </td>
                <td className={`${td} text-xs text-slate-400`}>{r.lastApproved}</td>
                <td className={td}>
                  <button onClick={() => setPage('workforce_des')} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">Profile →</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Learned-behavior history */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 overflow-hidden">
        <div className="px-5 pt-4 pb-2">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Learned-Behavior History</p>
          <p className="text-[11px] text-slate-500 mt-0.5">Approved behaviors now active in production — every entry carries its human approver</p>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-slate-950/60">
            <tr>
              <th className={th}>Date</th>
              <th className={th}>DE</th>
              <th className={th}>Behavior</th>
              <th className={th}>Approved by</th>
            </tr>
          </thead>
          <tbody>
            {history.map(h => (
              <tr key={h.id} className="border-t border-slate-800/60">
                <td className={`${td} text-xs text-slate-500 font-mono whitespace-nowrap`}>{h.date}</td>
                <td className={`${td} text-xs text-slate-300`}>{h.de}</td>
                <td className={`${td} text-xs text-slate-300 leading-relaxed`}>{h.behavior}</td>
                <td className={`${td} text-xs text-slate-400 whitespace-nowrap`}>{h.approver}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
