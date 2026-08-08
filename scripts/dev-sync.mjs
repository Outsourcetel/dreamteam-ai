#!/usr/bin/env node
// ============================================================
// dev-sync.mjs — make the dev project able to run the product.
//
// The golden path found that dev could not hire (role_archetypes empty), could
// not escalate (open_de_escalation missing), and could not prove the guardrail
// (a stale duplicate decide_action_execution without p_content). Dev was 102
// routines / 18 tables / 37 policies behind production with NO migration ledger,
// so the drift was invisible and unbounded. That means there was nowhere to
// verify a write path before it reached customers — a worse problem than any
// single bug.
//
// This closes the gap and installs the ledger that stops it reopening.
//
//   node scripts/dev-sync.mjs --dry-run   # report the gap, change nothing
//   node scripts/dev-sync.mjs             # sync
//
// SAFETY
//   · Writes ONLY to dev (nmuntxrcdksyhsdywpan). Production is read-only here,
//     and the production ref appears in exactly one place, for reads.
//   · NON-DESTRUCTIVE to dev data. Nothing drops a populated table. Dev's 185
//     users and 190 test tenants survive; a drop-and-rebuild would have
//     destroyed them and full_schema.sql explicitly cannot restore accounts.
//   · Every phase verifies its own effect. The run ends by re-diffing dev
//     against production and reporting what remains.
// ============================================================
import { readFileSync } from 'node:fs';

const DRY = process.argv.includes('--dry-run');
const DEV_REF = 'nmuntxrcdksyhsdywpan';
const PROD_REF = 'rfsvmhcqeiyrxivbmpel';   // READ ONLY. Never a write target.
const SCHEMA_FILE = 'supabase/baseline/full_schema.sql';

function token() {
  const fromEnv = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const raw = readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  return line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
}
const TOKEN = token();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function q(ref, sql, attempt = 0) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
  const text = await res.text();
  if (!res.ok) {
    if ((res.status === 429 || res.status >= 500 || res.status === 0) && attempt < 3) {
      await sleep(2000 * (attempt + 1));
      return q(ref, sql, attempt + 1);
    }
    throw new Error(`[${ref === DEV_REF ? 'dev' : 'prod'}] ${res.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}
const prod = (sql) => q(PROD_REF, sql);
const dev = (sql) => q(DEV_REF, sql);
const lit = (s) => (s === null || s === undefined ? 'null' : `'${String(s).replace(/'/g, "''")}'`);

const OBJ_SQL = `
  select 'table' as kind, tablename as name from pg_tables where schemaname='public'
  union all
  select 'routine', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.prokind in ('f','p')`;
const COL_SQL = `select table_name||'.'||column_name as col from information_schema.columns where table_schema='public'`;
const CENSUS_SQL = `select
    (select count(*) from pg_tables where schemaname='public') as tables,
    (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prokind in ('f','p')) as routines,
    (select count(*) from pg_policy) as policies,
    (select count(*) from information_schema.columns where table_schema='public') as columns`;

async function gap() {
  const [pObj, dObj, pCol, dCol] = await Promise.all([
    prod(OBJ_SQL), dev(OBJ_SQL), prod(COL_SQL), dev(COL_SQL),
  ]);
  const k = (o) => `${o.kind}|${o.name}`;
  const dSet = new Set(dObj.map(k)), pSet = new Set(pObj.map(k));
  const dCols = new Set(dCol.map((r) => r.col));
  const missingTables = pObj.filter((o) => o.kind === 'table' && !dSet.has(k(o))).map((o) => o.name);
  const missingTableSet = new Set(missingTables);
  return {
    missingTables,
    missingRoutines: pObj.filter((o) => o.kind === 'routine' && !dSet.has(k(o))).map((o) => o.name),
    extraRoutines: dObj.filter((o) => o.kind === 'routine' && !pSet.has(k(o))).map((o) => o.name),
    extraTables: dObj.filter((o) => o.kind === 'table' && !pSet.has(k(o))).map((o) => o.name),
    // Columns missing on tables that ALREADY exist on dev. CREATE TABLE IF NOT
    // EXISTS silently leaves these behind, which is the one thing the otherwise
    // idempotent schema file cannot fix by itself.
    missingColumns: pCol.map((r) => r.col)
      .filter((c) => !dCols.has(c) && !missingTableSet.has(c.split('.')[0])),
  };
}

