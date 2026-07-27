-- 476_ingest_workspace_assistant_kb_articles.sql            [DRAFT — do not
-- apply without founder approval; renumber 476 to the next free migration]
-- ============================================================================
-- PART 1 of 2 — publish the three Workspace Assistant KB articles.
--
-- WHY: three real user questions failed with knowledge_hits = 0 because the
-- assistant that ships in every workspace is documented NOWHERE:
--   "What is this workforce assistance"            (Technical Support DE)
--   "what is workspace assistance that i see in my account?"
--   "[hosted] Can you edit my settings for me?"    (Account Success DE)
-- The rejected self-denial fix (de_improvements aaff37e4) taught the DE to say
-- the term is unrecognized; these articles make the question ANSWERABLE.
--
-- WHAT: inserts the three docs (committed in docs/kb, same commit as this
-- draft) into outsourcetel-hq knowledge_docs with external_ref
-- 'product-kb/<cat>/<slug>' — the exact shape of the original 61-article
-- ingest (title from frontmatter; content with frontmatter stripped; tags =
-- frontmatter tags + category slug + feature; source 'upload'). This fixes the
-- ACTUAL failing path (outsourcetel-hq business DEs retrieve tenant docs) and
-- feeds Part 2, which copies docs+chunks+embeddings to the platform shelf so
-- every workspace's Workforce Assistant learns them (mig 336 pattern).
--
-- SEQUENCE (all three steps required, in order):
--   1. THIS migration (docs land, chunkless).
--   2. node <scratchpad>/kb/embed-workspace-assistant-kb-articles.mjs
--      — calls the ingest-chunks edge function per doc, looping until
--      remaining = 0 (the edge runtime embeds gte-small 384-dim, max 4
--      chunks/call; a migration cannot embed).
--   3. Migration 476+1 (copy to shelf, with its own asserts).
--
-- Idempotent: matched on (tenant_id, external_ref).
-- ============================================================================

