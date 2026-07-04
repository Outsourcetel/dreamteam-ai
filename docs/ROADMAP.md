# DreamTeam AI — Production Roadmap

_Formalized 2026-07-04 from the on-target scorecard (overall ~6.8/10). Companion to [PROTOTYPE-PRODUCTION-BOUNDARY.md](PROTOTYPE-PRODUCTION-BOUNDARY.md) and [SCALING-ARCHITECTURE.md](SCALING-ARCHITECTURE.md). Governing doctrine: DEs act like employees across existing systems of record, inside the judgment machinery (Workforce Engine). Every item below deepens the machinery — nothing decorates._

## R1 — Activation & E2E proof  `blocked on: founder's Anthropic API key`
Set ANTHROPIC_API_KEY edge secret → full end-to-end test: knowledge upload → grounded answer w/ sources → guardrail violation blocked + escalated → immutable audit chain verified → widget path → cache write confirmed. Fix known gap: widget-ask pre-LLM usage_metrics not incrementing.
**Moves scores:** Trust 4→5, Live depth 6.5→7.5.

## R2 — Systems-of-Record connector layer v1  `buildable now`
The doctrine-critical gap (scored 2/10). Connector framework implementing the SoR principle:
- `connectors` + `connector_objects` schema: per-object mode `sync` (cached working copy, TTL/webhook refresh) vs `read_through` (fetched at action time, never persisted); per-action write-back bindings; credentials encrypted, scoped per tenant (per-DE scoping next).
- **Zendesk connector v1**: sync tickets → support_tickets working cache; read_through ticket detail; write-back "add internal note / update status".
- Renewal playbook gains an optional write-back step slot (invoice lands in the SoR when a billing connector exists).
- Live Connectors page: connect flow (tenant pastes their API token), object-mode table, sync status, last-sync, disconnect.
**Testable to the credential boundary without a Zendesk account; founder can connect a free Zendesk trial to prove end-to-end.**
**Moves scores:** SoR layer 2→5.

## R3 — Live Proving Ground v1  `buildable now, runs dormant until key`
Golden Q&A pairs per tenant (`golden_qa`), eval runner edge function that asks the live DE each question and grades answer-contains-expected + confidence calibration; `eval_runs` history; **knowledge publishes blocked on regression** (ingest-chunks gated by last eval status, tenant-overridable). Live Proving Ground page: suite editor, run history, pass/fail detail. Operationalizes DE-machinery learning #9 (verify claims — "done" is not evidence).
**Moves scores:** Trust 4→6 (with R1 active).

## R4 — Server-side playbook executor  `buildable now`
Move renewal_v1 orchestration from browser (`playbookApi.ts`) into a `playbook-execute` edge function: runs advance server-side, survive closed tabs, steps idempotent, human-gate resume triggered by decideHumanTask via RPC. Client becomes start/observe only. Groundwork for the tenant playbook builder.
**Moves scores:** Engine 7→8, Stack 8.5→9.

## R5 — Trust dial v1 (per-action autonomy thresholds)  `buildable now, answer-path dormant until key`
`de_autonomy` config per tenant per action type: auto-approve invoice ≤ $X at confidence ≥ Y%; answer-confidence floor per channel (dock vs widget). Enforced in generateInvoice/playbook gate now, in de-answer/widget-ask on activation. Live UI on the DE profile (first live DE-profile surface) with the evidence line ("94% of Casey's invoices approved unchanged — raise the limit?") fed from audit_events. Productizes learnings #3/#5.
**Moves scores:** Engine 8→8.5, Features 7→7.5.

## Sequencing
R2, R4, R5 build in parallel now (R4+R5 fully testable pre-key; R2 testable to credential boundary). R3 follows immediately after (shares de-answer surface). R1 executes the moment the key arrives and re-tests everything the others shipped. Then: **pressure-test rescore** against this scorecard.

## Explicitly deferred (triggers unchanged)
Queue/tiering (volume), tenant playbook builder (after R4), LLM-judge guardrails (after R1 economics), Trust & Architecture page (first security review), PDF/DOCX ingestion (first tenant needing it), signed widget JWTs (first embedded pilot).
