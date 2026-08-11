# 50 — Full Review Scorecard (living document)

**Programme:** 19-workstream review (doc 49 = inventory). This is the one page that fills in as
workstreams land evidence. States: `proven-live` / `built-unproven` / `inferred` / `dead` /
`—` (not yet examined). Update in place; never delete a row.

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
| 1 | Support pipeline (inbox→triage→topic→park→report) | de_messages 796/30d | **proven-live (prod, 2026-08-12)** | Review Lab drive: hosted intake → retrieval-grounded answer (conf 95) → draft gate HELD → escalation task → Inbox-path approve → customer-visible reply → conv `human_owned`; triage classified (general/sev3/normal). Caveats: email channel has 0 conversations EVER; F-5 no-docs drop |
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
| 15 | Tenant lifecycle (suspend/resume/delete) | — | — | Q on Review Lab |
| 16 | Platform console + team | — | — | |
| 17 | Widget/portal/hosted chat | 1 session/30d | **proven-live (prod, 2026-08-12)** | hosted intake + poll + rate-limit + key auth all exercised in the Review Lab drive; near-zero real usage remains the commercial fact |
| 18 | Marketing DE | parked (founder lock) | — | never close |
| 19 | Browser operator / computer-use | 4 tasks/30d | — | spike-grade |
| 20 | Legal pages (ToS/Privacy) | — | — | N: content never reviewed |

## Confirmed findings register (starts 2026-08-12)

| ID | Found by | Finding | Status |
|---|---|---|---|
| F-1 | certify ring-0 | **Unexecutable approval, no executor:** outsourcetel-hq task `03aaa6dd` "$15,600 invoice to Meridian Group — test ping" (2026-08-10) has NO action_executions row on either linkage column. Approving it flips to approved and sends nothing. Probe never decides — **needs founder withdraw or re-raise** | OPEN — founder decision |
| F-2 | certify ring-0 | **Mismatched pair:** kinetic approval "Create a specialist desk" names definition `create_specialist` which is **disabled** (retired Specialist role); resolver only sees active → `action_definition_not_found`, silently nothing sent | OPEN |
| F-3 | certify ring-0 | **Unrunnable onboarding binding:** outsourcetel-hq SaaS-starter `locations_configured → propose_connector` requires role `workforce_assistant`; assigned employee (Onni) lacks it | OPEN |
| F-4 | golden-path footer | **Dev/prod drift:** dev 915 routines / 294 tables vs prod 881 / 284, same ledger height (657) — 34 routines + 10 tables ahead of prod. Explain in D/E | OPEN |

| F-5 | B drive v1 | **No-knowledge questions vanish:** widget-ask's no-docs branch ([widget-ask/index.ts:631](../supabase/functions/widget-ask/index.ts)) sends canned "check back soon" with `escalated:false`, **no human_task, no event** — a fresh tenant's customer questions are recorded but nobody is ever told. Conv stays `ai_handling` so no inbox surface flags it | OPEN |
| F-6 | B drive v2 + **mobile UI drive 2026-08-12** | **UI-PROVEN on deployed prod app:** in `/m`, the decision card's button reads **"Approve and send it"**; tapping it showed **"Approved and sent." / "All clear."** while the DB read task=`approved`, draft **still `draft_pending`**, conv still `needs_human`. The phone affirmatively claims a send that never happened. Same strand demonstrated earlier via raw RPC; HumanTasksPage:480 shares the call path (code-read). Fix shape: consequence must live server-side (decide RPC or trigger), not in one screen's JS | OPEN — **top priority** |
| F-7 | analysis of F-6 vs ring-0 | **Gate blind spot:** certify's unexecutable-approval probe scans `action_executions` linkage only; the draft-reply consequence class (de_messages.delivery) is invisible to it — F-6 could recur silently | OPEN |

Certify verdict at review start: **NOT CERTIFIED** (ring0-probes red; all 9 other sections green,
incl. typecheck, migration-ledger, role-gates, silent-refusals, golden-path, suite 55.6s).

**B session 2 (2026-08-12) production drive transcript (Review Lab):** owner-signin ✅ ·
knowledge-doc RLS insert ✅ · chunk+embed 1/1 ✅ · widget-key RLS insert ✅ · hosted ask →
conf-95 grounded answer ✅ · draft gate held ✅ · escalation task raised ✅ · customer-sees-nothing
pre-decision ✅ · decide (raw RPC) ✅ → **draft stranded (F-6)** · Inbox-path `approve_draft_reply`
→ delivery=sent, customer sees reply, conv `human_owned` ✅ · triage classified ✅.

## B priority queue (next sessions)

1. ~~Approvals spine mechanics~~ ✅ · ~~production decide on Review Lab~~ ✅ 2026-08-12 (found F-6).
2. ~~Support pipeline e2e~~ ✅ 2026-08-12 (hosted channel). Remaining slice: email-inbound
   (0 conversations ever — needs an inbound address) and park/snooze exercise.
2b. ~~Drive F-6 through the REAL mobile UI~~ ✅ 2026-08-12 — UI-PROVEN, see F-6. (Browser-pane
    note: taps were dispatched programmatically to the deployed app's own buttons — same React
    handlers — because the pane was hidden; screen text captured after each tap.)
3b. Next: one mission e2e · email-inbound slice · park/snooze · F-6/F-5 fixes when founder says go.
3. DE runtime attribution — split dispatch_log 5,695 into real-work vs heartbeat vs exam.
4. Mission #7 — drive one mission end-to-end (the keystone has exactly one data point).
5. Knowledge — ingest one doc on Review Lab; explain jobs=2 vs chunks=812.
