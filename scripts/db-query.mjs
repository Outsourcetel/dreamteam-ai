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
