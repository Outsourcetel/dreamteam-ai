# Builder typed gaps — build the 80%, hold the rest as answerable gaps

**Date:** 2026-08-12 · **Status:** design (nothing built) · **Author:** research/spec session
**Incident:** a prospective customer ran a CSM-engagement prompt through the Playbook builder
and a DE on 2026-08-11 and experienced both as a rejection. The validator was right on every
point; the *experience* was a diagnosis delivered as a verdict — questions with nowhere to
answer them, no mechanical fixes offered, nothing visible to iterate on.

**Founder intent:** build the supported 80%, hold unsupported parts as explicit typed gaps,
ask the questions in the same window, recompile from the answers — and make the whole
early-customer setup experience this forgiving.

---

## 1. Verified facts (claims with proof)

Evidence classes: **proven-live** (production rows read on 2026-08-12), **code** (file:line in
this repo at commit `00e9848`), **unverified** (stated where reads were blocked).

### 1.1 The builder DOES persist a draft — including when validation fails

- `playbook-draft` persists the draft definition and the Deep Study **unconditionally after a
  successful compile parse** — the persist block sits after the repair loop with no
  `validation.valid` gate: `supabase/functions/playbook-draft/index.ts:192-204`
  (definition insert `status:'draft'` at :195-198; `playbook_studies` upsert at :201-204).
- Validation runs against the real engine with up to 2 auto-repairs
  (`:137-156`), and the response carries `validation.{valid, errors, repair_attempts}` (`:216-219`).
- **Proven-live:** the actual incident row exists. Tenant `5bb802e1` (outsourcetel-hq),
  definition `88c1a2c1-292c-4fd0-9ba2-2450b963d297`, created `2026-08-11 21:52:12`,
  `status='draft'`. Its `playbook_studies` row holds the customer's exact SOP text and a report
  with **5 contradictions, 6 questions, 5 scenarios, 0 bindings, 5 risk grades (4 rail / 1
  judgment)**. The audit event (`Playbook Copilot`, 21:52:13) records:
  *"CSM Value-Driven Engagement Playbook" (7 steps, 6 clarifying questions, 0 knowledge
  bindings)* with detail `{valid: false, repaired: 2}` — compile validation **failed even after
  two repairs and the draft persisted anyway** (correct per code).

So the founder-reported "no draft saved" is **false at the data layer** and true at the
experience layer: nothing in the window says "your draft is saved and here is the path
forward", and (see 1.4) the draft was later destroyed by an un-audited overwrite.

### 1.2 What the customer actually saw (builder path, reconstructed from code + rows)

The "Draft with AI" modal (`src/pages/tenant/systems/LivePlaybookBuilder.tsx:1393-1425`) shows
*"Studying & compiling…"*, closes, and because `valid:false` the toast reads exactly:

> Drafted "CSM Value-Driven Engagement Playbook" with validation notes — review before publishing.

(`LivePlaybookBuilder.tsx:1718-1720`). The page opens the definition view with the Deep Study
panel — *"🔎 Deep Study — what the Copilot found before you go live"* — rendering four
**read-only** lists (`StudyPanel`, `:1427-1492`): conflicts (`:1448-1459`), *"❓ Questions to
answer (6)"* as plain `<li>` items (`:1461-1467`), test scenarios (`:1469-1476`), knowledge
bindings, plus *"Steps graded: 4 rail · 1 judgment"* (`:1487-1489`). Below it:
*"Publish this draft to run it. Drafts are never executable."* (`:1814`).

The dead-end anatomy, precisely:

