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

const unreplayable = [];
for (const f of files) {
  const res = spawnSync(process.execPath, ['scripts/dev-apply.mjs', f, '--dry-run'], { encoding: 'utf8' });
  const ok = res.status === 0;
  console.log(`   ${ok ? '✓' : '✗'} ${f}`);
  if (!ok) {
    const detail = `${res.stdout || ''}${res.stderr || ''}`.trim().split(/\r?\n/).filter(Boolean).slice(0, 4).join('\n     ');
    console.log(`     ${detail}`);
    unreplayable.push(f);
  }
}

if (!unreplayable.length) {
  console.log(`\nall ${files.length} can be replayed into an environment that is not production`);
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
