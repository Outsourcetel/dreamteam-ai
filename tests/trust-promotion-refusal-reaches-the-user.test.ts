// trust-promotion-refusal-reaches-the-user.test.ts — migration 837's client half.
//
// ── WHAT BROKE, AND WHY THIS FILE EXISTS ────────────────────────────────────
// apply_trust_promotion used to refuse a self-approval (and a stale request)
// with `raise exception`, one statement AFTER writing the audit row that
// recorded the refusal. The raise aborted the transaction that held the write,
// so a blocked self-approval left no trace at all. Measured on production
// 2026-08-21: trust_promotion_blocked_self_approval moved 0 -> 0 across a real
// refusal, while the same function's audit write on the non-raising path moved
// 0 -> 1. Migration 837 makes both refusals RETURN `ok:false` instead, which is
// the only way the row can survive — a raise cannot both abort and leave a
// durable write on one transaction.
//
// That moves the refusal off the error channel and into the payload, which is
// this repo's own named anti-pattern (project_payload_refusal_sweep): a 200 the
// UI reads as success. resolveTrustPromotion is what puts it back, with
// `if (r?.ok === false) throw …`. Delete that line and a blocked self-approval
// silently reports success to the person who just clicked Approve.
//
// So the line is pinned twice, deliberately: scripts/audit-silent-refusals.mjs
// (run by `npm run certify`) classifies the wrapper by that `ok === false …
// throw`, and this file asserts it directly.
//
// ── WHY THE CONDITION IS EVALUATED, NOT MATCHED ─────────────────────────────
// A `toMatch(/ok/)` would pass for an INVERTED gate — `r?.ok !== false` and
// `r?.ok === true` both contain "ok", and both are wrong in opposite
// directions. This repo already learned that once, in
// tests/human-tasks-trust-promotion-gate.test.ts ("a substring that survives
// negation is not proof of the relationship"). So the condition is extracted
// and RUN against four real payload shapes: the two the server refuses with,
// and the three it does not. An inverted, widened or narrowed gate fails on at
// least one of them.
//
// Structural rather than a render/integration test for the same reason as that
// file: this repo has no jsdom, no @testing-library, and no mocking convention
// (`vi.mock` appears nowhere in tests/, confirmed) — a test that stubbed the
// supabase client would be inventing a convention, and vitest.config.ts pins
// `environment: 'node'`.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const LIB_PATH = 'src/lib/trustApi.ts';
const MIGRATION_PATH = 'supabase/migrations/837_a_refusal_that_leaves_a_record.sql';
const MIGRATION_838_PATH = 'supabase/migrations/838_a_role_declares_what_a_step_grants.sql';

/** Comments are not code. Blanked rather than removed so this file cannot pass
 *  by matching the prose in the wrapper's own doc comment — which describes
 *  the very line it is checking for, and would otherwise satisfy every arm
 *  below with the implementation deleted. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const SRC = stripComments(readFileSync(LIB_PATH, 'utf8'));

/** The body of one exported function, up to the next top-level export. */
function wrapperBody(name: string): string {
  const start = SRC.indexOf(`export async function ${name}(`);
  expect(start, `${name} not found in ${LIB_PATH}`).toBeGreaterThan(-1);
  const after = SRC.slice(start);
  const end = after.slice(1).search(/\nexport\s+(?:async\s+)?(?:function|const|interface|type)\s/);
  return end < 0 ? after : after.slice(0, end + 1);
}

const BODY = wrapperBody('resolveTrustPromotion');

/** The refusal gate: `if (<condition involving .ok>) throw …`.
 *  Captured as one unit — an `if` whose consequent is anything other than a
 *  throw is not this gate and must not satisfy this test. */
const GATE = BODY.match(/if\s*\(([^)]*\bok\b[^)]*)\)\s*throw\b/);

/** Evaluate the extracted condition against a server payload. */
function refuses(payload: unknown): boolean {
  const cond = GATE![1];
  const varName = cond.match(/([A-Za-z_$][\w$]*)\s*\??\./)?.[1];
  expect(varName, `could not find the payload variable in: ${cond}`).toBeTruthy();
  // eslint-disable-next-line no-new-func
  return !!new Function(varName!, `return (${cond});`)(payload);
}

// The exact shapes migration 837's two refusal paths return. Kept literal so a
// server-side rename shows up as a failing parity arm below rather than as a
// gate that quietly stops matching anything.
const SELF_APPROVAL_REFUSAL = {
  applied: false, ok: false, reason: 'self_approval_blocked',
  message: 'the requester cannot approve their own promotion — a different teammate must approve',
};
const STALE_REFUSAL = {
  applied: false, ok: false, reason: 'stale',
  message: 'evidence regressed since the request — promotion rejected as stale',
};
// The three shapes 837 deliberately left alone. None carries `ok`, so none of
// them may throw — `no_pending_policy` in particular is a pre-existing
// in-payload refusal that this change did NOT widen into a throw.
const PROMOTED = { applied: true, new_level: 1 };
const REJECTED = { applied: false, reason: 'rejected' };
const NO_PENDING = { applied: false, reason: 'no_pending_policy' };

