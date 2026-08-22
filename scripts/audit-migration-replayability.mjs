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
import { existsSync, readFileSync } from 'node:fs';

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

// ══ PRE-FLIGHT: the static sweep ═══════════════════════════════════════════
//
// WHY THIS EXISTS ALONGSIDE THE DRY RUN. The dry run is the stronger check —
// it PROVES the defect rather than resembling it — but it needs credentials and
// a current dev project, so in a CI checkout without secrets it proves nothing
// at all. This half needs neither, and catches the same shape before the file
// is ever applied. Cheap, offline, and it runs first.
//
// WHY IT WAS ADDED. A sweep of the whole corpus on 2026-08-22 found this
// pattern at 99 assertion sites across 57 files — against the THREE this
// script's own header names. The gate never saw them because it only ever
// diffs what the branch ADDS, so a migration stops being checked the moment it
// lands. The historical 57 cannot be repaired (the ledger keys on filename AND
// checksum, so editing an applied file breaks certify's checksum section) —
// which makes "before it lands" the only moment this is fixable, and makes a
// credential-free arm worth having.
//
// SCOPE, deliberately narrow. It reads ONLY apply-time `do $tag$ … $tag$`
// blocks. A `create function … as $tag$ … $tag$` body runs at CALL time and is
// irrelevant to replay — conflating the two was the first wrong answer this
// sweep produced, and it turned 99 real sites into 422 mostly-false ones.
//
// It also skips any DO block doing source surgery (building SQL as a string to
// replace another function's body): the assertions in those live inside string
// literals and are data, not code.
const SCHEMA_SRC = /\b(pg_proc|pg_class|pg_indexes|pg_index|pg_policies|pg_policy|pg_constraint|pg_attribute|pg_type|pg_trigger|pg_namespace|pg_tables|pg_views|pg_matviews|pg_extension|pg_settings|pg_enum|pg_depend|pg_roles|pg_default_acl|information_schema|to_regclass|to_regproc|to_regtype|has_table_privilege|has_function_privilege|has_schema_privilege|pg_get_functiondef|pg_get_expr|pg_get_constraintdef|pg_get_indexdef|obj_description|pg_catalog|cron\.job)\b/i;
const SOURCE_SURGERY = /\b(pg_get_functiondef|array_to_string\s*\(\s*ARRAY|replace\s*\(\s*v_src|v_src\s*:=|v_new\s*:=|v_def\s*:=)\b/i;
const NOT_A_TABLE = new Set(['unnest', 'jsonb_array_elements', 'jsonb_array_elements_text',
  'jsonb_each', 'generate_series', 'regexp_split_to_table', 'string_to_table']);

/** Byte ranges of apply-time DO blocks — NOT function bodies. */
function applyTimeBlocks(src) {
  const out = [];
  const re = /(^|[\s;])do\s+(?:language\s+\w+\s+)?(\$[a-z_]*\$)/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const tag = m[2], s = m.index + m[0].length, e = src.indexOf(tag, s);
    if (e === -1) continue;
    out.push([s, e]);
    re.lastIndex = e + tag.length;
  }
  return out;
}

function staticFindings(file) {
  const src = readFileSync(file, 'utf8');
  const hits = [];
  for (const [s, e] of applyTimeBlocks(src)) {
    const body = src.slice(s, e);
    if (SOURCE_SURGERY.test(body)) continue;
    const baseLine = src.slice(0, s).split('\n').length;
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i], low = raw.toLowerCase();
      if (/^\s*'/.test(raw) || /''/.test(raw)) continue;        // quoted SQL being assembled
      const win = lines.slice(i, i + 4).join(' ').toLowerCase().replace(/\s+/g, ' ');
      if (!/\braise\s+exception/.test(win) || SCHEMA_SRC.test(win)) continue;
      const back = lines.slice(Math.max(0, i - 18), i + 1).join(' ').toLowerCase().replace(/\s+/g, ' ');
      let kind = null;
      if (/\bif\s+not\s+exists\s*\(\s*select/.test(low)) kind = 'if-not-exists → raise';
      else if (/\bif\s+\w+\s+is\s+null\s+then\b/.test(low)
               && /\bselect\b.*\binto\b.*\bfrom\b/.test(back) && !SCHEMA_SRC.test(back)) kind = 'select-into … is null → raise';
      else if (/\bif\s+\w+\s*(=\s*0|<\s*[1-9]\d*|<=\s*0)\s/.test(low)
               && /\bfrom\b/.test(back) && !SCHEMA_SRC.test(back)) kind = 'count must be non-zero → raise';
      if (!kind) continue;
      const tbls = [...back.matchAll(/\bfrom\s+(?:public\.)?([a-z_][a-z0-9_]*)/g)]
        .map((x) => x[1]).filter((t) => !NOT_A_TABLE.has(t));
      if (!tbls.length) continue;
      const tbl = tbls[tbls.length - 1];
      // A lookup PINNED TO A LITERAL IDENTITY cannot be about this migration's
      // own work: an INSERT mints its own uuid, so a hardcoded one names a row
      // that existed before the file ran. Same for a hardcoded tenant slug.
      //
      // ⚠ THIS OVERRIDE EXISTS BECAUSE THE EXEMPTION BELOW LET A REAL ONE
      // THROUGH. Positive-controlling this sweep against seven hand-verified
      // files caught six; 475 escaped, because it happens to
      // `insert into digital_employees` at line 76 and so was exempted at line
      // 156 — where it asserts on the literal uuid 39521a06-…, a production row
      // it certainly does not create. File-level "does it write this table" is
      // too coarse on its own.
      const pinsLiteralIdentity =
        /'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/i.test(back) ||
        /\bslug\s*=\s*'[^']+'/i.test(back);
      // Otherwise: if THIS migration writes the table it asserts on, the rows
      // exist wherever it runs and the assertion is about its own work.
      if (!pinsLiteralIdentity
          && new RegExp(`\\b(insert\\s+into|update)\\s+(public\\.)?${tbl}\\b`, 'i').test(src)) continue;
      hits.push({ line: baseLine + i, kind, table: tbl, text: raw.trim().replace(/\s+/g, ' ').slice(0, 120) });
    }
  }
  return hits;
}

