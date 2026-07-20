// The ONE guardrail control, scoped. Governance rebuild: guardrails are a
// single scoped table (guardrail_rules.scope + scope_ref), so this same
// component works at every level — workspace, department, a specific DE,
// or a playbook. It is embedded pre-scoped on a DE's Governance tab AND
// driven by a scope picker on the central Governance page. One build, one
// data model, shown wherever it's relevant.
//
// SAFETY: guardrails are the un-toggleable core. A human edits them here;
// the AI assistant (next) may only PROPOSE changes for approval, never
// flip one off. Every add/edit/toggle is audited by guardrailApi.
import React, { useCallback, useEffect, useState } from 'react';
import {
  listGuardrailRules, addGuardrailRule, updateGuardrailRule,
  type GuardrailRule, type GuardrailRuleType, type GuardrailScope,
} from '../lib/guardrailApi';
import {
  listPendingProposals, approveProposal, dismissProposal,
  type GovernanceProposal,
} from '../lib/governanceAiApi';
import GovernanceAIPanel from './GovernanceAIPanel';

const RULE_TYPES: Array<{ key: GuardrailRuleType; label: string; hint: string; input: 'phrase' | 'money' | 'pct' }> = [
  { key: 'blocked_phrase', label: 'Block a phrase', hint: 'Never say this phrase', input: 'phrase' },
  { key: 'blocked_topic', label: 'Block a topic', hint: 'Refuse this whole subject', input: 'phrase' },
  { key: 'require_approval_over_cents', label: 'Require approval over an amount', hint: 'A person signs off above this value', input: 'money' },
  { key: 'max_discount_pct', label: 'Cap a discount %', hint: 'Never discount beyond this', input: 'pct' },
  { key: 'frustration_signal', label: 'Escalate on frustration', hint: 'Hand to a human when a customer is upset', input: 'phrase' },
];

interface Props {
  scope: GuardrailScope;          // 'workspace' | 'department' | 'employee' | 'playbook'
  scopeRef: string | null;        // DE id, department name, or playbook id (null for workspace)
  entityLabel: string;            // e.g. "Product Support DE" or "this workspace"
  /** Compact = embedded on a profile; full = central page. */
  variant?: 'embedded' | 'full';
}

