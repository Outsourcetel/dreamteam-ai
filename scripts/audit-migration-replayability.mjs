#!/usr/bin/env node
// ============================================================================
// audit-migration-replayability.mjs — a migration must be able to run somewhere
// that is not production.
//
// ── THE DEFECT THIS EXISTS TO STOP ─────────────────────────────────────────
// Three migrations in this repo cannot be applied to an empty environment,
// because their assertions ask production what it CONTAINS rather than asking
// the database what it now IS:
//
//   778  "found no tenant with two distinctly named non-assistant employees"
//   789  "no goal-having employee without an open plan"
//   790  "no row carries disposition=cancelled"
//
// Each is fine against production and fatal anywhere else. The cost is not
// theoretical: dev cannot be brought level by replay, a restored backup cannot
// be verified by replay, and a new environment cannot be built from the
// migration history at all. They also cannot be fixed after the fact — they
// are applied, and public.schema_migrations keys on filename plus checksum, so
// editing the files breaks certify's checksum section.
//
// So the only place to stop the fourth one is before it lands.
//
// ── THE RULE, IN ONE LINE ──────────────────────────────────────────────────
// Assert the ABSENCE OF A VIOLATION, never the PRESENCE OF AN EXAMPLE.
//
//   ✓  if exists (select 1 from t where <the bad thing>) then raise ...
//   ✗  if not exists (select 1 from t where <the good thing>) then raise ...
//
// The first is vacuously true on empty data and still catches every real
// violation. The second demands that production's rows be present to pass, and
// so encodes "I am only ever run once, against one database" — which is the
// one thing a migration must not assume.
//
// Assertions about SCHEMA (pg_proc, pg_indexes, information_schema, a CHECK
// constraint's definition) are always fine: they describe what the migration
// itself installed, which is true everywhere it is applied.
//
// ── HOW IT CHECKS ──────────────────────────────────────────────────────────
// Not by pattern-matching SQL, which would be a guess. It DRY-RUNS each new
// migration against the dev project through scripts/dev-apply.mjs --dry-run,
// which rewrites the transaction to always abort and refuses if a commit
// survives the rewrite. A migration that cannot survive that has proven the
// defect rather than resembled it.
//
// ⚠ This is only meaningful when dev is reasonably current — a migration can
// also fail there because dev is missing something it depends on. CI runs the
// sync immediately before this for that reason.
//
//   node scripts/audit-migration-replayability.mjs                  # vs origin/main
//   node scripts/audit-migration-replayability.mjs --base <ref>
//   node scripts/audit-migration-replayability.mjs --files a.sql,b.sql
// ============================================================================
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const explicit = arg('--files');
const base = arg('--base') ?? 'origin/main';

function newMigrations() {
  if (explicit) return explicit.split(',').map((s) => s.trim()).filter(Boolean);
  // --diff-filter=A: only files this branch ADDS. A migration that already
  // existed is already applied somewhere and is not this branch's to answer
  // for; re-checking it would fail every run on the three known ones and
  // train everybody to ignore the job.
  try {
    const out = execFileSync('git', ['diff', '--name-only', '--diff-filter=A', `${base}...HEAD`, '--', 'supabase/migrations'], { encoding: 'utf8' });
    return out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.endsWith('.sql'));
  } catch {
    console.error(`could not diff against ${base} — pass --base <ref> or --files a.sql`);
    process.exit(2);
  }
}

const files = newMigrations().filter((f) => existsSync(f));

if (!files.length) {
  console.log(`no new migrations against ${base} — nothing to check`);
  process.exit(0);
}

console.log(`checking ${files.length} new migration(s) can run somewhere that is not production:\n`);

// ⚠ NOT EVERY DRY-RUN FAILURE IS THIS DEFECT, and the first version of this
// script accused a migration that was innocent. 798 failed on dev with
// `42883 function public.withdraw_human_tasks(uuid[], text) does not exist` —
// because dev is MISSING 790, which creates it. Nothing about 798 asserts on
// production data; it was reported as unreplayable purely because its
// dependency could not be installed on the environment used to test it.
//
// The discriminator is the SQLSTATE:
//
//   P0001  raise_exception  — the migration's OWN assertion fired. This is the
//                             defect: it demanded rows the environment lacks.
//   42883 / 42P01 / 42703 / 3F000
//          undefined function / table / column / schema — a DEPENDENCY the dev
//          environment does not have. Not this migration's fault, and its
//          author cannot fix it.
//
// A dependency failure is reported as NOT PROVEN and never as a pass, because
// "we could not check this" and "this is fine" must not look the same. But it
// does not fail the gate: blaming an author for someone else's gap is how a
// check gets routed around.
const DEPENDENCY_STATES = /ERROR:\s+(42883|42P01|42703|3F000)/;
const ASSERTION_STATE = /ERROR:\s+P0001/;

const unreplayable = [];
const notProven = [];
for (const f of files) {
  const res = spawnSync(process.execPath, ['scripts/dev-apply.mjs', f, '--dry-run'], { encoding: 'utf8' });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  if (res.status === 0) { console.log(`   ✓ ${f}`); continue; }

  const detail = out.trim().split(/\r?\n/).filter(Boolean).slice(0, 3).join('\n     ');
  if (ASSERTION_STATE.test(out)) {
    console.log(`   ✗ ${f}`);
    console.log(`     ${detail}`);
    unreplayable.push(f);
  } else if (DEPENDENCY_STATES.test(out)) {
    console.log(`   ⏸ ${f}  — NOT PROVEN (dev is missing a dependency, not this migration's doing)`);
    console.log(`     ${detail}`);
    notProven.push(f);
  } else {
    console.log(`   ⏸ ${f}  — NOT PROVEN (dry run failed for a reason this gate does not classify)`);
    console.log(`     ${detail}`);
    notProven.push(f);
  }
}

if (notProven.length) {
  // Said out loud every time. A count of clean results that quietly includes
  // unchecked ones is the "zero findings from zero comparisons" shape.
  console.log(`\n⏸ ${notProven.length} could NOT be checked — dev lacks something they depend on, so this gate proved nothing about them:`);
  for (const f of notProven) console.log(`   ${f}`);
  console.log('   (dev is behind because of the already-applied unreplayable migrations — register B-6)');
}

if (!unreplayable.length) {
  console.log(`\n${files.length - notProven.length} of ${files.length} proven replayable; ${notProven.length} not checked`);
  process.exit(0);
}

console.log(`\n✗ ${unreplayable.length} migration(s) cannot be applied to an empty environment.`);
console.log(`
This is almost always an assertion that asks what production CONTAINS instead
of what the database now IS. Rephrase it to assert the ABSENCE OF A VIOLATION
rather than the PRESENCE OF AN EXAMPLE:

    ✗  if not exists (select 1 from t where <the good thing>) then raise ...
    ✓  if exists     (select 1 from t where <the bad thing>)  then raise ...

The second is vacuously true on empty data and still catches every real
violation. Assertions about SCHEMA — pg_proc, pg_indexes, information_schema,
a constraint definition — are always fine, because they describe what this
migration installed and are true wherever it is applied.

Fix it now: once applied, it cannot be corrected. The ledger keys on filename
plus checksum, so editing the file breaks certify, and migrations 778, 789 and
790 are permanently unreplayable for exactly that reason.`);
if (process.env.GITHUB_ACTIONS) {
  for (const f of unreplayable) {
    console.log(`::error file=${f},title=Migration cannot be replayed::${f} fails a dry run against an environment without production's data. Assert the absence of a violation, not the presence of an example.`);
  }
}
process.exit(1);
