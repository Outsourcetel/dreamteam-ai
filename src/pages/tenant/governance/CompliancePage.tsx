import { useIsTenantAdmin } from '../../../lib/useRoleGate';
import React, { useState, useEffect } from 'react'
import { Modal, StatTile, Button, INPUT_CLS } from '../../../design/primitives'
import type { Tone } from '../../../design/primitives'
import { useAuth } from '../../../context/AuthContext'
import type { Page } from '../../../types'
import type { CompanyId } from '../../../data/companies'
import { PageHeader, th, td } from '../../../components/ui'
import { CustomerApiError } from '../../../lib/customerApi'
import {
  listGuardrailRules, listRetiredGuardrailRules, addGuardrailRule, updateGuardrailRule,
  retireGuardrailRule, restoreGuardrailRule, installStarterGuardrails,
  getGuardrailBlockCounts, getEnforcementStatus,
} from '../../../lib/guardrailApi'
import type { GuardrailRule, GuardrailRuleType, GuardrailScope, EnforcementStatus } from '../../../lib/guardrailApi'
import { listDigitalEmployees } from '../../../lib/digitalEmployeesApi'
import type { DigitalEmployee } from '../../../lib/digitalEmployeesApi'
import { LiveLoadingSkeleton, MissingTablesNotice, LiveEmptyState } from '../../../components/LiveDataStates'
import GovernanceAIPanel from '../../../components/GovernanceAIPanel'
import GuardrailAdjudicationPanel from '../../../components/GuardrailAdjudicationPanel'
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

// ═══════════════════════════════════════════════════════════════
// The Enforcement tile.
//
// ⚠ THIS USED TO BE THE STRING 'Live', HARDCODED, DERIVED FROM NOTHING. It was
// wrong: measured on 2026-08-12, only ONE of the three screening layers was
// actually stopping anything. Deterministic word/phrase matching was live (30
// guardrail_block events); the meaning judge was off platform-wide (no
// `semantic_guardrail.enabled` row at all, so the master gate fails inert —
// note the feature_registry row says default_enabled=true, which is exactly how
// reading the wrong table produces a confident wrong answer); and the AI second
// opinion was in shadow mode, recording what it would have done and applying
// none of it.
//
// The rule for this function is the same one that made the tile a defect: never
// replace one confident string with another. Every branch below is derived from
// a value read out of config at request time, and the failure branch SAYS it
// failed rather than falling back to a reassuring word.
// ═══════════════════════════════════════════════════════════════
function describeEnforcement(s: EnforcementStatus | null, checked: boolean):
  { value: string; sub: string; explain: string; tone: Tone } {
  if (!checked) return { value: '…', sub: 'Checking', explain: '', tone: 'neutral' }
  if (!s) {
    return {
      value: 'Unknown',
      sub: "Couldn't read the settings",
      explain: 'The check for what is currently switched on did not come back. This tile says so rather than guessing — the version before this one printed "Live" no matter what was true.',
      tone: 'warn',
    }
  }
  // 'watching only' = shadow: the layer runs, records a verdict, and changes
  // nothing. That is not enforcement and must never be worded as if it were.
  const layer = (l: { enabled: boolean; mode: 'shadow' | 'enforce' | null }) =>
    !l.enabled ? 'off' : l.mode === 'enforce' ? 'on' : 'watching only'
  const meaning = layer(s.semantic)
  const review = layer(s.adjudication)
  const n = s.patterns.blocking_rules
  const rules = `${n} blocking rule${n === 1 ? '' : 's'}`

  if (n === 0) {
    return {
      value: 'Nothing to enforce',
      sub: 'No blocking rule is switched on',
      explain: `Word and phrase checking runs on every answer, but this workspace has no active blocking rule for it to check against. Meaning check: ${meaning}. AI second opinion: ${review}.`,
      tone: 'warn',
    }
  }
  const meaningEnforcing = s.semantic.enabled && s.semantic.mode === 'enforce'
  return {
    value: meaningEnforcing ? 'Words + meaning' : 'Words only',
    sub: `${rules} · meaning check ${meaning}`,
    explain: `Word and phrase checking is live and withholds answers now (${rules}). `
      + `Meaning check — catches a rephrased breach the patterns miss: ${meaning}. `
      + `AI second opinion — can release an answer the patterns flagged by mistake: ${review}. `
      + `"Watching only" means the layer runs and records what it would have done, and changes nothing.`,
    tone: meaningEnforcing ? 'ok' : 'info',
  }
}

