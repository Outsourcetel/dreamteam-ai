# 46 — Census: what is alive, what is starved, what is dead

**Method: the database decides, not taste.** Three independent evidence
sources — `pg_stat_user_tables` (lifetime writes and reads), `cron.job_run_details`
(7 days of scheduled execution), and reference-counting across app code *and*
SQL functions, views and foreign keys. Nothing here is an opinion about whether
code "looks used".

Baseline `review-baseline-20260809` @ `bc86388`: 284 tables · 881 routines ·
387 policies · 49 cron jobs · 16 tenants · 117 DEs · 201 MB.

---

## The headline: I was wrong about the deletion opportunity

I predicted 30–40% of the surface was deletable. **The data says ~1%.**

Of 284 tables, 35 are empty and have never been written. Of those 35, only
**three** are genuinely unreferenced by anything — app code, SQL functions,
views, or foreign keys:

| Table | Evidence |
|---|---|
| `de_channels` | 0 app refs · 0 fn refs · 0 views · 0 FKs in · 0 rows ever |
| `knowledge_tags` | same |
| `voice_appointments` | same |

Everything else that looks dead is **wired and starved** — read constantly by
live code, waiting for data that never arrives. `eval_batch_jobs` has zero rows
and **5,365 reads**. `knowledge_chunks` has zero rows and **2,071 reads** (it is
a superseded twin of `knowledge_doc_chunks`, which holds 5,035 real chunks —
grounding is healthy; the empty twin is a rename that never finished).

**This changes the review's conclusion.** The problem is not a bloated codebase
carrying dead weight. It is a *complete* system with almost nothing flowing
through it. Deleting code would not have helped; I would have spent the window
on the wrong thing.

---

## The bottleneck, located precisely

| Queue | Depth |
|---|---|
| `de_work_items` pending | **0** |
| `human_tasks` pending | **374** |
| `knowledge_conflict_probe_queue` | 291 |
| `eval_batch_jobs` | 0 |

The machine side is **idle**. The human side is **374 deep**. Combined with the
30-day figures — 641 items created, 22 decided, 151 escalated vs 149 resolved —
the completion gap is not a capacity problem in the employees. **It is human
decision throughput.** Every architectural instinct to make the DEs *do more*
would widen the gap, not close it.

That is the single most useful thing this census produced, and it is measured,
not argued.

---

## Cron: 42,951 runs in 7 days, zero failures, mostly polling nothing

Every scheduled job succeeds and nearly all finish in under a quarter-second, so
this is not an outage or a cost crisis. It is a signal:

| Job | Runs/7d | Polls |
|---|---|---|
| `eval-run-driver` | 5,067 | a table with **zero rows, ever** |
| `knowledge-ingest-drain` | 5,040 | 2 items |
| `knowledge-reembed-drain` | 2,534 | — |
| `embed-backfill-drain` | 2,325 | — |
| 10 further `*/5` jobs | 2,016 each | — |

~20,000 invocations a week against empty queues. The fix is not deletion — these
jobs are correct and will matter the moment data flows. The fix is **backoff**:
a drain that finds nothing three times running should widen its interval until
something arrives. Deferred to a decision memo; it is Ring 3, not Ring 0.

`de-incident-sweep-5min` averages **3.03 s**, ~60× its peers. Worth one look.

---

## Quadrants

**DELETE (3)** — `de_channels`, `knowledge_tags`, `voice_appointments`.
Retire-don't-drop per convention, in one approved batch, under the 618 protocol
(enumerate callers, grep every `ON CONFLICT`, treat every index as an interface).
Total saving: three tables. Honest and small.

**RESOLVE (1)** — `knowledge_chunks` vs `knowledge_doc_chunks`: an unfinished
rename leaving an empty twin that live code still reads. Finish or remove it;
an empty table that something queries is a silent-wrong-answer waiting to
happen.

**FIX (2)** — cron backoff on empty queues; `de-incident-sweep` duration.

**KEEP (everything else)** — including all 32 "empty but referenced" tables.
They are not debt. They are the product, unfed.

---

## What this means for the review

The remaining engineering risk is **not** surface area. It is:

1. **Ring-0 correctness** — already paying: six cross-tenant write holes found
   and closed on day one (mig 636, docs/45).
2. **The human decision bottleneck** — 374 pending, 22 decided/30d. No amount of
   code quality moves this number.
3. **Nothing proven against reality** — six adapters, zero live connections; the
   approve-clean rate unmeasurable because its capture table was never populated.

Deletion was the wrong hypothesis. Certification and *flow* are the right ones.