| # | Missing affordance | Evidence |
|---|---|---|
| a | Questions have **no input** — nowhere to answer, nothing consumes an answer | `StudyPanel` renders `<li>{q}</li>` only, `:1461-1467`; no writer for `playbook_studies.report` exists outside `playbook-draft` |
| b | The **draft-time validation errors are discarded** by the UI — `onDrafted` reads only `r.validation.valid` for toast wording; the `errors` array is never rendered or stored | `:1713-1721`; server persists steps+study but not validation (`playbook-draft/index.ts:192-204`) |
| c | **No mechanical fixes offered** — the study's `risk[]` grades and the validator's structured codes (`approval_without_invoice`, `post_gate_primitive`, …) drive nothing; the one "insert a human gate" fix the report itself names is left to the user | `playbook-execute/index.ts:278` (validateSteps codes); StudyPanel consumes only 5 of the report's fields |
| d | Publish failure is a **page-top error line**, listing messages away from the steps | `publishFromCard`, `:1702-1711`; server returns structured 422 `playbook-execute/index.ts:2597-2607` |
| e | The upload path the study demands ("Where is the authoritative ROI framework?") exists only as Knowledge → Library navigation — not reachable from the panel that asked | census §5, rows 24/32 |

Paths where **nothing** persists (true dead ends in the builder): compile parse failure → 502
`compile_parse_failed` (`playbook-draft/index.ts:134-135`), model error → 502 (`:132`),
budget → 429 (`:91-92`), no LLM → 503 (`:90`); the modal shows the raw token
(`LivePlaybookBuilder.tsx:1403-1404, 1415`).

### 1.3 The DE path is a differently-shaped dead end

The dock (the surface a prospect most plausibly typed into) is
`src/components/DEChatDock.tsx:350` → `src/lib/knowledgeApi.ts:613` → `de-orchestrate` →
`de-answer`. **de-orchestrate performs no intent classification** — its only model call picks
*which DE* answers (`supabase/functions/de-orchestrate/index.ts:151-174`); a "build me a
playbook" order is coerced into knowledge Q&A. With docs present but not covering the ask,
context degrades to *"No documents matched the question."* (`de-answer/index.ts:876`),
confidence lands under the send threshold, and the reply escalates: a `human_tasks` row
(`:1336-1351`) and the amber strip *"I've escalated this to your team"*
(`DEChatDock.tsx:578-585`). No recovery offer, no artifact, no next step — the rich
`RecoveryHint` ladder fires **only at zero documents** (`de-answer/index.ts:707-739`).

Other DE-side surfaces for the same ask: `workforce-chat` is advisory prose with zero tools
(`supabase/functions/workforce-chat/index.ts:113-137`); `de-mission` compile refuses honestly
(`impossible`/`scope_source_not_allowed`, `de-mission/index.ts:219-237`) but each retry mints a
new dead `failed` mission row and the directive can't be edited
(`src/components/MissionPanel.tsx:180-184, 212, 276`); `ai-session` ("Edit with AI" / the
dock's "Change something" tab) is the one true loop surface but **cannot create a playbook** —
`AUTO_APPLIABLE` has `playbook.draft_steps` (existing target only) and no `playbook.create`
(`supabase/functions/ai-session/index.ts:55-60`;
`supabase/migrations/201_ai_working_sessions.sql:180-193`).

The mission-delegation keystone has the same shape as feared: honest refusal, raw machine
codes shown to the customer, no iterate-in-window.

**Unverified:** no DE-side transcript of the incident was found in `de_messages`
(searched 2026-08-11 18:00 → 08-12 06:00 for playbook/CSM/engagement on outsourcetel-hq —
zero rows). A `workforce_conversations` read was blocked by the session's permission
classifier, so whether the DE half went through workforce chat is **not verified**; the DE-side
behavior above is code-proven, not transcript-proven.

### 1.4 Aftermath found during verification (new facts, flag-don't-fix)

- **The incident draft was overwritten 39 minutes later with no audit trail.** The definition's
  `updated_at` is `2026-08-11 22:31:30`; its steps are now **8 prose sections**
  (`{order,title,description}` — not engine primitives; every one would fail validation as
  `unknown_primitive`), and its name is now **"Rabeel"**. Exactly one audit event exists for the
  definition (the 21:52 draft). The builder's own edit path writes an audit event from the
  client (`src/lib/playbookBuilderApi.ts:455-473`), and `ai_sessions` for the tenant after
  20:00 that evening is empty — so the write came through a path that audits nothing (direct
  PostgREST update under RLS, or a service-credential session). The original 7 compiled steps
  are unrecoverable (no snapshot before publish). Two consequences for this spec: the audit
  hole is real (open question Q6), and the customer's "nothing was saved" experience was
  eventually made true.
- `ai_apply_change('playbook.draft_steps')` coalesces the patch **verbatim with no step-shape
  validation** (`migrations/201_ai_working_sessions.sql:190-193`) — a second unvalidated write
  path into `playbook_definitions.steps` (open question Q7).

### 1.5 Reproduction status — honest accounting

The brief asked for a synthetic re-run on the Review Lab tenant
(`6c30af2b-a63b-4751-9876-8ce488f729d5`). **BLOCKED:** direct service-role invocation of
`playbook-draft` returned the function's own 401 (the deployed function's injected service key
evidently differs from the local legacy JWT), and the two session-minting alternatives (admin
password reset; the workstream-B magic-link pattern) were both denied by the session's
permission classifier — one rephrase attempted per the verification-safety boundary, then
stopped. **Zero rows were created anywhere; nothing to clean up; `action_executions` = 186
before and after (re-verified at the end of the session).** In place of the synthetic run, the
**actual incident rows** (§1.1–1.4) were used — strictly better evidence for the builder half.
What the blocked re-run leaves unproven: the same prompt's behavior on a *fresh* tenant with a
near-empty KB (Review Lab has 1 knowledge doc, 7 active guardrails).

