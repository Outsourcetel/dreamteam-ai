#!/usr/bin/env node
// ============================================================
// sync-dev-columns.mjs — bring the DEV project's existing tables up to the
// production column set, without destroying its data.
//
// WHY THIS EXISTS
// The dev project is a stale schema clone: 97 tables against production's 264,
// and the 97 it HAS are themselves out of date. supabase/baseline/full_schema.sql
// uses CREATE TABLE IF NOT EXISTS, so it happily adds the 167 missing tables but
// silently leaves an existing table with a 2026-06 shape. That fails loudly at
// the foreign-key stage:
//
//   ERROR: column "learned_from_spec_id" referenced in foreign key constraint
//          does not exist  (public.action_definitions)
//
// The obvious fix — drop and recreate the public schema — is the wrong one here.
// Dev holds 33 tenants and 27 auth.users, and those are the fixtures the
// `npm run test:isolation` suite signs in as. Dropping them destroys the only
// automated cross-tenant safety net in the project to save a few minutes.
//
// So this reconciles COLUMNS instead: additive only, ADD COLUMN IF NOT EXISTS,
// nullable, no defaults backfilled and nothing dropped. A column that exists in
// dev but not production is LEFT ALONE and reported — it is either older test
// scaffolding or a sign the two have genuinely diverged, and quietly deleting
// someone's column is not this script's business.
//
//   node scripts/sync-dev-columns.mjs           # report only
//   node scripts/sync-dev-columns.mjs --apply   # emit + run the ALTERs
// ============================================================
import { readFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const PROD = 'rfsvmhcqeiyrxivbmpel';
const DEV = 'nmuntxrcdksyhsdywpan';

function token() {
  const env = readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  if (!line) throw new Error('SUPABASE_ACCESS_TOKEN not found in .env.local');
  return line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
}

async function q(ref, sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

const COLS = `
  select c.relname as tbl, a.attname as col,
         format_type(a.atttypid, a.atttypmod) as type
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and a.attnum > 0 and not a.attisdropped
   order by 1, 2`;

const [prod, dev] = await Promise.all([q(PROD, COLS), q(DEV, COLS)]);

const key = (r) => `${r.tbl}.${r.col}`;
const devSet = new Set(dev.map(key));
const devTables = new Set(dev.map((r) => r.tbl));
const prodSet = new Set(prod.map(key));

// Only tables that ALREADY exist in dev. The missing 167 are full_schema.sql's
// job — creating them here would duplicate it and diverge.
const missing = prod.filter((r) => devTables.has(r.tbl) && !devSet.has(key(r)));
const extra = dev.filter((r) => !prodSet.has(key(r)));

const byTable = missing.reduce((m, r) => ((m[r.tbl] ??= []).push(r), m), {});

console.log(`dev has ${devTables.size} tables · production has ${new Set(prod.map((r) => r.tbl)).size}`);
console.log(`${missing.length} column(s) missing across ${Object.keys(byTable).length} existing dev table(s)\n`);
for (const [tbl, cols] of Object.entries(byTable)) {
  console.log(`  ${tbl}: ${cols.map((c) => `${c.col} ${c.type}`).join(', ')}`);
}
if (extra.length) {
  console.log(`\n${extra.length} column(s) exist in dev but NOT production — left alone, not dropped:`);
  console.log(`  ${extra.slice(0, 12).map(key).join(', ')}${extra.length > 12 ? ` … +${extra.length - 12}` : ''}`);
}

// ── CHECK constraints ───────────────────────────────────────────────────────
// Columns were only half the problem, and the other half is worse because it
// fails at RUNTIME rather than at sync time. Creating a workspace on dev died
// with:
//   new row for relation "guardrail_rules" violates check constraint
//   "guardrail_rules_rule_type_check"
// Dev's constraint allowed 4 rule_type values; production allows 9, and
// complete_signup inserts one of the newer five. So signup — the single most
// important path in the product — was broken on dev while every table and
// column looked correct. Measured across the whole schema: 12 constraints with
// a DIFFERENT definition and 12 missing entirely.
const CHECKS = `
  select c.relname as tbl, con.conname as name, pg_get_constraintdef(con.oid) as def
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and con.contype = 'c' and c.relkind = 'r'
   order by 1, 2`;

const [prodChk, devChk] = await Promise.all([q(PROD, CHECKS), q(DEV, CHECKS)]);
const devChkMap = new Map(devChk.map((r) => [`${r.tbl}.${r.name}`, r.def]));
const chkKey = (r) => `${r.tbl}.${r.name}`;

const chkDiffer = prodChk.filter((r) => devTables.has(r.tbl)
  && devChkMap.has(chkKey(r)) && devChkMap.get(chkKey(r)) !== r.def);
const chkMissing = prodChk.filter((r) => devTables.has(r.tbl) && !devChkMap.has(chkKey(r)));

console.log(`\n${chkDiffer.length} CHECK constraint(s) differ, ${chkMissing.length} missing — on tables dev already has`);
for (const r of [...chkDiffer, ...chkMissing].slice(0, 10)) console.log(`  ${chkKey(r)}`);

// ── RLS policies ────────────────────────────────────────────────────────────
// full_schema.sql already reconciles policies for the tables it touches — its
// POLICY section DROPs and recreates each one, which is why 0 differ and 0 are
// missing. What it CANNOT do is remove a policy production has since deleted.
// Those leftovers are the dangerous direction, because POSTGRES ORS PERMISSIVE
// POLICIES: one surviving permissive FOR ALL defeats every command-scoped
// policy beside it.
//
// Measured on dev: 13 such leftovers, including
//   knowledge_docs.knowledge_docs_tenant_isolation  (PERMISSIVE, FOR ALL,
//                                                    tenant_id = auth_tenant_id())
// That is the exact policy migration 344 DROPPED in production and 357 hardened
// against. While it exists, the six-level Knowledge ACL is fully bypassed on
// dev — any tenant member reads every document regardless of grants — and the
// invariant test that guards this runs against PRODUCTION, so it never saw it.
// A cross-tenant test passing on dev would have meant nothing.
const POLICIES = `
  select c.relname as tbl, p.polname as name
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' order by 1, 2`;

const [prodPol, devPol] = await Promise.all([q(PROD, POLICIES), q(DEV, POLICIES)]);
const prodPolSet = new Set(prodPol.map((r) => `${r.tbl}.${r.name}`));
const polExtra = devPol.filter((r) => !prodPolSet.has(`${r.tbl}.${r.name}`));

console.log(`\n${polExtra.length} RLS policy(ies) on dev that production does NOT have`);
for (const r of polExtra) console.log(`  ${r.tbl}.${r.name}`);

// ── Triggers ────────────────────────────────────────────────────────────────
// Checked but, unlike policies, extras here are NOT dropped by default.
//
// The asymmetry is deliberate. An extra permissive POLICY silently WIDENS
// access, because Postgres ORs them — that is why the 13 leftovers had to go.
// An extra TRIGGER does not widen anything; it maintains a table. Measured on
// dev: 0 differ, 0 missing, and 3 extras — all on specialist_profiles, a legacy
// table dev has and production does not. Dropping its updated_at and audit
// triggers would leave the table present but no longer maintaining itself,
// which is a worse state than the divergence.
//
// A trigger that DIFFERS or is MISSING on a SHARED table is the case that
// matters — it changes behaviour silently — so those are reported loudly and
// recreated on --apply.
const TRIGGERS = `
  select c.relname as tbl, t.tgname as name, pg_get_triggerdef(t.oid) as def
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and not t.tgisinternal order by 1, 2`;

const [prodTrg, devTrg] = await Promise.all([q(PROD, TRIGGERS), q(DEV, TRIGGERS)]);
const devTrgMap = new Map(devTrg.map((r) => [`${r.tbl}.${r.name}`, r.def]));
const trgKey = (r) => `${r.tbl}.${r.name}`;
const trgDiffer = prodTrg.filter((r) => devTables.has(r.tbl)
  && devTrgMap.has(trgKey(r)) && devTrgMap.get(trgKey(r)) !== r.def);
const trgMissing = prodTrg.filter((r) => devTables.has(r.tbl) && !devTrgMap.has(trgKey(r)));
const prodTrgSet = new Set(prodTrg.map(trgKey));
const trgExtra = devTrg.filter((r) => !prodTrgSet.has(trgKey(r)));

console.log(`\n${trgDiffer.length} trigger(s) differ, ${trgMissing.length} missing on shared tables`);
for (const r of [...trgDiffer, ...trgMissing].slice(0, 10)) console.log(`  ${trgKey(r)}`);
if (trgExtra.length) {
  console.log(`${trgExtra.length} extra trigger(s) on dev — REPORTED, NOT DROPPED (see comment):`);
  for (const r of trgExtra) console.log(`  ${trgKey(r)}`);
}

if (!APPLY) { console.log('\n(report only — pass --apply to run the ALTERs)'); process.exit(0); }
if (!missing.length && !chkDiffer.length && !chkMissing.length && !polExtra.length
    && !trgDiffer.length && !trgMissing.length) {
  console.log('\nnothing to do'); process.exit(0);
}

// Nullable and no default: this is a dev clone being reshaped, not a migration.
// A NOT NULL column added to a table with rows needs a default and a backfill
// decision that belongs in a real migration, not in a sync utility.
const sql = Object.entries(byTable)
  .map(([tbl, cols]) => cols.map((c) =>
    `ALTER TABLE public.${JSON.stringify(tbl).replace(/"/g, '"')} ADD COLUMN IF NOT EXISTS "${c.col}" ${c.type};`).join('\n'))
  .join('\n');

if (missing.length) {
  await q(DEV, sql);
  console.log(`\napplied ${missing.length} ADD COLUMN statement(s) to dev`);
}

// Constraints go one at a time, deliberately. A batch dies on the first table
// whose EXISTING rows violate the production rule and rolls back the other 23 —
// and that violation is information worth having, not a reason to abandon the
// sync.
let ok = 0; const notValid = []; const failed = [];
for (const r of [...chkDiffer, ...chkMissing]) {
  const drop = `ALTER TABLE public.${JSON.stringify(r.tbl).replace(/"/g, '"')} DROP CONSTRAINT IF EXISTS "${r.name}"`;
  const add = (suffix) =>
    `ALTER TABLE public.${JSON.stringify(r.tbl).replace(/"/g, '"')} ADD CONSTRAINT "${r.name}" ${r.def}${suffix}`;
  try {
    await q(DEV, `${drop}; ${add('')};`);
    ok += 1;
  } catch (e) {
    // Existing dev rows break the production rule. NOT VALID applies it to
    // future writes — which is what makes signup work — while leaving the
    // legacy rows alone and SAYING SO. Silently skipping would leave dev
    // diverged in a way nothing reports; silently deleting the rows would be
    // worse.
    try {
      await q(DEV, `${drop}; ${add(' NOT VALID')};`);
      notValid.push(`${chkKey(r)} — ${String(e.message).slice(0, 90)}`);
    } catch (e2) {
      failed.push(`${chkKey(r)} — ${String(e2.message).slice(0, 90)}`);
    }
  }
}

console.log(`\nCHECK constraints: ${ok} applied clean, ${notValid.length} NOT VALID, ${failed.length} failed`);
if (notValid.length) {
  console.log('\nNOT VALID (enforced for new rows; existing dev rows already violate them):');
  notValid.forEach((m) => console.log(`  ${m}`));
}
if (failed.length) {
  console.log('\nFAILED — dev still diverges here:');
  failed.forEach((m) => console.log(`  ${m}`));
}

// Drop the leftovers LAST, after columns and constraints are in place, so a
// half-synced dev never spends time with its access rules removed.
let dropped = 0; const polFailed = [];
for (const r of polExtra) {
  try {
    await q(DEV, `DROP POLICY IF EXISTS "${r.name}" ON public.${JSON.stringify(r.tbl).replace(/"/g, '"')};`);
    dropped += 1;
  } catch (e) {
    polFailed.push(`${r.tbl}.${r.name} — ${String(e.message).slice(0, 90)}`);
  }
}
if (polExtra.length) {
  console.log(`\nRLS policies: ${dropped} dropped, ${polFailed.length} failed`);
  polFailed.forEach((m) => console.log(`  ${m}`));
}

// Triggers last: they fire on writes, so recreating one mid-sync could act on a
// table whose columns or constraints were still being reshaped above.
let trgOk = 0; const trgFailed = [];
for (const r of [...trgDiffer, ...trgMissing]) {
  try {
    await q(DEV, `DROP TRIGGER IF EXISTS "${r.name}" ON public.${JSON.stringify(r.tbl).replace(/"/g, '"')}; ${r.def};`);
    trgOk += 1;
  } catch (e) {
    // Usually a missing trigger FUNCTION — full_schema.sql brings those, so a
    // failure here means the dump has not been applied or is out of date.
    trgFailed.push(`${trgKey(r)} — ${String(e.message).slice(0, 90)}`);
  }
}
if (trgDiffer.length || trgMissing.length) {
  console.log(`\nTriggers: ${trgOk} recreated, ${trgFailed.length} failed`);
  trgFailed.forEach((m) => console.log(`  ${m}`));
}