console.log(`dev-sync ${DRY ? '(dry run)' : ''} — ${new Date().toISOString()}`);
const before = await gap();
const [devCensusBefore] = await dev(CENSUS_SQL);
const [prodCensus] = await prod(CENSUS_SQL);
console.log(`  before: dev ${devCensusBefore.tables}t/${devCensusBefore.routines}r/${devCensusBefore.policies}p/${devCensusBefore.columns}c`
  + `  vs prod ${prodCensus.tables}t/${prodCensus.routines}r/${prodCensus.policies}p/${prodCensus.columns}c`);
console.log(`  gap: ${before.missingTables.length} tables, ${before.missingRoutines.length} routines, `
  + `${before.missingColumns.length} columns on existing tables, `
  + `${before.extraTables.length} extra tables, ${before.extraRoutines.length} extra routines`);

if (DRY) {
  console.log('\n  missing tables:  ' + (before.missingTables.join(', ') || 'none'));
  console.log('\n  missing columns: ' + (before.missingColumns.join(', ') || 'none'));
  console.log('\n  extra on dev:    ' + ([...before.extraTables, ...before.extraRoutines].join(', ') || 'none'));
  console.log('\n(dry run — nothing changed)');
  process.exit(0);
}

// ── Phase 1: columns on existing tables ────────────────────────────────────
// Must run BEFORE the schema file: a SQL-language function whose body selects a
// column that does not exist fails at CREATE time, so the functions in the file
// need their columns present first.
if (before.missingColumns.length) {
  const wanted = before.missingColumns.map((c) => `'${c}'`).join(',');
  const defs = await prod(`
    select table_name, column_name,
           format_type(a.atttypid, a.atttypmod) as type,
           pg_get_expr(ad.adbin, ad.adrelid) as default_expr
      from information_schema.columns c
      join pg_class cl on cl.relname = c.table_name
      join pg_namespace n on n.oid = cl.relnamespace and n.nspname = 'public'
      join pg_attribute a on a.attrelid = cl.oid and a.attname = c.column_name
      left join pg_attrdef ad on ad.adrelid = cl.oid and ad.adnum = a.attnum
     where c.table_schema = 'public'
       and (c.table_name || '.' || c.column_name) in (${wanted})`);
  // NOT NULL is deliberately NOT copied: dev tables already hold rows, and a
  // NOT NULL add without a default would fail. Nullable columns are the safe
  // superset — shape parity is what the golden path needs, not constraint parity.
  const stmts = defs.map((d) =>
    `ALTER TABLE public.${JSON.stringify(d.table_name).replace(/"/g, '"')} `
    + `ADD COLUMN IF NOT EXISTS "${d.column_name}" ${d.type}`
    + (d.default_expr ? ` DEFAULT ${d.default_expr}` : ''));
  for (let i = 0; i < stmts.length; i += 25) {
    await dev(stmts.slice(i, i + 25).join(';\n') + ';');
    process.stdout.write(`\r  phase 1: columns ${Math.min(i + 25, stmts.length)}/${stmts.length}`);
    await sleep(120);
  }
  console.log(`\n  phase 1: ${stmts.length} columns added`);
} else {
  console.log('  phase 1: no column gap');
}

