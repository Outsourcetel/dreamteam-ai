# 57 — Review synthesis & go/no-go (v2, 2026-08-18)

> **v2 supersedes the 7-workstream draft.** All **19 workstreams are now complete** (docs 49–69).
> Six of them changed conclusions in the first version, including the go/no-go rationale. Changes
> are listed in §8.

## 1. The finding, in one paragraph

The governed core is real, provable, and better built than its own documentation claims. **Every
detection organ in the product works and not one of them reaches a person**, which is why three
real incidents ran for a combined 40 days unnoticed. And the single feature that would fix the
economics, the scaling limit and the founder's own observed behaviour is the same feature: **the
trust ladder, which has never been opened.** Every remaining commercial blocker is a decision or
a configuration, not a build.

## 2. Scorecard — 19 workstreams

### Proven strengths (measured, not claimed)

| Area | Evidence |
|---|---|
| **Tenant isolation** | 21 attack probes from a real second tenant — **0 holes** (C) |
| **Support pipeline** | intake → grounded answer → draft gate → approve → delivered (B) |
| **Answer quality** | **83% pass**, avg 90 when passing; workhorse employee **91%** (I) |
| **Lifecycle** | 8/8 transitions; suspension *actively refuses* (HTTP 402), not just silence (Q) |
| **Schema recoverability** | restore drill exact on all 7 object classes, REVOKEs intact (E) |
| **Backups** | 7/7 daily snapshots verified against the API, not the dashboard (E) |
| **Error detection** | Sentry proven end-to-end by a deliberate probe (R) |
| **Supply chain (npm)** | **zero production-reachable vulnerabilities**; 134 packages; 5/5 MIT (O) |
| **Secrets history** | **no credential has ever been committed** — every commit tree checked (O) |
| **Accessibility** | **0 contrast failures** / 104 elements; 0 unnamed icon buttons (K) |
| **Customer manual** | **65 live, embedded, well-written KB articles** (S) |
| **Performance** | no pressure anywhere; vector search correctly HNSW-indexed (J) |
| **Mission rail** | compiles a plan that **writes its own human gates** (B) |

### Broken or dark

| Area | Evidence |
|---|---|
| **Completion** | **0 of 48 objectives ever achieved** (F) |
| **Decision loop** | **21 expired vs 13 decided** on the live tenant (F) |
| **Trust ladder** | 127/127 supervised, never opened; 11 requests queued (F) |
| **Notification** | ops alerts, connector health and Sentry all reach **only a dashboard** (E, P, R) |
| **Reconcile job** | dead since 08-05, 245 failures/7d — blocked work cannot unblock (E) |
| **Only real integration** | ERPNext dead 7 days, `http_402`, 6,714 retries, no circuit breaker (P) |
| **Billing** | 0 rows configured — nobody can be charged (G) |
| **Email** | 0 conversations ever; one secret unset (B) |
| **Guardrails** | never fired in production — precision unmeasurable (I) |
| **Per-person erasure** | no function exists (Q, N) |

## 3. Three findings that arrived from multiple directions

Findings that independent workstreams converged on carry more weight than any single measurement.

**① Nothing reaches a human — found four times.** Ops alerts → in-app banner only (E). Connector
failure → a derived UI badge only (P). Sentry issues → the Sentry dashboard only, 4 issues
unresolved for up to 29 days (R). And the founder's phone, which *does* work, is used only for
approvals (B). **This is one problem with four faces.**

**② The trust ladder is the answer to three different questions.**

* **Margin** — moving escalations to earned autonomy is worth ~50 points of gross margin at a
  $500 price; without it the business goes *underwater as the customer succeeds* (L).
* **Scale** — it is the built relief valve for a queue jammed at 66-in / 5-answered per week (F).
* **Behaviour** — the founder answers governance decisions at 50–67% within the hour and routine
  ones at 5%. They already behave like someone who wants policy calls, not per-item calls (T).

**③ The system fails quietly, and always has.** A cron dead 13 days, a connector dead 7, an alarm
ringing 20, four Sentry issues aging a month. Every one was detected correctly. None was
announced.

## 4. The register — 60 items, 57 open

**security 9 · correctness 14 · measurement 12 · hygiene 22.** Authoritative state lives in
`review/deferred-register.json`; every item carries a live query and re-verifies on each `certify`
run. This review filed 13 of them.

**The five that decide a pilot:**

