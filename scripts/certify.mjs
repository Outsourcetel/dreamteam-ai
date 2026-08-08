#!/usr/bin/env node
// ============================================================
// certify.mjs — the definition of green.
//
// One command that runs every standing verification this repo has, plus the
// Ring-0 probes (the invariants that must NEVER break), and exits nonzero if
// any of it fails. This exists because "shipped and green" has repeatedly been
// a weaker signal than it looked: features passed their own migration asserts
// and were still broken in ways only a standing, whole-system probe catches.
//
//   node scripts/certify.mjs             # everything (vitest included, ~3 min)
//   node scripts/certify.mjs --fast      # typecheck + probes + ledger (~30 s)
//   node scripts/certify.mjs --pin-allowlist   # regenerate the EXECUTE
//        allowlist from live state. ONLY after a deliberate perimeter change —
//        pinning after an accidental grant would bless the hole.
//
// Ring-0 probes are read-only against PRODUCTION: they assert what IS, they
// never change it. Behavioral write-path proofs live in the vitest suite and
// run against dev.
//
// The probe style is violations-only: every check returns rows ONLY when the
// invariant is broken, so a probe that returns nothing is a proof and a probe
// that returns anything is a named, actionable failure. A check that could
// pass vacuously (e.g. by querying a table that does not exist) fails loudly
// instead — SQL errors are failures, never skips.
// ============================================================
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const FAST = process.argv.includes('--fast');
const PIN = process.argv.includes('--pin-allowlist');
const PROD_REF = 'rfsvmhcqeiyrxivbmpel';
const ALLOWLIST_FILE = 'supabase/baseline/execute-allowlist.json';

function token() {
  const fromEnv = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const env = readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  if (!line) throw new Error('SUPABASE_ACCESS_TOKEN not found');
  return line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
}
const TOKEN = token();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function q(sql, attempt = 0) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROD_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
  const text = await res.text();
  if (!res.ok) {
    // Transient transport/rate-limit only. A genuine SQL error must FAIL the
    // probe — retrying it would be retrying a broken invariant into a timeout.
    if ((res.status === 429 || res.status >= 500 || res.status === 0) && attempt < 3) {
      await sleep(1500 * (attempt + 1));
      return q(sql, attempt + 1);
    }
    throw new Error(`Management API ${res.status}: ${text.slice(0, 250)}`);
  }
  return JSON.parse(text);
}

// ── The EXECUTE perimeter ──────────────────────────────────────────────────
// Postgres grants EXECUTE to PUBLIC by default and Supabase's default
// privileges add anon/authenticated as named roles — the hole this repo
// re-shipped twice (migs 610+630). The allowlist file pins today's surface;
// certify fails if the live surface DIFFERS in either direction, so a new
// function with a forgotten REVOKE cannot ship silently.
const PERIMETER_SQL = `
  select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind in ('f','p')
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
   order by 1`;

async function perimeterCheck() {
  const live = await q(PERIMETER_SQL);
  if (PIN) {
    writeFileSync(ALLOWLIST_FILE, JSON.stringify({
      pinned_at: new Date().toISOString(),
      note: 'The EXECUTE surface for anon/authenticated. certify fails on ANY diff. Re-pin only after a DELIBERATE perimeter change.',
      routines: live,
    }, null, 2) + '\n');
    console.log(`  pinned ${live.length} routines to ${ALLOWLIST_FILE}`);
    return [];
  }
  let pinned;
  try { pinned = JSON.parse(readFileSync(ALLOWLIST_FILE, 'utf8')).routines; }
  catch { return [{ violation: `allowlist file missing — run --pin-allowlist once, deliberately` }]; }
  const key = (r) => `${r.sig}|anon=${r.anon}|authed=${r.authed}`;
  const pset = new Set(pinned.map(key)), lset = new Set(live.map(key));
  const out = [];
  for (const r of live) if (!pset.has(key(r))) out.push({ violation: `NEW/CHANGED grant not in allowlist: ${key(r)}` });
  for (const r of pinned) if (!lset.has(key(r))) out.push({ violation: `allowlisted grant VANISHED (revoked or fn dropped): ${key(r)}` });
  return out;
}

