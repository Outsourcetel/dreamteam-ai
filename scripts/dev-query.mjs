#!/usr/bin/env node
// dev-query.mjs — same Management API path as db-query.mjs, but pointed at the
// ISOLATED DEV/TEST project (nmuntxrcdksyhsdywpan), never production.
// The project ref is hardcoded for the same reason db-query.mjs hardcodes prod:
// a ref passed on the command line is a ref that can be typed wrong once.
import { readFileSync } from 'node:fs';
const PROJECT_REF = 'nmuntxrcdksyhsdywpan';
const ENDPOINT = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
function readToken() {
  const env = readFileSync('.env.local', 'utf8').replace(/^\uFEFF/, '');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  if (!line) throw new Error('SUPABASE_ACCESS_TOKEN not found in .env.local');
  return line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
}
function readSql(argv) {
  const i = argv.indexOf('--sql');
  if (i !== -1) { const s = argv[i + 1]; if (!s) throw new Error('--sql requires a value'); return s; }
  const f = argv.find((a) => !a.startsWith('--'));
  if (!f) throw new Error('usage: dev-query.mjs <file.sql> | --sql "<statement>"');
  return readFileSync(f, 'utf8');
}
const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { Authorization: `Bearer ${readToken()}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: readSql(process.argv.slice(2)) }),
});
const text = await res.text();
if (!res.ok) { console.error(`HTTP ${res.status}`); console.error(text); process.exit(1); }
console.log(text);
