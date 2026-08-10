# Onboarding item execution (2a) — design

**Date:** 2026-08-10
**Status:** design approved, not built
**Scope:** make `owner_type: 'de'` mean something on an onboarding checklist item

---

## The problem, measured

The Onboarding DE opened a real project for Grant Plastics Ltd. and did nothing,
because there was nothing it could do.

| Measurement | Value |
|---|---|
| Checklist items on the Grant Plastics project | 10 |
| …marked `owner_type: 'de'` — the employee's job | **3** |
| …bound to an action that could perform them | **0** |
| Active verbs in the platform catalogue | 68 |
| …that CONFIGURE anything for a customer | **1** (`configure_customer_setup`, ERPNext) |
| `action_executions` whose origin is an employee | **0 of 186** |
| Connected systems in outsourcetel-hq offering a bindable verb | **1** |

A template item declares **who owns it** and nothing about **how it gets done**.
So `owner_type: 'de'` is a promise the schema makes and nothing keeps. The
employee read "this one's yours", had no mechanism, and escalated — task
`0c483f27`:

> Cannot find recorded requirements for Grant Plastics Ltd. … I need the
> documented customer requirements (employee count, locations, leave rules,
> billing preferences, custom needs). Per SOP: never assume defaults.

That escalation is correct behaviour and unanswerable in its current form: it
names five things in prose, none of which map to a field anything reads.

### A correction to an earlier claim

It was first reported that "9 of 10 steps have no verb". That overstates it.
Four items are `human` by design (kickoff call, settings review, UAT sign-off,
training) and two are `either`. A human owning the kickoff call is the design
working. **The real gap is 3 items, not 9.**

### Why this cannot be solved by building a connector

Onboarding at this company spans, simultaneously:

- **A1** setup inside ERPNext (a verb exists)
- **A2** setup inside another system we run (no connector)
- **A3** setup by hand in whatever the client uses (no connector possible)
- **B** setup inside a third-party product we resell or administer (varies per client)

Any design that assumes a verb exists solves one column. Templates are already
**per-tenant** — all 15 tenants own a private copy of "SaaS onboarding —
starter" — which confirms the checklist is tenant data, not platform machinery.

---

## Scope

**In (2a):** a checklist item can name a verb; the employee executes it through
the existing gate; the item completes from the receipt.

**Out, deliberately:**

- **2b — the assisted lane** (employee prepares, human applies, employee records
  evidence). This is what makes A2/A3 produce work rather than a shrug. Held
  back until 2a is proven on real data, and because it may turn out to be a
  better-shaped escalation rather than a new concept.
- **2c — richer authoring** beyond the picker described here.
- **Any new connector.** The portfolio assessment rates this unit thin-demand
  PILOT. A connector built for one client is the most expensive way to learn that.

---

## Design

### 1. What a binding is

Two optional fields on a template item:

```json
{
  "key": "locations_configured",
  "owner_type": "de",
  "action_key": "configure_customer_setup",
  "params": {
    "external_ref":  "@account",
    "territory":     "@ask",
    "payment_terms": "Net 30"
  }
}
```

**Bind by `action_key`, never by id.** `send_payment_reminder` exists as five
rows across five providers, and platform action ids differ per environment.
Resolution happens per tenant at run time against its connected connector — the
idiom `dunning_action_for(tenant, action_key, execution_key)` already uses. A
tenant that swaps ERPNext for Xero keeps working; a stored id would rot.

Each parameter takes exactly one of three forms:

| Form | Meaning |
|---|---|
| `@account` | filled from the project's customer record |
| `@ask` | becomes a question on the project, answered once by a person |
| any literal | fixed value |

**No placeholder syntax, no parser, no namespace validation.** An earlier draft
proposed `{req.territory}` templating; it was removed as a developer tool
wearing an onboarding costume.

### 2. Authoring — the author never types a key

In the template editor, against any employee-owned item, one control:
*"How does the employee do this?"* — listing what this workspace can actually
do, **by label** ("Set a customer's defaults in ERPNext"), not by key. Choosing
one reveals a table of that verb's parameters, each with three choices: *we
already know this* / *ask when we set the customer up* / *always use…*.
Choosing nothing leaves the item behaving exactly as today.

