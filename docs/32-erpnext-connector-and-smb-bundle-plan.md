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

> **D3 LOCKED 2026-07-28: pricing DEFERRED to G2.** The numbers below stand as an
> illustrative sketch only — no price is committed. Per-tenant COGS is tracked from S1 so
> the G2 pricing decision runs on observed cost, not a guess.

## 4. Pricing sketch (illustrative only — D3 deferred to G2)

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

## 6. Founder decisions — LOCKED 2026-07-28

| # | Decision | **Ruling** |
|---|---|---|
| D1 | Program shape (7 tracks / 4 gates, §7) | **APPROVED** — start to G1; each later gate still needs an explicit founder go |
| D2 | Canonical ERP landing zone | **`renewal_invoices` + `customer_accounts`** — workforce live day one; `invoices` unification = debt (B4) |
| D3 | Bundle price point | **DEFERRED to G2** — no number committed; unit economics tracked from S1 so the G2 decision runs on real COGS, not a guess |
| D4 | Frappe partner tier | **After first 5 bundle sites** — no upfront cost; certs when volume justifies the discount |
| D5 | Green-light Phase 1 (connector spine, serves BYO-ERP regardless of bundle) | **GO** — S1 authorized |

**Still open (do not block S1 code, but gate their milestones):**
- **Design partners** — 2–3 named from the fresh-tenant prospect list. Gates G2 entry, not G1.
- **G0 field-verification — CLEARED 2026-07-28.** Dev site `outsourcetel.m.frappe.cloud`
  (v16, Mumbai, 13-day trial) is live with sample data; a System-Manager user's API token
  authenticates (`Authorization: token key:secret`) and reads Sales Invoice, Customer, and
  Payment Entry (HTTP 200 on each). The `/api/resource/{DocType}` shape and token-auth
  mechanics are confirmed empirically, not from docs; trademark naming ("DreamTeam SMB
  Suite") cleared. Invoice field mapping grounded against a real record (`name`,
  `customer_name`, `due_date`, `outstanding_amount`, `status`, `grand_total`, `docstatus`).
  ⚠ The dev token was exposed on-screen/in-chat during setup — **rotate it** and store the
  fresh pair only in Vault via `set_connector_secret` as part of S1. No secret is written
  to this repo.

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

## 8. Execution playbook — how §7 gets worked flawlessly

§7 is the *what*. This section is the *how*: the discipline that turns 7 workstreams and
27–33 sessions into shipped, proven work without the failure modes this codebase has
already paid for. It is written to be picked up cold by any session.

### 8.0 Prime directive — the gate before the gate

**Nothing in §7 begins until G0 clears:** D1–D5 answered in writing (§6) and 2–3 design
partners named (§7.6). This playbook is not authorization to build. The moment a build
session legitimately opens, §8.1's rules bind it. Until then, every package below is in
state `blocked-on-G0` (§8.6).

### 8.1 Operating doctrine — eight rules, each bought with a real scar

| # | Rule (operational form) | The scar it encodes |
|---|---|---|
| R1 | **Fresh-dump before every recreate-apply.** Any migration doing `CREATE OR REPLACE` on an existing function: immediately before apply, dump the LIVE body (`pg_get_functiondef`), diff *every* recreated body against the migration's base, regenerate on any diff. | This session: the 425→430 number collision, then mig 453 silently rewrote `detect_de_development_needs_internal` after my dump — caught only by the pre-apply re-diff. Streams are at ledger #480 and moving. |
| R2 | **Rebase before every deploy.** Before any edge-fn deploy, rebase on `origin/main` and confirm parallel edits coexist in the file. | `playbook-execute` had +4 lines on main (Experience-door-b) a blind deploy would have reverted. |
| R3 | **Prove as behaviour, never infer from code.** Each exit proof is *observed* — a real scoped user, tenant, or run — not asserted from a function body. "Code, not behaviour" is named as a gap, never counted as done. | docs/30's own header; the 5× "inferred a system property from one object" error (verification-discipline memory). |
| R4 | **No false-greens.** Every assertion must be able to fail; test the primary key, not the object; a green that encodes the bug is worse than no test. | mig 435 blinded 5 crons for 8h behind a tautological assert; the null-composite guard bug (3 clicks = 3 hook runs). |
| R5 | **Honesty labels on everything.** `proven-live` / `built-unverified` / `inferred`, always distinguished; gaps surfaced unprompted. | Honesty mandate. |
| R6 | **Genericity — no ERP special-casing.** The connector generalizes via config; nothing ERPNext-shaped leaks into core (the §0 invariant). A provider/department hardcode fails review. | DE-genericity test; §0 moat clause. |
| R7 | **Money-safety floor.** Destructive risk tested per action (never assumed from the flag); every bundle DE starts draft-for-approval; journal entries never auto-execute. | Action-gate destructive floor; trust ladder. |
| R8 | **Data-safety: detect, don't correct.** Mirror drift is alarmed, never silently reconciled; restore is *drilled on a real backup* before GA, not assumed. | Data-restore has never been drilled platform-wide (recovery memory); ERP-wins conflict policy (B2). |

