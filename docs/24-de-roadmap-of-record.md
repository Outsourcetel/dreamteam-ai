# Digital Employee — Roadmap of Record

*Founder-locked 2026-07-24. Derives from the research-grade analysis in [docs/23](23-de-deep-analysis.md). This is the plan of record; docs/23 is the evidence.*

---

## The locked decision

**Wedge / product identity: a GOVERNED WORKFORCE OS (breadth) — sold GOVERNANCE-FIRST into regulated / trust-sensitive mid-market, NOW, ahead of answer-quality parity.**

Not a support-agent-depth play. The multi-role workforce (support + finance + sales + ops) stays the identity, and the **control fabric / governance / trust story is the differentiator we lead with** — the one axis where the platform is already ahead of Sierra / Decagon / Fin / Agentforce.

### What this reprioritizes (the consequence of the wedge)

Because the *pitch is the governance*, the moat must be **airtight and honestly real** before we chase raw answer-quality parity — a governance-first buyer's diligence tears into exactly the governance surface, and today that surface has honest holes. So the analysis's "finish-or-cut / harden" items stop being cleanup and become **the core product work**.

---

## Roadmap (ranked, for THIS wedge)

### 1. Governance Integrity — *make the moat bulletproof and honest* (IN PROGRESS)
The governance pitch cannot survive dormant/unfed governance features or a security-review hole. This block converts "governed (mostly)" → "provably governed."

- **GI-1 — Spend caps become real. ✅ SHIPPED (930bc81).** `record_de_spend` now fires in connector-hub after a successful monetary execution (both auto-exec and human-approved re-entry), so `de_spend_ledger` accumulates and the cumulative daily/monthly caps in `decide_action_execution` actually bite.
- **GI-2 — Lock the audit-chain insider-write hole. ✅ SHIPPED (mig 305, 930bc81).** Dropped the `audit_events_tenant_insert` RLS policy; the SECURITY DEFINER `append_audit_event` RPC is now the only append path (verified no direct insert anywhere). Also revoked INSERT/UPDATE/DELETE/**TRUNCATE**/TRIGGER/REFERENCES from anon+authenticated — verification caught a live TRUNCATE grant (a one-statement cross-tenant wipe, RLS- and trigger-exempt). Added `audit_chain_head()` for external anchoring.
- **GI-3 — Per-employee earned trust. ✅ SHIPPED (mig 306, 930bc81).** Threaded `de_id` (+ source_category) through `apply_trust_promotion`, `trust_demote`, and both demotion triggers — a promotion earned on one DE no longer widens the tenant-wide dial. Demotion fixed in the same migration so a per-DE-promoted employee stays demotable ("demote fast" preserved).
- **GI-4 — Widen what the record clamps, synchronously. ✅ SHIPPED (mig 307, deb6a62).** `de_records_gate` now also clamps on an open critical incident and degraded ERROR rate (56d/≥10-run/>15%). Adversarial pass caught that gating on *escalation* rate self-latches with no un-gate path (a permanent autonomy trap), so escalation stays soft/async; error-rate self-clears. Census: 0 DEs clamped on deploy.
- **GI-5 — Feed the metric watchers. ✅ SHIPPED (mig 308, fb52e92).** Daily pure-SQL cron snapshots platform-computed KPIs into `de_kpi_readings` (source='system'), **value-change-idempotent** so a sustained breach doesn't open one autonomous work-item per day per DE across all tenants. Fail-closed grants; manual rows untouched. Proven: run1 wrote 6, run2 wrote 0.
- **GI-6a — Surface a REAL self-improvement signal now. ✅ SHIPPED (mig 309, 40fa591).** Founder chose "real signal now, build fitness next." The naive fitness fix (two time-separated ~4-question golden replays) measures *noise* (non-deterministic LLM + tiny unordered sample + moving baseline) — an honesty-mandate violation. So the learning digest now surfaces the already-real closed loop on recurring problems (`knowledge_gap_clusters`): recurring issues fixed + fix durability (held vs reopened, shown only with real sample). The fitness chip stays hidden (needs samples≥3) until GI-6b makes it real.
- **GI-6b — Real amendment fitness (candidate-persona replay). ✅ COMPLETE (inert until enabled).** Full pipeline shipped: AREA A + persistence + determinism plumbing, then the driver (migs 311 digest quality-fix, 312 claim RPC, 313 cron; `de-fitness-measure` edge fn; SelfLearningPage fitness chip detached + unit-labelled). One applied 'de' amendment/tick → current-vs-proposed persona back-to-back golden replay at T=0 → pass-count delta → fail-closed write. Gated OFF by `amendment_fitness.enabled`; chip hidden until real samples≥3. Rigor capped at de-simulate MAX_COUNT=5 (|Q|=40 needs a harness change — documented follow-up). **Founder action to activate: flip `amendment_fitness.enabled` → 'true'.**
  - *Sub-shipments:* AREA A candidate_persona injection (7eb7705), persistence mig 310 (fixes fail-open GUC writer, 176e15b), determinism plumbing (c3eafdc), driver + chip (085b8da). Adversarial reviews across two workflows caught 6 real defects (T=1.0 ±50pp noise, fail-open writer, fabricated delta-0 samples, cosmetic-edit spurious delta, quality-signal pollution, double-fire race) — all handled.
