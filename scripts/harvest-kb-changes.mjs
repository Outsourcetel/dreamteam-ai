#!/usr/bin/env node
// harvest-kb-changes.mjs — feed shipped changes into the product-KB review queue.
//
//   node scripts/harvest-kb-changes.mjs            # everything not yet recorded
//   node scripts/harvest-kb-changes.mjs --since 325
//
// WHY THIS EXISTS
//   The product KB describes how DreamTeam works. Every migration in this repo
//   already carries a long header explaining what changed and WHY, written at
//   the moment of the change — migration 325 explains the judgment layer better
//   than any doc written afterwards would. That habit is the harvest source.
//
//   This script does NOT write documentation. It records what shipped and asks
//   the shelf which articles mention the same things, so a human reviewing the
//   queue is told "these 3 articles may now be wrong, and here is the change
//   that made them wrong" instead of being asked to remember.
//
// Idempotent: platform_kb_changes is UNIQUE on (source_kind, source_ref), so
// re-running refreshes rather than duplicating.

import { readFileSync, readdirSync } from 'node:fs';

const PROJECT_REF = 'rfsvmhcqeiyrxivbmpel';
const ENDPOINT = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
const MIGRATIONS = 'supabase/migrations';

function token() {
  const env = readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  if (!line) throw new Error('SUPABASE_ACCESS_TOKEN not found in .env.local');
  return line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
}

async function sql(query) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

const lit = (s) => `'${String(s ?? '').replace(/'/g, "''")}'`;

/**
 * Pull the human-written header out of a migration: the leading comment block,
 * minus the box-drawing rules and the leading `--`. The first substantive line
 * becomes the title.
 */
function header(sqlText) {
  const lines = sqlText.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (!line.startsWith('--')) break;                 // header ends at the first statement
    const t = line.replace(/^--\s?/, '').trimEnd();
    if (/^=+$/.test(t) || /^─+$/.test(t)) continue;    // drop rules
    out.push(t);
  }
  const body = out.join('\n').trim();
  // Skip the filename echo most headers open with.
  const meaningful = out.map((l) => l.trim()).filter((l) => l && !/^\d{3}_.*\.sql$/.test(l));
  return { title: meaningful[0] ?? '', body };
}

const since = (() => {
  const i = process.argv.indexOf('--since');
  return i !== -1 ? parseInt(process.argv[i + 1], 10) : 0;
})();

const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .filter((f) => parseInt(f.slice(0, 3), 10) >= since)
  .sort();

let recorded = 0, skipped = 0;
for (const f of files) {
  const { title, body } = header(readFileSync(`${MIGRATIONS}/${f}`, 'utf8'));
  if (!title) { skipped++; continue; }                 // no prose header, nothing to teach
  const q = `select public.record_platform_kb_change('migration', ${lit(f)}, ${lit(title.slice(0, 300))}, ${lit(body.slice(0, 8000))}) as id;`;
  await sql(q);
  recorded++;
}

const [{ health }] = (await sql('select public.get_platform_kb_health() as health;'))[0]
  ? (await sql('select public.get_platform_kb_health() as health;'))
  : [{ health: null }];

console.log(`harvested ${recorded} migration(s), skipped ${skipped} without a prose header`);
console.log(JSON.stringify(health, null, 2));
