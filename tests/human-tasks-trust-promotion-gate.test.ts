// human-tasks-trust-promotion-gate.test.ts — the desktop ops queue's half of
// fix round 2 (coordinator review, 2026-08-21): three findings, structurally
// pinned so a future edit cannot silently reopen any of them.
//
//   1. Approve was never gated on the evidence having loaded at all — the
//      state existed (`trustLoading`) but nothing read it. Click a
//      trust_promotion, click Approve while the block still says "Loading…",
//      and the decision is made having seen nothing, on the pane most people
//      use.
//   2. Even gated, a boolean state that starts `false` (a RESOLVED, settled
//      value) and only flips `true` inside an effect leaves one real
//      first-paint frame where a stale/absent value renders as truth. Fixed
//      by making `trustPolicy` tri-state (`T | null | undefined`, matching
//      this file's own `replyDraft` — see its "PendingConversationDraft |
//      null | undefined" declaration) and deriving `trustLoading` from
//      `=== undefined` rather than storing it separately.
//   3. Batch-approving a trust_promotion bypasses apply_trust_promotion
//      entirely (decide_human_tasks -> decide_human_task carries no trust
//      references; that hook lives only in the single-task decide path) —
//      closes the task as approved, strands pending_task_id, writes no
//      audit event, promotes nobody, and reports success. Batch selection
//      (checkbox + select-all) now excludes trust_promotion.
//
// ── WHY THIS IS A STRUCTURAL TEST ───────────────────────────────────────────
// Same reason as tests/mobile-trust-promotion-read-first.test.ts and its own
// cited precedents: no jsdom/@testing-library/react in this repo, confirmed
// against vitest.config.ts/package.json — a .tsx render test would not be
// collected.
//
// ⚠ A NAMED LIMIT, NOT SILENTLY INHERITED. The coordinator flagged that a
// bare `toMatch(/identifier/)` on an attribute string would still pass for an
// INVERTED gate (`disabled={!trustLoading}` contains the substring
// "trustLoading" too). Arm 2 below asserts the literal `deciding ||
// trustLoading` sequence for exactly that reason — a substring that survives
// negation is not proof of the relationship. The rest of this file's arms are
// still presence/absence checks on IDENTIFIERS (does trustLoading exist as a
// derived const, not a stored one; does batchSelectable exclude the type) —
// weaker than arm 2, adequate for what they check, and not claimed otherwise.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
// See tests/helpers/jsxAttribute.ts for why the behavioural helpers live in a
// plain module rather than in this file: importing them FROM a .test.ts
// double-registers that file's suites in the importer.
import { attributeExpression, evalAttributeExpression } from './helpers/jsxAttribute';

const PAGE_PATH = 'src/pages/tenant/ops/HumanTasksPage.tsx';

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const SRC = stripComments(readFileSync(PAGE_PATH, 'utf8'));

/** The nearest `<TagName …>` opening tag whose `>` is at or after `around`.
 *  ⚠ NOT a naive `indexOf('>')` — this button's own onClick is an arrow
 *  function (`() => …`), and a bare-`>` search stops at THAT `>` before ever
 *  reaching the tag's real close (confirmed live: it happened to work in
 *  tests/mobile-trust-promotion-read-first.test.ts only because that file's
 *  `disabled=` attribute is written BEFORE `onClick=`; here `onClick` comes
 *  first, so the naive version silently truncated before `disabled=` and
 *  this test failed for the wrong reason until fixed). Tracks brace depth
 *  and string literals so a `>` inside `{…}` (an arrow, a comparison) or a
 *  quoted attribute is never mistaken for the tag's own close. */
