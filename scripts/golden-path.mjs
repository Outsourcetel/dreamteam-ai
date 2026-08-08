#!/usr/bin/env node
// ============================================================
// golden-path.mjs — the product, as an executable trace.
//
// This is the irreducible loop the whole platform exists to run:
//
//   signup -> hire -> equip -> intake -> escalate -> HUMAN DECIDES
//          -> gate -> evidence -> trust
//
// It is a SPEC THAT RUNS. A markdown spec lies the moment the code moves; this
// one goes red. It is simultaneously (a) the statement of what the product is,
// (b) an end-to-end integration proof, and (c) the demo. Anything it never
// touches is a candidate for the census's retire quadrant.
//
//   node scripts/golden-path.mjs           # run, then clean up
//   node scripts/golden-path.mjs --keep    # leave the tenant for inspection
//
// SAFETY
//   · DEV PROJECT ONLY (nmuntxrcdksyhsdywpan). Production is never touched.
//   · The user is created through the REAL public signup path (auth.signUp ->
//     handle_new_user -> complete_signup), never a forged auth.users row.
//   · Every step asserts an OBSERVABLE consequence, not a return code. A step
//     that "succeeds" without changing state is a failure here — that is the
//     exact class of defect this review exists to catch.
// ============================================================
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const KEEP = process.argv.includes('--keep');
const DEV_REF = 'nmuntxrcdksyhsdywpan';

