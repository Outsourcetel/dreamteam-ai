# 49 — Full Product Review: Master Inventory & Claims Baseline (Workstream A)

**Date:** 2026-08-11 · **Status:** BASELINE — nothing here is verified yet unless marked otherwise.
**Programme:** 19-workstream full product review (approved 2026-08-11). This doc is the map every
other workstream marks up. Row states: `claimed` (someone/some doc says it works),
`proven-live` (driven on deployed system with evidence), `built-unproven`, `inferred`, `dead`,
`unknown` (no claim on file — itself a finding).

**Counting note (per working agreement):** this inventory enumerates **the whole surface from
primary sources** — filesystem, live database, package.json — not from docs or memory. Doc claims
are attached to rows, not used to generate them.

---

## 0. Surface totals (measured today)

| Surface | Count | Source |
|---|---|---|
| Public DB tables | 292 | information_schema (live) |
| Migration files | 726 (19 duplicate numbers, permanent) | supabase/migrations |
| Edge functions | 63 + `_shared` | supabase/functions |
| Frontend page components | 74 | src/pages |
| Frontend source files (ts/tsx) | 216 | src |
| Ops scripts | 34 | scripts/ |
| Test files | 41 | repo-wide |
| Certification checks | 17 named checks | scripts/certify.mjs |
| Docs | 78 files | docs/ |
| Tenants (live) | 16 | tenants table |
| DE instances (live) | ~125 across all tenants | digital_employees table |
| Connector rows (live) | 24 (9 real/demo + 15 self-connector) | connectors table |

---

## 1. Tenants (live census, verified today — this table is proven-live)

| Tenant | Status | Role in review |
|---|---|---|
| outsourcetel-hq | active | **The operating tenant.** All functional truth-audit evidence weighs here |
| outsourcetel | active | Legacy first tenant — 11 DEs all idle/designed. Candidate for decommission review (Q) |
| kinetic | active | Second operating candidate — 12 DEs, mostly designed |
| harbor-peak-consulting | trial | Trial-state exemplar for lifecycle testing (Q) |
| root-insurance, mynd, ontrac, fashion-nova, gusto, first-community-cu, sonic, masterclass, great-expressions, staypineapple | active | 10 industry demo tenants — uniform trio pattern |
| acme-telecom | suspended | Suspension-state exemplar (Q) + holds the demo connectors |
| acs | suspended | Second suspended exemplar |

**Findings already visible at baseline:** (a) 13 of 16 tenants are demo/idle — "live to all
tenants" claims are structurally testable against them; (b) a disposable **review tenant does not
yet exist** — needed for B/C/Q (founder approved provisioning via the real path).

## 2. DE workforce census (live, proven-live as census; capability is NOT proven by a row)

Operating force at outsourcetel-hq (status=active): Accounting DE, Business Development DE,
Onboarding DE, Renewal DE, Billing & Invoicing DE, Marketing DE, Technical Support DE, Account
Success DE, Finance DE. Designed/idle: IT Helpdesk DE, Front Desk DE (the two CREATE verdicts),
Workspace Assistant. Retired: Technical Specialist ×2, Customer/Patient Support ×3, Onboarding
Architect.

Every other tenant: standard trio (Account Success + Finance active; Workspace Assistant,
Onboarding Architect, demo Support idle). outsourcetel (legacy): 11 DEs all idle — nothing
operates there.

**All ~125 DEs are trust_level=supervised.** No DE anywhere runs above supervised — the autonomy
machinery (waves 1.1–1.3, org-level trust) has live config but no live consumer above the floor.
→ Verify in **B** (does supervised flow work), **I** (quality per role), **T** (which are used).

## 3. Frontend surface — 74 page components (src/pages)

Claim sources: dead-UI map, module truth audits, support/mobile memory. `unknown` = no claim on file.

