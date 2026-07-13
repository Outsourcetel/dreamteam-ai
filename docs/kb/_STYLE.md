# DreamTeam AI Knowledge Base — Authoring Style Guide

This is the customer-facing help center for DreamTeam AI. Every article must be
**accurate to the real product** and written for a **non-technical customer admin**
setting the platform up for the first time.

## Golden rule: ground everything in the real code
Before writing an article, READ the actual page component and its API layer.
Document only what actually exists. Use the **real button, tab, field, and menu
labels** exactly as they appear in the UI code. If a feature shows an honest
"empty state" or is deferred, say so plainly — never invent capabilities.

- Live pages (the real product): `src/pages/tenant/**/Live*.tsx` and their
  siblings; APIs in `src/lib/*Api.ts`; backend in `supabase/functions/**` and
  `supabase/migrations/**`.
- Prefer the `Live*` variant over any demo variant when both exist.

## Article file format
One article per `.md` file under `docs/kb/<category-slug>/<article-slug>.md`.
Start every file with YAML frontmatter, then the body:

```
---
title: A clear, task-oriented title (how a customer would search for it)
category: <Category Name>
feature: <Module/Feature this belongs to>
audience: admin | end-user
difficulty: beginner | intermediate | advanced
tags: [comma, separated, real, keywords]
---
```

## Body structure (use these H2 sections, in this order; omit any that don't apply)
- **What it is** — 1–3 sentences, plain language.
- **Why it matters** — the business value / when you'd use it.
- **Before you start** — prerequisites, required role/permission, dependencies.
- **Step by step** — numbered steps referencing the REAL UI (e.g. "Open **Knowledge → Library**, click **+ Add Document**"). Be specific and complete.
- **Options & settings** — the meaningful fields/toggles and what each does.
- **Tips & best practices** — real, useful guidance.
- **Troubleshooting** — common issues and honest limits.
- **Related articles** — link slugs of sibling articles.

## Voice
- Plain, warm, direct. Short sentences. Active voice.
- Name things the way the UI names them. Explain any necessary concept once.
- No code dumps, no internal table/function names in the body (those are for you
  to verify accuracy, not for the customer).
- Never promise a feature that isn't built. Honesty over polish.

## Categories (the KB taxonomy)
1. `getting-started` — what DreamTeam is, core concepts, first login, Company Setup wizard, navigating the app
2. `digital-employees` — the Roster, creating/configuring a DE, the DE profile, lifecycle stages, the Trust dial, DE at Work, Specialist Desk, teams/health/development
3. `knowledge` — Library, Ingestion & Sources, Gap Detection, Quality & Coverage, Self-Learning
4. `playbooks` — Playbook Builder, step types, per-step rules, testing/publishing, agentic steps
5. `connectors` — connecting a system, credentials & security, ingest control, actions, OAuth apps
6. `governance` — Guardrails & Compliance, Audit Trail, Security & Access, Data Access, Identity & Credentials, Trust & Architecture
7. `performance-outcomes` — Performance, Outcomes, Insights, Proving Ground (evals)
8. `company-data` — the entity/records spine, Customer/Account pipelines (BD, Sales, Onboarding, Support, Success, Renewal), custom vocabulary
9. `tasks-approvals` — Approvals & Drafts, Activity Log, escalations & the human-in-the-loop
10. `settings-billing` — Settings, AI engine keys, plan/trial/billing, the public Q&A widget