// The dev anon key lives in .env.test (same file vitest uses), the management
// token in .env.local. Reading both rather than duplicating a credential.
function env(key, ...files) {
  const fromEnv = process.env[key]?.trim();
  if (fromEnv) return fromEnv;
  for (const f of files) {
    let raw;
    try { raw = readFileSync(f, 'utf8').replace(/^﻿/, ''); } catch { continue; }
    const line = raw.split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
    if (line) return line.slice(key.length + 1).replace(/^["']|["']$/g, '').trim();
  }
  throw new Error(`${key} not found in ${files.join(' or ')}`);
}

const MGMT_TOKEN = env('SUPABASE_ACCESS_TOKEN', '.env.local');
const DEV_URL = env('VITE_TEST_SUPABASE_URL', '.env.test');
const DEV_ANON = env('VITE_TEST_SUPABASE_ANON_KEY', '.env.test');

/** Admin SQL against DEV, for setup and for OBSERVING consequences. */
async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${DEV_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MGMT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SQL ${res.status}: ${text.slice(0, 260)}`);
  return JSON.parse(text);
}
const one = async (q) => (await sql(q))[0];
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ── Capability probe ───────────────────────────────────────────────────────
// The dev project has NO migration ledger (0 rows) and has drifted materially
// behind production. So before running the loop we ask dev what it actually
// has, and report anything the loop needs that dev cannot provide. A step that
// cannot run is reported as CANNOT-PROVE — never silently skipped, and never
// faked by writing the table directly, which would prove nothing about the
// real path.
async function signatureOf(name) {
  const rows = await sql(`select pg_get_function_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = ${lit(name)}
     order by length(pg_get_function_arguments(p.oid)) desc`);
  return rows.map((r) => r.args);
}

const steps = [];
let failed = 0;
let cannotProve = 0;
async function step(name, why, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
    steps.push({ name, why, ok: true, detail, ms: Date.now() - t0 });
  } catch (e) {
    const msg = String(e.message ?? e).slice(0, 400);
    if (e instanceof CannotProve) {
      cannotProve++;
      console.log(`  CANNOT-PROVE  ${name}\n          ${msg}`);
      steps.push({ name, why, ok: false, cannot_prove: true, detail: msg, ms: Date.now() - t0 });
      return;
    }
    failed++;
    console.log(`  FAIL  ${name}\n          ${why}\n          ${msg}`);
    steps.push({ name, why, ok: false, detail: msg, ms: Date.now() - t0 });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/** The environment cannot run this step. NOT a pass — the loop is unproven
 *  here, and saying so loudly is the entire point. */
class CannotProve extends Error {}
const cannot = (msg) => { throw new CannotProve(msg); };

// ── State carried between steps ────────────────────────────────────────────
const S = {};
const stamp = `${Date.now()}`;

console.log(`golden path — dev project ${DEV_REF} — ${new Date().toISOString()}`);

// 1. SIGNUP — the real public path. A forged auth.users row would prove nothing
//    about the trigger chain that actually runs for a customer.
await step('signup', 'a real user and tenant must be creatable through the public path', async () => {
  const client = createClient(DEV_URL, DEV_ANON);
  const email = `golden-path-${stamp}@dreamteam-ai-tests.invalid`;
  const { data: su, error: e1 } = await client.auth.signUp({
    email, password: `GoldenPath!${stamp}`,
    options: { data: { full_name: 'Golden Path', role: 'tenant_owner', layer: 'tenant' } },
  });
  if (e1) throw new Error(`signUp: ${e1.message}`);
  assert(su.session, 'signUp returned no session — is mailer_autoconfirm on for dev?');
  const { data: cs, error: e2 } = await client.rpc('complete_signup', { p_org_name: `Golden Path ${stamp}` });
  if (e2) throw new Error(`complete_signup: ${e2.message}`);
  assert(cs?.ok, `complete_signup not ok: ${JSON.stringify(cs)}`);
  S.client = client; S.userId = su.user.id; S.tenantId = cs.tenant_id;

  const row = await one(`select tenant_id from profiles where user_id = ${lit(S.userId)}`);
  assert(row?.tenant_id === S.tenantId, 'profile was not linked to the new tenant');
  return `tenant ${S.tenantId.slice(0, 8)}`;
});

// 2. HIRE — instantiate a role archetype into a real employee.
await step('hire', 'an archetype must become a digital employee with a lifecycle', async () => {
  const arch = await one(`select key from role_archetypes where status = 'active' order by key limit 1`);
  if (!arch?.key) {
    cannot('role_archetypes is EMPTY on dev — the product cannot hire anyone here, so the '
      + 'core loop cannot start. Not a product defect: an environment that cannot run the product.');
  }
  S.archetype = arch.key;
  const { data, error } = await S.client.rpc('instantiate_role_archetype', {
    p_tenant_id: S.tenantId, p_archetype_key: S.archetype, p_de_name: `GP ${stamp}`,
  });
  if (error) throw new Error(`instantiate_role_archetype: ${error.message}`);
  S.deId = typeof data === 'string' ? data : data?.id ?? data?.de_id;
  assert(S.deId, `no DE id returned: ${JSON.stringify(data)}`);
  const de = await one(`select name, status, archetype_key from digital_employees where id = ${lit(S.deId)}`);
  assert(de, 'the employee row does not exist after hiring');
  return `${de.name} (${S.archetype}, ${de.status})`;
});

// 3. EQUIP — the role kit and the systems the role declares.
await step('equip', 'a hired employee must receive its kit and its system bindings', async () => {
  if (!S.deId) cannot('no employee exists — the hire step could not run in this environment');
  const { error } = await S.client.rpc('install_role_kit', { p_de_id: S.deId, p_archetype_key: S.archetype });
  if (error) throw new Error(`install_role_kit: ${error.message}`);
  await S.client.rpc('install_role_systems', { p_de_id: S.deId, p_archetype_key: S.archetype });
  const n = await one(`select
      (select count(*) from de_connected_systems where de_id = ${lit(S.deId)}) as systems,
      (select count(*) from de_guardrails      where de_id = ${lit(S.deId)}) as guardrails`);
  assert(Number(n.systems) + Number(n.guardrails) > 0,
    'the kit installed nothing observable — no systems and no guardrails');
  return `${n.systems} systems, ${n.guardrails} guardrails`;
});

// 4. INTAKE — work must be able to ENTER. The census showed 0 pending work
//    items in production against 374 pending human tasks, so this step is
//    where the real-world bottleneck begins.
await step('intake', 'work must be enqueueable and then claimable by a worker', async () => {
  if (!S.deId) cannot('no employee exists — the hire step could not run in this environment');
  const { data, error } = await S.client.rpc('enqueue_de_work_item', {
    p_tenant_id: S.tenantId, p_de_id: S.deId,
    p_title: `Golden path probe ${stamp}`, p_kind: 'act',
    p_idempotency_key: `golden-path-${stamp}`,
  });
  if (error) throw new Error(`enqueue_de_work_item: ${error.message}`);
  S.workItemId = typeof data === 'string' ? data : data?.id;
  const row = await one(`select status from de_work_items where id = ${lit(S.workItemId)}`);
  assert(row, 'the work item does not exist after enqueue');
  return `item ${String(S.workItemId).slice(0, 8)} (${row.status})`;
});

// 5. ESCALATE — the employee hands a judgement call to a person. This is the
//    seam the entire product thesis rests on.
await step('escalate', 'the employee must be able to raise a decision to a human', async () => {
  if ((await signatureOf('open_de_escalation')).length === 0) {
    cannot('open_de_escalation DOES NOT EXIST on the dev project — the human seam, '
      + 'which is the core of the product, cannot be exercised here at all. '
      + 'Dev is 102 routines behind production and has NO migration ledger.');
  }
  const { data, error } = await S.client.rpc('open_de_escalation', {
    p_tenant_id: S.tenantId, p_de_id: S.deId, p_work_item_id: S.workItemId,
    p_objective_id: null, p_title: `Approve golden path ${stamp}`,
    p_reason: 'certification review: proving the human seam',
    p_proposed_action: 'Publish the drafted reply',
    p_justification: 'Grounded in the workspace knowledge base',
    p_needs_input: true, p_sla_hours: 24,
  });
  if (error) throw new Error(`open_de_escalation: ${error.message}`);
  S.escalationId = typeof data === 'string' ? data : data?.id ?? data?.escalation_id;
  const t = await one(`select id, status from human_tasks
     where tenant_id = ${lit(S.tenantId)} and de_id = ${lit(S.deId)}
     order by created_at desc limit 1`);
  assert(t?.id, 'escalating produced NO human task — the work is invisible to a person');
  S.taskId = t.id;
  return `human task ${t.id.slice(0, 8)} (${t.status})`;
});

// 6. DECIDE — a real person approves, through the sanctioned path. Anything
//    that writes human_tasks.status directly is bypassing approval authority.
await step('decide', 'a human decision must be recorded through decide_human_task', async () => {
  if (!S.taskId) cannot('no human task exists to decide — the escalate step could not run');
  const { error } = await S.client.rpc('decide_human_task', {
    p_task_id: S.taskId, p_decision: 'approved',
    p_reason_code: null, p_note: 'golden path', p_edit: null,
  });
  if (error) throw new Error(`decide_human_task: ${error.message}`);
  const t = await one(`select status, decided_by, decided_at from human_tasks where id = ${lit(S.taskId)}`);
  assert(t.status === 'approved', `task status is ${t.status}, expected approved`);
  assert(t.decided_by && t.decided_at, 'the decision recorded no decider or timestamp — no accountability');
  return `approved by ${String(t.decided_by).slice(0, 8)}`;
});

// 7. GATE — the destructive floor must hold for a brand-new employee with no
//    earned trust. If this ever returns auto_executed, the product's core
//    promise is false.
await step('gate', 'a destructive action must NOT auto-execute for an untrusted employee', async () => {
  // Dev carries TWO overloads of this function (a 4-arg legacy one and a 7-arg
  // one), production carries a single 8-arg version WITH p_content — the
  // parameter the guardrail scan reads. So dev cannot prove the guardrail half
  // of the gate at all. Casts are explicit because an unadorned literal is
  // `unknown` and will not resolve against an overloaded name.
  if (!S.deId) cannot('no employee exists — the hire step could not run in this environment');
  const sigs = await signatureOf('decide_action_execution');
  if (sigs.length > 1) {
    console.log(`        note: dev has ${sigs.length} overloads of decide_action_execution — production has 1`);
  }
  const hasContent = sigs.some((a) => a.includes('p_content'));
  const call = hasContent
    ? `decide_action_execution(${lit(S.tenantId)}::uuid, 'Publish a post', 'social', true,
         ${lit(S.deId)}::uuid, null::bigint, 'action_execute', 'golden path content')`
    : `decide_action_execution(${lit(S.tenantId)}::uuid, 'Publish a post', 'social', true,
         ${lit(S.deId)}::uuid, null::bigint, 'action_execute')`;
  const d = await one(`select (${call})->>'decision' as decision`);
  assert(d.decision && d.decision !== 'auto_executed',
    `decision was ${d.decision} — an untrusted employee can act unattended`);
  S.gateDecision = d.decision;
  return `${d.decision}${hasContent ? '' : '  [WITHOUT guardrail content — dev lacks p_content]'}`;
});

// 8. GATE (negative control) — a NON-destructive action must not be blocked by
//    the destructive floor, or the employee can do nothing at all. A gate that
//    refuses everything is as broken as one that permits everything.
await step('gate-negative-control', 'a safe action must not hit the destructive floor', async () => {
  if (!S.deId) cannot('no employee exists — the hire step could not run in this environment');
  const sigs = await signatureOf('decide_action_execution');
  const hasContent = sigs.some((a) => a.includes('p_content'));
  const call = hasContent
    ? `decide_action_execution(${lit(S.tenantId)}::uuid, 'Draft a post', 'social', false,
         ${lit(S.deId)}::uuid, null::bigint, 'action_execute', 'golden path draft')`
    : `decide_action_execution(${lit(S.tenantId)}::uuid, 'Draft a post', 'social', false,
         ${lit(S.deId)}::uuid, null::bigint, 'action_execute')`;
  const d = await one(`select (${call})->>'decision' as decision`);
  assert(d.decision !== 'human_gated_destructive',
    'a non-destructive action hit the destructive floor — nothing can ever be delegated');
  return d.decision;
});

// 9. EVIDENCE — the decision must be visible in the audit trail. An approval
//    nobody can later prove happened is not governance.
await step('evidence', 'the loop must leave an auditable trace', async () => {
  const e = await one(`select
      (select count(*) from audit_events    where tenant_id = ${lit(S.tenantId)}) as audit,
      (select count(*) from activity_events where tenant_id = ${lit(S.tenantId)}) as activity`);
  assert(Number(e.audit) + Number(e.activity) > 0,
    'the entire loop produced no audit or activity record');
  return `${e.audit} audit, ${e.activity} activity`;
});

// 10. TRUST — autonomy must RESOLVE, and for a fresh employee it must not be
//     armed. This is the dial the whole governance story depends on.
await step('trust', 'autonomy must resolve, and a new employee must not start autonomous', async () => {
  if (!S.deId) cannot('no employee exists — the hire step could not run in this environment');
  // Prod takes a 5th p_playbook_id; dev does not. Call with the 4 both share.
  const a = await one(`select resolve_de_autonomy(
      ${lit(S.tenantId)}::uuid, 'action_execute', ${lit(S.deId)}::uuid, 'social')::text as verdict`);
  assert(a.verdict && a.verdict !== 'null', 'resolve_de_autonomy returned nothing');
  const v = JSON.parse(a.verdict);
  const enabled = v.enabled === true || v.autonomous === true;
  assert(!enabled, `a brand-new employee resolved to AUTONOMOUS: ${a.verdict}`);
  return `not autonomous (${Object.keys(v).slice(0, 4).join(',')})`;
});

// ── Cleanup ────────────────────────────────────────────────────────────────
if (!KEEP && S.tenantId) {
  try {
    await sql(`delete from tenants where id = ${lit(S.tenantId)}`);
    await sql(`delete from auth.users where id = ${lit(S.userId)}`);
    console.log('  cleanup: tenant and user removed');
  } catch (e) {
    console.log(`  cleanup FAILED (dev only, harmless): ${String(e.message).slice(0, 120)}`);
  }
} else if (KEEP) {
  console.log(`  kept: tenant ${S.tenantId} / user ${S.userId}`);
}

// The environment drift is itself a finding, so it is reported every run.
const drift = await one(`select
    (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prokind in ('f','p')) as routines,
    (select count(*) from pg_tables where schemaname='public') as tables,
    (select count(*) from public.schema_migrations) as ledger_rows`);
console.log(`\n  dev environment: ${drift.routines} routines, ${drift.tables} tables, `
  + `${drift.ledger_rows} ledger rows  (production: 881 / 284 / 657)`);

if (cannotProve > 0) {
  console.log(`  ${cannotProve} step(s) CANNOT be proven here — the dev project cannot exercise them.`);
}
console.log(failed === 0 && cannotProve === 0
  ? `\nGOLDEN PATH CLOSED — ${steps.length} steps, the loop runs end to end.`
  : failed === 0
    ? `\nGOLDEN PATH INCOMPLETE — ${steps.length - cannotProve}/${steps.length} proven; ${cannotProve} unprovable in this environment.`
    : `\nGOLDEN PATH BROKEN — ${failed}/${steps.length} steps failed.`);
process.exit(failed === 0 ? 0 : 1);