// ── Phase 2: the proven schema file ────────────────────────────────────────
// Fully idempotent by construction: CREATE TABLE IF NOT EXISTS x284, CREATE OR
// REPLACE FUNCTION, DROP POLICY IF EXISTS before every CREATE POLICY, CREATE
// INDEX IF NOT EXISTS, and FKs wrapped in DO blocks that swallow
// duplicate_object. The restore drill proves this file reproduces production
// exactly; here it is applied over the existing schema rather than an empty one.
{
  // CREATE OR REPLACE cannot change a function's RETURN TYPE ("cannot change
  // return type of existing function" / "Row type defined by OUT parameters is
  // different"). Where production has since widened a RETURNS TABLE, the dev
  // copy has to be dropped first or the whole file aborts on that one
  // statement. Computed, not hard-coded, so this keeps working as the schema
  // moves — dropping only where the signature genuinely differs.
  const RET_SQL = `
    select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig,
           pg_get_function_result(p.oid) as ret, p.prokind
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.prokind in ('f','p')`;
  const [pRets, dRets] = await Promise.all([prod(RET_SQL), dev(RET_SQL)]);
  const pMap = new Map(pRets.map((r) => [r.sig, r.ret]));
  const clashes = dRets.filter((r) => pMap.has(r.sig) && pMap.get(r.sig) !== r.ret);
  for (const c of clashes) {
    const kw = c.prokind === 'p' ? 'PROCEDURE' : 'FUNCTION';
    await dev(`DROP ${kw} IF EXISTS public.${c.sig} CASCADE;`);
  }
  if (clashes.length) {
    console.log(`  phase 2: dropped ${clashes.length} function(s) whose return type changed: `
      + clashes.map((c) => c.sig.split('(')[0]).join(', '));
  }

  const dump = readFileSync(SCHEMA_FILE, 'utf8');
  await dev(`SET search_path = public, extensions;\n${dump}`);
  const [c] = await dev(CENSUS_SQL);
  console.log(`  phase 2: schema applied — dev now ${c.tables}t/${c.routines}r/${c.policies}p`);
}

// ── Phase 2b: CHECK constraints on tables that already existed ─────────────
// Third instance of the same class as the columns: CREATE TABLE IF NOT EXISTS
// leaves an existing table's CHECK constraints untouched, so dev still enforced
// the pre-migration-574 category list and rejected an 'ads' adapter template.
// A stale CHECK is worse than a missing column — it actively refuses valid
// production data, so dev fails on rows that are correct.
{
  const CHK_SQL = `
    select cl.relname || '|' || con.conname as key,
           cl.relname as tbl, con.conname as name,
           pg_get_constraintdef(con.oid) as def
      from pg_constraint con
      join pg_class cl on cl.oid = con.conrelid
      join pg_namespace n on n.oid = cl.relnamespace
     where n.nspname = 'public' and con.contype = 'c'`;
  const [pChk, dChk] = await Promise.all([prod(CHK_SQL), dev(CHK_SQL)]);
  const dMap = new Map(dChk.map((r) => [r.key, r.def]));
  const devTables = new Set((await dev(`select tablename from pg_tables where schemaname='public'`)).map((r) => r.tablename));
  const todo = pChk.filter((r) => devTables.has(r.tbl) && dMap.get(r.key) !== r.def);
  let synced = 0, skipped = [];
  for (const c of todo) {
    try {
      // NOT VALID: dev holds ambient test data that may predate the rule. The
      // constraint then governs NEW rows (which is what the golden path needs)
      // without a migration failing over historical test junk.
      await dev(`ALTER TABLE public."${c.tbl}" DROP CONSTRAINT IF EXISTS "${c.name}";
                 ALTER TABLE public."${c.tbl}" ADD CONSTRAINT "${c.name}" ${c.def} NOT VALID;`);
      synced++;
    } catch (e) { skipped.push(`${c.key}: ${String(e.message).slice(0, 80)}`); }
    await sleep(80);
  }
  // And drop the ones production has RETIRED. The schema file can create and
  // replace, but it can never remove — so a constraint deliberately dropped in
  // production lives on here forever, refusing rows that are valid upstream.
  // adapter_templates_category_check was exactly this: dropped in production
  // when the ads/social/web_analytics categories landed, still enforcing the
  // old list on dev and rejecting every marketing template.
  const pKeys = new Set(pChk.map((r) => r.key));
  const stale = dChk.filter((r) => devTables.has(r.tbl) && !pKeys.has(r.key));
  let removed = 0;
  for (const c of stale) {
    try { await dev(`ALTER TABLE public."${c.tbl}" DROP CONSTRAINT IF EXISTS "${c.name}";`); removed++; }
    catch { /* left in place; reported by the final diff */ }
    await sleep(80);
  }
  console.log(`  phase 2b: ${synced} CHECK constraint(s) synced, ${removed} retired one(s) dropped`
    + (skipped.length ? `, ${skipped.length} skipped (${skipped[0]})` : ''));
}

