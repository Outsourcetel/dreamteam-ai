# One flag, three readers — typing `playbook_definitions`, and the four roles that never worked

**Date:** 2026-08-12
**Status:** design, awaiting founder review
**Founder decisions taken in-session:** type the row (yes) · convert the four to SOPs (yes) · Part 2 scope = SOP + watchers + activate all four

---

## 1. What was reported, and what is actually true

The task arrived with this framing: eleven playbooks in Outsourcetel carry
`status='published'` but cannot run, because `role_archetypes.sop_playbook`
holds **prose** rather than executable steps, and seven of them use keys that
are "not engine primitives at all" — `open_the_books`, `hand_it_over`,
`sop_notes`, and so on.

Every measurable part of that is wrong, and the correction is the reason this
design exists rather than a fix.

**The count is ten definitions and fourteen snapshots, not eleven.** The
failing keys are `accounting_sop`, `bdr_sop`, `billing_ar_sop`,
`cs_manager_sop`, `fpa_sop`, `front_desk_sop`, `it_helpdesk_sop`,
`marketing_sop`, `onboarding_sop`, `renewal_manager_sop`. Their version counts
sum to exactly fourteen. The eleven is mig 509's older count, carried forward
into mig 713's header and then into the brief.

**No snapshot contains an unknown primitive.** Emulating `validateSteps`
against every latest snapshot in the tenant: all fourteen use only
`instruction` and `checklist`. They fail two rules and only two — the last step
is not `complete`, and instruction steps carry their title in `label` rather
than `params.title`. The prose keys never reach the validator, because they are
not in the snapshots at all. The snapshots are frozen copies of the *pre-mig-509*
archetype format.

**And the keys are not prose.** Migrations 509 and 511 deliberately re-authored
`role_archetypes.sop_playbook` into a second executable format —
`{key, kind:'use_tool', work_kind, tool, title, detail}` — with its own
compiler, `compileSopToWorkItems` in `supabase/functions/de-work/index.ts:183`.
That compiler reads `playbook_definitions.steps` filtered on
`status='published'` and `de_id`, and it has fired **28 times, most recently
2026-08-12**:

| DE | compiled steps | compiles |
|---|---|---|
| Billing & Invoicing | `open_the_book → assess_each_item → prepare_the_chase → hand_it_over` | 9 |
| Accounting | `open_the_books → reconcile → prepare_the_note → raise_discrepancies` | 8 |
| Onboarding | two generations; mig 649 replaced the first | 8 |
| Account Success | `confirm_the_account → … → hand_it_over` | 2 |
| Finance | `open_the_books → … → flag_what_is_missing` | 1 |

`open_the_books` and `hand_it_over` are not prose that failed to be steps. They
are the step keys that produced Accounting's 38 work items and Billing's 36.

## 2. The actual defect

`playbook_definitions.status='published'` has **three** readers, each meaning
something different by it:

| Reader | Where | What `published` means to it |
|---|---|---|
| Briefing | `get_de_briefing` / `get_de_situational_briefing` (migs 250, 268) | render this into the DE's prompt as its SOP |
| SOP compiler | `compileSopToWorkItems`, de-work:183 | compile this into de_work_items |
| Playbook executor | `startDefinitionRunServer`, playbook-execute:2299 | this is runnable by me |

The builder lists all rows unfiltered (`listDefinitions`,
`src/lib/playbookBuilderApi.ts:416`), so the founder sees fourteen "published
playbooks" of which four can actually run.

Mig 713 named the disease correctly — *"two different kinds of object sharing
one table is the actual defect"* — and closed the insert door. It did not type
the object. This design does.

The tenant's ten split cleanly by shape:

- **Six are live SOPs** — `accounting`, `billing_ar`, `cs_manager`, `fpa`,
  `onboarding`, `renewal_manager`. `use_tool`-shaped, driving the de-work queue.
- **Four are unfinished procedures** — `bdr`, `front_desk`, `it_helpdesk`,
  `marketing`. `label`+`params`-shaped, never given `params.title` or a
  trailing `complete`. Their DEs have zero work items each. These are the only
  genuinely inert objects in the set.

## 3. Part 1 — type the row

Add `playbook_definitions.kind text not null default 'procedure'`, constrained
to `('sop','procedure')`, backfilled globally from step shape: any element
carrying `kind:'use_tool'` makes the row an `sop`; everything else is a
`procedure`. In Outsourcetel that lands **8 `sop` / 7 `procedure`**.

