#!/usr/bin/env node
// ============================================================
// sync-dev-columns.mjs — bring the DEV project's existing tables up to the
// production column set, without destroying its data.
//
// WHY THIS EXISTS
// The dev project is a stale schema clone: 97 tables against production's 264,
// and the 97 it HAS are themselves out of date. supabase/baseline/full_schema.sql
// uses CREATE TABLE IF NOT EXISTS, so it happily adds the 167 missing tables but
// silently leaves an existing table with a 2026-06 shape. That fails loudly at
// the foreign-key stage:
//
//   ERROR: column "learned_from_spec_id" referenced in foreign key constraint
//          does not exist  (public.action_definitions)
//
// The obvious fix — drop and recreate the public schema — is the wrong one here.
// Dev holds 33 tenants and 27 auth.users, and those are the fixtures the
// `npm run test:isolation` suite signs in as. Dropping them destroys the only
// automated cross-tenant safety net in the project to save a few minutes.
//
// So this reconciles COLUMNS instead: additive only, ADD COLUMN IF NOT EXISTS,
// nullable, no defaults backfilled and nothing dropped. A column that exists in
// dev but not production is LEFT ALONE and reported — it is either older test
// scaffolding or a sign the two have genuinely diverged, and quietly deleting
// someone's column is not this script's business.
//
//   node scripts/sync-dev-columns.mjs           # report only
//   node scripts/sync-dev-columns.mjs --apply   # emit + run the ALTERs
// ============================================================
import { readFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const PROD = 'rfsvmhcqeiyrxivbmpel';
const DEV = 'nmuntxrcdksyhsdywpan';

function token() {
  const env = readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  if (!line) throw new Error('SUPABASE_ACCESS_TOKEN not found in .env.local');
  return line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
}

async function q(ref, sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

const COLS = `
  select c.relname as tbl, a.attname as col,
         format_type(a.atttypid, a.atttypmod) as type
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and a.attnum > 0 and not a.attisdropped
   order by 1, 2`;

const [prod, dev] = await Promise.all([q(PROD, COLS), q(DEV, COLS)]);

const key = (r) => `${r.tbl}.${r.col}`;
const devSet = new Set(dev.map(key));
const devTables = new Set(dev.map((r) => r.tbl));
const prodSet = new Set(prod.map(key));

// Only tables that ALREADY exist in dev. The missing 167 are full_schema.sql's
// job — creating them here would duplicate it and diverge.
const missing = prod.filter((r) => devTables.has(r.tbl) && !devSet.has(key(r)));
const extra = dev.filter((r) => !prodSet.has(key(r)));

const byTable = missing.reduce((m, r) => ((m[r.tbl] ??= []).push(r), m), {});

console.log(`dev has ${devTables.size} tables · production has ${new Set(prod.map((r) => r.tbl)).size}`);
console.log(`${missing.length} column(s) missing across ${Object.keys(byTable).length} existing dev table(s)\n`);
for (const [tbl, cols] of Object.entries(byTable)) {
  console.log(`  ${tbl}: ${cols.map((c) => `${c.col} ${c.type}`).join(', ')}`);
}
if (extra.length) {
  console.log(`\n${extra.length} column(s) exist in dev but NOT production — left alone, not dropped:`);
  console.log(`  ${extra.slice(0, 12).map(key).join(', ')}${extra.length > 12 ? ` … +${extra.length - 12}` : ''}`);
}

if (!APPLY) { console.log('\n(report only — pass --apply to run the ALTERs)'); process.exit(0); }
if (!missing.length) { console.log('\nnothing to do'); process.exit(0); }

// Nullable and no default: this is a dev clone being reshaped, not a migration.
// A NOT NULL column added to a table with rows needs a default and a backfill
// decision that belongs in a real migration, not in a sync utility.
const sql = Object.entries(byTable)
  .map(([tbl, cols]) => cols.map((c) =>
    `ALTER TABLE public.${JSON.stringify(tbl).replace(/"/g, '"')} ADD COLUMN IF NOT EXISTS "${c.col}" ${c.type};`).join('\n'))
  .join('\n');

await q(DEV, sql);
console.log(`\napplied ${missing.length} ADD COLUMN statement(s) to dev`);
