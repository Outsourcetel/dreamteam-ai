#!/usr/bin/env node
// migration-append-check.mjs — refuse a migration whose verification block
// cannot report what it found.
//
// ⚠ THE DEFECT THIS EXISTS FOR, and why it is worse than an ordinary bug.
//
//   v_bad := v_bad || 'some sentence explaining the failure';
//
// is AMBIGUOUS. Postgres has both `anyarray || anyelement` and
// `anyarray || anyarray`, and an unknown-typed string literal resolves to the
// SECOND — so it tries to parse the sentence as an array literal and raises:
//
//   ERROR: 22P02: malformed array literal: "access text did not classify ..."
//   DETAIL: Array value must start with "{" or dimension information.
//
// PL/pgSQL resolves expression types LAZILY, at first execution. So the
// statement is perfectly fine until the branch actually runs — WHICH IS
// EXACTLY WHEN THE CHECK HAS FOUND SOMETHING. The migration then aborts with a
// type error instead of the finding, and the operator sees a SQL fault where a
// diagnosis should have been. A verification block whose error path breaks
// precisely where it matters is the "checker that cannot fail" trap wearing a
// different coat: this one cannot SPEAK.
//
// PROVEN, not inferred. The exact statement from migration 742 line 334 was
// lifted into a rolled-back DO block with its branch forced to fire: it raised
// 22P02. `array_append(v_bad, '...')` and `v_bad || format(...)` in the same
// block did not. That is why the rule below targets the bare literal only —
// format() returns text explicitly, so those appends were never at risk, which
// is also why only SOME appends in each affected file are counted. An explicit
// `::text` cast is likewise safe.
//
// ⚠⚠ AND THIS PROJECT HAS ALREADY BEEN BITTEN BY IT, IN A LIVE FUNCTION.
// `validate_onboarding_items` returns text[] and builds it this way. Migration
// 685 fixed it in production and migration 693 carries the note verbatim:
//
//     "::text on these four literals is a BUG FIX from mig 685, not a style
//      choice. Without it `text[] || <unknown literal>` resolves to
//      anyarray||anyarray and throws 22P02 instead of appending the message."
//
// So the defect is not theoretical, the fix is known, and it was applied
// FORWARD in a later migration rather than by editing the applied file — the
// same shape this script assumes. The reason this script exists is that the
// lesson did not travel: 685 learned it, and migration 741 — written months
// later and applied the same day as this check — reintroduced it 36 times.
// A fact that lives only in one migration's comment is a fact the next author
// will not have.
//
// ── WHY THE THREE APPLIED MIGRATIONS ARE GRANDFATHERED AND NOT FIXED ────────
// 740, 742 and 743 carry six instances each. They applied cleanly ONLY because
// those branches did not fire — i.e. because nothing was wrong. Rewriting them
// now is the wrong fix twice over: `public.schema_migrations` records a
// checksum taken at apply time, so an edited file makes `migrate:status`
// report DRIFTED, which is a TRUE statement that would then be a lie about the
// cause. An applied migration's file must keep describing what actually ran.
//
// ⚠ SO THIS IS A RATCHET, NOT AN EXEMPTION, and the difference is the whole
// design. The grandfathered files are pinned to an EXACT count. Add a
// nineteenth instance to 742 and this goes red, because 6 != 7 — the exemption
// cannot be used as cover. Remove one and it also goes red, because that means
// an applied migration was edited, which is its own finding.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = 'supabase/migrations';

/** Known debt, pinned to the exact count measured 2026-08-15. NOT a list of
 *  files that may contain the pattern — a list of files whose count may not
 *  change. See the header. */
export const GRANDFATHERED = Object.freeze({
  // Superseded in production: these four define validate_onboarding_items, and
  // migration 685 later redefined it WITH the casts. The live function is
  // safe; the files record what ran at the time and must keep doing so.
  '022_onboarding.sql': 4,
  '076_onboarding_connector_verification.sql': 4,
  '674_a_checklist_item_that_can_act.sql': 4,
  '681_a_verb_this_workspace_cannot_run.sql': 4,
  // Verification blocks only. Applied, and their error paths are broken — the
  // check runs, but if it FINDS something it raises 22P02 instead of saying
  // what. They passed because nothing was wrong, which is not the same as
  // being able to report that nothing was wrong.
  '634_the_knowledge_specialist_can_finally_curate.sql': 3,
  '740_discovery_proposals_can_record_why_a_writer_refused.sql': 6,
  '741_a_proposal_becomes_a_thing_or_says_why_not.sql': 36,
  '742_every_workspace_gets_its_own_topics.sql': 6,
  '743_a_connector_without_a_credential_is_not_a_source.sql': 6,
});

/** Strip line comments and split into statements, so a `||` inside a `--`
 *  explanation (this repo's migrations are heavily commented, and several of
 *  those comments quote the very pattern being banned) is never counted, and a
 *  statement broken across lines still reads as one. Block comments and
 *  dollar-quoted string bodies are NOT parsed — stated rather than hidden; the
 *  consequence is possible FALSE POSITIVES on a `||` inside a quoted body,
 *  which fail loudly and are fixed by rewriting the line, never false
 *  negatives. */
export function statementsOf(sql) {
  const withoutLineComments = sql
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');
  return withoutLineComments.split(';').map((s) => s.trim()).filter(Boolean);
}

