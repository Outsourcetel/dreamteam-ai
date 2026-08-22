#!/usr/bin/env node
// ============================================================
// backup-schema.mjs — dump the COMPLETE public schema to a single file that can
// rebuild this database's structure from nothing.
//
// WHY THIS EXISTS — the finding that prompted it
// The production organisation is on the Supabase **free plan**
// (GET /v1/organizations/<org> -> "plan":"free"), and
// GET /v1/projects/<ref>/database/backups returns **"backups": []**.
// There are no automated backups. Not "backups we have never restore-tested" —
// none. If this project is deleted, corrupted, or paused-then-lost, there is no
// restore path at all: 16 tenants, ~19 users and ~2,000 documents are gone.
//
// PITR needs a paid plan and is the founder's call. This script needs nothing:
// it turns "the schema exists only inside Supabase" into "the schema is in git".
// It does NOT back up DATA — see backup-data.mjs for that, and read the honesty
// note at the bottom of this comment.
//
// WHY IT DUMPS GRANTS TOO
// Migration 365 revoked EXECUTE from PUBLIC/anon/authenticated on 25 SECURITY
// DEFINER writers. Postgres grants EXECUTE to PUBLIC by default, so a schema
// restored WITHOUT its ACLs comes back with every one of those functions open
// to the internet again. A schema backup that silently drops the security
// posture is worse than none, because it looks like a restore succeeded.
//
// Strictly read-only against production: SELECT/WITH only, enforced below.
//
//   node scripts/backup-schema.mjs > supabase/baseline/full_schema.sql
//   npm run backup:schema
// ============================================================
import { readFileSync } from 'node:fs';

const DEV = process.argv.includes('--dev');
const PROJECT_REF = DEV ? 'nmuntxrcdksyhsdywpan' : 'rfsvmhcqeiyrxivbmpel';
const ENDPOINT = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

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
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

const say = (m) => process.stderr.write(m + '\n');

// ── Extensions first: a column typed `vector` fails without pgvector ────────
const exts = await q(`
  select extname, extversion, n.nspname as schema
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace
   where extname not in ('plpgsql')
   order by extname`);

// ── Enums, before any table that uses one ──────────────────────────────────
const enums = await q(`
  select t.typname,
         string_agg(quote_literal(e.enumlabel), ', ' order by e.enumsortorder) as labels
    from pg_type t
    join pg_enum e on e.enumtypid = t.oid
    join pg_namespace n on n.oid = t.typnamespace
   where n.nspname = 'public'
   group by t.typname order by t.typname`);

const cols = await q(`
  select c.relname as tbl, a.attnum, a.attname as col,
         format_type(a.atttypid, a.atttypmod) as type,
         a.attnotnull as notnull,
         pg_get_expr(d.adbin, d.adrelid) as default_expr,
         -- 's' = GENERATED ALWAYS AS (...) STORED. pg_attrdef holds the
         -- GENERATION expression for these, not a default. Emitting it as
         -- DEFAULT produces "cannot use column reference in DEFAULT expression"
         -- on restore, because the expression references a sibling column.
         a.attgenerated as generated,
         a.attidentity as identity
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where n.nspname = 'public' and c.relkind = 'r'
     and a.attnum > 0 and not a.attisdropped
   order by c.relname, a.attnum`);

const cons = await q(`
  select c.relname as tbl, quote_ident(con.conname) as name, con.contype as type,
         pg_get_constraintdef(con.oid) as def
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
   order by c.relname, con.contype, con.conname`);

const idx = await q(`
  select tablename as tbl, indexname as name, indexdef as def
    from pg_indexes
   where schemaname = 'public'
     and indexname not in (
       select con.conname from pg_constraint con
         join pg_class c on c.oid = con.conrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public')
   order by tablename, indexname`);

