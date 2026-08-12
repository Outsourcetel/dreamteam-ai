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
// mig 679's ratchet. The pin list, its reasons and the probe SQL live in ONE
// file, imported by BOTH this gate and certify-mutation-test.mjs — so the
// mutation test exercises the real query, not a paraphrase of it.
import { landedPredicateSql } from './landed-predicate.mjs';
import { productionEvidenceSql } from './production-evidence.mjs';
import { bareContainerLiteralSql } from './bare-container-literal.mjs';
import { unexecutableApprovalSql } from './unexecutable-approval.mjs';
import { advisoryBoundarySql } from './advisory-boundary.mjs';
import { trustProposerBoundarySql } from './trust-proposer-boundary.mjs';
import { gapGateConductSql, auditedStepsWritesSql, snapshotGateSql, gapEvidenceSql } from './playbook-gap-probes.mjs';
import { writePerimeterSql, silentNoopWriteSql, WRITE_PERIMETER_SQL } from './write-perimeter.mjs';

const FAST = process.argv.includes('--fast');
const PIN = process.argv.includes('--pin-allowlist');
// The write allowlist pins independently of the EXECUTE one. Not a convenience:
// re-pinning both together means a deliberate table-perimeter change silently
// absorbs whatever new EXECUTE grant happened to land in the same window. That
// happened while migs 714-719 were being applied — a concurrent session's new
// function, granted to anon AND authenticated, was swept into the EXECUTE pin
// by a --pin-allowlist run meant only to record the revokes, and had to be
// reverted by hand. Two surfaces, two decisions.
const PIN_WRITE = process.argv.includes('--pin-write') || PIN;
const PIN_EDGE = process.argv.includes('--pin-edge');
const OFFLINE = process.argv.includes('--offline');
const PROD_REF = 'rfsvmhcqeiyrxivbmpel';
const ALLOWLIST_FILE = 'supabase/baseline/execute-allowlist.json';
const WRITE_ALLOWLIST_FILE = 'supabase/baseline/write-allowlist.json';

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

// ── The WRITE perimeter — ARM 1 (pinned, symmetric) ────────────────────────
// The table analogue of the EXECUTE allowlist above, and the half of docs/52's
// probe that is deliberately RE-PINNABLE. Arm 2 (the hard TRUNCATE rule, no
// allowlist) lives in write-perimeter.mjs and runs with the other PROBES.
//
// The VANISHED direction is the point. A revoke that removes more than intended
// is the same class of defect as mig 643's near-miss — 11 of 12 workspaces
// nearly left administrable by nobody — and it is invisible from the revoking
// side, because REVOKE reports nothing either way. Here it is a red run.
async function writePerimeterCheck() {
  const live = await q(WRITE_PERIMETER_SQL);
  if (PIN_WRITE) {
    writeFileSync(WRITE_ALLOWLIST_FILE, JSON.stringify({
      pinned_at: new Date().toISOString(),
      note: 'The INSERT/UPDATE/DELETE/TRUNCATE surface of `authenticated` on public BASE TABLES. certify fails on ANY diff, in either direction. Re-pin only after a DELIBERATE perimeter change (migs 714/716/717/718/719) — never to make a red run green.',
      grants: live,
    }, null, 2) + '\n');
    console.log(`  pinned ${live.length} table grants to ${WRITE_ALLOWLIST_FILE}`);
    return [];
  }
  let pinned;
  try { pinned = JSON.parse(readFileSync(WRITE_ALLOWLIST_FILE, 'utf8')).grants; }
  catch { return [{ violation: `write-allowlist file missing — run --pin-allowlist once, deliberately` }]; }
  const key = (r) => `${r.tbl}.${r.priv}`;
  const pset = new Set(pinned.map(key)), lset = new Set(live.map(key));
  const out = [];
  for (const r of live) if (!pset.has(key(r))) out.push({ violation: `NEW grant not in write-allowlist: ${key(r)} — authenticated gained a write privilege nobody pinned` });
  for (const r of pinned) if (!lset.has(key(r))) out.push({ violation: `allowlisted grant VANISHED (over-revoked?): ${key(r)} — a legitimate writer may now be getting 42501` });
  return out;
}

