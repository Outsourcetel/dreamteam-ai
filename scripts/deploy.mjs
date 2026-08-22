#!/usr/bin/env node
/**
 * deploy.mjs — one command to ship DB + edge functions to production.
 *
 * Deploys Supabase edge functions, then verifies. Reads credentials from a
 * gitignored `.env.local` so nothing secret is ever committed or pasted.
 *
 * ⚠ IT DOES NOT APPLY MIGRATIONS. That path called an `exec_sql` RPC that
 * exists in no schema and read a `_supabase_migrations` table that exists in
 * no schema; it was removed 2026-08-22 rather than reimplemented, because the
 * commit/merge guards a migration must pass live in scripts/db-query.mjs.
 * Use:  node scripts/db-query.mjs --file supabase/migrations/<file>.sql
 *
 * SET UP ONCE (see scripts/DEPLOY_SETUP.md):
 *   1. .env.local holds SUPABASE_SERVICE_ROLE_KEY + SUPABASE_ACCESS_TOKEN
 *   2. settings.local.json allows: Bash(node scripts/deploy.mjs:*)
 *
 * THEN, FOREVER:
 *   node scripts/deploy.mjs                          # deploy de-work
 *   node scripts/deploy.mjs --fn de-work de-answer   # deploy specific functions
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
// Functions-only is now the DEFAULT, not an opt-out. The migration path is gone
// (see applyMigrations below), so leaving it on by default would mean the bare
// `node scripts/deploy.mjs` — the command this repo's runbook has always named —
// died every time. Instead the refusal fires only for someone reaching for the
// old flags, which is exactly who needs to read it. `--no-migrations` is still
// accepted so existing muscle memory and any pinned command keep working.
const doMigrations  = (migOnly !== null || sinceArg !== null) && !args.includes('--no-migrations');
const doFunctions   = !args.includes('--no-functions');
const FUNCTIONS     = fnList && fnList.length ? fnList : ['de-work'];
const migDir        = path.join(process.cwd(), 'supabase', 'migrations');
const numOf = (f) => { const m = f.match(/^(\d+)_/); return m ? parseInt(m[1], 10) : -1; };

function die(msg) { console.error(`\n❌ ${msg}`); process.exit(1); }

async function applyMigrations() {
  // ── THIS PATH NEVER WORKED, AND IS NOT BEING REPAIRED IN PLACE ───────────
  //
  // Removed 2026-08-22. Both halves of the old body were dead against the real
  // database, and had been since it was written:
  //
  //   * it read `_supabase_migrations`, which exists in no schema — the ledger
  //     is `public.schema_migrations` (mig 364). That read always errored, so
  //     `appliedMax` stayed null and every run without an explicit --mig/--since
  //     died at "Cannot determine applied state".
  //   * it applied SQL through `sb.rpc('exec_sql', { sql })`. Measured across
  //     all 859 migrations: `grep -rln "function.*exec_sql" supabase/migrations/`
  //     returns ZERO files. The function has never existed in any schema.
  //
  // It failed closed and loud, so nothing was ever silently mis-applied — but
  // scripts/DEPLOY_SETUP.md documented it as THE deploy command, and docs/47's
  // Phase 2 recorded this as closed by deleting the OTHER broken runner
  // (apply-migration.mjs) while this one kept the identical defect.
  //
  // ── WHY IT IS NOT SIMPLY POINTED AT THE WORKING PATH ────────────────────
  // Applying a migration is not "run this SQL". CLAUDE.md makes it a governed
  // act, and every guard lives in scripts/db-query.mjs: the file must be
  // COMMITTED (an applied-but-uncommitted migration is unrecoverable), and
  // byte-identical on origin/main (production is one shared database and main
  // is the one source of truth that can rebuild it). Eighteen migrations were
  // recovered from unmerged branches on 2026-08-20 precisely because a runner
  // satisfied a weaker check.
  //
  // Giving deploy.mjs a second, guard-free way in would recreate that. So the
  // migration path is REMOVED rather than reimplemented, and this refuses
  // loudly with the command that is actually correct.
  die(
    'deploy.mjs no longer applies migrations — that path was dead (it called a\n' +
    '   nonexistent `exec_sql` RPC and read a nonexistent `_supabase_migrations`\n' +
    '   table), and re-adding it would bypass the commit/merge guards in\n' +
    '   db-query.mjs that exist because production is one shared database.\n\n' +
    '   Apply a migration with:\n' +
    '       node scripts/db-query.mjs --file supabase/migrations/<NNN>_<slug>.sql\n\n' +
    '   Claim its number first with:\n' +
    '       npm run migrate:next -- <slug>\n\n' +
    '   Then re-run this for the edge functions only:\n' +
    '       node scripts/deploy.mjs --no-migrations --fn <name> [<name> ...]',
  );
}

// ── Functions that authenticate themselves and must NOT sit behind the
// platform's JWT gate ───────────────────────────────────────────────────────
// The gate rejects a request BEFORE the function body runs, so a caller
// presenting anything other than a Supabase JWT gets an opaque 401 with no
// diagnostics. SCIM is exactly that case: Okta/Entra send
// `Authorization: Bearer dtscim_…`, which the function itself verifies against
// a hashed token in scim_tokens (mig 375).
//
// ⚠ WHY THIS IS A LIST HERE AND NOT A supabase/config.toml.
// 48 of the 61 deployed functions already have verify_jwt=false, set
// individually over time. There is no config.toml, and `supabase functions
// deploy` with no flag PRESERVES whatever the function already has — verified
// empirically today by redeploying 51 functions and re-reading the API, all of
// which kept their setting. Introducing a config.toml would make IT the source
// of truth and silently flip every function it does not mention back to
// verify_jwt=true, which would break the anonymous widget (widget-ask), the
// inbound email hook, the OAuth callback and 45 others. A targeted flag is the
// smaller, safer instrument.
const NO_VERIFY_JWT = new Set([
  'scim', // IdP presents its own bearer token; verified in-function (mig 375)
  'mcp-demo-server', // a demo MCP server target; MCP clients POST JSON-RPC, not a Supabase JWT
  'voice-turn', // the voice platform is a third party; verified in-function via x-voice-secret (docs/42)
  'voice-webhook', // same caller, same in-function secret (docs/42)
]);

/**
 * Refuse to deploy an edge function from a tree that is behind origin/main.
 *
 * Deploying replaces the LIVE function wholesale. If another session has
 * shipped a change to that function — or to a _shared module it bundles — and
 * you deploy from before it, their code is simply gone from production while
 * still sitting in git, with nothing erroring and the deploy reporting success.
 *
 * That happened twice in one day: connector-hub was deployed over a parallel
 * session's Google Ads work, and de-answer was deployed before a rebase that
 * had aborted on a dirty tree (its exit code swallowed by a pipe). The first
 * caused a real outage of their feature; the second was harmless only by luck,
 * because the shared file they touched was not one de-answer bundles.
 *
 * A rule that lives in someone's memory fails the second time they are tired.
 * This lives in the tool.
 */
