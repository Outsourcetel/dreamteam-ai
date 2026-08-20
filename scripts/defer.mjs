#!/usr/bin/env node
// ============================================================================
// defer.mjs — record a deferred item in ONE command.
//
//   npm run defer -- --what "…" --where "…" --sev correctness --why walked-past \
//                    --sql "select count(*)::int as n from … " --open-if ">=1"
//
//   npm run defer -- --list                    # what is open, by severity
//   npm run defer -- --close A-5 --by "mig 730"
//
// ── WHY A SCRIPT, AND NOT A DOCUMENTED ONE-LINER ────────────────────────────
//
// docs/53's finding was not that people are careless. It was that **documents
// were the path of least resistance**: a paragraph in a doc costs one sentence,
// a register entry costs a schema. Whatever is cheapest is what gets used, so
// the register has to be cheaper than the paragraph or it will lose the same
// way docs/50's FIX BACKLOG beat docs/51's ranked list — nothing distinguished
// them except where the session ended.
//
// "Documented one-liner" (i.e. hand-edit the JSON) was the tempting option and
// it is the wrong one, for a reason this repo has already paid for: a
// hand-edited register drifts in shape — a duplicate id, a missing
// `first_named`, a severity nobody else uses — and a register whose counts
// cannot be trusted is a register people stop reading. Worse, hand-editing
// lets you record a state NOBODY CHECKED, which would mean the anti-staleness
// mechanism could be seeded stale on day one. Self-refuting.
//
// So this script does three things a one-liner cannot:
//
//   1. It mints the next id and writes a CONFORMING entry — the author writes
//      prose, not JSON, which is the ergonomic the documents were winning on.
//   2. It runs `validateRegister` — THE SAME validator certify runs — before
//      writing. A malformed entry never lands.
//   3. ⚠ IT DRY-RUNS THE VERIFICATION AND REFUSES A STATE THE VERIFICATION
//      CONTRADICTS. Say `--state open` on something already fixed and it stops
//      and tells you so. This is the honesty requirement applied to
//      AUTHORSHIP, not just to the gate: the register cannot be seeded with a
//      claim that was false at the moment it was written.
//
// An item with no possible verification is still recordable — `--unverifiable
// "<why>" --claim <file>#<anchor>` — but it costs more typing than a checkable
// one, and it consumes the register's unverifiable ceiling. That asymmetry is
// deliberate: the cheap path should be the honest one.
// ============================================================================
import { readFileSync, writeFileSync } from 'node:fs';
import {
  REGISTER_FILE, SEVERITIES, WHY_SKIPPED, SUBJECTS, SUBJECT_METHODS, SUBJECT_WHY,
  DEPLOYED_PROBES, loadRegister, validateRegister, subjectMethodFailures, runGrep,
} from './deferred-register.mjs';
import {
  readToken as edgeToken, countDriftedFromMain, countFloatingDeployedImports, countInDeployedBundle,
} from './edge-deployed-parity.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1] ?? true);
};
const has = (name) => argv.includes(`--${name}`);

const PROD_REF = 'rfsvmhcqeiyrxivbmpel';
const DEV_REF = 'nmuntxrcdksyhsdywpan';
function token() {
  const fromEnv = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const env = readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  return line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
}
const mk = (ref) => async (sql) => {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`Management API ${res.status}: ${t.slice(0, 200)}`);
  return JSON.parse(t);
};