// ── Ring-0 probes — violations-only ────────────────────────────────────────
const PROBES = [
  {
    name: 'landed-reads-use-the-shared-predicate',
    why: 'four migrations (675-678) each patched a different reader that read a claim-time marker as proof the work happened. mig 679 made the correct test ONE function; this is what forces the fifth reader to use it',
    sql: landedPredicateSql(),
  },
  {
    name: 'exam-evidence-stays-out-of-production-metrics',
    why: 'the same defect shipped three times (158 exam conversations counted as activity; test-provoked guardrail blocks counted as trust evidence; an exam answer able to record a billable resolution). mig 682 made the rule ONE stamp + ONE predicate; this forces every current and future reader onto it, and its data arms catch a regressed writer or backfill',
    sql: productionEvidenceSql(),
  },
  {
    name: 'no-untyped-literal-appended-to-a-container',
    why: 'appending a BARE string literal to a text[] (v_errors := v_errors || \'message\') does not append — the untyped literal makes Postgres resolve anyarray||anyarray instead of anyarray||anyelement, so it parses the message AS an array and raises 22P02 at runtime, and that branch can NEVER return its message. jsonb has the identical trap. Four rules of validate_onboarding_items were dead this way from mig 076 until mig 685, and the only reason nobody noticed is that every sibling line used format(), which returns typed text. THE FIX IS A CAST: \'message\'::text (or ::jsonb). format(...) and array_append(arr, \'lit\') are already correct and are deliberately not flagged',
    sql: bareContainerLiteralSql(),
  },
  {
    name: 'no-pending-approval-the-platform-cannot-carry-out',
    why: 'on 2026-08-11 the SAME defect shipped twice in one day and no gate could see either: mig 701 (the sweep raised approvals with connector_id NULL, so connector-hub refused at the door with connector_id_required and the browser DISCARDED the refusal — the task read as done and no customer was chased) and mig 703 (due_approved_actions held the executor id on every row and dropped it, so the driver would hit action_ambiguous on a five-minute cron with nobody watching). A row sitting in front of a human asking to be approved, that could not be executed even if they said yes, is the class. mig 590 wrote the rule and never got a standing check: "checking that an executor EXISTS is not the same as checking it has what it needs". The resolution rule is lifted from connector-hub\'s resolveActionDefinition (index.ts:2160-2219), not invented — a probe whose rule disagrees with the runtime\'s manufactures findings and misses real ones in the same pass. ⚠ It also reports its own denominator: mig 701 back-filled the two known-bad rows the morning this was written, so the naive form of this probe finds nothing and looks green from having compared nothing — `no-comparisons` is therefore a VIOLATION, never a pass. ⚠ WHAT IT CANNOT SEE: the browser half of mig 701\'s fix lives in TypeScript (src/lib/connectorApi.ts), and a regression that stopped forwarding action_definition_id from there would not show up here. ⚠⚠ A FOURTH ARM, `no-executor`, IS RED ON PRODUCTION TODAY AND THAT IS CORRECT: a pending action_approval with NO action_executions row behind it at all (neither task_id nor resolves_task_id) asks a human to approve something with no executor — clicking yes flips the task to approved and sends nothing. Exactly one row matches, measured: outsourcetel-hq\'s "Send a $15,600 invoice to Meridian Group — test ping", the founder\'s lock-screen push test of 2026-08-10. It is deliberately NOT allowlisted — an exemption keyed to the one row a check finds is how a gate becomes theatre — and the remedy is a human withdrawing the test task, same as the kinetic row',
    sql: unexecutableApprovalSql(),
  },
  {
    name: 'advisory-layer-cannot-decide',
    why: 'mig 705 put an advisory brief beside every pending approval. Its whole value rests on one sentence: IT NEVER DECIDES — auto-approve is Gap 2 and a founder decision. The boundary is privilege, not promise: every brief writer runs as the NOLOGIN role approval_brief_writer, which holds no EXECUTE on decide_human_task, no write on human_tasks, and reaches nothing that can (the two-paths trap: the front door is not the only pen). The coverage half counts pending approvals WITHOUT a brief and reports its own denominator — zero findings from zero comparisons is a violation, never a pass',
    sql: advisoryBoundarySql(),
  },
  {
    name: 'trust-proposer-cannot-decide',
    why: 'mig 710 built the Gap-2 seam: repeated identical landed human approvals become ONE trust_promotion proposal on the existing queue. Two proofs, held by privilege and by the ledger, never by promise. PRIVILEGE: the writer runs as the NOLOGIN role trust_pattern_proposer, which holds no EXECUTE on decide_human_task/apply_trust_promotion/trust_apply_level/trust_demote/set_de_autonomy, no UPDATE/DELETE on human_tasks, no write on de_autonomy (the dial) or approval_authority (the limits), and UPDATE on trust_policies only for the four request-bookkeeping columns — plus a reachable-decider sweep (the two-paths trap) and a cannot-file liveness arm (a proposer that silently lost INSERT is the mig-625 built-but-unfed breaker with a privilege cause). EVIDENCE: every OPEN system-raised proposal must cite >= 3 decisions the ledger RE-CONFIRMS at probe time as approved + production-origin + landed (a stored citation is a stored marker, mig 642); suspended workspaces must hold none; a pending proposal no policy points at is unactionable and flagged. The denominator prints on every run; zero open proposals is legal and says so',
    sql: trustProposerBoundarySql(),
  },
  {
    name: 'gap-gate-can-only-pause',
    why: 'the typed-gaps build (mig 712) publishes gapped steps as gap_gate placeholders whose whole contract is that the blocked behaviour CANNOT run — a human may skip the step for one run or cancel, and "execute anyway" does not exist. A gap_gate step recorded done means some code path executed through it. Denominator printed; zero gap_gate steps is legal while partial publish (opt-in, default OFF) is unused',
    sql: gapGateConductSql(),
  },
  {
    name: 'playbook-steps-writes-are-audited',
    why: 'proven live (spec §1.4): on 2026-08-11 22:31 the incident draft\'s 7 compiled steps became 8 prose sections named "Rabeel" through a write path that audits NOTHING. mig 712\'s trigger validates step shape and appends the audit event IN THE SAME STATEMENT, so an un-audited steps update is impossible while it stands — this pins the trigger as a DRIVING pg_trigger row (present, enabled, wired) plus a data arm matching every steps-update since the pin date to its audit event',
    sql: auditedStepsWritesSql(),
  },
  {
    name: 'published-snapshots-respect-the-gate',
    why: 'the typed-gaps invariant: THE GATE DOES NOT GET LOOSER. Instead of trusting that validateSteps ran, this asserts what it guards on every snapshot the executor can be handed (pinned key vocabulary, trailing complete, max one approval/invoice, gap_gate must name its gap) — the first loosened publish lands here as a named row. Scoped after 2026-08-12: 14 legacy snapshots (07-21..08-10) end in instruction and are named debt from a pre-pin bypass, reported in the denominator, never silently passed',
    sql: snapshotGateSql(),
  },
  {
    name: 'playbook-gaps-hold-their-evidence',
    why: 'answered ≠ resolved is the spine of the typed-gaps design: a gap resolves only on verified evidence (a resolved missing_knowledge gap must carry the doc the recompile actually retrieved), and an objection that exists only as study prose is the dead end this build replaces — so studies that raised gaps/validator errors must have gap rows behind them. Denominators printed',
    sql: gapEvidenceSql(),
  },
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
    // mig 681: the `why` used to claim this, while the SQL below only checked
    // that an ACTIVE definition was VISIBLE to the tenant. Platform actions
    // carry tenant_id IS NULL and are visible to EVERY tenant, so a workspace
    // with no Stripe connector passed this probe while binding a Stripe verb.
    //
    // mig 693: and the connector was still not the whole gate. The runtime
    // filters the SAME set through de_may_use_action, which enforces
    // action_definitions.requires_role — production's outsourcetel-hq bound a
    // verb needing 'workforce_assistant' to an onboarding employee that is not
    // one, and this probe passed it because the connector matched. Twice now,
    // this probe and validate_onboarding_items have drifted from
    // get_agentic_tools_for_de because "can this verb run here" was written out
    // three separate times. It is now written ONCE, in
    // public.onboarding_verb_verdict(tenant, action_key), and BOTH this probe
    // and the validator ask it. Do not re-inline the predicate here.
    //
    // SCOPE, chosen deliberately (mig 693). Only versions that can still
    // produce or run work are checked: the CURRENT published version of a
    // template (every new project is cut from it) and any version an existing
    // project points at. A superseded version can mint nothing and nothing
    // reads it, so flagging it is noise nobody can ever clear — the template
    // editor cannot edit history. That narrowing drops no live defect: v5 of
    // outsourcetel-hq's template is BOTH the current version AND carried by an
    // active project, and it is the row this probe now reports. It is a real
    // failure, not a historical one, and the fix is to rebind the draft and
    // publish again — which the validator will now refuse until the verb is
    // one the onboarding desk can run.
    //
    // The role arm SKIPS when a workspace routes onboarding to nobody yet
    // (desk_known = false) — same skip as the validator, because a probe that
    // is stricter than the publish path fails workspaces that did nothing
    // wrong.
    why: 'a checklist item that names a verb the employee who would run it cannot actually reach is a promise that breaks at 2am, in front of a customer — an ACTIVE definition is not enough (platform actions are visible to every tenant whether or not it owns the system), and a CONNECTED connector is not enough either (the runtime filters the same set through de_may_use_action, so a role-gated verb never reaches the offer list of an employee without that role, and perform_onboarding_item is then never even declared)',
    sql: `select t.slug || ' / ' || v.name || ' / ' || (i->>'key')
                 || ' → ' || (i->>'action_key') || ' — '
                 || case when not coalesce((r.verdict->>'reachable')::boolean, false)
                         then 'no connected system in this workspace can run it'
                         else 'needs the "' || coalesce(r.verdict->>'required_roles', 'required')
                              || '" role, which the employee(s) this workspace gives onboarding work to ('
                              || coalesce(r.verdict->>'desk', 'none named') || ') do not have'
                    end as violation
            from onboarding_template_versions v
            join tenants t on t.id = v.tenant_id
            join onboarding_templates tpl on tpl.id = v.template_id
            cross join lateral jsonb_array_elements(v.items) i
            cross join lateral (
              select public.onboarding_verb_verdict(v.tenant_id, i->>'action_key') as verdict) r
           where coalesce(i->>'action_key', '') <> ''
             and (tpl.version = v.version
               or exists (select 1 from onboarding_projects p where p.template_version_id = v.id))
             and (not coalesce((r.verdict->>'reachable')::boolean, false)
               or (coalesce((r.verdict->>'desk_known')::boolean, false)
                   and not coalesce((r.verdict->>'role_ok')::boolean, false)))`,
  },
  {
    name: 'bound-onboarding-items-complete-from-evidence',
    why: 'a bound item marked done with no execution behind it is work recorded that nobody approved and no system accepted — the stored-marker-read-as-truth trap this repo has paid for repeatedly',
    sql: `select p.name || ' / ' || (i->>'key') as violation
            from onboarding_projects p
            cross join lateral jsonb_array_elements(p.items_state) i
            join onboarding_template_versions v on v.id = p.template_version_id
            cross join lateral jsonb_array_elements(v.items) d
           where d->>'key' = i->>'key'
             and d ? 'action_key'
             and i->>'status' = 'done'
             and not exists (
               select 1 from action_executions ae
                where ae.dedupe_key = 'onboarding:' || p.id || ':' || (i->>'key')
                  and ae.decision in ('auto_executed','executed_after_approval'))`,
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
  {
    name: 'authenticated-write-perimeter',
    why: 'docs/52: `authenticated` — the role every logged-in browser session runs as — held TRUNCATE on 245 of 294 public base tables, and RLS DOES NOT APPLY TO TRUNCATE. One statement would have destroyed every tenant\'s playbook_versions without a policy ever being consulted. Migs 714/715 closed it and stopped it regrowing; this arm is the hard rule that keeps it closed, with no allowlist and no exemption, plus the default-privilege row that feeds it',
    sql: writePerimeterSql(),
  },
  {
    name: 'write-grants-can-actually-write',
    why: 'the OPPOSITE question about the same surface, and a different class: of the write grants authenticated still holds, is any one of them a write RLS can only ever refuse? A table with RLS on and no PERMISSIVE policy for that command matches zero rows and PostgREST returns SUCCESS WITH NO ERROR — supabase-js sees error === null and the client reports a write that never happened. This repo has paid for that shape twice (project_role_gated_ui_audit; the four removed `tenants` writes whose comments still sit at src/lib/api.ts:97/297/675/734). docs/52 §5 measured exactly ONE live instance out of 82 kept command-grants — de_deployment_stages UPDATE, driving promoteDeploymentStage — and mig 720 closed it with a governed RPC. This is what stops instance #2. It is NOT arm 1 restated: arm 1 pins the grant surface and can be silenced by a re-pin, whereas this reads the POLICIES, so a migration that adds a grant, forgets the policy and re-pins is green there and red here. It cannot see a policy whose USING clause matches nothing in practice (docs/52 §9) — that half is not decidable from the catalogue',
    sql: silentNoopWriteSql(),
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
    // The TABLE analogue. Same pin mechanism, same symmetric diff, and it had
    // never existed: docs/52 found authenticated holding TRUNCATE on 245 of
    // 294 base tables with nothing in this gate able to notice.
    for (const v of await writePerimeterCheck()) failures.push(`write-perimeter: ${v.violation}`);
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
          // A probe may return rows with violation NULL and a `note` — the
          // DENOMINATOR it compared against. Zero findings from zero
          // comparisons looks exactly like a clean result, so a probe that
          // can say how much it examined must be able to print it on a PASS
          // as well as a fail. Same treatment netExposureFailures already
          // gets: surfaced, never counted as a failure.
          for (const r of rows) {
            if (r.violation != null) failures.push(`${p.name}: ${r.violation}`);
            else if (r.note != null) console.log(`        ${r.note}`);
          }
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
    // mig 713's anti-drift ratchet. The gate on playbook_versions is a SQL
    // TWIN of playbook-execute's validateSteps, and this repo already
    // ratchets browser/edge twins because a second copy of a contract rots
    // into a gate that passes what the real validator refuses. Drives BOTH
    // implementations over a shared fixture corpus and asserts verdict
    // parity in both directions, with a liveness arm so a corpus that
    // refuses nothing (or everything) cannot report parity. Not in --fast:
    // it makes ~80 calls to the deployed validator.
    shell('gate-parity', 'node', ['scripts/playbook-gate-parity.mjs']),
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
