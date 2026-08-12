#!/usr/bin/env node
// ============================================================
// playbook-gate-parity.mjs — the anti-drift proof for mig 713's SQL twin.
//
// mig 713 puts a floor on playbook_versions INSERT/UPDATE so no path can
// publish a snapshot the runtime would refuse. That floor is a SECOND COPY
// of a contract whose authority lives in playbook-execute's validateSteps,
// and a second copy rots. This script is the ratchet that stops it.
//
// THE BOUNDED CONTRACT the floor claims (mig 713 header):
//   the floor decides EXACTLY what validateSteps decides from step KEYS
//   and their ORDER alone; everything params-dependent stays the edge
//   validator's sole authority.
//
// So parity is checked on the FLOOR'S CODE VOCABULARY only. For every
// fixture and every code C the floor can emit:
//        C ∈ edgeValidatorCodes   ⟺   C ∈ sqlFloorCodes
// Both directions, because the two failure modes are different diseases:
//   · floor stricter than the validator → legitimate publishes blocked
//   · floor looser  than the validator → the hole this migration closed
// params-only codes (bad_params, bad_rule, decision_forward_reference) are
// outside the floor's remit and are ignored by construction — named here so
// the exclusion is a decision, not an accident.
//
// Plus a VOCABULARY arm: the SQL primitive/post-gate arrays must be
// set-equal to PRIMITIVES / POST_GATE_ALLOWED in the edge source. Adding a
// primitive to the engine without adding it to SQL would make the floor
// refuse a legal publish; removing one without telling SQL reopens the gap.
//
// Every arm prints its DENOMINATOR. Zero mismatches from zero comparisons
// looks exactly like parity.
//
//   node scripts/playbook-gate-parity.mjs
//   node scripts/playbook-gate-parity.mjs --mutate=<case>   (self-test)
//
// --mutate drives the REAL comparison logic with one injected break and
// exits 0 only if the break was CAUGHT and NAMED. Cases:
//   sql-vocab-missing-key   sql-vocab-extra-key   floor-drops-last-step
//   floor-invents-a-refusal
// ============================================================
import { readFileSync } from 'node:fs';

const PROJECT_REF = 'rfsvmhcqeiyrxivbmpel';
const URL_BASE = `https://${PROJECT_REF}.supabase.co`;
const EDGE_SRC = 'supabase/functions/playbook-execute/index.ts';
// Review Lab — the designated test tenant. {action:'validate'} is read-only.
const TENANT = '6c30af2b-a63b-4751-9876-8ce488f729d5';

// The floor's own vocabulary (mig 713 playbook_snapshot_floor_errors). Codes
// outside this set belong to the edge validator alone and are not compared.
const FLOOR_CODES = [
  'empty', 'too_many_steps', 'bad_step', 'unknown_primitive', 'last_step',
  'multiple_complete', 'multiple_invoice', 'multiple_approval',
  'approval_without_invoice', 'post_gate_primitive',
];
const PARAMS_ONLY_CODES = ['bad_params', 'bad_rule', 'decision_forward_reference', 'sub_playbook_unpublished', 'sub_playbook_cycle'];

const MUTATE = (process.argv.find((a) => a.startsWith('--mutate=')) ?? '').split('=')[1] || null;

