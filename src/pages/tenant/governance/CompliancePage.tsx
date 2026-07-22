import React, { useState, useEffect } from 'react'
import { useAuth } from '../../../context/AuthContext'
import type { Page } from '../../../types'
import type { CompanyId } from '../../../data/companies'
import { PageHeader, th, td } from '../../../components/ui'
import { TCP_DES, PWC_DES } from '../WorkforceDEsPage'
import { useDataMode } from '../../../lib/dataMode'
import { CustomerApiError } from '../../../lib/customerApi'
import {
  listGuardrailRules, addGuardrailRule, updateGuardrailRule, installStarterGuardrails,
} from '../../../lib/guardrailApi'
import type { GuardrailRule, GuardrailRuleType, GuardrailScope } from '../../../lib/guardrailApi'
import { listDigitalEmployees } from '../../../lib/digitalEmployeesApi'
import type { DigitalEmployee } from '../../../lib/digitalEmployeesApi'
import { LiveLoadingSkeleton, MissingTablesNotice, LiveEmptyState } from '../../../components/LiveDataStates'
import { ConfirmDeleteModal } from '../../../components'
import GovernanceAIPanel from '../../../components/GovernanceAIPanel'
import { listPendingProposals, approveProposal, dismissProposal, type GovernanceProposal } from '../../../lib/governanceAiApi'

// ═══════════════════════════════════════════════════════════════
// LIVE mode — real tenant guardrail_rules: enforced in the real
// path (invoice approval threshold now; DE answer checks in the
// de-answer/widget-ask edge functions). Every change is recorded
// in the immutable audit trail.
// ═══════════════════════════════════════════════════════════════

const RULE_TYPE_META: Record<GuardrailRuleType, { label: string; hint: string }> = {
  blocked_topic: { label: 'Blocked topic', hint: 'DE answers matching this topic are withheld and escalated' },
  blocked_phrase: { label: 'Blocked phrase', hint: 'DE answers containing these phrases are withheld and escalated' },
  require_approval_over_cents: { label: 'Approval threshold', hint: 'Invoices above this amount route to Human Tasks' },
  max_discount_pct: { label: 'Discount cap', hint: 'Maximum discount without human approval' },
  frustration_signal: { label: 'Frustration signal', hint: 'Phrases that score customer frustration — enough matches force a human, regardless of confidence' },
}

// A rule type the UI doesn't know yet must never crash the page again —
// render it honestly instead (this exact gap took the page down when
// frustration_signal rows existed but the map didn't have the key).
const ruleTypeMeta = (t: string) => RULE_TYPE_META[t as GuardrailRuleType] ?? { label: t.split('_').join(' '), hint: 'Custom rule type' }

// Wave 2a — the scopes surfaced in the UI. All three are honored across
// the answer, triage, and action-gate paths.
const SCOPE_META: Record<'workspace' | 'department' | 'employee', { label: string; hint: string }> = {
  workspace: { label: 'Whole workspace', hint: 'Applies to every Digital Employee' },
  department: { label: 'A department', hint: 'Applies only to DEs in the chosen department' },
  employee: { label: 'One employee', hint: 'Applies only to the chosen Digital Employee' },
}

