// discovery-proposal-batching.test.ts — proves the Task 2 screen's batching
// rule is enforced in CODE, not just followed by convention in the page
// component. (.superpowers/sdd/2026-08-13-discovery-proposals-and-creation,
// Task 2: "a screen that is short where that is safe".)
//
// §11b (docs/superpowers/specs/2026-08-12-discovery-interview-design.md) is
// unambiguous: guardrail and trust_rule NEVER batch, full stop. If someone
// later "simplifies" src/lib/discoveryProposalPresentation.ts's
// batchModeFor by collapsing its two-set check into a single default, or a
// seventh proposal kind is added to PROPOSAL_KINDS without a decision about
// where it batches, this file is what goes red — not a design review that
// might not happen.
//
// Each block below states the exact data that would turn it red, per the
// "name the data that turns it red" standard this programme holds itself to.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import {
  PROPOSAL_KINDS, SECTION_ORDER, batchModeFor, cardCopyFor, guardrailLiteral, guardrailKindOf,
  guardrailAcceptability, screenGuardrailPattern, UNIVERSAL_PATTERN_SCREENS,
  formatCap, formatBareNumber, humanizeToken, humanizeSystem, humanizeConnectorTouch,
  whatAcceptingWrites, trustRuleBlockReason, itemsForBatchMode, needsAcceptConfirmation,
  __looksLikeEnforceablePattern_forDriftTestOnly,
  __looksLikeEnforceablePattern_forDriftTestOnly as looksLikeEnforceablePattern,
  sopTextForProcedure, procedureAcceptability,
} from '../src/lib/discoveryProposalPresentation';
// migration 752: the deterministic key lives with the writer, and the drift
// guard below pins it against the SQL construction that enforces it.
import { procedureDraftKey } from '../src/lib/discoveryApi';
// The WRITERS, imported for real — all three of them. Their screen runs before
// requireTenantId() and before the write, so a screened refusal throws without
// ever touching the network, which is what makes the cases below behavioural
// rather than a grep.
import { addGuardrailRule, updateGuardrailRule, STARTER_GUARDRAILS } from '../src/lib/guardrailApi';
import type { ProposalKind, PatternScreenFailure } from '../src/lib/discoveryProposalPresentation';
// ⚠ ONE BATTERY, ONE SET OF SEPARATORS — imported from the live differential
// rather than restated here. The script is what compares them against the REAL
// database; this file only checks the client half and the structure of the SQL.
import { BATTERY, PG_ONLY_WHITESPACE, guardrailBranch, extractPredicate } from '../scripts/guardrail-predicate-differential.mjs';
// The REAL implementation this file's copy must never drift from — same
// "duplicated on purpose, drift-guarded here" pattern Task 1's own test file
// uses for matchProvider (tests/discovery-proposals.test.ts). A real import
// of a supabase/functions/_shared module is legal under vitest (Vite
// resolves it fine); it is Deno that cannot load anything importing
// import.meta.env, which is why the frontend copy exists at all.
import { validatePayload as realValidatePayload } from '../supabase/functions/_shared/discoveryProposals.ts';
// The fourth door onto guardrail_rules.pattern, and the only one that is not
// PostgREST — see THE RPC DOORS below. Its screen runs before the RPC call, so
// a refusal throws without a network round trip, same as the other three.
import { approveLearnedBehavior } from '../src/lib/selfLearningApi';
import { screenPatternForWrite } from '../src/lib/guardrailApi';

// ── THE FILE LIST EVERY ENUMERATION BELOW READS ────────────────────────────
//
// ⚠⚠ `git ls-files` READS THE INDEX, NOT THE WORKING TREE — and every
// enumeration in this file used it alone. Reconstructed and re-measured
// 2026-08-17 with this helper reverted to the index-only query: a new UNTRACKED
// file holding a bare `supabase.from('guardrail_rules').insert({ pattern })`
// left THE ENUMERATION below GREEN (2 unrelated pins went red — the two that
// watch the file list itself). The identical bytes in a TRACKED file turn it
// red at once.
//
// That is not a theoretical gap, it is the normal case. The session in which a
// door is added is exactly the session in which the file is still untracked,
// and this repository is worked by several agents in one tree — migration 751
// and scripts/guardrail-predicate-differential.mjs were themselves untracked
// while these very pins were being written.
//
// `-o --exclude-standard` adds untracked-but-not-ignored paths. The union is
// deduped because git prints nothing twice but the two lists can overlap after
// an `git add`. IGNORED files stay out deliberately: node_modules/ and
// .claude/worktrees/ hold entire second copies of src/, and scanning those
// would report the copy as an offender in the original's place.
//
// ⚠⚠ READ A RED ENUMERATION IN THIS TREE AS "A PROBE IS ON DISK" FIRST.
// Unioning untracked files is what closes the hole (a door added in the same
// session that adds it was invisible while this read only `git ls-files`), but
// it has a cost: several agents work this repo in one tree, and ANY foreign
// scratch file under src/, supabase/functions/ or scripts/ now participates in
// THE ENUMERATION and in the SQL-writer allowlist. This was not theoretical —
// during the round that added it, a reviewer's `src/lib/__lensA_probe9.ts` and
// a `__lensa_probe_writer` SQL function both turned up inside another
// reviewer's assertion diffs. So: on a red, run `git ls-files -o
// --exclude-standard src supabase/functions scripts` BEFORE concluding a door
// was added. The trade is still right — a pin that cannot see a new file
// cannot see the session that adds one.
function repoFiles(pathspec: string, ext: RegExp = /\.(ts|tsx|mjs|js)$/): string[] {
  const run = (cmd: string) => execSync(cmd, { encoding: 'utf8' }).split('\n');
  return [...new Set([
    ...run(`git ls-files ${pathspec}`),
    ...run(`git ls-files -o --exclude-standard ${pathspec}`),
  ])].map((f) => f.trim()).filter((f) => f !== '' && ext.test(f));
}

describe('batchModeFor — the single gate the page renders through', () => {
  it('guardrail never batches — RED if this ever returns anything but "never"', () => {
    expect(batchModeFor('guardrail')).toBe('never');
  });

  it('trust_rule never batches — RED if this ever returns anything but "never" (§11b: "the only proposal that removes a human")', () => {
    expect(batchModeFor('trust_rule')).toBe('never');
  });

  it('employee batches by department, not accept-all — RED if it ever returns "accept_all" (would put a hire behind a bulk-accept checkbox)', () => {
    expect(batchModeFor('employee')).toBe('department');
  });

  it('the three low-stakes kinds get accept-all — RED if any of these regresses to "never" (would make the screen unusably long for ~40 items) or "department" (they have no department)', () => {
    expect(batchModeFor('conversation_type')).toBe('accept_all');
    expect(batchModeFor('procedure')).toBe('accept_all');
    expect(batchModeFor('connector')).toBe('accept_all');
  });

  it('every one of the 6 real kinds resolves to a real mode — RED if PROPOSAL_KINDS and the two batching sets ever drift apart (a 7th kind added to one and not the other)', () => {
    const modes = PROPOSAL_KINDS.map((k) => batchModeFor(k));
    expect(modes).toHaveLength(6);
    for (const m of modes) expect(['never', 'department', 'accept_all']).toContain(m);
  });

  it('SECTION_ORDER is a permutation of PROPOSAL_KINDS — RED if a kind is dropped from the render order (silently hides a whole category from the screen)', () => {
    expect([...SECTION_ORDER].sort()).toEqual([...PROPOSAL_KINDS].sort());
  });
});

describe('guardrailLiteral — the enforceable literal, verbatim (fix round 1, Critical 1)', () => {
  it('a pattern renders as "matches: X" — RED if the pattern text is altered or dropped', () => {
    expect(guardrailLiteral({ rule: 'No refund promises', pattern: 'refund|chargeback', threshold: null }))
      .toBe('matches: refund|chargeback');
  });

  it('a threshold with no pattern renders as a BARE number, no invented currency — RED if a "$" ever appears here', () => {
    // The review's own two failing examples, both fixed by removing the
    // fabricated dollar sign rather than only one of them:
    //  - a 20%-discount cap used to render "$20"
    //  - a require_approval_over_cents value of 100000 (= $1,000, in
    //    CENTS) used to render "$100,000" — a hundredfold error
    expect(guardrailLiteral({ rule: 'Max 20% discount without VP approval', pattern: null, threshold: 20 }))
      .toBe('threshold: 20');
    expect(guardrailLiteral({ rule: 'Invoices over $10,000 need approval', pattern: null, threshold: 100000 }))
      .toBe('threshold: 100,000');
  });

  it('neither present is reported honestly, not hidden — RED if this returns an empty string a card could render blank', () => {
    expect(guardrailLiteral({ rule: 'Be careful', pattern: null, threshold: null }))
      .toBe('no literal recorded yet');
  });

  it('a PROSE pattern beside a valid threshold falls back to the threshold, never renders the prose as the literal — RED if "matches: ..." appears here', () => {
    // The exact live-reachable shape the review flagged: Task 1's
    // validatePayload accepts a guardrail whose pattern fails
    // looksLikeEnforceablePattern as long as threshold is a valid number —
    // it does not null out the invalid pattern first. A card that then
    // treats ANY truthy payload.pattern as the literal renders un-consentable
    // prose as if it were enforceable.
    const payload = { rule: 'Do not upset customers', pattern: 'anything the customer might find upsetting', threshold: 10000 };
    // Prove the premise first: Task 1's real validatePayload actually
    // accepts this payload (via the threshold), so this is not a
    // hypothetical shape — it is exactly what can reach discovery_proposals.
    expect(() => realValidatePayload('guardrail', payload)).not.toThrow();
    expect(guardrailLiteral(payload)).toBe('threshold: 10,000');
    expect(guardrailLiteral(payload)).not.toMatch(/matches:/);
  });
});

describe('guardrailKindOf — pattern vs threshold vs none, the fact whatAcceptingWrites/cardCopyFor branch on', () => {
  it('a real pattern is "pattern" — RED if a valid enforceable pattern is ever misread as "threshold" or "none"', () => {
    expect(guardrailKindOf({ pattern: 'refund|chargeback', threshold: null })).toBe('pattern');
  });
  it('a prose "pattern" with a valid threshold is "threshold", not "pattern" — RED if this ever returns "pattern" for prose', () => {
    expect(guardrailKindOf({ pattern: 'anything the customer might find upsetting', threshold: 10000 })).toBe('threshold');
  });
  it('neither is "none" — RED if this silently reports "pattern" or "threshold" for an empty payload', () => {
    expect(guardrailKindOf({ pattern: null, threshold: null })).toBe('none');
  });
});

describe('looksLikeEnforceablePattern — drift-guarded against the real Task 1 behaviour', () => {
  // Task 1's copy (supabase/functions/_shared/discoveryProposals.ts) does not
  // export looksLikeEnforceablePattern directly, so the oracle here is its
  // OWN exported validatePayload: for a fixed valid rule and threshold=null,
  // whether validatePayload throws is entirely a function of whether the
  // pattern is enforceable. If the two implementations of
  // looksLikeEnforceablePattern ever disagree, this test goes red on
  // whichever case it disagrees on — not a hypothetical, an actual behaviour
  // comparison against the real Deno-deployed module.
  const cases: Array<[string, boolean]> = [
    ['refund|chargeback', true],
    ['refund|chargeback|free month', true],
    ['anything the customer might find upsetting', false],
    ['Do not upset customers.', false],           // trailing punctuation
    ['a b c d e f g h', false],                    // over 5 tokens
    ['', false],
  ];
  it('agrees with the real validatePayload on every case — RED on the first disagreement', () => {
    for (const [pattern, expected] of cases) {
      const local = looksLikeEnforceablePattern(pattern);
      expect(local, `local looksLikeEnforceablePattern("${pattern}")`).toBe(expected);
      if (!pattern) continue; // empty pattern + null threshold throws for a DIFFERENT reason (no literal at all) — not what's under test here
      const realAccepts = (() => {
        try { realValidatePayload('guardrail', { rule: 'x', pattern, threshold: null }); return true; }
        catch { return false; }
      })();
      expect(realAccepts, `real validatePayload accepts pattern "${pattern}"`).toBe(expected);
    }
  });
});

describe('guardrailAcceptability — the ONE gate the card and the accept writer share (migration 751)', () => {
  const noOwners = new Map<string, string>();

  it('a pattern-bearing payload is acceptable and hands back the TRIMMED literal — RED if the writer would insert a different string than the card showed', () => {
    const gate = guardrailAcceptability({ rule: 'No refunds', pattern: '  refund|chargeback  ', threshold: null });
    expect(gate.ok).toBe(true);
    // ⚠ The trim is load-bearing, not cosmetic. decide_discovery_proposal
    // compares the created rule's `pattern` against
    // `nullif(btrim(payload->>'pattern'),'')` — writing the untrimmed string
    // would make the stamp fail its own verbatim check on every payload whose
    // model fill happened to include whitespace.
    expect(gate.pattern).toBe('refund|chargeback');
    expect(gate.reason).toBe('');
  });

  it('a threshold-only payload is HELD, with the number said back and no unit invented — RED if it becomes acceptable (the founder ruling of 2026-08-15)', () => {
    const gate = guardrailAcceptability({ rule: 'Over 10,000 needs my say-so', pattern: null, threshold: 10000 });
    expect(gate.ok).toBe(false);
    expect(gate.pattern).toBe('');
    expect(gate.reason).toMatch(/10,000/);
    expect(gate.reason).not.toMatch(/\$/);
    expect(gate.reason).not.toMatch(/%/);
  });

  it('a PROSE pattern sitting beside a threshold is held too — RED if prose is ever written as a blocked phrase', () => {
    // validatePayload accepts this shape (the pattern is never nulled out when
    // a valid threshold is present), and the card renders it as
    // "threshold: 10,000". Writing the prose as a blocked_phrase would block a
    // whole sentence the customer was never shown as a literal.
    const gate = guardrailAcceptability({
      rule: 'Nothing upsetting', pattern: 'anything the customer might find upsetting', threshold: 10000,
    });
    expect(gate.ok).toBe(false);
    expect(gate.pattern).toBe('');
  });

  it('a payload with neither is held with its own reason — RED if the two refusals collapse into one message', () => {
    const neither = guardrailAcceptability({ rule: 'Be careful', pattern: null, threshold: null });
    const threshold = guardrailAcceptability({ rule: 'x', pattern: null, threshold: 20 });
    expect(neither.ok).toBe(false);
    expect(neither.reason).not.toBe(threshold.reason);
  });

  it('the gate and the card cannot disagree — every kind of payload gives the same verdict to cardCopyFor as to the writer', () => {
    const payloads = [
      { rule: 'a', pattern: 'refund|chargeback', threshold: null },
      { rule: 'b', pattern: null, threshold: 20 },
      { rule: 'c', pattern: 'anything the customer might find upsetting', threshold: 10000 },
      { rule: 'd', pattern: null, threshold: null },
    ];
    for (const p of payloads) {
      const gate = guardrailAcceptability(p);
      const detail = cardCopyFor('guardrail', p, noOwners).detail;
      // The card's consequence sentence is built FROM the gate, so an ok gate
      // must produce the blocking sentence and a held gate must produce its
      // own reason verbatim. RED the moment somebody re-hardcodes either.
      if (gate.ok) expect(detail).toMatch(/blocked before it reaches a customer/);
      else expect(detail).toContain(gate.reason);
    }
  });
});

