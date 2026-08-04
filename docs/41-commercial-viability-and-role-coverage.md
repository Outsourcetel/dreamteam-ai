# 41 — Commercial viability, and how far beyond support this platform really is

**Date:** 2026-08-04 · **Prepared for:** the founder's direct question — *"Is this
commercially viable while the giants enhance their AI? Is it still just a support
tool with a renewal DE, or can it take over the ten roles on my list?"*

**Evidence discipline (R5):** every claim below is labelled **PROVEN** (receipts in
production), **OPERATING** (running live, output measurable), **BUILT** (code +
schema live, never exercised against a real external system), **SCAFFOLD** (tables
and SOPs exist, no feed or executor), or **MISSING**. Numbers were read from
production on 2026-08-04, after the exam/probe cleanup (migs 557, 570-571) removed
artifacts that had been inflating the workforce's apparent output — so these are
smaller and more honest than any earlier snapshot.

---

## 1. The verdict, up front

**The founder's instinct is half right, and the half that is right is fixable.**

*Operationally, today,* this is a support-and-renewals product with the first
approved collections sends: the live footprint over the last 30 days is **81
customer answers, one employee with earned auto-send autonomy (support,
certified), and 2 approved ERPNext dunning writes with receipts** — everything
else on the books was exams, probes, or work for a suspended test tenant, and the
honest cleanups just removed it.

*Architecturally,* it stopped being a support tool weeks ago. The rails are
role-generic and real: 12 installable role kits, 43 platform-scope actions across
10 system categories and 20 providers, one approval gate every action passes, a
trust ladder with a proven promotion (and a proven demotion-and-restore), a
tamper-evident audit chain, certification exams wired to autonomy, and a
suspension/dormancy regime that actually holds. No other tenant-specific code
exists — the audit two sessions ago proved zero hardcoded tenant logic anywhere.

**The gap between those two sentences is not code. It is proof.** 12 of the 13
provider integrations have never touched a real external system. 21 of 21
certifications ever passed are support. One system of record is connected
platform-wide. N = 0 external customers. The platform is a governed workforce OS
in architecture and a support tool in evidence — and only execution against real
customer systems converts one into the other.

**Commercially viable?** Conditionally yes — but only on the wedge already locked
in docs/24 (governed workforce OS, governance-first), sharpened by what this
review found: lead with the **money-adjacent roles** (collections, billing,
accounting drafting) where the approval gate and audit chain are decisive and the
giants are weakest, use support + renewals as the trust-builder it already is,
and sell to SMB/mid-market through the ERPNext bundle where nobody big will
follow. Do not compete as a horizontal agent builder (the giants own that) or as
a pure support AI (Sierra/Decagon/Fin own that mindshare and are racing to the
bottom on per-resolution price).

---

## 2. What production actually shows (the ledger)

Read live on 2026-08-04:

| Signal | Value | Tier |
|---|---|---|
| External writes ever executed with receipts | **2 × ERPNext** (dunning, latest today) + 10 × platform self-admin + 33 × early-July template tests | PROVEN, narrow |
| Answer-runs, live tenants, 30d | **81**, 0 escalated in-window | OPERATING |
| Employees with earned auto-send autonomy | **1** (support, certified — migs 568/572) | PROVEN |
| Certifications passed, ever | **21 — all support_agent** | OPERATING, one-role |
| Role kits installable | **12/12** (fixed this week — 6 were uninstallable for every tenant) | BUILT |
| Platform-scope actions | **43** across 10 categories, 20 providers | BUILT |
| Provider integrations verified against a real system | **1 of 13** (ERPNext) | ⚠ THE gap |
| Systems of record connected, platform-wide | **1** (ERPNext dev) | ⚠ |
| Real deliverables / completed work items, 30d, live tenants | **0** after exam/probe cleanup | honest zero |
| Voice channel | **none** | MISSING |
| marketing / seo / ads system categories | **do not exist** | MISSING |
| Approvals pending on live tenants | 6 (plus 79 on dead/suspended queues) | |

