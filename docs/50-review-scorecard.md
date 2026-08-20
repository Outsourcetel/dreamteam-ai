# 50 — Full Review Scorecard (living document)

**Programme:** 19-workstream review (doc 49 = inventory). This is the one page that fills in as
workstreams land evidence. States: `proven-live` / `built-unproven` / `inferred` / `dead` /
`—` (not yet examined). Update in place; never delete a row.

> ⚠ **The FIX BACKLOG and the carried-forward findings below are HISTORY. Open state lives in
> `review/deferred-register.json`**, re-verified against live production by `certify` ›
> `deferred-register` on every run. docs/53 found this document's own carried-forward r5 list
> naming two findings that were already closed or refuted — a backlog nobody re-measures stops
> being evidence. F-1…F-8 and W-1 are now register items `B-2`…`B-8` and `D-9`. Add items with
> `npm run defer`.

## Review Lab tenant (provisioned 2026-08-12, Workstream B fixture)

Created via the **real path** — admin-API auth user → `signInWithPassword` → `rpc complete_signup`
(exactly what OrgSetupScreen calls). No raw inserts.

- tenant `6c30af2b-a63b-4751-9876-8ce488f729d5` · slug `review-lab-disposable` · status `trial`
- owner auth user `88f7070a-…-33d775034276` (review-lab-owner@outsourcetel.com); profile row
  verified: role `tenant_owner`, correct tenant. Password not stored — reset via admin API when needed.
- Baseline auto-provisioned (parity ✅ vs demo-tenant pattern): Workspace Assistant,
  Onboarding Architect, Finance DE (active), Account Success DE (active).

## 30-day activity census (2026-07-13 → 08-12, measured 08-12)

Method: rows created in the last 30 days per table (221 public tables carry `created_at`;
292 total). This is a **proxy** census — edge-fn logs don't retain 30 days and `otel_spans`
holds only 360 rows. A table can be active from seed scripts, not users; module rows below
must attribute activity before claiming "used."

**Alive (top of 128 active tables):** audit_events 44,943 · dispatch_log 5,695 ·
de_token_usage 2,122 · de_messages 796 · de_conversations 393 · de_decision_trace 361 ·
human_tasks 313 · ops_alerts 297 · eval_judgments 248 · de_work_items 134 · golden_qa 126 ·
action_executions 94 · evidence_runs 93 · playbook_runs 84 · journal_entries 48 · de_incidents 43.

**Starved / dormant (all-time counts, not 30-day):**

| Subsystem | Evidence | Reading |
|---|---|---|
| Voice channel | voice_messages **0 ever**, voice_appointments 0 | 3 edge fns + decided plan, zero traffic — built-unproven |
| Mission delegation ("keystone") | de_missions **1 all-time** | keystone claim vs one row — starved, verify the one |
| Push | push_subscriptions **1 device** | founder-only; fleet claim untestable beyond n=1 |
| Agentic step | agentic_step_runs 6 / 30d | barely exercised |
| AI sessions / computer-use | 5 · 4 / 30d | spike-grade |
| Invoicing | invoices 5 all-time, invoice_payments 2 | machine proven once, not operating |
| End-user portal | end_user_sessions 1 / 30d | effectively unused |

## Scorecard

