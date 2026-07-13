---
title: How your knowledge base powers your Digital Employees
category: Knowledge
feature: Knowledge Library
audience: admin
difficulty: beginner
tags: [knowledge, grounding, retrieval, hallucination, citations, confidence, escalation]
---

# How your knowledge base powers your Digital Employees

## What it is
Your Digital Employees (DEs) answer **only** from the documents in your Knowledge Library. When someone asks a question, the DE finds the most relevant passages in your own documents, writes an answer grounded in them, and cites which documents it used. If your documents don't cover the question, the DE says so and escalates — it does not make something up.

## Why it matters
This is the difference between a helpful assistant and a liability. A DE that invents answers ("hallucinates") can promise refunds you don't offer or quote policies that don't exist. By tying every answer to your approved documents, DreamTeam keeps your DEs accurate, auditable, and safe to put in front of customers and staff. The quality of your DEs is, quite directly, the quality of your Knowledge Library.

## How retrieval works, in plain terms
When a DE receives a question, it searches your documents two ways at once and combines the results:

- **Keyword matching** catches the exact words someone typed — useful for rare terms, error codes, product names, and part numbers a customer copies verbatim.
- **Meaning matching** catches questions phrased differently from your documents. "I'm locked out" will find your "SSO login troubleshooting" article even though none of the words match, because the system compares *meaning*, not just spelling.

The two result lists are blended so a passage that ranks well on either method rises to the top. This hybrid approach answers a customer who "asks the same question in ten different ways" far more reliably than plain keyword search, while still respecting the exact term when it matters.

Once the best passages are found, the DE is instructed to **answer only from those passages** and to output a confidence score alongside the answer. Nothing outside your documents is treated as fact.

## What you'll see on an answer
- **A written answer**, grounded in your documents.
- **Cited sources** — the titles of the documents the DE actually used.
- **A confidence score** from 0 to 100, reflecting how well your documents supported the answer.
- **An escalation** to a human when confidence is low (below 60) or the DE judges it needs a person. The customer isn't left with a confident-sounding guess.

## Why this prevents hallucination
Three safeguards work together:

1. **Grounding** — the DE is told to answer strictly from the retrieved documents and never to invent facts.
2. **Honest gaps** — if there are no documents at all, or none that cover the question, the DE returns a low-confidence answer and escalates instead of improvising. A brand-new workspace with an empty library will get a plain "I don't have any knowledge documents yet" rather than a fabricated reply.
3. **Guardrails** — even a well-grounded answer is checked against your guardrail rules before it's sent, so a DE can't promise something you've forbidden.

## What makes an answer good
- **Coverage** — a document exists that actually answers the question.
- **Findability** — that document has been indexed (see *Retrieval* status in the Library) so meaning-matching can find it, not just keyword search.
- **Freshness** — the document is current. Stale documents produce confidently wrong answers; the Quality & Coverage page helps you catch them.
- **Scope** — the document is available to the DE being asked (see scoping).

## Good to know
- Indexing (the "meaning matching" step) is computed inside the platform at no extra cost — you don't need to connect or pay for a separate AI service for retrieval to work.
- A document that hasn't been indexed yet still works, but only through keyword matching. The Library shows a **Keyword only** badge until indexing finishes.
- Good answers to common questions are cached, so repeat questions come back instantly without re-computing — and the cache is cleared automatically whenever you edit or re-scope the underlying document.

## Related articles
- adding-documents-to-the-library
- scoping-knowledge-to-a-de
- gap-detection
- quality-and-coverage
