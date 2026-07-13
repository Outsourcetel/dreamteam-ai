---
title: Configuring the AI engine
category: Settings & Billing
feature: AI Engine
audience: admin
difficulty: intermediate
tags: [ai engine, api keys, anthropic, openai, google, model, tokens, budget]
---

## What it is

The **AI Engine** tab in **Settings** is where the AI provider keys that power every Digital Employee are stored — an Anthropic key (required), plus optional OpenAI and Google AI keys.

## Why it matters

No key, no answers. The Anthropic key is what lets your Digital Employees respond at all. The optional keys unlock better search and additional models. Because the keys are shared across every workspace you run, this tab is managed by your **platform team**, not by individual workspace admins.

## Before you start

- **This tab is only visible to platform-team members.** If you administer a single workspace, you won't see the AI Engine tab — the keys are configured centrally for you. This article is for whoever runs the platform.
- You'll need the API keys themselves, from each provider's console.

## Step by step

1. Open **Settings** and select the **AI Engine** tab.
2. Paste your **Anthropic API Key** (from console.anthropic.com → API Keys). This is required — until it's set, DE responses are disabled and the field shows *"Not set — DE responses disabled."*
3. Optionally paste an **OpenAI API Key** to enable vector/semantic search across the knowledge base, which noticeably improves answer quality. Without it, search falls back to keyword matching.
4. Optionally paste a **Google AI Key** (from aistudio.google.com → API Keys) to make Gemini models available.
5. Click **Save Keys**. Edge functions pick up the new keys immediately, and each field flips to a **Configured** status.

To replace an existing key, type the new one into the same field and save — the field shows a "Configured" badge until you do.

## Options & settings

- **Anthropic API Key** — required; powers all Digital Employee responses.
- **OpenAI API Key** — optional; turns on semantic/vector knowledge search. When unset, knowledge search is keyword-only.
- **Google AI Key** — optional; enables Gemini models (for example Gemini 1.5 Flash and Gemini 2.0 Flash).
- **Per-DE model choice** — individual Digital Employees can be set to use a specific model; each DE's answers use the model it's configured for, falling back to the platform default. This is configured on the employee, not on this tab.

## How keys are stored (the honest note)

Keys are **stored encrypted in your database and shared across all your client tenants**. They are not per-workspace secrets — one set of provider keys serves every workspace you operate. You control spend per workspace through token budgets, not through separate keys.

## How billing works

- You pay the AI provider (for example Anthropic) directly for token usage across all workspaces.
- Each workspace has a **monthly token budget** you set — its DEs stop responding when the budget is reached (see [managing-your-plan-and-trial](managing-your-plan-and-trial.md) and the **Usage & Budgets** tab).
- Token costs are small — on the cheapest model, a short query is on the order of a tenth of a cent — so you can either absorb AI usage into your service fee or charge it on at your own margin.

## Troubleshooting

- **"DEs aren't answering and I'm a platform admin."** Check the AI Engine tab — if the Anthropic key shows *Not set*, add it.
- **"Search quality is poor."** Add an OpenAI key to enable semantic search; keyword-only search misses paraphrased questions.
- **"I don't see the AI Engine tab."** You're a workspace-level admin. Key configuration is platform-only by design; contact whoever runs your platform.

## Related articles

- [managing-your-plan-and-trial](managing-your-plan-and-trial.md)
- [workspace-settings](workspace-settings.md)
- [embedding-the-customer-widget](embedding-the-customer-widget.md)