const USAGE = `
  npm run defer -- --list
  npm run defer -- --close <id> --by "<commit or migration that closed it>"
  npm run defer -- --what "<one sentence>" --where "<file:line or db object>" \\
                   --sev <${SEVERITIES.join('|')}> --why <${WHY_SKIPPED.join('|')}> \\
                   --subject <${SUBJECTS.join('|')}> \\
                   [--id <ID>] [--source "<where it was first named>"] \\
                   ( --sql "<select …::int as n>" --open-if "<op><number>"
                   | --grep "<regex>" --paths "<a,b>" [--tree origin/main] --open-if "<op><number>"
                   | --deployed-edge <${DEPLOYED_PROBES.join('|')}> [--slug <fn> --grep "<regex>"] --open-if "<op><number>"
                   | --unverifiable "<why no check is possible>" --claim "<file>#<anchor text>" )

  --open-if takes >=1, >0, ==0, <=3 … "open when n <op> value". Inverted polarity
  (open while a count is ZERO) is normal and supported: ==0.

  ⚠ --subject is what the item is a CLAIM ABOUT; the verification flag is HOW it
  is checked. They are different things and this tool will not let you pair them
  wrongly (F8). The pairs that can answer each other:
${SUBJECTS.map((s) => `      ${s.padEnd(14)} → ${SUBJECT_METHODS[s].join(', ').padEnd(15)} (${SUBJECT_WHY[s]})`).join('\n')}

  This exists because D-12 — "the edge functions carry unpinned remote imports" —
  was recorded CLOSED off a grep of the working tree while 60 of 64 DEPLOYED
  bundles still ran the unpinned build. The grep was right; it was right about
  the wrong subject. Deploying is a MANUAL step, so "repo-source" is never the
  subject of a claim about a running edge function.
`;

function parseOpenIf(s) {
  const m = /^(>=|<=|==|>|<)\s*(-?\d+)$/.exec(String(s ?? '').trim());
  if (!m) throw new Error(`--open-if must look like ">=1" or "==0", got ${JSON.stringify(s)}`);
  return { op: m[1], n: Number(m[2]) };
}

function nextId(reg, sev) {
  // Ids are letter-blocks so a human can refer to one out loud. New items get
  // the next free number in the block their severity maps to, which keeps the
  // seeded ids (A-*, B-*, …) meaningful instead of renumbering history.
  const block = { security: 'A', correctness: 'B', measurement: 'C', hygiene: 'D' }[sev] ?? 'X';
  const used = reg.items.map((i) => i.id).filter((i) => i.startsWith(`${block}-`))
    .map((i) => Number(i.slice(2))).filter(Number.isFinite);
  return `${block}-${(used.length ? Math.max(...used) : 0) + 1}`;
}

const reg = loadRegister();

// ── --list ────────────────────────────────────────────────────────────────
if (has('list')) {
  const open = reg.items.filter((i) => i.state === 'open');
  console.log(`${reg.items.length} item(s); ${open.length} open, ${reg.items.length - open.length} closed. Verification is re-run by certify, not here — this is the register as WRITTEN.`);
  for (const sev of SEVERITIES) {
    const rows = open.filter((i) => i.severity === sev);
    if (!rows.length) continue;
    console.log(`\n  ${sev} (${rows.length})`);
    for (const r of rows) console.log(`    ${r.id.padEnd(5)} [${r.why_skipped}] ${r.what.slice(0, 96)}${r.what.length > 96 ? '…' : ''}${r.verification.kind === 'none' ? '  ⏸ carried on claim' : ''}`);
  }
  process.exit(0);
}

// ── --close ───────────────────────────────────────────────────────────────
if (has('close')) {
  const id = flag('close');
  const by = flag('by');
  const it = reg.items.find((x) => x.id === id);
  if (!it) { console.error(`no item ${id}`); process.exit(1); }
  if (!by) { console.error('--close needs --by "<the commit or migration that closed it>". Closing an item is a claim, and this register exists because uncited claims go stale.'); process.exit(1); }
  it.state = 'closed'; it.closed_by = by; it.closed_on = new Date().toISOString().slice(0, 10);
  const bad = validateRegister(reg);
  if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
  writeFileSync(REGISTER_FILE, JSON.stringify(reg, null, 2) + '\n');
  console.log(`${id} closed, credited to ${by}.`);
  console.log('⚠ certify will now re-verify it. If the defect is still there, the run goes RED with F2 — which is the point.');
  process.exit(0);
}