| # | Item | Why |
|---|---|---|
| 1 | **B-12** — expiries exceed decisions | the core loop discards work; ship it and it buries the customer in week two |
| 2 | **B-11** — reconcile job dead | 245 failures/7d; explains 0-of-48 completion |
| 3 | **C-8** — nothing reaches a human | the multiplier on every other failure |
| 4 | **G-3** — trust ladder shut | margin, scale and behaviour all point here |
| 5 | **Billing unconfigured** | a signed pilot cannot be invoiced |

## 5. 30 / 60 / 90

**First 30 days — make the loop finish work, and make failure visible.**

1. Fix **B-11** — one CHECK constraint against one written value.
2. **Route detection to a person** — ops alerts, connector health and Sentry into the push channel
   that already works (**C-8**). One job, three systems; would have caught B-11 and B-13 on day one.
3. Ship **batch decisions** — the founder answers in 2–3 hours when they engage; give them a way
   to clear dozens at once.
4. Restore **ERPNext** and add a **circuit breaker** (**B-13**).
5. Clear the three dead approvals (F-1/F-2/F-3) and fix **role-gates** (3 gates refuse the wrong roles).
6. Two one-liners: **`color-scheme: dark`** (D-13) and **rotate the Resend key** (A-6).

**Days 30–60 — make it sellable.**

7. **Open the trust ladder** on the 186 escalations, measured, one class at a time — and start
   **capturing decision rationale**, which is the evidence a promotion needs and which 33 of 33
   approvals lack (T).
8. **Set a price and switch billing on.** AI costs **$12/month across all tenants**; per-seat or
   per-outcome, never per-message.
9. **Wire email** — one secret, one domain.
10. **Counsel**: jurisdiction, liability cap, retention — plus name all four possible AI
    subprocessors (**A-8**) and write `forget_end_user()` (**A-7**).

**Days 60–90 — make it provable at scale.**

11. **Prove a data restore** into a throwaway project — the last untested control.
12. Bring **dev to parity** (120 migrations behind) and fix the **hardcoded drift footer** (F-8).
13. **Pin the 71 floating edge imports** (D-12) — the privileged half of the system has the weaker
    supply chain.
14. One **guardrail red-team** (C-10) and one **rehearsed incident** (D-14).

## 6. Go / no-go

**Opening a pilot beyond Outsourcetel today: NO-GO** — on two commitments, not three.

1. **We cannot invoice them.** `tenant_billing_config` is empty; no price exists.
2. **We cannot promise their decisions get answered.** On our own tenant, more decisions expire
   than are ever made.

> **Corrected from v1.** The first synthesis listed a third blocker — *"we cannot honour a deletion
> request"*. Workstream Q found that too strong and withdrew it: **whole-tenant deletion exists,
> is well-guarded and writes a receipt from pre-counted rows.** What is genuinely missing is
> **per-person erasure** and a content retention policy (A-7). That is a real compliance gap and a
> counsel item — it is not a reason a pilot cannot start.

**Conditional GO** when four things are true:

1. Decision throughput exceeds arrival on our own tenant, two weeks running.
2. A price exists and one tenant is billed end to end.
3. Email is live and has carried a real thread.
4. Counsel has cleared jurisdiction, liability and retention, and A-7/A-8 are closed.

Items 2–4 are days of work. Item 1 is the product question — and it is the one worth solving,
because **"digital employees that cannot act behind your back" only sells if the work still gets
done.**

## 7. The trajectory is the most encouraging fact

When this review opened on 11 August, `certify` had **10 sections**. It now has **20** — including
a probe written directly against a defect this review produced, and a `deferred-register` section
that re-verifies all 57 open items against live production on every run.

That register **refused one of my own filings** during Workstream S, because the verification I
wrote was sloppy enough to contradict its own claim. A control that catches the reviewer is
working better than one that merely catches the code.

**A project whose gates double in a week while it finds its own defects is not decaying. It is
becoming measurable.**

## 8. What changed since v1

| Change | Workstream |
|---|---|
| **Deletion blocker withdrawn** from the go/no-go — tenant deletion works; per-person erasure is the real gap | Q |
| **"No customer manual" withdrawn** — 65 live, embedded, well-written KB articles exist | S |
| **"Legacy docs presumed stale" withdrawn** — 7 of 10 are marked and current | S |
| Answer quality confirmed **good**, so the demo's confident moment is not hollow | I |
| Integration count corrected from 2 to **1** — Stripe has never executed anything | P |
| Unit economics quantified: human review is **19–56× AI cost** | L |
| Notification gap escalated to the **most-repeated finding** in the review | R |
| UX and accessibility reclassified as a **strength** | K |
| Supply chain reclassified as a **strength** (npm) with the risk isolated to edge imports | O |
| The bottleneck reframed: **selection, not latency** | T |
