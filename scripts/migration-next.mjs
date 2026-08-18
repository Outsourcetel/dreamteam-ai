#!/usr/bin/env node
// ============================================================================
// migration-next.mjs — claim the next migration number, atomically.
//
//   npm run migrate:next -- the_thing_it_does
//     → creates supabase/migrations/669_the_thing_it_does.sql and prints the path
//
//   npm run migrate:next            # just report the next free number, claim nothing
//
// WHY THIS EXISTS. On 2026-08-10 two agents working the same repo both computed
// "next = 666" from `ls | tail -1` and both wrote a migration 666. Nothing
// collided in production only because git found the two commits
// patch-equivalent. That was luck. The repo already carries **19 duplicate
// number prefixes** from the same mistake made over months (514, 520, 526,
// 540-544, 574-577, …), so this is chronic, not a one-off.
//
// ── WHY NOT TIMESTAMPS (the obvious fix) ───────────────────────────────────
// Because migrations replay in FILENAME ORDER, and `20260810…` sorts BEFORE
// `666…` — '2' < '6'. Switching would drop every new migration into the middle
// of history. The repo's 6 existing timestamp-named files already sit wrongly
// between 1xx and 3xx for exactly this reason. Fixed-width renumbering is worse:
// public.schema_migrations keys on FILENAME, so renaming an applied migration
// turns it into an ORPHANED ledger row plus a PENDING file — 687 of them.
// The number format is load-bearing and cannot move. So fix the CLAIM instead.
//
// ── WHAT "TAKEN" ACTUALLY MEANS ───────────────────────────────────────────
// Three sources disagree, and only their UNION is the truth. On the day this
// was written: local files reached 666, origin/main reached 666, and the
// production ledger already held 667 and 668 — two migrations applied by
// another session that exist in no git tree at all. Anyone computing "next"
// from local files alone would have re-used 667.
//   1. local supabase/migrations/*.sql
//   2. origin/main's copy of that directory  (work pushed but not pulled)
//   3. public.schema_migrations on PRODUCTION (applied, maybe never committed)
//
// ── THE CLAIM IS TAKEN ON PRODUCTION (mig 759) ─────────────────────────────────────────────────
// The three sources above record what has ALREADY HAPPENED — schema_migrations
// only gains a row at APPLY. So between one agent's claim and its apply the
// number exists nowhere the other agent can look: not in their tree (separate
// worktrees, or unpulled), not on origin/main (a branch, or uncommitted), not
// in the ledger (nothing applied yet). On 717 that window was SEVENTEEN
// SECONDS. Four collisions — 669, 715, 717, 754 — every one through it, and
// every time THIS TOOL ANSWERED CORRECTLY. It was never the wrong answer; it
// was the right answer to a question the sources cannot yet see.
//
// So the claim now goes into public.migration_number_claims on PRODUCTION,
// BEFORE the local file is written. Its PRIMARY KEY on num is the mutual
// exclusion: two agents racing cannot both insert 758, and the loser gets zero
// rows back and moves on. That row is visible to every session immediately —
// the one property the other three sources cannot have.
//
// The 'wx' local write is KEPT as a second, weaker gate: it catches a same-tree
// race in the milliseconds before the network round-trip returns.
//
// ⚠ NO PRODUCTION, NO CLAIM. If the ledger is unreachable, claiming REFUSES
// rather than guessing. Reporting still works offline. Claiming without the
// shared resource is precisely the bug.
//
// ⚠ CLAIMS NEVER EXPIRE. A crashed session burns a number, which is cheap —
// gaps are already normal here (335 and 463-464 are missing, nothing cares).
// Auto-expiry would hand a live number to a second agent mid-write. Release a
// stale claim deliberately: npm run migrate:next -- --release 758
// ============================================================================
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const MIG_DIR = 'supabase/migrations';
const PROD_REF = 'rfsvmhcqeiyrxivbmpel';
const slug = process.argv.slice(2).find((a) => !a.startsWith('--'));

