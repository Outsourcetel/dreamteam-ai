# 19 — Build-Phase Gap Analysis
### Code-verified capability inventory vs three bars, with scored picks
*v2, 2026-07-23. Replaces the v1 list. Method: every "have" below was
code-or-DB-verified in this repo (most exercised live this week); every
market bar is sourced from the docs/18 research. Scoring: Impact (1–5,
weighted toward docs/18 strategy + pilot survival) × Confidence (0.5–1.0,
evidence quality) ÷ Effort (sessions). Higher = build sooner.*

## 0. The three bars

- **Bar A — Pilot survives** (Outsourcetel live use, weeks): nothing
  customer-visible breaks silently; the founder can operate alone.
- **Bar B — Mid-market production** (first external tenants, months): the
  feature floor buyers in our beachhead compare against (Decagon-class CX
  table stakes + our multi-role differentiators).
- **Bar C — Category leadership** (the employment layer, quarters): the
  moats in docs/18 §3 made durable (M1 compounding, M5 network).

## 1. Verified capability inventory (what is REAL today)

Channels: web widget (live-tested; streams only on Anthropic-direct, buffered
fallback otherwise), in-app chat, internal missions/objectives, A2A
endpoints. Governance: guardrails enforced in the live path (proven again
2026-07-23: refund demand → honest refusal + human task), un-toggleable
compliance packs (attach picker fixed today), escalation rules, action gate
w/ scoped guardrails, budgets (429-hard), audit chain, exceptions desk w/
producer. Trust: evidence-earned dial, certification exams (24-question run
executing live at time of writing), proving ground, rehearsal-at-hire.
Visibility: workforce board (now/next/blocked), operating model v2, outcome
statement w/ per-DE economics, decision traces humanized. Learning: gap
detection fed by live channels, gap→draft doc via assistant, judged
amendments, golden-exam growth, eval gate DB-enforced. Resilience: 4-provider
LLM spine, Bedrock primary live, $10 spend guard (two layers). Meter: 99¢
resolution rails. 66 connector adapters + registry + grants; browser
operator (parked-then-unblocked); role kits ×12.

## 2. Gap register

Legend: [A/B/C] = bar it blocks · I=Impact C=Confidence E=Effort(sessions)
· Score = I×C/E.

### G1 — Inbound email channel [A,B] — **Score 4.5** (I5 C0.9 E1)
Evidence: no inbound-email path exists (deep-audit finding, re-verified:
send-outbound only). Market bar: email is the default support channel
mid-market; Decagon/Sierra treat it as table stakes. Machinery ready:
conversation=ticket lifecycle, front-DE, reply-mode gates, drafts. Scope:
inbound address (provider webhook) → thread → de-answer → draft under
approval → threaded reply. Serves M1 (more real traffic → more learning).

### G2 — Pilot ops pack [A] — **Score 4.2** (I4 C0.95 E0.9)
(a) Sentry DSN activation (integration dormant; founder supplies DSN);
(b) Console AI-Engine tab (promised; keys/chain/last-failover — currently a
Remote-Access detour); (c) noteFailover marker silently failing (log-only
today); (d) RA-session dashboard mislabel ("Demo Workspace", zeroed tiles —
verified in-browser 2026-07-22). Cheap, and the founder operates alone.

### G3 — Human handoff surface completion [A,B] — **Score 3.6** (I4 C0.9 E1)
Evidence: escalations create human_tasks (proven today) and the Approvals
desk lists them; but resolution flow back to the CUSTOMER after a human
takes over (reply-from-inbox on an escalated thread, close-the-loop note to
the DE's memory) is thin. Decagon-class bar: agent→human→agent handoff is
a first-class demo. Mostly UI + one write path on the existing inbox.

### G4 — Self-evolution organs [C→M1] — **Score 3.2** (I5 C0.8 E1.25)
The four starving loops (built, unfed): amendment fitness (win-rate of
applied amendments), drift sentinel (behavior change alarms on evals),
learning review cadence (weekly digest of what the workforce learned —
feeds founder AND the proof page), ramp KPI (time-to-trust per hire). This
IS moat M1's compounding engine; MIT says memory+learning loops are where
the 5% live. Data exists for all four (evals, amendments, certifications).

### G5 — Proof page + buy-vs-build block [B, Move 1+2] — **Score 3.0**
(I4 C0.9 E1.2) Direct build-out of docs/18 moves with acceptance criteria
already defined. Depends on G2a (Sentry keeps the page honest) and pilot
telemetry accumulating.

### G6 — Records→gates [B,C] — **Score 2.7** (I4 C0.85 E1.25)
Cert expiry pauses autonomy; KPI misses spawn development items; health
drops demote reply-mode. Converts Layer-B records into Layer-A controls —
the "governance that actually bites" story Gartner's 40% lack. Touches the
trust ladder carefully; needs its own session.

### G7 — SoR write-back completion (Zendesk sync first) [B] — **Score 2.4**
(I3 C0.8 E1) Connector production-ready, needs creds + one pilot workflow.
Rises sharply the day a pilot tenant runs Zendesk; otherwise parked-ready.

### G8 — BYO-agent enrollment spec [C, Move 3] — **Score 2.1** (I5 C0.7 E1.7)
Design-first (docs/18 §5). Head start verified: A2A, delegation tokens,
action gate. Build only after spec review; the demo target (toolkit agent
completes one governed task) is the acceptance test.

### G9 — Assistant deep-merge (one spine) [B] — **Score 1.8** (I3 C0.9 E1.5)
Two assistants with cross-pointers today (honest but inelegant). Merge
workforce-chat onto ai-session's tool spine. Quality-of-product, not
blocking; schedule opportunistically.

### G10 — Voice channel [B-partial] — **Score 1.2** (I3 C0.6 E1.5+)
Market signal real (Sierra/Retell monetize voice heavily). NOT our
beachhead's first ask and heavy to do honestly (telephony, latency,
barge-in). Deliberate defer with quarterly re-check — do not build now.

### G11 — SSO/SAML + SOC 2 track [B-procurement] — **Score 1.0**
(I4 C0.9 E3+) Blocks enterprise procurement, not pilot or first mid-market
deals. Start the SOC 2 evidence-collection HABIT now (cheap: we already
have audit trails); defer the audit spend until first blocked deal.

### External/waiting (no build): frontier models on Bedrock (AWS sales),
Anthropic org restoration (auto-recovers; returns widget streaming + Batch
50% eval savings), July→Aug budget re-tighten (calendar note exists).

## 3. The committed sequence

1. **G2 pilot ops pack** (this week — founder supplies Sentry DSN)
2. **G1 inbound email** (the structural win; start immediately after)
3. **G3 handoff completion** (rides G1's surfaces)
4. **G5 proof page + calculator** (as pilot telemetry accumulates)
5. **G4 self-evolution organs** (the moat engine; next big session)
6. **G6 records→gates** → **G8 BYO spec** → **G7 on demand** → **G9**

**Explicit non-builds this phase:** G10 voice, G11 SOC 2 audit spend,
demo-fiction purge (Fresh Tenant Program owns it), frontier-model chasing.

## 4. What would change this ranking
A pilot tenant on Zendesk (G7 jumps to #2). A blocked deal on SSO (G11
jumps). Sierra/Decagon shipping self-serve mid-market pricing (accelerate
G5/G4 — the moat race shortens). Labs shipping employment-layer features
(accelerate G8 — neutrality becomes the story).
