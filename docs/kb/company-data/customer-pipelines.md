---
title: The customer lifecycle pipelines (BD through Renewal)
category: Company Data
feature: Customer Lifecycle
audience: admin
difficulty: intermediate
tags: [pipeline, business development, sales, onboarding, support, success, renewal, lifecycle]
---

# The customer lifecycle pipelines (BD through Renewal)

## What it is
The customer lifecycle is one relationship followed end-to-end across six stages — **Business Development**, **Sales**, **Onboarding**, **Support**, **Success**, and **Renewal & Expansion**. Each is a live page under **Company Data**, and they share data so there are no handoffs and no re-entry between stages.

## Why it matters
Most tools split a customer across a CRM, a helpdesk, an onboarding tracker, and a renewals spreadsheet. Here it's one spine: a prospect qualifies into a deal, a won deal becomes an account with onboarding, that account is supported and its health watched, and its renewal is prepared — all on the same records your Digital Employees act on.

## Before you start
- These are **live-workspace** pages. The top-level **Customer Lifecycle** overview notes that its journey-bar counts are illustrative while **Support, Success, Renewal, and Human Tasks are live**.
- **Your CRM stays your CRM.** Each pipeline page carries a banner saying so — it's a working cache for your DEs, with native entry and CSV import as the bootstrap and CRM sync arriving with the Salesforce/HubSpot connector.

## Step by step — the stages

1. **Business Development** — the top-of-funnel lens. Add prospects with **+ Add prospect**, or bootstrap from a CRM export with **+ Import CSV**. Click **Qualify →** on a prospect to move it into Sales. BD and Sales are the *same* pipeline data seen through two lenses — qualifying is just a stage move, not a re-entry.
2. **Sales** — the deal lens: qualified → proposal → negotiation → won/lost. Change a deal's **Stage** inline. Editing lets you set the **Amount** and **Close date**. Choosing **✓ Won…** opens the account and hands off to onboarding; **✗ Lost…** requires a reason (lost reasons feed your win/loss learning).
3. **Onboarding** — when a deal is won you can start onboarding immediately against a published template (there's a 10-step starter template if you haven't built one). This tracks the new account's setup to completion.
4. **Support** — the live ticket view for the account; where a Support DE resolves inquiries and escalates the ones it can't.
5. **Success** — account health computed from real tickets, invoices, and activity, surfacing at-risk accounts before they churn.
6. **Renewal & Expansion** — prepares renewals and invoices against real records; larger amounts route to a human for approval (which lands in **Approvals & Drafts**).

## Options & settings
- **The Won handoff.** Closing a deal as won lets you create a new served-party record or link an existing one, optionally set its value metric to the deal amount, and start onboarding with a chosen template — all in one modal, no re-keying.
- **Configurable stages.** The pipeline stages aren't fixed. Each pipeline reads your tenant's configured stages (name and order), so BD is your first stage and Sales is everything after it. Summary cards render one per configured stage. See [customizing-vocabulary-and-fields](customizing-vocabulary-and-fields.md).
- **Source tags.** Every opportunity shows whether it was entered natively or came from an import/connector, so you always know a record's origin.

## Tips & best practices
- Bootstrap BD/Sales once via **Import CSV** — the importer auto-maps common column names (company, stage, amount, close date, owner) and reports any row errors.
- Let the lifecycle do the linking: **Won** creates the account, onboarding, health, and renewal path from a single action. Don't create those records by hand.
- Always give a real **lost reason** — it's required, and it's what powers win/loss insight later.

## Troubleshooting
- **"No open deals."** Qualify prospects in Business Development to fill the Sales pipeline — the two share one dataset.
- **Won deal but no onboarding started.** Onboarding only kicks off if you left "Start onboarding immediately" checked *and* a published template exists. Install the starter template from the Won modal if you have none.
- **A pipeline page won't load / "still provisioning."** The tables for that pipeline haven't been created for this workspace; apply the pending migration and reload.

## Related articles
- [company-data-overview](company-data-overview.md)
- [customizing-vocabulary-and-fields](customizing-vocabulary-and-fields.md)
- [../tasks-approvals/approvals-and-drafts](../tasks-approvals/approvals-and-drafts.md)
