import { useIsTenantAdmin } from '../../../lib/useRoleGate';
import { useState, useEffect } from 'react'
import { Modal, StatTile, Button, INPUT_CLS } from '../../../design/primitives'
import type { Tone } from '../../../design/primitives'
import type { Page } from '../../../types'
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
import { getTenantCompliancePacks, detachCompliancePack } from '../../../lib/deWorkbenchApi'
import type { CompliancePackRow } from '../../../lib/deWorkbenchApi'
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
  // ── Compliance packs (migration 747) ────────────────────────────────────
  // A pack is a shared catalogue of BLOCKING rules that a hire can switch on
  // for the WHOLE workspace without anyone deciding to. Until 747 the product
  // had an attach control and no detach control at all — the rows were
  // undeletable by design (trg_guard_compliance_guardrails), the per-rule
  // Retire button correctly refuses them, and the thing it points at
  // ("detach the pack instead") had no caller anywhere in src/. This is that
  // caller.
  const [packs, setPacks] = useState<CompliancePackRow[]>([])
  const [confirmDetach, setConfirmDetach] = useState<CompliancePackRow | null>(null)
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
      const [r, d, b, e, cp] = await Promise.all([
        listGuardrailRules(),
        listDigitalEmployees().catch(() => []),
        getGuardrailBlockCounts().catch(() => ({})),
        // Never allowed to take the page down, and never allowed to invent an
        // answer: it resolves to null when it could not be established, and the
        // tile renders that as "Unknown".
        getEnforcementStatus(),
        // Additive strip — a workspace with no packs is the common case and a
        // failure here must not cost anyone their guardrail list.
        getTenantCompliancePacks().catch(() => [] as CompliancePackRow[]),
      ])
      setRules(r)
      setDes(d)
      setBlocks(b)
      setEnforcement(e)
      setPacks(cp)
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
      // ⚠ THE SAME FREE-TEXT FIELD, THE OTHER WRITER — and until 2026-08-17 the
      // other writer had no screen. `refund|` typed into Add was refused; saved
      // as `refund` and then changed to `refund|` HERE it was accepted, live and
      // blocking, muting every outbound message on all four enforcement paths.
      // Two clicks apart, one dialog, opposite answers. `updateGuardrailRule`
      // now runs the same screen with the same provenance, so re-saving one of
      // the 35 live rules that carry a metacharacter still works and a trailing
      // pipe does not.
      await updateGuardrailRule(editing, {
        rule: form.rule.trim(), pattern, threshold, severity: form.severity,
      }, 'hand_authored')
    } else {
      // 'hand_authored': `pattern` here is what a person typed into this form.
      // 35 of the 168 live active patterned rules carry a regex metacharacter,
      // so refusing them would take away a capability this page already has;
      // the empty-alternative and invisible-separator screens still run, and 0
      // live rules trip either.
      await addGuardrailRule({
        rule: form.rule.trim(),
        rule_type: form.rule_type,
        pattern,
        threshold,
        severity: form.severity,
        scope: form.scope,
        scope_ref: form.scope === 'workspace' ? null : (form.scope_ref || null),
      }, 'hand_authored')
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

  // What each attached pack is ENFORCING right now, counted from the real rows
  // rather than from the shared catalogue. listGuardrailRules already excludes
  // retired rows, so a pack detached and re-attached reports what is live today
  // rather than what the catalogue says it should be.
  const packRules = (packKey: string) => rules.filter(r => r.compliance_pack_key === packKey && r.active)

  const submitDetach = (p: CompliancePackRow) => run(async () => {
    await detachCompliancePack(p.pack_key)
    setConfirmDetach(null)
    // The rules do not disappear — they are retired, so they move to the shelf.
    // Reloading it here means the person can see where they went.
    if (showRetired) await loadRetired()
  })

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
      {error && <div className="mb-4 rounded-xl border border-dt-danger-border bg-dt-danger-soft px-4 py-3 text-xs text-dt-danger">{error}</div>}

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

          {/* ── Compliance packs ────────────────────────────────────────────
              ⚠ THE CONTROL THAT DID NOT EXIST. Accepting a hire — from the
              wizard or from a discovery recommendation — can switch on a whole
              pack of BLOCKING rules that apply to every employee in the
              workspace. 7 of 15 active role archetypes do exactly that. The
              individual rules correctly refuse to be retired one at a time, and
              the thing that refusal points at ("detach the pack instead") had
              no button, no API call and no caller anywhere. A control the
              customer cannot reach is not a control.

              Only rendered when a pack is actually attached: an empty section
              explaining a mechanism that is not running is noise on a page
              whose whole job is telling live rules from dead ones. */}
          {packs.length > 0 && (
            <div className="rounded-2xl border border-dt-border bg-dt-card p-6 mb-6">
              <h3 className="text-base font-semibold text-dt-title">Compliance packs</h3>
              <p className="text-xs text-dt-muted mt-0.5 mb-4">
                A pack is a ready-made set of blocking rules for a regulated activity. Hiring certain
                roles switches one on automatically, and it applies to <span className="text-dt-support">every</span> Digital
                Employee in this workspace — not just the one that brought it. Its rules cannot be edited or
                switched off one at a time; the pack comes off as a whole.
              </p>
              <div className="overflow-x-auto rounded-xl border border-dt-border">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-dt-border text-left">
                      {['Pack', 'What it blocks', 'In force since', ''].map(h => (
                        <th key={h} className={th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {packs.map(p => {
                      const prs = packRules(p.pack_key)
                      return (
                        <tr key={p.pack_key} className="border-b border-dt-border last:border-b-0 align-top">
                          <td className={`${td} text-dt-body text-xs`}>
                            {p.name || p.pack_key}
                            {p.domain && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-dt-panel text-dt-support">{p.domain}</span>}
                          </td>
                          <td className={`${td} text-xs text-dt-support`}>
                            {/* The rules themselves, verbatim. A count alone
                                ("2 blocking rules") is exactly the sentence
                                nobody can consent to. */}
                            {prs.length === 0
                              ? <span className="text-dt-muted">Nothing is in force from this pack right now.</span>
                              : (
                                <ul className="space-y-1">
                                  {prs.map(r => (
                                    <li key={r.id} className="leading-snug">
                                      <span className="text-dt-warn mr-1">blocks</span>{r.rule}
                                    </li>
                                  ))}
                                </ul>
                              )}
                          </td>
                          <td className={`${td} text-[11px] text-dt-muted whitespace-nowrap`}>
                            {p.attached_at ? new Date(p.attached_at).toLocaleDateString() : '—'}
                          </td>
                          <td className={`${td} text-right whitespace-nowrap`}>
                            {/* Gated on the SAME bar as every other write on
                                this page (owner/admin), because that is the bar
                                detach_compliance_pack itself enforces — a button
                                a manager can press and the database refuses is
                                the defect this page has been fixed for twice. */}
                            {canEditGuardrails && (
                              <Button kind="ghost" size="sm" disabled={busy}
                                onClick={() => setConfirmDetach(p)}
                                title="Take this pack off. Its rules stop applying to every employee; they are kept, not deleted.">
                                Take this pack off
                              </Button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="rounded-2xl border border-dt-border bg-dt-card p-6 mb-6">
            <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
              <div>
                <h3 className="text-base font-semibold text-dt-title">Guardrail rules</h3>
                <p className="text-xs text-dt-muted mt-0.5">Checked on every invoice generation and every DE answer. The same controls appear, pre-scoped, on each employee&apos;s Governance tab — this is the central view of all of them.</p>
              </div>
              <button onClick={() => setShowGovAI(v => !v)}
                className="text-xs px-3 py-1.5 rounded-lg bg-dt-accent-soft text-dt-accent-text hover:brightness-110 border border-dt-accent-border transition-colors">
                {showGovAI ? 'Close assistant' : '✨ Set up with AI'}
              </button>
              {/* Clears `editing` on the way in — otherwise "+ Add rule"
                  after an edit reopens the composer still bound to that rule. */}
              <button disabled={!canEditGuardrails}
                onClick={() => { if (showAdd) closeComposer(); else { setEditing(null); setShowAdd(true) } }}
                className="text-xs px-3 py-1.5 rounded-lg bg-dt-accent-strong hover:bg-dt-accent-hover text-white transition-colors">
                + Add rule
              </button>
            </div>

            {/* Governance rebuild: focus the cockpit on any level. */}
            <div className="flex items-center gap-2 mb-4 flex-wrap">
              <span className="text-[11px] text-dt-muted">Showing:</span>
              <select value={focus} onChange={e => setFocus(e.target.value)}
                className="bg-dt-page border border-dt-border text-dt-support text-xs rounded-lg px-2 py-1 focus:outline-none focus:border-dt-accent">
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
                <div className="text-[11px] font-medium text-dt-accent-text mb-2">
                  ✨ Proposed by the assistant for {govTarget.label} — needs your approval ({proposals.length})
                </div>
                <div className="space-y-1.5">
                  {proposals.map(p => (
                    <div key={p.id} className="flex items-center gap-2 text-xs rounded-lg border border-indigo-800/40 bg-dt-inset px-3 py-2">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-accent-soft text-dt-accent-text">{p.severity === 'warning' ? 'warns' : 'blocks'}</span>
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
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${r.scope === 'workspace' ? 'bg-dt-panel text-dt-support' : 'bg-dt-accent-soft text-dt-accent-text'}`}>{scopeLabel(r)}</span>
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
                          onChange={(v) => void run(() => updateGuardrailRule(r, { active: v }, 'hand_authored'))} />
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
              <button onClick={() => setPage('gov_audit')} className="text-dt-accent-text underline underline-offset-2 hover:brightness-110">audit trail</button>.
            </p>

            {/* ── The retired shelf ──────────────────────────────────────────
                Retiring is not deleting: the row survives so a block recorded
                months ago still has something to point at, and so the decision
                is reversible. This is where a hand-written rule goes, and where
                it comes back from.
                ⚠ A COMPLIANCE-PACK RULE ALSO LANDS HERE NOW (migration 747 made
                detach retire rather than delete) AND DOES NOT COME BACK FROM
                HERE — it comes back with its pack. The Restore column below
                branches on that; see its own note. */}
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
                            {/* ⚠ A PACK RULE HAS NO RESTORE, AND THAT IS NOT A
                                STYLE CHOICE — restore_guardrail_rule writes
                                `active = false`, and
                                trg_guard_compliance_guardrails refuses exactly
                                that on any row carrying a compliance_pack_key.
                                The button would error every single time it was
                                pressed. It could never be pressed on a pack rule
                                before migration 747, because detach DELETED the
                                rows and they never reached this shelf; 747
                                retires them instead, which is what puts them
                                here — so the shelf has to grow the branch in the
                                same change. The way back for a pack is the pack,
                                whole (attach revives the same rows, live), and
                                that is what the cell says instead of offering a
                                control the database refuses. The database also
                                refuses it in words now, because a control that
                                is only hidden is not gated. */}
                            <td className={`${td} text-right whitespace-nowrap`}>
                              {r.compliance_pack_key ? (
                                <span className="text-[11px] text-dt-muted"
                                  title={`These rules came from the "${r.compliance_pack_key}" compliance pack and come back together. Put the pack back on above, or hire a role that needs it.`}>
                                  From the {r.compliance_pack_key} pack — put the pack back
                                </span>
                              ) : canEditGuardrails && (
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
      {/* `canEditGuardrails` is repeated here on purpose. Both doors into this
          composer — "+ Add rule" and the per-rule Edit — are already gated, so
          a manager cannot reach it today. But that is an argument about control
          flow, and audit:role-gates reads STRUCTURE: it saw fields that write
          guardrail_rules with no gate between them and the user, and it was
          right to. Gating the composer itself makes the invariant local, so a
          third way in cannot quietly bypass it later. */}
      {showAdd && canEditGuardrails && (
        <Modal size="md" onClose={closeComposer} title={editing ? 'Edit guardrail rule' : 'Add guardrail rule'}>
            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-dt-support mb-1">Rule (plain English)</label>
                <input value={form.rule} onChange={e => setForm(f => ({ ...f, rule: e.target.value }))}
                  placeholder='e.g. "Never quote competitor pricing"'
                  className="w-full bg-dt-page border border-dt-border-strong rounded-lg px-3 py-2 text-dt-body placeholder:text-dt-faint focus:outline-none focus:border-dt-accent" />
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
                    className="w-full bg-dt-page border border-dt-border-strong rounded-lg px-3 py-2 text-dt-body focus:outline-none focus:border-dt-accent">
                    {(Object.keys(RULE_TYPE_META) as GuardrailRuleType[]).map(t => (
                      <option key={t} value={t}>{RULE_TYPE_META[t].label}</option>
                    ))}
                  </select>
                  )}
                </div>
                <div>
                  <label className="block text-dt-support mb-1">Severity</label>
                  <select value={form.severity} onChange={e => setForm(f => ({ ...f, severity: e.target.value as 'blocking' | 'warning' }))}
                    className="w-full bg-dt-page border border-dt-border-strong rounded-lg px-3 py-2 text-dt-body focus:outline-none focus:border-dt-accent">
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
                    className="w-full bg-dt-page border border-dt-border-strong rounded-lg px-3 py-2 text-dt-body focus:outline-none focus:border-dt-accent">
                    {(Object.keys(SCOPE_META) as Array<'workspace' | 'department' | 'employee'>).map(s => (
                      <option key={s} value={s}>{SCOPE_META[s].label}</option>
                    ))}
                  </select>
                </div>
                {form.scope === 'department' ? (
                  <div>
                    <label className="block text-dt-support mb-1">Department</label>
                    <select value={form.scope_ref} onChange={e => setForm(f => ({ ...f, scope_ref: e.target.value }))}
                      className="w-full bg-dt-page border border-dt-border-strong rounded-lg px-3 py-2 text-dt-body focus:outline-none focus:border-dt-accent">
                      <option value="">Choose a department…</option>
                      {departments.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </div>
                ) : form.scope === 'employee' ? (
                  <div>
                    <label className="block text-dt-support mb-1">Employee</label>
                    <select value={form.scope_ref} onChange={e => setForm(f => ({ ...f, scope_ref: e.target.value }))}
                      className="w-full bg-dt-page border border-dt-border-strong rounded-lg px-3 py-2 text-dt-body focus:outline-none focus:border-dt-accent">
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
                    className="w-full bg-dt-page border border-dt-border-strong rounded-lg px-3 py-2 text-dt-body font-mono placeholder:text-dt-faint focus:outline-none focus:border-dt-accent" />
                </div>
              ) : (
                <div>
                  <label className="block text-dt-support mb-1">
                    {form.rule_type === 'require_approval_over_cents' ? 'Threshold (dollars)' : 'Max discount (%)'}
                  </label>
                  <input value={form.threshold} onChange={e => setForm(f => ({ ...f, threshold: e.target.value }))}
                    placeholder={form.rule_type === 'require_approval_over_cents' ? '10000' : '20'} inputMode="numeric"
                    className="w-full bg-dt-page border border-dt-border-strong rounded-lg px-3 py-2 text-dt-body font-mono placeholder:text-dt-faint focus:outline-none focus:border-dt-accent" />
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

      {/* Detach a compliance pack, confirmed — and the confirmation SAYS WHAT IS
          LOST. This is the one control on this page that removes protection
          rather than adding it, so the dialog names the rules that stop
          applying, says they apply to every employee, and does not describe
          itself as a delete: migration 747 made detach retire the rows, and a
          dialog claiming to delete something that survives would be the same
          untrue label the Enforcement tile stopped being. */}
      {confirmDetach && (
        <Modal size="md" onClose={() => setConfirmDetach(null)} title={`Take the ${confirmDetach.name || confirmDetach.pack_key} pack off?`}>
          <div className="space-y-3">
            <p className="text-sm text-dt-body leading-relaxed">
              These blocking rules stop applying to <span className="text-dt-title">every Digital Employee</span> in
              this workspace:
            </p>
            {packRules(confirmDetach.pack_key).length === 0 ? (
              <p className="text-xs text-dt-muted">Nothing from this pack is currently in force.</p>
            ) : (
              <ul className="space-y-1.5 rounded-xl border border-rose-800/40 bg-rose-500/5 px-4 py-3">
                {packRules(confirmDetach.pack_key).map(r => (
                  <li key={r.id} className="text-xs text-dt-body leading-snug">{r.rule}</li>
                ))}
              </ul>
            )}
            {/* ⚠ THE PROMISE HAS TO MATCH WHAT THE SHELF ACTUALLY OFFERS. This
                said the rules "move to Retired rules" and stopped there, which
                sent people to a Restore button the database refuses for every
                pack rule (guard_compliance_guardrails rejects the active=false
                that restore writes). They do move there — for the record — and
                the way back is the pack, whole. Both halves, in that order. */}
            <p className="text-xs text-dt-support leading-relaxed">
              Removing the pack removes that protection. The rules are kept, not deleted — they move to
              &ldquo;Retired rules&rdquo; as a record, so a block one of them caused months ago can still be
              explained. They cannot be switched back on one at a time: putting this pack back on, or hiring a
              role that needs it, brings the same rules back together.
            </p>
          </div>
          <div className="flex justify-end gap-2 mt-5">
            <Button kind="secondary" size="sm" onClick={() => setConfirmDetach(null)}>Cancel</Button>
            {/* The gate is repeated here on purpose, for the reason the retire
                dialog gives: "you can only get here through a gate" is exactly
                the reasoning that has let ungated confirm buttons ship here. */}
            <Button kind="danger" size="sm" disabled={busy || !canEditGuardrails}
              onClick={() => void submitDetach(confirmDetach)}>
              {busy ? 'Removing…' : 'Take the pack off'}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// What is left of the preview compliance page: three helpers the LIVE
// page above still calls. Everything else was DELETED 2026-08-22, all
// zero-reader — 140 lines of hardcoded rules for two fictional tenants
// ('tcp'/'pwc') that no longer exist, describing a guardrail model the
// live page does not implement:
//
//   INDUSTRY_TEMPLATES, ACTIVE_TEMPLATE   five invented template names
//        and versions ("Financial Services v6.2").
//   TemplateRule/TEMPLATE_RULES           21 invented compliance rules
//        citing SOC 2, GDPR, SEC/FINRA, PCAOB and AML by name. Live
//        rules are rows read through guardrailApi.
//   OverrideRow/SEED_OVERRIDES            four invented org overrides.
//   VersionRow/VERSION_HISTORY            11 invented change-log entries
//        with invented named approvers.
//   CALENDAR                              six invented filing deadlines,
//        two flagged overdue.
//   CategoryBadge                         zero render sites.
//
// The invented regulatory text is why this is a deletion and not an
// archive: a compliance screen that can render "SOC 2 evidence
// collection — overdue" from a literal is worse than one that renders
// nothing. Recoverable at 571868e.
// ═══════════════════════════════════════════════════════════════

type Severity = 'blocking' | 'warning' | 'regulatory'


// ── Small helpers ──────────────────────────────────────────────

function SeverityBadge({ severity }: { severity: Severity }) {
  const styles: Record<Severity, string> = {
    blocking: 'bg-dt-danger-soft text-dt-danger',
    warning: 'bg-dt-warn-soft text-dt-warn',
    regulatory: 'bg-dt-accent-soft text-dt-accent-text',
  }
  return <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded ${styles[severity]}`}>{severity}</span>
}


function Toggle({ enabled, onChange, disabled }: { enabled: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      onClick={() => !disabled && onChange(!enabled)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${disabled ? 'bg-dt-panel cursor-not-allowed' : enabled ? 'bg-dt-accent-strong' : 'bg-dt-border-strong'}`}
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

