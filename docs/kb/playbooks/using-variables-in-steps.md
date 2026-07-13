---
title: Using variables in playbook steps
category: Playbooks
feature: Playbook Builder
audience: admin
difficulty: intermediate
tags: [playbooks, templates, variables, template variables, steps]
---

# Using variables in playbook steps

## What it is
Most step fields — a message, a task title, a knowledge query, a connector action's parameters, an agentic goal — accept **template variables**. These are placeholders written in double curly braces, like `{{account.name}}`, that get filled in with real values when the run executes. They let one playbook adapt to whatever account or event it's running against.

## Why it matters
Without variables you'd hardcode a single account's details and the playbook would only be right once. With them, "Renewal follow-up for {{account.name}} — invoice {{invoice.amount}}" renders correctly for every account the playbook ever runs against.

## Where to find the list
In the builder, the top-right **{{ templates }} ▾** button opens a popover listing every available variable and what it means. You can drop any of these into a text field.

## The variables

- **`{{account.name}}`** — the served record's name. Available after a **Check account** step has run.
- **`{{invoice.amount}}`** — the invoice amount, formatted (for example `$12,000`). Available after a **Generate invoice** step.
- **`{{run.id}}`** — the current playbook run's id.
- **`{{party.FIELD}}`** — a custom field on the served record, for example `{{party.region}}`. These come from your workspace's custom fields and are available after **Check account**.
- **`{{event.ref}}`** — for a run started by an event trigger, what triggered it (for example the ticket or invoice id).
- **`{{event.note}}`** — a short description of the triggering event.
- **`{{steps.N.FIELD}}`** — a value recorded by an earlier step. `N` is the step's position, counting from 0 (so the first step is `steps.0`).

## Referencing an earlier step's output
`{{steps.N.FIELD}}` is how you thread one step's result into a later step. The step index is **zero-based**: the first step in the list is `0`, the second is `1`, and so on.

Which fields are available depends on the step:

- Any step exposes its **`status`** (for example `done`, `skipped`, `failed`) via `{{steps.N.status}}` and its recorded **`detail`** via `{{steps.N.detail}}`.
- A **Check account** step records `account_name`, `arr_cents`, and `renewal_date`.
- A **Check knowledge** step records `found` (whether anything matched) and `matches` (how many).
- If you reference a step with no specific field — `{{steps.N}}` — you get that step's main recorded value.

An unknown or not-yet-run token renders as an empty string — the braces never leak into a customer-facing message.

## Using step results in a Decision
The same references power **Decision** steps. When you build a decision, you pick a prior step and a field to look at, then a comparison. For example, after a **Check knowledge** step you can branch on whether it found anything — the decision looks at `step:N.found`. This is the clean way to say "if we found a policy, do X; otherwise escalate." Decisions can only look at **earlier** steps.

## Tips & best practices
- Add a **Check account** step before any step that uses `{{account.name}}` or `{{party.*}}`, or those tokens resolve to empty/default values.
- Remember the zero-based counting for `{{steps.N}}` — the third step is `steps.2`, not `steps.3`.
- Use `{{event.ref}}` / `{{event.note}}` only in playbooks you expect to be started by an event trigger; in a manual run they're empty.
- Keep templated text readable even if a variable comes out empty, so a missing value never produces a confusing message.

## Troubleshooting
- **My variable came out blank.** Either the producing step hadn't run yet, the field name is wrong, or (for account/party fields) there was no preceding Check account step.
- **My `{{steps.N}}` points at the wrong step.** Check your counting — the first step is index 0.
- **A Decision always takes the Else branch.** Confirm the field you're comparing is actually recorded by that step (for example, branch on `found` for a knowledge check, not on a field that step doesn't produce).

## Related articles
- [step-types-explained](step-types-explained.md)
- [building-your-first-playbook](building-your-first-playbook.md)
- [agentic-steps](agentic-steps.md)
