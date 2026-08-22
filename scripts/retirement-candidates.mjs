#!/usr/bin/env node
// ============================================================================
// retirement-candidates.mjs — which functions in `public` is nothing calling?
//
// ⚠⚠⚠ THIS FILE EXISTS BECAUSE THE HAND-BUILT VERSION OF IT WAS WRONG.
//
// A previous round produced a retirement list by grepping the repo for each
// function name. An adversarial round destroyed most of it, and every one of
// the four ways it was wrong is now a RULE IN THIS FILE rather than a name on
// a safe-list. A safe-list somebody maintains by hand rots: the next audit
// re-proposes the auth hooks, and dropping those breaks login for every user
// of the product. So each exclusion below is a query or a mechanical rule, and
// each one prints its denominator — how many it examined, not only how many it
// caught. Zero findings from zero comparisons looks exactly like a clean run.
//
//   node scripts/retirement-candidates.mjs            # human report
//   node scripts/retirement-candidates.mjs --json     # machine report
//   node scripts/retirement-candidates.mjs --name X   # everything about one
//   node scripts/retirement-candidates.mjs --selftest # invert every pin
//
// ── THE FOUR THINGS THAT FOOLED THE LAST ROUND ─────────────────────────────
//
// 1. A DIRECTORY NOBODY KNEW ABOUT. `heartbeat_computer_use_runtime` was
//    marked abandoned while it was advancing `computer_use_runtimes.last_seen`
//    during the audit. Its caller is a complete containerised client at
//    runtime/browser-operator/ — Dockerfile, docker-compose, four TS modules —
//    that no scan looked at because nobody knew the directory existed. This
//    file therefore does not take a list of directories to search. It ENUMERATES
//    every top-level entry in the repo and assigns each one to a surface, and
//    it FAILS if it meets a top-level directory it has never been told about.
//    A new top-level directory turns this checker red instead of silently
//    shrinking its own corpus. See UNCLASSIFIED_TOPLEVEL_IS_FATAL.
//
// 2. THREE CALLER SHAPES NO GREP CAN SEE.
//    · THE GRANTEE IS THE CALLER. supabase_auth_admin holds EXECUTE on the two
//      auth hooks; the Supabase Auth service invokes them from project config
//      on every sign-in and sign-up, and no file in this repo names them.
//      approval_brief_writer and trust_pattern_proposer are the same shape.
//      Rule: any grantee outside the AMBIENT set is a caller. (R4)
//    · A GENERATED FILE IS NOT A CALLER. src/types/database.types.ts names 229
//      of these functions and rescued 15 that nothing calls. So do
//      supabase/baseline/full_schema.sql and review/*.json. (GENERATED)
//    · A NAME IN A COMMENT IS NOT A CALLER. 16 were rescued by a comment, one
//      of which reads "its frontend wrapper is gone". Every body and every
//      source file is comment-stripped before matching. (stripComments)
//
// 3. THE ANSWER IS SOMETIMES ALREADY WRITTEN DOWN. Migration 749's header
//    names nine retirement candidates by hand, with evidence — and DISQUALIFIES
//    four of them in the same breath ("reachable by NOBODY, and that is
//    DELIBERATE"). A caller census cannot see prose. Rule R7 searches every
//    migration header and every doc for the name, and a hit does not rescue the
//    function — it BLOCKS TIER A and sends it to Tier B for a human to read.
//
// 4. BUILT-AHEAD LOOKS EXACTLY LIKE ABANDONED. set_authority_rule (783),
//    forget_end_user (779) and revive_unit (687) are recent and deliberately
//    inert. Anything introduced inside the in-flight window is out of scope
//    on arrival. (R6)
//
// ── WHAT THIS FILE CANNOT SEE, SAID OUT LOUD ───────────────────────────────
// A caller that builds the function name at runtime — `supabase.rpc(\`get_\${k}\`)`
// — is invisible to every rule here, and so is a caller that lives outside this
// repository entirely (a partner integration hitting /rest/v1/rpc/name over the
// anon key). Rule R4 covers the second case only where the grant is bespoke.
// That residue is why the report has a Tier B at all.
// ============================================================================

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, extname, sep } from 'node:path';

const ARGV = process.argv.slice(2);
const JSON_OUT = ARGV.includes('--json');
const SELFTEST = ARGV.includes('--selftest');
const ONE_NAME = ARGV.includes('--name') ? ARGV[ARGV.indexOf('--name') + 1] : null;
const ROOT = process.cwd();

// ── The in-flight window ───────────────────────────────────────────────────
// A function introduced by a recent migration is presumed BUILT AHEAD, not
// abandoned. The window is expressed as a count of migration NUMBERS back from
// the highest number applied to production, so it slides on its own and nobody
// has to remember to move it.
const INFLIGHT_WINDOW = 60;

// ── The ambient grantee set ────────────────────────────────────────────────
// These four roles plus the owner are what EVERY function gets by default or by
// house convention, so holding EXECUTE for one of them says nothing about
// whether anybody calls it. A grantee OUTSIDE this set was created for a
// purpose and is a caller. This set is deliberately tiny: adding a name to it
// is how the auth hooks get re-proposed.
const AMBIENT_GRANTEES = new Set(['postgres', 'PUBLIC', 'anon', 'authenticated', 'service_role']);

