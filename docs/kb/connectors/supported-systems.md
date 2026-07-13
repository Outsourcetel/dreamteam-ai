---
title: Supported systems (the full connector catalog)
category: Connectors
feature: Connectors — Catalog
audience: admin
difficulty: beginner
tags: [supported systems, catalog, providers, categories, gated, aggregator, on request]
---

# Supported systems (the full connector catalog)

## What it is
DreamTeam ships first-party connectors across every major system category, plus two ways to reach anything else. This article lists what's in the picker and is honest about what needs extra steps or is available on request.

## Why it matters
Your Digital Employees speak in **categories** — "the CRM", "the helpdesk", "the knowledge base" — and whichever system you connect answers. Knowing the catalog helps you pick the right connector, and know what to do when your exact tool isn't listed.

## The catalog by category
**CRM** — HubSpot, Salesforce, Microsoft Dynamics 365, Pipedrive, Close.

**Helpdesk** — Zendesk, Freshdesk, Freshservice, ServiceNow, Gorgias, Front, Kustomer, Jira, Intercom.

**Knowledge base** — Confluence, Notion, SharePoint, Google Drive, Box, Dropbox, Slack, Microsoft Teams, Guru, Document360, GitBook, Coda, Contentful.

**ERP / Financials** — QuickBooks Online, Xero, NetSuite.

**Billing** — Stripe.

**Payroll / HCM** — Gusto, BambooHR.

**Point of sale** — Shopify, WooCommerce, BigCommerce, Square, Toast.

**Product systems & work tools** — GitHub, GitLab, Asana, ClickUp, monday.com, Linear, Smartsheet, Wrike, Trello, Datadog, PagerDuty, Sentry, Greenhouse, Lever, Buildium, Canvas LMS, Clio, Procore, Jobber, Okta, Typeform, Calendly, PowerSchool, Ellucian (Banner/Colleague), plus **Your product API** (generic REST).

**Other** — Twilio, Mailchimp, athenahealth, Epic, Oracle Health (Cerner).

*(Categories aren't rigid — you can point most connectors at a different category on the connect form. HubSpot, for example, covers both CRM and Service Hub tickets depending on the category you choose.)*

## Which systems can ingest knowledge
Most connectors are read-live (fetch-only). These can also **ingest** a searchable copy of their content: Zendesk, Salesforce, Confluence, Intercom, ServiceNow, Guru, Document360, SharePoint, Google Drive, Notion, Box, and Dropbox. See *Fetch vs ingest modes*.

## Which systems connect by sign-in (OAuth)
QuickBooks Online, Xero, Clio, Gusto, Procore, Jobber, and Dropbox connect by signing in rather than pasting a key — a platform admin registers the developer app once first. See *Connecting OAuth (sign-in) apps*.

## Honest notes — what needs extra steps
- **Gated by the vendor.** Some systems can't connect until a third party enables access:
  - **PowerSchool** needs a district-installed plugin before it provides credentials.
  - **Ellucian (Ethos)** needs an institution entitlement.
  - **Toast** requires an approved integration-partner account.
- **PHI systems require a signed BAA.** **athenahealth, Epic,** and **Oracle Health (Cerner)** touch patient data — a Business Associate Agreement must be in place before connecting real records. The connector says so plainly and should not be connected without it.
- **The Aggregator (hundreds of niche tools)** is shown in the picker as **available on request** — *"built when the first customer needs it (honest, not pretend-integrated)."* It's rung 2 of the connection ladder.
- **Anything not listed** — use rung 4 (**Your product API** or a custom **template**) or rung 5 (**upload files into Knowledge**). See *Connecting a custom or unlisted system*.

## The 5-rung connection ladder
DreamTeam picks the most direct route to any system:
1. **MCP server** — if your system publishes one, register it under Specialist sources.
2. **Aggregator** — one connection covering the long tail (available on request).
3. **Named adapter** — the built-in connectors listed above.
4. **Any other system** — a template or the generic REST connector (configuration, not code).
5. **File import** — no API? Upload documents into Knowledge.

## Tips & best practices
- Match the connector to what the DE actually needs to answer, and set the **category** accordingly.
- For gated or PHI systems, complete the vendor's prerequisites (plugin, entitlement, partner approval, BAA) *before* attempting to connect.
- Can't find your tool? Don't wait — build a template or upload the source documents.

## Troubleshooting
- **My system is listed but won't connect** — check whether it's gated (needs vendor enablement) or PHI (needs a BAA).
- **"Registers now — adapter not built yet"** — if a system ever shows this note, it can be saved but calls return an honest "not implemented" until the adapter ships.
- **I need a niche tool that isn't here** — request the Aggregator, or connect it as a custom template.

## Related articles
- connecting-your-first-system
- fetch-vs-ingest-modes
- connecting-oauth-apps
- custom-api-connector
- controlling-what-gets-ingested
