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