**The questions are not authored — they are generated from the verb.** Every
action definition already carries human-written help text:

> `territory` — "e.g. United Kingdom — must already exist in ERPNext"
> `default_price_list` — "the price list this customer should be billed from"

Those become the prompts on the project's requirements card, so nobody writes
them twice and they cannot drift from the verb they feed.

### 3. Requirements live on the project

`onboarding_projects` gains **`requirements jsonb not null default '{}'`**.

Today the table has nowhere to hold this, which is precisely why the founder's
answer — Net 30, Standard Selling, United Kingdom — had nowhere to land. On the
customer's project a card headed *"Grant Plastics Ltd. — what we need to set
them up"* renders one labelled field per `@ask`, filled once by a person.

**Keyed by `<action_key>.<param>`, not by bare parameter name.** So:

```json
{ "configure_customer_setup.territory": "United Kingdom",
  "configure_customer_setup.default_price_list": "Standard Selling" }
```

Two different verbs can both take a `territory` meaning different things; a flat
key would silently merge them and feed one verb the other's answer. The card
still shows a single field per question, so this costs the user nothing — it is
purely about not colliding underneath.

### 4. Execution

When the employee reaches a bound item:

1. **Resolve** `action_key` against this tenant's connected connectors. Publish
   time checked that the verb was reachable; a connector can be disconnected
   afterwards, so **an unresolvable verb at run time is an escalation, not an
   error** — *"Locations configured needs ERPNext, which is no longer
   connected."* Validation at publish is a courtesy, not a guarantee.
2. **Fill** parameters: `@account` from the project's customer record, `@ask`
   from `requirements`, literals as written.
3. **If an `@ask` is unanswered → escalate, naming it.** Not "cannot find
   recorded requirements" but *"Locations configured needs Territory and Price
   list for Grant Plastics Ltd."* — the same machinery carrying an answerable
   question.
4. **Otherwise propose through the existing path**: `execute_action` →
   `decide_action_execution`. **No second decision path.** Approval, trust
   ceiling, spend cap and the destructive floor apply unchanged.

Because `configure_customer_setup` is `destructive: true`, a person sees it
before it touches a real customer record. That was deliberate at registration
and is kept: **the approval stays in the loop.**

### 5. Completion — from the receipt, never from the employee

**An item completes because evidence arrived, not because the employee said so.**

- on proposal → item moves to `in_progress`
- on execution returning `auto_executed` or `executed_after_approval` → item
  moves to `done`, with the receipt written into its note as evidence
- on refusal, guardrail block or connector error → item stays, reason recorded,
  retried on the next wake — **but a repeatedly failing item escalates once and
  then stops proposing.** Unbounded retry is how this repo built a queue that
  amplifies itself; an item that has failed the same way twice is a question for
  a person, not a thing to try a third time.

This is the repo's most expensive recurring trap — a stored marker read as
truth. Marking `locations_configured` done at proposal time would record work
that no human approved and ERPNext never accepted.

**Consequence, stated plainly:** for a destructive verb the employee cannot
finish the item alone, and should not. It assembles the change; a person
approves; the receipt closes the item. That is one more item in a queue already
running 29:1 created-to-decided — but a *pre-assembled* one, which is the
difference between approving and doing.

### 6. Linkage and idempotency

`action_executions` already carries `subject_kind` / `subject_id`. The execution
records `subject_kind = 'onboarding_item'`, the project id, and the item key —
which is what lets completion follow evidence, and what makes the dedupe key
natural so a re-run cannot apply the same change twice.

---

## Data model changes

| Change | Detail |
|---|---|
| `onboarding_projects.requirements` | new `jsonb not null default '{}'` |
| template item schema | optional `action_key text`, optional `params jsonb` |
| `validate_onboarding_items` | extended: if `action_key` is present the item must be `owner_type: 'de'`, every param value must be `@account`, `@ask` or a literal, and every **required** parameter of that verb must appear as a key in `params` — *named*, not answered. `@ask` is a valid answer to "is it named"; whether it has a value is a run-time question, not a publish-time one. |
| execution linkage | `subject_kind = 'onboarding_item'` + item key |

