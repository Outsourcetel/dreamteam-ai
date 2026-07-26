#!/usr/bin/env node
// ============================================================
// generate-baseline.mjs — reconstruct CREATE TABLE DDL for tables that exist in
// production but have no CREATE statement anywhere in supabase/migrations/.
//
// WHY THIS EXISTS
// 19 production tables — including `tenants` and `profiles`, which almost
// everything else foreign-keys to — were created before this repo's migration
// history began (supabase/migrations/README.md: "001-010 are legacy... Do not
// re-apply"). Migration 001 line 23 already does `references tenants(id)`.
// So the repository cannot rebuild its own database: a replay onto an empty
// project fails on the first file. Combined with backups that have never been
// restore-tested, losing the Supabase project means losing the business.
//
// This reads the live catalog and emits ordered, idempotent DDL. It is
// STRICTLY READ-ONLY against production — it only ever SELECTs.
//
//   node scripts/generate-baseline.mjs > supabase/baseline/000_baseline_core.sql
//
// WHAT IT DOES NOT DO (deliberately, and stated so nobody assumes otherwise):
//   · does not emit data — structure only
//   · does not emit functions/triggers owned by later migrations
//   · does not make the FULL history replayable; it makes the FK chain
//     resolvable, which is the prerequisite for that work
// ============================================================
import { readFileSync } from 'node:fs';

const PROJECT_REF = 'rfsvmhcqeiyrxivbmpel';
const ENDPOINT = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

