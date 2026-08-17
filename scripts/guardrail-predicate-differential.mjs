#!/usr/bin/env node
// guardrail-predicate-differential.mjs
// ===========================================================================
// THE ORACLE IS THE DATABASE, NOT A TRANSCRIPTION OF IT.
//
// `guardrail_rules.pattern` is screened twice on the discovery accept path, in
// two languages, and the ordering makes the two copies ASYMMETRIC:
//
//     acceptGuardrailProposal (src/lib/discoveryApi.ts)
//        1. the TS gate runs               (guardrailAcceptability)
//        2. addGuardrailRule INSERTS       <- a live, blocking, workspace-wide rule
//        3. decide_discovery_proposal      (migration 751's SQL copy) stamps it
//
//   SQL LOOSER than TS   -> the client refused first and created nothing. Safe.
//   SQL STRICTER than TS -> the rule is ALREADY live and blocking; the stamp
//                           refuses; the proposal reverts to pending; the
//                           client's reuse-find re-finds that same rule on every
//                           retry and re-refuses forever. The customer was told
//                           "The rule was created and is switched on now" at the
//                           click and sees only last_error after a reload.
//
// So there is ONE invariant, and it has a direction:
//
//     THERE MUST BE NO PATTERN WHERE TS ACCEPTS AND THE SQL REFUSES.
//
// ⚠⚠ WHY THIS IS A SCRIPT AND NOT A VITEST CASE, WHICH IS THE WHOLE POINT.
// tests/discovery-proposal-batching.test.ts used to assert exactly that
// invariant — against a JAVASCRIPT RE-IMPLEMENTATION of the SQL predicate whose
// parameters it read out of the migration text. That is exam-vs-production
// evidence: a transcription can only ever prove it agrees with itself, and it
// agreed with itself while the real database disagreed. Run against LIVE
// POSTGRES with the predicate text extracted from the migration, the same
// battery reported TEN unsafe patterns the JS oracle called clean, because five
// code points are `\s` to Postgres and are NOT `\s` to JavaScript:
//
//     U+001C U+001D U+001E U+001F   (the C0 file/group/record/unit separators)
//     U+0085                        (NEL)
//
// and neither JS `.trim()` nor the migration's explicit btrim set strips any of
// them. `a<US>b<US>c<US>d<US>e<US>f` is ONE word to looksLikeEnforceablePattern
// and SIX to `array_length(regexp_split_to_array(v_pattern,'\s+'),1) <= 5`. A
// leading U+0085 also yields an empty leading element, so five JS tokens become
// six in Postgres.
//
// This file therefore does two things a unit test cannot:
//   * it evaluates the SQL EXPRESSIONS THEMSELVES — lifted verbatim out of
//     supabase/migrations/751_a_hard_line_the_customer_wrote.sql, not retyped —
//     inside the real database, with the real ctype and the real regex engine;
//   * it evaluates the REAL TypeScript gate, imported from
//     src/lib/discoveryProposalPresentation.ts through esbuild, not restated.
//
// Neither side is a copy. The comparison is between the two things that ship.
//
//   node scripts/guardrail-predicate-differential.mjs
//   node scripts/guardrail-predicate-differential.mjs --json
//
// RUN BY: scripts/certify.mjs, section `guardrail-pattern-differential`.
// Exits non-zero on any unsafe pattern, and ALSO on a battery that lost its
// teeth — zero acceptances, zero refusals, zero disagreements or too few
// comparisons all fail, because zero findings from zero comparisons looks
// exactly like a clean result.
// ===========================================================================

import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MIGRATION_751 = 'supabase/migrations/751_a_hard_line_the_customer_wrote.sql';
export const PRESENTATION_TS = 'src/lib/discoveryProposalPresentation.ts';
const PROD_REF = 'rfsvmhcqeiyrxivbmpel';

// ── the five code points that started this ─────────────────────────────────
// Exported so the vitest drift guard can name them without re-deriving them,
// and so the battery below and the client screen cannot describe different
// sets. Verified against live Postgres, not assumed:
//   select array_length(regexp_split_to_array('a'||chr(28)||'b','\s+'),1) -> 2
// while JS /\s/.test('\u001c') is false.
export const PG_ONLY_WHITESPACE = ['\u001c', '\u001d', '\u001e', '\u001f', '\u0085'];

