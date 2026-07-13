---
title: Connecting a custom or unlisted system (REST API & templates)
category: Connectors
feature: Connectors — Custom API & Template builder
audience: admin
difficulty: advanced
tags: [generic rest, custom api, template builder, template library, no code, product api]
---

# Connecting a custom or unlisted system (REST API & templates)

## What it is
If your system isn't in the picker, you have two no-code routes:

- **Your product API** — the generic REST connector: point DreamTeam at any JSON REST API by giving it a search endpoint (and optionally a record endpoint).
- **The template library & builder** — turn a system's API into a reusable **template** so it (and anyone else on your workspace) can connect to it like a first-class provider.

Both are **configuration, not code.**

## Why it matters
No connector catalog covers every tool. This is rung 4 of DreamTeam's connection ladder — *"Any JSON REST API: use a template from the library, or build one in five guided steps."* It means your own product, an internal service, or a niche vendor can back a Digital Employee without waiting for a built-in adapter.

## Option A — the generic "Your product API" connector
Best for a one-off connection to a single API.

1. **Connectors → + Connect a system**, pick a category, then choose **Your product API** (provider icon 🔌).
2. Enter the **API base URL** (e.g. `https://api.yourproduct.com`).
3. If the API needs a key, fill the optional **Auth header name** (e.g. `Authorization`) and **Auth header value** (e.g. `Bearer …`). The value is stored server-side, never shown again.
4. Tell DreamTeam **how to search this API:**
   - **Search path** — the endpoint path, e.g. `/users`.
   - **Query param** — the parameter that carries the search text (defaults to `q`).
   - **Items path in the response** (optional) — where the list lives in the JSON, e.g. `data.results`. Leave blank if the response is already a list.
   - **Record path** (optional) — a path template to fetch one record, using `{ref}` for the id, e.g. `/users/{ref}`.
5. Choose the **category** and **data handling**, then **Test & Save.**

## Option B — build a reusable template (5 guided steps)
Best when you want the system to look and behave like a named provider, or to connect several instances of it.

Open **Connectors** and, in the **Template library** section, click **+ Build a custom template.** The builder walks through five steps:

1. **What system is this?** — name it and pick its category.
2. **How does it check who you are?** — choose the auth style (for example an API-key header, or OAuth2 client-credentials with a token URL).
3. **Where does it live?** — the base URL template, with any `{variables}` you want filled in per connection.
4. **What may DreamTeam ask it?** — bind the category's canonical operations (search / get) to real endpoints, and use **Test now (live call)** to run one operation against credentials entered in the builder. The builder shows the **raw response** side by side with the extracted results, so you can confirm the mapping before saving. Those test secrets travel in-flight only and are never stored.
5. **Save & publish.** Save keeps it as an editable **draft** (invisible to the connect flow); **Publish** makes it available in your workspace's **Template library** so connectors can be created from it.

**Connecting from a template:** in the Template library, click a published template's **Use** action, enter your credentials and any variables, choose the data-handling mode, and DreamTeam runs a live test as it creates the connector.

## Options & settings
- **Field mapping** — after connecting either way, use **Field mapping** on the connector card if your system names fields differently. Map the canonical fields (**title, snippet, url, external_ref**) to your field names; leave any blank to keep the sensible default.
- **Variables** (templates) — let one template serve many instances (for example a per-customer subdomain).
- **Draft vs published** (templates) — drafts stay editable and hidden; only published templates appear in the connect flow.

## Tips & best practices
- Start with the operation you most need (usually search) and confirm it with **Test now** before binding the rest.
- Prefer a scoped, read-only key in the auth header.
- If you'll connect the same kind of system more than once, build a **template** rather than repeated generic connectors — it's reusable and cleaner.
- Set the **items path** carefully: if search returns nothing but the raw response clearly has results, the items path is usually pointing at the wrong place in the JSON.

## Troubleshooting
- **"A search endpoint path is required"** — the generic connector needs at least a search path so DreamTeam knows how to look things up.
- **Test returns the raw JSON but no items** — adjust the **items path** to where the list actually sits in the response.
- **Template doesn't appear in the connect flow** — it's still a draft; publish it.
- **Auth rejected** — recheck the header name/value or the template's auth recipe and token URL.

## Related articles
- connecting-your-first-system
- how-credentials-are-kept-safe
- supported-systems
- actions-what-des-can-do-in-your-systems
