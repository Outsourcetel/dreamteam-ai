#!/usr/bin/env node
// ============================================================================
// sync-dev-migrations.mjs — bring the DEV project's schema level with
// production by applying only what dev is missing.
//
// WHY THIS EXISTS (register B-6)
// golden-path is the only automated end-to-end proof of the product's core
// loop, it is a CI job on every push, and it runs against DEV. So a green tick
// proves whatever schema dev happens to have. B-6 was closed in August by
// rebuilding dev once from the baseline — and it re-opened within days,
// because dev falls behind the moment anyone applies a migration to
// production, which on this repo is constantly and from several sessions at
// once. A fix that decays back to the defect is not a fix; it is a chore.
//
// This is the chore, automated, and run before golden-path in CI.
//
// ── Why incremental and not the full rebuild ────────────────────────────────
// rebuild-dev-from-baseline.mjs exists and works, but it DROPS dev's public
// schema. Running that on every push would (a) take minutes, (b) race with any
// other CI run or human session touching dev, and (c) restore from
// supabase/baseline/full_schema.sql — a checked-in artefact that is only as
// current as the last restore drill, so a stale baseline would rebuild dev
// into a DIFFERENT wrong state and call it fixed.
//
// Applying the handful of pending files is cheaper, non-destructive, and
// self-correcting. The full rebuild stays the right tool for a large gap,
// which is why this refuses rather than grinds when the gap is large.
//
// ── Set difference, not count difference ───────────────────────────────────
// ⚠ B-6's register pin compares ledger COUNTS. Two ledgers can hold the same
// number of rows and different rows — dev carrying one production never had
// while missing one it does — and the count would read level while dev was
// wrong. This compares the SETS, and reports dev-only rows as an anomaly
// rather than silently netting them off.
//
//   node scripts/sync-dev-migrations.mjs            # report only
//   node scripts/sync-dev-migrations.mjs --apply    # actually apply
// ============================================================================
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const DEV_REF = 'nmuntxrcdksyhsdywpan';
const PROD_REF = 'rfsvmhcqeiyrxivbmpel';

// Above this, applying one-by-one is the wrong tool: the files are not
// individually transactional (many carry their own begin/commit), so a long
// replay that fails halfway leaves dev in a state no one chose. 25 is well
// above normal drift (4-8 in practice) and well below the 136 that made the
// original replay unworkable.
const MAX_INCREMENTAL = 25;

const APPLY = process.argv.includes('--apply');
// ── --best-effort: for CI ───────────────────────────────────────────────────
// Apply everything that CAN apply, report everything that cannot, exit 0.
//
// It exists because neither default is acceptable in a CI job that runs before
// golden-path. Failing on any drift turns CI permanently red — three of the
// migrations in this repo assert on production DATA and can never apply to an
// empty dev, so that red would never clear and would be routed around within a
// week. Warning silently is worse: a check that cannot fail is theatre.
//
// The line this holds: it tolerates an ENVIRONMENT problem (a migration that
// will not replay here) and refuses a REPOSITORY problem (a migration whose
// source is missing — register B-10). The first is a known, named, reported
// gap. The second means main cannot rebuild production, and no run should
// glide past it.
//
// Every unreplayable migration is printed in full AND raised as a GitHub
// annotation, so the shortfall appears on the run summary rather than only in
// a log nobody opens.
const BEST_EFFORT = process.argv.includes('--best-effort');
// Files to step over, named in full. There is deliberately no --skip-all and
// no pattern form: skipping a migration decides what dev is allowed to differ
// from production by, and a decision should have to be typed out.
const SKIP = process.argv.filter((a, i) => process.argv[i - 1] === '--skip');

