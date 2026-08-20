#!/usr/bin/env node
// ============================================================
// restore-data-drill.mjs — prove the DATA export actually loads back.
//
// restore-drill.mjs proves the schema file rebuilds the shape of production.
// This proves the other half: that backups/<ts>/*.jsonl (backup-data.mjs)
// loads into that schema and produces a coherent database — counts match the
// manifest, no foreign key dangles, RLS is on, and a real function answers a
// real question against the restored rows.
//
// It runs entirely in a THROWAWAY local Docker container (supabase/postgres,
// same major version as production). Nothing here touches production or dev
// beyond reading the local export directory.
//
//   node scripts/restore-data-drill.mjs                    # newest backups/<ts>
//   node scripts/restore-data-drill.mjs --dir backups/X    # a specific export
//   node scripts/restore-data-drill.mjs --keep             # leave the container
//
// Design decisions that ARE the drill (learned from restore-drill.mjs):
//   · The verdict is computed BEFORE cleanup, and a cleanup failure says so in
//     its own words and exits 2 — a tidying step must never be able to
//     impersonate the thing being tested.
//   · auth.users/auth.identities are DROPPED and re-created as shims matching
//     the export's columns, BEFORE the schema file runs, so the profiles FK
//     binds to the table the data will actually fill. GoTrue is not running
//     in the container; its baked table shape is irrelevant here.
//   · Data loads under session_replication_role=replica (FK triggers off), so
//     file order does not matter — and then EVERY foreign key is orphan-swept
//     afterwards. Skipping enforcement during load is honest only because the
//     sweep re-proves integrity at the end.
//   · jsonb_populate_recordset does the type coercion (uuid, timestamptz,
//     arrays, jsonb, vector) — hand-rolled COPY escaping is how a restore
//     script corrupts data while reporting success.
// ============================================================
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
const dirIdx = args.indexOf('--dir');
const CONTAINER = 'bkp-data-drill';
const PORT = '5433';
const SCHEMA_FILE = 'supabase/baseline/full_schema.sql';

