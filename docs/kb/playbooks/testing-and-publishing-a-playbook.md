---
title: Testing and publishing a playbook
category: Playbooks
feature: Playbook Builder
audience: admin
difficulty: intermediate
tags: [playbooks, dry-run, preview, publish, versioning, snapshot]
---

# Testing and publishing a playbook

## What it is
Before a playbook can run, it has to be validated and published. Publishing takes an **immutable version snapshot** — the exact steps at that moment — and it's that snapshot, not your live draft, that every run executes. This article covers previewing a draft safely, publishing it, and how versioning works.

## Why it matters
You don't want to discover a mistake on a real account. The **Dry-run preview** lets you watch a playbook's path with nothing actually happening. And because publishing snapshots an immutable version, editing a playbook later never disturbs runs already in flight — they keep executing the version they started on.

## Before you start
- Your playbook should have no red validation errors in the builder (the Publish button stays disabled until client-side validation passes).
- To preview a run you need at least one account to simulate against.

## Step by step

### 1. Fix validation first
The builder validates live and flags problems under each step, plus playbook-wide errors near the buttons. Common ones: the last step must be **Complete**; at most one Generate invoice and one Human approval; Human approval must follow Generate invoice; and any step that references an earlier one (like a Decision) must point *backward*. Clear every red message.

### 2. Run a Dry-run preview
At the bottom of the builder, open **Dry-run preview** and click **Try it**:

1. Pick an account to simulate against.
2. Click **Run preview**.
3. Read the simulated timeline. Each step shows done, skipped, waiting, or failed, with a detail line.

In preview mode, connector calls and writes are **simulated** — nothing is called externally and nothing is persisted (no run row, no audit events, no human tasks). Human gates never pause; you see the full path in one pass. The decision, instruction, and checklist *logic* still runs for real, so the branch path you see is trustworthy. Preview is available even for an unsaved draft.

### 3. Publish
Click **Publish**. The server re-validates everything independently of the browser. If it passes, the server:

- creates an immutable **version snapshot** of the steps, and
- sets the playbook's status to **published**, bumping its version number.

If the server rejects the publish, the flagged steps are highlighted — fix them and publish again.

### 4. Run it
Open the published playbook, pick an account, and click **▶ Run v[n]**. The run executes the published snapshot server-side. A run started at the human approval gate shows as "paused at the human approval gate" — handle it in Human Tasks.

## Versioning and immutable snapshots
- Each publish creates a new, frozen version. The playbook detail view shows the current **v[n]**.
- **Runs execute the snapshot, never the live draft.** A run records which version it ran (`v[n]` appears in run history), and later edits never touch in-flight runs.
- Editing a published playbook just changes its draft steps. The next time you publish, it snapshots **version + 1** — the Edit button even reads "Edit (next publish → v[n+1])."
- **Archiving** a playbook removes it from the active library without deleting its history. Runs and versions remain.

## Options & settings
- **Save draft** — keep working; not runnable.
- **Try it / Run preview** — simulate a run, nothing persisted.
- **Publish** — server-validate and snapshot a version.
- **Run v[n]** — execute the published snapshot against a chosen account.
- **Triggers** (on a published playbook) — add schedules or event rules so it runs automatically. A note reminds you that triggers won't start runs until the playbook is published.

## Tips & best practices
- Preview against a couple of different accounts — one that exercises the "then" branch of a decision and one that exercises the "else."
- Publish deliberately. Each publish is a version people can point to; keep your changes coherent per version.
- If a big change is risky, remember in-flight runs are safe on their own snapshot — you can publish the new version without disrupting them.
- Use run history's version tag to confirm which version actually ran when you're diagnosing behavior.

## Troubleshooting
- **Publish is greyed out.** Client-side validation errors remain. Resolve every red message.
- **The server rejected my publish.** It re-validates independently; read the highlighted steps, fix, and retry.
- **My edit didn't change a running playbook.** Expected — runs use the snapshot from when they started. Publish a new version for future runs.
- **Preview shows a step "skipped."** In preview, external systems are simulated; a skip often means "no connected system for this action" — that's the honest degradation you'd see live too.

## Related articles
- [building-your-first-playbook](building-your-first-playbook.md)
- [step-types-explained](step-types-explained.md)
- [human-approval-and-escalation-in-playbooks](human-approval-and-escalation-in-playbooks.md)
- [what-are-playbooks](what-are-playbooks.md)
