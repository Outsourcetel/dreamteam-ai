# 56 — Workstream G: market fit & pilot readiness (2026-08-18)

Not a marketing plan. This answers one question: **can the product survive contact with a
prospect, and what must be true first?** Judged on Workstream A–F evidence, all measured live.

## Verdict

**Demo-ready. Not pilot-ready.** A stranger can be shown a genuinely differentiated product in
30 minutes, and every step of that demo is proven live. But a paying pilot would hit three walls
in its first fortnight: nobody can be billed, decisions expire faster than they are answered, and
the contracts are unsigned drafts.

## 1. The demo path — every step PROVEN LIVE (Workstream B)

This is the flow to show, in this order. Nothing here is aspirational:

1. **Create a workspace** through the real signup path — baseline employees auto-provision.
   *(proven 08-12, Review Lab)*
2. **Give it knowledge** — paste a document; it chunks and embeds in seconds. *(proven)*
3. **A customer asks a question** in the hosted chat — the employee answers **grounded in that
   document at 95% confidence**, citing it. *(proven)*
4. **The reply does not send.** It is held as a draft and an escalation is raised. The customer
   sees nothing. *(proven — this is the money shot; a chatbot cannot show this)*
5. **Approve it from your phone** — the customer receives the reply, the thread hands to
   `human_owned`. *(proven 08-18, after the F-6 fix)*
6. **Give an order in plain English** — "make sure every open conversation has a complete answer".
   It compiles into a plan that **writes its own human gates** ("before sending any follow-up —
   human must approve"), waits for approval, then installs live watchers. *(proven 08-12)*
7. **Show the audit trail** — 44,943 events in 30 days, and a chain `certify` verifies
   cryptographically.

## 2. The North-Star test — what a chatbot competitor cannot claim

| Claim | Evidence | Safe to say? |
|---|---|---|
| Every external act is gated by a named human decision, recorded | draft-gate proven; 464 decisions logged | ✅ **yes** |
| An order compiles to a plan with gates *before* anything runs | mission drive, 2 gates auto-written | ✅ **yes** |
| Tenant isolation proven by attack, not asserted | Workstream C: 21 probes, 0 holes | ✅ **yes** |
| The platform refuses approvals it cannot carry out | ring-0 probes + mig 721 trigger | ✅ **yes** |
| Employees earn autonomy as they prove themselves | **127/127 supervised, never promoted** | ❌ **no — do not claim** |
| It completes work end to end | **0 of 48 objectives ever achieved** | ❌ **no — do not claim** |
| Native integrations with your stack | 2 real (ERPNext dev, Stripe-MCP) | ❌ roadmap only |

The first four are real, rare, and defensible. **Sell the governed seam; do not sell autonomy or
outcomes yet.**

## 3. Can we charge anyone? No.

| Table | Rows |
|---|---|
| `tenant_billing_config` | **0** |
| `tenant_outcome_pricing` | **0** |

The machinery exists and is unconfigured — **no tenant has a plan, and no price is set on
anything.** A signed pilot today has no mechanism to be invoiced.

**But the cost side is excellent news.** Metering is clean (2,158 calls, 5.5M tokens, zero
unpriced models) and the **entire platform's AI spend for 30 days across all 16 tenants was
$12.01.**

That single number should shape pricing: **tokens are not the COGS — human review is.** Pricing
per-seat or per-outcome clears cost trivially; pricing per-message would be leaving nearly all
the value on the table. (Full unit economics is Workstream L.)

## 4. What a pilot's first two weeks would actually look like

| Day | What happens | Status |
|---|---|---|
| 1 | Workspace created, knowledge loaded, widget embedded | ✅ works |
| 2–3 | Real customer questions arrive, grounded drafts appear | ✅ works |
| 2–3 | Their admin approves replies from the phone | ✅ works (since 08-18) |
| 4 | They ask "can we email support@ instead?" | ❌ **dark** — channel never wired (D-9) |
| 5–7 | Decision queue reaches ~60/week; they answer a handful | ⚠️ **the wall** |
| 7+ | Unanswered decisions begin **expiring** | ❌ 21 expired vs 13 decided on our own tenant |
| 10 | They ask "can it just handle the routine ones?" | ❌ trust ladder never opened |
| 14 | Invoice due | ❌ no billing config exists |
| any | Their security review asks for a DPA / retention policy | ❌ placeholders (§5) |

## 5. Contract readiness — honest drafts, not signable

`TermsOfServicePage` and `PrivacyPolicyPage` are real, well-written, and **self-aware about being
incomplete** ("the placeholders below need real answers first"). Open items, verbatim from the
pages: trial length and what happens at its end · limitation-of-liability cap and indemnification ·
**governing jurisdiction** · confirmation of each AI provider's data-processing terms (Anthropic is
named) · and — most material — *"there is currently no automated retention/deletion window."*

That last one means **a deletion request cannot be honoured automatically today.** For an EU or
California pilot that is a hard blocker, not a nicety. (Workstream N takes this further.)

## 6. The four things that must be true before a pilot signs

Ranked by what stops the deal soonest:

1. **Answer the decision-rate problem** (docs/55 G-1). Either batch approval, or open the trust
   ladder on the 186 escalations. Without this the pilot's own queue buries them in week two —
   and we would be shipping them our bottleneck.
2. **Set a price and turn billing on.** `tenant_billing_config` has zero rows; $12/mo of AI cost
   means almost any sane price is profitable. This is a decision, not a build.
3. **Wire the email channel** (D-9). Mid-market support means email. One secret and a domain.
4. **Get the contracts past counsel** — jurisdiction, liability cap, retention/deletion.

Items 2 and 3 are hours of work. Item 1 is the product question this whole review has been
circling. Item 4 needs a lawyer, not an engineer.

## 7. Positioning, in one line

> *"Digital employees that cannot act behind your back — every external action waits for a named
> human, and the whole chain is auditable."*

That is true today, provable in a live demo, and not something Sierra, Decagon or Fin lead with.
What we must **not** yet say is that it works unsupervised, or that it finishes work on its own.
Both are measured false, and a prospect who tries either will find out in week two.
