---
title: What "Company Data" is and how your DEs use it
category: Company Data
feature: Company Data
audience: admin
difficulty: beginner
tags: [company data, records, entities, customers, accounts, context, system of record]
---

# What "Company Data" is and how your DEs use it

## What it is
**Company Data** is the section of the app that holds your business records — the people you serve (your customers or accounts), their deals, projects, tickets, and renewals. It's the working layer your Digital Employees read from and act on. In the sidebar it's the **COMPANY DATA** group.

## Why it matters
A Digital Employee is only as useful as the context it has. When Alex answers a support question, or Casey prepares a renewal, they pull from these records to know *who* they're dealing with and *where that relationship stands*. Company Data is what turns a generic answer into an accurate, account-aware one.

## Before you start
- Company Data is a **live-workspace** feature. Demo workspaces show illustrative preview data instead.
- **Your system of record stays your system of record.** This isn't a replacement CRM. It's a working cache and action workspace for your DEs. If you already have a CRM, the pipeline pages carry the fields needed to sync to it; if you don't, native entry and CSV import are your bootstrap.

## Step by step
1. Open **Company Data** in the sidebar (it may be collapsed by default — click to expand).
2. The top item is your served-party lifecycle — by default **Customers**, but relabelled to your own word if you've set your vocabulary (Patients, Clients, Orders, and so on).
3. Under it sit the lifecycle pipelines: **Business Development**, **Sales**, **Onboarding**, **Support**, **Success**, and **Renewal & Expansion** — each a live view of that stage.
4. Add records by hand, or click **+ Import** to bootstrap from a CSV export.

## Options & settings
- **The records spine.** The core object is the served-party record (an account/customer) with its related work — opportunities, onboarding projects, tickets, and renewals. Every one is tenant-scoped: you only ever see your own.
- **Custom fields.** You can add extra fields to the served-party record so it captures what *your* business tracks. See [customizing-vocabulary-and-fields](customizing-vocabulary-and-fields.md).
- **Vocabulary.** Every label in this section reads from your tenant vocabulary, so "Customers" becomes whatever you call the people you serve.

## How DEs use Company Data
- **As context for answers.** When a DE resolves an inquiry, it can pull account configuration and history into its evidence before answering — visible step-by-step in **DE at Work**.
- **As the thing it acts on.** Winning a deal in Sales creates the account and can kick off onboarding; a Renewal DE prepares an invoice against a real renewal record; a Success DE computes account health from real tickets, invoices, and activity.
- **As the drill-down from reports.** The **Outcomes** report's "Work in flight" tiles link straight back into these pipelines.

## Tips & best practices
- Import once to bootstrap, then let the lifecycle keep records current — winning, onboarding, and renewing all update the same records, so there's no re-entry.
- Set your **vocabulary and custom fields early** (ideally in Company Setup) so every page and every DE speaks your business's language from the start.
- Keep the served-party record accurate — it's the context your DEs reason from.

## Troubleshooting
- **A pipeline says "Workspace still provisioning."** The underlying tables haven't been created for this workspace yet; apply the pending migration and reload.
- **I see illustrative data on the Customer Lifecycle page.** In a live workspace, the journey-bar counts are illustrative while **Support, Success, Renewal, and Human Tasks are live** — the page says so at the top.

## Related articles
- [customer-pipelines](customer-pipelines.md)
- [customizing-vocabulary-and-fields](customizing-vocabulary-and-fields.md)
- [../performance-outcomes/outcomes](../performance-outcomes/outcomes.md)
