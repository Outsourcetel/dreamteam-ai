# 19 — Build-Phase Gap Analysis (2026-07-23)

*Synthesis of the current state after everything shipped through 2026-07-23:
all truth-audit programs closed (W1/W2/W4-A–E, ledger), docs/17 C1–C6
complete, LLM failover spine live on Bedrock, board + operating model live,
pile triaged 10→1. This ranks what remains by STRUCTURAL value for the build
phase, with the Outsourcetel pilot as the forcing function.*

## Tier 1 — pilot-critical (do before/with the pilot)

1. **Inbound email channel.** The support surface is chat + widget; real
   support traffic is email. Named in the deep audit as a true gap; the
   conversation lifecycle (conversation=ticket, inbox, front-DE) is ready to
   receive it. Scope: inbound address → parse → de-answer pipeline → draft
   reply under reply-mode gates → thread back out. Biggest single
   capability gap between "pilot" and "production support desk."
2. **The proof hour as pilot gate (operation, not build).** Now unblocked on
   Bedrock: run Remy mission E2E, a rule-forced escalation, certification
   exams across the roster, one gap→golden→doc loop, one judged amendment.
   Output feeds the Move-1 case-study page. Run it as pilot kickoff.
3. **Pilot ops pack (small builds):**
   - Sentry DSN activation (integration shipped dormant) — error visibility
     before real users hit errors.
   - Platform Console "AI Engine" tab (promised): keys, chain status,
     last-failover display — no more Remote-Access detour for ops.
   - Fix noteFailover's silent platform_config_set write (marker row never
     lands; log line works).
4. **Budget headroom decision.** July cap = 970k tokens (~400k fresh);
   August resets to 400k (~$6 worst case). A real pilot with daily traffic
   likely wants 2–5M tokens (~$10–30/mo realistic blended) — founder call
   when pilot volume shows up; AWS $10 budget alert will flag it.

## Tier 2 — the docs/18 moves (moat-building)

5. **Case-study proof page** (Move 1) — 1 session, marketing surface.
6. **Buy-vs-build calculator** on the hire wizard job-spec (Move 2) — small.
7. **BYO-agent enrollment spec** (Move 3) — design session; A2A + delegation
   tokens + action gate give a head start. The strategic judo.

## Tier 3 — structural debt with leverage (post-pilot-start)

8. **Self-evolution organs** (machinery built but starving): amendment
   fitness loop, drift sentinel, learning review cadence, ramp KPI. The
   self-improving-workforce story needs these four to be true at scale.
9. **Records → gates:** cert expiry pauses autonomy; KPI misses spawn
   development items. Turns Layer-B records into Layer-A controls.
10. **Assistant deep-merge** (one spine for workforce-chat + ai-session) —
    the one remaining two-brains seam; needs its own design session.
11. **Zendesk SoR sync / ticket write-back** — connector is production-ready,
    needs credentials + pilot demand.
12. **Email-adjacent:** send-outbound exists (drafts→approve→send); inbound
    completes the loop (see #1).

## External / waiting

13. **Frontier models on Bedrock** — AWS sales/account upgrade unlocks
    Sonnet 5/Opus 4.8/Fable 5; map flips back via config only.
14. **Anthropic org restoration** — restores streaming widget replies, Batch
    API (50% eval savings), first-party frontier. Chain auto-recovers.
15. **SSO / advanced ACL** — enterprise-sale blockers, not pilot blockers.

## Recommended picks (the next structural wins)

**Pick 1: Inbound email** (Tier 1.1) — the largest honest capability gap and
the thing a pilot will hit first. **Pick 2: Pilot ops pack + proof hour**
(Tier 1.2/1.3) — cheap, and converts the pilot into evidence for Move 1.
**Pick 3: Case-study page + calculator** (Tier 2) — ship while pilot
evidence is fresh. BYO-agent spec next design session after that.
