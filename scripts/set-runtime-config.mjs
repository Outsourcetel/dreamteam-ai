#!/usr/bin/env node
// set-runtime-config.mjs — tell a database which project it is.
//
// platform_runtime_config holds two rows that every dispatcher reads (mig 383):
//   function_base_url  — where net.http_post sends edge-function calls
//   supabase_anon_key  — the gateway JWT those calls carry
//
// Before 383 the dispatchers hardcoded PRODUCTION's values, so any clone of the
// database dispatched INTO PRODUCTION: dev's cron woke prod's workers, which
// drained prod's queues, and dev's own rows were never looked at. 383 made them
// read config; this script is what puts the right answer in the config.
//
// Values are READ FROM AN ENV FILE at runtime and never appear in a command
// line, a shell history, or a committed .sql file.
//
// ⚠ THE GUARD BELOW IS THE POINT OF THIS SCRIPT. It refuses to write unless the
// URL in the env file belongs to the project being written to. Seeding dev with
// production's URL would recreate the exact bug 383 fixed, silently, and the
// symptom (a queue that never drains) gives no hint of the cause.
//
//   node scripts/set-runtime-config.mjs --project dev  --env .env
//   node scripts/set-runtime-config.mjs --project prod --env .env.production-backup
import { readFileSync } from 'node:fs';

const REFS = { dev: 'nmuntxrcdksyhsdywpan', prod: 'rfsvmhcqeiyrxivbmpel' };

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const target = arg('project');
const envFile = arg('env', '.env');
const apply = !argv.includes('--dry-run');

if (!REFS[target]) {
  console.error('usage: set-runtime-config.mjs --project dev|prod [--env <file>] [--dry-run]');
  process.exit(1);
}

const read = (f) => readFileSync(f, 'utf8').replace(/^﻿/, '');
const pick = (txt, ...keys) => {
  for (const k of keys) {
    const line = txt.split(/\r?\n/).find((l) => l.startsWith(`${k}=`));
    if (line) return line.slice(k.length + 1).replace(/^["']|["']$/g, '').trim();
  }
  return null;
};

const env = read(envFile);
const url = pick(env, 'VITE_SUPABASE_URL', 'SUPABASE_URL', 'VITE_TEST_SUPABASE_URL');
const key = pick(env, 'VITE_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY', 'VITE_TEST_SUPABASE_ANON_KEY');
if (!url || !key) { console.error(`${envFile}: could not find a Supabase URL and anon key`); process.exit(1); }

// ── The guard ───────────────────────────────────────────────────────────────
const ref = REFS[target];
const host = new URL(url).host;
if (!host.startsWith(`${ref}.`)) {
  console.error(`REFUSING: --project ${target} is ${ref}, but ${envFile} points at ${host}.`);
  console.error('Writing this would make that database dispatch into a different project.');
  process.exit(1);
}
// An anon key is a JWT whose payload names its project. Decoding the claim is
// the only way to catch a URL and a key that come from DIFFERENT projects — a
// combination that authenticates nowhere and fails as a 401, which looks
// exactly like a fast success from the dispatcher's side.
try {
  const claims = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'));
  if (claims.ref && claims.ref !== ref) {
    console.error(`REFUSING: the URL is ${ref} but the key belongs to ${claims.ref}.`);
    process.exit(1);
  }
  if (claims.role && claims.role !== 'anon') {
    console.error(`REFUSING: that key's role is "${claims.role}", not "anon". Only the public anon key belongs here.`);
    process.exit(1);
  }
} catch { console.error('note: could not decode the key payload; continuing on the URL check alone'); }

console.log(`project   ${target} (${ref})`);
console.log(`source    ${envFile}`);
console.log(`base url  ${url}`);
console.log(`anon key  ${key.length} chars, role=anon, ref=${ref}  (value not printed)`);
if (!apply) { console.log('\n--dry-run: nothing written'); process.exit(0); }

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sql = `
insert into platform_runtime_config (key, value) values
  ('function_base_url', ${q(url)}),
  ('supabase_anon_key', ${q(key)})
on conflict (key) do update set value = excluded.value;
select key, length(value) as len,
       case when key = 'function_base_url' then value else '(hidden)' end as shown
  from platform_runtime_config order by key;`;

const token = (() => {
  const line = read('.env.local').split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  if (!line) throw new Error('SUPABASE_ACCESS_TOKEN not found in .env.local');
  return line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
})();

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
});
const text = await res.text();
if (!res.ok) { console.error(`HTTP ${res.status}\n${text}`); process.exit(1); }
console.log('\nwritten:', text);