const numsOf = (names) => names
  .map((n) => /^(\d{3})_/.exec(n)?.[1])
  .filter(Boolean)
  .map(Number);

// ── 1. local ───────────────────────────────────────────────────────────────
const local = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql'));

// ── 2. origin/main — work pushed by someone else that this tree lacks ──────
let remote = [];
try {
  execSync('git fetch -q origin main', { stdio: 'ignore', timeout: 30_000 });
  remote = execSync(`git ls-tree -r --name-only origin/main -- ${MIG_DIR}`,
    { encoding: 'utf8', timeout: 30_000 })
    .split(/\r?\n/).filter(Boolean).map((p) => p.split('/').pop());
} catch {
  console.error('⚠  could not read origin/main — the number below ignores unpulled work');
}

// ── 3. the PRODUCTION ledger — applied, possibly never committed ──────────
// ⚠ prodQuery THROWS rather than returning null. Every caller decides what an
// unreachable production means for IT: reporting degrades loudly, claiming
// REFUSES. A helper that returned null would let the claim path read "I could
// not ask" as "nothing is claimed" — the exact failure it exists to prevent.
async function prodQuery(sql) {
  const env = readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  if (!line) throw new Error('SUPABASE_ACCESS_TOKEN missing from .env.local');
  const token = line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROD_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 140)}`);
  return JSON.parse(await res.text());
}

let ledger = [];
let prodReachable = true;
try {
  ledger = (await prodQuery('select filename from public.schema_migrations')).map((r) => r.filename);
} catch (e) {
  prodReachable = false;
  // LOUD, never silent: a missed ledger is exactly how 667 would be re-used.
  console.error(`⚠  could not read the production ledger (${String(e).slice(0, 60)}).`);
  console.error('⚠  The number below may collide with a migration already APPLIED but never committed.');
}

// ── 4. OUTSTANDING CLAIMS — the source the other three cannot see (mig 759) ──
// Unreleased rows only: a released claim is a number deliberately handed back.
let claims = [];
let claimsTableLive = false;
if (prodReachable) {
  try {
    claims = await prodQuery('select num, filename, claimed_at, claimed_by from'
      + ' public.migration_number_claims where released_at is null order by num');
    claimsTableLive = true;
  } catch (e) {
    // The table not existing is the pre-759 world, not a failure to report.
    if (!/migration_number_claims/.test(String(e))) throw e;
    console.error('⚠  migration_number_claims is absent — migration 759 is not applied here.');
    console.error('⚠  Claiming falls back to the pre-759 race until it is.');
  }
}

const taken = new Set([
  ...numsOf(local), ...numsOf(remote), ...numsOf(ledger), ...claims.map((c) => Number(c.num)),
]);
const highest = Math.max(0, ...taken);

// ── --release NNN — hand a burned number back, deliberately, with a name on it.
const argv = process.argv.slice(2);
const relIdx = argv.findIndex((a) => a === '--release' || a.startsWith('--release='));
if (relIdx !== -1) {
  const rel = argv[relIdx].includes('=') ? argv[relIdx].split('=')[1] : argv[relIdx + 1];
  const n = Number(rel);
  if (!Number.isInteger(n)) {
    console.error('usage: npm run migrate:next -- --release 758');
    process.exitCode = 1;
  } else if (numsOf(ledger).includes(n)) {
    // Releasing an APPLIED number would invite a second file to take it.
    console.error(`${n} is APPLIED to production — refusing to release it.`);
    process.exitCode = 1;
  } else if (!claimsTableLive) {
    console.error('cannot release: the claims table is unreachable or absent.');
    process.exitCode = 1;
  } else {
    const rows = await prodQuery(
      'update public.migration_number_claims set released_at = now(),'
      + " release_note = 'released by hand via migrate:next --release'"
      + ` where num = ${n} and released_at is null returning num, filename`);
    console.log(rows.length
      ? `released ${n} (was ${rows[0].filename}) — it is free again`
      : `${n} was not an open claim; nothing changed`);
  }
}

// --release is terminal: it never falls through into claiming a number.
const releasing = relIdx !== -1;

// ⚠ NOTHING BELOW CALLS process.exit() ON SUCCESS. The ledger read above leaves
// a keep-alive socket open, and exiting hard while libuv still holds it aborts
// the process — this script reported success and exited **127**, which any
// caller would read as failure. Set process.exitCode and let the loop drain.
if (releasing) {
  // handled above — nothing further to do
} else if (!slug) {
  console.log(`next free migration number: ${String(highest + 1).padStart(3, '0')}`);
  console.log(`  local ${Math.max(0, ...numsOf(local))} · origin ${Math.max(0, ...numsOf(remote))} · prod ledger ${Math.max(0, ...numsOf(ledger))}`);
  console.log(`  (nothing claimed — pass a slug to claim it: npm run migrate:next -- my_change)`);
} else if (!/^[a-z0-9_]+$/.test(slug)) {
  console.error(`slug must be lower_snake_case: got "${slug}"`);
  process.exitCode = 1;
} else {
  // ── CLAIM ON PRODUCTION FIRST, THEN ON DISK ────────────────────────────
  // The order is the whole fix. The production row is what a parallel session
  // can see; the local file is what THIS tree can see. Taking the file first
  // would re-create the window that produced 669, 715, 717 and 754.
  //
  // ⚠ REFUSE RATHER THAN GUESS. Without the claims table there is no shared
  // exclusion, and claiming anyway is exactly the behaviour being fixed. The
  // escape hatch is explicit and has to be typed by a human who has read this.
  if (!claimsTableLive && !argv.includes('--no-shared-claim')) {
    console.error(prodReachable
      ? 'REFUSING TO CLAIM: migration 759 is not applied here, so no shared claim exists.'
      : 'REFUSING TO CLAIM: production is unreachable, so no shared claim can be taken.');
    console.error('A number claimed with nothing holding it on production is the bug this');
    console.error('tool exists to stop — it has cost four duplicates (669, 715, 717, 754).');
    console.error('If you accept that risk deliberately: npm run migrate:next -- <slug> --no-shared-claim');
    process.exitCode = 1;
  } else {
  let claimed = null;
  for (let n = highest + 1; n <= 999 && !claimed; n++) {
    const num = String(n).padStart(3, '0');
    const path = `${MIG_DIR}/${num}_${slug}.sql`;
    // The PRIMARY KEY on num is the mutual exclusion. `on conflict do nothing`
    // + `returning` means the loser gets ZERO ROWS and walks to the next number,
    // without an exception to swallow or a second read to race against.
    if (claimsTableLive) {
      const won = await prodQuery(
        'insert into public.migration_number_claims (num, filename, claimed_by) values ('
        + `${n}, '${num}_${slug}.sql', 'migrate:next')`
        + ' on conflict (num) do nothing returning num');
      if (!won.length) {
        console.error(`  ${num} is claimed on production by another session — trying ${n + 1}`);
        continue;
      }
    }
    try {
      writeFileSync(
        path,
        `-- ${num}_${slug}.sql\n-- ${'='.repeat(74)}\n-- WHY: \n-- ${'='.repeat(74)}\n\nbegin;\n\n\n\ncommit;\n`,
        { flag: 'wx' },
      );
      claimed = path;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      console.error(`  ${num} was taken between the scan and the write — trying ${n + 1}`);
    }
  }
  if (claimed) {
    console.log(claimed);
    if (!claimsTableLive) console.error('⚠  claimed WITHOUT a shared lock — tell the other sessions.');
  } else {
    console.error('no free migration number below 999 — the 3-digit space is exhausted');
    process.exitCode = 1;
  }
  }
}