// ── THE BATTERY ────────────────────────────────────────────────────────────
// Exported and imported by tests/discovery-proposal-batching.test.ts, so the
// structural drift guard there and this differential compare the same corpus.
// Two batteries would be two answers to one question.
export const BATTERY = (() => {
  const out = [
    // ordinary accepts
    'refund|chargeback', 'free month', 'late fee|penalty', 'price match|beat any quote',
    'refund', 'a', 'no refunds ever here', 'one two three four five',
    // word-count boundary
    'one two three four five six',
    // empty alternatives
    'refund|', '|refund', 'refund||chargeback', '||', '|',
    // sentence punctuation
    'refund.', 'refund!', 'refund?', 'refund .',
    // empty / whitespace-only
    '', ' ', '\t', '\u00a0', '\ufeff',
    // padded, to exercise the trim on both sides
    '  refund|chargeback  ', '\trefund|chargeback\n', '\u3000refund\u2003',
    // the two disagreements that are SAFE (TS stricter), kept as controls
    '\u{1d51e}'.repeat(61),      // 122 UTF-16 units, 61 code points
    'éanything',                 // JS \b fires between é and a; Postgres \y does not
    '\u{1d51e}'.repeat(60), '\u{1d51e}'.repeat(121),
  ];
  for (const n of [118, 119, 120, 121, 122]) out.push('a'.repeat(n));
  for (const ch of ['\\', '^', '$', '.', '?', '*', '+', '(', ')', '{', '}', '[', ']']) {
    out.push(`refund${ch}x`, `${ch}refund`, `refund${ch}`);
  }
  for (const w of 'the and might could should would whatever anything something appropriate reasonable seems find please kindly customer customers'.split(' ')) {
    out.push(`refund ${w} now`, `${w}refund`, `refund-${w}`);
  }
  // ⚠ THE CLASS THE JS ORACLE COULD NOT SEE. Each of these is one word to
  // JavaScript and several to Postgres, or gains an empty leading element in
  // Postgres that JS's .filter(Boolean) drops. Every one of them was TS-accepted
  // and SQL-refused before the client screen was widened — i.e. every one of
  // them would have left a live workspace-wide blocking rule behind a proposal
  // that could never be stamped.
  for (const ch of PG_ONLY_WHITESPACE) {
    out.push(`a${ch}b${ch}c${ch}d${ch}e${ch}f`);   // 1 JS word, 6 Postgres words
    out.push(`${ch}refund`);                        // empty leading element in PG
    out.push(`refund${ch}`);                        // empty trailing element in PG
    out.push(`refund${ch}chargeback`);              // 1 JS word, 2 Postgres words
    out.push(`one two three four five${ch}six`);    // 5 JS words, 6 Postgres words
    out.push(`${ch}`);                              // trimmed to nothing by neither
  }
  return out;
})();

// ── extraction: the SQL that actually ships ────────────────────────────────
/**
 * The guardrail branch WITH LINE COMMENTS STRIPPED, from `when 'guardrail' then`
 * to the end of the branch. The migration's own header contains the literal
 * `when 'guardrail' then` inside a comment, and an extractor that found that one
 * would be reading prose.
 *
 * ⚠ THE END MARKER IS THE END OF THE BRANCH, not `if p_created_object_id is
 * null then`. The earlier extraction stopped there, which left the rule_type
 * refusal, the byte-for-byte pattern refusal, the pack refusal and the
 * five-condition blast-radius arm OUTSIDE everything that counted clauses — and
 * those are the refusals that run on a row the client has ALREADY INSERTED.
 */
export function guardrailBranch(sqlText) {
  const code = sqlText.split(/\r?\n/).map((l) => l.replace(/--.*$/, '')).join('\n');
  const s = code.indexOf("when 'guardrail' then");
  if (s === -1) return null;
  const e = code.indexOf('v_object_id := v_rule.id;', s);
  if (e === -1) return null;
  return code.slice(s, e + 'v_object_id := v_rule.id;'.length);
}

