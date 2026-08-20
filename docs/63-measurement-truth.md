# 63 — Workstream M: measurement truth (2026-08-18)

**This does not repeat docs/51.** That audit censused 32 measurement organs six days ago
(23 honest · 6 lies · 2 measure-the-exam · 1 unread) and its top five fixes shipped as migs
706–709 and 720. M's job here is narrower and complementary: **verify its headline claims still
hold**, then cover the ground it did not — **data integrity**, and the numbers a human actually
reads before deciding something.

## 1. Verified — the exam/production split works

61% of all conversations are exam traffic. The split holds:

| Channel | Conversations |
|---|---|
| **exam** | **282** |
| dock | 164 |
| hosted | 15 |
| widget | 1 |

The support surface (`widget · hosted · portal · email · dock`) shows **180** — the 282 exam
conversations are excluded, exactly as mig 671 intends. This was the contamination that once put
exam traffic into production support metrics; **it is fixed and stays fixed.**

## 2. Verified — referential integrity is clean

| Check | Result |
|---|---|
| Conversations with no surviving tenant | **0** |
| Human tasks with no surviving tenant | **0** |
| Employees with no surviving tenant | **0** |
| Knowledge docs with no surviving tenant | **0** |
| Profiles with `tenant_id` NULL | **3** — 2 are `platform_super_admin` (legitimate: platform staff belong to no tenant), **1 is a `tenant_owner`** |

That last one is register **A-5**, still open: an owner belonging to no workspace. It is one row,
and it is the residue of an `ON DELETE SET NULL` that mints tenantless owners rather than refusing.

## 3. NEW — the volume counter reads zero for the only employee doing work (register **C-11**)

`get_de_performance_summary` is the per-employee summary a human reads to judge how an employee is
doing. For **Technical Support** on outsourcetel-hq:

```
reported: responses_this_month = 0 · avg_csat = null
          escalation_rate = null · resolution_rate = null · roi_hours_saved = null
actual:   159 conversations in 30 days · 111 eval judgments · 91% pass rate
```

**Denominator stated, per counting discipline:** 6 active HQ employees compared. Five genuinely
have zero conversations and are reported correctly as zero. So the counter is wrong on **1 of the
1 rows capable of testing it** — and it is the row that matters. A metric that is trivially
correct on every idle employee and wrong on the only busy one is the worst possible shape: it
looks 5/6 healthy.

One genuine improvement since docs/51: `roi_hours_saved` now returns **null** instead of a
fabricated figure. Returning nothing is the honest answer when you know nothing. The volume line
beneath it did not get the same treatment.

## 4. The register — trust this number, don't trust that one

For anything a human might make a decision from:

### 🟢 Trust these

| Number | Why it is trustworthy |
|---|---|
| Support queue counts & topic split | reads production channels only; exam excluded (§1) |
| Audit trail (44,943 events) | chain cryptographically verified by `certify` |
| AI spend & token metering | 2,158 calls, 5.5M tokens, **zero unpriced models** (docs/59) |
| Per-tenant cost attribution | resolves per tenant; HQ isolated at 96% |
| Human-decision counts (pending/expired/decided) | counted directly from `human_tasks`; B-12 derives from them |
| Backup chain | verified against the Management API, not the dashboard (docs/54) |
| Connector health in the UI | **derived** from failures, never the stale `status` column (docs/61) |
| Answer quality (pass/partial/fail) | `eval_judgments`, production graded separately from exams (docs/58) |

### 🔴 Do not trust these

| Number | Failure |
|---|---|
| **`responses_this_month`** on the employee summary | **0 for an employee with 159 conversations** (C-11) |
| avg_csat / escalation_rate / resolution_rate | all null on the busiest employee |
| **Stated confidence as an accuracy rate** | 95 stated → 81 actual, and effectively bimodal (docs/58, C-9) |
| `connectors.status` column (raw) | reads `connected` on a connector with 6,714 failures (docs/61) — the UI is honest, the column is not |
| golden-path's drift footer | prints production's figures as a **string literal** (F-8) |
| The 6 organs docs/51 named as lying | de-eval-online sampling · assess_de_skills_internal · workforce economics · playbook economics · learning-digest volume — register C-1…C-6 |
| Guardrail effectiveness | unmeasurable: the layer has never fired (docs/58, C-10) |
| Anything implying a completed outcome | 0 of 48 objectives achieved (docs/55) |

## 5. The pattern behind every entry in the red column

Each failure is one of the three traps this project has already written down:

1. **A stored marker read as truth** — `connectors.status`, golden-path's hardcoded footer.
2. **A metric that measures the test** — solved for support (§1), still latent in
   `get_de_economics` per docs/51.
3. **Two paths, one counted** — `responses_this_month` counting a path the traffic no longer
   takes.

None is exotic. They recur because a number, once written, is believed — which is precisely why
the deferred register makes every finding re-derive itself on every `certify` run instead of
sitting in a document.

## 6. Verdict

**Measurement is in better shape than the product's own history would predict.** The contamination
that once poisoned support metrics is genuinely fixed and verified; integrity is clean; the money
numbers are trustworthy; and the biggest single organ repair (roi_hours_saved) chose null over
fiction.

**One live defect worth fixing this week** (C-11 — the employee summary reads zero for the only
employee working), one stale row (A-5), and six known liars already tracked. Nothing here changes
the go/no-go; it changes which dashboard numbers you may quote to a customer.

---

## 7. Close-out verification — 2026-08-20

- **C-11 FIXED and TRUE:** get_de_performance_summary was repaired to count the
  path traffic actually takes (de_messages joined through de_conversations; its
  own comment records the old read named a column that never existed). Verified
  by the truth pair, not the code: summary says **161**, the raw count says
  **161**, exact agreement on the one employee capable of testing it.
- Red-column deltas since 2026-08-18: **F-8 fixed** (golden-path footer now
  measures production live — verified in doc 50); **connectors.status defused
  everywhere it is read** (810 invariant + all five eligibility readers consult
  the breaker — Workstream P close-out, live-verified). The six docs/51 organs
  and C-9/C-10 remain tracked by the self-re-deriving register, which is the
  enforcement mechanism, not this document.