### 8.2 The per-session loop — Entry → Work → Prove → Land → Record

Every build session, no exceptions:

1. **Entry.** `npm run migrate:status` to see the live ledger max; reserve the next
   migration number(s) on-branch + announce to active streams (§8.3); confirm the work
   package's entry criteria are met; `git pull` / rebase `origin/main`.
2. **Work.** One package. Smallest shippable slice. Always-live — the change reaches all
   tenants via baseline, never one tenant (always-live rule), *except* the bundle-plan
   flag which is deliberately gated.
3. **Prove.** Run the package's exit proof (§8.5), which is machine-checkable:
   migrations carry in-body `DO $assert$` blocks *and* get a post-apply live query;
   RLS/scoping changes run `npm run test:isolation` + `test:invariants`; UI runs
   design-drift clean + a screenshot; money actions run a destructive-floor test that
   actually gates.
4. **Land.** Apply R1/R2 first. Apply migrations via `node scripts/db-query.mjs <file>`
   (auto-records the ledger); deploy fns via `node scripts/deploy.mjs --no-migrations
   --fn <name>` (preserves per-fn `verify_jwt`). Then `npm test` + `npm run typecheck`
   green before the session is allowed to close.
5. **Record.** Update the §8.6 tracker and the project memory; commit with the
   `bkhan@outsourcetel.com` identity. The `schema_migrations` row — not anyone's
   memory — is the source of truth for "applied".

### 8.3 Coordination with the parallel streams