function assertNotStale() {
  if (args.includes('--stale-ok')) return;
  try { execSync('git fetch origin main --quiet', { stdio: 'ignore' }); } catch { /* offline: use the ref we have */ }
  let behind = '0';
  try {
    behind = execSync('git rev-list --count HEAD..origin/main', { encoding: 'utf8' }).trim();
  } catch {
    return; // not a git checkout, or no origin/main — nothing to compare against
  }
  if (behind === '0') return;

  let touched = '';
  try {
    touched = execSync('git diff --name-only HEAD...origin/main -- supabase/functions', { encoding: 'utf8' }).trim();
  } catch { /* best effort */ }

  die([
    `refusing to deploy from a STALE tree — origin/main is ${behind} commit(s) ahead of you.`,
    touched
      ? `\nAnother session has changed these edge files:\n  ${touched.split('\n').join('\n  ')}`
      : '\n(no edge files changed upstream, but your tree is still behind)',
    '\nDeploying now would replace their live function with your older copy.',
    'Fix:  git fetch origin main && git rebase origin/main   — then deploy again.',
    'If you are certain this is safe:  --stale-ok',
  ].join('\n'));
}

function deployFunctions() {
  if (!ACCESS) die('SUPABASE_ACCESS_TOKEN missing — add it to .env.local (supabase.com/dashboard/account/tokens)');
  assertNotStale();
  for (const fn of FUNCTIONS) {
    const dir = path.join(process.cwd(), 'supabase', 'functions', fn);
    if (!fs.existsSync(dir)) die(`function not found: supabase/functions/${fn}`);
    const noJwt = NO_VERIFY_JWT.has(fn);
    console.log(`\nDeploying function: ${fn}${noJwt ? '  (--no-verify-jwt: authenticates itself)' : ''}`);
    execSync(`npx supabase functions deploy ${fn} --project-ref ${REF}${noJwt ? ' --no-verify-jwt' : ''}`, {
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
