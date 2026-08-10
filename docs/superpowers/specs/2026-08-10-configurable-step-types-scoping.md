# Configurable onboarding step types — scoping note

**Date:** 2026-08-10
**Status:** scoping only. No design, no plan, nothing built.
**Why this exists:** the founder asked for onboarding steps that carry text,
document instructions, spreadsheets, PDFs, links and systems/tools connections.
Brainstorming established that is **four subsystems, not one**. This note records
the decomposition and the dependency order so the next session does not have to
rediscover it.

---

## What the founder asked for, and what is already built

| Requested type | Status |
|---|---|
| systems / tools connection | **DONE** — the verb binding, migs 674–681. A step names an `action_key`, params fill from the customer record or are asked of a person, execution goes through the approval gate, and the item completes only on the receipt. |
| text / information | **PARTLY** — items already carry `description` (plain text). |
| document instructions, spreadsheets, PDFs, links | **NEW** — but on an unused foundation (below). |

**The item shape today** — nine keys on `onboarding_templates.items` /
`onboarding_template_versions.items`:

```
key · label · phase · owner_type · requires_signoff · description · verify · action_key · params
```

**The storage foundation already exists and has never been used.** Migration 652
restored `media_assets` (`id, tenant_id, definition_id, kind, title,
storage_path, mime, size_bytes, created_by, created_at`) plus two private buckets
`playbook-media` and `specialist-media`. **0 rows, 0 objects.** `definition_id`
already generalises to "the thing this asset belongs to", so attaching to an
onboarding item is wiring rather than invention.

---

## The two founder answers that shape everything

**1. Attachments are BOTH kinds, declared per attachment.** Some are
instructions for a person ("here's how we run discovery", a template to fill in,
a link to the standard form). Some are input the employee consumes.

⚠ **Design consequence:** the two kinds must be *visibly different* in the UI and
in the data model. A file nobody can act on, sitting beside a file the employee is
expected to parse, with the same icon and the same upload button, is how you ship a
step that looks configured and does nothing.

**2. The employee needs both to READ content and to EXTRACT records.** Reading is
reachable now. Extraction is not — see the dependency below.

---

## The four subsystems

**1 — Attachment store and authoring.**
Upload a file or add a link, attach it to a step, display it, control visibility.
Everything else depends on this. The storage exists; this is wiring.

**2 — Employee-readable content.**
A step's documents become part of what the employee knows, through the existing
grounding path. This is what lets it answer a discovery escalation from an
attached requirements doc instead of asking a person to retype values.

**3 — Extraction.**
Parse a spreadsheet or PDF into structured records. Real work: schema inference,
validation, and "the export had 14 columns we didn't expect" as a normal outcome
rather than a crash.

**4 — Destination verbs.**
Somewhere to PUT extracted records — an import verb that creates 200 employees in
a target system.

### ⚠ The dependency that decides the order

**3 is useless without 4.** A parser producing a list nobody can act on is a demo.
This is the same wall this whole workstream hit: `employees_imported` is marked
`owner_type: 'de'` and has **no verb behind it** — that finding is what started
migrations 674–681. The platform's ~68 active verbs are overwhelmingly
comment / reply / tag / note; exactly one configures anything for a customer
(`configure_customer_setup`, ERPNext, added in this workstream).

**4 is the harder project**, and it is blocked on a product question, not on
engineering. The founder confirmed onboarding spans, simultaneously:
setup inside ERPNext (a verb exists), setup inside another system we run (no
connector), setup by hand at the client (no connector possible), and setup inside
third-party products we resell or administer (varies per client). **There is no
single destination to build against.** Settle that before designing extraction.

### Order

```
1 → 2 → (4 → 3)
```

---

## Recommendation

**Spec sub-project 1 on its own, in a fresh session.**

It is the foundation, it is genuinely reachable, the storage already exists, and it
delivers real value alone: steps that carry the document instructions, links and
templates a person needs — most of what was asked for, none of it blocked on a
connector.

**2 follows quickly and cheaply** once 1 exists, because the grounding path is built.

**Hold 3 and 4** until the destination question is settled. Designing an extraction
pipeline against a destination that does not exist is the most expensive possible
way to learn that.

### Context the next session needs

- `docs/superpowers/specs/2026-08-10-onboarding-item-execution-design.md` — the item
  model, the binding design, and the corrections that came out of implementing it
- `docs/superpowers/plans/2026-08-10-onboarding-item-execution.md` — how the item
  execution plan was structured, and the constraints that bind this area
- `supabase/migrations/652_*.sql` — why `media_assets` exists and what it was for
- The starter template is now **16 items across 6 phases** (mig 685), including a
  post-go-live `handoff` phase

### Constraints that will bind sub-project 1

- **Templates are per-tenant.** All 15 tenants own a private copy; some may be
  edited. Never overwrite one — extend, or change the seed for new tenants only.
- **`validate_onboarding_items(p_items, p_tenant_id)`** polices the item shape at
  publish time and must learn any new keys. It rejects a binding whose verb the
  workspace cannot reach (mig 681).
- **Publishing requires a signed-in owner/admin** — `publish_onboarding_template`
  refuses a JWT-less caller by design. A script cannot publish, and should not try.
- **Buckets are private.** Any display path needs signed URLs; do not make a bucket
  public to make a demo easier.
- **`certify` Ring-0 probes** guard this area: `onboarding-bindings-are-runnable`,
  `bound-onboarding-items-complete-from-evidence`, and
  `no-untyped-literal-appended-to-a-container`. New SQL must not trip them, and new
  invariants should arrive with a probe **and** a mutation case.

---

## Still open from the parent workstream

- **`action_executions.origin_kind = 'de'` is 0.** The onboarding execution path has
  never run end to end. It is blocked on two browser steps only a workspace owner can
  take: publish the outsourcetel-hq draft, then re-point the Grant Plastics project at
  the new version.
  ⚠ **The metric itself was wrong** and is corrected here: `perform_onboarding_item`
  passes `origin_kind = 'de_work_item'`, never `'de'`, so that number can never move.
  The honest discriminator is `dedupe_key like 'onboarding:%'`.
- **"Progress tracking"** was deliberately not shipped as a checklist item — `progress_pct`
  is already computed from item state, so a "progress tracked" box would raise the very
  number it claims to track. The recurring half belongs in a scheduled driver, like dunning.
- **14 tenants still carry the 10-step starter.** Migrating them is a UI opt-in, not
  something to do on their behalf.
