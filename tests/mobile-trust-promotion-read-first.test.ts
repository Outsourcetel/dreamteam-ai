// mobile-trust-promotion-read-first.test.ts — proves Task 6's own purpose
// ("the person deciding must see the evidence, and must be told plainly when
// it is thin") holds on the SECOND surface that decides trust_promotion
// tasks, not just the desktop ops queue.
//
// Fix round 1 (coordinator review, 2026-08-21): the phone shell
// (src/pages/tenant/mobile/MobileShell.tsx) calls the exact same
// decideHumanTask() as desktop — its own header says so: "NO SECOND SOURCE
// OF TRUTH... There is no mobile decision path" — but its READ_FIRST list,
// the gate between a one-tap Approve and being made to open the detail
// first, did not include 'trust_promotion'. A promotion (WIDENING what an
// employee may do) could be approved in one tap, showing only the raw task
// title/detail. trust_demotion_notice (REMOVING autonomy, the safe
// direction) already required the read — the list was backwards on risk.
// This is Task 6's own defect, on a second surface, not a neighbouring one.
//
// ── WHY THIS IS A STRUCTURAL TEST, NOT A RENDER TEST ───────────────────────
// Same reason as tests/platform-demand-empty-state.test.ts and
// tests/remote-access-write-audit-reader.test.ts, re-measured here rather
// than assumed: vitest.config.ts sets environment: 'node' with
// include: ['tests/**/*.test.ts'], and package.json carries no jsdom and no
// @testing-library/react. A .tsx render test would not even be collected.
//
// Every "new behaviour" arm below was run against the pre-fix file and
// observed RED before being kept — a checker that cannot fail is theatre.
// (The render-site-gating arm is a CONTROL: it proves the mechanism the fix
// relies on already works, so it is expected to pass before AND after — that
// is what makes the READ_FIRST-membership arm meaningful rather than an
// unused constant.)
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const PAGE_PATH = 'src/pages/tenant/mobile/MobileShell.tsx';

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const RAW = readFileSync(PAGE_PATH, 'utf8');
const SRC = stripComments(RAW);

/** Balanced `{...}` starting from the first `{` at or after `at` (an index,
 *  or a needle resolved via indexOf). */
function sliceBlock(src: string, at: string | number): string {
  const start = typeof at === 'string' ? src.indexOf(at) : at;
  if (start === -1) throw new Error(`sliceBlock: anchor not found in ${PAGE_PATH}`);
  const braceAt = src.indexOf('{', start);
  if (braceAt === -1) throw new Error(`sliceBlock: no '{' at/after index ${start}`);
  let depth = 0;
  for (let i = braceAt; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(braceAt, i + 1); }
  }
  throw new Error('sliceBlock: unbalanced braces');
}

/** The nearest `<TagName …>` opening tag whose `>` is at or after `around`.
 *  ⚠ FIX ROUND 2: not a naive `indexOf('>')` — this button's own onClick is
 *  an arrow function (`() => …`), which contains a `>` of its own. The naive
 *  version happened to still work here only because this file's `disabled=`
 *  attribute is written BEFORE `onClick=`, so the truncation landed after
 *  the part being asserted on; the desktop equivalent
 *  (tests/human-tasks-trust-promotion-gate.test.ts) has `onClick` FIRST and
 *  the same naive version silently truncated before ever reaching
 *  `disabled=`, failing for the wrong reason until this was fixed there and
 *  mirrored back here. Tracks brace depth and string literals so a `>`
 *  inside `{…}` (an arrow, a comparison) or a quoted attribute is never
 *  mistaken for the tag's own close. */
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
    if (braceDepth > 0) continue;
    if (c === '>') return src.slice(tagStart, i + 1);
  }
  throw new Error(`enclosingOpenTag: no real tag-close '>' found for <${tagName} starting at ${tagStart}`);
}

// The "read it properly" screen — everything between `if (open) {` and its
// matching close. This is what a tap on "Read it" / "Details" actually
// shows, and what stands between a one-tap Approve and an informed one.
const OPEN_VIEW = sliceBlock(SRC, 'if (open) {');