function LiveCompliancePage({ setPage }: { setPage: (p: Page) => void }) {
  const [rules, setRules] = useState<GuardrailRule[]>([])
  const [loading, setLoading] = useState(true)
  const [missingTables, setMissingTables] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  // Central-cockpit focus: 'all' | 'workspace' | 'de:<id>' | 'dept:<name>'.
  const [focus, setFocus] = useState('all')
  const [des, setDes] = useState<DigitalEmployee[]>([])
  // AI-assisted governance (Part 2), driven from the central cockpit's focus.
  const [showGovAI, setShowGovAI] = useState(false)
  const [proposals, setProposals] = useState<GovernanceProposal[]>([])
  const [deciding, setDeciding] = useState<string | null>(null)
  const [form, setForm] = useState<{ rule: string; rule_type: GuardrailRuleType; pattern: string; threshold: string; severity: 'blocking' | 'warning'; scope: 'workspace' | 'department' | 'employee'; scope_ref: string }>(
    { rule: '', rule_type: 'blocked_phrase', pattern: '', threshold: '', severity: 'blocking', scope: 'workspace', scope_ref: '' })

  // Distinct, non-empty departments across the roster — the options for a
  // department-scoped rule. Employee scope uses the DE list directly.
  const departments = Array.from(new Set(des.map(d => (d.department || '').trim()).filter(Boolean))).sort()

  const refresh = async () => {
    setLoading(true)
    setError(null)
    try {
      const [r, d] = await Promise.all([listGuardrailRules(), listDigitalEmployees().catch(() => [])])
      setRules(r)
      setDes(d)
      setMissingTables(false)
    } catch (err) {
      if (err instanceof CustomerApiError && err.missingTables) setMissingTables(true)
      else setError((err as Error)?.message || 'Failed to load guardrails.')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void refresh() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Resolve a rule's scope to a human label for the table.
  const scopeLabel = (r: GuardrailRule): string => {
    if (r.scope === 'department') return `Dept · ${r.scope_ref || '—'}`
    if (r.scope === 'employee') return `DE · ${des.find(d => d.id === r.scope_ref)?.name || r.scope_ref || '—'}`
    if (r.scope === 'playbook') return `Playbook · ${r.scope_ref || '—'}`
    return 'Workspace'
  }

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try { await fn(); await refresh() }
    catch (err) { setError((err as Error)?.message || 'Operation failed.') }
    finally { setBusy(false) }
  }

  const submitAdd = () => run(async () => {
    const isMoney = form.rule_type === 'require_approval_over_cents'
    const isPct = form.rule_type === 'max_discount_pct'
    await addGuardrailRule({
      rule: form.rule.trim(),
      rule_type: form.rule_type,
      pattern: (!isMoney && !isPct && form.pattern.trim()) ? form.pattern.trim() : null,
      threshold: isMoney ? Math.round(Number(form.threshold) * 100) || null : isPct ? Math.round(Number(form.threshold)) || null : null,
      severity: form.severity,
      scope: form.scope,
      scope_ref: form.scope === 'workspace' ? null : (form.scope_ref || null),
    })
    setShowAdd(false)
    setForm({ rule: '', rule_type: 'blocked_phrase', pattern: '', threshold: '', severity: 'blocking', scope: 'workspace', scope_ref: '' })
  })

  // A non-workspace rule needs a target chosen before it can be saved.
  const scopeIncomplete = form.scope !== 'workspace' && !form.scope_ref

  const active = rules.filter(r => r.active)

  // Governance rebuild: focus the central cockpit on any level. When
  // focused on a DE or department, workspace-wide rules are included too
  // (they also apply there), matching what the DE's own tab shows.
  const focusedRules = rules.filter(r => {
    if (focus === 'all') return true
    if (focus === 'workspace') return r.scope === 'workspace'
    if (focus.startsWith('de:')) return (r.scope === 'employee' && r.scope_ref === focus.slice(3)) || r.scope === 'workspace'
    if (focus.startsWith('dept:')) return (r.scope === 'department' && r.scope_ref === focus.slice(5)) || r.scope === 'workspace'
    return true
  })

  // The scope the AI assistant writes into, derived from the focus picker.
  const govTarget: { scope: GuardrailScope; ref: string | null; label: string } =
    focus.startsWith('de:') ? { scope: 'employee', ref: focus.slice(3), label: des.find(d => d.id === focus.slice(3))?.name || 'this employee' }
    : focus.startsWith('dept:') ? { scope: 'department', ref: focus.slice(5), label: `the ${focus.slice(5)} department` }
    : { scope: 'workspace', ref: null, label: 'the whole workspace' }

  const loadProposals = async () => {
    try { setProposals(await listPendingProposals(govTarget.scope, govTarget.ref)) }
    catch { /* additive strip; never blocks the page */ }
  }
  useEffect(() => { void loadProposals() }, [focus]) // eslint-disable-line react-hooks/exhaustive-deps

  const decide = async (p: GovernanceProposal, approve: boolean) => {
    setDeciding(p.id); setError(null)
    try {
      if (approve) await approveProposal(p); else await dismissProposal(p.id)
      await Promise.all([refresh(), loadProposals()])
    } catch (err) { setError((err as Error)?.message || 'Could not apply the decision.') }
    setDeciding(null)
  }

  const describeProposal = (p: GovernanceProposal): string => {
    if (p.action === 'add') {
      if (p.rule_type === 'require_approval_over_cents') return `Require approval over $${((p.threshold ?? 0) / 100).toLocaleString()}`
      if (p.rule_type === 'max_discount_pct') return `Cap discounts at ${p.threshold ?? 0}%`
      return p.pattern ? `Block "${p.pattern}"` : (p.rule_name || 'New guardrail')
    }
    return `${p.action[0].toUpperCase()}${p.action.slice(1)} an existing rule`
  }

  return (
    <div className="p-6">
      <PageHeader
        title="Compliance & Guardrails"
        subtitle="Real guardrails, enforced in the real path — invoice approvals check them now; DE answers are checked at generation time. Every change lands in the immutable audit trail."
      />
      {error && <div className="mb-4 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{error}</div>}

      {loading ? (
        <LiveLoadingSkeleton rows={4} />
      ) : missingTables ? (
        <MissingTablesNotice />
      ) : rules.length === 0 ? (
        <LiveEmptyState
          icon="🛡"
          title="No guardrails yet"
          body="Install a sensible starter set — a $10K invoice approval threshold, blocked legal-commitment phrases, a blocked legal-advice topic, and a 20% discount cap. You can edit or deactivate any of them."
          primaryLabel={busy ? 'Installing…' : 'Install starter guardrails'}
          onPrimary={() => { if (!busy) void run(() => installStarterGuardrails()) }}
          secondaryLabel="Add a custom rule"
          onSecondary={() => setShowAdd(true)}
        />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3 mb-6">
            {[
              { label: 'Active rules', value: String(active.length), color: 'text-white' },
              { label: 'Blocking', value: String(active.filter(r => r.severity === 'blocking').length), color: 'text-red-300' },
              { label: 'Enforcement', value: 'Live', color: 'text-emerald-300' },
            ].map(s => (
              <div key={s.label} className="bg-dt-card border border-dt-border rounded-xl p-4">
                <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-1">{s.label}</p>
                <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
              </div>
            ))}
          </div>

          <div className="rounded-2xl border border-dt-border bg-dt-card p-6 mb-6">
            <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
              <div>
                <h3 className="text-base font-semibold text-white">Guardrail rules</h3>
                <p className="text-xs text-dt-muted mt-0.5">Checked on every invoice generation and every DE answer. The same controls appear, pre-scoped, on each employee&apos;s Governance tab — this is the central view of all of them.</p>
              </div>
              <button onClick={() => setShowGovAI(v => !v)}
                className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600/20 text-indigo-300 hover:bg-indigo-600/30 border border-indigo-700/50 transition-colors">
                {showGovAI ? 'Close assistant' : '✨ Set up with AI'}
              </button>
              <button onClick={() => setShowAdd(v => !v)}
                className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors">
                + Add rule
              </button>
            </div>

            {/* Governance rebuild: focus the cockpit on any level. */}
            <div className="flex items-center gap-2 mb-4 flex-wrap">
              <span className="text-[11px] text-dt-muted">Showing:</span>
              <select value={focus} onChange={e => setFocus(e.target.value)}
                className="bg-dt-page border border-dt-border text-dt-support text-xs rounded-lg px-2 py-1 focus:outline-none focus:border-indigo-500">
                <option value="all">Everything</option>
                <option value="workspace">Workspace-wide only</option>
                {des.length > 0 && <optgroup label="A specific employee">
                  {des.map(d => <option key={d.id} value={`de:${d.id}`}>{d.name}</option>)}
                </optgroup>}
                {departments.length > 0 && <optgroup label="A department">
                  {departments.map(dep => <option key={dep} value={`dept:${dep}`}>{dep}</option>)}
                </optgroup>}
              </select>
              <span className="text-[11px] text-dt-faint">{focusedRules.length} rule{focusedRules.length === 1 ? '' : 's'}</span>
            </div>

            {/* AI-assisted governance — talks in plain language, scoped to the
                current focus. It can only PROPOSE; every proposal is approved
                below by a person. */}
            {showGovAI && (
              <div className="mb-4">
                <GovernanceAIPanel scope={govTarget.scope} scopeRef={govTarget.ref} entityLabel={govTarget.label}
                  onProposed={() => void loadProposals()} onClose={() => setShowGovAI(false)} />
              </div>
            )}
            {proposals.length > 0 && (
              <div className="mb-4 rounded-xl border border-indigo-800/50 bg-indigo-900/15 p-3">
                <div className="text-[11px] font-medium text-indigo-200 mb-2">
                  ✨ Proposed by the assistant for {govTarget.label} — needs your approval ({proposals.length})
                </div>
                <div className="space-y-1.5">
                  {proposals.map(p => (
                    <div key={p.id} className="flex items-center gap-2 text-xs rounded-lg border border-indigo-800/40 bg-dt-inset px-3 py-2">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300">{p.severity === 'warning' ? 'warns' : 'blocks'}</span>
                      <span className="text-dt-body">{describeProposal(p)}</span>
                      {p.rationale && <span className="text-dt-muted hidden sm:inline">— {p.rationale}</span>}
                      <div className="ml-auto flex items-center gap-2 shrink-0">
                        <button onClick={() => void decide(p, true)} disabled={deciding === p.id}
                          className="text-[11px] px-2 py-1 rounded bg-emerald-600/80 hover:bg-emerald-500 text-white disabled:opacity-40">
                          {deciding === p.id ? '…' : 'Approve'}
                        </button>
                        <button onClick={() => void decide(p, false)} disabled={deciding === p.id}
                          className="text-[11px] text-dt-muted hover:text-dt-support disabled:opacity-40">Dismiss</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="overflow-x-auto rounded-xl border border-dt-border">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-dt-border text-left">
                    {['Rule', 'Type', 'Scope', 'Pattern / threshold', 'Severity', 'Version', 'Active', ''].map(h => (
                      <th key={h} className={th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {focusedRules.map(r => (
                    <tr key={r.id} className={`border-b border-dt-border last:border-b-0 ${r.active ? '' : 'opacity-50'}`}>
                      <td className={`${td} text-dt-body text-xs`}>{r.rule}</td>
                      <td className={td}>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-panel text-dt-support">{ruleTypeMeta(r.rule_type).label}</span>
                      </td>
                      <td className={td}>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${r.scope === 'workspace' ? 'bg-dt-panel text-dt-support' : 'bg-indigo-500/15 text-indigo-300'}`}>{scopeLabel(r)}</span>
                      </td>
                      <td className={`${td} text-xs text-dt-support font-mono`}>
                        {r.rule_type === 'require_approval_over_cents' && r.threshold != null ? `$${Math.round(r.threshold / 100).toLocaleString()}`
                          : r.rule_type === 'max_discount_pct' && r.threshold != null ? `${r.threshold}%`
                          : r.pattern || '—'}
                      </td>
                      <td className={td}><SeverityBadge severity={r.severity} /></td>
                      <td className={`${td} text-xs text-indigo-400 font-mono`}>v{r.version}</td>
                      <td className={td}>
                        <Toggle enabled={r.active} disabled={busy}
                          onChange={(v) => void run(() => updateGuardrailRule(r, { active: v }))} />
                      </td>
                      <td className={`${td} text-right`}>
                        <span className="text-[10px] text-dt-faint">{new Date(r.updated_at).toLocaleDateString()}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-[11px] text-dt-muted">
              The approval-threshold rule replaces the built-in $10K gate on renewal invoices. Blocked phrases/topics are checked against every DE answer before it reaches the user (simple pattern matching, v1) — matches are withheld, escalated to Human Tasks, and recorded as a guardrail block in the{' '}
              <button onClick={() => setPage('gov_audit')} className="text-indigo-400 hover:text-indigo-300 underline underline-offset-2">audit trail</button>.
            </p>
          </div>
        </>
      )}

      {/* Add rule form */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowAdd(false)}>
          <div className="bg-dt-card border border-dt-border-strong rounded-2xl p-6 w-[440px] max-w-[90vw]" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-white mb-4">Add guardrail rule</h3>
            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-dt-support mb-1">Rule (plain English)</label>
                <input value={form.rule} onChange={e => setForm(f => ({ ...f, rule: e.target.value }))}
                  placeholder='e.g. "Never quote competitor pricing"'
                  className="w-full bg-dt-page border border-dt-border-strong rounded-lg px-3 py-2 text-dt-body placeholder:text-dt-faint focus:outline-none focus:border-indigo-500" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-dt-support mb-1">Type</label>
                  <select value={form.rule_type} onChange={e => setForm(f => ({ ...f, rule_type: e.target.value as GuardrailRuleType }))}
                    className="w-full bg-dt-page border border-dt-border-strong rounded-lg px-3 py-2 text-dt-body focus:outline-none focus:border-indigo-500">
                    {(Object.keys(RULE_TYPE_META) as GuardrailRuleType[]).map(t => (
                      <option key={t} value={t}>{RULE_TYPE_META[t].label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-dt-support mb-1">Severity</label>
                  <select value={form.severity} onChange={e => setForm(f => ({ ...f, severity: e.target.value as 'blocking' | 'warning' }))}
                    className="w-full bg-dt-page border border-dt-border-strong rounded-lg px-3 py-2 text-dt-body focus:outline-none focus:border-indigo-500">
                    <option value="blocking">Blocking</option>
                    <option value="warning">Warning</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-dt-support mb-1">Applies to</label>
                  <select value={form.scope} onChange={e => setForm(f => ({ ...f, scope: e.target.value as 'workspace' | 'department' | 'employee', scope_ref: '' }))}
                    className="w-full bg-dt-page border border-dt-border-strong rounded-lg px-3 py-2 text-dt-body focus:outline-none focus:border-indigo-500">
                    {(Object.keys(SCOPE_META) as Array<'workspace' | 'department' | 'employee'>).map(s => (
                      <option key={s} value={s}>{SCOPE_META[s].label}</option>
                    ))}
                  </select>
                </div>
                {form.scope === 'department' ? (
                  <div>
                    <label className="block text-dt-support mb-1">Department</label>
                    <select value={form.scope_ref} onChange={e => setForm(f => ({ ...f, scope_ref: e.target.value }))}
                      className="w-full bg-dt-page border border-dt-border-strong rounded-lg px-3 py-2 text-dt-body focus:outline-none focus:border-indigo-500">
                      <option value="">Choose a department…</option>
                      {departments.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </div>
                ) : form.scope === 'employee' ? (
                  <div>
                    <label className="block text-dt-support mb-1">Employee</label>
                    <select value={form.scope_ref} onChange={e => setForm(f => ({ ...f, scope_ref: e.target.value }))}
                      className="w-full bg-dt-page border border-dt-border-strong rounded-lg px-3 py-2 text-dt-body focus:outline-none focus:border-indigo-500">
                      <option value="">Choose an employee…</option>
                      {des.map(d => <option key={d.id} value={d.id}>{d.name}{d.department ? ` · ${d.department}` : ''}</option>)}
                    </select>
                  </div>
                ) : (
                  <div className="flex items-end">
                    <p className="text-[11px] text-dt-muted pb-2">{SCOPE_META[form.scope].hint}.</p>
                  </div>
                )}
              </div>
              {form.scope === 'department' && departments.length === 0 && (
                <p className="text-[11px] text-amber-400/80">No departments found on your roster yet — set a department on a Digital Employee's profile first, or scope to a specific employee.</p>
              )}
              {(form.rule_type === 'blocked_phrase' || form.rule_type === 'blocked_topic' || form.rule_type === 'frustration_signal') ? (
                <div>
                  <label className="block text-dt-support mb-1">Patterns (separate alternatives with |)</label>
                  <input value={form.pattern} onChange={e => setForm(f => ({ ...f, pattern: e.target.value }))}
                    placeholder="guarantee|we promise|legally binding"
                    className="w-full bg-dt-page border border-dt-border-strong rounded-lg px-3 py-2 text-dt-body font-mono placeholder:text-dt-faint focus:outline-none focus:border-indigo-500" />
                </div>
              ) : (
                <div>
                  <label className="block text-dt-support mb-1">
                    {form.rule_type === 'require_approval_over_cents' ? 'Threshold (dollars)' : 'Max discount (%)'}
                  </label>
                  <input value={form.threshold} onChange={e => setForm(f => ({ ...f, threshold: e.target.value }))}
                    placeholder={form.rule_type === 'require_approval_over_cents' ? '10000' : '20'} inputMode="numeric"
                    className="w-full bg-dt-page border border-dt-border-strong rounded-lg px-3 py-2 text-dt-body font-mono placeholder:text-dt-faint focus:outline-none focus:border-indigo-500" />
                </div>
              )}
              <p className="text-[11px] text-dt-muted">{ruleTypeMeta(form.rule_type).hint}.</p>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowAdd(false)}
                className="text-xs px-3 py-1.5 rounded-lg border border-dt-border-strong text-dt-support hover:bg-dt-panel transition-colors">Cancel</button>
              <button onClick={submitAdd} disabled={busy || !form.rule.trim() || scopeIncomplete}
                className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white transition-colors">
                {busy ? 'Saving…' : 'Add rule'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// GOVERNANCE — Compliance & Guardrails (gov_compliance)
// Three-layer guardrail model:
//   Industry Template (base) → Customer Overrides → Per-DE Restrictions
// Per-DE data is imported directly from WorkforceDEsPage seed data
// so the two views can never drift apart.
// ═══════════════════════════════════════════════════════════════

type Severity = 'blocking' | 'warning' | 'regulatory'

interface TemplateRule {
  id: string
  text: string
  category: 'Data handling' | 'AI conduct' | 'Industry-specific'
  severity: Severity
}

const INDUSTRY_TEMPLATES = [
  { name: 'Healthcare (HIPAA)', version: 'v3.1' },
  { name: 'Manufacturing', version: 'v2.0' },
  { name: 'Technology / SaaS', version: 'v4.0' },
  { name: 'Retail / eCommerce', version: 'v2.4' },
  { name: 'Financial Services', version: 'v6.2' },
]

const TEMPLATE_RULES: Record<CompanyId, TemplateRule[]> = {
  tcp: [
    // Data handling
    { id: 'dh1', text: 'PII masking required in all DE responses and logs', category: 'Data handling', severity: 'regulatory' },
    { id: 'dh2', text: 'Customer data must remain in approved data-residency regions (US/EU)', category: 'Data handling', severity: 'regulatory' },
    { id: 'dh3', text: 'Conversation retention limited to 24 months unless legal hold applies', category: 'Data handling', severity: 'blocking' },
    // AI conduct
    { id: 'ac1', text: 'No legal or medical advice — route to human specialist', category: 'AI conduct', severity: 'blocking' },
    { id: 'ac2', text: 'DE must disclose AI identity when asked or on first contact', category: 'AI conduct', severity: 'regulatory' },
    { id: 'ac3', text: 'Content filtering active on all outbound channels', category: 'AI conduct', severity: 'blocking' },
    // Industry-specific
    { id: 'is1', text: 'SOC 2 access controls enforced on all connected systems', category: 'Industry-specific', severity: 'regulatory' },
    { id: 'is2', text: 'GDPR / CCPA data-subject request handling within statutory windows', category: 'Industry-specific', severity: 'regulatory' },
    { id: 'is3', text: 'API data protection — no raw API keys or tokens in DE output', category: 'Industry-specific', severity: 'blocking' },
    { id: 'is4', text: 'Beta-feature commitments require product-team confirmation', category: 'Industry-specific', severity: 'warning' },
  ],
  pwc: [
    // Data handling
    { id: 'dh1', text: 'PII redaction required in all DE responses and stored artifacts', category: 'Data handling', severity: 'regulatory' },
    { id: 'dh2', text: 'Client data must remain in approved data-residency regions', category: 'Data handling', severity: 'regulatory' },
    { id: 'dh3', text: 'Engagement records retained 7 years per regulatory requirement', category: 'Data handling', severity: 'regulatory' },
    // AI conduct
    { id: 'ac1', text: 'No legal or medical advice — route to attorney or specialist', category: 'AI conduct', severity: 'blocking' },
    { id: 'ac2', text: 'DE must disclose AI identity when asked or on first contact', category: 'AI conduct', severity: 'regulatory' },
    { id: 'ac3', text: 'Strict content filtering on all client-facing channels', category: 'AI conduct', severity: 'blocking' },
    // Industry-specific
    { id: 'is1', text: 'SEC / FINRA communication rules applied to all client messaging', category: 'Industry-specific', severity: 'regulatory' },
    { id: 'is2', text: 'Auditor independence rules — no conflicting engagements', category: 'Industry-specific', severity: 'regulatory' },
    { id: 'is3', text: 'AML / KYC verification required before engagement work begins', category: 'Industry-specific', severity: 'regulatory' },
    { id: 'is4', text: 'PCAOB documentation standards on all audit-adjacent output', category: 'Industry-specific', severity: 'blocking' },
    { id: 'is5', text: 'Fee discussions flagged for engagement-partner visibility', category: 'Industry-specific', severity: 'warning' },
  ],
}

interface OverrideRow {
  id: string
  rule: string
  type: 'allow' | 'restrict'
  appliesTo: string
  addedBy: string
  date: string
  version: string
}

// Seed overrides mirror the customerOverrides on the DE configs in
// WorkforceDEsPage (rule text verbatim), rolled up to the org level.
const SEED_OVERRIDES: Record<CompanyId, OverrideRow[]> = {
  tcp: [
    { id: 'co1', rule: 'Never quote competitor pricing', type: 'restrict', appliesTo: 'All DEs', addedBy: 'Admin', date: '2026-03-01', version: 'v2.1' },
    { id: 'co2', rule: 'Always offer free trial extension on churn risk', type: 'allow', appliesTo: 'Alex, Casey', addedBy: 'CSM Lead', date: '2026-04-15', version: 'v2.2' },
    { id: 'co3', rule: 'Max 20% discount without VP approval', type: 'restrict', appliesTo: 'Casey', addedBy: 'Finance', date: '2026-02-01', version: 'v1.7' },
  ],
  pwc: [
    { id: 'co1', rule: 'Require partner sign-off on all client commitments >$50K', type: 'restrict', appliesTo: 'All DEs', addedBy: 'Risk', date: '2026-02-10', version: 'v3.0' },
  ],
}

// ── Version history ────────────────────────────────────────────
interface VersionRow { version: string; date: string; summary: string; changedBy: string; diff: { removed: string[]; added: string[] } }

const VERSION_HISTORY: Record<CompanyId, VersionRow[]> = {
  tcp: [
    { version: 'v2.3', date: '2026-05-01', summary: 'Alex — added "No SLA commitments not in standard tier" restriction', changedBy: 'K. Douglas (Security)',
      diff: { removed: [], added: ['Alex › restrictions: "No SLA commitments not in standard tier" (blocking)'] } },
    { version: 'v2.2', date: '2026-04-15', summary: 'Customer override added — free trial extension on churn risk', changedBy: 'CSM Lead',
      diff: { removed: [], added: ['Overrides › allow: "Free trial extension allowed on churn risk" (applies to: Casey)'] } },
    { version: 'v2.1', date: '2026-03-01', summary: 'Customer override added — never quote competitor pricing', changedBy: 'Admin',
      diff: { removed: [], added: ['Overrides › restrict: "Never quote competitor pricing" (applies to: all DEs)'] } },
    { version: 'v2.0', date: '2026-02-10', summary: 'Re-based on Technology / SaaS template v4.0 (from v3.8)', changedBy: 'System',
      diff: { removed: ['Template base: Technology / SaaS v3.8'], added: ['Template base: Technology / SaaS v4.0', 'New template rule: "API data protection — no keys or tokens in DE output" (regulatory, locked)', 'All existing overrides re-validated against v4.0 — 0 conflicts'] } },
    { version: 'v1.8', date: '2026-04-01', summary: 'Casey — write-off limit raised to $2,500 with Finance approval gate', changedBy: 'Finance',
      diff: { removed: ['Casey › restrictions: "No write-offs >$1,000"'], added: ['Casey › restrictions: "No write-offs >$2,500" + approval gate: Finance Manager'] } },
    { version: 'v1.5', date: '2026-01-15', summary: 'Riley — PII handling set to hash; content filter set to strict', changedBy: 'HR Director',
      diff: { removed: ['Riley › PII handling: mask', 'Riley › content filter: standard'], added: ['Riley › PII handling: hash', 'Riley › content filter: strict'] } },
  ],
  pwc: [
    { version: 'v3.1', date: '2026-05-01', summary: 'Morgan — added fee-adjustment restriction ($5,000 cap)', changedBy: 'Quality & Risk',
      diff: { removed: [], added: ['Morgan › restrictions: "No fee adjustments >$5,000" (blocking)'] } },
    { version: 'v3.0', date: '2026-02-10', summary: 'Customer override added — partner sign-off on commitments >$50K', changedBy: 'Risk',
      diff: { removed: [], added: ['Overrides › restrict: "Partner sign-off on client commitments >$50K" (applies to: all DEs)'] } },
    { version: 'v2.4', date: '2026-06-01', summary: 'Avery — PCAOB independence conflict rule added', changedBy: 'Quality & Risk',
      diff: { removed: [], added: ['Avery › restrictions: "No PCAOB independence conflicts" (regulatory, locked)'] } },
    { version: 'v2.3', date: '2026-03-01', summary: 'Re-based on Financial Services template v6.2 (from v6.0)', changedBy: 'System',
      diff: { removed: ['Template base: Financial Services v6.0'], added: ['Template base: Financial Services v6.2', 'New template rule: "Sanctions screening required before client onboarding" (regulatory, locked)'] } },
    { version: 'v2.0', date: '2026-01-20', summary: 'All DEs — PII handling set to redact per firm policy', changedBy: 'Managing Partner',
      diff: { removed: ['Morgan › PII handling: mask', 'Avery › PII handling: mask'], added: ['Morgan › PII handling: redact', 'Avery › PII handling: redact'] } },
  ],
}

// ── Compliance calendar ────────────────────────────────────────
const CALENDAR: Record<CompanyId, { item: string; date: string; overdue: boolean }[]> = {
  tcp: [
    { item: 'SOC 2 evidence collection', date: 'Jul 10', overdue: true },
    { item: 'Annual penetration test', date: 'Aug 1', overdue: false },
    { item: 'GDPR processing review', date: 'Sep 15', overdue: false },
  ],
  pwc: [
    { item: 'Independence attestation', date: 'Jul 8', overdue: true },
    { item: 'FINRA filing window', date: 'Jul 15', overdue: false },
    { item: 'AML training refresh', date: 'Aug 30', overdue: false },
  ],
}

const ACTIVE_TEMPLATE: Record<CompanyId, { name: string; version: string }> = {
  tcp: { name: 'Technology / SaaS', version: 'v4.0' },
  pwc: { name: 'Financial Services', version: 'v6.2' },
}

// ── Small helpers ──────────────────────────────────────────────

function SeverityBadge({ severity }: { severity: Severity }) {
  const styles: Record<Severity, string> = {
    blocking: 'bg-red-500/15 text-red-300',
    warning: 'bg-amber-500/15 text-amber-300',
    regulatory: 'bg-indigo-500/15 text-indigo-300',
  }
  return <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded ${styles[severity]}`}>{severity}</span>
}

function CategoryBadge({ category }: { category: string }) {
  return <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-panel text-dt-support">{category}</span>
}

function Toggle({ enabled, onChange, disabled }: { enabled: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      onClick={() => !disabled && onChange(!enabled)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${disabled ? 'bg-dt-panel cursor-not-allowed' : enabled ? 'bg-indigo-600' : 'bg-slate-600'}`}
      title={disabled ? 'Regulatory rule — cannot be disabled' : undefined}
    >
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : 'translate-x-1'}`} />
    </button>
  )
}

// ── Page ───────────────────────────────────────────────────────

export default function CompliancePage({ setPage }: { setPage: (p: Page) => void }) {
  const dataMode = useDataMode()
  if (dataMode === 'live') return <LiveCompliancePage setPage={setPage} />
  return <DemoCompliancePage setPage={setPage} />
}

function DemoCompliancePage({ setPage }: { setPage: (p: Page) => void }) {
  const { activeCompanyId } = useAuth()
  const companyId = activeCompanyId
  const des = companyId === 'tcp' ? TCP_DES : PWC_DES
  const [template, setTemplate] = useState(ACTIVE_TEMPLATE[companyId])
  useEffect(() => { setTemplate(ACTIVE_TEMPLATE[companyId]) }, [companyId])
  const rules = TEMPLATE_RULES[companyId]
  const calendar = CALENDAR[companyId]
  const versions = VERSION_HISTORY[companyId]
  const [openDiff, setOpenDiff] = useState<string | null>(null)

  const deRestrictionCount = des.reduce((n, d) => n + d.guardrails.deRestrictions.length, 0)

  // Disabled rules — persisted per company
  const disabledKey = `dt_gov_rules_disabled_${companyId}`
  const [disabledRules, setDisabledRules] = useState<string[]>(() => {
    try { const s = localStorage.getItem(disabledKey); return s ? JSON.parse(s) : [] } catch { return [] }
  })
  const toggleRule = (id: string, enabled: boolean) => {
    const next = enabled ? disabledRules.filter(r => r !== id) : [...disabledRules, id]
    setDisabledRules(next)
    try { localStorage.setItem(disabledKey, JSON.stringify(next)) } catch { /* noop */ }
  }

  // Customer overrides — persisted per company
  const overridesKey = `dt_gov_overrides_${companyId}`
  const [overrides, setOverrides] = useState<OverrideRow[]>(() => {
    try { const s = localStorage.getItem(overridesKey); return s ? JSON.parse(s) : SEED_OVERRIDES[companyId] } catch { return SEED_OVERRIDES[companyId] }
  })
  const saveOverrides = (next: OverrideRow[]) => {
    setOverrides(next)
    try { localStorage.setItem(overridesKey, JSON.stringify(next)) } catch { /* noop */ }
  }

  const [showAddForm, setShowAddForm] = useState(false)
  const [newRule, setNewRule] = useState('')
  const [newType, setNewType] = useState<'allow' | 'restrict'>('restrict')
  const [newAppliesTo, setNewAppliesTo] = useState('All DEs')

  const addOverride = () => {
    if (!newRule.trim()) return
    const maxV = Math.max(...versions.map(v => parseFloat(v.version.slice(1))), ...overrides.map(o => parseFloat(o.version.slice(1))))
    const next: OverrideRow = {
      id: `co_${Date.now()}`,
      rule: newRule.trim(),
      type: newType,
      appliesTo: newAppliesTo,
      addedBy: 'You',
      date: new Date().toISOString().slice(0, 10),
      version: `v${(maxV + 0.1).toFixed(1)}`,
    }
    saveOverrides([...overrides, next])
    setNewRule(''); setNewType('restrict'); setNewAppliesTo('All DEs'); setShowAddForm(false)
  }

  // Template change dialog
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false)
  const [pendingTemplate, setPendingTemplate] = useState<string | null>(null)
  const [removeOverrideTarget, setRemoveOverrideTarget] = useState<OverrideRow | null>(null)

  const layerCards = [
    { title: 'Industry Template', sub: 'base', detail: `${template.name} ${template.version}` },
    { title: 'Customer Overrides', sub: 'org-level', detail: `${overrides.length} override${overrides.length === 1 ? '' : 's'}` },
    { title: 'Per-DE Restrictions', sub: 'role-level', detail: `${deRestrictionCount} restrictions across ${des.length} DEs` },
  ]

  const grouped = ['Data handling', 'AI conduct', 'Industry-specific'].map(cat => ({
    cat,
    rules: rules.filter(r => r.category === cat),
  }))

  return (
    <div className="p-6">
      <PageHeader
        title="Compliance & Guardrails"
        subtitle="Layered guardrail architecture — industry template, customer overrides, and per-DE restrictions. All versioned, all auditable."
      />

      {/* ── Layer visual ── */}
      <div className="flex items-stretch gap-2 mb-6">
        {layerCards.map((l, i) => (
          <React.Fragment key={l.title}>
            <div className="flex-1 bg-dt-card border border-dt-border rounded-xl p-4">
              <p className="text-[10px] uppercase tracking-wider text-dt-muted mb-1">Layer {i + 1} · {l.sub}</p>
              <p className="text-sm font-semibold text-white">{l.title}</p>
              <p className="text-xs text-indigo-400 mt-1.5">{l.detail}</p>
            </div>
            {i < layerCards.length - 1 && (
              <div className="flex items-center text-dt-faint text-lg flex-shrink-0">→</div>
            )}
          </React.Fragment>
        ))}
      </div>

      {/* ── Compliance calendar strip ── */}
      <div className="flex flex-wrap gap-2 mb-6">
        <span className="text-xs text-dt-muted self-center mr-1">Upcoming deadlines:</span>
        {calendar.map(c => (
          <span key={c.item} className={`text-xs px-3 py-1.5 rounded-lg border ${c.overdue ? 'border-red-500/40 bg-red-500/10 text-red-300' : 'border-dt-border bg-dt-card text-dt-support'}`}>
            {c.item} · {c.date}{c.overdue && ' — overdue'}
          </span>
        ))}
      </div>

      <div className="space-y-6">
        {/* ── Section A: Industry Template ── */}
        <div className="bg-dt-card border border-dt-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
            <div>
              <p className="text-xs font-medium text-dt-muted uppercase tracking-wider mb-1">Layer 1 — Industry Template</p>
              <p className="text-sm font-semibold text-white">{template.name} <span className="text-indigo-400">{template.version}</span></p>
            </div>
            <div className="relative">
              <button onClick={() => setTemplatePickerOpen(!templatePickerOpen)}
                className="text-xs px-3 py-1.5 rounded-lg bg-dt-panel border border-dt-border-strong text-dt-support hover:bg-dt-panel transition-colors">
                Change template ▾
              </button>
              {templatePickerOpen && (
                <div className="absolute right-0 mt-1 w-64 bg-dt-card border border-dt-border-strong rounded-xl shadow-xl z-20 py-1">
                  {INDUSTRY_TEMPLATES.map(t => (
                    <button key={t.name}
                      onClick={() => { setTemplatePickerOpen(false); if (t.name !== template.name) setPendingTemplate(`${t.name} ${t.version}`) }}
                      className={`w-full text-left px-3 py-2 text-xs transition-colors ${t.name === template.name ? 'text-indigo-400 bg-indigo-500/10' : 'text-dt-support hover:bg-dt-panel'}`}>
                      {t.name} <span className="text-dt-muted">{t.version}</span>
                      {t.name === template.name && <span className="float-right">✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {grouped.map(g => (
            <div key={g.cat} className="mb-4 last:mb-0">
              <p className="text-[11px] uppercase tracking-wide text-dt-muted mb-2">{g.cat}</p>
              <div className="space-y-1.5">
                {g.rules.map(r => {
                  const isRegulatory = r.severity === 'regulatory'
                  const enabled = !disabledRules.includes(r.id)
                  return (
                    <div key={r.id} className="flex items-center gap-3 bg-dt-page rounded-lg px-3 py-2.5">
                      <span className={`text-sm flex-1 ${enabled ? 'text-dt-body' : 'text-dt-muted line-through'}`}>{r.text}</span>
                      <CategoryBadge category={r.category} />
                      <SeverityBadge severity={r.severity} />
                      {isRegulatory ? (
                        <span className="text-dt-muted text-sm w-9 text-center" title="Regulatory rule — cannot be disabled">🔒</span>
                      ) : (
                        <Toggle enabled={enabled} onChange={v => toggleRule(r.id, v)} />
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        {/* ── Section B: Customer Overrides ── */}
        <div className="bg-dt-card border border-dt-border rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-dt-border flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-dt-muted uppercase tracking-wider mb-1">Layer 2 — Customer Overrides</p>
              <p className="text-xs text-dt-support">Org-level rules layered on top of the industry template</p>
            </div>
            <button onClick={() => setShowAddForm(!showAddForm)}
              className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs px-3 py-1.5 rounded-lg transition-colors">
              {showAddForm ? 'Cancel' : '+ Add Override'}
            </button>
          </div>

          {showAddForm && (
            <div className="px-5 py-4 border-b border-dt-border bg-dt-inset flex flex-wrap gap-3 items-end">
              <div className="flex-1 min-w-[220px]">
                <label className="text-xs text-dt-muted block mb-1">Rule</label>
                <input value={newRule} onChange={e => setNewRule(e.target.value)} placeholder="e.g. No refunds over $1,000 without approval"
                  className="w-full bg-dt-page border border-dt-border-strong rounded-lg px-3 py-1.5 text-sm text-dt-body focus:outline-none focus:border-slate-500" />
              </div>
              <div>
                <label className="text-xs text-dt-muted block mb-1">Type</label>
                <select value={newType} onChange={e => setNewType(e.target.value as 'allow' | 'restrict')}
                  className="bg-dt-page border border-dt-border-strong rounded-lg px-3 py-1.5 text-sm text-dt-body focus:outline-none">
                  <option value="restrict">Restrict</option>
                  <option value="allow">Allow</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-dt-muted block mb-1">Applies to</label>
                <select value={newAppliesTo} onChange={e => setNewAppliesTo(e.target.value)}
                  className="bg-dt-page border border-dt-border-strong rounded-lg px-3 py-1.5 text-sm text-dt-body focus:outline-none">
                  <option>All DEs</option>
                  {des.map(d => <option key={d.id}>{d.name}</option>)}
                </select>
              </div>
              <button onClick={addOverride} className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-4 py-1.5 rounded-lg">Add</button>
            </div>
          )}

          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-dt-border">
                <th className={th}>Rule</th>
                <th className={th}>Type</th>
                <th className={th}>Applies to</th>
                <th className={th}>Added by</th>
                <th className={th}>Date</th>
                <th className={th}>Version</th>
                <th className={th}></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50">
              {overrides.map(o => (
                <tr key={o.id} className="hover:bg-dt-panel/20 transition-colors">
                  <td className={`${td} text-dt-body`}>{o.rule}</td>
                  <td className={td}>
                    <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded ${o.type === 'restrict' ? 'bg-red-500/15 text-red-300' : 'bg-emerald-500/15 text-emerald-300'}`}>{o.type}</span>
                  </td>
                  <td className={`${td} text-dt-support text-xs`}>{o.appliesTo}</td>
                  <td className={`${td} text-dt-support text-xs`}>{o.addedBy}</td>
                  <td className={`${td} text-dt-muted text-xs`}>{o.date}</td>
                  <td className={`${td} text-indigo-400 text-xs`}>{o.version}</td>
                  <td className={`${td} text-right`}>
                    <button onClick={() => setRemoveOverrideTarget(o)}
                      className="text-dt-muted hover:text-red-400 text-xs transition-colors">Remove</button>
                  </td>
                </tr>
              ))}
              {overrides.length === 0 && (
                <tr><td colSpan={7} className="py-8 text-center text-dt-faint text-sm">No customer overrides — the industry template applies as-is.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* ── Section C: Per-DE Restrictions ── */}
        <div>
          <p className="text-xs font-medium text-dt-muted uppercase tracking-wider mb-3">Layer 3 — Per-DE Restrictions</p>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {des.map(de => (
              <div key={de.id} className="bg-dt-card border border-dt-border rounded-xl p-4 flex flex-col">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="text-sm font-semibold text-white">{de.name}</p>
                    <p className="text-xs text-dt-muted">{de.role}</p>
                  </div>
                  <span className="text-xs text-indigo-400">Guardrails v{de.guardrails.version}</span>
                </div>
                <div className="flex gap-2 mb-3">
                  <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded ${de.guardrails.piiHandling === 'redact' ? 'bg-red-500/15 text-red-300' : de.guardrails.piiHandling === 'hash' ? 'bg-amber-500/15 text-amber-300' : 'bg-indigo-500/15 text-indigo-300'}`}>
                    PII: {de.guardrails.piiHandling}
                  </span>
                  <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded ${de.guardrails.contentFilter === 'strict' ? 'bg-red-500/15 text-red-300' : 'bg-dt-panel text-dt-support'}`}>
                    Filter: {de.guardrails.contentFilter}
                  </span>
                </div>
                <ul className="space-y-1.5 flex-1">
                  {de.guardrails.deRestrictions.map((r, i) => (
                    <li key={i} className="text-xs text-dt-support flex items-start gap-2">
                      <span className="text-red-400 flex-shrink-0 mt-0.5">•</span>{r}
                    </li>
                  ))}
                </ul>
                <button onClick={() => setPage('workforce_des')}
                  className="mt-3 text-xs text-indigo-400 hover:text-indigo-300 text-left transition-colors">
                  Configure in DE profile →
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* ── Section D: Version History ── */}
        <div className="bg-dt-card border border-dt-border rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-dt-border flex items-center justify-between flex-wrap gap-2">
            <p className="text-xs font-medium text-dt-muted uppercase tracking-wider">Version History</p>
            <div className="flex items-center gap-3">
              <button onClick={() => setPage('gov_audit')} className="text-xs text-dt-muted">
                Every guardrail change is versioned and auditable — <span className="text-indigo-400 hover:text-indigo-300">see Audit Trail →</span>
              </button>
              <button onClick={() => setPage('gov_trust')} className="text-xs text-indigo-400 hover:text-indigo-300">
                Trust &amp; Architecture →
              </button>
            </div>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-dt-border">
                <th className={th}>Version</th>
                <th className={th}>Date</th>
                <th className={th}>Change summary</th>
                <th className={th}>Changed by</th>
                <th className={th}></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50">
              {versions.map(v => {
                const key = `${v.version}-${v.date}`
                const open = openDiff === key
                return (
                  <React.Fragment key={key}>
                    <tr className="hover:bg-dt-panel/20 transition-colors">
                      <td className={`${td} text-indigo-400 font-mono text-xs`}>{v.version}</td>
                      <td className={`${td} text-dt-muted text-xs`}>{v.date}</td>
                      <td className={`${td} text-dt-body text-xs`}>{v.summary}</td>
                      <td className={`${td} text-dt-support text-xs`}>{v.changedBy}</td>
                      <td className={`${td} text-right`}>
                        <button
                          onClick={() => setOpenDiff(open ? null : key)}
                          className={`text-xs px-2 py-1 rounded-lg border transition-colors ${open ? 'border-indigo-500 text-indigo-300' : 'border-dt-border-strong text-dt-support hover:text-white hover:border-dt-border-strong'}`}>
                          {open ? 'Hide diff' : 'Diff'}
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={5} className="px-5 py-3 bg-dt-inset">
                          <div className="font-mono text-xs space-y-1">
                            {v.diff.removed.map((line, i) => (
                              <div key={`r${i}`} className="text-red-400/90 bg-red-500/5 rounded px-2 py-1">− {line}</div>
                            ))}
                            {v.diff.added.map((line, i) => (
                              <div key={`a${i}`} className="text-emerald-400/90 bg-emerald-500/5 rounded px-2 py-1">+ {line}</div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Template change confirm dialog ── */}
      {pendingTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setPendingTemplate(null)}>
          <div className="bg-dt-card border border-dt-border-strong rounded-2xl p-6 w-[420px] max-w-[90vw]" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-white mb-2">Change industry template?</h3>
            <p className="text-xs text-dt-support leading-relaxed mb-1">
              Switch from <span className="text-white">{template.name} {template.version}</span> to <span className="text-white">{pendingTemplate}</span>.
            </p>
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-xs text-amber-300 my-4">
              This re-bases all guardrails; overrides are preserved and re-validated against the new template.
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setPendingTemplate(null)}
                className="text-xs px-3 py-1.5 rounded-lg border border-dt-border-strong text-dt-support hover:bg-dt-panel transition-colors">Cancel</button>
              <button
                onClick={() => {
                  const [name, version] = [pendingTemplate!.slice(0, pendingTemplate!.lastIndexOf(' ')), pendingTemplate!.slice(pendingTemplate!.lastIndexOf(' ') + 1)]
                  setTemplate({ name, version })
                  setPendingTemplate(null)
                }}
                className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors">Re-base guardrails</button>
            </div>
          </div>
        </div>
      )}
      {removeOverrideTarget && (
        <ConfirmDeleteModal
          title="Remove override"
          message={`Remove the override "${removeOverrideTarget.rule}"? This tenant will fall back to the industry template's default for this rule.`}
          confirmLabel="Remove"
          onClose={() => setRemoveOverrideTarget(null)}
          onConfirm={() => { saveOverrides(overrides.filter(x => x.id !== removeOverrideTarget.id)); setRemoveOverrideTarget(null) }}
        />
      )}
    </div>
  )
}