// Functions BEFORE triggers and policies: both can reference them.
//
// EXCLUDES anything an extension owns. pgvector, pg_net and pg_cron all install
// LANGUAGE c functions into `public`, and dumping those produces
// "permission denied for language c" on restore — nobody but a superuser may
// create them. They come back with CREATE EXTENSION instead. pg_dump applies
// the same pg_depend deptype='e' filter for the same reason.
// ...but NOT all of them can go first, which is the other half of the ordering
// problem. A function declared `RETURNS SETOF de_skills` uses a TABLE's row
// type, and a return type is resolved at CREATE time no matter what
// check_function_bodies says. So:
//   needs_tables = false -> emit BEFORE tables (CHECK constraints may call it)
//   needs_tables = true  -> emit AFTER  tables (it names a table row type)
// Both orderings are required simultaneously; one pass cannot satisfy both.
const funcs = await q(`
  with fn as (
    select p.oid, p.proname, pg_get_functiondef(p.oid) as def,
           p.oid::regprocedure::text as sig,
           array_append(p.proargtypes::oid[], p.prorettype) as all_types
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind in ('f', 'p')
       and not exists (select 1 from pg_depend d
                        where d.objid = p.oid and d.classid = 'pg_proc'::regclass
                          and d.deptype = 'e'))
  select proname, def, sig,
         exists (
           select 1 from unnest(all_types) t(oid)
             join pg_type ty on ty.oid = t.oid
             join pg_class c on c.oid = ty.typrelid
             join pg_namespace tn on tn.oid = c.relnamespace
            where c.relkind = 'r' and tn.nspname = 'public') as needs_tables
    from fn
   order by proname, sig`);

const trigs = await q(`
  select c.relname as tbl, quote_ident(t.tgname) as name, pg_get_triggerdef(t.oid) as def
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and not t.tgisinternal
   order by c.relname, t.tgname`);

// ── Sequences ──────────────────────────────────────────────────────────────
// A legacy `serial` column carries DEFAULT nextval('<table>_id_seq'::regclass).
// Without the sequence, CREATE TABLE fails with "relation ... does not exist".
// Identity columns own their sequence implicitly and are excluded.
const seqs = await q(`
  select c.relname as name, s.seqstart, s.seqincrement, s.seqmin, s.seqmax,
         format_type(s.seqtypid, null) as type
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_sequence s on s.seqrelid = c.oid
   where n.nspname = 'public' and c.relkind = 'S'
     and not exists (select 1 from pg_depend d
                      where d.objid = c.oid and d.classid = 'pg_class'::regclass
                        and d.deptype = 'i')
   order by c.relname`);

// ── Views ──────────────────────────────────────────────────────────────────
// The first version of this script dumped relkind='r' only and silently omitted
// all four views — including connector_secrets_decrypted and
// specialist_source_secrets_decrypted, which are how decrypted credentials are
// read. A "complete schema backup" missing those restores a database where
// credential reads fail and nobody knows why.
const views = await q(`
  select c.relname as name, pg_get_viewdef(c.oid, true) as def, c.relkind
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('v', 'm')
   order by c.relname`);

const rls = await q(`
  select c.relname as tbl, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity`);

const pol = await q(`
  select c.relname as tbl, quote_ident(p.polname) as name,
         case p.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT'
                       when 'w' then 'UPDATE' when 'd' then 'DELETE' else 'ALL' end as cmd,
         p.polpermissive as permissive,
         pg_get_expr(p.polqual, p.polrelid) as using_expr,
         pg_get_expr(p.polwithcheck, p.polrelid) as check_expr,
         (select string_agg(quote_ident(r.rolname), ', ')
            from pg_roles r where r.oid = any(p.polroles)) as roles
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
   order by c.relname, p.polname`);

// ── Function ACLs. THE SECURITY POSTURE. See the header. ───────────────────
// Anything NOT executable by a client role gets an explicit REVOKE emitted, so
// a restore reproduces the closed perimeter instead of Postgres's open default.
const fnAcl = await q(`
  select p.oid::regprocedure::text as sig,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon_x,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_x
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind in ('f', 'p')
   order by 1`);

