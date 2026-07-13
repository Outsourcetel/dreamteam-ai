---
title: Connecting your first system
category: Connectors
feature: Connectors — Connect wizard
audience: admin
difficulty: beginner
tags: [connectors, connect wizard, credentials, test and save, categories, providers]
---

# Connecting your first system

## What it is
The **Connect a system** wizard on the **Connectors** page links a Digital Employee (DE) to one of your real business systems — your helpdesk, CRM, knowledge base, product API, and so on. The wizard is **category-first**: you tell DreamTeam what *kind* of system it is, then which brand, then enter credentials and run a live test.

## Why it matters
A Digital Employee is only as good as what it can see. Until you connect a system, a DE answers from uploaded knowledge alone. Connect your systems of record and it can look up a customer, check a ticket's history, or read the latest policy doc — grounded in your live data, with every access audited.

## Before you start
- You need admin access to the Connectors page.
- Have the credentials for the system ready (an API token, key, or admin login — the wizard tells you exactly where to find each one).
- Decide whether the DE should **read the system live** (fetch-only) or **keep a searchable copy** of its content (ingest). See *Fetch vs ingest modes*.

## Step by step
1. Open **Connectors** in the left navigation.
2. Click **+ Connect a system** (top right). On a brand-new workspace with no connectors yet, click **Connect a system** on the empty-state card instead.
3. **Pick a category — "what kind is it?"** Choose the tile that matches the system's job:
   - **CRM** — customers, deals, conversations
   - **Helpdesk** — tickets & help articles
   - **Knowledge base** — docs & pages
   - **ERP / Financials** — invoices, payments, POs
   - **Billing** — subscriptions, invoices, usage
   - **Payroll / HCM** — employees, payruns, time off
   - **Point of sale** — orders & products
   - **Product system** — your own product's records
   - **Other**

   The category matters because your DEs speak in categories, not brands: a DE asks "the helpdesk" whether you run Zendesk or Freshdesk, and whichever system you connected answers.
4. **Pick the system (the brand).** You'll see the systems that fit your category first. Use the **Search 30+ systems…** box to filter by name. If your system isn't listed, choose **Custom system — build a template** (rung 4) or upload files into Knowledge instead (rung 5).
5. **Enter credentials.** The **How to get credentials** panel gives the exact steps for that provider (for example, in Zendesk: *Admin Center → Apps and integrations → APIs → Zendesk API → enable Token access → Add API token*). Fill in the base URL (for systems that need one) and the credential fields. Secret fields are masked and are stored server-side only — you'll never see them again.
6. **Confirm the category** and choose your **Data handling** — *Fetch-only* (we look, never store) or *Ingest* (a searchable working copy). Add an optional **Display name** so you can tell two of the same system apart (e.g. "Zendesk — production").
7. Click **Test & Save.** DreamTeam saves the connector and immediately runs a live authentication test. A green toast confirms *"credentials verified live"*; if the test fails, the connector is still saved but marked with the honest error so you can fix the credential and test again.

## Options & settings
- **System category** — sets which canonical operations the DE may ask this system (a CRM answers "who is this customer?", a helpdesk answers "have we solved this before?"). You can change it on the connect form before saving.
- **Data handling** — *fetch-only* vs *ingest*. Knowledge-capable systems default to ingest; everything else defaults to fetch-only.
- **Display name** — optional label shown on the connector card.
- **Some systems connect by sign-in** instead of pasted keys (QuickBooks, Xero, Clio, Gusto, Procore, Jobber, Dropbox). For those the wizard shows a **Connect with…** button — see *Connecting OAuth (sign-in) apps*.

## Tips & best practices
- Use read-only or least-privilege credentials wherever the provider offers them (for example a Stripe **Restricted key**, or a scoped Shopify token). The credential help text calls out the safer option.
- Give production and sandbox connectors distinct display names so nobody points a DE at the wrong one.
- After connecting, use **Live search (read-through)** on the connector card to type a query and confirm the DE can actually find things.

## Troubleshooting
- **"saved, but the live test failed"** — the connector was created but the credentials were rejected. Click **Disconnect** and reconnect with a corrected token, or use **Test connection** on the card after fixing the credential.
- **"Connector tables not yet provisioned"** — the connector backend hasn't been set up for this workspace yet; contact your administrator.
- **The system I want isn't in the list** — build a **custom template** (rung 4) or, for a niche tool, the **Aggregator** is available on request. See *Supported systems*.

## Related articles
- how-credentials-are-kept-safe
- fetch-vs-ingest-modes
- connecting-oauth-apps
- custom-api-connector
- supported-systems