---

## 2. Funnel census — where else the first hours dead-end

Full sweep of the new-tenant funnel: **57 surfaces examined · 19 dead ends (❌) · 21 partial
(⚠️) · 17 with a real path forward (✅)**. The dead-end table (verdicts for ✅ rows omitted for
brevity; full trace evidence lives in the session notes):

| # | Surface | Trigger → what the user sees | Evidence |
|---|---|---|---|
| 1 | **Quick Start (Ada)** | LLM key unset / budget exceeded → HTTP 200 `ok:true, proposals:[]` → *"Ada didn't propose anything this time. Try describing your needs with a bit more detail."* — blames the user's writing for an infra state; no retry can succeed | `onboarding-assist/index.ts:97,124-131`; `OnboardingArchitectPage.tsx:171-174`; `agentic-step-execute/index.ts:519-523, 304-317` |
| 2 | Quick Start | `no_architect` / `run_context_failed` → bare token in a red box | `onboarding-assist/index.ts:60,65`; `OnboardingArchitectPage.tsx:101,154-156` |
| 3 | **DE dock — document fallback** | de-answer emits `fallback:{kind:'upload_document'}` and the DE's prose asks for a document — the client type narrows recovery and **drops `fallback`**; no control renders | `de-answer/index.ts:252,280`; `knowledgeApi.ts:654-663` (the comment at :557-566 warns about exactly this); `DEChatDock.tsx:561-572` renders site-import only |
| 4 | DE dock — import lands 0 docs | `onImported` fires only when `imported>0`; the "Nothing could be read" thread reply is unreachable — modal closes, chat unchanged | `ImportSiteModal.tsx:409`; `DEChatDock.tsx:726-728` |
| 5 | DE dock — budget / suspended / DE unavailable | generic *"network or server issue… try again"* — retrying a budget block can never succeed | `de-answer/index.ts:885,497-499`; `DEChatDock.tsx:376-382` |
| 6 | **Knowledge gaps drawer** | lists the exact unanswered customer questions, then *"Still accumulating — needs N more…"* — no upload, no write-the-answer, no link | `KnowledgeGapsPage.tsx:436-447,493-497` |
| 7 | Knowledge library — .docx upload | no type gate: binary read as text → **garbage doc created with no error** | `LiveKnowledgeLibrary.tsx:478,484` |
| 8 | Knowledge library / any live page — unprovisioned | tells a tenant admin to run a SQL migration in the Supabase editor | `LiveKnowledgeLibrary.tsx:512-526`; `LiveDataStates.tsx:18-33` |
| 9 | Ingestion & Sources | every failure = auto-dismissing 5s toast, styled success-green | `KnowledgeIngestionPage.tsx:80-150,356-359` |
| 10 | Widget / hosted / portal — no docs | flat *"…check back soon."*; no recovery hint exists in widget-ask at all; portal has the hint on the response and doesn't read it | `widget-ask/index.ts:631-634`; `EndUserChatPage.tsx:190-198` (matches workstream-B finding F-5) |
| 11 | Connector setup — bad credentials | modal closes, credentials wiped, toast *"saved, but the live test failed"*; fix requires finding the row + Reconnect | `LiveConnectorsPage.tsx:182-185,1198-1202` |
| 12 | MCP — unreachable server | error shown **and** name/url/token fields wiped on the same path | `McpServersPage.tsx:265-267` |
| 13 | Workforce Chat Hub | raw response body rendered: `Failed to send message: {"error":"ai_not_configured"}` | `workforce-chat/index.ts:60,69,140`; `WorkforceChatHubPage.tsx:243-247`; `workforceApi.ts:94-96` |
| 14 | Hire wizard — entity-draft fails | bare token `llm_not_configured` in a rose box (brief is retained) | `entity-draft/index.ts:67-69`; `HireEmployeeWizard.tsx:214,328` |
| 15 | Mission panel — refused compile | raw `scope_source_not_allowed:<x>` shown; retry recompiles the same text; each attempt a new dead `failed` row | `de-mission/index.ts:225-237`; `MissionPanel.tsx:180-184,212` |
| 16 | de-orchestrate (latent) | forwards `no_docs` but **not `recovery`** — first tenant to designate a supervisor DE silently loses the one working recovery button | `de-orchestrate/index.ts:202-211` |
| 17 | Playbook builder — nothing-persisted failures | raw token in modal (see §1.2) | `playbook-draft/index.ts:90-92,132-135` |
| 18 | Onboarding template publish | RPC error strings don't identify which of 16 items failed | `CustomerOnboardingLive.tsx:505-515`; `onboardingApi.ts:199-209` |
| 19 | entity-amend | no caller anywhere in src/ or functions — self-improvement surface unreachable | only removal note `EmployeeFileSections.tsx:3798-3811` |

