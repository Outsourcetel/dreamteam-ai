# DreamTeam AI — Prospect Walkthrough Guide

**Live demo:** https://dreamteam-ai-five.vercel.app
**Demo companies:** TCP Software (Technology/SaaS — the richer dataset, use as primary) and PWC (Financial Services — use to show industry adaptability). Switch companies from the picker at the top of the sidebar.

**Positioning line:** *"Your business isn't organized around your org chart — it's organized around who you serve and what you're trying to achieve. Digital Employees own relationships end-to-end, with your guardrails, your knowledge, and a human in the loop wherever you decide."*

---

## The 20-minute core demo (TCP Software)

### 1. Command Centre (2 min) — "the whole business at a glance"
- Point at the KPI row: 3 DEs active, human tasks pending, 87% AI resolution.
- Show the Entity cards (who we serve) and Outcome cards (what we achieve).
- **Key beat:** the "Legacy departments" chips on every card. *"Your team doesn't have to relearn where things live — every card tells you which old department maps here. That mapping is configurable per customer."*
- Click the ⚙ Health Config to show that even "what counts as a healthy DE" is customer-configurable.

### 2. Story A — one customer relationship, end-to-end (5 min)
Path: **Customer → overview journey bar → Support**
- The journey bar: BD → Sales → Onboarding → Support → Success → Renewal. *"One DE owns the customer across all of this. No handoffs, no context loss."*
- In Support: Alex's control room, 47 tickets, live queue.
- **Follow the Apex Systems thread:** Support shows the escalated API auth bug → back to Command Centre activity feed (same incident) → Outcomes → Product & Engineering shows it as the open P1 → Customer Success shows Apex flagged at-risk (health 34) → Renewal shows Casey's pipeline. *"Five pages, one consistent story — because it's one relationship, not five departments' tickets."*

### 3. Story B — the self-healing knowledge loop (5 min) — THE differentiator
Path: **Knowledge → Gap Detection**
- Show the loop diagram: Gap detected → Resolution Agent → Draft → Human approval → Publish → DE retrain.
- Open **"Webhook retry logic" (23 queries)**: the actual missed queries → what the Resolution Agent found in 1,240 historical resolutions → the fully drafted article with cited sources.
- **Click Approve & publish live.** The toast: "affected DEs will retrain within 24h."
- Show the already-resolved gap: "Retrained: Alex ✓". *"Your knowledge base finds its own holes and fixes them — a human just approves."*

### 4. Story C — trust and control (5 min)
Path: **Governance → Compliance & Guardrails**
- The three layers: Industry template (locked regulatory rules) → your overrides → per-DE restrictions. *"Compliance isn't hardcoded — it's your industry's baseline plus your rules."*
- Show the template dropdown (Healthcare, Manufacturing, SaaS, Retail, FinServ).
- Path: **Governance → Audit Trail** — find the **BLOCKED event**: Alex tried to commit an SLA outside standard tier and the guardrail stopped him. *"The system enforces, logs, and proves it."*
- Path: **Intelligence → Self-Learning** — the validation gate is locked ON. Show Riley's proposed behavior awaiting human approval. *"DEs learn, but nothing they learn goes live without a human signing off."*

### 5. Close — Human Tasks (3 min)
Path: **Operations → Human Tasks**
- *"Everything that needs a human lands here — approvals, reviews, escalations."* Approve the Meridian invoice live; show the SLA countdowns.
- End on Company Setup: *"This is day one for a new customer — pick your industry, activate functions, get DE hiring recommendations and your compliance template."*

## The 5-minute industry-switch encore (PWC)
Switch to PWC in the sidebar. Same structure, different world: Practice Delivery instead of Product & Engineering, engagement renewals, FinServ guardrails v6.2 with independence rules, 7-year audit retention, FATCA knowledge gap. *"Same platform, different industry — nothing was rebuilt."*

---

## Feedback capture (fill in after every walkthrough)

Tracked against the production gates in [PROTOTYPE-PRODUCTION-BOUNDARY.md](PROTOTYPE-PRODUCTION-BOUNDARY.md):

| Question | Notes |
|---|---|
| Did the entity/outcome structure make sense without explanation? | |
| Which page did they linger on / return to? | |
| What did they ask for that doesn't exist? | |
| Any structural change requests? (Gate 1: 3 clean walkthroughs) | |
| Pilot interest? (Gate 2: committed design partner) | |
| Their must-have systems/integrations | |
| Their compliance regime / guardrail needs | |

## Demo hygiene
- Demo state (approvals, health configs, published gaps) persists in the browser's localStorage. **To reset for a fresh demo:** open browser DevTools → Application → Local Storage → clear keys starting with `dt_`.
- Do not present as production-ready; this is a design preview (see boundary doc §6).
