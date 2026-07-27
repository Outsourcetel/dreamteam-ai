# 36 — The eval gate is blocking on a coin flip

**Status:** ✅ DECIDED (option 1) and SHIPPED 2026-07-28 — `eval-run` deployed
**Date:** 2026-07-28
**Decision was:** whether to change what makes the eval gate go red

---

## The short version

The eval gate stops knowledge from being published when the last test run
failed.

**It has never been green. Not once.** Ten runs have finished in this workspace
and every single one is recorded as failed.

It is not red because something is broken. It is red because the test suite
gives a different answer each time it runs, and a run only counts as green if
all sixteen questions land well on the same attempt.

**No question in the suite has ever failed twice in a row.** Every single
failure in its recorded history — including the two I was asked to fix and the
three that appeared in tonight's re-run — has also *passed* on another run,
with nothing changed in between.

---

## The evidence

Every finished run in the outsourcetel-hq workspace, counting only questions
that were genuinely graded:

| | |
|---|---|
| Questions in the suite | 18 |
| Questions that have flipped pass ↔ fail | **4** |
| Questions that always passed | 14 |
| **Questions that always failed** | **0** |

The four that flip, and how often each has passed:

| Question | Passed | Failed |
|---|---:|---:|
| Can a Digital Employee take actions in my systems? | 2 | 2 |
| How do I connect my helpdesk or CRM to DreamTeam? | 6 | 1 |
| How do human approval gates work inside playbooks? | 5 | 1 |
| How do I control which DE can access which system? | 5 | 1 |

Three of those four pass roughly 85% of the time. The gate has been holding
publishing shut on the strength of questions that are usually fine.

Tracked run by run, the two I was asked to "fix":

```
access control    PASS  FAIL  PASS  PASS  FAIL  PASS
actions           FAIL  FAIL  PASS  PASS  FAIL  FAIL
```

The second one passed twice in the middle with no edit from anyone.

**On the observed rates, roughly 30% of runs would come back green** — so about
two runs in three block publishing regardless of whether anything is actually
wrong. (Rough estimate: small sample, and it assumes the questions fail
independently. Treat it as an order of magnitude, not a precise figure.)

---

## Why it happens

One line in `supabase/functions/eval-run/index.ts`:

```js
const pass = verdict === 'pass';
```

The judge returns one of three verdicts: `pass`, `partial`, or `fail`. This
line treats `partial` exactly like `fail`.

And `partial` is where all the variance lives. Every `partial` in the record is
a *completeness* complaint about an answer that was correct and well-grounded —
tonight's three were at 95%, 97% and 85% confidence, and the judge's objection
in each case was that the answer did not mention everything, not that it said
anything wrong.

Whether a good answer mentions every listed point varies between runs, because
the employee re-writes its answer each time and the judge re-reads it each time.

**In the entire history of the suite there has been exactly one hard `fail`:**

> 2026-07-25 — *"How do I control which Digital Employee can access which
> system?"* — the employee refused to answer, claiming the question was
> outside its guardrails.

That was a real defect (a guardrail misfiring on an ordinary product question),
the gate caught it correctly, and it has since been fixed. That question has
passed five times since.

So the gate's teeth have fired once, on a real problem. Every other time it has
blocked publishing, it was on a borderline judgement that would probably have
gone the other way on a re-run.

---

## What it costs

This connects to the publishing deadlock in the same workspace:

- A digital employee proposes a fix to its own knowledge after a bad answer
- A human approves it
- The gate is red, so the fix cannot publish
- The fix that would have improved the answers never lands
- The next run is another coin flip

The first self-improvement ever approved in this workspace hit exactly this
and published nothing. The human saw "Approved" and no article appeared.

---

## A separate defect, worth fixing whatever you decide

An outage is currently recorded as a quality failure.

Run `bb6c46ab` on 25 July shows 13 of 24 questions "failed". Nothing was wrong
with the answers — the AI budget ran out partway through, and every unanswered
question was recorded as a failure. The run is stored with status `failed`,
indistinguishable from a run where thirteen answers were genuinely bad.

Had that been the most recent run, it would have held publishing shut across
the workspace because of a spending limit.

The same applies to judge outages (`HTTP 502`).

**⚠ Correction — this is already fixed, and I proposed fixing it twice over.**
On reading the current code to implement the change, `eval-run` already treats
`ai_budget_exceeded`, `rate_limited`, `429` and any `5xx` as infrastructure and
records the run as `blocked_llm`, which the gate does not treat as failed. That
handling postdates `bb6c46ab`, which is why the historical run still carries
`failed`. So the defect is real in the DATA but not in the CODE, and no change
was needed. The stale row remains a trap for anyone using run history as a
baseline — `bb6c46ab` must be excluded from any comparison.

