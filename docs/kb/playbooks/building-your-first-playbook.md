---
title: Building your first playbook
category: Playbooks
feature: Playbook Builder
audience: admin
difficulty: beginner
tags: [playbooks, builder, draft, publish, steps]
---

# Building your first playbook

## What it is
A walkthrough of the Playbook Builder — creating a new playbook, adding and ordering steps, saving a draft, and publishing it so it can run.

## Before you start
- You need access to the **Playbooks** page in your workspace.
- Have a rough procedure in mind: what should happen, in what order, and where a person needs to approve something.
- If your playbook will read from or write to a connected system, that connector should already be set up (see the Connectors help). If it isn't, the step still saves — it just degrades honestly at run time.

## Step by step

### 1. Open the builder
Go to **Playbooks**. Under **Your playbooks**, click **+ New playbook**. A new playbook opens with a small starter template already filled in (check account → generate invoice → human approval → log activity → complete). You can keep, edit, or delete any of those steps.

### 2. Name it and give it a key
At the top of the builder, fill in:

- **Playbook name** — a human name, e.g. "Renewal follow-up".
- **key** — a short slug (letters, numbers, underscores), e.g. `renewal_followup`. The key is permanent once the playbook is created; the name and description can change later.
- **Description** — one line on what this playbook does.

### 3. Add steps
Below the step list are three rows of add buttons, grouped **Do something**, **Guide & explain**, and **Flow control**. Click any **+ [step name]** button to append that step. New steps insert just before the final **Complete** step. Each step type is explained in [step-types-explained](step-types-explained.md).

As you add a step, an inline editor appears so you can fill in its details — a query to look up, a message template, which connector action to run, and so on.

### 4. Order the steps
Every step has **↑** and **↓** arrows on its right side to move it up or down, and an **✕** to remove it. Ordering is free — for example, **Check account** no longer has to be step 1; place it wherever the account's fields are first needed. The one fixed rule: the last step must be **Complete**.

### 5. Watch the live validation
The builder validates as you type and flags problems in red under the affected step (for example, "A knowledge check needs something to look up"). Some rules are structural — at most one Generate invoice, at most one Human approval, and Human approval must come after Generate invoice. Fix any red messages before publishing; you can still **Save draft** with errors present.

### 6. Save a draft
Click **Save draft**. This stores the playbook in an editable state. Drafts are never executable — you can't run a draft. Come back and edit it as often as you like.

### 7. Try it (optional but recommended)
At the bottom of the builder is **Dry-run preview**. Click **Try it**, pick an account, and **Run preview** to simulate the whole playbook. Connector calls and writes are simulated, nothing is persisted, and human gates never pause — it's a safe way to see the path a run would take. See [testing-and-publishing-a-playbook](testing-and-publishing-a-playbook.md).

### 8. Publish
When the playbook is clean, click **Publish**. The server re-validates everything and, if it passes, takes an immutable version snapshot and sets the status to **published**. Now you can run it.

## Options & settings
- **Save draft** — persist your work; keeps status as draft.
- **Publish** — server-validate and snapshot a version. If the server rejects it, the flagged steps are highlighted and you fix and retry.
- **Cancel** — leave without saving the latest changes.
- **{{ templates }}** — the help popover in the top-right lists the template variables you can drop into step text (see [using-variables-in-steps](using-variables-in-steps.md)).

## Tips & best practices
- Start small. A three- or four-step playbook that works beats a twenty-step one you can't reason about.
- Use a **Dry-run preview** before every publish — it catches ordering mistakes the validator can't.
- Put a human approval gate wherever the DE would otherwise commit to something you'd want to eyeball first.
- Keep the key stable and meaningful — it shows up in the audit trail and run history.

## Troubleshooting
- **The Publish button is disabled.** There are still client-side validation errors. Resolve every red message under the steps first.
- **Publish failed with a server message.** The server re-validates independently. Read the flagged steps, correct them, and publish again.
- **I can't run my playbook.** Only **published** playbooks run. Drafts show "Publish this draft to run it."
- **The page shows a "missing tables" notice.** The playbook backend isn't provisioned for this workspace yet — contact your administrator.

## Related articles
- [what-are-playbooks](what-are-playbooks.md)
- [step-types-explained](step-types-explained.md)
- [testing-and-publishing-a-playbook](testing-and-publishing-a-playbook.md)
- [using-variables-in-steps](using-variables-in-steps.md)