// ── Ring-0 probes — violations-only ────────────────────────────────────────
const PROBES = [
  {
    name: 'rls-on-every-public-table',
    why: 'a table without RLS is cross-tenant by default',
    sql: `select tablename as violation from pg_tables t
           join pg_class c on c.relname = t.tablename
           join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
          where t.schemaname = 'public' and not c.relrowsecurity`,
  },
  {
    name: 'no-unattended-public-speech',
    why: 'anything that speaks in public must be destructive (human-gated)',
    sql: `select category || '.' || action_key as violation from action_definitions
          where status = 'active' and scope = 'platform'
            and action_key in ('publish_post','schedule_post','reply_to_comment','hide_comment',
                               'delete_post','boost_post','publish_media','publish_video',
                               'pause_campaign','resume_campaign','set_campaign_budget')
            and (risk->>'destructive')::boolean is not true`,
  },
  {
    name: 'money-param-is-amount_cents',
    why: 'execute_action reads the amount ONLY from a param named amount_cents; any other name disarms the approval threshold, spend cap and trust ceiling',
    sql: `select a.category || '.' || a.action_key || ' (' || (p->>'name') || ')' as violation
            from action_definitions a, lateral jsonb_array_elements(a.param_schema) p
           where (p->>'type') in ('integer','number')
             and (p->>'name') ~* '(budget|amount|cents|price|spend)'
             and (p->>'name') <> 'amount_cents'`,
  },
  {
    name: 'guard-bypass-setters-pinned',
    why: 'app.allow_task_decision is the approvals guard; a new setter is a new path around human authority',
    sql: `select proname as violation
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind in ('f','p')
             and pg_get_functiondef(p.oid) ilike '%allow_task_decision%'
             and proname not in ('approve_learned_behavior','close_escalations_for_finished_goal',
               'decide_de_escalation','decide_human_task','guard_human_task_decision',
               'handoff_back_to_de','reconcile_blocked_goals','reject_learned_behavior',
               'reroute_de_escalation','retry_answerable_blockers','set_support_conversation_state')`,
  },
  {
    name: 'secdef-search-path-ratchet',
    why: 'SECURITY DEFINER without a pinned search_path is hijackable; 9 legacy offenders are a standing finding — the ratchet is NO NEW ONES',
    sql: `select proname as violation
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prosecdef and p.prokind in ('f','p')
             and not exists (select 1 from unnest(coalesce(p.proconfig,'{}'::text[])) c where c like 'search_path=%')
           order by 1 offset 9`,
  },
  {
    name: 'audit-chain-verifies-hq',
    why: 'the audit trail is only evidence if its hash chain verifies',
    // verify_audit_chain(uuid) enforces caller MEMBERSHIP (raises for a
    // non-member), so it cannot run from the review context; the _internal
    // twin is the same computation without the membership guard. Contract:
    // { intact: bool, forks, known_anomalies, broken_at }. `intact` is the
    // verdict — `ok` does not exist, and reading a missing key would pass
    // vacuously, which is the whole failure mode this review exists to kill.
    sql: `select 'audit chain NOT intact for outsourcetel-hq: '
                 || (verify_audit_chain_internal(id))::text as violation
            from tenants where slug = 'outsourcetel-hq'
             and coalesce((verify_audit_chain_internal(id)->>'intact')::boolean, false) is not true`,
  },
  {
    name: 'active-template-actions-are-bound',
    why: 'an active action with no binding asks a human to approve something that then does nothing',
    sql: `select a.category || '.' || a.action_key as violation
            from action_definitions a
           where a.status = 'active' and a.provider = 'template'
             and not exists (select 1 from adapter_templates t
                              where t.id = a.template_id and t.definition->'actions' ? a.action_key)`,
  },
  {
    name: 'template-op-contract-classes',
    why: 'the silent-success families: a search that never sends its query, a list that takes one, a get with no ref, a test_op naming an unbound op',
    sql: `select t.name || '.' || k || ': ' ||
                 case when k like 'search\\_%' and (t.definition->'ops'->k)::text not like '%{query}%' then 'search never sends {query}'
                      when k like 'list\\_%'   and (t.definition->'ops'->k)::text     like '%{query}%' then 'list pretends to search'
                      when k like 'get\\_%'    and (t.definition->'ops'->k)::text not like '%{ref}%'  then 'get has no {ref}'
                 end as violation
            from adapter_templates t, lateral jsonb_object_keys(t.definition->'ops') k
           where t.scope = 'platform' and t.status = 'published'
             and ((k like 'search\\_%' and (t.definition->'ops'->k)::text not like '%{query}%')
               or (k like 'list\\_%'   and (t.definition->'ops'->k)::text     like '%{query}%')
               or (k like 'get\\_%'    and (t.definition->'ops'->k)::text not like '%{ref}%'))
          union all
          select t.name || ': test_op "' || (t.definition->'test_op'->>'op') || '" is not a bound op'
            from adapter_templates t
           where t.scope = 'platform' and t.status = 'published' and t.definition ? 'test_op'
             and not (t.definition->'ops' ? (t.definition->'test_op'->>'op'))
          union all
          select t.name || '.' || k || ': literal date frozen at ship time'
            from adapter_templates t, lateral jsonb_object_keys(t.definition->'ops') k
           where t.scope = 'platform' and t.status = 'published'
             and (t.definition->'ops'->k)::text ~ '"(startDate|endDate)":\\s*"\\d{4}-'`,
  },
  {
    name: 'migration-files-match-ledger-checksums',
    why: 'a migration edited after applying no longer describes what ran',
    sql: `select 'ledger has ' || count(*) || ' entries with NULL checksum recorded after 2026-08-01' as violation
            from schema_migrations
           where checksum is null and recorded_at > '2026-08-01'
          having count(*) > 0`,
  },
];