function token() {
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

// Compute the missing set here rather than reading a stray file: a generator
// that depends on an untracked artifact silently produces the wrong output the
// first time someone else runs it.
const { readdirSync } = await import('node:fs');
const { join } = await import('node:path');
const MIG_DIR = 'supabase/migrations';
let allSql = '';
for (const f of readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql') && true /* baseline lives outside this dir */)) {
  allSql += readFileSync(join(MIG_DIR, f), 'utf8') + '\n';
}
const creatable = new Set();
{
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi;
  let m; while ((m = re.exec(allSql))) creatable.add(m[1].toLowerCase());
}
const prodTables = (await q(`
  select string_agg(table_name, ',' order by table_name) as t
    from information_schema.tables
   where table_schema='public' and table_type='BASE TABLE'`))[0].t.split(',');

const TABLES = prodTables.filter((t) => !creatable.has(t.toLowerCase()));
if (TABLES.length === 0) {
  process.stderr.write('nothing missing — every production table has a CREATE statement in the repo\n');
  process.exit(0);
}
const list = TABLES.map((t) => `'${t}'`).join(',');
process.stderr.write(`${prodTables.length} prod tables · ${creatable.size} creatable from repo · ${TABLES.length} missing\n`);

// ── Columns, with the exact formatted type and default ──────────────────────
const cols = await q(`
  select c.relname as tbl, a.attnum, a.attname as col,
         format_type(a.atttypid, a.atttypmod) as type,
         a.attnotnull as notnull,
         pg_get_expr(d.adbin, d.adrelid) as default_expr
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where n.nspname = 'public' and c.relname in (${list})
     and a.attnum > 0 and not a.attisdropped
   order by c.relname, a.attnum`);

// ── Constraints. Split so FKs can be emitted AFTER every table exists. ──────
const cons = await q(`
  select c.relname as tbl, con.conname as name, con.contype as type,
         pg_get_constraintdef(con.oid) as def
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in (${list})
   order by c.relname, con.contype, con.conname`);

// ── Indexes not already implied by a constraint ────────────────────────────
const idx = await q(`
  select tablename as tbl, indexname as name, indexdef as def
    from pg_indexes
   where schemaname = 'public' and tablename in (${list})
     and indexname not in (
       select con.conname from pg_constraint con
         join pg_class c on c.oid = con.conrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname='public' and c.relname in (${list}))
   order by tablename, indexname`);

// ── RLS + policies: security posture is part of the schema, not an extra ────
const rls = await q(`
  select c.relname as tbl, c.relrowsecurity as enabled
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname='public' and c.relname in (${list})`);

const pol = await q(`
  select c.relname as tbl, quote_ident(p.polname) as name,
         case p.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT'
                       when 'w' then 'UPDATE' when 'd' then 'DELETE' else 'ALL' end as cmd,
         pg_get_expr(p.polqual, p.polrelid) as using_expr,
         pg_get_expr(p.polwithcheck, p.polrelid) as check_expr,
         (select string_agg(quote_ident(r.rolname), ', ')
            from pg_roles r where r.oid = any(p.polroles)) as roles
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname='public' and c.relname in (${list})
   order by c.relname, p.polname`);

const by = (rows, key) => rows.reduce((m, r) => ((m[r[key]] ??= []).push(r), m), {});
const C = by(cols, 'tbl'), K = by(cons, 'tbl'), I = by(idx, 'tbl'), P = by(pol, 'tbl');
const rlsOn = new Set(rls.filter((r) => r.enabled).map((r) => r.tbl));

// ── Order tables so a FK never precedes its target ─────────────────────────
const deps = {};
for (const t of TABLES) {
  deps[t] = new Set(
    (K[t] || []).filter((c) => c.type === 'f')
      .map((c) => (c.def.match(/REFERENCES\s+(?:public\.)?"?([a-z0-9_]+)"?/i) || [])[1])
      .filter((x) => x && x !== t && TABLES.includes(x)),
  );
}
const ordered = [];
const seen = new Set();
const visit = (t, stack = new Set()) => {
  if (seen.has(t) || stack.has(t)) return;   // stack guard: a cycle emits FKs separately below
  stack.add(t);
  for (const d of deps[t]) visit(d, stack);
  stack.delete(t);
  seen.add(t); ordered.push(t);
};
TABLES.forEach((t) => visit(t));

// ── Emit ───────────────────────────────────────────────────────────────────
const out = [];
out.push(`-- 000_baseline_core.sql`);
out.push(`-- ============================================================================`);
out.push(`-- GENERATED by scripts/generate-baseline.mjs from the live production catalog.`);
out.push(`-- Do not hand-edit: regenerate.`);
out.push(`--`);
out.push(`-- These ${TABLES.length} tables exist in production but had no CREATE TABLE anywhere in`);
out.push(`-- supabase/migrations/. They predate this repo's migration history (README: 001-010`);
out.push(`-- are legacy, "do not re-apply"), yet migration 001 line 23 already does`);
out.push(`-- 'references tenants(id)'. So the repository could not rebuild its own database:`);
out.push(`-- a replay onto an empty project failed on the first file.`);
out.push(`--`);
out.push(`-- Lives in supabase/baseline/, NOT supabase/migrations/: it is not a migration and`);
out.push(`-- must never be recorded in the migration ledger as applied.`);
out.push(`--`);
out.push(`-- THIS IS A REBUILD ARTIFACT, NOT A MIGRATION TO RUN AGAINST PRODUCTION.`);
out.push(`-- The table, index and foreign-key sections ARE idempotent. The POLICY section is`);
out.push(`-- NOT: it drops and recreates each policy so a rebuild is deterministic. Running`);
out.push(`-- that against a live database would churn real RLS policies, so do not.`);
out.push(`-- Production already has these ${TABLES.length} tables; this file exists so an EMPTY database`);
out.push(`-- can be brought to the same shape.`);
out.push(`--`);
out.push(`-- Structure only: no data, and no functions/triggers that later migrations own.`);
out.push(`-- ============================================================================`);
out.push('');

for (const t of ordered) {
  const cs = C[t] || [];
  if (!cs.length) continue;
  out.push(`-- ── ${t} ${'─'.repeat(Math.max(0, 68 - t.length))}`);
  const lines = cs.map((c) => {
    let s = `  ${JSON.stringify(c.col).replace(/"/g, '"')} ${c.type}`;
    if (c.default_expr) s += ` DEFAULT ${c.default_expr}`;
    if (c.notnull) s += ' NOT NULL';
    return s;
  });
  // primary key inline; unique + check inline; FKs deferred to the end
  for (const k of (K[t] || []).filter((k) => k.type === 'p' || k.type === 'u' || k.type === 'c')) {
    lines.push(`  CONSTRAINT ${k.name} ${k.def}`);
  }
  out.push(`CREATE TABLE IF NOT EXISTS public.${t} (`);
  out.push(lines.join(',\n'));
  out.push(`);`);
  out.push('');
}

out.push(`-- ── Foreign keys, after every table exists ──────────────────────────────────`);
for (const t of ordered) {
  for (const k of (K[t] || []).filter((k) => k.type === 'f')) {
    out.push(`DO $$ BEGIN`);
    out.push(`  ALTER TABLE public.${t} ADD CONSTRAINT ${k.name} ${k.def};`);
    out.push(`EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  }
}
out.push('');

out.push(`-- ── Indexes ─────────────────────────────────────────────────────────────────`);
for (const t of ordered) {
  for (const i of (I[t] || [])) {
    out.push(i.def.replace(/^CREATE (UNIQUE )?INDEX /i, (m, u) => `CREATE ${u || ''}INDEX IF NOT EXISTS `) + ';');
  }
}
out.push('');

out.push(`-- ── Row Level Security ──────────────────────────────────────────────────────`);
out.push(`-- Emitted with the tables because on a multi-tenant system RLS is not a`);
out.push(`-- hardening step applied later — a table restored without it is a data leak.`);
for (const t of ordered) {
  if (rlsOn.has(t)) out.push(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
}
out.push('');

for (const t of ordered) {
  for (const p of (P[t] || [])) {
    out.push(`DROP POLICY IF EXISTS ${p.name} ON public.${t};`);
    let s = `CREATE POLICY ${p.name} ON public.${t} FOR ${p.cmd}`;
    if (p.roles && p.roles !== 'public') s += ` TO ${p.roles}`;
    if (p.using_expr) s += ` USING (${p.using_expr})`;
    if (p.check_expr) s += ` WITH CHECK (${p.check_expr})`;
    out.push(s + ';');
  }
}
out.push('');
out.push(`NOTIFY pgrst, 'reload schema';`);

process.stdout.write(out.join('\n') + '\n');
process.stderr.write(`generated ${ordered.length} tables · ${cons.length} constraints · ${idx.length} indexes · ${pol.length} policies\n`);
