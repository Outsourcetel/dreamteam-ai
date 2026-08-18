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
// ⚠ ONE SECTION IS NO LONGER COVERED BY THAT SENTENCE, and leaving it standing
// unqualified would make this header the lie. `decide-discovery-proposal-behaviour`
// calls verify_decide_discovery_proposal(), which DRIVES THE REAL RPC against
// production: it inserts sessions, proposals and connectors in a live workspace
// and deactivates a real owner's profile, because refusals that are never fired
// prove nothing.
//
// ⚠ AND SINCE MIGRATION 746 IT ALSO HIRES DIGITAL EMPLOYEES THERE. Probes 12-14
// drive the employee accept, so each run creates digital_employees rows in a
// real workspace — with their watchers, their published SOP and their role
// guardrails — and inserts TWO role_archetypes rows, which is the only write
// this section makes to a PLATFORM-WIDE table rather than a tenant-scoped one.
// They are keyed `vddp_` and named `vddp probe employee…`, and the function's
// own leak checks name any survivor. Naming this here rather than leaving it in
// the migration is the point of the paragraph.
//
// The exact count moved with it: 51 writes, not the 39 this header used to
// claim (which was itself one short of 745's real 40 — recounted rather than
// carried). Every one of them sits inside a probe sub-block that ends in an
// unconditional raise, so all of it rolls back — enumerated, not assumed, and
// asserted afterwards against row-count baselines AND per-row tags for
// discovery_proposals, discovery_sessions, connectors, audit_events,
// digital_employees, playbook_definitions, guardrail_rules and role_archetypes.
// It is the only section that writes, it is deliberate, and it is named here so
// nobody has to discover it from a diff.
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
import { strandedDraftSql } from './stranded-draft.mjs';
import { advisoryBoundarySql } from './advisory-boundary.mjs';
// mig 749's ratchet. Same file-per-rule shape as the imports above, and for
// the same reason the append-check exists: the lesson lived in migration 685's
// comment and was reintroduced 36 times by 741. This one lived in migration
// 685's sibling and was reintroduced 21 times.
import { secdefAuthorityPrefixSql } from './secdef-authority-prefix.mjs';
import { trustProposerBoundarySql } from './trust-proposer-boundary.mjs';
import { gapGateConductSql, auditedStepsWritesSql, snapshotGateSql, gapEvidenceSql } from './playbook-gap-probes.mjs';
import { writePerimeterSql, silentNoopWriteSql, WRITE_PERIMETER_SQL } from './write-perimeter.mjs';
// docs/53's finding, turned into a standing check: 11 of the 14 deferred items
// genuinely walked past in a week were named in a DOCUMENT rather than a commit,
// and the registers holding them had themselves gone stale. The register is now
// a tracked JSON file and this re-verifies it against live production and the
// repo on every run. It fails when the REGISTER IS WRONG ABOUT ITSELF, never
// merely because work is outstanding — see the module header for the argument.
import { deferredRegisterSection } from './deferred-register.mjs';
import { triggerExecutePerimeterSql } from './trigger-execute-perimeter.mjs';
// The comparison itself, shared with scripts/certify-mutation-test.mjs so the
// mutation cases exercise the REAL logic rather than a paraphrase of it. It in
// turn imports the SAME derivation scripts/gen-provider-seed.mjs uses to write
// the seed, so the gate checks the generator instead of agreeing with itself.
import { providerCatalogFailures, providerCheckValues, readConnectorConstants } from './provider-catalog-check.mjs';
// Same split, same reason: certify fetches and formats, discoverySpineFailures
// decides — and scripts/certify-mutation-test.mjs imports the identical
// function so its fixtures exercise the real gate, not a paraphrase of it.
import { discoverySpineFailures } from './discovery-spine-check.mjs';
// The sibling section, same split again: the proposal-DECISION assertions the
// 2026-08-13 discovery-proposals-and-creation plan calls Task 5. It is a
// SEPARATE section from discovery-spine on purpose — the spine is seeded
// standing data (14 rows, never legitimately zero) while discovery_proposals
// is a transactional table that is legitimately empty until the first
// interview, so the two have opposite answers to "is zero examined a
// violation" and must not share a PASS/FAIL line that hides the difference.
import {
  discoveryProposalFailures, proposalsSql, resolverControlSql, routeTablesSql,
  deciderSql, kindCheckValues, constraintDefsSql, privSql, mapPriv,
  exclusionAnchorSql,
} from './discovery-proposal-check.mjs';
// Same split again, and this one replaces a probe that could not fail: the
// ledger-vs-COMMITTED comparison needs git as well as SQL, so it cannot be a
// PROBES entry. certify-mutation-test.mjs imports committedLedgerFailures too.
import {
  readCommittedMigrations, committedLedgerFailures, MIGRATION_DIR,
} from './migration-committed-check.mjs';

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
// Read ONLY by the deferred register's dev-ledger-lag verification (item B-6).
// Nothing in certify writes to either project.
const DEV_REF = 'nmuntxrcdksyhsdywpan';
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