function enclosingOpenTag(src: string, tagName: string, around: number): string {
  const tagStart = src.lastIndexOf(`<${tagName}`, around);
  if (tagStart === -1) throw new Error(`enclosingOpenTag: no <${tagName} before index ${around}`);
  let i = tagStart + 1 + tagName.length;
  let braceDepth = 0;
  let quote: '"' | "'" | null = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote && src[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{') { braceDepth++; continue; }
    if (c === '}') { braceDepth--; continue; }
    if (braceDepth > 0) continue; // ignore '>' inside an expression — arrows, comparisons
    if (c === '>') return src.slice(tagStart, i + 1);
  }
  throw new Error(`enclosingOpenTag: no real tag-close '>' found for <${tagName} starting at ${tagStart}`);
}

describe('trustPolicy is tri-state, not a resolved value plus a separate flag', () => {
  it('initialises to undefined ("still looking"), not null or a stored boolean', () => {
    expect(SRC).toMatch(/useState<TrustPolicy \| null \| undefined>\(undefined\)/);
  });

  it('trustLoading is DERIVED from trustPolicy === undefined, never its own stored state', () => {
    // The round-1 defect: `const [trustLoading, setTrustLoading] = useState(false)`
    // started at a RESOLVED value, so a fetch that had not started yet was
    // indistinguishable from "confirmed nothing to load".
    expect(SRC).not.toContain('setTrustLoading');
    const at = SRC.indexOf('const trustLoading =');
    expect(at, 'trustLoading is not declared as a derived const').toBeGreaterThan(-1);
    const statement = SRC.slice(at, SRC.indexOf(';', at) + 1);
    expect(statement).toContain('trustPolicy === undefined');
  });

  it('a failed fetch settles trustPolicy to null rather than leaving it undefined forever', () => {
    // Otherwise a network error would disable Approve permanently instead of
    // just explaining why the evidence panel is empty. Anchored on the catch
    // handler's own message (unique in the file) rather than the first
    // setTrustLoadError( — that earlier hit is the per-selection RESET line,
    // not the failure handler, and a window from there never reaches
    // setTrustPolicy(null) at all.
    const at = SRC.indexOf('Could not load the evidence behind this request.');
    expect(at, 'the catch handler\'s own error message was not found').toBeGreaterThan(-1);
    const nearby = SRC.slice(at, at + 200);
    expect(nearby).toContain('setTrustPolicy(null)');
  });
});

describe('Approve cannot resolve before the evidence has finished loading', () => {
  it('the Approve button\'s disabled= literally ORs in trustLoading — not just a substring that would survive negation', () => {
    const at = SRC.indexOf("onClick={() => void decide(selected, 'approved')}");
    expect(at, 'the desktop Approve button was not found').toBeGreaterThan(-1);
    const tag = enclosingOpenTag(SRC, 'button', at);
    // A bare `toMatch(/trustLoading/)` here would also pass for
    // `disabled={!trustLoading}` (inverted — the exact defect being guarded
    // against). Requiring the literal `deciding || trustLoading` sequence
    // does not.
    expect(tag).toContain('deciding || trustLoading');
  });

  it('and the gate BEHAVES: the real disabled= expression is true while loading and false when settled', () => {
    // ⚠ FINAL REVIEW (2026-08-21). The arm above is still a substring test,
    // and the coordinator's own note conceded it "would pass for an inverted
    // gate". It is worse than that concession: `disabled={!(deciding ||
    // trustLoading)}` — a total inversion — CONTAINS the literal sequence
    // `deciding || trustLoading`, so the arm above passes for it. This arm
    // lifts the actual expression out of the source and evaluates it, which
    // is the only thing that can tell a gate from its negation without a
    // renderer.
    //
    // ⛔ INVERSION RUNS, measured across this file + the mobile one (26 arms):
    //   * disabled={!(deciding || trustLoading || …)} — a TOTAL inversion —
    //     reddened THIS arm and nothing else. 25 of 26 still passed, the
    //     substring arm above among them. That is the review finding
    //     reproduced exactly, and the reason this arm exists.
    //   * dropping trustLoading from the gate entirely reddened BOTH arms.
    const at = SRC.indexOf("onClick={() => void decide(selected, 'approved')}");
    const tag = enclosingOpenTag(SRC, 'button', at);
    const expr = attributeExpression(tag, 'disabled');
    const scope = (over: Record<string, unknown>) => ({
      deciding: false,
      trustLoading: false,
      // A trust_promotion task: not a checklist, so the third disjunct is
      // false and the two under test are the only things that can move.
      selected: { type: 'trust_promotion', checklist_state: [] },
      ...over,
    });
    // SETTLED: nothing in flight, evidence loaded -> Approve must be live.
    expect(evalAttributeExpression(expr, scope({}))).toBe(false);
    // LOADING: the evidence has not arrived -> Approve must be dead.
    expect(evalAttributeExpression(expr, scope({ trustLoading: true }))).toBe(true);
    // And the pre-existing half of the same gate still holds.
    expect(evalAttributeExpression(expr, scope({ deciding: true }))).toBe(true);
    // The checklist disjunct this arm deliberately holds constant is still
    // wired — asserted here so holding it constant above is a choice, not an
    // accidental blind spot.
    expect(evalAttributeExpression(expr, scope({
      selected: { type: 'checklist', checklist_state: [{ done: false }] },
    }))).toBe(true);
  });

  it('the button label says so while checking, same wording as the checklist/evidence copy elsewhere', () => {
    const at = SRC.indexOf("onClick={() => void decide(selected, 'approved')}");
    const tag = enclosingOpenTag(SRC, 'button', at);
    // The label ternary sits in the children, just after the tag's real
    // close (found via the tag's own length, not a naive '>' search — see
    // enclosingOpenTag's header for why that under-counts here).
    const tagEnd = SRC.indexOf(tag) + tag.length;
    const after = SRC.slice(tagEnd, tagEnd + 400);
    expect(after).toMatch(/trustLoading \? 'Checking…'/);
  });
});

describe('the evidence block itself (fix round 1, re-checked after round 2\'s state change)', () => {
  it('is gated on trust_promotion and renders trustCopy.detail plus a thin-evidence chip', () => {
    const at = SRC.indexOf("selected.type === 'trust_promotion' && (");
    expect(at, 'the evidence block render site was not found').toBeGreaterThan(-1);
    const nearby = SRC.slice(at, at + 1500);
    expect(nearby).toContain('trustCopy.detail');
    expect(nearby).toMatch(/trustThin && <Chip tone="warn">Thin evidence<\/Chip>/);
  });
});

describe('batch selection excludes trust_promotion — the small half of item 4', () => {
  it('batchSelectable is defined and excludes the type', () => {
    const at = SRC.indexOf('const batchSelectable =');
    expect(at, 'batchSelectable predicate not found').toBeGreaterThan(-1);
    const statement = SRC.slice(at, SRC.indexOf(';', at) + 1);
    expect(statement).toContain("t.status === 'pending'");
    expect(statement).toContain("t.type !== 'trust_promotion'");
  });

  it('select-all (ids, count, and the clear/select label) all read batchSelectable, not a bare pending check', () => {
    // Pinned as a COUNT, not just presence — three call sites existed before
    // this fix (ids, the size comparison, the label), and a fix that patched
    // only one would still let the other two smuggle a trust_promotion id
    // into `picked` via "Select all".
    const uses = SRC.match(/visible\.filter\(batchSelectable\)/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(3);
    // And the OLD, unscoped form must be gone from this control entirely —
    // not just outnumbered by the new one.
    expect(SRC).not.toMatch(/visible\.filter\(t => t\.status === 'pending'\)/);
  });

  it('the per-row checkbox renders disabled-with-a-reason for a pending trust_promotion row, not the live selectable one', () => {
    const at = SRC.indexOf("task.status === 'pending' && task.type === 'trust_promotion' ? (");
    expect(at, 'the trust_promotion-specific checkbox branch was not found').toBeGreaterThan(-1);
    const nearby = SRC.slice(at, at + 500);
    expect(nearby).toMatch(/<input\s+type="checkbox"\s+disabled/);
    expect(nearby).toMatch(/title="[^"]*batch-approved[^"]*"/);
    // And the branch actually reached for a REAL trust_promotion+pending row
    // is the disabled one, not the live `batchSelectable` one — checked by
    // making sure `batchSelectable(task)` appears in the ELSE arm that
    // follows, not gating this branch itself.
    const afterTernaryElse = SRC.slice(at, SRC.indexOf(') : batchSelectable(task) && (', at) + 40);
    expect(afterTernaryElse).toContain('batchSelectable(task) && (');
  });
});

describe('the raw task.detail no longer restates the card beside it (final review)', () => {
  // ⚠ THE DEFECT: task.detail renders ABOVE the evidence card, and for a
  // criteria-shaped request it is the SQL-composed sentence "Evidence met all
  // criteria: … . Approving widens autonomy one step — still capped by
  // guardrails." The approver read the evidence twice, in two voices, and the
  // first promised a cap the trust ladder does not grant (measured:
  // trust_level_settings('action_execute', N) returns max_amount_cents NULL
  // for every N >= 1). Suppressed here; the pattern detector's detail, which
  // carries citation receipts nothing else reproduces, is deliberately kept.
  it('the detail paragraph is guarded by trustDetailRedundant, not rendered unconditionally', () => {
    // ⛔ INVERSION: reverting this site to an unguarded {selected.detail &&}
    // reddened this arm alone (1 of 26).
    const at = SRC.indexOf('{selected.detail &&');
    expect(at, 'the raw detail render site was not found').toBeGreaterThan(-1);
    const line = SRC.slice(at, at + 200);
    expect(line).toContain('!trustDetailRedundant');
  });

  it('trustDetailRedundant is DERIVED, and requires the card to have actually rendered', () => {
    // Three conjuncts, all load-bearing: the task type (this rule is only
    // about trust_promotion), !!trustCopy (a load error, an unlinked policy
    // or an unreadable snapshot must ALL still show the detail — hiding it
    // there would leave the approver with nothing at all), and the shared
    // predicate (which is what keeps a pattern-shaped proposal's receipts on
    // screen).
    // ⛔ INVERSION: deleting the '&& !!trustCopy' conjunct reddened this arm
    // alone (1 of 26) — the conjunct that keeps the detail on screen when the
    // card could not render.
    const at = SRC.indexOf('const trustDetailRedundant =');
    expect(at, 'trustDetailRedundant is not declared as a derived const').toBeGreaterThan(-1);
    const statement = SRC.slice(at, SRC.indexOf(';', at) + 1);
    expect(statement).toContain("'trust_promotion'");
    expect(statement).toContain('!!trustCopy');
    expect(statement).toContain('detailIsRedundantBesideCard');
  });

  it('the rule comes from the shared module — no second copy of it on this surface', () => {
    expect(SRC).toContain("from '../../../lib/trustPromotionPresentation'");
    expect(SRC).toContain('detailIsRedundantBesideCard');
  });
});