const tblAcl = await q(`
  select c.relname as tbl,
         has_table_privilege('anon', c.oid, 'SELECT') as anon_r,
         has_table_privilege('anon', c.oid, 'INSERT') as anon_w,
         has_table_privilege('authenticated', c.oid, 'SELECT') as auth_r,
         has_table_privilege('authenticated', c.oid, 'INSERT') as auth_w
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
   order by c.relname`);

// ── The OTHER half of the perimeter, and the half this file used to drop ───
// The REVOKEs below preserve what is CLOSED. Nothing preserved what is OPEN,
// so a restore produced a database where every API role had nothing and no
// client could talk to it. Measured 2026-08-20 (register A-12): production
// holds 5964 grants in public — anon 712, authenticated 872, service_role
// 2185 — and dev, rebuilt from this file, held ZERO while matching production
// on tables, functions and policies exactly. Structurally perfect, unusable.
//
// aclexplode over pg_class rather than information_schema.role_table_grants:
// one query covers tables, views, materialised views AND sequences, and gives
// the exact privilege set instead of the SELECT/INSERT booleans above. A
// sequence with no USAGE is how an INSERT fails on a table that looks granted.
const relAcl = await q(`
  select c.relkind::text as kind, c.relname as rel,
         pg_get_userbyid(a.grantee) as grantee,
         string_agg(distinct a.privilege_type, ', ' order by a.privilege_type) as privs
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) a
   where n.nspname = 'public'
     and c.relkind in ('r', 'v', 'm', 'S')
     and pg_get_userbyid(a.grantee) in ('anon', 'authenticated', 'service_role')
   group by 1, 2, 3
   order by 2, 3`);

const by = (rows, key) => rows.reduce((m, r) => ((m[r[key]] ??= []).push(r), m), {});
const C = by(cols, 'tbl'), K = by(cons, 'tbl'), I = by(idx, 'tbl'),
      P = by(pol, 'tbl'), T = by(trigs, 'tbl');
const TABLES = [...new Set(cols.map((c) => c.tbl))];

// ── Order tables so a FK never precedes its target ─────────────────────────
const deps = {};
for (const t of TABLES) {
  deps[t] = new Set(
    (K[t] || []).filter((c) => c.type === 'f')
      .map((c) => (c.def.match(/REFERENCES\s+(?:public\.)?"?([a-z0-9_]+)"?/i) || [])[1])
      .filter((x) => x && x !== t && TABLES.includes(x)));
}
const ordered = [], seen = new Set();
const visit = (t, stack = new Set()) => {
  if (seen.has(t) || stack.has(t)) return;
  stack.add(t);
  for (const d of deps[t]) visit(d, stack);
  stack.delete(t); seen.add(t); ordered.push(t);
};
TABLES.forEach((t) => visit(t));

