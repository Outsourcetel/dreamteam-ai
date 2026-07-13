---
title: Adding documents to the Knowledge Library
category: Knowledge
feature: Knowledge Library
audience: admin
difficulty: beginner
tags: [knowledge, library, upload, pdf, url, paste, indexing, tags]
---

# Adding documents to the Knowledge Library

## What it is
The Knowledge Library is where you add and manage the documents your Digital Employees answer from. You can paste text, upload a file, or import a page from a URL. Everything you add here becomes available to your DEs.

## Why it matters
Your DEs only know what's in this library. Adding your FAQs, policies, product docs, and help-center articles is how you give them a brain. The page header says it plainly: *"These documents are the only thing your DE answers from — keep them current."*

## Before you start
- You need access to your workspace's **Knowledge → Library** page.
- Have the content ready: text to paste, a file to upload, or the URL of a page to import.

## Step by step

### Option A — Paste text
1. Open **Knowledge → Library**.
2. Click **+ Add document**.
3. Enter a **Title** (e.g. "Refund policy").
4. Paste your content into the **Content** box. Plain text or Markdown both work.
5. Optionally add **Tags** (comma-separated, e.g. `billing, refunds`). Tags group documents into "collections" on the Quality & Coverage page.
6. Click **Add document**. The document is saved and then automatically indexed so your DEs can find it by meaning as well as by keyword.

### Option B — Upload a file
1. On **Knowledge → Library**, click **Upload file**.
2. Choose a file. Supported types: **`.txt`, `.md` / `.markdown`, and `.pdf`**.
3. For a PDF, the platform extracts the text for you (you'll see "Extracting text from …"). Text and Markdown files are read directly.
4. The document appears in the list and is indexed automatically.

### Option C — Import from a URL
1. Click **Import from URL**.
2. Paste a full `http(s)` link — for example your public help-center article.
3. Click **Fetch & add**. The platform reads the page, strips the layout, and saves the readable text as a new document.

## Options & settings
- **Title** — how the document is identified in the Library and, when cited, in a DE's answer.
- **Content** — the text your DEs answer from. Keep it focused; one topic per document generally retrieves better than one giant document.
- **Tags** — optional labels used to organize documents and to build the per-tag coverage view on Quality & Coverage.
- **Edit / Delete** — every document can be edited or removed from its row. Editing re-indexes it automatically.

## Understanding the columns
- **Source** — how the document got here: `paste`, `upload`, or `connector` (synced from a connected system).
- **Retrieval** — the indexing status:
  - **Indexed · N chunks** — fully searchable by meaning and keyword.
  - **Indexing…** — indexing is in progress.
  - **Keyword only** — not yet indexed; it still works but only exact-word matches will find it.
- **Who can use this** — which DEs can retrieve it. See *scoping-knowledge-to-a-de*.
- **Updated** — when the document last changed.

## Limits & supported types
- **File uploads:** `.txt`, `.md`/`.markdown`, and `.pdf` only. Other formats (e.g. `.docx`) aren't accepted through the uploader today — convert or paste the text instead.
- **PDF size:** up to **15 MB**.
- **Document length:** up to about **500,000 characters** of extracted text per document.
- **Scanned/image-only PDFs:** these have no selectable text, so extraction can't read them. You'll get a clear message that OCR isn't supported yet — paste the text or use a text-based version.
- **URLs:** must be public `http(s)` pages. Internal or private addresses are blocked by a safety policy, and each fetch times out after about 15 seconds.

## Tips & best practices
- Break large manuals into focused documents. Retrieval works on passages, and tightly-scoped documents produce cleaner citations.
- Give documents clear, descriptive titles — the title is what shows as the cited source in an answer.
- After adding several documents, glance at the **Retrieval** column to confirm they show **Indexed** rather than **Keyword only**.

## Troubleshooting
- **"Workspace still provisioning" notice** — the knowledge tables haven't been created for this workspace yet. Contact your administrator; the page tells them exactly which setup step is missing.
- **A PDF failed to import** — it's likely a scanned image. Use a text-based PDF or paste the content.
- **A document stays on "Keyword only"** — indexing runs in the background and is resumable; large documents finish in stages. Reload the page after a moment. Keyword search still works in the meantime.

## Related articles
- how-knowledge-powers-your-des
- ingestion-and-sources
- scoping-knowledge-to-a-de
- quality-and-coverage