| Area | Pages | Claimed state → verify in |
|---|---|---|
| Auth/entry (6) | Login, OrgSetup, PlatformInviteRedeem, ResetPassword, SetPassword, Proof | claimed working → B, K |
| Platform console (4) | PlatformConsole, PlatformTeam, PlatformInvitesPanel, MyAccountBadge | claimed working (console cleanup 07) → B, C |
| Tenant core (12) | Dashboard, DeWorkbench, EmployeeFile(+Sections), LiveWorkforceDEs, MyProfile, Organisation, Settings, UserManagement, WorkforceChatHub, WorkforceHub, CompanySetup, OnboardingArchitect | mixed; EmployeeFile has 8 ANSWERED decisions to implement → B, F, K |
| Support (6) | SupportCommandCenter, SupportInbox, SupportHistoryReport, SupportHub, SupportCalls, SupportTriageRules | **strongest claims — handoff 06 COMPLETE, proven-live migs 667–669** → spot-confirm B |
| Governance (7) | GovernanceHub, AuditTrail, Compliance, DataAccess, IdentityInventory, SecurityAccess, TrustArchitecture | claimed live post dead-controls fix → B, C, M |
| Knowledge (7) | KnowledgeHub, Library, LiveLibrary, Ingestion, Gaps, Permissions, Quality | claimed live; retrieval default-OFF → B, I |
| Entity/customers (10) | CustomersHub, CustomerOnboardingLive, CustomerRenewal, CustomerSuccessLive, PipelineLive, CommercialContinuity, CustomerJourneyStubs, VendorPages, WorkforcePages, onboarding/{ProjectRequirements,VerbBinding} | mixed — "Stubs"/"Live" naming split is itself a claim; vendor descoped → B, F |
| Ops (3) | Activity, DEActivity, HumanTasks | claimed live (42/100 audit history) → B, M |
| Intelligence (3) | IntelligencePages, LiveProvingGround, SelfLearning | unknown → B (dead-code check first) |
| Systems (4) | LiveConnectors, LivePlaybookBuilder, McpServers, TemplateBuilder | claimed live (playbook 3.0, MCP UI) → B, P |
| Mobile (1) | MobileShell `/m` | proven-live except founder lock-screen last hop → B closes it |
| Autonomy (1) | BrowserOperator | claimed spike-grade → B |
| Portal/chat/legal (4) | EndUserChat, HostedChat, Privacy, Terms | chat claimed live; legal pages **content never reviewed** → N |
| Outcomes (1) | LiveOutcomes | claimed rebuilt (performance-outcomes) → B, M |

## 4. Edge functions — 63 (supabase/functions)

| Domain | Functions | Verify in |
|---|---|---|
| DE runtime (10) | de-work, de-answer, de-orchestrate, de-mission, agentic-step-execute, de-memory, de-improve, de-simulate, de-eval-online, de-fitness-measure | B, I |
| Approvals/actions (3) | approved-action-driver, unexecutable-approval path, emit-event | B (spine) |
| Knowledge (7) | knowledge-ingest-drain, ingest-chunks, embed-backfill, reembed-drain, extract-document, knowledge-gap-detect, site-import | B, I |
| Connectors/MCP (6) | connector-hub, connector-zendesk, mcp-client, mcp-demo-server, oauth-start, oauth-callback | P |
| Comms (5) | email-inbound, send-email-reply, send-outbound, push-send, invite-team-member | B (email+push are demand arteries) |
| Voice (3) | voice-relay, voice-turn, voice-webhook | B (known-slow, decided path) |
| Eval/exam (4) | eval-batch, eval-judge, eval-run, de-training-capture | I, M (exam contamination) |
| Onboarding (3) | onboarding-assist, onboarding-verify, provision-workforce-assistants | B, Q |
| Playbooks/templates (4) | playbook-draft, playbook-amend, playbook-execute, tool-learn | B |
| Entity ops (2) | entity-draft, entity-amend | B |
| Platform/infra (9) | a2a, ai-engine-status, ai-session, brand-extract, check-ip-allowlist, compute, compile-trust-plan, conflict-probe-drain, learned-behavior-detect | B, C |
| Governance/export (5) | scim, tenant-export, verify-domain, otel-export, proof-stats | C, N, Q |
| Widgets (2) | widget-ask, workforce-chat | B, P |
| Specialist (1) | specialist-consult | retired role — dead-code candidate, D |

**Baseline question for B:** which of these 63 have fired in production in the last 30 days?
One query against invocation logs turns "exists" into "used/unused" for the whole list.

## 5. Governance controls & harnesses

