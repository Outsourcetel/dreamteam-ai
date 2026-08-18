# 57 — Workstream H: review synthesis & go/no-go (2026-08-18)

## What this rests on — and what it does not

Seven of nineteen workstreams have run: **A** inventory · **B** functional truth (5 live-drive
sessions) · **C** security & tenancy · **D** code health (opened) · **E** ops readiness ·
**F** gap analysis · **G** pilot readiness. Parallel sessions contributed **docs 51** (measurement
organs), **52** (write perimeter — audit only, nothing applied) and **53** (deferred-work census).

**Not yet examined:** AI answer quality (I), performance at scale (J), UX/accessibility (K), unit
economics (L), compliance/legal depth (N), dependencies & secrets (O), connector reality (P),
tenant lifecycle (Q), incident readiness (R), documentation accuracy (S), voice-of-user (T).

Everything below is measured against live production. Where a claim is inferred, it says so.

---

## 1. The one-sentence finding

**The governed core is real and provable; the loop that turns governed work into finished work is
jammed, and every commercial blocker is a decision rather than a build.**

## 2. Scorecard

| Module | Verdict | Evidence |
|---|---|---|
| Provisioning / onboarding | 🟢 proven-live | real signup path, baseline parity |
| Support pipeline | 🟢 proven-live | intake → grounded 95% answer → draft gate → approve → delivered |
| Knowledge ingest & retrieval | 🟢 proven-live | doc → chunk → embed → grounded the answer same minute |
| Hosted chat / widget | 🟢 proven-live | key auth, rate limit, poll, CSAT path |
| Mission rail (keystone) | 🟢 proven-live | compiles plan, **writes its own human gates**, plan-gate held |
| Park / snooze | 🟢 proven-live | 7/7 incl. the last_message_at invariant |
| Cross-tenant isolation | 🟢 proven-live | 21 attack probes, **0 holes** |
| Schema recoverability | 🟢 proven-live | restore drill exact on all 7 object classes, REVOKEs intact |
| Backups | 🟢 verified | 7/7 daily snapshots, no gaps (debt-map claim was stale) |
| Approvals spine | 🟡 works, was lying | F-6 fixed + gated; 3 dead approvals remain in live queues |
| Mobile `/m` | 🟡 works | renders, decides, delivers — since the F-6 fix |
| DE runtime | 🟡 alive, starved | 5,695 invocations/30d, only ~700 externally valuable |
| Objectives / completion | 🔴 **0 of 48 ever achieved** | and cannot unblock while B-11 is broken |
| Decision loop | 🔴 **expiry > service** | 21 expired vs 13 decided on the live tenant |
| Trust ladder | 🔴 never opened | 127/127 supervised; 11 requests queued |
| Billing | 🔴 cannot charge | `tenant_billing_config` = 0 rows |
| Email channel | 🔴 dark | 0 conversations ever; secret unset |
| Voice | 🔴 zero traffic | 3 edge fns, 0 rows ever |
| Alerting to humans | 🔴 reaches nobody | 133 unresolved; 77 firing 20 days |
| Data restore | ⚪ unproven | never performed; PITR off = 24h loss window |
| Legal / contracts | ⚪ honest drafts | jurisdiction, liability cap, retention all unset |

## 3. The trajectory is up, and that matters

`certify` had **10 sections** when this review opened on 08-11. It has **20 today** — the harness
doubled in a week, including a probe (`no-approval-that-said-sent-and-sent-nothing`) written
directly against a finding this review produced, and a `deferred-register` section that
re-verifies every open item against live production on every run.

Today's run: **14 pass, 6 fail.** Attribution matters more than the count —

* `discovery-proposal-decisions`, `decide-discovery-proposal-behaviour` — a parallel session's
  **in-flight** feature, not decay
* `deferred-register` — fails *by design* while debt is open. This is the gate working
* `ring0-probes` — the three dead approvals (F-1/F-2/F-3), known and listed
* `role-gates` — **real**: 3 UI writes refuse `tenant_manager`/`knowledge_manager` who should pass
* `suite` — one failing test in `write-bindings.test.ts`