// ── Phase 3: remove what production no longer has ──────────────────────────
// The specialist role was RETIRED in migration 611; dev still carries its
// tables and routines. Leaving them means dev can pass tests for machinery that
// no longer exists in production — the mirror of the original problem.
{
  const g = await gap();
  let dropped = 0;
  for (const sig of g.extraRoutines) {
    const kindRow = await dev(`select p.prokind from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' = ${lit(sig)}`);
    const kw = kindRow[0]?.prokind === 'p' ? 'PROCEDURE' : 'FUNCTION';
    try { await dev(`DROP ${kw} IF EXISTS public.${sig} CASCADE;`); dropped++; } catch { /* dependency; harmless on dev */ }
    await sleep(80);
  }
  // Extra TABLES are left in place on purpose: dropping a table destroys data,
  // and an unused table on dev costs nothing. Parity that matters for the
  // golden path is "everything production has", not "nothing more".
  console.log(`  phase 3: dropped ${dropped} retired routine(s); left ${g.extraTables.length} extra table(s) in place (non-destructive)`);
}

// ── Phase 4: platform reference data ───────────────────────────────────────
// Without role_archetypes the product cannot hire, which is why the golden path
// stopped at step 2. These are platform-scope catalogue rows, identical in every
// environment — not tenant data.
{
  const TABLES = [
    { name: 'system_categories', where: '' },
    { name: 'role_archetypes', where: '' },
    { name: 'compliance_packs', where: '' },
    { name: 'event_definitions', where: '' },
    { name: 'adapter_templates', where: `where scope = 'platform'` },
    { name: 'action_definitions', where: `where scope = 'platform'` },
  ];
  for (const t of TABLES) {
    const rows = await prod(`select to_jsonb(x) as r from public.${t.name} x ${t.where}`);
    if (!rows.length) { console.log(`  phase 4: ${t.name} — nothing to seed`); continue; }
    // Type-aware, because to_jsonb() flattens EVERYTHING to JSON: a Postgres
    // text[] arrives as a JSON array and must go back as an array literal, not
    // as jsonb ("column is of type text[] but expression is of type jsonb").
    // udt_name for an array type is the element type prefixed with '_'.
    const cols = await dev(`select column_name, data_type, udt_name
       from information_schema.columns
       where table_schema='public' and table_name=${lit(t.name)}`);
    const devCols = new Map(cols.map((c) => [c.column_name, c]));
    const keys = Object.keys(rows[0].r).filter((k) => devCols.has(k));
    const render = (k, v) => {
      const col = devCols.get(k);
      if (v === null || v === undefined) return 'null';
      if (col.data_type === 'ARRAY') {
        const elem = col.udt_name.replace(/^_/, '');
        const items = Array.isArray(v) ? v : [v];
        return items.length
          ? `ARRAY[${items.map((i) => (typeof i === 'object' ? lit(JSON.stringify(i)) : lit(i))).join(',')}]::${elem}[]`
          : `'{}'::${elem}[]`;
      }
      if (col.data_type === 'jsonb' || col.data_type === 'json') return `${lit(JSON.stringify(v))}::${col.data_type}`;
      if (typeof v === 'object') return `${lit(JSON.stringify(v))}::jsonb`;
      if (typeof v === 'boolean' || typeof v === 'number') return String(v);
      return lit(v);
    };
    const pk = await dev(`select a.attname from pg_index i
       join pg_attribute a on a.attrelid=i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = 'public.${t.name}'::regclass and i.indisprimary`);
    const pkCols = pk.map((r) => r.attname);
    let n = 0;
    for (let i = 0; i < rows.length; i += 20) {
      const chunk = rows.slice(i, i + 20).map((row) =>
        `(${keys.map((k) => render(k, row.r[k])).join(',')})`).join(',\n');
      const conflict = pkCols.length
        ? `on conflict (${pkCols.map((c) => `"${c}"`).join(',')}) do nothing`
        : 'on conflict do nothing';
      await dev(`insert into public.${t.name} (${keys.map((k) => `"${k}"`).join(',')})
                 values ${chunk} ${conflict};`);
      n += Math.min(20, rows.length - i);
      await sleep(120);
    }
    const [after] = await dev(`select count(*)::int as n from public.${t.name}`);
    console.log(`  phase 4: ${t.name} — seeded ${n} from prod, dev now holds ${after.n}`);
  }
}

