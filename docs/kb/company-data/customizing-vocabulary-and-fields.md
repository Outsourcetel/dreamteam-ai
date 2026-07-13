---
title: Renaming entities and adding custom fields
category: Company Data
feature: Vocabulary & Custom Fields
audience: admin
difficulty: intermediate
tags: [vocabulary, custom fields, relabel, pipeline stages, industry, patients, clients, orders]
---

# Renaming entities and adding custom fields

## What it is
DreamTeam ships with sensible defaults (you serve "Customers", your value metric is "ARR"), but you can relabel the whole workspace to your own business's language and add extra fields to your records. Three things are configurable: your **vocabulary**, your **pipeline stages**, and **custom fields** on the served-party record.

## Why it matters
A clinic serves Patients, not Customers. A law firm serves Clients. An e-commerce operation tracks Orders. Forcing everyone into "Customer / ARR" makes the product feel wrong and confuses your Digital Employees' output. Configuring these once makes every page — and every DE reply — speak your language.

## Before you start
- These settings are for a **live workspace** (the demo tenant's settings are locked).
- Changing settings requires being an **owner or admin** of your organization.
- Anything you leave blank simply falls back to the default, so existing workspaces change nothing until you choose to.

## Step by step

### Set your vocabulary
1. Open **Settings** → the **General** area, and find the **Your vocabulary** panel.
2. Fill in the fields you want to change:
   - **You serve one…** — the singular noun (e.g. *Patient*, *Client*, *Order*). Default: *Customer*.
   - **…and many** — the plural (e.g. *Patients*). Default: *Customers*.
   - **Value metric** — what you call the money figure (e.g. *Contract value*, *Care value*). Default: *ARR*.
   - **Recurring commitment** — your renewal noun (e.g. *Re-enrollment*, *Reorder*). Default: *Renewal*.
   - **DE reply language** and **DE tone of voice** — how your Digital Employees write (every DE answer honors these).
3. Click **Save Changes**. The relabelling takes effect across live pages.

### Configure pipeline stages and custom fields (via Company Setup)
The **Company Setup** wizard seeds your vocabulary, pipeline stages, and custom fields from your chosen **industry** in one pass:
1. Run **Company Setup** and pick your industry.
2. It applies the industry's vocabulary to your workspace, sets the matching **pipeline stages**, and adds the industry's suggested **custom fields** to your served-party record.
3. These are starting points — all of them are editable afterward.

### Where custom fields appear
Once a custom field exists, it shows up on the served-party records automatically — for example on the **Success** page, where each custom field becomes a column in the account table and an input when you add a new account (typed as text, number, or date).

## Options & settings
- **Vocabulary** is stored on your organization and read by every live surface — pipelines, the Won handoff, Success, and reporting all use it.
- **Pipeline stages** are name-and-order configurable. The first stage is your Business Development lens; everything after is the Sales lens. The server won't silently drop a stage that's in use, so reconfiguring is safe.
- **Custom fields** each have a **key**, a **label**, and a **type** (text, number, or date). They're added, not overwritten — setting up again skips keys that already exist.

## Tips & best practices
- Do this in **Company Setup at the start** if you can — it seeds all three from your industry, so you begin in your own language rather than retrofitting later.
- Keep custom fields to what you'll actually use in a DE's reasoning or your reports; every field is another thing to keep accurate.
- If a default word is close enough, leave it — blank means "use the default", which keeps things simple.

## Troubleshooting
- **"Only an owner or admin may change these settings."** You need the owner or admin role on this organization. Ask whoever set up the workspace.
- **A vocabulary field didn't seem to change anything.** Blank values fall back to defaults; make sure you typed a value and saved. Relabelling applies to live pages, not the demo workspace.
- **Custom fields didn't seed during setup.** Setup never blocks on custom fields — if the step is skipped, add them again later; existing keys are left untouched.

## Related articles
- [company-data-overview](company-data-overview.md)
- [customer-pipelines](customer-pipelines.md)
- [../getting-started/company-setup-wizard](../getting-started/company-setup-wizard.md)
