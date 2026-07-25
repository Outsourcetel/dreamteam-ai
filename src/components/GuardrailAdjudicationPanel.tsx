/**
 * GuardrailAdjudicationPanel — the human control and the receipt for GI-10.
 *
 * GI-10 lets a small model clear a deterministic guardrail match it judges to
 * DESCRIBE a control rather than ENACT the prohibited act. That is the first
 * mechanism in this platform capable of un-blocking content, so it must be
 * granted deliberately, one rule at a time, and every release must be visible
 * to the person accountable for it — not buried in a table only the server
 * reads. Shipping the engine without this panel would repeat the
 * built-but-never-surfaced pattern the module audits keep finding.
 *
 * The grant is written through the set_rule_adjudicable RPC, never a table
 * update: guardrail_rule_adjudicable revokes INSERT/UPDATE/DELETE from
 * authenticated precisely so permission cannot be granted without its audit row.
 */
import React, { useEffect, useState } from 'react'
import {
  listAdjudicableRules, setRuleAdjudicable, listAdjudications,
  type GuardrailRule, type AdjudicableGrant, type Adjudication,
} from '../lib/guardrailApi'

const MIN_JUSTIFICATION = 40

function Assessment({ a, wouldClear }: { a: Adjudication['assessment']; wouldClear: boolean }) {
  const map: Record<string, string> = {
    describes: 'bg-amber-500/20 text-amber-200',
    enacts: 'bg-emerald-500/15 text-emerald-300',
    unclear: 'bg-dt-page text-dt-muted',
    error: 'bg-red-500/15 text-red-300',
  }
  const label = a === 'describes' ? (wouldClear ? 'describes → clear' : 'describes (below bar)')
    : a === 'enacts' ? 'enacts → upheld'
    : a === 'unclear' ? 'unclear → upheld'
    : 'error → upheld'
  return <span className={`text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap ${map[a ?? 'error']}`}>{label}</span>
}

