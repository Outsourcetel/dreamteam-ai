#!/usr/bin/env node
// audit-role-gates.mjs — does the UI offer controls the DATABASE will refuse?
//
//   node scripts/audit-role-gates.mjs            # report
//   node scripts/audit-role-gates.mjs --strict   # exit 1 on any finding
//
// navAccess decides which PAGES a role may open. It does not decide which
// CONTROLS on those pages will work — that lives in the SECURITY DEFINER
// functions. The two drift apart silently, and the symptom is a button that
// errors for some people and works for others. A sweep on 2026-08-07 found
// nineteen such controls on the Employee File, a password field on Browser
// Operator that a read_only account could type into but never save, and ten
// more across sub-pages and components.
//
// ⚠⚠ THE CLASSIFIER MUST READ THE `or self` BRANCH.
//
// The first version of this matched auth_has_tenant_role(...) and reported the
// roles. It could not see:
//
//     v_self  := (p_user_id = auth.uid());
//     v_admin := auth_has_tenant_role(array['tenant_owner','tenant_admin']);
//     if v_self or v_admin then ...
//
// so it called a PER-PERSON permission a ROLE permission. That misreading cost
// a wrong recommendation — "My Profile needs a server change" when it needed
// one line of nav config, because every employee-record RPC was already
// self-aware. It can also cause the opposite harm: gating a control somebody
// was always entitled to use on their own record.
//
// ⚠ Not every auth.uid() is a self-gate. `updated_by = auth.uid()` is audit
// stamping. Only a comparison in a PERMISSION position counts.
//
// ⚠ THIS IS NOT A SECURITY BOUNDARY. The database refuses regardless. This
// reports where the UI is DISHONEST about it.
//
// ⚠ And a governed refusal that explains itself is NOT a defect: decide_human_task
// answers "you hold no approval authority for X". Hiding that would remove the
// one control the `approver` role exists to use. Judge by whether the refusal
// teaches the person anything.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const PROJECT_REF = 'rfsvmhcqeiyrxivbmpel';
const ENDPOINT = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
const STRICT = process.argv.includes('--strict');
const DEBUG = process.argv.includes('--debug');
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

// ── the classifier ───────────────────────────────────────────────────────
const ROLE_RE = /auth_has_tenant_role|can_admin_tenant|resolve_platform_capability|role\s+not\s+in\s*\(/i;

/** Does this function grant access to the SUBJECT of the row, not just a role? */
export function selfBranch(src) {
  const s = (src || '').replace(/\s+/g, ' ');
  if (/\(?[a-z_.]*\s*=\s*auth\.uid\(\)\s*\)?\s*or\s+[^;]{0,120}(auth_has_tenant_role|can_admin_tenant|resolve_platform_capability)/i.test(s)) return 'inline';
  if (/(auth_has_tenant_role|can_admin_tenant|resolve_platform_capability)[^;]{0,120}\s+or\s+\(?[a-z_.]*\s*=\s*auth\.uid\(\)/i.test(s)) return 'inline';
  const selfVars = [...s.matchAll(/([a-z_][a-z0-9_]*)\s*(?::=|boolean\s*:=)\s*\(?\s*[a-z_.]+\s*=\s*auth\.uid\(\)/gi)].map((m) => m[1]);
  const roleVars = [...s.matchAll(/([a-z_][a-z0-9_]*)\s*(?::=|boolean\s*:=)\s*(?:auth_has_tenant_role|can_admin_tenant|resolve_platform_capability)/gi)].map((m) => m[1]);
  for (const sv of selfVars) {
    for (const rv of roleVars) {
      if (new RegExp(`\\b${sv}\\b\\s+or\\s+\\b${rv}\\b`, 'i').test(s)) return 'via-vars';
      if (new RegExp(`\\b${rv}\\b\\s+or\\s+\\b${sv}\\b`, 'i').test(s)) return 'via-vars';
    }
  }
  for (const sv of selfVars) if (new RegExp(`if\\s+(not\\s+)?\\b${sv}\\b`, 'i').test(s)) return 'self-var-gate';
  return null;
}

/** Roles a caller must hold — or SELF, meaning the subject is always allowed. */
export function classify(src) {
  const hasRole = ROLE_RE.test(src || '');
  const self = selfBranch(src);
  if (hasRole && self) return { kind: 'SELF-OR-ROLE', self };
  if (hasRole) return { kind: 'ROLE-ONLY', self: null };
  if (self) return { kind: 'SELF-ONLY', self };
  return { kind: 'UNGATED', self: null };
}

// ── the repo ─────────────────────────────────────────────────────────────
const FILES = {};
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
    else if (/\.(ts|tsx)$/.test(e.name)) FILES[path.relative(ROOT, p).split(path.sep).join('/')] = readFileSync(p, 'utf8');
  }
})(path.join(ROOT, 'src'));

// A control counts as guarded if it is behind ANY of these. The last group is
// the important one and was missing at first: SERVER-PROVIDED capability flags.
//
// ⚠ EmployeeProfileDrawer gates its pay form with `{rec.can_edit_pay && …}`,
// where can_edit_pay comes back from get_employee_record — the server telling
// the UI what this particular caller may do, which is strictly better than the
// UI guessing from a role. Without `can_edit_` here the checker flagged the
// best-behaved component in the codebase and would have had me "fix" it.
const GATE_RE = /canOverride|canEdit|canManage|isDTUser|isAdmin|canApprove|canOperate|canStop|canResume|tenant_owner|role ===|useIsTenantAdmin|useIsTenantManager|isTenantAdmin|isTenantManager|can_edit_|can_manage_|can_approve_|\.can_/;

