// ============================================================
// THE AUDIT TRAIL MUST HAVE A READER, AND ITS EMPTY STATE MUST NOT LIE.
//
// `remote_access_write_log` records every write a platform operator makes
// INSIDE a customer's workspace during Remote Access. Production held 194 such
// rows (2026-07-07 → 2026-07-23) with 74 audit triggers attached, and the only
// component in the entire repo that reads the table —
// `RemoteAccessWriteAuditPanel`, ~150 lines, complete, filterable by tenant —
// was DECLARED AND NEVER RENDERED. For a product whose claim is governed
// action, an audit trail visible to nobody is the sharpest form of the defect.
// Register item B-20; render site added 2026-08-21.
//
// It hid because `noUnusedLocals` is false in tsconfig.json, so nothing in the
// toolchain has an opinion about a component no JSX ever mounts.
//
// ── AND THE SECOND HALF, WHICH IS EASIER TO GET WRONG ─────────────────────
// An UNAUTHORISED read of this table does not fail. `authenticated` holds the
// SELECT grant, so PostgREST answers 200 with `[]` and RLS silently filters.
// Measured in production on 2026-08-21 — the same statement under role
// `authenticated` returned 194 rows for a platform_super_admin's `sub` and 0
// for a tenant_owner's, and NEITHER errored. (anon is different: no grant, hard
// 42501.) So a panel that renders "No remote-access writes recorded yet" over
// an empty result set is stating the single most reassuring reading of "the
// database refused you" — that no operator has ever touched customer data.
// That is the measurement-organ-lies defect, in the governance panel.
//
// ── WHY THIS TEST IS STRUCTURAL AND NOT A RENDER ──────────────────────────
// Same reason as tests/platform-demand-empty-state.test.ts, re-measured here
// rather than assumed: vitest.config.ts sets `environment: 'node'` with
// `include: ['tests/**/*.test.ts']`, and package.json carries no jsdom and no
// @testing-library/react. A `.tsx` render test would not even be collected.
//
// ⚠ EVERY ARM BELOW WAS RUN AGAINST THE DEFECT AND OBSERVED RED before it was
// kept — the render site deleted, the refusal branch deleted, and the probe
// promoted to a gate. A checker that cannot fail is theatre.
// ============================================================
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const PAGE_PATH = 'src/pages/platform/PlatformConsolePage.tsx';
const PANEL = 'RemoteAccessWriteAuditPanel';

/** ⚠ COMMENTS ARE STRIPPED BEFORE ANYTHING BELOW READS THE SOURCE, and here
 *  that is not a nicety: the header comment on the panel itself quotes
 *  `<RemoteAccessWriteAuditPanel`, `canAudit`, `remote_access.audit` and the
 *  words of the refusal copy, precisely so the next reader understands the
 *  trap. Every arm of this file would pass on a source file that had been
 *  gutted down to that comment. Braces inside prose are not syntax either. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const RAW = readFileSync(PAGE_PATH, 'utf8');
const PAGE = stripComments(RAW);

/** Slice the body of `const NAME = (...) => { ... }`, brace-matched. The props
 *  are destructured, so PAREN depth is walked before the body brace. */
function sliceArrowComponent(src: string, name: string): string {
  const at = src.search(new RegExp(`const\\s+${name}\\s*=\\s*\\(`));
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

/** The SMALLEST balanced `{...}` region of `block` containing `index`. */
function tightestBracedRegion(block: string, index: number): string | null {
  let best: { text: string; span: number } | null = null;
  for (let i = 0; i <= index; i++) {
    if (block[i] !== '{') continue;
    let d = 0;
    for (let j = i; j < block.length; j++) {
      if (block[j] === '{') d++;
      else if (block[j] === '}') {
        d--;
        if (d === 0) {
          if (j >= index && (best === null || j - i < best.span)) best = { text: block.slice(i, j + 1), span: j - i };
          break;
        }
      }
    }
  }
  return best?.text ?? null;
}

/** The single ternary CONDITION that `index` participates in: backwards to the
 *  nearest enclosing `{`/`(`/`?`/`:` at the same bracket depth, forwards to the
 *  `?` that ends it.
 *
 *  ⚠ Written because the obvious version was not enough, and the mutation run
 *  proved it. Asking whether the whole `{a ? x : b ? y : z}` chain "mentions a
 *  zero-row test" is satisfied by ANY arm of the chain mentioning one — so
 *  promoting the capability probe to the chain's FIRST condition, the exact
 *  gate this file exists to forbid, sailed straight through. The condition has
 *  to be sliced out on its own. */
function enclosingCondition(block: string, index: number): string {
  const OPEN = '([{';
  const CLOSE = ')]}';
  let depth = 0;
  let start = 0;
  for (let i = index; i >= 0; i--) {
    const c = block[i];
    if (CLOSE.includes(c)) depth++;
    else if (OPEN.includes(c)) {
      if (depth === 0) { start = i + 1; break; }
      depth--;
    } else if (depth === 0 && (c === '?' || c === ':')) { start = i + 1; break; }
  }
  depth = 0;
  let end = block.length;
  for (let i = index; i < block.length; i++) {
    const c = block[i];
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) { if (depth === 0) { end = i; break; } depth--; }
    else if (depth === 0 && c === '?') { end = i; break; }
  }
  return block.slice(start, end);
}

const BODY = sliceArrowComponent(PAGE, PANEL);

