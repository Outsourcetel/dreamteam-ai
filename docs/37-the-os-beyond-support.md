# 37 — The OS Beyond Support: what the other archetypes reveal

**Date:** 2026-07-28
**Charge (founder, verbatim):** "We have just worked on building and polishing a support
DE and have not considered any other use cases yet — frankly the ones that actually
shape up the whole OS."
**Method:** four live non-support employees walked through all eleven organs of the OS
(hiring → knowledge → work engine → evidence → performance → KPIs → certification →
trust → experience → improvement → approvals), each organ classified FITS /
MISMEASURES / NO-PATH / EMPTY-BY-DESIGN against live data and live function
definitions; plus an exhaustive census of support-shaped assumptions; plus an
adversarial critique that re-verified the twelve worst claims independently — and
caught the walks' own errors, which are folded in below rather than hidden.

**Verdict: the founder's charge is CONFIRMED, and it is worse than "polish bias."**
The OS's organs are not merely support-*first* — several actively **lie** about
non-support employees, and ten organs share a single root cause.

---

## The one sentence that explains most of it

> **In this platform, a unit of work IS an answered inquiry.**

`evidence_runs(inquiry, answer)` — written only by the three answer paths — is the
sole evidence substrate. Performance metrics, skills, KPIs, experience, knowledge-gap
detection, the improvement loop, trust promotion, and the records gate **all read only
it**. Every one of those consumers is *generic* — support-shaped only in what feeds
them. A Renewal DE that worked 25 real work items, fired 6 real watcher matches, and
escalated 4 real blockers has written **zero** evidence rows, because none of that is
an answered inquiry. The OS cannot see governed *work* — only governed *answers*.

## The lie class — what MISMEASURES means, with the worst examples

Empty organs are honest. These are not empty; they are wrong, on live screens today
(all twelve re-verified independently by the critic):

- **Performance**: `get_de_performance_metrics` coalesces missing evidence to **0** —
  the Renewal DE's tab shows **"0% escalation rate"** while 4 real escalations sit
  rejected and 4 items wait on humans. A manager is told the opposite of reality.
  All four walked DEs show the same fabricated zeros (and `success_rate` *defaults to
  100.00*).
- **Trust**: all four non-support DEs render the **same seven cards** — a chat-
  confidence dial for employees that don't chat, plus six platform-admin action cards
  that exist only because the tenant's sole connector is platform_admin. The one
  renewal-native card (invoice auto-send — the only non-answer trust capability in
  the OS) is real and enforced; nothing else about their actual work is dialable.
- **Certification**: every certification ever issued (19/19) is `support_agent`. A
  correction to our own audit record: `golden_qa` *does* have an archetype column now,
  with 4 active renewal questions — but a renewal exam has never once run, the queue
  DEs are `active` only because they predate the certification gate that would block
  them today, and the exam that *would* run scores prose fragments. It certifies
  **talking about** renewals, not doing them.
- **Hiring**: kits declare `required_connector_categories` (CRM for renewal, ERP for
  ledger) — **enforced nowhere**. The Onboarding hire completes with a false
  "ready to work" verdict; the Renewal DE went active with no CRM, and *every zero in
  its walk traces to that single unenforced line* — its four rejected escalations all
  say the same thing: "search returns only platform documentation."
- **Work engine** (FITS, with rot no organ sees): 4 playbook runs stuck at step 0 for
  15 days, objectives that have woken 117 times against items stuck waiting — the
  engine spins and nothing measures spin. And "done" items whose result is a request
  for more input are counted as done.