// ⚠⚠ ONE DEFINITION OF "THIS FILE HAS A GATE", USED BY BOTH PASSES.
//
// GATE_RE is a hard-coded list of idioms. The intra-file pass stopped trusting
// it long ago and derives gate names from the file's own use*Is/use*Can
// bindings — but the FILE-LEVEL pass still consulted GATE_RE alone, so the two
// disagreed about the same file. Adding `useCanCurateKnowledge` proved it: the
// intra-file pass saw the gate, the file-level pass did not, and the checker
// reported a freshly-gated page as ungated. That is the FIFTH time a detector
// has failed to learn an idiom I had just introduced, and the fix is not
// another name in the list — it is to stop keeping two lists.
// ── IS THIS COMPONENT A CONTROL, OR DOES IT CONTAIN ONE? ─────────────────
//
// A capitalised tag's on* props are two different things wearing one prefix,
// and the checker used to approximate the difference by accepting onClick
// alone. That dropped every control not called onClick — <LiveEmptyState
// onPrimary> (17 sites, often the ONLY control on an empty state),
// <Toggle onChange>, <TabBar onSelect>, <LiveErrorNotice onRetry> — and two
// real defects hid there, both of which I ended up finding by reading.
//
// ⚠ TENSE IS NOT THE SIGNAL. I tried that first: present tense commands,
// past tense reports. It classified all 109 handler props in the repo and
// looked right, then produced five findings that were all the same false
// positive — a parent handing a callback to a child that renders the actual
// control. `<FieldMapEditor onSave={…}>` is present tense and is still not a
// button.
//
// THE SIGNAL IS IN THE COMPONENT'S OWN DEFINITION. A leaf control wires the
// prop straight into a native element's handler:
//     LiveEmptyState:  onClick={onPrimary}
//     Toggle:          onClick={() => !disabled && onChange(!enabled)}
// A container calls it after doing something else, in a function body:
//     SystemCard:      try { await fn(); onChange(); }
// The first IS the control. The second is a refresh notification, and the
// child's real controls are judged on their own pass — counting the parent
// too is how three refresh callbacks on Browser Operator once got reported
// as dead buttons.
const componentSrc = {};
for (const body of Object.values(FILES)) {
  const re = /(?:^|\n)(?:export\s+)?(?:default\s+)?(?:function\s+([A-Z][A-Za-z0-9_]*)|const\s+([A-Z][A-Za-z0-9_]*)\s*=\s*(?:\([^)]*\)|[A-Za-z0-9_]+)\s*(?::[^=]*)?=>)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const name = m[1] || m[2];
    // Next definition at the same level, or end of file.
    const rest = body.slice(m.index + m[0].length);
    const nxt = rest.search(/\n(?:export\s+)?(?:function\s+[A-Z]|const\s+[A-Z][A-Za-z0-9_]*\s*=)/);
    componentSrc[name] = (componentSrc[name] ?? '') + rest.slice(0, nxt < 0 ? 12000 : nxt);
  }
}
/** Does <Comp prop={…}> put `prop` behind a real handler inside Comp? */
function isControlProp(comp, prop) {
  if (prop === 'onClick') return true;              // native semantics, always
  const src = componentSrc[comp];
  if (!src) return false;                           // unknown component: stay quiet
  // ⚠ IT MUST BE A NATIVE ELEMENT'S HANDLER. My first version accepted the
  // prop inside ANY on*={…}, and the self-test below caught it immediately:
  // SystemCard passes onChange down through a CHILD's notification —
  //     <LoginForm onDone={() => { setShowLogin(false); onChange(); }} />
  // — which is still plumbing, one level further down. Only a lowercase tag
  // is the user actually clicking something.
  const re = /\bon[A-Z][a-zA-Z]*\s*=\s*(\{(?:[^{}]|\{[^{}]*\})*\})/g;
  let h;
  while ((h = re.exec(src)) !== null) {
    if (!new RegExp(`\\b${prop}\\b`).test(h[1])) continue;
    // Walk back to the tag this attribute belongs to; lowercase means native.
    const open = src.lastIndexOf('<', h.index);
    if (open >= 0 && /^<[a-z]/.test(src.slice(open, open + 2))) return true;
  }
  return false;
}
const isCommandProp = (p) => p === 'onClick';       // kept for the enforcing filter below

// ⚠ PINNED IN BOTH DIRECTIONS. A rule that quietly reclassified everything as
// plumbing would make this checker report less and still "pass" — the failure
// mode it has had more than once. Three it must now see, three it must not.
// ⚠ <Modal onClose> IS classified a control, and that is correct: Modal's ×
// is a real <button onClick={onClose}>. I first pinned it as "not a control"
// because dismissing a dialog is not a gated action — but that confuses what
// a control IS with whether it happens to reach anything gated. It reaches
// nothing gated, so it produces no comparison and no finding; asserting the
// mechanism should mis-classify it to get the outcome I expected would have
// been fixing the instrument to match my guess. The pin tests the thing that
// actually matters: a LEAF control is seen, a CONTAINER's callback is not.
for (const [comp, prop, want] of [
  ['LiveEmptyState', 'onPrimary', true],   // the empty-state CTA that hid a dead end
  ['Toggle', 'onChange', true],            // the inversion test that used to miss
  ['SystemCard', 'onChange', false],       // a container's refresh callback
]) {
  // ⚠ I ALSO PINNED <FieldMapEditor onSave> AS "not a control" AND WAS WRONG
  // AGAIN. Its definition is `<button onClick={() => onSave(map)}>` — one
  // Save button whose action IS that prop. Twice in a row I asserted an
  // outcome I expected and the mechanism disagreed, and twice the mechanism
  // was right. Only pins I have actually read the definition for belong here;
  // the rest is triaged from the output, not legislated into it.
  if (isControlProp(comp, prop) !== want) {
    console.error(`ABORT: <${comp} ${prop}> should ${want ? 'BE' : 'NOT be'} treated as a control.`);
    console.error('The component-definition reader is broken; every judgement below is unreliable.');
    process.exit(2);
  }
}