describe('the Remote Access write audit log has a reader', () => {
  it('is the only reader of remote_access_write_log, and still queries it', () => {
    // If this ever stops being true the rest of the file is measuring the
    // wrong component, and the count below says so out loud rather than
    // quietly passing over a second reader somebody added elsewhere.
    const readers = PAGE.match(/from\(['"]remote_access_write_log['"]\)/g) ?? [];
    expect(readers.length).toBe(1);
    expect(BODY).toContain("from('remote_access_write_log')");
  });

  it('is actually RENDERED somewhere — declaring it is not shipping it', () => {
    // The whole of B-20 in one assertion. `<Panel` anywhere in the file, in
    // JSX, outside comments.
    const renderSites = PAGE.match(new RegExp(`<${PANEL}[\\s/>]`, 'g')) ?? [];
    expect(renderSites.length).toBeGreaterThan(0);
  });

  it('is rendered on the page branch that can name the tenants it lists', () => {
    // Not decoration. The panel prints a workspace NAME per row from the
    // `dbTenants` prop; mounted on a branch where that list is out of scope it
    // renders a column of raw UUIDs, and `platform_security` / `platform_demand`
    // are deliberately ungated on the tenant fetch for exactly that reason.
    const BRANCH = "if (page === 'platform_tenants')";
    const site = PAGE.search(new RegExp(`<${PANEL}[\\s/>]`));
    const branch = PAGE.lastIndexOf(BRANCH, site);
    expect(branch).toBeGreaterThan(-1);
    // ...and no LATER branch opens between that `if` and the render site,
    // which would mean the panel actually sits on a different page. Sliced
    // from AFTER the `if` itself, or the arm would match its own anchor and
    // could never pass — the shape of gate this repo has paid for twice.
    const between = PAGE.slice(branch + BRANCH.length, site);
    expect(between).not.toMatch(/if \(page === '/);
    // The tenant list really is what it is handed.
    const tag = PAGE.slice(site, PAGE.indexOf('/>', site) + 2);
    expect(tag).toMatch(/dbTenants=\{/);
  });
});

describe('the empty state distinguishes "nothing happened" from "you may not know"', () => {
  // The zero-row sentence that is only true when the reader is ALLOWED to see
  // rows. RLS returning 0 rows to a non-holder makes it a falsehood.
  const REASSURING = 'No remote-access writes recorded';

  it('asks the capability question at all', () => {
    expect(BODY).toContain("resolve_platform_capability");
    expect(BODY).toContain("remote_access.audit");
  });

  it('renders a DIFFERENT, refusing empty state when the capability is absent', () => {
    const at = BODY.indexOf(REASSURING);
    expect(at).toBeGreaterThan(-1);
    const guard = tightestBracedRegion(BODY, at);
    expect(guard).not.toBeNull();
    // ⚠ The tight region around the reassuring sentence must itself be a
    // conditional that has already ruled the refusal case out. A bare
    // `{visibleRows.length === 0 ? <p>nothing recorded</p> : ...}` — the
    // pre-fix code — goes red here, because `canAudit` appears nowhere in it.
    expect(guard!).toContain('canAudit');
    // And the alternative branch has to SAY something different, not just
    // suppress the table.
    expect(guard!).toMatch(/capability/i);
  });

  it('says which capability, so the reader can act on the refusal', () => {
    const at = BODY.indexOf(REASSURING);
    const guard = tightestBracedRegion(BODY, at)!;
    expect(guard).toContain('remote_access.audit');
  });
});

describe('the capability probe is a LABEL, never a gate', () => {
  // ⚠ This repo's recorded trap runs both ways. UI gating is not
  // authorisation — but a client-side probe that HIDES rows is worse than
  // useless: RLS is the authority, it has already decided, and a false
  // negative from the probe (a stale session, a failed RPC) would blank a log
  // the database was perfectly willing to serve. The rows must be governed by
  // the rows.
  it('consults the probe only where there are no rows to show', () => {
    // The precise property. `canAudit` may appear in a render condition ONLY
    // alongside a zero-row test, so it can choose the WORDING of an empty
    // state and can never remove a row the database was willing to serve.
    //
    // Red on the gate: `{canAudit === false ? <Banner/> : <table/>}` — the
    // enclosing expression names canAudit and no length at all. Also red on
    // the subtler `{canAudit ? <table/> : <Banner/>}`.
    const uses = [...BODY.matchAll(/\bcanAudit\s*(?:===|!==|\?|&&|\|\||\))/g)];
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      const cond = enclosingCondition(BODY, u.index!);
      expect(cond, `canAudit consulted without a zero-row test in the SAME condition:\n  ${cond.trim()}`)
        .toMatch(/length === 0/);
    }
    // And the rows themselves are reached without asking the probe anything.
    const at = BODY.indexOf('visibleRows.map');
    expect(at).toBeGreaterThan(-1);
    expect(tightestBracedRegion(BODY, at)!).not.toMatch(/\bcanAudit\b/);
  });

  it('treats an unanswerable probe as unknown, not as a refusal', () => {
    // `canAudit` starts null and only a literal `false` earns the refusal copy,
    // so a probe that itself errors degrades to the neutral empty state rather
    // than accusing a legitimate operator of having no access.
    expect(BODY).toMatch(/useState<boolean \| null>\(null\)/);
    expect(BODY).toMatch(/canAudit === false/);
  });
});
