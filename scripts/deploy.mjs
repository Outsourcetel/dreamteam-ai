#!/usr/bin/env node
/**
 * deploy.mjs — one command to ship DB + edge functions to production.
 *
 * Applies pending SQL migrations (via the service-role `exec_sql` RPC) and
 * deploys Supabase edge functions, then verifies. Reads credentials from a
 * gitignored `.env.local` so nothing secret is ever committed or pasted.
 *
 * SET UP ONCE (see scripts/DEPLOY_SETUP.md):
 *   1. .env.local holds SUPABASE_SERVICE_ROLE_KEY + SUPABASE_ACCESS_TOKEN
 *   2. settings.local.json allows: Bash(node scripts/deploy.mjs:*)
 *
 * THEN, FOREVER:
 *   node scripts/deploy.mjs                      # pending migrations + deploy de-work
 *   node scripts/deploy.mjs --mig 244_x.sql      # a specific migration only
 *   node scripts/deploy.mjs --since 243          # migrations numbered > 243
 *   node scripts/deploy.mjs --fn de-work de-answer   # deploy specific functions
 *   node scripts/deploy.mjs --no-functions       # migrations only
 *   node scripts/deploy.mjs --no-migrations --fn de-work   # deploy only
 */
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

const URL     = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const ANON    = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ACCESS  = process.env.SUPABASE_ACCESS_TOKEN;
const REF     = process.env.SUPABASE_PROJECT_REF || 'rfsvmhcqeiyrxivbmpel';

const args = process.argv.slice(2);
const takeList = (flag) => {
  const i = args.indexOf(flag);
  if (i < 0) return null;
  const out = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]);
  return out;
};
const migOnly       = takeList('--mig');
const sinceArg      = takeList('--since');
const fnList        = takeList('--fn');
const doMigrations  = !args.includes('--no-migrations');
const doFunctions   = !args.includes('--no-functions');
const FUNCTIONS     = fnList && fnList.length ? fnList : ['de-work'];
const migDir        = path.join(process.cwd(), 'supabase', 'migrations');
const numOf = (f) => { const m = f.match(/^(\d+)_/); return m ? parseInt(m[1], 10) : -1; };

function die(msg) { console.error(`\n❌ ${msg}`); process.exit(1); }

async function applyMigrations() {
  if (!URL) die('SUPABASE_URL missing — add it (or VITE_SUPABASE_URL) to .env.local');
  if (!SERVICE) die('SUPABASE_SERVICE_ROLE_KEY missing — add it to .env.local (Supabase dashboard → Settings → API → service_role)');
  const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });

  const files = fs.readdirSync(migDir).filter(f => f.endsWith('.sql')).sort();

  // Which files to apply.
  let pending;
  if (migOnly && migOnly.length) {
    pending = migOnly.map(m => m.endsWith('.sql') ? m : `${m}.sql`);
    for (const f of pending) if (!fs.existsSync(path.join(migDir, f))) die(`migration not found: ${f}`);
  } else {
    // Determine the highest already-applied migration number.
    let appliedMax = null;
    const { data, error } = await sb.from('_supabase_migrations').select('name');
    if (!error && Array.isArray(data)) {
      appliedMax = data.reduce((mx, r) => Math.max(mx, numOf(r.name || '')), -1);
    }
    let since;
    if (sinceArg && sinceArg.length) since = parseInt(sinceArg[0], 10);
    else if (appliedMax !== null && appliedMax >= 0) since = appliedMax;
    else die('Cannot determine applied state (no readable _supabase_migrations). Re-run with --mig <file> or --since <N>.');
    pending = files.filter(f => numOf(f) > since);
    console.log(`Migrations: ${files.length} on disk, applying ${pending.length} newer than #${since}`);
  }

  if (pending.length === 0) { console.log('  ✓ no pending migrations'); return; }
  for (const f of pending) {
    const sql = fs.readFileSync(path.join(migDir, f), 'utf-8');
    process.stdout.write(`  → ${f} … `);
    const { error } = await sb.rpc('exec_sql', { sql });
    if (error) die(`${f} FAILED: ${error.message}`);
    // Record it (non-fatal if the tracking table isn't present).
    await sb.from('_supabase_migrations').insert([{ name: f, executed_at: new Date().toISOString() }]).then(() => {}, () => {});
    console.log('ok');
  }
  console.log(`  ✓ applied ${pending.length} migration(s)`);
}

function deployFunctions() {
  if (!ACCESS) die('SUPABASE_ACCESS_TOKEN missing — add it to .env.local (supabase.com/dashboard/account/tokens)');
  for (const fn of FUNCTIONS) {
    const dir = path.join(process.cwd(), 'supabase', 'functions', fn);
    if (!fs.existsSync(dir)) die(`function not found: supabase/functions/${fn}`);
    console.log(`\nDeploying function: ${fn}`);
    execSync(`npx supabase functions deploy ${fn} --project-ref ${REF}`, {
      stdio: 'inherit',
      env: { ...process.env, SUPABASE_ACCESS_TOKEN: ACCESS },
    });
  }
  console.log(`  ✓ deployed ${FUNCTIONS.length} function(s)`);
}

async function verify() {
  if (!URL || !ANON) return;
  const sb = createClient(URL, ANON);
  // A function "exists" if anon gets 42501 permission-denied (granted to
  // authenticated/service only) rather than PGRST202 not-found.
  const checks = ['list_de_operate_config', 'create_browser_operation', 'list_browser_operator'];
  console.log('\nVerify (RPC existence, anon probe):');
  for (const fn of checks) {
    const { error } = await sb.rpc(fn, fn === 'list_browser_operator'
      ? { p_tenant_id: '00000000-0000-0000-0000-000000000000', p_limit: 1 }
      : { p_de_id: '00000000-0000-0000-0000-000000000000' }).then(r => r, e => ({ error: e }));
    const notFound = error && (error.code === 'PGRST202' || /Could not find the function/i.test(error.message || ''));
    console.log(`  ${notFound ? '✗ not applied' : '✓ live       '} ${fn}`);
  }
}

(async () => {
  console.log('════ deploy ════');
  if (doMigrations) await applyMigrations();
  if (doFunctions) deployFunctions();
  await verify();
  console.log('\n✅ Deploy complete.');
})().catch(e => die(e.message));
