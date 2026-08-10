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
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const FAST = process.argv.includes('--fast');
const PIN = process.argv.includes('--pin-allowlist');
const PIN_EDGE = process.argv.includes('--pin-edge');
const OFFLINE = process.argv.includes('--offline');
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
// Resolved at module load, which is right for every credentialed mode — a
// missing token should stop the run, not surface as a confusing failure inside
// one probe. But --offline runs NOTHING that talks to production, and CI has no
// .env.local, so demanding a token there would make the offline gate
// unrunnable in the one place it exists to run.
const TOKEN = OFFLINE ? null : token();
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
    name: 'role-restricted-actions-stay-restricted',
    why: 'the offer list IS the authorisation boundary — decide_action_execution gates destructive/trust/budget but never asks whether THIS employee may use this action, so a mis-scoped offer is a mis-granted permission (mig 643: 22 employees, incl. Marketing and Accounting, could hire staff)',
    sql: `select t.slug || ' / ' || de.name || ' → ' || ad.action_key as violation
            from digital_employees de
            join tenants t on t.id = de.tenant_id
            cross join lateral jsonb_array_elements(
              public.get_agentic_tools_for_de(de.tenant_id, de.id)) x
            join action_definitions ad on ad.id = (x->>'action_definition_id')::uuid
           where t.status = 'active'
             and ad.requires_role is not null
             -- ⚠ mig 669 INVALIDATED this probe's original form, and the probe
             -- correctly went red rather than quietly widening. It used to read
             -- "and not coalesce(de.is_workforce_assistant, false)" — i.e. it
             -- hardcoded "restricted implies workforce_assistant", true when 643
             -- was the only requirement and false the moment 'finance' existed.
             -- It now flagged the finance desk holding finance verbs, which is
             -- the intended state.
             --
             -- ⚠ BE PRECISE ABOUT WHAT THIS CAN AND CANNOT CATCH. I first wrote
             -- that it independently validates every offer. Mutation-testing
             -- disproved that: get_agentic_tools_for_de FILTERS through
             -- de_may_use_action, so an action the gate refuses never reaches
             -- the offer list and this probe sees nothing — clearing a
             -- requires_role in a rolled-back transaction produced 0 rows here.
             --
             -- What it DOES catch is the gate DIVERGING from the mapping below:
             -- a permissive regression, or a new requires_role arm added to the
             -- function and not here. Proven, not assumed — replacing
             -- de_may_use_action with "select true" inside a rolled-back
             -- transaction lit up 104 violations, "Onboarding DE →
             -- send_final_notice" first. That is the failure worth guarding:
             -- the day someone loosens the gate, this names who gained what.
             -- Deliberately NOT written as a call to de_may_use_action — asking
             -- the gate whether it agrees with itself is the tautology this
             -- repo keeps paying for.
             and not (
               (ad.requires_role = 'workforce_assistant'
                 and coalesce(de.is_workforce_assistant, false))
               or (ad.requires_role = 'finance'
                 and coalesce(de.archetype_key, '') in ('billing_ar', 'accounting', 'fpa'))
             )`,
  },
  {
    name: 'onboarding-bindings-are-runnable',
    why: 'a checklist item that names a verb nobody can run is a promise that breaks at 2am, in front of a customer — and the template author never finds out',
    sql: `select t.slug || ' / ' || v.name || ' / ' || (i->>'key')
                 || ' → ' || (i->>'action_key') as violation
            from onboarding_template_versions v
            join tenants t on t.id = v.tenant_id
            cross join lateral jsonb_array_elements(v.items) i
           where i ? 'action_key'
             and not exists (
               select 1 from action_definitions ad
                where ad.action_key = i->>'action_key'
                  and ad.status = 'active'
                  and (ad.tenant_id is null or ad.tenant_id = v.tenant_id))`,
  },
  {
    name: 'workspace-admin-has-an-owner',
    why: 'the other half — restricting the admin verbs to one role is only safe if that role can actually reach them; without this, closing the hole silently leaves a workspace administrable by nobody',
    sql: `select t.slug as violation
            from tenants t
           where t.status = 'active'
             and exists (select 1 from connectors c
                          where c.tenant_id = t.id and c.status = 'connected'
                            and c.category = 'platform_admin')
             and exists (select 1 from digital_employees d
                          where d.tenant_id = t.id and coalesce(d.is_workforce_assistant, false))
             and not exists (
               select 1 from digital_employees de
               cross join lateral jsonb_array_elements(
                 public.get_agentic_tools_for_de(de.tenant_id, de.id)) x
               join action_definitions ad on ad.id = (x->>'action_definition_id')::uuid
              where de.tenant_id = t.id
                and coalesce(de.is_workforce_assistant, false)
                and ad.requires_role = 'workforce_assistant')`,
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
    name: 'secdef-caller-tenant-ratchet',
    why: 'R0.8. SECURITY DEFINER bypasses RLS, so a function that is reachable by `authenticated`, takes an id from its caller, and never derives the CALLER\'s tenant has made that parameter the authorisation. 27 such routines were reachable in production until mig 662 — they returned another tenant\'s playbook text, open invoices with customer names, and its whole org tree. The 41 named below were each read line by line and cleared; the ratchet is NO NEW ONES. To add a name here you must first read the body and be able to say why the caller cannot steer it.',
    sql: `select proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as violation
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind in ('f','p') and p.prosecdef
             and has_function_privilege('authenticated', p.oid, 'EXECUTE')
             and pg_get_function_identity_arguments(p.oid) like '%uuid%'
             and p.prosrc not ilike '%auth_tenant_id%'
             and p.prosrc not ilike '%auth.uid%'
             and p.prosrc not ilike '%can_access_de%'
             and p.prosrc not ilike '%is_platform_admin%'
             and p.proname not in (
               'apply_config_template','apply_playbook_amendment','clear_de_operate_login',
               'count_pending_knowledge_gaps','create_config_schema','delete_custom_metric',
               'delete_de_operate_binding','export_tenant_config','get_config_audit_log',
               'get_config_schema','get_de_config','get_de_metrics_batch','get_metric_trend',
               'get_metric_value','get_metrics_anomalies','get_platform_shelf_doc',
               'get_quality_score_breakdown','get_sla_achievement','get_tenant_config_status',
               'get_tenant_metrics_comparison','install_role_systems','is_ancestor_of',
               'list_config_schemas','list_de_operate_config','list_org_tree','match_cached_answer',
               'match_doc_chunks','reject_playbook_amendment',
               'resolve_account_writeback','resolve_continuity_writeback','resolve_opportunity_writeback',
               'scim_tokens_list','set_de_operate_login','tenant_ancestors',
               'tenant_descendants','update_custom_metric','upsert_de_operate_binding',
               -- ⚠ validate_watcher_config STAYS, and not because it was cleared by
               -- the same reading that wrongly cleared submit_csat. It is read-only
               -- (STABLE, writes nothing) and is reached by trg_validate_work_watcher
               -- → validate_work_watcher, which is SECURITY INVOKER — so the admin
               -- doing the INSERT must retain EXECUTE or every watcher create and
               -- edit fails across 15 workspaces. A pg_depend sweep does not show
               -- this: the dependency is one hop deeper than a direct reference.
               'validate_watcher_config','visible_knowledge_docs')
               -- REMOVED by mig 664, because the exemption was wrong, not because
               -- the routines changed shape: submit_csat (cross-tenant WRITE) and
               -- platform_capability_remaining_holders (platform-staff oracle).
               -- Both are now revoked, so they drop out of the sieve on their own.
           order by 1`,
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

// ── Edge functions: a per-function type-error ratchet ──────────────────────
// `tsc --noEmit` EXCLUDES supabase/functions, so 59 Deno entrypoints were
// type-checked by nothing. de-work carried 13 errors for weeks and no gate saw
// them. Checking all 59 in ONE deno invocation shares the module graph, which
// is the difference between ~30s and several minutes.
//
// A hard "zero errors everywhere" bar would be red on day one (16 functions,
// 58 errors) and would simply be switched off. So: every function has a pinned
// ceiling. Exceeding it FAILS. Coming in under it is reported as a ratchet
// opportunity — fix, then `--pin-edge` to lock the gain in. A function pinned
// at 0 can never regress.
const EDGE_BASELINE_FILE = 'supabase/baseline/edge-typecheck.json';

function edgeErrorCounts() {
  const fns = readdirSync('supabase/functions', { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== '_shared')
    .map((d) => d.name)
    .filter((n) => existsSync(`supabase/functions/${n}/index.ts`))
    .sort();

  const r = spawnSync('npx',
    ['deno', 'check', ...fns.map((n) => `supabase/functions/${n}/index.ts`)],
    { shell: true, encoding: 'utf8', timeout: 570_000, maxBuffer: 64 * 1024 * 1024 });
  const out = ((r.stdout ?? '') + (r.stderr ?? '')).replace(/\x1b\[[0-9;]*m/g, '');

  // ONE location per error. A TS error block can carry several `at file` lines
  // (the fault plus a related site); counting them all made the same code total
  // 66 attributions for 58 errors, and a ratchet that cannot count the same
  // thing twice the same way is not a ratchet.
  const counts = Object.fromEntries(fns.map((n) => [n, 0]));
  const blocks = out.split(/^(?=TS\d+ )/m).filter((b) => /^TS\d+ /.test(b));
  let unattributed = 0;
  for (const b of blocks) {
    const m = b.match(/at file:\/\/\/.*?supabase\/functions\/([^/]+)\/index\.ts:/);
    if (m && counts[m[1]] !== undefined) counts[m[1]]++;
    else unattributed++;
  }
  return { counts, total: blocks.length, unattributed, fns };
}

// ── The outbound pipe must stay unreachable from the internet ──────────────
// pg_net (schema `net`) can make OUTBOUND HTTP requests, and every net function
// plus the request queue is granted to PUBLIC — which includes anon. We CANNOT
// revoke that: `net` is owned by supabase_admin, and a REVOKE running as
// postgres is a silent no-op (proven, not assumed). The ONLY thing standing
// between PUBLIC's grant and a live server-side-request-forgery primitive is
// that `net` is not in PostgREST's exposed-schema list — a project-config
// setting, not a database grant. That setting has no representation in the DB,
// so no SQL probe can see it. This one does the only check that matters: it
// asks the REST API, as the anonymous internet, whether `net` answers. The day
// someone flips the config, this goes red.
function envVar(name) {
  for (const f of ['.env.local', '.env']) {
    try {
      const line = readFileSync(f, 'utf8').replace(/^﻿/, '')
        .split(/\r?\n/).find((l) => l.startsWith(name + '='));
      if (line) return line.slice(name.length + 1).replace(/^["']|["']$/g, '').trim();
    } catch { /* file may not exist (CI) */ }
  }
  return null;
}

async function netExposureFailures() {
  const anon = envVar('VITE_SUPABASE_ANON_KEY') ?? envVar('SUPABASE_ANON_KEY');
  const base = `https://${PROD_REF}.supabase.co`;
  if (!anon) {
    // No key (e.g. CI without .env). Skip LOUDLY — never a silent pass.
    return [{ note: 'net-not-exposed: SKIPPED — no anon key available to probe the REST surface (not a pass)' }];
  }
  const h = { apikey: anon, Authorization: `Bearer ${anon}` };
  let netStatus;
  try {
    netStatus = (await fetch(`${base}/rest/v1/http_request_queue?select=id&limit=1`,
      { headers: { ...h, 'Accept-Profile': 'net' } })).status;
  } catch (e) {
    return [{ note: `net-not-exposed: SKIPPED — REST probe could not reach the API (${String(e).slice(0, 80)})` }];
  }
  // ⚠ NO SEPARATE CONTROL REQUEST, deliberately. The first version used a
  // public view as its control; migration 665 then revoked anon's access to
  // that view, the control went 401, and the probe silently disarmed itself.
  // A control must never depend on a grant that hardening may remove.
  // Instead the status code IS the evidence, because PostgREST distinguishes:
  //   406 → the API answered and refused the schema  = not exposed  = PASS
  //   200 → the schema is exposed to the anonymous internet         = FAIL
  //   else (401/403/5xx) → we cannot tell            = SKIP, LOUDLY
  if (netStatus === 200) {
    return [{ violation: `schema \`net\` is REACHABLE over REST (HTTP 200) while PUBLIC holds EXECUTE — an anonymous outbound-request primitive. Remove \`net\` from the project's exposed schemas (it cannot be fixed with a REVOKE; supabase_admin owns it).` }];
  }
  if (netStatus !== 406) {
    return [{ note: `net-not-exposed: SKIPPED — got HTTP ${netStatus}, which distinguishes nothing (406 = closed, 200 = exposed). NOT a pass.` }];
  }
  return [];
}

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

// --offline: only the sections that need NO credentials, so CI can run the real
// gate on every push instead of waiting for someone to remember. It is a SUBSET,
// never a substitute — the banner says which mode ran, because a bar that does
// not say what it skipped is the false-green this whole exercise exists to kill.
const OFFLINE_SECTIONS = new Set(['typecheck', 'edge-typecheck', 'design-drift', 'suite']);

const sections = [
  shell('typecheck', 'npx', ['tsc', '--noEmit']),
  section('ring0-probes', async () => {
    const failures = [];
    const perim = await perimeterCheck();
    for (const v of perim) failures.push(`execute-perimeter: ${v.violation}`);
    // The outbound-pipe exposure check — REST, not SQL, because the gate it
    // guards is config, not a grant. A `note` is surfaced but does not fail.
    for (const r of await netExposureFailures()) {
      if (r.violation) failures.push(`net-not-exposed: ${r.violation}`);
      else if (r.note) console.log(`        ${r.note}`);
    }
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
  // ── No NEW duplicate migration numbers ─────────────────────────────────
  // Two agents computing `ls | tail -1` both pick the same number. It has
  // happened 19 times in this repo's history (514, 520, 526, 540-544, 574-577,
  // …) and twice on 2026-08-10 alone. It is a RATCHET, not a clean-sweep: the
  // existing 19 cannot be renamed, because public.schema_migrations keys on
  // FILENAME and renaming an applied migration turns it into an ORPHANED
  // ledger row plus a PENDING file. So the rule is only: no new ones.
  // `npm run migrate:next` is what prevents them; this is what catches them.
  section('migration-numbering', () => {
    // NAMED, not counted. A bare ceiling can be nudged up by anyone in a hurry
    // and says nothing about what collided; a list forces whoever adds to it to
    // write down which pair and why it could not be undone.
    //
    // ⚠ EVERY ENTRY HERE IS PERMANENT DEBT, NOT A BUDGET. A duplicate can only
    // be added when BOTH files are already applied to production — because
    // public.schema_migrations keys on FILENAME, renaming an applied migration
    // turns it into an ORPHANED ledger row plus a PENDING file. If a collision
    // is caught BEFORE either half is applied, rename it and do NOT list it.
    const KNOWN_DUPLICATES = new Set([
      // Inherited: months of `ls | tail -1`, all long since applied.
      '20260720', '514', '520', '526', '540', '541', '542', '543', '544',
      '574', '575', '576', '577', '578', '582', '583', '584', '585', '586',
      // 2026-08-10 — and this one is a DEFEAT worth reading, because it is the
      // collision the new convention was built to stop, one hour after it
      // shipped. Two agents on one repo: 669_park_and_snooze applied 09:04:41,
      // 669_an_onboarding_agent_must_not_send_a_final_demand applied 09:06:03.
      // `npm run migrate:next` DID return 669 correctly — it only binds the
      // agent who runs it, and the other session had not pulled it yet. Both
      // were in production before either tree saw the other, so neither can be
      // renamed. A convention only holds once everyone has it.
      '669',
    ]);
    const names = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql'));
    const byNum = new Map();
    for (const n of names) {
      const m = /^(\d+)_/.exec(n);
      if (!m) continue;
      if (!byNum.has(m[1])) byNum.set(m[1], []);
      byNum.get(m[1]).push(n);
    }
    const dups = [...byNum.entries()].filter(([, fs]) => fs.length > 1);
    const fresh = dups.filter(([k]) => !KNOWN_DUPLICATES.has(k));
    if (fresh.length) {
      return {
        ok: false,
        detail: `${fresh.length} NEW duplicate migration number(s). Claim numbers with:\n`
          + `    npm run migrate:next -- my_change\n`
          + `If neither half is applied to production yet, RENAME one — do not add it below.\n`
          + fresh.map(([k, fs]) => `  ${k}: ${fs.join(' , ')}`).join('\n'),
      };
    }
    // Ratchet down: a listed number that no longer collides should be removed.
    const stale = [...KNOWN_DUPLICATES].filter((k) => !dups.some(([d]) => d === k));
    if (stale.length) {
      return { ok: true, detail: `no longer duplicated — drop from KNOWN_DUPLICATES: ${stale.join(', ')}` };
    }
    return { ok: true, detail: '' };
  }),
  section('edge-typecheck', () => {
    const { counts, total, unattributed, fns } = edgeErrorCounts();
    if (PIN_EDGE) {
      writeFileSync(EDGE_BASELINE_FILE, JSON.stringify({
        pinned_at: new Date().toISOString(),
        note: 'Per-edge-function deno type-error CEILING. certify fails if any function exceeds its number. Ratchet DOWN only — fix, then re-pin. A function at 0 must stay at 0.',
        total_at_pin: total,
        counts,
      }, null, 2) + '\n');
      return { ok: true, detail: `pinned ${fns.length} functions, ${total} error(s)` };
    }
    let pinned;
    try { pinned = JSON.parse(readFileSync(EDGE_BASELINE_FILE, 'utf8')).counts; }
    catch { return { ok: false, detail: `baseline missing — run --pin-edge once, deliberately` }; }

    const regressions = [], improvements = [], added = [];
    for (const [fn, n] of Object.entries(counts)) {
      const ceiling = pinned[fn];
      if (ceiling === undefined) { if (n > 0) added.push(`${fn}: NEW function with ${n} error(s)`); continue; }
      if (n > ceiling) regressions.push(`${fn}: ${n} error(s), ceiling ${ceiling}`);
      else if (n < ceiling) improvements.push(`${fn}: ${ceiling} -> ${n}`);
    }
    if (unattributed > 0) improvements.push(`(${unattributed} error(s) not attributable to a function entrypoint)`);
    const bad = [...regressions, ...added];
    if (improvements.length) {
      console.log(`        ratchet available — re-pin with --pin-edge: ${improvements.slice(0, 4).join('; ')}`);
    }
    return {
      ok: bad.length === 0,
      detail: bad.join('\n'),
    };
  }),
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
    // OFFLINE runs only the credential-free test files. `npx vitest run` sweeps
    // ALL of tests/**, and two of those hard-throw at module load without
    // credentials — knowledge-acl-invariants.test.ts:29 (adminTokenAvailable)
    // and setup.ts (.env.test), neither of which exists in a CI checkout. So a
    // bare vitest run in --offline mode would have gone red on every push for a
    // MISSING-SECRET reason, which is the "tick everyone learns to ignore"
    // failure this whole phase exists to remove. Caught by mutation-testing the
    // gate rather than by CI failing later.
    OFFLINE
      ? shell('suite', 'npm', ['run', '-s', 'test:unit'])
      : shell('suite', 'npx', ['vitest', 'run']),
  ]),
];

const active = OFFLINE ? sections.filter((s) => OFFLINE_SECTIONS.has(s.name)) : sections;
const skipped = sections.length - active.length;

console.log(`certify ${OFFLINE ? '(OFFLINE SUBSET)' : FAST ? '(fast)' : '(full)'} — ${new Date().toISOString()}`);
if (OFFLINE) {
  console.log(`  running ${active.length} credential-free section(s); ${skipped} section(s) NOT RUN and NOT PROVEN here.`);
}
let failed = 0;
for (const s of active) {
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
  at: new Date().toISOString(), mode: OFFLINE ? 'offline' : FAST ? 'fast' : 'full', failed, results,
}, null, 2) + '\n');

console.log(
  failed !== 0
    ? `\nNOT CERTIFIED — ${failed} section(s) failed.`
    : OFFLINE
      // Never let a subset claim the word. This banner is the difference
      // between "CI is green" and "CI proved the things CI can prove".
      ? `\nOFFLINE SUBSET GREEN — ${active.length}/${sections.length} sections. NOT a full certification: ${skipped} section(s) need credentials and did not run.`
      : '\nCERTIFIED — all sections green.');
process.exit(failed === 0 ? 0 : 1);
