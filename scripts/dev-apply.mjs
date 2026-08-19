#!/usr/bin/env node
// dev-apply.mjs — apply a migration to the ISOLATED DEV project AND record it
// in dev's ledger, the same way db-query.mjs records production's.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// dev-query.mjs runs SQL and nothing else. It has no ledger handling at all,
// so a migration applied through it takes effect and leaves NO TRACE. That is
// the worst of the available states: dev drifts from production, and the drift
// is invisible to the one query anybody would run to check.
//
// On 2026-08-19 dev was nine migrations behind and nothing said so until
// certify's B-6 arm compared the two ledgers by hand.
//
// The checksum comes from the SHARED migrationChecksum(), and the row is
// written through the SAME record_migration_applied() RPC production uses, so
// certify's migration-files-match-ledger-checksums compares like with like
// rather than two hashes that merely agree today.
//
// ── DRY RUN ────────────────────────────────────────────────────────────────
// --dry-run makes the transaction ALWAYS ABORT, in whichever of the two shapes
// this repo uses: a migration that opens its own transaction has its commit
// swapped for a rollback; a bare one (several exist) is wrapped. Either way it
// REFUSES if a commit survives the rewrite, because a dry run that silently
// commits is the single worst outcome available here.
//
//   node scripts/dev-apply.mjs supabase/migrations/NNN_x.sql --dry-run
//   node scripts/dev-apply.mjs supabase/migrations/NNN_x.sql
//
// ── WHAT IT CANNOT DO ──────────────────────────────────────────────────────
// Several migrations in this repo self-verify against PRODUCTION-SHAPED DATA
// and raise when they do not find it. Dev holds tenant and employee templates
// with no operating data — no conversations, no KPIs, no goals — so those
// migrations cannot apply there at all, and this script will report their
// raise verbatim rather than pretend. That is a property of those migrations,
// not of this tool: a data-dependent assertion inside a migration turns a
// verification concern into a deployment blocker.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { migrationChecksum } from './migration-committed-check.mjs';

// Hardcoded for the same reason db-query.mjs hardcodes production's: a ref
// passed on the command line is a ref that can be typed wrong once.
const PROJECT_REF = 'nmuntxrcdksyhsdywpan';
const ENDPOINT = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

function readToken() {
  const env = readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  if (!line) throw new Error('SUPABASE_ACCESS_TOKEN not found in .env.local');
  return line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
}
const token = readToken();

async function q(query) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
const dryRun = process.argv.includes('--dry-run');
if (!file) {
  console.error('usage: dev-apply.mjs <path-to-migration.sql> [--dry-run]');
  process.exit(2);
}

const name = file.split(/[\\/]/).pop();
const raw = readFileSync(file, 'utf8');
const sum = migrationChecksum(raw);

let sql = raw;
if (dryRun) {
  if (/^commit;$/m.test(raw)) {
    sql = raw.replace(/^commit;$/gm, 'rollback;');
  } else if (/^begin;$/m.test(raw)) {
    console.error('REFUSING: the file opens a transaction it never commits — cannot rewrite it safely.');
    process.exit(3);
  } else {
    sql = `begin;\n${raw}\nrollback;\n`;
  }
  // Belt and braces. Assert the rewrite did what it claims rather than
  // assuming the substitution matched.
  if (/^commit;$/m.test(sql)) {
    console.error('REFUSING: a commit; survived the dry-run rewrite.');
    process.exit(3);
  }
  if (!/^rollback;$/m.test(sql)) {
    console.error('REFUSING: no rollback; in the dry-run text.');
    process.exit(3);
  }
}

const r = await q(sql);
if (!r.ok) {
  console.error(`${dryRun ? 'DRY-RUN FAILED' : 'APPLY FAILED'}  ${name}  HTTP ${r.status}`);
  console.error(r.text.slice(0, 900));
  process.exit(1);
}
console.log(`${dryRun ? 'dry-run ok' : 'applied'}  ${name}`);

if (!dryRun) {
  const rec = await q(`select public.record_migration_applied('${name}', '${sum}', 'dev-apply.mjs') as r`);
  if (!rec.ok) {
    // The migration ran. Failing to record it is exactly the invisible drift
    // this script exists to end, so it is an error, not a warning.
    console.error(`  LEDGER RECORD FAILED for ${name} — dev has the change but does not say so:`);
    console.error(`  ${rec.text.slice(0, 400)}`);
    process.exit(1);
  }
  const parsed = JSON.parse(rec.text)[0]?.r;
  if (parsed?.content_changed_since_last_apply) {
    console.error(`  ⚠ ${name} was applied before with DIFFERENT content — dev may not match this file.`);
  } else if (parsed?.reapplied) {
    console.log('  ledger: re-applied');
  } else {
    console.log('  ledger: recorded');
  }
}
