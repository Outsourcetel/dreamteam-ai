# 58 — Workstream I: AI quality & judgment (2026-08-18)

The synthesis (doc 57 §7) ranked this the highest-risk unexamined workstream: *"if answer quality
is poor, the demo's 95%-confidence moment is hollow."* It is not hollow. But the number means
something different from what it says.

All figures below come from `eval_judgments`, which grades **production** answers (`source=online`)
separately from exam traffic (`source=simulation`) — the separation mig 706 enforces, still
holding: online judgments run to today, simulation stopped 08-03.

## 1. Answer quality — genuinely good

**Production (`online`), 142 graded answers:**

| Verdict | Count | Share | Avg score |
|---|---|---|---|
| pass | 118 | **83%** | 90.2 |
| partial | 12 | 8% | 61.5 |
| fail | 12 | 8% | 26.8 |

Exam traffic scores *lower* (70% pass) than production — the exams are harder than real questions,
which is the right way round.

### Per employee (production only, n ≥ 3)

| Employee | Graded | Pass rate | Avg score |
|---|---|---|---|
| Marketing | 4 | 100% | 94.3 |
| OnTrac Demo Support | 5 | 100% | 89.8 |
| **Technical Support** | **86** | **91%** | **85.9** |
| Account Success DE | 8 | 88% | 80.1 |
| Workspace Assistant | 14 | 71% | 77.5 |
| Onboarding Architect | 3 | 67% | 71.0 |
| Great Expressions Demo | 3 | 67% | 73.7 |
| Sonic Demo Support | 3 | 0% | 58.3 |
| **Billing Support** | **4** | **0%** | **23.0** |

**Technical Support is the workhorse** — 86 of the 142 graded answers, passing 91%. That is the
employee doing real work, and it is good. The weak entries are small samples on idle or demo
employees; **Billing Support at 0/4 and an average score of 23 is the one worth opening**, small
sample notwithstanding, because 23 is not a near-miss.

## 2. Confidence calibration — the real finding (register **C-9**)

Joining each graded answer to the confidence the employee stated at the time:

| Stated confidence | Answers | Actually passed | Gap |
|---|---|---|---|
| 90–100 (avg **95**) | 52 | **81%** | **−14 pts** |
| 75–89 | 2 | 100% | — |
| 50–74 | 1 | 100% | — |
| under 50 (avg 13) | 7 | **14%** | — |

Two things are true at once:

* **The safety property holds.** When the employee reports low confidence it is right only 14% of
  the time — it genuinely knows when it does not know, which is exactly what the escalation path
  depends on. That is the half that protects customers.
* **The top of the range is overconfident.** "95% confident" corresponds to roughly **81% likely
  to be correct**. Not catastrophic, but a real 14-point gap.

There is a third, structural observation: **the scale is effectively bimodal.** 52 answers sit at
90–100 and 7 sit below 50; only **3** land anywhere in between. What is presented as a probability
behaves like a binary flag — *confident* or *escalating* — with almost no middle.

**Claim discipline (updates doc 56 §2):** showing a confidence figure in a demo is fine. Saying or
implying it is an accuracy rate is not. The honest sentence is *"the employee reports how sure it
is, and when it is unsure it escalates rather than guessing"* — which is true, provable, and the
part that actually matters.

## 3. Guardrails — real, loaded, and never once fired (register **C-10**)

| Signal | Value |
|---|---|
| Assistant messages ever sent | 455 |
| Messages with `delivery='blocked'` | **0** |
| `guardrail_adjudications` rows | 2 |
| `guardrail_rules` created in 30 days | 166 |
| Patterns compared by certify's differential | 155 (32 client / 54 database, 22 disagreements, all on the safe side) |

The rules exist and are loaded — this is not dead code, and certify actively diffs client
behaviour against the database's. But **no production message has ever been blocked**, so both
error rates are unmeasurable: false-block is trivially zero, false-allow is *unknown*.

This is the "wired and starved" pattern again, on the seam the product sells hardest. The fix is
not more rules — it is one deliberate red-team pass that fires the layer on purpose and records
what it catches and what it misses.

## 4. The grounded-confidence shadow experiment is mostly synthetic

`grounded_confidence_shadow_log`: 95 rows, self-confidence 91.7 avg vs grounded 93.7 avg. But
**87 of 95 rows are `is_synthetic`** — only 8 carry real production signal, and 88 of 95 would
have escalated. Treat its conclusions as a design rehearsal, not evidence.

## 5. Quality scorecard

| Dimension | Verdict | Basis |
|---|---|---|
| Production answer quality | 🟢 **good** | 83% pass, 90 avg when passing; workhorse at 91% |
| Knows when it does not know | 🟢 **holds** | low-confidence answers pass only 14% — escalation is warranted |
| Exam / production separation | 🟢 holds | graded separately; exams harder than reality |
| Confidence as a probability | 🟡 **overconfident + bimodal** | 95 stated → 81 actual; only 3 answers between the extremes |
| Weakest employee | 🟡 Billing Support | 0/4, avg 23 — small sample, large deficit |
| Guardrail precision | ⚪ **unmeasurable** | never fired in production |
| Grounded-confidence evidence | ⚪ rehearsal only | 92% synthetic |

## 6. What this changes

**It does not change the go/no-go.** Answer quality was the risk most likely to hollow out the
demo, and it did not: the product answers real questions well and escalates when it should.

**It does change one sentence of the pitch.** Confidence is a routing signal, not an accuracy
guarantee, and the review's claim-discipline table should say so before anyone repeats "95%" to a
prospect.

**It adds one job to the 30-day list:** a deliberate guardrail red-team. Everything else in this
workstream is either healthy or small enough to schedule.