- **GI-7 — Finish-or-cut the rest, honestly. ✅ RESOLVED (disposition; neither is falsely claimed — only these audit docs mention them, so no customer-facing false advertising to unwind).**
  - **`tool-learn` → KEEP.** Not dead-weight: mig 158 calls it "roadmap muscle #2, HIGHEST LEVERAGE" — it turns an OpenAPI spec into executable `action_definitions`, i.e. it is the deliberate foundation of §3 (Governed Action Reach). Honestly scoped in its own header (structural until a connector+creds exist). Its user-facing entry point is §3's opening move, built there — not a rushed GI-7 UI.
  - **`de-perceive` → CUT-recommended (left in place pending founder confirm — deletion is destructive).** Examining the real tool overlap: `nl_query` duplicates de-work's existing `run_analytics` (vetted-key analytics the brain already calls), and `extract_fields` (document field extraction) has no consumer in any work path. Wiring it would add redundant/speculative surface to the safety-critical tool-use loop for ~no value. Honest call = remove; it is NOT falsely claimed, so leaving it in place is also honest — the cut is optional cleanup, not a landmine.
  - **ANN / freshness / conflict-detection flags** were validated + enabled on the pilot tenant (Knowledge P5); fleet-wide default-on is a separate rollout call, not a GI-7 blocker.
- **GI-8 — Real compliance/guardrail detection. ✅ SHIPPED (mig 315 + guardrailJudge.ts, bfc9464), inert (flag OFF, shadow default).** A semantic LLM-judge (Haiku T=0) second-pass that catches paraphrased PHI/TCPA/SoD violations the regex first-pass misses — on both the answer path (de-answer + widget-ask, incl. a streaming→buffer fix so the judge clears before the first byte) and the action path (connector-hub payload + playbook-execute invoice auto-send, the two `decide_action_execution` callers). ONE shared primitive; fail-closed in enforce (no-provider/over-budget/timeout/unparseable all BLOCK); verdict cache invalidated by rule/pack edits; shadow mode logs without blocking. Two-tier flag: `platform_config['semantic_guardrail.enabled']` (absent=OFF) + per-tenant `feature_registry`. **Founder activation: shadow on a pilot tenant → review `semantic_guardrail_shadow_log` → flip mode to enforce.**
- **GI-9 — Real certification. ✅ SHIPPED (eval-run + mig 316, 05354ff).** The cert exam now grades semantically via `eval-judge` (retired the substring fragment-match; infra outage → no cert minted, R1 fail-closed). Certification is mandatory-before-autonomy via `de_records_gate` branch (e) — opt-in per tenant (`require_certification`, seeded OFF) + triple-grandfathered (explicit override / hired-after-opt-in / exam-exists) so no existing tenant flips on apply; direct opt-in read (never the fail-open feature check), fail-closed lookups, archetype-scoped "certified." **Founder activation: flip `require_certification` per tenant → new hires must certify.**

> **✅ GOVERNANCE-INTEGRITY CLUSTER COMPLETE (GI-1 → GI-9).** The moat is airtight and honest end to end. All governance-behavior changes ship flag-OFF/inert; founder activations are collected in the "Founder activation" notes above.

### 2. Enterprise & Diligence Gates — *what a regulated mid-market buyer requires to sign*
SSO / SAML / SCIM; SOC2 path. These gate every deal irrespective of product quality; sequence them into the governance-first motion early enough to not block the first regulated close.

