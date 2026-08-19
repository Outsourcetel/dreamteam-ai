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
import { migrationChecksum } from './migration-committed-check.mjs';

const DEV_REF = 'nmuntxrcdksyhsdywpan';
const PROD_REF = 'rfsvmhcqeiyrxivbmpel';

// Above this, applying one-by-one is the wrong tool: the files are not
// individually transactional (many carry their own begin/commit), so a long
// replay that fails halfway leaves dev in a state no one chose. 25 is well
// above normal drift (4-8 in practice) and well below the 136 that made the
// original replay unworkable.
const MAX_INCREMENTAL = 25;

const APPLY = process.argv.includes('--apply');
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
for (const f of pending) {
  // Re-read dev's ledger per file rather than trusting the snapshot taken at
  // start: another CI run or session may be applying the same backlog right
  // now. This narrows the race; it does not abolish it, and pretending
  // otherwise would be the kind of claim this repo keeps paying for.
  const [{ n }] = await run(DEV_REF, `select count(*)::int as n from public.schema_migrations where filename = '${f.replace(/'/g, "''")}'`);
  if (n > 0) { console.log(`   skip ${f} (already in dev — applied by someone else since this run started)`); continue; }

  if (SKIP.includes(f)) { console.log(`   SKIP ${f} (named on --skip; dev will stay behind production by this one)`); skipped.push(f); continue; }

  const sql = readFileSync(`supabase/migrations/${f}`, 'utf8');
  console.log(`   apply ${f}`);
  try {
    await run(DEV_REF, sql);
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
    console.error(`\n✗ ${f} failed against dev.`);
    console.error(`  ${String(e.message).slice(0, 500)}`);
    console.error(`\n  If this migration asserts on PRODUCTION DATA it can never be replayed into an empty`);
    console.error(`  environment, and that is a defect in the migration, not in this sync. Re-run with`);
    console.error(`  --skip ${f}   to proceed past it deliberately — dev then stays behind by that one,`);
    console.error(`  which is the honest state rather than a green tick over a gap.`);
    process.exit(1);
  }
  await run(DEV_REF, `insert into public.schema_migrations (filename, checksum, applied_at, applied_by, provenance)
    values ('${f.replace(/'/g, "''")}', '${migrationChecksum(sql)}', now(), 'sync-dev-migrations.mjs', 'applied_by_runner')
    on conflict (filename) do nothing`);
  applied += 1;
}

const after = (await ledger(DEV_REF)).length;
console.log(`\napplied ${applied}; dev ledger now ${after} vs production ${prod.length}`);

if (skipped.length) {
  // Reported as a shortfall, never netted away. The point of this script is
  // that golden-path stops proving a schema nobody chose; a skip means it is
  // still proving one, just by a smaller and known margin.
  console.log(`\nSKIPPED ${skipped.length} deliberately: ${skipped.join(', ')}`);
  console.log('dev is NOT level with production, and register B-6 stays open until the skipped migration can be replayed into an empty environment.');
  process.exit(0);
}

if (after < prod.length) {
  console.error('✗ dev is still behind after the sync');
  process.exit(1);
}
console.log('dev is level with production');
