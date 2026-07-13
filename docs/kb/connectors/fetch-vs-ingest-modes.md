---
title: Fetch-only vs ingest — how a DE reads your systems
category: Connectors
feature: Connectors — Data handling
audience: admin
difficulty: intermediate
tags: [fetch-only, ingest, read-through, data handling, access mode, knowledge]
---

# Fetch-only vs ingest — how a DE reads your systems

## What it is
Every connector has a **Data handling** choice that decides what happens to your system's content:

- **Fetch-only** — DreamTeam reads the system **live** to answer a question and **never stores** its content. Only the citation trail (title, reference, a short snippet) is kept.
- **Ingest** — DreamTeam keeps a **searchable working copy** of knowledge content so it can be searched instantly. Your system stays the source of truth.

Your systems of record stay yours either way — DreamTeam works on top of them.

## Why it matters
The choice is about where your data lives and how fresh it is:

- **Fetch-only** is the most conservative: nothing leaves your system except at the moment a DE needs it, and nothing is retained. It's ideal for sensitive or fast-changing records (customers, tickets, invoices) where you never want a stored copy.
- **Ingest** trades a stored working copy for speed and semantic search across large document sets. It's how a DE can answer "what do our docs say about X?" across a whole knowledge base in one step.

## How each mode behaves
**Fetch-only (read-through):**
- The DE calls your system at question time, uses the result to answer, and discards it.
- On the connector card, **Live search (read-through)** shows this directly — *"Fetched at question time — nothing stored, audit event only."*
- The card is badged **fetch-only · never stored**.
- Trying to run **Sync knowledge** on a fetch-only connector is refused server-side, with the honest message: *"this connector is fetch-only by your choice — DreamTeam reads it live and never stores its content."*

**Ingest:**
- Available only for **knowledge-capable** systems — the ones that hold articles, pages, or documents.
- A **Sync knowledge** button appears on the card. Running it pulls documents into a searchable index; the toast reports how many documents were ingested and how many passages were indexed.
- The card is badged **ingest · working copy**.

## Which systems can ingest
Ingest is offered by knowledge-capable providers, including: **Zendesk, Salesforce, Confluence, Intercom, ServiceNow, Guru, Document360, SharePoint, Google Drive, Notion, Box,** and **Dropbox**. Everything else is read live (fetch-only). Document systems (SharePoint, Google Drive, Notion, Box, Dropbox) also get a **review-before-ingest** queue — see *Controlling what gets ingested*.

## Step by step — set or change the mode
1. When connecting, choose **Fetch-only** or **Ingest** under **Data handling** before you click **Test & Save**. Knowledge systems default to ingest; everything else defaults to fetch-only.
2. For an ingest connector, click **Sync knowledge** on the connector card to pull content into the searchable copy.
3. For fetch-only, there's nothing to sync — just use **Live search (read-through)** or let your DEs query it live.

## Zendesk — per-object modes
Zendesk goes a level deeper. Under **Objects — data mode** you can set each object type independently:
- **Sync (cached working copy)** — kept on a schedule you choose (15 min up to Daily). Tickets default to this.
- **Read-through (never stored)** — fetched at action time only. Users and organizations default to this.

## Tips & best practices
- Default to **fetch-only** for anything sensitive or personal; reserve **ingest** for reference content you want searched fast.
- Ingest keeps a *copy* — re-run **Sync knowledge** (or rely on scheduled sync where available) after big content changes so the copy stays current.
- Whichever mode you pick, every read is written to the Audit Trail.

## Troubleshooting
- **"Sync refused: this connector is fetch-only by your choice."** That's expected — switch the connector to ingest (reconnect and choose Ingest) if you want a stored copy, or keep reading it live.
- **No "Sync knowledge" button.** The provider isn't knowledge-capable, so only live read-through is available.
- **Search returns nothing on an ingest connector.** Run **Sync knowledge** first — an ingest connector has no working copy until its first sync.

## Related articles
- connecting-your-first-system
- controlling-what-gets-ingested
- how-credentials-are-kept-safe
- supported-systems
