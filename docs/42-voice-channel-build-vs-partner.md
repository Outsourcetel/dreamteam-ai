# 42 — Voice channel: build vs partner, decided

**Date:** 2026-08-04 · **Context:** docs/41 ranked the voice front-desk as the
proven SMB wedge we cannot address (rank #3), with voice a hard requirement in
6 of 10 target industries. The founder said: do voice — bring the build-vs-
partner plan. Research was run fresh (August 2026 landscape; sources in the
session record; load-bearing facts cited inline).

---

## 1. The decision

**Build on managed voice infrastructure, in custom-LLM mode, with our own
telephony numbers. Spike on Vapi; keep Retell and Twilio ConversationRelay as
drop-in fallbacks by construction. Do not white-label a finished product. Do
not build a media plane.**

One sentence of architecture: **they own the mouth and ears; we own the brain,
the gate, and the record.**

## 2. Why the constraint decides everything

Our non-negotiable: every utterance must exist as **text, checked by
guardrails, before it is spoken** — the same sentence-buffered discipline the
streaming chat channel already enforces. The research confirmed this constraint
is not optional conservatism; it is the only workable shape:

- **No native speech-to-speech mode offers a blocking text gate before audio.**
  OpenAI's Realtime guardrails run on debounced transcripts and trip *after*
  speech has started — a kill switch, not a pre-check. OpenAI's own guidance
  for approval-heavy flows is the chained architecture: run policy checks on
  text, "generate speech only after the workflow reaches an approved answer."
- **Anthropic ships no voice API as of July 2026.** The pipeline (STT → our
  LLM turn → guardrail → TTS) is the *only* way Claude — and our 4-provider
  failover spine — stays the brain.

So the platform question reduces to: which managed voice platforms let **our
server be the LLM**, with the media plane (telephony, STT, TTS, barge-in,
endpointing) entirely theirs?

## 3. The field (August 2026, researched)

Three platforms fit the seam; the rest fail it or fail us:

| Platform | Custom-LLM shape | All-in cost (our Claude tokens, BYO SIP) | HIPAA | Notes |
|---|---|---|---|---|
| **Vapi** | **OpenAI-compatible HTTPS/SSE endpoint — turn-scoped request/response** | ~$0.10-0.16/min | Enterprise add-on | $500M valuation; Amazon Ring routes 100% of inbound support through it; most consistent latency percentiles in independent benchmarks (~600-900ms) |
| **Retell** | WebSocket from our side (persistent per call) | ~$0.09-0.13/min | **Self-serve BAA** | $50M ARR on ~$5M raised (capital-efficient = survival odds); 50M calls/mo |
| **Twilio ConversationRelay** | WebSocket; carrier sends user text, we return reply text | ~$0.09-0.12/min | HIPAA-eligible | The purest text seam; carrier-grade telephony; but Twilio cut voice staff in 2026 — watch commitment |
| Bland | Closed model stack — no first-class custom LLM | — | Enterprise | **Fails the seam** |
| Synthflow | Managed LLM only | $0.15-0.37/min | Agency tier | **Fails the seam**; the only native white-label ($1.4k + ~$2k/mo) — which is why white-label dies as an option |
| ElevenLabs Agents | Custom LLM supported | ~$0.08/min + LLM | Enterprise BAA | Fastest benchmark turn (1.73s median); strong EU residency; keep on the bench for EU-heavy demand |
| LiveKit / Pipecat (cloud-hosted code) | We write the agent process | ~$0.03-0.08/min at scale | BAA on Scale tier | The **escape hatch**: open-source portability when volume justifies owning more |

**Why Vapi first — one decisive technical fact:** its custom-LLM mode is a
turn-scoped HTTPS request with a streaming response. That is *exactly* the
shape of a Supabase edge function. Retell and ConversationRelay both want a
WebSocket held open for the whole call — minutes — which collides with edge-
function wall-clock limits and would force a small persistent service (cheap,
but a new ops surface). **Vapi means zero new infrastructure:** the voice turn
endpoint is one more edge function reusing the existing LLM failover spine and
guardrail matcher.

**Portability is designed in, not hoped for:** our turn endpoint speaks the
OpenAI chat-completions dialect, so Retell/CR/LiveKit remain drop-ins; numbers
live on our own Twilio/Telnyx SIP trunk, so the phone numbers — the asset
customers actually feel — never belong to the platform. The 2026 consolidation
wave (Cognigy absorbed, PlayAI gone to Meta, OpenAI killing its own Agent
Builder inside a year) is the argument for this hedge.

**Why not white-label:** the only native white-label (Synthflow) runs its own
managed LLM — our gate structurally cannot sit in the loop, which forfeits the
moat and is the "agent washing" the market now punishes. For an ISV embedding
voice in its own SaaS, **the API is the white-label** — callers only ever meet
our brand.

**Why not from-scratch:** 4-9 engineering-months to production quality
(end-of-turn detection, barge-in recovery, echo, voicemail-detection false
positives, DTMF), plus 3-6 more for testing infrastructure, plus ~0.5 FTE
forever — to save $0.07-0.12/min that only matters above ~50k minutes/month.
We are at zero minutes/month. Revisit at sustained >50k min/mo via the
LiveKit/Pipecat escape hatch (write the agent in portable code then; the
platform bill at that volume funds the migration).

## 4. The governance architecture (the part that is ours)

The voice platform is treated exactly like MCP was: **an external tool-calling
client that must come through the gate.** Everything below reuses shipped
machinery.

1. **The turn loop** — new edge function `voice-turn` (OpenAI-compatible):
   platform sends the conversation so far → we run Claude through the existing
   failover spine → **sentence-buffered guardrail check on the text** (same
   matcher + semantic judge the chat channel uses) → only released text
   returns to be synthesized. A blocked utterance is never spoken; the caller
   hears the standard safe redirect.
2. **Mid-call actions = action_definitions.** `book_appointment`,
   `take_message`, `send_payment_link`, `log_payment_promise`,
   `transfer_to_human` — each registered with risk, executed via connector-hub
   `execute_action` → `decide_action_execution`. Reads auto; state-changing per
   the trust dial; money/destructive human-gated — the agent says "I'll have a
   colleague confirm that and text you," which is honest and is the product.
   Platform tool-webhook budgets (~100ms ack, async completion) fit the gate's
   claim-then-decide flow.
3. **The record.** Post-call webhook → transcript + recording pointer +
   every action into the audit chain; the call lands in `evidence_runs`, so
   voice feeds the *same* performance, trust, certification and KPI organs as
   chat — no parallel system. `de_channels` already has `kind='voice'` waiting.
4. **Trust ladder + certification.** A voice DE starts supervised
   (transfer-heavy, transcripts reviewed); auto-handling is earned per
   evidence, exactly like auto-send was earned; a voice exam gates the phone
   the way exams gate everything else. Suspension: `tenant_is_operational`
   checked in the webhook — a dormant workspace's number gets the fallback
   greeting, consistent with the dormancy regime.
5. **Compliance floor, enforced as config not memos** (all enforceable NOW):
   - **EU AI Act Article 50** (enforceable since 2 Aug 2026): AI self-
     disclosure in the *first utterance* — a guardrail-enforced greeting line,
     logged to the audit chain per call.
   - **Recording consent** in all-party-consent states (CA, FL, IL, MD, MA,
     PA, WA…): disclosure line before substantive conversation; California
     AB 2905 adds AI-specific disclosure at $500/violation.
   - **TCPA for outbound AR reminders**: FCC's 2024 ruling makes conversational
     AI an "artificial voice" — first-party informational calls need prior
     express consent, captured and **logged as evidence** (our consent log
     becomes an auditable artifact — a differentiator, since platforms ship
     mechanisms but accept no liability).
   - Open industry gap to track: Art. 50(2) machine-readable marking of
     synthetic *telephony* audio — no vendor solves it yet; we note it in the
     risk register rather than pretend.

## 5. Cost model

Target all-in at pilot volumes: **≤ $0.15/minute** — platform $0.05 + STT
(Deepgram Flux) ~$0.007 + TTS (Cartesia Sonic) ~$0.02-0.03 + Claude tokens
~$0.01-0.03 + telephony (BYO SIP) ~$0.008-0.015. Independent reports warn
Vapi stacks to $0.23-0.50/min with premium voices and defaults — we control it
by bringing our own keys for every component. Versus the anchors: a handled
call costs $0.30-0.50 vs $7-17 human; the front-desk human it displaces is
$45-50k loaded. Customer pricing: per-call or per-*booked-outcome* with
verified billing — deferred settlement extends naturally (a booked appointment
bills only if it survives 72h uncancelled).

## 6. The phased plan, with kill criteria

**P0 — the spike (2-3 weeks).** Vapi + one BYO Telnyx/Twilio number + the
`voice-turn` edge function + two tools (`take_message` auto, `book_appointment`
gated) + post-call ingest. Inbound front-desk booking use case. **Exit
criteria, all must pass:**
- p50 turn latency ≤ 1.2s measured on real calls with the guardrail seam in
  the loop (kill criterion: if > 1.5s after tuning, switch to Retell's socket
  shape before abandoning the approach);
- a seeded blocking guardrail provably prevents the utterance from ever being
  synthesized (the streaming-chat proof, repeated for voice);
- one gated action approved by a human mid-call flow completes with a receipt;
- the transcript and actions appear in the audit chain; the call appears in
  `evidence_runs`;
- the Article 50 disclosure line plays first on every call;
- a suspended tenant's number answers with the fallback, takes no action.

**P1 — governed pilot (4-6 weeks).** One design partner in a phone-native
vertical; supervised trust tier; voice certification exam built on the
existing exam driver; state-aware recording-consent lines; `de_channels`
wiring + channel UI on the Employee File; call review queue.

**P2 — GA + outbound.** Voice as a standard channel any tenant can enable;
outbound AR-reminder calls **only after** the TCPA consent-capture log ships;
pricing live with verified billing.

## 7. What this needs from the founder

1. Approve the spike (direction + ~$100-300 of usage spend; Vapi is
   self-serve).
2. A Twilio **or** Telnyx account with one number (BYO trunk from day one —
   the portability hedge; Telnyx is the cheaper leg).
3. Design-partner preference for P1: which phone-native vertical do we court
   first (trades / clinics / restaurants / professional-services reception)?
4. Confirm the P2 posture on outbound calls (consent-first, informational
   only, no marketing calls) — it constrains what we ever build there.