export default function GuardrailAdjudicationPanel({ rules }: { rules: GuardrailRule[] }) {
  const [grants, setGrants] = useState<AdjudicableGrant[]>([])
  const [log, setLog] = useState<Adjudication[]>([])
  const [loading, setLoading] = useState(true)
  const [unavailable, setUnavailable] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [why, setWhy] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    try {
      const [g, l] = await Promise.all([listAdjudicableRules(), listAdjudications(30, 200)])
      setGrants(g); setLog(l); setUnavailable(false)
    } catch {
      // Honest empty state rather than a crash: the tables land with mig 329.
      setUnavailable(true)
    } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  // Only blocking phrase/topic rules can ever be adjudicated — the RPC enforces
  // this too; showing anything else would imply a control that does not exist.
  const eligible = rules.filter(r =>
    r.severity === 'blocking' && (r.rule_type === 'blocked_phrase' || r.rule_type === 'blocked_topic') && r.active)
  const grantedIds = new Set(grants.map(g => g.rule_id))

  const submit = async (ruleId: string, on: boolean) => {
    setBusy(true); setError(null)
    try {
      await setRuleAdjudicable(ruleId, on, on ? why.trim() : '')
      setEditing(null); setWhy('')
      await load()
    } catch (e) {
      setError((e as Error).message ?? 'Could not change this')
    } finally { setBusy(false) }
  }

  if (loading) return null

  const cleared = log.filter(a => a.applied).length
  const wouldHave = log.filter(a => a.would_clear && !a.applied).length
  const upheld = log.filter(a => !a.would_clear).length

  return (
    <div className="rounded-2xl border border-dt-border bg-dt-card p-6 mb-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">When a guardrail matches the wrong thing</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">can un-block content</span>
      </div>
      <p className="text-[11px] text-dt-muted mb-4 max-w-3xl">
        Blocking rules match text, so they cannot tell an employee <em>doing</em> the forbidden thing from one
        <em> explaining the rule against it</em>. "I'm not able to provide diagnoses" trips the no-diagnoses rule;
        "a grant doesn't skip approvals" trips the payments rule. Switching a rule on here lets a small model read
        the flagged sentence and decide which it is. It can only ever <strong>release</strong> a block — never add
        one — and if anything goes wrong at all, the block stands. Every release is written permanently to the
        audit trail before the answer is sent.
      </p>

      {unavailable && (
        <p className="text-xs text-dt-muted">Not available in this workspace yet.</p>
      )}

      {!unavailable && (
        <>
          {log.length > 0 && (
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className="rounded-xl border border-dt-border bg-dt-page p-3">
                <div className="text-lg font-semibold text-amber-300">{cleared}</div>
                <div className="text-[10px] text-dt-muted">blocks released by AI</div>
              </div>
              <div className="rounded-xl border border-dt-border bg-dt-page p-3">
                <div className="text-lg font-semibold text-white">{wouldHave}</div>
                <div className="text-[10px] text-dt-muted">would have been released (observing)</div>
              </div>
              <div className="rounded-xl border border-dt-border bg-dt-page p-3">
                <div className="text-lg font-semibold text-white">{upheld}</div>
                <div className="text-[10px] text-dt-muted">block kept</div>
              </div>
            </div>
          )}

          <div className="space-y-2 mb-5">
            {eligible.length === 0 && (
              <p className="text-xs text-dt-muted">No blocking phrase or topic rules yet.</p>
            )}
            {eligible.map(r => {
              const on = grantedIds.has(r.id)
              const grant = grants.find(g => g.rule_id === r.id)
              const pack = (r as GuardrailRule & { compliance_pack_key?: string | null }).compliance_pack_key
              return (
                <div key={r.id} className="rounded-xl border border-dt-border bg-dt-page p-3">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="text-xs text-dt-body">{r.rule}</div>
                      <div className="text-[10px] text-dt-muted font-mono truncate">{r.pattern}</div>
                      {pack && (
                        <div className="text-[10px] text-amber-300 mt-1">
                          From the {pack} compliance pack — making it machine-clearable is an explicit
                          compliance decision and needs the workspace owner override.
                        </div>
                      )}
                      {on && grant && (
                        <div className="text-[10px] text-dt-muted mt-1">
                          Allowed since {new Date(grant.granted_at).toLocaleDateString()} — "{grant.justification}"
                        </div>
                      )}
                    </div>
                    <button
                      disabled={busy}
                      onClick={() => (on ? void submit(r.id, false) : (setEditing(editing === r.id ? null : r.id), setWhy('')))}
                      className={`text-[11px] px-2.5 py-1 rounded-lg whitespace-nowrap disabled:opacity-50 ${
                        on ? 'bg-amber-600/80 hover:bg-amber-600 text-white' : 'bg-dt-card border border-dt-border text-dt-body hover:border-indigo-500'}`}>
                      {on ? 'AI may clear this — revoke' : 'Let AI clear a false match'}
                    </button>
                  </div>

                  {editing === r.id && (
                    <div className="mt-3 border-t border-dt-border pt-3">
                      <p className="text-[11px] text-dt-muted mb-2">
                        Say why this rule is safe for a machine to overrule. This is stored in the audit trail
                        against your name.
                      </p>
                      <textarea
                        value={why} rows={2} disabled={busy}
                        onChange={e => setWhy(e.target.value)}
                        placeholder="e.g. This rule exists to stop the employee promising a refund. It keeps blocking answers that merely quote the published refund policy."
                        className="w-full bg-dt-card border border-dt-border text-dt-body text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 disabled:opacity-50" />
                      <div className="mt-2 flex items-center gap-3">
                        <button
                          disabled={busy || why.trim().length < MIN_JUSTIFICATION}
                          onClick={() => void submit(r.id, true)}
                          className="text-[11px] px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40">
                          {busy ? 'Saving…' : 'Allow'}
                        </button>
                        <span className="text-[10px] text-dt-muted">
                          {Math.max(0, MIN_JUSTIFICATION - why.trim().length)} more characters needed
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {error && <p className="text-xs text-rose-300 mb-3">{error}</p>}

          <h4 className="text-xs font-semibold text-white mb-2">Every decision, kept</h4>
          {log.length === 0 ? (
            <p className="text-[11px] text-dt-muted">
              Nothing adjudicated yet. Decisions appear here the moment a rule above is switched on and one of
              its matches is reviewed.
            </p>
          ) : (
            <div className="space-y-1.5 max-h-96 overflow-y-auto">
              {log.map(a => (
                <div key={a.id} className="rounded-lg border border-dt-border bg-dt-page p-2.5">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <Assessment a={a.assessment} wouldClear={a.would_clear} />
                    {a.applied && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-200">RELEASED</span>}
                    {a.mode === 'shadow' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-card text-dt-muted">observing only</span>}
                    {a.confidence != null && <span className="text-[10px] text-dt-muted">{a.confidence}% sure</span>}
                    <span className="text-[10px] text-dt-muted ml-auto">{new Date(a.created_at).toLocaleString()}</span>
                  </div>
                  <div className="text-[11px] text-dt-body">
                    {a.rule_text}
                    {a.matched_text && <> — matched <span className="font-mono text-amber-300">"{a.matched_text}"</span></>}
                  </div>
                  {a.rationale && <div className="text-[10px] text-dt-muted mt-0.5 italic">{a.rationale}</div>}
                  {!a.would_clear && a.reason && a.assessment === 'error' && (
                    <div className="text-[10px] text-dt-muted mt-0.5">block kept — {a.reason}</div>
                  )}
                  {a.model && <div className="text-[10px] text-dt-muted mt-0.5">{a.model}{a.cache_hit ? ' · from cache' : ''}</div>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
