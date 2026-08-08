#!/usr/bin/env node
// audit-silent-refusals.mjs — does the UI believe a refusal that arrives as DATA?
//
//   node scripts/audit-silent-refusals.mjs            # report
//   node scripts/audit-silent-refusals.mjs --strict   # exit 1 on any finding
//
// ⚠⚠ A RESOLVED PROMISE IS NOT A COMPLETED ACTION.
//
// An earlier sweep fixed 214 call sites that ignored supabase's ERROR channel
// — `.rpc()` resolves on a Postgres error, so `await` alone proved nothing.
// This is the other half of the same lie, and nothing had ever looked for it:
// a SECURITY DEFINER function that returns its refusal in the PAYLOAD.
//
//     return jsonb_build_object('ok', false, 'error', 'not_pending');
//
// That is a 200. The promise resolves, no exception is thrown, and a caller
// that does not read `.ok` sails straight on to its success message.
//
// It cost a real one on 2026-08-08: the knowledge gaps page ran
// `await resolveKnowledgeRevision(...)` and then said "Article published —
// the knowledge base was updated immediately", unconditionally. Calling
// apply_knowledge_revision on an already-decided request returns
// {ok:false, error:'not_pending'} and writes nothing, so that message was a
// claim about a knowledge fix that had not happened. The same function was
// discarded in the human-task approval hook, where the task closes either way.
//
// ⚠ PRECISION IS THE WHOLE POINT. Flagging every caller that ignores an `ok`
// would bury the real ones: plenty of these functions never refuse — they
// succeed or they RAISE, and a raise is an exception the caller's catch
// already handles. So this reads the FUNCTION BODIES out of the live database
// and only judges callers of functions that genuinely have an `'ok', false`
// path. A noisy checker gets ignored, which is how this class survived.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const PROJECT_REF = 'rfsvmhcqeiyrxivbmpel';
const ENDPOINT = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
const STRICT = process.argv.includes('--strict');
const ROOT = process.cwd();

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
  if (!res.ok) throw new Error(`db: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

// ── the repo, with comments blanked ──────────────────────────────────────
// ⚠ COMMENTS ARE NOT CODE. The first version of this reported the very
// comment I had written explaining the bug I had just fixed. A checker that
// reads its own documentation as a defect keeps re-finding finished work.
// Blanked rather than removed so reported line numbers stay true.
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/^([^\n"'`]*?)\/\/.*$/gm, (_, keep) => keep);
const FILES = {};
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
    else if (/\.(ts|tsx)$/.test(e.name)) {
      FILES[path.relative(ROOT, p).split(path.sep).join('/')] = strip(readFileSync(p, 'utf8'));
    }
  }
})(path.join(ROOT, 'src'));

// ── 1. which DB functions actually REFUSE in the payload? ────────────────
const rows = await sql(`
  select p.proname
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f'
    and pg_get_functiondef(p.oid) like '%''ok'', false%'
  order by p.proname`);
const refusing = new Set(rows.map((r) => r.proname));
if (refusing.size < 20) {
  console.error(`ABORT: only ${refusing.size} refusing functions found — the query is wrong.`);
  process.exit(2);
}
// ⚠ Pinned: the function today's bug lived in. If this stops being seen as a
// refuser, every clean result below is meaningless.
if (!refusing.has('apply_knowledge_revision')) {
  console.error('ABORT: apply_knowledge_revision is not recognised as refusing — the reader is broken.');
  process.exit(2);
}

