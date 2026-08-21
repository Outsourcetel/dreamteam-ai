#!/usr/bin/env node
// ============================================================================
// seed-dev-reference-data.mjs — copy the platform's CATALOG rows from
// production into dev, after a schema rebuild.
//
// WHY (learned the hard way, 2026-08-19)
// rebuild-dev-from-baseline.mjs restored dev's schema from
// supabase/baseline/full_schema.sql and every object class matched production
// exactly — 304 tables, 965 functions, 402 policies, ledger level. Then
// golden-path FAILED 3/10 with `invalid input syntax for type uuid:
// "undefined"`, because signup created no tenant.
//
// The dump is a SCHEMA dump. It carries no rows. The product cannot start a
// workspace without its catalog — `role_archetypes` decides what an employee
// can be hired as, and complete_signup provisions against it. A structurally
// perfect database that cannot hire anyone is not a usable environment, and
// the restore drill never caught this because it only ever compared STRUCTURE.
//
// ── What this copies, and what it deliberately does not ────────────────────
// Only tables that are (a) tenant-independent — no tenant_id column at all —
// and (b) catalog rather than operational. Nothing customer-shaped crosses:
// no tenants, employees, conversations, tasks, audit rows or secrets. dev gets
// the platform's vocabulary, never production's content.
//
// EXCLUDED on purpose, though they are also tenant-independent:
//   dispatch_log, ops_alerts, auth_login_lockouts   — operational history
//   connector_secrets                               — credentials, never copy
//   benchmark_samples, agentic_step_messages        — run artefacts
//   migration_number_claims                         — claims are per-environment
//
//   node scripts/seed-dev-reference-data.mjs --confirm
// ============================================================================
import { readFileSync } from 'node:fs';

const DEV_REF = 'nmuntxrcdksyhsdywpan';
const PROD_REF = 'rfsvmhcqeiyrxivbmpel';

// Order matters: comparators reference dimensions, pack_rules reference packs.
// An entry is a table name, or { name, where } for a table whose CATALOG rows
// are a subset: some tables carry tenant_id NULL for "platform default" beside
// real tenant rows, so "no tenant_id column" (rule a) is the wrong test for
// them — the filter keeps the platform vocabulary and leaves customer content
// behind. Learned 2026-08-21: review_time_standards (mig 691 seeds 11 platform
// defaults, tenant_id NULL) was invisible to rule (a), dev had zero rows, and
// tests/review-minutes.test.ts failed on every branch. The 2026-08-21 sweep
// then judged the 14 other tables holding NULL-tenant platform rows one by
// one; 13 are listed below and profiles must never cross — its rows reference
// auth.users identities that do not exist in dev.
const TABLES = [
  // system_categories first: connectors.category is a FK to it, and
  // provision_tenant_baseline_internal creates a connector during signup — so
  // without this table complete_signup fails and NO tenant can be created.
  'system_categories',
  'role_archetypes',
  'connector_providers',
  'feature_registry',
  'discovery_dimensions',
  'authority_dimensions',
  'authority_dimension_comparators',
  'compliance_packs',
  'compliance_pack_rules',
  // ⚠ dunning_rungs was here and was WRONG. It has no tenant_id column, so the
  // "tenant-independent means catalog" rule admitted it — then it failed a
  // foreign key to dunning_ladders, which IS tenant-scoped. A table can belong
  // to a tenant through its PARENT without carrying the column itself, so the
  // absence of tenant_id is necessary for catalog data and not sufficient.
  'ai_model_pricing',
  'config_schema_templates',
  'computer_use_runtimes',
  // Platform-default review minutes (mig 691). Tenant overrides stay behind.
  { name: 'review_time_standards', where: 'tenant_id is null' },
  // ── NULL-tenant platform rows, judged table-by-table 2026-08-21 ───────────
  // profiles also holds 2 NULL-tenant rows and is EXCLUDED FOREVER: its rows
  // reference auth.users identities that do not exist in dev.
  { name: 'skill_categories', where: 'tenant_id is null' },
  { name: 'skill_catalog', where: 'tenant_id is null' },
  { name: 'certification_types', where: 'tenant_id is null' },
  { name: 'kpi_metric_catalog', where: 'tenant_id is null' },
  { name: 'escalation_signals', where: 'tenant_id is null' },
  { name: 'event_definitions', where: 'tenant_id is null' },
  { name: 'analytics_query_defs', where: 'tenant_id is null' },
  { name: 'work_item_framing', where: 'tenant_id is null' },
  { name: 'de_training_modules', where: 'tenant_id is null' },
  // scope='archetype' routing defaults; every NULL-tenant row has de_id NULL,
  // so nothing points at a production employee.
  { name: 'de_model_routes', where: 'tenant_id is null' },
  // Before action_definitions: its template_id FKs adapter_templates. The
  // definitions carry auth SHAPES (op maps, oauth token URLs), no credentials.
  { name: 'adapter_templates', where: 'tenant_id is null' },
  // The tool-offer authorization boundary (migs 642/643). scope='platform'
  // rows are offered to every tenant, but the controls travel IN the rows —
  // requires_role, status, and de_may_use_action gate against them — so
  // copying reproduces production's platform posture, disabled rows included.
  { name: 'action_definitions', where: 'tenant_id is null' },
  { name: 'dunning_ladders', where: 'tenant_id is null' },
  // The header's warning made good: rungs belong to a tenant through their
  // PARENT. Only the platform ladder's rungs cross, after that ladder exists;
  // on dev the same subquery scopes the verify count to those rungs.
  { name: 'dunning_rungs', where: 'ladder_id in (select id from public.dunning_ladders where tenant_id is null)' },
];

