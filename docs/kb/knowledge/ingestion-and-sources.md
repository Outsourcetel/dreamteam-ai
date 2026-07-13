---
title: Ingestion & Sources — syncing content from connected systems
category: Knowledge
feature: Ingestion & Sources
audience: admin
difficulty: intermediate
tags: [ingestion, sources, connectors, sync, pipeline, review-gate]
---

# Ingestion & Sources — syncing content from connected systems

## What it is
The **Ingestion & Sources** page shows the connected systems that feed your knowledge base and lets you pull their content in. When you sync a source like a wiki or help desk, its content is imported as knowledge documents, then automatically split and indexed so your Digital Employees can answer from it.

## Why it matters
Most of your knowledge already lives somewhere — Zendesk macros, a Confluence wiki, a Salesforce knowledge base. Rather than copy-pasting it all, you connect the system once and sync it here. The page also makes the processing pipeline visible so you can see how much content has actually been ingested and indexed.

## Before you start
- You need at least one **connector** set up on the **Connectors** page. If none is connected, this page shows *"No sources connected yet"* with a button to **Go to Connectors**.
- Only some providers support knowledge sync. Providers that are lookup-only ("fetch-only") don't store content and can't be synced here.

## The processing pipeline
At the top of the page, four tiles show real counts across your connector-sourced content:

1. **Sources** — connected systems that are healthy (e.g. "3 / 4").
2. **Ingested** — documents synced in from those systems.
3. **Chunked** — documents split into passages for retrieval.
4. **Embedded** — passages indexed for meaning-based search.

These are live numbers from your workspace, not estimates.

## Step by step — sync a connected source
1. Open **Knowledge → Ingestion & Sources**.
2. Find the source in the **Connected sources** table. Its **Status** shows Healthy, Degraded, Down, or Never connected.
3. Click **Sync now** on that row.
4. When it finishes, a message confirms how many documents were synced, chunked, and embedded.
5. The synced documents now appear in the Knowledge Library with a **connector** source label.

If a source shows **fetch-only** or **no sync** instead of a button, that provider either looks content up live (never storing it) or doesn't support knowledge sync.

## Step by step — add a document directly
You don't have to have a connector to add content here:

1. Click **Add a document**.
2. Enter a title and paste the content.
3. Click **Add & index**. It's chunked and indexed immediately, exactly like the Library's paste flow.

## An important, honest note about review
**Synced content goes straight into the knowledge base — there is no draft or review gate on connector-sourced content today.** The page says this directly. Once you click **Sync now**, those documents become answerable by your DEs without an approval step in between.

What this means for you:
- Only sync sources whose content you trust to be customer- or staff-facing as-is.
- You remain fully in control after the fact: you can **edit or remove any synced document** from the Knowledge Library at any time, and scope it to specific DEs.
- If you need a review step, add content through the Library manually rather than syncing, and review before it goes live.

## Tips & best practices
- Re-sync periodically to keep imported content current — synced documents don't update themselves between syncs.
- After a large sync, check the **Embedded** tile and the Library's **Retrieval** column to confirm content is indexed, not just ingested.
- Use scoping to limit a synced source to the DEs it's relevant to, rather than exposing everything to everyone.

## Troubleshooting
- **Sync failed** — the message shows the reason (often an expired credential or a down source). Re-check the connector on the Connectors page.
- **No "Sync now" button** — the provider is fetch-only or doesn't support knowledge sync; its content is looked up live rather than stored.
- **Synced docs not answering** — confirm they show **Indexed** in the Library and aren't scoped away from the DE you're testing.

## Related articles
- adding-documents-to-the-library
- scoping-knowledge-to-a-de
- how-knowledge-powers-your-des