// ── add ───────────────────────────────────────────────────────────────────
const what = flag('what'), where = flag('where'), sev = flag('sev'), why = flag('why');
const subject = flag('subject');
if (!what || !where || !sev || !why) { console.log(USAGE); process.exit(1); }
if (!SEVERITIES.includes(sev)) { console.error(`--sev must be one of ${SEVERITIES.join(', ')}`); process.exit(1); }
if (!WHY_SKIPPED.includes(why)) { console.error(`--why must be one of ${WHY_SKIPPED.join(', ')}`); process.exit(1); }
// ⚠ NOT DEFAULTED FROM THE METHOD, deliberately. Deriving the subject from the
// kind would rubber-stamp whatever check the author happened to reach for,
// which is precisely how D-12 came to be a production claim answered by a repo
// grep. The person has to say what the claim is about.
if (!SUBJECTS.includes(subject)) {
  console.error(`--subject must be one of ${SUBJECTS.join(', ')} — it says what the item is a CLAIM ABOUT, which is not the same as how you check it.`);
  console.error(SUBJECTS.map((s) => `    ${s.padEnd(14)} ${SUBJECT_WHY[s]}`).join('\n'));
  process.exit(1);
}

let verification;
if (has('unverifiable')) {
  const claim = String(flag('claim') ?? '');
  const hash = claim.indexOf('#');
  if (hash < 1) { console.error('--unverifiable needs --claim "<file>#<anchor text that must still appear in it>"'); process.exit(1); }
  verification = {
    kind: 'none',
    why_unverifiable: flag('unverifiable'),
    claim: { file: claim.slice(0, hash), anchor: claim.slice(hash + 1) },
  };
} else if (has('sql')) {
  verification = { kind: 'sql', sql: flag('sql'), open_if: parseOpenIf(flag('open-if')) };
} else if (has('grep')) {
  verification = {
    kind: 'grep', paths: String(flag('paths') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    pattern: flag('grep'), count: flag('count', 'matches'), open_if: parseOpenIf(flag('open-if')),
  };
  if (!verification.paths.length) { console.error('--grep needs --paths "src,supabase/functions"'); process.exit(1); }
  if (has('tree')) verification.tree = flag('tree');
} else if (has('deployed-edge')) {
  const probe = flag('deployed-edge');
  if (!DEPLOYED_PROBES.includes(probe)) { console.error(`--deployed-edge must be one of ${DEPLOYED_PROBES.join(', ')}`); process.exit(1); }
  verification = { kind: 'deployed-edge', probe, tree: flag('tree', 'origin/main'), open_if: parseOpenIf(flag('open-if')) };
  if (probe === 'content') {
    verification.slug = flag('slug');
    verification.pattern = flag('grep');
    if (flag('files')) verification.files = String(flag('files')).split(',').map((s) => s.trim()).filter(Boolean);
    if (!verification.slug || !verification.pattern) { console.error('--deployed-edge content needs --slug <function> and --grep "<regex>"'); process.exit(1); }
  }
} else {
  console.error('An item needs a way to check it: --sql, --grep, --deployed-edge, or an explicit --unverifiable with a --claim.\n'
    + 'That is the whole point of the register — an item nobody can check is the shape docs/53 found 18 of, and it costs the register\'s unverifiable ceiling.');
  process.exit(1);
}

const item = {
  id: flag('id') ?? nextId(reg, sev),
  what, where, severity: sev, why_skipped: why,
  first_named: {
    date: new Date().toISOString().slice(0, 10),
    source: flag('source') ?? 'recorded by npm run defer',
  },
  subject,
  state: flag('state', 'open'),
  verification,
};
if (reg.items.some((i) => i.id === item.id)) { console.error(`id ${item.id} is taken`); process.exit(1); }

// ── F8 at WRITE time, before a single query runs ──────────────────────────
// The same matrix certify enforces on every run. Checked here first because a
// mismatched pair's number is not evidence either way, and dry-running it would
// print a confident n= that means nothing.
{
  const bad = subjectMethodFailures({ items: [item] });
  if (bad.length) {
    console.error(`REFUSED — ${bad.join('\n')}`);
    process.exit(1);
  }
}

// ── The dry run. This is the part a hand-edit cannot do. ──────────────────
if (verification.kind !== 'none') {
  let n;
  try {
    if (verification.kind === 'sql') {
      const rows = await mk(PROD_REF)(verification.sql);
      if (!Array.isArray(rows) || rows.length !== 1 || Object.keys(rows[0]).length !== 1) {
        throw new Error(`the query must return exactly one row with one column (alias it \`n\`); it returned ${JSON.stringify(rows).slice(0, 160)}`);
      }
      n = Number(Object.values(rows[0])[0]);
    } else if (verification.kind === 'deployed-edge') {
      const tok = edgeToken();
      const tree = verification.tree ?? 'origin/main';
      if (verification.probe === 'drift-from-main') n = (await countDriftedFromMain({ token: tok, tree })).n;
      else if (verification.probe === 'unpinned-imports') n = (await countFloatingDeployedImports({ token: tok, tree })).n;
      else n = await countInDeployedBundle({ token: tok, slug: verification.slug, pattern: verification.pattern, files: verification.files ?? null, tree });
    } else {
      n = runGrep(verification);
    }
  } catch (e) {
    console.error(`the verification does not run: ${String(e.message ?? e).slice(0, 300)}`);
    console.error('NOT RECORDED. A verification that cannot run would land in the register as an F3 failure on the next certify run.');
    process.exit(1);
  }
  const OPS = { '>=': (a, b) => a >= b, '>': (a, b) => a > b, '==': (a, b) => a === b, '<=': (a, b) => a <= b, '<': (a, b) => a < b };
  const isOpen = OPS[verification.open_if.op](n, verification.open_if.n);
  console.log(`  dry run: the verification returned n=${n}; open_if ${verification.open_if.op} ${verification.open_if.n} ⇒ ${isOpen ? 'OPEN' : 'CLOSED'}`);
  if (isOpen !== (item.state === 'open')) {
    console.error(`\nREFUSED: you asked to record ${item.id} as "${item.state}", but its own verification says ${isOpen ? 'OPEN' : 'CLOSED'} right now.`);
    console.error('Seeding a state nobody checked into the mechanism that exists to stop unchecked states is self-refuting, so this is a hard stop.');
    console.error(isOpen
      ? 'Either record it open, or fix the verification if it is measuring the wrong thing.'
      : 'If it is genuinely already closed, add --state closed --by "<what closed it>".');
    process.exit(1);
  }
}
if (item.state === 'closed') {
  item.closed_by = flag('by') ?? null;
  item.closed_on = new Date().toISOString().slice(0, 10);
  if (!item.closed_by) { console.error('--state closed needs --by "<what closed it>"'); process.exit(1); }
}

reg.items.push(item);
const bad = validateRegister(reg);
if (bad.length) { console.error('REFUSED — the entry does not conform:\n  ' + bad.join('\n  ')); process.exit(1); }
if (verification.kind === 'none') {
  const unver = reg.items.filter((i) => i.verification.kind === 'none').length;
  if (unver > reg.unverifiable_ceiling) {
    console.error(`REFUSED — this would take the register to ${unver} unverifiable item(s) against a ceiling of ${reg.unverifiable_ceiling}.`);
    console.error('Raise `unverifiable_ceiling` in the register IN THE SAME COMMIT if the exception is genuine, so a reviewer sees it as a decision someone typed.');
    process.exit(1);
  }
}
writeFileSync(REGISTER_FILE, JSON.stringify(reg, null, 2) + '\n');
console.log(`recorded ${item.id} in ${REGISTER_FILE}. certify re-verifies it from now on; commit the file.`);
