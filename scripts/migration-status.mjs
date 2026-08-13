#!/usr/bin/env node
// ============================================================
// migration-status.mjs — answer "which migrations are applied to production?"
//
// package.json advertised `npm run migrate:status` pointing here for months and
// THIS FILE DID NOT EXIST. That is the same category of thing as a green CI
// tick that ran nothing: a control that reports rather than checks.
//
//   node scripts/migration-status.mjs              # report
//   node scripts/migration-status.mjs --backfill   # seed the pre-ledger history
//   node scripts/migration-status.mjs --dev        # against the dev project
//
// Statuses:
//   APPLIED   recorded by the runner, and the file still hashes the same
//   ASSUMED   predates the ledger (mig 364). Believed applied, never verified.
//   DRIFTED   recorded as applied, but the FILE HAS CHANGED since. Dangerous:
//             what is in the database is not what is in the repository.
//   PENDING   in the repo, not in the ledger — never applied here
//   ORPHANED  in the ledger, not in the repo — the file was deleted or renamed
// ============================================================
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
// The SAME hash db-query.mjs writes into the ledger and certify's
// migration-files-match-ledger-checksums section compares against HEAD. Three
// hand-copied definitions of "the same migration" would agree right up until
// one of them was tidied.
import { migrationChecksum } from './migration-committed-check.mjs';

const DEV = process.argv.includes('--dev');
const BACKFILL = process.argv.includes('--backfill');
const PROJECT_REF = DEV ? 'nmuntxrcdksyhsdywpan' : 'rfsvmhcqeiyrxivbmpel';
const ENDPOINT = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
const MIG_DIR = 'supabase/migrations';

function token() {
  const env = readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  if (!line) throw new Error('SUPABASE_ACCESS_TOKEN not found in .env.local');
  return line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
}

async function q(sql) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

export const checksum = migrationChecksum;

const files = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
const local = new Map(files.map((f) => [f, checksum(readFileSync(join(MIG_DIR, f), 'utf8'))]));

// The ledger may not exist yet on a fresh database — say so plainly instead of
// crashing with a Postgres error the founder cannot read.
const hasLedger = (await q(`select count(*)::int as n from information_schema.tables
                             where table_schema='public' and table_name='schema_migrations'`))[0].n > 0;
if (!hasLedger) {
  console.error(`No migration ledger on ${PROJECT_REF}. Apply supabase/migrations/364_migration_ledger.sql first.`);
  process.exit(2);
}

if (BACKFILL) {
  // Record every file that is not already in the ledger as ASSUMED — believed
  // applied before the ledger existed, never verified. Deliberately does NOT
  // claim applied_at: an invented timestamp would be worse than a null one.
  const rows = [...local.entries()]
    .map(([f, c]) => `('${f.replace(/'/g, "''")}', '${c}', NULL, NULL, 'assumed_pre_ledger')`)
    .join(',\n    ');
  const res = await q(`
    with ins as (
      insert into public.schema_migrations (filename, checksum, applied_at, applied_by, provenance)
      values ${rows}
      on conflict (filename) do nothing
      returning 1)
    select count(*)::int as inserted from ins`);
  console.log(`Backfilled ${res[0].inserted} migration(s) as ASSUMED (pre-ledger, unverified).`);
  console.log('Anything applied from now on is recorded by the runner with a real timestamp.');
  process.exit(0);
}

const ledger = new Map(
  (await q('select filename, checksum, applied_at, provenance from public.schema_migrations order by filename'))
    .map((r) => [r.filename, r]),
);

const buckets = { APPLIED: [], ASSUMED: [], DRIFTED: [], PENDING: [], ORPHANED: [] };
for (const [f, c] of local) {
  const r = ledger.get(f);
  if (!r) buckets.PENDING.push(f);
  else if (r.checksum !== c) buckets.DRIFTED.push(f);
  else if (r.provenance === 'assumed_pre_ledger') buckets.ASSUMED.push(f);
  else buckets.APPLIED.push(f);
}
for (const f of ledger.keys()) if (!local.has(f)) buckets.ORPHANED.push(f);

const label = DEV ? 'DEV' : 'PRODUCTION';
console.log(`\nMigration status — ${label} (${PROJECT_REF})`);
console.log(`${files.length} files in ${MIG_DIR}, ${ledger.size} in the ledger\n`);
console.log(`  APPLIED   ${String(buckets.APPLIED.length).padStart(4)}   recorded by the runner, file unchanged`);
console.log(`  ASSUMED   ${String(buckets.ASSUMED.length).padStart(4)}   predates the ledger — believed applied, never verified`);
console.log(`  DRIFTED   ${String(buckets.DRIFTED.length).padStart(4)}   applied, then the FILE CHANGED`);
console.log(`  PENDING   ${String(buckets.PENDING.length).padStart(4)}   in the repo, never applied here`);
console.log(`  ORPHANED  ${String(buckets.ORPHANED.length).padStart(4)}   in the ledger, no longer in the repo`);

for (const k of ['DRIFTED', 'PENDING', 'ORPHANED']) {
  if (buckets[k].length) {
    console.log(`\n${k}:`);
    buckets[k].forEach((f) => console.log(`  ${f}`));
  }
}
if (buckets.DRIFTED.length) {
  console.log('\nDRIFTED means the database contains a version of that migration that no');
  console.log('longer exists in the repository. Re-applying the current file may not be');
  console.log('idempotent against what actually ran. Inspect before doing anything.');
}
console.log('');

// Exit non-zero on states a human must look at, so this is usable as a CI gate.
process.exit(buckets.DRIFTED.length || buckets.ORPHANED.length ? 1 : 0);