describe('mobile requires reading a trust promotion before deciding it', () => {
  it('trust_promotion is in READ_FIRST — RED if it is missing, as it was before this fix', () => {
    const arrayLiteral = SRC.match(/const READ_FIRST: HumanTaskType\[\] = \[([\s\S]*?)\];/);
    expect(arrayLiteral, 'READ_FIRST array literal not found — this test cannot check what it cannot find').not.toBeNull();
    expect(arrayLiteral![1]).toMatch(/'trust_promotion'/);
  });

  it('READ_FIRST is what separates "Read it" from an inline Approve at the render site (control — passes either way; proves the array is load-bearing rather than decorative)', () => {
    const at = SRC.indexOf('readFirst(t) ?');
    expect(at, 'the readFirst(t) ? … : … render-site ternary was not found').toBeGreaterThan(-1);
    const ternary = sliceBlock(SRC, SRC.lastIndexOf('{', at));
    // The Approve-wired-straight-to-decide branch must sit on the FALSE arm
    // of readFirst(t) — i.e. it is what a type absent from READ_FIRST gets.
    expect(ternary).toContain("onClick={() => void decide(t, 'approved')}");
    const approveAt = ternary.indexOf("onClick={() => void decide(t, 'approved')}");
    const questionAt = ternary.indexOf('?');
    const colonAt = ternary.indexOf(':', questionAt);
    expect(colonAt, 'no ternary colon found').toBeGreaterThan(-1);
    expect(approveAt, 'the inline Approve must be on the FALSE (else) side of readFirst(t) ?, not the true side').toBeGreaterThan(colonAt);
  });
});

describe('the "Read it" screen shows the evidence, not just the raw task text', () => {
  it('imports the same pure presentation module the desktop queue uses — no second source of truth', () => {
    expect(SRC).toContain("from '../../../lib/trustPromotionPresentation'");
    expect(SRC).toMatch(/\btrustPromotionCardCopy\b/);
    expect(SRC).toMatch(/\bextractPolicyEvidence\b/);
  });

  it('renders trustCopy.detail for a trust_promotion task, inside the open-task screen specifically', () => {
    expect(OPEN_VIEW).toMatch(/open\.type === 'trust_promotion'/);
    expect(OPEN_VIEW).toContain('trustCopy.detail');
  });

  it('says plainly when the evidence is thin, on this screen too', () => {
    expect(OPEN_VIEW).toMatch(/\btrustThin\b/);
    expect(OPEN_VIEW).toMatch(/Thin evidence/);
  });

  it('does not let Approve resolve before the evidence has finished loading', () => {
    // Same discipline this file already applies to the gated-reply draft two
    // lines away (`disabled={busy || draft === undefined}`) — a tap must not
    // be able to go through before the thing it is supposed to inform the
    // decision has arrived.
    // ⚠ FIX ROUND 2: a bare `toMatch(/trustLoading/)` would also pass for an
    // INVERTED gate (`disabled={!trustLoading}` contains the identifier too)
    // — flagged by the coordinator as a real gap in this exact assertion.
    // Requiring the literal `&& trustLoading)` close does not survive that
    // inversion.
    const at = OPEN_VIEW.indexOf("onClick={() => void decide(open, 'approved')}");
    expect(at, 'the mobile Approve button for the open task was not found').toBeGreaterThan(-1);
    const tag = enclosingOpenTag(OPEN_VIEW, 'Button', at);
    expect(tag).toContain("(open.type === 'trust_promotion' && trustLoading)");
  });
});

describe('trustPolicy is tri-state, not a resolved value plus a separate flag (fix round 2)', () => {
  // The coordinator's second "close the same class on mobile" finding:
  // `trustLoading` used to be its OWN useState(false) — a resolved, settled
  // value from the very first render — while the effect that ever set it
  // `true` only runs after commit. For one real frame between a
  // trust_promotion task being opened and that effect firing, the screen
  // could show "No trust policy is linked — approving would change nothing"
  // with Approve tappable. This file's OWN `draft` state, two hundred lines
  // above, already dodges exactly this with a THREE-state value
  // (`PendingConversationDraft | null | undefined`, "undefined = still
  // looking") — trustPolicy now uses the same shape.
  it('initialises to undefined ("still looking"), not null or a stored boolean', () => {
    expect(SRC).toMatch(/useState<TrustPolicy \| null \| undefined>\(undefined\)/);
  });

  it('trustLoading is DERIVED from trustPolicy === undefined, never its own stored state', () => {
    expect(SRC).not.toContain('setTrustLoading');
    const at = SRC.indexOf('const trustLoading =');
    expect(at, 'trustLoading is not declared as a derived const').toBeGreaterThan(-1);
    const statement = SRC.slice(at, SRC.indexOf(';', at) + 1);
    expect(statement).toContain('trustPolicy === undefined');
  });

  it('a failed fetch settles trustPolicy to null rather than leaving it undefined (and Approve disabled) forever', () => {
    const at = SRC.indexOf('Could not load the evidence behind this request.');
    expect(at, 'the catch handler\'s own error message was not found').toBeGreaterThan(-1);
    const nearby = SRC.slice(at, at + 200);
    expect(nearby).toContain('setTrustPolicy(null)');
  });
});