// ── Surfaces ───────────────────────────────────────────────────────────────
// Every top-level entry in the repo is assigned to exactly one of these.
//   caller    — live product/tooling code. A match here rescues the function.
//   test      — a match rescues nothing on its own but is recorded (a function
//               whose only caller is its own test is dead in production and
//               live in CI, and that is a different verdict).
//   intent    — prose. Never a caller. A match BLOCKS Tier A. (R7)
//   generated — derived from the live schema. Naming a function here is a
//               restatement of the census, not a call. Never matched.
//   ignore    — not code and not prose (binaries, lockfiles, agent caches).
const SURFACE = {
  // ---- caller ----
  'src': 'caller',
  'supabase/functions': 'caller',
  'runtime': 'caller',            // ⚠ the directory that broke the last round
  'scripts': 'caller',
  'public': 'caller',
  '.github': 'caller',
  'qa-app.js': 'caller',
  'qa-audit.cjs': 'caller',
  'qa-forms.cjs': 'caller',
  'full-deploy-check.sh': 'caller',
  'verify-migration.sql': 'caller',
  'vite.config.ts': 'caller',
  'vitest.config.ts': 'caller',
  // Added 2026-08-22 — and this entry is the argument for wiring this
  // checker into certify. vitest.offline.config.ts landed earlier the same
  // day and UNCLASSIFIED_TOPLEVEL_IS_FATAL fired on it correctly, on the
  // FIRST run anyone had ever given this tool. It caught a real omission in
  // a change made minutes earlier; it just had no bell attached.
  'vitest.offline.config.ts': 'caller',
  'postcss.config.js': 'caller',
  'tailwind.config.js': 'caller',
  'index.html': 'caller',
  'package.json': 'caller',
  'vercel.json': 'caller',
  'tsconfig.json': 'caller',
  'tsconfig.node.json': 'caller',
  '.mcp.json': 'caller',
  '.audit_sql.sh': 'caller',

  // ---- test ----
  'tests': 'test',
  'supabase/tests': 'test',

  // ---- intent (prose — blocks Tier A, never rescues) ----
  'supabase/migrations': 'intent',
  'docs': 'intent',
  'README.md': 'intent',
  'CLAUDE.md': 'intent',
  'BACKEND_RPC_REQUIREMENTS.md': 'intent',
  'DEPLOYMENT_COMPLETE_VERIFICATION.md': 'intent',
  'DEPLOYMENT_READY.md': 'intent',
  'OUTSOURCETEL_SOPHIE_CONFIGURATION.md': 'intent',
  'SOPHIE_CONFIGURATION_FRAMEWORK.md': 'intent',
  'TENANT_MANAGEMENT_BUILD.md': 'intent',
  'WEEK1_FOUNDATION_COMPLETION.md': 'intent',
  'WEEK1_STARTING_TASKS.md': 'intent',
  'WEEK2_CODEBASE_AUDIT_AND_AMENDMENTS.md': 'intent',
  'WEEK2_PARALLEL_PREREQUISITES.md': 'intent',
  'WEEK2_SUPPORT_AGENT_BUILD_PLAN.md': 'intent',
  'WORK_ANALYSIS_48HR_2026_07_20.md': 'intent',

  // ---- generated (never matched — see rule 2) ----
  'src/types/database.types.ts': 'generated',
  'supabase/baseline': 'generated',
  'review': 'generated',
  'dist': 'generated',
  'runtime/browser-operator/dist': 'generated',
  'qa-output': 'generated',
  'backups': 'generated',
  'supabase/.temp': 'generated',
  'package-lock.json': 'generated',
  'runtime/browser-operator/package-lock.json': 'generated',
  'deno.lock': 'generated',

  // ---- ignore ----
  'node_modules': 'ignore',
  'runtime/browser-operator/node_modules': 'ignore',
  '.git': 'ignore',
  '.claude': 'ignore',
  '.superpowers': 'ignore',
  '.github/ISSUE_TEMPLATE': 'ignore',
  '.env': 'ignore',
  '.env.example': 'ignore',
  '.env.local': 'ignore',
  '.env.production-backup': 'ignore',
  '.env.test': 'ignore',
  '.gitignore': 'ignore',
  '.supabase-token': 'ignore',
  '.vercel-token': 'ignore',
  '.vercel': 'ignore',
  'qa-style.css': 'ignore',
};

// A new top-level directory must turn this red, not silently shrink the corpus.
const UNCLASSIFIED_TOPLEVEL_IS_FATAL = true;

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.sql', '.json', '.md', '.sh',
  '.yml', '.yaml', '.html', '.css', '.txt', '.toml', '.env', '.webmanifest', '',
]);

// ── db ─────────────────────────────────────────────────────────────────────
function q(sql) {
  const r = spawnSync(process.execPath, [join('scripts', 'db-query.mjs'), '--sql', sql], {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, cwd: ROOT,
  });
  if (r.status !== 0) {
    throw new Error(`db-query failed (${r.status}): ${(r.stderr || r.stdout || '').slice(0, 2000)}`);
  }
  const out = (r.stdout || '').trim();
  try { return JSON.parse(out); }
  catch { throw new Error(`db-query returned non-JSON: ${out.slice(0, 800)}`); }
}

