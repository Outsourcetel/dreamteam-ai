#!/usr/bin/env node
// ============================================================================
// rebuild-dev-from-baseline.mjs — bring the DEV project's schema back to
// production's, in one operation, from the artefact the restore drill proves.
//
// WHY THIS EXISTS (register B-6, docs/54 §8)
// Dev drifted 147 migrations behind production. That matters because
// golden-path — the only automated end-to-end proof of the product's core loop,
// and now a CI job on every push — runs against dev. A green tick was proving a
// July schema.
//
// Replaying the backlog was the obvious fix and the wrong one: 136 files
// pending, 85 of which carry their own begin/commit, so the set cannot be
// wrapped in a transaction, dry-run, or rolled back — and dev is shared with
// parallel sessions and CI. This instead applies supabase/baseline/full_schema.sql,
// which restore-drill.mjs has just verified reproduces production exactly.
//
// ⚠ DESTRUCTIVE, DEV ONLY. Drops and recreates dev's `public` schema. Production
// is never touched: it is read for the ledger and the census, nothing else.
//
// ⚠ THE TWO CROSS-SCHEMA TRIGGERS ARE THE TRAP. `auth.users` and
// `net.http_request_queue` carry triggers that call PUBLIC functions. Dropping
// public CASCADE takes those triggers with it, and the baseline dump only
// contains the public schema — so it cannot put them back. Without step 4,
// signup silently stops creating profiles and golden-path fails at step one.
// They are captured from PRODUCTION before the drop and recreated after.
//
//   node scripts/rebuild-dev-from-baseline.mjs --confirm
// ============================================================================
import { readFileSync } from 'node:fs';
import { splitStatements, chunkStatements, countCreateTable, dumpProblems, sessionSetOf } from './sql-statements.mjs';

const DEV_REF = 'nmuntxrcdksyhsdywpan';
const PROD_REF = 'rfsvmhcqeiyrxivbmpel';
const FILE = 'supabase/baseline/full_schema.sql';

if (!process.argv.includes('--confirm')) {
  console.error('refusing to run without --confirm: this DROPS the dev public schema');
  process.exit(1);
}

