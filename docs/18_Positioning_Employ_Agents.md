# 18 — Positioning: The Employment Layer
### A research-grounded strategy for winning when every company can build agents
*v2, 2026-07-23. Replaces the v1 sketch. Sources: Gartner, MIT NANDA "GenAI
Divide," vendor pricing teardowns, category maps (links at end). Product
claims are code-verified in this repo as of this date.*

---

## 0. Executive summary — the bet

The agent-toolkit era (NVIDIA Agent Toolkit, LangGraph, CrewAI, hyperscaler
copilots) commoditizes the ability to BUILD an agent. It does not touch the
ability to EMPLOY one: to trust it on evidence, govern it, see its work,
develop it, bill it by outcome, and survive a vendor outage. The empirical
record says that second ability is precisely where the market is failing —
Gartner projects **>40% of agentic-AI projects canceled by end-2027, citing
governance and risk-control gaps, not engineering**; MIT's GenAI Divide found
**95% of enterprise GenAI pilots produced zero P&L impact**, and that
**vendor-led deployments succeed ~2× as often as internal builds (~67% vs
~33%)**. Our bet: claim the category between the $1k/mo single-role bots and
the $350k/yr single-function enterprise contracts — **the governed,
multi-role digital-workforce OS for mid-market operations** — and defend it
with the one asset no toolkit can commoditize: each customer's accumulated
employment record (knowledge, exams, trust history, amendments) that makes
*their* workforce smarter every week and worthless to export.

**One-liner:** *Every company will have agents. Very few can employ them.*

---

## 1. The market map — four competitor classes, and what each proves

| Class | Exemplars (2026 anchors) | Price reality | What they prove | Where they are weak vs us |
|---|---|---|---|---|
| **Enterprise outcome platforms** | Sierra ($15.8B val, May-26; ~$150k+/yr, $50–200k setup, yr-1 $200–350k+), Decagon ($4.5B, Jan-26; ~$50k base + ~$0.99/conv or ~$0.50/resolution) | 6-figure, negotiated, CX-only | Outcome pricing works; boards pay for governed agents | Single-function (support CX); enterprise-only motion; mid-market orphaned; no multi-role workforce, no missions/back-office |
| **Single-role "AI employee" specialists** | 11x ($40–66k/yr AI SDR), Artisan (~$999/mo outbound) | Per-role subscription | "Hire an AI employee" language sells; >$583M VC into 6 companies validates the noun | ONE role each; thin governance; no cross-role fabric, no earned trust, no audit spine |
| **No-code agent builders** | Lindy ($0–200/mo), Relevance | Prosumer | Long-tail demand for self-serve automation | Workflows, not employees: no lifecycle, no certification, no board; buyer must design the job |
| **Toolkits & hyperscalers** | NVIDIA Agent Toolkit, LangGraph, CrewAI, Agentforce, Copilot agents | Free–consumption | The build layer is commoditizing on schedule | Independent 2026 reviews: frameworks' unsolved bottlenecks are "state management, observability, and governance… none solve governance across agents." They arm the 33%-success internal-build path |

**Category-shape insight:** analysts already split "AI employees" into
general platforms / single-role specialists / builders. Nobody in the map
sells a **multi-role governed workforce with an employment lifecycle** at
mid-market pricing. That seam is the position.

---

## 2. Demand evidence — the market's failure mode is our product

Three independent findings triangulate:

1. **Gartner (Jun-25, reaffirmed 2026):** >40% of agentic projects will be
   canceled by 2027 — "escalating costs, unclear business value, inadequate
   risk controls." Cancellations attributed to *management and governance
   gaps, not engineering failures*. Only ~130 of thousands of "agentic"
   vendors are judged real (the rest: agent washing).
2. **MIT NANDA (2025):** the 5% of pilots that produce P&L share three
   traits — deep workflow embedding, **memory**, and **learning loops** —
   and buy-side partnerships beat internal builds ~2:1.
3. **Framework literature (2026):** even DIY practitioners name governance
   as the unsolved layer.

Read together: the reel's world — everyone building agents — statistically
produces the 33%-success path and the 40% cancellation cohort. What the
successful minority buys is workflow-embedded + memoried + governed + partner
-accountable. That is a near-literal description of the DE architecture
(role kits + KB/Deep Study + gap→doc/amendment loops + control fabric +
outcome metering). **We are not fighting the trend in the reel; we are its
picks-and-shovels' aftermarket.**

---

## 3. Moat analysis — tested, not asserted

For each candidate moat: the test is *"what stops a well-funded copier or a
DIY team in 12 months?"*

**M1 — Accumulated employment record (switching cost, compounding).**
Every tenant accrues: curated knowledge with version history, golden exams
grown from real failures, per-DE trust histories earned on evidence, judged
amendments, decision traces, guardrail tuning. This is the *employee's
experience*, not config — it compounds weekly (gap detection feeds docs,
evals feed certifications) and cannot be exported to a rival without
becoming a new hire who remembers nothing. MIT's finding that winners ship
"memory and learning loops" says this is also the ROI driver, not just
lock-in. **Strongest moat; every roadmap item should feed it.**

**M2 — Process power in the control fabric.** ~255 migrations of
interlocking governance (un-toggleable guardrails, action gate, trust
ladder, audit chain, budget rails, lifecycle gates) that we have
adversarially audited three times. Copyable in principle; expensive in
practice — and Gartner says its absence is why projects die. Halmer-style
"process power": credible at 12–24-month horizon, not forever.

