-- 478_unify_workspace_assistant_name.sql
-- Founder decision: ONE name. The dock said Workspace Assistant, the hub and
-- shelf said Workforce Assistant, users typed a third blend — the KB grounding
-- gap this split caused let a knowledge fix score 82/100 for teaching a DE to
-- deny the feature. Unified on WORKSPACE Assistant (the label on the only
-- surface with real usage, and the founder's own vocabulary). 'Workforce'
-- keeps meaning the DE roster. Internal is_workforce_assistant column stays.
-- All writes run as postgres — the eval-gate publish trigger exempts
-- non-authenticated context, and every layer carries a landed-assert.

-- 1. The sixteen live assistants
update digital_employees set
  name = 'Workspace Assistant',
  persona_name = case when persona_name = 'Workforce Assistant' then 'Workspace Assistant' else persona_name end,
  description = replace(coalesce(description,''), 'Workforce Assistant', 'Workspace Assistant'),
  charter = replace(charter::text, 'Workforce Assistant', 'Workspace Assistant')::jsonb
where is_workforce_assistant;

-- 2. The three provisioning functions keep minting the name for future tenants
do $fns$
declare fn text; v_src text; v_new text; v_hits int;
begin
  foreach fn in array array['auto_provision_new_tenant','create_workforce_assistant_de','provision_workforce_assistant_internal'] loop
    select pg_get_functiondef(p.oid) into v_src from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname='public' and p.proname = fn;
    if v_src is null then raise exception '478: % not found', fn; end if;
    v_hits := (length(v_src) - length(replace(v_src, 'Workforce Assistant', ''))) / length('Workforce Assistant');
    if v_hits = 0 then raise notice '478: % already carries no old literal', fn; continue; end if;
    v_new := replace(v_src, 'Workforce Assistant', 'Workspace Assistant');
    execute v_new;
  end loop;
end $fns$;

-- 3. product-kb/getting-started/meet-your-workspace-assistant
update knowledge_docs d set title = $t$What is the Workspace Assistant?$t$, content = $c$# What is the Workspace Assistant?

## What it is
The **Workspace Assistant** is a built-in Digital Employee that comes with every DreamTeam workspace. It lives in the chat dock in the **bottom-right corner of every page**, and it knows two things: your workspace (it answers from your own knowledge documents) and the DreamTeam platform itself (it is taught from the DreamTeam product guide).

## One assistant, one name
This assistant is called the **Workspace Assistant** everywhere in DreamTeam. Some earlier screens and documents called it the **Workforce Assistant** — that was the same employee, and the name has since been unified. People also say "workforce assistance", "workspace assistance", or the "workplace assistant" — same assistant, same chat dock.

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
- **You see a mention of a "Workforce Assistant" or an assistant "hub"** — a dedicated page for hiring and restructuring the workforce is still being rolled out. The chat dock is the place to work with your assistant today.

## Related articles
- [asking-the-workspace-assistant-to-make-changes](asking-the-workspace-assistant-to-make-changes.md)
- [../knowledge/what-your-workforce-assistant-knows](../knowledge/what-your-workforce-assistant-knows.md)
- [../digital-employees/how-a-de-answers-questions](../digital-employees/how-a-de-answers-questions.md)
- [../tasks-approvals/approvals-and-drafts](../tasks-approvals/approvals-and-drafts.md)
$c$
from tenants t where t.id = d.tenant_id and t.slug='outsourcetel-hq' and d.external_ref = 'product-kb/getting-started/meet-your-workspace-assistant';
delete from knowledge_doc_chunks c using knowledge_docs d, tenants t
 where c.doc_id = d.id and d.tenant_id = t.id and t.slug='outsourcetel-hq' and d.external_ref = 'product-kb/getting-started/meet-your-workspace-assistant';
insert into knowledge_doc_chunks (tenant_id, doc_id, chunk_index, content, content_hash)
select d.tenant_id, d.id, 0, $k$# What is the Workspace Assistant?

## What it is
The **Workspace Assistant** is a built-in Digital Employee that comes with every DreamTeam workspace. It lives in the chat dock in the **bottom-right corner of every page**, and it knows two things: your workspace (it answers from your own knowledge documents) and the DreamTeam platform itself (it is taught from the DreamTeam product guide).

## One assistant, one name
This assistant is called the **Workspace Assistant** everywhere in DreamTeam. Some earlier screens and documents called it the **Workforce Assistant** — that was the same employee, and the name has since been unified. People also say "workforce assistance", "workspace assistance", or the "workplace assistant" — same assistant, same chat dock.

## Why it matters
Your other Digital Employees answer from your business knowledge — they aren't set up to explain DreamTeam itself. The Workspace Assistant is: ask it "how do playbook rules work?" or "what does the trust dial do?" and it answers from the official product guide, alongside anything it can find in your own library. And because it is a real Digital Employee, it plays by the same rules as the rest of your workforce: grounded answers, guardrails, escalation to a human when unsure, and a full audit trail.$k$, encode(digest($k$# What is the Workspace Assistant?

## What it is
The **Workspace Assistant** is a built-in Digital Employee that comes with every DreamTeam workspace. It lives in the chat dock in the **bottom-right corner of every page**, and it knows two things: your workspace (it answers from your own knowledge documents) and the DreamTeam platform itself (it is taught from the DreamTeam product guide).

## One assistant, one name
This assistant is called the **Workspace Assistant** everywhere in DreamTeam. Some earlier screens and documents called it the **Workforce Assistant** — that was the same employee, and the name has since been unified. People also say "workforce assistance", "workspace assistance", or the "workplace assistant" — same assistant, same chat dock.

## Why it matters
Your other Digital Employees answer from your business knowledge — they aren't set up to explain DreamTeam itself. The Workspace Assistant is: ask it "how do playbook rules work?" or "what does the trust dial do?" and it answers from the official product guide, alongside anything it can find in your own library. And because it is a real Digital Employee, it plays by the same rules as the rest of your workforce: grounded answers, guardrails, escalation to a human when unsure, and a full audit trail.$k$, 'sha256'), 'hex')
from knowledge_docs d join tenants t on t.id = d.tenant_id
where t.slug='outsourcetel-hq' and d.external_ref = 'product-kb/getting-started/meet-your-workspace-assistant';
insert into knowledge_doc_chunks (tenant_id, doc_id, chunk_index, content, content_hash)
select d.tenant_id, d.id, 1, $k$n library. And because it is a real Digital Employee, it plays by the same rules as the rest of your workforce: grounded answers, guardrails, escalation to a human when unsure, and a full audit trail.

## Before you start
Nothing to set up. The assistant is provisioned into every workspace automatically — including new workspaces — and is available on every page. It runs **supervised**: it has the right to answer you, not the right to act on its own.

## Step by step — asking a question
1. Click the **round chat button in the bottom-right corner** of any page (hovering over it shows **Ask Workspace Assistant**).
2. Keep the **Ask a question** tab selected — it's the default.
3. Type your question and press **Enter**.
4. The reply shows a **confidence score** and, when documents were used, a **From:** line naming its sources.
5. If it isn't confident enough to answer on its own, you'll see *"I've escalated this to your team"* with a link to **view Human Tasks**.

Use the **⋯** menu to **Clear conversation** at any time.$k$, encode(digest($k$n library. And because it is a real Digital Employee, it plays by the same rules as the rest of your workforce: grounded answers, guardrails, escalation to a human when unsure, and a full audit trail.

## Before you start
Nothing to set up. The assistant is provisioned into every workspace automatically — including new workspaces — and is available on every page. It runs **supervised**: it has the right to answer you, not the right to act on its own.

## Step by step — asking a question
1. Click the **round chat button in the bottom-right corner** of any page (hovering over it shows **Ask Workspace Assistant**).
2. Keep the **Ask a question** tab selected — it's the default.
3. Type your question and press **Enter**.
4. The reply shows a **confidence score** and, when documents were used, a **From:** line naming its sources.
5. If it isn't confident enough to answer on its own, you'll see *"I've escalated this to your team"* with a link to **view Human Tasks**.

Use the **⋯** menu to **Clear conversation** at any time.$k$, 'sha256'), 'hex')
from knowledge_docs d join tenants t on t.id = d.tenant_id
where t.slug='outsourcetel-hq' and d.external_ref = 'product-kb/getting-started/meet-your-workspace-assistant';
insert into knowledge_doc_chunks (tenant_id, doc_id, chunk_index, content, content_hash)
select d.tenant_id, d.id, 2, $k$s.
5. If it isn't confident enough to answer on its own, you'll see *"I've escalated this to your team"* with a link to **view Human Tasks**.

Use the **⋯** menu to **Clear conversation** at any time.

## How it decides to answer or hand off
- It answers on its own only when its confidence is high — **70% or better by default**. Anything weaker is escalated to your team instead of guessed at.
- Escalations land in **Approvals & Drafts**, tagged **via DE chat**, with the transcript attached, so a person can pick up exactly where the assistant stopped.
- Every answer is checked against your **guardrails** before it's shown. A blocked answer is withheld and recorded in the audit trail.
- The assistant works **inside your workspace only** — it never answers on your public customer-facing Q&A widget.

## Tips & best practices
- Ask it platform questions in plain words — "why did my employee escalate that?", "how do I add knowledge?". It's taught from the same product guide you can read yourself in **Knowledge → Library**.
- It can also make certain changes for you — see the **Change something** tab, covered in [asking-the-workspace-assistant-to-make-changes](asking-the-workspace-assistant-to-make-changes.md).$k$, encode(digest($k$s.
5. If it isn't confident enough to answer on its own, you'll see *"I've escalated this to your team"* with a link to **view Human Tasks**.

Use the **⋯** menu to **Clear conversation** at any time.

## How it decides to answer or hand off
- It answers on its own only when its confidence is high — **70% or better by default**. Anything weaker is escalated to your team instead of guessed at.
- Escalations land in **Approvals & Drafts**, tagged **via DE chat**, with the transcript attached, so a person can pick up exactly where the assistant stopped.
- Every answer is checked against your **guardrails** before it's shown. A blocked answer is withheld and recorded in the audit trail.
- The assistant works **inside your workspace only** — it never answers on your public customer-facing Q&A widget.

## Tips & best practices
- Ask it platform questions in plain words — "why did my employee escalate that?", "how do I add knowledge?". It's taught from the same product guide you can read yourself in **Knowledge → Library**.
- It can also make certain changes for you — see the **Change something** tab, covered in [asking-the-workspace-assistant-to-make-changes](asking-the-workspace-assistant-to-make-changes.md).$k$, 'sha256'), 'hex')
from knowledge_docs d join tenants t on t.id = d.tenant_id
where t.slug='outsourcetel-hq' and d.external_ref = 'product-kb/getting-started/meet-your-workspace-assistant';
insert into knowledge_doc_chunks (tenant_id, doc_id, chunk_index, content, content_hash)
select d.tenant_id, d.id, 3, $k$ibrary**.
- It can also make certain changes for you — see the **Change something** tab, covered in [asking-the-workspace-assistant-to-make-changes](asking-the-workspace-assistant-to-make-changes.md).

## Troubleshooting
- **It says its brain isn't activated** — answering runs on your workspace's AI engine key. An admin needs to add one; until then the assistant can't answer from your documents.
- **You see a mention of a "Workforce Assistant" or an assistant "hub"** — a dedicated page for hiring and restructuring the workforce is still being rolled out. The chat dock is the place to work with your assistant today.

## Related articles
- [asking-the-workspace-assistant-to-make-changes](asking-the-workspace-assistant-to-make-changes.md)
- [../knowledge/what-your-workforce-assistant-knows](../knowledge/what-your-workforce-assistant-knows.md)
- [../digital-employees/how-a-de-answers-questions](../digital-employees/how-a-de-answers-questions.md)
- [../tasks-approvals/approvals-and-drafts](../tasks-approvals/approvals-and-drafts.md)$k$, encode(digest($k$ibrary**.
- It can also make certain changes for you — see the **Change something** tab, covered in [asking-the-workspace-assistant-to-make-changes](asking-the-workspace-assistant-to-make-changes.md).

## Troubleshooting
- **It says its brain isn't activated** — answering runs on your workspace's AI engine key. An admin needs to add one; until then the assistant can't answer from your documents.
- **You see a mention of a "Workforce Assistant" or an assistant "hub"** — a dedicated page for hiring and restructuring the workforce is still being rolled out. The chat dock is the place to work with your assistant today.

## Related articles
- [asking-the-workspace-assistant-to-make-changes](asking-the-workspace-assistant-to-make-changes.md)
- [../knowledge/what-your-workforce-assistant-knows](../knowledge/what-your-workforce-assistant-knows.md)
- [../digital-employees/how-a-de-answers-questions](../digital-employees/how-a-de-answers-questions.md)
- [../tasks-approvals/approvals-and-drafts](../tasks-approvals/approvals-and-drafts.md)$k$, 'sha256'), 'hex')
from knowledge_docs d join tenants t on t.id = d.tenant_id
where t.slug='outsourcetel-hq' and d.external_ref = 'product-kb/getting-started/meet-your-workspace-assistant';
update platform_knowledge_docs set title = $t$What is the Workspace Assistant?$t$, content = $c$# What is the Workspace Assistant?

## What it is
The **Workspace Assistant** is a built-in Digital Employee that comes with every DreamTeam workspace. It lives in the chat dock in the **bottom-right corner of every page**, and it knows two things: your workspace (it answers from your own knowledge documents) and the DreamTeam platform itself (it is taught from the DreamTeam product guide).

## One assistant, one name
This assistant is called the **Workspace Assistant** everywhere in DreamTeam. Some earlier screens and documents called it the **Workforce Assistant** — that was the same employee, and the name has since been unified. People also say "workforce assistance", "workspace assistance", or the "workplace assistant" — same assistant, same chat dock.

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
- **You see a mention of a "Workforce Assistant" or an assistant "hub"** — a dedicated page for hiring and restructuring the workforce is still being rolled out. The chat dock is the place to work with your assistant today.

## Related articles
- [asking-the-workspace-assistant-to-make-changes](asking-the-workspace-assistant-to-make-changes.md)
- [../knowledge/what-your-workforce-assistant-knows](../knowledge/what-your-workforce-assistant-knows.md)
- [../digital-employees/how-a-de-answers-questions](../digital-employees/how-a-de-answers-questions.md)
- [../tasks-approvals/approvals-and-drafts](../tasks-approvals/approvals-and-drafts.md)
$c$ where source_doc_path = 'product-kb/getting-started/meet-your-workspace-assistant';
delete from platform_knowledge_chunks pc using platform_knowledge_docs pd
 where pc.doc_id = pd.id and pd.source_doc_path = 'product-kb/getting-started/meet-your-workspace-assistant';
insert into platform_knowledge_chunks (doc_id, chunk_index, content)
select pd.id, c.chunk_index, c.content
from platform_knowledge_docs pd
join knowledge_docs d on d.external_ref = pd.source_doc_path
join tenants t on t.id = d.tenant_id and t.slug='outsourcetel-hq'
join knowledge_doc_chunks c on c.doc_id = d.id
where pd.source_doc_path = 'product-kb/getting-started/meet-your-workspace-assistant';
-- 3. product-kb/getting-started/asking-the-workspace-assistant-to-make-changes
update knowledge_docs d set title = $t$Can the Workspace Assistant change settings for me?$t$, content = $c$# Can the Workspace Assistant change settings for me?

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
- [../governance/guardrails](../governance/guardrails.md)
$c$
from tenants t where t.id = d.tenant_id and t.slug='outsourcetel-hq' and d.external_ref = 'product-kb/getting-started/asking-the-workspace-assistant-to-make-changes';
delete from knowledge_doc_chunks c using knowledge_docs d, tenants t
 where c.doc_id = d.id and d.tenant_id = t.id and t.slug='outsourcetel-hq' and d.external_ref = 'product-kb/getting-started/asking-the-workspace-assistant-to-make-changes';
insert into knowledge_doc_chunks (tenant_id, doc_id, chunk_index, content, content_hash)
select d.tenant_id, d.id, 0, $k$# Can the Workspace Assistant change settings for me?

## What it is
The **Change something** tab in the Workspace Assistant's chat dock (bottom-right corner of every page). Describe what you want changed in your own words, and the assistant makes the edit for you — with an **Undo** on everything it does, available for **120 hours**.

Some people call this assistant the "workplace assistant" or ask about "workforce assistance" — it's the same built-in assistant, and this is its editing mode.

## What it can change — and what it can't
It can edit, in plain language:

- **Knowledge** — your knowledge documents.
- **Playbook drafts** — draft playbooks (not published ones going live behind your back).
- **Employee descriptions** — how a Digital Employee describes itself.

It **cannot** change your account settings for you. Your profile, password, sign-in and security options, and plan/billing stay in their own **Settings** pages, under your control. It also can't loosen governance by chat: guardrails, trust levels, and connector credentials go through their own reviewed flows — a chat message never changes them. The assistant works from a fixed allow-list of safe, undoable edit types; anything outside it simply isn't applied.$k$, encode(digest($k$# Can the Workspace Assistant change settings for me?

## What it is
The **Change something** tab in the Workspace Assistant's chat dock (bottom-right corner of every page). Describe what you want changed in your own words, and the assistant makes the edit for you — with an **Undo** on everything it does, available for **120 hours**.

Some people call this assistant the "workplace assistant" or ask about "workforce assistance" — it's the same built-in assistant, and this is its editing mode.

## What it can change — and what it can't
It can edit, in plain language:

- **Knowledge** — your knowledge documents.
- **Playbook drafts** — draft playbooks (not published ones going live behind your back).
- **Employee descriptions** — how a Digital Employee describes itself.

It **cannot** change your account settings for you. Your profile, password, sign-in and security options, and plan/billing stay in their own **Settings** pages, under your control. It also can't loosen governance by chat: guardrails, trust levels, and connector credentials go through their own reviewed flows — a chat message never changes them. The assistant works from a fixed allow-list of safe, undoable edit types; anything outside it simply isn't applied.$k$, 'sha256'), 'hex')
from knowledge_docs d join tenants t on t.id = d.tenant_id
where t.slug='outsourcetel-hq' and d.external_ref = 'product-kb/getting-started/asking-the-workspace-assistant-to-make-changes';
insert into knowledge_doc_chunks (tenant_id, doc_id, chunk_index, content, content_hash)
select d.tenant_id, d.id, 1, $k$credentials go through their own reviewed flows — a chat message never changes them. The assistant works from a fixed allow-list of safe, undoable edit types; anything outside it simply isn't applied.

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
- Check the result where it lives (for example **Knowledge → Library**) — the change is real the moment it's applied.$k$, encode(digest($k$credentials go through their own reviewed flows — a chat message never changes them. The assistant works from a fixed allow-list of safe, undoable edit types; anything outside it simply isn't applied.

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
- Check the result where it lives (for example **Knowledge → Library**) — the change is real the moment it's applied.$k$, 'sha256'), 'hex')
from knowledge_docs d join tenants t on t.id = d.tenant_id
where t.slug='outsourcetel-hq' and d.external_ref = 'product-kb/getting-started/asking-the-workspace-assistant-to-make-changes';
insert into knowledge_doc_chunks (tenant_id, doc_id, chunk_index, content, content_hash)
select d.tenant_id, d.id, 2, $k$'s wrong. "Fix the pricing article — the starter plan is $49" beats "fix pricing".
- Check the result where it lives (for example **Knowledge → Library**) — the change is real the moment it's applied.

## Troubleshooting
- **"This is a remote support session, so changes can be suggested but not applied."** — someone assisting your workspace from outside can only propose edits. Apply them from your own login.
- **You asked for something it won't do** — account, security, billing, guardrail, and trust changes are deliberately outside its reach. Make those in their own pages; the assistant answering questions about *where* is fair game in the **Ask a question** tab.

## Related articles
- [meet-your-workspace-assistant](meet-your-workspace-assistant.md)
- [../knowledge/adding-documents-to-the-library](../knowledge/adding-documents-to-the-library.md)
- [../governance/guardrails](../governance/guardrails.md)$k$, encode(digest($k$'s wrong. "Fix the pricing article — the starter plan is $49" beats "fix pricing".
- Check the result where it lives (for example **Knowledge → Library**) — the change is real the moment it's applied.

## Troubleshooting
- **"This is a remote support session, so changes can be suggested but not applied."** — someone assisting your workspace from outside can only propose edits. Apply them from your own login.
- **You asked for something it won't do** — account, security, billing, guardrail, and trust changes are deliberately outside its reach. Make those in their own pages; the assistant answering questions about *where* is fair game in the **Ask a question** tab.

## Related articles
- [meet-your-workspace-assistant](meet-your-workspace-assistant.md)
- [../knowledge/adding-documents-to-the-library](../knowledge/adding-documents-to-the-library.md)
- [../governance/guardrails](../governance/guardrails.md)$k$, 'sha256'), 'hex')
from knowledge_docs d join tenants t on t.id = d.tenant_id
where t.slug='outsourcetel-hq' and d.external_ref = 'product-kb/getting-started/asking-the-workspace-assistant-to-make-changes';
update platform_knowledge_docs set title = $t$Can the Workspace Assistant change settings for me?$t$, content = $c$# Can the Workspace Assistant change settings for me?

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
- [../governance/guardrails](../governance/guardrails.md)
$c$ where source_doc_path = 'product-kb/getting-started/asking-the-workspace-assistant-to-make-changes';
delete from platform_knowledge_chunks pc using platform_knowledge_docs pd
 where pc.doc_id = pd.id and pd.source_doc_path = 'product-kb/getting-started/asking-the-workspace-assistant-to-make-changes';
insert into platform_knowledge_chunks (doc_id, chunk_index, content)
select pd.id, c.chunk_index, c.content
from platform_knowledge_docs pd
join knowledge_docs d on d.external_ref = pd.source_doc_path
join tenants t on t.id = d.tenant_id and t.slug='outsourcetel-hq'
join knowledge_doc_chunks c on c.doc_id = d.id
where pd.source_doc_path = 'product-kb/getting-started/asking-the-workspace-assistant-to-make-changes';
-- 3. product-kb/knowledge/what-your-workforce-assistant-knows
update knowledge_docs d set title = $t$What your Workspace Assistant knows — the DreamTeam product guide$t$, content = $c$# What your Workspace Assistant knows — the DreamTeam product guide

## What it is
A read-only set of articles about how DreamTeam itself works, maintained by DreamTeam and shown at the bottom of **Knowledge → Library**. These articles are what your **Workspace Assistant** (previously labelled the Workforce Assistant on some screens; some people also say workplace assistant) is taught from when it answers questions about the platform.

## Why it matters
When the assistant explains a DreamTeam feature, you shouldn't have to take its word for where that came from. This panel is the transparency: you can read exactly what your assistant was told, article by article. It's also why the assistant can answer "how does this platform work?" questions (sometimes asked as "what is this workforce assistance?") that your business Digital Employees aren't set up to cover.

## Step by step
1. Open **Knowledge → Library**.
2. Scroll to the bottom. Below your own documents there's a quiet collapsed row: **DreamTeam product guide**, with the current article count and a **read-only** badge, marked *maintained by DreamTeam*.
3. Click the row to expand **What your Workspace Assistant knows**.
4. Use **Search the product guide…** to filter, and click any article to read it in full.
5. Articles the assistant has recently drawn on show a **used N× in 30d** marker.

While searching your own library, you may also see a line like **"Also 3 matches in the DreamTeam product guide →"** — click it to jump into the guide with the same search.

## How it relates to your own knowledge base — honestly
- **It is not part of your knowledge base.** Product-guide articles don't appear in your library list, aren't counted in your document totals, and don't affect your quality or gap scores.
- **It is read-only.** Every article carries a *provided* badge; there is no edit, delete, or upload here. Your own documents live above it, fully under your control.
- **Only the Workspace Assistant is taught from it.** Your other Digital Employees answer from your own library only — the product guide never leaks into their answers to your customers.
- The assistant still reads your own knowledge too: when you ask it something about *your* business, it answers from your documents, same as any Digital Employee.

## Tips & best practices
- Before writing your own "how do I use DreamTeam" notes, search the product guide — it's probably already covered, kept current by DreamTeam, and already known to your assistant.
- The **used N× in 30d** markers are a quick read on what your team actually asks the assistant about.

## Related articles
- [../getting-started/meet-your-workspace-assistant](../getting-started/meet-your-workspace-assistant.md)
- [adding-documents-to-the-library](adding-documents-to-the-library.md)
- [how-knowledge-powers-your-des](how-knowledge-powers-your-des.md)
$c$
from tenants t where t.id = d.tenant_id and t.slug='outsourcetel-hq' and d.external_ref = 'product-kb/knowledge/what-your-workforce-assistant-knows';
delete from knowledge_doc_chunks c using knowledge_docs d, tenants t
 where c.doc_id = d.id and d.tenant_id = t.id and t.slug='outsourcetel-hq' and d.external_ref = 'product-kb/knowledge/what-your-workforce-assistant-knows';
insert into knowledge_doc_chunks (tenant_id, doc_id, chunk_index, content, content_hash)
select d.tenant_id, d.id, 0, $k$# What your Workspace Assistant knows — the DreamTeam product guide

## What it is
A read-only set of articles about how DreamTeam itself works, maintained by DreamTeam and shown at the bottom of **Knowledge → Library**. These articles are what your **Workspace Assistant** (previously labelled the Workforce Assistant on some screens; some people also say workplace assistant) is taught from when it answers questions about the platform.

## Why it matters
When the assistant explains a DreamTeam feature, you shouldn't have to take its word for where that came from. This panel is the transparency: you can read exactly what your assistant was told, article by article. It's also why the assistant can answer "how does this platform work?" questions (sometimes asked as "what is this workforce assistance?") that your business Digital Employees aren't set up to cover.

## Step by step
1. Open **Knowledge → Library**.
2. Scroll to the bottom. Below your own documents there's a quiet collapsed row: **DreamTeam product guide**, with the current article count and a **read-only** badge, marked *maintained by DreamTeam*.
3. Click the row to expand **What your Workspace Assistant knows**.
4. Use **Search the product guide…** to filter, and click any article to read it in full.
5. Articles the assistant has recently drawn on show a **used N× in 30d** marker.$k$, encode(digest($k$# What your Workspace Assistant knows — the DreamTeam product guide

## What it is
A read-only set of articles about how DreamTeam itself works, maintained by DreamTeam and shown at the bottom of **Knowledge → Library**. These articles are what your **Workspace Assistant** (previously labelled the Workforce Assistant on some screens; some people also say workplace assistant) is taught from when it answers questions about the platform.

## Why it matters
When the assistant explains a DreamTeam feature, you shouldn't have to take its word for where that came from. This panel is the transparency: you can read exactly what your assistant was told, article by article. It's also why the assistant can answer "how does this platform work?" questions (sometimes asked as "what is this workforce assistance?") that your business Digital Employees aren't set up to cover.

## Step by step
1. Open **Knowledge → Library**.
2. Scroll to the bottom. Below your own documents there's a quiet collapsed row: **DreamTeam product guide**, with the current article count and a **read-only** badge, marked *maintained by DreamTeam*.
3. Click the row to expand **What your Workspace Assistant knows**.
4. Use **Search the product guide…** to filter, and click any article to read it in full.
5. Articles the assistant has recently drawn on show a **used N× in 30d** marker.$k$, 'sha256'), 'hex')
from knowledge_docs d join tenants t on t.id = d.tenant_id
where t.slug='outsourcetel-hq' and d.external_ref = 'product-kb/knowledge/what-your-workforce-assistant-knows';
insert into knowledge_doc_chunks (tenant_id, doc_id, chunk_index, content, content_hash)
select d.tenant_id, d.id, 1, $k$Workspace Assistant knows**.
4. Use **Search the product guide…** to filter, and click any article to read it in full.
5. Articles the assistant has recently drawn on show a **used N× in 30d** marker.

While searching your own library, you may also see a line like **"Also 3 matches in the DreamTeam product guide →"** — click it to jump into the guide with the same search.

## How it relates to your own knowledge base — honestly
- **It is not part of your knowledge base.** Product-guide articles don't appear in your library list, aren't counted in your document totals, and don't affect your quality or gap scores.
- **It is read-only.** Every article carries a *provided* badge; there is no edit, delete, or upload here. Your own documents live above it, fully under your control.
- **Only the Workspace Assistant is taught from it.** Your other Digital Employees answer from your own library only — the product guide never leaks into their answers to your customers.
- The assistant still reads your own knowledge too: when you ask it something about *your* business, it answers from your documents, same as any Digital Employee.

## Tips & best practices
- Before writing your own "how do I use DreamTeam" notes, search the product guide — it's probably already covered, kept current by DreamTeam, and already known to your assistant.
- The **used N× in 30d** markers are a quick read on what your team actually asks the assistant about.$k$, encode(digest($k$Workspace Assistant knows**.
4. Use **Search the product guide…** to filter, and click any article to read it in full.
5. Articles the assistant has recently drawn on show a **used N× in 30d** marker.

While searching your own library, you may also see a line like **"Also 3 matches in the DreamTeam product guide →"** — click it to jump into the guide with the same search.

## How it relates to your own knowledge base — honestly
- **It is not part of your knowledge base.** Product-guide articles don't appear in your library list, aren't counted in your document totals, and don't affect your quality or gap scores.
- **It is read-only.** Every article carries a *provided* badge; there is no edit, delete, or upload here. Your own documents live above it, fully under your control.
- **Only the Workspace Assistant is taught from it.** Your other Digital Employees answer from your own library only — the product guide never leaks into their answers to your customers.
- The assistant still reads your own knowledge too: when you ask it something about *your* business, it answers from your documents, same as any Digital Employee.

## Tips & best practices
- Before writing your own "how do I use DreamTeam" notes, search the product guide — it's probably already covered, kept current by DreamTeam, and already known to your assistant.
- The **used N× in 30d** markers are a quick read on what your team actually asks the assistant about.$k$, 'sha256'), 'hex')
from knowledge_docs d join tenants t on t.id = d.tenant_id
where t.slug='outsourcetel-hq' and d.external_ref = 'product-kb/knowledge/what-your-workforce-assistant-knows';
insert into knowledge_doc_chunks (tenant_id, doc_id, chunk_index, content, content_hash)
select d.tenant_id, d.id, 2, $k$— it's probably already covered, kept current by DreamTeam, and already known to your assistant.
- The **used N× in 30d** markers are a quick read on what your team actually asks the assistant about.

## Related articles
- [../getting-started/meet-your-workspace-assistant](../getting-started/meet-your-workspace-assistant.md)
- [adding-documents-to-the-library](adding-documents-to-the-library.md)
- [how-knowledge-powers-your-des](how-knowledge-powers-your-des.md)$k$, encode(digest($k$— it's probably already covered, kept current by DreamTeam, and already known to your assistant.
- The **used N× in 30d** markers are a quick read on what your team actually asks the assistant about.

## Related articles
- [../getting-started/meet-your-workspace-assistant](../getting-started/meet-your-workspace-assistant.md)
- [adding-documents-to-the-library](adding-documents-to-the-library.md)
- [how-knowledge-powers-your-des](how-knowledge-powers-your-des.md)$k$, 'sha256'), 'hex')
from knowledge_docs d join tenants t on t.id = d.tenant_id
where t.slug='outsourcetel-hq' and d.external_ref = 'product-kb/knowledge/what-your-workforce-assistant-knows';
update platform_knowledge_docs set title = $t$What your Workspace Assistant knows — the DreamTeam product guide$t$, content = $c$# What your Workspace Assistant knows — the DreamTeam product guide

## What it is
A read-only set of articles about how DreamTeam itself works, maintained by DreamTeam and shown at the bottom of **Knowledge → Library**. These articles are what your **Workspace Assistant** (previously labelled the Workforce Assistant on some screens; some people also say workplace assistant) is taught from when it answers questions about the platform.

## Why it matters
When the assistant explains a DreamTeam feature, you shouldn't have to take its word for where that came from. This panel is the transparency: you can read exactly what your assistant was told, article by article. It's also why the assistant can answer "how does this platform work?" questions (sometimes asked as "what is this workforce assistance?") that your business Digital Employees aren't set up to cover.

## Step by step
1. Open **Knowledge → Library**.
2. Scroll to the bottom. Below your own documents there's a quiet collapsed row: **DreamTeam product guide**, with the current article count and a **read-only** badge, marked *maintained by DreamTeam*.
3. Click the row to expand **What your Workspace Assistant knows**.
4. Use **Search the product guide…** to filter, and click any article to read it in full.
5. Articles the assistant has recently drawn on show a **used N× in 30d** marker.

While searching your own library, you may also see a line like **"Also 3 matches in the DreamTeam product guide →"** — click it to jump into the guide with the same search.

## How it relates to your own knowledge base — honestly
- **It is not part of your knowledge base.** Product-guide articles don't appear in your library list, aren't counted in your document totals, and don't affect your quality or gap scores.
- **It is read-only.** Every article carries a *provided* badge; there is no edit, delete, or upload here. Your own documents live above it, fully under your control.
- **Only the Workspace Assistant is taught from it.** Your other Digital Employees answer from your own library only — the product guide never leaks into their answers to your customers.
- The assistant still reads your own knowledge too: when you ask it something about *your* business, it answers from your documents, same as any Digital Employee.

## Tips & best practices
- Before writing your own "how do I use DreamTeam" notes, search the product guide — it's probably already covered, kept current by DreamTeam, and already known to your assistant.
- The **used N× in 30d** markers are a quick read on what your team actually asks the assistant about.

## Related articles
- [../getting-started/meet-your-workspace-assistant](../getting-started/meet-your-workspace-assistant.md)
- [adding-documents-to-the-library](adding-documents-to-the-library.md)
- [how-knowledge-powers-your-des](how-knowledge-powers-your-des.md)
$c$ where source_doc_path = 'product-kb/knowledge/what-your-workforce-assistant-knows';
delete from platform_knowledge_chunks pc using platform_knowledge_docs pd
 where pc.doc_id = pd.id and pd.source_doc_path = 'product-kb/knowledge/what-your-workforce-assistant-knows';
insert into platform_knowledge_chunks (doc_id, chunk_index, content)
select pd.id, c.chunk_index, c.content
from platform_knowledge_docs pd
join knowledge_docs d on d.external_ref = pd.source_doc_path
join tenants t on t.id = d.tenant_id and t.slug='outsourcetel-hq'
join knowledge_doc_chunks c on c.doc_id = d.id
where pd.source_doc_path = 'product-kb/knowledge/what-your-workforce-assistant-knows';

-- 4. per-tenant audit trail for a governance-visible rename
do $aud$
declare r record;
begin
  for r in select id, tenant_id from digital_employees where is_workforce_assistant loop
    perform append_audit_event_internal(r.tenant_id, 'DreamTeam', 'system',
      'Workspace Assistant name unified — previously shown as Workforce Assistant on some screens',
      'config_change', jsonb_build_object('kind','de_rename','de_id',r.id,'from','Workforce Assistant','to','Workspace Assistant'));
  end loop;
end $aud$;

-- 5. Asserts — each fails if the FEATURE is broken, not merely if SQL ran
do $a$
declare n int; v_def text; fn text;
begin
  select count(*) into n from digital_employees where is_workforce_assistant and name <> 'Workspace Assistant';
  if n > 0 then raise exception '478: % assistants still carry the old name', n; end if;
  select count(*) into n from digital_employees where is_workforce_assistant and charter::text like '%Workforce Assistant%';
  if n > 0 then raise exception '478: % charters still name the old label', n; end if;
  foreach fn in array array['auto_provision_new_tenant','create_workforce_assistant_de','provision_workforce_assistant_internal'] loop
    select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and p.proname=fn;
    if v_def like '%''Workforce Assistant''%' then raise exception '478: % still mints the old name', fn; end if;
  end loop;
  select count(*) into n from knowledge_doc_chunks c join knowledge_docs d on d.id=c.doc_id where d.external_ref like 'product-kb/%assistant%';
  if n < 10 then raise exception '478: tenant chunks incomplete (%/10)', n; end if;
  select count(*) into n from platform_knowledge_chunks pc join platform_knowledge_docs pd on pd.id=pc.doc_id where pd.source_doc_path like 'product-kb/%assistant%';
  if n < 10 then raise exception '478: shelf chunks incomplete (%/10)', n; end if;
  -- retrieval-level: the renamed title must be lexically findable on the shelf NOW
  select count(*) into n from platform_match_knowledge('what is the workspace assistant', null, 3);
  if n = 0 then raise exception '478: shelf retrieval returns nothing for the unified name'; end if;
end $a$;

notify pgrst, 'reload schema';
