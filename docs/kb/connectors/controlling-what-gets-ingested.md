---
title: Controlling what gets ingested (the review queue)
category: Connectors
feature: Connectors — Ingest control
audience: admin
difficulty: intermediate
tags: [ingest, review queue, filters, sharepoint, google drive, notion, box, dropbox, documents]
---

# Controlling what gets ingested (the review queue)

## What it is
For document connectors — **SharePoint, Google Drive, Notion, Box,** and **Dropbox** — the **What gets ingested** panel lets you set filters (by folder, name, and file type), scan the source to list candidate files, and **approve or reject each file before anything enters knowledge**.

## Why it matters
A document library can hold far more than a DE should ever read — drafts, HR files, archives, confidential material. Ingest control lets you decide exactly which files become searchable knowledge, and see the list before you commit. It's hygiene and review; the real security wall is least-privilege sharing at the source (see Tips).

## Before you start
- The connector must be one of: SharePoint, Google Drive, Notion, Box, or Dropbox.
- It should be in **ingest** mode (these are knowledge-capable systems).

## Step by step
1. Open **Connectors** and find the document connector's card.
2. Click **What gets ingested**. The ingest-control panel opens.
3. **Set your filters:**
   - **Folder / Shared Drive / sub-folder / path** — scope the sync to one folder. Leave blank to include everything shared with the app. (Notion scopes by which pages you've shared with the integration, so it has no folder field.)
   - **Exclude files/folders whose name contains** — a comma-separated list, e.g. `draft, confidential, archive, HR`. Any file or folder whose name contains one of these is skipped.
   - **Only ingest these file types** — toggle **PDFs, Documents (Word/Docs), Slides, Spreadsheets, Text / Markdown**. Leave all unchecked to allow every supported type.
   - **Review before ingest** — when on (the default), nothing enters knowledge until you approve it here.
4. Click **Save settings.** Filters are saved; the toast reminds you to run a scan to apply them.
5. Click **Scan for documents.** DreamTeam lists the files that match your filters into the **Review queue** — *nothing is stored yet*. The toast reports how many matched and how many are new to review.
6. **Review the queue.** Each row shows the file type, title, and path, with a status badge: **Awaiting review**, **Approved**, **Excluded**, or **In knowledge**. Approve or exclude files:
   - Per file: **Approve** / **Exclude**.
   - In bulk: **Approve all** / **Exclude all** for everything pending.
7. Click **Sync knowledge** on the connector card to ingest. With review on, only **approved** files are ingested; the panel confirms *"N file(s) approved — click Sync knowledge above to ingest them."*

## Options & settings
- **Review before ingest (on/off).** On: approvals gate ingest. Off: *"Sync knowledge ingests every file that matches your filters directly"* — no per-file approval.
- **Folder scope**, **exclude patterns**, and **file-type allow-list** together decide what the scan surfaces.
- **Statuses:** *Awaiting review* (pending), *Approved* (will ingest), *Excluded* (rejected, won't ingest), *In knowledge* (already ingested).

## Tips & best practices
- Filters are **hygiene, not a security wall.** The panel says so directly. The real wall is **least privilege at the source:**
  - **Google Drive** — share only the intended folder(s) with the service account; it sees nothing else.
  - **Notion** — share only the intended pages with the integration; it sees nothing else.
  - **Box** — grant the app access to only the intended folders in the Box Admin Console.
  - **Dropbox** — share only the intended folder(s) with the app, or scope the app folder.
  - **SharePoint** — grant `Sites.Selected` on one dedicated site rather than `Sites.Read.All`.
- Re-scan after adding documents at the source so new files appear in the queue.
- Use exclude patterns like `draft` and `confidential` as a safety net even when you've scoped the folder tightly.

## Troubleshooting
- **"discover not supported for provider"** — the connector isn't a document connector; the review queue only applies to SharePoint, Google Drive, Notion, Box, and Dropbox.
- **Scan finds nothing** — check the folder scope and exclude patterns aren't filtering everything out, and confirm the app actually has access to the folder at the source.
- **Approved files didn't ingest** — you still need to click **Sync knowledge** on the card after approving; the scan and approval steps never store content on their own.

## Related articles
- fetch-vs-ingest-modes
- how-credentials-are-kept-safe
- connecting-your-first-system
- supported-systems