**A project whose gates double in a week while it finds its own defects is not decaying. It is
becoming measurable.** That is the single most encouraging fact in this review.

## 4. Ranked register — 50 items, 47 open

By severity: **security 7 · correctness 12 · measurement 9 · hygiene 19.**
Authoritative state lives in `review/deferred-register.json` (`npm run defer -- --list`); every
item carries a live query so none can quietly go stale.

**The five that decide whether a pilot succeeds:**

| # | Item | Why it is top-five |
|---|---|---|
| 1 | **B-12** — expiries exceed decisions | The product's core loop discards work. Ship this to a customer and it buries them in week two |
| 2 | **B-11** — reconcile job dead since 08-05 | 245 failures/7d; blocked objectives can never unblock; explains 0-of-48 |
| 3 | **C-8** — alerts reach no human | B-11 alarmed 77 times for 20 days and nobody knew. Push exists and is unused |
| 4 | **G-3** — trust ladder never opened | The built relief valve for #1, queued behind #1 |
| 5 | **Billing unconfigured** | Zero rows. A signed pilot cannot be invoiced |

## 5. 30 / 60 / 90

**Next 30 days — make the loop finish work.**

1. Fix **B-11** (one CHECK constraint vs one written value — hours).
2. Route **C-8** alerts into the push channel that already works.
3. Ship **batch decision** UX — one operator clears dozens, not one at a time.
4. Clear the three dead approvals (**F-1/F-2/F-3**); F-1 is one founder tap.
5. Fix **role-gates** — 3 gates refuse roles that should pass.

**Days 30–60 — make it sellable.**

6. Open the **trust ladder** on the single highest-volume, lowest-risk class (the 186 escalations),
   measured, one class at a time.
7. **Set a price, enable billing.** AI cost is $12/mo across all tenants — pick per-seat or
   per-outcome, never per-message.
8. **Wire email** (one secret, one domain).
9. Contracts to counsel: jurisdiction, liability cap, **retention/deletion**.

**Days 60–90 — make it provable at scale.**

10. **Prove a data restore** into a throwaway project (the one control still untested).
11. Bring **dev to parity** with production (120 migrations behind) so golden-path proves today's
    schema; fix the hardcoded drift footer (**F-8**).
12. Run the workstreams this review has not: **I** (answer quality), **L** (unit economics),
    **P** (connector reality), **Q** (lifecycle incl. deletion), **N** (compliance).

## 6. Go / no-go

**Opening a pilot beyond Outsourcetel today: NO-GO.** Not because the product is weak — the
demo is strong and the isolation, gating and audit properties are genuinely rare — but because
three commitments cannot currently be honoured: **we cannot invoice them, we cannot promise their
decision queue will be answered, and we cannot honour a deletion request.**

**Conditional GO** once four things are true, none of which is a large build:

1. Decision throughput demonstrably exceeds arrival on our own tenant for two consecutive weeks
   (B-12 green, B-11 fixed, batch UX shipped).
2. A price exists and one tenant is successfully billed end to end.
3. Email is live and has carried a real thread.
4. Counsel has cleared jurisdiction, liability and retention.

Items 2–4 are days of work. Item 1 is the product question — and it is the one worth solving,
because it is also the thing that makes the pitch true: **"digital employees that cannot act
behind your back"** only sells if the work still gets done.

## 7. What could still change this verdict

The twelve unexamined workstreams contain real risk. In descending order of what could most
change the picture: **I** (if answer quality is poor, the demo's 95%-confidence moment is
hollow) · **L** (whether human-review cost destroys the margin) · **Q** (whether deletion and
suspension actually work) · **P** (whether the 2 integrations survive contact) · **J** (whether
any of it holds at 10×). None is likely to overturn the *governance* findings, which are the
product's differentiator and are proven.