Nothing existing changes shape. `update_onboarding_item_as_de` already moves an
item and records a note; `validate_onboarding_items` already guards item shape.

---

## UI

Both pieces land in `CustomerOnboardingLive.tsx`, which already owns template
authoring and project tracking — but **as new components, not more lines**. That
file is 783 lines carrying two responsibilities; adding a picker and a form
inline would push it past comfortable.

- `VerbBinding` — the picker plus the three-way field table (template editor)
- `ProjectRequirements` — the generated card (customer project)

Design System v1 primitives only. Adoption is part of shipping, and a new
surface inside an old page is exactly where drift starts.

**Honest limit:** for most workspaces the picker will list very few verbs —
outsourcetel-hq has one connected system offering anything bindable. The screen
will look sparse. That is the truth of the situation, not a UI defect.

---

## Verification

*This section was written into the spec rather than walked through in
conversation — it is the part to read most sceptically.*

The feature is proven when **`action_executions` contains a row whose origin is
an employee**, produced by an onboarding item, on real production data. That
number is 0 of 186 today and is the single honest measure of success. Nothing
below substitutes for it.

**Gates that must be able to fail** (each mutation-tested: inject the violation,
confirm red, restore, confirm green):

1. **A bound item on a non-`de` owner is rejected** at publish time.
2. **A binding naming a verb this tenant cannot reach is rejected** at publish
   time — a template that cannot run is a promise that will break at 2am.
3. **A binding missing a required parameter of its verb is rejected** at publish
   time, not discovered at run time.
4. **An item cannot reach `done` without a corresponding execution receipt.**
   This is the completion-from-evidence rule; assert it as an invariant over
   `onboarding_projects` × `action_executions`, and mutate by marking an item
   done with no execution.
5. **The offer list still gates it.** An employee not offered the bound verb must
   not execute it — `configure_customer_setup` currently reaches 13 employees
   with `requires_role = null`, which is worth revisiting separately.

**Live proof, in order:**

1. Bind `locations_configured` on outsourcetel-hq's template to
   `configure_customer_setup`, with territory and price list as `@ask`.
2. Confirm the employee escalates naming *those two fields* — the improved
   escalation is itself a deliverable, and this is the state Grant Plastics is
   in today.
3. Fill the requirements card with Net 30 / Standard Selling / United Kingdom.
4. Wake the employee; confirm it proposes, and that the proposal is
   `human_gated_destructive`.
5. Approve it; confirm the receipt lands, the item flips to `done` carrying that
   receipt, and `origin_kind = 'de'` appears for the first time.
6. Wake again; confirm the dedupe key prevents a second application.

**Explicitly not proof:** the item turning green in the UI, the employee
reporting success in prose, or a passing unit test with a mocked connector.
Every one of those has been mistaken for evidence in this repo before.

---

## Risks

| Risk | Response |
|---|---|
| Builds machinery for a unit whose real constraint is demand | Accepted knowingly. The portfolio assessment stands: this makes the machine real, it does not create a book of business. |
| Only one item type lights up | True, and the reason 2a comes first — prove the loop on one verb before building more. |
| Adds to the 29:1 decision queue | The added item is pre-assembled. If the queue is the binding constraint, that is an argument for trust promotion, not for skipping the approval. |
| `configure_customer_setup` is offered to 13 employees | Pre-existing, out of scope here, worth its own change — the offer list is the authorisation boundary. |
| Per-tenant templates mean 15 copies to update | Only tenants that bind anything are affected; unbound items behave exactly as today. |

---

## Decisions taken

- Bind by `action_key`, resolved per tenant — not by action id.
- No placeholder syntax; three field forms only.
- Requirements questions generated from the verb's own help text.
- Approval stays in the loop for destructive verbs.
- Completion follows the receipt, never the employee's claim.
- No new connector, and no assisted lane, in 2a.