Then each reader gets the predicate it actually means:

- **Briefing — no filter, and asserted unchanged.** A DE reads its own
  procedure whichever kind it is. This is the trap in the change: filtering
  every reader by `kind` for symmetry would silently strip half of every DE's
  briefing. The migration asserts the rendered briefing is byte-identical
  before and after for at least one DE of each kind.
- **SOP compiler — `kind='sop'`.** The existing `some(x => x.kind==='use_tool')`
  sniff stays as a shape guard, but stops being the classifier.
- **Playbook executor — `kind='procedure'`.** An `sop` gets a distinct, honest
  refusal (`definition_is_an_sop`, HTTP 409) naming what the object is and
  which engine owns it, replacing today's `invalid_definition`/422.
- **Builder UI** — surfaces the kind and stops offering Run on `sop` rows.

`install_role_kit` sets `kind` from the archetype's shape and only ever
snapshots a `procedure`. No existing snapshot is rewritten, moved or deleted.

### The one behaviour change inside Part 1

`account_at_risk_checkin` has an **active event rule** on `account_at_risk`.
Its definition was overwritten into `use_tool` shape by a later migration, but
its old, still-valid procedure snapshot survived — so an `account_at_risk` fire
today would start a run executing steps that match nothing the builder
displays. It has never fired (0 runs). Typing it `sop` closes that path
deliberately: a snapshot that has diverged from its own definition is worse
than no run. `invoice_overdue_followup` carries the same divergence and has no
event rule, so nothing changes for it.

### Inverting the pins

A gate that cannot fail is theatre, so each assertion is proven by its
opposite before it is trusted:

- a hand-made `procedure` row whose steps contain `use_tool` must classify
  `sop` — and the reverse row must classify `procedure`;
- the executor must refuse a known `sop` id, and must still accept
  `erpnext_dunning_reminder` (18 runs, the live control);
- the compiler must pick up a known `sop` and must **not** pick up
  `support_tier_1_resolution_playbook_ee9089`;
- the briefing must return identical text for one `sop` DE and one `procedure`
  DE across the change.

Counts are recorded, not just findings: N rows classified, N compared.

## 4. Part 2 — the four roles

Authoring four SOPs produces nothing on its own. Measured:

| DE | status | lifecycle | watchers | objectives | work items |
|---|---|---|---|---|---|
| Business Development | active | active | 0 | 0 | 0 |
| Marketing | active | active | 0 | 0 | 0 |
| Front Desk | **idle** | designed | 0 | 0 | 0 |
| IT Helpdesk | **idle** | designed | 0 | 0 | 0 |

The compiler runs only inside `planObjective`, so an objective must exist, and
objectives come from watchers. de-work filters `status === 'active'`
(de-work:2113, :2166, :2213), so the two idle DEs are excluded outright.

**Renewal DE is the control that proves it.** It already carries the converted
`use_tool` SOP — mig 509's own work — plus six active watchers that all ran on
2026-08-12. It has 0 objectives and 0 work items. That is not a defect: its
watchers are `date_horizon`/`state_condition` over `commercial_agreements` and
`customer_accounts`, and nothing sits in the horizon. The DEs that produce work
are the ones with `schedule` watchers, which fire on a clock regardless of data.

### `inbox` watchers do not produce objectives

`run_work_watchers` has excluded `kind='inbox'` in every version since mig 213
(`WHERE active AND kind <> 'inbox'`, still present at mig 430:375 and after).
Mig 232 states why in its own words: the inbox watcher is registered *"so the
book of work is complete in one place; intake is served by the proactive
poller."* It is a registration, not a producer.

That matters because `front_desk` and `it_helpdesk` are exactly the two
archetypes whose only watcher template is `inbox`. There are zero inbox
watchers in the tenant today, for any DE.

### What each of the four actually needs

Using what exists — `install_role_kit` for archetype templates, and
`install_role_watchers` (mig 606) for grounded per-role intake, which matches
on **role name** and refuses to create a watcher over an empty source:

| DE | SOP | Activation | Intake, and where it comes from |
|---|---|---|---|
| Business Development | author | already active | archetype `schedule` template (daily, 1440m) via `install_role_kit` — identical in shape to Accounting's, which produces 38 items |
| Marketing | author | already active | archetype `schedule` template (weekly, 10080m), same path |
| IT Helpdesk | author | idle → active | `install_role_watchers` matches `helpdesk` → `state_condition` on `de_conversations status='human_owned'`. Grounded: the tenant has 160 conversations, 1 already `human_owned` |
| Front Desk | author | idle → active | **nothing existing fires.** `install_role_watchers` has no branch matching "front desk" and counts it `skipped_no_catalogued_source`; its only template is `inbox`, which never produces an objective |

