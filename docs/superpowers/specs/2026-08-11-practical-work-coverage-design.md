# Practical Work Coverage — Program Design (approved 2026-08-11)

**Founder brief:** before real data loads, cover the practical work an SMB/BPO
actually sells: onboarding, marketing, SEO, website management, renewals,
billing, collections, health/lifecycle/churn reviews, order taking,
appointment setting, quote generation, Meta/Google/LinkedIn ads, bookkeeping,
payables, receivables. Founder decisions locked in brainstorm:

1. **BPO clients' systems from day one** — every provider is tenant-scoped;
   each client tenant connects THEIR accounts (the ERPNext pattern: connector
   row + vaulted per-tenant credentials; the Zoho OAuth refresh flow is the
   token template). Nothing special-cases Outsourcetel's own accounts.
2. **All external account groups exist** (Google Ads, Meta/LinkedIn, GA4/GSC +
   CMS, Google Calendar) — every adapter is wireable once OAuth apps exist.
3. **All three chains ship** — the customer chooses; coverage IS the product.
4. **Front desk is text-first now**; voice slots in later on the same rails.

**Ground truth this design stands on (measured 2026-08-11):** 15 active role
archetypes already cover every function above. 20 provider action-sets exist
(erpnext, stripe, quickbooks, xero, hubspot, salesforce, zendesk, shopify,
square, …). The gaps are PIPES, not roles: no ads/analytics/CMS/calendar
providers; no Quotation/Sales-Order verbs; no verb that posts to a ledger; no
AP side at all; no recurring customer-review desk; and
`required_connector_categories` is decorative — nothing stops an ungrounded
hire. connector-hub NATIVE_ACTIONS is the verb registry; the draft→approve→
post gate is uniform product law for every new write.

## Phase 0 (parallel, starts immediately)
- **Founder:** register the developer apps the demand chain needs — Google
  Cloud (Ads API + Calendar + GA4/GSC scopes), Meta Business app, LinkedIn
  Marketing app. Two have human review queues (Google Ads developer token,
  Meta App Review): days-to-weeks, on their clocks. Runbooks:
  `docs/runbooks/oauth-apps.md`.
- **Build 0c — the grounding gate:** `required_connector_categories` becomes
  enforced: lifecycle advance to working stages requires a CONNECTED connector
  in each required category, and the hire flow says plainly what is missing.
  With clients connecting their own systems, an ungrounded hire is a
  customer-facing lie, not a hygiene issue.

## Chain M — Money (no OAuth; ERPNext dev instance verifies everything)
- **M1 Quote → Order:** `erpnext_create_quotation` and
  `erpnext_quotation_to_sales_order` verbs (draft docs in ERP; SUBMIT is the
  committing act and stays human-gated; rollback = cancel doc), registered as
  gated action_definitions for every tenant (Always-Live), offered to the
  sales/billing/front-desk roles per the mig-643 offer-list boundary.
- **M2 Ledger landing:** `erpnext_create_payment_entry` (and journal entry)
  verbs; approving a posting_draft finally POSTS through the same gate —
  accounting stops being a report-writer.
- **M3 Payables MVP:** purchase-invoice mirror (same two-call ingest pattern
  as AR), AP approval desk, payment-run proposals through the money gates
  (`amount_cents` is the only param the gates read).

## Chain C — Customer (assembly)
- **C1 Review desk:** recurring health-check / lifecycle / churn deliverables
  per account over the existing account book + continuity engine, driven like
  the dunning sweep (execution-advanced, dedupe-checked, no self-amplifying
  queue).
- **C2 Booking (text-first front desk):** Google Calendar per-tenant adapter;
  bind the existing `book_appointment` verb to a real diary. Code ships now;
  live wire awaits the founder's Google app credentials.

## Chain D — Demand (each lands as its OAuth approval arrives)
D1 shared per-tenant OAuth framework (generalise the Zoho refresh flow) →
D2 GA4 + Search Console read adapters (ground SEO/website roles first; reads
carry no spend risk) → D3 Google Ads (reads, then budget-gated writes) →
D4 Meta → D5 LinkedIn → D6 CMS (which CMS: ask at wiring time).

## Execution order (my side)
0c → M1 → C2 → M2 → M3 → C1, with D-items slotting in as approvals land.
Every verb: draft→approve→post, receipts, rollback, per-allocation
idempotency, offer-list scoping, and live verification against the dev ERP
with cleanup — the disciplines already proven on AR.