/**
 * The three expressions the accept actually screens with, lifted verbatim.
 *
 * ⚠ EVERY ANCHOR IS `(?<![A-Za-z0-9_])`-GUARDED where a prefixed identifier
 * could satisfy it. `length(v_pattern) <= 120` is a SUBSTRING of
 * `octet_length(v_pattern) <= 120`, and a bare `.toContain` / bare regex was
 * measured to accept the swap: 'é'.repeat(100) is 100 UTF-16 units (TS accepts)
 * and 200 UTF-8 bytes (the drifted SQL refuses) — precisely the unsafe direction,
 * passing a green pin.
 *
 * ⚠ WHAT THE GUARD ACTUALLY DOES TO THAT MUTANT, SAID EXACTLY. With the swap in
 * place `maxLen` comes back NULL, so `runDifferential` throws at the
 * "predicate parameters not readable" arm below and this script exits non-zero
 * WITHOUT SENDING A QUERY. That is fail-closed and it is stronger than a
 * comparison — but it is a refusal to compare, not a comparison that found
 * drift, and the two are worth telling apart when reporting a red. Measured
 * 2026-08-17 against an in-memory copy of the migration; the file on disk was
 * not touched. Consequence to keep in view: `verdict()`'s `maxLen !== 120` arm
 * can only fire for a bound that is readable and different (200, say), never
 * for the unreadable one.
 */
export function extractPredicate(branch) {
  const trimSet = /btrim\(v_p\.payload ->> 'pattern', E'([^']+)'\)/.exec(branch)?.[1] ?? null;
  const okExpr = /v_pattern_ok\s*:=([\s\S]*?);/.exec(branch)?.[1]?.trim() ?? null;
  const screens = [...branch.matchAll(/if v_pattern ~ '((?:[^']|'')+)' then/g)].map((m) => m[1]);
  const maxLen = /(?<![A-Za-z0-9_])length\(v_pattern\) <= (\d+)/.exec(branch)?.[1] ?? null;
  const maxWords = /(?<![A-Za-z0-9_])array_length\(regexp_split_to_array\(v_pattern, '\\s\+'\), 1\), 0\) <= (\d+)/.exec(branch)?.[1] ?? null;
  return { trimSet, okExpr, screens, maxLen: maxLen && Number(maxLen), maxWords: maxWords && Number(maxWords) };
}

// ── the SQL side: evaluated BY POSTGRES ────────────────────────────────────
/** JSON with every non-ASCII and control code point escaped, so the request
 *  body is pure ASCII and no transport can reinterpret a separator character
 *  on the way. The whole finding is about characters HTTP and JSON are entitled
 *  to normalise; sending them raw would be testing the pipe. */
