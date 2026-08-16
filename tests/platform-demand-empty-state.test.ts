// ============================================================
// THE EMPTY STATE MUST NOT ASSERT A FINDING THE SCREEN CANNOT MAKE.
//
// Platform › Customer Demand renders a red banner when
// `gap_dimensions === 0`: "This screen cannot report a finding right now."
// The first version of the page then rendered, DIRECTLY BENEATH IT, the
// headline "No customer has asked for something we cannot staff." — and a
// closing line promising "you would be looking at a red notice instead of
// this one" while a red notice was on screen.
//
// Only the banner and one stat tile were conditioned on `gap_dimensions`.
// The sentence a human actually reads was not. So emptying the gap catalogue
// made the roadmap screen report a clean bill of health it explicitly could
// not know — the measurement-organ-lies defect, inside the component written
// to prevent it.
//
// ── WHY THIS TEST IS STRUCTURAL AND NOT A RENDER ──────────────────────────
// Not a preference. This repo's vitest runs `environment: 'node'` with
// `include: ['tests/**/*.test.ts']`, and carries no jsdom and no
// @testing-library/react — measured in package.json and vitest.config.ts
// before this file was written, not assumed. A `.tsx` render test would not
// even be collected. Structural assertions over the source are the pattern
// this repo already uses for page-level properties
// (tests/discovery-interview.test.ts, tests/discovery-proposal-batching.test.ts).
//
// ⚠ SO THE ASSERTIONS ARE WRITTEN TO FAIL ON THE ACTUAL DEFECT, not to grep
// for a reassuring token. Each one below was RUN against the pre-fix wording
// and observed RED before it was kept. In particular, "the sentence sits
// inside some expression mentioning gap_dimensions" is NOT enough on its own:
// the component destructures `gap_dimensions` at the top, so the function
// body itself mentions it, and a bare JSX sentence would trivially satisfy a
// naive enclosing-scope test. The enclosing expression is therefore required
// to be strictly TIGHTER than the function body.
// ============================================================
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const PAGE_PATH = 'src/pages/platform/PlatformDemandPage.tsx';

/** ⚠ COMMENTS ARE STRIPPED BEFORE ANYTHING BELOW LOOKS AT THE SOURCE, and
 *  this is load-bearing twice over.
 *
 *  Caught by this very test on its first run: the page carries a note
 *  explaining why `setReport(null)` used to be needed, and the state-slot arm
 *  went red against code that no longer has a `setReport` at all. A check that
 *  a comment can trip is a check a comment can also SATISFY — a file that
 *  merely QUOTES the guarded sentence would have passed the "is it rendered
 *  conditionally" arms while rendering nothing of the sort.
 *
 *  It also makes the brace matching honest: braces inside prose are not
 *  syntax, and counting them would mis-locate every enclosing expression. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const PAGE = stripComments(readFileSync(PAGE_PATH, 'utf8'));

/** The vacuity input. Everything on this screen that claims a finding has to
 *  trace back to it. */
const GAP = 'gap_dimensions';

/** The sentence that must never render unconditionally. */
const REASSURING_HEADLINE = 'No customer has asked for something we cannot staff.';
/** ...and the closing line that claims a failure would have looked different. */
const RED_NOTICE_CLAIM = 'red notice instead of this';

/** Slice `function NAME(...) { ... }` out of source, brace-matched. The
 *  parameter list is skipped by PAREN depth first, because the destructured
 *  props are themselves braces. */
function sliceFunction(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`);
  if (at === -1) throw new Error(`${name} not found in ${PAGE_PATH} — this test cannot check what it cannot find`);
  let i = src.indexOf('(', at);
  let paren = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') paren++;
    else if (src[i] === ')') { paren--; if (paren === 0) { i++; break; } }
  }
  const bodyStart = src.indexOf('{', i);
  if (bodyStart === -1) throw new Error(`${name} has no body`);
  let brace = 0;
  for (let j = bodyStart; j < src.length; j++) {
    if (src[j] === '{') brace++;
    else if (src[j] === '}') { brace--; if (brace === 0) return src.slice(bodyStart, j + 1); }
  }
  throw new Error(`${name}'s body is unbalanced`);
}