function env(key) {
  for (const f of ['.env.local', '.env']) {
    try {
      const raw = readFileSync(f, 'utf8').replace(/^﻿/, '');
      const line = raw.split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
      if (line) return line.slice(key.length + 1).replace(/^["']|["']$/g, '').trim();
    } catch { /* next file */ }
  }
  return null;
}
const MGMT = env('SUPABASE_ACCESS_TOKEN');
if (!MGMT) {
  console.error('playbook-gate-parity needs SUPABASE_ACCESS_TOKEN in .env.local (the token scripts/db-query.mjs uses).');
  console.error('Failing loudly rather than skipping — a parity check that silently does not run is theatre.');
  process.exit(2);
}

async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MGMT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`SQL HTTP ${r.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

let _secret = null;
async function dispatchSecret() {
  if (_secret) return _secret;
  const rows = await sql("select decrypted_secret as s from vault.decrypted_secrets where name = 'playbook_dispatch_secret'");
  _secret = rows[0]?.s;
  if (!_secret) throw new Error('playbook_dispatch_secret not found in vault');
  return _secret;
}

// ── the two implementations under comparison ──────────────────────────
async function edgeCodes(steps) {
  const secret = await dispatchSecret();
  const res = await fetch(`${URL_BASE}/functions/v1/playbook-execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dispatch-secret': secret },
    body: JSON.stringify({ action: 'validate', steps, tenant_id: TENANT }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`validate HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return new Set((body.errors ?? []).map((e) => e.code));
}

// One round trip for all fixtures — the floor is a pure function.
async function floorCodesBatch(fixtures) {
  const values = fixtures
    .map((f, i) => `(${i}, ${quote(JSON.stringify(f.steps))}::jsonb)`)
    .join(', ');
  const rows = await sql(`
    select v.i as i, coalesce(public.playbook_snapshot_floor_errors(v.s), array[]::text[]) as codes
      from (values ${values}) as v(i, s)
     order by v.i`);
  return rows.map((r) => new Set(
    Array.isArray(r.codes) ? r.codes : String(r.codes ?? '').replace(/^\{|\}$/g, '').split(',').filter(Boolean),
  ));
}
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ── vocabulary arm ────────────────────────────────────────────────────
function edgeArray(name) {
  const src = readFileSync(EDGE_SRC, 'utf8');
  if (name === 'PRIMITIVES') {
    const m = /const PRIMITIVES = \[([\s\S]*?)\] as const;/.exec(src);
    if (!m) throw new Error('could not find PRIMITIVES in ' + EDGE_SRC);
    return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  }
  // POST_GATE_ALLOWED = SQL_RESUMABLE ∪ its own literals
  const sqlR = /const SQL_RESUMABLE = new Set\(\[([\s\S]*?)\]\);/.exec(src);
  const post = /const POST_GATE_ALLOWED = new Set\(\[([\s\S]*?)\]\);/.exec(src);
  if (!sqlR || !post) throw new Error('could not find POST_GATE_ALLOWED in ' + EDGE_SRC);
  return [...new Set([
    ...[...sqlR[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]),
    ...[...post[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]),
  ])];
}

// ── fixture corpus ────────────────────────────────────────────────────
// Hand-written: one per floor code plus its clean twin, so every rule is
// compared in BOTH verdicts. Then a randomised sweep over the real
// vocabulary, which is what catches an ordering rule nobody thought to
// write a fixture for.
const S = (k, params) => (params ? { key: k, params } : { key: k });
const HANDWRITTEN = [
  { name: 'empty list', steps: [] },
  { name: 'valid minimal', steps: [S('instruction', { title: 't', body_md: 'b' }), S('complete')] },
  { name: 'no trailing complete', steps: [S('instruction', { title: 't', body_md: 'b' })] },
  { name: 'complete not last', steps: [S('complete'), S('instruction', { title: 't', body_md: 'b' })] },
  { name: 'unknown primitive', steps: [S('teleport_money'), S('complete')] },
  { name: 'retired consult_specialist', steps: [S('consult_specialist'), S('complete')] },
  { name: 'bad step (not an object)', steps: [42, S('complete')] },
  { name: 'bad step (key not a string)', steps: [{ key: 7 }, S('complete')] },
  { name: 'two completes', steps: [S('complete'), S('complete')] },
  { name: 'two invoices', steps: [S('generate_invoice', { amount_source: 'account_arr' }), S('generate_invoice', { amount_source: 'account_arr' }), S('complete')] },
  { name: 'two approvals', steps: [S('generate_invoice', { amount_source: 'account_arr' }), S('human_approval'), S('human_approval'), S('complete')] },
  { name: 'approval gating nothing', steps: [S('human_approval'), S('complete')] },
  { name: 'approval before its invoice', steps: [S('human_approval'), S('generate_invoice', { amount_source: 'account_arr' }), S('complete')] },
  { name: 'post-gate check_account', steps: [S('generate_invoice', { amount_source: 'account_arr' }), S('human_approval'), S('check_account'), S('complete')] },
  { name: 'post-gate allowed set is fine', steps: [S('generate_invoice', { amount_source: 'account_arr' }), S('human_approval'), S('log_activity', { text_template: 'x' }), S('complete')] },
  { name: '21 steps', steps: [...Array(20).fill(0).map(() => S('instruction', { title: 't', body_md: 'b' })), S('complete')] },
  { name: '20 steps exactly', steps: [...Array(19).fill(0).map(() => S('instruction', { title: 't', body_md: 'b' })), S('complete')] },
  { name: 'gap_gate mid-list', steps: [S('gap_gate', { gap_id: 'g' }), S('complete')] },
  { name: 'unknown primitive AND no complete', steps: [S('teleport_money'), S('instruction', { title: 't', body_md: 'b' })] },
];

function randomCorpus(vocab, n) {
  // deterministic PRNG — a parity failure must be reproducible
  let seed = 713;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const junk = ['teleport_money', 'hand_it_over', 'sop_notes', 'open_the_books'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const len = 1 + Math.floor(rnd() * 7);
    const steps = [];
    for (let j = 0; j < len; j++) {
      const pool = rnd() < 0.08 ? junk : vocab;
      steps.push(S(pool[Math.floor(rnd() * pool.length)]));
    }
    if (rnd() < 0.5) steps.push(S('complete'));
    out.push({ name: `random#${i}`, steps });
  }
  return out;
}

// ── run ───────────────────────────────────────────────────────────────
const fail = [];
const note = (s) => console.log(s);

async function main() {
  note('playbook-gate-parity — mig 713 SQL floor vs the DEPLOYED edge validator\n');

  // ARM 1 — vocabulary set-equality
  let sqlPrims = (await sql('select public.playbook_snapshot_primitives() as a'))[0].a;
  let sqlPost = (await sql('select public.playbook_snapshot_post_gate_allowed() as a'))[0].a;
  const asArr = (v) => (Array.isArray(v) ? v : String(v).replace(/^\{|\}$/g, '').split(',').filter(Boolean));
  sqlPrims = asArr(sqlPrims); sqlPost = asArr(sqlPost);
  if (MUTATE === 'sql-vocab-missing-key') sqlPrims = sqlPrims.filter((k) => k !== 'gap_gate');
  if (MUTATE === 'sql-vocab-extra-key') sqlPrims = [...sqlPrims, 'consult_specialist'];

  let vocabCompared = 0;
  for (const [label, sqlList, srcName] of [['PRIMITIVES', sqlPrims, 'PRIMITIVES'], ['POST_GATE_ALLOWED', sqlPost, 'POST_GATE_ALLOWED']]) {
    const src = edgeArray(srcName);
    const onlySql = sqlList.filter((k) => !src.includes(k));
    const onlySrc = src.filter((k) => !sqlList.includes(k));
    vocabCompared += src.length + sqlList.length;
    if (onlySql.length || onlySrc.length) {
      fail.push(`VOCABULARY DRIFT in ${label}: only-in-SQL=[${onlySql.join(',')}] only-in-${EDGE_SRC}=[${onlySrc.join(',')}] — the SQL floor and the engine disagree about what a step may be`);
    }
  }
  note(`  vocabulary arm: compared ${vocabCompared} key membership(s) across 2 vocabularies (PRIMITIVES ${sqlPrims.length}, POST_GATE_ALLOWED ${sqlPost.length})`);

  // ARM 2 — verdict parity, code by code
  const corpus = [...HANDWRITTEN, ...randomCorpus(edgeArray('PRIMITIVES'), 60)];
  let floors = await floorCodesBatch(corpus);
  if (MUTATE === 'floor-drops-last-step') floors = floors.map((s) => { const n = new Set(s); n.delete('last_step'); return n; });
  if (MUTATE === 'floor-invents-a-refusal') floors = floors.map((s) => new Set([...s, 'multiple_complete']));

  const edges = [];
  for (let i = 0; i < corpus.length; i += 8) {
    edges.push(...await Promise.all(corpus.slice(i, i + 8).map((f) => edgeCodes(f.steps))));
  }

  let comparisons = 0, mismatches = 0;
  corpus.forEach((f, i) => {
    for (const code of FLOOR_CODES) {
      comparisons++;
      const inEdge = edges[i].has(code);
      const inFloor = floors[i].has(code);
      if (inEdge !== inFloor) {
        mismatches++;
        fail.push(
          `PARITY MISMATCH on "${f.name}" [${code}]: edge validator ${inEdge ? 'REFUSES' : 'accepts'} but the SQL floor ${inFloor ? 'REFUSES' : 'accepts'}`
          + ` — ${inFloor ? 'the floor is STRICTER than the engine and will block a legitimate publish' : 'the floor is LOOSER than the engine and the mig 713 gap is reopening'}`
          + `\n      steps=${JSON.stringify(f.steps).slice(0, 200)}`
          + `\n      edge=[${[...edges[i]].join(',')}] floor=[${[...floors[i]].join(',')}]`,
        );
      }
    }
  });
  note(`  verdict arm: ${comparisons} code comparison(s) across ${corpus.length} fixture(s) (${HANDWRITTEN.length} handwritten, ${corpus.length - HANDWRITTEN.length} randomised) — ${mismatches} mismatch(es)`);
  note(`  not compared by design (params-only, edge validator is sole authority): ${PARAMS_ONLY_CODES.join(', ')}`);

  // Liveness: a corpus where the edge validator never refused anything would
  // make parity vacuous. Count the refusals it actually made.
  const edgeRefusals = edges.filter((s) => [...s].some((c) => FLOOR_CODES.includes(c))).length;
  note(`  liveness: the edge validator emitted a floor-vocabulary refusal on ${edgeRefusals}/${corpus.length} fixture(s)`);
  if (edgeRefusals === 0) fail.push('LIVENESS: the edge validator refused nothing in the whole corpus — parity here proves nothing');
  if (edgeRefusals === corpus.length) fail.push('LIVENESS: the edge validator refused EVERYTHING — no accept-side parity was exercised');

  if (MUTATE) {
    const caught = fail.length > 0;
    console.log(`\n--mutate=${MUTATE}: ${caught ? 'CAUGHT' : 'NOT CAUGHT'}`);
    if (caught) console.log(fail.map((f) => '  ' + f.split('\n')[0]).join('\n'));
    process.exit(caught ? 0 : 1);
  }
  if (fail.length) {
    console.log(`\nFAIL — ${fail.length} finding(s):`);
    fail.forEach((f) => console.log('  · ' + f));
    process.exit(1);
  }
  console.log('\nPASS — the SQL floor and the deployed validator agree on every key-and-order rule.');
}

main().catch((e) => { console.error('playbook-gate-parity ERROR:', e.message); process.exit(2); });
