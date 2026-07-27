# 32 — ERPNext Connector + SMB Bundle Plan

**Status:** RESEARCHED, AWAITING FOUNDER APPROVAL — nothing built.
**Date:** 2026-07-28
**Follows:** founder direction ("single platform bundle for SMBs, without becoming the system of record"), docs/24 roadmap-of-record (governed workforce OS, moat airtight + honest first).

---

## 0. The invariant (the sentence we never break)

> **Every bundle customer gets a dedicated ERPNext instance that is theirs — their database,
> their books, exportable any day — and DreamTeam talks to it through the same connector
> machinery we'd use for any external ERP.**

Bundled ≠ merged. One signup, one bill, one login (phased — §6), inline work surfaces —
but the ERP stays a swappable, customer-owned system of record behind the standard
connector. The moment it gets special-cased into our core, we've become the SoR through
the back door and the docs/24 wedge story dies.

---

## 1. Verified facts (researched 2026-07-28, sources at end)

### Licensing + naming
- **ERPNext is GPL-3.0** — hosting it as a service is permitted (GPL has no network
  clause). We do not fork it; we consume its APIs, so share-alike never bites. The free
  edition is COMPLETE (accounting, AR/AP, HR, payroll, inventory, CRM, manufacturing) —
  unlike Odoo Community, which holds full accounting/payroll back for the paid tier.
- **Trademark:** "ERPNext"/"Frappe" are registered trademarks. We may DESCRIBE
  ("managed ERP **powered by ERPNext**"); we may NOT put ERPNext in a product, company,
  or domain name, or in paid ads. Bundle name: **"DreamTeam SMB Suite"** (compliant).

