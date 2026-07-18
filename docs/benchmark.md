# The DreamTeam Benchmark — honest numbers, recountable by anyone

*Added 2026-07-18 (Frontier-20 #11).*

## Why this exists

The 2026 AI-agent market has a credibility problem: vendors publish
resolution rates measured over cherry-picked traffic ("67% resolution"
claims that independent evaluation puts at 42–50%). DreamTeam makes the
opposite bet: **every benchmark number is computed over ALL traffic in
the window, from raw production rows a tenant admin can recount, and the
metric definitions ship inside the report payload itself.**

## The report

`get_benchmark_report(tenant_id, de_id?, days?)` (migration 176) returns
one JSON document per workforce or per employee:

| Metric | Definition (verbatim from the payload) |
|---|---|
| **Resolution rate** | Auto-sent, guardrail-clean answers as a share of **all** metered outcomes in the window — every escalation, human hand-off, and guardrail block counts in the denominator. Nothing is excluded. |
| **Judged quality** | Share of graded answers an independent LLM judge scored as passing on grounding, correctness, guardrail adherence, and tone (migration 167). |
| **CSAT** | Average of ratings customers actually submitted. Never inferred or imputed. |
| **Cost per resolution** | Real model spend in the window divided by resolutions delivered. |
| **Capability** | Latest certification-grade simulation result. Dry-run (candidate) simulations are excluded — exactly as they are excluded from certification. |

## What makes it trustworthy

1. **All-traffic denominators.** The resolution rate cannot be inflated
   by dropping hard conversations: escalations and guardrail blocks are
   metered into `billable_outcomes` by the same code path that meters
   resolutions (migration 175), and the rate divides by both.
2. **Idempotent metering.** One resolution and one escalation maximum
   per conversation, enforced by unique indexes — replays and retries
   cannot inflate counts.
3. **Semantic grading, not keyword matching.** Judged quality comes from
   the LLM-judge spine (migration 167), which passes paraphrases and
   fails confidently-wrong answers — proven live both directions.
4. **Recountable.** Every headline number is a one-line SQL aggregate
   over tables the tenant can read under RLS. No proprietary black-box
   scoring.
5. **Definitions travel with the data.** The payload's `definitions`
   object states what each number means, so a report screenshot can't
   quietly outrun what was measured.

## What it is not

- Not a marketing simulator: if a workforce had a bad month, the report
  says so.
- Not an industry leaderboard: numbers are per-tenant, about *your*
  traffic. Cross-vendor comparison requires matching definitions — which
  is exactly why the definitions are embedded.
- CSAT with small sample sizes is noise; the report includes the count so
  readers can judge significance themselves.