### The one assumption I am stating rather than asking about

To make "activate all four" mean something for **Front Desk**, this design adds
a `schedule` watcher template to the `front_desk` archetype — a daily sweep,
the same shape as `bdr`'s, which demonstrably produces work. Without it, Front
Desk is activated into an intake that cannot fire, and its number stays zero
however good its SOP is.

This is the single place where I am interpreting intent rather than executing
an instruction. Strike it at spec review and Front Desk gets its SOP and its
activation and still produces nothing — which is a defensible answer, just not
a silent one.

### SOP authoring constraints

Each of the four SOPs is written against that role's **real tool offer list**,
because the offer list is the authorization boundary — a step naming a tool the
role is not offered is a step that escalates rather than acts. The shared
offers are `recall_memory`, `search_knowledge`, `compute`, `run_analytics`,
`remember`, `draft_outreach`, `operate_in_system`, `escalate_to_human`,
`mark_done`; role-conditional offers include `read_contacts`,
`write_back_to_record`, `write_back_to_opportunity`, `produce_deliverable`,
`read_system` and `verify_in_system`.

Two constraints carried forward from migs 509 and 511, unchanged:

- **No SOP ends in contact.** Channels are closed under founder decision N5.
  Every motion that would end in a customer message ends instead at a prepared
  document plus an escalation naming who should send it, and the step says so
  in its own text so the DE stops deliberately rather than hitting a wall.
- **An empty book is a finished shift.** Schedule-driven roles state this
  explicitly, or they escalate asking for access they already have — the exact
  failure mig 505 fixed.

`role_archetypes` is platform-level, so these ship to every tenant; tenant
copies are re-materialised, the pattern migs 509/511/649 established.

## 5. Verification

Nothing in this design is reported as working until it has been run and its
output read.

- **Part 1** proves itself in-migration with the inverted pins in §3, plus a
  live executor call against a typed `sop` id (expect 409 `definition_is_an_sop`)
  and against `erpnext_dunning_reminder` (expect the run path unchanged).
- **Part 2** is proven by work items appearing, not by watchers existing. The
  measurement is `de_work_items` and `de_decision_trace tool='compile_sop'` per
  DE, before and after, counted. A watcher that exists and has never matched is
  reported as exactly that.
- Anything that does not turn on is named, with its reason, in the same report
  as the things that did. Two-of-four is a result; four-of-four claimed on the
  strength of two is the failure mode this repo has already paid for.

## 6. Named and deliberately not done

- `compileSopToWorkItems` does `.limit(5)` with no `order by`, so a DE with more
  than five published definitions gets a nondeterministic SOP. Finance has three
  today. Real, adjacent, out of scope.
- Mig 713's header calls all fifteen archetype SOPs "prose documents" and
  repeats the eleven/seven counts. The compile traces disprove it. An applied
  migration is not edited — `public.schema_migrations` keys on filename and the
  repo must match what ran — so the record is corrected in the new migration's
  header and here.
- The five archetypes still in the old `params` format and not covered by this
  work: `google_ads`, `sdr`, `seo`, `social_media`, `support_agent`. They are
  not in this tenant's definitions. Mig 713 already makes their install honest.
- `invoice_overdue_followup`'s definition/snapshot divergence is closed by
  typing, but the general question — what to do with snapshots that have
  diverged from their definitions — is not addressed here.

## 7. Order of work

1. Migration: `kind` column, constraint, global backfill, `install_role_kit`
   update, and the inverted-pin assertions. Claimed via `npm run migrate:next`,
   committed before applied.
2. `compileSopToWorkItems` filters `kind='sop'`; `startDefinitionRunServer`
   filters `kind='procedure'` and returns the honest 409.
3. Builder UI surfaces kind; Run is not offered on an `sop`.
4. Verify Part 1 live, including the briefing-unchanged assertion.
5. Migration: four archetype SOPs in `use_tool` format, the `front_desk`
   schedule template, tenant re-materialisation.
6. Activate Front Desk and IT Helpdesk; run `install_role_kit` /
   `install_role_watchers` for the four.
7. Verify Part 2 by counting work items per DE, and report what did not turn on.