// Every Ring-0 probe reads PRODUCTION. The one exception is the deferred
// register's dev-ledger-lag verification, which by definition has to ask the
// OTHER project — so the ref is a parameter there and hardcoded everywhere
// else, the same split db-query.mjs and dev-query.mjs already keep.
const qProject = (ref, sql) => q(sql, 0, ref);
async function q(sql, attempt = 0, ref = PROD_REF) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
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
      // ⚠ `ref` MUST be carried through the retry. Dropping it would silently
      // re-aim a retried DEV query at PRODUCTION and report the answer as dev's.
      return q(sql, attempt + 1, ref);
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
      note: 'The INSERT/UPDATE/DELETE/TRUNCATE surface of `authenticated` on public BASE TABLES. certify fails on ANY diff, in either direction. Re-pin only after a DELIBERATE perimeter change (migs 714/716/717/718/719/720) — never to make a red run green. It is now exactly docs/52 KEEP: 81 pairs, every one with a proven src/ caller AND a PERMISSIVE policy — write-grants-can-actually-write is the arm that holds the second half.',
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
    name: 'no-approval-that-said-sent-and-sent-nothing',
    why: 'F-6, the sibling class the probe above CANNOT see. Every arm of unexecutable-approval starts from a JOIN to action_executions; a gated customer REPLY has no action_execution — its consequence is a column on de_messages — so the whole class was invisible to the gate that most looks like the gate that should have caught it (docs/50 F-7). The defect was UI-proven on the deployed app on 2026-08-12: /m\'s button read "Approve and send it" and its toast read "Approved and sent." while the draft stayed draft_pending and the conversation stayed needs_human. approve_draft_reply — the only code that flips a gated reply to sent — was reachable from ONE screen, so approving from anywhere else recorded the decision, wrote the audit event, closed the task and delivered nothing. mig 721 moved the consequence onto the row as a sixth status-sync trigger. ⚠ THE ARM THAT STOPS THIS BEING THEATRE IS THE MECHANISM ARM, not the data arm: a quiet week finds no stranded rows whether the trigger is installed or deleted, so the trigger must be present, ENABLED, attached to AFTER UPDATE OF status, and still carry both safety properties — approvals only (a decline that delivers the reply is worse than the original bug) and an ALLOW-LIST of self-delivering channels (a deny-list fails OPEN on the next carrier channel, which is the same lie one layer down). ⚠ Data arm 1 is scoped to decisions from mig 721 onward — not because older strandings are acceptable, but because a red keyed to history can never go green; every pre-fix row is printed individually by id in the notes instead of disappearing into an aggregate. Exactly one exists today: Review Lab task b6cd7764, message 27f98c5a, approved 08-11 20:45. A fourth arm flags the inverse — a PENDING approval on an email conversation holding a draft with no outbound_drafts row to carry it, i.e. a person being asked to approve a send with nothing behind it. Denominators print on every run',
    sql: strandedDraftSql(),
  },
  {
    name: 'advisory-layer-cannot-decide',
    why: 'mig 705 put an advisory brief beside every pending approval. Its whole value rests on one sentence: IT NEVER DECIDES — auto-approve is Gap 2 and a founder decision. The boundary is privilege, not promise: every brief writer runs as the NOLOGIN role approval_brief_writer, which holds no EXECUTE on decide_human_task, no write on human_tasks, and reaches nothing that can (the two-paths trap: the front door is not the only pen). The coverage half counts pending approvals WITHOUT a brief and reports its own denominator — zero findings from zero comparisons is a violation, never a pass',
    sql: advisoryBoundarySql(),
  },
  {
    name: 'no-secdef-authority-check-that-skips-instead-of-fails',
    why: '`if auth.uid() is not null and not exists (<caller is a member>) then raise` reads like a guard and is not one: the identity test makes the check SKIP rather than FAIL when auth.uid() is null. Most of the affected functions take a tenant id — or an id that resolves to one — AS A PARAMETER, which is the tenant-id-is-authorisation shape migs 662-664 exist to prevent. ⚠ THE EXPOSURE, stated precisely rather than inflated: anon holds EXECUTE on none of them, so this is not an open door to the internet — it is the removal of the last tenant-scoping backstop from every service-role path, and an edge function relaying a caller-supplied tenant id into one is a confused deputy. Migs 747/748 fixed four by hand and named more; the sweep that followed closed the rest in mig 749 (eleven split into _internal + a wrapper for their real service-role callers, eighteen with the identity test simply deleted). ⚠⚠⚠ THE PREDICATE IS A REGEX AND ITS FIRST DRAFT WAS A SUBSTRING, WHICH IS THE DEFECT THIS ENTRY EXISTS TO REMEMBER. `ilike \'%auth.uid() is not null and%\' found 21 of the same 750 SECURITY DEFINER bodies that `~* \'auth\\.uid\\(\\)\\s+is\\s+not\\s+null\\s+and\'` finds 27 of: a literal cannot see a defect that spans a line break, and real bodies break the line (enqueue_conflict_backlog writes `IF auth.uid() IS NOT NULL` then `AND NOT (...)` on the next). Six live carriers, two of them WRITERS taking a tenant id as a parameter, were invisible — and so was mig 749s own probe, built on the same substring. Proven by injecting a synthetic line-broken body: population 750->751, violations 21->21, NOT DETECTED. `node scripts/secdef-authority-prefix.mjs --selftest` re-runs that mutation and asserts the CARRIER count rises (measured: 21->21 old, 29->30 new). ⚠ TWO ARMS, because the defect has two shapes: FLAT (the identity test is a conjunct) and WRAPPING (an outer `if auth.uid() is not null then` around a nested `if`, e.g. set_de_objective_status, verify_extraction_result). ⚠ ARM B IS DELIBERATELY `then` + a NESTED `if`, NOT `then` + anything: `IF auth.uid() IS NOT NULL THEN RAISE` is a fail-CLOSED service-role-only bar (probe_chunk_neighbors, record_knowledge_conflict) and widening the arm to catch it would have this check demand the deletion of a correct guard. ⚠ AND ARM C ANSWERS THE GAP A REGEX ALWAYS LEAVES: any body mentioning the pattern in a shape NEITHER arm claims, and not named in CLASSIFIED_NON_DEFECTS with an argument, is reported as "a human must classify this" rather than silently passing — so shape number four goes red on arrival instead of outside the predicate. That pin is symmetric BOTH ways: red if a classified name stops mentioning the pattern (aimed at nothing) and red if one BECOMES a carrier (an expired classification still granting cover). ⚠⚠ THE SWEEP STRIPS LINE COMMENTS, because prosrc returns them and a naive match matches every comment that NAMES the pattern — including the ones 747/748/749 added to explain the fix; migration 747 lost its first apply to exactly that, and the enumeration handed to 749 repeated the mistake one level up, mis-crediting two SQL callers that were comment-only mentions. ⚠ Which creates the opposite trap, so three vacuity arms guard it: the number of SECURITY DEFINER functions EXAMINED must be non-zero, at least one stripped body must still mention auth.uid() (a strip that ate the body finds nothing by construction), and the naive count must EXCEED the stripped one or the strip has never been exercised. The pin is EMPTY and symmetric — a name listed that does not carry the pattern is also a violation, so an exemption cannot be left aimed at nothing. Denominator printed on every run, now including the flat/wrapping split and the unclassified-shape count',
    sql: secdefAuthorityPrefixSql(),
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
    name: 'trigger-functions-hold-no-ambient-execute',
    why: 'migs 610/630 doctrine, the half the ALLOWLIST could never enforce. The EXECUTE allowlist was NOT blind to trigger functions — they are prokind=f like any other and it saw all 80 — but it is RE-PINNABLE, and 48 of the 49 breached ones sat INSIDE the pin, blessed by past --pin-allowlist runs; only the 49th was red because it arrived after the last pin. certify.mjs\'s own header records the near miss where a concurrent session\'s new anon+authenticated function was swept into the pin by a run meant only to record some revokes. This arm has no allowlist and no exemption, so a FIFTIETH sibling cannot be made green by re-pinning — only by the revoke. The rule is absolute rather than a judgement call: a function returning `trigger` is unreachable by anon/authenticated (PostgREST will not expose it, Postgres rejects a direct call) and EXECUTE is checked at CREATE TRIGGER time, NOT at fire time — driven, not assumed, on dev AND prod (mig 722 §3 plus a four-arm rolled-back drive with a no-trigger control that correctly did NOT fire). ⚠ The received reason is wrong and the correction matters: triggers run as the CALLER, not the table owner (a SECURITY INVOKER trigger fired with current_user=authenticated), which is precisely why mig 722 left the 20 non-trigger PUBLIC-EXECUTE helpers alone — a helper CALLED from a trigger body IS privilege-checked at call time. ⚠⚠ THE GENERATOR IS STILL OPEN: a new function created by postgres in public is born with `=X/postgres`, and unlike the table case there is NO default-privileges fix (tested both orderings on dev; the new function still came out PUBLIC-executable), so this gate is the only defence. Denominator printed on every run',
    sql: triggerExecutePerimeterSql(),
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
    why: 'the other half — restricting the admin verbs to one role is only safe if that role can actually reach them, whatever the reason it might not: a missing connector included. The old form used a connected platform_admin connector as a precondition to even look at a tenant, so deleting that connector silenced the exact failure this probe exists to catch — a workspace nobody can administer. ⚠ IT NO LONGER FILTERS BY TENANT STATUS EITHER, and that is the same defect one layer out: every tenant is BORN `trial` (complete_signup and request_subtenant both insert `status=\'trial\'`), so an `active`-only probe was blind for the entire window in which a newly-provisioned workspace is newly broken — and expire_trials() then flips a lapsed trial to `suspended` on a timer, which would have moved it from one blind status to another without a human ever seeing it. A status filter is a precondition that a single UPDATE can use to silence the alarm, which is exactly what the connector precondition was. Measured before widening (2026-08-13): with no status filter at all, and the demo exemption still in place, the predicate returns ZERO tenants — 17 of the 18 workspaces holding a Workspace Assistant have 1 admin connector and 4 reachable workforce_assistant verbs, and the 18th is the exempt Demo Workspace. Widening silenced nothing and flagged nothing; it removed a snooze button. The denominator prints on every run, and zero examined is a violation rather than a quiet pass',
    // ⚠ THIS TEMPLATE LITERAL IS READ AS TEXT by scripts/certify-mutation-test.mjs,
    // which runs it verbatim as the `silent` half and runs a copy with the demo
    // exemption removed as the `fires` half. Keep the exemption on its own line
    // and keep the SQL free of backticks; the extractor asserts on both and
    // throws rather than testing nothing if either stops being true.
    sql: `with examined as (
            -- Provisioning refuses this tenant by id, on purpose: both
            -- provision_onboarding_architect and provision_tenant_baseline_internal
            -- (mig 730) return early for the demo tenant, so it genuinely has no
            -- platform_admin connector and never will under current provisioning.
            -- Same exclusion audit_tenant_feature_parity and audit_tenant_provisioning
            -- use (mig 723) — match the house convention. Remove this line if
            -- provisioning ever starts covering the demo tenant too. It is also
            -- the live fixture the mutation test lifts to prove this probe fires.
            select t.id, t.slug, t.status
              from tenants t
             where t.id <> 'a0000000-0000-0000-0000-000000000001'
               and exists (select 1 from digital_employees d
                            where d.tenant_id = t.id and coalesce(d.is_workforce_assistant, false))
          ),
          flagged as (
            select e.slug, e.status
              from examined e
             where not exists (
               select 1 from digital_employees de
               cross join lateral jsonb_array_elements(
                 public.get_agentic_tools_for_de(de.tenant_id, de.id)) x
               join action_definitions ad on ad.id = (x->>'action_definition_id')::uuid
              where de.tenant_id = e.id
                and coalesce(de.is_workforce_assistant, false)
                and ad.requires_role = 'workforce_assistant')
          ),
          counted as (
            select (select count(*) from examined) as n,
                   (select count(*) from flagged)  as bad,
                   (select coalesce(string_agg(s.status || '=' || s.c, ', ' order by s.status), 'none')
                      from (select e.status, count(*) as c from examined e group by e.status) s) as by_status
          )
          select f.slug || ' (' || f.status || ') — holds a Workspace Assistant but is offered no '
                 || 'requires_role=''workforce_assistant'' action: nobody can administer this workspace' as violation,
                 null::text as note
            from flagged f
          union all
          -- Zero examined renders identically to zero violations. Both gates
          -- that remain (the demo id, and "has an assistant") are things a row
          -- change can empty, so the denominator is asserted, not just printed.
          select 'no-comparisons — this probe examined ZERO workspaces. Every tenant is '
                 || 'supposed to hold a Workspace Assistant (auto_provision_new_tenant), so '
                 || 'either that stopped being true or the predicate drifted off '
                 || 'digital_employees. Both are failures, and neither is a pass.' as violation,
                 null::text as note
            from counted c
           where c.n = 0
          union all
          select null::text as violation,
                 'workspace-admin-has-an-owner: examined ' || c.n
                 || ' workspace(s) holding a Workspace Assistant, all statuses (' || c.by_status
                 || '), demo tenant exempt. ' || c.bad
                 || ' with no reachable workforce_assistant verb' as note
            from counted c`,
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
  // ⚠ `migration-files-match-ledger-checksums` USED TO LIVE HERE, as a probe
  // asserting `checksum is null and recorded_at > '2026-08-01'`. It never
  // compared a checksum to any file content and could not detect the drift its
  // own `why` named — production holds 763 ledger rows and ZERO null checksums,
  // so it returned zero rows exactly the way a clean scan does. It is now a
  // SECTION further down, because the comparison needs git as well as SQL and
  // cannot be one query. See it for the whole argument.
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
  {
    name: 'authority-has-one-evaluator-and-no-decorative-dimension',
    why: 'two paths measuring separately diverge — mig 755 had to unpick exactly that between list_de_trust_surface and decide_action_execution. And a dimension that can be written into a rule with nothing reading it is max_discount_pct again: configurable, zero readers, enforced by asking a model nicely. Both arms report their denominator, because zero findings from zero comparisons looks exactly like a clean result. ⚠ THE FIRST VERSION OF THE EVALUATOR ARM MATCHED A VARIABLE NAME, AND THAT IS THE DEFECT THIS PARAGRAPH EXISTS TO REMEMBER: it tested comment-stripped source for `strictest|v_worst`, and public.check_idle_in_transaction_internal (mig 466 — an idle-in-transaction watchdog with nothing to do with authority) declares its own local `v_worst` (an oldest-offender tracker). That would have false-positived as a second evaluator the moment 768/770/772 reached production, before any real second evaluator was ever written — caught in dry run, not in production, but only because it was dry-run first. Renaming the watchdog\'s variable to suit this probe was considered and rejected: it makes unrelated code serve a test\'s regex, and the next function that happens to declare v_worst breaks the gate again the same way. Fixed instead by testing what a second evaluator must actually DO rather than what it happens to be named: its comment-stripped source must reference authority_rules (it has to read the table the rules live in) AND require_second_approver (it has to be able to emit the ladder\'s middle rung) — BOTH, not either. A watchdog cannot satisfy that pair by coincidence; a real evaluator cannot avoid it while doing its job. Comments are stripped before matching for the same reason mig 749 needed it: these two terms are ordinary words that this very probe\'s prose and 772\'s own comments both use, so an unstripped scan would match itself. DO NOT SIMPLIFY THIS BACK TO A SINGLE IDENTIFIER MATCH — that is exactly the version that was wrong',
    sql: `
      with evaluators as (
        select fn.proname
          from (
            select p.proname, regexp_replace(p.prosrc, '--[^\\n]*', '', 'g') as src
              from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public'
          ) fn
         where fn.src ~ 'authority_rules'
           and fn.src ~ 'require_second_approver'
           and fn.proname <> 'evaluate_authority'
      ),
      readerless as (
        select distinct ar.dimension
          from authority_rules ar
          join authority_dimensions ad on ad.dimension = ar.dimension
         where ar.is_active
           and (ad.reader_fn is null or to_regprocedure(ad.reader_fn) is null)
      )
      select 'a SECOND authority evaluator exists: ' || proname as violation, null::text as note
        from evaluators
      union all
      select 'an active rule names a dimension nothing reads: ' || dimension, null
        from readerless
      union all
      select null, format('compared %s rules across %s dimensions against %s registered readers',
                          (select count(*) from authority_rules where is_active),
                          (select count(distinct dimension) from authority_rules where is_active),
                          (select count(*) from authority_dimensions where reader_fn is not null))
    `,
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
const OFFLINE_SECTIONS = new Set(['typecheck', 'edge-typecheck', 'design-drift', 'migration-append', 'suite']);

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
  // ── The deferred-work register re-verifies itself ──────────────────────
  // Same band as ring0-probes — read-only against production, runs in --fast,
  // violations-only — but it is a SECTION rather than a PROBES entry because
  // its verifications span three sources (production SQL, the repo on disk,
  // and the dev project's ledger) and cannot be one query.
  //
  // ⚠ IT DOES NOT FAIL BECAUSE WORK IS OUTSTANDING. 44 items are open today
  // and that is data, printed with denominators. It fails when the register is
  // WRONG ABOUT ITSELF — an item recorded open that verification proves closed,
  // or recorded closed that verification proves open — because a backlog nobody
  // re-measures stops being evidence, which is precisely how docs/45 came to
  // carry 28 fail-open guards against a live catalogue holding one.
  section('deferred-register', () => deferredRegisterSection({
    runSql: q,
    runSqlDev: (sql) => qProject(DEV_REF, sql),
  })),
  shell('migration-ledger', 'npm', ['run', '-s', 'migrate:status']),
  // ── What RAN must be what is COMMITTED ─────────────────────────────────
  // CLAUDE.md: "Commit the migration before you apply it. An applied-but-
  // uncommitted migration is the worst state available: the effect is
  // permanent, the source is one `rm` from gone, and a rebuilt environment
  // differs silently."
  //
  // This section is the standing proof of that sentence, and it replaces a
  // probe that could not deliver it. The old
  // `migration-files-match-ledger-checksums` said "a migration edited after
  // applying no longer describes what ran" and then asserted only that no
  // ledger row had a NULL checksum. It compared nothing to nothing: 763 rows,
  // zero nulls, zero rows returned, green forever.
  //
  // It is NOT a duplicate of `migration-ledger` above. That section
  // (scripts/migration-status.mjs) compares the ledger against DISK, so the
  // one state this whole thing exists to catch — a migration applied from an
  // edited working tree and never committed — reads APPLIED there, because
  // disk agrees with the ledger precisely BECAUSE the wrong thing was applied.
  // Proven live on 2026-08-13: migration 737 was committed, failed on illegal
  // SQL, was edited, and the edited text applied from the working tree.
  // Production ran uncommitted schema for ~25 seconds and every gate was green.
  // HEAD is the only witness that disagrees, so HEAD is what this reads.
  //
  // FETCHES and FORMATS only; migration-committed-check.mjs decides — and
  // certify-mutation-test.mjs drives that same function over synthesised
  // ledgers, so the fixtures exercise this gate rather than a copy of it.
  section('migration-files-match-ledger-checksums', async () => {
    const ledger = await q('select filename, checksum, provenance from public.schema_migrations');
    // HEAD, not the index and not disk. A STAGED file is not a committed file:
    // `git add` leaves the source exactly as recoverable as `rm` makes it.
    const { content, revSha } = readCommittedMigrations('HEAD');
    const onDisk = new Set(readdirSync(MIGRATION_DIR).filter((f) => f.endsWith('.sql')));
    const { failures, compared, comparedByProvenance, orphans, uncommitted } =
      committedLedgerFailures({ ledger, committed: content, onDisk });

    // Count the comparisons, not just the findings. This section's predecessor
    // is the reason that rule is written down: zero findings from zero
    // comparisons looked exactly like a clean result for months.
    const prov = Object.entries(comparedByProvenance)
      .sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${n} ${k}`).join(', ');
    const detail = failures.length
      ? failures.join('\n')
      : `compared ${compared} of ${ledger.length} ledger row(s) against HEAD ${revSha.slice(0, 8)} `
        + `(${prov}); ${content.size} migration file(s) in that commit, ${onDisk.size} on disk`
        + (orphans.length
          // Named, never a silent skip — and named as SOMEONE ELSE'S red, so
          // nobody reads this line as an exemption that closed the question.
          ? `; ${orphans.length} ledger row(s) have no file in the commit and none on disk, so there is `
            + `nothing to compare them WITH — that is the migration-ledger section's ORPHANED arm, which `
            + `is RED for them right now: ${orphans.join(', ')}`
          : '');
    if (!failures.length) console.log(`        migration-committed: ${detail}`);
    if (uncommitted.length) console.log(`        ⚠ ${uncommitted.length} applied migration(s) exist ONLY in this working tree`);
    return { ok: failures.length === 0, detail };
  }),
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
      // 2026-08-12 — the same defeat as 669, twice in one morning, and the
      // second one is the sharper lesson. Two agents, one repo:
      //   715_ratchet_default_privileges_authenticated   applied 10:37:33
      //   715_the_definition_says_which_engine_owns_it   applied 10:44:33
      //   717_revoke_live_uncalled_grants_slice1_content applied 10:57:43
      //   717_four_roles_get_a_procedure_and_intake      applied 10:58:00
      //
      // `npm run migrate:next` was run for both of mine and answered correctly
      // at the time — for 715 it read `local 713 · origin 714 · prod ledger
      // 714`, and it caught the 716 claim in between, which is why there is no
      // 716 collision. The gap it cannot close is CLAIM-TO-APPLY: the other
      // session's 715 landed in the seven minutes between my claim and my
      // apply. On 717 the margin was SEVENTEEN SECONDS.
      //
      // So this is not "someone forgot to run the tool". O_EXCL binds the file
      // on ONE disk; production is the shared resource and nothing holds a
      // claim there until apply. Closing it needs the claim to be taken in the
      // ledger at claim time, not at apply time — a real change to
      // migrate:next, recorded here rather than attempted in passing.
      '715', '717',
      // 2026-08-18 — the SAME defeat a fourth time, and it widens the gap the
      // 715/717 note left open. Two agents, one repo:
      //   754_a_trust_level_cannot_hide_a_live_grant     applied 01:29:28
      //   754_conversation_topics_the_customer_named     applied 01:40:52
      //
      // `npm run migrate:next` answered correctly for mine: at claim time the
      // other 754 was not in the local tree, not on origin/MAIN, and not in
      // the production ledger. It was on an UNMERGED BRANCH —
      // claude/docs54-stage-c — a source the union does not read, and one the
      // 715/717 note did not name because that pair never sat on a branch.
      //
      // ⚠ CORRECTED SAME DAY, because the first version of this note pointed
      // at the wrong fix. It said the gap was that migrate:next cannot read
      // unmerged branches. It reads the PRODUCTION LEDGER — verified by
      // running it: `local 755 · origin 755 · prod ledger 757`. So the branch
      // is only why the number was invisible BEFORE their apply; the reason it
      // was still invisible AT MY CLAIM is that they had not applied yet. That
      // is the SAME claim-to-apply gap as 669 and 715/717, for the fourth time.
      //
      // Reading branches would narrow the window; only taking the claim in the
      // ledger AT CLAIM TIME closes it. Do not let this list grow a fifth entry
      // that re-diagnoses the same hole. Recorded, not attempted in passing.
      '754',
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
  // ── The provider catalog cannot silently drift ─────────────────────────
  // The systems we claim to support lived in a TypeScript constant hand-synced
  // against a CHECK constraint — two lists, one truth, nobody watching. The
  // discovery interview reads the DB copy, so a drift means we prepare the
  // wrong connector, or fail to recognise a system the customer named.
  // This section FETCHES and FORMATS; provider-catalog-check.mjs decides. The
  // split is what lets certify-mutation-test.mjs hand the real comparison a
  // mutated copy of live state and watch it fire, instead of proving the gate
  // works by writing a broken row into the production catalog.
  section('provider-catalog', async () => {
    const constants = readConnectorConstants();
    const rows = await q(`select provider_key, label, category, auth_kind, credential_hint,
                                 default_base_url, implemented, aliases
                            from public.connector_providers where active`);
    const [chk] = await q(`select pg_get_constraintdef(oid) as def from pg_constraint
                            where conrelid = 'public.connectors'::regclass
                              and conname = 'connectors_provider_check'`);
    const catRows = await q(`select distinct unnest(required_connector_categories) as cat
                               from public.role_archetypes
                              where required_connector_categories is not null`);
    const [priv] = await q(`select has_table_privilege('authenticated','public.connector_providers','select') as can_read,
                                   has_table_privilege('authenticated','public.connector_providers','delete') as can_delete`);

    const inCheck = providerCheckValues(chk?.def);
    const cats = catRows.map((r) => r.cat);
    const { failures, compared, aliasCount } =
      providerCatalogFailures({ ...constants, rows, inCheck, cats, priv });

    // Count the comparisons, not just the findings. Zero findings from zero
    // comparisons looks exactly like a clean result.
    const detail = failures.length
      ? failures.join('\n')
      : `compared ${Object.keys(constants.PROVIDERS).length} providers x 3 lists `
        + `(${inCheck.size} CHECK values), ${compared} field values, ${aliasCount} aliases, `
        + `${cats.length} required categories`;
    if (!failures.length) console.log(`        provider-catalog: ${detail}`);
    return { ok: failures.length === 0, detail };
  }),
  // ── The discovery interview's fixed spine cannot silently shrink ────────
  // Tasks 1-3 of the 2026-08-13 discovery-interview-engine plan built the
  // spine (public.discovery_dimensions), the session coverage ledger
  // (public.discovery_sessions) and the turn-loop engine that writes it.
  // Nothing since then stood guard over any of it — this is that guard.
  //
  // ⚠ The task-4 brief that specified this section was written against a
  // STALE count of 12 dimensions; the live spine has 14 (migrations 734-736
  // grew it after the brief was drafted). Nothing below hardcodes either
  // number — every assertion is phrased against whatever
  // discovery-spine-check.mjs counts live, which is the entire point: the
  // brief's own staleness is the argument for never hardcoding a dimension
  // count or key list here.
  //
  // This section FETCHES and FORMATS; discovery-spine-check.mjs decides —
  // see its header for why, and for why certify-mutation-test.mjs imports
  // the identical function rather than a paraphrase of it.
  section('discovery-spine', async () => {
    const dims = await q(`select key, ordinal, title, guidance, serves_archetypes, produces, active
                            from public.discovery_dimensions`);
    const archetypeRows = await q(`select key from public.role_archetypes`);
    const sessions = await q(`select id, coverage from public.discovery_sessions`);
    const [priv] = await q(`select
        has_table_privilege('authenticated','public.discovery_dimensions','select') as dim_select_authenticated,
        has_table_privilege('authenticated','public.discovery_dimensions','insert') as dim_insert_authenticated,
        has_table_privilege('authenticated','public.discovery_dimensions','update') as dim_update_authenticated,
        has_table_privilege('authenticated','public.discovery_dimensions','delete') as dim_delete_authenticated,
        has_table_privilege('authenticated','public.discovery_capability_demand','select') as demand_select_authenticated,
        has_table_privilege('anon','public.discovery_capability_demand','select') as demand_select_anon,
        has_table_privilege('authenticated','public.discovery_sessions','update') as session_update_authenticated,
        has_function_privilege('authenticated','public.end_discovery_session(uuid, uuid, text, text)','execute') as end_session_authenticated,
        has_function_privilege('service_role','public.end_discovery_session(uuid, uuid, text, text)','execute') as end_session_service_role`);
    // ⚠ has_function_privilege on a name Postgres cannot resolve ERRORs
    // 42883 rather than returning false — deliberate, per this repo's
    // doctrine: if migration 739's end_discovery_session were dropped or its
    // signature changed, this section goes LOUD instead of quietly reporting
    // "authenticated cannot execute it" about a function that no longer
    // exists.

    const { failures, dimensionsExamined, activeDimensionsExamined, sessionsExamined } = discoverySpineFailures({
      dims,
      archetypeKeys: new Set(archetypeRows.map((r) => r.key)),
      sessions,
      priv: {
        dimSelectAuthenticated: priv?.dim_select_authenticated,
        dimInsertAuthenticated: priv?.dim_insert_authenticated,
        dimUpdateAuthenticated: priv?.dim_update_authenticated,
        dimDeleteAuthenticated: priv?.dim_delete_authenticated,
        demandSelectAuthenticated: priv?.demand_select_authenticated,
        demandSelectAnon: priv?.demand_select_anon,
        sessionUpdateAuthenticated: priv?.session_update_authenticated,
        endSessionAuthenticated: priv?.end_session_authenticated,
        endSessionServiceRole: priv?.end_session_service_role,
      },
    });

    // Counts, not just findings — zero examined must itself be a violation
    // (enforced inside discoverySpineFailures for dimensions; sessions is
    // reported here regardless of value so "0 sessions, 0 findings" is never
    // misreadable as "checked and clean" — see that file's header for why
    // sessions does not ALSO gate ok/not-ok the way dimensions does).
    const detail = failures.length
      ? failures.join('\n')
      : `examined ${dimensionsExamined} dimension(s) (${activeDimensionsExamined} active, unique contiguous ordinals), `
        + `${sessionsExamined} discovery_sessions row(s)`
        + (sessionsExamined === 0 ? ' (interview engine not yet used in production — coverage-state check has nothing to examine yet)' : '');
    if (!failures.length) console.log(`        discovery-spine: ${detail}`);
    return { ok: failures.length === 0, detail };
  }),
  // ── A proposal in a terminal state must have a person and a thing ───────
  // Task 5 of the 2026-08-13 discovery-proposals-and-creation plan, landing
  // WITH the first kind rather than after the last one — task-3-contract.md
  // §9: "the assertions must be red-provable on the first kind, or they will
  // be written to fit whatever shipped."
  //
  // Four row assertions (no terminal state without decided_by AND decided_at;
  // no accepted row without a created_object_id; every kind present is one a
  // writer can route; and an accepted row's created_object_id must resolve to
  // a LIVE row in the table its kind creates into — a stored uuid is not a
  // created thing).
  //
  // ⚠⚠ discovery_proposals holds ZERO rows today and every one of those four
  // therefore compares nothing. That is measured, not assumed: 0 proposals, 0
  // discovery_sessions, and 0 audit_events carrying
  // detail->>'kind'='discovery_proposal_decision' — checked, because in this
  // repo zero rows is never on its own evidence that a feature never ran. A
  // section that reported PASS on that basis would be the ninth
  // check-that-cannot-fail in five days. So:
  //   · the row denominator is printed on EVERY run, and zero prints as a
  //     ⚠ NOT-YET-EXERCISED line saying in words that those four proved
  //     nothing today;
  //   · four further families run on every run whatever the table holds —
  //     the ROUTES (each routable kind's target table must resolve live AND
  //     must be the table EXPECTED_KIND_TABLES independently names, which is
  //     what makes both "add conversation_type to KIND_ROUTES" and "point a
  //     kind at a live-but-wrong table" go red instead of buying silence);
  //     the STATES (TERMINAL_STATES/NON_TERMINAL_STATES diffed against
  //     discovery_proposals_state_check in both directions, so a new state
  //     cannot be skipped by every row arm in silence); the RESOLVER CONTROLS
  //     (the same SQL expression the dangling-uuid assertion uses, driven
  //     four ways per kind — nil uuid must say no, a real row must say yes,
  //     that row under ANOTHER tenant must say no, and an excluded row
  //     (is_workforce_assistant) must say no); and the AUDIT-WRITE PERIMETER,
  //     because the "created then deleted" relief reads an audit event as
  //     evidence and that is admissible only while the browser cannot write
  //     one.
  //
  // FETCHES and FORMATS only; discovery-proposal-check.mjs decides, and
  // certify-mutation-test.mjs drives that same function over mutated copies of
  // this same live state.
  section('discovery-proposal-decisions', async () => {
    const proposals = await q(proposalsSql());
    const controls = await q(`select * from (${resolverControlSql()}) _c order by kind, arm`);
    const routeTables = await q(routeTablesSql());
    const constraintDefs = await q(constraintDefsSql());
    const defOf = (name) => constraintDefs.find((c) => c.conname === name)?.def;
    const deciders = await q(deciderSql());
    const [priv] = await q(privSql());
    // The live half of the exclusion check. Three booleans per anchor — see
    // EXCLUSION_ANCHORS for exactly which three and why the third is the
    // narrowest read that can answer "was the `excluded` control arm even
    // driveable this run". Fetched here rather than derived, because deriving
    // it from EXPECTED_KIND_EXCLUSIONS is what let a two-line edit delete the
    // whole control without a single red.
    const anchorProbes = await q(`select * from (${exclusionAnchorSql()}) _a order by kind`);

    const r = discoveryProposalFailures({
      proposals,
      controls,
      routeTables,
      anchorProbes,
      kindsInCheck: kindCheckValues(defOf('discovery_proposals_kind_check')),
      // The STATE vocabulary, fetched for the same reason the kind vocabulary
      // is: TERMINAL_STATES used to be a JS literal compared against nothing,
      // so a future `expired` state would have been skipped by every per-row
      // arm while still counting in the denominator.
      statesInCheck: kindCheckValues(defOf('discovery_proposals_state_check')),
      deciders,
      priv: mapPriv(priv),
    });

    // Count the comparisons, not just the findings — and print them whether
    // the section passes or fails, because the number that matters most here
    // is the one that is currently zero.
    const denominator = `compared ${r.proposalsExamined} proposal row(s) `
      + `(${r.terminalExamined} terminal, ${r.acceptedExamined} accepted, `
      + `${r.retiredExamined} accepted-but-object-since-deleted, kinds present: `
      + `${r.kindsPresent.length ? r.kindsPresent.join('/') : 'none'}), `
      + `${r.routesExamined} routable kind(s) against live target tables, `
      + `${r.expectationsExamined} route/exclusion expectation(s), `
      + `${r.anchorsExamined} live exclusion anchor(s), `
      + `${r.statesExamined} admitted state value(s), `
      + `${r.controlsExamined} resolver control(s); `
      // WHICH workspace each cross_tenant arm contrasted with, on green runs
      // too. That arm's `false` only means something against a contrast that
      // owns a row in the target table, the contrast is picked from live data,
      // and it shipped once picked purely by accident — so the choice is
      // printed rather than trusted. A control quietly going vacuous is
      // otherwise indistinguishable from one that passed.
      + `cross_tenant contrasted with ${r.crossTenantContrasts?.length ? r.crossTenantContrasts.join(', ') : 'NOTHING'}; `
      + `kinds the CHECK admits that no writer routes: `
      + `${r.admittedButUnroutable.length ? r.admittedButUnroutable.join('/') : 'none'}`;
    for (const n of r.notes) console.log(`        ${n}`);
    console.log(`        discovery-proposal-decisions: ${denominator}`);
    return { ok: r.failures.length === 0, detail: r.failures.join('\n') };
  }),
  // ── The same surface, asked the OTHER question: does the function BEHAVE ─
  // The section above asserts ROW invariants on discovery_proposals. That
  // table holds zero rows and every one of those arms therefore compares
  // nothing — it says so itself, on every run. Meanwhile NOTHING checked that
  // the compare-and-swap refuses a second accept, that the role bar refuses a
  // tenant_user, that a cross-tenant caller is refused, that an unroutable
  // kind leaves the proposal pending WITH last_error set, that park is not
  // decline, or that a successful accept clears a stale reason. Those are
  // properties of the FUNCTION, true or false whether or not a customer has
  // ever used the surface, and migration 741 proved them exactly ONCE, at
  // apply time, in a DO block that then ceased to exist.
  //
  // Migration 745 turned 741's eleven probes into
  // public.verify_decide_discovery_proposal(), which returns its findings
  // instead of raising them. This runs it. It is the sibling of
  // discovery-proposal-decisions and deliberately NOT merged into it: one
  // reads rows that may legitimately be absent, the other drives behaviour
  // that is never legitimately absent, and a shared PASS line would hide the
  // difference.
  //
  // ⚠⚠ THIS IS THE ONE RING-0 SECTION THAT WRITES TO PRODUCTION, and the
  // header's "probes are read-only" sentence does not cover it. Every probe
  // creates a session, connectors and proposals in a real workspace, drives
  // the RPC as `authenticated`, and rolls the whole lot back by raising a
  // sentinel inside its own sub-block. Dev cannot substitute: the probes need
  // a real owner, a real non-admin member of the same workspace, a second
  // workspace's owner and a platform-layer profile, and those fixtures are
  // production's. The rollback is ASSERTED rather than trusted — the function
  // re-reads row counts for all five tables it touches against baselines taken
  // before any probe ran, greps for its own tagged rows, and checks that the
  // person probe 8 deactivates is active again. Any of those moving is a
  // finding, printed here verbatim.
  //
  // ⚠ THE PROBE COUNT IS WHY THIS IS NOT THEATRE. An empty findings array from
  // a function whose eleven probes all died looks exactly like a clean run —
  // which is the ninth version of this repo's oldest mistake. The function
  // prints probes_completed= and this REFUSES the run if it is missing or
  // zero, before it ever looks at whether there were findings.
  section('decide-discovery-proposal-behaviour', async () => {
    let rows;
    try {
      // unnest, not the bare array: rows are unambiguous over the wire, where
      // a text[] could arrive as an array or as a Postgres array literal
      // depending on the driver — and guessing wrong would silently turn every
      // finding into one unparsed string.
      rows = await q('select f as finding from unnest(public.verify_decide_discovery_proposal()) f');
    } catch (e) {
      // A check that cannot run is a failure, never a skip. This is also what
      // fires if the function was dropped or its perimeter revoked.
      return {
        ok: false,
        detail: `verify_decide_discovery_proposal() ERRORED, so NOTHING about the decision path was verified this run — ${String(e).slice(0, 400)}`,
      };
    }

    const all = rows.map((r) => r.finding).filter((f) => typeof f === 'string');
    // ⚠ Match the FULL prefix, not `note: `. Any finding beginning with the
    // shorter string would be reclassified as a note and silently excused —
    // and a run genuinely reporting probes_completed=0 in a SECOND note went
    // green under the loose match. Not live today (no finding in 745 starts
    // that way), fixed because "not live today" is how it gets in.
    const NOTE = 'note: probes_completed=';
    const notes = all.filter((f) => f.startsWith(NOTE));
    const findings = all.filter((f) => !f.startsWith(NOTE));
    const note = notes[0] ?? '';
    const probes = Number(/probes_completed=(\d+)/.exec(note)?.[1] ?? NaN);
    const asserts = Number(/assertions=(\d+)/.exec(note)?.[1] ?? NaN);

    // ⚠⚠ THE GATE MUST HOLD ITS OWN DENOMINATOR, not delegate it to the thing
    // it is checking. Refusing only `0` left 7-of-11-with-no-findings GREEN —
    // proven by mutant, not argued. The function happens to emit its own
    // "only N of 14 probes completed" finding today, so that case is red in
    // practice; one edit to that single line disarms the gate silently. Same
    // for the assertion count: it was PARSED AND PRINTED and never compared,
    // so hollowing out the probe bodies while leaving the sub-blocks standing
    // kept probes_completed at its full value forever. That is exactly the
    // one-shot-versus-standing distinction migration 745 exists to fix,
    // reproduced one level up in its own gate.
    //
    // ⚠ THESE TWO MOVE WITH THE FUNCTION, IN THE SAME COMMIT, OR THIS GOES RED.
    // That is the intended coupling: migration 746 added probes 12/13/14 (the
    // employee hire, the nested-sub-block asymmetry driven in both directions,
    // and "the router did not swing open for procedure/trust_rule"), so 11
    // becomes 14 and 98 becomes 138. Migration 751 adds probe 15 (the whole
    // guardrail path — the browser's own insert under RLS, the accept, the shape
    // of the rule that now exists, RETIRING it, and ten refusals) plus a
    // guardrail leak arm, so 14 becomes 15 and 138 becomes 164 — and then the
    // review fixes add five more (the prose-word alternation's only behavioural
    // case, the regex-metacharacter screen, the empty-alternative screen, the
    // whitespace-padded accept that proves the trim, and the employee-scope
    // decoy), so 164 becomes 169. The floor is the
    // count on a CLEAN run — every `v_checks := v_checks + 1` is reached when
    // every probe completes — so it goes red the moment a probe is skipped,
    // which is the whole point.
    //
    // Declared HERE, above the zero-probe branch, so every message below counts
    // against the same number. They used to be declared halfway down and three
    // sentences said "11" as a string literal; when the count moved, those three
    // would have kept telling a person the wrong denominator while the gate
    // itself was right.
    // Migration 752 adds probe 16 (the whole procedure path — the drafter's two
    // writes performed as the role it uses, the browser's key+name stamp under
    // RLS, the accept, the REACHABILITY of what it created measured against all
    // three executor selectors and inverted by publishing the same row,
    // ARCHIVING it as the owner, the 740 identity-key model driven both ways,
    // and sixteen refusals) plus a playbook leak arm, so 15 becomes 16 and 169
    // becomes 202. It also REPOINTS probe 14 off `procedure` — routing the kind
    // would have left half of that probe asserting that the procedure branch
    // refuses a procedure, running and comparing nothing.
    //
    // ⚠ 202 IS COUNTED. It was 201 for one round: counting
    // `v_checks := v_checks + 1` in the shipped function body gave 32 new ones
    // on top of 751's 169. The review of 752 then added the long-name case
    // (probe 16 (e11) — a 228-character procedure name driven through the
    // provenance refusal, proving `left(v_err, 500)` no longer cuts the closing
    // sentence off the card), which is one more: 33, so 202. The same count run
    // against 751 returns exactly 169 — its own floor — which is what makes the
    // method trustworthy rather than merely self-consistent.
    // 753 moves both again, and the second number is COUNTED by the same method.
    //
    // ⚠⚠ AND THE FIRST VERSION OF THIS PARAGRAPH WAS FALSE IN TWO OF ITS THREE
    // TERMS. It said "30 new assertions in probe 17, plus 2 net in probe 14,
    // plus 2 in the rollback section. 202 + 34 = 236." The arithmetic held and
    // the terms did not — the error on probe 17 (-4) and the error on probe 14
    // (+4) cancelled exactly, which is precisely why a breakdown that only has
    // to SUM cannot be trusted. Each term is a claim about a block of the
    // migration and has to be counted in that block. Re-counted against the
    // shipped bodies of 752 and 753:
    //     probe 17           +37   its whole assertion block
    //     probe 14, REBUILT   -2   8 arms in 752 -> 6 here. It was rebuilt
    //                              rather than repointed: four named-kind arms
    //                              lost, two that loop over a derived set
    //                              gained. That is MINUS two, not plus two.
    //     rollback section    +2   4 arms in 752 -> 6 here (trust_policies and
    //                              de_autonomy)
    //     202 + 37 - 2 + 2 = 239
    // The review round that found this also added three assertions to probe 17
    // (two for the automatic trust-widening candidate measurement, one for the
    // confidence-cap range refusal), which is why probe 17's term is 37 and not
    // the 34 it shipped at.
    //
    // ⚠ IF PROBES 7 AND 14 EVER REPORT AS MISSING, READ THE FUNCTION'S OWN
    // FINDING BEFORE TOUCHING THESE NUMBERS. Both used to name a kind literally
    // and both have already been fixed once by renaming it (751, then 752);
    // routing `trust_rule` leaves exactly ONE unroutable kind, so 753 rebuilt
    // them to DERIVE their subject from discovery_proposals_kind_check minus the
    // router's real `when` arms. The day `conversation_type` gains a branch that
    // set is empty, both probes decline to run, and this section goes red ON
    // PURPOSE with a finding naming what to rebuild. Lowering EXPECTED_PROBES
    // there would delete the only coverage of "a refusal leaves a reason",
    // "attempts increments rather than being set" and "the router opened for
    // exactly the kinds intended".
    const EXPECTED_PROBES = 18;
    const ASSERTION_FLOOR = 265; // 754 adds 26 (265) = 23 when it was written, plus 3 from its fix round: probe 18(d2) pins support_triage_rules_source_proposal_uq itself (a second row claiming one proposal must raise 23505; that proposal must own exactly 1 rule; a NULL-carrying rule must still insert, which is the arm proving the index is still PARTIAL). It was pinned by NOTHING before — a reviewer dropped the index and got 18/18 probes, 262 assertions and zero findings, because every other arm reads that column through the RPC's stamp rather than through the database refusing a second row. The 23 original: 3 denominator/counter arms, 3 classifier arms (fires, does not fire for everything, and loses to the baseline where the patterns overlap), 2 identity-index arms, 1 removability, 1 provenance, 10 refusal arms (g1-g8 plus the rule_order-default fact and the band), 2 role-bar arms — plus 1 rollback arm for support_triage_rules, minus 0. Measured from a real aborting run: 239 -> 262 -> 265. ⚠ Probes 7 and 14 are UNCHANGED and still run: 754 keeps them drivable with the `__unrouted_probe__` sentinel rather than by lowering this floor. // 741 shipped 95; 745 ported them plus 3 ctid arms (98); 746 adds 40 across probes 12/13/14 and the hire's own rollback arm (138); 751 adds 26 across probe 15 and the guardrail leak arm (164), then 5 more from the review fixes (169); 752 adds 33, all of them probe 16's (202) — the playbook leak arm extends an existing check rather than adding one; 753 adds 37 net (239) = +37 probe 17, -2 probe 14 (REBUILT, 8 arms -> 6), +2 rollback (trust_policies and de_autonomy). ⚠ This line previously read "753 adds 34 (236) — 30 in probe 17, 2 net from rebuilding probe 14, and 2 rollback arms": two of the three terms were wrong and the total only survived because +4 and -4 cancelled. Count each term in its own block.

    // The denominator is checked BEFORE the findings, on purpose: "no
    // findings" is only meaningful once something was compared.
    if (!Number.isFinite(probes)) {
      return {
        ok: false,
        detail: 'the function returned no `note: probes_completed=` line, so how much it compared is unknown. '
          + 'Zero findings from zero probes is indistinguishable from a clean result, and this section refuses to '
          + `guess which one it got. Returned ${all.length} element(s).`,
      };
    }
    if (probes === 0) {
      return {
        ok: false,
        detail: `the function ran ZERO of ${EXPECTED_PROBES} probes and therefore proved nothing. This is a REFUSAL, not a pass.\n${note}`
          + (findings.length ? `\n${findings.map((f) => `  ✗ ${f}`).join('\n')}` : ''),
      };
    }
    if (probes !== EXPECTED_PROBES) {
      return {
        ok: false,
        detail: `only ${probes} of ${EXPECTED_PROBES} probes completed. The missing ones proved nothing, and a partial `
          + `run with no findings is not a pass.\n${note}`
          + (findings.length ? `\n${findings.map((f) => `  ✗ ${f}`).join('\n')}` : ''),
      };
    }
    if (!Number.isFinite(asserts) || asserts < ASSERTION_FLOOR) {
      return {
        ok: false,
        detail: `${EXPECTED_PROBES} probes ran but only ${Number.isFinite(asserts) ? asserts : 'an unreadable number of'} `
          + `assertion(s) were made, below the floor of ${ASSERTION_FLOOR}. ${EXPECTED_PROBES} empty sub-blocks would `
          + `report ${EXPECTED_PROBES} probes. If assertions were deliberately removed, move this floor and say why.\n${note}`,
      };
    }
    if (findings.length > 0) {
      return {
        ok: false,
        detail: `${findings.length} finding(s) from ${probes}/${EXPECTED_PROBES} probe(s), ${asserts} assertion(s):\n`
          + findings.map((f) => `  ✗ ${f}`).join('\n') + `\n${note}`,
      };
    }
    // Count the comparisons, not just the findings — printed on green runs too.
    console.log(`        decide-discovery-proposal-behaviour: ${note}`);
    return { ok: true, detail: '' };
  }),
  // ⚠⚠ THE ONLY PLACE THE TWO COPIES OF THE GUARDRAIL PATTERN PREDICATE ARE
  // ACTUALLY COMPARED. `guardrail_rules.pattern` is screened in TypeScript
  // (src/lib/discoveryProposalPresentation.ts) and again in SQL (migration 751's
  // guardrail branch), and the ordering makes the pair ASYMMETRIC: the browser
  // INSERTS a live, blocking, workspace-wide rule between the two, so SQL
  // STRICTER THAN THE CLIENT leaves that rule in force behind a proposal that
  // reverts to pending and re-refuses on every retry, forever.
  //
  // tests/discovery-proposal-batching.test.ts used to assert that invariant
  // against a JavaScript re-implementation of the SQL predicate. It passed. Run
  // against the real database with the predicate lifted out of the migration, it
  // was FALSE — 10 unsafe patterns, because five code points are `\s` to
  // Postgres and not to JavaScript. A transcription can only prove it agrees
  // with itself, which is why this section exists and why it is HERE and not in
  // vitest: the suite has no database, and a differential that skips when it
  // cannot reach one is a checker that cannot fail.
  //
  // The script hard-fails on an unreachable database and on a battery that has
  // lost its teeth (no acceptances, no refusals, no disagreements, too few
  // comparisons), so a green here is a green over a real comparison.
  section('guardrail-pattern-differential', async () => {
    const { runDifferential, verdict } = await import('./guardrail-predicate-differential.mjs');
    let r;
    try {
      r = await runDifferential();
    } catch (e) {
      // A check that cannot run is a failure, never a skip.
      return {
        ok: false,
        detail: `the guardrail pattern differential could not run, so NOTHING about the client/database agreement was verified this run — ${String(e).slice(0, 400)}`,
      };
    }
    const v = verdict(r);
    // Count the comparisons, not just the findings — printed on green runs too.
    const denom = `compared ${r.compared} patterns against live Postgres: client accepts ${r.tsAccepted}, database accepts ${r.sqlAccepted}, disagreements ${r.disagreements} (${r.safeDisagreements.length} on the safe side)`;
    if (!v.ok) return { ok: false, detail: `${v.problems.map((p) => `  ✗ ${p}`).join('\n')}\n        ${denom}` };
    console.log(`        guardrail-pattern-differential: ${denom}`);
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
    // Debt #0's ratchet — the SAME disease one level down. gate-parity above
    // compares two copies of the TOP-LEVEL vocabulary; nothing compared the
    // decision-BRANCH vocabulary against the arms that carry it out, and for
    // months validateSteps accepted 10 keys the executor could perform 6 of.
    // The other four were recorded `skipped` and the run reported COMPLETED.
    // Five arms: two read the repo (arms ⊇ accepted keys, builder == server),
    // three drive the DEPLOYED function — including one that creates a run
    // holding an unrunnable key, advances it, asserts it FAILED, and deletes
    // it, because the vocabulary being right is not the same claim as the
    // engine refusing to file undone work as a success. Not in --fast: ~20
    // calls to the deployed function plus a create/delete round trip.
    shell('branch-parity', 'node', ['scripts/playbook-branch-parity.mjs']),
    shell('design-drift', 'node', ['scripts/design-drift.mjs']),
    // `v_bad := v_bad || 'a sentence'` is ambiguous — anyarray||anyarray wins
    // over anyarray||anyelement for an unknown literal, so it raises 22P02
    // instead of appending. PL/pgSQL resolves types at FIRST EXECUTION, so the
    // statement only fails WHEN THE BRANCH FIRES: a verification block whose
    // error path breaks exactly when it has something to report. Migration 685
    // already fixed this in the live validate_onboarding_items and wrote the
    // reason down; migration 741 reintroduced it 36 times anyway, which is why
    // the knowledge needed to live somewhere a person cannot fail to read.
    // Credential-free, so it runs in --offline too.
    shell('migration-append', 'node', ['scripts/migration-append-check.mjs']),
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
