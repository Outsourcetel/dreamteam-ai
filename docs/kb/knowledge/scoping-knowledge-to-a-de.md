---
title: Scoping a document to a specific Digital Employee
category: Knowledge
feature: Knowledge Library
audience: admin
difficulty: intermediate
tags: [scoping, visibility, per-de, accuracy, permissions, specialists]
---

# Scoping a document to a specific Digital Employee

## What it is
By default, every document in your Knowledge Library is available to **all** your Digital Employees and specialists. Scoping lets you limit a specific document so that **only selected** DEs (or specialists) can use it when answering.

## Why it matters
Not every document belongs to every DE. A refund-policy document should feed your Support DE, not your HR DE. Scoping keeps each DE focused on the knowledge relevant to its role, which:

- **Improves accuracy** — a DE can't cite a document meant for another team.
- **Prevents cross-role leakage** — sensitive or team-specific content stays with the DEs that should see it.
- **Reduces noise** — retrieval has fewer, more relevant passages to choose from.

## How the default works
- A document with **no scope set** is **tenant-wide**: every DE and specialist can retrieve it. In the Library, its "Who can use this" badge reads **All digital employees**.
- A document you've limited shows a badge like **Scoped · 2**, meaning only 2 selected team members can use it.

## Step by step
1. Open **Knowledge → Library**.
2. Find the document and click its badge in the **Who can use this** column.
3. In the **Who can use this document?** window, you'll see a list of your Digital Employees and specialists.
4. **Tick the ones** that should be able to use this document.
5. Click **Limit to N selected**. (If you leave everything unticked, the button reads **Allow everyone** and the document goes back to tenant-wide.)
6. The change is saved and takes effect on the very next answer.

## Options & settings
- **Leave all unticked → everyone.** Removing all selections restores tenant-wide visibility.
- **Digital Employee vs Specialist.** Each entry is tagged so you can tell DEs and specialists apart when choosing.
- **Per document.** Scoping is set one document at a time; there's no bulk scope today.

## How scoping is enforced
Scoping isn't just a display setting — it's enforced **server-side, at answer time**. When a DE retrieves knowledge, the system only returns documents that are either tenant-wide or explicitly scoped to that DE. A scoped document will never surface to a DE that isn't on its list, and it won't leak through any un-attributed path.

Every scope change is **recorded in the audit trail**, and any cached answers that were built from the document are cleared automatically so a scope change can't be bypassed by an old cached reply.

## Tips & best practices
- Scope role-specific content (HR policies, finance procedures) to the relevant DE rather than leaving it tenant-wide.
- Keep genuinely shared references (company overview, brand voice) tenant-wide so every DE benefits.
- If a DE is citing something it shouldn't, check that document's scope first — it may be tenant-wide when it should be limited.
- Use the **Quality & Coverage** page to see, per tag, which DEs a collection of documents actually reaches.

## Troubleshooting
- **The scope window shows "No digital employees or specialists in this workspace yet."** Create at least one DE first; there's nothing to scope to yet.
- **A DE stopped answering from a document after scoping.** That's expected if the DE wasn't on the selected list — re-open the scope and add it.
- **A newly scoped document still answered once from cache.** Cached answers are invalidated on a scope change; reload and retry — the fresh answer will respect the new scope.

## Related articles
- how-knowledge-powers-your-des
- adding-documents-to-the-library
- quality-and-coverage