Two structural facts worth naming because they are unusual and load-bearing:

- **The trust machinery has now completed one full, honest cycle in production:**
  a support employee passed certification, earned auto-send, had it revoked by a
  poisoned metric (its own exams were being counted as escalations), and had it
  restored once exams were separated from production work (migs 568-573). That
  is the entire product thesis — autonomy earned from evidence, revoked on
  evidence, and the evidence itself audited for honesty — demonstrated end to
  end on a real employee.
- **The cleanup that shrank the numbers is a feature of the story, not damage:**
  a platform that quietly counts its own exams as customer work is the exact
  oversell this product exists to prevent. Ours caught it and corrected the
  record.

## 3. "Is it still just a support tool?" — the direct answer

**Three role families have real machinery today; one of them operates.**

1. **Support / CS / renewals — OPERATING.** Chat + email channels, streaming
   guardrails, certification, escalation, renewal-risk watchers, account health,
   the only earned-autonomy employee. This is the deepest and it is genuinely
   good — but it is also the most contested market on earth right now.
2. **Billing / AR / collections — PROVEN chain, barely used.** ERP sync with
   verified balances (the $431k face-value lesson is machine-enforced now: a
   dunning rung *cannot* fire on an unverified balance), a declared dunning
   ladder, promise-to-pay with honesty semantics (kept/broken/**unverifiable**),
   invoice drafting under a balance-and-evidence gate, drift sentinel, and 2
   approved writes with receipts. This is the least-shipped *best* thing in the
   product.
3. **Accounting drafting — SCAFFOLD with the right spine.** Posting drafts that
   cannot leave draft unless they balance to the cent and every line cites its
   evidence row. No bank feed, no OCR, no external GL post action yet — but the
   control structure the entire bookkeeping-AI market converges on
   (draft → approve → post) is already our native shape.

Everything else on the founder's list is BUILT-unverified (SDR/CRM), thin
(HR: one provider action, no archetype), or MISSING (procurement, document
processing pipeline, marketing grounding).

So: **more than a support tool, less than an operations platform — a governed
execution OS with one operating desk, one proven money chain, and ten roles of
rails at varying depth.** Calling it "just a support tool" undersells the
architecture; calling it a business-operations platform today would oversell the
evidence. The distance between the two is measured in verified connectors and
design partners, not in new subsystems.

## 4. The competitive field (August 2026)

Researched fresh 2026-08-04 (sources and dates in the research appendix the
session produced; the load-bearing facts repeated here).

### The giants are building governance *infrastructure*, not governed *employees*

- **Salesforce** is the aggressor: Agentforce at ~$800M ARR (+169% YoY), and it
  bought **Fin for $3.6B in June explicitly to reach smaller/mid-market buyers**.
  Expect compression from above within ~12 months. Pricing ~$0.10/action,
  $2/conversation.
- **Microsoft** ships Agent 365 ($15/user/mo; bundled in the new $99 E7): agent
  registry, per-agent identity (Entra Agent ID), control tower. **OpenAI**
  launched Frontier (enterprise "AI coworkers", custom pricing, forward-deployed
  engineers) — and already killed AgentKit's Agent Builder within a year, a
  reminder of platform churn under anyone building on the giants. **Google**
  now bills "Semantic Governance Policies" as a SKU. **ServiceNow**'s Action
  Fabric opens its workflows to external agents — a governed-execution land grab
  inside its own cloud.
- The pattern: registries, identity, quotas, RBAC — *infrastructure* governance
  for enterprises with platform teams, inside their own clouds. **None of them
  ships evidence-earned trust levels, certification-before-autonomy, or a
  tamper-evident audit chain as product.** Approval flows exist as
  configuration, not doctrine.

### The support specialists are enormous, single-role, and over-claiming

- Sierra: $15.8B valuation, $150M+ ARR, ~$1–2.50/resolution plus $200-350k
  year-one deployments. Decagon: $4.5B. Fin: $100M ARR at $0.99/resolution —
  and an independent teardown puts its *production* resolution at **45-53% vs
  the 76% marketing claim**. Zendesk now advertises **dual-verified billing** of
  resolutions — pricing integrity is becoming a feature.
- Relevant to us twice: (a) support is the most contested, fastest-commoditising
  market on earth — $0.50-2.00 per resolution and falling; (b) the honesty gap
  is public knowledge, so **verified, honest metrics are a weapon** — and our
  deferred-settlement metering (built, flag-off: a resolution only bills after
  72h with no negative signal) is precisely the "dual-verified billing" the
  market is converging on.

### Role specialists: one role each, human-gated wherever money moves

- **Accounting is the hottest role category of 2026** (Pilot's "AI Accountant"
  at ~$99/mo, Basis at $1.15B used by ~30% of top-25 firms, Digits' agentic GL)
  — and the credible ones are **approval-gated by design**. The founder's
  draft→approve→post instinct is the market standard, confirmed again.
- **AI SDR is the cautionary tale**: 50-70% annual churn, the 11x fabricated-
  customers scandal, Artisan repricing 10x downward. The winner (Clay, $5B
  tender) won by selling research + human-in-loop, *not* autonomous reps.
  Governed drafts with caps is the surviving posture — which is what we built.
- **Collections/AR**: incumbents (Upflow, Tesorio) repositioning as "agents with
  guardrails"; AI-natives funded (Daylit $110M, Fazeshift $17M Series A).
  Human review of outbound dunning is the default posture. Our chain matches
  the market's landing point — with a stronger control (a rung structurally
  cannot chase an unverified balance).
- **Compliance**: Norm Ai at $1.2B, Bretton (ex-Greenlite) $75M — in regulated
  buying, human approval + evidentiary audit trail is *standard*. Proof that
  governed agents are what regulated buyers pay for.
- **Ema** ("Universal AI Employee", ISO 42001 + SOC 2 certified) is the closest
  concept-competitor and shows the certification path works as marketing.

### Governance became a buying criterion in 2026 — ahead of the law

- Enterprise procurement now asks for **kill switches, evidentiary audit
  trails, human-in-the-loop boundaries, model change control** as standard
  vendor obligations. Deloitte: only **21% of enterprises have mature agentic
  governance** while 74% expect agent use by 2027 — the gap is the market.
- Gartner: **>40% of agentic projects will be canceled by 2027**, naming
  inadequate risk controls; "guardian agents" forecast at 10-15% of the market
  by 2030; and only ~130 of the thousands of self-described agentic vendors are
  real ("agent washing").
- EU AI Act's high-risk obligations slipped to Dec 2027 — so through 2026-27
  governance demand is **buyer-driven, not regulator-driven**. ISO 42001 is the
  cheapest credibility purchase available (<100 orgs certified worldwide).
- MIT's much-cited finding: 95% of GenAI pilots produced no P&L return; the 5%
  that worked **bought a narrow workflow**. Failure modes have shifted from
  hallucination (<10% of logged failures) to **execution and escalation
  breakdowns** — Klarna publicly walked back its 700-role replacement; Replit's
  agent deleted a production database. Every one of these is a sales asset for
  trust-graduated autonomy.

### Where that leaves us

The white space is real and it is exactly the locked wedge, sharpened: **nobody
prominent sells an SMB/mid-market multi-role workforce where governance is the
operating system, running on the customer's own systems of record.** The giants
govern agents inside their own clouds for enterprises; the specialists sell one
role each. What the market would laugh at: breadth claims from a pre-revenue
team, self-reported autonomy rates. What it would respect: the audit hash chain,
certification-before-autonomy, destructive-always-gated, verified billing, and
honest claimed-vs-production numbers.

## 5. The founder's 10 roles — validated, re-ranked for winnability

The founder's list survives contact with the market data far better than most
founder lists do — the finance/support cluster at the top is exactly right. The
research (SMB adoption surveys, funding flows, revenue-proven companies, labor
data; all sourced in the session record) forces four corrections:

1. **The single most-proven SMB "AI employee" was hidden inside his #8.** The
   voice front-desk — reception, call answering, scheduling — is the actual SMB
   entry product of 2026: Podium crossed $100M AI-agent ARR (+300% YoY), Avoca
   reached ~$1B valuation on HVAC/plumbing operators, EliseAI $200M ARR
   automating 90% of leasing work, SMB voice-agent adoption ~30% and growing 89%
   YoY. It deserves its own rank near the top — and **voice is a hard
   requirement in 6 of the 10 target industries** (healthcare, trades,
   restaurants, personal services, logistics, legal intake). We have no voice
   channel. This is the largest strategic gap this review found.
2. **Growth Marketing is over-ranked by ~6 places** as an *agent* purchase.
   Marketing is the #1 SMB *AI usage* category — which is exactly why nobody
   pays for an autonomous marketer: owners DIY it with $20-60/mo copilots. No
   breakout autonomous-marketing company exists. And internally, our marketing
   kits are ungrounded (no categories/providers) — the role would today produce
   confident, unmeasurable content. Ship marketing as an assistive capability
   inside other roles; do not sell it as an employee.
3. **Billing and Collections are one role.** Buyers purchase order-to-cash
   motion (invoice → chase → reconcile), not two agents. Merged below.
4. **IT helpdesk is missing** from the list entirely — 70% of MSPs already run
   agentic service delivery, SMBs consume it through the MSP channel, and our
   helpdesk category is ironically the *richest* rail we have (14 platform
   actions). Added; procurement parked at #11 (near-zero sub-100-employee
   demand).

### The combined table — market demand × our readiness

*WTP = willingness-to-pay signal for SMB/mid-market, from the research.
Readiness = production evidence tier from §5a. Loaded human cost anchors what
the role can be priced against (agents at $200-1,500/mo = 5-25% of the human).*

| Rank | Role | Founder's # | WTP | Our readiness | Loaded human cost | Voice needed |
|---:|---|---:|---|---|---|---|
| 1 | Customer Service & Success (incl. renewal risk) | 1 | Strong | **OPERATING** — the one earned-autonomy employee lives here | $58-64k | Partial (hard in local verticals) |
| 2 | **Order-to-Cash: Collections & AR + Billing** | 3 + 2 | Strong (hard-dollar: automation-heavy AR shops report ~32% DSO cuts) | **PROVEN chain** — our best moat fit | $59-79k | Partial (escalation calls) |
| 3 | Front-Desk, Reception & Scheduling | carved from 8 | Strong — THE proven SMB wedge | **MISSING** (no voice) | $45-50k | **Yes** |
| 4 | Bookkeeping & Accounting Ops | 5 | Strong (95% zero-touch is the market bar; accountant channel) | SCAFFOLD+ (right control spine, no feeds/GL-post) | $57-70k | No |
| 5 | Sales Dev — re-scoped to **inbound speed-to-lead** + CRM hygiene | 6 | Strong inbound / weak cold-outbound (AI-SDR churn 50-70%) | BUILT, unverified (HubSpot/SF writes; draft-gated outbound) | $95-120k OTE | Partial |
| 6 | IT Helpdesk & Internal Support | — (new) | Emerging-strong via MSP channel | BUILT-adjacent (richest category rails, pointed outward today) | ~$65k | No |
| 7 | Recruiting & HR Ops | 7 | Emerging (volume/hourly hiring; episodic otherwise) | THIN (one BambooHR action, no kit) | $82-101k | Partial |
| 8 | Compliance, Quality & Reporting | 10 | Emerging in regulated verticals; weak horizontal | **PLATFORM PROPERTY** (the moat itself), thin as standalone DE | $80-130k | No |
| 9 | Admin & Document Processing (post carve-out) | 8 | Emerging | MISSING→SCAFFOLD (extraction pipeline empty; computer-use has no runtime) | $60-67k | No |
| 10 | Growth Marketing | 4 | **Weak as an agent** | SCAFFOLD ONLY (ungrounded — categories don't exist) | $65-92k | No |
| 11 | Procurement & Vendor Ops (parked) | 9 | Weak SMB / emerging 200+ employees | MISSING | $75-84k | No |

**On his "Industry coverage 10/10" column:** it measures universality, which is
real — every industry has these functions. What it doesn't measure is whether
anyone *buys an agent* for the function today. The re-rank above is by
winnability: demand × our readiness × moat fit × competitive crowding. Both
lenses are true; only one sequences a roadmap.

### Pricing implication (from the labor and spend data)

SMB AI spend clusters low — 28% spend $25-99/mo, only ~10% spend $250+/mo — so
the honest wedge is **fractional-role displacement** ("the 0.25 bookkeeper you
never hired"), not FTE replacement, with role-branded packaging (SMBs think in
headcount) and an **outcome-metered billing unit the owner can audit**. Our
deferred-settlement metering — a resolution only bills after 72h with no
negative signal — is precisely the "verified billing" the market is converging
on (Zendesk now markets exactly this); it is built, flag-off, and should be a
launch feature, not an option. Where hard-dollar ROI exists (DSO days, missed
calls recovered), price against the outcome, not the seat.

### Internal readiness per role (production evidence, 2026-08-04)

| # (founder) | Role | Readiness | What exists | What's missing to sell it |
|---:|---|---|---|---|
| 1 | Customer Service & Success | **OPERATING** | support_agent (12 hires, 21 certs, 1 auto-send), cs_manager + onboarding + renewal_manager kits, chat+email, streaming guardrails, at-risk watchers | **Voice** (absent, and the role spec includes it); helpdesk writes (Zendesk/Freshdesk/Intercom/Gorgias — 13 actions) all unverified |
| 2 | Billing & Invoicing | **BUILT→PROVEN (one SoR)** | invoice-from-agreement drafting under balance+evidence gate; ERPNext sync w/ verified balances; billing actions (Stripe/Chargebee) | Verify QBO/Xero/Stripe writes; an invoice actually *created* in an external system with a receipt |
| 3 | Collections & AR | **PROVEN chain** | dunning ladder that cannot chase unverified balances; promise-to-pay with derived kept/broken/unverifiable; 2 approved sends w/ receipts; hourly AR self-refresh; drift sentinel | Payment ingest beyond ERP `outstanding_amount` (bank feed); volume — it has run twice, not two thousand times |
| 4 | Growth Marketing | **SCAFFOLD ONLY** | marketing/seo/google_ads kits + SOPs | The `seo`/`ads`/`marketing` **categories do not exist**; no GA4/Search Console/Meta/Google Ads providers; a hired SEO DE today runs **ungrounded** — a content generator with a job title |
| 5 | Bookkeeping & Accounting | **SCAFFOLD+** | posting_drafts (balance + line-evidence enforced), evidence-only payment reconciliation, accounting/fpa kits | Bank/receipt feeds (extraction pipeline is empty), an external GL post action with receipt+rollback |
| 6 | Sales Development & CRM | **BUILT, unverified** | bdr/sdr kits, HubSpot+Salesforce write actions (6), draft-for-approval outbound machinery | One verified CRM write; an email send path; enrichment source. Market note: governed drafts are the antidote to the AI-SDR churn collapse — this is a positioning asset |
| 7 | Recruiting & HR Ops | **THIN** | payroll_hcm category, one BambooHR action | No archetype/kit, no ATS provider, no sourcing/screening machinery |
| 8 | Admin & Document Processing | **MISSING→SCAFFOLD** | email inbox watch (feeds support), computer-use proposals (gated, **no runtime exists**), extraction tables (empty) | The extraction pipeline itself; doc generation; scheduling |
| 9 | Procurement & Vendor Ops | **MISSING** | nothing role-specific (ERPNext PO doctypes reachable in principle) | Category, kit, PO machinery — and the sales cycle is the longest of the ten |
| 10 | Compliance, Quality & Reporting | **PLATFORM PROPERTY** | compliance packs, guardrails+adjudication, tamper-evident audit chain, cert exams, eval/QA, exception engine — more than any competitor ships | Reframe: this is the governance layer **of every role**, our moat — not a standalone DE. A "reporting DE" that assembles audit evidence is a later, cheap add |

## 6. Readiness — the platform-level gaps that block *any* role claim

**P0 — credibility (before any sales conversation):**
1. **Verify the 12 unverified providers** against real sandboxes (HubSpot,
   Salesforce, QuickBooks, Xero, Stripe, Zendesk, Freshdesk, Intercom, Gorgias,
   BambooHR, Square, Shopify). Until then every integration claim is a demo
   claim. This needs founder-created sandbox credentials; it is days of work per
   provider, not weeks.
2. **Voice decision.** The #1 role's spec includes phone. Buying (Twilio +
   a voice-agent layer riding our existing guardrail/gate machinery) vs
   deferring is a strategy decision — but "Customer Service Agent" without voice
   is a partial claim in most SMB verticals.
3. **Design partners.** N=0. The docs/24 proof gate (one paying instrumented
   reference) is still the binding constraint. Target: 5 SMBs, 2 wedge roles,
   90 days, receipts on *their* systems.
4. **Throughput honesty.** Post-cleanup, the workforce completes ~0 non-answer
   work items on live tenants. The de-work spine exists; give the live tenant
   real books of work again (the exam purge took the fake ones — good — but
   nothing real replaced them).

**P1 — role unlocks in wedge order:**
5. Payment/bank ingest feeding `reconcile_invoice_payments` (turns collections
   from ERP-mirroring into cash-truth).
6. External GL post action (journal/payment entry to ERPNext first) with
   receipt + rollback — unlocks the accounting role's draft→approve→post.
7. Outbound email send path with per-rung caps (unlocks collections at volume
   and SDR drafts).
8. HR archetype on the BambooHR rails (cheap: the kit mechanism is proven).
9. Marketing grounding **only if the role stays**: create seo/ads/marketing
   categories + GA4/Search Console/Meta providers; until then, stop offering
   those kits (they hire ungrounded employees — the exact "confident false
   report" failure mig 528 documented).

**P2 — later:**
10. Document-extraction pipeline (tables exist, empty) → unlocks Admin/AP.
11. Procurement category + kit (ERPNext PO path for bundle customers first).
12. Per-role certification exams beyond support (21/21 are support today;
    the exam driver is generic, the question banks are not).
13. Compliance "reporting DE" assembling audit-chain evidence into
    regulator-shaped artifacts — cheap, high-differentiation.

## 7. The verdict in full, and the sequencing

### Commercially viable?

**Yes — as a focused, governed order-to-cash + support workforce with a 90-day
proof program. No — as a 10-role horizontal launch.** The evidence for each
half:

*For viability:* the white space is real and validated — nobody prominent sells
a multi-role governed workforce on the customer's own systems of record for
SMB/mid-market. Buyer-side procurement now demands exactly our primitives (kill
switches, evidentiary audit trails, HITL boundaries, change control) while only
21% of enterprises have mature agent governance. Gartner's 40%-of-projects-
canceled forecast names inadequate risk controls — every public failure (Klarna,
Replit, the AI-SDR collapse, Fin's claimed-vs-real gap) is a sales asset for
trust-graduated autonomy. The suites are absorbing point agents, which favors a
multi-role portfolio. And the trust machinery has already done the one thing the
whole market struggles to do: complete an honest earn-revoke-restore autonomy
cycle in production.

*Against complacency:* Salesforce bought Fin ($3.6B) explicitly to come
down-market — the window is ~12 months, not ~36. The giants will ship
better models, voice, and distribution than we ever will; the only durable
position is the one they structurally won't take: **governance depth as the
operating system, on systems of record they don't own, for buyers too small
for their platform teams.** And the market laughs at breadth claims from
pre-revenue vendors — with N=0 customers and one verified connector, our 10-role
story must be told as a *sequenced portfolio*, never a launch claim.

### Is it "just a support tool with a renewal DE"?

No — but the version of the answer that matters is: **it is a governed
execution OS whose evidence is currently support-shaped.** Three role families
have real machinery (support/renewals operating; order-to-cash proven;
accounting drafting scaffolded on the right controls). The other seven are rails
of varying depth on a genuinely role-generic chassis — 12 installable kits, one
gate, one audit chain, zero tenant-specific code. What separates "support tool"
from "operations platform" is not another subsystem; it is verified connectors,
real books of work, and paying references.

### The 90-day program (recommendation)

1. **Wedge = Order-to-Cash on the ERPNext bundle + Support/Renewals as the
   trust-builder.** Two roles, one story: "your money chased and your customers
   answered, every action gated, everything auditable." Target the phone-light
   segments first (e-commerce, SaaS, professional services, manufacturing) where
   voice isn't gating.
2. **Verify the providers that back those two roles first** (QuickBooks, Xero,
   Stripe, HubSpot, Zendesk sandboxes — founder supplies credentials), then the
   rest. Every verified write converts a demo claim into an evidence claim.
3. **5 design partners, 90 days, receipts on their systems.** The docs/24 proof
   gate stands: one paying instrumented reference before scaling GTM. Offer the
   deferred-settlement verified billing as the pricing hook.
4. **Make the voice decision now** (build-on-Twilio vs partner vs defer): it
   gates rank #3 (front-desk — the proven SMB wedge we don't have) and half the
   industries on the founder's coverage claim. Deferring is legitimate;
   deferring *silently* is not.
5. **Pull the marketing kits from the catalog until grounded** (categories +
   GA4/Search Console/Meta providers exist) — an ungrounded SEO employee is the
   mig-528 confident-false-report failure sold as a product. Keep marketing as
   assistive drafting inside other roles.
6. **Start ISO 42001.** Cheapest credibility for a governance-first vendor;
   fewer than 100 orgs certified; our closest concept-competitor (Ema) already
   markets it.
7. **Activate the honesty features we already built** (founder flags):
   deferred-settlement metering and grounded confidence enforcement — they are
   the productized version of the market's biggest credibility gap.
8. **Roadmap the next roles in winnability order** (bookkeeping GL-post →
   inbound speed-to-lead → IT helpdesk via MSP → HR kit on BambooHR), each
   gated on: category exists → provider verified → kit installable → exam
   exists → design-partner proof. The role table in §5 is the sequence; the
   gap register in §6 is the work.

### What to tell a buyer today (honest claims)

- "Every external action passes an approval gate; destructive actions cannot
  bypass a human." — TRUE, enforced in the database.
- "Autonomy is earned per-employee from evidence, and revoked on evidence —
  here is one that did the full cycle." — TRUE, with the exam-honesty story.
- "Your audit log is tamper-evident and we prove it on demand." — TRUE.
- "We run on your systems; we never replace them." — TRUE (and the SMB bundle
  exists for buyers who have no system to run on).
- "We resolve X% of your support volume autonomously" — **NOT YET SAYABLE.**
  N=0. That number is what the design-partner program exists to earn.
- "We do ten roles" — **NOT SAYABLE AS A CLAIM.** Sayable as: two roles proven,
  a governed chassis the other eight install onto, in this order, on this
  evidence.