### Frappe Cloud (the Option-A host — ERP hosted by ERPNext's own maker)
- Priced **per site, unlimited users**: Starter $5/mo (250MB DB), Small $10/mo (500MB DB),
  Medium $25/mo (1GB DB, 25GB storage). All plans: automated backups, SSL, monitoring,
  **automatic upgrades** (the upgrade treadmill is Frappe's problem, not ours).
- **Programmatic provisioning is real**: the open-source Frappe Cloud backend
  (frappe/press) exposes whitelisted `press.api.site.new` (subdomain, apps[], plan,
  cluster/region) plus `login`, `backups`, `get_backup_link`, `jobs`. Their public API is
  documented as append-only/stable. ⚠ Exact team-token auth mechanics to re-verify at
  build time (docs page intermittently 500'd during research).
- **Partner program**: Bronze/Silver/Gold with Frappe Cloud discounts. Requirements:
  ≥2 team members certified via Frappe School + ≥$100/mo Frappe Cloud billing
  (≈ 4–10 bundle sites). Not required to start — it's a margin upgrade, not a gate.

### ERPNext integration surface
- REST CRUD on every DocType: `/api/resource/{DocType}` (Sales Invoice, Payment Entry,
  Customer, Item…). Auth: `Authorization: token api_key:api_secret` — fits our existing
  api-key connector auth shape as-is.
- **Webhooks are first-class** (per-DocType, per-event, conditions, signed with
  `X-Webhook-Secret`) → event-driven sync is available; our existing inbox-poll machinery
  also works without them.
- ERPNext ships an OAuth2 provider AND consumes external OAuth logins (relevant to §6).

### Odoo (for the pricing sketch, and why not Odoo)
- Odoo 2026: One-App-Free; Standard ~$24.90/user/mo; Custom ~$37.40/user/mo (varies by
  country; US often higher). A 10-user SMB on Standard ≈ **$250/mo for the ERP alone**.
- Odoo CE is LGPL but hollowed out; full accounting = paid Enterprise. ERPNext free
  edition is the only complete-ERP option we can bundle at $0 software cost.
- We still want an **Odoo connector** eventually (biggest install base) — but for the
  *bundle*, ERPNext wins on completeness + $0 license + per-site pricing.

---

## 2. What already exists in our codebase (live-verified map)

The deep map (this session, Explore pass over the worktree) says the bundle is mostly
assembly, not construction:

**Reused unchanged:**
- Connector substrate: `connectors` table (+ tenant RLS, Vault-encrypted secrets via
  mig 088, health columns, scheduled sync), connector-hub router with template-vs-native
  dispatch, SSRF guard at constraint AND fetch time (migs 099/370).
- **`erp_financials` category already exists everywhere it needs to**: `system_categories`,
  `CATEGORY_OPS` (`search_invoices`/`get_invoice`), `work_item_framing` seed, adapter
  template validator. A new `erp_financials` connector is picked up by
  `poll_de_work_sources_targets` with **zero code change**.
- Action layer: `action_definitions` binding by (category, action_key) with provider
  tiebreak; `decide_action_execution` (destructive-floor → guardrail → trust);
  `human_tasks` approvals; `get_agentic_tools_for_de` — **a new action row on a connected
  connector becomes a DE tool with no code change** (mig 074).
- The whole dunning domain: `renewal_invoices` + `customer_accounts`, `invoice_overdue`
  trigger branch, `dunning_payment_reminder`/`dunning_final_notice` playbooks (mig 043),
  staleness watchdog branch, watcher catalog entry, Billing/AR role kit (migs 218/223),
  guardrails (legal-threat block, approval-over-cents).
- Work surfaces: `get_de_role_context`/`get_de_work_product` (already group
  `erp_financials` executions generically), workforce board, BookOfWork/CaseTimeline
  panels, approvals inbox.
- Provisioning rails: `provision_tenant_baseline_internal` (mig 118),
  `demo-provision`-shaped idempotent edge provisioner, `pg_net` dispatch piggyback
  pattern (mig 076), OAuth app-credential storage in Vault (mig 141), and
  connector-verified onboarding items (`verify` blocks, service-role-only confirmation).

**Genuinely net-new (the real build):**
1. The ERPNext adapter itself (two options, §3).
2. **An ingest path.** Connector reads are deliberately never persisted today
   (`persisted:false`). For the existing dunning/watcher machinery to run on REAL ERP
   data, ERPNext invoices/customers must sync into our working tables.
   ⚠ Fork in the road: we have TWO parallel money tables — `renewal_invoices` (what all
   dunning automation reads) and `invoices` (what the AR role kit reads) — currently
   unreconciled. **Recommendation: land ERPNext sync into `renewal_invoices` +
   `customer_accounts`** (keeps every existing automation live on day one) and file
   `invoices` unification as separate debt.
3. Frappe Cloud provisioning: API client + platform token in Vault-encrypted
   `platform_config`, a `provision-erp` edge fn on the `demo-provision` shape, one
   amendment to mig 118's "seed everything **except connectors**" contract (this is the
   first case where the platform CAN mint the connector credential), failure/rollback
   semantics, onboarding `verify` items.
4. An AR workbench surface (nothing renders connector-level invoice detail inline today).
5. SSO/IdP — the expensive one, phased in §6.

**Two hard constraints found:**
- SSRF guard rejects private/loopback hosts: **Frappe Cloud public hostnames connect
  fine; a self-hosted ERPNext on a customer VPN cannot connect as-is.** Fine for the
  bundle; relevant for BYO-ERP customers later.
- `erp_financials` contract is only 2 ops today. Broader ERP surfaces (Payment Entry,
  Sales Order, Stock) require contract-code changes in both `categoryContracts.ts` files
  + the template validator — deliberate (mig 107: the list is data, the contract is
  reviewed code). Phase them; don't boil the ocean.

---

## 3. Build plan — four phases, each independently shippable

### Phase 1 — ERPNext connector on existing rails
**1a. Proof (pure data, zero new TS) — 1 session.**
One `adapter_templates` row (`provider='template'`, api-key auth header
`token key:secret`, ops bound to `/api/resource/Sales Invoice`) + template action
bindings, against a real trial ERPNext site. Proves auth/fetch/action round-trip using
exactly the pattern migs 037/043 shipped. Limited to the 2 legal `erp_financials` ops.
**1b. First-class `erpnext` provider — 2–3 sessions.**
Native adapter in connector-hub (test/search/fetch/listRecent), op translators, native
action executors, `connectors_provider_check` widening, `PROVIDERS` registry entry + UI
icon, **platform-scope** `action_definitions` rows for the dunning trio (today they exist
only as tenant-scope rows for one tenant — mig 217's `WHERE NOT EXISTS` shape is the
template). Ships to ALL tenants per the always-live rule: any customer with an ERPNext
can connect from day one — this serves BYO customers even if the bundle never ships.
**1c. Ingest/reconcile — 1–2 sessions + the canonical-table decision above.**
Scheduled sync (reuse migs 287/288 columns) mapping Sales Invoice → `renewal_invoices`,
Customer → `customer_accounts`; optional ERPNext webhook → `emit-event` for freshness.
Exit test: Sasha's existing dunning playbooks fire on a REAL overdue ERPNext invoice,
approval task carries the real reference, approved action writes back to ERPNext.

### Phase 2 — inline AR workbench — 1–2 sessions
Aging buckets, dunning queue, per-invoice drill-in with deep link into ERPNext, DE
activity (already available via `get_de_work_product`), all in our design system
(design-system law; dt-tokens). Reads the Phase-1c synced tables, so no live-fetch
surface is needed.

### Phase 3 — the bundle: auto-provisioned ERP — 2–3 sessions
`provision-erp` edge fn: create Frappe Cloud site (`press.api.site.new`, apps=[erpnext]),
poll job to readiness, mint api key/secret inside the new site, write the connector +
secret via existing RPCs, add onboarding items with `verify` blocks so go-live is
machine-confirmed. Triggered post-`complete_signup` for bundle-plan tenants. Idempotent,
forward-only, with explicit half-created-site cleanup. Support boundary: bundle includes
a **Support DE trained on the ERPNext KB** (our own machinery — the bundle dogfoods the
product) + defined escalation to Frappe Cloud support.
Human prerequisite (not code): decide who takes the 2 Frappe School certifications if we
want partner-tier discounts.

### Phase 4 — single login, honestly phased
- **4a (cheap, ships with Phase 3):** we auto-provision the customer's users in their
  ERPNext via REST + configure the same Google/Microsoft social login on both sides +
  deep links from our surfaces. Feels near-single; is honest.
- **4b (defer):** true OIDC IdP (authorization endpoint, JWKS, signing) — entirely
  net-new, weeks of security-sensitive work, and our Trust page already honestly lists
  SSO/SAML as Roadmap. Do not let this gate the bundle.

**Total to a sellable bundle: Phases 1–3 ≈ 7–11 build sessions.** Phase 1b alone is
already a standalone win for non-bundle customers.

---

## 4. Pricing sketch (founder to bless numbers)

**COGS per bundle customer:** Frappe Cloud Medium $25/mo (recommended for real books;
Small $10/mo viable for tiny customers) − partner discount later. Plus marginal support.

| | DreamTeam SMB Suite (sketch) | Odoo Standard, 10 users |
|---|---|---|
| ERP | included, **unlimited users** | ≈ $249/mo |
| Governed AI workforce | included | — (nothing comparable) |
| Sketch price | **DreamTeam plan + $99/mo flat "Managed ERP" add-on** | ERP only |

At $99/mo add-on: ~$74/mo gross margin per customer before support (improves with
partner discount). Positioning: *ERP plus a governed AI workforce for less than
Odoo charges for ERP alone* — and per-site pricing means the customer's 15th employee
costs them nothing, which is exactly the SMB nerve.

Naming stays trademark-compliant: "DreamTeam SMB Suite — managed ERP powered by ERPNext."

---

## 5. Risks, stated honestly

1. **Support gravity.** Bundling means ERP how-to questions land on us regardless of
   contract. Mitigation: Support DE on ERPNext KB + explicit scope + Frappe escalation.
2. **Two money tables.** If we skip the §2 reconciliation decision, we get a third
   parallel truth. The decision is part of Phase 1c's definition of done.
3. **Frappe Cloud dependency.** Their outage/pricing change hits our bundle. Mitigations:
   customer owns the site + daily `get_backup_link` pulls; the press stack is
   open-source, so self-hosting (Option B) remains a genuine exit, not a rewrite.
4. **Moat dilution optics.** Guard: the bundle is marketed as "workforce that comes with
   its own back office," never as ERP hosting. North-star test still passes — a chatbot
   competitor cannot claim the approval gates, audit trail, or trust dial around ERP
   actions.
5. **Verification debt.** Frappe Cloud API auth mechanics + current partner terms need a
   fresh read at build kickoff (their docs endpoint was flaky during research).

---

## 6. Founder decisions requested

| # | Decision | Recommendation |
|---|---|---|
| D1 | Approve phasing (1a→1b→1c→2→3, 4a with 3, 4b deferred) | Yes as laid out |
| D2 | Canonical ERP landing zone | `renewal_invoices` + `customer_accounts`; `invoices` unification filed as debt |
| D3 | Bundle price point | $99/mo flat Managed-ERP add-on (Medium plan COGS) |
| D4 | Pursue Frappe partner tier (2 certifications — who?) | Yes, after first 5 bundle customers |
| D5 | Green-light Phase 1a+1b now (serves BYO-ERP customers regardless of bundle) | Yes |

## 7. Program roadmap v2 — full depth (2026-07-28; supersedes the §3 estimates)

§3's phases were the *connector spine*. This section is the full program for running
real customers' back offices: seven parallel workstreams, four stage gates, and the
work the thin version skipped — books migration, lifecycle parity, drift
reconciliation, money-action governance, support operations, disaster drills.
**Nothing here is started; D1–D5 still gate everything.**

### 7.0 Operating principles (the "not a shell" clause)

1. **Deep operator integration, never embedding.** No ERPNext iframes in our UI. DEs
   act *in* the ERP through the governed action gate; our surfaces are first-class
   DreamTeam pages over mirrored data. The bundle is "an AI back-office team that
   comes with its own ERP," not a skinned ERP.
2. **One direction of truth.** The ERP is the system of record; our tables are a
   governed mirror. Every write path goes through `decide_action_execution`
   (destructive floor → guardrails → trust). Mirror drift is *detected and alarmed*,
   never silently corrected.
3. **Event-driven, not poll-only.** ERPNext webhooks feed our trigger layer; the
   5-minute polls become the fallback, not the mechanism.
4. **Lifecycle parity.** Suspend, delete, export, and restore cover the bundled ERP
   too — a suspended bundle tenant's ERP site is deactivated alongside our dormancy
   guards (mig 430), and offboarding hands the customer a standard, restorable ERPNext.
5. **Staffed, not empty.** The bundle ships with a hired back-office team (DEs with
   role kits, playbooks, KPIs, trust progression starting at draft-for-approval), not
   bare software.

### 7.1 Stage gates

| Gate | Meaning | Entry | Exit proof (machine-checkable where possible) |
|---|---|---|---|
| **G0 — Foundations** | decisions + legal + dev rig | this doc | D1–D5 recorded; Frappe Cloud token-auth + partner terms re-verified; dev ERPNext site live; naming cleared against trademark policy |
| **G1 — Spine proven** | tech risk retired | G0 | scripted E2E: real overdue invoice in dev ERP → existing dunning playbook fires → approval task with real ref → approved action lands in ERP → drift check passes |
| **G2 — Private beta** | 2–3 design partners on real books | G1 | each partner: books migrated with sign-off, ≥30 days live, ≥1 DE promoted past draft-only on evidence, zero sev-1, support flow exercised |
| **G3 — GA bundle** | sellable at D3 price | G2 | provisioning <30 min signup→live (timed), restore drill PASSED on a real partner backup, runbooks + SLAs published, billing line-item live |

### 7.2 Workstreams and work packages

Estimates are focused build sessions including verification. Parallelism noted per track.

**Track A — Connector & action platform (6–8 sessions)** — starts at G0 exit
- A1 Provider foundation (1.5): native `erpnext` adapter (test/search/fetch/listRecent),
  token auth, health, SSRF-safe; `connectors_provider_check` widening; `PROVIDERS` UI.
- A2 Read surface beyond invoices (1.5): Customer/Payment Entry/Sales Order ops —
  requires extending `CATEGORY_OPS` in BOTH contract files + the template validator
  (mig 107 rule: the list is data, the contract is reviewed code). Aging computation.
- A3 Action catalog v1 (1.5): platform-scope `action_definitions` (mig 217 shape) for
  the dunning trio + `record_payment_promise`, `add_comment`, `create_todo`; explicit
  destructive/idempotent risk classification per action; plain-language previews.
- A4 Event plane (1): ERPNext Webhook → `emit-event` (tenant api key auth, exists) →
  trigger-layer mapping (`invoice_overdue` realtime, `payment_received` clears dunning).
- A5 Knowledge sync (0.5–1): customer's ERP item/policy docs into the DE KB
  (`KNOWLEDGE_CAPABLE` + existing ingestion).
- A6 Odoo parity: assessment only, separate program — recorded so it is a decision,
  not a drift.

**Track B — Data plane & reconciliation (4–6 sessions)** — parallel after A1
- B1 Canonical mapping (1): external-ref columns migration; amount→cents; currency
  guard (reject non-tenant-currency until multi-currency is scoped); multi-company =
  out of scope v1, detected and refused loudly at connect time.
- B2 Sync engine (1.5): webhook-driven + scheduled upserts, idempotent by external ref;
  conflict policy = ERP wins, local edits to mirrored fields are blocked at the RPC.
- B3 Drift sentinel (1): nightly count/sum reconciliation ERP↔mirror per tenant →
  `ops_alerts` + tenant-visible health chip (the invariant-suite pattern from the
  verification-discipline memory — asserts that would catch OUR bugs, not just theirs).
- B4 Money-table unification (0.5–1.5): execute D2 — `renewal_invoices` canonical,
  `invoices` (AR role kit) either fed from the same sync or formally deprecated;
  the parallel-truth state ends at this package, not later.
- B5 Historical backfill (1): full AR ledger initial import with progress + resumability.

**Track C — Workforce staffing (4–6 sessions)** — parallel after A3
- C1 Role kits (2): AR clerk (extend existing Billing/AR kit), AP clerk (new),
  Bookkeeper-drafts (new; journal entries ALWAYS human-gated). Team mission template
  "month-end close" wiring the three.
- C2 Playbook packs + escalation (1.5): per-role playbooks bound to real actions;
  escalation conditions on the generic {signal,op,value} engine (mig 262); KPI
  definitions per role (DSO, collection rate, close latency) on the KPI machinery.
- C3 Trust progression (0.5): every bundle DE starts draft-for-approval; promotion only
  via existing evidence-based `trust_policies`; demotion wired to the records gate.
- C4 Certification (1): golden QA set for ERP workflows; cert exam via the existing
  eval driver so the Employee File shows a real certification, not a badge.

**Track D — Provisioning & lifecycle (5–7 sessions)** — parallel after A1
- D1 Frappe Cloud client (1.5): Vault-held platform token + admin-only setter
  (mirrors `set_oauth_app`); `press.api.site.new` → poll jobs → mint site api
  key/secret → connector row via existing RPCs. Idempotent, forward-only.
- D2 Signup integration (1): bundle plan flag in `feature_registry`; amend mig 118's
  "everything except connectors" contract for exactly this connector; onboarding items
  with `verify` blocks so go-live is machine-confirmed (mig 076).
- D3 **Books migration workbench (2)** — the package the thin roadmap missed entirely:
  chart-of-accounts template per country pack, customer/supplier/open-invoice CSV
  import (ERPNext data-import API) driven by the onboarding DE with per-step human
  sign-off, trial-balance check before the workforce activates. Bad books in = bad
  automation forever; this package is why design partners succeed.
- D4 Lifecycle parity (1.5): suspension → deactivate site + connector pause (extends
  mig 430's dormancy semantics to the bundled ERP); deletion → export bundle
  (site backup via `get_backup_link` + our tenant export) then teardown; weekly backup
  pull; **one real restore drill is a G3 exit criterion** (data-restore has never been
  drilled platform-wide — the bundle does not inherit that gap).
- D5 Failure containment (1): half-created-site cleanup, retry budget, `ops_alerts`,
  and a provisioning status surface the customer can see.

**Track E — Governance & compliance (3–4 sessions)** — parallel after A3
- E1 Money guardrail pack (1): `require_approval_over_cents` defaults per action,
  legal-threat blocked phrases, per-category autonomy defaults; destructive floor
  verified per action in a test, not assumed.
- E2 Access model (0.5): per-DE `data_access_grants` to the ERP connector, default
  deny (docs/29 axes); reporting-line visibility honored.
- E3 Audit continuity (0.5): every ERP write carries the ERP doc reference in
  `audit_events` + `action_executions.receipt`; evidence linkage so the Employee File
  shows ERP work truthfully.
- E4 Compliance pack (1): GPL policy = config-only, NO forked Frappe apps (if a custom
  app ever becomes necessary it is published open-source — decision, not accident);
  trademark naming checklist; country tax pack selection at provisioning; data-ownership
  language for the contract ("your instance, exportable any day") aligned with what D4
  actually delivers.

**Track F — Experience (4–5 sessions)** — parallel after B2
- F1 Back-office workbench (2): AR first — aging, dunning queue with DE activity,
  invoice drill-in, deep link to the ERP record, inline approvals. dt-tokens law;
  drift baselines updated.
- F2 Bundle onboarding wizard (1): connect-or-provision choice (BYO ERPNext uses the
  same rails — the bundle is a superset, not a fork).
- F3 One-login phase 1 (1): user mirroring on team invite + deep links + optional
  shared Google/Microsoft social login on both sides. Phase 2 (real OIDC IdP) stays
  deferred and is listed on the Trust page as Roadmap — no quiet scope creep.
- F4 Vocabulary + design QA (0.5): tenant vocabulary keys for ERP nouns; drift
  detector clean.

**Track G — Commercial & support ops (2–3 sessions + human tasks)** — before G3
- G1 Billing (0.5): plan gating + manual line-item first; automated billing explicitly
  out of scope here.
- G2 Support model (1): Support DE trained on ERPNext KB (existing ingestion), scope
  boundary doc (what we answer vs what escalates to Frappe), macro pack.
- G3 Ops runbook (1): site-health monitor via press API → `ops_alerts` (with a READER
  — the ops-visibility rule), per-tenant infra cost tracking against plan, upgrade-note
  watch (Frappe auto-upgrades: we monitor release notes, we don't gate them).
- G4 Partner tier (human, calendar): 2 Frappe School certifications (D4 decision on
  who) once ≥5 bundle sites justify the discount.

### 7.3 Sequencing and totals

```
G0 ─ A1 ──► A2 ─ A3 ─ A4 ─ A5          (A: connector platform)
        └─► B1 ─ B2 ─ B3 ─ B4 ─ B5     (B: data plane, parallel)
        └─► D1 ─ D2 ─ D3 ─ D4 ─ D5     (D: provisioning, parallel)
             A3 ──► C1 ─ C2 ─ C3 ─ C4  (C: staffing)
             A3 ──► E1 ─ E2 ─ E3 ─ E4  (E: governance)
             B2 ──► F1 ─ F2 ─ F3 ─ F4  (F: experience)
                          G1..G4 ──► G3 gate
```

- **To G1 (spine proven):** A1–A3 + B1–B2 + E1 ≈ **7–8 sessions**
- **To G2 (private beta):** + A4, B3–B5, C1–C2, D1–D3, E2–E3, F1–F2, G2 ≈ **+13–16**
- **To G3 (GA):** + A5, C3–C4, D4–D5, E4, F3–F4, G1, G3 ≈ **+7–9**
- **Program total: ≈ 27–33 sessions.** With B/C/D/E running parallel to A after A1,
  calendar shape is roughly: G1 in week 1–2, G2 entry in week 4–5, G2→G3 driven by the
  30-day partner soak, GA around week 9–10. The §3 "8.5–12.5 sessions" figure was the
  minimum spine only; this is the honest full-program number.

### 7.4 Risk register

| Risk | Mitigation |
|---|---|
| Action misfire on real money | draft-first trust for every bundle DE; destructive floor tested per action (E1); journal entries never auto |
| Bad books migrated in | D3 trial-balance check + human sign-off before workforce activation |
| Mirror drift | B3 nightly reconciliation + alarm; ERP-wins conflict policy; no silent correction |
| Frappe Cloud dependency | customer owns site; weekly backup pulls; restore drill at G3; open-source press = credible self-host exit |
| Support gravity | G2 scope boundary + Support DE deflection measured; escalation to Frappe defined |
| Per-tenant cost creep | G3 cost tracking vs plan; site-plan right-sizing alert |
| GPL contamination | config-only policy (E4); any custom Frappe app is published open-source by decision |
| Scope creep into ERP consulting | bundle = defined role kits + migration workbench; anything beyond is paid services, stated in the contract |
| Suspension gap recurrence | D4 lifecycle parity extends mig 430 semantics to the ERP site — tested, not assumed |

### 7.5 Program KPIs (reported per gate)

- Signup → live ERP time (target < 30 min at G3)
- % ERP actions auto vs gated over time per DE (trust progression is visible, not claimed)
- Design-partner DSO delta over the G2 soak
- Support deflection rate by the Support DE; escalations to Frappe per tenant per month
- Drift-check pass rate (target 100%; any failure is an ops alert, not a statistic)
- Per-tenant infra cost vs D3 price (unit economics stay visible from day one)

### 7.6 Founder gate points (beyond D1–D5)

- **G2 entry:** pick the 2–3 design partners (fresh-tenant program prospect list).
- **G2→G3:** price confirmation (D3) after real COGS observed; partner-tier timing (D4).
- **Any change to the §0 invariant** (customer-owned, swappable, standard connector)
  returns to you by name — it is the moat clause.

## Sources
- https://www.erpresearch.com/pricing/erpnext · https://frappe.io/cloud
- https://frappe.io/partners/plans · https://frappe.io/blog/community/a-guide-to-working-with-frappe-partners
- https://docs.frappe.io/cloud/api · https://github.com/frappe/press (press/api/site.py)
- https://docs.frappe.io/framework/user/en/guides/integration/rest_api/token_based_authentication
- https://docs.frappe.io/framework/v15/user/en/guides/integration/rest_api/oauth-2
- https://docs.frappe.io/framework/v14/user/en/guides/integration/webhooks
- https://github.com/frappe/erpnext/blob/develop/TRADEMARK_POLICY.md
- https://www.erpresearch.com/pricing/odoo
