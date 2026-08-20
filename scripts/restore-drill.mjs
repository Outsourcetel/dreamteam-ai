#!/usr/bin/env node
// ============================================================
// restore-drill.mjs — prove the schema backup actually restores.
//
// A backup nobody has restored is a belief, not a control. This script is the
// difference: it takes supabase/baseline/full_schema.sql, rebuilds it into a
// throwaway schema on the DEV project, compares the result to production
// object-for-object, and drops it again.
//
// It found six real defects the first time it ran, none of which were visible
// by reading the file — it looked complete and correct at every stage:
//   1. CHECK constraints call functions, so functions must come BEFORE tables
//      (connectors CHECK (is_safe_external_url(base_url)))
//   2. ...but functions RETURNING SETOF <table> must come AFTER, so the dump
//      needs two function passes, not one ordering
//   3. extension-owned LANGUAGE c functions can't be recreated by a non-superuser
//   4. policy names containing spaces were emitted unquoted
//   5. GENERATED ALWAYS AS (...) STORED columns were emitted as DEFAULT
//   6. sequences behind legacy `serial` columns weren't dumped at all
//   (+ views were missing entirely, including the two *_secrets_decrypted ones)
//
//   node scripts/restore-drill.mjs          # regenerate, restore, compare, drop
//   node scripts/restore-drill.mjs --keep   # leave the schema for inspection
//
// SAFETY: it only ever writes to the DEV project, and only inside a schema named
// bkp_verify that it creates and drops. Production is read-only here.
// ============================================================
import { readFileSync, openSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const KEEP = process.argv.includes('--keep');
const PROD_REF = 'rfsvmhcqeiyrxivbmpel';
const DEV_REF = 'nmuntxrcdksyhsdywpan';
const SCHEMA = 'bkp_verify';
const FILE = 'supabase/baseline/full_schema.sql';

function token() {
  const fromEnv = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const env = readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  if (!line) throw new Error('SUPABASE_ACCESS_TOKEN not found in .env.local');
  return line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
}

async function run(ref, sql, attempt = 0) {
  // Retries cover BOTH failure modes, which is the point: the batched cleanup
  // makes hundreds of calls in a row and hits rate limits (HTTP 429, an HTML
  // error page) AND bare transport failures where fetch itself throws. Handling
  // only the first left the drop dying on "fetch failed" halfway through.
  //
  // A genuine SQL error (4xx that is not 429) is NOT retried — that is a real
  // answer and repeating it just hides it.
  let res;
  try {
    res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
    });
  } catch (e) {
    if (attempt < 5) { await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); return run(ref, sql, attempt + 1); }
    throw e;
  }
  const text = await res.text();
  if (!res.ok) {
    const transient = res.status === 429 || res.status >= 500;
    if (transient && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      return run(ref, sql, attempt + 1);
    }
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Drop the scratch schema in BATCHES, because two limits pull opposite ways:
 *
 *   · DROP SCHEMA … CASCADE takes a lock on every dependent object inside ONE
 *     transaction. At ~1,050 objects that exceeds max_locks_per_transaction and
 *     fails with "out of shared memory" — so it cannot be a single statement.
 *   · One request per object is rate-limited into an HTML error page after a few
 *     hundred calls — so it cannot be a statement each, either.
 *
 * Many objects per statement, few statements. This is not hypothetical tidiness:
 * the single-statement version worked until the schema crossed roughly a
 * thousand objects, then began leaving the ENTIRE scratch schema on dev after a
 * drill that reported success. The comparison passed, the cleanup threw, and the
 * next run inherited the mess.
 */
async function dropSchemaInBatches(ref, schema, batch = 30) {
  const qi = (s) => '"' + String(s).replace(/"/g, '""') + '"';

  for (;;) {
    const rows = await run(ref, `select tablename from pg_tables where schemaname = '${schema}' limit ${batch}`);
    if (!rows.length) break;
    await run(ref, `DROP TABLE IF EXISTS ${rows.map((r) => `${schema}.${qi(r.tablename)}`).join(', ')} CASCADE`);
    await sleep(150);
  }
  for (;;) {
    const rows = await run(ref, `select table_name from information_schema.views where table_schema = '${schema}' limit ${batch}`);
    if (!rows.length) break;
    await run(ref, `DROP VIEW IF EXISTS ${rows.map((r) => `${schema}.${qi(r.table_name)}`).join(', ')} CASCADE`);
    await sleep(150);
  }
  for (;;) {
    const rows = await run(ref, `select p.oid::regprocedure::text as sig, p.prokind
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = '${schema}' and p.prokind in ('f','p') limit ${batch}`);
    if (!rows.length) break;
    // Grouped by prokind: DROP FUNCTION on a procedure raises 42809.
    for (const kind of ['f', 'p']) {
      const sigs = rows.filter((r) => r.prokind === kind).map((r) => r.sig);
      if (sigs.length) await run(ref, `DROP ${kind === 'p' ? 'PROCEDURE' : 'FUNCTION'} IF EXISTS ${sigs.join(', ')} CASCADE`);
    }
    await sleep(150);
  }
  await run(ref, `DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  const [left] = await run(ref, `select count(*)::int as n from pg_namespace where nspname = '${schema}'`);
  if (left.n !== 0) throw new Error(`scratch schema ${schema} survived the batched drop`);
}

const census = (ns, excludeExtensionFns) => `
  select
    (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='${ns}' and c.relkind='r') as tables,
    (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='${ns}' and c.relkind='v') as views,
    (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='${ns}'${excludeExtensionFns ? ` and not exists (select 1 from pg_depend d
        where d.objid=p.oid and d.classid='pg_proc'::regclass and d.deptype='e')` : ''}) as functions,
    (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid
       join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='${ns}' and not t.tgisinternal) as triggers,
    (select count(*) from pg_policy p join pg_class c on c.oid=p.polrelid
       join pg_namespace n on n.oid=c.relnamespace where n.nspname='${ns}') as policies,
    (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='${ns}' and c.relkind='r' and c.relrowsecurity) as rls_enabled,
    (select count(*) from pg_attribute a join pg_class c on c.oid=a.attrelid
       join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='${ns}' and c.relkind='r' and a.attnum>0 and not a.attisdropped) as columns`;

console.log('1/4  regenerating the schema dump from production…');
const out = openSync(FILE, 'w');
try {
  execFileSync(process.execPath, ['scripts/backup-schema.mjs'], { stdio: ['ignore', out, 'inherit'] });
} finally {
  closeSync(out);
}

console.log('2/4  restoring into a throwaway schema on the dev project…');
const dump = readFileSync(FILE, 'utf8').replace(/public\./g, `${SCHEMA}.`);

// The dump outgrew a single request: register A-12's 841 grant lines pushed
// it past the Management API's body cap (HTTP 413, 2026-08-20). So it now
// travels as chunks of WHOLE STATEMENTS — split dollar-quote- and
// comment-aware, because a naive split on ';' would cut every plpgsql body in
// half. Each request is its own session, so each chunk re-states search_path.
function splitStatements(sql) {
  const stmts = [];
  let start = 0, i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {              // line comment
      i = sql.indexOf('\n', i); if (i === -1) break; i++;
    } else if (ch === "'") {                             // string literal ('' escapes)
      i++;
      while (i < sql.length) { if (sql[i] === "'") { if (sql[i + 1] === "'") { i += 2; continue; } i++; break; } i++; }
    } else if (ch === '$') {                             // dollar quoting
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (m) { const close = sql.indexOf(m[0], i + m[0].length); i = close === -1 ? sql.length : close + m[0].length; }
      else i++;
    } else if (ch === ';') {
      stmts.push(sql.slice(start, i + 1)); i++; start = i;
    } else i++;
  }
  if (sql.slice(start).trim()) stmts.push(sql.slice(start));
  return stmts;
}
// Each chunk is its own Management-API session, so session GUCs must be
// re-stated per chunk: the search_path AND check_function_bodies (the dump
// sets it on line 1, which only the first chunk's session ever sees).
const SEARCH_PATH = `SET search_path = ${SCHEMA}, public, extensions;\nSET check_function_bodies = off;\n`;
const CHUNK_LIMIT = 512 * 1024;
const statements = splitStatements(dump);
const chunks = [];
let cur = `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;\nCREATE SCHEMA ${SCHEMA};\n${SEARCH_PATH}`;
for (const st of statements) {
  if (cur.length + st.length > CHUNK_LIMIT && cur.length > SEARCH_PATH.length) {
    chunks.push(cur); cur = SEARCH_PATH;
  }
  cur += st;
}
if (cur.trim().length > SEARCH_PATH.trim().length) chunks.push(cur);
console.log(`     ${statements.length} statements in ${chunks.length} chunk(s) of ≤${CHUNK_LIMIT / 1024}KB`);
for (let c = 0; c < chunks.length; c++) {
  await run(DEV_REF, chunks[c]);
}

console.log('3/4  comparing the rebuilt schema to production…');
const [got] = await run(DEV_REF, census(SCHEMA, false));
const [want] = await run(PROD_REF, census('public', true));

const rows = Object.keys(want).map((k) => ({
  object: k, production: want[k], restored: got[k], match: want[k] === got[k] ? 'OK' : 'MISMATCH',
}));
console.table(rows);

// The verdict is decided BEFORE cleanup, and cleanup can no longer change it.
// Previously the drop ran first and threw, so a drill whose comparison had
// PASSED exited non-zero with a lock-table error — the run looked like a backup
// failure when the backup was fine and only the housekeeping had broken. A
// tidying step must never be able to impersonate the thing being tested.
const bad = rows.filter((r) => r.match !== 'OK');

let cleanupError = null;
if (!KEEP) {
  try {
    await dropSchemaInBatches(DEV_REF, SCHEMA);
    console.log('4/4  scratch schema dropped.');
  } catch (e) {
    cleanupError = e;
    console.error(`4/4  CLEANUP FAILED — ${SCHEMA} is still on dev: ${e.message}`);
    console.error('     The drill result below stands; this is housekeeping, not the backup.');
  }
} else {
  console.log(`4/4  left ${SCHEMA} in place (--keep).`);
}

if (bad.length) {
  console.error(`\nRESTORE DRILL FAILED — ${bad.map((b) => b.object).join(', ')} differ.`);
  console.error('The backup does not reproduce production. Do not rely on it until this passes.');
  process.exit(1);
}
console.log('\nRESTORE DRILL PASSED — the schema backup reproduces production exactly.');
// Still a non-zero exit, because a scratch schema left on dev will confuse the
// next run — but the message above says plainly which of the two failed.
if (cleanupError) process.exit(2);