**M3 — Counter-positioning via proof.** In a market Gartner labels
agent-washed (~130 real of thousands), our discipline — nothing shown that
isn't wired, live telemetry as marketing, incidents told honestly (the
2026-07-22 brain-transplant) — is a posture incumbents monetizing hype
cannot copy without repricing their story. Cheap for us; costly for them.

**M4 — Multi-provider resilience.** Proven live: org disabled → workforce
switched to Bedrock mid-flight with calibration intact. DIY stacks and most
single-role vendors are single-keyed. A real but *thin* moat alone;
valuable inside the M2 story.

**M5 (optional, future) — BYO-agent network.** A2A + delegation tokens +
action-gate already exist; opening enrollment ("bring the agent you built;
we make it an employee") turns every toolkit-built agent into inventory.
This is the only path on the board to a network-shaped moat.

**Explicit NON-moats (do not budget as if they were):** model access (we
rent the same brains as everyone — the failover proved models are
interchangeable *because* our layer holds the value); UI polish; connector
count (66 adapters is table stakes vs iPaaS); price alone.

---

## 4. Where we win, where we don't (kill-zone honesty)

**Beachhead (win):** mid-market ops/BPO-flavored businesses (50–2,000 seats)
that need SUPPORT + RENEWALS + BILLING + BACK-OFFICE run together under
governance, cannot fund a Sierra contract or a platform team, and are
statistically doomed on the DIY path. Outsourcetel is customer #1 by design
("I am my customer"). The multi-role board — one screen showing ten
employees' now/next/blocked — is the demo Sierra and 11x structurally
cannot give.

**Avoid (lose):** F500 CX bake-offs vs Sierra/Decagon (their references,
their SOC2/SSO checklists, their pricing floor — we lose on procurement
before product). Prosumer automation vs Lindy (race to $0). Pure SDR
seat-replacement vs 11x (they out-specialize us in that one role — our
counter is "your SDR is one hire in a workforce," not feature war).

**Watch-list risks (falsifiable, review quarterly):**
R1 hyperscaler bundling (Agentforce given away inside Salesforce contracts)
— mitigation: we live where their SoR isn't the center, and on top of SoRs
as the work layer. R2 Sierra/Decagon moving down-market with PLG — watch
their pricing pages. R3 **model labs shipping the employment layer**
(managed-agent runtimes with governance are appearing in lab platforms) —
the most serious long-range threat; our counters are multi-model neutrality
+ per-tenant employment records labs won't hold + SoR-adjacent workflow
depth. R4 single-founder execution capacity — argues for the pilot→proof→
narrow-ICP motion over breadth.

---

## 5. The three moves, with acceptance criteria

**Move 1 — The proof page (counter-positioning weapon vs agent washing).**
Public page: the failover incident with production telemetry, the live
board, certification records, metering statement. *Accept when:* a cold
prospect can verify every claim on the page against a live surface in <5
minutes. Feeds R3/M3.

**Move 2 — Buy-vs-build, quantified in-product.** The hire wizard's job-spec
gains the market numbers a buyer already suspects: internal builds succeed
~33% (MIT); >40% of agent projects die on governance (Gartner); typical
enterprise alternative = $200–350k yr-1 (Sierra-class); this hire =
supervised today, hard-capped spend, outcome-metered. All figures cited,
labeled as third-party estimates. *Accept when:* the block renders per-hire
with sources linked.

**Move 3 — BYO-agent enrollment (the judo; spec before build).** Design
doc for: enrollment flow (A2A handshake → File + guardrails + trust=draft +
budget), sandboxed tool surface, evidence path to promotion, pricing (an
enrolled agent bills like a DE). *Accept when:* spec reviewed and a
toolkit-built demo agent completes one governed task E2E in staging.
This converts competitor class #4 from threat into supply.

---

## 6. Messaging architecture

- **Category:** the digital-workforce OS / the employment layer.
- **One-liner:** *Toolkits build agents. DreamTeam employs them.*
- **CEO narrative:** "You wouldn't run humans without management, HR, and
  audit. Why run agents that way?"
- **CFO narrative:** outcome-metered (99¢/resolution rails), hard-capped
  spend, vs $200–350k yr-1 enterprise contracts or a 33%-odds internal build.
- **CTO narrative:** model-neutral (proven failover), SoR-preserving (work
  layer, never replaces systems of record), bring-your-own-agent road.
- **Proof points (all live):** the board; evidence-earned trust; the
  failover trace; certification exams; the audit chain; per-DE economics.

## Sources
Gartner press release (Jun 2025) and 2026 follow-ups on 40% cancellation +
agent washing; MIT NANDA "GenAI Divide: State of AI in Business 2025" (95%
zero-P&L; ~67% vs ~33% vendor-vs-internal); Sierra pricing teardowns
(cloudtalk/myaskai/getmacha, 2026) and Series C reporting ($15.8B, May-26);
Decagon valuation/pricing analyses (eesel/retell/corepiper, 2026); AI-employee
market maps (TeamDay, Vellum, 2026: >$583M VC, 3-shape split; 11x $40–66k/yr,
Artisan ~$999/mo, Lindy $0–200/mo); 2026 framework production reviews
(LangGraph/CrewAI: governance unsolved). Full URLs in the session log.