if (!process.argv.includes('--confirm')) {
  console.error('refusing to run without --confirm');
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
  throw new Error(`${key} not found`);
}
const TOKEN = env('SUPABASE_ACCESS_TOKEN', '.env.local');

async function run(ref, query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SQL ${res.status}: ${text.slice(0, 260)}`);
  return JSON.parse(text);
}

// ⚠ DO NOT BUILD VALUES TUPLES BY HAND HERE. The first version did, and died on
// role_archetypes: `column "responsibilities" is of type text[] but expression
// is of type jsonb`. The management API returns a Postgres text[] and a jsonb
// array as the SAME JavaScript array, so no amount of inspecting the value can
// tell you which cast to emit — the answer lives in the column type, not the
// data. jsonb_populate_recordset asks the table itself, so every column is
// coerced by the definition that will store it.
const results = [];
for (const entry of TABLES) {
  const { name: table, where } = typeof entry === 'string' ? { name: entry } : entry;
  const filter = where ? ` where ${where}` : '';
  const rows = await run(PROD_REF, `select * from public.${table}${filter}`);
  if (!rows.length) { results.push({ table, copied: 0, note: 'empty in production' }); continue; }
  // ⚠ CHUNK BY BYTES, NOT ROW COUNT. The first version batched 50 rows and
  // failed on role_archetypes: each row embeds a whole SOP playbook, so fifty
  // of them is megabytes in one statement and the API rejects it. A four-row
  // table seeded fine at the same setting, which is exactly the shape that
  // makes a row-count batch look correct until one wide table arrives.
  const MAX_BYTES = 150_000;
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const chunk = JSON.stringify(batch).replace(/'/g, "''");
    await run(DEV_REF,
      `insert into public.${table}
       select * from jsonb_populate_recordset(null::public.${table}, '${chunk}'::jsonb)
       on conflict do nothing`);
    batch = [];
  };
  for (const r of rows) {
    batch.push(r);
    if (JSON.stringify(batch).length > MAX_BYTES) { batch.pop(); await flush(); batch.push(r); }
  }
  await flush();
  // Same filter on the verify side: without it, a filtered table would count
  // dev's own tenant rows (tests create overrides) and report a false PARTIAL.
  const [got] = await run(DEV_REF, `select count(*)::int as n from public.${table}${filter}`);
  results.push({ table, production: rows.length, dev: got.n, match: rows.length === got.n ? 'OK' : 'PARTIAL' });
}
console.table(results);
const bad = results.filter((r) => r.match === 'PARTIAL');
console.log(bad.length ? `⚠ ${bad.length} table(s) did not fully copy` : 'reference catalog seeded — dev has the platform vocabulary, none of production content');
process.exit(bad.length ? 1 : 0);