**Certify checks (17):** rls-on-every-public-table · secdef-caller-tenant-ratchet ·
secdef-search-path-ratchet · migration-files-match-ledger-checksums · audit-chain-verifies-hq ·
no-pending-approval-the-platform-cannot-carry-out · role-restricted-actions-stay-restricted ·
guard-bypass-setters-pinned · landed-reads-use-the-shared-predicate ·
exam-evidence-stays-out-of-production-metrics · no-unattended-public-speech ·
no-untyped-literal-appended-to-a-container · template-op-contract-classes ·
active-template-actions-are-bound · onboarding-bindings-are-runnable ·
bound-onboarding-items-complete-from-evidence · workspace-admin-has-an-owner
→ **C/D re-run and invert each** (a checker that cannot fail is theatre); comparison counts recorded.

**Standing audits:** audit:role-gates · audit:silent-refusals · design-drift · benchmark ·
golden-path · certify:mutation · restore-drill (**never run against production data — E**).

**Known-open governance items at baseline:** support auto-close deliberately unbuilt (open
decision) · marketing DE parked-never-close · golden_qa has no role column (I) ·
security-deferred checklist (C).

## 6. Connectors (live table, proven-live as census)

| Connector | Tenant | Status | Reality label to assign in P |
|---|---|---|---|
| ERPNext (dev frappe.cloud) | outsourcetel-hq | connected, last_ok **today** | candidate **live-proven** (AR/dunning) — P confirms write path |
| Stripe (MCP) | outsourcetel-hq | connected, last_ok 08-05 | claimed governed-MCP; P verifies scope + credential handling post-580 |
| Zendesk (edge fn exists, no connector row) | — | — | **claims/reality mismatch to resolve in P** |
| Salesforce | acme-telecom | disconnected, "no creds yet" | vapour until proven |
| Zuora | kinetic | disconnected | vapour until proven |
| generic_rest ×3, template ×2 (jsonplaceholder) | acme-telecom | connected | demo-grade; exclude from customer-facing claims |
| dreamteam (self) ×15 | all tenants | connected | internal plumbing, not an integration claim |

**Baseline finding:** the honest external-integration count today is **ERPNext + Stripe-MCP = 2**,
both on the HQ tenant only. Every other integration name in docs is roadmap, not product.

## 7. Docs corpus — 78 files, three strata (full classification in S)

1. **Numbered decision docs 05–48** — the governed record; several FOUNDER-LOCKED (24, 29, 39, 41, 45–47).
2. **Legacy caps-named docs** (GO_LIVE_*, HIPAA-SECURITY-POLICY, SCALING-ARCHITECTURE, WEEK1_…, ROADMAP…) — predate the truth audits; **assume stale until S clears them**. HIPAA policy doc with no HIPAA programme is a liability-shaped claim → N.
3. **Reference/design** (design-system, mcp-governed-connector-design, benchmark, kb/, superpowers/).

## 8. Claims requiring priority verification (cross-workstream shortlist)

| # | Claim on file | Source | Workstream |
|---|---|---|---|
| 1 | Restore has never been proven; PITR OFF | memory | **E — top risk** |
| 2 | Support pipeline end-to-end proven-live | migs 667–671 | B (spot-confirm only) |
| 3 | Push reaches founder lock-screen | mig 670, last hop unproven | B |
| 4 | Cross-tenant perimeter closed | migs 662–664 | C (attack as 2nd tenant) |
| 5 | No approval can exist that the platform cannot execute | certify + mig 704 | B/C invert it |
| 6 | Billing "who pays" now works | migs 632/633 | Q (had never worked before) |
| 7 | Exam evidence out of production metrics | mig 671 + check | M (contaminated once) |
| 8 | −83% infra cost holds | memory | L |
| 9 | ERPNext AR write path proven | memory | P (re-drive) |
| 10 | All-tenants parity (features global via baseline) | standing rule | B (test on a demo tenant, not HQ) |

---

## Next: Workstream A remaining items → then B begins

- [ ] Edge-function invocation census (used/unused per fn, 30-day window)
- [x] Route map located: central page-state router, `src/lib/pageRoutes.ts`, **68 mapped routes**
      against 74 page components — the delta is sub-components plus any unreachable pages;
      per-route reachability check lands in B/D (dead-UI pass)
- [ ] Provision disposable review tenant via real path (founder-approved)
- [ ] Scorecard skeleton (doc 50) initialized from this inventory