// ── 2. lib wrappers over those functions, and WHAT THEY DO WITH THE FLAG ──
// ⚠⚠ THE WRAPPER IS THE FIRST PLACE THE REFUSAL CAN DIE — OR BE SAVED.
// v1 of this judged call sites alone and reported five defects. All five were
// wrong: every one of those wrappers already does `if (!r?.ok) throw`, which
// moves the refusal onto the ERROR channel where the call site's catch block
// was handling it all along. Reporting a caller for "ignoring" a flag that
// never reaches it is how a checker manufactures work and loses its audience.
//
// So classify the wrapper first — the caller can only be judged against what
// actually arrives:
//   converts — `if (!ok) throw`: the caller needs a catch, not an ok check.
//   reads    — consumes the flag itself (counts it, branches on it).
//   passes   — hands the ok back: NOW the caller must read it.
//   swallows — never looks at ok at all, and returns void.
//              ⚠ the worst shape: every caller is blind through no fault of
//              its own, and no call-site check could ever find it.
const wrappers = new Map();
for (const [f, s] of Object.entries(FILES)) {
  if (!f.startsWith('src/lib/')) continue;
  const re = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const after = s.slice(m.index + m[0].length);
    const end = after.search(/\nexport\s+(?:async\s+)?(?:function|const)\s/);
    const body = end < 0 ? after : after.slice(0, end);
    const hits = [...body.matchAll(/\.rpc\(\s*['"]([a-z0-9_]+)['"]/g)]
      .map((x) => x[1]).filter((n) => refusing.has(n));
    if (!hits.length) continue;
    const sig = body.slice(0, body.indexOf('{') + 1);
    const negThrow = /!\s*[A-Za-z0-9_]*\??\.?\s*ok\b[\s\S]{0,140}?\bthrow\b/.test(body)
      || /\bok\s*===\s*false[\s\S]{0,140}?\bthrow\b/.test(body);
    const touchesOk = /[.?]ok\b|\bok\s*[=!]==|\{\s*ok\s*[,}:]/.test(body);
    const kind = /Promise<[^>]*\bok\s*[?:]/.test(sig) ? 'passes'
      : negThrow ? 'converts'
      : touchesOk ? 'reads'
      : 'swallows';
    wrappers.set(m[1], { rpcs: [...new Set(hits)], kind, file: f });
  }
}
const byKind = (k) => [...wrappers].filter(([, w]) => w.kind === k);

// ⚠ NAME WHAT YOU SKIP. A checker that quietly drops a case it decided was
// fine is indistinguishable from one that never looked — so allowances live
// here, carry their reasoning, and are PRINTED on every run. Adding a line
// here is a claim someone can come back and check.
const ALLOWED = {
  widgetIdentityConfigured:
    'a read, not a write: the refusals (widget_key_not_found / not_permitted) leave `configured` undefined, which the wrapper coerces to false — so a refused caller is shown the setup prompt, never told it is configured. Fail-safe by construction.',
};

// ⚠ Pinned both ways. A rule that only ever confirms is not a test: if
// `converts` stops being recognised the false positives come straight back,
// and if nothing lands in `passes` the call-site pass below is comparing air.
if (wrappers.get('setConnectorSchedule')?.kind !== 'converts') {
  console.error('ABORT: setConnectorSchedule does `if (!r?.ok) throw` — classifying it otherwise means the wrapper reader is broken.');
  process.exit(2);
}

// ── 3. call sites that never read the flag ───────────────────────────────
// A success CLAIM after the call is what turns an ignored flag into a lie the
// user reads. Both tiers are reported; only the first is a defect on sight.
const CLAIM = /setToast|showToast|setNotice|setMsg\(|setSuccess|onDone\(|onApplied\(|onFinished\(/;
const findings = [];
let compared = 0;
const passing = byKind('passes');

// ⚠⚠ AN UNEXERCISED SCANNER REPORTS ZERO AND LOOKS LIKE GOOD NEWS.
// Every wrapper currently converts or consumes the flag, so `passing` is
// empty and the loop below does not run at all — its "0 findings" would be
// worth precisely nothing, and would stay worth nothing on the day someone
// adds a wrapper that does hand the flag on. So run the identical scan over
// the `converts` wrappers purely as a liveness proof: those definitely have
// call sites, and if the machinery cannot find THEM it is broken.
const findSites = (names) => {
  let n = 0;
  for (const [f, s] of Object.entries(FILES)) {
    if (f.startsWith('src/lib/')) continue;
    for (const [fn] of names) {
      const re = new RegExp(`(?:^|[^.\\w])${fn}\\s*\\(`, 'g');
      while (re.exec(s) !== null) n++;
    }
  }
  return n;
};
const liveness = findSites(byKind('converts'));
if (liveness < 10) {
  console.error(`ABORT: the call-site scanner found only ${liveness} sites for ${byKind('converts').length} known-called wrappers — it is not matching, so any clean result it produces is meaningless.`);
  process.exit(2);
}

for (const [f, s] of Object.entries(FILES)) {
  if (f.startsWith('src/lib/')) continue;
  const lines = s.split('\n');
  for (const [fn, w] of passing) {          // ⚠ only wrappers that hand the flag on
    const re = new RegExp(`(?:^|[^.\\w])${fn}\\s*\\(`, 'g');
    let m;
    while ((m = re.exec(s)) !== null) {
      const i = s.slice(0, m.index).split('\n').length - 1;
      compared++;
      const win = lines.slice(i, i + 10).join('\n');
      // Reading the flag in any of its usual shapes counts.
      if (/\.ok\b|\bok\s*===|\bok\s*\?|\{\s*ok\s*[,}]|!res\b|!r\b|!rev\b/.test(win)) continue;
      findings.push({
        where: `${f}:${i + 1}`, fn, rpcs: w.rpcs.join(', '),
        claims: CLAIM.test(win), code: (lines[i] ?? '').trim().slice(0, 90),
      });
    }
  }
}

// ⚠ COUNT THE COMPARISONS, NOT JUST THE FINDINGS. "0 findings" from 0
// comparisons is indistinguishable from a clean sweep, and that is exactly
// how two earlier instruments in this repo failed.
const swallows = byKind('swallows').filter(([fn]) => !ALLOWED[fn]);
console.log(`functions that refuse in the payload: ${refusing.size}`);
console.log(`lib wrappers over them:               ${wrappers.size}`);
console.log(`   converts the refusal into a throw: ${byKind('converts').length}`);
console.log(`   consumes the flag itself:          ${byKind('reads').length}`);
console.log(`   hands the flag to the caller:      ${passing.length}`);
console.log(`   never reads the flag at all:       ${byKind('swallows').length}`);
console.log(`call sites compared:                  ${compared}   (scanner liveness: ${liveness} sites)`);
for (const [fn, why] of Object.entries(ALLOWED)) {
  if (!wrappers.has(fn)) {
    console.error(`ABORT: allowance for ${fn} no longer matches anything — delete the entry or fix the reader, do not leave a stale excuse in place.`);
    process.exit(2);
  }
  console.log(`\nallowed — ${fn}:\n   ${why}`);
}
if (byKind('converts').length < 5) {
  console.error('ABORT: almost nothing classified as `converts` — the wrapper reader is broken and the findings below are noise.');
  process.exit(2);
}

// ⚠ THE WRAPPER IS THE LOUDEST FINDING. When it drops the flag, no caller can
// recover it and no amount of care at the call site would have helped — so
// this outranks anything a caller did.
console.log(`\n⚠⚠ WRAPPER DROPS THE REFUSAL — every caller is blind (${swallows.length}):`);
for (const [fn, w] of swallows) console.log(`   ${(w.file + ' — ' + fn).padEnd(58)} → ${w.rpcs.join(', ')}`);
if (!swallows.length) console.log('   none');

const bad = findings.filter((x) => x.claims);
const quiet = findings.filter((x) => !x.claims);
console.log(`\n⚠ CALLER IGNORES THE REFUSAL AND CLAIMS SUCCESS (${bad.length}):`);
for (const x of bad) console.log(`   ${x.where}\n      ${x.fn} → ${x.rpcs}\n      ${x.code}`);
if (!bad.length) console.log('   none');
console.log(`\ncaller ignores the refusal, makes no claim (${quiet.length}):`);
for (const x of quiet) console.log(`   ${x.where.padEnd(56)} ${x.fn} → ${x.rpcs}`);
if (!quiet.length) console.log('   none');

if (STRICT && (bad.length || swallows.length)) process.exit(1);
