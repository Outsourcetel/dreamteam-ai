#!/usr/bin/env node
// ============================================================
// playbook-branch-parity.mjs — the ratchet for Debt #0.
//
// THE DEFECT THIS EXISTS TO PREVENT RECURRING
//   `validateSteps` decided which step types may appear inside a decision's
//   then/else branch. `runBranchStep` decided which ones it could actually
//   carry out. Nobody ever compared the two lists. They read 10 and 6.
//   `update_record`, `check_knowledge`, `read_reference` and a nested
//   `decision` all passed validation, fell to the executor's `default:`, were
//   recorded `skipped`, and the run went on to `complete` and reported
//   COMPLETED. A playbook could be filed as a success having performed
//   neither requested action. The false report is the defect; the missing
//   arms were only how it got there.
//
// THE INVARIANT
//   For the branch executor:  implemented arms  ⊇  validator-accepted keys
//   and an unhandled key must STOP the run, never be skipped past.
//
// FIVE ARMS, each printing its DENOMINATOR. Zero findings from zero
// comparisons looks exactly like a clean result, so every arm says how many
// comparisons it actually made and dies if that number is zero.
//
//   1 SOURCE   arms ⊇ BRANCH_ALLOWED, parsed out of the edge function
//   2 TWIN     the builder's BRANCH_PRIMITIVES == the server's BRANCH_ALLOWED
//   3 LIVE ✓   every accepted key, driven through the DEPLOYED function,
//              lands on a real arm — not the unhandled default
//   4 LIVE ✗   every key that must be refused IS refused, in a branch
//   5 LIVE ☠   a run holding an unimplemented key FAILS. Driven, not read:
//              a run row is created, advanced, asserted, and deleted.
//
// Arms 1–2 read the repository. Arms 3–5 drive production's deployed
// function, so an un-deployed fix is a finding rather than a pass.
//
//   node scripts/playbook-branch-parity.mjs
//   node scripts/playbook-branch-parity.mjs --mutate=<case>   (self-test)
//
// --mutate drives the REAL comparison logic with one injected break and exits
// 0 only if the break was CAUGHT and NAMED. Cases:
//   arm-goes-missing   twin-drift   live-arm-silently-skips
//   validator-accepts-junk   unhandled-key-completes
// ============================================================
import { readFileSync } from 'node:fs';

const PROJECT_REF = 'rfsvmhcqeiyrxivbmpel';
const FN = `https://${PROJECT_REF}.supabase.co/functions/v1/playbook-execute`;
const EDGE_SRC = 'supabase/functions/playbook-execute/index.ts';
const CLIENT_SRC = 'src/lib/playbookBuilderApi.ts';
// Review Lab — the designated disposable test tenant, same one gate-parity uses.
const TENANT = '6c30af2b-a63b-4751-9876-8ce488f729d5';
const ACCOUNT = '00000000-0000-0000-0000-0000000000aa';

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
  console.error('playbook-branch-parity needs SUPABASE_ACCESS_TOKEN in .env.local (the token scripts/db-query.mjs uses).');
  console.error('Failing loudly rather than skipping — a probe that silently does not run is theatre.');
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
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

let _secret = null;
async function dispatchSecret() {
  if (_secret) return _secret;
  const rows = await sql("select decrypted_secret as s from vault.decrypted_secrets where name = 'playbook_dispatch_secret'");
  _secret = rows[0]?.s;
  if (!_secret) throw new Error('playbook_dispatch_secret not found in vault');
  return _secret;
}
async function callFn(body) {
  const secret = await dispatchSecret();
  const r = await fetch(FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dispatch-secret': secret },
    body: JSON.stringify(body),
  });
  return { http: r.status, body: await r.json().catch(() => ({})) };
}