function LiveCompliancePage({ setPage }: { setPage: (p: Page) => void }) {
  // guardrail_rules is owner/admin in RLS; this page is MANAGE, so a
  // manager could add a rule, toggle one, or install the starter set and
  // watch nothing happen. Reading the rules stays open — knowing what the
  // guardrails ARE is most of the value of this page.
  const canEditGuardrails = useIsTenantAdmin();
  const [rules, setRules] = useState<GuardrailRule[]>([])
  // How often each rule has actually stopped something, last 30 days.
  const [blocks, setBlocks] = useState<Record<string, { count: number; last_at: string }>>({})
  const [loading, setLoading] = useState(true)
  const [missingTables, setMissingTables] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  // The composer serves both jobs — null means "adding", a rule means "editing
  // that rule". updateGuardrailRule has always accepted rule/pattern/threshold/
  // severity; nothing on this page ever offered them.
  const [editing, setEditing] = useState<GuardrailRule | null>(null)
  // The retired shelf. Loaded only when someone asks for it — the point of
  // retiring is that these stay out of the way while staying recoverable.
  const [retired, setRetired] = useState<GuardrailRule[]>([])
  const [showRetired, setShowRetired] = useState(false)
  const [confirmRetire, setConfirmRetire] = useState<GuardrailRule | null>(null)
  const [retireReason, setRetireReason] = useState('')
  // What is actually switched on, read from config rather than asserted.
  // `checked` separates "not back yet" from "came back empty", which is the
  // difference between a spinner and a claim.
  const [enforcement, setEnforcement] = useState<EnforcementStatus | null>(null)
  const [enforcementChecked, setEnforcementChecked] = useState(false)
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
      const [r, d, b, e] = await Promise.all([
        listGuardrailRules(),
        listDigitalEmployees().catch(() => []),
        getGuardrailBlockCounts().catch(() => ({})),
        // Never allowed to take the page down, and never allowed to invent an
        // answer: it resolves to null when it could not be established, and the
        // tile renders that as "Unknown".
        getEnforcementStatus(),
      ])
      setRules(r)
      setDes(d)
      setBlocks(b)
      setEnforcement(e)
      setEnforcementChecked(true)
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

  const loadRetired = async () => {
    try { setRetired(await listRetiredGuardrailRules()) }
    catch { setRetired([]) }
  }

  const closeComposer = () => {
    setShowAdd(false)
    setEditing(null)
    setForm({ rule: '', rule_type: 'blocked_phrase', pattern: '', threshold: '', severity: 'blocking', scope: 'workspace', scope_ref: '' })
  }

  // Open the composer on an existing rule. Type and scope are shown but not
  // editable: updateGuardrailRule accepts rule | pattern | threshold |
  // applies_to | severity | active, and offering a control that silently does
  // nothing is the failure this page is being fixed for.
  const openEdit = (r: GuardrailRule) => {
    setEditing(r)
    setForm({
      rule: r.rule,
      rule_type: r.rule_type,
      pattern: r.pattern ?? '',
      // The money rule is stored in cents and typed in dollars, exactly as the
      // add path converts it — the reverse here, or an edit silently divides
      // the threshold by 100 every time it is saved.
      threshold: r.threshold == null ? ''
        : r.rule_type === 'require_approval_over_cents' ? String(r.threshold / 100)
        : String(r.threshold),
      severity: r.severity,
      scope: r.scope === 'department' || r.scope === 'employee' ? r.scope : 'workspace',
      scope_ref: r.scope_ref ?? '',
    })
    setShowAdd(true)
  }

  const submitRule = () => run(async () => {
    const isMoney = form.rule_type === 'require_approval_over_cents'
    const isPct = form.rule_type === 'max_discount_pct'
    const pattern = (!isMoney && !isPct && form.pattern.trim()) ? form.pattern.trim() : null
    const threshold = isMoney ? Math.round(Number(form.threshold) * 100) || null
      : isPct ? Math.round(Number(form.threshold)) || null : null
    if (editing) {
      await updateGuardrailRule(editing, {
        rule: form.rule.trim(), pattern, threshold, severity: form.severity,
      })
    } else {
      await addGuardrailRule({
        rule: form.rule.trim(),
        rule_type: form.rule_type,
        pattern,
        threshold,
        severity: form.severity,
        scope: form.scope,
        scope_ref: form.scope === 'workspace' ? null : (form.scope_ref || null),
      })
    }
    closeComposer()
  })

  const submitRetire = (r: GuardrailRule, reason: string) => run(async () => {
    await retireGuardrailRule(r, reason)
    setConfirmRetire(null)
    setRetireReason('')
    await loadRetired()
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

  const enf = describeEnforcement(enforcement, enforcementChecked)

  return (
    <div className="p-6">
      <PageHeader
        title="Compliance & Guardrails"
        subtitle="Checked on every action before anything happens — invoice approvals check them now; answers are checked as they are written. Every change to a rule is written to the record."
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
          onPrimary={() => { if (!busy && canEditGuardrails) void run(() => installStarterGuardrails()) }}
          secondaryLabel="Add a custom rule"
          onSecondary={() => { setEditing(null); setShowAdd(true) }}
        />
      ) : (
        <>
          {/* StatTile, not three hand-rolled boxes — the design system's own
              schema, and it is what gives the Enforcement tile a second line to
              be honest on. */}
          <div className="grid grid-cols-dt-kpis gap-3 mb-6">
            <StatTile label="Active rules" value={String(active.length)} />
            <StatTile label="Blocking" tone="danger"
              value={String(active.filter(r => r.severity === 'blocking').length)} />
            <StatTile label="Enforcement" value={enf.value} tone={enf.tone}
              sub={<span title={enf.explain}>{enf.sub}</span>} />
          </div>

          {/* GI-10: the human grant + the receipt, next to the rules they govern. */}
          <GuardrailAdjudicationPanel rules={rules} />

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
              {/* Clears `editing` on the way in — otherwise "+ Add rule"
                  after an edit reopens the composer still bound to that rule. */}
              <button disabled={!canEditGuardrails}
                onClick={() => { if (showAdd) closeComposer(); else { setEditing(null); setShowAdd(true) } }}
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
                    {['Rule', 'Has it stopped anything?', 'Type', 'Scope', 'Pattern / threshold', 'Severity', 'Version', 'Active', ''].map(h => (
                      <th key={h} className={th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {focusedRules.map(r => (
                    <tr key={r.id} className={`border-b border-dt-border last:border-b-0 ${r.active ? '' : 'opacity-50'}`}>
                      <td className={`${td} text-dt-body text-xs`}>{r.rule}</td>
                      {/* ⚠ THIS IS THE COLUMN THAT TELLS THEM APART. A rule
                          that fires daily and a rule that has never matched
                          anything looked identical here — same row, same
                          toggle — and they need opposite attention: one is
                          load-bearing, the other is redundant or written so it
                          can never match. Counted from real guardrail_block
                          events over 30 days, not from a setting. */}
                      <td className={td}>
                        {(() => {
                          const b = blocks[r.id]
                          if (!b) return <span className="text-xs text-dt-muted">Hasn't stopped anything</span>
                          return (
                            <span className="text-xs text-dt-warn" title={`Last stopped ${new Date(b.last_at).toLocaleString()}`}>
                              Stopped {b.count} {b.count === 1 ? 'time' : 'times'}
                            </span>
                          )
                        })()}
                      </td>
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
                        <Toggle enabled={r.active} disabled={busy || !canEditGuardrails}
                          onChange={(v) => void run(() => updateGuardrailRule(r, { active: v }))} />
                      </td>
                      {/* Edit and Retire. Both were missing entirely: the row
                          had one mutation (the toggle) even though the API
                          behind it has always accepted the rule text, pattern,
                          threshold and severity. */}
                      <td className={`${td} text-right whitespace-nowrap`}>
                        <span className="text-[10px] text-dt-faint mr-2">{new Date(r.updated_at).toLocaleDateString()}</span>
                        {canEditGuardrails && (
                          <>
                            <Button kind="ghost" size="sm" disabled={busy} onClick={() => openEdit(r)}
                              title="Change the wording, pattern, amount or severity">Edit</Button>
                            <Button kind="ghost" size="sm" disabled={busy || !!r.compliance_pack_key}
                              onClick={() => { setRetireReason(''); setConfirmRetire(r) }}
                              title={r.compliance_pack_key
                                ? `This rule comes from the "${r.compliance_pack_key}" compliance pack — detach the whole pack instead of removing one of its rules`
                                : 'Take this rule out of the list. It stops applying; the record of what it blocked is kept.'}>
                              Retire
                            </Button>
                          </>
                        )}
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

            {/* ── The retired shelf ──────────────────────────────────────────
                Retiring is not deleting: the row survives so a block recorded
                months ago still has something to point at, and so the decision
                is reversible. This is where it goes, and where it comes back
                from. */}
            <div className="mt-5 pt-4 border-t border-dt-border">
              <Button kind="ghost" size="sm"
                onClick={() => { const next = !showRetired; setShowRetired(next); if (next) void loadRetired() }}>
                {showRetired ? 'Hide retired rules' : 'Retired rules'}
                {showRetired && retired.length > 0 ? ` (${retired.length})` : ''}
              </Button>
              {showRetired && (
                retired.length === 0 ? (
                  <p className="mt-3 text-[11px] text-dt-muted">
                    Nothing retired. A retired rule stops applying but is kept, so the audit trail can still explain a block it caused.
                  </p>
                ) : (
                  <div className="mt-3 overflow-x-auto rounded-xl border border-dt-border">
                    <table className="w-full text-sm border-collapse">
                      <thead>
                        <tr className="border-b border-dt-border text-left">
                          {['Rule', 'Did it ever stop anything?', 'Type', 'Scope', 'Retired', ''].map(h => (
                            <th key={h} className={th}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {retired.map(r => (
                          <tr key={r.id} className="border-b border-dt-border last:border-b-0">
                            <td className={`${td} text-dt-body text-xs`}>{r.rule}</td>
                            {/* The reason the row was kept rather than deleted:
                                these counts still resolve. */}
                            <td className={td}>
                              {blocks[r.id]
                                ? <span className="text-xs text-dt-warn" title={`Last stopped ${new Date(blocks[r.id].last_at).toLocaleString()}`}>
                                    Stopped {blocks[r.id].count} {blocks[r.id].count === 1 ? 'time' : 'times'}
                                  </span>
                                : <span className="text-xs text-dt-muted">Never did</span>}
                            </td>
                            <td className={td}>
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-panel text-dt-support">{ruleTypeMeta(r.rule_type).label}</span>
                            </td>
                            <td className={td}>
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-panel text-dt-support">{scopeLabel(r)}</span>
                            </td>
                            <td className={`${td} text-[11px] text-dt-muted`}>
                              {r.retired_at ? new Date(r.retired_at).toLocaleDateString() : '—'}
                            </td>
                            <td className={`${td} text-right whitespace-nowrap`}>
                              {canEditGuardrails && (
                                <Button kind="ghost" size="sm" disabled={busy}
                                  title="Put it back in the list. It returns switched off — turning it back on is a separate decision."
                                  onClick={() => void run(async () => { await restoreGuardrailRule(r); await loadRetired() })}>
                                  Restore
                                </Button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              )}
            </div>
          </div>
        </>
      )}

      {/* Add / edit rule form — ONE composer. An edit screen that is a second
          copy of the add screen is two places for the money conversion and the
          pattern rules to drift apart. */}
      {showAdd && (
        <Modal size="md" onClose={closeComposer} title={editing ? 'Edit guardrail rule' : 'Add guardrail rule'}>
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
                  {editing ? (
                    // ⚠ NOT A DISABLED SELECT. What a rule IS cannot be changed
                    // in place — updateGuardrailRule does not accept rule_type,
                    // and changing it would leave a pattern or a threshold
                    // meaning something else. A control that looks operable and
                    // is not is exactly what this page is being fixed for, so
                    // the fact is stated instead of mimed.
                    <p className="px-3 py-2 rounded-lg bg-dt-inset border border-dt-border text-dt-support">
                      {ruleTypeMeta(editing.rule_type).label}
                    </p>
                  ) : (
                  <select value={form.rule_type} onChange={e => setForm(f => ({ ...f, rule_type: e.target.value as GuardrailRuleType }))}
                    className="w-full bg-dt-page border border-dt-border-strong rounded-lg px-3 py-2 text-dt-body focus:outline-none focus:border-indigo-500">
                    {(Object.keys(RULE_TYPE_META) as GuardrailRuleType[]).map(t => (
                      <option key={t} value={t}>{RULE_TYPE_META[t].label}</option>
                    ))}
                  </select>
                  )}
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
              {editing ? (
                <div>
                  <label className="block text-dt-support mb-1">Applies to</label>
                  <p className="px-3 py-2 rounded-lg bg-dt-inset border border-dt-border text-dt-support">
                    {scopeLabel(editing)}
                    <span className="text-dt-muted"> — who a rule covers is fixed once it exists. To move it, retire this one and add it where you want it.</span>
                  </p>
                </div>
              ) : (
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
              )}
              {!editing && form.scope === 'department' && departments.length === 0 && (
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
              <Button kind="secondary" size="sm" onClick={closeComposer}>Cancel</Button>
              <Button kind="primary" size="sm" onClick={submitRule}
                disabled={busy || !canEditGuardrails || !form.rule.trim() || (!editing && scopeIncomplete)}>
                {busy ? 'Saving…' : editing ? 'Save changes' : 'Add rule'}
              </Button>
            </div>
        </Modal>
      )}

      {/* Retire, confirmed. Deliberately NOT the shared ConfirmDeleteModal —
          this is not a delete, and a dialog that says "Delete" about something
          that survives would be the same class of untrue label the Enforcement
          tile just stopped being. */}
      {confirmRetire && (
        <Modal size="md" onClose={() => setConfirmRetire(null)} title="Retire this guardrail?">
          <div className="space-y-3">
            <p className="text-sm text-dt-body leading-relaxed">
              &ldquo;{confirmRetire.rule}&rdquo; will stop applying and leave this list.
            </p>
            <p className="text-xs text-dt-support leading-relaxed">
              The rule is kept, not deleted — that is what lets the audit trail still explain a block it
              caused months ago. You can restore it from &ldquo;Retired rules&rdquo; at any time; it comes
              back switched off.
            </p>
            <div className="text-xs">
              <label className="block text-dt-support mb-1">Why (optional — recorded in the audit trail)</label>
              <input value={retireReason} onChange={e => setRetireReason(e.target.value)}
                placeholder="e.g. replaced by the new pricing rule" className={INPUT_CLS} />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-5">
            <Button kind="secondary" size="sm" onClick={() => setConfirmRetire(null)}>Cancel</Button>
            {/* The gate is repeated here on purpose. The dialog is only
                reachable from an already-gated row button, and "you can only
                get here through a gate" is exactly the reasoning that has let
                ungated confirm buttons ship on this codebase before. */}
            <Button kind="danger" size="sm" disabled={busy || !canEditGuardrails}
              onClick={() => void submitRetire(confirmRetire, retireReason)}>
              {busy ? 'Retiring…' : 'Retire rule'}
            </Button>
          </div>
        </Modal>
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
  return <LiveCompliancePage setPage={setPage} />
}

