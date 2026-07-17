# Streaming-Compatible Guardrails (Guardrails v2) — Design

**Status:** approved direction (founder, 2026-07-17) · implementation in progress
**Owner surfaces:** widget-ask (customer portal + embeddable widget), ChatCore; later de-answer/DEChatDock.

## The conflict this resolves

Today every customer-facing answer is guardrail-checked **in full before the
customer sees a single word** — a violating answer is withheld entirely and
escalated ("guardrail always wins"). True token streaming puts text on the
customer's screen before the complete answer exists, so the full-answer check
can no longer protect the whole message. Mid-stream retraction of an entire
prohibited utterance is off-brand; not streaming at all loses the latency/UX
bar set by Fin/Sierra/Decagon.

## Key technical insight

Incremental checking does **not** require per-chunk pattern matching (which
has chunk-boundary miss risks). Our blocking rules are `'|'`-separated
substring/regex fragments over a few KB of text — re-running the check over
the **entire accumulated text before every flush** costs microseconds and has
zero boundary problem. The hard part is *semantics*, not detection:

> If sentence 3 violates, sentences 1–2 are already visible. No finite
> hold-back buffer restores "withhold the entire answer" — only full
> buffering (i.e., not streaming) does.

## Design

### 1. Internal surfaces stream freely
DEChatDock and inbox draft previews stream tokens with no guardrail buffering.
Drafts exist *for human review* — the operator is the safety layer, and the
draft/auto gate (`external_reply_mode`) already prevents unreviewed customer
delivery. Zero trust change.

### 2. Customer-facing: sentence-buffered streaming with full-bubble retraction
- Server (widget-ask, `body.stream=true` → SSE; JSON path unchanged for
  widget.js compatibility):
  - Stream from Anthropic; append tokens to an accumulator.
  - Flush only on sentence boundaries (`.?!` + whitespace heuristics), and
    always hold back `K = max(active blocking pattern length, 120)` chars.
  - Before *every* flush: run the blocking-rule check over the **full
    accumulated text**. Match → abort upstream stream, emit
    `event: blocked` with the standard guardrail message, write the same
    audit event / human task / de_messages rows as the non-streaming path.
  - On clean completion: emit `event: final` with confidence/sources/
    delivery — then the existing cache write, memory write, metering.
- Client (ChatCore): render flushed sentences as they arrive;
  on `blocked`, **replace the entire streamed bubble** with the standard
  guardrail message (no partial text remains).

### 3. Honest residual (documented product behavior)
- A **complete** blocked span never renders (accumulated check + hold-back).
- Clean earlier sentences of an ultimately-blocked answer may be visible for
  a few seconds before the bubble is replaced. This is a deliberate,
  documented trade — the alternative is no streaming. Tenants who want
  absolute full-answer withholding keep it: streaming is per-tenant/per-DE
  **opt-in**, default OFF (`de_channels`/widget config flag), so the current
  behavior remains the default until a tenant chooses speed.

### 4. What does NOT change
- Guardrail rules, scoping, and the un-toggleable compliance packs are
  untouched — same resolver, same rules, run more often.
- Draft mode: streaming never applies to `draft_pending` deliveries (the
  customer sees the holding message; the draft streams only to the inbox).
- Cache hits are already instant and are served whole (no streaming needed).

## Verification plan
1. Unit-style: accumulated-check catches a pattern split across two chunks.
2. Live: seed a `blocked_phrase` rule on the demo tenant; stream a prompt
   engineered to violate mid-answer; verify: stream aborts, `blocked` event,
   bubble replaced, audit event + escalation task written, no complete
   blocked span ever emitted (capture raw SSE to prove).
3. Live clean path: normal question streams sentence-by-sentence, `final`
   carries sources/confidence; cache/memory/metering rows all present.
4. Regression: widget.js (JSON path) and draft mode unchanged.