// ── source parsing ────────────────────────────────────────────────────
function branchAllowedFromEdge() {
  const src = readFileSync(EDGE_SRC, 'utf8');
  const m = /const BRANCH_ALLOWED = new Set\(\[([\s\S]*?)\]\);/.exec(src);
  if (!m) throw new Error(`could not find BRANCH_ALLOWED in ${EDGE_SRC}`);
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

/** The `case '<key>':` labels inside runBranchStep's own switch — brace-counted
 *  from the arrow function's body so a `case` belonging to any OTHER switch in
 *  this 3,000-line file cannot be miscounted as an implemented branch arm. */
function branchArmsFromEdge() {
  const src = readFileSync(EDGE_SRC, 'utf8');
  const start = src.indexOf('const runBranchStep = async');
  if (start === -1) throw new Error(`could not find runBranchStep in ${EDGE_SRC}`);
  const open = src.indexOf('{', src.indexOf('=>', start));
  if (open === -1) throw new Error('could not find runBranchStep body');
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) throw new Error('runBranchStep body never closes');
  const body = src.slice(open, end);
  return {
    arms: [...body.matchAll(/case '([a-z_]+)':/g)].map((x) => x[1]),
    hasFailingDefault: /default: \{[\s\S]*?status = 'failed'[\s\S]*?return 'halt';/.test(body),
  };
}

function branchPrimitivesFromClient() {
  const src = readFileSync(CLIENT_SRC, 'utf8');
  const m = /export const BRANCH_PRIMITIVES: PrimitiveKey\[\] = \[([\s\S]*?)\];/.exec(src);
  if (!m) throw new Error(`could not find BRANCH_PRIMITIVES in ${CLIENT_SRC}`);
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

// ── fixtures ──────────────────────────────────────────────────────────
// Params good enough to clear the params-level validators, so the only thing
// under test is whether the KEY can be carried out inside a branch.
const BRANCH_PARAMS = {
  instruction: { title: 'probe', body_md: 'probe' },
  checklist: { items: ['probe'] },
  log_activity: { text_template: 'probe' },
  update_record: { table: 'renewal_invoices', set: { status: 'sent' } },
  connector_action: { action_key: 'probe_action', action_category: 'helpdesk', param_templates: {} },
  guardrail_check: { check: 'invoice_threshold' },
  check_knowledge: { query_template: 'probe', on_miss: 'continue' },
  read_reference: { refs: [{ kind: 'url', url: 'https://example.com' }], title: 'probe' },
  wait: { minutes: 1 },
  human_approval: {},
  generate_invoice: { amount_source: 'account_arr' },
  complete: {},
  consult_specialist: { profile_key: 'technical', question_template: 'q' },
  decision: { on: 'step:0', operator: 'exists' },
};
// Keys a branch must REFUSE. Gates and terminal steps have never been legal
// there; `wait` and `decision` were legal and unperformable, which is the same
// disease as a missing arm; `consult_specialist` is retired (migration 611).
const MUST_REFUSE = ['wait', 'decision', 'human_approval', 'generate_invoice', 'complete', 'consult_specialist', 'teleport_money'];

/** A 3-step playbook whose ELSE branch holds exactly the step under test. */
function fixture(branchStep) {
  return [
    { key: 'instruction', label: 'seed', params: { title: 'seed', body_md: 'seed' } },
    {
      key: 'decision', label: 'the decision',
      params: { on: 'step:0', operator: 'equals', value: '__never_matches__' },
      then_steps: [], else_steps: [branchStep],
    },
    { key: 'complete', label: 'done' },
  ];
}
const stepFor = (k) => ({ key: k, label: `probe:${k}`, params: BRANCH_PARAMS[k] ?? {} });

// The exact string the OLD default wrote. If this ever comes back from a live
// run, the defect is back regardless of what the source says.
const OLD_SKIP_MARKER = 'not executed in branch preview path';

// ── run ───────────────────────────────────────────────────────────────
const fail = [];
const note = (s) => console.log(s);

async function main() {
  note('playbook-branch-parity — decision-branch executor arms vs the keys its validator accepts\n');

  // ══ ARM 1 — SOURCE: arms ⊇ BRANCH_ALLOWED ═════════════════════════
  const allowed = branchAllowedFromEdge();
  let { arms, hasFailingDefault } = branchArmsFromEdge();
  if (MUTATE === 'arm-goes-missing') arms = arms.filter((k) => k !== 'update_record');

  const missingArms = allowed.filter((k) => !arms.includes(k));
  const orphanArms = arms.filter((k) => !allowed.includes(k));
  note(`  ARM 1 source    : compared ${allowed.length} validator-accepted key(s) against ${arms.length} executor arm(s) in runBranchStep`);
  note(`                    accepted = [${allowed.join(', ')}]`);
  note(`                    arms     = [${arms.join(', ')}]`);
  if (allowed.length === 0 || arms.length === 0) {
    fail.push('ARM 1 LIVENESS: parsed zero keys or zero arms — the parser broke, and a comparison of nothing always passes');
  }
  for (const k of missingArms) {
    fail.push(`ARM 1 MISSING EXECUTOR ARM: validateSteps accepts "${k}" inside a decision branch and runBranchStep has no case for it`
      + ` — a published playbook using it would reach the default. This is Debt #0 reopening.`);
  }
  if (orphanArms.length) {
    note(`                    note: ${orphanArms.length} arm(s) with no validator key (harmless, but dead): ${orphanArms.join(', ')}`);
  }
  if (!hasFailingDefault) {
    fail.push('ARM 1 SILENT DEFAULT: runBranchStep\'s default no longer fails the step and halts'
      + ' — an unhandled key would be skipped past and the run would still report completed');
  }

  // ══ ARM 2 — TWIN: the builder's copy must match the server's ══════
  let clientList = branchPrimitivesFromClient();
  if (MUTATE === 'twin-drift') clientList = [...clientList, 'consult_specialist'];
  const onlyClient = clientList.filter((k) => !allowed.includes(k));
  const onlyServer = allowed.filter((k) => !clientList.includes(k));
  note(`  ARM 2 twin      : compared ${clientList.length + allowed.length} key membership(s) across 2 lists (client ${clientList.length}, server ${allowed.length})`);
  if (onlyClient.length || onlyServer.length) {
    fail.push(`ARM 2 TWIN DRIFT: builder BRANCH_PRIMITIVES vs engine BRANCH_ALLOWED — only-in-builder=[${onlyClient.join(',')}] only-in-engine=[${onlyServer.join(',')}]`
      + ` — ${onlyClient.length ? 'the palette offers a step the server will refuse' : 'the palette hides a step that is legal'}`);
  }

  // ══ ARM 3 — LIVE: every accepted key lands on a real arm ══════════
  // Drives the DEPLOYED function. Catches the case where the fix is in the
  // repository but was never shipped.
  let live3 = 0;
  for (const k of allowed) {
    const steps = fixture(stepFor(k));
    const v = await callFn({ action: 'validate', tenant_id: TENANT, steps });
    if (!v.body.valid) {
      fail.push(`ARM 3 DEPLOY DRIFT: the deployed validator REFUSES "${k}" in a branch, but this repo's BRANCH_ALLOWED lists it`
        + ` (codes=[${(v.body.errors ?? []).map((e) => e.code).join(',')}]) — source and production disagree`);
      continue;
    }
    const p = await callFn({ action: 'start', preview: true, tenant_id: TENANT, account_id: ACCOUNT, steps });
    let bs = ((p.body.steps ?? [])[1]?.else_steps ?? [])[0] ?? {};
    if (MUTATE === 'live-arm-silently-skips' && k === 'update_record') {
      bs = { status: 'skipped', detail: `skipped: "${k}" ${OLD_SKIP_MARKER}` };
    }
    live3++;
    const detail = String(bs.detail ?? '');
    if (detail.includes(OLD_SKIP_MARKER)) {
      fail.push(`ARM 3 SILENT SKIP IS LIVE: the deployed executor dropped branch step "${k}" with the old default's wording`
        + ` ("${detail.slice(0, 80)}") and the run reported ${p.body.status} — the exact Debt #0 behaviour`);
    } else if (bs.status === 'pending' || bs.status === undefined) {
      fail.push(`ARM 3 BRANCH STEP NEVER RAN: "${k}" came back status=${bs.status} — the branch was not executed at all`);
    } else if (bs.status === 'failed' && p.body.status === 'completed') {
      fail.push(`ARM 3 FAILED STEP IN A COMPLETED RUN: "${k}" is status=failed but the run reported completed — a false success`);
    }
  }
  note(`  ARM 3 live ✓    : drove ${live3}/${allowed.length} accepted key(s) through the DEPLOYED executor as real preview runs`);
  if (live3 === 0) fail.push('ARM 3 LIVENESS: not one accepted key was actually driven — this arm proved nothing');

  // ══ ARM 4 — LIVE: what must be refused IS refused ═════════════════
  let live4 = 0, refusals = 0;
  for (const k of MUST_REFUSE) {
    const v = await callFn({ action: 'validate', tenant_id: TENANT, steps: fixture(stepFor(k)) });
    let valid = !!v.body.valid;
    if (MUTATE === 'validator-accepts-junk' && k === 'teleport_money') valid = true;
    live4++;
    if (valid) {
      fail.push(`ARM 4 VALIDATOR TOO LOOSE: the deployed validator ACCEPTS "${k}" inside a decision branch`
        + ` — nothing stops a snapshot being published with a step the executor cannot carry out`);
    } else refusals++;
  }
  note(`  ARM 4 live ✗    : drove ${live4} must-refuse key(s); the deployed validator refused ${refusals}/${live4}`);
  if (live4 === 0) fail.push('ARM 4 LIVENESS: zero refusal fixtures were driven');

  // ══ ARM 5 — LIVE: an unhandled key FAILS the run ══════════════════
  // The one arm that proves the BEHAVIOUR rather than the vocabulary. It
  // cannot go through `start` — that re-validates and would refuse the
  // fixture. It goes through `advance`, which replays playbook_runs.steps
  // verbatim with no re-validation: exactly the path a snapshot published
  // under an older vocabulary takes. A row is created and then removed.
  let arm5 = 'not attempted';
  const defRows = await sql(`select id from public.playbook_definitions where tenant_id = ${quote(TENANT)} order by created_at limit 1`);
  const defId = defRows[0]?.id;
  if (!defId) {
    fail.push('ARM 5 CANNOT RUN: the Review Lab tenant has no playbook definition to hang a probe run on — the behaviour of the default was NOT proven');
  } else {
    const probeSteps = [
      { key: 'instruction', label: 'seed', status: 'done', at: new Date().toISOString(), detail: 'seed', params: { title: 's', body_md: 's' } },
      {
        key: 'decision', label: 'the decision', status: 'pending', at: null, detail: '',
        params: { on: 'step:0', operator: 'equals', value: '__never_matches__' },
        then_steps: [],
        // A key no vocabulary has ever contained: stands in for any snapshot
        // published under an older BRANCH_ALLOWED than the engine now has.
        else_steps: [{ key: 'a_step_this_engine_cannot_run', label: 'the dropped step', status: 'pending', at: null, detail: '', params: {} }],
      },
      { key: 'complete', label: 'done', status: 'pending', at: null, detail: '' },
    ];
    const ins = await sql(`
      insert into public.playbook_runs (tenant_id, playbook_key, status, current_step, steps, definition_id, definition_version, context)
      values (${quote(TENANT)}, 'branch-parity-probe', 'resume_pending', 1, ${quote(JSON.stringify(probeSteps))}::jsonb,
              ${quote(defId)}, 0, '{}'::jsonb)
      returning id`);
    const runId = ins[0].id;
    let created = 1, removed = 0;
    try {
      const adv = await callFn({ action: 'advance', tenant_id: TENANT, run_id: runId });
      let status = adv.body.status;
      if (MUTATE === 'unhandled-key-completes') status = 'completed';
      const after = await sql(`select status, steps->1->>'status' as decision_status,
                                      steps->1->'else_steps'->0->>'status' as branch_status
                                 from public.playbook_runs where id = ${quote(runId)}`);
      const row = after[0] ?? {};
      const storedStatus = MUTATE === 'unhandled-key-completes' ? 'completed' : row.status;
      arm5 = `advance returned status=${status}; stored run.status=${storedStatus}, decision step=${row.decision_status}, branch step=${row.branch_status}`;
      if (status === 'completed' || storedStatus === 'completed') {
        fail.push(`ARM 5 THE SILENT DEFAULT IS ALIVE: a run whose branch holds "a_step_this_engine_cannot_run" reported COMPLETED`
          + ` (${arm5}) — the run was filed as a success having performed neither requested action`);
      } else if (status !== 'failed') {
        fail.push(`ARM 5 UNHANDLED KEY DID NOT FAIL OR PAUSE: advance returned "${status}" (${arm5})`
          + ` — the only acceptable outcomes are failed or a pause`);
      }
    } finally {
      const del = await sql(`delete from public.playbook_runs where id = ${quote(runId)} returning id`);
      removed = del.length;
    }
    note(`  ARM 5 live ☠    : 1 unhandled-key run driven through advance — ${arm5}`);
    note(`                    rows: created ${created} playbook_runs (${runId}), removed ${removed}`);
    if (removed !== 1) fail.push(`ARM 5 CLEANUP: the probe run ${runId} was not removed (deleted ${removed})`);
  }

  // ── verdict ─────────────────────────────────────────────────────────
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
  console.log('\nPASS — every key the branch validator accepts has an executor arm, the builder agrees, and an unhandled key stops the run.');
}

main().catch((e) => { console.error('playbook-branch-parity ERROR:', e.message); process.exit(2); });
