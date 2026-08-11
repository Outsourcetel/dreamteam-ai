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
| 1 | Support pipeline (inbox→triage→topic→park→report) | de_messages 796/30d | — | migs 667–671 claim proven-live; B spot-confirms on Review Lab |
| 2 | Approvals spine (human_tasks→decide→execute) | human_tasks 313/30d | mechanics proven (dev) / **3 live defects (prod)** | golden-path 10/10 (2026-08-12); certify ring-0 scanned 90 pending, 89 routable vs 235 defs → 3 findings below. Prod Review-Lab drive still owed |
| 3 | Order-to-cash (invoice→dunning→payment) | invoices 5 ever | — | machine vs demand — L quantifies |
| 4 | Mobile `/m` + push | 1 subscription | — | last-hop proof outstanding |
| 5 | DE runtime (de-work/answer/orchestrate) | dispatch_log 5,695/30d | — | attribute: real work vs heartbeat? |
| 6 | Knowledge (ingest→embed→retrieve) | chunks 812/30d, jobs 2/30d | — | jobs vs chunks mismatch to explain |
| 7 | Missions | 1 ever | — | drive one live on Review Lab |
| 8 | Playbooks | playbook_runs 84/30d | — | |
| 9 | Evals/exams | eval_judgments 248/30d | — | M: exam-vs-prod split |
| 10 | Voice | 0 ever | — | candidate: park formally |
| 11 | Connectors (ERPNext, Stripe-MCP) | connectors last_ok 08-11 | — | P re-drives writes |
| 12 | Onboarding/provisioning | **proven-live 08-12** | proven-live | Review Lab creation above |
| 13 | Org/routing/trust | assignment_rules 60/30d | — | all DEs still `supervised` |
| 14 | Governance surfaces (audit, compliance, access) | audit_events 44,943/30d | — | M: reader-side truth |
| 15 | Tenant lifecycle (suspend/resume/delete) | — | — | Q on Review Lab |
| 16 | Platform console + team | — | — | |
| 17 | Widget/portal/hosted chat | 1 session/30d | — | |
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

Certify verdict at review start: **NOT CERTIFIED** (ring0-probes red; all 9 other sections green,
incl. typecheck, migration-ledger, role-gates, silent-refusals, golden-path, suite 55.6s).

## B priority queue (next sessions)

1. ~~Approvals spine mechanics~~ ✅ 2026-08-12 (golden-path dev + certify prod scan). Remaining:
   one PRODUCTION approval driven e2e on Review Lab — needs intake channel, so combine with 2.
2. Support pipeline on Review Lab — email-inbound → conversation → triage → topic → park →
   escalation raises a human task → decide → verify execution outside the ledger.
3. DE runtime attribution — split dispatch_log 5,695 into real-work vs heartbeat vs exam.
4. Mission #7 — drive one mission end-to-end (the keystone has exactly one data point).
5. Knowledge — ingest one doc on Review Lab; explain jobs=2 vs chunks=812.