function newestBackupDir() {
  const dirs = readdirSync('backups', { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  if (!dirs.length) throw new Error('no export found under backups/ — run npm run backup:data first');
  return join('backups', dirs[dirs.length - 1]);
}
const DIR = dirIdx !== -1 ? args[dirIdx + 1] : newestBackupDir();
const manifest = JSON.parse(readFileSync(join(DIR, '_manifest.json'), 'utf8'));

function docker(argv, opts = {}) {
  return execFileSync('docker', argv, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64, ...opts });
}
// psql into the container, SQL on stdin. Returns { ok, out } — callers decide
// whether a failure is fatal, because for the schema apply it is a COUNT, not
// an exception.
function psql(sql, { onErrorStop = true, user = 'postgres' } = {}) {
  const r = spawnSync('docker',
    ['exec', '-i', '-e', 'PGPASSWORD=drill', CONTAINER, 'psql', '-U', user, '-d', 'postgres',
     '-v', `ON_ERROR_STOP=${onErrorStop ? 1 : 0}`, '-X', '-q', '-At', '-f', '-'],
    { input: sql, encoding: 'utf8', maxBuffer: 1024 * 1024 * 256 });
  return { ok: r.status === 0, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
function q1(sql) {
  const r = psql(sql);
  if (!r.ok) throw new Error(`query failed: ${sql.slice(0, 120)} :: ${r.out.slice(0, 300)}`);
  return r.out.trim();
}

const failures = [];
const notes = [];

// ── 0. container ────────────────────────────────────────────────────────────
console.log(`Export:    ${DIR} (${manifest.total_rows.toLocaleString()} rows, exported ${manifest.exported_at})`);
console.log(`Schema:    ${SCHEMA_FILE}`);
try { docker(['rm', '-f', CONTAINER], { stdio: 'ignore' }); } catch { /* no leftover */ }

const image = docker(['images', '--format', '{{.Repository}}:{{.Tag}}'])
  .split('\n').find((l) => l.startsWith('supabase/postgres:'));
if (!image) throw new Error('no supabase/postgres image pulled — docker pull supabase/postgres:17.6.1.005');
console.log(`Image:     ${image}`);

docker(['run', '-d', '--name', CONTAINER, '-e', 'POSTGRES_PASSWORD=drill',
        '-p', `${PORT}:5432`, image]);
process.stdout.write('Booting container');
let up = false;
for (let i = 0; i < 60; i++) {
  const r = spawnSync('docker', ['exec', CONTAINER, 'pg_isready', '-U', 'postgres'], { encoding: 'utf8' });
  if (r.status === 0) { up = true; break; }
  process.stdout.write('.');
  execFileSync(process.platform === 'win32' ? 'ping' : 'sleep',
    process.platform === 'win32' ? ['-n', '3', '127.0.0.1'] : ['2'], { stdio: 'ignore' });
}
console.log('');
if (!up) throw new Error('container never became ready');
// The image boots its own init once; give it a moment and verify a real query.
for (let i = 0; i < 30; i++) {
  const r = psql('select 1;');
  if (r.ok) break;
  execFileSync(process.platform === 'win32' ? 'ping' : 'sleep',
    process.platform === 'win32' ? ['-n', '3', '127.0.0.1'] : ['2'], { stdio: 'ignore' });
  if (i === 29) throw new Error('psql never connected: ' + r.out.slice(0, 300));
}
console.log(`PG:        ${q1('show server_version;')}`);

// ── 1. auth shim (before the schema file, so its FKs bind to these) ─────────
const authShim = `
drop table if exists auth.identities cascade;
drop table if exists auth.users cascade;
create schema if not exists auth;
create table auth.users (
  id uuid primary key, email text, phone text,
  created_at timestamptz, updated_at timestamptz,
  email_confirmed_at timestamptz, phone_confirmed_at timestamptz,
  last_sign_in_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb,
  is_super_admin boolean, role text, is_sso_user boolean, banned_until timestamptz,
  encrypted_password text
);
create table auth.identities (
  id uuid, user_id uuid, provider text, provider_id text,
  identity_data jsonb, created_at timestamptz, last_sign_in_at timestamptz
);
-- Stubs: the schema's functions call these. NULL = the superuser-ish context
-- every SECURITY DEFINER guard in the codebase lets through (auth.role() is
-- null short-circuits the membership checks).
create or replace function auth.uid() returns uuid language sql stable as 'select null::uuid';
create or replace function auth.role() returns text language sql stable as 'select null::text';
create or replace function auth.jwt() returns jsonb language sql stable as 'select null::jsonb';
`;
{
  const r = psql(authShim);
  if (!r.ok) { failures.push('auth shim failed: ' + r.out.slice(0, 300)); }
}

// ── 2. schema ────────────────────────────────────────────────────────────────
console.log('Applying schema (errors are counted, then judged by object counts)…');
const schemaRes = psql(readFileSync(SCHEMA_FILE, 'utf8'), { onErrorStop: false });
const schemaErrors = (schemaRes.out.match(/^psql:.*ERROR:/gm) ?? schemaRes.out.match(/ERROR:/g) ?? []);
notes.push(`schema apply reported ${schemaErrors.length} error line(s)`);
if (schemaErrors.length) notes.push('  first errors: ' + schemaErrors.slice(0, 3).join(' | ').slice(0, 400));

const counts = {
  tables: +q1(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'`),
  functions: +q1(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind in ('f','p')`),
  policies: +q1(`select count(*) from pg_policy pol join pg_class c on c.oid=pol.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'`),
  rls_tables: +q1(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity`),
};
console.log(`Restored shape: ${counts.tables} tables · ${counts.functions} functions · ${counts.policies} policies · RLS on ${counts.rls_tables}`);

// ── 3. data ──────────────────────────────────────────────────────────────────
// Per-table column strategy comes from the RESTORED schema, not the export:
// generated columns must be excluded, identity-always columns need OVERRIDING.
const tmp = mkdtempSync(join(tmpdir(), 'drill-'));
const BATCH = 100;
let loadedTables = 0, loadedRows = 0;
const countMismatches = [];
const loadErrors = [];

function loadTable(tbl, file, schema, table) {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (!lines.length) return 0;
  const targetIdent = `${schema}."${table}"`;
  const colInfo = q1(`
    select coalesce(string_agg(quote_ident(column_name), ',' order by ordinal_position), '')
         || '|' || coalesce(max(case when is_identity='YES' and identity_generation='ALWAYS' then 1 else 0 end)::text, '0')
      from information_schema.columns
     where table_schema='${schema}' and table_name='${table}'
       and is_generated = 'NEVER'`);
  const [colList, hasIdentity] = colInfo.split('|');
  if (!colList) { loadErrors.push(`${tbl}: no columns found in restored schema`); return 0; }
  const overriding = hasIdentity === '1' ? ' overriding system value' : '';

  let rows = 0;
  for (let i = 0; i < lines.length; i += BATCH) {
    const batch = lines.slice(i, i + BATCH);
    const json = '[' + batch.join(',') + ']';
    // Dollar-quote tag chosen to never appear in data; verified per batch.
    let tag = 'DRILLJSON';
    while (json.includes('$' + tag + '$')) tag += 'X';
    const sql = `set session_replication_role = replica;
insert into ${targetIdent} (${colList})${overriding}
select ${colList} from jsonb_populate_recordset(null::${targetIdent}, $${tag}$${json}$${tag}$::jsonb);`;
    const f = join(tmp, 'batch.sql');
    writeFileSync(f, sql);
    const r = spawnSync('docker',
      ['exec', '-i', '-e', 'PGPASSWORD=drill', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres',
       '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-f', '-'],
      { input: readFileSync(f), encoding: 'utf8', maxBuffer: 1024 * 1024 * 256 });
    if (r.status !== 0) {
      loadErrors.push(`${tbl} @row ${i}: ${((r.stderr ?? '') + (r.stdout ?? '')).slice(0, 220)}`);
      return rows; // stop this table, keep drilling the rest
    }
    rows += batch.length;
  }
  return rows;
}

console.log('Loading data…');
for (const m of manifest.tables) {
  if (!m.rows) continue;
  const file = join(DIR, `${m.table}.jsonl`);
  if (!existsSync(file)) { loadErrors.push(`${m.table}: file missing from export`); continue; }
  const n = loadTable(m.table, file, 'public', m.table);
  loadedRows += n; loadedTables += 1;
  const local = +q1(`select count(*) from public."${m.table}"`);
  if (local !== m.rows) countMismatches.push(`${m.table}: manifest ${m.rows}, restored ${local}`);
}
// auth
const authUsersRows = loadTable('auth.users', join(DIR, '_auth_users.jsonl'), 'auth', 'users');
const authIdRows = loadTable('auth.identities', join(DIR, '_auth_identities.jsonl'), 'auth', 'identities');
console.log(`Loaded ${loadedRows.toLocaleString()} rows across ${loadedTables} tables (+${authUsersRows} auth.users, +${authIdRows} auth.identities)`);

// Sequences: put every owned sequence past its column's max so inserts work.
psql(`do $seq$
declare r record;
begin
  for r in
    select seq.relname as seqname, tbl.relname as tblname, a.attname as colname
      from pg_class seq
      join pg_depend d on d.objid = seq.oid and d.deptype in ('a','i')
      join pg_class tbl on tbl.oid = d.refobjid
      join pg_attribute a on a.attrelid = tbl.oid and a.attnum = d.refobjsubid
      join pg_namespace n on n.oid = seq.relnamespace
     where seq.relkind = 'S' and n.nspname = 'public'
  loop
    execute format('select setval(%L, coalesce((select max(%I) from public.%I), 0) + 1, false)',
                   'public.' || r.seqname, r.colname, r.tblname);
  end loop;
end $seq$;`);

// ── 4. VERDICT (before any cleanup — always) ────────────────────────────────
console.log('\nVerifying…');

// 4a. every FK, orphan-swept. FK enforcement was off during load; this is the
// step that makes that honest. Counted: the number of comparisons is printed,
// because zero findings from zero comparisons looks exactly like a clean result.
const fkReport = q1(`
with fks as (
  select con.oid, con.conname,
         cn.nspname as child_schema, child.relname as child,
         pn.nspname as parent_schema, parent.relname as parent,
         (select array_agg(a.attname order by k.ord)
            from unnest(con.conkey) with ordinality k(attnum, ord)
            join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as child_cols,
         (select array_agg(a.attname order by k.ord)
            from unnest(con.confkey) with ordinality k(attnum, ord)
            join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum) as parent_cols
    from pg_constraint con
    join pg_class child on child.oid = con.conrelid
    join pg_namespace cn on cn.oid = child.relnamespace
    join pg_class parent on parent.oid = con.confrelid
    join pg_namespace pn on pn.oid = parent.relnamespace
   where con.contype = 'f' and cn.nspname = 'public'
)
select count(*)::text from fks;`);
const fkTotal = +fkReport;
const orphanSql = `
do $fk$
declare r record; n bigint; bad int := 0; checked int := 0;
begin
  create temp table if not exists _fk_orphans (constraint_name text, child text, orphans bigint);
  for r in
    select con.conname,
           cn.nspname || '.' || child.relname as child_ident,
           pn.nspname || '.' || parent.relname as parent_ident,
           (select string_agg(format('c.%I is not null', a.attname), ' and ')
              from unnest(con.conkey) with ordinality k(attnum, ord)
              join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as notnull_pred,
           (select string_agg(format('c.%I = p.%I', ca.attname, pa.attname), ' and ')
              from unnest(con.conkey)  with ordinality ck(attnum, ord)
              join pg_attribute ca on ca.attrelid = con.conrelid  and ca.attnum = ck.attnum
              join unnest(con.confkey) with ordinality pk(attnum, ord) on pk.ord = ck.ord
              join pg_attribute pa on pa.attrelid = con.confrelid and pa.attnum = pk.attnum) as join_pred
      from pg_constraint con
      join pg_class child on child.oid = con.conrelid
      join pg_namespace cn on cn.oid = child.relnamespace
      join pg_class parent on parent.oid = con.confrelid
      join pg_namespace pn on pn.oid = parent.relnamespace
     where con.contype = 'f' and cn.nspname = 'public'
  loop
    execute format('select count(*) from %s c where (%s) and not exists (select 1 from %s p where %s)',
                   r.child_ident, r.notnull_pred, r.parent_ident, r.join_pred) into n;
    checked := checked + 1;
    if n > 0 then
      bad := bad + 1;
      insert into _fk_orphans values (r.conname, r.child_ident, n);
    end if;
  end loop;
  raise notice 'FK_SWEEP checked=% dangling=%', checked, bad;
end $fk$;
select coalesce(string_agg(constraint_name || ' (' || child || '): ' || orphans || ' orphan(s)', E'\n'), 'CLEAN')
  from _fk_orphans;`;
const fkRun = psql(orphanSql);
const fkChecked = +(fkRun.out.match(/FK_SWEEP checked=(\d+)/)?.[1] ?? 0);
const fkResult = fkRun.out.split('\n').filter((l) => !l.startsWith('psql:') && l.trim() && !l.includes('FK_SWEEP')).join('\n').trim();
if (!fkRun.ok) failures.push('FK sweep did not run: ' + fkRun.out.slice(0, 300));
else if (fkChecked === 0) failures.push('FK sweep checked 0 constraints — that is not a pass, it is a broken checker');
else if (fkResult !== 'CLEAN') failures.push(`FK orphans found:\n${fkResult}`);
console.log(`  FK sweep: ${fkChecked} of ${fkTotal} constraints checked → ${fkResult === 'CLEAN' ? 'no orphans' : 'ORPHANS FOUND'}`);

// 4b. counts
if (countMismatches.length) failures.push(`row-count mismatches (${countMismatches.length}):\n  ` + countMismatches.slice(0, 10).join('\n  '));
console.log(`  Row counts: ${manifest.tables.filter((m) => m.rows).length - countMismatches.length}/${manifest.tables.filter((m) => m.rows).length} non-empty tables match the manifest`);
if (loadErrors.length) failures.push(`load errors (${loadErrors.length}):\n  ` + loadErrors.slice(0, 10).join('\n  '));

// 4c. auth linkage — the "restored but nobody can log in" check, inverted:
// every profile must point at a restored auth user.
const authManifest = readFileSync(join(DIR, '_auth_users.jsonl'), 'utf8').split('\n').filter(Boolean).length;
if (authUsersRows !== authManifest) failures.push(`auth.users: exported ${authManifest}, restored ${authUsersRows}`);
const orphanProfiles = +q1(`select count(*) from public.profiles p where p.user_id is not null and not exists (select 1 from auth.users u where u.id = p.user_id)`);
if (orphanProfiles > 0) failures.push(`${orphanProfiles} profile(s) point at auth users that did not restore`);
console.log(`  Auth: ${authUsersRows} users restored, ${orphanProfiles} orphaned profiles`);

// 4d. the app answers a question from restored data: a real worklist for a
// real employee, chosen FROM THE RESTORED ROWS (nothing hardcoded).
const smoke = psql(`
select w.worklist_key || '=' || w.row_count
  from (select d.tenant_id, d.id from public.digital_employees d
         where d.archetype_key = 'accounting' and d.status = 'active' limit 1) de,
       lateral public.get_de_worklists(de.tenant_id, de.id) w;`);
if (!smoke.ok) failures.push('functional smoke test failed — get_de_worklists did not answer against restored data: ' + smoke.out.slice(0, 300));
else console.log(`  Function smoke: get_de_worklists → ${smoke.out.trim().split('\n').join(', ') || '(no accounting DE in restore — empty answer, function ran)'}`);

// ── 5. verdict, then cleanup ────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));
if (failures.length) {
  console.log(`✗ DATA-RESTORE DRILL FAILED — ${failures.length} finding(s):\n`);
  for (const f of failures) console.log('  ✗ ' + f.split('\n').join('\n    '));
} else {
  console.log(`✓ DATA-RESTORE DRILL PASSED`);
  console.log(`  ${loadedRows.toLocaleString()} rows · ${loadedTables} tables · ${fkChecked} FKs swept clean · auth linked · functions answer`);
}
for (const n of notes) console.log('  ℹ ' + n);

let exitCode = failures.length ? 1 : 0;
if (!KEEP) {
  try { docker(['rm', '-f', CONTAINER]); rmSync(tmp, { recursive: true, force: true }); }
  catch (e) {
    console.log(`\n⚠ cleanup failed (${String(e).slice(0, 160)}) — the DRILL VERDICT ABOVE STANDS; remove the container by hand: docker rm -f ${CONTAINER}`);
    exitCode = failures.length ? 1 : 2;
  }
} else {
  console.log(`\ncontainer kept: docker exec -it ${CONTAINER} psql -U postgres`);
}
process.exit(exitCode);
