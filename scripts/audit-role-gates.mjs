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
const compOfPage = {}; {
  const re = /case\s+'([a-z_]+)':\s*(?:\n\s*)?return\s*<([A-Za-z0-9_]+)/g;
  let m; while ((m = re.exec(app)) !== null) compOfPage[m[1]] = m[2];
}
const fileOfComp = {}; {
  const re = /import\s+(?:\{\s*([^}]+)\s*\}|([A-Za-z0-9_]+))\s+from\s+'(\.[^']+)'/g;
  let m; while ((m = re.exec(app)) !== null) {
    const names = (m[1] || m[2] || '').split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    for (const n of names) fileOfComp[n] = path.posix.join('src', m[3].replace(/^\.\//, ''));
  }
}
const ext = (b) => ['.tsx', '.ts'].map((x) => b + x).find((c) => FILES[c]);
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
  const comp = path.basename(file).replace(/\.tsx?$/, '');
  let widest = [];
  for (const [f2, b] of Object.entries(FILES)) {
    if (f2 === file) continue;
    if (!new RegExp(`<${comp}[\\s/>]`).test(b)) continue;
    const up = viewersOf(f2, depth + 1);
    if (up.length > widest.length) widest = up;
  }
  return widest;
}

for (const [f, src] of Object.entries(FILES)) {
  if (!f.startsWith('src/pages/') && !f.startsWith('src/components/')) continue;
  const comp = path.basename(f).replace(/\.tsx?$/, '');
  if (GATE_RE.test(src) || gatedByProp.has(comp)) continue;
  const hit = new Set();
  for (const name of needsGate.keys()) {
    if (src.includes(`rpc('${name}'`) || src.includes(`rpc("${name}"`)) hit.add(name);
  }
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

console.log(`role-gated functions: ${rows.length}   (self-aware, subject always allowed: ${selfAware})`);
console.log(`UI call sites offering a gated action with no role check: ${findings.length}\n`);
for (const f of findings) console.log(`  ${f.action}  ←  ${f.file}`);
if (!findings.length) console.log('  none — every gated action reached from the UI sits behind a role check');

if (STRICT && findings.length) process.exit(1);
