# 69 — Workstream T: customer evidence & voice of the user (2026-08-18)

The only real users are inside Outsourcetel, and that is still evidence. This workstream reads
**behaviour** — what gets used, what gets ignored, what gets worked around — and then hands over a
short instrument for the questions only people can answer.

## 1. The headline: the human is selective, not slow

| Decision type | Raised | Answered | Expired | Pending | **Avg time to answer** |
|---|---|---|---|---|---|
| escalation | 221 | 12 (5%) | **21** | 188 | **3 hours** |
| action_approval | 111 | 14 (13%) | 6 | 91 | **2 hours** |
| **inquiry_review** | **58** | **0 (0%)** | 0 | 58 | **never** |
| checklist | 49 | 1 | 0 | 48 | 0 h |
| trust_demotion_notice | 11 | 1 | 0 | 10 | 16 h |
| knowledge_revision | 9 | 1 | 0 | 8 | 16 h |
| review_gate | 4 | **2 (50%)** | 0 | 2 | 0 h |
| trust_promotion | 3 | **2 (67%)** | 0 | 1 | 0 h |

Docs/55 measured the queue and concluded the human was the bottleneck. This refines that
materially: **when the founder engages, they answer in 2–3 hours.** The problem is not latency,
it is **selection**.

And the selection has a clear shape:

* **Governance decisions get the highest engagement** — trust promotion **67%**, review gates
  **50%**, answered within the hour.
* **Routine customer work gets the lowest** — escalations **5%**, and 21 of those expired.
* **`inquiry_review` has never once been answered.** 58 raised, zero touched, none expired — it
  simply sits. A category with a 0% engagement rate over six weeks is the product asking a
  question nobody wants to be asked.

**The behavioural verdict:** the founder behaves like an owner who wants to make *policy* calls and
not *per-item* calls. That is exactly the profile the trust ladder was designed to serve — and
docs/59 already priced it at roughly 50 points of gross margin.

## 2. The drafts are accepted as written

| Measure | Value |
|---|---|
| Decisions made (approved or rejected) | 33 |
| **Approved with edits** | **0** |
| **Decisions carrying a reason code** | **0** |

Not one draft has ever been corrected before sending. Read alongside docs/58 — the workhorse
employee passes evaluation **91%** of the time — the consistent explanation is that the drafts are
simply good enough to send.

The learning loop is not starved either: `de_experience` 180 rows, `de_improvements` 17,
`de_learning_edits` 3, behaviour clusters 3. Learning happens; it just is not being fed by human
corrections, because there are none.

**But zero reason codes is a real gap with a consequence.** The trust ladder promotes an employee
on recorded evidence of good judgement. Thirty-three approvals were granted and **not one recorded
why**. The ladder is shut (docs/55 G-3), and part of what would open it is the rationale nobody is
capturing. That is a correlation worth naming, not yet a proven cause.

## 3. Features used once and abandoned

From the activity stream:

| Signal | Count | First | Last |
|---|---|---|---|
| escalated | 174 | 07-06 | **08-18 (today)** |
| resolved | 152 | 07-04 | **08-07 (11 days ago)** |
| approval | 15 | 07-11 | 08-11 |
| config_change | 12 | 07-07 | 08-11 |
| certification_stale | 6 | 07-22 | 08-06 |
| handoff_returned | 2 | 08-11 | 08-11 (same day) |
| **quality_drift** | **1** | 07-24 | 07-24 (once, ever) |

**`escalated` still fires today; `resolved` stopped eleven days ago.** The completion gap
(docs/55) is visible in the activity stream itself: the system keeps raising work and stopped
finishing it — which is consistent with B-11, the reconcile job that died on 2026-08-05.

`quality_drift` fired exactly once in six weeks, and `handoff_returned` twice on a single day.
Those are features that have effectively never entered the workflow.

## 4. Where the human works *around* the product

The most honest gap analysis is what people do by hand instead. Two are visible in data:

1. **Support resolution.** 152 `resolved` events, none in 11 days, while escalations continue —
   customer conversations are being ended somewhere other than through the loop, or not at all.
2. **The email channel.** Zero conversations ever (docs/50, D-9). Whatever mid-market support
   correspondence happens at Outsourcetel is happening entirely outside the product.

A third is inferable but **not** yet evidenced: 188 pending escalations with a 3-hour response
time on the 12 that were answered suggests the other 188 were either handled another way or did
not need handling. **Only a person can say which**, which is exactly what §5 is for.

## 5. The questions only your people can answer

Behaviour shows *what* happened, never *why*. These eight questions close that gap. They are
written to be delivered **by the founder, not by the system** — a workforce product surveying its
own users about whether they trust it will get polite answers.

Suggested framing: *"I'm reviewing what we've built. Please be blunt — 'I ignore it' is the most
useful answer you can give me."*

**On the decision queue**
1. When a decision appears in the queue, what makes you answer it now versus leave it? Be concrete
   about the last one you skipped.
2. There are 58 "inquiry review" tasks and none has ever been answered. What are they, and what
   would make them worth opening — or should they stop being raised?

**On trust**
3. Which employee's work would you let go out **without** reading it first? If none, what would
   have to be true?
4. You have approved 33 drafts and edited none. Is that because they were right, or because
   editing is more effort than it is worth?

**On workarounds**
5. What do you still do by hand that this product was supposed to do for you?
6. When a customer emails support today, what actually happens? Walk me through the last one.

**On value**
7. If this product disappeared tomorrow, what is the first thing you would miss — and the first
   thing you would not notice?
8. What have you stopped using, and when did you stop?

## 6. Verdict

**The behavioural evidence contradicts the simplest reading of the bottleneck.** The founder is
not overwhelmed and slow — they are fast and selective, engaging with governance and declining
routine. That reframes the top recommendation of this entire review: the trust ladder is not
merely a margin lever (docs/59) or a scaling lever (docs/55), it is **the feature that matches how
the only real user already behaves**.

Two things this workstream cannot settle, by design: whether the 188 unanswered escalations
represent lost value or correctly-ignored noise, and what work is still being done by hand. §5
exists because those answers are worth more than any query I can run.