function localGateNames(src) {
  return [...new Set([...src.matchAll(/const\s+([a-zA-Z0-9_]+)\s*=\s*use(?:Is|Can)[A-Za-z0-9_]*\s*\(/g)].map((m) => m[1]))];
}
function fileHasGate(src) {
  if (GATE_RE.test(src)) return true;
  const local = localGateNames(src);
  return local.length > 0 && new RegExp('\\b(?:' + local.join('|') + ')\\b').test(src);
}

const gatedByProp = new Set();
for (const body of Object.values(FILES)) {
  const re = /<([A-Z][A-Za-z0-9_]*)([^>]*?)\/?>/g;
  let m; while ((m = re.exec(body)) !== null) if (GATE_RE.test(m[2] || '')) gatedByProp.add(m[1]);
}

const rows = await sql(`
  select p.proname, p.prosrc
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind in ('f','p')
    and pg_get_function_result(p.oid) <> 'trigger'
    and (p.prosrc ilike '%auth_has_tenant_role%' or p.prosrc ilike '%can_admin_tenant%'
         or p.prosrc ilike '%resolve_platform_capability%' or p.prosrc ~* 'role not in \\(')
  order by p.proname`);

// ── SELF-TESTS — pin both directions on functions read by hand ────────────
const by = Object.fromEntries(rows.map((r) => [r.proname, r.prosrc]));
const EXPECT = [
  ['get_employee_record', 'SELF-OR-ROLE'],
  ['update_employee_private', 'SELF-OR-ROLE'],
  ['set_employee_compensation', 'ROLE-ONLY'],   // "being able to set it is not"
  ['set_de_identity', 'ROLE-ONLY'],
];
for (const [name, want] of EXPECT) {
  if (!by[name]) { console.error(`SELF-TEST FAILED: ${name} missing from the gated set`); process.exit(2); }
  const got = classify(by[name]).kind;
  if (got !== want) { console.error(`SELF-TEST FAILED: ${name} → ${got}, expected ${want}`); process.exit(2); }
}
console.error(`self-test ok — ${rows.length} gated functions, self-branch detection live\n`);

// ── gated rpc  ->  the exported lib function that wraps it ───────────────
//
// ⚠⚠ WITHOUT THIS STEP THE CHECKER IS BLIND. The first version matched only
// direct rpc('name') calls in page/component files — but the overwhelming
// majority of call sites live in src/lib/*.ts and reach the UI through an
// exported wrapper. It reported "0 findings" with a gate deliberately removed,
// which is the same "0 from 0 comparisons" trap as reporting a clean audit
// having compared nothing. Caught only by removing a gate and watching the
// checker fail to notice.
const wrappers = {};                 // exported fn name -> [gated rpc names]
for (const [f, src] of Object.entries(FILES)) {
  if (!f.startsWith('src/lib/')) continue;
  const re = /export\s+(?:async\s+)?(?:function\s+([A-Za-z0-9_]+)|const\s+([A-Za-z0-9_]+)\s*[:=])/g;
  const marks = []; let m;
  while ((m = re.exec(src)) !== null) marks.push({ name: m[1] || m[2], at: m.index });
  for (let i = 0; i < marks.length; i++) {
    const body = src.slice(marks[i].at, marks[i + 1] ? marks[i + 1].at : src.length);
    for (const r of rows) {
      if (body.includes(`rpc('${r.proname}'`) || body.includes(`rpc("${r.proname}"`)) {
        (wrappers[marks[i].name] ||= []).push(r.proname);
      }
    }
  }
}

// ── which are reachable from the UI, and are those controls gated? ────────
const findings = [];
let selfAware = 0;
const needsGate = new Map();         // rpc name -> true when a role check is required
for (const r of rows) {
  const c = classify(r.prosrc);
  if (c.kind === 'SELF-OR-ROLE') { selfAware++; continue; }  // subject always allowed — not a UI defect
  if (c.kind === 'UNGATED') continue;
  // ⚠ These two regexes were once written by a shell-quoted patch script and
  // arrived with every backslash stripped —
  //     /auth_has_tenant_roles*(s*arrays*[([^]]*)]/i
  // which matches nothing, so `roles` was always empty, every function hit the
  // `continue` below, and the checker reported a clean sweep having examined
  // nothing. Fifth time in this session that shell escaping has silently
  // broken a checker. Edit this file directly; never patch it through a shell.
  const m = (r.prosrc.match(/auth_has_tenant_role\s*\(\s*array\s*\[([^\]]*)\]/i) || [])[1];
  const roles = m ? m.replace(/['\s]|::text/g, '').split(',').filter(Boolean)
                  : (/can_admin_tenant/i.test(r.prosrc) ? ['tenant_owner', 'tenant_admin'] : []);
  if (!roles.length) continue;   // platform-capability gates: not a tenant-role question
  needsGate.set(r.proname, roles);
}

// ── THE SECOND SURFACE: writes that go straight to a table ───────────────
//
// ⚠⚠ EVERYTHING ABOVE READS pg_proc, SO IT CANNOT SEE THIS AT ALL. The
// Organisation page has no gated function anywhere — it calls
// `.from('org_units').insert(…)` and the permission lives in an RLS POLICY.
// The checker was silent about that page and the silence looked like coverage.
//
// ⚠⚠ AND THIS SURFACE FAILS WORSE THAN THE OTHER ONE. A refused RPC raises;
// PostgREST reports an RLS-denied write as SUCCESS with zero rows changed. No
// error reaches the UI, so the button appears to work and the change is simply
// not there. That is how the "who pays" radio stayed broken — it wrote to a
// table whose RLS allowed SELECT only, and every save reported success.
//
// ⚠ PERMISSIVE POLICIES OR TOGETHER. If any permissive policy covering a
// command has no role condition, the write is NOT role-restricted, and a
// second policy naming roles does not narrow it. Treating each policy alone
// would invent a requirement that does not exist — and it handles the self
// case for free: `profiles` UPDATE has "Platform admins manage all profiles"
// OR "Users can update own profile", the second of which names no role, so
// the pair correctly resolves to "not a role question".
const policies = await sql(`
  select tablename, policyname, permissive, cmd,
         coalesce(with_check, '') as check_expr, coalesce(qual, '') as using_expr
  from pg_policies where schemaname = 'public' and cmd <> 'SELECT'`);

const policyRoles = (expr) => {
  const m = (expr.match(/auth_has_tenant_role\s*\(\s*ARRAY\s*\[([^\]]*)\]/i) || [])[1];
  if (m) return m.replace(/['\s]|::text/g, '').split(',').filter(Boolean);
  return /can_admin_tenant/i.test(expr) ? ['tenant_owner', 'tenant_admin'] : null;
};
/** Synthetic action name, so table writes flow through the same comparison,
 *  the same viewer resolution and the same reporting as an rpc. */
const tableAction = (t, cmd) => `${t}.${cmd.toLowerCase()}`;

// ⚠ RESTRICTIVE policies AND on top and can only narrow. All eleven in this
// database are DE-scope (`de_id IS NULL OR can_access_de(de_id)`) and carry no
// role condition, so they change nothing today — but say so out loud if that
// ever stops being true rather than quietly ignoring them.
const restrictiveWithRole = policies.filter((p) => p.permissive !== 'PERMISSIVE' && policyRoles(p.check_expr || p.using_expr));
if (restrictiveWithRole.length) {
  console.error(`NOTE: ${restrictiveWithRole.length} RESTRICTIVE policies now carry a role condition ` +
    `(${[...new Set(restrictiveWithRole.map((p) => p.tablename))].join(', ')}). They AND with the permissive ` +
    'set, so the effective requirement is NARROWER than reported below.');
}

for (const cmd of ['INSERT', 'UPDATE', 'DELETE']) {
  for (const t of new Set(policies.map((p) => p.tablename))) {
    const covering = policies.filter((p) => p.tablename === t && p.permissive === 'PERMISSIVE' && (p.cmd === 'ALL' || p.cmd === cmd));
    if (!covering.length) continue;
    const union = new Set();
    let open = false;
    for (const p of covering) {
      const r = policyRoles(p.check_expr || p.using_expr);
      if (!r) { open = true; break; }
      r.forEach((x) => union.add(x));
    }
    if (open || !union.size) continue;
    needsGate.set(tableAction(t, cmd), [...union]);
  }
}

// ── SELF-TEST for the policy reader, pinned in BOTH directions ───────────
//
// The dangerous mistake here is not missing a gate, it is INVENTING one: read
// a single policy in isolation and you will report a requirement the database
// does not have, then "fix" a working control by taking it away from people
// who were entitled to it. So pin an open table and a self-policy table as
// firmly as the gated one.
{
  const PIN = [
    ['connectors.update', 'tenant_owner,tenant_admin'],   // one policy, role-gated
    ['activity_events.insert', null],                     // tenant scope only — not a role question
    ['profiles.update', null],                            // "Platform admins…" OR "Users can update own
                                                          //  profile"; the second names no role, so the
                                                          //  pair is not a role gate at all
  ];
  for (const [name, want] of PIN) {
    const got = needsGate.has(name) ? needsGate.get(name).join(',') : null;
    if (got !== want) {
      console.error(`SELF-TEST FAILED: ${name} → ${got === null ? 'not gated' : got}, expected ${want === null ? 'not gated' : want}`);
      process.exit(2);
    }
  }
  console.error(`policy reader ok — ${[...needsGate.keys()].filter((k) => k.includes('.')).length} role-gated table writes, ` +
    'open and self-policy tables correctly excluded\n');
}

/** Table writes in a body, as synthetic action names. `.upsert` is an insert
 *  for policy purposes; the chained call may sit on the next line. */
/**
 * Navigations to a page with a LITERAL key: setPage('workforce_hire'),
 * handleSetPage("gov_security"), openTab('trust').
 *
 * ⚠ DELIBERATELY ONLY LITERALS. A hub that does `onSelect={setPage}` over a
 * tabs array is passing a VARIABLE, and those hubs already filter their tab
 * list through canAccessPage — reading them as one control pointing at every
 * page would flag the four correctly-filtered hubs and bury the real
 * findings. A noisy checker gets ignored, which is how this drift arrived.
 * The cost is stated rather than hidden: a hub that FORGOT to filter is not
 * caught by this pass. PAGE_ACCESS completeness, checked separately, is what
 * covers the case where such a page has no tier at all.
 */
function navTargets(body) {
  const out = new Set();
  for (const m of body.matchAll(/\b(?:handleSetPage|setPage|openTab|onSelect)\s*\(\s*['"]([a-z0-9_]+)['"]/g)) {
    const name = navAction(m[1]);
    if (needsGate.has(name)) out.add(name);
  }
  return out;
}

function tableWrites(body) {
  const out = new Set();
  for (const m of body.matchAll(/\.from\(\s*['"]([a-z0-9_]+)['"]\s*\)\s*(?:\r?\n\s*)*\.(insert|update|upsert|delete)\b/g)) {
    const name = tableAction(m[1], m[2] === 'upsert' ? 'INSERT' : m[2]);
    if (needsGate.has(name)) out.add(name);
  }
  return out;
}

// The lib wrappers again, this time for table writes. A second pass because
// needsGate has to exist first — `createUnit` is no more visible from a page
// than `setDeIdentity` is, and 33 of these stand between the UI and a policy.
for (const [f, src] of Object.entries(FILES)) {
  if (!f.startsWith('src/lib/')) continue;
  const re = /export\s+(?:async\s+)?(?:function\s+([A-Za-z0-9_]+)|const\s+([A-Za-z0-9_]+)\s*[:=])/g;
  const marks = []; let m;
  while ((m = re.exec(src)) !== null) marks.push({ name: m[1] || m[2], at: m.index });
  for (let i = 0; i < marks.length; i++) {
    const body = src.slice(marks[i].at, marks[i + 1] ? marks[i + 1].at : src.length);
    for (const a of tableWrites(body)) (wrappers[marks[i].name] ||= []).push(a);
  }
}

// ── who can OPEN the page this control sits on? ──────────────────────────
//
// ⚠ Without this the checker cries wolf. A control needing owner/admin on a
// page only owners and admins can open is correct, not a defect — reporting it
// buries the real findings in noise, and a noisy checker gets ignored, which
// is how the drift got here in the first place.
const TIER = {
  OWNER: ['tenant_owner'],
  ADMIN: ['tenant_owner', 'tenant_admin'],
  MANAGE: ['tenant_owner', 'tenant_admin', 'tenant_manager'],
  KNOWLEDGE: ['tenant_owner', 'tenant_admin', 'tenant_manager', 'knowledge_manager'],
  APPROVALS: ['tenant_owner', 'tenant_admin', 'tenant_manager', 'approver'],
  ALL_TENANT: ['tenant_owner', 'tenant_admin', 'tenant_manager', 'knowledge_manager', 'approver', 'tenant_user', 'read_only'],
};
const nav = FILES['src/lib/navAccess.ts'] || '';
const app = FILES['src/App.tsx'] || '';
const pageRoles = {};
{
  const block = nav.slice(nav.indexOf('const PAGE_ACCESS'), nav.indexOf('export const canAccessPage'));
  const re = /^\s{2}([a-z_]+):\s*(OWNER|ADMIN|MANAGE|KNOWLEDGE|APPROVALS|ALL_TENANT|\[\])/gm;
  let m; while ((m = re.exec(block)) !== null) pageRoles[m[1]] = m[2] === '[]' ? [] : TIER[m[2]];
}
// ── THE THIRD SURFACE: a control that OPENS a page it cannot open ────────
//
// ⚠⚠ THIS CHECKER WAS SILENT ON THIS CLASS THREE TIMES.
//   · support_calls — a TAB that took the click and did nothing
//   · the governance hub — Security & Access rendered to every role, and a
//     manager clicking it went nowhere
//   · "✨ Hire with AI" — introduced by me, converting the hire wizard from a
//     modal to an ADMIN-only route and leaving the button ungated
//
// Every one is the same defect and none of them touched an RPC or a table, so
// the two surfaces above could not see any of them. handleSetPage refuses
// silently when canAccessPage says no, which means the control looks live,
// takes the click, and does nothing — worse than being absent, because it
// reads as a broken product rather than as a boundary.
//
// A navigation target is an ACTION whose allowed roles are the page's own, so
// it folds into needsGate and every downstream comparison works unchanged: a
// finding is a viewer who can SEE the control but cannot OPEN what it opens.
const navAction = (page) => `open ${page}`;
for (const [page, roles] of Object.entries(pageRoles)) {
  // `[]` is platform-staff-only. A tenant-facing control pointing at one is a
  // real finding, and the isDTUser idiom in GATE_RE already clears the
  // legitimate cases, so these are included rather than skipped.
  needsGate.set(navAction(page), roles);
}

const compOfPage = {}; {
  // ⚠ CASE LABELS STACK. Four support pages share one component:
  //     case 'support_command_center':
  //     case 'support_triage_rules':
  //     case 'support_inbox':
  //     case 'support_calls':
  //       return <SupportHubPage …/>
  // A regex demanding `case 'x': return <Y` captures only the LAST label, so
  // three of the four pages had no component and the tier lookup came back
  // empty — which the checker then treated as "unreachable" and skipped.
  const re = /((?:case\s+'[a-z_]+':\s*)+)return\s*<([A-Za-z0-9_]+)/g;
  let m;
  while ((m = re.exec(app)) !== null) {
    for (const c of m[1].matchAll(/case\s+'([a-z_]+)'/g)) compOfPage[c[1]] = m[2];
  }
}
const fileOfComp = {}; {
  const re = /import\s+(?:\{\s*([^}]+)\s*\}|([A-Za-z0-9_]+))\s+from\s+'(\.[^']+)'/g;
  let m; while ((m = re.exec(app)) !== null) {
    const names = (m[1] || m[2] || '').split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    for (const n of names) fileOfComp[n] = path.posix.join('src', m[3].replace(/^\.\//, ''));
  }
}
const ext = (b) => ['.tsx', '.ts', '/index.tsx', '/index.ts'].map((x) => b + x).find((c) => FILES[c]);

// ── who imports whom, and under WHAT LOCAL NAME ──────────────────────────
//
// ⚠⚠ THE FILENAME IS NOT THE RENDER NAME. The first resolver searched for
// `<Basename` and returned no viewers when it found none — and the checker
// then skipped the file IN SILENCE. `DeWorkbench.tsx` is default-exported and
// rendered as `<DeWorkbenchPanel>`, so it went unexamined while the report
// read clean. A whole sub-page slipped through a check I had just written to
// stop exactly that.
//
// So follow the IMPORT, which carries the binding, rather than guessing from
// the path. Handles `import D from`, `import { A, B as C } from`, and
// `import D, { A } from`.
const importsOf = {};    // file -> [{ from: <file>, names: [local names] }]
for (const [f, src] of Object.entries(FILES)) {
  const re = /import\s+(?:([A-Za-z0-9_]+)\s*,\s*)?(?:\{\s*([^}]*)\s*\}|([A-Za-z0-9_]+))\s+from\s+'(\.[^']+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const names = [];
    if (m[1]) names.push(m[1]);
    if (m[3]) names.push(m[3]);
    if (m[2]) for (const part of m[2].split(',')) {
      const t = part.trim(); if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.push((as[1] || as[0]).trim());          // the LOCAL binding, i.e. after `as`
    }
    const target = ext(path.posix.normalize(path.posix.join(path.posix.dirname(f), m[4])));
    if (!target || !names.length) continue;
    (importsOf[target] ||= []).push({ from: f, names });
  }
}
/** Widest set of roles that can reach this file, following renders upward. */
function viewersOf(file, depth = 0) {
  if (depth > 6) return [];
  // ⚠ WIDEST, not first. One component can serve several pages at different
  // tiers — WorkforceHubPage backs both `outcomes` (ALL_TENANT) and
  // `intelligence_learning` (MANAGE). Returning whichever matched first let a
  // manager-level tier answer for an all-tenant page, and the comparison
  // passed: with a gate deliberately removed the checker still said "clean".
  let own = [];
  for (const [pg, comp] of Object.entries(compOfPage)) {
    if (ext(fileOfComp[comp] || '') !== file) continue;
    const roles = pageRoles[pg] || [];
    if (roles.length > own.length) own = roles;
  }
  if (own.length) return own;
  // ⚠ The app SHELL is every page at once. DEChatDock is rendered in App.tsx
  // outside the page switch, so it appears on every screen a signed-in tenant
  // user can reach — its viewers are ALL_TENANT, not "none". Resolving it to
  // nothing skipped the global chat dock entirely.
  if (file === 'src/App.tsx') return TIER.ALL_TENANT;
  let widest = [];
  for (const { from, names } of (importsOf[file] || [])) {
    if (from === file) continue;
    const body = FILES[from] || '';
    // Rendered under ANY of the names this importer bound to the file.
    if (!names.some((n) => new RegExp(`<${n}[\\s/>]`).test(body))) continue;
    // ⚠⚠ A TAB CHILD IS NOT AS WIDE AS ITS HUB. Four support pages share one
    // hub component, and one of them (the Inbox) is ALL_TENANT — so taking the
    // hub's widest tier handed ALL_TENANT to the Triage Rules page, which is
    // MANAGE, and reported four roles as refused that can never open it. The
    // hub renders each child under `{tab === 'support_triage_rules' && …}`,
    // and handleSetPage will not move to a tab the role cannot open, so the
    // guard IS the tier. Read it rather than inheriting.
    //
    // The "widest" rule is still right for the hub file itself — it really
    // does serve all four — which is why this reads the render site instead of
    // changing that rule.
    let viaTab = null;
    for (const n of names) {
      for (const m of body.matchAll(new RegExp(`(?:tab|page|currentPage)\\s*===\\s*'([a-z_]+)'[^<]{0,80}<${n}[\\s/>]`, 'g'))) {
        const roles = pageRoles[m[1]];
        if (roles && (!viaTab || roles.length > viaTab.length)) viaTab = roles;
      }
    }
    const up = viaTab || viewersOf(from, depth + 1);
    if (up.length > widest.length) widest = up;
  }
  return widest;
}

// ── inside a PARTIALLY gated file ────────────────────────────────────────
//
// ⚠⚠ The check below is file-level: one mention of a gate and the whole file
// is trusted. That hid six controls in LiveWorkforceDEs.tsx, which is ~4,200
// lines holding eleven components that each declare their own `canManage`.
// Wiring one component's buttons silenced the checker for the other ten.
//
// ⚠ Proximity to the rpc() call is the WRONG test. Those lines are handler
// BODIES; the button that calls the handler is often fifty lines away and
// perfectly gated. My first attempt reported nine of these as bare and every
// one was a false alarm. The right question is: for each handler that reaches
// a role-gated action, is every control invoking it behind a gate?
//
// ⚠ Handler names collide — `save` is declared in six components here — so a
// name-keyed map merges unrelated bodies and invents findings. Handlers are
// therefore scoped to the component they are declared in.
// Split the tally by area. "Components are covered" is a claim; "27 of 63
// comparisons were in src/components" is a fact, and the difference matters
// because a resolver that fails to find a component's render site returns no
// viewers and the file is skipped WITHOUT SAYING SO.
const SKIPPED = [];
const COMPARED = { n: 0, pages: 0, components: 0, nav: 0, area: '' };
function controlsMissingGate(src, wrapperMap) {
  const L = src.split(/\r?\n/);
  // ⚠⚠ DERIVE the gate names from this file rather than hard-coding them.
  //
  // GATE_RE lists idioms I knew about when I wrote it. The moment I gated a
  // control with `const canDecideCandidates = useIsTenantAdmin()` the tag-level
  // test stopped recognising it and reported my own fix as the bug — the fourth
  // time in this work that a detector failed to learn a new idiom. Anything
  // bound from a use*Is/use*Can hook is a gate, whatever it is called, so read
  // the bindings instead of guessing the names.
  const local = localGateNames(src);          // same extraction the file-level pass uses
  const localRe = local.length ? new RegExp('\\b(?:' + local.join('|') + ')\\b') : null;
  const isGate = (s) => GATE_RE.test(s) || (localRe !== null && localRe.test(s));
  // Component boundaries: a top-level `function Name(` at column 0.
  const bounds = [];
  L.forEach((l, i) => { if (/^function [A-Z][A-Za-z0-9_]*\s*[({]/.test(l)) bounds.push(i); });
  const compAt = (line) => {
    let lo = 0;
    for (const b of bounds) { if (b <= line) lo = b; else break; }
    return lo;
  };
  // Handlers, keyed by "componentStart:name" so two `save`s never merge.
  const handlers = new Map();
  for (let i = 0; i < L.length; i++) {
    const m = L[i].match(/^(\s+)const ([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?(?:\(|function)/);
    if (!m) continue;
    // ⚠ A HANDLER BODY ENDS AT THE COMPONENT'S `return`, TOO. The stop
    // pattern was const/function/export at the same indent, so a handler that
    // is the LAST declaration before the JSX kept reading — up to 120 lines —
    // straight through `return (` and into the markup. `submit` in the roster
    // ends at line 215 and never navigates, but the scan swallowed the hire
    // button at 231 and attributed `open workforce_hire` to it. This was
    // never nav-specific either: any handler in that position inherited every
    // RPC and table write rendered below it, which over-attributes silently
    // and is only visible when the action happens to be one you can check.
    const stop = new RegExp('^' + m[1] + '(?:const |function |export |return\\b)');
    let body = '';
    for (let j = i + 1; j < L.length && j - i < 120; j++) {
      if (j > i + 1 && stop.test(L[j])) break;
      body += L[j] + '\n';
    }
    const acts = new Set();
    for (const n of needsGate.keys()) {
      if (body.includes(`rpc('${n}'`) || body.includes(`rpc("${n}"`)) acts.add(n);
    }
    for (const p of navTargets(body)) acts.add(p);   // …and navigations to a restricted page
    for (const a of tableWrites(body)) acts.add(a);   // …and writes straight to a table
    // …and through a lib wrapper, which the direct-rpc scan alone cannot see.
    for (const [fn, rpcs] of Object.entries(wrapperMap)) {
      if (!new RegExp(`\\b${fn}\\s*\\(`).test(body)) continue;
      for (const n of rpcs) if (needsGate.has(n)) acts.add(n);
    }
    if (acts.size) handlers.set(compAt(i) + ':' + m[2], { name: m[2], acts: [...acts], comp: compAt(i) });
  }
  // ⚠ THIS USED TO `return []` WHEN NO HANDLER TOUCHED A GATED ACTION, which
  // skipped the whole tag walk. The control that prompted this pass —
  //     <Button onClick={() => setPage('workforce_hire')}>Hire with AI</Button>
  // — is an INLINE navigation in a file whose named handlers call nothing
  // gated, so the early return would have skipped the very case it was added
  // to catch. The walk below is cheap and judges tags directly; there is no
  // reason it needed a handler to exist first.
  // ⚠ A control is ALSO gated when an ANCESTOR withholds it —
  //     {canDecide && ( <button onClick={decide}/> )}
  //     {!isAdmin ? null : ( <form/> )}
  // — which is the better fix in most cases, because a control that cannot
  // work is usually better absent than greyed out. Judging the tag alone
  // reported four controls I had just gated that way as ungated. An
  // instrument that reports the FIX as the BUG is the failure mode to watch:
  // it is the same shape as the self-test that had to be flipped after the
  // Employee File work.
  const gatedSpans = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '{') continue;
    const head = src.slice(i + 1, i + 200);
    // ⚠ Read the WHOLE condition chain, not the first clause. `{pending.length
    // > 0 && canDecide && (` stops a non-greedy `(&&|\?)` at the first `&&`,
    // leaving `pending.length > 0` — no gate token — so the checker reported
    // four controls I had just gated. Anchor on `&& (` or `?` instead.
    // ⚠⚠ SIXTH IDIOM FAILURE, AND THIS ONE WAS BLIND ON EVERY SURFACE.
    // The anchor was `&&\s*\(` — a gate followed by a PARENTHESISED block:
    //     {canDecide && ( <button …/> )}
    // But the most compact form in this codebase has no parenthesis at all:
    //     {canHire && <Button onClick={() => setPage('workforce_hire')}>…}
    // and that is the exact line I had just written to FIX the hire button.
    // The checker reported my own gate as a missing gate. Worse, this was
    // never nav-specific: any RPC control withheld by `{gate && <Comp …>}`
    // was invisible to the two older surfaces too, for as long as they have
    // existed. Accept `<` as well as `(`.
    const cond = head.match(/^([^{}]*?)(?:&&\s*[(<]|\?)/);
    if (!cond || !isGate(cond[1])) continue;
    // ⚠⚠ A FUNCTION BODY IS NOT A JSX CONDITIONAL. A component opening
    //     { const canManage = useCanManageDe(); const [x] = useState(a ? b : c);
    // matches the pattern above — a gate name, then a `?` — so the whole
    // component body was treated as withheld and EVERY control inside it went
    // silent. Adding the hook to seven components made two real findings
    // vanish, which is the worst failure a checker can have: it got quieter
    // the more code it was asked to judge. A JSX condition is one expression
    // and never contains a statement.
    if (/;|\bconst\b|\blet\b|\breturn\b|\bfunction\b|=>/.test(cond[1])) continue;
    let d = 1, j = i + 1;
    for (; j < src.length && d > 0; j++) {
      if (src[j] === '{') d++; else if (src[j] === '}') d--;
    }
    gatedSpans.push([i, j]);
  }
  const insideGate = (pos) => gatedSpans.some(([a, b]) => pos > a && pos < b);
  // Every JSX opening tag carrying a handler prop, read brace-aware so a tag
  // spanning lines is judged whole — otherwise `disabled={… !canManage}` on
  // the following line reads as absent.
  const out = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '<' || !/[a-zA-Z]/.test(src[i + 1] || '')) continue;
    let d = 0, j = i + 1;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === '{') d++; else if (c === '}') d--; else if (c === '>' && d === 0) break;
    }
    const tag = src.slice(i, j + 1);
    // ⚠⚠ WHICH TAGS ARE CONTROLS.
    //
    // A LOWERCASE tag is native HTML: any on* handler on it is the user acting
    // — click, change, submit — so all of them count.
    //
    // A CAPITALISED tag is a component, and its on* props are two different
    // things wearing one prefix. `<Button onClick={save}>` IS the control;
    // `<SystemCard onChange={() => loadCfg(id)}>` is a REFRESH NOTIFICATION
    // handed to a child that renders its own controls — and that child is
    // examined on its own, so counting the parent reported three refresh
    // callbacks on Browser Operator as dead buttons.
    //
    // I first "fixed" that by ignoring capitalised tags entirely. That threw
    // away the design system: `Button` is how most of this codebase renders a
    // control, so MissionPanel's gates could be deleted outright and the
    // checker stayed silent. Restricting to onClick keeps the primitive and
    // still drops the notification props.
    const lower = /^[a-z]/.test(tag.slice(1));
    // ⚠ A PARENT IS NOT ITS CHILD'S CONTROL. The brace-aware reader above
    // deliberately swallows a whole multi-line tag — which means a component
    // taking JSX in a prop swallows that JSX too:
    //     <PanelCard actions={!adding && (<Button onClick={…}/>)}>
    // The outer tag then appears to carry the inner button's onClick and its
    // action, judged against the OUTER tag's attributes, where no gate lives.
    // That reported the roster's PanelCard as an ungated hire button while
    // the real button two lines below was correctly gated. The nested element
    // is visited on its own iteration of this loop, so attributing it twice
    // adds a false positive and never a true one: judge only what precedes it.
    // ⚠ Search PAST this tag's own opening bracket. `tag.search(/<[A-Za-z]/)`
    // finds index 0 — the `<PanelCard` we are standing on — so the guard
    // `nested > 0` was never true and this whole fix was a no-op that still
    // reported the right number of findings for the wrong reason.
    const rel = tag.slice(1).search(/<[A-Za-z]/);
    const own = rel >= 0 ? tag.slice(0, rel + 1) : tag;
    // ⚠⚠ A COMPONENT'S CONTROL IS NOT ALWAYS CALLED onClick.
    //
    // This used to accept only onClick on a capitalised tag, to drop the
    // refresh callbacks a container hands its children —
    // `<SystemCard onChange={() => loadCfg(id)}>` is a notification, not a
    // button. The cost was everything else: <LiveEmptyState onPrimary> (17
    // call sites, and often the ONLY control on an empty state),
    // <Toggle onChange>, <TabBar onSelect>, <LiveErrorNotice onRetry>. Two
    // real defects hid there — the knowledge-ingestion empty state that was
    // a knowledge specialist's dead end, and the eval-gate dialog's Proving
    // Ground button — and I found both by reading, not by running this.
    //
    // The separation is in the NAMES, and it is a convention this codebase
    // keeps: present tense COMMANDS the component (onChange, onSelect,
    // onPrimary, onRetry, onOpen), past tense REPORTS to the parent
    // (onChanged, onUpdated, onApplied, onSaved, onProposed, onDone), and
    // onClose/onCancel/onDismiss dismiss a dialog. Only commands are
    // controls; the thing that did an onChanged is elsewhere and is judged
    // on its own pass. Verified against all 109 distinct component handler
    // props in the repo before being wired in, and pinned in both
    // directions by the self-test below.
    const compName = (tag.match(/^<([A-Za-z][A-Za-z0-9_]*)/) || [])[1] || '';
    const hasControl = lower
      ? /on[A-Z][a-zA-Z]+\s*=/.test(own)                       // native: any handler is the user acting
      : [...own.matchAll(/\b(on[A-Z][a-zA-Z]+)\s*=/g)].some((m) => isControlProp(compName, m[1]));
    if (!hasControl) continue;
    const line = src.slice(0, i).split('\n').length - 1;
    // Count the comparison BEFORE judging it. `0 findings from 0 comparisons`
    // is indistinguishable from a clean sweep, and both of my earlier
    // instruments failed exactly that way — one compared nothing and reported
    // success. The total is asserted at the end.
    // ⚠ A TOOLTIP IS NOT A GATE. Testing the whole tag for a gate name counts
    //     title={canResolve ? undefined : 'an admin does this'}
    // as enforcement, so a control that EXPLAINS the permission but does not
    // apply it reads as guarded. Caught by a negative test: I stripped
    // `!canResolve` from three buttons that still carried that title and the
    // checker reported nothing. Only the attributes that actually stop a click
    // count — plus withholding the control entirely, which insideGate covers.
    // ⚠ THE ENFORCING LIST HAS TO KNOW THE SAME PROPS THE CONTROL TEST DOES.
    // It named onClick/onChange/onSelect explicitly, so a gate written inside
    // any other command prop was invisible:
    //     onPrimary={canOpenConnectors ? () => setPage('systems_connectors') : undefined}
    // is a real gate — I wrote that one myself — and the checker reported it
    // as ungated because `onPrimary` was not in this list. Two lists that
    // disagree about what a control is, which is the same defect as keeping
    // two definitions of "has a gate". Derive the handler half from the one
    // classifier instead of naming props twice.
    // ⚠ A GATE HANDED TO THE CHILD IS STILL A GATE.
    //     <TrustSurfaceCard canOverride={canOverride} onSaveDial={…} />
    // TrustSurfaceCard's own comment says set_de_autonomy is owner/admin in
    // the database, and it takes the permission as a prop and applies it
    // inside. Judging only disabled/readOnly/handlers reported that as
    // ungated. `can*`/`is*`-NAMED props whose VALUE is a gate expression
    // count too.
    // ⚠ THE PROP NAME MATTERS, NOT JUST THE VALUE. Accepting any attribute
    // carrying a gate token would re-admit the tooltip case this checker was
    // burned by once already —
    //     title={canResolve ? undefined : 'an admin does this'}
    // explains a permission without applying it. A prop actually NAMED for a
    // capability is the permission being passed down; `title` is prose.
    const enforcing = [...tag.matchAll(/\b(disabled|readOnly|aria-disabled|enabled|can[A-Z][a-zA-Z]*|is[A-Z][a-zA-Z]*|on[A-Z][a-zA-Z]+)\s*=\s*(\{(?:[^{}]|\{[^{}]*\})*\})/g)]
      .filter((m) => !/^on[A-Z]/.test(m[1]) || isControlProp(compName, m[1]))
      .map((m) => m[2]).join(' ');
    const guarded = isGate(enforcing) || insideGate(i);
    const seen = new Set();
    for (const h of handlers.values()) {
      if (h.comp !== compAt(line)) continue;                       // scope, not name
      if (!new RegExp(`\\b${h.name}\\s*[(}]`).test(own)) continue;   // own, not tag — see the nesting note above
      for (const a of h.acts) seen.add(a);
    }
    // ⚠ NOT EVERY CONTROL GOES THROUGH A NAMED HANDLER.
    //     onClick={() => void run(() => deleteWatcher(w.id))}
    // reaches the lib wrapper straight from the tag, so the handler map — which
    // only knows `const x = …` declarations — never sees it. A negative test
    // caught this: I removed that button's gate and the checker shrugged.
    for (const [fn, acts] of Object.entries(wrapperMap)) {
      if (!new RegExp(`\\b${fn}\\s*\\(`).test(tag)) continue;
      for (const a of acts) if (needsGate.has(a)) seen.add(a);
    }
    for (const a of tableWrites(own)) seen.add(a);
    for (const p of navTargets(own)) seen.add(p);
    for (const n of needsGate.keys()) {
      if (tag.includes(`rpc('${n}'`) || tag.includes(`rpc("${n}"`)) seen.add(n);
    }
    for (const a of seen) {
      COMPARED.n++;
      COMPARED[COMPARED.area]++;
      if (a.startsWith('open ')) COMPARED.nav++;   // counted apart — see the floor note
      if (!guarded) out.push({ action: a, line: line + 1 });
    }
  }
  return out;
}

for (const [f, src] of Object.entries(FILES)) {
  if (!f.startsWith('src/pages/') && !f.startsWith('src/components/')) continue;
  const comp = path.basename(f).replace(/\.tsx?$/, '');
  if (fileHasGate(src) || gatedByProp.has(comp)) {
    // Partially gated: look at the controls rather than trusting the file.
    const viewers = viewersOf(f);
    if (!viewers.length) { SKIPPED.push(f); continue; }
    COMPARED.area = f.startsWith('src/components/') ? 'components' : 'pages';
    for (const c of controlsMissingGate(src, wrappers)) {
      const allowed = needsGate.get(c.action) || [];
      const refused = viewers.filter((v) => !allowed.includes(v));
      if (refused.length) {
        findings.push({ action: c.action, file: `${f}:${c.line}`, needs: allowed.join('/'), refused: refused.join(', ') });
      }
    }
    continue;
  }
  const hit = new Set();
  for (const name of needsGate.keys()) {
    if (src.includes(`rpc('${name}'`) || src.includes(`rpc("${name}"`)) hit.add(name);
  }
  for (const a of tableWrites(src)) hit.add(a);
  for (const [fn, rpcs] of Object.entries(wrappers)) {
    if (!new RegExp(`\\b${fn}\\s*\\(`).test(src)) continue;
    for (const n of rpcs) if (needsGate.has(n)) hit.add(n);
  }
  if (!hit.size) continue;
  const viewers = viewersOf(f);
  if (DEBUG) console.error(`[debug] ${f}\n         calls: ${[...hit].join(', ')}\n         viewers: ${viewers.length ? viewers.join(', ') : '(none resolved)'}`);
  if (!viewers.length) continue;                 // platform-only or unreachable
  for (const n of hit) {
    const allowed = needsGate.get(n);
    const refused = viewers.filter((v) => !allowed.includes(v));
    if (refused.length) findings.push({ action: n, file: f, needs: allowed.join('/'), refused: refused.join(', ') });
  }
}

// ⚠⚠ ASSERT THE NUMBER OF COMPARISONS, NOT JUST THE NUMBER OF FINDINGS.
// Two earlier instruments reported a clean sweep having examined nothing —
// one because a shell-mangled regex matched no function, one because it only
// looked at direct call sites on pages that delegate. A floor turns "I found
// nothing" into "I looked at N things and found nothing", which are not the
// same claim. Never delete it.
//
// Set well below the current count (63) on purpose. The floor is here to catch
// a scan that has BROKEN — zero, or single digits — not to police ordinary
// refactoring. A floor set just under today's number would abort the build the
// first time someone merged two panels, and a check that cries wolf gets
// deleted, which is how the drift it guards against got here.
const FLOOR = 40;
if (COMPARED.n < FLOOR) {
  console.error(`ABORT: only ${COMPARED.n} control/action pairs compared (floor ${FLOOR}).`);
  console.error('A clean result from too few comparisons is not a clean result. The scan is broken.');
  process.exit(2);
}
// ⚠ AND A FLOOR PER SURFACE. One total hides a surface that has stopped
// working: if navTargets' regex were mangled the way two earlier ones in this
// file were, nav comparisons would fall to zero while the RPC scan alone kept
// the total far clear of 40 — and the run would look clean. Every surface has
// to prove it still looked. Set far below the current 29 for the same reason
// the total is: this catches a BREAK, not a refactor.
const NAV_FLOOR = 8;
if (COMPARED.nav < NAV_FLOOR) {
  console.error(`ABORT: only ${COMPARED.nav} navigation controls compared (floor ${NAV_FLOOR}).`);
  console.error('The page-navigation surface is not being scanned. Check navTargets().');
  process.exit(2);
}
// ── the nav map itself ───────────────────────────────────────────────────
//
// ⚠⚠ THREE PAGES WENT MISSING FROM PAGE_ACCESS AND NOBODY NOTICED.
//
// Adding a page means touching four places: the Page union, the App.tsx route,
// the Sidebar or a tab bar, and PAGE_ACCESS. The first three fail loudly — a
// type error, a blank screen, a missing link. PAGE_ACCESS fails SILENTLY,
// because canAccessPage defaults to DENY:
//
//   my_profile     in the Sidebar, filtered out ⇒ invisible to every role,
//                  including the owner who asked for it
//   organisation   the same, found only because the render-site resolver
//                  started reporting the files it had skipped
//   support_calls  worse — a TAB, not a Sidebar item. Tabs navigate through
//                  handleSetPage, which moves only if canAccessPage agrees, so
//                  the tab rendered, took the click and did NOTHING. No error,
//                  no navigation, nothing to report to support.
//
// Three of a kind is a pattern, not luck. This is cheap; leave it in.
const navGaps = [];
{
  const sidebar = FILES['src/components/Sidebar.tsx'] || '';
  const offered = new Set([...sidebar.matchAll(/page:\s*'([a-z_]+)'/g)].map((m) => m[1]));
  for (const p of offered) if (!(p in pageRoles)) navGaps.push(`${p} (Sidebar)`);
  for (const p of Object.keys(compOfPage)) if (!(p in pageRoles) && !offered.has(p)) navGaps.push(`${p} (routed/tab)`);
}
console.log(`role-gated functions: ${rows.length}   (self-aware, subject always allowed: ${selfAware})`);
console.log(`pages offered in the UI but missing from PAGE_ACCESS: ${navGaps.length}${navGaps.length ? '  ⇒ ' + navGaps.join(', ') : ''}`);
console.log(`controls compared against their action's gate: ${COMPARED.n}   (pages ${COMPARED.pages}, components ${COMPARED.components})`);
console.log(`  of those, controls that OPEN a page: ${COMPARED.nav}`);
// ⚠ Name the files that were skipped. A component whose render site the
// resolver cannot find is indistinguishable from one nobody renders, and
// silence there is how a whole file goes unexamined while the report reads
// clean. Nine components reach a gated action and all nine resolved a parent
// on 2026-08-07 — if that list stops being empty, read it.
if (SKIPPED.length) console.log(`files skipped, no render site resolved: ${SKIPPED.join(', ')}`);
console.log(`UI call sites offering a gated action with no role check: ${findings.length}\n`);
// Print what it needs and who it refuses. Without those two columns the
// report says a control is wrong but not how to fix it, and the wrong hook
// (admin where manager is allowed) removes a capability someone really had.
for (const f of findings) {
  console.log(`  ${f.action}  ←  ${f.file}`);
  console.log(`      needs ${f.needs}   ·   refuses ${f.refused}`);
}
if (!findings.length) console.log('  none — every gated action reached from the UI sits behind a role check');

if (STRICT && (findings.length || navGaps.length)) process.exit(1);
