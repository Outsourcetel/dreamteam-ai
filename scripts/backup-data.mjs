#!/usr/bin/env node
// ============================================================
// backup-data.mjs — export every row of every public table to local JSONL.
//
// backup-schema.mjs saves the SHAPE of the database. This saves the CONTENTS.
// Both are needed: restoring the schema alone gives you a correctly-secured
// EMPTY system — no tenants, no employees, no documents, no conversations.
//
// WHY (updated 2026-08-20; the original said "free plan, no backups" — false
// since 2026-08-05 and exactly the kind of stale claim that gets believed in
// an emergency): Supabase now takes DAILY physical backups (7 retained), but
// PITR is OFF, a daily can silently go missing (2026-08-02 did), the managed
// restore has never been rehearsed and goes IN PLACE, and physical backups
// exclude nothing-tells-you-what. This export is the copy WE control: it is
// the input to scripts/restore-data-drill.mjs, the only restore this project
// has actually watched succeed.
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
// Password hashes are OFF by default. See the auth section near the bottom for
// why that default is the way round it is.
const WITH_HASHES = args.includes('--include-password-hashes');
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
  // Retries transport failures and 429/5xx — a 3-minute export makes hundreds
  // of calls and WILL meet a rate limit; dying on it silently truncates the
  // backup (proven live 2026-08-20: the run died at audit_events and the
  // pipeline's tail masked the crash as exit 0). A non-429 4xx is a real
  // answer and is not retried. JSON.parse failures are thrown to the CALLER,
  // which knows whether shrinking the page is the right response.
  for (let attempt = 0; ; attempt++) {
    let res, text;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: sql }),
      });
      text = await res.text();
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (!res.ok) {
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return JSON.parse(text);
  }
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

  // Adaptive page size: the Management API truncates very large response
  // bodies MID-JSON with HTTP 200 (proven live 2026-08-20 on audit_events —
  // 500 rows of jsonb detail overran the cap and JSON.parse got half a
  // document). Truncation presents as a parse failure, so on one of those we
  // halve the page for THIS table and re-fetch the SAME offset. Halving below
  // 10 means single rows are oversized — that is a real answer, not a retry.
  let pageSize = PAGE;
  for (;;) {
    let page;
    try {
      page = await q(
        `select coalesce(json_agg(t), '[]'::json) as d from (
           select ${cols} from public.${tbl} order by ctid limit ${pageSize} offset ${offset}) t`);
    } catch (e) {
      if (e instanceof SyntaxError && pageSize > 10) {
        pageSize = Math.max(10, Math.floor(pageSize / 2));
        console.log(`  ${tbl}: response truncated, retrying at page size ${pageSize}`);
        continue;
      }
      throw e;
    }
    const data = page[0].d;
    if (!data.length) break;
    appendFileSync(file, data.map((r) => JSON.stringify(r)).join('\n') + '\n');
    rows += data.length;
    offset += data.length;
    if (data.length < pageSize) break;
  }

  grandTotal += rows;
  manifest.push({ table: tbl, rows, vectors_omitted: SKIP_VECTORS && vector_cols > 0 });
  if (rows) console.log(`  ${tbl.padEnd(44)} ${String(rows).padStart(7)} rows`);
}

// ── auth.users: the difference between "restored" and "usable" ─────────────
// Without this, a full restore gives every tenant their records back with NOBODY
// ABLE TO LOG IN — and worse, every profiles.user_id and every audit row points
// at a UUID that no longer exists. The UUIDs are the load-bearing part.
//
// encrypted_password is EXCLUDED BY DEFAULT and needs --include-password-hashes.
// That default is deliberate. Customer data leaking is bad; bcrypt hashes leaking
// is worse in kind, because they can be cracked offline and tried against the
// users' other accounts. Without hashes a restore still works — every user goes
// through password reset once. With them, nobody notices the restore happened.
// Pick per situation; do not make it the silent default.
const authCols = [
  'id', 'email', 'phone', 'created_at', 'updated_at', 'email_confirmed_at',
  'phone_confirmed_at', 'last_sign_in_at', 'raw_app_meta_data',
  'raw_user_meta_data', 'is_super_admin', 'role', 'is_sso_user', 'banned_until',
  ...(WITH_HASHES ? ['encrypted_password'] : []),
].map((c) => `"${c}"`).join(', ');

const authUsers = await q(
  `select coalesce(json_agg(t), '[]'::json) as d
     from (select ${authCols} from auth.users order by created_at) t`);
writeFileSync(join(OUT, '_auth_users.jsonl'),
  authUsers[0].d.map((r) => JSON.stringify(r)).join('\n') + '\n');

// Identity rows carry the OAuth/SSO linkage. Currently every user is email-based,
// so this is usually empty — captured anyway so adding SSO later does not
// silently create a new backup gap nobody notices until a restore.
const authIdentities = await q(
  `select coalesce(json_agg(t), '[]'::json) as d
     from (select id, user_id, provider, provider_id, identity_data, created_at,
                  last_sign_in_at
             from auth.identities order by created_at) t`);
writeFileSync(join(OUT, '_auth_identities.jsonl'),
  authIdentities[0].d.map((r) => JSON.stringify(r)).join('\n') + '\n');

console.log(`\n  auth.users${' '.repeat(36)}${String(authUsers[0].d.length).padStart(7)} rows` +
            (WITH_HASHES ? '  (WITH password hashes)' : '  (no password hashes — users must reset)'));
console.log(`  auth.identities${' '.repeat(31)}${String(authIdentities[0].d.length).padStart(7)} rows`);

writeFileSync(join(OUT, '_manifest.json'), JSON.stringify({
  project: PROJECT_REF,
  exported_at: new Date().toISOString(),
  vectors_omitted: SKIP_VECTORS,
  total_rows: grandTotal,
  // Recorded so a restore knows what it is NOT getting back. Silence here would
  // let someone believe this file is a complete disaster-recovery artifact.
  auth_users_included: true,
  password_hashes_included: WITH_HASHES,
  not_included: [
    ...(WITH_HASHES ? [] : ['auth.users password hashes — every user must reset their password after a restore (re-run with --include-password-hashes to capture them)']),
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
