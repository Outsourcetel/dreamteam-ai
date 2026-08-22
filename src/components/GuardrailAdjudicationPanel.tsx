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
import { useEffect, useState } from 'react'
import {
  listAdjudicableRules, setRuleAdjudicable, listAdjudications,
  type GuardrailRule, type AdjudicableGrant, type Adjudication,
} from '../lib/guardrailApi'

const MIN_JUSTIFICATION = 40

/** Plain-English reasons the adjudicator declined to judge at all. A decline is
 *  NOT a verdict — assessment is null — so it must never render as one. */
const DECLINE_REASON: Record<string, string> = {
  matched_text_in_question: 'the asker used that phrase themselves',
  rule_not_opted_in: 'this rule is not machine-clearable',
  rule_type_not_adjudicable: 'rule type cannot be adjudicated',
  no_evidence: 'no matched text captured',
  no_de_scope: 'no employee in scope',
  sentinel: 'screening was unavailable',
  rate_limited: 'rate limit reached',
  breaker_open: 'paused after repeated failures',
  deadline: 'took too long',
  rules_fetch_failed: 'rules could not be loaded',
  rule_not_in_set: 'rule no longer in scope',
  match_not_locatable: 'match could not be located',
}

function Assessment({ a, wouldClear, reason }: { a: Adjudication['assessment']; wouldClear: boolean; reason: string | null }) {
  if (!a) {
    // Declined: no judgment was made. Shown neutrally so it is never counted
    // as either a clear or a block-with-reasoning.
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap bg-dt-page text-dt-muted">
        not judged{reason && DECLINE_REASON[reason] ? ` — ${DECLINE_REASON[reason]}` : ''}
      </span>
    )
  }
  const map: Record<string, string> = {
    describes: 'bg-dt-warn-soft text-dt-warn',
    enacts: 'bg-dt-ok-soft text-dt-ok',
    unclear: 'bg-dt-page text-dt-muted',
    error: 'bg-dt-danger-soft text-dt-danger',
  }
  const label = a === 'describes' ? (wouldClear ? 'describes → clear' : 'describes (below bar)')
    : a === 'enacts' ? 'enacts → upheld'
    : a === 'unclear' ? 'unclear → upheld'
    : 'error → upheld'
  return <span className={`text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap ${map[a]}`}>{label}</span>
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
  // Counts must separate JUDGED outcomes from declines, or a rule nobody
  // opted in would look like the AI kept deciding to block.
  const upheld = log.filter(a => a.assessment && !a.would_clear).length
  const notJudged = log.filter(a => !a.assessment).length

  return (
    <div className="rounded-2xl border border-dt-border bg-dt-card p-6 mb-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-dt-title">When a guardrail matches the wrong thing</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-warn-soft text-dt-warn">can un-block content</span>
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
                <div className="text-lg font-semibold text-dt-warn">{cleared}</div>
                <div className="text-[10px] text-dt-muted">blocks released by AI</div>
              </div>
              <div className="rounded-xl border border-dt-border bg-dt-page p-3">
                <div className="text-lg font-semibold text-dt-title">{wouldHave}</div>
                <div className="text-[10px] text-dt-muted">would have been released (observing)</div>
              </div>
              <div className="rounded-xl border border-dt-border bg-dt-page p-3">
                <div className="text-lg font-semibold text-dt-title">{upheld}</div>
                <div className="text-[10px] text-dt-muted">block kept{notJudged>0?` · ${notJudged} not judged`:''}</div>
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
                        <div className="text-[10px] text-dt-warn mt-1">
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

          {error && <p className="text-xs text-dt-danger mb-3">{error}</p>}

          <h4 className="text-xs font-semibold text-dt-title mb-2">Every decision, kept</h4>
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
                    <Assessment a={a.assessment} wouldClear={a.would_clear} reason={a.reason} />
                    {a.applied && <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-warn-soft text-dt-warn">RELEASED</span>}
                    {a.mode === 'shadow' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-dt-card text-dt-muted">observing only</span>}
                    {a.confidence != null && <span className="text-[10px] text-dt-muted">{a.confidence}% sure</span>}
                    <span className="text-[10px] text-dt-muted ml-auto">{new Date(a.created_at).toLocaleString()}</span>
                  </div>
                  <div className="text-[11px] text-dt-body">
                    {a.rule_text}
                    {a.matched_text && <> — matched <span className="font-mono text-dt-warn">"{a.matched_text}"</span></>}
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