const o = [];
o.push(`-- full_schema.sql — COMPLETE public schema, generated by scripts/backup-schema.mjs`);
o.push(`-- ============================================================================`);
o.push(`-- Do not hand-edit: regenerate with \`npm run backup:schema\`.`);
o.push(`--`);
o.push(`-- WHY: the Supabase organisation is on the FREE plan and the backups endpoint`);
o.push(`-- returns an EMPTY list. There are no automated backups of this database. This`);
o.push(`-- file is the schema half of the answer; data is NOT in here (see below).`);
o.push(`--`);
o.push(`-- Contents: ${exts.length} extensions · ${enums.length} enums · ${ordered.length} tables ·`);
o.push(`-- ${cons.length} constraints · ${idx.length} indexes · ${funcs.length} functions ·`);
o.push(`-- ${trigs.length} triggers · ${pol.length} policies · ${relAcl.length} role grants ·
-- explicit REVOKEs for the closed perimeter.`);
o.push(`--`);
o.push(`-- WHAT THIS DOES NOT COVER, so nobody mistakes it for a full backup:`);
o.push(`--   · no table DATA — tenants, users, documents, conversations are all absent`);
o.push(`--   · no auth.users — accounts do not come back from this file`);
o.push(`--   · no storage objects, no vault secrets, no edge-function code`);
o.push(`--   · no pg_cron schedules`);
o.push(`-- Restoring this yields an EMPTY, correctly-shaped, correctly-secured and
-- REACHABLE database — the last of those was missing until 2026-08-20: the file
-- carried the REVOKEs and none of the GRANTs, so a restore came back with every
-- table present and no API role able to read one (register A-12).`);
o.push(`-- ============================================================================`);
o.push('');
// LANGUAGE sql function bodies are validated at CREATE time, so a function
// that calls a function defined later in this file kills the restore — caught
// live 2026-08-20 by restore-drill: five callers of evidence_is_production
// (mig 682) precede its definition. pg_dump solves this with exactly this
// knob, and so do we. plpgsql was never affected (bodies parse lazily), and
// views are unaffected (emitted after all functions).
o.push(`SET check_function_bodies = off;`);
o.push('');
o.push(`-- ── Extensions ──────────────────────────────────────────────────────────────`);
for (const e of exts) o.push(`CREATE EXTENSION IF NOT EXISTS "${e.extname}" WITH SCHEMA ${e.schema};`);
o.push('');

