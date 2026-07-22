# 15 — Employee File Truth Audit (2026-07-22)

Five parallel code-tracing investigations + a live data audit of the Employee
File (every tab, every panel, traced to its table/RPC/edge-function consumer),
commissioned by the founder: "evaluate each DE, each tab, each feature — why it
exists, is it wired, what's hidden, what's missing, is it generic, and how far
does Edit-with-AI reach." Verdicts below are code-verified, not impressions.
Brain-offline (dead Anthropic key) was distinguished from unwired throughout.

## The three-layer classification (the core finding)

The file mixes three kinds of surface with identical styling, and a founder
cannot tell them apart:

**Layer A — genuinely enforced (the real machine):**
- Lifecycle gate: paused/retired DEs refuse answers, widget fronting, playbook
  runs, inbox polling (de-answer:315, widget-ask:300, playbook-execute:2311,
  mig 130/211). ONE HOLE: the de-work objective queue never re-checks
  lifecycle (claim_de_work_items mig 166; de-work:649).
- Guardrails (blocked phrase/topic): per-DE + workspace, enforced on ANSWER
  text in both channels incl. per-flush streaming re-checks. Caveat:
  FAIL-OPEN on resolver error (de-answer:124, widget-ask:117).
- Invoice $ cap: enforced per-DE via decide_action_execution (mig 125) on the
  registry/agentic path. BUG: legacy path (playbook-execute:2729-2744) queries
  de_autonomy with NO de_id filter + .maybeSingle() — the moment any per-DE
  invoice override exists it errors → autonomy=null → auto-send under
  guardrail-only. Latent silent-bypass.
- Model choice: DeModelPanel.model_id genuinely routes every brain call
  (resolveDeModel consumers: de-answer/widget-ask/specialist-consult/
  workforce-chat; de-work via resolve_de_model_for_task). Hidden override:
  de_model_routes per-task-class outrank it with zero UI visibility (mig 163).
- Identity (title/purpose/responsibilities): feeds the persona for
  INTERACTIVE answers (dePersona.ts → de-answer/widget-ask) — but NOT
  de-work or specialist-consult (name-only prompts), despite "feeds every
  answer" badge.
- Availability: genuinely gates inbox ownership w/ team fallback
  (de_is_available, mig 130/211). Enum-thin (one window, weekday flags, no
  holidays/PTO/shifts; TZ typos degrade silently to UTC). Meaningless for
  non-inbox roles.
- Reply mode: consumed ONLY by widget-ask; de-answer ignores it. And the
  widget picks ONE tenant "front DE" (oldest auto, else oldest eligible) —
  per-DE toggles silently reassign which employee fronts the whole widget.
- Knowledge scoping, data-access grants, consultation grants, incidents,
  memory (read+forget), work queue/objectives/case timeline/deliverables
  reads, availability, missions rail (mig 248): all real.
- Development items: auto-detected from real 8-week metrics; drives
  "Improving" status (the only Development panel with a downstream effect).

**Layer B — records styled as controls (display-only, zero runtime
consumers):** Skills (uniform 5-row seed on every DE incl. Workforce
Assistant), KPIs (missed KPI triggers nothing), Economics (needs baselines;
display), Certifications & Reviews (expiry gates nothing), custom
profile-field VALUES (digital_employees.attributes never read), employee
code/location/cost-center.

**Layer C — written but NEVER read (decoration / dead ends):**
- OperatingCharterPanel: whole panel (assign/reorder/pause playbooks) writes
  de_playbook_assignments — NO runtime consumer. de-work's briefing reads a
  DIFFERENT model (playbook_definitions.de_id, single most-recent only). Two
  playbook models inches apart; the Strip shows one, the charter manages the
  other.
- "Your own rules" custom escalation rules: saved to
  de_escalation_rules.custom_rules — no reader anywhere.
- Exceptions tab: full approve/reject/learn UI over de_exceptions — NO
  producer in the codebase (de-work escalates to human_tasks instead).
  Empty forever.
- Eval certification: certify_de_from_eval / certify_de_from_sim have ZERO
  callers — Proving Ground passes never certify; the tab stays "Not
  certified"; the mig-162 go-live gate is unsatisfiable through the app.
  (Separate from the human-attestation de_certifications system — two
  certification systems share one word.)
- metric_threshold watchers: creatable, but the KPI feed (record_kpi_reading)
  has no UI caller — can never fire.
- max_discount_pct guardrail: no located enforcement consumer.

## The two systemic discoveries

**1. Two disconnected execution worlds honor different config.**
Interactive answering (de-answer dock + widget-ask) uses: hardcoded
escalation threshold 60, model self-report, guardrails, persona, reply-mode
(widget only). The autonomous world (specialist-consult inbox triage +
de-work) uses: decide_*_triage with frustration threshold, always-escalate
topics, trust-dial confidence floors, availability. Consequence: the trust
dial's dock/widget floors and ALL escalation rules do nothing on the live
channels a founder actually tests. ("dormant until activation" badge exists
on the dial; escalation panel has no such disclosure.)

