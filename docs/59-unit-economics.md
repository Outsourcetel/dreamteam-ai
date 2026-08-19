# 59 — Workstream L: unit economics (2026-08-18)

Workstream G established the shape — *"tokens are not the cost of goods; human review is."* This
puts real numbers on both sides, using the system's **own** review-time model rather than an
assumption, and states which cost line kills the margin first.

Scope note: measured on **outsourcetel-hq**, the only tenant doing real work. It accounts for
**$11.58 of the platform's $12.01** 30-day AI spend — 96%. Every other tenant is pennies.

## 1. The two cost lines, measured

### AI — trivially cheap

| Measure (outsourcetel-hq, 30 days) | Value |
|---|---|
| AI spend | **$11.58** |
| Model calls | 2,139 |
| Conversations handled | 160 |
| Messages | 330 |
| Human decisions raised | 120 |
| **AI cost per conversation** | **$0.072** |
| **AI cost per decision raised** | **$0.096** |

### Human review — the actual cost of goods

The platform ships a review-time standard per task type (`review_time_standards`, all defaults,
founder-tunable via mig 698): escalation **4 min** · inquiry_review **4** · review_gate **3** ·
override **3** · trust_promotion **3** · training_feedback **3** · approval_gate **2** ·
action_approval **2** · checklist **2** · trust_demotion_notice **2** · knowledge_revision **8**.

Applying those minutes to real rows:

| Measure (outsourcetel-hq) | Value |
|---|---|
| Review minutes arriving | **120 min/week ≈ 8.7 h/month** |
| Pending backlog, unworked | 86 tasks = **5.8 hours** |
| Average per decision | 4.1 minutes |

### The ratio that matters

| Loaded labour rate | Human review / month | AI / month | Human as multiple of AI |
|---|---|---|---|
| $25/h | $217 | $11.58 | **19×** |
| $50/h | $435 | $11.58 | **38×** |
| $75/h | $652 | $11.58 | **56×** |

**Human review is 19–56× the AI cost.** Any pricing, packaging or optimisation conversation that
starts with tokens is optimising 2–5% of the cost base.

## 2. Cost per unit of *finished* work — undefined, and that is the finding

The natural denominator is a completed objective. There have been **none** (docs/55). The honest
per-unit figures are therefore *cost per decision raised* ($0.096 AI + ~$3.38 human at $50/h) and
*cost per conversation* ($0.072 AI + review time if it escalates).

**Cost per completed outcome cannot be computed, because the system has not completed one.** That
is not a measurement gap — it is the same completion gap, arriving in the P&L.

## 3. Margin sensitivity — which line kills it first

Take a plausible SMB price of **$500/tenant/month**:

| Scenario | Review hours/mo | Human cost @$50/h | AI | Gross margin |
|---|---|---|---|---|
| Today's volume | 8.7 | $435 | $12 | **11%** |
| Trust ladder opens on escalations (−60% review) | 3.5 | $174 | $12 | **63%** |
| 3× customer volume, no autonomy | 26 | $1,300 | $35 | **−167%** |
| 3× volume with autonomy | 10.4 | $520 | $35 | **−11%** |

Three conclusions fall straight out:

1. **AI spend never threatens the margin.** Even at 10× volume it is under $120/month.
2. **Review hours are the entire margin question.** At today's ratio the business is roughly
   break-even at $500/month per tenant, and **goes underwater as the customer succeeds** — the
   more work the workforce does, the more decisions arrive.
3. **The trust ladder is not a feature — it is the margin.** Moving the 186 escalations (4 min
   each, the single largest line) to earned autonomy is the difference between 11% and 63%.

This is the same finding as docs/55 G-3 and docs/57 item 4, now denominated in money: **the
unopened trust ladder is the P&L.**

## 4. Controls that are genuinely working

| Control | State | Evidence |
|---|---|---|
| Token metering | 🟢 complete | 2,158 calls, 5.5M tokens, **zero unpriced models** |
| Per-tenant attribution | 🟢 working | spend resolves per tenant; HQ isolated at 96% |
| **AI budget enforcement** | 🟢 **armed and honoured** | all **18/18** tenants carry a `monthly_token_budget > 0`; callers return early on `allowed === false` (e.g. `guardrailAdjudicator.ts:209`), they do not merely log it |
| Budget alerting | 🟡 fires, reaches nobody | raises `ai_budget_approaching` at 80% into the channel C-8 shows nobody reads |
| Review-time model | 🟢 exists, founder-tunable | 11 task types with defaults |

The "who pays" plumbing that memory records as *never having worked* now works: spend is metered,
attributed, ceilinged and enforced. That is a real recovery and should be counted as one.

## 5. What this means for pricing

* **Never price per message or per token.** It bills 2–5% of the cost base and caps upside on the
  cheap input.
* **Price per seat or per outcome**, and treat *review minutes saved* as the value story — that is
  literally what the customer is buying and what the system already measures.
* **A pilot at any sane price is profitable at today's volume** — but only because the volume is
  tiny. Do not read today's 11% margin as a business; read it as a warning that margin arrives
  only with autonomy.
* Budget ceilings are already enforced per tenant, so a runaway-cost incident is bounded. That is
  a genuine thing to say in a security or procurement review.

## 6. Verdict

**Unit economics are not a risk to the pilot; they are a risk to the second year.** Nothing here
changes the go/no-go. It sharpens the ranking: opening the trust ladder was already the top
product item, and it is now also the top *financial* item, worth roughly **50 points of gross
margin** at a $500 price.