export default function ScopedGuardrails({ scope, scopeRef, entityLabel, variant = 'embedded' }: Props) {
  const [rules, setRules] = useState<GuardrailRule[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [ruleType, setRuleType] = useState<GuardrailRuleType>('blocked_phrase');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [severity, setSeverity] = useState<'blocking' | 'warning'>('blocking');
  // AI-assisted governance (Part 2): the panel + the assistant's pending proposals.
  const [showAI, setShowAI] = useState(false);
  const [proposals, setProposals] = useState<GovernanceProposal[]>([]);
  const [deciding, setDeciding] = useState<string | null>(null);

  const meta = RULE_TYPES.find(t => t.key === ruleType)!;

  // The table returns every rule; filter to this scope. A workspace-scoped
  // rule ALSO applies to a DE, so when embedded on a DE we show both its
  // own rules and the inherited workspace ones (read-only marker).
  const load = useCallback(async () => {
    setError(null);
    try {
      const all = await listGuardrailRules();
      const mine = all.filter(r => r.scope === scope && (r.scope_ref ?? null) === (scopeRef ?? null));
      const inherited = (scope === 'employee' || scope === 'department' || scope === 'playbook')
        ? all.filter(r => r.scope === 'workspace')
        : [];
      setRules([...mine, ...inherited.map(r => ({ ...r, __inherited: true } as GuardrailRule & { __inherited?: boolean }))]);
    } catch (e) { setError((e as Error).message); }
  }, [scope, scopeRef]);

  const loadProposals = useCallback(async () => {
    try { setProposals(await listPendingProposals(scope, scopeRef ?? null)); }
    catch { /* the proposals strip is additive; never block the rules on it */ }
  }, [scope, scopeRef]);

  useEffect(() => { void load(); void loadProposals(); }, [load, loadProposals]);

  const decide = async (p: GovernanceProposal, approve: boolean) => {
    setDeciding(p.id); setError(null);
    try {
      if (approve) await approveProposal(p); else await dismissProposal(p.id);
      await Promise.all([load(), loadProposals()]);
    } catch (e) { setError((e as Error).message); }
    setDeciding(null);
  };

  const describeProposal = (p: GovernanceProposal): string => {
    if (p.action === 'add') {
      if (p.rule_type === 'require_approval_over_cents') return `Require approval over $${((p.threshold ?? 0) / 100).toLocaleString()}`;
      if (p.rule_type === 'max_discount_pct') return `Cap discounts at ${p.threshold ?? 0}%`;
      return p.pattern ? `Block "${p.pattern}"` : (p.rule_name || 'New guardrail');
    }
    return `${p.action[0].toUpperCase()}${p.action.slice(1)} an existing rule`;
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); await load(); }
    catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const submit = () => {
    if (!name.trim()) return;
    const isMoney = meta.input === 'money';
    const isPct = meta.input === 'pct';
    void run(async () => {
      await addGuardrailRule({
        rule: name.trim(),
        rule_type: ruleType,
        pattern: meta.input === 'phrase' && value.trim() ? value.trim() : null,
        threshold: isMoney ? (Math.round(Number(value) * 100) || null)
                 : isPct ? (Math.round(Number(value)) || null) : null,
        severity,
        scope,
        scope_ref: scopeRef,
        applies_to: 'all',
        active: true,
      });
      setAdding(false); setName(''); setValue('');
    });
  };

  const describe = (r: GuardrailRule): string => {
    if (r.rule_type === 'require_approval_over_cents') return `approval required over $${((r.threshold ?? 0) / 100).toLocaleString()}`;
    if (r.rule_type === 'max_discount_pct') return `discount capped at ${r.threshold ?? 0}%`;
    if (r.pattern) return `"${r.pattern}"`;
    return r.rule_type.replace(/_/g, ' ');
  };

  return (
    <div className={variant === 'full' ? '' : 'rounded-2xl border border-slate-700 bg-slate-800/50 p-6'}>
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Guardrails</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300">always enforced</span>
        <span className="text-[11px] text-slate-500">for {entityLabel}</span>
        <button onClick={() => setShowAI(v => !v)}
          className="ml-auto text-[11px] px-2 py-1 rounded-lg bg-indigo-600/20 text-indigo-300 hover:bg-indigo-600/30 border border-indigo-700/50">
          {showAI ? 'Close assistant' : '✨ Set up with AI'}
        </button>
      </div>
      <p className="text-[11px] text-slate-500 mb-3">
        Hard limits {scope === 'workspace' ? 'across the whole workspace' : `for ${entityLabel}`}. Guardrails always win —
        an employee can never be talked, trained, or trusted past one.
        {scope !== 'workspace' && ' Workspace-wide rules are inherited and shown greyed out; edit those at the workspace level.'}
      </p>
      {error && <p className="text-xs text-rose-300 mb-2">{error}</p>}

      {showAI && (
        <div className="mb-3">
          <GovernanceAIPanel scope={scope} scopeRef={scopeRef} entityLabel={entityLabel} onProposed={() => void loadProposals()} onClose={() => setShowAI(false)} />
        </div>
      )}

      {/* The assistant's pending suggestions — a person approves each into a live rule. */}
      {proposals.length > 0 && (
        <div className="mb-3 rounded-xl border border-indigo-800/50 bg-indigo-900/15 p-3">
          <div className="text-[11px] font-medium text-indigo-200 mb-2">
            ✨ Proposed by the assistant — needs your approval ({proposals.length})
          </div>
          <div className="space-y-1.5">
            {proposals.map((p) => (
              <div key={p.id} className="flex items-center gap-2 text-xs rounded-lg border border-indigo-800/40 bg-slate-900/50 px-3 py-2">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300">{p.severity === 'warning' ? 'warns' : 'blocks'}</span>
                <span className="text-slate-200">{describeProposal(p)}</span>
                {p.rationale && <span className="text-slate-500 hidden sm:inline">— {p.rationale}</span>}
                <div className="ml-auto flex items-center gap-2 shrink-0">
                  <button onClick={() => void decide(p, true)} disabled={deciding === p.id}
                    className="text-[11px] px-2 py-1 rounded bg-emerald-600/80 hover:bg-emerald-500 text-white disabled:opacity-40">
                    {deciding === p.id ? '…' : 'Approve'}
                  </button>
                  <button onClick={() => void decide(p, false)} disabled={deciding === p.id}
                    className="text-[11px] text-slate-500 hover:text-slate-300 disabled:opacity-40">Dismiss</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {rules === null ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : rules.length === 0 ? (
        <p className="text-xs text-slate-500 mb-3">No guardrails{scope === 'workspace' ? ' yet' : ` set for ${entityLabel} — workspace rules still apply`}.</p>
      ) : (
        <div className="space-y-1.5 mb-3">
          {rules.map((r) => {
            const inherited = (r as GuardrailRule & { __inherited?: boolean }).__inherited;
            return (
              <div key={r.id + (inherited ? '-inh' : '')}
                className={`flex items-center gap-2 text-xs rounded-lg border px-3 py-2 ${
                  inherited ? 'border-slate-800 bg-slate-900/30 opacity-60' : 'border-slate-700 bg-slate-900/60'}`}>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${r.severity === 'blocking' ? 'bg-rose-500/15 text-rose-300' : 'bg-amber-500/15 text-amber-300'}`}>
                  {r.severity === 'blocking' ? 'blocks' : 'warns'}
                </span>
                <span className="text-slate-200">{r.rule}</span>
                <span className="text-slate-500">— {describe(r)}</span>
                {inherited
                  ? <span className="ml-auto text-[10px] text-slate-600">workspace-wide</span>
                  : <button onClick={() => void run(() => updateGuardrailRule(r, { active: !r.active }))} disabled={busy}
                      className={`ml-auto text-[10px] ${r.active ? 'text-slate-500 hover:text-amber-300' : 'text-emerald-400 hover:text-emerald-300'}`}>
                      {r.active ? 'pause' : 'resume'}
                    </button>}
                {!inherited && !r.active && <span className="text-[10px] text-slate-600">(paused)</span>}
              </div>
            );
          })}
        </div>
      )}

      {!adding ? (
        <button onClick={() => setAdding(true)} className="text-[11px] text-indigo-400 hover:text-indigo-300">
          + Add a guardrail{scope !== 'workspace' ? ` for ${entityLabel}` : ''}
        </button>
      ) : (
        <div className="rounded-xl border border-slate-600 bg-slate-900/60 p-3 space-y-2">
          <select value={ruleType} onChange={e => setRuleType(e.target.value as GuardrailRuleType)}
            className="w-full bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500">
            {RULE_TYPES.map(t => <option key={t.key} value={t.key}>{t.label} — {t.hint}</option>)}
          </select>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Name this rule (e.g. No refunds over policy)"
            className="w-full bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500" />
          <div className="flex items-center gap-2">
            <input value={value} onChange={e => setValue(e.target.value)}
              placeholder={meta.input === 'money' ? 'Amount in dollars' : meta.input === 'pct' ? 'Max %' : 'Phrase or topic'}
              className="flex-1 bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500" />
            <select value={severity} onChange={e => setSeverity(e.target.value as 'blocking' | 'warning')}
              className="bg-slate-800 border border-slate-600 text-slate-300 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500">
              <option value="blocking">Block</option>
              <option value="warning">Warn</option>
            </select>
            <button onClick={submit} disabled={busy || !name.trim()}
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40">Add</button>
            <button onClick={() => setAdding(false)} className="text-xs text-slate-500 hover:text-slate-300">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
