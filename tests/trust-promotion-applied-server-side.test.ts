// trust-promotion-applied-server-side.test.ts — the CLIENT half of migration
// 836. The migration's own verify block proves the server behaviour (it drives
// the real decide_human_tasks, preview_decide_human_tasks and
// withdraw_human_task and asserts against stored state), and its schema arm
// re-checks the SQL on every replay. Neither of them can see TypeScript, which
// is where the defect actually lived: apply_trust_promotion's only caller in
// the entire system was a browser hook.
//
// Two things are pinned here, and the second matters more than the first.
//
//   1. The promotion is not applied from the client any more. Re-adding it
//      would be a SECOND apply: the server's call nulls
//      trust_policies.pending_task_id, so a client call afterwards finds
//      nothing and returns {"applied": false, "reason": "no_pending_policy"}
//      with an HTTP 200 — and any honest check of that payload would then
//      throw on a promotion that had SUCCEEDED.
//
//   2. THE THIRD RETURN STATE IS READ. decide_human_task can now return a row
//      whose task was NOT closed — the consequence refused, and it left the
//      task open with the reason on it rather than raising (a raise would roll
//      back the record of the refusal; see migration 836's header and 837's).
//      Every check that existed before asks "did I get a row?", which used to
//      be the same question as "was it decided?". It is not any more. Missing
//      this is exactly how "Approved N tasks" came to be printed over a
//      promotion that never happened.
//
// ── WHAT THIS FILE DELIBERATELY DOES NOT DO ─────────────────────────────────
// It does not re-test migration 837's `ok === false → throw` in
// resolveTrustPromotion. That has its own file
// (tests/trust-promotion-refusal-reaches-the-user.test.ts) which evaluates the
// condition rather than matching it. What IS asserted here is that 836 did not
// DELETE that wrapper on its way past — an earlier draft of this fix did, and
// it would have taken 837's client half and a certify arm with it.
//
// ── WHY THIS IS A STRUCTURAL TEST ───────────────────────────────────────────
// Same reason as tests/human-tasks-trust-promotion-gate.test.ts and
// tests/trust-promotion-refusal-reaches-the-user.test.ts: there is no jsdom or
// @testing-library/react in this repo (confirmed against vitest.config.ts and
// package.json), so a render/behaviour test of the decide path would not be
// collected. Source-level assertions are what is available.
//
// ⚠ A NAMED LIMIT, NOT SILENTLY INHERITED. These are source assertions. They
// prove no client-side apply is written down and that the status check is
// present in the right relationship; they do not prove one could not be
// reached some other way. That is weaker than the migration's runtime arms and
// is not claimed otherwise — the runtime proof lives in the migration,
// deliberately.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const CUSTOMER_API = 'src/lib/customerApi.ts';
const TRUST_API = 'src/lib/trustApi.ts';
const MIGRATION = 'supabase/migrations/836_the_promotion_is_part_of_the_decision.sql';