| # | Module | Census signal | Verdict | Evidence |
|---|---|---|---|---|
| 1 | Support pipeline (inbox→triage→topic→park→report) | de_messages 796/30d | **proven-live (prod, 2026-08-12)** | Review Lab drive: hosted intake → retrieval-grounded answer (conf 95) → draft gate HELD → escalation task → Inbox-path approve → customer-visible reply → conv `human_owned`; triage classified (general/sev3/normal). Park/snooze proven 2026-08-12 (7/7 incl. last_message_at NOT bumped, owner-only RPC). Email channel: 0 convs ever — **explained: deployed fn is dormant-honest, 503 `RESEND_INBOUND_SECRET is not set`** — wiring decision, not code defect. F-5 no-docs drop |
| 2 | Approvals spine (human_tasks→decide→execute) | human_tasks 313/30d | proven WITH defect class | golden-path 10/10 dev; prod decide driven on Review Lab 2026-08-12 — task→approved atomically, BUT consequence coupling is client-side (F-6). Ring-0 scan: 3 findings (F-1..F-3) |
| 3 | Order-to-cash (invoice→dunning→payment) | invoices 5 ever | — | machine vs demand — L quantifies |
| 4 | Mobile `/m` + push | 1 subscription | UI drive done — **F-6 defect** | phone shell renders, lists the task, decides — but its "Approve and send it" does NOT send (F-6). Push last-hop proof still outstanding |
| 5 | DE runtime (de-work/answer/orchestrate) | dispatch_log 5,695/30d | attributed 2026-08-12 | de-work 2,002 (heartbeat+loop; only 134 work items created → mostly polling) · specialist-consult 1,154 (LIVE consultation organ — called by de-answer/agentic-step/gap-detect, NOT the retired role) · maintenance drains ~1,713 (reembed/embed/fitness/conflict/gap) · real-work slice: playbook-execute 267, connector-hub 246, de-eval-online 184 · push-send 22. Verdict: runtime alive + self-maintaining; externally-valuable work is the thin slice — "wired and starved" confirmed by invocation mix |
| 6 | Knowledge (ingest→embed→retrieve) | chunks 812/30d, jobs 2/30d | **proven-live (prod, 2026-08-12)** | Review Lab: owner RLS insert → ingest-chunks (1 chunk, 1 embedded) → retrieval grounded the widget answer same-minute. Drain-path (jobs vs chunks) still to explain |
| 7 | Missions | 2 ever (1 = this drive) | **rail proven-live (prod, 2026-08-12)** | Review Lab: create_de_mission → LLM compile (standing shape, correct interpretation, **2 human gates compiled into the plan**) → plan-gate held at awaiting_approval → owner approve → running, 2 `work_watchers` rows verified (open_conversations, high_priority_conversations). NOT yet observed: a watcher FIRING and creating a case — needs dwell time; check work_watcher_matches next session |
| 8 | Playbooks | playbook_runs 84/30d | — | |
| 9 | Evals/exams | eval_judgments 248/30d | — | M: exam-vs-prod split |
| 10 | Voice | 0 ever | — | candidate: park formally |
| 11 | Connectors (ERPNext, Stripe-MCP) | connectors last_ok 08-11 | — | P re-drives writes |
| 12 | Onboarding/provisioning | **proven-live 08-12** | proven-live | Review Lab creation above |
| 13 | Org/routing/trust | assignment_rules 60/30d | — | all DEs still `supervised` |
| 14 | Governance surfaces (audit, compliance, access) | audit_events 44,943/30d | — | M: reader-side truth |
| C | **Cross-tenant isolation** | 728 SECDEF fns / 292 tables | **perimeter HELD (prod, 2026-08-12)** | live attack from Review Lab vs outsourcetel-hq: 9 direct reads = 0 rows; 2 direct writes = 0 rows (RLS); 4 object-ID SECDEF RPCs refused (task_not_found / unknown_de / not_found / not authorized); 6 tenant-PARAM SECDEF calls refused (owner-check / permission-denied / Unauthorized); connector_secrets 0 rows, `_decrypted` view permission-denied. **0 real holes.** One probe false-positive (analytics_de_workload returned empty maps not error — verified guard, not leak) |
| 15 | Tenant lifecycle (suspend/resume/delete) | — | — | Q on Review Lab |
| 16 | Platform console + team | — | — | |
| 17 | Widget/portal/hosted chat | 1 session/30d | **proven-live (prod, 2026-08-12)** | hosted intake + poll + rate-limit + key auth all exercised in the Review Lab drive; near-zero real usage remains the commercial fact |
| 18 | Marketing DE | parked (founder lock) | — | never close |
| 19 | Browser operator / computer-use | 4 tasks/30d | — | spike-grade |
| 20 | Legal pages (ToS/Privacy) | — | — | N: content never reviewed |

## FIX BACKLOG (founder-directed 2026-08-12: "keep a list of things we need to fix")

This register IS the fix list. Nothing here gets fixed until the founder says go; new confirmed
defects get an F-number and land here the moment they're proven. Ordered by severity, not date.

| Priority | Fix | Why |
|---|---|---|
| 1 | **F-6** — move draft-delivery consequence server-side (decide RPC or trigger) | phone says "Approved and sent." and sends nothing; founder uses this path daily |
| 2 | **F-1** — withdraw or re-raise the $15.6k Meridian approval (founder one-tap) + F-2 kinetic disabled-def approval | live queue rows that approve into nothing |
| 3 | **F-5** — no-knowledge widget branch must raise a human task (or flag the conv) | fresh tenants silently lose customer demand |
| 4 | **F-7** — extend ring-0 probe to the draft-delivery consequence class | the gate that should have caught F-6 can't see it |
| 5 | **F-3** — grant workforce_assistant role or rebind the onboarding step | HQ onboarding step can never run |
| 2= | **F-4** — bring dev up to prod's ledger (apply the 74 missing migrations) and drop the 7 specialist-era zombie tables | golden-path certifies a schema 74 migrations stale; migs 666–709 have no loop coverage at all |
| 4= | **F-8** — make golden-path's drift footer *measure* production instead of printing `881 / 284 / 657`; delete the two stale "dev has no ledger" claims | the indicator for F-4 cannot fail, so the drift grew unseen |
| 7 | **W-1** (wiring, founder decision) — light the email channel: set RESEND_INBOUND_SECRET + RESEND_API_KEY, pick receiving domain/addresses | the default mid-market support channel has never carried a message; fn is deployed and dormant-honest |