o.push(`-- ── Enum types ──────────────────────────────────────────────────────────────`);
for (const e of enums) {
  o.push(`DO $$ BEGIN CREATE TYPE public.${e.typname} AS ENUM (${e.labels});`);
  o.push(`EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
}
o.push('');

o.push(`-- ── Functions ───────────────────────────────────────────────────────────────`);
o.push(`-- BEFORE the tables, and this ordering is load-bearing. Found by running an`);
o.push(`-- actual restore, not by reading the file: connectors has`);
o.push(`--   CONSTRAINT connectors_base_url_safe_check CHECK (is_safe_external_url(base_url))`);
o.push(`-- so a CHECK constraint depends on a function. With functions emitted last the`);
o.push(`-- restore died on table 40-odd of 257. The file looked completely fine.`);
o.push(`--`);
o.push(`-- Functions in turn reference tables that do not exist yet, so body validation`);
o.push(`-- is deferred: LANGUAGE sql bodies are parsed at CREATE time unless this is off.`);
o.push(`-- pg_dump does the same thing for the same reason.`);
o.push(`SET check_function_bodies = false;`);
o.push('');
for (const f of funcs.filter((f) => !f.needs_tables)) o.push(f.def.trimEnd().replace(/;?$/, ';') + '\n');
o.push('');

o.push(`-- ── Sequences ───────────────────────────────────────────────────────────────`);
for (const s of seqs) {
  o.push(`CREATE SEQUENCE IF NOT EXISTS public.${s.name} AS ${s.type} ` +
         `INCREMENT BY ${s.seqincrement} MINVALUE ${s.seqmin} MAXVALUE ${s.seqmax} START WITH ${s.seqstart};`);
}
o.push('');

o.push(`-- ── Tables ──────────────────────────────────────────────────────────────────`);
for (const t of ordered) {
  const lines = (C[t] || []).map((c) => {
    let s = `  "${c.col}" ${c.type}`;
    if (c.generated === 's') {
      // The expression in pg_attrdef is the GENERATION expression, not a default.
      s += ` GENERATED ALWAYS AS (${c.default_expr}) STORED`;
    } else if (c.identity === 'a' || c.identity === 'd') {
      s += ` GENERATED ${c.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`;
    } else if (c.default_expr) {
      s += ` DEFAULT ${c.default_expr}`;
    }
    if (c.notnull) s += ' NOT NULL';
    return s;
  });
  for (const k of (K[t] || []).filter((k) => 'puc'.includes(k.type))) {
    lines.push(`  CONSTRAINT ${k.name} ${k.def}`);
  }
  o.push(`CREATE TABLE IF NOT EXISTS public.${t} (`);
  o.push(lines.join(',\n'));
  o.push(`);`);
}
o.push('');

o.push(`-- ── Foreign keys, after every table exists ──────────────────────────────────`);
for (const t of ordered) {
  for (const k of (K[t] || []).filter((k) => k.type === 'f')) {
    o.push(`DO $$ BEGIN ALTER TABLE public.${t} ADD CONSTRAINT ${k.name} ${k.def};`);
    o.push(`EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  }
}
o.push('');

o.push(`-- ── Indexes ─────────────────────────────────────────────────────────────────`);
for (const t of ordered) {
  for (const i of (I[t] || [])) {
    o.push(i.def.replace(/^CREATE (UNIQUE )?INDEX /i, (m, u) => `CREATE ${u || ''}INDEX IF NOT EXISTS `) + ';');
  }
}
o.push('');

o.push(`-- ── Views ───────────────────────────────────────────────────────────────────`);
for (const v of views) {
  o.push(`CREATE OR REPLACE ${v.relkind === 'm' ? 'MATERIALIZED ' : ''}VIEW public.${v.name} AS`);
  o.push(v.def.trimEnd().replace(/;?$/, ';'));
}
o.push('');

o.push(`-- ── Functions that name a table row type (RETURNS SETOF <table>) ───────────`);
for (const f of funcs.filter((f) => f.needs_tables)) o.push(f.def.trimEnd().replace(/;?$/, ';') + '\n');
o.push('');

o.push(`-- ── Triggers ────────────────────────────────────────────────────────────────`);
for (const t of ordered) {
  for (const g of (T[t] || [])) {
    o.push(`DROP TRIGGER IF EXISTS ${g.name} ON public.${t};`);
    o.push(g.def + ';');
  }
}
o.push('');

// A policy that says TO trust_pattern_proposer restores as an ERROR on any
// environment that lacks the role — proven in the container drill 2026-08-20,
// where four policies were silently lost (the dev drill never noticed because
// dev's migrations had already created the roles). Emit every non-builtin
// role a policy references, idempotently, with its memberships. polroles={0}
// ("all roles") unnests to oid 0 and matches nothing here, by design.
const customRoles = await q(`
  select r.rolname,
         coalesce((select string_agg(distinct m.rolname, ',')
                     from pg_auth_members am
                     join pg_roles m on m.oid = am.member
                    where am.roleid = r.oid), '') as members
    from pg_roles r
   where r.oid in (select distinct unnest(polroles) from pg_policy)
     and r.rolname not in ('postgres', 'anon', 'authenticated', 'service_role', 'authenticator', 'dashboard_user')
     and r.rolname not like 'pg\\_%' and r.rolname not like 'supabase\\_%'
   order by r.rolname`);
if (customRoles.length) {
  o.push(`-- ── Custom roles the policies below bind to ─────────────────────────────────`);
  for (const cr of customRoles) {
    o.push(`DO $role$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${cr.rolname}') THEN CREATE ROLE ${cr.rolname} NOLOGIN; END IF; END $role$;`);
    for (const mem of cr.members.split(',').filter(Boolean)) o.push(`GRANT ${cr.rolname} TO ${mem};`);
  }
  o.push('');
}

o.push(`-- ── Row Level Security ──────────────────────────────────────────────────────`);
o.push(`-- On a multi-tenant database RLS is not hardening applied later: a table`);
o.push(`-- restored without it is a cross-tenant data leak on the first query.`);
o.push(`--`);
o.push(`-- FORCE is emitted alongside ENABLE and is NOT decoration. Every table here`);
o.push(`-- is owned by the postgres role, and a table owner is exempt from its own`);
o.push(`-- RLS unless FORCE is set. All 791 SECURITY DEFINER routines run as that`);
o.push(`-- owner, so a table restored with ENABLE but without FORCE still row-filters`);
o.push(`-- direct PostgREST traffic and silently stops filtering every SECDEF path —`);
o.push(`-- which is most of the product. This half was missing until 2026-08-22: the`);
o.push(`-- snapshot read relrowsecurity only, so 27 FORCE'd tables (platform_config,`);
o.push(`-- platform_invites, remote_access_write_log, auth_login_lockouts, ...) came`);
o.push(`-- back weaker than production and both restore paths applied that file.`);
for (const r of rls) {
  o.push(`ALTER TABLE public.${r.tbl} ENABLE ROW LEVEL SECURITY;`);
  if (r.forced) o.push(`ALTER TABLE public.${r.tbl} FORCE ROW LEVEL SECURITY;`);
}
o.push('');

for (const t of ordered) {
  for (const p of (P[t] || [])) {
    o.push(`DROP POLICY IF EXISTS ${p.name} ON public.${t};`);
    let s = `CREATE POLICY ${p.name} ON public.${t}`;
    if (!p.permissive) s += ' AS RESTRICTIVE';
    s += ` FOR ${p.cmd}`;
    if (p.roles && p.roles !== 'public') s += ` TO ${p.roles}`;
    if (p.using_expr) s += ` USING (${p.using_expr})`;
    if (p.check_expr) s += ` WITH CHECK (${p.check_expr})`;
    o.push(s + ';');
  }
}
o.push('');

o.push(`-- ── Grants: reproduce the CLOSED perimeter ──────────────────────────────────`);
o.push(`-- Postgres grants EXECUTE on every new function to PUBLIC by default. Migration`);
o.push(`-- 365 revoked that on the SECURITY DEFINER writers no client should reach. A`);
o.push(`-- restore without these REVOKEs comes back with all of them open to anyone who`);
o.push(`-- can sign up — a silent, total regression of that work.`);
const closed = fnAcl.filter((f) => !f.anon_x && !f.auth_x);
// ON ROUTINE, not ON FUNCTION: the dump includes PROCEDUREs (prokind=p), and
// `REVOKE ... ON FUNCTION <procedure>` fails with 42809 "is not a function".
for (const f of closed) o.push(`REVOKE ALL ON ROUTINE ${f.sig} FROM PUBLIC, anon, authenticated;`);
o.push('');
for (const t of tblAcl) {
  if (!t.anon_r && !t.anon_w) o.push(`REVOKE ALL ON TABLE public.${t.tbl} FROM anon;`);
  if (!t.auth_r && !t.auth_w) o.push(`REVOKE ALL ON TABLE public.${t.tbl} FROM authenticated;`);
}
o.push('');

// ── Grants. AFTER the revokes, deliberately ────────────────────────────────
// A table that appears in both lists must end up granted: the REVOKE above is
// keyed on "holds neither SELECT nor INSERT", so anything holding only, say,
// UPDATE would be revoked and then correctly re-granted here. Emitting these
// first would let the revoke win and reproduce the very bug this closes.
o.push(`-- ── Role grants (register A-12) ─────────────────────────────────────────────`);
o.push(`-- Without these a restore comes back CLOSED: every table present, every policy`);
o.push(`-- present, and no API role able to read a row. RLS decides WHICH rows a caller`);
o.push(`-- sees; these grants decide whether the caller may ask at all, and a policy`);
o.push(`-- cannot grant what the role does not hold.`);
const REL_KEYWORD = { r: 'TABLE', v: 'TABLE', m: 'TABLE', S: 'SEQUENCE' };
for (const a of relAcl) {
  o.push(`GRANT ${a.privs} ON ${REL_KEYWORD[a.kind]} public.${a.rel} TO ${a.grantee};`);
}
o.push('');
o.push(`NOTIFY pgrst, 'reload schema';`);

process.stdout.write(o.join('\n') + '\n');
say(`${ordered.length} tables · ${seqs.length} sequences · ${views.length} views · ${funcs.length} functions · ${trigs.length} triggers · ${pol.length} policies`);
say(`${closed.length} functions emitted with an explicit REVOKE (closed perimeter preserved)`);
say(`${relAcl.length} role grants emitted across tables, views and sequences (OPEN perimeter preserved — register A-12)`);