**The census**: 20+ support-shaped assumptions enumerated with evidence — 5 active
MISMEASURES, 11 NO-PATHs — from the hardcoded `source_category:'support'` stamps in
the answer recorders, to CSAT reachable only from chat, to the knowledge-gap detector
that can only be triggered by a *low-confidence answer* (a wrong invoice can never
open a knowledge gap), to improvement drivers whose only remedy shape is a KB article
(what fraction of a ledger DE's failure modes can an article fix?).

## The fix is six moves, not forty patches

**Move 0 — Stop the lies (days; non-optional under the honesty mandate).** NULL-not-0
in performance where no evidence path exists; kill the 100.00 success default;
label displayed-but-unenforced controls "advisory"; reclassify "done"-but-blocked
items; backfill the missing escalation back-links.

**Move 1 — The work-cycle evidence spine (the keystone).** de-work *already computes*
an achieved/blocked/continue verdict with a note on every objective wake, and already
records deliverables. Write those verdicts — and work-item completions — into the same
evidence spine the answer path uses, with the account/entity ref carried and
`source_category` derived from the archetype (killing the hardcoded 'support' stamp
first, or renewal work gets minted as support evidence — a new lie). By the census's
own math this one writer unblocks **ten organs at once**, because every consumer is
generic over evidence. Traps already mapped: cron context (the 454 lesson), the
suspension hole (mig 430 still unapplied), the eval-gate interaction.

**Move 2 — Per-archetype performance contracts + work-sourced KPIs.** The unit of
work per archetype (renewal = deadlines met / saves / ARR retained; ledger =
correctness & cycle time; project = milestones & time-to-live; relationship =
at-risk saves) becomes the performance read and the KPI catalog rows — computable
today from de_objectives / de_work_items / commercial_agreements. Skills note from the
critic: pouring work evidence into the spine does *not* fix skill definitions that
are answer-semantic (Communication Quality = CSAT) — those definitions need the same
per-archetype treatment.

**Move 3 — Trust surfaces from each archetype's real gated moments.** The invoice
card is the proven template: capability → gate → dial → evidence → promotion. Each
kit declares its own gated moments (send renewal notice alone; post ledger entry
under $X; send check-ins to ≤N accounts) and the surface derives from them.

**Move 4 — Enforce hiring's own declarations.** Required connector categories block
activation (or pin a blocking setup task). The single highest-leverage line of code
in this audit.

**Move 5 — Certification that simulates work.** Per-archetype fixture tenants:
seed accounts with deadlines and health scores, verify the DE opens the right
objectives and gates the right actions; the Q&A exam becomes the knowledge sub-score.
Eval-gate scope must be decided with it (D6): today the support chat exam gates every
archetype's learning loop tenant-wide.

**Move 6 — Improvement remedies beyond KB articles** (connector/config/SOP/plan
changes, same human gate; the drivers currently have one fix shape).

**Sequence:** Move 0 now → prove Moves 1–5 on **Renewal** (next in the founder-locked
order, richest prior art, sharpest test) → Billing/Accounting arrive as *config*
(catalog rows, kit motions, fixtures), not code — per the ships-global rule.

## The seven decisions that are yours (D1–D7)

1. **Retroactive certification** — five-plus active queue DEs have zero
   certifications; grandfather or gate them?
2. **Connect the systems of record** — the CRM/ERP for outsourcetel-hq; every zero in
   three walks traces to this. *The single highest-leverage action found.*
3. **Sign the unit-of-work contracts** — what "good" means per archetype is a
   business definition; proposals inside.
4. **Trust denominations** — auto-send invoices under what amount; check-ins alone up
   to how many accounts.
5. **Improvement remedies** — may the driver propose connector/config/SOP changes
   (human-gated) or KB articles only?
6. **Eval-gate scope** — per-archetype gates, or one tenant gate?
7. **The standing backlog (30 minutes)** — 18 exceptions sit undecided platform-wide;
   five are the Onboarding DE *correctly self-diagnosing its own blocker, daily*.

## What the critique caught — kept visible on purpose

- **The walks repeated the platform's own sin**: three walks independently claimed
  "0 conversations" for DEs that have some (Renewal has 1; Account Success has 1;
  hq has 251 total) — counter-style claims without counting rows, the exact error
  family this week named. The affected *conclusions* survive (1 conversation doesn't
  make a chat-shaped organ honest for queue work), but the figures above are the
  corrected ones.
- **Cells the six moves do NOT flip**: no move creates a non-chat satisfaction signal
  (CSAT/frustration stay chat-only — after Move 0 they go honestly NULL, but no
  work-shaped equivalent exists); and deliverables gain honest *doneness* but no
  production *quality* organ — the analog of answer-judging for a drafted invoice
  does not exist in this plan. Both are named as open, not solved.
- **A fifth archetype went unexamined**: marketing/SDR kits exist (migs 220/230) with
  a live DE (Website & Growth, 5 conversations) whose campaign/outbound work shape is
  claimed by neither the answer pipe nor the queue-engine analysis.
- The gap-matrix arithmetic (15 FITS / 21 MISMEASURES+NO-PATH / 8 other across 44
  graded cells) is consistent but sub-rows sit outside it; treat the matrix as a map,
  not a scorecard.

---

*Full per-archetype walks (11 organs each), the complete census, synthesis, and
critique are preserved in the session archive; every worst-class claim in this
document survived independent re-verification against live production.*
