---
title: Creating a Digital Employee
category: Digital Employees
feature: Workforce / Roster
audience: admin
difficulty: beginner
tags: [create digital employee, add DE, roster, role, persona, model]
---

# Creating a Digital Employee

## What it is
Adding a new Digital Employee to your Roster. This creates the employee's identity — a name, a role, and a description — so you can then configure what it knows and does.

## Why it matters
Creating a DE is intentionally generic: the same simple form works for any department (Support, Account Success, Finance, Onboarding, and so on). You don't wire up a department-specific bot — you add an employee and then configure it.

## Before you start
- You must be a **workspace owner or admin**. Creating a DE is restricted to those roles and enforced on the server.
- Have a plain-language idea of what this employee will be responsible for. You don't need to have its knowledge or system access ready yet — those come after.

## Step by step
1. Open **Digital Employees** from the navigation.
2. In the **Your Digital Employees** panel, click **+ Add a Digital Employee**.
3. Fill in the form:
   - **Role / label (required)** — the job title, e.g. *Account Success DE*. This is the only required field.
   - **Persona name (optional)** — a human first name the employee answers as, e.g. *Jordan*. If you set one, customers and audit records see "Jordan"; if you leave it blank, the role label is used.
   - **Department** — e.g. *Account Success*. Used for grouping and shown on the profile.
   - **What does this Digital Employee do?** — a short, plain-language description of what it's responsible for.
4. Click **Create**.

The new employee appears in the Roster immediately.

## What happens on creation
- The DE starts at trust level **supervised**, with a default confidence threshold of **75%** and **no required-approval** default.
- It starts with **no data access and no playbooks** — you (or an admin) grant those next, the same way for every DE.
- Its lifecycle stage starts at **Designed** (see *the-de-lifecycle*).

## Picking its category, role, and model
The quick-create form keeps things minimal. You set the rest from the DE's profile after it's created:

- **Category & role** — the create form captures the role label and department. You can refine the employee's **display title**, **purpose statement**, **primary business outcome**, and **responsibilities** in the **Identity & Purpose** panel on the profile. These feed directly into every answer the employee gives.
- **AI model** — open the **AI Engine** panel on the profile to choose which Claude model this employee thinks with. Options include **Claude Sonnet 5** (balanced, the default), **Claude Haiku 4.5** (fastest, most economical), and **Claude Opus 4.8** (most capable). Every listed model has verified pricing, so cost numbers stay accurate whichever you choose. The choice takes effect on the employee's next answer.

## Tips & best practices
- Set a **persona name** if this DE talks to customers — a real first name reads better than "Account Success DE."
- Write the **description** and **responsibilities** carefully: they are part of the employee's working instructions, not just labels. A clear "what you do" produces better-scoped answers.
- Start narrow. You can always widen a DE's knowledge and access later; you can't un-send an answer it gave with access it shouldn't have had.

## Troubleshooting
- **"Failed to create the Digital Employee. Only workspace owners/admins can do this."** — Your role can't create DEs. Ask an owner or admin.
- **No name entered** — the role/label field is required; the form asks you to give the employee a name or role label before creating.

## Related articles
- understanding-digital-employees
- the-de-profile-page
- configuring-what-a-de-knows-and-does
- the-de-lifecycle