/** The raw text of a JSX attribute's value — `"a string"` or `{anExpression}`,
 *  returned WITH its delimiter so a bare literal is distinguishable. */
function jsxAttrValue(block: string, attr: string): string {
  const at = block.indexOf(`${attr}=`);
  if (at === -1) throw new Error(`no \`${attr}=\` attribute found`);
  const v = at + attr.length + 1;
  const c = block[v];
  if (c === '"' || c === "'") {
    const end = block.indexOf(c, v + 1);
    if (end === -1) throw new Error(`unterminated ${attr} literal`);
    return block.slice(v, end + 1);
  }
  if (c !== '{') throw new Error(`unrecognised ${attr} value starting ${JSON.stringify(block.slice(v, v + 20))}`);
  let d = 0;
  for (let j = v; j < block.length; j++) {
    if (block[j] === '{') d++;
    else if (block[j] === '}') { d--; if (d === 0) return block.slice(v, j + 1); }
  }
  throw new Error(`unbalanced ${attr} expression`);
}

/** The SMALLEST balanced `{...}` region of `block` containing `index`.
 *  Returns null when the only thing enclosing it is nothing at all. */
function tightestBracedRegion(block: string, index: number): { text: string; start: number; end: number } | null {
  let best: { text: string; start: number; end: number } | null = null;
  for (let i = 0; i <= index; i++) {
    if (block[i] !== '{') continue;
    let d = 0;
    for (let j = i; j < block.length; j++) {
      if (block[j] === '{') d++;
      else if (block[j] === '}') {
        d--;
        if (d === 0) {
          if (j >= index && (best === null || j - i < best.end - best.start)) {
            best = { text: block.slice(i, j + 1), start: i, end: j };
          }
          break;
        }
      }
    }
  }
  return best;
}

/** Does `expr` depend on gap_dimensions — directly, or through ONE local
 *  const declared in `scope`? A rename to a derived flag stays green; a
 *  hardcoded `true`, or a condition on some unrelated number, goes red. */