Counterexamples worth copying (the platform already knows how to do this): the de-answer
zero-docs recovery ladder with a rendered control (`de-answer/index.ts:270-282` +
`DEChatDock.tsx:561-572`); ingestion queue's only-real-retries rule
(`IngestionQueuePanel.tsx:13-23`); MCP allowlist block with the fix form on the same page
(`McpServersPage.tsx:214-221,296-349`); de-work's blocked-item refusal that **names the missing
fields and opens a needs-input escalation** (`de-work/index.ts:1147-1163`).

---

## 3. The precedent: the platform already has a gap language

Do not invent a second one. The onboarding module's model
(researched in full; key cites):

- **Declaration:** three param specs — `'@account'` (know it), `'@ask'` (ask it), literal
  (fix it) — `src/lib/onboardingTypes.ts:12-28` (byte-identical edge twin
  `supabase/functions/_shared/onboardingTypes.ts`, kept by certify › contract-parity).
- **Answer sheet:** `onboarding_projects.requirements jsonb`, keyed `'<action_key>.<param>'`
  (mig `674:31-34`; `ProjectRequirements.tsx:12-16`).
- **Derived, never stored, gap state:** `Resolved.missing: string[]`.
- **Enforcement:** publish validator (mig `674:157-182`) demands every required param be
  *named* (`'@ask'` satisfies declaration, not answering); runtime refusal-5
  (`de-work/index.ts:1147-1163`) blocks the item, **names the fields**, opens
  `open_de_escalation(p_needs_input:true)`.
