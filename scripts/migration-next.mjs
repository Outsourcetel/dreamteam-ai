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
// ── THE CLAIM IS THE FILE ─────────────────────────────────────────────────
// Created with the 'wx' flag, which fails if the path exists. Two agents racing
// cannot both win: the loser gets EEXIST and takes the next number. Since the
// agents on this repo share one working tree, a file on disk is a claim the
// other one can see — which a computed-but-unwritten number is not.
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
let ledger = [];
try {
  const env = readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  const token = line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROD_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'select filename from public.schema_migrations' }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  ledger = JSON.parse(await res.text()).map((r) => r.filename);
} catch (e) {
  // LOUD, never silent: a missed ledger is exactly how 667 would be re-used.
  console.error(`⚠  could not read the production ledger (${String(e).slice(0, 60)}).`);
  console.error('⚠  The number below may collide with a migration already APPLIED but never committed.');
}

const taken = new Set([...numsOf(local), ...numsOf(remote), ...numsOf(ledger)]);
const highest = Math.max(0, ...taken);

// ⚠ NOTHING BELOW CALLS process.exit() ON SUCCESS. The ledger read above leaves
// a keep-alive socket open, and exiting hard while libuv still holds it aborts
// the process — this script reported success and exited **127**, which any
// caller would read as failure. Set process.exitCode and let the loop drain.
if (!slug) {
  console.log(`next free migration number: ${String(highest + 1).padStart(3, '0')}`);
  console.log(`  local ${Math.max(0, ...numsOf(local))} · origin ${Math.max(0, ...numsOf(remote))} · prod ledger ${Math.max(0, ...numsOf(ledger))}`);
  console.log(`  (nothing claimed — pass a slug to claim it: npm run migrate:next -- my_change)`);
} else if (!/^[a-z0-9_]+$/.test(slug)) {
  console.error(`slug must be lower_snake_case: got "${slug}"`);
  process.exitCode = 1;
} else {
  // ── Claim it. 'wx' fails if the path exists, so a race cannot double-book. ──
  let claimed = null;
  for (let n = highest + 1; n <= 999 && !claimed; n++) {
    const num = String(n).padStart(3, '0');
    const path = `${MIG_DIR}/${num}_${slug}.sql`;
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
  } else {
    console.error('no free migration number below 999 — the 3-digit space is exhausted');
    process.exitCode = 1;
  }
}