// ── comment stripping ──────────────────────────────────────────────────────
// Rule 2, third shape. `--` in SQL and `//` in TS/JS both hide a name that is
// NOT a call. The `//` strip deliberately refuses to fire on `://` so that a
// URL is not treated as the start of a comment and the rest of the line lost.
function stripComments(text, ext) {
  let t = text.replace(/\/\*[\s\S]*?\*\//g, ' ');           // block, both dialects
  if (ext === '.sql') t = t.replace(/--[^\n]*/g, ' ');
  else t = t.replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  return t;
}
function stripSqlComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

// ── DDL-about vs invocation, inside a migration body ───────────────────────
// R9 asks whether a migration CALLS a function — a provisioning or backfill
// path that no TypeScript names and that R5 therefore cannot see. It is what
// migration 636 meant by "install_role_watchers is called only from migrations
// and provisioning, both".
//
// The trap: `grant execute on function public.foo(uuid) to service_role` names
// foo and is followed by `(`, so any "name-then-paren" test calls it a caller.
// So every DDL clause that is ABOUT a function is deleted before the search.
const DDL_ABOUT_FUNCTION =
  /\b(?:create\s+(?:or\s+replace\s+)?function|drop\s+function(?:\s+if\s+exists)?|alter\s+function|comment\s+on\s+function|on\s+function)\s+[^;(]*\(/gi;
function stripDdlAboutFunctions(sql) {
  return sql.replace(DDL_ABOUT_FUNCTION, ' ');
}

// ⚠ AND THE SECOND TRAP, WHICH COST A CORRECT ANSWER ONCE ALREADY. Migration
// 749 carries a row of allowlist DATA reading
//     ('public.certify_de_from_sim(uuid,text,uuid,integer)', true, true)
// — a NAME INSIDE A STRING LITERAL, followed by `(`. Counted as a call, it
// rescues a function 749's own header calls dead in the same file. So literals
// go before the search. The `''` form is real in these bodies (…exception''s…)
// and a naive /'[^']*'/ ends the literal in the middle of one.
function stripSqlLiterals(sql) {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

// ── word-boundary matcher ──────────────────────────────────────────────────
// `_` counts as a word character on purpose: without that, `search_knowledge`
// matches inside `search_knowledge_docs` and a live sibling rescues a dead
// function. JS \b does NOT give this — it treats `_` as a word char already,
// but \b would still let `search_knowledge` match at the start of
// `search_knowledge_docs`. The explicit trailing class is the fix.
const WORDY = /[A-Za-z0-9_]/;
function findAll(hay, needle) {
  const hits = [];
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    const before = i === 0 ? '' : hay[i - 1];
    const after = hay[i + needle.length] ?? '';
    if (!WORDY.test(before) && !WORDY.test(after)) hits.push(i);
    i += needle.length;
  }
  return hits;
}

// An INVOCATION-shaped hit vs a MENTION-shaped one. A name inside a string
// array in an audit script is a census, not a call; `.rpc('name'` is a call.
// Both are reported. Only the invocation shape is allowed to rescue silently.
function classifyHit(hay, at, name) {
  const pre = hay.slice(Math.max(0, at - 60), at);
  const post = hay.slice(at + name.length, at + name.length + 8);
  if (/\.rpc\(\s*['"`]$/.test(pre)) return 'rpc';
  if (/rpc\/$/.test(pre)) return 'rest';
  if (/(select|perform|call|from|join|=|return)\s+(public\.)?$/i.test(pre) && /^\s*\(/.test(post)) return 'sqlcall';
  if (/^\s*\(/.test(post)) return 'call';
  return 'mention';
}

// ── repo walk ──────────────────────────────────────────────────────────────
function classifyPath(rel) {
  const parts = rel.split(sep).join('/');
  // longest configured prefix wins, so supabase/baseline beats supabase/...
  let best = null;
  for (const key of Object.keys(SURFACE)) {
    if (parts === key || parts.startsWith(key + '/')) {
      if (!best || key.length > best.length) best = key;
    }
  }
  return best ? { key: best, surface: SURFACE[best] } : null;
}

function isContainer(rel) {
  const p = rel.split(sep).join('/') + '/';
  return Object.keys(SURFACE).some((k) => k.startsWith(p));
}

function walk(dir, acc, denom) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const abs = join(dir, e.name);
    const rel = abs.slice(ROOT.length + 1);
    const cls = classifyPath(rel);
    if (!cls) {
      // A directory whose CHILDREN are classified (supabase/ holds functions,
      // migrations, baseline and tests, each with its own surface) is a
      // container: recurse. Anything else at the top level is genuinely new
      // and must go fatal — that is the runtime/ lesson, mechanised.
      if (e.isDirectory() && isContainer(rel)) { walk(abs, acc, denom); continue; }
      if (rel.split(sep).length === 1) { denom.unclassified.push(rel); continue; }
      continue;
    }
    if (cls.surface === 'ignore') { denom.ignoredPaths++; continue; }
    if (e.isDirectory()) { walk(abs, acc, denom); continue; }
    if (!e.isFile()) continue;
    const ext = extname(e.name).toLowerCase();
    if (!TEXT_EXT.has(ext)) { denom.binarySkipped++; continue; }
    let size = 0;
    try { size = statSync(abs).size; } catch { continue; }
    if (size > 12 * 1024 * 1024) { denom.tooBig.push(rel); continue; }
    let raw;
    try { raw = readFileSync(abs, 'utf8'); } catch { continue; }
    denom.bySurface[cls.surface] = denom.bySurface[cls.surface] || { files: 0, bytes: 0 };
    denom.bySurface[cls.surface].files++;
    denom.bySurface[cls.surface].bytes += size;
    if (cls.surface === 'generated') { denom.generatedFiles.push(rel); continue; }
    acc.push({ rel, surface: cls.surface, text: stripComments(raw, ext), ext });
  }
}

// ── main ───────────────────────────────────────────────────────────────────
function main() {
  const denom = {
    unclassified: [], ignoredPaths: 0, binarySkipped: 0, tooBig: [],
    generatedFiles: [], bySurface: {},
  };
  const files = [];
  walk(ROOT, files, denom);

  if (denom.unclassified.length && UNCLASSIFIED_TOPLEVEL_IS_FATAL) {
    console.error('UNCLASSIFIED TOP-LEVEL ENTRIES — this checker refuses to run with a');
    console.error('surface it has never been told about. THIS IS THE runtime/ FAILURE.');
    console.error('Assign each of these in SURFACE, then re-run:');
    for (const u of denom.unclassified) console.error('  ' + u);
    process.exit(2);
  }

  // ── R0 population ────────────────────────────────────────────────────────
  const census = q(`
    select p.oid::text as oid, p.proname as name,
           pg_get_function_arguments(p.oid) as args,
           pg_get_function_identity_arguments(p.oid) as ident,
           p.prokind::text as kind, p.prosecdef as secdef,
           pg_get_function_result(p.oid) as result
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and not exists (select 1 from pg_depend d
                        where d.deptype='e' and d.classid='pg_proc'::regclass and d.objid = p.oid)
     order by p.proname, p.oid`);

  // ── R1 in-database dependents (triggers, RLS policies, views, defaults,
  //     constraints, casts, operators, event triggers, index support) ───────
  const deps = q(`
    select p.proname as name, p.oid::text as oid,
           d.classid::regclass::text as dep_kind, count(*)::text as n
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      join pg_depend d on d.refobjid = p.oid and d.refclassid = 'pg_proc'::regclass
     where n.nspname='public' and d.deptype <> 'i'
       and not (d.classid = 'pg_proc'::regclass and d.objid = p.oid)
     group by 1,2,3`);

  // ── R2 another function's body names it, comments stripped ───────────────
  const bodyRefs = q(`
    with fns as (
      select p.oid, p.proname,
             regexp_replace(regexp_replace(p.prosrc, '/\\*.*?\\*/', ' ', 'gs'),
                            '--[^' || chr(10) || ']*', ' ', 'g') as body
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public'
         and not exists (select 1 from pg_depend d
                          where d.deptype='e' and d.classid='pg_proc'::regclass and d.objid=p.oid)),
    names as (select distinct proname from fns)
    select nm.proname as name,
           string_agg(distinct f.proname, ',' order by f.proname) as callers
      from names nm
      join fns f on f.proname <> nm.proname
                and f.body ~ ('(^|[^a-zA-Z0-9_])' || nm.proname || '[^a-zA-Z0-9_]')
     group by 1`);

  // ── R3 scheduled jobs ────────────────────────────────────────────────────
  const cron = q(`select jobid::text as jobid, jobname, command, active::text as active from cron.job`);
  const cronText = cron.map((j) => stripSqlComments(j.command || '')).join('\n');

  // ── R4 the grantee is the caller ─────────────────────────────────────────
  const grants = q(`
    select p.proname as name, p.oid::text as oid,
           case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end as grantee
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace,
           lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
     where n.nspname='public' and x.privilege_type='EXECUTE'
       and not exists (select 1 from pg_depend d
                        where d.deptype='e' and d.classid='pg_proc'::regclass and d.objid=p.oid)`);

  // ── R6 which migration introduced it, and when ───────────────────────────
  const migDir = join(ROOT, 'supabase', 'migrations');
  const migFiles = readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
  const CREATE_RE = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?([a-z0-9_]+)"?\s*\(/gi;
  const introducedBy = new Map();   // name -> migration filename (lowest number that creates it)
  const migIntent = new Map();      // name -> [{file, line, text}] prose hits
  const migRaw = [];
  for (const f of migFiles) {
    const raw = readFileSync(join(migDir, f), 'utf8');
    migRaw.push({ f, raw });
    const body = stripSqlComments(raw);
    let m;
    CREATE_RE.lastIndex = 0;
    while ((m = CREATE_RE.exec(body))) {
      if (!introducedBy.has(m[1])) introducedBy.set(m[1], f);
    }
  }
  // ⚠ Six migrations in the ledger are CLI-timestamped (20260719225435_…) and
  // carry no 3-digit number. They are all from 2026-07 and are months older
  // than the in-flight window, so they read as number 0 rather than as
  // parseInt('202') — which is what `f.slice(0,3)` silently produced, and
  // would have put a July function inside an August window.
  const migNum = (f) => (/^\d{3}_/.test(f) ? parseInt(f.slice(0, 3), 10) : 0);
  const highestApplied = Number(
    q(`select max((regexp_match(filename,'^([0-9]{3})_'))[1]::int)::text as n from public.schema_migrations`)[0].n
  );
  const inflightFrom = highestApplied - INFLIGHT_WINDOW + 1;

  // ── build the index ──────────────────────────────────────────────────────
  const byName = new Map();
  for (const f of census) {
    if (!byName.has(f.name)) byName.set(f.name, { name: f.name, overloads: [] });
    byName.get(f.name).overloads.push(f);
  }
  for (const rec of byName.values()) {
    rec.deps = deps.filter((d) => d.name === rec.name);
    rec.bodyCallers = (bodyRefs.find((b) => b.name === rec.name)?.callers || '').split(',').filter(Boolean);
    rec.grantees = [...new Set(grants.filter((g) => g.name === rec.name).map((g) => g.grantee))].sort();
    rec.bespokeGrantees = rec.grantees.filter((g) => !AMBIENT_GRANTEES.has(g));
    rec.cronHits = findAll(cronText, rec.name).length;
    rec.introMig = introducedBy.get(rec.name) || null;
    rec.introNum = rec.introMig ? migNum(rec.introMig) : null;
    rec.repo = { caller: [], test: [], intent: [] };
  }

  // ── scan the repo corpus ─────────────────────────────────────────────────
  const names = [...byName.keys()];
  let comparisons = 0;
  for (const file of files) {
    for (const name of names) {
      comparisons++;
      const hits = findAll(file.text, name);
      if (!hits.length) continue;
      const rec = byName.get(name);
      const shapes = [...new Set(hits.map((h) => classifyHit(file.text, h, name)))];
      const bucket = rec.repo[file.surface];
      if (bucket) bucket.push({ file: file.rel, n: hits.length, shapes });
    }
  }
  // ── R7 migration prose ───────────────────────────────────────────────────
  // Matched on the RAW comment text on purpose: a comment is exactly what we
  // are looking for here. This rule does NOT exclude anything and does NOT
  // rescue anything — it ATTACHES the sentence a migration wrote about this
  // function, verbatim, so the reading a machine cannot do is put in front of
  // the human who has to do it. Migration 749's header names nine retirement
  // candidates and DISQUALIFIES four of them in the same breath; no density
  // heuristic separates those two halves, and pretending one does is how the
  // last round's answer went missing.
  let migComparisons = 0;
  for (const { f, raw } of migRaw) {
    const lines = raw.split(/\r?\n/);
    const commentLines = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/--(.*)$/);
      if (m) commentLines.push({ i: i + 1, text: m[1].trim() });
    }
    const joined = commentLines.map((c) => c.text).join('\n');
    for (const name of names) {
      migComparisons++;
      if (!findAll(joined, name).length) continue;
      const rec = byName.get(name);
      const quotes = commentLines.filter((c) => findAll(c.text, name).length)
        .slice(0, 3).map((c) => `${f}:${c.i}  ${c.text}`);
      rec.repo.intent.push({ file: `supabase/migrations/${f}`, self: f === rec.introMig, quotes });
    }
  }

  // ── apply the rules, in order, counting the denominator at each step ─────
  const steps = [];
  let live = [...byName.values()];
  const step = (label, pred, note) => {
    const before = live.length;
    const removed = live.filter(pred);
    live = live.filter((r) => !pred(r));
    steps.push({ label, examined: before, excluded: removed.length, remaining: live.length, note,
                 names: removed.map((r) => r.name) });
  };

  steps.push({ label: 'R0  population — non-extension functions in public', examined: byName.size,
               excluded: 0, remaining: byName.size,
               note: `${census.length} overloads across ${byName.size} distinct names` });

  step('R1  a database object depends on it (trigger / RLS policy / view / default / constraint / cast / operator / event trigger)',
       (r) => r.deps.length > 0, 'pg_depend, refclassid=pg_proc, deptype<>i');
  step('R2  another function body names it (comments stripped)',
       (r) => r.bodyCallers.length > 0, 'pg_proc.prosrc cross-reference, server-side');
  step('R3  a cron.job command names it',
       (r) => r.cronHits > 0, `${cron.length} scheduled jobs read`);
  step('R4  granted EXECUTE to a role outside the ambient set — THE GRANTEE IS THE CALLER',
       (r) => r.bespokeGrantees.length > 0, `ambient = ${[...AMBIENT_GRANTEES].join(', ')}`);
  // ⚠ R5 RESCUES ON A HIT OF ANY SHAPE, INCLUDING A BARE MENTION, AND THAT IS
  // DELIBERATE. `calculate_tenant_monthly_cost` appears in scripts/anon-probe.mjs
  // only as a string inside an array — mention-shaped, and it IS a caller: the
  // probe iterates that array and .rpc()s every entry to prove anon is refused.
  // A data-driven dispatch table is indistinguishable from a hand-list until
  // you read what iterates it, so over-rescuing here is the safe error. The
  // count is printed so the size of that softness is visible rather than
  // assumed.
  const mentionOnly = live.filter((r) => r.repo.caller.length > 0 &&
    !r.repo.caller.some((h) => h.shapes.some((s) => s !== 'mention'))).map((r) => r.name);
  step('R5  named in live repo code (generated artifacts excluded, comments stripped)',
       (r) => r.repo.caller.length > 0,
       `${denom.bySurface.caller?.files ?? 0} caller-surface files; ` +
       `${mentionOnly.length} of the rescues rest on MENTION-shaped hits only`);
  step('R6  introduced inside the in-flight window — BUILT AHEAD LOOKS LIKE ABANDONED',
       (r) => r.introNum !== null && r.introNum >= inflightFrom,
       `window = last ${INFLIGHT_WINDOW} migration numbers, i.e. >= ${inflightFrom} (highest applied ${highestApplied})`);

  // ── R8 the post-split wrapper ────────────────────────────────────────────
  // ⚠ THE LARGEST SINGLE CLASS OF FALSE POSITIVES ON THIS REPO, AND THE ONE A
  // CALLER CENSUS IS GUARANTEED TO GET WRONG.
  //
  // Migrations 748 and 749 fixed a fail-open authority prefix by SPLITTING each
  // affected function: `X_internal` carries the body with no user check and is
  // service_role-only, and the ORIGINAL NAME X becomes a wrapper that refuses a
  // caller with no identity. Every call site was repointed at X_internal, so X
  // has exactly zero callers — BY DESIGN, as the fail-closed public identity of
  // the operation. 749's header says so in as many words about three of them:
  // "reachable by NOBODY, and that is DELIBERATE", with a stated revival path
  // (`grant execute … to authenticated`).
  //
  // Dropping a wrapper is not a no-op. It deletes the gate and leaves the
  // UNGATED `_internal` on the only name that remains, which is the exact
  // inversion 749 refused ("the gate belongs on the obvious name").
  //
  // Mechanical, and it re-derives itself: X is a wrapper iff `X_internal`
  // exists in the same catalogue.
  const internalNames = new Set(census.map((c) => c.name).filter((n) => n.endsWith('_internal')));
  step('R8  a fail-closed wrapper left behind by an authority split (an `X_internal` sibling exists)',
       (r) => internalNames.has(`${r.name}_internal`),
       `${internalNames.size} _internal functions in the catalogue`);

  // R9 — a migration BODY invokes it (provisioning / backfill / seeding).
  // Computed here rather than earlier because it is the most expensive rule and
  // the population is already small; the result is identical either way.
  // ⚠ THE THIRD TRAP. A migration that CREATES a function and then exercises it
  // in a probe or a one-shot backfill is not a caller of the running system —
  // it is a file talking to itself, and it stops talking the moment it has
  // applied. Migration 749 both re-creates certify_de_from_sim / resolve_de_
  // exception and PERFORMs them in its verification probes, while its own
  // header says of both: "none, anywhere". Counting that as a caller
  // contradicts the file in the file's own words. So a migration is only a
  // caller of a function it does NOT define.
  const definesFn = new Map();          // migration file -> Set(names it creates)
  for (const { f, raw } of migRaw) {
    const s = new Set();
    const re = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?([a-z0-9_]+)"?\s*\(/gi;
    let m; const b = stripSqlComments(raw);
    while ((m = re.exec(b))) s.add(m[1]);
    definesFn.set(f, s);
  }
  const migBodies = migRaw.map(({ f, raw }) =>
    ({ f, body: stripDdlAboutFunctions(stripSqlLiterals(stripSqlComments(raw))) }));
  for (const r of live) {
    r.migCallers = [];
    for (const { f, body } of migBodies) {
      if (definesFn.get(f)?.has(r.name)) continue;      // self-reference, not a caller
      for (const at of findAll(body, r.name)) {
        if (/^\s*\(/.test(body.slice(at + r.name.length, at + r.name.length + 6))) {
          r.migCallers.push(f); break;
        }
      }
    }
  }
  step('R9  a migration BODY invokes it — provisioning / backfill, a caller no grep of src/ can see',
       (r) => r.migCallers.length > 0,
       `${migRaw.length} migration files; DDL-about-a-function clauses, string literals and self-references removed first`);

  // ── Tiering ──────────────────────────────────────────────────────────────
  // Everything that survived R1-R6 has NO caller on any surface this repo can
  // see. What separates A from B is the COST OF BEING WRONG, and each softener
  // below is a reason the caller census might be blind rather than right.
  //
  // ⚠ A migration-header mention is NOT a softener. It cannot be: every
  // function is named by the migrations around it, so treating a mention as a
  // blocker makes Tier A structurally empty and the checker unable to fail. The
  // quotes are ATTACHED instead and a human reads them.
  const tierA = [], tierB = [];
  for (const r of live) {
    const blockers = [];
    if (r.repo.test.length)
      blockers.push(`named in ${r.repo.test.length} test file(s) — a test would break, and CI is a caller`);
    if (r.introMig === null)
      blockers.push('no migration in the repo creates it — provenance unknown, so the drop cannot be replayed');
    if (r.grantees.includes('anon'))
      blockers.push('anon holds EXECUTE — reachable over /rest/v1/rpc without a session, i.e. by a caller outside this repo');
    if (r.grantees.includes('PUBLIC'))
      blockers.push('PUBLIC holds EXECUTE — same, and wider');
    if (r.overloads.length > 1)
      blockers.push(`${r.overloads.length} overloads share this name — a drop must name each signature and one may be live`);
    r.blockers = blockers;
    (blockers.length ? tierB : tierA).push(r);
  }

  const report = {
    measured_at: new Date().toISOString(),
    denominators: {
      surfaces: denom.bySurface,
      generated_files_excluded: denom.generatedFiles.sort(),
      binary_or_unreadable_skipped: denom.binarySkipped,
      ignored_paths: denom.ignoredPaths,
      distinct_function_names: byName.size,
      overloads: census.length,
      repo_comparisons: comparisons,
      migration_header_comparisons: migComparisons,
      cron_jobs: cron.length,
      grant_rows: grants.length,
      dependency_rows: deps.length,
      body_reference_rows: bodyRefs.length,
      r5_rescues_on_mention_shaped_hits_only: mentionOnly,
      migration_files: migFiles.length,
      highest_applied_migration: highestApplied,
      inflight_from: inflightFrom,
    },
    steps,
    tierA: tierA.map(fmt).sort(byNameAsc),
    tierB: tierB.map(fmt).sort(byNameAsc),
  };

  if (ONE_NAME) {
    const rec = byName.get(ONE_NAME);
    console.log(JSON.stringify(rec ? fmt(rec, true) : { error: 'no such function in public' }, null, 2));
    return;
  }
  if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); return; }
  human(report);
}

function byNameAsc(a, b) { return a.name < b.name ? -1 : 1; }

function fmt(r, verbose = false) {
  const o = {
    name: r.name,
    signatures: r.overloads.map((o2) => `${o2.name}(${o2.args})`),
    kind: r.overloads[0].kind,
    secdef: r.overloads[0].secdef,
    introduced_by: r.introMig,
    grantees: r.grantees,
    bespoke_grantees: r.bespokeGrantees,
    db_dependents: r.deps.map((d) => `${d.dep_kind}x${d.n}`),
    sql_body_callers: r.bodyCallers,
    cron_hits: r.cronHits,
    repo_caller_hits: r.repo.caller,
    repo_test_hits: r.repo.test,
    intent_files: r.repo.intent.map((h) => h.file),
    intent_quotes: r.repo.intent.flatMap((h) => h.quotes ?? []),
    blockers: r.blockers ?? [],
  };
  if (verbose) o.result = r.overloads.map((o2) => o2.result);
  return o;
}

function human(rep) {
  const d = rep.denominators;
  console.log('='.repeat(78));
  console.log('RETIREMENT CANDIDATES —', rep.measured_at);
  console.log('='.repeat(78));
  console.log('\nSURFACES SEARCHED (denominator, not a claim):');
  for (const [s, v] of Object.entries(d.surfaces).sort()) {
    console.log(`  ${s.padEnd(10)} ${String(v.files).padStart(6)} files  ${String(v.bytes).padStart(10)} bytes`);
  }
  console.log(`  ${'binary'.padEnd(10)} ${String(d.binary_or_unreadable_skipped).padStart(6)} skipped (not text)`);
  console.log(`\nGENERATED ARTIFACTS EXCLUDED FROM THE CALLER CORPUS (${d.generated_files_excluded.length} files):`);
  const roots = [...new Set(d.generated_files_excluded.map((f) => f.split(sep).slice(0, 2).join('/')))];
  for (const r of roots.sort()) console.log('  ' + r);
  console.log(`\nCOMPARISONS MADE: ${d.repo_comparisons.toLocaleString()} (file x name) in the repo,`);
  console.log(`                  ${d.migration_header_comparisons.toLocaleString()} (migration header x name).`);
  console.log(`                  ${d.cron_jobs} cron jobs, ${d.grant_rows} grant rows, ${d.dependency_rows} dependency rows.`);
  console.log('\n' + '-'.repeat(78));
  console.log('EXCLUSIONS, IN ORDER — each is a query or a rule, none is a hand-list');
  console.log('-'.repeat(78));
  for (const s of rep.steps) {
    console.log(`\n${s.label}`);
    console.log(`   examined ${s.examined}   excluded ${s.excluded}   remaining ${s.remaining}`);
    if (s.note) console.log(`   ${s.note}`);
  }
  console.log('\n' + '='.repeat(78));
  console.log(`TIER A — DROP  (${rep.tierA.length})`);
  console.log('='.repeat(78));
  console.log('  no caller on ANY surface; ambient grants only; outside the in-flight window;');
  console.log('  nothing in the database depends on it. READ THE QUOTES BEFORE DROPPING.');
  for (const t of rep.tierA) {
    console.log(`\n  ${t.name}   [${t.introduced_by}]`);
    console.log(`    ${t.signatures.join('\n    ')}`);
    console.log(`    grantees: ${t.grantees.join(', ') || '(none)'}   secdef=${t.secdef}`);
    if (t.intent_quotes.length) {
      console.log(`    what the migrations SAY about it (${t.intent_quotes.length} lines, first 3):`);
      for (const qt of t.intent_quotes.slice(0, 3)) console.log(`      | ${qt}`);
    } else {
      console.log('    no migration comment anywhere names it.');
    }
  }
  if (!rep.tierA.length) console.log('\n  (empty — and that is a legitimate answer)');
  console.log('\n' + '='.repeat(78));
  console.log(`TIER B — REVOKE ONLY / READ FIRST  (${rep.tierB.length})`);
  console.log('='.repeat(78));
  for (const t of rep.tierB) {
    console.log(`\n  ${t.name}   [${t.introduced_by}]`);
    for (const b of t.blockers) console.log(`    · ${b}`);
  }
}

// ── selftest — invert every pin ────────────────────────────────────────────
// A checker that cannot fail is theatre. Each case below MUTATES the input to
// one rule so that the rule must change its answer, and asserts that it does.
function selftest() {
  let pass = 0, fail = 0;
  const t = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}   got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
    ok ? pass++ : fail++;
  };
  console.log('SELFTEST — every pin inverted\n');

  // stripComments: a name hidden in a comment must NOT survive
  t('sql -- comment stripped', findAll(stripComments('-- calls foo_bar()\nselect 1', '.sql'), 'foo_bar').length, 0);
  t('sql comment strip does not eat code', findAll(stripComments('select foo_bar();', '.sql'), 'foo_bar').length, 1);
  t('ts // comment stripped', findAll(stripComments('// foo_bar is gone\nx();', '.ts'), 'foo_bar').length, 0);
  t('ts block comment stripped', findAll(stripComments('/* foo_bar */ x();', '.ts'), 'foo_bar').length, 0);
  t('URL is not a comment', findAll(stripComments('const u="https://x/foo_bar";', '.ts'), 'foo_bar').length, 1);

  // word boundary: a longer sibling must not rescue a shorter name
  t('prefix sibling does not match', findAll('search_knowledge_docs(', 'search_knowledge').length, 0);
  t('exact name does match', findAll('search_knowledge(', 'search_knowledge').length, 1);
  t('suffix sibling does not match', findAll('x_search_knowledge(', 'search_knowledge').length, 0);

  // hit classification
  const at = (s, n) => s.indexOf(n);
  const RPC = `supabase.rpc('foo_bar', {})`;
  const LIST = `const A=['foo_bar','x']`;
  const SEL = `select foo_bar()`;
  t('.rpc( is an invocation', classifyHit(RPC, at(RPC, 'foo_bar'), 'foo_bar'), 'rpc');
  t('bare name in a list is a mention', classifyHit(LIST, at(LIST, 'foo_bar'), 'foo_bar'), 'mention');
  t('sql select is an invocation', classifyHit(SEL, at(SEL, 'foo_bar'), 'foo_bar'), 'sqlcall');

  // surface classification: the runtime/ failure, and generated must not rescue
  t('runtime/ is a caller surface', classifyPath(join('runtime', 'browser-operator', 'src', 'db.ts'))?.surface, 'caller');
  t('runtime/**/dist is generated', classifyPath(join('runtime', 'browser-operator', 'dist', 'db.js'))?.surface, 'generated');
  t('database.types.ts is generated', classifyPath(join('src', 'types', 'database.types.ts'))?.surface, 'generated');
  t('src/lib is a caller', classifyPath(join('src', 'lib', 'knowledgeApi.ts'))?.surface, 'caller');
  t('baseline is generated', classifyPath(join('supabase', 'baseline', 'full_schema.sql'))?.surface, 'generated');
  t('migrations are intent, not callers', classifyPath(join('supabase', 'migrations', '749_x.sql'))?.surface, 'intent');
  t('review/*.json is generated', classifyPath(join('review', 'certify-last.json'))?.surface, 'generated');
  t('supabase/functions is a caller', classifyPath(join('supabase', 'functions', 'de-work', 'index.ts'))?.surface, 'caller');
  t('an unknown top-level entry is unclassified (goes fatal)', classifyPath('brand-new-dir'), null);

  // ambient set: the auth hooks' grantee must read as bespoke
  t('supabase_auth_admin is NOT ambient', AMBIENT_GRANTEES.has('supabase_auth_admin'), false);
  t('service_role IS ambient', AMBIENT_GRANTEES.has('service_role'), true);

  // R9: a GRANT that names a function is not a call; a select that names it is
  const G = `grant execute on function public.foo_bar(uuid) to service_role;`;
  const C = `create or replace function public.foo_bar(p uuid) returns void as $$ begin end $$;`;
  const D = `drop function if exists public.foo_bar(uuid);`;
  const S = `perform public.foo_bar(v_id);`;
  const LIT = `insert into t values ('public.foo_bar(uuid,text)', true);`;
  const LITQ = `select format('refused by foo_bar (%s)', x);`;
  const isCall = (sql) => {
    const b = stripDdlAboutFunctions(stripSqlLiterals(stripSqlComments(sql)));
    return findAll(b, 'foo_bar').some((a) => /^\s*\(/.test(b.slice(a + 7, a + 13)));
  };
  t('R9: grant execute is NOT a call', isCall(G), false);
  t('R9: create function is NOT a call', isCall(C), false);
  t('R9: drop function is NOT a call', isCall(D), false);
  t('R9: perform IS a call', isCall(S), true);
  t('R9: a name inside a string literal is NOT a call', isCall(LIT), false);
  t("R9: '' inside a literal does not end it early", isCall(`select 'it''s foo_bar (x)';`), false);
  t('R9: a literal does not swallow the code after it', isCall(`select 'a'; perform foo_bar(1);`), true);
  t('R9: format() argument is not a call', isCall(LITQ), false);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (SELFTEST) selftest();
else main();