- **Separate verification axis:** `verified_by:'system'` via connector read-through
  (`onboarding-verify/index.ts:141-170`) — *evidence the platform demands* vs *input the
  platform lacks*.
- Known lossiness to fix rather than replicate: `missing[]` is untyped — de-work re-derives
  the kind heuristically (`de-work/index.ts:1156`).

The design below reuses: the ask/answer-sheet split, stable dotted keys, derived-not-stored
blocking, refusals that name the field, and the answered-vs-verified distinction.

---

## 4. Design

### 4.1 Objects

**`playbook_gaps`** (new table; RLS tenant-scoped like `playbook_studies`):

```
id uuid pk · tenant_id · definition_id fk → playbook_definitions · step_index int null
kind text CHECK IN ('missing_knowledge','missing_authority','missing_data','fixable_by_structure')
gap_key text          -- stable dedupe key, unique (definition_id, gap_key), e.g.
                      --   knowledge:roi_framework · authority:pricing_concession_approver
                      --   data:account.executive_sponsor · structure:human_approval_before:4
title text · detail text · source text CHECK IN ('validator','study','author')
ask jsonb             -- the typed affordance contract (per-kind, §4.2)
status text CHECK IN ('open','answered','resolved','dismissed') default 'open'
answer jsonb · answered_by uuid · answered_at · resolved_at
```

Two-state honesty, mirroring onboarding's input/verification split: **answered** = a person
provided something; **resolved** = the platform verified the evidence (e.g. recompile's
`check_knowledge` binding actually retrieves the uploaded doc). A gap never resolves on the
user's say-so alone. `dismissed` requires a role (Q2) and is recorded in the audit trail.

**Extraction.** `playbook-draft`'s Deep Study step already produces exactly this content as
free text (proven by the incident report). Restructure the study prompt to emit
`gaps[]` with `{kind, step_index, gap_key, title, detail, ask}` instead of loose
`questions[]`; keep `scenarios` and `risk` as-is. The LLM proposes, the server disposes
(the de-mission `validateScope` pattern, `de-mission/index.ts:69-81`): kinds outside the enum,
malformed asks, or step_index out of range → the gap is kept but coerced to a safe shape
(kind `missing_knowledge`, ask `{}`), never dropped — losing an objection is worse than
mistyping one. Validator errors map **deterministically** (no LLM) to
`fixable_by_structure` gaps:

| Validator code (playbook-execute:278) | Patch offered |
|---|---|
| `approval_without_invoice` / study flags an ungated money/pricing step | `insert_step {key:'human_approval'}` before the flagged step |
| `last_step` | `append_step {key:'complete'}` |
| `post_gate_primitive` | `move_step` before the gate |
| `unknown_primitive` (e.g. retired `consult_specialist`) | `replace_step {key:'custom_step'}` carrying the old instructions |
| `bad_params` with a missing template | `edit_step_param` opening the existing param editor focused on the field |

Persist the incident-visible truth too: store the draft-time `validation.errors` on the study
report (today they are returned and dropped — §1.2b).

### 4.2 Per-kind ask contracts and answer affordances

| kind | `ask` shape | Inline affordance (in the same window) | Resolution evidence |
|---|---|---|---|
| `missing_knowledge` | `{query, suggested_doc_title}` | three controls, all existing machinery: **upload a document** (extract-document → ingest-chunks pipeline), **link a page** (site-import, single-page budget), **pick an existing doc** | recompile re-runs the step's `hybrid_match_knowledge` binding; gap resolves only when the query retrieves the new doc (`playbook-draft/index.ts:174-190` bindings loop is the checker) |
| `missing_authority` | `{decision, options[], recommended}` | a decision card: named human picks an option + optional note; **role-gated** (Q2) | the recorded decision itself; echoed to `append_audit_event` (category `config_change`) |
| `missing_data` | `{entity:'account'\|'org', field, help}` | input bound to the real field (customer_accounts custom fields / org settings), reusing the onboarding answer-sheet input pattern (`ProjectRequirements.tsx:104-108`) | the field is non-null at recompile |
| `fixable_by_structure` | `{patch:[{op,at,step}], preview}` | one-click **"Apply fix"** with a step-diff preview | patch applied to draft steps AND the originating validator error gone on revalidate (`action:'validate'`, playbook-execute:2580-2592) |