## Confirmed findings register (starts 2026-08-12)

| ID | Found by | Finding | Status |
|---|---|---|---|
| F-1 | certify ring-0 | **Unexecutable approval, no executor:** outsourcetel-hq task `03aaa6dd` "$15,600 invoice to Meridian Group — test ping" (2026-08-10) has NO action_executions row on either linkage column. Approving it flips to approved and sends nothing. Probe never decides — **needs founder withdraw or re-raise** | OPEN — founder decision |
| F-2 | certify ring-0 | **Mismatched pair:** kinetic approval "Create a specialist desk" names definition `create_specialist` which is **disabled** (retired Specialist role); resolver only sees active → `action_definition_not_found`, silently nothing sent | OPEN |
| F-3 | certify ring-0 | **Unrunnable onboarding binding:** outsourcetel-hq SaaS-starter `locations_configured → propose_connector` requires role `workforce_assistant`; assigned employee (Onni) lacks it | OPEN |
| F-4 | golden-path footer → **RESOLVED + UPGRADED in D (2026-08-12)** | **Dev is 74 migrations BEHIND production, not ahead.** Ledger: prod 731, dev 657, and **zero** migrations exist in dev that aren't in prod. Dev only *looks* bigger because it carries **7 zombie tables from the retired Specialist era** (de_specialist_assignments, spec_consultations, specialist_profiles, specialist_sources, embed_tokens, scribe_requests, sod_policies) that never shipped. Dev is **missing 5 tables of shipped production features**: `tenant_brand_identity` (666), `conversation_checks` (667/668), `push_subscriptions` (670), `unit_tripwires` (687), `benchmark_samples`. **Consequence: golden-path — certify's ONLY write-path proof, "the spec that runs" — executes against a schema 74 migrations stale, so migs 666–709 are entirely uncovered by it** (incl. 701/703/704, the fixes for the very unexecutable-approval class F-1/F-2 belong to) | **CLOSED (verified 2026-08-20):** `scripts/sync-dev-migrations.mjs` (register B-6) applies the set difference before golden-path in CI; dev ledger today = 826 rows, latest `807…` — level with production the same morning the file landed |
| F-8 | Workstream D, reading [golden-path.mjs:327](../scripts/golden-path.mjs) | **The drift indicator is hardcoded fiction.** The footer that exists *specifically* to surface F-4 prints `(production: 881 / 284 / 657)` as a **string literal** — production is never queried. Real prod today: 918 routines / 293 tables / 731 ledger. Two more stale claims in the same file: the L65 comment and the L192 CANNOT-PROVE message both assert dev "has NO migration ledger (0 rows)" — dev has had 657 for some time. A stored marker read as truth: the one organ that would have caught the drift **cannot ever change**, so it reported "in sync" while dev fell 74 behind | **FIXED (verified 2026-08-20):** the footer now queries production live with a NOT-MEASURED fallback (golden-path.mjs:332-348) |