function env(key, ...files) {
  const fromEnv = process.env[key]?.trim();
  if (fromEnv) return fromEnv;
  for (const f of files) {
    let raw; try { raw = readFileSync(f, 'utf8').replace(/^﻿/, ''); } catch { continue; }
    const line = raw.split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
    if (line) return line.slice(key.length + 1).replace(/^["']|["']$/g, '').trim();
  }
  throw new Error(`${key} not found in ${files.join(' or ')}`);
}
const TOKEN = env('SUPABASE_ACCESS_TOKEN', '.env.local');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(ref, query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SQL ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const qi = (s) => '"' + String(s).replace(/"/g, '""') + '"';

// ⚠ THE BASELINE NO LONGER FITS IN ONE REQUEST. On 2026-08-20 this script
// sent all 3.0MB at once and got SQL 413 back AFTER dropping dev, leaving the
// project with zero tables and no way to put them back. The endpoint ceiling
// is between 2MB and 3MB (measured: 2048KB -> 201, 3072KB -> 413).
//
// 1MB is half the largest body proven to succeed, and comfortably clear of the
// single largest statement in the dump (409KB), which cannot be subdivided and
// has to fit in one request on its own.
const CHUNK_BYTES = 1024 * 1024;

// Headroom inside the cap for the per-chunk prologue — search_path plus the
// session GUCs the dump has set so far. About 100 bytes today; reserved
// generously so that adding one never silently pushes a chunk over.
const PROLOGUE_RESERVE = 4096;

// Same batching reasoning as restore-drill.mjs: one statement per object gets
// rate-limited, one statement for everything exceeds max_locks_per_transaction.
async function dropPublicInBatches(batch = 30) {
  for (;;) {
    const rows = await run(DEV_REF, `select tablename from pg_tables where schemaname='public' limit ${batch}`);
    if (!rows.length) break;
    await run(DEV_REF, `DROP TABLE IF EXISTS ${rows.map((r) => `public.${qi(r.tablename)}`).join(', ')} CASCADE`);
    await sleep(150);
  }
  for (;;) {
    const rows = await run(DEV_REF, `select table_name from information_schema.views where table_schema='public' limit ${batch}`);
    if (!rows.length) break;
    await run(DEV_REF, `DROP VIEW IF EXISTS ${rows.map((r) => `public.${qi(r.table_name)}`).join(', ')} CASCADE`);
    await sleep(150);
  }
  for (;;) {
    // ⚠ EXTENSION-OWNED FUNCTIONS MUST BE LEFT ALONE. pgvector installs 118
    // functions into public on this project; dropping one answers
    // "cannot drop function vector_to_float4 because extension vector requires
    // it". They are not app code, the baseline does not contain them, and
    // dropping the extension to remove them would take the embedding column
    // types with it. pg_depend deptype='e' is what marks them.
    const rows = await run(DEV_REF, `select p.oid::regprocedure::text as sig, p.prokind
        from pg_proc p
        join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.prokind in ('f','p')
         and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')
       limit ${batch}`);
    if (!rows.length) break;
    for (const kind of ['f', 'p']) {
      const sigs = rows.filter((r) => r.prokind === kind).map((r) => r.sig);
      if (sigs.length) await run(DEV_REF, `DROP ${kind === 'p' ? 'PROCEDURE' : 'FUNCTION'} IF EXISTS ${sigs.join(', ')} CASCADE`);
    }
    await sleep(150);
  }
  // The SCHEMA itself is deliberately kept. Two extensions live in public here;
  // dropping the schema would drop them, and the baseline cannot put an
  // extension back. Emptying it of app objects is the same end state for our
  // purposes and leaves the extensions where the dump expects to find them.
}

const census = (ref) => run(ref, `select
  (select count(*) from pg_tables where schemaname='public') as tables,
  (select count(*) from information_schema.views where table_schema='public') as views,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind in ('f','p')) as functions,
  (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal) as triggers,
  (select count(*) from pg_policies where schemaname='public') as policies,
  (select count(*) from information_schema.columns where table_schema='public') as columns`);

// ── 1. capture what the drop will destroy outside public ────────────────────
console.log('1/6  capturing cross-schema triggers from production…');
const crossTriggers = await run(PROD_REF, `select pg_get_triggerdef(t.oid) as ddl,
    n.nspname||'.'||c.relname as on_table
  from pg_trigger t
  join pg_class c on c.oid=t.tgrelid
  join pg_namespace n on n.oid=c.relnamespace
  join pg_proc p on p.oid=t.tgfoid
  join pg_namespace fn on fn.oid=p.pronamespace
 where not t.tgisinternal and n.nspname <> 'public' and fn.nspname='public'`);
for (const t of crossTriggers) console.log(`     ${t.on_table} — ${t.ddl.slice(0, 60)}…`);
if (!crossTriggers.length) throw new Error('expected at least the auth.users trigger — refusing to proceed blind');

// ── 2. the ledger production actually holds ─────────────────────────────────
const ledger = await run(PROD_REF, 'select filename, checksum, applied_at, applied_by, provenance from public.schema_migrations order by filename');
console.log(`2/6  production ledger: ${ledger.length} row(s) to copy across`);

// ── 3. drop + restore ───────────────────────────────────────────────────────
// ⚠ EVERYTHING CHECKABLE IS CHECKED BEFORE THE DROP. The 2026-08-20 failure was
// not that the restore was impossible — it was that we found out AFTER dev had
// been destroyed. A rebuild that refuses leaves a stale dev, which is a bad day.
// A rebuild that drops and then discovers it cannot restore leaves NO dev, which
// is a bad week. Every check that does not require an empty database belongs
// here, above `dropPublicInBatches()`, and none of them may be moved below it.
const dump = readFileSync(FILE, 'utf8');
const statements = splitStatements(dump);
const chunks = chunkStatements(statements, CHUNK_BYTES - PROLOGUE_RESERVE);
const [want] = await census(PROD_REF);

{
  const problems = dumpProblems(dump, statements, CHUNK_BYTES - PROLOGUE_RESERVE);

  // Is this a schema dump at all, or a fragment? The workflow regenerates the
  // baseline from production immediately before calling this and applies its
  // own floor — but the script is also run by hand, where nothing does. A
  // truncated dump passes every other check here and restores a partial dev
  // that the census at the end would happily call a mismatch AFTER the damage.
  const dumpTables = countCreateTable(dump);
  if (dumpTables < want.tables * 0.9) {
    problems.push(`${FILE} carries ${dumpTables} CREATE TABLE statements and production has ${want.tables} — this dump is truncated`);
  }

  if (problems.length) {
    for (const p of problems) console.error(`REFUSING: ${p}`);
    console.error('Dev has NOT been touched.');
    process.exit(1);
  }

  console.log(`     pre-flight OK: ${(dump.length / 1048576).toFixed(2)}MB · ${dumpTables} tables · ${statements.length} statements · ${chunks.length} chunk(s) of at most ${CHUNK_BYTES / 1024}KB`);
}

console.log('3/6  emptying dev public schema of app objects (batched, extensions kept)…');
await dropPublicInBatches();

console.log(`4/6  restoring the proven baseline into public (${chunks.length} chunks)…`);
const carried = [];   // session GUCs the dump has set in the chunks already sent
for (let c = 0; c < chunks.length; c += 1) {
  // Each request is its own session, so everything session-scoped is restated:
  // search_path, and every SET the dump itself has executed so far. Setting
  // them once in chunk 1 silently does nothing for chunks 2..n — which is how
  // the functions-before-tables ordering died on `check_function_bodies`.
  const prologue = ['SET search_path = public, extensions;', ...carried].join('\n') + '\n';
  const body = prologue + chunks[c].join('\n');
  if (body.length > CHUNK_BYTES) {
    throw new Error(`chunk ${c + 1} is ${body.length} bytes with its prologue, over the ${CHUNK_BYTES} cap — raise PROLOGUE_RESERVE`);
  }
  for (const st of chunks[c]) {
    const set = sessionSetOf(st);
    if (set) carried.push(set);
  }
  try {
    await run(DEV_REF, body);
  } catch (e) {
    console.error(`     chunk ${c + 1}/${chunks.length} FAILED (${body.length} bytes, ${chunks[c].length} statements): ${e.message}`);
    console.error(`     dev is now PARTIALLY restored — chunks 1..${c} applied. Re-run once the cause is fixed.`);
    throw e;
  }
  console.log(`     chunk ${c + 1}/${chunks.length} applied — ${(body.length / 1024).toFixed(0)}KB, ${chunks[c].length} statements`);
}

// ── 4. put the cross-schema triggers back ───────────────────────────────────
console.log('5/6  recreating cross-schema triggers…');
for (const t of crossTriggers) {
  const [schema, table] = t.on_table.split('.');
  const name = t.ddl.match(/CREATE TRIGGER (\S+)/)[1];
  await run(DEV_REF, `DROP TRIGGER IF EXISTS ${name} ON ${schema}.${qi(table)}; ${t.ddl};`);
  console.log(`     restored ${name} on ${t.on_table}`);
}

// ── 5. ledger, so dev knows what it has ─────────────────────────────────────
const esc = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
for (let i = 0; i < ledger.length; i += 100) {
  const vals = ledger.slice(i, i + 100)
    .map((r) => `(${esc(r.filename)}, ${esc(r.checksum)}, ${esc(r.applied_at)}, ${esc(r.applied_by)}, ${esc(r.provenance)})`)
    .join(',\n');
  await run(DEV_REF, `insert into public.schema_migrations (filename, checksum, applied_at, applied_by, provenance)
    values\n${vals}\n on conflict (filename) do nothing`);
}

// ── 6. prove it ─────────────────────────────────────────────────────────────
console.log('6/6  comparing dev to production…');
const [got] = await census(DEV_REF);
// `want` was read before the drop — the pre-flight needed production's table
// count to tell a truncated dump from a real one.
const [devLedger] = await run(DEV_REF, 'select count(*)::int as n from public.schema_migrations');
const rows = Object.keys(want).map((k) => ({
  object: k, production: want[k], dev: got[k], match: want[k] === got[k] ? 'OK' : 'MISMATCH',
}));
rows.push({ object: 'ledger', production: ledger.length, dev: devLedger.n, match: ledger.length === devLedger.n ? 'OK' : 'MISMATCH' });
console.table(rows);

const bad = rows.filter((r) => r.match !== 'OK');
console.log(bad.length ? `\n⚠ ${bad.length} MISMATCH — dev does not match production` : '\nDEV REBUILT — schema and ledger now match production');
process.exit(bad.length ? 1 : 0);
