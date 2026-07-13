---
title: Quality & Coverage — keeping your knowledge accurate and fresh
category: Knowledge
feature: Quality & Coverage
audience: admin
difficulty: intermediate
tags: [quality, coverage, freshness, calibration, citations, stale, re-verify]
---

# Quality & Coverage — keeping your knowledge accurate and fresh

## What it is
The **Quality & Coverage** page tells you how healthy your knowledge base actually is: which Digital Employees each collection reaches, how fresh your documents are, and which documents are producing answers that don't hold up against human feedback. Everything on it is computed from your real documents and real answer history.

## Why it matters
A knowledge base decays quietly. Documents go stale, some are never cited, and a DE can be confidently wrong about a topic that changed months ago. This page turns those invisible problems into a short list of things to fix.

## What's on the page
Open **Knowledge → Quality & Coverage**. If you have no documents yet, it shows an honest empty state explaining what will appear once documents exist.

### Coverage matrix
A grid of **tags (collections) × Digital Employees**. For each tag, it shows the percentage of that tag's documents each DE can actually use — accounting for scoping. A tenant-wide document counts toward every DE; a scoped document only counts toward the DEs it's limited to. This is how you spot a DE that's missing a whole collection it should have.

(If no documents are tagged, or you have no DEs yet, the matrix explains that instead of showing an empty grid.)

### Freshness
A histogram of your documents by time since they were last verified (or created, if never verified):
- **0–30d**, **31–60d**, **61–90d**, and **>90d stale**.

The stale bucket is the one to watch.

### Confidence calibration
A list of documents that have actually been **cited in answers** and where the DE's confidence disagreed with how humans rated those answers:
- **Overconfident** — the DE was confident, but humans rated the answers as needing improvement.
- **Underconfident** — the DE hedged, but humans consistently rated the answers accurate.

Each entry shows how many times the document was cited and the accurate-vs-needs-improvement split. If nothing has enough citations and feedback yet, the page says so rather than inventing calibration data.

### Stale queue
A table of documents unverified for **more than 90 days**, sorted oldest first, with their tags, last-verified date, and citation count.

## Step by step — clear the stale queue
1. Open **Quality & Coverage** and scroll to **Stale queue**.
2. For each document, read it and confirm it's still correct.
3. Click **Re-verify** to stamp it as verified today. This is a clean bill of health — it does **not** change the document's content, just records that a human confirmed it's still accurate.
4. If a document is no longer correct or needed, click **Delete** to remove it. (Deleting is permanent — the DE can no longer cite it.) To fix rather than remove it, edit it in the Knowledge Library instead.

## Understanding "verified" vs "updated"
- **Updated** reflects the last time the content changed.
- **Verified** is a separate, human "I checked this is still accurate today" stamp. A document can be verified without being edited — that's the whole point of re-verification.

## Tips & best practices
- Re-verify on a schedule for anything that changes with regulation, pricing, or product releases.
- Investigate **Overconfident** documents first — those are where a DE is most likely giving customers a wrong answer with a straight face.
- A document with **zero citations** may be unfindable (check its indexing status in the Library) or simply redundant.
- Tag your documents consistently — the coverage matrix is only as useful as your tags.

## Troubleshooting
- **Coverage matrix is empty** — you have no tagged documents or no DEs yet. Add tags in the Library, or create a DE.
- **Calibration section is empty** — no document has been cited enough, with enough human feedback, to compare. This fills in as your DEs answer and humans review.
- **A fresh document shows as stale** — freshness falls back to the creation date until it's first verified. Re-verify it to reset the clock.

## Related articles
- how-knowledge-powers-your-des
- adding-documents-to-the-library
- gap-detection
- self-learning
