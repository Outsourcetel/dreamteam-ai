# Onboarding step attachments (sub-project 1) — design

**Date:** 2026-08-11
**Status:** design, not built. No migration claimed, nothing applied, no UI written.
**Scope:** sub-project **1 only** of the configurable-step-types decomposition —
the attachment store and its authoring. Sub-projects 2 (employee-readable
content), 3 (extraction) and 4 (destination verbs) are out; 3 and 4 remain
blocked on the unsettled destination question recorded in the scoping note.

**Brief:** `docs/superpowers/specs/2026-08-10-configurable-step-types-scoping.md`
**Item model:** `docs/superpowers/specs/2026-08-10-onboarding-item-execution-design.md`
**Storage history:** `supabase/migrations/652_the_table_that_was_dropped_for_being_empty.sql`

---

## 0. The scoping note's claims, checked against production

The note was written 2026-08-10 and several of its claims carry the design. Each
was re-read against the live database and the current tree on 2026-08-11 before
anything below was written. Four hold. Three had drifted, and one of those
changes a design decision.

| Claim | Verdict | Evidence |
|---|---|---|
| `media_assets` exists with the ten stated columns | **TRUE** | `information_schema.columns` returns exactly `id, tenant_id, definition_id, kind, title, storage_path, mime, size_bytes, created_by, created_at`. RLS on, three policies (select/insert/delete — **no UPDATE policy**). `CHECK (kind in ('document','image','video'))`. |
| Two private buckets `playbook-media` / `specialist-media` exist | **TRUE** | `storage.buckets` → both present, both `public = false`. Both have `file_size_limit = null` and `allowed_mime_types = null`. Note 652 itself only creates `playbook-media`; `specialist-media` survives from mig 024/031 and was never dropped. |
| Still 0 rows / 0 objects | **TRUE** | `media_assets` = 0 rows. `storage.objects` = **0 rows in the entire project**, not merely in those two buckets. The feature has genuinely never been used. |
| The item shape is the stated nine keys | **TRUE** | Across all 363 item objects in `onboarding_templates` ∪ `onboarding_template_versions`, exactly nine distinct keys occur: `key`(363) `label`(363) `phase`(363) `owner_type`(363) `requires_signoff`(363) `description`(355) `action_key`(5) `params`(5) `verify`(4). No tenth key anywhere. |
| `validate_onboarding_items` polices the shape at publish and rejects an unreachable verb | **TRUE, and stricter than described** | It now has a **third** reachability arm — rule (g), mig 693: a verb the *onboarding desk employee* cannot reach by **role** is rejected too, not only one no connector can run. All three reachability questions are answered by one function, `public.onboarding_verb_verdict(tenant, action_key)`, which both the validator and certify call. Do not re-inline that predicate. |
| `publish_onboarding_template` refuses a JWT-less caller | **TRUE** | `raise exception` unless `tenant_id = auth_tenant_id() and auth_has_tenant_role(array['tenant_owner','tenant_admin'])`. With no JWT `auth_tenant_id()` is NULL, so the comparison fails and it raises. A script cannot publish. |
| **The starter template is 16 items across 6 phases** | **DRIFTED** | The *seed function* `starter_onboarding_template()` is 16 items / 6 phases — true. **No tenant's template matches it.** outsourcetel-hq's draft is **15 items / 6 phases** (`leave_rules_configured` is absent; it is present in the canonical list at mig 685 line 187, so it was deleted by a tenant edit after 685's merge — draft `updated_at` 2026-08-10 23:24, after v4/v5 were published at 21:51, both already 15). The other 14 are still the **10-item / 5-phase** v1 from July. |
| **All 15 tenants own a private copy** | **DRIFTED** | There are **16** tenants. **15** own a starter; `Demo Workspace` (slug `outsourcetel`, not to be confused with `outsourcetel-hq`) owns **none**. And `Acme Telecom` owns **two** templates — the starter plus a `Verify test template`. So "one template per tenant, every tenant" is false in both directions. |
| *(not claimed, but load-bearing)* `definition_id` "already generalises to the thing this asset belongs to" | **FALSE** | `definition_id uuid references public.playbook_definitions(id)`. It is a typed FK to playbooks, not a polymorphic owner. An onboarding item cannot be put in it without dropping or altering that constraint. This is the claim that most changes the design — see §2. |
| *(not claimed, found while checking)* the generated types match production | **FALSE — fix before building** | `src/types/database.types.ts:4719` describes the **pre-611** `media_assets`, with `extracted`, `knowledge_doc_id`, `profile_id`, `quality_flags`, `sort_order`, `tags` and `updated_at` — **none of which exist in production**. Code written against the generated type will compile and then fail at runtime. Regenerate the types (or hand-type the row) before writing the upload path. |

**What the drift changes.** Nothing in the founder's answers, and nothing in the
recommended data model except §2's rejection of `definition_id`. It does change
§6 (migration): the tenant estate is more varied than "15 identical copies", and
one tenant has already edited its draft — the warning about never overwriting a
tenant copy is not hypothetical, it has already happened.

---

## 1. What is settled, and what this spec must not reopen

The founder's two answers stand as given:

1. **Attachments are BOTH kinds, declared per attachment.** Some are instructions
   for a *person*; some are input the *employee* consumes.
2. **⚠ The two kinds must be visibly different in the UI and distinct in the data
   model.** A file nobody can act on sitting beside one the employee is expected
   to parse — same icon, same upload button — is how you ship a step that looks
   configured and does nothing.

Everything below is in service of those. Where a decision is genuinely the
founder's, it is in §8 as an open question with a recommendation, not decided
here.

**Global by construction.** Attachments are a property of the item shape and the
template editor. Both are baseline for every tenant. There is no flag, no
per-tenant enablement, and nothing to switch on.

---

## 2. Data model — extend `media_assets`, a join table, or the item?

Three candidates were considered.

**(A) Extend `media_assets`** with `onboarding_template_id`, `item_key`,
`audience`, `link_url`, and read attachments by query.
**(B) A new join table** `onboarding_item_attachments`.
**(C) An ordered `attachments` array on the item itself**, with uploaded files
continuing to live as `media_assets` rows of unchanged shape, and links carried
inline.

### Recommendation: (C)

**The decisive fact is that the item JSON is the versioned unit.**
`publish_onboarding_template` snapshots `items` into
`onboarding_template_versions.items`, and every project runs from that frozen
snapshot — `supabase/functions/de-work/index.ts:1560-1606` renders the checklist from
`onboarding_template_versions.items`, not from the draft. An attachment list
living *outside* items is not frozen: editing the draft would silently change
what a live project shows, including projects cut from a version published weeks
earlier. That is a stored marker read as truth, which is this repo's most
expensive recurring trap, wearing a new hat.

**The validator only ever sees the items array.**
`validate_onboarding_items(p_items, p_tenant_id)` is handed the JSON. Under (A)
or (B) it would have to go and query a side table — so the thing it validates and
the thing it freezes could disagree *by construction*, which is a defect you
cannot test your way out of. Under (C) it polices exactly the bytes that get
frozen.

**`media_assets` is shared, and its shape is an interface.** Three live callers
(`playbookBuilderApi.ts:966` insert, `:986` select, `playbook-execute/index.ts:2132`
select-then-`storage.download`). Option (A) needs `storage_path` to become
nullable so a link row can exist — that is relaxing a NOT NULL a live downloader
depends on, in a table two other features read. `kind` is a *media-type* axis
(`document|image|video`); the founder's person/employee axis is orthogonal, and
collapsing two axes into one column is how the distinction stops being visible.

**`definition_id` does not generalise.** It is `references playbook_definitions(id)`.
The scoping note's "wiring rather than invention" framing is right about the
*pattern* — private bucket + tenant-scoped metadata row + signed URLs — and wrong
about this specific column.

**Links are not media.** A link has no bytes, no bucket, no mime, no size and no
signed URL. Under (A) half the columns are meaningless for half the rows.

**The cost of (C), stated plainly.** A JSON key is only as strong as the code
that checks it, where a column can carry a `CHECK`. That is real and it is the
price. Two mitigations, and they are not the same check twice: the validator
refuses a malformed attachment at publish (§5), and a certify probe reads the
*published versions* directly (§7) — which also covers rows written before the
rule existed, something a `CHECK` never does. And note what (C) buys back: because
the employee's read path obeys the **frozen** snapshot, the audience value the
runtime honours cannot be edited after publish. A mutable column with a `CHECK`
would be weaker there, not stronger.

### The attachment entry

An item gains one optional key. Absent, the item behaves exactly as it does today.

```json
{
  "key": "discovery_requirements",
  "label": "Discovery — requirements documented",
  "phase": "kickoff",
  "owner_type": "either",
  "requires_signoff": false,
  "description": "…",
  "attachments": [
    {
      "id": "a1",
      "audience": "person",
      "source": "link",
      "title": "Discovery call script",
      "url": "https://docs.example.com/discovery"
    },
    {
      "id": "a2",
      "audience": "employee",
      "source": "file",
      "title": "GP-requirements.xlsx",
      "asset_id": "3f2c…",
      "mime": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "size_bytes": 184320
    }
  ]
}
```

| Field | Rule |
|---|---|
| `id` | short, unique **within the item**. Ordering and replace depend on it. |
| `audience` | `'person'` or `'employee'`. **Required — there is no default.** |
| `source` | `'file'` or `'link'`. Exactly one of `asset_id` / `url` follows from it. |
| `title` | non-empty. What a person reads before deciding whether to open it. |
| `asset_id` | `source='file'` only — a `media_assets.id` **in this tenant**. |
| `url` | `source='link'` only — `https://` scheme only. |
| `mime`, `size_bytes` | `source='file'` only, copied from the asset **at attach time**. |

**Why `mime`/`size_bytes` are copied.** So the frozen version renders a truthful
label without a second query, and stays meaningful if the asset row is later
deleted. This is a snapshot, not a second writable path — `media_assets` remains
the only source of the bytes, and the copy is read-only by construction because
published versions are immutable.

**Why `person` / `employee` and not `human` / `de`.** The two axes are
independent: a person-audience attachment on a `owner_type: 'de'` item is legal
and common (the runbook for whoever does the manual half). Different words stop a
later reader "fixing" the model by asserting `audience` must match `owner_type`.
If the build session prefers `human`/`de`, it must add a comment and a validator
test asserting the mismatch is *permitted*, or someone will close it.

**There is no `both`.** A third value re-introduces exactly the ambiguity the
founder warned about. A document genuinely needed by both is attached twice, with
two ids and two audiences — explicit, and it renders in both groups where it
belongs.

### `media_assets` changes: none

No new column, no new FK, no relaxed constraint. Uploaded files get an ordinary
row with `definition_id = null`. The item JSON holds the only pointer, so there
is no second place for the two to disagree.

**Ownership and garbage collection.** "Which assets belong to onboarding" is
answered by a query over `onboarding_templates.items` ∪
`onboarding_template_versions.items`, plus the storage path prefix (below) for a
human-legible audit. **GC is deliberately not built in sub-project 1** — an
orphaned file in a private bucket is a storage cost, not a hazard, and a delete
path that can reach a file a published version still references is a hazard.
Named and left; see §8 Q4.

### Bucket: a new private `onboarding-media`

Recommended over reusing `playbook-media`, for two reasons that are not
aesthetic:

1. **Per-bucket policies are the authorisation surface.** Reusing `playbook-media`
   means a future policy change intended for playbooks silently re-authorises
   onboarding documents. Separate buckets keep those decisions separable.
2. **`playbook-media` has `file_size_limit = null` and `allowed_mime_types = null`**
   (verified). Onboarding attachments want both set. Retrofitting them onto
   `playbook-media` changes behaviour for the playbook uploader — a change to a
   shared structure for a reason that has nothing to do with playbooks.

Create it exactly as 652 created `playbook-media` — `insert … on conflict do
nothing`, `public = false` — with `file_size_limit` set (**25 MB recommended**)
and `allowed_mime_types` set, plus the same three `storage.objects` policies
copied verbatim from `playbook_media_tenant_{select,insert,delete}`, which key on
`(storage.foldername(name))[1] IN (select tenant_id::text from profiles where
user_id = auth.uid())`.

**Storage path:** `${tenant_id}/onboarding/${uuid}-${safe_name}`.
`foldername[1]` is still the tenant id, so the copied policies match unchanged;
the second segment is purely for legibility when someone audits the bucket.

The mime allow-list is an authoring decision, not the founder's. A defensible
starting set: PDF, DOCX, XLSX, CSV, PNG, JPEG, plain text, Markdown. ⚠ Note that
`allowed_mime_types` is enforced on the **declared** content type, not on the
bytes; it is a usability guard, not a security boundary. The security boundary is
that the bucket is private and every read is a signed URL.

---

## 3. How an attachment binds to an item

It does not bind — it *is part of* the item. That is the whole point of §2.

- **Draft:** `saveTemplateDraft` already writes the whole `items` array through
  PostgREST (`onboardingApi.ts:178`). An `attachments` key rides along with no API
  change. ⚠ **Consequence:** drafts are unvalidated today and stay unvalidated —
  the validator runs at publish only.
- **Publish:** `publish_onboarding_template` snapshots `items` verbatim into
  `onboarding_template_versions`. Attachments freeze with everything else. No
  change to the publish function.
- **Project:** `create_onboarding_project` points at a version; `items_state`
  carries per-item *status*, not definitions. Attachments are read from the
  version. **`onboarding_projects` gains nothing.**
- **Employee:** `de-work/index.ts` already reads
  `onboarding_template_versions.items` to render the checklist. Attachments are
  in that object already; whether the employee is *told* about them is §4 and
  open question Q1.

Uploading a file and adding it to the draft are two writes that can partially
fail (storage → `media_assets` → draft save). Order them so the failure is
harmless: **upload, then insert the row, then patch the draft.** A crash leaves an
unreferenced file (cost), never a reference to a file that is not there (a broken
step).

---

## 4. Authoring UI

**New component: `src/pages/tenant/entity/onboarding/ItemAttachments.tsx`** —
sibling of the existing `VerbBinding.tsx` and `ProjectRequirements.tsx`, rendered
from the item editor row in `CustomerOnboardingLive.tsx`. Not more lines in that
file: it is 795 lines carrying two responsibilities already, and §UI of the
2026-08-10 design made the same call for the same reason.

### Design System v1 is law here, and the surrounding page is not a model

Import from `src/design/primitives.tsx`: `Field`, `INPUT_CLS`, `SELECT_CLS`,
`Button`, `Chip`, `EmptyState`, `Banner`, `PanelCard`, `Modal`, `TableScroll`.

⚠ **Do not copy the page's local styles.** `CustomerOnboardingLive.tsx:37` defines
its own `inputCls`, and the file carries local `btnGhost` / `btnPrimary`. These
predate the DS and are drift; `VerbBinding.tsx` already does the right thing
(`import { SELECT_CLS, INPUT_CLS, Field, EmptyState } from '…/design/primitives'`).
Follow `VerbBinding`, not its host. `src/components/Modal` is a legacy adapter —
the page already imports `Modal` from `design/primitives`, which is correct.
Adoption is part of shipping this, not a follow-up.

Existing drift in the host file is named and **left alone** — fixing it is a
separate change, not smuggled in here.

### The two kinds must not share a list

This is the founder's ⚠ made concrete. A badge on a shared list is precisely the
"same icon, same upload button" failure, so:

- **Two separately headed groups**, always both present, each with its own
  control:
  - *"For whoever does this step"* → button **"Attach instructions"**
  - *"For the employee to use"* → button **"Attach input for the employee"**
- **Different `Chip` tone** on each entry — `info` for person, `accent` for
  employee (from the DS `Tone` union). Colour supports the grouping; it never
  carries the distinction alone.
- **Each group states what happens to its files**, in one plain sentence, on
  screen — not in a tooltip. A tooltip is not a gate and it is not an
  explanation. For the employee group that sentence depends on Q1; the honest
  form under the recommended answer is: *"Your employee can see these by name. It
  cannot read what is inside them yet."*
- An empty group renders `EmptyState`, not nothing. Absence must be legible.

### Adding one

- **File:** a single `<input type="file">` behind a `Button`. Client-side check
  of size and type before upload so the failure message is in English rather than
  a storage error. Then upload → insert → patch draft (§3 ordering).
- **Link:** `Field` + `INPUT_CLS`, `https://` prefilled, plus a `title`. Reject a
  non-`https` scheme in the browser with a reason; the publish-time rule (§5) is
  the one that actually holds.
- **Order:** array order is display order. Move-up / move-down `Button`s. No
  drag-and-drop — that is new machinery and not a DS primitive.
- **Remove:** removes the entry from the draft item. **It does not delete the
  file** (a published version may still reference it). Say so in the confirm.

### Where a person sees them

On the project page (`CustomerOnboardingLive.tsx`, item card, under
`item.description`):

- **Person group:** each entry an openable row — title, a small type chip, and
  for a link the **host shown next to the title** so a person can see where it
  goes before clicking.
- **Employee group:** a muted list carrying the same sentence as the editor. A
  person must never have to guess which files are theirs to open, and must never
  be handed a control that does nothing.

Mobile (`/m`) is **out of scope** for sub-project 1 and is stated here so it is a
decision rather than an oversight. `/m` renders approvals, not onboarding
projects; nothing there regresses.

---

## 5. What `validate_onboarding_items` must learn

⚠ **Read this first: the validator has no unknown-key rejection.** It checks the
keys it knows and ignores the rest. An `attachments` key therefore publishes
**cleanly today**, unvalidated. So the validator change and the UI must ship
together, in that order — the UI cannot go first, or the first malformed
attachment is already frozen into a version.

New rules, numbered to continue the existing (a)–(g):

| # | Rule |
|---|---|
| (h) | `attachments`, if present, must be a JSON **array**, at most **10** entries. (50 items × 10 keeps a frozen item JSON small and a project page readable.) |
| (i) | Every element must be a JSON **object** with a non-empty `title`. |
| (j) | `audience` must be exactly `'person'` or `'employee'`. **A missing `audience` is an error, never a default.** This is the founder's rule made enforceable — an attachment whose kind was never declared *is* the file nobody can act on. |
| (k) | `source` must be `'file'` or `'link'`; `source='file'` requires `asset_id` and forbids `url`; `source='link'` requires `url` and forbids `asset_id`. **Exactly one**, never both, never neither. |
| (l) | `source='file'` → `asset_id` must name a `media_assets` row **whose `tenant_id` = `p_tenant_id`**. This is the cross-tenant rule: an item must not be able to point at another workspace's file. The validator is already `STABLE` and already does tenant-scoped lookups via `onboarding_verb_verdict`, so this is in keeping. |
| (m) | `source='link'` → `url` must begin `https://`. Not `http://`, not `javascript:`, not a bare string. Rendering an author-supplied URL is an injection surface and the scheme allow-list is the cheapest correct gate — and it belongs at publish, not only in the browser, because the browser is not the only writer. |
| (n) | Duplicate attachment `id` within one item is an error. Ordering and replace depend on uniqueness. |

⚠ **Every new message must be `format(...)` or `'literal'::text`.** A bare literal
appended to a `text[]` resolves `anyarray||anyarray`, throws 22P02, and that
branch can never return its message — four of this function's rules were dead
that way from mig 076 until mig 685. `certify` ›
`no-untyped-literal-appended-to-a-container` ratchets against a fifth; do not be it.

**Not changed:** rules (a)–(g), the go-live rule, the `p_tenant_id is null` refusal,
and the `desk_unknown` skip-loudly notice. Attachments are orthogonal to
reachability.

---

## 6. Migrating existing per-tenant templates

**Recommendation: no backfill, and no change to the seed.**

Attachments are additive and optional. An item with no `attachments` key behaves
exactly as it does today, in every one of the 16 template rows. Nothing needs to
be written into any tenant's template, so the "never overwrite a tenant's copy"
constraint is satisfied by not writing at all.

`starter_onboarding_template()` should **also** be left alone. Seeding an
attachment would mean shipping a placeholder document into 15 workspaces — a file
nobody chose, which is the same failure the founder named from the other end.

**The estate, measured today, because a future migration will need it:**

- **16 tenants. 15 own a starter.** `Demo Workspace` (slug `outsourcetel` — *not*
  `outsourcetel-hq`) owns none.
- **`Acme Telecom` owns two templates** — the starter and a `Verify test template`.
- **14 published starters are still 10 items / 5 phases**, v1, untouched since July.
- **outsourcetel-hq's draft is 15 items / 6 phases at v5** — it has been *edited*
  (`leave_rules_configured` deleted after mig 685's merge). Tenant edits are not
  hypothetical; one has already happened.

So any future migration touching "the starter template" must key on
`name = 'SaaS onboarding — starter'`, must not assume one template per tenant, and
must not assume every tenant has one. A naive `update … where tenant_id = t.id`
would have been wrong on both counts.

⚠ **If a later decision does want to seed an attachment**, copy mig 685's merge
pattern rather than re-deriving it: canonical order first, **the existing item
wins on any shared key**, tenant-authored items appended, then assert *inside the
same `DO` block that performed the merge* that (i) no key present before is
absent after and (ii) every binding survived by count **and** by content. That
block is the reason outsourcetel-hq's verb binding is still intact.

---

## 7. Certify probes this work needs

Ring-0 already guards this area with `onboarding-bindings-are-runnable`,
`bound-onboarding-items-complete-from-evidence` and
`no-untyped-literal-appended-to-a-container`. None of them change — attachments do
not affect reachability or completion.

Three new probes, each to arrive with a mutation case (inject the violation,
confirm red, restore, confirm green). **Scope every one of them the way
`onboarding-bindings-are-runnable` is scoped** (mig 693): only the *current
published version* of a template and any version an existing project points at. A
superseded version can mint nothing, and flagging it is noise nobody can clear
because the editor cannot edit history.

**1. `onboarding-attachment-kinds-are-declared`**
Every attachment in a live version has `audience in ('person','employee')` and
exactly one of `asset_id` / `url`. This is the founder's rule with a standing
check behind it.
*Mutation:* write an attachment with no `audience`, and one with both `asset_id`
and `url`, into a version inside a rolled-back transaction — both must fire.
⚠ **It must report its own denominator.** There are zero attachments in
production today, so the naive form of this probe compares nothing and looks
identical to a clean result. `no-comparisons` must read as *not yet exercised*,
never as a pass — the same treatment `no-pending-approval-the-platform-cannot-carry-out`
already gives itself.

**2. `onboarding-file-attachments-resolve`**
Every `source='file'` attachment in a live version names a `media_assets` row in
the **same tenant** with a non-empty `storage_path`. Catches a cross-tenant
pointer and an asset deleted out from under a published version — the second is
the realistic one, because §4 deliberately does not delete files on removal.
*Mutation:* delete the asset row, and separately repoint `tenant_id`, inside a
rolled-back transaction — both must fire.

**3. `onboarding-attachment-links-are-https`**
Every `source='link'` attachment in a live version has an `https://` URL. The
validator enforces this at publish; the probe covers rows written by anything
that is not the publish path, and rows that predate the rule.
*Mutation:* set a `javascript:` URL in a rolled-back transaction — must fire.

**Also extend the existing mutation fixtures** for
`no-untyped-literal-appended-to-a-container` to cover the new validator branches.
Rules (h)–(n) are written the same way the four dead rules were, and the only
reason those went unnoticed for nine months is that every sibling line used
`format()`.

⚠ `scripts/certify.mjs`, `scripts/certify-mutation-test.mjs` and
`scripts/unexecutable-approval.mjs` are being edited by another agent as this is
written. These probes are **specified here for the build session**; nothing was
added to those files.

---

## 8. Open questions for the founder

Each of these is authority, or what an employee may read, or what ships enabled.
Recommendations given; none decided here.

**Q1. Does the `employee` kind ship enabled in sub-project 1, and what may the
employee do with it?**
Sub-project 2 (reading the contents) is out of scope, so an employee-audience
attachment has no reader on day one. Two honest options, and one dishonest one
(offer the control, do nothing) which is ruled out by the founder's own ⚠.
- **Recommended: ship it enabled, visible but not readable.** `de-work`'s
  checklist rendering (`supabase/functions/de-work/index.ts:1579-1604`, where
  each item already becomes one line of context) gains one clause naming each
  employee-audience attachment and
  its type. The employee can then escalate with *"the requirements are in the
  attached 'GP-requirements.xlsx', which I cannot read yet — send me the values,
  or wait for document reading"* instead of today's *"cannot find recorded
  requirements"*. That is roughly fifteen lines, it makes the employee kind
  non-vacuous immediately, and it is exactly the improved-escalation deliverable
  the 2026-08-10 design already argued for.
- **Alternative: store the field, disable the choice.** The authoring UI shows the
  employee group with the control greyed and the reason on screen. Nothing is
  lost — the field already exists, so sub-project 2 needs no migration.

**Q2. Who may attach a file?**
Today `onboarding_templates` RLS is `for all` to anyone in the tenant with no
role restriction, and `media_assets` insert/delete is likewise any tenant member.
So as specified, **any member can attach to a draft, and only an owner/admin can
publish** — nothing reaches a live project without an admin.
- **Recommended: leave it.** The publish gate is the authority boundary and it
  already holds. Raised because it is authority, not because it looks wrong.

**Q3. May a link point anywhere?**
Sub-project 1 renders links for a person to click. Sub-project 2 may make the
platform *fetch* them, at which point an arbitrary author-supplied URL is a
different kind of object.
- **Recommended: `https://` only, no host allow-list, in sub-project 1** — and
  revisit at sub-project 2, when something other than a human starts following
  them. Flagged now so that revisit is scheduled rather than remembered.

**Q4. What happens to a customer's document when the attachment is removed?**
Recommended in §4: removing an attachment from a draft does **not** delete the
file, because a published version may still reference it. That leaves orphaned
files accumulating in a private bucket.
- **Recommended: accept the orphans in sub-project 1**, with deletion as a
  separate, explicit act later. Raised because these are customer documents and
  "when is a customer's file destroyed" is not an engineering call.

---

## 9. Explicitly out of scope

- **Sub-project 2** — making an attachment's *contents* part of what the employee
  knows, through the grounding path. Q1's recommendation deliberately stops at
  the file's *name and type*.
- **Sub-projects 3 and 4** — extraction and destination verbs. Still blocked on
  the destination question. ⚠ Note in passing: the pre-611 `media_assets` carried
  an `extracted boolean` and a `tags text[]`, visible in the stale generated
  types. That is a fossil of an earlier attempt, not a foundation to build on.
- **Attachments on a *project*** (a customer sending their export into a specific
  onboarding, as `data_export_received` implies). This spec attaches to the
  **template item** only — the thing that is authored, versioned and frozen. A
  per-project upload is a different object with a different lifecycle and no
  publish gate in front of it. Named and left.
- **Garbage collection** of unreferenced assets (§2, Q4).
- **Mobile `/m`** (§4).
- **The host page's pre-DS local styles** (§4). Named and left.

---

## 10. Risks

| Risk | Response |
|---|---|
| The employee kind ships and does nothing | The exact failure the founder named. Q1's recommended answer prevents it at low cost; the alternative prevents it by disabling the control. Silently shipping a dead option is not on the table. |
| A JSON key is weaker than a `CHECK` | Accepted, argued in §2. Bought back by the validator plus a probe that reads published versions, and by the audience value being frozen at publish rather than mutable. |
| An asset deleted under a live published version | Signed-URL resolution returns null; the UI must say *"this file is no longer available"* rather than render a broken link. Probe 2 catches it standing. |
| Adding a bucket rather than reusing one | Costs one idempotent insert and three copied policies. Buys separable authorisation and per-bucket size/mime limits that cannot be retrofitted to `playbook-media` without changing playbook behaviour. |
| Author-supplied URLs rendered in the product | `https://`-only at publish and in the browser; host shown next to the title; `rel="noopener noreferrer"`. Revisit at sub-project 2 (Q3). |
| Stale `database.types.ts` | Real and immediate — it describes seven columns production does not have. Regenerate before writing the upload path, or the first `insert` compiles and fails. |
| 10-attachment cap is arbitrary | It is. It is also reversible, cheap, and the alternative is an unbounded array frozen into every version of every template. |

---

## 11. Decisions taken

- Attachments live **on the item**, in an ordered `attachments` array — because
  the item is the versioned, frozen, validated unit.
- **`media_assets` changes shape not at all.** Files get an ordinary row with
  `definition_id = null`; the item JSON holds the only pointer.
- **Links are not `media_assets` rows.** They carry a URL inline.
- A new private bucket **`onboarding-media`**, with `file_size_limit` and
  `allowed_mime_types` set, and 652's three policies copied verbatim.
- `audience` is **`person` | `employee`**, **required**, with **no `both`**.
- The two kinds render as **two separately headed groups with different
  controls**, never one list with a badge.
- Signed URLs, minted **on click**. No bucket is ever made public.
- **No backfill and no seed change** — attachments are additive and optional.
- The validator learns rules (h)–(n) and must ship **before or with** the UI.
- Three new probes, each with a mutation case, each reporting its denominator.