The repo runs concurrent migration streams (this branch + the audit/employee-file
stream; live ledger already at #480). The contract that keeps them from clobbering:

- **Number reservation.** Before writing a migration, `migrate:status`, take the next
  free number, announce it via cross-session-message. Any number ≤ the live ledger max
  is burned — never reuse.
- **R1 is a shared invariant, not ours alone.** It is precisely what lets two streams
  recreate overlapping function bodies safely. If a stream skips it, the last-applied
  wins and silently reverts the other.
- **Cadence.** Rebase daily and before every apply/deploy.
- **The moat clause.** Any change to the §0 invariant returns to the founder by name.

### 8.4 Gate go/no-go checklists — founder authorizes each transition

I do not self-advance a gate. Each transition needs its proofs green *and* an explicit
founder go.

- **G0 → build:** D1–D5 recorded; partners named; Frappe Cloud token-auth + partner
  terms re-verified live; trademark naming cleared; dev ERPNext site reachable.
- **G1 (spine):** the scripted E2E passes end-to-end — real overdue invoice in dev ERP →
  existing dunning playbook fires → approval task carries the real invoice ref →
  approval executes the reminder into ERP → nightly drift check reconciles to zero. Plus
  `npm test` + `test:isolation` green.
- **G2 (private beta):** per partner — books migrated with trial-balance sign-off, ≥30
  days live, ≥1 DE promoted past draft-only on evidence (not by hand), zero sev-1, the
  support-escalation path exercised at least once for real.
- **G3 (GA):** provisioning timed < 30 min signup→live; `npm run restore:drill` PASSED
  on a real partner backup (this is the first platform-wide data-restore proof — it does
  not get waved through); runbooks + SLAs published; billing line-item live; unit
  economics (per-tenant COGS vs D3 price) observed and positive.

### 8.5 Session ledger to G1 — the only immediately-actionable increment

Detailed because it's next; G2/G3 packages stay coarse until their entry criteria
approach (fully planning them now would be planning on unverified assumptions — R3).

| Session | Package | Entry | Deliverable | Exit proof (behaviour) | Rollback |
|---|---|---|---|---|---|
| S1 | A1 provider foundation | G0 clear | native `erpnext` adapter (test/search/fetch/listRecent), token auth, health, SSRF-safe; `connectors_provider_check` widen; `PROVIDERS` UI entry | wizard connects a real dev ERPNext; `hubTest` green; `category_op` returns real Sales-Invoice rows | drop the provider-check widen migration; revert fn deploy (prior on main) |
| S2 | B1 canonical mapping | A1 | external-ref columns migration; amount→cents; currency guard; multi-company refused loudly at connect | insert a mapped invoice, assert external-ref idempotency (primary-key level, R4); reject a 2nd-currency connector in a test | migration is additive columns — safe drop |
| S3 | A3 action catalog v1 | A1 | platform-scope `action_definitions` (mig-217 shape) for dunning trio + `record_payment_promise`/`add_comment`; per-action destructive/idempotent classification; previews | each action tested through `decide_action_execution`: destructive floor gates the final-notice **before** trust is consulted (R7) | `WHERE NOT EXISTS` inserts; delete the rows |
| S4 | B2 sync engine | B1 | webhook + scheduled upserts, idempotent by external ref; ERP-wins conflict; local edits to mirrored fields blocked at RPC | a real ERP invoice syncs; edit the mirrored field via RPC → refused; ERP change wins on next tick | pause the schedule; sync is upsert-idempotent |
| S5 | E1 money guardrail pack | A3 | `require_approval_over_cents` defaults, legal-threat blocked phrases, per-category autonomy defaults | a dunning note over the threshold gates; a legal-threat phrase blocks — both observed, not assumed (R3) | guardrail rows are data; disable |
| S6 | A4 event plane | A1, B2 | ERPNext Webhook → `emit-event` (tenant api key); `invoice_overdue` realtime, `payment_received` clears dunning | fire a real ERP webhook → trigger row appears → dunning clears on payment | webhook is additive; delete the rule |
| S7 | **G1 assembly + proof** | S1–S6 | wire the scripted E2E harness; run it | the full G1 chain (§8.4) passes; `npm test` + `test:isolation` green | n/a — this is the proof session |

Estimate holds at §7's **7–8 sessions to G1** (S3 and B-track overlap S1–S2 once A1 lands).

> **S1 SHIPPED & PROVEN LIVE — 2026-07-28.** Native `erpnext` read adapter
> (test/search/fetchRecord/listRecent, Frappe `token key:secret`, Sales Invoice
> DocType, submitted-only) + `PROVIDER_OP_TRANSLATORS.erpnext`
> (search_invoices/get_invoice) in connector-hub; migration 514 registers the
> provider; frontend PROVIDERS entry + wizard + icon. Deployed. Proof: a real
> ERPNext (outsourcetel.m.frappe.cloud) connected to tenant outsourcetel-hq
> (connector 7f595bec) → `test` returns "authenticated as bkhan@outsourcetel.com"
> (healthy); `category_op search_invoices` returns real invoices in canonical
> shape; `get_invoice` returns full detail. Read-only slice — A2 (wider ops),
> A3 (dunning WRITE actions), and B-track ingest are next. ⚠ the dev connector
> holds the exposed dev token — rotate in ERPNext and re-store via
> set_connector_secret; low-risk throwaway trial site.

> **B1+B2 SHIPPED & PROVEN LIVE — 2026-07-28.** Migration 517 adds
> provider-generic `source_provider`/`source_external_ref`/`source_currency`
> columns + partial-unique idempotency indexes + `upsert_external_ar_record`
> (account then invoice; unknown status → 'sent'); no `erpnext` in the schema.
> `erpnext.syncFinancials` + a connector-hub `sync_financials` action pull all
> submitted invoices and upsert them. Proof: sync of connector 7f595bec landed
> 5 invoices / 3 deduped accounts into renewal_invoices/customer_accounts,
> amount×100 correct (PKR), status mapped (Unpaid→sent, Paid→paid); ran twice →
> still 5/3 (idempotent, R4 at row level). The existing dunning/at-risk/
> staleness machinery now reads real ERP data. NEXT toward G1: A3 (dunning
> WRITE actions, human-gated) + a backdated overdue invoice to fire the
> playbook end-to-end + B3 drift reconciliation.

> **A3 + B3 + overdue invoice SHIPPED & PROVEN LIVE — 2026-07-28 (near-G1).**
> **Overdue:** created ACC-SINV-2026-00006 in ERPNext (due 2026-07-02, 26 days
> past due), synced → renewal_invoices status='sent'; arStatus fixed so ERPNext
> 'Overdue'→'sent'; confirmed in the exact set invoice_overdue selects (target
> tenant outsourcetel-hq already has the published dunning rules).
> **A3 (mig 520 + erpnext_invoice_comment executor):** send_final_notice →
> `human_gated_destructive` (floored before trust), send_payment_reminder →
> `human_gated_trust` — the platform cannot write to the ERP without a human
> (the moat, proven through the gate). The write mechanism (POST Comment to the
> Sales Invoice timeline) proven to land in ERPNext. The approve→execute step is
> human-gated by design (needs a real authenticated approver — not faked).
> **B3 (mig 521 + reconcile_financials + nightly cron):** compares ERP live
> count/total vs the mirror, raise_ops_alert on mismatch — proven 6/6 in-sync →
> induced 7-vs-6 drift (ops_alert 'erp_ar_drift' raised) → re-sync → 7/7 clear.
> REMAINING for the formal G1 gate: the autonomous playbook→erpnext-action
> binding (wire "Overdue Invoice Follow-Up" to the erpnext dunning actions) and a
> real human approval through the UI. ⚠ dev connector still holds the exposed
> token — rotate.

> **★ G1 GATE — AUTONOMOUS CHAIN PROVEN LIVE, 2026-07-28.** The end-to-end
> money-shot runs hands-off. Added a `{{invoice.external_ref}}` bridge in
> playbook-execute (resolves the fire's internal renewal_invoices.id → the ERP
> invoice name at run start) + migration 526 (a real dunning playbook wired to
> erpnext send_payment_reminder; invoice_overdue rule repointed). PROVEN: fresh
> overdue invoice ACC-SINV-2026-00008 → sync → dispatch → invoice_overdue trigger
> fired → dunning playbook ran (check_account → connector_action → complete) →
> resolved the erpnext connector → gate returned human_gated_trust → an **approval
> task was created referencing the REAL ERP invoice** (bridge resolved
> external_ref to ACC-SINV-2026-00008, not the uuid). Autonomous up to the human
> approval, which stays human by design (A3 already proved an approved note posts
> to the ERP). G1 substantively met on one dev tenant; full close still wants
> `npm test`/`test:isolation` green + one real UI approval click.

### 8.6 Living tracker

Maintained here and mirrored to memory each session. State ∈ {`blocked-on-G0`, `ready`,
`in-progress`, `proven-live`}. Source of truth for "applied" is always the ledger row.

| Track | Packages | State (2026-07-28, post-lock) |
|---|---|---|
| A connector platform | A1–A6 | **S1 + A3 PROVEN LIVE 2026-07-28** — read adapter (mig 514) + dunning write actions (mig 520): gate floors destructive to a human, write posts to the ERP timeline. A2/A4–A6 pending |
| B data plane + drift | B1–B5 | **B1+B2+B3 PROVEN LIVE 2026-07-28** — ingest idempotent; drift sentinel (mig 521) detects/alarms/clears (proven: 6/6 → 7-vs-6 alert → 7/7). B4 unify, B5 backfill pending |
| C staffing | C1–C4 | blocked — entry after A3 |
| D provisioning + lifecycle | D1–D5 | blocked — G2/G3 milestone |
| E governance | E1–E4 | **ready after A3** |
| F experience | F1–F4 | blocked — entry after B2 |
| G commercial + support | G1–G4 | blocked — pre-G3; price deferred to G2 (D3) |

### 8.7 Risk register → control mapping

Each §7.4 risk is neutralized by a specific doctrine rule + gate check, not by good
intentions:

| Risk (§7.4) | Control |
|---|---|
| Action misfire on real money | R7 draft-first + per-action destructive-floor test (S3/S5); G1 proves the gate, not the bypass |
| Bad books migrated in | D3 trial-balance sign-off before workforce activates; G2 blocks without it |
| Mirror drift | R8 detect-don't-correct; B3 nightly reconcile → `ops_alerts`; G1 requires drift=zero |
| Frappe Cloud dependency | weekly backup pulls; **R8 restore drill is a hard G3 exit**; open-source press = credible exit |
| Migration collision / clobber | R1 fresh-dump + §8.3 number reservation; proven twice this session |
| Deploy reverts a parallel edit | R2 rebase-before-deploy; proven this session |
| Support gravity | G2 scope-boundary exercised for real; Support-DE deflection measured (G-track) |
| Per-tenant cost creep | G3 unit-economics gate; cost tracked from S-day-one |
| GPL contamination / trademark | E4 config-only, no forked apps; naming cleared at G0 |
| Scope creep into ERP consulting | R6 genericity; bundle = fixed role kits + migration workbench, rest is paid services |
| Suspension gap recurrence | D4 extends mig-430 dormancy to the ERP site — tested at G2, not assumed |


## 9. SoR alternatives — performance re-evaluation (researched 2026-07-28)

Prompted by an ERPNext performance concern. First, an honest confound: everything
was proven on a **Frappe Cloud trial** (cheapest shared tier) — near the worst case
for ERPNext, whose stack is heavy (Python + MariaDB + Redis + workers + socketio). The
perceived slowness may be the *deployment*, not the software; a fair test wants a
dedicated instance. Regardless, the free alternatives, verified against OUR criteria
(complete free accounting · true open-source/ownable · clean REST for our connector ·
light stack · provisionable):

| Option | License | API shape | Fit | Verdict |
|---|---|---|---|---|
| **Dolibarr** | **GPL-3+** | REST, `DOLAPIKEY` header; `/invoices`, `/thirdparties`, `/payments`; Swagger explorer | complete free ERP/CRM, light PHP, official Docker (amd64+arm64) | **Top pick.** ⚠ accounting/GL API thinner than invoicing (AR is well-covered); webhooks unconfirmed (we poll anyway) |
| **Tryton** | GPL-3+ | **JSON-RPC / XML-RPC first** (REST only via a stale community add-on) | strongest double-entry accounting; Python 3-tier (lighter than Frappe, heavier than PHP) | Good if accounting depth is paramount, but the RPC-first API is a different adapter shape |
| **Akaunting** | **BSL** (→ GPLv3 after 4 yrs) | REST CRUD, but thin docs; Laravel | lightest for finance-only | ⚠ **BSL is source-available, NOT open-source** — restricts hosted/reseller use. Fails the "customer owns a free open instance" invariant without legal review. Correction to an earlier verbal "GPL core." |
| ERPNext (incumbent) | GPL-3 | REST `/api/resource/{DocType}` (proven) | complete, proven live | keep pending a fair perf test on real hardware |

**Dolibarr port sketch — what actually changes.** Because the connector was built
provider-generic on purpose (R6, "no erpnext in the schema"), the surrounding machinery
**ports unchanged**:
- REUSED as-is: the AR ingest (`upsert_external_ar_record`, mig 517), the drift sentinel
  (`erp_ar_mirror_totals` + `dispatch_erp_reconcile_internal` + `reconcile_financials`,
  mig 521 — the dispatcher already loops `provider <> 'template'` erp_financials
  connectors), the `{{invoice.external_ref}}` bridge (mig 110fbde), the autonomous dunning
  playbook + `connector_action` resolution (mig 526 — resolves the tenant's erp_financials
  connector regardless of provider), the whole governance/gate/approval path.
- NET-NEW (the port): a `dolibarr` adapter object in connector-hub (test/search/fetch/
  listRecent/syncFinancials + a `dolibarr_invoice_note` write executor — Dolibarr's
  equivalent of the ERP comment is an invoice note or a linked agenda event); field
  mapping (`ref`→external_ref, `socid`→customer, `total_ttc`→amount×100,
  `date_lim_reglement`→due_date, `paye`/`statut`→status); a provider-check widen migration
  (mig-514 shape); platform-scope `action_definitions` for dolibarr (mig-520 shape); a
  `PROVIDERS`/icon entry.

**Effort to Dolibarr parity: ~2 sessions** (vs the ~6–8 the ERPNext path took), because
only the adapter + registration are new — ingest, drift, gate, and the autonomous chain
are already generic and proven. Needs a dev Dolibarr (Docker, ~15 min).

**Recommendation.** (1) Rule out the trial-tier confound with one honest ERPNext perf
test on a dedicated box before abandoning it. (2) In parallel, **evaluate Dolibarr** — it
is the cleanest free + open + light + REST-shaped fit, and the port is cheap. (3) Drop
Akaunting as an *anchor* (BSL); it could only be a connector after legal review.
(4) Tryton only if accounting depth outweighs the RPC-first API cost. The bundle can even
support BOTH ERPNext and Dolibarr as selectable anchors — same generic machinery.

Sources: Dolibarr REST API (wiki.dolibarr.org Module_Web_Services_API_REST; deepwiki
Dolibarr/dolibarr) · Dolibarr license + Docker (github.com/Dolibarr/dolibarr;
hub.docker.com/r/dolibarr/dolibarr) · Akaunting API + license (akaunting.com/hc/docs/
developers/restful-api; akaunting.com/license) · Tryton license + API (tryton.org;
github.com/openlabs/tryton-restful).

## Sources
- https://www.erpresearch.com/pricing/erpnext · https://frappe.io/cloud
- https://frappe.io/partners/plans · https://frappe.io/blog/community/a-guide-to-working-with-frappe-partners
- https://docs.frappe.io/cloud/api · https://github.com/frappe/press (press/api/site.py)
- https://docs.frappe.io/framework/user/en/guides/integration/rest_api/token_based_authentication
- https://docs.frappe.io/framework/v15/user/en/guides/integration/rest_api/oauth-2
- https://docs.frappe.io/framework/v14/user/en/guides/integration/webhooks
- https://github.com/frappe/erpnext/blob/develop/TRADEMARK_POLICY.md
- https://www.erpresearch.com/pricing/odoo
