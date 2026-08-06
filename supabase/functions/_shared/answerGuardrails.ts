// ============================================================
// Screening an answer against its employee's guardrails — ONE implementation.
//
// de-answer and widget-ask each carried a copy. Both fail CLOSED and both log
// an incident, so this is not the fail-open case that specialist-consult had
// before the role was retired. The difference is narrower and still real:
// de-answer carries the MATCHED TEXT on the rule it returns, widget-ask threw
// it away — so on the widget path the adjudicator was asked to judge a hit it
// could not see, and the audit record recorded a block without its trigger.
//
// The matcher itself already lives in _shared/guardrailMatch.ts. What was
// duplicated is the loading, the fail-closed contract and the incident write.
// ============================================================
import { findBlockingMatch } from './guardrailMatch.ts';

export interface GuardrailRule {
  id: string;
  rule: string;
  rule_type: string;
  pattern: string | null;
  applies_to: string;
  /** The exact text that triggered this rule. Present on a real hit; absent on
   *  the resolver-error sentinel, which has no trigger by definition. */
  matched_text?: string;
}

// Fail-CLOSED sentinel: if the guardrail resolver itself errors (or returns no
// rule set) we cannot PROVE the answer was screened, so we treat it as blocked
// and route to a human rather than release an unscreened reply during a
// transient DB blip.
export const GUARDRAIL_RESOLVER_ERROR: GuardrailRule = {
  id: '__resolver_error__',
  rule: 'answer screening unavailable',
  rule_type: 'resolver_error',
  pattern: null,
  applies_to: 'answer',
};

/** Load this employee's BLOCKING rules. Returns null when screening could not
 *  be shown to have run — callers must treat null as "blocked", never as
 *  "nothing matched".
 *
 *  Exported because widget-ask screens a SECOND time mid-stream (it checks the
 *  accumulated text as tokens arrive, so a blocked phrase is caught before it
 *  reaches the visitor) and needs the rules without the full check. */
// deno-lint-ignore no-explicit-any
export async function loadBlockingRules(admin: any, tenantId: string, deId: string | null, path: string): Promise<GuardrailRule[] | null> {
  try {
    // Scope-aware: the resolver returns workspace rules plus any
    // department/employee-scoped rules for this DE. A null DE → workspace only.
    const { data: rules } = await admin.rpc('guardrail_rules_for_de', {
      p_tenant_id: tenantId, p_de_id: deId, p_rule_types: ['blocked_phrase', 'blocked_topic'],
    });
    if (!Array.isArray(rules)) return null;   // screening didn't run → fail closed
    return (rules as Array<GuardrailRule & { severity?: string }>)
      .filter((r) => r.severity === 'blocking');
  } catch (e) {
    // Fail-closed, but never SILENTLY: a durable incident lands on the
    // employee's record so a broken guardrail resolver cannot hide.
    console.error(`guardrail check failed (fail-closed → escalating) [${path}]:`, e);
    try {
      await admin.from('de_incidents').insert({
        tenant_id: tenantId, de_id: deId, kind: 'guardrail_block', severity: 'critical',
        title: 'Guardrail check FAILED — answer withheld and escalated (fail-closed)',
        detail: { error: String((e as Error)?.message ?? e).slice(0, 400), path },
        source_table: 'guardrail_rules', source_id: null,
        occurred_at: new Date().toISOString(),
      });
    } catch { /* best-effort */ }
    return null;
  }
}

/** Match already-loaded rules against a piece of text. Separate from
 *  checkAnswerGuardrails so the streaming path can screen a partial answer
 *  without re-loading the rules on every token. */
export function matchBlockingRule(blocking: GuardrailRule[], text: string): GuardrailRule | null {
  const m = findBlockingMatch(blocking, text);
  return m ? { ...m.rule, matched_text: m.matched } : null;
}

/** Screen an answer. Returns the rule it tripped (with the matched text), the
 *  resolver-error sentinel when screening could not run, or null when the
 *  answer is clean. `path` names the caller in the incident record. */
// deno-lint-ignore no-explicit-any
export async function checkAnswerGuardrails(
  admin: any, tenantId: string, answer: string, deId: string | null, path: string,
): Promise<GuardrailRule | null> {
  const blocking = await loadBlockingRules(admin, tenantId, deId, path);
  if (blocking === null) return GUARDRAIL_RESOLVER_ERROR;   // can't prove it ran → block

  // The WHOLE pattern is one regex, so a rule author's grouping survives. The
  // old per-'|'-fragment loop shredded `what is your (pin|cvv|ssn)` into a bare
  // `ssn` and blocked any answer that merely mentioned one.
  //
  // Carry the matched TEXT alongside the rule: the adjudicator cannot judge a
  // hit it cannot see, and the audit record needs the exact trigger. Every
  // downstream consumer reads only .id/.rule/.rule_type, so this is a widening.
  return matchBlockingRule(blocking, answer);
}