| F-5 | B drive v1 | **No-knowledge questions vanish:** widget-ask's no-docs branch ([widget-ask/index.ts:631](../supabase/functions/widget-ask/index.ts)) sends canned "check back soon" with `escalated:false`, **no human_task, no event** — a fresh tenant's customer questions are recorded but nobody is ever told. Conv stays `ai_handling` so no inbox surface flags it | **FIXED (verified in code 2026-08-20):** the branch now inserts the message `escalated:true`, flips the conv to `needs_human` with a handoff summary, raises a `human_tasks` escalation, and writes activity + audit events — the code comment cites this register entry |
| F-6 | B drive v2 + **mobile UI drive 2026-08-12** | **UI-PROVEN on deployed prod app:** in `/m`, the decision card's button reads **"Approve and send it"**; tapping it showed **"Approved and sent." / "All clear."** while the DB read task=`approved`, draft **still `draft_pending`**, conv still `needs_human`. The phone affirmatively claims a send that never happened. Same strand demonstrated earlier via raw RPC; HumanTasksPage:480 shares the call path (code-read). Fix shape: consequence must live server-side (decide RPC or trigger), not in one screen's JS | **FIXED — mig 721 `approving_a_draft_reply_actually_sends_it` moved the consequence server-side (verified 2026-08-20: migration applied; client decide path carries delivery hooks + verifyConsequence)** |
| F-7 | analysis of F-6 vs ring-0 | **Gate blind spot:** certify's unexecutable-approval probe scans `action_executions` linkage only; the draft-reply consequence class (de_messages.delivery) is invisible to it — F-6 could recur silently | **CLOSED** — certify probe `no-approval-that-said-sent-and-sent-nothing` covers the class (see B-8 note below) |
| N-1 (note, not defect) | Workstream C | `analytics_de_workload` (and any fn ANDing `can_access_de` with a service_role branch) returns EMPTY for legitimate userless server calls — a functional over-lock, not a security hole. Flag for I/M when analytics reliability is assessed | NOTE |

Certify verdict at review start: **NOT CERTIFIED** (ring0-probes red; all 9 other sections green,
incl. typecheck, migration-ledger, role-gates, silent-refusals, golden-path, suite 55.6s).

**B session 2 (2026-08-12) production drive transcript (Review Lab):** owner-signin ✅ ·
knowledge-doc RLS insert ✅ · chunk+embed 1/1 ✅ · widget-key RLS insert ✅ · hosted ask →
conf-95 grounded answer ✅ · draft gate held ✅ · escalation task raised ✅ · customer-sees-nothing
pre-decision ✅ · decide (raw RPC) ✅ → **draft stranded (F-6)** · Inbox-path `approve_draft_reply`
→ delivery=sent, customer sees reply, conv `human_owned` ✅ · triage classified ✅.

## Workstream C — security & tenancy (session 2026-08-12)

**Verdict so far: the cross-tenant perimeter HELD under live attack.** Attacker = Review Lab
owner (a real tenant with a real JWT), target = outsourcetel-hq. Nothing leaked, nothing mutated,
no SECDEF function trusted a tenant_id parameter. This spot-confirms the migs 662–664 perimeter
work against *today's* production and against the 42 SECDEF functions added since (665–706).

Certify's two standing gates both green in the review-start run: `secdef-caller-tenant-ratchet`,
`secdef-search-path-ratchet`. `rls-on-every-public-table` also green.

**C still owes (next C session):** (a) the security-deferred checklist ([[security_deferred_items]])
item-by-item; (b) write-side perimeter on a wider table set (I hit the highest-value writes, not
all 292); (c) the `authenticated`-role default-grant sweep on the 42 new functions
([[security_default_execute_grant]] — revoke public+anon+authenticated); (d) anon-role probe (not
just cross-tenant-authenticated). None blocked by today's evidence; all are breadth, not a
suspected hole.

## Workstream D — code health & architecture (session 2026-08-12)

**Method: re-score, don't re-derive.** docs/47 + `review/debt-map-findings.json` already hold
**86 MEASURED findings** across 9 dimensions (giants 11 · duplication 8 · schema 7 · routines 9 ·
ui 9 · tests 13 · deps 12 · infra 8 · docs 9). D spot-checks the headline claims against today
rather than repeating the audit.

**Re-scored so far:**

| Debt finding | Then | Today | Verdict |
|---|---|---|---|
| #58 CI + runtime floor on Node 20 (EOL) | r4 | `.github/workflows/ci.yml` runs **node-version: 22** on all 3 jobs | **REMEDIATED** |
| #44 "CI runs 3 of 10 test files" | r5/i5 | CI now runs test:unit, **certify:offline**, audit, audit:toolchain, test:isolation, test:invariants | **materially improved** — re-measure exact file count before final scoring |
| #46 "cross-tenant isolation behaviourally proven on 1 table of 242" | r5/i5 | Workstream C proved **9 tables + 2 write paths + 10 SECDEF RPCs** under live attack | **materially improved** (still not all 292 — breadth remains) |
| #74 dev is a divergent environment | r3 | **Confirmed and worse than stated** — see F-4/F-8 | **UPGRADED** |

**Carried-forward r5 findings — RE-CHECKED 2026-08-12.** The line below used to read
"not yet re-checked, carried forward", and two of its six had already been closed or refuted when
it was written. That is the drift docs/53 §4 names, so each is now given its verdict and its
evidence rather than being deleted:

