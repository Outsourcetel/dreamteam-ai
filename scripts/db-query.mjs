#!/usr/bin/env node
// db-query.mjs — run a SQL statement against the Supabase project via the
// Management API. SQL comes from a file (arg) or --sql "<inline>", so the
// vault-referencing SQL never sits on the shell command line.
//
//   node scripts/db-query.mjs supabase/migrations/264_eval_run_driver.sql
//   node scripts/db-query.mjs --sql "select 1"
//
// Token is read from .env.local (SUPABASE_ACCESS_TOKEN), BOM-stripped.

import { readFileSync } from 'node:fs';

const PROJECT_REF = 'rfsvmhcqeiyrxivbmpel';
const ENDPOINT = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

function readToken() {
  const env = readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  if (!line) throw new Error('SUPABASE_ACCESS_TOKEN not found in .env.local');
  return line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
}

function readSql(argv) {
  const i = argv.indexOf('--sql');
  if (i !== -1) {
    const sql = argv[i + 1];
    if (!sql) throw new Error('--sql requires a value');
    return sql;
  }
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) throw new Error('usage: db-query.mjs <file.sql> | --sql "<statement>"');
  return readFileSync(file, 'utf8');
}

const token = readToken();
const query = readSql(process.argv.slice(2));

const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query }),
});

const text = await res.text();
if (!res.ok) {
  console.error(`HTTP ${res.status}`);
  console.error(text);
  process.exit(1);
}
console.log(text);

// ── Record it in the ledger (mig 364) ──────────────────────────────────────
// Only for a real migration FILE, and only AFTER it succeeded — a failed
// migration must never leave a row claiming it was applied. This is what turns
// the ledger from a one-off snapshot into something that stays true: before
// this, "which migrations are applied" lived in one person's memory.
const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (file && /supabase[\\/]migrations[\\/]/.test(file)) {
  try {
    const { createHash } = await import('node:crypto');
    const name = file.split(/[\\/]/).pop();
    // CRLF-normalised: this repo has a CRLF working tree, and a file differing
    // only by line ending is not a changed migration.
    const sum = createHash('sha256')
      .update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), 'utf8').digest('hex');
    const rec = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `select public.record_migration_applied(
                  ${JSON.stringify(name).replace(/"/g, "'")}, '${sum}', 'db-query.mjs') as r`,
      }),
    });
    if (rec.ok) {
      const r = JSON.parse(await rec.text())[0]?.r;
      if (r?.content_changed_since_last_apply) {
        console.error(`⚠  ${name} was applied before with DIFFERENT content — the database may not match this file.`);
      } else if (r?.reapplied) {
        console.error(`ledger: ${name} re-applied`);
      } else {
        console.error(`ledger: ${name} recorded`);
      }
    }
  } catch {
    // Never fail a successful migration because the bookkeeping call failed —
    // but say so, so the ledger silently drifting is visible.
    console.error('⚠  migration applied, but the ledger could not be updated');
  }
}