function asciiJson(values) {
  return JSON.stringify(values).replace(/[\u007f-\uffff]/g, (c) =>
    `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function differentialSql(pred, values) {
  if (!pred.trimSet || !pred.okExpr || pred.screens.length !== 2) {
    throw new Error('predicate extraction incomplete — refusing to build a query that would pass by accident');
  }
  // The extracted text is spliced in VERBATIM. `v_pattern` is a column here, so
  // the plpgsql expression evaluates unchanged, with Postgres's own regex engine
  // and the database's own ctype — which is the entire point of this file.
  return `
with raw(s, i) as (
  select value, ordinality
    from jsonb_array_elements_text($jb$${asciiJson(values)}$jb$::jsonb) with ordinality as t(value, ordinality)
),
trimmed as (
  select i, s, nullif(btrim(s, E'${pred.trimSet}'), '') as v_pattern from raw
)
select i,
       coalesce((${pred.okExpr}), false)
         and not coalesce(v_pattern ~ '${pred.screens[0]}', false)
         and not coalesce(v_pattern ~ '${pred.screens[1]}', false) as sql_accepts
  from trimmed
 order by i`;
}

function token() {
  const fromEnv = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const env = readFileSync('.env.local', 'utf8').replace(/^\ufeff/, '');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  if (!line) throw new Error('SUPABASE_ACCESS_TOKEN not found in .env.local');
  return line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
}

async function runSql(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROD_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  // ⚠ NO SKIP ARM. A differential that cannot reach the database has proven
  // nothing, and "could not check" must never read as "clean".
  if (!res.ok) throw new Error(`Management API ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// ── the TS side: the REAL gate, not a restatement ──────────────────────────
/** Loads src/lib/discoveryProposalPresentation.ts itself. The module is pure —
 *  no imports, no I/O, which is what makes this possible — so an esbuild
 *  transform is enough and there is no bundle graph to drift. */
export async function loadTsGate() {
  const esbuild = await import('esbuild');
  const src = readFileSync(PRESENTATION_TS, 'utf8');
  const js = (await esbuild.transform(src, { loader: 'ts', format: 'esm' })).code;
  // ⚠ esbuild keeps a child process alive; without this the run ends in a libuv
  // assertion on Windows AFTER the verdict has been printed, which reads like a
  // crash in the check rather than a clean red/green.
  await esbuild.stop?.();
  const dir = mkdtempSync(join(tmpdir(), 'guardrail-diff-'));
  const file = join(dir, 'presentation.mjs');
  writeFileSync(file, js, 'utf8');
  const mod = await import(pathToFileURL(file).href);
  return (pattern) => mod.guardrailAcceptability({ rule: 'x', pattern, threshold: null }).ok;
}

export async function runDifferential() {
  const branch = guardrailBranch(readFileSync(MIGRATION_751, 'utf8'));
  if (!branch) throw new Error(`could not isolate the guardrail branch in ${MIGRATION_751}`);
  const pred = extractPredicate(branch);
  const missing = Object.entries(pred)
    .filter(([, v]) => v === null || (Array.isArray(v) && v.length !== 2))
    .map(([k]) => k);
  if (missing.length) throw new Error(`predicate parameters not readable from the migration: ${missing.join(', ')} — a half-built comparison accepts everything`);

  const tsAccepts = await loadTsGate();
  const rows = await runSql(differentialSql(pred, BATTERY));
  if (rows.length !== BATTERY.length) {
    throw new Error(`the database answered about ${rows.length} patterns, not ${BATTERY.length}`);
  }
  const sqlAccepts = new Map(rows.map((r) => [Number(r.i) - 1, r.sql_accepts === true]));

  const ts = BATTERY.map(tsAccepts);
  const sql = BATTERY.map((_, i) => sqlAccepts.get(i) === true);
  const unsafe = BATTERY.filter((_, i) => ts[i] && !sql[i]);
  const safeDisagreements = BATTERY.filter((_, i) => !ts[i] && sql[i]);

  return {
    compared: BATTERY.length,
    tsAccepted: ts.filter(Boolean).length,
    sqlAccepted: sql.filter(Boolean).length,
    disagreements: unsafe.length + safeDisagreements.length,
    unsafe,
    safeDisagreements,
    maxLen: pred.maxLen,
    maxWords: pred.maxWords,
  };
}

/** The verdict, with its own vacuity arms. Shared with certify so the section
 *  and a hand run cannot disagree about what green means. */
export function verdict(r) {
  const problems = [];
  if (r.compared < 150) problems.push(`the battery shrank to ${r.compared} comparisons, below the 150 this was measured over`);
  if (r.tsAccepted < 4) problems.push(`only ${r.tsAccepted} patterns are accepted by the client, so "TS accepts and SQL refuses" is close to vacuous`);
  if (r.sqlAccepted < 4) problems.push(`only ${r.sqlAccepted} patterns are accepted by the database`);
  if (r.compared - r.tsAccepted < 50) problems.push(`only ${r.compared - r.tsAccepted} patterns are refused by the client, so the battery is not exercising the refusals`);
  if (r.disagreements === 0) problems.push('the two copies never disagree anywhere in the battery, so this comparison cannot demonstrate it would notice one');
  if (r.maxLen !== 120 || r.maxWords !== 5) problems.push(`the shared bounds read out of the migration are length=${r.maxLen}, words=${r.maxWords} — expected 120 and 5`);
  if (r.unsafe.length) {
    problems.push(`${r.unsafe.length} pattern(s) where THE CLIENT ACCEPTS AND THE DATABASE REFUSES — each one inserts a live, blocking, workspace-wide rule the stamp then rejects forever: ${JSON.stringify(r.unsafe.slice(0, 10))}`);
  }
  return { ok: problems.length === 0, problems };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const r = await runDifferential();
  const v = verdict(r);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ...r, ok: v.ok, problems: v.problems }, null, 2));
  } else {
    console.log(`compared ${r.compared} patterns against LIVE POSTGRES`);
    console.log(`  client accepts ${r.tsAccepted} · database accepts ${r.sqlAccepted} · disagreements ${r.disagreements}`);
    console.log(`  UNSAFE (client accepts, database refuses): ${r.unsafe.length}`);
    for (const p of r.unsafe) console.log(`    ✗ ${JSON.stringify(p)}`);
    console.log(`  safe disagreements (client stricter): ${r.safeDisagreements.length}`);
    for (const p of v.problems) console.log(`  ✗ ${p}`);
    console.log(v.ok ? 'OK — the client is at least as strict as the database everywhere in the battery.' : 'FAILED');
  }
  process.exitCode = v.ok ? 0 : 1;
}