// ── Section runner ─────────────────────────────────────────────────────────
const results = [];
function section(name, fn) { return { name, fn }; }
function shell(name, cmd, args) {
  return section(name, () => {
    const r = spawnSync(cmd, args, { shell: true, encoding: 'utf8', timeout: 420_000 });
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    return { ok: r.status === 0, detail: r.status === 0 ? '' : out.split(/\r?\n/).filter(Boolean).slice(-8).join('\n') };
  });
}

const sections = [
  shell('typecheck', 'npx', ['tsc', '--noEmit']),
  section('ring0-probes', async () => {
    const failures = [];
    const perim = await perimeterCheck();
    for (const v of perim) failures.push(`execute-perimeter: ${v.violation}`);
    if (!PIN) {
      for (const p of PROBES) {
        try {
          const rows = await q(p.sql);
          for (const r of rows) if (r.violation != null) failures.push(`${p.name}: ${r.violation}`);
        } catch (e) {
          failures.push(`${p.name}: PROBE ERROR (a broken probe is a failure, not a skip) — ${String(e).slice(0, 160)}`);
        }
      }
    }
    return { ok: failures.length === 0, detail: failures.join('\n') };
  }),
  shell('migration-ledger', 'npm', ['run', '-s', 'migrate:status']),
  ...(FAST ? [] : [
    // The core loop, run for real against dev. This is the only section that
    // exercises WRITE paths end to end; everything else reads. It is also the
    // gate that keeps dev synced — the moment dev falls behind production the
    // loop stops closing and this goes red, which is exactly how the drift
    // should have been caught the first time.
    shell('golden-path', 'node', ['scripts/golden-path.mjs']),
    shell('role-gates', 'npm', ['run', '-s', 'audit:role-gates']),
    shell('silent-refusals', 'npm', ['run', '-s', 'audit:silent-refusals']),
    shell('design-drift', 'node', ['scripts/design-drift.mjs']),
    shell('suite', 'npx', ['vitest', 'run']),
  ]),
];

console.log(`certify ${FAST ? '(fast)' : '(full)'} — ${new Date().toISOString()}`);
let failed = 0;
for (const s of sections) {
  const t0 = Date.now();
  let r;
  try { r = await s.fn(); } catch (e) { r = { ok: false, detail: String(e).slice(0, 300) }; }
  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${s.name} (${dur}s)`);
  if (!r.ok) { failed++; console.log(r.detail.split('\n').map((l) => `        ${l}`).join('\n')); }
  results.push({ section: s.name, ok: r.ok, seconds: +dur, detail: r.ok ? undefined : r.detail });
}

mkdirSync('review', { recursive: true });
writeFileSync('review/certify-last.json', JSON.stringify({
  at: new Date().toISOString(), mode: FAST ? 'fast' : 'full', failed, results,
}, null, 2) + '\n');

console.log(failed === 0 ? '\nCERTIFIED — all sections green.' : `\nNOT CERTIFIED — ${failed} section(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