const staticHits = files.flatMap((f) => staticFindings(f).map((h) => ({ file: f, ...h })));
if (staticHits.length) {
  console.log(`✗ ${staticHits.length} apply-time assertion(s) read data the migration does not create:\n`);
  for (const h of staticHits) {
    console.log(`   ${h.file}:${h.line}`);
    console.log(`     [${h.kind}] reads \`${h.table}\`, which this file never writes`);
    console.log(`     ${h.text}`);
  }
  console.log(`
Assert the ABSENCE OF A VIOLATION, never the PRESENCE OF AN EXAMPLE:

    ✗  if not exists (select 1 from t where <the good thing>) then raise ...
    ✓  if exists     (select 1 from t where <the bad thing>)  then raise ...

The second is vacuously true on empty data and still catches every real
violation. The first demands production's rows in order to pass.

⚠ IF YOU ARE HERE BECAUSE A VACUOUS PROOF WOULD BE THEATRE — that is the right
instinct and it has a legal outlet. Build the fixture INSIDE the migration,
assert against it, and roll it back in the same transaction. Non-vacuous AND
replayable. Reaching for production's rows is the one option that is neither.

An assertion about SCHEMA (pg_proc, pg_indexes, information_schema, a constraint
definition) is always fine and is not flagged here — it describes what this
migration itself installed, which is true wherever it runs.`);
  process.exit(1);
}
console.log(`  ✓ static pre-flight: no apply-time assertion reads data it does not create\n`);

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

// ── Why "not proven" is split in two, as of 2026-08-22 ─────────────────────
// A DEPENDENCY failure is a real, bounded statement: the dry run reached dev,
// ran, and dev was missing an object. Not the author's fault, so it does not
// fail the gate — that judgement stands.
//
// The `else` branch was NOT that. It swallowed every other cause, including
// "there are no credentials at all". Measured before this change:
//
//   $ node scripts/audit-migration-replayability.mjs --base HEAD~5
//      ⏸ …841_warm_editorial_surface_family.sql — NOT PROVEN (…does not classify)
//        Error: ENOENT: no such file or directory, open '.env.local'
//      0 of 1 proven replayable; 1 not checked
//      >>> EXIT=0
//
// Zero proven, exit 0 — in a step `.github/workflows/ci.yml` documents as a
// HARD FAIL. "We could not check this" and "this is fine" must not look the
// same, and that principle was already written six lines above; it just was not
// wired to the exit code for the unclassified case.
const unreplayable = [];
const notProvenDependency = [];
const unclassified = [];
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
    notProvenDependency.push(f);
  } else {
    console.log(`   ⚠ ${f}  — NOT CHECKED (the dry run did not reach a verdict this gate can classify)`);
    console.log(`     ${detail}`);
    unclassified.push(f);
  }
}

if (notProvenDependency.length) {
  // Said out loud every time. A count of clean results that quietly includes
  // unchecked ones is the "zero findings from zero comparisons" shape.
  console.log(`\n⏸ ${notProvenDependency.length} could NOT be checked — dev lacks something they depend on, so this gate proved nothing about them:`);
  for (const f of notProvenDependency) console.log(`   ${f}`);
  console.log('   (dev is behind because of the already-applied unreplayable migrations — register B-6)');
}

if (unclassified.length) {
  console.log(`\n✗ ${unclassified.length} migration(s) could not be checked AT ALL, for a reason this gate cannot name:`);
  for (const f of unclassified) console.log(`   ${f}`);
  console.log(`
The commonest cause is that the dry run never reached the dev project —
missing .env.local, no SUPABASE_ACCESS_TOKEN, or a network failure. That is a
WIRING problem, and it must be loud: a gate reporting "0 of 1 proven" while
exiting 0 is the precise shape this repository has paid for before.

Fix the wiring and re-run. If a migration genuinely cannot be classified with
credentials present, say so in the register rather than letting the gate pass.`);
  process.exit(1);
}

if (!unreplayable.length) {
  console.log(`\n${files.length - notProvenDependency.length} of ${files.length} proven replayable; ${notProvenDependency.length} not checked`);
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
