---
title: Gap Detection — finding questions your DEs couldn't answer
category: Knowledge
feature: Gap Detection
audience: admin
difficulty: intermediate
tags: [gap-detection, clusters, low-confidence, revision, review, self-healing]
---

# Gap Detection — finding questions your DEs couldn't answer

## What it is
Gap Detection automatically notices when your Digital Employees keep failing to answer the same kind of question well, groups those questions into a **gap**, drafts a proposed knowledge update, and hands it to you to approve. It's the platform noticing its own blind spots — no manual flagging required.

## Why it matters
You can't fix a knowledge gap you don't know about. Individually, a single low-confidence answer isn't worth acting on. But when several similar questions keep scoring low with no matching document, that's a real, recurring gap worth closing. Gap Detection surfaces exactly those patterns so you spend your time on fixes that matter.

## How it works
This runs **automatically, roughly every 5 minutes**:

1. **Signal.** An answered question scores below your workspace's confidence floor **specifically because no knowledge covered it** (not because of a blocked connector or a guardrail — those are handled elsewhere). That's a gap *candidate*.
2. **Clustering.** Candidate questions are compared by meaning and grouped with similar ones. A lone low-confidence answer is never actioned on its own.
3. **Promotion.** Once a cluster crosses your configured **minimum size** within a set **time window**, it's promoted into a proposed **knowledge update** — a real draft awaiting review.
4. **Human review.** You approve or reject. Approving publishes the update to the knowledge base immediately. Nothing is ever auto-published.
5. **Recurrence check.** If a gap you already fixed starts collecting new questions again, it reopens with higher severity — a signal that the earlier fix didn't actually work.

## What you'll see on the page
Open **Knowledge → Gap Detection**. A strip at the top shows the loop: **Gap detected → Draft pending review → Resolved**, with live counts.

The table lists each detected gap with:
- **Gap** — the representative question (or the proposed title once a draft exists), and when it was first seen.
- **Category** — the area it falls under, or "any".
- **Members** — how many similar questions are in the cluster.
- **Affected DE** — which Digital Employee the questions were asked of.
- **Severity** — Low, Medium, High, or **Recurred after fix**.
- **Status** — **Open**, **Draft pending review**, or **Resolved**.

## Step by step — review and resolve a gap
1. Click a gap row to open its detail panel.
2. Read **Signal — the questions behind this pattern**: the real questions in the cluster, each with how similar it is to the representative one.
3. If a draft exists, read **Proposed knowledge update** — a title and body assembled from the evidence.
4. Choose:
   - **Approve & publish** — the knowledge base is updated immediately, and the gap is marked Resolved.
   - **Reject** — the gap reopens and keeps accumulating for the next detection pass.

For a gap still marked **Open**, the panel tells you how many more similar questions are needed before it's promoted to a reviewable draft.

## Where the proposed text comes from
The proposed update is **assembled server-side from real evidence** — the current document (if any), the cluster's questions, and reviewer notes — not free-form model writing. The same approve/reject actions here also appear as "knowledge" items in your Human Tasks queue; this page is just a richer, gap-focused view of the same real work.

## Honest empty state
A new or quiet workspace will show **"No knowledge gaps detected yet."** That's not a bug — it means nothing has yet crossed the pattern threshold. Gaps only appear once several genuinely low-confidence, no-knowledge questions accumulate over time.

## Tips & best practices
- Treat recurring high-severity gaps as your knowledge to-do list — they represent real customer questions you're currently missing.
- When you approve a fix, watch for it recurring. A reopened gap means the fix didn't fully answer the underlying question.
- Rejecting a draft doesn't delete the gap; it reopens so a better draft can form later.

## Related articles
- how-knowledge-powers-your-des
- quality-and-coverage
- self-learning
