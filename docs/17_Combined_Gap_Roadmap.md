# 17 — Combined Gap Roadmap (2026-07-22)

Merges three sources into one build queue, net of everything already shipped
(W1/W2/W4-A–E, ledger, IA restructures, LLM failover spine):

- **A. DE Operating-Model audit** ("How Each DE Actually Operates — 12 Roles,
  Gap Map", session 7c70a0af): 12 archetypes graded, 2 structural gaps, Q1–Q6
  founder-visibility questions, defects list.
- **B. Competitor scan** (conducting.ai + reznikov-engineering): 7 picked
  learnings + a design language.
- **C. Founder direction 2026-07-22**: "AI at every level — Connectors,
  Knowledge, Governance too, so working those tabs beats going button by button."

## Already closed since the audits (do not re-plan)

- Q1 "what is it doing now" — Employee File "Working right now" + CC strip.
- Q5 attribution root cause — human_tasks rows now carry de_id (W1); the
  per-DE "waits on you" GROUPING is still open (below).
- Onboarding kit "orphaned" — corrected same day (Onni has 2 active watchers).
- Missions keystone (docs/14), exceptions producer, KPI recorder — live.
- Governance ✨ (propose_guardrail, human-approved) — existed; kept as-is.
- **C (this commit)**: assistant estate-eyes — `list_systems`,
  `list_guardrails`, `list_knowledge_gaps` read tools in ai-session; ✨ on
  Connectors ("Ask about systems") and Gap Detection ("Work gaps with AI");
  gap→draft-doc closed loop conversationally (list gap → knowledge.create).

## The combined queue (recommended order)

### C2 — Workforce Board + Next-Up (1 session) ← START HERE
One build satisfies audit gap #2 AND competitor learning #3 (their static
"AI-Native Company Design" org board, ours live from telemetry):
- Whole-workforce **now / next / blocked** board (Workforce hub tab or CC
  expansion): every DE, not just those with live work rows.
- Fix work-queue order (deWorkbenchApi created_at DESC → scheduled order).
- Per-DE ordered **next-up** on Employee File Today (queue + parked cases +
  watchers due, one list, one "when").
- Q6 cadence surface: render get_de_operating_model (mig 248) — watchers,
  schedules, day-shape — in How-I-operate ("every 5 min" stops being prose).
- Q5 grouping: "Casey waits on you for 3 things" per DE (human_tasks by de_id).
- Verify/fix the `kind <> 'inbox'` watcher-skip predicate (support_agent's
  proactive path; poll_de_work_sources may make it moot — verify, then fix or
  document as intended).

### C3 — Operating Model as a first-class object (1–2 sessions)
Audit structural gap #1: unify work-sources + cadence + day-shape +
current-focus + next-step per DE (today implicit across 5 tables, next-step
in 3 places). mig 248's get_de_operating_model is the seed; becomes the
spine of How-I-operate and feeds C2's board.

### C4 — Standing mission templates (competitor #2, cheap leverage)
Their 5 cross-dept orchestrators as installable mission templates on our
missions rail: Customer Save, Inbound Lead Lifecycle, VoC loop, Monthly Exec
Reporting, Incident→Customer Comms. Machinery exists (docs/14); this is
authoring + an "install" affordance.

### C5 — Packaging sprint (competitor #1/#4/#5/#6/#7 — mostly copy + small UI)
- Name the regulations per compliance pack / playbook (EU AI Act, GDPR Art
  22, SOC 2) — machinery → board-sellable story.
- Named maturity phases at tenant level (we have all three as machinery:
  trust dial / KB+Deep Study / missions+A2A) — packaging only.
- Pre-hire "job description" block in HireEmployeeWizard: cost range,
  autonomy level, risk overlay, rollout plan (+ mission-compile estimate
  surfaced as the Reznikov "price in seconds" moment).
- Quick Day-1 Wins pack post-hire; human triad prompts (AI Lead / Dept Lead /
  Champion) + "what changes for your team" comms template at hire.

### C6 — Reznikov dossier pass (design, fold into next Employee-File touch)
Personnel-dossier header (FILE:, STATUS: OPERATIONAL, hard-stat telemetry
strip), click-to-reveal depth — within dt-token law.

### Standing candidates (unchanged, tracked elsewhere)
Platform Console AI-Engine tab (promised); assistant deep-merge (one spine);
proof hour scenarios (now unblocked on Bedrock); records→gates; frontier
unlock via AWS sales.

**Do NOT copy** conducting.ai's oversell (fake members/testimonials) — our
counter-position is the real proof spine.