**2. Per-DE content is wildly uneven while the frame is uniform** (live data
audit): Remy 5 watchers/325 traces (reference), Riley 2/124, Aria+Bailey
1/11, Morgan 1/0-traces, Blair+Sky+Product Support+WA ZERO watchers.
Certifications/dev-items 0 for all; skills identical seed for all; zero
per-DE autonomy overrides. Same 9 tabs regardless.

## Tab-by-tab supplementary findings

- TODAY: MissionPanel fully live (mig 248 → objectives → 5-min tick) but
  batch scope whitelist = ONLY customer_accounts + commercial_agreements
  (accounting/marketing missions compile "impossible"); standing shape not
  installable; spent_usd/warn_sent never surfaced (soft-budget promise
  unmet); "Recent decisions" reads evidence_runs only (autonomous work
  invisible) AND applies de-filter AFTER a tenant-wide limit-60 (can show
  empty for a busy DE — correctness bug); work item result.summary +
  deliverables never shown; mission-origin objectives unlinked (visual
  triple-count with progress bar + "On my plate").
- HOW I OPERATE: best-composed panel; read-only while its empty state
  instructs action; watcher config (which date/threshold) hidden; drafts
  invisible; human_tasks.de_id counts are post-248 only.
- PERFORMANCE: all RPCs real; but 5/7 tiles + CSAT assume the support
  pipeline — work-item/deliverable roles read zero; mixed all-time vs ranged
  metrics under one window selector; billable value (metering
  amount_cents) not surfaced.
- WORKBENCH: memory/work/reasoning/replay live; Reasoning renders raw tool
  names + JSON.stringify(outputs).slice(0,100) (worst jargon leak);
  Book-of-work watcher builder locked to customer_accounts/renewal_date
  fields; Training curriculum exists for support_agent only; Compliance
  read-only tenant-wide with no attach UI; dead getDeMemory fetch each open.
- TRUST: dial storage real; earned ladder confirmed workspace-wide (de_id
  deliberately nulled, disclaimer accurate); action-gate guardrail matching
  is label-only + unscoped.
- AI ASSIST (estate): ai-session/AISessionPanel = the spine (4 auto-apply
  kinds w/ 120h undo: knowledge.create/edit, playbook.draft_steps,
  de.describe; DB allowlist mig 201) but wired to only 3 surfaces; DE config
  beyond identity actively refused; trust/outcomes/settings/connectors/
  triage/knowledge-pages = ZERO assist; live DEs lost the golden-gated
  amendment wizard (demo-only now); TWO competing assistants (ai-session
  "Workspace Assistant" vs workforce-chat "Workforce Assistant" hub);
  DEChatDock = scripted keyword demo in demo mode, real (de-answer/
  ai-session) in live mode; 4 different interaction patterns for the same
  plain-language idea.

## The program (founder-facing summary lives in the session of record)

WAVE 1 — safety & silent-no-op fixes (trust-critical):
 1. Enforce escalation rules (frustration + topics) in de-answer + widget-ask.
 2. Wire or remove custom_rules (recommend: wire reader in both answer paths).
 3. Fix legacy invoice-path trust-dial bypass (de_id-aware resolution).
 4. Activate dock/widget confidence floors (replace hardcoded 60 with
    resolve_de_autonomy; keep 60 as fallback).
 5. Lifecycle check in de-work claim/plan.
 6. Guardrail resolver fail-open → fail-closed + incident (or at minimum
    alert); honor scope in the action gate.
WAVE 2 — truth in the UI:
 7. Unify the two playbook models (briefing reads assignments by priority);
    kill the inert charter or make it real.
 8. Wire Exceptions producer (de-work) or remove tab.
 9. Call certify_de_from_eval on eval completion (closes Proving Ground loop).
10. Label Layer-B records honestly ("record — doesn't gate work yet") until
    consumers exist; surface widget front-DE explicitly.
11. Humanize Reasoning; fix Recent-decisions per-DE query + merge traces;
    role-aware Performance tiles; unify time windows; surface deliverables,
    result summaries, spent-vs-estimate, billable value.
12. Generalize watcher builder beyond CS fields (role-kit-driven source
    registry — same registry should widen mission scopes).
13. Compliance attach UI; per-archetype training curricula or honest label;
    identity fields into de-work/specialist prompts.
WAVE 3 — "AI everywhere" (founder directive):
14. One pattern: ✨ button on every surface → AISessionPanel; extend
    subject kinds (guardrails exists; add de-config/watchers/trust/
    connectors/settings/outcomes/triage as PROPOSE-ONLY kinds; extend the
    mig-201 allowlist only where undo is possible).
15. Consolidate assistants (fold workforce-chat hub onto the ai-session
    spine); restore the judged amendment flow on LIVE pages.
16. Missions: widen scope registry (per role kit), standing-shape install,
    spent/warn surfacing.
