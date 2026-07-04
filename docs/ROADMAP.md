# DreamTeam AI — Production Roadmap

_Formalized 2026-07-04 from the on-target scorecard (overall ~6.8/10). Companion to [PROTOTYPE-PRODUCTION-BOUNDARY.md](PROTOTYPE-PRODUCTION-BOUNDARY.md) and [SCALING-ARCHITECTURE.md](SCALING-ARCHITECTURE.md). Governing doctrine: DEs act like employees across existing systems of record, inside the judgment machinery (Workforce Engine). Every item below deepens the machinery — nothing decorates._

## R1 — Activation & E2E proof  `blocked on: founder's Anthropic API key`
Set ANTHROPIC_API_KEY edge secret → full end-to-end test: knowledge upload → grounded answer w/ sources → guardrail violation blocked + escalated → immutable audit chain verified → widget path → cache write confirmed. Fix known gap: widget-ask pre-LLM usage_metrics not incrementing. TODO(R1-activation): wire the `de_autonomy` answer-confidence floors (`answer_dock` / `answer_widget`, stored by R5 migration 016 and configurable on the trust dial) into de-answer and widget-ask — dormant until the key.
**Moves scores:** Trust 4→5, Live depth 6.5→7.5.

## R2 — Systems-of-Record connector layer v1  ✅ **SHIPPED**
The doctrine-critical gap (scored 2/10). Connector framework implementing the SoR principle:
- ✅ Schema (migration 017): `connectors` + `connector_objects` (per-object mode `sync` vs `read_through`) + `connector_actions` (write-back registry) + `connector_secrets` — service-role-only credential table written via SECURITY DEFINER RPC, never client-readable (Vault/KMS encryption is the hardening step; per-DE scoping next). `support_tickets` gained `source`+`external_ref` as the working-cache key.
- ✅ **Zendesk connector v1** (`connector-zendesk` edge fn, deployed): test / sync_tickets (incremental pull, 300-ticket cap per run, upsert into support_tickets) / read_ticket read-through (nothing persisted except the audit event) / write_back `add_internal_note`+`update_status`. Audit categories `connector_sync`/`connector_action` added.
- ✅ Live Connectors page: connect flow (Test & Save), object-mode table w/ intervals, write-back toggles, sync now, read-through demo, disconnect w/ credential purge. Zendesk source chip on live Support tickets.
- ⏸ Renewal playbook write-back step slot: deferred to the first billing connector (Zuora) — nothing to bind yet.
**Verified to the credential boundary (fake creds return structured `zendesk_auth_failed`, proving the full path to Zendesk's door); founder connects a free Zendesk trial to prove end-to-end.**
**Moves scores:** SoR layer 2→5.

## R3 — Live Proving Ground v1  `SHIPPED — runs dormant until key`
Golden Q&A pairs per tenant (`golden_qa`), eval runner edge function that asks the live DE each question and grades answer-contains-expected + confidence calibration; `eval_runs` history; **knowledge publishes gated on regression** (tenant-overridable, override audited). Live Proving Ground page: suite editor, starter-suite generator, run history, pass/fail detail. Operationalizes DE-machinery learning #9 (verify claims — "done" is not evidence).
**Shipped notes:** migration 018 + `eval-run` edge function (JWT-forwarding to de-answer verified; `blocked_llm` honest-dormant path verified live) + `src/lib/evalApi.ts` + `LiveProvingGround.tsx` + eval-gate dialog in LiveKnowledgeLibrary. Grader v1 is fragment matching (LLM-judge grading is the upgrade); gate is client-side soft (server-side hard gate in ingest-chunks is the hardening step).
**Moves scores:** Trust 4→6 (with R1 active).

## R4 — Server-side playbook executor  `buildable now`
Move renewal_v1 orchestration from browser (`playbookApi.ts`) into a `playbook-execute` edge function: runs advance server-side, survive closed tabs, steps idempotent, human-gate resume triggered by decideHumanTask via RPC. Client becomes start/observe only. Groundwork for the tenant playbook builder.
**Moves scores:** Engine 7→8, Stack 8.5→9.

## R5 — Trust dial v1 (per-action autonomy thresholds)  `buildable now, answer-path dormant until key`
`de_autonomy` config per tenant per action type: auto-approve invoice ≤ $X at confidence ≥ Y%; answer-confidence floor per channel (dock vs widget). Enforced in generateInvoice/playbook gate now, in de-answer/widget-ask on activation. Live UI on the DE profile (first live DE-profile surface) with the evidence line ("94% of Casey's invoices approved unchanged — raise the limit?") fed from audit_events. Productizes learnings #3/#5.
**Moves scores:** Engine 8→8.5, Features 7→7.5.

## R6 — Tenant playbook builder  ✅ **SHIPPED**
Tenants compose playbooks from typed step primitives (`check_account`, `generate_invoice`, `human_approval`, `guardrail_check`, `connector_action`, `update_record`, `log_activity`, `complete`) in a builder UI (Playbooks live mode). Definitions (`playbook_definitions`, migration 019) are validated server-side on publish (structured errors: unknown primitive, bad params, >20 steps, gate-ordering rules) and snapshotted into immutable `playbook_versions` — runs execute the snapshot via the generalized `playbook-execute` executor, never the live draft. Guardrail + trust-dial composition applies to every generated invoice exactly as in renewal_v1.
**Honest notes:** manual trigger only in v1 — `schedule`/`event` trigger types are reserved columns, not wired. Human-gate resume is split: `resume_playbook_on_task` advances post-gate steps it can do natively in SQL (guardrail_check / update_record / log_activity / complete); a post-gate `connector_action` needs HTTP, so the RPC parks the run in `resume_pending` and `decideHumanTask` fires the edge function's `advance` to finish it. `connector_action` degrades honestly — no connected connector / no target ref → step recorded `skipped`, run continues. `update_record` is a whitelisted status flip only. Legacy `renewal_v1` runs untouched (regression-verified).
**Moves scores:** Engine 8.5→9, Features 7.5→8.

## R7 — Scheduled & event playbook triggers  ✅ **SHIPPED**
Fills the `trigger_type` slots reserved in R6. Migration 020: `playbook_schedules` (friendly cadences — daily/weekly/monthly at a UTC hour, **deliberately not raw cron strings**; `next_fire_at` computed server-side on every write), `playbook_event_rules` (two event keys in v1: `invoice_overdue` w/ `overdue_days`, `ticket_synced_high_priority` w/ `priority`; per-target `cooldown_hours` dedup, default 24h), `playbook_trigger_fires` (firing log — every dispatch decision is a row: `pending_start` → `started`/`error`, or `skipped_dedup` recorded once per cooldown window). `dispatch_due_triggers()` (SECURITY DEFINER, pure SQL) evaluates due schedules + event matches into `pending_start` fires and stamps schedule `last/next_fire_at` atomically — a crashed HTTP processor can never double-fire a schedule. The `playbook-execute` `dispatch` action turns pending fires into real definition runs (same start path as manual runs — guardrails, gates, and the audit chain all apply) and audits each fire (`playbook_step`, `detail.kind='trigger_fire'`).
**Dispatch mode achieved (verified on the project):** pg_cron 1.6.4 + pg_net 0.20.3 + Vault all live → **primary: pg_cron job every 5 minutes** (`playbook-dispatch-5min` → `invoke_playbook_dispatch()` → pg_net POST with the Vault-held `playbook_dispatch_secret`, provisioned out of band, never in git). Live cron ticks observed in `cron.job_run_details` (succeeded). **Backup: opportunistic dispatch** when the Playbooks page loads, scoped server-side to the caller's tenant.
**Honest notes:** friendly cadences only, not cron expressions; two event keys in v1; events are *polled* on the 5-minute tick, not pushed; `all_eligible` targeting = accounts with a renewal date within N days (default 60). E2E verified: due schedule → fire `started` → run completed; overdue sent invoice → event fire → run; second dispatch inside cooldown → `skipped_dedup`; audit chain intact after all fires.
**Moves scores:** Engine 9→9.5 — playbooks now run without a human pressing the button, inside the same judgment machinery.

## Lifecycle completion

### Customer Success — end-to-end  ✅ **SHIPPED**
Migration 021. Health is **computed from real signals** (open/pending tickets, escalations, overdue sent invoices, activity recency), never hand-entered: each account carries a transparent `health_components` breakdown ("Tickets −10 · Escalations −15 · Overdue invoice −21 · Activity −20"), weights and at-risk/healthy thresholds are tenant-configurable (`health_score_config`), and status flips active↔at_risk automatically (churned never touched; ONE audit event per flip, not per recompute). The payoff loop: new `account_at_risk` event key on the R7 trigger machinery — an account sitting at-risk fires a playbook automatically (optional min-ARR filter, per-account cooldown dedup). Recompute paths: nightly via the existing pg_cron dispatcher (24h staleness check on every 5-min tick, runs BEFORE dispatch so a flip fires the same cycle), opportunistic on Success page load (>1h stale), and a "Recompute now" button. Success page rebuilt: header stats (accounts / at-risk / avg health / ARR at risk), breakdown popovers, account signal drawer with run-playbook, collapsible scoring config. **Honest:** no health history in v1 (latest breakdown only); recency reads from `activity_events` only.

### Onboarding — next
Won-deal handoff → structured onboarding checklist playbooks on the same trigger machinery.

### BD / Sales — connector-first
Pipeline lives in the tenant's CRM (SoR principle); DreamTeam reads via connectors rather than rebuilding a CRM. Demo pages stay demo until a connector lands.

## Sequencing
R2, R4, R5 build in parallel now (R4+R5 fully testable pre-key; R2 testable to credential boundary). R3 follows immediately after (shares de-answer surface). R1 executes the moment the key arrives and re-tests everything the others shipped. Then: **pressure-test rescore** against this scorecard.

## Explicitly deferred (triggers unchanged)
Queue/tiering (volume), ~~tenant playbook builder (after R4)~~ **shipped as R6**, LLM-judge guardrails (after R1 economics), Trust & Architecture page (first security review), PDF/DOCX ingestion (first tenant needing it), signed widget JWTs (first embedded pilot).
