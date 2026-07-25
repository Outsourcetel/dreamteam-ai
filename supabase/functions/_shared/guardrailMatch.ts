/**
 * guardrailMatch — the ONE deterministic pattern matcher behind every blocking
 * guardrail, on every surface.
 *
 * ── The bug this fixes ──────────────────────────────────────────────────────
 * Four independent copies of the matcher (de-answer, widget-ask,
 * specialist-consult, playbook-execute) all did this:
 *
 *     for (const frag of r.pattern.split('|')...) {
 *       try { hit = new RegExp(frag, 'i').test(answer); } catch { ... }
 *     }
 *
 * Splitting on '|' and THEN compiling each fragment as a regex is
 * self-defeating: RegExp already understands '|'. Splitting first shreds any
 * grouping the rule author wrote. The live HIPAA/PII rule
 *
 *     what is your (pin|cvv|password|ssn|social security)|tell me your (...)|...
 *
 * — a precise rule that fires only when the employee ASKS for a secret — was
 * shredded into the bare fragments `cvv`, `password`, `ssn`, `passcode)`, so it
 * fired on ANY mention of those words. Verified against 17 real historical
 * blocks: a credit-union employee telling a customer "do NOT share your SSN with
 * anyone who contacts you" was blocked five separate times by the rule that
 * exists to stop it ASKING for an SSN.
 *
 * That is a governance-integrity defect, not just a quality one: the rule being
 * ENFORCED was broader than the rule DISPLAYED in the UI and agreed by the
 * customer. Nobody wrote "block any answer containing 'ssn'".
 *
 * ── Why this is safe ────────────────────────────────────────────────────────
 * Audited all 85 active blocking patterns across every tenant: exactly ONE uses
 * grouping, and none use [ ] \ { } * + ? — so for 84 of 85 rules a plain
 * `a|b|c` alternation is SEMANTICALLY IDENTICAL whether you split it or compile
 * it whole. This changes behaviour on one rule, in the direction of what its
 * author actually wrote.
 *
 * Un-compilable patterns fall back to LITERAL fragment matching — never to
 * regex — because a fragment that failed to compile as part of a whole is not
 * meaningful as a regex on its own.
 */

/** The blocking-rule shape shared by every caller (each adds its own extras). */
export interface PatternRule {
  id: string;
  rule: string;
  rule_type: string;
  pattern: string | null;
  applies_to: string;
}

export interface PatternHit<R> {
  /** The rule that matched. */
  rule: R;
  /** The exact text that matched — for the audit record and for the semantic
   *  judge, which cannot adjudicate a hit it cannot see. */
  matched: string;
}

/**
 * Test one pattern against text. Returns the matched substring, or null.
 *
 * The whole pattern is compiled as a single case-insensitive regex — so
 * alternation, grouping, and anchors all mean what the author wrote.
 */
export function matchPattern(pattern: string | null | undefined, text: string): string | null {
  const p = String(pattern ?? '').trim();
  if (!p) return null;
  try {
    const m = text.match(new RegExp(p, 'i'));
    return m ? m[0] : null;
  } catch {
    // Not a valid regex → the author meant literal phrases separated by '|'.
    const hay = text.toLowerCase();
    for (const frag of p.split('|').map((f) => f.trim().toLowerCase()).filter(Boolean)) {
      if (hay.includes(frag)) return frag;
    }
    return null;
  }
}

/** First blocking rule whose pattern matches, with the text that matched it. */
export function findBlockingMatch<R extends { pattern: string | null }>(
  rules: R[], text: string,
): PatternHit<R> | null {
  for (const rule of rules) {
    const matched = matchPattern(rule.pattern, text);
    if (matched !== null) return { rule, matched };
  }
  return null;
}

/**
 * LEGACY matcher — the shredding behaviour, kept ONLY so a caller can report
 * the difference between what used to be blocked and what is blocked now.
 * Never use it to decide anything.
 */
export function legacyFragmentMatch(pattern: string | null | undefined, text: string): string | null {
  const p = String(pattern ?? '').trim();
  if (!p) return null;
  const hay = text.toLowerCase();
  for (const frag of p.split('|').map((f) => f.trim().toLowerCase()).filter(Boolean)) {
    let hit = false;
    try { hit = new RegExp(frag, 'i').test(text); } catch { hit = hay.includes(frag); }
    if (hit) return frag;
  }
  return null;
}

/**
 * Blank out the FIRST occurrence of `matched`, preserving every offset.
 *
 * This is what makes clearing safe. Clearing keyed on a rule ID would mean a
 * benign match of one phrase releases a genuine match of another phrase in the
 * SAME rule — an adversarial reviewer built a case where "we never disclose PHI
 * without authorization … I've attached the patient record without the signed
 * auth" gets released because the first clause adjudicates as descriptive.
 * Masking the cleared phrase and re-running the WHOLE matcher over ALL rules
 * means anything still matching keeps the block.
 *
 * U+FFFD appears in no authored pattern.
 */
export function maskFirst(text: string, matched: string): string {
  if (!matched) return text;
  const i = text.toLowerCase().indexOf(matched.toLowerCase());
  if (i < 0) return text;
  return text.slice(0, i) + '�'.repeat(matched.length) + text.slice(i + matched.length);
}
