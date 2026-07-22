# 16 — Module Truth Audits (2026-07-22)

Six parallel code-tracing audits (same lenses as docs/15: wired vs decoration
vs dead, genericity, customization, hidden machinery, AI coverage) over the
remaining nav modules. Founder directive: "similar fashion audit for each nav
module." Full agent reports live in the session of record; this file is the
condensed findings + the consolidated program.

## Cross-module themes (the patterns that repeat)

1. **Demo mode oversells; live mode is honest but thinner.** Every module
   ships a demo twin with fabricated sophistication that has no live
   counterpart: Support's 6-step setup wizard, Compliance's 3-layer template
   model + calendar, Renewal's "Zuora webhooks", Knowledge's type taxonomy,
   Playbooks' scripted evals, Audit's fake "verified" chain badges. A
   prospect who saw demo expects features live cannot deliver.
2. **The strongest machinery is invisible.** Data-access grants (default-deny,
   genuinely enforced) never appear in the Connectors UI; the generalized
   action preview/execute layer surfaces only in approvals; category
   contracts aren't exercisable; MCP + browser-operate live outside the
   Connect wizard; metering (the billing story) is absent from the page
   named Outcomes.
3. **Entry paths are the missing half.** Continuity has no
   agreement-creation UI (permanently empty for new tenants); the account
   write-back desk has a resolver but no proposer; watchers can't be
   authored beyond CS fields; playbooks can't be bound to a DE from the
   builder (fixed file-side in W2 via AttachedProceduresPanel).
4. **Doc/self-description drift.** connector-hub's header contradicts its own
   68 adapters; mig 090 + Trust page claim API keys have no consumers
   (false — a2a + emit-event); the executor docstring kept a removed rule;
   Trust & Architecture under-claims shipped security work.

## Per-module headlines (ranked gaps condensed)

### Playbook Builder
1. `playbook_definitions.de_id` never settable in the builder (user/AI drafts
   land de_id=null → consult-auto always skips, grants/knowledge fall back to
   first DE, lifecycle gate + trust-adaptive gating never apply, procedure
   docs unscoped). W2 shipped the Employee-File-side binding; the builder
   picker + DraftWithAI deId passthrough remain.
2. Deterministic step vocabulary is domain-bound (invoice-only object
   creation; update_record = 2 tables; guardrail_check = invoice-only; no
   notify/loop/create-record) — non-CS SOPs lean wholly on connector actions
   + dormant judgment steps.
3. Sub-playbook swallows child failure (parent marks done even when child
   failed / parked at its gate).
4. Branch execution partial (category-op/legacy connector_action + wait
   honest-skip inside branches).
5. "Publish v↑" broken label; jargon leaks (raw table names, step:N.field,
   slugs, raw webhook JSON); Edit-with-AI refuses published edits while the
   manual builder allows them; schedules have no generic audience selector.

### Knowledge
1. **Live chat + widget misses never feed gap detection or quality
   calibration** — both read only the specialist-consult evidence pipe; the
   self-healing loop is blind to the two highest-volume channels.
2. Eval gate is client-side, fail-open, bypassed by ingestion quick-add +
   connector sync.
3. "Approved revision → golden_qa / retrain" is demo narrative — no live
   writer.
4. "Alex" hardcoded across live Library copy.
5. Demo taxonomy (types/audience/6-stage lifecycle/DOCX dropzone) has zero
   live backing; silent partial-embedding state; no gap-policy tuning UI; no
   version-history viewer; specialist doc-scoping id-space mismatch risk.

### Governance
1. **IP allowlist is not a perimeter** — client-side sign-out only, fail-open
   at every layer; presented as network restriction.
2. API-key scopes are decorative (UI mints scopes nothing honors; the one
   consumer needs `a2a.*`, which the UI can't create).
3. Stale claims: "no endpoint calls API keys" (false: a2a + emit-event);
   Trust page under-claims shipped session/IP/API-key work.
4. Demo Compliance sells a template/calendar lifecycle with no live
   counterpart; playbook guardrail scope resolver-honored but UI-invisible;
   dual audit logs (hash-chained best-effort vs guaranteed activity log)
   with no cross-reference.
   (Data Access, Identity Inventory, live Audit chain = genuinely strong.)

### Connected Systems
1. All 69 providers `implemented:true` → the "adapter not built yet" honesty
   UI is dead code, while the REAL caveat (unverified against live
   instances) is never shown — green "Connected" overstates proof.
2. connector-hub header is stale and self-contradicting (says six providers;
   sharepoint "not implemented" — it has a full Graph adapter).
3. Grants invisible in the module (connected ≠ usable, never co-located);
   generalized action layer has no UI; category contracts not exercisable;
   ConnectorStatusDashboard orphaned (advertises a 5-min auto-sync that
   doesn't exist); Zendesk dual-path debt; MCP + operate bindings
   undiscoverable from the wizard; no scheduled health/sync.

### Customers
1. **No agreement-creation UI** — continuity permanently empty off-seed;
   empty-state CTA is a dead end.
2. Account write-back desk orphaned (resolver + list exist; no proposer, no
   renderer — mig 215 invisible).
3. Live Customer Overview is a dead shell (activity panel hardcoded empty,
   never calls listActivity; KPIs vanish live).
4. `logActivity` drops `account_id` → renewal/invoice events never reach the
   account drawer or health recency (one-line fix).
5. Demo oversell (Zuora/Gainsight, support wizard); onboarding demo's
   AI-assist unbuilt live; health history untracked; continuity reachable in
   demo mode where it errors.
   (Health computation, invoice gating composition, onboarding versioning,
   continuity case-facet = genuinely excellent.)

### Outcomes
1. **Metering is support-shaped** — only confident answers bill; action-only
   and domain DEs meter $0; `a2a`/`orchestrate` sources declared, never
   emitted.
2. The money story is missing from the Outcomes page (metering renders only
   on Performance/Employee File; two money engines never reconciled).
3. No UI for per-tenant pricing (`tenant_outcome_pricing` schema + RLS exist,
   product control doesn't).
4. No export/reporting (benchmark payload exists, no CSV/PDF anywhere).
5. Per-DE metered value omitted from the Delivery table; vestigial dead
   live-guards in OutcomePages; N+1 KPI fetch.
   (Idempotent metering + reversal, economics honesty, double-row handling =
   verified correct.)

## Consolidated program (Wave 4 candidates, in recommended order)

W4-A (safety/truth quick wins): logActivity account_id; builder DE picker +
DraftWithAI deId; sub-playbook failure propagation; API-key scope alignment
(mint `a2a.*` or label unrestricted); IP-allowlist honest relabel (or edge
enforcement); connector-hub header rewrite; "Alex"→persona; Publish label;
stale-claims sweep (Trust page, mig-090 comment).
W4-B (entry paths): agreement create/import UI; account write-back proposer +
timeline render; Overview wired to listActivity + live KPIs; watcher-engine
generalization (the deferred SQL rewrite); gap-policy tuning UI.
W4-C (visibility): grants shown on Connectors; action-registry UI + category
contract test button; metering card + per-DE value + pricing control on
Outcomes; version-history viewer; front-DE also shown in Settings.
W4-D (loop closure): de-answer/widget-ask write gap-detection candidates
(and optionally citations) so the self-healing loop sees live channels;
approved-revision → golden_qa; eval gate server-side.
W4-E (Wave 3 = AI-everywhere, unchanged from docs/15): ✨ standard on every
surface via ai-session; consolidate assistants; restore live amendment flow.