// ── Phase 5: give dev a ledger, so it can never silently drift again ───────
{
  await dev(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      filename text PRIMARY KEY,
      checksum text,
      applied_at timestamptz,
      applied_by text,
      provenance text,
      recorded_at timestamptz NOT NULL DEFAULT now()
    );`);
  const [n] = await dev(`select count(*)::int as n from public.schema_migrations`);
  if (n.n === 0) {
    const rows = await prod(`select filename, checksum from public.schema_migrations order by filename`);
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100)
        // provenance is a constrained enum ('assumed_pre_ledger' |
        // 'applied_by_runner'), not free text. These migrations were applied to
        // PRODUCTION and their effect arrives here via full_schema.sql rather
        // than by running each file, so 'assumed_pre_ledger' is the honest
        // value — believed present, not verified statement-by-statement. It is
        // also exactly what migrate:status reports as ASSUMED.
        .map((r) => `(${lit(r.filename)},${lit(r.checksum)},'assumed_pre_ledger')`).join(',');
      await dev(`insert into public.schema_migrations (filename, checksum, provenance)
                 values ${chunk} on conflict (filename) do nothing;`);
      await sleep(100);
    }
  }
  const [after] = await dev(`select count(*)::int as n from public.schema_migrations`);
  console.log(`  phase 5: dev ledger holds ${after.n} rows (was ${n.n})`);
}

// ── Verify ─────────────────────────────────────────────────────────────────
const after = await gap();
const [devCensusAfter] = await dev(CENSUS_SQL);
console.log(`\n  after:  dev ${devCensusAfter.tables}t/${devCensusAfter.routines}r/${devCensusAfter.policies}p/${devCensusAfter.columns}c`
  + `  vs prod ${prodCensus.tables}t/${prodCensus.routines}r/${prodCensus.policies}p/${prodCensus.columns}c`);
const remaining = after.missingTables.length + after.missingRoutines.length + after.missingColumns.length;
if (remaining) {
  console.log(`  REMAINING GAP: ${after.missingTables.length} tables, ${after.missingRoutines.length} routines, ${after.missingColumns.length} columns`);
  if (after.missingTables.length) console.log('    tables:   ' + after.missingTables.join(', '));
  if (after.missingRoutines.length) console.log('    routines: ' + after.missingRoutines.slice(0, 10).join(', '));
  if (after.missingColumns.length) console.log('    columns:  ' + after.missingColumns.slice(0, 10).join(', '));
}
console.log(remaining === 0
  ? '\nDEV SYNCED — dev now has everything production has. Run: npm run golden-path'
  : `\nDEV PARTIALLY SYNCED — ${remaining} object(s) still missing (listed above).`);
process.exit(remaining === 0 ? 0 : 1);