*(This refinement, and the chosen option below, came from the audit-stream
session. The refinement turned out to be already implemented; the option was
better than my original recommendation and replaced it.)*

---

## Options

**1. Gate on hard `fail` immediately; gate on `partial` only when the same
question is `partial` in two consecutive runs.** *(recommended)*
A real defect still closes the gate on the first run. A completeness gap still
closes it — but only once it proves it is real by recurring on the same
question. Random variance rarely survives two draws; a genuine gap survives
every time. This keeps completeness pressure without the coin flip.
*Trade-off:* a real completeness gap takes two runs to gate.

**2. Gate on `fail`; show `partial` as a warning only.**
Simpler. The gate keeps the ability that has actually worked — catching a hard
failure — and completeness gaps stay visible in the Proving Ground without ever
blocking.
*Trade-off:* an answer that is correct but thin never blocks publishing at all.

**3. Change nothing; keep fixing individual questions.**
*Trade-off:* this is what the last two attempts did. Because nothing fails
consistently, there is no stable target — fixing the questions that failed last
time does not stop different ones failing next time. The gate stays a coin flip
and the deadlock stays in place.

---

## What I am not claiming

- **I am not saying the answers are perfect.** The completeness gaps the judge
  points at are real. They are worth fixing as knowledge work. They are just
  not a sound basis for blocking publishing, because they come and go.
- **This makes a safety control less strict.** That is a genuine trade-off and
  it is the founder's call, not mine. I raised the same caution against
  exempting self-improvement articles from the gate, and declined to do it on
  replay evidence alone. The difference here is that the strictness is
  measurably not catching anything: nothing has failed twice.
- **The sample is small** — a handful of runs over five days.
- **I corrected myself once already on this data.** My first count said half the
  suite was flaky. That was wrong: it counted infrastructure failures
  (`ai_budget_exceeded`, judge `HTTP 502`, one entire run lost to budget
  exhaustion) as quality failures. Excluding those brings it to 4 of 18. The
  figures above are the corrected ones.

---

## What shipped

Option 1, in `supabase/functions/eval-run/index.ts` — no migration.

- The judge's verdict is now stored as a **field** on each result, not left to
  be parsed back out of the reason text. The next run reads it to decide
  whether a partial is a repeat.
- A hard `fail` gates on sight. A `partial` gates only when the same question
  was partial in the previous finished run.
- `passed` / `failed` keep their old meaning — answer quality — because
  `certify_de_from_eval` scores certifications from `eval_runs.total/passed`.
  Changing them would have silently re-graded every certification. Only
  `eval_runs.status` moves, so certification behaviour is untouched.
- Infrastructure results carry no verdict, so an outage can never make the
  following run's partial look like a repeat.

### Verified before shipping, against every recorded run

The condition I set was that the one real defect in the suite's history must
still turn the gate red. Simulating the new rule over all nine graded runs:

| Run | Hard fails | Partials | New gate |
|---|---:|---:|---|
| 07-20 04:38 → 07-25 00:55 (7 runs) | 0 | 0 | GREEN |
| **07-25 02:07** | **1** | 1 | **RED** ← the real defect still gates |
| 07-27 22:35 | 0 | 3 | RED |

Seven runs that were red on outages and one-off partials would now be green.
The guardrail refusal still closes the gate on its first appearance.

### ⚠ Correction — the simulation and the code disagree on the first run

The table above was produced in SQL by parsing the `judge verdict "partial"`
marker out of each result's reason text. **The shipped code does not do that.**
It reads the new `verdict` field, which no historical result has, because this
change is what introduced it.

So on the FIRST run after deploy, every partial looks like a first occurrence
and none of them gate. The row reading "07-27 → RED on a repeated partial" is
what the rule will do *once two runs have stored verdicts* — it is not what
happens on the next run.

What survives unchanged: **a hard `fail` still gates on its first appearance**,
which was the condition set for shipping. What does not survive: the claim that
the persistence rule is active immediately. It is one run late, and
self-correcting from the first new-format run.

Caught by the audit-stream session from a different angle, without seeing this
code. Two fixes are possible — parse the marker as a one-time bootstrap, or
accept the one-run delay. Being tracked there alongside the `eval_gate` view
change.

### One more hole, not closed by this change

`eval_gate` is `DISTINCT ON (tenant_id) … WHERE finished_at IS NOT NULL ORDER BY
finished_at DESC` — so a finished *halted* run becomes the tenant's gate row.
It will not block publishing (the trigger tests `= 'failed'`), but it
**overwrites a real failure**: a genuine red followed by an outage silently
opens the gate. Being fixed separately by filtering the view to quality
statuses.
