---
title: Embedding the customer Q&A widget
category: Settings & Billing
feature: Widget & API
audience: admin
difficulty: intermediate
tags: [widget, embed, widget key, public, ask, escalation, api, end user]
---

## What it is

A public, self-serve **Q&A widget** you embed in your own product. Your customers' end users type a question, and one of your Digital Employees answers from your knowledge base — with the same grounding, guardrails, and escalation as anywhere else in the platform.

## Why it matters

The widget puts your Digital Employee in front of the people you serve, without giving them a login. It answers common questions instantly and hands anything it isn't sure about to your team, so end users get fast answers and your staff only see what genuinely needs a human.

## Before you start

- You must be in a **live workspace** — the **Widget & API** tab appears only in live mode.
- Your **Anthropic key** must be configured (see [configuring-the-ai-engine](configuring-the-ai-engine.md)); without it the widget returns a "not configured" response.
- You need somewhere to paste a short script — your product's front-end.

## How a question flows

1. An end user asks a question in the widget.
2. The request reaches DreamTeam carrying your **widget key** and an end-user context (which account and person is asking).
3. The key is matched to your workspace, rate-limited, and the asking end user's session is recorded.
4. Your workspace's first eligible Digital Employee answers, using knowledge retrieval (keyword + semantic) and only the documents it's allowed to see.
5. The answer is checked against your guardrails. If a **blocking** rule matches, the answer is withheld and the item is escalated to a human.
6. If the DE's **confidence is below 60**, or it flags that it needs help, the question is **escalated** — it appears in **My Tasks → Approvals & Drafts** for your team, and the end user is told a human will follow up.
7. Otherwise the grounded answer is returned, with the sources it used.

Every widget answer, escalation, and block is written to your activity and audit records, just like internal work.

## Step by step — set it up

1. Open **Settings → Widget & API**.
2. Under **Widget Keys**, type a label (for example *Production portal*) and click **Generate key**. The key (prefixed `dtw_`) is shown **once** — copy it now with the **Copy** button; only a hash is stored, so it can't be shown again.
3. Under **Embed Snippet**, copy the provided script. Paste it into your product and replace the placeholders:
   - `key` — the widget key you just generated.
   - `accountRef` — your identifier for the customer account the user belongs to.
   - `endUserRef` — your identifier for the individual user.
   - `displayName` — the user's name, for friendlier replies and clearer escalations.
4. Publish. You can try the snippet on the linked **demo page**, and there's a full reference in the linked embed docs.

## Options & settings

- **Multiple keys** — generate a separate key per surface (portal, help centre, mobile) so you can track and revoke them independently.
- **Revoke** — click **Revoke** on any key to disable it immediately. Each key row shows when it was created, its request count, and when it was last used.
- **End-User Activity** — a table of recent end users who asked questions, by account, name, and first/last seen.

## Limits (be aware)

- **Ask-only.** A widget key can only ask questions — it can never read or change your data.
- **Suspended workspaces don't answer.** If your workspace is suspended (for example, an expired trial), the widget stops answering until it's reactivated.
- **Rate limited.** Requests are capped per key per minute to protect your budget.
- **Knowledge-bound.** The widget answers only from your knowledge base. If nothing relevant is found, it says the knowledge base is still being set up rather than guessing.
- **One answering employee.** The widget is answered by your workspace's first eligible Digital Employee; the public request can't choose a specific DE.

## Troubleshooting

- **"invalid widget key."** The key is mistyped or has been revoked. Generate a new one and update your snippet.
- **The widget says knowledge isn't ready.** Add documents in **Knowledge → Library** — the DE needs something to answer from.
- **Answers stopped entirely.** Check that the workspace isn't suspended and that the Anthropic key is configured; also check your monthly token budget.
- **I lost the key.** Keys are shown only once. Revoke the old one and generate a replacement.

## Related articles

- [configuring-the-ai-engine](configuring-the-ai-engine.md)
- [managing-your-plan-and-trial](managing-your-plan-and-trial.md)
- [workspace-settings](workspace-settings.md)
