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

## Sources
- https://www.erpresearch.com/pricing/erpnext · https://frappe.io/cloud
- https://frappe.io/partners/plans · https://frappe.io/blog/community/a-guide-to-working-with-frappe-partners
- https://docs.frappe.io/cloud/api · https://github.com/frappe/press (press/api/site.py)
- https://docs.frappe.io/framework/user/en/guides/integration/rest_api/token_based_authentication
- https://docs.frappe.io/framework/v15/user/en/guides/integration/rest_api/oauth-2
- https://docs.frappe.io/framework/v14/user/en/guides/integration/webhooks
- https://github.com/frappe/erpnext/blob/develop/TRADEMARK_POLICY.md
- https://www.erpresearch.com/pricing/odoo