describe('THE THIRD COPY — the SQL pattern predicate in migration 751 must not drift from the TypeScript one', () => {
  // ⚠ WHY A THIRD COPY EXISTS AT ALL, and why it needs a guard of its own.
  // decide_discovery_proposal is the only thing that can write a refusal onto
  // discovery_proposals.last_error, so it has to be able to tell a
  // pattern-bearing payload from a threshold-only one ITSELF — including the
  // prose-pattern-beside-a-threshold case, which `pattern is not null` gets
  // wrong. That means looksLikeEnforceablePattern exists three times: here, in
  // supabase/functions/_shared/discoveryProposals.ts (guarded by the block
  // above), and now in SQL.
  //
  // This block compares the SQL literal against the TypeScript one WORD FOR
  // WORD and BOUND FOR BOUND. It is a source-text comparison, not a behavioural
  // one — vitest cannot reach Postgres — and it is honest about that: what it
  // proves is that the two lists say the same thing, not that Postgres's `\y`
  // and JavaScript's `\b` agree on every input. Migration 751's probe 15 drives
  // the SQL copy against a prose pattern in production.
  const MIGRATION = 'supabase/migrations/751_a_hard_line_the_customer_wrote.sql';
  // ⚠ THE BRANCH, COMMENT-STRIPPED — not the whole file. These are assertions
  // about CODE, and this migration's header quotes its own predicate at length;
  // a `toContain` against the raw file is satisfiable by a paragraph. Same
  // extractor the live differential uses, so "where the branch ends" has one
  // answer in this repository rather than two.
  const sql = guardrailBranch(readFileSync(MIGRATION, 'utf8')) ?? '';
  const ts = readFileSync('src/lib/discoveryProposalPresentation.ts', 'utf8');

  it('the branch was isolated before anything below compared against it — RED if the extractor stops finding it, which would make every toContain here vacuous', () => {
    expect(sql.length, 'the guardrail branch could not be isolated from the migration').toBeGreaterThan(4000);
    expect(sql, 'comment stripping took the code with it').toContain('v_pattern_ok');
    expect(sql, 'the header prose survived the strip, so these are not code assertions').not.toContain('THE THIRD COPY');
  });

  const sqlWords = (/!~\*\s*'\\y\(([^)]+)\)\\y'/.exec(sql) ?? [])[1];
  const tsWords = (/const PATTERN_PROSE_WORDS = \/\\b\(([^)]+)\)\\b\/i;/.exec(ts) ?? [])[1];

  it('both prose-word lists were actually FOUND — RED if either regex stopped matching, because two nulls compare equal and would pass silently', () => {
    expect(sqlWords, `prose-word alternation in ${MIGRATION}`).toBeTruthy();
    expect(tsWords, 'PATTERN_PROSE_WORDS in discoveryProposalPresentation.ts').toBeTruthy();
    expect(String(sqlWords).split('|').length).toBeGreaterThan(5);
  });

  it('the SQL prose-word list is identical to the TypeScript one, in the same order — RED on a word added to one and not the other', () => {
    expect(sqlWords).toBe(tsWords);
  });

  it('the SQL length and word-count bounds match the TypeScript ones — RED if 120 or 5 moves in one copy only, AND red on a prefixed length function', () => {
    // ⚠⚠ `toContain('length(v_pattern) <= 120')` IS SATISFIED BY
    // `octet_length(v_pattern) <= 120`, AND SO WAS THE OLD ORACLE'S
    // `/length\(v_pattern\) <= (\d+)/`. Measured: swapping octet_length in left
    // the whole file 116/116 GREEN. It is not a cosmetic difference —
    // octet_length counts BYTES, JS `.length` counts UTF-16 units and Postgres
    // `length()` counts CODE POINTS, so 'é'.repeat(100) is 100 to the client and
    // 200 to the drifted SQL: the client accepts, the database refuses, a live
    // workspace-wide blocking rule is created and can never be stamped. That is
    // exactly what the one invariant forbids, passing a green pin.
    //
    // The lookbehind is the fix here. THE LIVE DIFFERENTIAL GOES RED ON THE SAME
    // MUTANT BY A DIFFERENT MECHANISM, AND THE DIFFERENCE IS WORTH STATING:
    // measured 2026-08-17 by running extractPredicate over an in-memory copy of
    // the migration with `length(` swapped for `octet_length(`, `maxLen` comes
    // back null, runDifferential's own guard throws "predicate parameters not
    // readable from the migration: maxLen — a half-built comparison accepts
    // everything", and the script exits non-zero WITHOUT EVER QUERYING POSTGRES.
    // Fail-closed, and stronger than a comparison, but it is a refusal to
    // compare — not a comparison that found drift. (Its verdict() arm
    // `maxLen !== 120` therefore only ever fires on a bound that is READABLE and
    // different, e.g. 200; the null case never reaches it.)
    expect(sql, 'the length bound is not a BARE length() call').toMatch(/(?<![A-Za-z0-9_])length\(v_pattern\) <= 120/);
    expect(sql, 'octet_length counts bytes, which neither other copy does').not.toContain('octet_length');
    expect(ts).toContain('t.length > 120');
    expect(sql).toMatch(/(?<![A-Za-z0-9_])array_length\(regexp_split_to_array\(v_pattern, '\\s\+'\), 1\), 0\) <= 5/);
    expect(ts).toContain('.filter(Boolean).length > 5');
    expect(sql).toContain("v_pattern !~ '[.!?]$'");
    expect(ts).toContain('/[.!?]$/.test(t)');
  });

  // ── THE TRIM IN FRONT OF THE PREDICATE ────────────────────────────────────
  // This block compared the four predicate clauses and never the trim that
  // feeds them, and the trim was wrong: one-argument `btrim` strips SPACES
  // ONLY (measured in Postgres — length(btrim(E'\treturn|refund')) = 14 against
  // length('return|refund') = 13), while the client's `str()` uses JS `.trim()`,
  // which strips all whitespace. On a payload the model filled as
  // "refund|chargeback\n" the browser CREATED the rule with the trimmed literal
  // and the RPC then refused the stamp against the untrimmed one, raising
  // 'the rule that was created blocks X, but this recommendation showed X'
  // about two identical-looking strings — proposal back to pending, attempts
  // incremented, and A LIVE WORKSPACE-WIDE BLOCKING RULE left behind that every
  // retry re-finds and re-refuses.
  it('the SQL trims the pattern with an EXPLICIT whitespace set, not one-argument btrim — RED the moment `btrim(v_p.payload ->> \'pattern\')` comes back', () => {
    expect(sql).not.toContain("btrim(v_p.payload ->> 'pattern')");
    expect(sql).toContain("btrim(v_p.payload ->> 'pattern', E'");
    expect(sql).toContain("btrim(coalesce(v_p.payload ->> 'threshold', ''), E'");
  });

  it('the SQL whitespace set covers every character JS .trim() strips — RED on a character present in one copy and not the other', () => {
    const set = /btrim\(v_p\.payload ->> 'pattern', E'([^']+)'\)/.exec(sql)?.[1];
    expect(set, 'the explicit whitespace set on the pattern trim').toBeTruthy();
    // Vacuity: a set that stopped containing the ASCII escapes would make every
    // assertion below trivially true if they were written as `.not`.
    expect(String(set).length).toBeGreaterThan(20);
    // Each entry, as the SQL E'' escape it is written as, paired with the real
    // character so the JS side is a BEHAVIOUR check and not a second spelling.
    const cases: Array<[string, string]> = [
      ['\\t', '\t'], ['\\n', '\n'], ['\\r', '\r'], ['\\f', '\f'], ['\\v', '\v'],
      ['\\u00a0', '\u00a0'], ['\\u2003', '\u2003'], ['\\u2028', '\u2028'],
      ['\\u2029', '\u2029'], ['\\u202f', '\u202f'], ['\\u3000', '\u3000'],
      ['\\ufeff', '\ufeff'],
    ];
    for (const [escape, ch] of cases) {
      expect(String(set), `SQL trim set carries ${escape}`).toContain(escape);
      expect(`x${ch}`.trim(), `JS .trim() strips ${escape}`).toBe('x');
    }
    expect(String(set).startsWith(' '), 'the SQL trim set starts with a plain space').toBe(true);
  });

  it('a whitespace-padded payload yields the SAME literal the SQL will compare against — RED if the two trims ever disagree on what the customer consented to', () => {
    for (const pad of ['\t', '\n', '\r', '\f', '\v', '\u00a0', '\u2003', '\u3000', '\ufeff', ' ']) {
      const gate = guardrailAcceptability({
        rule: 'Never promise a refund', pattern: `${pad}refund|chargeback${pad}`, threshold: null,
      });
      expect(gate.ok, `padded with ${JSON.stringify(pad)}`).toBe(true);
      expect(gate.pattern, `padded with ${JSON.stringify(pad)}`).toBe('refund|chargeback');
    }
  });

  // ── THE METACHARACTER SCREEN ──────────────────────────────────────────────
  it('the SQL metacharacter class and the TypeScript one name the same characters — RED on a character screened in one copy and not the other', () => {
    const sqlClass = /v_pattern ~ '\[([^']+)\]' then/.exec(sql)?.[1];
    expect(sqlClass, 'the metacharacter class in the migration').toBeTruthy();
    for (const ch of ['\\', '^', '$', '.', '?', '*', '+', '(', ')', '{', '}', '[', ']']) {
      // present in the SQL class (backslash-escaped there for `[` and `]`)
      expect(String(sqlClass), `SQL metacharacter class carries ${ch}`).toContain(ch);
      // and REFUSED by the TypeScript gate, behaviourally, with the character in
      // the MIDDLE so `?` is not caught by the trailing-punctuation clause first
      const gate = guardrailAcceptability({ rule: 'x', pattern: `refund${ch}x`, threshold: null });
      expect(gate.ok, `guardrailAcceptability("refund${ch}x")`).toBe(false);
      expect(gate.reason, `reason for "refund${ch}x"`).toMatch(/search expression/);
    }
  });

  it('the SQL empty-alternative screen and the TypeScript one are the same expression — RED if one copy stops catching a bare pipe', () => {
    expect(sql).toContain("v_pattern ~ '(^\\||\\|\\||\\|$)'");
    expect(ts).toContain('const PATTERN_EMPTY_ALTERNATIVE = /(^\\||\\|\\||\\|$)/;');
    for (const p of ['refund|', '|refund', 'refund||chargeback']) {
      const gate = guardrailAcceptability({ rule: 'x', pattern: p, threshold: null });
      expect(gate.ok, `guardrailAcceptability(${JSON.stringify(p)})`).toBe(false);
      expect(gate.reason).toMatch(/nothing beside it/);
    }
  });

  it('a plain alternation is still acceptable — RED if the two screens above became a refuse-everything gate', () => {
    for (const p of ['refund|chargeback', 'free month', 'late fee|penalty', 'price match|beat any quote']) {
      expect(guardrailAcceptability({ rule: 'x', pattern: p, threshold: null }).ok, p).toBe(true);
    }
  });
});

// ── I1: the four literals the review measured, end to end ───────────────────
// Each of these passes looksLikeEnforceablePattern — that is the point. The
// card would have said "matches: $500 off" and "Anything matching this is
// blocked before it reaches a customer" about a rule that blocks nothing.
describe('the consented literal is compiled as a regex, and the gate now says so', () => {
  const matchPattern = (pattern: string, text: string): string | null => {
    const p = String(pattern ?? '').trim();
    if (!p) return null;
    try { const m = text.match(new RegExp(p, 'i')); return m ? m[0] : null; } catch {
      const hay = text.toLowerCase();
      for (const frag of p.split('|').map((f) => f.trim().toLowerCase()).filter(Boolean)) {
        if (hay.includes(frag)) return frag;
      }
      return null;
    }
  };

  // A local transcription of guardrailMatch.ts's matchPattern (that module is
  // Deno-shaped and imports nothing, but keeping the oracle local means this
  // block states the behaviour it is asserting rather than inheriting it).
  it('the transcribed matcher reproduces the four measured failures — RED if this oracle stops matching guardrailMatch.ts', () => {
    expect(matchPattern('$500 off', 'we can do $500 off for you')).toBeNull();
    expect(matchPattern('(free) month', 'have a (free) month')).toBeNull();
    expect(matchPattern('3.5% fee', 'our 3x5% fee applies')).toBe('3x5% fee');
    expect(matchPattern('refund|', 'we will ship it tomorrow')).toBe('');
    expect(matchPattern('refund|chargeback', 'a refund now')).toBe('refund');
  });

  it('every literal that would mis-match is refused by the gate, and the one that matches as written is not — RED if a card can promise a block that blocks nothing', () => {
    const misleading = ['$500 off', '(free) month', '3.5% fee', 'refund|'];
    for (const p of misleading) {
      // still reads as a literal rather than prose — this is why nothing before
      // the screen caught it
      expect(looksLikeEnforceablePattern(p), `looksLikeEnforceablePattern(${p})`).toBe(true);
      expect(guardrailAcceptability({ rule: 'x', pattern: p, threshold: null }).ok, p).toBe(false);
    }
    expect(guardrailAcceptability({ rule: 'x', pattern: 'refund|chargeback', threshold: null }).ok).toBe(true);
  });

  it('the card and the drawer both say the refusal — RED if either keeps promising the block', () => {
    const payload = { rule: 'Never offer money off', pattern: '$500 off', threshold: null };
    const copy = cardCopyFor('guardrail', payload, new Map<string, string>());
    expect(copy.detail).not.toMatch(/blocked before it reaches a customer/);
    expect(copy.detail).toMatch(/search expression/);
    // ⚠ CHANGED 2026-08-17 (round 3, F2). This assertion USED TO PIN THE
    // CONTRADICTION: `toBe('matches: $500 off')`, on a card whose very next
    // line reads 'This one cannot be switched on as written: "$500 off"
    // contains $ …'. guardrailLiteral keyed on guardrailKindOf, which never
    // consults the two screens, so the promise survived its own withdrawal —
    // the same defect shape whatAcceptingWrites had already been fixed for
    // once ("Creates a guardrail that requires your approval…" → "Creates
    // nothing"). §11b requires the literal to be SHOWN; it does not require
    // the word "matches", and nothing has promised to match this one.
    //
    // RED if "matches:" comes back for a screened-out literal, or if the
    // literal itself falls off the card (which would make "we could not act on
    // this" uncheckable against the thing we could not act on).
    expect(copy.meta).toBe('phrase as written: $500 off');
    expect(copy.meta).not.toMatch(/matches/);
    expect(copy.meta).toContain('$500 off');
    expect(copy.nudge).toBeUndefined();
    expect(whatAcceptingWrites('guardrail', payload)).toMatch(/^Creates nothing\./);
  });

  it('every screened-out literal drops the promise and keeps the words — RED if one refusal shape still says "matches"', () => {
    // All four measured mis-matchers plus the two other empty-alternative
    // shapes. The ACCEPTED case is asserted alongside them so this cannot
    // become "meta never says matches", which would be the opposite defect.
    for (const p of ['$500 off', '(free) month', '3.5% fee', 'refund|', '|refund', 'refund||chargeback']) {
      const meta = guardrailLiteral({ rule: 'x', pattern: p, threshold: null });
      expect(meta, `meta for ${JSON.stringify(p)}`).toBe(`phrase as written: ${p}`);
      expect(meta).not.toMatch(/matches/);
      expect(meta).toContain(p);
    }
    expect(guardrailLiteral({ rule: 'x', pattern: 'refund|chargeback', threshold: null }))
      .toBe('matches: refund|chargeback');
  });
});

describe('formatBareNumber — no invented unit, ever', () => {
  it('groups digits for legibility but never adds a currency or percent sign — RED if "$" or "%" ever appears', () => {
    expect(formatBareNumber(100000)).toBe('100,000');
    expect(formatBareNumber(20)).toBe('20');
    expect(formatBareNumber('10000')).toBe('10,000');
  });
  it('a non-numeric value is reported honestly rather than crashing or printing "NaN" — RED on either failure mode', () => {
    expect(formatBareNumber('whatever seems reasonable')).toBe('whatever seems reasonable');
  });
});

describe('formatCap — dollar vs confidence, keyed on the real action_category split', () => {
  it('answer_dock / answer_widget read as confidence — RED if a dollar sign appears instead', () => {
    expect(formatCap('answer_dock', 90)).toBe('90% confidence');
    expect(formatCap('answer_widget', '75')).toBe('75% confidence');
  });

  it('every other action_category reads as a dollar amount — RED if this shows a bare number with no currency, unpredictable to a reader', () => {
    expect(formatCap('erp_financials', 10000)).toBe('$10,000');
    expect(formatCap('action:erp_financials', '$10,000')).toBe('$10,000');
  });

  it('a non-numeric cap is reported, not silently coerced to $0 or NaN — RED if this crashes or prints "$NaN"', () => {
    expect(formatCap('erp_financials', 'whatever seems reasonable')).toBe('whatever seems reasonable');
  });
});

describe('humanizeToken / humanizeSystem — display only, never compared against', () => {
  it('strips the action_category namespace prefix — RED if "action:erp_financials" renders with the prefix still attached', () => {
    expect(humanizeToken('action:erp_financials')).toBe('Erp Financials');
    expect(humanizeToken('writeback:crm')).toBe('Crm');
    expect(humanizeToken('answer_dock')).toBe('Answer Dock');
  });

  it('a known connector category gets its short label — RED if this falls back to the raw key for a category CATEGORY_SHORT actually knows', () => {
    expect(humanizeSystem('erp_financials')).toBe('ERP / Financials');
  });

  it('an unknown category degrades to a humanized token rather than throwing — RED if this throws or returns the raw underscored string', () => {
    expect(humanizeSystem('mcp_stripe_refunds')).toBe('Mcp Stripe Refunds');
  });
});

describe('humanizeConnectorTouch — fix round 1, Important ("connector literals leak snake_case")', () => {
  it('the exact live shape Task 1 emits — "<category> records" — is humanized, RED if "erp_financials" leaks through raw', () => {
    expect(humanizeConnectorTouch('erp_financials records')).toBe('ERP / Financials records');
    expect(humanizeConnectorTouch('helpdesk records')).toBe('Helpdesk records');
  });
  it('an unknown underscored shape still degrades to Title Case rather than leaking snake_case — RED if an underscore ever survives', () => {
    expect(humanizeConnectorTouch('mcp_stripe_refunds')).not.toMatch(/_/);
  });
  it('a plain English word (spec §11b\'s own illustrative "deals"/"notes") passes through unchanged — RED if this breaks that shape when it does occur', () => {
    expect(humanizeConnectorTouch('deals')).toBe('deals');
    expect(humanizeConnectorTouch('notes')).toBe('notes');
  });
});