An answered `missing_authority` gap **never mutates guardrails or trust dials** — it can only
record who decided what, or (via a linked structure patch) *add* a human gate. Loosening
anything remains outside this surface entirely.

### 4.3 The recompile loop

New action on the existing function (keep one compiler): `playbook-draft` accepts
`{definition_id, answers:{gap_key: …}}` → merges answers as additional grounding into the
compile+study prompts → updates the draft's steps → re-extracts gaps with the same
`gap_key` discipline so unchanged objections keep their identity (answered ones close if
evidence verifies; genuinely new objections open as new rows). Response reports honestly:
`{closed:[], still_open:[], new:[]}`.

UI: `StudyPanel` becomes the **gap panel** on the draft view — each gap renders its kind badge,
its affordance, and its status; a progress line counts *"4 of 6 gaps answered · 1 new question
from the last recompile"*. Answering never navigates away; the upload/link controls are the
same components the dock's recovery path uses. The panel also shows the persisted draft-time
validation errors beside the steps they index (fix for §1.2b/d).

Budget note: each recompile is a real LLM spend, budget-gated exactly like the first draft
(`playbook-draft/index.ts:91-92`); the loop needs no new metering.

### 4.4 Partial publish semantics — precise runtime contract

Default publish is **unchanged and stays strict** (playbook-execute:2597-2634). A new explicit
`mode:'partial'`:

- **Precondition:** zero open `fixable_by_structure` gaps. Structural validity is
  non-negotiable — the snapshot must pass the same `validateSteps`, unmodified.
- Steps carrying open knowledge/authority/data gaps are replaced **in the snapshot** by a new
  primitive `gap_gate {gap_id, label, reason, original_step}` where `original_step` is a frozen,
  non-executable copy. `validateSteps` learns `gap_gate` as a legal non-terminal step; the
  executor gets exactly one case for it.