| r5 finding | Verdict today | Evidence (re-runnable) |
|---|---|---|
| **#0** playbook branch executor runs 6 of the 9 step types its own validator accepts — a playbook can report COMPLETED having done neither requested action | **CLOSED** | `BRANCH_ALLOWED` is now 8 keys with 8 matching `case` arms in `runBranchStep` (`supabase/functions/playbook-execute/index.ts`), `wait` REFUSED rather than silently skipped, and `scripts/playbook-branch-parity.mjs` (5 arms, 3 of them driving the deployed function) is wired into `certify`. Register `B-9`. |
| **#35** zero component tests over 73,790 lines of UI | **STANDS** | 20 test files under `tests/`; `grep -l @testing-library tests/*.ts` → **0**. Register `D-7`. |
| **#47** the action gate is untested | **CLOSED — was already closed when this line was written** | `tests/action-gate.test.ts` holds **18** top-level cases (`grep -cE "^\s*(it\|test)\(" tests/action-gate.test.ts`), landed in `da9ef788`. |
| **#57** edge functions have no lockfile + 68 floating imports | **HALF REFUTED, HALF STANDS** | `deno.lock` **is tracked** (`git ls-files deno.lock`) — the lockfile half was never true. The floating-import half stands and the count moved: **71 of 133** remote imports carry no `@x.y.z` pin (re-counted 2026-08-12). Register `D-12`. |
| **#70** no automated backups (**feeds E**) | **REFUTED** | Management API `/v1/projects/rfsvmhcqeiyrxivbmpel/database/backups` 2026-08-12: `walg_enabled: true`, **7 daily physical backups, all COMPLETED** (most recent 2026-08-12T03:30Z). ⚠ Separately true and NOT refuted: `pitr_enabled: false`. |
| **#73** the JWT gate for the edge functions exists only inside Supabase | **STANDS** | `supabase/config.toml` does not exist and no `.toml` under `supabase/` mentions `verify_jwt`, across **64** function directories. Register `D-8`. |

## B priority queue (next sessions)

1. ~~Approvals spine mechanics~~ ✅ · ~~production decide on Review Lab~~ ✅ 2026-08-12 (found F-6).
2. ~~Support pipeline e2e~~ ✅ 2026-08-12 (hosted channel). Remaining slice: email-inbound
   (0 conversations ever — needs an inbound address) and park/snooze exercise.
2b. ~~Drive F-6 through the REAL mobile UI~~ ✅ 2026-08-12 — UI-PROVEN, see F-6. (Browser-pane
    note: taps were dispatched programmatically to the deployed app's own buttons — same React
    handlers — because the pane was hidden; screen text captured after each tap.)
3b. ~~mission e2e~~ ✅ · ~~email-inbound~~ ✅ (dormant-by-config, W-1) · ~~park/snooze~~ ✅ —
    all 2026-08-12. **B core COMPLETE.** Open B residue: watcher-fire observation (dwell) ·
    push last-hop. Review widens next to C (security) and D (code health); fixes on founder go.
3. DE runtime attribution — split dispatch_log 5,695 into real-work vs heartbeat vs exam.
4. Mission #7 — drive one mission end-to-end (the keystone has exactly one data point).
5. Knowledge — ingest one doc on Review Lab; explain jobs=2 vs chunks=812.

## Verification sweep 2026-08-13 (results filed to the register, not here)

Re-verified two of this document's findings against live production; both agree with
`review/deferred-register.json`, which is the authoritative open state:

- **B-1 / F-6 — CLOSED, now proven.** mig 721 installs `trg_sync_conversation_draft` (6th
  status-sync trigger). Re-ran the exact failing test: fresh hosted draft → raw
  `decide_human_task` (the path that stranded it) → `delivery=sent`, conv `human_owned`,
  customer poll shows 1 message. Pre-fix rows stay stranded by design.
- **B-8 / F-7 — CLOSED.** certify probe `no-approval-that-said-sent-and-sent-nothing` covers the
  class with a mechanism arm, so a quiet week cannot fake a pass.
- **B-6 / F-4 — measurably WORSE:** dev ledger 657, prod **777** (was 731 on 08-12) → the gap
  grew 74 → **120 migrations** in a day.

⚠ **Correction to this document:** its carried-forward r5 list named debt #0 (playbook branch
executor) as still-standing. It was already fixed — register **B-9 closed**. I carried those
r5 items forward from docs/47 without re-measuring them, which is the precise failure docs/53
names. The register exists because of it; open state belongs there.