// ── migration 838 adds a THIRD refusal on the same contract ─────────────────
// A role that has not declared what a trust step grants cannot have its
// employees promoted (promotion_is_possible). 838 wires that refusal into
// apply_trust_promotion and — deliberately, having read this file first —
// returns it in 837's shape rather than raising, so the audit row recording the
// block survives. The gate above is `r?.ok === false`, so this reason is
// covered by construction; what is NOT covered by construction is the server
// still returning it, which the parity arm below pins to 838's own file.
const NOT_POSSIBLE_REFUSAL = {
  applied: false, ok: false, reason: 'promotion_not_possible',
  message: 'this promotion cannot be applied - this role has not declared what a trust step grants, so there is nothing to promote to',
};

describe('resolveTrustPromotion puts the server refusal back on the error channel', () => {
  it('has a refusal gate whose consequent is a throw', () => {
    expect(GATE, `resolveTrustPromotion no longer refuses on the payload. Migration 837 made the self-approval and stale paths RETURN ok:false instead of raising, so this line is the ONLY thing standing between a governed refusal and a success message. See ${LIB_PATH}.`).toBeTruthy();
  });

  it('throws on BOTH paths that used to raise', () => {
    expect(refuses(SELF_APPROVAL_REFUSAL), 'a blocked self-approval must reach the user as an error').toBe(true);
    expect(refuses(STALE_REFUSAL), 'a stale-evidence refusal must reach the user as an error').toBe(true);
  });

  it('throws on migration 838\'s undeclared-ladder refusal too', () => {
    expect(refuses(NOT_POSSIBLE_REFUSAL), 'a promotion refused because the role declares no trust ladder must reach the user as an error, not a silent 200').toBe(true);
  });

  it('does NOT throw on any path 837 left alone', () => {
    // ⚠ THE INVERSION. Without these three, `ok !== false`, `true`, or any
    // widened gate passes the arm above — and every successful promotion would
    // throw. The two arms only mean something together.
    expect(refuses(PROMOTED), 'a successful promotion must not throw').toBe(false);
    expect(refuses(REJECTED), 'an ordinary rejection is a successful outcome, not a refusal').toBe(false);
    expect(refuses(NO_PENDING), 'no_pending_policy was already an in-payload refusal the caller ignored; 837 did not widen it').toBe(false);
  });

  it('shows the user the server\'s own sentence, not a generic one', () => {
    // The guard's wording is the whole explanation ("a different teammate must
    // approve"). A throw that discarded it would tell somebody a promotion
    // failed without telling them what to do about it.
    expect(BODY).toMatch(/throw\s+new\s+CustomerApiError\s*\(\s*[A-Za-z_$][\w$]*\.message\b/);
  });

  it('still calls the RPC it is the wrapper for', () => {
    expect(BODY).toMatch(/\.rpc\(\s*['"]apply_trust_promotion['"]/);
  });
});

describe('client and server agree on the refusal contract', () => {
  const SQL = readFileSync(MIGRATION_PATH, 'utf8');

  it('migration 837 returns the reasons and messages this file pins', () => {
    for (const r of [SELF_APPROVAL_REFUSAL, STALE_REFUSAL]) {
      expect(SQL, `migration 837 no longer returns reason '${r.reason}'`).toContain(`'reason', '${r.reason}'`);
      expect(SQL, `migration 837 no longer returns the message pinned here for '${r.reason}'`).toContain(r.message);
    }
  });

  it('migration 838 returns the third reason and message this file pins', () => {
    const SQL_838 = readFileSync(MIGRATION_838_PATH, 'utf8');
    expect(SQL_838, `migration 838 no longer returns reason '${NOT_POSSIBLE_REFUSAL.reason}'`)
      .toContain(`'reason', '${NOT_POSSIBLE_REFUSAL.reason}'`);
    // The message is composed at runtime — format('this promotion cannot be
    // applied - %s', <why>) — so the pinnable halves are the prefix the server
    // builds and the `why` promotion_is_possible supplies for the arm this
    // whole migration exists for. Both are asserted; the constant above is the
    // concatenation a user actually sees.
    expect(SQL_838, 'migration 838 no longer builds the refusal message prefix pinned here')
      .toContain("'this promotion cannot be applied - %s'");
    expect(SQL_838, 'promotion_is_possible no longer gives the undeclared-ladder reason pinned here')
      .toContain('this role has not declared what a trust step grants, so there is nothing to promote to');
    // ⚠ AND IT MUST RETURN, NOT RAISE. 837 measured that a raise here rolls the
    // refusal's own audit row back. A future edit that "tidies" 838's return
    // into a raise would restore that defect silently, and the arm above would
    // still pass because the message literals would survive.
    expect(SQL_838, 'migration 838 must RETURN its refusal, not raise it — see 837')
      .toContain("return jsonb_build_object('applied', false, 'ok', false, 'reason', 'promotion_not_possible'");
  });

  it('keeps the literal scripts/audit-silent-refusals.mjs finds this function by', () => {
    // That auditor selects refusing functions with
    //   pg_get_functiondef(oid) like '%''ok'', false%'
    // If this literal is reformatted away, apply_trust_promotion stops being
    // seen as a refuser and the wrapper's throw stops being checked by certify.
    expect(SQL).toContain("'ok', false");
  });
});