### 3. Governed Action Reach across the Workforce (breadth) — *make "workforce OS" real, not support-only*
Auto-generate governed write-actions from OpenAPI / MCP manifests (not hand-written per system); route MCP side-effects through the same `decide_action_execution` gate; close the non-blocking-gate seam (an approved action executes exactly once; the loop resumes with the REAL outcome); require independent definition-of-done before any `achieved`.
- **Action-honesty — exactly-once: ✅ SHIPPED (72cfdde + mig 318/89c34da).** A gated action approved twice used to DOUBLE-EXECUTE (real double-charge): `decideHumanTask` had no `pending` guard and re-ran every approval hook, and the executed row was written with `task_id=NULL` so `resolve_action_execution_for_task` re-returned the original gated row. Fixed both halves — frontend idempotency guard (sequential) + a DB partial-unique-index claim taken before the external call (concurrent race). Fails toward never-double-charge.
- **Action-honesty — definition-of-done: ⏳ STAGED (design wf_165ebbd7-45a).** Shadow layer (assess whether a run/objective's required side-effects actually completed before it may write `achieved`; log the verdict at all 4 terminal writers) → server execute-once + reconcile on approval → enforce per-tenant flag. Founder defaults confirmed (lenient rejection, `awaiting_verification` state, reconcile-not-replay, enforce gated). A large agentic-loop + objective-lifecycle unit — next focused pass; inert/shadow until its flag.
- **Breadth (auto-gen reach):** tool-learn (OpenAPI→action_definitions, mig 158) is the foundation; MCP parsing + entry point + gate routing remain. Approach = OpenAPI/MCP auto-gen (founder-recommended path).

### 4. Metering Integrity — *a price defensible at invoice time* — ✅ SHIPPED (mig 314, df4f49e), flag OFF
Deferred settlement: a resolution records PENDING at answer time and only CONFIRMS billable after a 72h window IF no negative signal (escalation / thumbs-down / hand-off-to-human / customer wrote back). `settle_billable_outcomes()` cron (*/15) confirms or unbills; escalation reverses pending+confirmed. Reproduced `record_billable_outcome` from mig 181 (signature unchanged → no edge-fn changes); readers untouched. Entire change behind `metering_deferred_settlement_enabled` (seeded OFF) → flag OFF = byte-identical to mig 181, 103 historical billable resolutions preserved, no published /proof number moves. **Founder action: flipping the flag is a billing-policy decision — "we stop charging for answers the customer later reopened or thumbs-downed, at a 72h billing delay."**

### 5. Grounded Intelligence — *the governance-adjacent slice of the core upgrade* — ✅ SHIPPED (mig 317 + groundedConfidence.ts, a96a639), inert (self_reported default, shadow-first)
Confidence is now derivable from real retrieval support (distance/coverage/corroboration) instead of blind model self-report; shadow-logs both before it ever drives escalation; blends only as min(self,grounded) under a per-tenant validation gate; fail-open on infra, LOW on thin retrieval; synthetic/cert traffic excluded. **Founder activation: `grounded_confidence.enabled='true'` + mode `shadow` on a pilot → review flip-rate → re-baseline floors + insert validation row → `blended`.** Fast-follows: widget-ask parity + safety-valve auto-revert cron (before wide enforce). Full core upgrade (reranker, stronger embeddings, widget grounding) stays on the roadmap behind the governance story.

### 6. Coherence & Scale (ongoing)
Collapse duplicated seams (mig-195 parallel lifecycle, two drafts / two routers / two output contracts / two watchable-source whitelists); apply the Knowledge-Phase-1 scale pattern everywhere (per-DE readers, parallel fair-share dispatch, retention/rollup) before enterprise volume forces it.

---

## Proof gate (non-negotiable)
Require **one paying, instrumented reference deployment showing quality-driven expansion/renewal** before scaling GTM — against the 2026 "95% of GenAI pilots show zero ROI" buyer skepticism. Governance-first buys still buy *evidence*.

## Still-open founder decisions (from docs/23 §7)
Action-reach approach (hand-write top-20 vs bet on OpenAPI/MCP auto-gen); the honest billable-resolution definition; exact finish-or-cut calls per dormant organ; SSO/SCIM + SOC2 timing.