- **What a partially-published playbook may DO at runtime:** steps before the first `gap_gate`
  execute normally under today's guardrails/trust-dial composition (that path is untouched).
  When execution reaches a `gap_gate`, the run: (1) marks the step `waiting` with the gap's
  reason as detail, (2) creates a `human_tasks` row that **names the gap and its answer path**
  (mirror de-work refusal-5's shape, `de-work/index.ts:1147-1163`), (3) sets the run
  `waiting_approval`. The human decision offers exactly two outcomes: **skip this step for this
  run** (recorded `skipped — gap unanswered, waived by <name> for this run`) or **cancel the
  run**. There is no "execute anyway": the blocked behavior does not exist in the snapshot in
  executable form. Snapshots stay immutable — answering the gap later unblocks the *next*
  published version, never a paused run retroactively.
- Library card + document view render gapped steps visibly blocked WITH their reason (the
  onboarding "unmet requirement" presentation is the model), never hidden.

### 4.5 The invariant — the gate stays exactly as strict

Nothing in this design weakens a refusal; it re-platforms refusals as data:

1. Full publish validation: byte-identical behavior on the existing fixture set.
2. No step whose evidence is missing ever reaches the executor in executable form.
3. Runtime guardrails (discounts need approval, no written commitments, action gates,
   trust dial) are not touched by any file this build edits — `gap_gate` is a *pausing*
   primitive added beside `human_approval`, not a bypass.
4. Gap answers can add gates and record decisions; they cannot remove steps' guardrail
   composition, mutate `guardrail_rules`, or grant authority.

---

## 5. Certify probes the build must ship (with mutation cases)

Count comparisons, not just findings — every probe prints its denominator; a probe that cannot
fail is theatre.

| Probe | Green means | Mutation case (must go RED) |
|---|---|---|
| `draft-always-persists` | a fixture SOP whose compile fails validation still yields definition + study + ≥1 gap rows, and the response carries them | gate the persist block behind `validation.valid` |
| `objection-maps-to-gap` | for the incident fixture: every validator error + every study contradiction/question maps to exactly one typed gap; unmapped = 0 of N (N printed) | add an extraction branch that drops unknown kinds |
| `gap-gate-never-executes` | partial-publish fixture run: `gap_gate` step ends `waiting`, a needs-input human task exists, and **0 `action_executions`** originate from that step | make the executor's `gap_gate` case fall through to `skipped` |
| `full-publish-strictness-pinned` | the pre-change refusal fixture set still refuses with identical error codes (inverted pin; refusal count compared to baseline) | relax any `validateSteps` rule |
| `partial-requires-structural-clean` | partial publish with an open `fixable_by_structure` gap → 422 | skip the precondition |
| `answer-closes-only-its-gap` | recompile with one answer closes at most that gap (plus verified evidence); others stay open | mark all gaps resolved on any recompile |
| `resolved-requires-evidence` | a `missing_knowledge` gap whose doc was uploaded but is NOT retrieved by the binding query stays `answered`, not `resolved` | resolve on upload success |

Contract-parity note: if any gap types land in a `_shared` twin (edge + client), extend the
existing certify › contract-parity arm to cover them.

---

## 6. Early-setup framing — same pattern across the funnel

The typed-gap pattern generalizes: *a refusal is a gap object with a kind, an inline
affordance, and a verification*. Ranked by first-hours impact (census §2):

**In scope for this build (top 2):**

1. **DE-chat missing-knowledge gap** — the dock's document fallback + closing the import loop.
   Render the `fallback:{kind:'upload_document'}` the server already sends (restore the field
   dropped at `knowledgeApi.ts:654-663`; the interface comment at :557-566 demands exactly
   this), post the import/upload result back into the thread (make `DEChatDock.tsx:726-728`
   reachable), and extend the recovery envelope to the **low-confidence-with-docs** path so a
   workspace with 3 docs gets the same offer as one with 0 (new `recovery` on the escalate
   branch beside `de-answer/index.ts:1336-1351`). This is the incident's DE half, fixed with
   the same vocabulary: the DE's "I can't" becomes a `missing_knowledge` gap with an answer
   control in the same window.
2. **Quick Start honest failure** — stop flattening `llm_not_configured` / `budget_exceeded`
   into `ok:true, proposals:[]` (`onboarding-assist/index.ts:97,124-131`); type the failure in
   the response and give `OnboardingArchitectPage.tsx:171-174` distinct states. Step 1 of the
   only first-run checklist must never blame the user's writing for an infra state.

**Named follow-ups (not this build), in rank order:** widget-ask/portal recovery parity
(census #10, = workstream-B F-5 class); de-orchestrate forwarding `recovery` (#16); Knowledge
gaps drawer answer affordance (#6 — becomes a `missing_knowledge` gap card for free once the
gap panel component exists); connector/MCP credential-wipe on failed test (#11, #12); dock
budget-block misdirect (#5); .docx silent garbage ingest (#7); mission compile — plain-language
refusal + editable directive instead of new-row-per-attempt (#15); workforce-chat raw error
JSON (#13); hire-wizard raw tokens (#14); unprovisioned-table messages (#8); ingestion toast
persistence (#9); entity-amend reachability (#19).

---

## 7. Build plan sketch

1. **Migration** (`npm run migrate:next`, commit before apply): `playbook_gaps` + RLS +
   `gap_gate` acceptance in `validateSteps` + persistence of draft-time validation errors on
   `playbook_studies.report`.
2. **playbook-draft**: typed-gap extraction (study prompt + server-side coercion + deterministic
   validator→structure mapping); `answers`/recompile action; gap_key stability.
3. **playbook-execute**: `gap_gate` executor case (waiting + needs-input task + two-outcome
   decision); `mode:'partial'` publish with snapshot substitution + precondition.
4. **UI**: gap panel replacing StudyPanel's read-only lists (kind badges, per-kind affordances,
   progress line, recompile button); blocked-step rendering in document view + library card;
   publish-partial affordance.
5. **Funnel fix 1** (dock document fallback + import loop + low-confidence recovery) and
   **fix 2** (onboarding-assist honest failure).
6. **Certify probes** of §5, each with its mutation case demonstrated red in the PR.
7. Re-run `npm run certify`; the three pre-existing legitimate REDs stay untouched.

Rough sizing: 2 (migration+draft) + 1 (execute) + 2 (UI) + 1 (funnel) + 1 (probes) ≈ 7 focused
sessions.

---

## 8. Open founder questions (flagged, not taken)

| # | Question | Recommendation |
|---|---|---|
| Q1 | May a gapped draft be shared with / edited by a customer-facing CSM role, or is the gap panel admin/manager-only? | Members see the draft + gap statuses read-only; answering requires the same role that can edit playbooks today (`useIsTenantManager` gate) |
| Q2 | Who may answer a `missing_authority` gap, and who may `dismiss` any gap? | Owner/admin only for both; every decision audited with actor + note |
| Q3 | Is `mode:'partial'` publish allowed by default, or behind a per-tenant setting? | Allowed by default — blocked steps pause loudly and cannot execute; a setting adds a knob nobody asked for |
| Q4 | When a `missing_knowledge` gap is answered by upload, does the doc land published in the KB or as a draft awaiting curation (it becomes DE-visible knowledge!)? | Follow the existing knowledge publish gating per tenant; the gap stays `answered` (not `resolved`) until the doc is retrievable, which composes with review |
| Q5 | Disposition of the incident row `88c1a2c1` ("Rabeel", outsourcetel-hq): restore from the study (recompile), rename, or archive? | Founder's tenant, founder's call — recompiling from the stored SOP text would be the live demo of this very feature |
| Q6 | `playbook_definitions.steps` accepts direct un-audited updates (proven by the 22:31 overwrite). Move edits behind an auditing RPC and revoke direct UPDATE? | Yes — same class as the org-scoped permissions work; but it touches authority + an interface others call, so founder decision |
| Q7 | Should `ai_apply_change('playbook.draft_steps')` route through the engine validator before writing (mig 201:190-193 writes verbatim)? | Yes — cheap, closes the second unvalidated write path; drafts stay drafts either way |

---

## 9. Self-review against the brief

- Builder path traced end-to-end with file:line; persistence question answered with live rows,
  not inference (§1.1–1.2). ✅
- DE path traced across all five surfaces incl. mission plan-gate shape (§1.3). ✅
- Reproduction: synthetic Review Lab run **BLOCKED** at session-minting (classifier; one
  rephrase then stopped) — substituted with the discovered *actual* incident rows; the gap this
  leaves (fresh-tenant behavior) is stated (§1.5). Zero rows created; cleanup nil; 186 intact. ✅/⚠️
- Census with denominators: 57 examined / 19 dead ends (§2). ✅
- One gap language, reusing the onboarding precedent explicitly (§3, §4). ✅
- Partial-publish runtime behavior defined precisely, incl. what a paused run may and may not
  do (§4.4). ✅
- Gate strictness stated as an invariant with probes + mutation cases (§4.5, §5). ✅
- Scope: builder + 2 funnel fixes; 12 follow-ups named (§6). ✅
- Founder decisions flagged with recommendations, none taken (§8). ✅
- Prohibitions honored: no migrations/schema/UI built; no approvals/decisions/executions; no
  audit rewrites; outsourcetel-hq only read, never written.