/** Every variable this file DECLAREs as text[]. The check is targeted at those
 *  rather than at `|| '` everywhere, because appending a literal to a text
 *  variable is ordinary and correct — it is only an ARRAY on the left that
 *  makes the operator ambiguous. */
export function arrayVarsOf(sql) {
  const vars = new Set();
  const re = /(\w+)\s+text\s*\[\s*\]/gi;
  let m;
  while ((m = re.exec(sql)) !== null) vars.add(m[1].toLowerCase());
  return vars;
}

/** Violations in one file's source. Exported so the mutation harness drives
 *  the SAME function certify calls, rather than a re-implementation of it.
 *
 *  ⚠ THE FIRST VERSION OF THIS FUNCTION WAS WRONG IN BOTH DIRECTIONS, and the
 *  only reason that is known is that it was run against the real 766-file
 *  corpus before being trusted. It:
 *    · MISSED all 18 real instances, because it required a statement to BEGIN
 *      with the assignment. The shipped pattern sits inside `if … then`, so
 *      the statement text starts with `if`. A guard that reports zero on the
 *      exact corpus it was written for is worse than no guard.
 *    · FLAGGED correct code — `array_append(v_labels, v_label || ' (' … )`,
 *      where the `||` is on a TEXT variable inside the append, and
 *      `v_leak || 'x'::text`, where the cast removes the ambiguity entirely.
 *
 *  So the rule is not "an assignment containing `|| '`". It is: THE ARRAY
 *  VARIABLE ITSELF is an operand of `||` whose other operand is an UNCAST
 *  string literal. Both orders, because `'x' || v_bad` is equally ambiguous. */
export function violationsIn(sql) {
  const vars = arrayVarsOf(sql);
  if (vars.size === 0) return [];
  const src = statementsOf(sql).join(';\n');
  const out = [];
  // A SQL string literal, doubled-quote escapes included.
  const LIT = "'(?:[^']|'')*'";
  for (const v of vars) {
    // array || 'literal'   — flagged unless the literal carries a ::text cast
    const rightRe = new RegExp(`\\b${v}\\s*\\|\\|\\s*(${LIT})(\\s*::\\s*\\w+)?`, 'gi');
    // 'literal' || array   — the mirror image, same ambiguity
    const leftRe = new RegExp(`(${LIT})(\\s*::\\s*\\w+)?\\s*\\|\\|\\s*\\b${v}\\b`, 'gi');
    for (const re of [rightRe, leftRe]) {
      let m;
      while ((m = re.exec(src)) !== null) {
        const cast = re === rightRe ? m[2] : m[2];
        if (cast) continue; // `::text` resolves the operator — not at risk
        out.push(`${v} || ${String(m[1]).replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
  }
  return out;
}

export function scan(dir = MIGRATIONS_DIR) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const findings = [];
  let filesScanned = 0;
  let statementsExamined = 0;
  let arrayVarFiles = 0;

  for (const f of files) {
    const sql = readFileSync(join(dir, f), 'utf8');
    filesScanned++;
    statementsExamined += statementsOf(sql).length;
    if (arrayVarsOf(sql).size > 0) arrayVarFiles++;
    const hits = violationsIn(sql);
    const allowed = GRANDFATHERED[f];

    if (allowed === undefined) {
      for (const h of hits) {
        findings.push(`${f}: appends a bare string literal to a text[] — use array_append() — ${h}`);
      }
    } else if (hits.length !== allowed) {
      findings.push(
        hits.length > allowed
          ? `${f}: ${hits.length} bare-literal append(s), pinned at ${allowed}. The grandfathered count is a RATCHET, not permission — new instances must use array_append().`
          : `${f}: ${hits.length} bare-literal append(s), pinned at ${allowed}. Fewer means this APPLIED migration was edited; its file must keep describing what ran. Re-pin here only if the edit was deliberate and migrate:status was checked.`,
      );
    }
  }

  // Every grandfathered entry must still name a real file, or the pin is
  // pointing at nothing and quietly permits the pattern everywhere.
  for (const f of Object.keys(GRANDFATHERED)) {
    if (!files.includes(f)) {
      findings.push(`grandfathered file ${f} no longer exists — remove the pin rather than leaving it aimed at nothing`);
    }
  }

  return { findings, filesScanned, statementsExamined, arrayVarFiles, pinned: Object.keys(GRANDFATHERED).length };
}

// ── CLI ───────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('migration-append-check.mjs')) {
  const r = scan();
  // Report the DENOMINATOR, always. Zero findings over zero comparisons looks
  // exactly like a clean result, and this repo has been bitten by that enough
  // times to make the count non-optional.
  const summary = `migration-append: examined ${r.statementsExamined} statement(s) across ${r.filesScanned} migration(s), ${r.arrayVarFiles} of which declare a text[] variable; ${r.pinned} file(s) pinned to a known count`;
  if (r.arrayVarFiles === 0) {
    console.error(`${summary}\nVACUOUS: no migration declares a text[] variable, so this check compared nothing. Something is wrong with the scanner, not with the migrations.`);
    process.exit(1);
  }
  if (r.findings.length > 0) {
    console.error(`${summary}\n${r.findings.map((f) => `  ✗ ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log(summary);
}
