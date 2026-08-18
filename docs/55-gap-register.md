# 55 — Workstream F: product gap analysis (2026-08-18)

Judged against the locked references (docs/24 Roadmap of Record, the Constitution, the DE
business-unit verdicts). The two structural claims carried in project memory — the **completion
gap** and the **decision bottleneck** — are *measured* here, not re-argued. Every number below is
from live production today.

## The finding, in one paragraph

The machine starts work far better than it finishes it, and the reason is not capacity — it is
that **every finish needs a human, and the human is one person.** On the live tenant more
decisions have **expired unanswered (21) than have ever been made (13)**. The relief valve built
for exactly this problem — the trust ladder — has **never opened**: all 127 employees sit at
`supervised`, with 11 promotion requests waiting in the same queue that is already jammed. The
bottleneck is therefore self-sealing: the mechanism that would reduce the decisions is itself
blocked behind the decisions.

## 1. The completion gap — MEASURED

| Stage | Started | Finished | Completion |
|---|---|---|---|
| Objectives (all tenants) | 48 | **0 achieved, ever** | **0%** |
| Work items (all tenants) | 226 | 63 done | 28% |
| Work items (outsourcetel-hq) | 226 | 63 done · 163 open | 28% |
| Human decisions (all tenants) | 464 raised | 33 decided (30 ✔ / 3 �’) · 27 expired | 7% |

`achieved` **is** a valid objective status (CHECK allows open · in_progress · blocked · achieved ·
abandoned). Zero rows carry it. 45 of the 48 are `blocked`, and **all 45 blocked objectives are on
outsourcetel-hq** — the one tenant doing real work.

⚠ Compounding this: register **B-11** — the 30-minute job that reconciles blocked goals has been
failing since 2026-08-05 (245 failures/7d). Blocked objectives cannot currently become unblocked
even in principle.

## 2. The decision bottleneck — MEASURED

Arrival vs service, all tenants, by week:

| Week | Raised | Decided |
|---|---|---|
| 06-29 | 41 | 3 |
| 07-06 | 86 | 4 |
| 07-13 | 162 | 13 |
| 07-20 | 47 | 3 |
| 07-27 | 5 | 0 |
| 08-03 | 75 | 31 |
| 08-10 | 42 | 5 |
| 08-17 | 6 | 1 |

**~66 decisions arrive per week; ~5 are answered.** The queue is 404 pending, average age
**29 days**, oldest 2026-07-05, and **93% are older than a week**.

**Being fair to the number:** 208 of the 404 (51%) sit on `acme-telecom`, a *suspended demo*
tenant — artefacts, not operational load. The honest operating figure is **86 pending on
outsourcetel-hq**, averaging 8 days. That is the real burden, and it is still growing.

**The sharpest single fact in this review:** on the live tenant,
**21 decisions have expired unanswered vs 13 ever decided.** A governance loop whose expiry rate
exceeds its service rate does not govern — it discards.

Composition of the 404: escalation 186 · action_approval 91 · inquiry_review 58 · checklist 48 ·
trust_demotion_notice 10 · knowledge_revision 8.

## 3. Why it is self-sealing — the trust ladder has never opened

* **127 of 127 employees are `supervised`.** Not one has ever been promoted.
* `de_autonomy` holds 25 rows, 21 enabled — the dials exist and are configured.
* **11 trust-promotion requests are pending**, queued behind the same jam.
* One promotion was approved (2026-07-05) but was action-scoped (`de_id` NULL, "invoice auto send
  to level 1"), not an employee promotion. *No claim is made here that it failed to apply — it was
  never a DE-level promotion.*

The product's thesis is a *governed* workforce: a human sets the boundary, the workforce operates
inside it. What is running instead is a *supervised* workforce: a human approves every act. Those
are different products, and only the first one scales past one operator.

## 4. Gap register

| # | Gap | Size (measured) | Tag |
|---|---|---|---|
| G-1 | Decisions expire faster than they are made | 21 expired vs 13 decided (live tenant) | **BLOCKS PILOT** |
| G-2 | No objective has ever been completed | 0 of 48 achieved | **BLOCKS PILOT** |
| G-3 | Trust ladder unreached — relief valve never opened | 127/127 supervised; 11 requests pending | **BLOCKS SCALE** |
| G-4 | Blocked goals cannot unblock (B-11) | 245 cron failures/7d since 08-05 | **BLOCKS PILOT** |
| G-5 | Failures reach no human (C-8) | 133 alerts unresolved, 77 firing 20 days | **BLOCKS PILOT** |
| G-6 | Only 2 real external integrations | ERPNext (dev) + Stripe-MCP, HQ only | BLOCKS SCALE |
| G-7 | Email channel dark (D-9) | 0 conversations ever; secret unset | BLOCKS SCALE |
| G-8 | Voice built, zero traffic | 0 rows ever, 3 edge fns | Cosmetic until wedge proven |
| G-9 | Work items 72% unfinished | 163 open vs 63 done | BLOCKS SCALE |

## 5. What this means for the wedge

docs/24 locks the wedge as **order-to-cash + support, governed**. Support is proven end-to-end
(Workstream B). Order-to-cash has machinery proven once but **5 invoices ever**. The governed half
— the part no chatbot competitor can claim — is precisely the half that is jammed.

**The pilot-blocking question is not "does it work?" It is "who answers 66 decisions a week?"**
Three honest routes, in the order I would take them:

1. **Raise the service rate** — batch/bulk decision UI, digest-driven, so one operator can clear
   dozens in minutes rather than one at a time. Cheapest, no trust change required.
2. **Lower the arrival rate** — open the trust ladder for the narrowest, highest-volume,
   lowest-risk action class first (the 186 escalations are the target), so routine acts stop
   asking. This is the mechanism already built and never used.
3. **Stop raising decisions nobody will answer** — anything that expires unanswered should either
   auto-resolve on a stated policy or never have been raised. 21 expiries is the system telling
   you which those are.

Route 2 is the product thesis. Route 1 is what makes route 2 safe to attempt.
