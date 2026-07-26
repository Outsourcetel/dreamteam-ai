#!/usr/bin/env node
// ============================================================
// backup-data.mjs — export every row of every public table to local JSONL.
//
// backup-schema.mjs saves the SHAPE of the database. This saves the CONTENTS.
// Both are needed: restoring the schema alone gives you a correctly-secured
// EMPTY system — no tenants, no employees, no documents, no conversations.
//
// WHY: the Supabase org is on the FREE plan, and the backups endpoint returns
// an empty list. There is no automated backup of this database, so until PITR
// is purchased this script is the only thing standing between a bad afternoon
// and losing 16 tenants' data permanently.
//
//   node scripts/backup-data.mjs                 # everything, to backups/<date>/
//   node scripts/backup-data.mjs --out DIR       # somewhere else
//   node scripts/backup-data.mjs --skip-vectors  # omit embedding columns (large)
//
// ⚠ THE OUTPUT CONTAINS REAL CUSTOMER DATA AND PII.
// It writes to backups/, which is gitignored. Never commit it, never put it in
// a shared drive without encryption, and treat a copy on a laptop as a breach
// risk in its own right. That is a genuine trade-off, not boilerplate: the
// alternative right now is having no copy at all.
//
// Reads through the Management API, so it needs no database password. Strictly
// SELECT-only.
// ============================================================
import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const SKIP_VECTORS = args.includes('--skip-vectors');
const outIdx = args.indexOf('--out');
const PROJECT_REF = 'rfsvmhcqeiyrxivbmpel';
const ENDPOINT = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
const PAGE = 500;

function token() {
  const fromEnv = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const env = readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  if (!line) throw new Error('SUPABASE_ACCESS_TOKEN not found in .env.local');
  return line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
}

async function q(sql) {
  if (!/^\s*(select|with)\b/i.test(sql)) throw new Error('read-only: SELECT/WITH only');
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// The run is stamped by the caller's clock, which is fine — this is a local
// artifact, not something another machine has to agree with.
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const OUT = outIdx !== -1 ? args[outIdx + 1] : join('backups', stamp);
mkdirSync(OUT, { recursive: true });

const tables = await q(`
  select c.relname as tbl,
         (select count(*) from pg_attribute a
           where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
             and format_type(a.atttypid, a.atttypmod) = 'vector') as vector_cols
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
   order by c.relname`);

console.log(`Exporting ${tables.length} tables to ${OUT}\n`);
const manifest = [];
let grandTotal = 0;

for (const { tbl, vector_cols } of tables) {
  // Ordering by ctid gives a stable, index-free full scan on any table, without
  // assuming a primary key exists or is sortable.
  let offset = 0, rows = 0;
  const file = join(OUT, `${tbl}.jsonl`);
  writeFileSync(file, '');

  const cols = SKIP_VECTORS && vector_cols > 0
    ? (await q(`select string_agg(quote_ident(a.attname), ', ' order by a.attnum) as c
                  from pg_attribute a
                 where a.attrelid = 'public.${tbl}'::regclass and a.attnum > 0
                   and not a.attisdropped
                   and format_type(a.atttypid, a.atttypmod) <> 'vector'`))[0].c
    : '*';
  if (!cols) { console.log(`  ${tbl.padEnd(44)} skipped (only vector columns)`); continue; }

  for (;;) {
    const page = await q(
      `select coalesce(json_agg(t), '[]'::json) as d from (
         select ${cols} from public.${tbl} order by ctid limit ${PAGE} offset ${offset}) t`);
    const data = page[0].d;
    if (!data.length) break;
    appendFileSync(file, data.map((r) => JSON.stringify(r)).join('\n') + '\n');
    rows += data.length;
    offset += PAGE;
    if (data.length < PAGE) break;
  }

  grandTotal += rows;
  manifest.push({ table: tbl, rows, vectors_omitted: SKIP_VECTORS && vector_cols > 0 });
  if (rows) console.log(`  ${tbl.padEnd(44)} ${String(rows).padStart(7)} rows`);
}

writeFileSync(join(OUT, '_manifest.json'), JSON.stringify({
  project: PROJECT_REF,
  exported_at: new Date().toISOString(),
  vectors_omitted: SKIP_VECTORS,
  total_rows: grandTotal,
  // Recorded so a restore knows what it is NOT getting back. Silence here would
  // let someone believe this file is a complete disaster-recovery artifact.
  not_included: [
    'auth.users — user accounts and credentials live in the auth schema',
    'storage objects',
    'vault secrets (connector credentials are encrypted at rest and not exported)',
    'edge function source (that is in the repo)',
    'pg_cron schedules',
  ],
  tables: manifest,
}, null, 2));

console.log(`\n${grandTotal.toLocaleString()} rows across ${manifest.filter((m) => m.rows).length} non-empty tables.`);
console.log(`Manifest: ${join(OUT, '_manifest.json')}`);
console.log('\n⚠ This directory contains real customer data. It is gitignored — keep it that way.');