function env(key, ...files) {
  const fromEnv = process.env[key]?.trim();
  if (fromEnv) return fromEnv;
  for (const f of files) {
    let raw; try { raw = readFileSync(f, 'utf8').replace(/^﻿/, ''); } catch { continue; }
    const line = raw.split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
    if (line) return line.slice(key.length + 1).replace(/^["']|["']$/g, '').trim();
  }
  throw new Error(`${key} not found (env or ${files.join(', ')})`);
}
const TOKEN = env('SUPABASE_ACCESS_TOKEN', '.env.local', '.env.test');

async function run(ref, query) {
  // ⚠ THE ONE CHECK THAT KEEPS THIS OFF PRODUCTION. Every write below passes
  // DEV_REF, but a future edit that threads a ref through a variable would not
  // be obviously wrong at the call site. This is.
  //
  // It gates on the STATEMENT, not on --apply. The first version refused any
  // production call while applying, and immediately refused its own read of
  // production's ledger — which is the whole input. Reading production is
  // required and harmless; writing to it is the thing that must be impossible.
  if (ref === PROD_REF && !/^\s*select\b/i.test(query)) {
    throw new Error('refusing to run a non-SELECT against production — this script exists to sync DEV');
  }
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SQL ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

const ledger = (ref) => run(ref, 'select filename from public.schema_migrations order by filename');

const prod = (await ledger(PROD_REF)).map((r) => r.filename);
const dev = (await ledger(DEV_REF)).map((r) => r.filename);
const devSet = new Set(dev);
const prodSet = new Set(prod);

const pending = prod.filter((f) => !devSet.has(f));
const devOnly = dev.filter((f) => !prodSet.has(f));

console.log(`production ledger: ${prod.length}   dev ledger: ${dev.length}`);
console.log(`dev is missing ${pending.length}; dev holds ${devOnly.length} production does not`);

if (devOnly.length) {
  // Not fatal — dev is where things get tried — but never silent. A dev-only
  // migration means golden-path is proving behaviour production does not have.
  console.log('\n⚠ in dev but NOT in production (golden-path may be proving something production lacks):');
  for (const f of devOnly) console.log(`   ${f}`);
}

if (!pending.length) {
  console.log('\ndev is level with production — nothing to apply');
  process.exit(0);
}

console.log('\npending:');
const missingOnDisk = [];
for (const f of pending) {
  const ok = existsSync(`supabase/migrations/${f}`);
  if (!ok) missingOnDisk.push(f);
  console.log(`   ${f}${ok ? '' : '   *** NO SOURCE ON DISK ***'}`);
}

// This is register B-10 arriving through a different door: production applied
// something whose source is not on this branch. Applying the REST would leave
// dev quietly different from production in exactly the way this script exists
// to prevent, so it stops instead.
if (missingOnDisk.length) {
  console.error(`\n✗ ${missingOnDisk.length} pending migration(s) have no source file. Production applied something this branch does not carry (see register B-10). Recover the files before syncing dev.`);
  process.exit(1);
}

if (pending.length > MAX_INCREMENTAL) {
  console.error(`\n✗ ${pending.length} pending exceeds the incremental limit of ${MAX_INCREMENTAL}. These files are not individually transactional, so a long replay that fails halfway leaves dev in a state nobody chose. Use: node scripts/rebuild-dev-from-baseline.mjs --confirm`);
  process.exit(1);
}

if (!APPLY) {
  console.log('\n(report only — pass --apply to apply these to dev)');
  process.exit(pending.length ? 1 : 0);
}

let applied = 0;
const skipped = [];
const unreplayable = [];
for (const f of pending) {
  // Re-read dev's ledger per file rather than trusting the snapshot taken at
  // start: another CI run or session may be applying the same backlog right
  // now. This narrows the race; it does not abolish it, and pretending
  // otherwise would be the kind of claim this repo keeps paying for.
  const [{ n }] = await run(DEV_REF, `select count(*)::int as n from public.schema_migrations where filename = '${f.replace(/'/g, "''")}'`);
  if (n > 0) { console.log(`   skip ${f} (already in dev — applied by someone else since this run started)`); continue; }

  if (SKIP.includes(f)) { console.log(`   SKIP ${f} (named on --skip; dev will stay behind production by this one)`); skipped.push(f); continue; }

  console.log(`   apply ${f}`);
  try {
    // ⚠ DELEGATED, NOT REIMPLEMENTED. scripts/dev-apply.mjs (added by a
    // parallel session the same day) already applies one migration to dev and
    // records it — through the SAME record_migration_applied() RPC production
    // uses, so certify's checksum section compares like with like. The first
    // version of this script did its own apply plus a raw INSERT into
    // schema_migrations, which was a second definition of "applied to dev" and
    // a worse one. This repo has paid for two-paths-one-counted before.
    const res = spawnSync(process.execPath, ['scripts/dev-apply.mjs', `supabase/migrations/${f}`], { encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`${(res.stderr || '').trim() || (res.stdout || '').trim()}`);
  } catch (e) {
    // ⚠ THE INTERESTING FAILURE, and worth naming rather than dumping a stack.
    // A migration whose assertions read LIVE DATA cannot be replayed anywhere
    // that lacks that data — not dev, not a restored backup, not a new
    // environment. 778 is the worked example: it fails here on "found no
    // tenant with two distinctly named non-assistant employees" and "the
    // live-corpus replay saw ZERO pending escalations", both of which are
    // facts about production's rows, not about the schema it installs.
    //
    // Stopping is correct. Applying the REST silently would leave dev in a
    // state nobody chose, and skipping must be a decision somebody made.
    const msg = String(e.message).slice(0, 500);
    if (BEST_EFFORT) {
      // Recorded, announced, and carried on from — never swallowed.
      unreplayable.push({ file: f, error: msg });
      console.error(`   ✗ ${f} could not be applied to dev`);
      console.error(`     ${msg}`);
      if (process.env.GITHUB_ACTIONS) {
        console.log(`::warning title=dev is behind production::${f} could not be applied to dev — ${msg.replace(/\r?\n/g, ' ').slice(0, 300)}`);
      }
      continue;
    }
    console.error(`\n✗ ${f} failed against dev.`);
    console.error(`  ${msg}`);
    console.error(`\n  If this migration asserts on PRODUCTION DATA it can never be replayed into an empty`);
    console.error(`  environment, and that is a defect in the migration, not in this sync. Re-run with`);
    console.error(`  --skip ${f}   to proceed past it deliberately — dev then stays behind by that one,`);
    console.error(`  which is the honest state rather than a green tick over a gap.`);
    process.exit(1);
  }
  applied += 1;
}

const after = (await ledger(DEV_REF)).length;
console.log(`\napplied ${applied}; dev ledger now ${after} vs production ${prod.length}`);

if (unreplayable.length) {
  // The whole point of --best-effort is that this paragraph gets printed. A
  // run that applies 1 of 4 and says nothing is the failure mode; a run that
  // applies 1 of 4 and says which 3 it could not, and why, is a report.
  console.log(`\n⚠ ${unreplayable.length} migration(s) could NOT be applied to dev:`);
  for (const u of unreplayable) console.log(`   ${u.file}`);
  console.log('\nThese are almost always migrations whose assertions read production DATA rather than');
  console.log('schema, so they cannot apply to an environment without that data — and by the same');
  console.log('token they cannot be replayed into a restored backup or a new environment either.');
  console.log('That is a defect in those migrations, not in this sync. Register B-6 stays open.');
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::warning title=golden-path is proving a stale schema::dev is ${prod.length - (await ledger(DEV_REF)).length} migration(s) behind production; ${unreplayable.length} could not be applied. See register B-6.`);
  }
}

if (skipped.length) {
  // Reported as a shortfall, never netted away. The point of this script is
  // that golden-path stops proving a schema nobody chose; a skip means it is
  // still proving one, just by a smaller and known margin.
  console.log(`\nSKIPPED ${skipped.length} deliberately: ${skipped.join(', ')}`);
}

if (skipped.length || unreplayable.length) {
  console.log('\ndev is NOT level with production. That is the accurate state.');
  // Exit 0 under --best-effort so the golden-path job still runs against the
  // closest dev we could get it to; non-zero otherwise so a human invocation
  // still fails loudly.
  process.exit(BEST_EFFORT ? 0 : 1);
}

if (after < prod.length) {
  console.error('✗ dev is still behind after the sync');
  process.exit(1);
}
console.log('dev is level with production');
