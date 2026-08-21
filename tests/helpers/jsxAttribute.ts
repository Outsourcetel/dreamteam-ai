// jsxAttribute.ts — lift a JSX attribute expression out of source text and
// EVALUATE it.
//
// ⚠ WHY THIS EXISTS AT ALL. This repo has no jsdom and no
// @testing-library/react (confirmed against vitest.config.ts and
// package.json), so the trust-promotion Approve gates are pinned structurally,
// by reading the page source. A structural pin on a boolean gate has one
// specific failure mode, and the final whole-feature review (2026-08-21) named
// it: `expect(tag).toContain('deciding || trustLoading')` ALSO passes for
//
//     disabled={!(deciding || trustLoading)}
//
// — a total inversion of the gate, which contains that substring intact. A
// substring that survives negation is not proof of a relationship. Evaluating
// the expression against a supplied scope is, and it is the only assertion
// available here that separates a gate from its negation.
//
// ⚠ AND WHY IT IS NOT IN A .test.ts. These helpers were first defined inside
// tests/human-tasks-trust-promotion-gate.test.ts and imported by the mobile
// file. That works, and it silently DOUBLE-REGISTERS every describe in the
// imported file: the mobile suite reported 20 tests where it has 10, with the
// desktop's 10 counted twice. A denominator that lies is the thing this repo
// least tolerates in a checker, so the helpers moved here. vitest.config.ts
// includes only `tests/**/*.test.ts`, so this file is a module, never a suite.

/** The balanced `{…}` expression a JSX attribute is assigned, as source text.
 *  Brace-depth and quote aware, so an arrow function, a nested object or a
 *  comparison inside the expression does not terminate it early. */
export function attributeExpression(tag: string, attr: string): string {
  const marker = `${attr}={`;
  const at = tag.indexOf(marker);
  if (at === -1) throw new Error(`attributeExpression: no ${marker} in <…> tag`);
  const start = at + marker.length;
  let depth = 1;
  let quote: string | null = null;
  for (let i = start; i < tag.length; i++) {
    const c = tag[i];
    if (quote) { if (c === quote && tag[i - 1] !== '\\') quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') { depth++; continue; }
    if (c === '}') { depth--; if (depth === 0) return tag.slice(start, i); }
  }
  throw new Error(`attributeExpression: unbalanced ${marker}`);
}

/** Evaluate a JSX attribute expression against a supplied scope, coerced the
 *  way React coerces a `disabled` prop. Every identifier the expression
 *  mentions must be a key of `scope`, or this throws a ReferenceError — which
 *  is the desired behaviour: a gate that started reading a variable the test
 *  does not know about must fail loudly, not silently pass. */
export function evalAttributeExpression(expr: string, scope: Record<string, unknown>): boolean {
  const names = Object.keys(scope);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const fn = new Function(...names, `"use strict"; return (${expr});`) as (...a: unknown[]) => unknown;
  return Boolean(fn(...names.map((n) => scope[n])));
}