INSERT INTO knowledge_docs (tenant_id, title, content, source, tags, external_ref, authority)
SELECT v.tenant_id, v.title, v.content, v.source, v.tags, v.external_ref, v.authority
  FROM (VALUES
  (
    '5bb802e1-8e92-4eef-9a7a-ac348785d43f'::uuid,
    $kb336b$What is the Workspace Assistant? (also called the Workforce Assistant)$kb336b$,
    $kb336b$# What is the Workspace Assistant? (also called the Workforce Assistant)

## What it is
The **Workspace Assistant** is a built-in Digital Employee that comes with every DreamTeam workspace. It lives in the chat dock in the **bottom-right corner of every page**, and it knows two things: your workspace (it answers from your own knowledge documents) and the DreamTeam platform itself (it is taught from the DreamTeam product guide).

## One assistant, a few names
You may see this assistant under slightly different names — they all refer to the same employee:

- **Workspace Assistant** — its name in the chat dock, where the header reads **Workspace Assistant — Knows your workspace & the platform**.
- **Workforce Assistant** — the name used in **Knowledge → Library**, where the **What your Workforce Assistant knows** panel shows the product-guide articles it is taught from.
- People also say "workforce assistance", "workspace assistance", or the "workplace assistant" — same assistant, same chat dock.

## Why it matters
Your other Digital Employees answer from your business knowledge — they aren't set up to explain DreamTeam itself. The Workspace Assistant is: ask it "how do playbook rules work?" or "what does the trust dial do?" and it answers from the official product guide, alongside anything it can find in your own library. And because it is a real Digital Employee, it plays by the same rules as the rest of your workforce: grounded answers, guardrails, escalation to a human when unsure, and a full audit trail.

## Before you start
Nothing to set up. The assistant is provisioned into every workspace automatically — including new workspaces — and is available on every page. It runs **supervised**: it has the right to answer you, not the right to act on its own.

## Step by step — asking a question
1. Click the **round chat button in the bottom-right corner** of any page (hovering over it shows **Ask Workspace Assistant**).
2. Keep the **Ask a question** tab selected — it's the default.
3. Type your question and press **Enter**.
4. The reply shows a **confidence score** and, when documents were used, a **From:** line naming its sources.
5. If it isn't confident enough to answer on its own, you'll see *"I've escalated this to your team"* with a link to **view Human Tasks**.

Use the **⋯** menu to **Clear conversation** at any time.

## How it decides to answer or hand off
- It answers on its own only when its confidence is high — **70% or better by default**. Anything weaker is escalated to your team instead of guessed at.
- Escalations land in **Approvals & Drafts**, tagged **via DE chat**, with the transcript attached, so a person can pick up exactly where the assistant stopped.
- Every answer is checked against your **guardrails** before it's shown. A blocked answer is withheld and recorded in the audit trail.
- The assistant works **inside your workspace only** — it never answers on your public customer-facing Q&A widget.

## Tips & best practices
- Ask it platform questions in plain words — "why did my employee escalate that?", "how do I add knowledge?". It's taught from the same product guide you can read yourself in **Knowledge → Library**.
- It can also make certain changes for you — see the **Change something** tab, covered in [asking-the-workspace-assistant-to-make-changes](asking-the-workspace-assistant-to-make-changes.md).

## Troubleshooting
- **It says its brain isn't activated** — answering runs on your workspace's AI engine key. An admin needs to add one; until then the assistant can't answer from your documents.
- **You see a mention of a "Workforce Assistant hub"** — a dedicated page for hiring and restructuring the workforce is still being rolled out. The chat dock is the place to work with your assistant today.

## Related articles
- [asking-the-workspace-assistant-to-make-changes](asking-the-workspace-assistant-to-make-changes.md)
- [../knowledge/what-your-workforce-assistant-knows](../knowledge/what-your-workforce-assistant-knows.md)
- [../digital-employees/how-a-de-answers-questions](../digital-employees/how-a-de-answers-questions.md)
- [../tasks-approvals/approvals-and-drafts](../tasks-approvals/approvals-and-drafts.md)$kb336b$,
    'upload',
    ARRAY[$kb336b$workspace assistant$kb336b$, $kb336b$workforce assistant$kb336b$, $kb336b$workforce assistance$kb336b$, $kb336b$workspace assistance$kb336b$, $kb336b$workplace assistant$kb336b$, $kb336b$chat dock$kb336b$, $kb336b$ask a question$kb336b$, $kb336b$platform help$kb336b$, $kb336b$getting-started$kb336b$, $kb336b$Workspace Assistant$kb336b$]::text[],
    $kb336b$product-kb/getting-started/meet-your-workspace-assistant$kb336b$,
    0
  ),
  (
    '5bb802e1-8e92-4eef-9a7a-ac348785d43f'::uuid,
    $kb336b$Can the Workspace Assistant change settings for me?$kb336b$,
    $kb336b$# Can the Workspace Assistant change settings for me?

## What it is
The **Change something** tab in the Workspace Assistant's chat dock (bottom-right corner of every page). Describe what you want changed in your own words, and the assistant makes the edit for you — with an **Undo** on everything it does, available for **120 hours**.

Some people call this assistant the "workplace assistant" or ask about "workforce assistance" — it's the same built-in assistant, and this is its editing mode.

## What it can change — and what it can't
It can edit, in plain language:

- **Knowledge** — your knowledge documents.
- **Playbook drafts** — draft playbooks (not published ones going live behind your back).
- **Employee descriptions** — how a Digital Employee describes itself.

It **cannot** change your account settings for you. Your profile, password, sign-in and security options, and plan/billing stay in their own **Settings** pages, under your control. It also can't loosen governance by chat: guardrails, trust levels, and connector credentials go through their own reviewed flows — a chat message never changes them. The assistant works from a fixed allow-list of safe, undoable edit types; anything outside it simply isn't applied.

## Why it matters
Small fixes shouldn't require hunting through pages: "the refund window in that article is wrong — it's 30 days, not 14" is faster to say than to click. Because every edit is undoable for 120 hours and recorded, you get speed without giving up control.

## Step by step
1. Click the **round chat button in the bottom-right corner** of any page.
2. Select the **Change something** tab.
3. Describe the change in your own words — the panel says it plainly: *"Describe what is wrong in your own words and I will change it. Anything I change, you can undo for 120 hours."*
4. The assistant replies with what it did. Each applied change appears as its own item with an **Undo** button and how long you have left to use it.
5. Changed your mind? Click **Undo** on that item.

## Tips & best practices
- Be concrete: name the document, playbook, or employee and say what's wrong. "Fix the pricing article — the starter plan is $49" beats "fix pricing".
- Check the result where it lives (for example **Knowledge → Library**) — the change is real the moment it's applied.

## Troubleshooting
- **"This is a remote support session, so changes can be suggested but not applied."** — someone assisting your workspace from outside can only propose edits. Apply them from your own login.
- **You asked for something it won't do** — account, security, billing, guardrail, and trust changes are deliberately outside its reach. Make those in their own pages; the assistant answering questions about *where* is fair game in the **Ask a question** tab.

## Related articles
- [meet-your-workspace-assistant](meet-your-workspace-assistant.md)
- [../knowledge/adding-documents-to-the-library](../knowledge/adding-documents-to-the-library.md)
- [../governance/guardrails](../governance/guardrails.md)$kb336b$,
    'upload',
    ARRAY[$kb336b$workspace assistant$kb336b$, $kb336b$workplace assistant$kb336b$, $kb336b$workforce assistant$kb336b$, $kb336b$workforce assistance$kb336b$, $kb336b$edit settings$kb336b$, $kb336b$change something$kb336b$, $kb336b$undo$kb336b$, $kb336b$plain language changes$kb336b$, $kb336b$getting-started$kb336b$, $kb336b$Workspace Assistant$kb336b$]::text[],
    $kb336b$product-kb/getting-started/asking-the-workspace-assistant-to-make-changes$kb336b$,
    0
  ),
  (
    '5bb802e1-8e92-4eef-9a7a-ac348785d43f'::uuid,
    $kb336b$What your Workforce Assistant knows — the DreamTeam product guide$kb336b$,
    $kb336b$# What your Workforce Assistant knows — the DreamTeam product guide

## What it is
A read-only set of articles about how DreamTeam itself works, maintained by DreamTeam and shown at the bottom of **Knowledge → Library**. These articles are what your **Workforce Assistant** — the same assistant the chat dock calls the **Workspace Assistant** (and some people call the workplace assistant) — is taught from when it answers questions about the platform.

## Why it matters
When the assistant explains a DreamTeam feature, you shouldn't have to take its word for where that came from. This panel is the transparency: you can read exactly what your assistant was told, article by article. It's also why the assistant can answer "how does this platform work?" questions (sometimes asked as "what is this workforce assistance?") that your business Digital Employees aren't set up to cover.

## Step by step
1. Open **Knowledge → Library**.
2. Scroll to the bottom. Below your own documents there's a quiet collapsed row: **DreamTeam product guide**, with the current article count and a **read-only** badge, marked *maintained by DreamTeam*.
3. Click the row to expand **What your Workforce Assistant knows**.
4. Use **Search the product guide…** to filter, and click any article to read it in full.
5. Articles the assistant has recently drawn on show a **used N× in 30d** marker.

While searching your own library, you may also see a line like **"Also 3 matches in the DreamTeam product guide →"** — click it to jump into the guide with the same search.

## How it relates to your own knowledge base — honestly
- **It is not part of your knowledge base.** Product-guide articles don't appear in your library list, aren't counted in your document totals, and don't affect your quality or gap scores.
- **It is read-only.** Every article carries a *provided* badge; there is no edit, delete, or upload here. Your own documents live above it, fully under your control.
- **Only the Workforce Assistant is taught from it.** Your other Digital Employees answer from your own library only — the product guide never leaks into their answers to your customers.
- The assistant still reads your own knowledge too: when you ask it something about *your* business, it answers from your documents, same as any Digital Employee.

## Tips & best practices
- Before writing your own "how do I use DreamTeam" notes, search the product guide — it's probably already covered, kept current by DreamTeam, and already known to your assistant.
- The **used N× in 30d** markers are a quick read on what your team actually asks the assistant about.

## Related articles
- [../getting-started/meet-your-workspace-assistant](../getting-started/meet-your-workspace-assistant.md)
- [adding-documents-to-the-library](adding-documents-to-the-library.md)
- [how-knowledge-powers-your-des](how-knowledge-powers-your-des.md)$kb336b$,
    'upload',
    ARRAY[$kb336b$product guide$kb336b$, $kb336b$workforce assistant$kb336b$, $kb336b$workspace assistant$kb336b$, $kb336b$workforce assistance$kb336b$, $kb336b$workplace assistant$kb336b$, $kb336b$read-only$kb336b$, $kb336b$library$kb336b$, $kb336b$platform knowledge$kb336b$, $kb336b$knowledge$kb336b$, $kb336b$Knowledge  Product Guide$kb336b$]::text[],
    $kb336b$product-kb/knowledge/what-your-workforce-assistant-knows$kb336b$,
    0
  )
  ) AS v(tenant_id, title, content, source, tags, external_ref, authority)
 WHERE NOT EXISTS (
   SELECT 1 FROM knowledge_docs k
    WHERE k.tenant_id = v.tenant_id AND k.external_ref = v.external_ref AND k.is_current
 );

-- ── Assert: all three landed, current, published, and non-trivially sized ────
DO $assert$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n
    FROM knowledge_docs
   WHERE tenant_id = '5bb802e1-8e92-4eef-9a7a-ac348785d43f'
     AND is_current AND lifecycle_status = 'published'
     AND length(content) > 1000
     AND external_ref IN ($kb336b$product-kb/getting-started/meet-your-workspace-assistant$kb336b$, $kb336b$product-kb/getting-started/asking-the-workspace-assistant-to-make-changes$kb336b$, $kb336b$product-kb/knowledge/what-your-workforce-assistant-knows$kb336b$);
  IF v_n <> 3 THEN
    RAISE EXCEPTION '476: expected the 3 Workspace Assistant articles current+published, found %', v_n;
  END IF;
END $assert$;