function dependsOnGap(expr: string, scope: string): boolean {
  if (expr.includes(GAP)) return true;
  for (const id of new Set(expr.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
    const m = scope.match(new RegExp(`\\b(?:const|let|var)\\s+${id}\\s*=\\s*([^;]+);`));
    if (m && m[1].includes(GAP)) return true;
  }
  return false;
}

describe('Platform › Customer Demand: the empty state cannot claim a finding it cannot make', () => {
  const EMPTY = sliceFunction(PAGE, 'AnchoredEmpty');

  // ⚠ ZERO COMPARISONS LOOKS EXACTLY LIKE A CLEAN RESULT. If the sentences
  // this file is about have been reworded, every arm below would silently
  // check nothing. So their PRESENCE is asserted first, and a reword breaks
  // this test loudly instead of disarming it.
  it('is actually pointed at the sentences it claims to guard', () => {
    expect(EMPTY.length).toBeGreaterThan(200);
    expect(EMPTY).toContain(REASSURING_HEADLINE);
    expect(EMPTY).toContain(RED_NOTICE_CLAIM);
    expect(EMPTY).toContain(GAP);
  });

  it('does not hand EmptyState a hardcoded headline', () => {
    const headline = jsxAttrValue(EMPTY, 'headline');
    // A bare `headline="No customer has asked…"` is the defect, verbatim.
    expect(
      headline.startsWith('{'),
      `AnchoredEmpty's headline is a fixed literal (${headline.slice(0, 80)}). It renders the same ` +
      `sentence whether or not the gap catalogue can produce a finding at all.`,
    ).toBe(true);
  });

  it('swings the headline on whether a finding is possible at all', () => {
    const headline = jsxAttrValue(EMPTY, 'headline');
    expect(headline).toContain(REASSURING_HEADLINE);
    expect(
      dependsOnGap(headline, EMPTY),
      `AnchoredEmpty's headline expression does not depend on ${GAP}. With no interview dimension ` +
      `naming an unstaffed capability the log CANNOT gain a row, and this screen would print ` +
      `"${REASSURING_HEADLINE}" underneath its own red banner saying it cannot report a finding.`,
    ).toBe(true);
    // ...and there must be a second thing to say. A ternary whose both arms
    // are the same reassurance would pass everything above.
    const alternatives = headline.match(/'[^']{20,}'/g) ?? [];
    expect(
      alternatives.length,
      'the headline expression offers no alternative wording, so it cannot say anything different when a finding is impossible',
    ).toBeGreaterThan(1);
  });

  it('swings the closing "you would have seen a red notice" line on the same condition', () => {
    const at = EMPTY.indexOf(RED_NOTICE_CLAIM);
    const region = tightestBracedRegion(EMPTY, at);
    expect(region, 'the closing line is not inside any expression at all').not.toBeNull();
    // ⚠ STRICTLY TIGHTER THAN THE FUNCTION BODY. AnchoredEmpty destructures
    // gap_dimensions on its first line, so the body itself always mentions it
    // — accepting the body as "the enclosing expression" would make this arm
    // pass on the very code it exists to reject.
    expect(
      region!.text.length,
      'the closing line sits in no expression tighter than the whole function body — i.e. it is unconditional JSX text, ' +
      'and it promises a red notice would have appeared instead of it while a red notice is on screen above it',
    ).toBeLessThan(EMPTY.length);
    expect(
      dependsOnGap(region!.text, EMPTY),
      `the closing line's enclosing expression does not depend on ${GAP}`,
    ).toBe(true);
  });
});

describe('Platform › Customer Demand: rows keep the grain the aggregate is computed at', () => {
  // Migration 744 groups discovery_capability_demand on (capability,
  // dimension_key, dimension_title) — the title is a denormalised snapshot so
  // a demand row survives the dimension being retitled. One capability can
  // therefore hold one row per title it has carried. A React key built from
  // two of the three columns collides on exactly that case: duplicate key,
  // and one `openKey` comparison opens both drill-downs at once.
  it('builds the row key from all three grain columns', () => {
    const body = sliceFunction(PAGE, 'DemandReportBody');
    const m = body.match(/const key = ([^;]+);/);
    expect(m, 'no `const key = …` found in the demand table — this test is checking nothing').not.toBeNull();
    const key = m![1];
    for (const col of ['capability', 'dimension_key', 'dimension_title']) {
      expect(
        key.includes(col),
        `the row key (${key}) omits ${col}, which is part of the aggregate's grain — two rows of the ` +
        `same capability under different dimension titles would collide on it`,
      ).toBe(true);
    }
  });
});

describe('Platform › Customer Demand: report and failure cannot both be on screen', () => {
  // platformDemandApi's union guarantees `report` is unreadable on the failure
  // arm. It does NOT constrain what a consumer does after destructuring it:
  // holding `report` and `failure` in two independent useState slots leaves
  // exclusivity resting on one `setReport(null)` line, and deleting that line
  // paints a red notice above a stale "No customer has asked…".
  it('keeps one state slot holding the whole discriminated result', () => {
    // `PlatformDemandPage` is an arrow-function const, not a `function`
    // declaration, so it is sliced from its declaration to end of file rather
    // than by sliceFunction.
    const at = PAGE.indexOf('const PlatformDemandPage');
    expect(at, 'PlatformDemandPage not found — this test is checking nothing').toBeGreaterThan(-1);
    const page = PAGE.slice(at);
    expect(page).toContain('useState<DemandReadResult');
    for (const setter of ['setReport(', 'setFailure(']) {
      expect(
        page.includes(setter),
        `${setter}…) is back: report and failure are in separate state slots again, so whether the ` +
        `screen can show a stale report under a fresh error depends on remembering to clear the other one`,
      ).toBe(false);
    }
  });
});