/** Comments explain the defect at length in all three files, and every string
 *  this test looks for appears in that prose. Matching un-stripped source
 *  would match the explanation rather than the code — this repo's own
 *  convention, applied in SQL by the migration's schema arm and in TS here. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const CUSTOMER_SRC = stripComments(readFileSync(CUSTOMER_API, 'utf8'));
const TRUST_SRC = stripComments(readFileSync(TRUST_API, 'utf8'));
const MIGRATION_SRC = readFileSync(MIGRATION, 'utf8');

describe('a trust promotion is applied by the server, never by the browser', () => {
  it('the decide path does not import a trust applier', () => {
    // The hook was `const { resolveTrustPromotion } = await import('./trustApi')`.
    expect(CUSTOMER_SRC).not.toMatch(/resolveTrustPromotion/);
  });

  it('the decide path does not call apply_trust_promotion directly either', () => {
    // Deleting the wrapper is not the point; not applying from the client is.
    // Inlining the .rpc() call would satisfy the previous assertion and
    // reintroduce the double-apply, so it gets its own arm.
    expect(CUSTOMER_SRC).not.toMatch(/apply_trust_promotion/);
  });

  it('migration 837’s wrapper and its throw were not collateral damage', () => {
    // 836 moved the applier server-side; it must not have taken 837's client
    // half with it. The throw itself is proven in 837's own test file — this
    // is only the "still there" pin.
    expect(TRUST_SRC).toMatch(/export\s+async\s+function\s+resolveTrustPromotion\s*\(/);
    expect(TRUST_SRC).toMatch(/r\?\.ok\s*===\s*false/);
  });

  it('trustApi still exports the REQUEST side, which was never the defect', () => {
    // The counterweight. Asserting only absences would pass just as well if
    // someone deleted the whole module, which would break asking for a
    // promotion at all — a different bug wearing this fix's clothes.
    //
    // ⚠ THE `\(` IS LOAD-BEARING, and it is here because inverting this arm
    // caught it. Without it the pattern is an unterminated prefix, so
    // `export async function requestTrustPromotionRENAMED` matches it too —
    // this arm passed against a function that had been renamed out from under
    // every caller. Same class as the gate test's note on `disabled={!x}`
    // satisfying a bare `/x/`: a substring that survives the edit it is meant
    // to catch is not proof of anything.
    expect(TRUST_SRC).toMatch(/export\s+async\s+function\s+requestTrustPromotion\s*\(/);
    expect(TRUST_SRC).toMatch(/rpc\(\s*'request_trust_promotion'/);
  });
});

describe('the decide path reads the third return state', () => {
  it('compares the returned status against the decision', () => {
    // ⚠ THE WHOLE EXPRESSION, not a substring. `decidedRow.status === decision`
    // and `!== decision` both contain "status" and "decision" and are wrong in
    // opposite directions — the inverted one would run every consequence hook
    // for a task that was never closed. So the relationship is pinned, not the
    // vocabulary. (The same lesson is written up in
    // tests/human-tasks-trust-promotion-gate.test.ts.)
    expect(CUSTOMER_SRC).toMatch(/if\s*\(\s*decidedRow\.status\s*!==\s*decision\s*\)/);
  });

  it('returns decided:false on that branch, before any consequence hook', () => {
    const branch = CUSTOMER_SRC.indexOf('decidedRow.status !== decision');
    expect(branch).toBeGreaterThan(-1);

    // The branch must return, not fall through. Everything below it in this
    // function is a consequence of a decision that did not happen.
    const afterBranch = CUSTOMER_SRC.slice(branch, branch + 600);
    expect(afterBranch).toMatch(/return\s+withOutcome\(/);
    expect(afterBranch).toMatch(/decided:\s*false/);

    // And it must sit BEFORE the first consequence. updateInvoice is the
    // first one in this function and the most expensive to get wrong — it
    // marks a renewal invoice sent.
    const firstConsequence = CUSTOMER_SRC.indexOf('await updateInvoice(');
    expect(firstConsequence).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(firstConsequence);
  });

  it('surfaces the server’s own reason rather than inventing one', () => {
    // A generic "something went wrong" would hide a governed refusal behind a
    // shrug. refusal_reason is what decide_human_task wrote on the row.
    expect(CUSTOMER_SRC).toMatch(/decidedRow\.refusal_reason/);
    expect(CUSTOMER_SRC).toMatch(/refusal_reason\?:\s*string\s*\|\s*null/);
  });

  it('the migration that created the third state is present and creates it', () => {
    // Not a substitute for the migration's own verify block — that one runs
    // against a live database and drives all three delegating verbs. This is a
    // cheap tripwire for the file being reverted or renamed while these client
    // changes stay, which would leave the client reading a column that does
    // not exist.
    expect(MIGRATION_SRC).toMatch(/add column if not exists refusal_reason text/);
    expect(MIGRATION_SRC).toMatch(/v_trust\s*:=\s*public\.apply_trust_promotion\(p_task_id,\s*p_decision\)/);
    expect(MIGRATION_SRC).toMatch(/v_row\.status is distinct from p_decision/);
  });
});
