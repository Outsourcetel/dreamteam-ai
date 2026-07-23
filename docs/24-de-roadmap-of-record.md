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
- **GI-4 — Widen what the record clamps, synchronously.** Fold open-critical-incidents + degraded-metrics into the *synchronous* records-gate (today only certs clamp actions in real time; incidents lag a 15-min cron and never touch actions). Add skill-floor / KPI-miss gating so the Employee File broadly bites.
- **GI-5 — Feed the metric watchers.** Snapshot `get_de_kpi_status` into `de_kpi_readings` (currently manual-writer-only → metric-threshold watchers are inert for the metrics that matter).
- **GI-6 — Make "it gets measurably better" measurable.** Fix `amendment_metrics` (tenant context + real writers; today reads an unset GUC with zero writers → `fitness_avg_delta` is structurally null) and surface recurrence-closed trend evidence.
- **GI-7 — Finish-or-cut the rest, honestly.** Wire-or-retire `de-perceive` (orphaned) and `tool-learn` (executor branch unwired); turn ON ANN / freshness / conflict-detection with validation, or relabel as roadmap.
- **GI-8 — Real compliance/guardrail detection.** Replace regex/substring guardrail + compliance-pack *content* with a classifier / LLM-judge layer (keep the deterministic layer as a cheap first pass) — PHI/TCPA/SoD must actually detect for regulated buyers. *Larger; sequence after GI-1..3.*
- **GI-9 — Real certification.** Route the cert exam through the semantic `eval-judge` (retire fragment-match), make certification mandatory-before-autonomy (today an uncertified DE runs ungated). *Larger; sequence after GI-1..3.*

### 2. Enterprise & Diligence Gates — *what a regulated mid-market buyer requires to sign*
SSO / SAML / SCIM; SOC2 path. These gate every deal irrespective of product quality; sequence them into the governance-first motion early enough to not block the first regulated close.

### 3. Governed Action Reach across the Workforce (breadth) — *make "workforce OS" real, not support-only*
Auto-generate governed write-actions from OpenAPI / MCP manifests (not hand-written per system); route MCP side-effects through the same `decide_action_execution` gate; close the non-blocking-gate seam (an approved action executes exactly once; the loop resumes with the REAL outcome); require independent definition-of-done before any `achieved`.

### 4. Metering Integrity — *a price defensible at invoice time*
Gate a billable "resolution" on a positive signal (CSAT-up / no-reopen / no-follow-up escalation); base value on the real work-product mix; roll in all LLM cost. (A thumbs-down auto-answer billing as a paid resolution is indefensible.)

### 5. Grounded Intelligence — *the governance-adjacent slice of the core upgrade*
Even in a governance-first motion, replace model-**self-reported** confidence with a **grounded** signal (retrieval-score / entailment vs cited spans) as the default input to **escalation + certification** — because those are governance surfaces. Full core upgrade (reranker, stronger embeddings, widget grounding) stays on the roadmap but sequences behind the governance story for this buyer.

### 6. Coherence & Scale (ongoing)
Collapse duplicated seams (mig-195 parallel lifecycle, two drafts / two routers / two output contracts / two watchable-source whitelists); apply the Knowledge-Phase-1 scale pattern everywhere (per-DE readers, parallel fair-share dispatch, retention/rollup) before enterprise volume forces it.

---

## Proof gate (non-negotiable)
Require **one paying, instrumented reference deployment showing quality-driven expansion/renewal** before scaling GTM — against the 2026 "95% of GenAI pilots show zero ROI" buyer skepticism. Governance-first buys still buy *evidence*.

## Still-open founder decisions (from docs/23 §7)
Action-reach approach (hand-write top-20 vs bet on OpenAPI/MCP auto-gen); the honest billable-resolution definition; exact finish-or-cut calls per dormant organ; SSO/SCIM + SOC2 timing.