describe('cardCopyFor — every kind carries its literal on the card, not just in the Drawer', () => {
  const noOwners = new Map<string, string>();

  it('conversation_type: label is on the title, owner (or its absence) is on the meta — RED if the owner_ref is silently dropped', () => {
    const withOwner = cardCopyFor('conversation_type', { label: 'Billing question', owner_ref: 'archetype:billing_ar' },
      new Map([['billing_ar', 'Morgan']]));
    expect(withOwner.title).toContain('Billing question');
    expect(withOwner.meta).toBe('Routes to: Morgan');

    const noOwner = cardCopyFor('conversation_type', { label: 'Billing question', owner_ref: 'unassigned' }, noOwners);
    expect(noOwner.meta).toMatch(/no owner/i);
  });

  it('connector: provider + what it reads/writes + the credential note — RED if reads/writes are missing from meta', () => {
    const copy = cardCopyFor('connector', {
      provider_key: 'hubspot', label: 'HubSpot', reads: ['deals'], writes: ['notes'],
    }, noOwners);
    expect(copy.title).toBe('Connect HubSpot');
    expect(copy.meta).toBe('HubSpot · reads deals, writes notes');
    expect(copy.detail).toMatch(/credential/i);
  });

  it('connector: the REAL Task 1 payload shape is humanized, not left as snake_case — RED if "erp_financials" appears verbatim in meta (fix round 1, Important)', () => {
    // supabase/functions/_shared/discoveryProposals.ts's proposalsFrom emits
    // reads exactly as [`${row.category} records`] — this is that shape, not
    // the spec's hypothetical "deals"/"notes" illustration.
    const copy = cardCopyFor('connector', {
      provider_key: 'erpnext', label: 'ERPNext', reads: ['erp_financials records'], writes: [],
    }, noOwners);
    expect(copy.meta).toBe('ERPNext · reads ERP / Financials records');
    expect(copy.meta).not.toMatch(/erp_financials/);
  });

  // ⚠ M1 of the 2026-08-15 review. This test used to feed CATEGORY KEYS
  // ("erp_financials") and assert they were humanized — but since BLOCKER 2,
  // Task 1 does not emit category keys here at all. It emits finished display
  // strings built from role_archetypes.system_templates: a label plus the
  // read/write reach in parentheses. Running humanizeSystem over those
  // title-cased every word, so the live shape rendered as "Invoices (AR)
  // (Read/Write)". The fixture below is the REAL payload shape, copied from
  // proposalsFrom's own output, and the assertion is that it is left alone.
  // Red if title-casing ever comes back.
  it('employee: systems are the REAL system_templates strings, rendered verbatim — RED if "(read/write)" is title-cased', () => {
    const copy = cardCopyFor('employee', {
      name: 'Billing & AR Specialist',
      systems: ['Invoices (AR) (read/write)', 'CRM / booking system (read only)'],
    }, noOwners);
    expect(copy.meta).toBe('Systems: Invoices (AR) (read/write), CRM / booking system (read only)');
    expect(copy.meta).not.toMatch(/\(Read\/Write\)/);
    expect(copy.meta).not.toMatch(/\(Read Only\)/);
    expect(copy.detail).toMatch(/supervised/i);
    expect(copy.detail).toMatch(/SOP/i);
  });

  // ⚠ R4 — §11b, "put the fact on the card". evidence_quote is the
  // customer's own sentence, checked VERBATIM against the transcript by
  // supabase/functions/_shared/discoveryProposals.ts, and it is the entire
  // reason this role is being offered rather than one of the other fourteen.
  // The mechanical gate can prove the model did not invent those words; it
  // cannot prove the role fits, and its own header says so. The person
  // reading their own sentence next to the job title is the only thing that
  // can — so hiding it in the Details drawer would leave the judgement to the
  // half of the system that is admittedly incapable of making it.
  // RED if either the quote or the fit_reason falls off the card.
  it('employee: the customer\'s own quoted words are ON THE CARD, next to the fit reason', () => {
    const copy = cardCopyFor('employee', {
      name: 'Google Ads Specialist',
      systems: ['Ads platform (read only)'],
      evidence_quote: 'we do run Google Ads',
      fit_reason: 'They already run Google Ads themselves and nobody is watching the spend.',
    }, noOwners);
    expect(copy.meta).toContain('we do run Google Ads');
    expect(copy.meta).toContain('Systems: Ads platform (read only)');
    expect(copy.detail).toContain('They already run Google Ads themselves');
    // the consequence sentence survives alongside it — the quote must not
    // push "starts supervised, sends nothing" off the card
    expect(copy.detail).toMatch(/supervised/i);
    expect(copy.detail).toMatch(/sends nothing/i);
  });

  // The degraded shape still renders honestly — RED if a payload with no
  // quote (an older row, or a hand-built one) renders an empty quotation.
  it('employee: a card with no quote falls back to the generic sentence, never an empty quotation', () => {
    const copy = cardCopyFor('employee', { name: 'Billing & AR Specialist', systems: ['Invoices (AR) (read/write)'] }, noOwners);
    expect(copy.meta).toBe('Systems: Invoices (AR) (read/write)');
    expect(copy.meta).not.toContain('“');
    expect(copy.detail).toMatch(/^Comes with a published SOP/);
  });

  it('guardrail: the rule sentence is the title, verbatim — RED if it gets paraphrased or truncated', () => {
    const copy = cardCopyFor('guardrail', { rule: 'Never promise a refund over the phone', pattern: 'refund|chargeback' }, noOwners);
    expect(copy.title).toBe('Never promise a refund over the phone');
    expect(copy.meta).toBe('matches: refund|chargeback');
  });

  it('guardrail with a PATTERN claims blocking — RED if the "blocked" sentence disappears for the one case where it is actually true', () => {
    const copy = cardCopyFor('guardrail', { rule: 'Never promise a refund over the phone', pattern: 'refund|chargeback' }, noOwners);
    expect(copy.detail).toMatch(/blocked/i);
  });

  it('guardrail with only a THRESHOLD says it cannot be switched on, and never promises a gate — RED if "blocked" OR "approval" appears here (migration 751)', () => {
    // ⚠ THIS ASSERTION WAS INVERTED ON 2026-08-17, and the reason is the point.
    // It used to demand `/approval/i`, pinning the sentence "Above this, it
    // needs your approval before it goes ahead". Migration 751 makes that
    // sentence false in the worst available direction: the founder's ruling
    // (patterns now, thresholds held) means decide_discovery_proposal REFUSES a
    // threshold-only guardrail, so the card was promising a gate the button
    // behind it declines to build. Two measured reasons — the payload's number
    // carries no unit while require_approval_over_cents reads CENTS and
    // max_discount_pct reads PERCENT, and max_discount_pct has no enforcement
    // path at all (its only readers interpolate it into a prompt).
    //
    // RED if: "blocked" appears (findBlockingMatch is pattern-only, so nothing
    // about a bare number blocks outbound text — the original point, still
    // true); or "approval" appears (that is the promise 751 withdrew); or the
    // sentence stops saying that nothing will be created.
    const copy = cardCopyFor('guardrail', { rule: 'Max 20% discount without VP approval', pattern: null, threshold: 20 }, noOwners);
    expect(copy.detail).not.toMatch(/blocked/i);
    expect(copy.detail).not.toMatch(/approval/i);
    expect(copy.detail).toMatch(/no unit/i);
    expect(copy.detail).toMatch(/change nothing/i);
    // …and the literal is STILL on the card, verbatim and unitless. §11b does
    // not stop applying because we are refusing: "we could not act on this" is
    // only checkable against the thing we could not act on.
    expect(copy.meta).toBe('threshold: 20');
  });

  it('a refused guardrail carries NO "you can edit this later" nudge — RED if the card offers to let you change a rule that will not exist', () => {
    const refused = cardCopyFor('guardrail', { rule: 'Max 20% discount', pattern: null, threshold: 20 }, noOwners);
    expect(refused.nudge).toBeUndefined();
    const accepted = cardCopyFor('guardrail', { rule: 'No refunds', pattern: 'refund|chargeback' }, noOwners);
    expect(accepted.nudge).toMatch(/remove this rule/i);
  });

  it('trust_rule: employee + category + cap, all three, on the meta line — RED if any one of the three is missing', () => {
    const copy = cardCopyFor('trust_rule', { de_ref: 'archetype:billing_ar', action_category: 'erp_financials', cap: 10000 },
      new Map([['billing_ar', 'Morgan']]));
    // §11b's requirement is that all three literals are ON THE CARD. Migration
    // 753 changed the wording (the old meta read "· up to $10,000", which
    // implied a limit that was being enforced) but not the requirement, so the
    // three parts are asserted as parts rather than as one frozen sentence.
    expect(copy.meta).toContain('Morgan');
    expect(copy.meta).toContain('Erp Financials');
    expect(copy.meta).toContain('$10,000');
    expect(copy.title).toContain('Morgan');
    expect(copy.title).toContain('$10,000');
  });

  // ⚠ ADDED BY MIGRATION 753, and it is the pin that matters most on this kind.
  // The old copy said "Let Morgan act on its own up to $10,000" and "Above this,
  // it stops and asks you first" — measured live, 90 trust_policies rows, 0
  // above level 0, 0 with a ladder, and trust_ladder_settings returns
  // {enabled:false} for any level <= 0 before it reads a ladder at all. Nothing
  // the accept writes lets anybody act on their own and nothing stops anything.
  // These four assertions are what stops that wording coming back.
  it('trust_rule: the card MUST NOT claim enforcement, and MUST say nothing changes today — RED if the old "act on its own" copy returns', () => {
    const copy = cardCopyFor('trust_rule', { de_ref: 'archetype:billing_ar', action_category: 'erp_financials', cap: 10000 },
      new Map([['billing_ar', 'Morgan']]));
    const all = `${copy.title} ${copy.detail} ${copy.meta} ${copy.nudge ?? ''}`;
    expect(all).not.toMatch(/act on its own/i);
    expect(all).not.toMatch(/without asking/i);
    expect(all).not.toMatch(/stops and asks you first/i);
    expect(all).toMatch(/nothing changes today/i);
    expect(whatAcceptingWrites('trust_rule', { de_ref: 'archetype:billing_ar', action_category: 'erp_financials', cap: 10000 }))
      .toMatch(/level 0/i);
    expect(whatAcceptingWrites('trust_rule', { de_ref: 'archetype:billing_ar', action_category: 'erp_financials', cap: 10000 }))
      .not.toMatch(/raises/i);
  });

  // ⚠⚠ THE SECOND FALSE CLAIM ON THIS CARD, AND IT WAS THE REPLACEMENT COPY.
  // 753's first rewrite removed the enforcement overclaim and replaced it with
  // a SUPERVISION claim: "Morgan still brings everything to you", "everything
  // still comes to you for approval", "everything it does still comes to you
  // for approval". None of those is something this accept controls.
  //
  // Measured live 2026-08-17, from pg_proc: `de_autonomy` — the table every
  // enforcement path reads through resolve_de_autonomy — has SEVEN writers
  // (deprovision_starter_de_internal, instantiate_role_archetype_internal,
  // provision_starter_de_internal, provision_workforce_assistant_internal,
  // retire_digital_employee, set_de_autonomy, trust_apply_level) and only the
  // LAST is downstream of a trust level. `renewal_manager`'s autonomy_templates
  // is [{action_type:'action_execute', source_category:'crm', enabled:true}], so
  // instantiate_role_archetype_internal writes an ENABLED dial at HIRE, before
  // any trust card renders. Corroborated on live rows: the Renewal DE
  // (40d688eb…, tenant 5bb802e1…) sits at trust level 0 across its policies with
  // digital_employees.trust_level = 'supervised', and
  // resolve_de_autonomy(tenant,'action_execute',de,'crm').enabled is TRUE.
  //
  // So this is the pin. The card, the drawer and the page flash may say what
  // the ACCEPT does; none of them may tell the owner that everything this
  // employee does comes to them. RED if any of the three says it again.
  it('trust_rule: NOTHING may claim the employee is fully supervised — RED if "everything comes to you" returns to the card, the drawer or the flash', () => {
    const copy = cardCopyFor('trust_rule', { de_ref: 'archetype:billing_ar', action_category: 'erp_financials', cap: 10000 },
      new Map([['billing_ar', 'Morgan']]));
    const drawer = whatAcceptingWrites('trust_rule', { de_ref: 'archetype:billing_ar', action_category: 'erp_financials', cap: 10000 });
    const flash = readFileSync('src/pages/tenant/DiscoveryProposalsPage.tsx', 'utf8');

    // The three literal shapes that shipped, plus the general form. A comment
    // explaining the ban would trip the file-level check, so the flash source is
    // stripped of comments before it is searched — the same treatment migration
    // 753's own fixtures block gives decide_discovery_proposal's body, and for
    // the same reason: unstripped, the paragraph forbidding a sentence counts
    // as the sentence.
    const flashCode = flash.replace(/^\s*\/\/.*$/gm, '');
    const SUPERVISION = [
      /brings everything to you/i,
      /everything (it does )?still comes to you/i,
      /everything\b[^.!?]{0,40}\bcomes to you/i,
    ];
    for (const re of SUPERVISION) {
      expect(`${copy.title} ${copy.detail} ${copy.meta} ${copy.nudge ?? ''}`).not.toMatch(re);
      expect(drawer).not.toMatch(re);
      expect(flashCode).not.toMatch(re);
    }

    // ⚠ AND THE VACUITY GUARD. Three `not.toMatch` against a string that never
    // arrived would pass for the wrong reason, so the subjects are proven to be
    // the real ones first.
    expect(copy.detail.length).toBeGreaterThan(40);
    expect(drawer).toMatch(/level 0/i);
    expect(flashCode).toMatch(/written down\. Nothing changes today/);
  });

  // ── FIX ROUND 3: three residues the round-2 reviewers found ──────────────
  //
  // Each one is a sentence that was true of the code in one place and not in
  // another. This workstream has shipped six of those; these are the pins that
  // stop these three coming back.
  it('trust_rule: a confidence cap over 100 is REFUSED ON THE CARD, not promised then refused by the server — RED if the card says it records a limit the accept will reject', () => {
    // 753's branch raises on `v_tr_unit = 'confidence' and v_tr_cap_n > 100`.
    // Before this, the card rendered "Note Sam's limit for this: 500%
    // confidence" beside "this records the limit you stated" — and the accept
    // then refused. guardrailAcceptability already solves exactly this shape
    // for the guardrail kind; this is the same standard applied here.
    const bad = cardCopyFor('trust_rule', { de_ref: 'archetype:support_lead', action_category: 'answer_dock', cap: 500 },
      new Map([['support_lead', 'Sam']]));
    expect(bad.detail).toMatch(/cannot be recorded as written/i);
    expect(bad.detail).toMatch(/0 to 100/);
    expect(bad.detail).not.toMatch(/records the limit you stated/i);
    expect(bad.meta).toMatch(/cannot be recorded/i);

    // THE BOUND, both sides of it — 100 is admissible, 101 is not. Without
    // these two the arm above passes for a screen that refuses everything.
    const at100 = cardCopyFor('trust_rule', { de_ref: 'archetype:support_lead', action_category: 'answer_dock', cap: 100 },
      new Map([['support_lead', 'Sam']]));
    expect(at100.detail).toMatch(/records the limit you stated/i);
    expect(at100.detail).not.toMatch(/cannot be recorded/i);

    // AND THE UNIT SPLIT. A money category is dollar-gated, so 500 there is an
    // ordinary cap — RED if the screen ever widens to every category, which
    // would refuse a legitimate $500 approval limit.
    const money = cardCopyFor('trust_rule', { de_ref: 'archetype:billing_ar', action_category: 'erp_financials', cap: 500 },
      new Map([['billing_ar', 'Morgan']]));
    expect(money.detail).toMatch(/records the limit you stated/i);
    expect(money.detail).not.toMatch(/cannot be recorded/i);
  });

  it('trust_rule: the daily promotion check is disclosed ON THE CARD FACE — RED if it is only in the drawer, which is optional reading for a one-click decision', () => {
    // `needsAcceptConfirmation` is employee-only, so Accept on a trust_rule
    // card calls runDecision directly. The drawer was the only string saying
    // this workspace can raise a promotion on its own — the same defect this
    // file already names and fixed once for the employee kind. §11b exempts
    // trust_rule from the short-card budget, so there is room on the card.
    const copy = cardCopyFor('trust_rule', { de_ref: 'archetype:billing_ar', action_category: 'erp_financials', cap: 10000 },
      new Map([['billing_ar', 'Morgan']]));
    expect(copy.detail).toMatch(/daily check/i);
    expect(copy.detail).toMatch(/promotion/i);
    // …and it must stay a thing the owner APPROVES, never something that
    // happens by itself. RED if the card ever implies the promotion lands.
    expect(copy.detail).toMatch(/in front of you/i);
    expect(copy.detail).not.toMatch(/automatically (promot|rais|appl)/i);
  });

  it('trust_rule: the card does NOT say the number is written into the trust setting — RED if "recorded against" returns (the accept writes no limit there, and Trust settings does not show it)', () => {
    const copy = cardCopyFor('trust_rule', { de_ref: 'archetype:billing_ar', action_category: 'erp_financials', cap: 10000 },
      new Map([['billing_ar', 'Morgan']]));
    const drawer = whatAcceptingWrites('trust_rule', { de_ref: 'archetype:billing_ar', action_category: 'erp_financials', cap: 10000 });
    // The drawer is the authority and says it outright; the card must not
    // contradict it. RED if the two ever disagree about where the number lives.
    expect(drawer).toMatch(/writes NO limit into that setting/i);
    expect(copy.detail).not.toMatch(/recorded against/i);
    expect(copy.detail).toMatch(/alongside this recommendation/i);
  });

  it('trust_rule: above_cap, when the model supplied one, is on the CARD (not just the drawer) — RED if it never appears (fix round 1, minor)', () => {
    const copy = cardCopyFor('trust_rule', {
      de_ref: 'archetype:billing_ar', action_category: 'erp_financials', cap: 10000,
      above_cap: 'Above $10,000 it goes to Finance for sign-off.',
    }, new Map([['billing_ar', 'Morgan']]));
    // §11b still requires "what happens above it" on the card. 753 keeps it
    // there and ATTRIBUTES it — it is the customer's own expectation, not a
    // description of what the workspace does today — so the assertion is
    // containment rather than equality, and the attribution is pinned too.
    expect(copy.detail).toContain('Above $10,000 it goes to Finance for sign-off.');
    expect(copy.detail).toMatch(/You said/i);
  });

  it('trust_rule: with no above_cap supplied, a generic honest fallback is used — RED if this renders empty', () => {
    const copy = cardCopyFor('trust_rule', { de_ref: 'archetype:billing_ar', action_category: 'erp_financials', cap: 10000 },
      new Map([['billing_ar', 'Morgan']]));
    expect(copy.detail.length).toBeGreaterThan(5);
  });
});

describe('whatAcceptingWrites — every kind states what its acceptance creates', () => {
  const EMPTY: Record<string, unknown> = {};

  it('all 6 kinds return a non-empty, distinct sentence — RED if two kinds accidentally share one generic sentence', () => {
    const sentences = PROPOSAL_KINDS.map((k) => whatAcceptingWrites(k, EMPTY));
    for (const s of sentences) expect(s.length).toBeGreaterThan(10);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it('guardrail branches on pattern vs threshold, same as the card — and the threshold branch says it creates NOTHING (migration 751)', () => {
    const patternSentence = whatAcceptingWrites('guardrail', { pattern: 'refund|chargeback', threshold: null });
    const thresholdSentence = whatAcceptingWrites('guardrail', { pattern: null, threshold: 20 });
    expect(patternSentence).toMatch(/block/i);
    expect(thresholdSentence).not.toMatch(/block/i);
    // ⚠ INVERTED ON 2026-08-17 with the card assertion above, same reason: this
    // used to demand /approval/i, pinning "Creates a guardrail that requires
    // your approval above this threshold" — a sentence describing a write that
    // decide_discovery_proposal now refuses to make. RED if it goes back to
    // promising an approval gate, or stops saying nothing is created.
    expect(thresholdSentence).not.toMatch(/approval/i);
    expect(thresholdSentence).toMatch(/creates nothing/i);
    expect(patternSentence).not.toBe(thresholdSentence);
  });

  it('the PATTERN sentence names the blast radius — RED if it stops saying the rule applies to every employee (migration 751)', () => {
    // The rule this accept writes is applies_to='all', scope='workspace'. A
    // customer agreeing to "block this phrase" for one employee and getting it
    // for all of them is the same class of surprise as the compliance-pack
    // clause two describe-blocks down.
    const patternSentence = whatAcceptingWrites('guardrail', { pattern: 'refund|chargeback', threshold: null });
    expect(patternSentence).toMatch(/every employee/i);
    expect(cardCopyFor('guardrail', { rule: 'No refunds', pattern: 'refund|chargeback' }, new Map<string, string>()).detail)
      .toMatch(/every employee/i);
  });

  // ── migration 747: the hire says what it switches on for the WHOLE workspace ──
  //
  // instantiate_role_archetype auto-attaches its archetype's mandatory
  // compliance packs, which materialise guardrail_rules with applies_to='all'
  // and severity='blocking'. Measured live 2026-08-16: 7 of 15 active
  // archetypes carry one, 2 rules each. None of it reached the card, so a
  // customer accepted blocking rules covering every employee they had never
  // been shown.
  describe('employee — the compliance pack a hire attaches', () => {
    const PACK = { pack_key: 'financial_controls', name: 'Financial Controls', rule_count: 2, already_attached: false };

    it('names the pack and counts the blocking rules — RED if accepting can attach workspace-wide blocking rules the card never mentions', () => {
      const s = whatAcceptingWrites('employee', {}, { compliancePacks: [PACK] });
      expect(s).toContain('Financial Controls');
      expect(s).toMatch(/2 blocking rules/);
      expect(s).toMatch(/every employee/i);
    });

    it('a pack the workspace ALREADY has adds no new rules — RED if the card claims 2 more blocking rules for an accept that creates none', () => {
      const s = whatAcceptingWrites('employee', {}, { compliancePacks: [{ ...PACK, already_attached: true }] });
      expect(s).toMatch(/already has/i);
      expect(s).not.toMatch(/2 blocking rules/);
    });

    it('an archetype with no pack says so — RED if silence has to be read as "none"', () => {
      const s = whatAcceptingWrites('employee', {}, { compliancePacks: [] });
      expect(s).toMatch(/no compliance pack/i);
    });

    // ⚠ THE ONE THAT MATTERS MOST. `undefined` means the lookup has not come
    // back. Treating it as "there are none" is the `?? 0` defect this codebase
    // keeps paying for: the card would confidently confirm the absence of a
    // control it never looked for.
    it('an unestablished lookup says it has not been checked — RED if not-yet-known is rendered as none', () => {
      const s = whatAcceptingWrites('employee', {});
      expect(s).toMatch(/not been checked/i);
      expect(s).not.toMatch(/no compliance pack/i);
    });

    it('the four states produce four different sentences — RED if two of them collapse into one', () => {
      const sentences = [
        whatAcceptingWrites('employee', {}),
        whatAcceptingWrites('employee', {}, { compliancePacks: [] }),
        whatAcceptingWrites('employee', {}, { compliancePacks: [PACK] }),
        whatAcceptingWrites('employee', {}, { compliancePacks: [{ ...PACK, already_attached: true }] }),
      ];
      expect(new Set(sentences).size).toBe(4);
    });

    // ══════════════════════════════════════════════════════════════════
    // ⚠⚠ THE DISCLOSURE HAS TO BE WHERE THE DECISION IS.
    //
    // Every test above proves whatAcceptingWrites says the right thing — and
    // whatAcceptingWrites renders ONLY inside the Details drawer
    // (DiscoveryProposalsPage.tsx). Accept sits on the CARD FACE and used to
    // fire on one click with no confirmation. So all of it could be true and a
    // customer could still hire an employee, switch on two workspace-wide
    // blocking rules, and never have the sentence rendered on their screen.
    // Measured: 4 of 18 workspaces held a pack, 14 exposed on the first such
    // hire. These cases are about the card and the confirm gate.
    // ══════════════════════════════════════════════════════════════════
    describe('the card face — cardCopyFor carries the pack, not just the drawer', () => {
      const noOwners = new Map<string, string>();

      it('names the pack and counts the rules ON THE CARD — RED if the whole disclosure is behind "Details" while Accept is not', () => {
        const copy = cardCopyFor('employee', { name: 'Accounts Payable Clerk' }, noOwners, { compliancePacks: [PACK] });
        expect(copy.detail).toContain('Financial Controls');
        expect(copy.detail).toMatch(/2 blocking rules/);
        expect(copy.detail).toMatch(/every employee/i);
      });

      it('says WHOSE employees — RED if the card lets a workspace-wide rule read as a rule about this one hire', () => {
        const copy = cardCopyFor('employee', { name: 'Accounts Payable Clerk' }, noOwners, { compliancePacks: [PACK] });
        expect(copy.detail).toMatch(/not just this one/i);
      });

      it('a pack already on claims no new rules — RED if the card overclaims on a second finance hire', () => {
        const copy = cardCopyFor('employee', { name: 'Second Clerk' }, noOwners,
          { compliancePacks: [{ ...PACK, already_attached: true }] });
        expect(copy.detail).toMatch(/already has on/i);
        expect(copy.detail).not.toMatch(/2 blocking rules/);
      });

      it('an unestablished lookup says so on the card — RED if not-yet-known renders as silence, which reads as "there is none"', () => {
        const copy = cardCopyFor('employee', { name: 'Someone' }, noOwners);
        expect(copy.detail).toMatch(/not been checked yet/i);
      });

      it('an archetype with NO pack adds nothing to the card — RED if the card starts narrating non-events (and the not-checked branch is what keeps this silence honest)', () => {
        const withNone = cardCopyFor('employee', { name: 'Someone' }, noOwners, { compliancePacks: [] });
        const unknown = cardCopyFor('employee', { name: 'Someone' }, noOwners);
        expect(withNone.detail).not.toMatch(/compliance pack/i);
        expect(withNone.detail).not.toBe(unknown.detail);
      });

      it('no other kind grows a pack clause — RED if a connector card starts talking about compliance packs', () => {
        for (const k of PROPOSAL_KINDS) {
          if (k === 'employee') continue;
          const copy = cardCopyFor(k, { rule: 'r', pattern: 'x', label: 'l', name: 'n' }, noOwners,
            { compliancePacks: [PACK] });
          expect(copy.detail).not.toMatch(/compliance pack/i);
        }
      });
    });

    describe('needsAcceptConfirmation — the gate between one click and a hire', () => {
      it('a NEW pack with rules asks first — RED if Accept fires straight through on the one decision that switches on blocking rules', () => {
        expect(needsAcceptConfirmation('employee', { compliancePacks: [PACK] })).toBe(true);
      });

      it('an unestablished lookup asks first — RED if "we could not check" is treated as "there is nothing to disclose"', () => {
        expect(needsAcceptConfirmation('employee')).toBe(true);
        expect(needsAcceptConfirmation('employee', {})).toBe(true);
      });

      it('a pack already on goes straight through — RED if every accept gets a confirmation, because one nobody can avoid is one nobody reads', () => {
        expect(needsAcceptConfirmation('employee', { compliancePacks: [{ ...PACK, already_attached: true }] })).toBe(false);
      });

      it('an archetype with no pack goes straight through', () => {
        expect(needsAcceptConfirmation('employee', { compliancePacks: [] })).toBe(false);
      });

      it('a pack carrying ZERO rules goes straight through — RED if the gate fires on a pack that changes nothing', () => {
        expect(needsAcceptConfirmation('employee', { compliancePacks: [{ ...PACK, rule_count: 0 }] })).toBe(false);
      });

      it('one fresh pack among several already-attached ones still asks — RED if the check reads only the first pack', () => {
        expect(needsAcceptConfirmation('employee', {
          compliancePacks: [{ ...PACK, already_attached: true }, { ...PACK, pack_key: 'tcpa_dnc', name: 'TCPA / DNC' }],
        })).toBe(true);
      });

      it('never fires for a kind that attaches no pack — RED if a connector accept grows a modal it has nothing to say in', () => {
        for (const k of PROPOSAL_KINDS) {
          if (k === 'employee') continue;
          expect(needsAcceptConfirmation(k, { compliancePacks: [PACK] })).toBe(false);
        }
      });
    });

    // ⚠⚠ THE GATE IS NOT THE WIRING, AND THIS PROGRAMME HAS PAID FOR THAT
    // DISTINCTION BEFORE. Everything above proves compliancePackCardClause and
    // needsAcceptConfirmation return the right answers. None of it proves the
    // page ASKS them — and the defect being fixed here was precisely that: the
    // disclosure function was correct, complete, well-tested, and rendered only
    // inside a drawer nobody had to open, while the Accept button next to it
    // called runDecision directly. A pure-function suite that is entirely green
    // is exactly what that looked like from in here.
    //
    // So this reads the page. It is a coarse instrument and it is deliberately
    // coarse: it does not care how the wiring is written, only that a card's
    // Accept cannot reach runDecision without the gate being consulted first.
    describe('the page actually asks — DiscoveryProposalsPage wiring', () => {
      const page = readFileSync('src/pages/tenant/DiscoveryProposalsPage.tsx', 'utf8');

      /** The Accept handler's OWN BODY, not the whole file.
       *
       *  ⚠⚠ THIS EXTRACTION IS THE POINT, AND IT IS HERE BECAUSE THE TWO TESTS
       *  IT REPLACES WERE PROVEN UNABLE TO FAIL — against a bypass that was
       *  briefly REAL ON DISK, not a hypothetical one:
       *
       *      onClick={() => {
       *        void needsAcceptConfirmation(p.kind, acceptContextFor(p));  // discarded
       *        void runDecision(p, 'accepted', null);                      // unconditional
       *      }}
       *
       *  Every accept goes straight through and the confirm modal is dead
       *  code. Both old tests stayed green, and so did the other 69:
       *    · `toMatch(/needsAcceptConfirmation.*\n?.*setAcceptTarget/s)` — the
       *      `s` flag makes `.` match newlines, so `.*` spans the ENTIRE FILE.
       *      The call at the card and the `setAcceptTarget(null)` in the
       *      modal's onClose, 300 lines apart and unrelated, satisfied it.
       *    · `not.toMatch(/onClick=\{\(\)\s*=>\s*void runDecision/)` — pinned
       *      one exact spelling. A braced block body never matches it.
       *  A test that reads the whole file cannot tell a gate from two
       *  statements that happen to mention it. */
      const acceptHandlerBody = (() => {
        const at = page.indexOf("{busy.has(p.id) ? 'Setting up…' : 'Accept'}");
        if (at === -1) return null;
        const open = page.lastIndexOf('onClick={', at);
        if (open === -1) return null;
        // Walk braces from the arrow body so nested blocks are included whole.
        let depth = 0; let i = page.indexOf('{', open + 'onClick='.length);
        const start = i;
        for (; i < page.length; i++) {
          if (page[i] === '{') depth++;
          else if (page[i] === '}') { depth--; if (depth === 0) break; }
        }
        return page.slice(start, i + 1);
      })();

      it('the Accept handler exists and could be isolated — RED if the card stops being findable, which would make every assertion below vacuous', () => {
        expect(acceptHandlerBody, 'could not locate the card Accept onClick body — the assertions below would silently pass over nothing').toBeTruthy();
        expect(acceptHandlerBody!.length).toBeGreaterThan(20);
      });

      it('Accept is GATED, not merely gate-adjacent — RED if the confirmation result is computed and discarded', () => {
        const body = acceptHandlerBody!;
        // The decision must BRANCH on the gate, and the true side must open
        // the confirmation. `[^;]*` rather than `[^)]*` because the condition
        // contains a nested call — acceptContextFor(p) — so a paren-excluding
        // span stops inside it. (That was a real mistake in the first draft of
        // this test, and the test failing on the CORRECT handler is how it was
        // found: an assertion that cannot be wrong about the good case cannot
        // be trusted about the bad one.) A semicolon still bounds it to this
        // one statement.
        expect(body, 'the handler does not branch on needsAcceptConfirmation').toMatch(
          /if\s*\([^;]*needsAcceptConfirmation[^;]*\)/,
        );
        expect(body, 'the true branch does not open the confirmation').toMatch(
          /if\s*\([^;]*needsAcceptConfirmation[^;]*\)\s*setAcceptTarget/,
        );
        // ...and reach the decision ONLY through else.
        expect(body, "runDecision('accepted') is reachable without passing the gate").toMatch(
          /else[\s\S]*runDecision\(\s*p,\s*'accepted'/,
        );
        // And the result must never be thrown away — this is the exact bypass.
        expect(body, 'needsAcceptConfirmation is called and its answer discarded').not.toMatch(
          /void\s+needsAcceptConfirmation/,
        );
      });

      it('there is exactly ONE way to accept from a card — RED if a second, ungated call is added anywhere on the page', () => {
        // Counting, not spelling. Any bypass ADDS an occurrence, whatever
        // shape it takes, and the batch path uses acceptProposal rather than
        // this call so it does not inflate the count.
        const accepts = page.match(/runDecision\(\s*p,\s*'accepted'/g) ?? [];
        expect(accepts, `expected exactly one runDecision(p,'accepted') on the page, found ${accepts.length}`).toHaveLength(1);
        expect(acceptHandlerBody!).toContain("runDecision(p, 'accepted'");
      });

      it('the card copy is built WITH the pack context — RED if cardCopyFor loses its fourth argument and the clause silently disappears from every card', () => {
        expect(page).toMatch(/cardCopyFor\(p\.kind,\s*p\.payload,\s*employeeNameByArchetype,\s*acceptContextFor\(p\)\)/);
      });

      it('the confirmation renders the same sentence the drawer does — RED if the two disclosures become two different claims about one hire', () => {
        // whatAcceptingWrites must appear at least twice: once in the confirm,
        // once in the drawer, both fed by acceptContextFor.
        expect(page.match(/whatAcceptingWrites\(/g) ?? []).toHaveLength(2);
        expect(page.match(/acceptContextFor\(/g) ?? []).not.toHaveLength(0);
      });
    });
  });
});

describe('trustRuleBlockReason — §11b requirement 4: blocked with a reason, never hidden', () => {
  it('no matching employee proposed at all — RED if this returns null (would let a trust rule for nobody through as decidable)', () => {
    const reason = trustRuleBlockReason('archetype:sdr', []);
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/no employee/i);
  });

  it('employee proposed but still pending — RED if this returns null (the trust rule would render fully decidable before its employee is real)', () => {
    const reason = trustRuleBlockReason('archetype:billing_ar', [
      { payload: { archetype_key: 'billing_ar', name: 'Morgan' }, state: 'pending' },
    ]);
    expect(reason).not.toBeNull();
    expect(reason).toContain('Morgan');
    expect(reason).toMatch(/until you accept/i);
  });

  it('employee actually accepted — RED if this still returns a block reason (would permanently hide a decidable trust rule, the opposite failure)', () => {
    const reason = trustRuleBlockReason('archetype:billing_ar', [
      { payload: { archetype_key: 'billing_ar', name: 'Morgan' }, state: 'accepted' },
    ]);
    expect(reason).toBeNull();
  });

  it('a de_ref with no "archetype:" prefix is still matched on the bare key — RED if the prefix-stripping regresses', () => {
    const reason = trustRuleBlockReason('billing_ar', [
      { payload: { archetype_key: 'billing_ar', name: 'Morgan' }, state: 'accepted' },
    ]);
    expect(reason).toBeNull();
  });
});

describe('itemsForBatchMode — fix round 1, Important ("batching is structural for the value, conventional for the wiring")', () => {
  const items: Array<{ kind: ProposalKind; id: string }> = [
    { kind: 'guardrail', id: 'g1' },
    { kind: 'guardrail', id: 'g2' },
    { kind: 'trust_rule', id: 't1' },
    { kind: 'employee', id: 'e1' },
    { kind: 'connector', id: 'c1' },
  ];

  it('THE EXACT BYPASS THE REVIEW NAMED — calling the accept-all path for guardrail returns nothing, not the two guardrail items — RED if this ever returns g1/g2', () => {
    // Before this fix, the page's renderAcceptAllSection(kind) trusted
    // whatever kind it was called with. A single mis-typed
    // renderAcceptAllSection('guardrail') would have rendered these two
    // guardrails inside a bulk "Accept all" checkbox batch with every
    // existing test (which only ever checked batchModeFor in isolation)
    // still green. This is that exact call, one level down from the React
    // component so it's provable without a DOM.
    expect(itemsForBatchMode('guardrail', 'accept_all', items)).toEqual([]);
  });

  it('the same bypass for trust_rule via "department" mode also returns nothing — RED if t1 appears', () => {
    expect(itemsForBatchMode('trust_rule', 'department', items)).toEqual([]);
  });

  it('correct usage still works — RED if this now ALSO returns nothing (the guard must not become a wall)', () => {
    expect(itemsForBatchMode('guardrail', 'never', items).map((i) => i.id)).toEqual(['g1', 'g2']);
    expect(itemsForBatchMode('trust_rule', 'never', items).map((i) => i.id)).toEqual(['t1']);
    expect(itemsForBatchMode('employee', 'department', items).map((i) => i.id)).toEqual(['e1']);
    expect(itemsForBatchMode('connector', 'accept_all', items).map((i) => i.id)).toEqual(['c1']);
  });

  it('even with the right mode, only that kind is returned from a mixed list — RED if a guardrail leaks into an employee department section', () => {
    expect(itemsForBatchMode('employee', 'department', items)).not.toContainEqual(expect.objectContaining({ kind: 'guardrail' }));
  });

  // ── migration 746: employee accepts went LIVE ────────────────────────────
  // §11b's batching rule and the accept gate are two different things, and
  // until 746 nothing distinguished them for 'employee' because the kind could
  // not be accepted at all — an "Accept all N selected" button for a kind whose
  // controls were disabled was not a hazard anyone could reach.
  //
  // It is reachable now. renderAcceptAllSection is the ONLY renderer that draws
  // a bulk-accept control, it calls acceptSelected on everything checked, and
  // its confirmation sentence is written about connectors ("each waiting for
  // your credential"). An employee reaching it would be bulk-hired — real
  // people on the payroll, each with an SOP, watchers and guardrails — behind
  // one click, with a confirmation about credentials. §11b puts employees in a
  // DEPARTMENT batch precisely because that is a grouping device and not a
  // bulk-decide one: every card keeps its own Accept.
  //
  // So this is the same bypass as the guardrail case above, asserted for the
  // kind that just gained the ability to be harmed by it. RED if e1 appears.
  it('employee cannot be dragged into a bulk-accept batch now that hiring is LIVE — RED if e1 appears', () => {
    expect(itemsForBatchMode('employee', 'accept_all', items)).toEqual([]);
  });

  it('...and its real mode is still department, which draws no bulk-accept control at all — RED if batchModeFor(employee) moves', () => {
    expect(batchModeFor('employee')).toBe('department');
    // The two kinds §11b says may never batch, restated here so that "employee
    // is a department batch" cannot be read as "batching got looser".
    expect(batchModeFor('guardrail')).toBe('never');
    expect(batchModeFor('trust_rule')).toBe('never');
  });
});

// ── migration 751: guardrail accepts went LIVE ──────────────────────────────
// The same distinction the employee block above draws, for the kind that has
// just gained an accept — and one extra thing, because a guardrail is the only
// kind whose accept switches something ON with no second gate behind it. A
// connector waits for a credential; an employee starts supervised and sends
// nothing; a blocking rule starts blocking the moment the row lands.
describe('the guardrail accept is wired, and wired the one way that keeps the card true (migration 751)', () => {
  const api = readFileSync('src/lib/discoveryApi.ts', 'utf8');

  /** ACCEPT_WRITERS' own object literal, not the whole file. The header of
   *  that table says it is "THE SINGLE TABLE — which kinds this screen can
   *  decide"; a test that grepped the file for the word `guardrail` would be
   *  satisfied by the paragraph explaining why guardrails used to be absent. */
  const acceptWritersBody = (() => {
    const at = api.indexOf('const ACCEPT_WRITERS');
    if (at === -1) return null;
    const start = api.indexOf('{', at);
    let depth = 0; let i = start;
    for (; i < api.length; i++) {
      if (api[i] === '{') depth++;
      else if (api[i] === '}') { depth--; if (depth === 0) break; }
    }
    return api.slice(start, i + 1);
  })();

  it('ACCEPT_WRITERS could be isolated — RED if the table stops being findable, which would make the assertions below vacuous', () => {
    expect(acceptWritersBody, 'could not locate the ACCEPT_WRITERS object literal').toBeTruthy();
    expect(acceptWritersBody!).toContain('connector:');
  });

  it('guardrail has an entry in ACCEPT_WRITERS — RED if the kind is gated on without a writer, or wired somewhere else', () => {
    // isDecidableKind reads this table and acceptProposal runs the entry it
    // finds, so an entry here is what gives the kind Accept, Decline and Park
    // together. There is deliberately no second place to look.
    expect(acceptWritersBody!).toMatch(/guardrail:\s*\(proposal, note\)\s*=>\s*acceptGuardrailProposal/);
  });

  it('the writer picks blocked_phrase and NEVER writes a compliance_pack_key — RED on either, because a pack rule cannot be retired', () => {
    // retire_guardrail_rule refuses a pack rule by name and
    // trg_guard_compliance_guardrails blocks deactivating one, so a discovery
    // guardrail carrying a pack key is a rule the customer agreed to and cannot
    // remove. Migration 751's probe 15 retires the rule it creates to prove the
    // omission works; this is the pin that keeps the omission from coming back.
    expect(api).toMatch(/rule_type:\s*'blocked_phrase'/);
    expect(api).not.toMatch(/compliance_pack_key:/);
  });

  it('a threshold-only guardrail still calls the RPC, so the refusal is written to the ROW — RED if the writer starts refusing locally and the reason stops surviving a reload', () => {
    // migration 740's last_error is the whole reason Task 3 Step 3 exists. A
    // client-side-only refusal lives in React state and a reload turns "we
    // refused this and told you why" back into "nobody has decided this yet".
    expect(api).toMatch(/if\s*\(!gate\.ok\)\s*\{[\s\S]{0,600}?decideDiscoveryProposal\(proposal\.id,\s*'accepted',\s*note,\s*null\)/);
  });

  // ── F3: THE FIX THAT CLOSED B1 WAS PROTECTED BY NOTHING ───────────────────
  //
  // Watched in round 2, both on the real tree:
  //     delete `.eq('scope', 'workspace')` from the reuse-find  -> 373 GREEN
  //     delete `.eq('applies_to', 'all')`  from the reuse-find  -> 373 GREEN
  // The whole tests/ tree mentioned "scope" once, in a comment, and probe 15
  // never runs the client. So B1's client half — the half that decides WHICH
  // EXISTING ROW gets handed to decide_discovery_proposal as "the rule this
  // proposal created" — had no pin at all.
  //
  // What the deletion costs, concretely: without the scope filter this find
  // matches on `applies_to` alone, a column NO enforcement path reads. In
  // outsourcetel-hq 12 rows match every other filter it applies and all 12 are
  // scope='employee'. A pattern collision would hand the RPC an employee-scoped
  // rule; the RPC would refuse it (both halves check scope now), the proposal
  // would revert to pending, and the customer would be stuck — or, before the
  // RPC learned to check, the stamp would take it and the card would say "for
  // every employee in this workspace" about a rule guardrail_rules_for_de
  // returns for exactly one.
  describe('the reuse-find still filters on the column that decides blast radius (round 3, F3)', () => {
    /** The reuse-find's OWN chain, not the whole file. A test that grepped
     *  discoveryApi.ts for "scope" would be satisfied by the four paragraphs
     *  explaining why the filter matters — which is exactly how the deletion
     *  stayed green. */
    //  ⚠ ANCHORED ON THE TABLE, NOT ON THE VARIABLE NAME. `const { data:
    //  existing, error: findErr }` appears TWICE in this file — the guardrail
    //  reuse-find and the connector one — and a first-match extraction would be
    //  asserting scope filters against a query over `connectors`, which has
    //  none. It happens to work today only because the guardrail writer sits
    //  above the connector writer in the file.
    const reuseFind = (() => {
      const table = api.indexOf(".from('guardrail_rules')");
      if (table === -1) return null;
      const at = api.lastIndexOf('const { data: existing, error: findErr }', table);
      if (at === -1) return null;
      const limit = api.indexOf('.limit(1)', table);
      if (limit === -1) return null;
      const end = api.indexOf(';', limit);
      if (end === -1) return null;
      return api.slice(at, end + 1);
    })();

    it('the reuse-find could be isolated — RED if it stops being findable, which would make every assertion below vacuous', () => {
      expect(reuseFind, 'could not locate the guardrail reuse-find query chain').toBeTruthy();
      expect(reuseFind!).toContain("from('guardrail_rules')");
      expect(reuseFind!.length).toBeGreaterThan(200);
    });

    it("`.eq('scope', 'workspace')` is IN THE FIND — RED the moment it is deleted (the exact deletion that stayed green in round 2)", () => {
      expect(reuseFind!, "the reuse-find no longer filters on scope — it would match employee-scoped rows on applies_to alone")
        .toMatch(/\.eq\(\s*'scope',\s*'workspace'\s*\)/);
    });

    it("`.eq('applies_to', 'all')` is IN THE FIND — RED the moment it is deleted", () => {
      // Not enforcement, but the RPC checks it, so a reused row missing it is a
      // stamp that refuses and a proposal that sticks.
      expect(reuseFind!, 'the reuse-find no longer filters on applies_to, which decide_discovery_proposal still checks')
        .toMatch(/\.eq\(\s*'applies_to',\s*'all'\s*\)/);
    });

    it('every column decide_discovery_proposal re-checks is in the find — RED if the two halves stop agreeing on what a reusable row is', () => {
      // The RPC checks: tenant, rule_type, pattern verbatim, severity, scope,
      // applies_to, active, not retired, no pack key. A find that omits any one
      // of them can return a row the stamp will refuse — a permanently stuck
      // proposal with a live blocking rule beside it.
      for (const [col, val] of [
        ['rule_type', "'blocked_phrase'"], ['scope', "'workspace'"],
        ['applies_to', "'all'"], ['severity', "'blocking'"], ['active', 'true'],
      ] as const) {
        expect(reuseFind!, `the reuse-find dropped its ${col} filter`)
          .toContain(`.eq('${col}', ${val})`);
      }
      expect(reuseFind!).toContain(".is('retired_at', null)");
      expect(reuseFind!).toContain(".is('compliance_pack_key', null)");
      expect(reuseFind!).toContain(".eq('tenant_id', tenantId)");
    });
  });

  it('guardrails still never batch, now that they can actually be accepted — RED if g1/g2 appear in a bulk-accept batch', () => {
    // §11b: comparing guardrails across rules is the disclosure this surface
    // exists to protect, and batchModeFor is the single gate. This restates the
    // case above deliberately: the earlier assertion was written when the kind
    // could not be accepted at all, so a bulk control over it was unreachable
    // rather than refused. It is reachable now.
    const items = [
      { kind: 'guardrail' as const, id: 'g1' },
      { kind: 'guardrail' as const, id: 'g2' },
      { kind: 'connector' as const, id: 'c1' },
    ];
    expect(batchModeFor('guardrail')).toBe('never');
    expect(itemsForBatchMode('guardrail', 'accept_all', items)).toEqual([]);
    expect(itemsForBatchMode('guardrail', 'never', items).map((i) => i.id)).toEqual(['g1', 'g2']);
  });
});

// ── F1: THE SCREEN IS ON THE WRITER NOW, NOT ON ONE CALLER ──────────────────
//
// The two screens (regex metacharacters, empty alternatives) used to live only
// inside guardrailAcceptability — i.e. on the discovery accept path — while
// three comments said migration 751 was "the FIRST path that lets a
// MODEL-authored literal reach that compiler". It was not. approveProposal
// (src/lib/governanceAiApi.ts) passes governance_proposals.pattern, a column
// the Workspace Assistant writes, straight into addGuardrailRule with NO screen
// at all: not the metacharacter one, not the empty-alternative one, not even
// looksLikeEnforceablePattern. A human clicks Approve; the bytes are the
// model's. "refund|" through that door mutes every outbound message on all four
// enforcement paths. governance_proposals holds 0 rows (measured 2026-08-17),
// so the claim was true about history and false about the code.
describe('the pattern screen is on addGuardrailRule, so every door passes it (round 3, F1)', () => {
  const guardrailApiSrc = readFileSync('src/lib/guardrailApi.ts', 'utf8');
  const governanceSrc = readFileSync('src/lib/governanceAiApi.ts', 'utf8');
  const industriesSrc = readFileSync('src/lib/industries.ts', 'utf8');

  const base = { rule: 'Never promise a refund', rule_type: 'blocked_phrase' as const };

  it('a MODEL-authored metacharacter literal is refused BY THE WRITER — RED if the screen leaves addGuardrailRule', async () => {
    // Behavioural, not a grep: the screen runs before requireTenantId() and
    // before the insert, so this rejects without a network call. If the screen
    // is removed, the call falls through and the message stops being the
    // screen's.
    await expect(addGuardrailRule({ ...base, pattern: '$500 off' }, 'model_authored'))
      .rejects.toThrow(/search expression/);
  });

  it('a MODEL-authored empty alternative is refused BY THE WRITER — RED if the workspace-wide mute can reach the insert', async () => {
    await expect(addGuardrailRule({ ...base, pattern: 'refund|' }, 'model_authored'))
      .rejects.toThrow(/nothing beside it/);
  });

  it('a HAND-authored empty alternative is refused too — RED if provenance ever gates THIS screen', async () => {
    // 0 of the 168 live active patterned rules carry one (measured 2026-08-17),
    // and nobody typing into a form has ever meant "match every message".
    await expect(addGuardrailRule({ ...base, pattern: 'refund|' }, 'hand_authored'))
      .rejects.toThrow(/nothing beside it/);
  });

  it('a HAND-authored regex is NOT refused by the screen, and the same string IS as model-authored — RED if the concession becomes unconditional in either direction', async () => {
    // A real INDUSTRY_TEMPLATES pattern. As 'hand_authored' it must get PAST
    // the screen — it then fails further down (no session), which is a
    // DIFFERENT error, and that difference is the assertion. Asserting both
    // directions on one string is what stops this from being "the screen never
    // fires" or "the screen always fires".
    const pattern = 'guarantee[d]? (delivery|ship)';
    await expect(addGuardrailRule({ ...base, pattern }, 'model_authored'))
      .rejects.toThrow(/search expression/);
    let handErr = '';
    try { await addGuardrailRule({ ...base, pattern }, 'hand_authored'); }
    catch (e) { handErr = e instanceof Error ? e.message : String(e); }
    expect(handErr, 'a hand-authored regex was refused by the model screen').not.toMatch(/search expression/);
  });

  it('the screen runs BEFORE the write, not after — RED if a refused pattern can reach guardrail_rules', () => {
    // Ordering by index inside the one function that writes. A screen that ran
    // after the write would leave exactly the artefact this migration exists to
    // prevent: a live workspace-wide blocking rule plus a refusal.
    const at = guardrailApiSrc.indexOf('async function screenedGuardrailWrite');
    expect(at, 'could not locate screenedGuardrailWrite').toBeGreaterThan(-1);
    const body = guardrailApiSrc.slice(at, guardrailApiSrc.indexOf('\n}', at));
    expect(body.length).toBeGreaterThan(120);
    const screenAt = body.indexOf('screenPatternForWrite');
    const writeAt = body.indexOf('await write()');
    expect(screenAt, 'the write no longer screens at all').toBeGreaterThan(-1);
    expect(writeAt, 'could not find the write — the ordering assertion would be vacuous').toBeGreaterThan(-1);
    expect(screenAt).toBeLessThan(writeAt);
  });

  it('the universal screens are filtered from EVERY failure, not read off the first one — RED if `.failure` comes back as the provenance test', () => {
    // ⚠ THIS PIN EXISTS BECAUSE THE PREVIOUS ONE ASSERTED THE BUG. It required
    // the literal `screen.failure === 'empty_alternative'` in the writer — i.e.
    // it demanded that only the FIRST failure be consulted. "refund.|" reports
    // `metachar` first, `metachar` is provenance-exempt for hand-authored bytes,
    // and so the empty alternative was never applied: a regex matching the empty
    // string, saved from the ordinary Add dialog.
    const at = guardrailApiSrc.indexOf('function screenPatternForWrite');
    expect(at, 'could not locate screenPatternForWrite').toBeGreaterThan(-1);
    const body = guardrailApiSrc.slice(at, guardrailApiSrc.indexOf('\n}', at));
    expect(body, 'the provenance rule reads a single failure again').not.toMatch(/screen\.failure\s*===/);
    expect(body).toContain('screen.failures');
    expect(body).toContain('UNIVERSAL_PATTERN_SCREENS');
  });

  it('THE BEHAVIOUR: a hand-authored "refund.|" is refused for the EMPTY ALTERNATIVE, not let through by the metacharacter exemption', async () => {
    // The literal trips both screens. The metacharacter one is exempt here; the
    // empty-alternative one is not, and the message proves which one answered.
    expect(screenGuardrailPattern('refund.|').failures.map((f) => f.failure))
      .toEqual(['metachar', 'empty_alternative']);
    await expect(addGuardrailRule({ ...base, pattern: 'refund.|' }, 'hand_authored'))
      .rejects.toThrow(/nothing beside it/);
  });

  it('EVERY door names its provenance, and exactly the two model doors say model_authored — RED if a new caller is copy-pasted as hand_authored', () => {
    // Enumerated across src/, not assumed. The parameter is required, so
    // TypeScript already proves presence; this proves the VALUE, which is the
    // part a compiler cannot check.
    // ⚠ WORKING TREE, NOT INDEX — see repoFiles. A new caller added in the
    // session that adds it is untracked, and `git ls-files` alone could not see
    // it, which is exactly when a copy-pasted 'hand_authored' would land.
    const files = repoFiles('src', /\.tsx?$/);
    const callers: Array<{ file: string; provenance: string }> = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      const re = /addGuardrailRule\(\{[\s\S]*?\},\s*'(model_authored|hand_authored)'\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) callers.push({ file: f, provenance: m[1] });
      // a call that does NOT end in one of the two literals inflates `loose`
      const loose = (text.match(/\bawait addGuardrailRule\(/g) ?? []).length;
      const tight = (text.match(re) ?? []).length;
      expect(tight, `${f} has an addGuardrailRule call that does not name its provenance literally`).toBe(loose);
    }
    // Vacuity: if the extraction found nothing, every assertion below is empty.
    expect(callers.length, 'no addGuardrailRule call sites were found at all').toBeGreaterThanOrEqual(5);
    const model = callers.filter((c) => c.provenance === 'model_authored').map((c) => c.file).sort();
    expect(model).toEqual(['src/lib/discoveryApi.ts', 'src/lib/governanceAiApi.ts']);
  });

  it('approveProposal — the door the comments said did not exist — is the model-authored one', () => {
    // Named separately from the enumeration above because this IS the finding:
    // p.pattern is governance_proposals.pattern, written by the assistant.
    const at = governanceSrc.indexOf('export async function approveProposal');
    expect(at).toBeGreaterThan(-1);
    const body = governanceSrc.slice(at, governanceSrc.indexOf('\n}', at));
    expect(body).toMatch(/pattern:\s*p\.pattern/);
    expect(body, 'approveProposal stopped declaring its pattern model-authored').toMatch(/\},\s*'model_authored'\s*\)/);
  });

  it('the hand-authored concession is load-bearing, and nothing shipped trips the unconditional screen — RED if either fact changes', () => {
    // WHY 'hand_authored' exists at all, as a count rather than an assertion.
    // CompanySetupPage feeds every one of these through addGuardrailRule
    // verbatim; a model screen here would refuse Company Setup for most
    // industries. Measured live the same day: 35 of 168 active patterned rules
    // carry a metacharacter, all 35 workspace-scoped; 0 carry an empty
    // alternative.
    const patterns = [...industriesSrc.matchAll(/pattern:\s*'([^']*)'/g)].map((m) => m[1]);
    expect(patterns.length, 'no INDUSTRY_TEMPLATES patterns found — the counts below would be vacuous').toBeGreaterThanOrEqual(20);
    // ⚠ `.failures`, not `.failure`. Reading the first failure only would miss a
    // template that carried BOTH — the same walk-through that let "refund.|" in.
    const tripped = (p: string, f: PatternScreenFailure) =>
      screenGuardrailPattern(p).failures.some((x) => x.failure === f);
    const meta = patterns.filter((p) => tripped(p, 'metachar'));
    const universal = patterns.filter((p) =>
      UNIVERSAL_PATTERN_SCREENS.some((f) => tripped(p, f)));
    expect(meta.length, 'no shipped template uses a metacharacter, so the hand_authored concession now protects nothing — reconsider it')
      .toBeGreaterThanOrEqual(13);
    expect(universal, `a shipped template would be REFUSED by an unconditional screen: ${JSON.stringify(universal)}`)
      .toEqual([]);
  });
});

// ── G1/G2: THE SCREEN IS ON EVERY WRITER, AND THERE ARE THREE ──────────────
//
// Round 3's finding was "the screen is on one CALLER, not on the writer". Its
// fix put the screen on ONE WRITER — and there are THREE, all in
// src/lib/guardrailApi.ts, all writing the same column of the same table:
//
//   addGuardrailRule          screened by round 3
//   updateGuardrailRule       NO SCREEN — and reachable in two clicks, because
//                             CompliancePage feeds ONE free-text field to
//                             addGuardrailRule when composing and to this when
//                             `editing` is set. "refund|" refused on Add,
//                             accepted on Edit, workspace-wide, live.
//   installStarterGuardrails  NO SCREEN, a live UI door (the empty state's
//                             primary button), and nothing in tests/ or
//                             scripts/ mentioned STARTER_GUARDRAILS at all.
//
// So the fix is not a third remembered call. Every PostgREST write in this
// repository now goes through ONE function, and the enumeration below is what
// keeps a fourth door from being added beside it rather than through it. THE
// RPC DOORS ARE A SEPARATE PERIMETER with a pin of its own further down — a
// write behind `supabase.rpc(...)` is not a `.from()` and this scan is blind to
// it by construction.
describe('every writer of guardrail_rules.pattern passes the screen (round 4, G1/G2)', () => {
  const guardrailApiSrc = readFileSync('src/lib/guardrailApi.ts', 'utf8');
  const base = { rule: 'Never promise a refund', rule_type: 'blocked_phrase' as const };
  const liveRule = {
    id: '00000000-0000-0000-0000-000000000001', version: 3, retired_at: null,
  } as unknown as Parameters<typeof updateGuardrailRule>[0];

  /** ⚠ THE EXTRACTOR, FACTORED OUT SO IT CAN BE RUN AGAINST SOURCES THAT ARE
   *  NOT THIS REPOSITORY. The version this replaced required the write method
   *  to follow `.from(...)` immediately, and three ways round that were
   *  demonstrated GREEN on this tree in round 5. The self-test below drives all
   *  four evasions through this same function, so "it catches them" is asserted
   *  every run instead of having been true once.
   *
   *  Returns one entry per site. `op` is the chained method when the builder is
   *  consumed on the spot; `null` means the builder was NOT consumed there — an
   *  alias, which this treats as a write because nothing here can know what the
   *  alias is later asked to do, and guessing in the safe direction is how a
   *  screen gets skipped. */
  function guardrailTableSites(text: string): Array<{ line: number; op: string | null; kind: 'from' | 'aliased_name' }> {
    // Comments are blanked, not deleted, so every offset (and so every reported
    // line number) still lines up with the file on disk. This is what closes
    // "put a comment between `.from()` and `.insert()`".
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));
    const lineOf = (i: number) => code.slice(0, i).split('\n').length;
    const out: Array<{ line: number; op: string | null; kind: 'from' | 'aliased_name' }> = [];
    for (const m of code.matchAll(/\.from\(\s*['"`]guardrail_rules['"`]\s*\)/g)) {
      const chained = /^\s*\.(\w+)\(/.exec(code.slice(m.index + m[0].length));
      out.push({ line: lineOf(m.index), op: chained ? chained[1] : null, kind: 'from' });
    }
    // …and the table name held in a variable, which `.from(TBL)` hides from the
    // scan above entirely. Narrow on purpose: a BINDING to the literal, not the
    // literal anywhere. `table: 'guardrail_rules'` in a script's name map and
    // `referencedRelation: "guardrail_rules"` in database.types.ts are not doors
    // and there are 7 of them, so flagging every literal would be noise a reader
    // learns to ignore.
    for (const m of code.matchAll(/\b(?:const|let|var)\s+\w+(?:\s*:\s*[^=;\n]+)?\s*=\s*['"`]guardrail_rules['"`]/g)) {
      out.push({ line: lineOf(m.index), op: null, kind: 'aliased_name' });
    }
    return out;
  }

  it('the extractor catches all FOUR evasions that were demonstrated GREEN — RED if any of them becomes invisible again', () => {
    // ⚠⚠ THE PIN ON THE PIN. Three of these four were measured to pass the
    // round-4 extractor while writing to the table, and the fourth (an untracked
    // file) defeated the FILE LIST rather than the extractor and is closed in
    // repoFiles. Driving them through the real function is the only way this
    // block can claim to catch them; asserting it in a comment is what round 4
    // did.
    const alias = "const t = supabase.from('guardrail_rules');\nawait t.update({ pattern }).eq('id', id);";
    const commented = ".from('guardrail_rules')\n  // a note about why\n  .insert({ pattern });";
    const constName = "const TBL = 'guardrail_rules';\nawait supabase.from(TBL).insert({ pattern });";
    const direct = "supabase.from('guardrail_rules').insert({ pattern });";
    const plainRead = "supabase.from('guardrail_rules').select('*').eq('id', id);";

    // ⚠ THE ALIAS FORM IS THIS CODEBASE'S OWN IDIOM, not a contrived case.
    // Counted 2026-08-17 over the 375 tracked+untracked .ts/.tsx/.mjs/.js files
    // in the three scanned roots, SHAPE STATED so the number is re-checkable:
    //     /\b(?:const|let|var)\s+\w+\s*=\s*\w+(?:\.\w+)*\.from\(/
    // -> 62 occurrences across 41 files. (An earlier revision of this comment
    // said "38 across 22" and named no shape, so nobody could reproduce it and
    // three reviewers each got a different answer. A measured number without
    // its method is decorative — that is the defect this whole block exists
    // for, committed one line above the pin that catches it.)
    // Includes supabase/functions/ai-session/index.ts:511 on guardrail_rules
    // itself — that one is a `.select(`, so it is correctly counted as a read.
    expect(guardrailTableSites(alias), 'the ALIAS form is invisible again')
      .toEqual([{ line: 1, op: null, kind: 'from' }]);
    expect(guardrailTableSites(commented).map((s) => s.op), 'a comment between .from() and the write hides it again')
      .toEqual(['insert']);
    expect(guardrailTableSites(constName).map((s) => s.kind), 'the table name in a const is invisible again')
      .toEqual(['aliased_name']);
    expect(guardrailTableSites(direct).map((s) => s.op)).toEqual(['insert']);
    // …and the inversion, so this is not "everything is a write": an ordinary
    // read must come back as a read, or the offender list below is noise.
    expect(guardrailTableSites(plainRead).map((s) => s.op)).toEqual(['select']);
    expect(guardrailTableSites('nothing to see here')).toEqual([]);
  });

  it('THE ENUMERATION: every PostgREST write to guardrail_rules is inside the one screened writer — RED on a fourth `.from()` door anywhere this can see', () => {
    // ⚠ WHAT THIS MAY CLAIM. Round 4's title said "every write to
    // guardrail_rules in the repo … RED on a fourth door added anywhere", and
    // round 5 measured both halves false: `approve_learned_behavior` writes the
    // column behind an RPC and is not a `.from()` at all, and three ways to add
    // a `.from()` write and stay green were demonstrated. So the sentence is
    // narrowed to what the code delivers — every PostgREST write, in the three
    // roots below, in the WORKING TREE.
    //
    // WHAT IT STILL CANNOT SEE, named rather than left to be discovered:
    //   · a table name that is COMPUTED ('guardrail' + '_rules', a template
    //     literal with a substitution, a name read from config);
    //   · `.from(x)` where x arrives as a parameter from another module;
    //   · anything outside src/, supabase/functions/ and scripts/ — tests/ is
    //     excluded deliberately, because this very file holds the string
    //     `.from('guardrail_rules')` in its own assertions;
    //   · SQL. The RPC doors are pinned separately below.
    const files = repoFiles('src supabase/functions scripts');
    const writes: Array<{ file: string; op: string | null; kind: string }> = [];
    let sawSelect = 0;
    for (const f of files) {
      const raw = readFileSync(f, 'utf8');
      if (!raw.includes('guardrail_rules')) continue;
      for (const s of guardrailTableSites(raw)) {
        if (s.kind === 'from' && s.op === 'select') { sawSelect += 1; continue; }
        writes.push({ file: `${f}:${s.line}`, op: s.op, kind: s.kind });
      }
    }
    // Vacuity, both ways: an extractor that matched nothing would report a clean
    // repo, and one that lost the reads has probably lost the writes too.
    expect(files.length, 'the file list collapsed, so every assertion here would be vacuous').toBeGreaterThan(200);
    expect(sawSelect, 'the extractor found no guardrail_rules reads at all, so it is not reading the repo')
      .toBeGreaterThanOrEqual(5);
    expect(writes.length, 'the extractor found no guardrail_rules writes at all — it must find the three in guardrailApi.ts')
      .toBeGreaterThanOrEqual(3);
    const offenders = writes.filter((w) => !w.file.startsWith('src/lib/guardrailApi.ts:'));
    expect(offenders, `a write to guardrail_rules outside the screened writer: ${JSON.stringify(offenders)}`)
      .toEqual([]);
    expect(writes.map((w) => w.op).sort(), 'the three writers are insert (add), update (edit), insert (starter set) — and each still consumes its builder on the spot')
      .toEqual(['insert', 'insert', 'update']);
  });

  it('the file list is the WORKING TREE, not the git index — RED if the untracked half is dropped again', () => {
    // ⚠ THE HOLE THIS CLOSES, restated because it is the reason every other pin
    // in this file could be added-around: `git ls-files` alone left a new
    // src/lib/__probe.ts holding a bare guardrail_rules insert 130/130 GREEN.
    //
    // ⚠ AND WHAT THIS DOES NOT PROVE. It compares repoFiles against the two git
    // queries it is built from, so it proves the UNION, not that git's untracked
    // list is complete. When the tree happens to have no untracked file under
    // these roots the second loop compares zero paths — which is why the flag
    // itself is asserted as well, rather than relying on a comparison that can
    // be empty.
    const spec = 'src supabase/functions scripts';
    const q = (cmd: string) => execSync(cmd, { encoding: 'utf8' }).split('\n')
      .map((f) => f.trim()).filter((f) => f !== '' && /\.(ts|tsx|mjs|js)$/.test(f));
    const tracked = q(`git ls-files ${spec}`);
    const untracked = q(`git ls-files -o --exclude-standard ${spec}`);
    const union = repoFiles(spec);
    expect(tracked.length, 'the tracked half returned nothing').toBeGreaterThan(200);
    for (const f of tracked) expect(union, `${f} fell out of the union`).toContain(f);
    for (const f of untracked) expect(union, `${f} is untracked and was not scanned`).toContain(f);
    expect(union.length).toBe(new Set([...tracked, ...untracked]).size);
    // ⚠ ASSERTED AGAINST THE HELPER'S OWN BODY, not against this file. A
    // `toContain` over the whole file would be satisfied by the string in this
    // very assertion — a pin that passes because it exists.
    const self = readFileSync('tests/discovery-proposal-batching.test.ts', 'utf8');
    const at = self.indexOf('function repoFiles(');
    expect(at, 'could not locate repoFiles, so the check below would be vacuous').toBeGreaterThan(-1);
    const helper = self.slice(at, self.indexOf('\n}', at));
    expect(helper.length).toBeGreaterThan(80);
    expect(helper, 'repoFiles stopped asking git for untracked files')
      .toContain('ls-files -o --exclude-standard');
  });

  it('all three writers route through screenedGuardrailWrite — RED if one of them talks to supabase directly again', () => {
    for (const fn of ['addGuardrailRule', 'updateGuardrailRule', 'installStarterGuardrails']) {
      const at = guardrailApiSrc.indexOf(`export async function ${fn}`);
      expect(at, `could not locate ${fn}`).toBeGreaterThan(-1);
      const body = guardrailApiSrc.slice(at, guardrailApiSrc.indexOf('\n}', at));
      expect(body.length, `${fn} body looks empty, so the assertion below would be vacuous`).toBeGreaterThan(100);
      expect(body, `${fn} no longer routes through screenedGuardrailWrite`).toContain('screenedGuardrailWrite(');
    }
  });

  it('G1 — updateGuardrailRule refuses an empty alternative, for BOTH provenances', async () => {
    // The reachable defect: this is the Compliance page's Edit dialog. The
    // screen runs before requireTenantId(), so both of these reject without a
    // network call and the message names which screen answered.
    await expect(updateGuardrailRule(liveRule, { pattern: 'refund|' }, 'hand_authored'))
      .rejects.toThrow(/nothing beside it/);
    await expect(updateGuardrailRule(liveRule, { pattern: 'refund|' }, 'model_authored'))
      .rejects.toThrow(/nothing beside it/);
  });

  it('G1 — updateGuardrailRule keeps the hand-authored metacharacter concession, and drops it for the model', async () => {
    // Re-saving one of the 35 live rules that carry a metacharacter must still
    // work, or this fix would brick the edit dialog it was written to protect.
    const pattern = 'guarantee[d]? (delivery|ship)';
    await expect(updateGuardrailRule(liveRule, { pattern }, 'model_authored'))
      .rejects.toThrow(/search expression/);
    let handErr = '';
    try { await updateGuardrailRule(liveRule, { pattern }, 'hand_authored'); }
    catch (e) { handErr = e instanceof Error ? e.message : String(e); }
    expect(handErr, 'a hand-authored regex was refused by the model screen on edit').not.toMatch(/search expression/);
  });

  it('G1 — every updateGuardrailRule call site names its provenance literally, and only the assistant says model_authored', () => {
    const files = repoFiles('src', /\.tsx?$/);          // working tree, not index
    const callers: Array<{ file: string; provenance: string }> = [];
    for (const f of files) {
      if (f === 'src/lib/guardrailApi.ts') continue;   // the definition
      const text = readFileSync(f, 'utf8');
      const re = /updateGuardrailRule\([\s\S]*?,\s*'(model_authored|hand_authored)'\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) callers.push({ file: f, provenance: m[1] });
      const loose = (text.match(/\bupdateGuardrailRule\(/g) ?? []).length;
      const tight = (text.match(re) ?? []).length;
      expect(tight, `${f} has an updateGuardrailRule call that does not name its provenance literally`).toBe(loose);
    }
    // Enumerated 2026-08-17: 8 sites — 6 passing no pattern, 2 passing one.
    expect(callers.length, 'no updateGuardrailRule call sites found — the assertions below would be vacuous').toBe(8);
    expect(callers.filter((c) => c.provenance === 'model_authored').map((c) => c.file))
      .toEqual(['src/lib/governanceAiApi.ts', 'src/lib/governanceAiApi.ts', 'src/lib/governanceAiApi.ts']);
  });

  it('G2 — STARTER_GUARDRAILS is driven through the screen, so a trailing pipe in the constant goes RED here', () => {
    // ⚠ NOTHING IN tests/ OR scripts/ MENTIONED THIS CONSTANT. It ships to every
    // tenant that clicks "Install starter guardrails", and a "|" added to one of
    // these two strings would have muted every outbound message in that
    // workspace with the whole suite green.
    const patterned = STARTER_GUARDRAILS.filter((r) => typeof r.pattern === 'string' && r.pattern);
    expect(patterned.length, 'no patterned starter guardrail found — this check would be vacuous').toBe(2);
    for (const r of patterned) {
      const screen = screenGuardrailPattern(r.pattern as string);
      const universal = screen.failures.filter((f) => UNIVERSAL_PATTERN_SCREENS.includes(f.failure));
      expect(universal, `starter guardrail "${r.rule}" would be refused by an unconditional screen: ${JSON.stringify(universal)}`)
        .toEqual([]);
    }
    // …and the mutation the pin exists to catch really is caught.
    expect(screenGuardrailPattern(`${patterned[0].pattern}|`).failures.map((f) => f.failure))
      .toContain('empty_alternative');
  });
});

// ── J1: THE RPC DOORS, AS AN ALLOWLIST RATHER THAN A SENTENCE ──────────────
//
// The enumeration above sees `.from('guardrail_rules')`. It cannot see SQL, and
// the round-4 comment that named `approve_learned_behavior` and
// `attach_compliance_pack` as "a different perimeter, named in that test rather
// than covered by this one" was accurate about today and worth nothing about
// tomorrow: nothing went red when a fifth appeared, because nothing counted.
//
// THE ONE THAT WAS ALREADY OPEN. SelfLearningPage.tsx renders an <input>
// labelled "Pattern to block (edit before approving)"; approveLearnedBehavior
// passes it as `p_final_pattern`; migration 487's approve_learned_behavior both
// INSERTs a guardrail_rules row with it and UPDATEs an existing row's `pattern`
// with it. Blast radius as measured, not as feared: the INSERT writes
// severity='warning' and both deterministic readers keep severity='blocking'
// only, so that branch mutes nothing; the UPDATE can overwrite a BLOCKING rule,
// but all 3 live de_learned_behavior_clusters rows carry guardrail_rule_id NULL
// and that branch returns 'no_target_rule' first. A code-level hole of exactly
// the shape round 4 closed three times, not a live outage.
describe('the RPC-mediated writers are an explicit allowlist (round 5, J1)', () => {
  /** Every SQL function whose body writes guardrail_rules, attributed to the
   *  function it sits inside, over the WHOLE migration set with comments
   *  stripped. Filename order is replay order (CLAUDE.md), so this is the set of
   *  doors this repository can rebuild — not a transcription of production and
   *  not supabase/baseline/full_schema.sql, which was last regenerated
   *  2026-08-07 and does not contain decide_discovery_proposal at all. */
  const sqlWriters = (() => {
    const found = new Map<string, string[]>();
    let orphanDml = 0;
    for (const f of repoFiles('supabase/migrations', /\.sql$/).sort()) {
      const text = readFileSync(f, 'utf8')
        .split(/\r?\n/).map((l) => l.replace(/--.*$/, '')).join('\n');
      // Function bodies, by their dollar-quoted delimiter, so "inside which
      // function" is a range and not "the nearest CREATE FUNCTION above".
      const bodies: Array<{ name: string; s: number; e: number }> = [];
      for (const m of text.matchAll(/\bcreate\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\(/gi)) {
        const tag = /\$([a-z_]*)\$/i.exec(text.slice(m.index, m.index + 4000));
        if (!tag) continue;
        const s = m.index + tag.index + tag[0].length;
        const e = text.indexOf(tag[0], s);
        if (e === -1) continue;
        bodies.push({ name: m[1].toLowerCase(), s, e });
      }
      for (const w of text.matchAll(/\b(insert\s+into|update|delete\s+from)\s+(?:public\.)?guardrail_rules\b/gi)) {
        const owner = bodies.find((b) => w.index > b.s && w.index < b.e);
        if (!owner) { orphanDml += 1; continue; }
        if (!found.has(owner.name)) found.set(owner.name, []);
        found.get(owner.name)!.push(f.replace('supabase/migrations/', ''));
      }
    }
    return { names: [...found.keys()].sort(), found, orphanDml };
  })();

  it('the SQL writers of guardrail_rules are exactly these NINE — RED on a tenth, wherever the migration puts it', () => {
    // ⚠ THE LIST IS THE ASSERTION. A new SECURITY DEFINER function that writes
    // this column arrives here as a new name, and a name nobody has decided
    // about is a red test rather than a paragraph somebody remembers to update.
    // Enumerated 2026-08-17 over 775 migration files (tracked + untracked).
    expect(sqlWriters.names).toEqual([
      'approve_learned_behavior',            // ⚠ takes a caller-supplied pattern
      'attach_compliance_pack',              // pack key only; patterns are pack rows
      'attach_compliance_pack_internal',     // ditto (mig 747 split)
      'detach_compliance_pack',              // deletes pack rows
      'install_role_kit',                    // kit key only; patterns are kit constants
      'provision_tenant_baseline_internal',  // server-side baseline, no caller input
      'restore_guardrail_rule',              // flips retired_at/active
      'retire_guardrail_rule',               // flips retired_at/active
      'verify_decide_discovery_proposal',    // mig 751's own probe, rolled back
    ]);
    // Vacuity: an attribution that stopped working would return an empty list,
    // which is indistinguishable from "no SQL writes this table".
    expect([...sqlWriters.found.values()].flat().length,
      'the SQL scan attributed no writes at all, so the list above proves nothing')
      .toBeGreaterThanOrEqual(15);
    // Top-level DML in a migration is a one-shot data change, not a callable
    // door, so it is counted and reported rather than pinned — pinning it would
    // turn every future seed row into a red test about the wrong thing.
    expect(sqlWriters.orphanDml, 'the scan lost its ability to tell body DML from top-level DML')
      .toBeGreaterThanOrEqual(1);
  });

  it('the CLIENT doors onto those functions are exactly these SEVEN — RED on an eighth `.rpc()` into a guardrail writer', () => {
    // The other half: a SQL door nobody can call is not a door. This is the
    // enumeration the round-4 comment made in prose.
    const doors: string[] = [];
    for (const f of repoFiles('src supabase/functions scripts')) {
      const raw = readFileSync(f, 'utf8');
      for (const name of sqlWriters.names) {
        const re = new RegExp(`\\.rpc\\(\\s*['"\`]${name}['"\`]`, 'g');
        for (const _ of raw.matchAll(re)) doors.push(`${f} -> ${name}`);
      }
    }
    expect(doors.sort()).toEqual([
      'scripts/golden-path.mjs -> install_role_kit',
      'src/lib/deWorkbenchApi.ts -> attach_compliance_pack',
      'src/lib/deWorkbenchApi.ts -> detach_compliance_pack',
      'src/lib/guardrailApi.ts -> restore_guardrail_rule',
      'src/lib/guardrailApi.ts -> retire_guardrail_rule',
      'src/lib/hireApi.ts -> install_role_kit',
      'src/lib/selfLearningApi.ts -> approve_learned_behavior',
    ]);
  });

  it('the one door that carries a caller-supplied pattern SCREENS it — RED if approveLearnedBehavior stops calling the writer\'s own screen', async () => {
    // Behavioural. screenPatternForWrite runs before supabase.rpc(), so this
    // rejects with no network round trip — the same property that lets the three
    // PostgREST writers be driven here.
    await expect(approveLearnedBehavior('00000000-0000-0000-0000-000000000001', 'refund|'))
      .rejects.toThrow(/nothing beside it/);
  });

  it('…and it screens as HAND-AUTHORED, so the metacharacter concession survives — RED if the provenance is restated instead of imported', () => {
    // The inversion, on the shared screen rather than through the RPC, because
    // an accepted pattern would go to the network and this file never does.
    // 'hand_authored' is not a preference: a person edits this field, and the
    // same regexes Company Setup ships would otherwise be refused here.
    expect(() => screenPatternForWrite('guarantee[d]? (delivery|ship)', 'hand_authored')).not.toThrow();
    expect(() => screenPatternForWrite('guarantee[d]? (delivery|ship)', 'model_authored')).toThrow(/search expression/);
    expect(() => screenPatternForWrite('refund|', 'hand_authored')).toThrow(/nothing beside it/);
    // And the ordering, by index: a screen after the RPC would leave the row
    // written and the refusal beside it.
    const src = readFileSync('src/lib/selfLearningApi.ts', 'utf8');
    const at = src.indexOf('export async function approveLearnedBehavior');
    expect(at, 'could not locate approveLearnedBehavior').toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('\n}', at));
    expect(body.length).toBeGreaterThan(120);
    const screenAt = body.indexOf('screenPatternForWrite');
    const rpcAt = body.indexOf('supabase.rpc(');
    expect(screenAt, 'approveLearnedBehavior no longer screens at all').toBeGreaterThan(-1);
    expect(rpcAt, 'could not find the RPC call — the ordering assertion would be vacuous').toBeGreaterThan(-1);
    expect(screenAt).toBeLessThan(rpcAt);
    // The rule is imported, not restated — one provenance rule, four doors.
    expect(body, 'the provenance is decided somewhere other than the writer that owns it')
      .toContain("screenPatternForWrite(finalPattern, 'hand_authored')");
  });
});

// ── J4: THE RESOLVER SHAPE, PINNED INSTEAD OF DESCRIBED ────────────────────
//
// `guardrail_rules_for_de` is the sole resolver behind loadBlockingRules and
// loadBlockingRulesForJudge, and therefore behind all four enforcement paths.
// Its shape is stated in prose in several places in this repository and, before
// this block, was asserted by nothing. Precisely: tests/action-gate.test.ts
// does name it — it asserts the resolver is CALLED inside decide_de_action
// before permission is granted (:542) and drives a live employee-scoped rule to
// prove it does not leak to a sibling employee (:515) — but nothing anywhere
// asserted the SHAPE: how many arms it has, that each non-workspace arm guards
// its own parameter, or that it never reads applies_to. The header in
// src/lib/discoveryApi.ts
// carries its own correction notice ("corrected 2026-08-17 … describing a
// four-arm resolver as a two-arm one is exactly the class of error that
// produced B1"), which is the evidence that a hand-maintained description of
// this function has already drifted at least once. A description corrected by
// hand is a description that will be wrong again.
//
// Filename order is replay order, so the LAST migration that redefines the
// function is what production runs. Everything below is read out of that file.
describe('the guardrail resolver has FOUR scope arms and reads no applies_to (round 5, J4)', () => {
  const resolver = (() => {
    const migs = repoFiles('supabase/migrations', /\.sql$/).sort();
    const re = /create\s+or\s+replace\s+function\s+(?:public\.)?guardrail_rules_for_de\s*\(/i;
    const file = [...migs].reverse().find((f) => re.test(readFileSync(f, 'utf8')));
    if (!file) return null;
    const text = readFileSync(file, 'utf8');
    const m = re.exec(text)!;
    const tag = /\$([a-z_]*)\$/i.exec(text.slice(m.index, m.index + 2000));
    if (!tag) return null;
    const s = m.index + tag.index + tag[0].length;
    const e = text.indexOf(tag[0], s);
    return e === -1 ? null : { file, body: text.slice(s, e) };
  })();

  it('the live definition was found and is real SQL — RED if it stops being findable, which would make every assertion below vacuous', () => {
    expect(resolver, 'no migration defines guardrail_rules_for_de').toBeTruthy();
    expect(resolver!.body.length).toBeGreaterThan(200);
    expect(resolver!.body).toContain('from guardrail_rules');
    expect(resolver!.body).toContain('g.tenant_id = p_tenant_id');
    // Named so a reader can go and look, and so a NEWER redefinition landing in
    // a later migration shows up here as a changed filename rather than
    // silently rebasing every assertion below onto different SQL.
    expect(resolver!.file).toBe('supabase/migrations/726_a_guardrail_can_be_retired_and_the_page_says_what_is_enforced.sql');
  });

  const arms = () => [...(resolver?.body ?? '').matchAll(/g\.scope\s*=\s*'(\w+)'/g)].map((m) => m[1]);

  it('exactly FOUR arms, in this order — RED on a fifth added in SQL alone', () => {
    expect(arms()).toEqual(['workspace', 'employee', 'department', 'playbook']);
  });

  it('every non-workspace arm requires its own parameter to be non-null — RED if one of them starts matching on scope_ref alone', () => {
    // Without these, a NULL p_de_id would make `g.scope_ref = p_de_id::text`
    // null rather than false — still not a match, but a `coalesce` or an `is not
    // distinct from` added later would turn the arm into "every employee-scoped
    // rule in the tenant". The conjuncts are what make that a code change
    // somebody has to argue for.
    expect(resolver!.body).toContain("g.scope = 'employee'   and p_de_id is not null");
    expect(resolver!.body).toContain("g.scope = 'department' and p_de_id is not null");
    expect(resolver!.body).toContain("g.scope = 'playbook'   and p_playbook_def_id is not null");
    // THREE, not four: `g.retired_at is null` is `is null` and does not count
    // here. (Measured — the first version of this line said four and went red,
    // which is the whole argument for pinning a shape instead of describing it.)
    expect((resolver!.body.match(/is not null/g) ?? []).length,
      'a non-null parameter guard was dropped, or a fourth appeared unexplained')
      .toBe(3);
  });

  it('the resolver does not read applies_to ANYWHERE — RED the moment it does, because four comments are built on that fact', () => {
    // src/lib/discoveryApi.ts's accept header, its reuse-find comment, the F3
    // block above and src/lib/discoveryProposalPresentation.ts all reason from
    // "applies_to is displayed, scope is enforced". If that stops being true
    // every one of them becomes a false sentence at once.
    expect(resolver!.body).not.toContain('applies_to');
    expect(resolver!.body, 'the resolver stopped filtering on active/retired, which every reader assumes').toContain('g.active');
    expect(resolver!.body).toContain('g.retired_at is null');
  });

  it('the PROSE and the TYPE carry the same four arms as the SQL — RED if a fifth arm is added and only the SQL is updated', () => {
    // This is the ratchet the comment never had. discoveryApi.ts's header spells
    // the arms out; guardrailApi.ts's GuardrailScope union is what the UI types
    // against. A fifth arm in SQL turns both of these red, which is the only way
    // a hand-maintained description stops drifting.
    const discovery = readFileSync('src/lib/discoveryApi.ts', 'utf8');
    const prose = [...discovery.matchAll(/g\.scope = '(\w+)'/g)].map((m) => m[1]);
    expect(prose, 'the accept header no longer lists the resolver arms').toEqual(arms());
    expect(discovery, 'the header stopped saying how many arms there are').toContain('FOUR arms');

    const scopeType = /export type GuardrailScope =([^;]+);/.exec(readFileSync('src/lib/guardrailApi.ts', 'utf8'))?.[1];
    expect(scopeType, 'GuardrailScope could not be read').toBeTruthy();
    const declared = [...scopeType!.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
    expect(declared, 'GuardrailScope and the resolver disagree about what scopes exist')
      .toEqual([...arms()].sort());
  });
});

// ── G3(a): FIVE CODE POINTS THAT ARE WHITESPACE TO POSTGRES AND NOT TO JS ───
//
// The behavioural half of the fix lives here; the DIFFERENTIAL that found it —
// and that would find the next one — is not a unit test at all, and cannot be.
// See the F4 block below.
describe('the client refuses the separators Postgres counts as whitespace (round 4, G3)', () => {
  it('all five are refused, for both provenances — RED if the client stops being stricter than the database here', () => {
    expect(PG_ONLY_WHITESPACE.length, 'the exported set shrank').toBe(5);
    for (const ch of PG_ONLY_WHITESPACE) {
      const p = `a${ch}b${ch}c${ch}d${ch}e${ch}f`;
      expect(screenGuardrailPattern(p).failures.map((f) => f.failure),
        `U+${ch.charCodeAt(0).toString(16).padStart(4, '0')} is not screened`)
        .toContain('pg_only_whitespace');
      expect(guardrailAcceptability({ rule: 'x', pattern: p, threshold: null }).ok).toBe(false);
    }
  });

  it('THE MEASURED CASE: one JS word, six Postgres words — RED if looksLikeEnforceablePattern starts calling it enforceable and nothing else refuses it', () => {
    // The predicate the two copies disagree on is the WORD COUNT, and this is
    // why a screen was the fix rather than a re-derivation of Postgres's ctype:
    // to JavaScript this really is one word, and it always will be.
    const p = 'a\u001fb\u001fc\u001fd\u001fe\u001ff';
    expect(p.trim().split(/\s+/).filter(Boolean).length, 'JS still has to see one word, or this case has stopped being the case').toBe(1);
    expect(__looksLikeEnforceablePattern_forDriftTestOnly(p), 'the emission-time predicate is deliberately NOT the place this is caught').toBe(true);
    expect(guardrailAcceptability({ rule: 'x', pattern: p, threshold: null }).ok).toBe(false);
  });

  it('nothing ordinary is caught by it — RED if this became a refuse-everything screen', () => {
    for (const p of ['refund|chargeback', 'free month', 'late fee|penalty', '  refund  ']) {
      expect(screenGuardrailPattern(p.trim()).failures.map((f) => f.failure)).not.toContain('pg_only_whitespace');
    }
  });
});

// ── F4 / G3 / G4 / G5: THE STRUCTURE HERE, THE COMPARISON IN THE DATABASE ───
//
// acceptGuardrailProposal runs the TS gate, then addGuardrailRule — A LIVE
// INSERT — and only then decide_discovery_proposal. So the two copies of the
// predicate are not symmetric:
//
//   SQL LOOSER than TS   → the client refused first and created nothing. Safe.
//   SQL STRICTER than TS → the rule is ALREADY live, blocking and
//                          workspace-wide; the stamp refuses; the proposal
//                          reverts to pending; the reuse-find re-finds the rule
//                          and re-refuses forever. The customer was told "The
//                          rule was created and is switched on now" at the
//                          click and sees only last_error after a reload.
//
// ⚠⚠ THE BEHAVIOURAL HALF OF THIS BLOCK HAS BEEN DELETED, AND THAT IS THE FIX.
// It asserted "no pattern exists where TS accepts and the SQL refuses" against a
// JAVASCRIPT RE-IMPLEMENTATION of the SQL predicate whose parameters it read out
// of the migration text. That is exam-vs-production evidence in its purest form:
// a transcription can only ever prove that it agrees with itself. It did agree
// with itself, over 90 patterns, and reported the invariant HELD. Run against
// LIVE POSTGRES with the predicate lifted out of the same file, the invariant
// was FALSE — 10 patterns where the client accepts and the database refuses,
// because five code points are `\s` to Postgres and are not `\s` to JavaScript
// (PG_ONLY_WHITESPACE, and the G3 block above). A green pin, a false claim, and
// ten live workspace-wide blocking rules waiting to be created through it.
//
// THE COMPARISON NOW LIVES IN scripts/guardrail-predicate-differential.mjs. It
// evaluates the SQL EXPRESSIONS THEMSELVES inside the real database and the REAL
// TypeScript gate through esbuild — neither side a copy — and scripts/certify.mjs
// runs it as the section `guardrail-pattern-differential`. It cannot live in
// vitest: this suite has no database, and a differential that skips when it
// cannot reach one is a checker that cannot fail.
//
// WHAT STAYS HERE IS WHAT A TEXT CAN HONESTLY ANSWER — that the branch is
// findable and that its clauses have not silently multiplied. Round 2 watched
// both of these go GREEN with no pin in the tree:
//     N*  an extra conjunct in the SQL predicate only
//     O*  an extra raise screen in SQL only
describe('the SQL guardrail branch, counted over the WHOLE branch (round 4, G4)', () => {
  const MIGRATION_751 = 'supabase/migrations/751_a_hard_line_the_customer_wrote.sql';

  // ⚠ ONE EXTRACTOR, IMPORTED FROM THE THING THAT RUNS THE REAL COMPARISON.
  // Two extractors would be two opinions about where the branch ends, and where
  // it ended was precisely the defect: the previous copy stopped at
  // `if p_created_object_id is null then`, which left the rule_type refusal, the
  // byte-for-byte pattern refusal, the pack refusal and the five-condition
  // blast-radius arm OUTSIDE every count. Measured: a fifth SQL-only raise added
  // after the pack refusal left the whole file 116/116 GREEN. That uncounted
  // region is exactly where SQL-stricter drift does the damage, because those
  // checks run on a row the client has ALREADY INSERTED — the
  // `p_created_object_id is null` arm is the only one where the client refused
  // first and created nothing.
  const branch = guardrailBranch(readFileSync(MIGRATION_751, 'utf8'));

  it('the branch could be isolated, comments stripped, and it REACHES THE END — RED if it stops being findable, which would make every count below vacuous', () => {
    expect(branch, 'could not isolate the SQL guardrail branch').toBeTruthy();
    expect(branch!.length, 'the branch is no longer than the truncated extraction this replaces').toBeGreaterThan(4000);
    expect(branch!, 'comment stripping removed the code as well').toContain('v_pattern_ok');
    expect(branch!, 'the header prose survived the strip').not.toContain('THE THIRD COPY');
    // …and the previously-uncounted region really is inside it now.
    expect(branch!, 'the extraction still stops before the row checks').toContain('v_rule.compliance_pack_key is not null');
    expect(branch!, 'the extraction stops before the blast-radius arm').toContain('v_rule.retired_at is not null');
  });

  it('the branch has exactly TEN ways to refuse — RED on an eleventh raise added in SQL alone (O*)', () => {
    // FOUR before the created-object arm (threshold-with-no-phrase, prose,
    // metacharacter, empty alternative) and SIX after it (no created id, no such
    // rule in this tenant, wrong rule_type, pattern not byte-identical,
    // pack-owned, and the blast-radius arm). The last six were uncounted, and
    // they are the ones that fire on an already-inserted row.
    const raises = (branch!.match(/raise exception/g) ?? []);
    expect(raises, `expected 10 raise exception statements in the guardrail branch, found ${raises.length}`).toHaveLength(10);
    const screens = (branch!.match(/if v_pattern ~ /g) ?? []);
    expect(screens, `expected 2 post-predicate pattern screens, found ${screens.length}`).toHaveLength(2);
  });

  it('v_pattern_ok has exactly FOUR conjuncts after the null check — RED on a fifth added in SQL alone (N*)', () => {
    const assignment = /v_pattern_ok\s*:=([\s\S]*?);/.exec(branch!)?.[1];
    expect(assignment, 'could not read the v_pattern_ok assignment').toBeTruthy();
    // ` and ` with spaces on both sides: the prose alternation's own "and|" is
    // not a conjunct and does not inflate this.
    const conjuncts = (assignment!.match(/ and /g) ?? []);
    expect(conjuncts, `expected 4 conjuncts (length, punctuation, word count, prose words), found ${conjuncts.length}`).toHaveLength(4);
    expect(assignment!).toContain('v_pattern is not null');
  });

  it('the checks that run on an ALREADY-INSERTED rule are counted too — RED on a sixth comparison or a sixth blast-radius condition (G4)', () => {
    // The region the truncated extraction could not see. FIVE `is distinct from`
    // comparisons — rule_type, pattern, severity, scope, applies_to — and the
    // blast-radius arm is ONE `if` of FIVE conditions, four `or`s, because they
    // are one promise ("blocked for every employee in this workspace").
    const distinct = (branch!.match(/is distinct from/g) ?? []);
    expect(distinct, `expected 5 \`is distinct from\` comparisons, found ${distinct.length}`).toHaveLength(5);
    const arm = /if v_rule\.severity is distinct from[\s\S]*?then/.exec(branch!)?.[0];
    expect(arm, 'could not isolate the blast-radius arm').toBeTruthy();
    const ors = (arm!.match(/\bor\b/g) ?? []);
    expect(ors, `expected 4 \`or\`s (5 conditions) in the blast-radius arm, found ${ors.length}`).toHaveLength(4);
    for (const col of ['severity', 'scope', 'applies_to', 'active', 'retired_at']) {
      expect(arm!, `the blast-radius arm stopped checking ${col}`).toContain(col);
    }
  });

  it('the trim set still does NOT carry the five Postgres-only separators — RED if it grows them, because the client screen would then be over-strict for no reason', () => {
    // Named rather than assumed. Neither JS `.trim()` nor this btrim strips
    // them, which is why the client refuses them outright instead of trying to
    // re-derive Postgres's word splitting in the browser.
    const trimSet = extractPredicate(branch!).trimSet;
    expect(trimSet, 'the explicit trim set could not be read').toBeTruthy();
    for (const ch of PG_ONLY_WHITESPACE as string[]) {
      const escape = `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
      expect(String(trimSet), `the SQL trim set now carries ${escape} — re-measure the client screen`).not.toContain(escape);
    }
  });
});

// ── G3(b): THE DIFFERENTIAL EXISTS, REFUSES TO SKIP, AND SOMETHING RUNS IT ──
//
// A comparison nobody runs is a comparison that does not exist. These are grep
// assertions and they say so: they prove the script is on disk, exports what
// this file imports, fails rather than skips, and is named in certify's section
// list. They do NOT prove it passes — only running it does, which is certify's
// job and this block's whole point.
describe('the live predicate differential exists and is run (round 4, G3)', () => {
  const script = readFileSync('scripts/guardrail-predicate-differential.mjs', 'utf8');
  const certify = readFileSync('scripts/certify.mjs', 'utf8');

  it('it evaluates the SQL in the DATABASE and the gate from SOURCE — RED if either side becomes a transcription again', () => {
    // The two properties whose absence made the old pin worthless.
    expect(script, 'the extracted predicate must be sent to Postgres').toContain('api.supabase.com');
    expect(script, 'the REAL gate must be loaded, not restated').toContain('discoveryProposalPresentation');
    expect(script).toContain('guardrailAcceptability');
    // The predicate text is spliced into the query verbatim, not retyped.
    expect(script).toContain('${pred.okExpr}');
  });

  it('it FAILS when it cannot reach the database, and when the battery loses its teeth — RED if a skip arm appears', () => {
    expect(script, 'a differential that cannot run must not report clean').toContain('if (!res.ok) throw new Error');
    expect(script).not.toMatch(/\breturn\s*\{\s*skipped/);
    for (const arm of ['the battery shrank', 'never disagree anywhere', 'accepted by the client']) {
      expect(script, `the vacuity arm "${arm}" is gone`).toContain(arm);
    }
  });

  it('the battery still carries the class that started this, and enough comparisons — RED if the divergence cases are dropped', () => {
    expect(BATTERY.length, 'the shared battery shrank below the 150 comparisons this was measured over').toBeGreaterThanOrEqual(150);
    const withSeparators = (BATTERY as string[]).filter((p) =>
      (PG_ONLY_WHITESPACE as string[]).some((ch) => p.includes(ch)));
    expect(withSeparators.length, 'the battery no longer contains a single Postgres-only separator, so the differential could not find this class again')
      .toBeGreaterThanOrEqual((PG_ONLY_WHITESPACE as string[]).length * 4);
    // …and the client refuses every one of them — the fix restated as a property
    // of the whole corpus rather than of five hand-picked strings.
    const accepted = withSeparators.filter((p) =>
      guardrailAcceptability({ rule: 'x', pattern: p, threshold: null }).ok);
    expect(accepted, `the client accepts a pattern carrying a Postgres-only separator: ${JSON.stringify(accepted)}`).toEqual([]);
  });

  it('certify runs it — RED if the section is removed, which would leave the only real comparison unrun', () => {
    expect(certify, 'certify no longer names the differential section').toContain("section('guardrail-pattern-differential'");
    expect(certify).toContain('guardrail-predicate-differential.mjs');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('THE SOP-TEXT COMPOSER EXISTS TWICE — the SQL copy in migration 752 must not drift from sopTextForProcedure', () => {
  // ⚠ WHY THERE ARE TWO, and why the drift is asymmetric.
  //
  // decide_discovery_proposal's `procedure` branch re-composes the SOP text
  // from the payload and requires a `playbook_studies` row whose `sop_text`
  // matches it BYTE FOR BYTE. That check is what stops the accept verifying
  // only the caller's own claims: `key` and `name` are both written by the
  // browser, and the study is written by the drafter's own service-role client
  // from the text it was handed, so it is the one field on that path the
  // browser cannot choose.
  //
  // The ordering makes the two copies asymmetric, exactly as 751's pattern
  // predicate is:
  //     acceptProcedureProposal (src/lib/discoveryApi.ts)
  //        1. procedureAcceptability + sopTextForProcedure   <- this copy
  //        2. draftPlaybookFromSop  -> a MODEL CALL and a real draft row
  //        3. decide_discovery_proposal                      <- the SQL copy
  //   SQL LOOSER than TS   -> the client refused first and drafted nothing. Safe.
  //   SQL STRICTER than TS -> the draft exists, the stamp refuses, the proposal
  //                           reverts to pending, and every retry re-finds the
  //                           same draft and re-refuses. Milder than 751's stuck
  //                           guardrail — an inert draft, not a live blocking
  //                           rule — but the same permanent shape.
  //
  // This is a SOURCE-TEXT comparison, not a behavioural one: vitest cannot
  // reach Postgres. What it proves is that the two copies say the same thing.
  // Migration 752's probe 16 drives the SQL copy against a payload whose
  // expected SOP text is written out as a literal, so the composer has an
  // independent oracle in production as well as this structural one here.
  const MIGRATION = 'supabase/migrations/752_a_procedure_the_customer_described.sql';
  const file = readFileSync(MIGRATION, 'utf8');

  /** The `procedure` branch, comment-stripped. Same discipline as
   *  guardrailBranch: these are assertions about CODE, and the branch's own
   *  prose quotes every one of its checks, so a toContain against the raw file
   *  would be satisfiable by a paragraph. */
  const start = file.indexOf("      when 'procedure' then");
  const end = file.indexOf('      -- ---- every other kind', start);
  const sql = start >= 0 && end > start
    ? file.slice(start, end).replace(/--[^\n]*/g, '')
    : '';

  it('the branch was isolated and stripped before anything below compared against it — RED if the extractor stops finding it, which would make every assertion here vacuous', () => {
    expect(sql.length, 'the procedure branch could not be isolated from the migration').toBeGreaterThan(1500);
    expect(sql, 'comment stripping took the code with it').toContain('v_sop :=');
    expect(sql, 'the header prose survived the strip, so these are not code assertions').not.toContain('THE CONSENTED LITERAL, COMPOSED');
  });

  it('the SQL composes name / "Runs when: " / "Steps:" / "- " in that order — RED the moment either copy changes shape, because the two are compared byte for byte', () => {
    expect(sql, 'the trigger label').toContain("'Runs when: ' || v_proc_trig");
    expect(sql, 'the steps label').toContain("'Steps:'");
    expect(sql, 'the bullet').toContain("'- ' || x");
    const out = sopTextForProcedure({
      name: 'Chase an overdue invoice',
      trigger: 'an invoice goes 14 days past due',
      steps: ['Check the account', 'Send the first reminder'],
    });
    expect(out).toBe(
      'Chase an overdue invoice\n\nRuns when: an invoice goes 14 days past due\n\nSteps:\n- Check the account\n- Send the first reminder',
    );
    // the blank-line separators, which are the easiest thing to lose silently
    expect(sql, 'the two blank-line separators').toContain("E'\\n\\n'");
    expect(out.split('\n\n').length, 'three sections separated by blank lines').toBe(3);
  });

  it('the SQL trims name, trigger and every step with an EXPLICIT whitespace set, not one-argument btrim — RED the moment the one-argument form comes back', () => {
    // One-argument btrim strips SPACES ONLY. Against a byte-for-byte
    // comparison that is not a mismatched literal, it is a draft that can never
    // be stamped: the client trims a tab away, the SQL keeps it, and the
    // provenance check refuses a perfectly correct draft on every retry.
    expect(sql).not.toContain("btrim(v_p.payload ->> 'name')");
    expect(sql).not.toContain("btrim(v_p.payload ->> 'trigger')");
    expect(sql).toContain("btrim(v_p.payload ->> 'name',");
    expect(sql).toContain("btrim(v_p.payload ->> 'trigger',");
    expect(sql, 'the steps are trimmed with the same set').toContain('btrim(s,');
  });

  it('the SQL whitespace set on the composer is the SAME one 751 uses on the pattern — RED if the two migrations ever carry different sets', () => {
    const here = /btrim\(v_p\.payload ->> 'name',\s*E'([^']+)'\)/.exec(sql)?.[1];
    const there = /btrim\(v_p\.payload ->> 'pattern', E'([^']+)'\)/
      .exec(readFileSync('supabase/migrations/751_a_hard_line_the_customer_wrote.sql', 'utf8'))?.[1];
    expect(here, 'the explicit whitespace set on the name trim').toBeTruthy();
    expect(there, "751's set, for comparison").toBeTruthy();
    expect(String(here).length, 'vacuity: a set this short is not the real one').toBeGreaterThan(20);
    expect(here, 'the two migrations carry different whitespace sets').toBe(there);
  });

  it('a whitespace-padded payload composes to the SAME text the SQL will compare against — RED if the two trims ever disagree', () => {
    for (const pad of ['\t', '\n', '\r', '\f', '\v', '\u00a0', '\u2003', '\u3000', '\ufeff', ' ']) {
      const out = sopTextForProcedure({
        name: `${pad}Chase an overdue invoice${pad}`,
        trigger: `${pad}an invoice goes 14 days past due${pad}`,
        steps: [`${pad}Check the account${pad}`, `${pad}Send the first reminder${pad}`],
      });
      expect(out, `padded with ${JSON.stringify(pad)}`).toBe(
        'Chase an overdue invoice\n\nRuns when: an invoice goes 14 days past due\n\nSteps:\n- Check the account\n- Send the first reminder',
      );
    }
  });

  it('blank and non-string steps are DROPPED on both sides — RED if one copy keeps a bullet the other does not', () => {
    expect(sql, 'the SQL drops entries that trim to empty').toContain('is not null)');
    const out = sopTextForProcedure({
      name: 'Chase an overdue invoice',
      trigger: 'an invoice goes 14 days past due',
      steps: ['Check the account', '   ', '', null as unknown as string, 42 as unknown as string, 'Log it'],
    });
    expect(out).toBe(
      'Chase an overdue invoice\n\nRuns when: an invoice goes 14 days past due\n\nSteps:\n- Check the account\n- Log it',
    );
  });

  it("the 40-character floor is in BOTH copies and is the drafter's own — RED if either side stops refusing a description playbook-draft rejects with an HTTP 400", () => {
    expect(sql, 'the SQL floor').toContain('length(v_sop) < 40');
    const shortPayload = { name: 'Do it', trigger: 'now', steps: ['go'] };
    expect(sopTextForProcedure(shortPayload).length).toBeLessThan(40);
    const short = procedureAcceptability(shortPayload);
    expect(short.ok, 'a 34-character description').toBe(false);
    expect(short.reason).toMatch(/not enough written down/i);
    // THE INVERSION: over the floor is accepted, so the refusal above is about
    // the length and not about the shape of the payload.
    const longPayload = {
      name: 'Chase an overdue invoice',
      trigger: 'an invoice goes 14 days past due',
      steps: ['Check the account'],
    };
    expect(sopTextForProcedure(longPayload).length).toBeGreaterThanOrEqual(40);
    expect(procedureAcceptability(longPayload).ok).toBe(true);
  });

  it('the deterministic key is derived from the proposal id and matches the SQL construction — RED if a retry could mint a SECOND playbook', () => {
    expect(sql, 'the SQL key construction').toContain("'discovery_' || replace(v_p.id::text, '-', '')");
    // 10 + 32 = 42 characters, all [a-z0-9_] — the shape every other key in
    // playbook_definitions uses, and short of any length limit on the column.
    expect(procedureDraftKey('a1b2c3d4-1111-2222-3333-444455556666'))
      .toBe('discovery_a1b2c3d4111122223333444455556666');
    expect(procedureDraftKey('a1b2c3d4-1111-2222-3333-444455556666')).toHaveLength(42);
    expect(procedureDraftKey('a1b2c3d4-1111-2222-3333-444455556666')).toMatch(/^discovery_[0-9a-f]{32}$/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the procedure CARD says only things the accept makes true (migration 752)', () => {
  const payload = {
    name: 'Chase an overdue invoice',
    trigger: 'an invoice goes 14 days past due',
    steps: ['Check the account', 'Send the first reminder'],
  };

  it('names the procedure the customer agreed to — RED if the title stops carrying the payload name, which is the only handle they are given for it', () => {
    expect(cardCopyFor('procedure', payload).title).toBe('Draft the "Chase an overdue invoice" procedure');
  });

  it("does not present the trigger as something that will fire — RED if 'Trigger:' comes back, because playbook-draft writes trigger_type='manual' on every draft and nothing schedules the customer's sentence", () => {
    const copy = cardCopyFor('procedure', payload);
    expect(copy.meta, 'the card must not claim a trigger the row does not carry').not.toMatch(/^Trigger:/);
    expect(copy.meta).toContain('an invoice goes 14 days past due');
    expect(copy.meta).toMatch(/when you said it should run/i);
  });

  it('says the steps are DRAFTED from the words rather than copied — RED if that disappears, because the compiler may merge, split or reorder them and a person would skim a draft they believed was a transcription', () => {
    expect(cardCopyFor('procedure', payload).nudge).toMatch(/drafted from your words, not copied/i);
  });

  it('keeps the publish gate, which is the whole safety argument — RED if the detail sentence stops saying nothing runs until publish', () => {
    expect(cardCopyFor('procedure', payload).detail).toMatch(/nothing runs until you publish/i);
    expect(whatAcceptingWrites('procedure', payload)).toMatch(/only publishing makes it live/i);
  });

  it('warns that a model does the writing — RED if the accept sentence stops saying so, because this is the ONE accept on this screen that spends the workspace AI budget', () => {
    expect(whatAcceptingWrites('procedure', payload)).toMatch(/AI budget/i);
  });

  it('a payload that cannot be drafted from says CREATES NOTHING — RED if it ever promises a draft it will not produce (the overclaim 751 had to fix on the guardrail card)', () => {
    const empty = { name: 'Chase an overdue invoice', trigger: '', steps: [] };
    expect(whatAcceptingWrites('procedure', empty)).toMatch(/^Creates nothing\./);
    expect(cardCopyFor('procedure', empty).detail).not.toMatch(/nothing runs until you publish/i);
    expect(cardCopyFor('procedure', empty).nudge).toMatch(/Nothing is created/i);
  });
});
