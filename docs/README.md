# The documentation, and how to read it

There are ~96 documents in this folder and 65 more under `docs/kb/`. Without a
map that is not a library, it is a pile — which is what
[docs/68](68-documentation-accuracy.md) recorded as finding **#77**: *"No README,
no index, no way in."* This file is that way in.

**It routes; it does not restate.** Nothing here is the authority on anything.
If this file and a document it points at disagree, the document wins and this
file is wrong — see [Keeping this true](#keeping-this-true).

---

## Start here

In this order. About two hours, and you will be able to work without guessing.

| # | Read | Why |
|---|---|---|
| 1 | [`CLAUDE.md`](../CLAUDE.md) *(repo root)* | How work is done here. Not aspirational — every rule in it is there because its absence already cost a defect. |
| 2 | [05 — Core Domain Model](05_Core_Domain_Model.md) | The 39 concepts and what the words mean. A DE is not an agent; a playbook is not a procedure. Get the vocabulary before the code. |
| 3 | [10 — Digital Workforce Framework](10_Digital_Workforce_Framework.md) | What a Digital Employee *is*, and [11](11_Operational_Digital_Workforce_Model.md) for how one actually operates. |
| 4 | [07 — Security and Governance](07_Security_and_Governance.md) | Tenancy, authority, and the audit chain. Most defects in this repo's history are here. |
| 5 | [47 — The technical debt map](47-debt-map.md) | What is known-broken, named, and deliberately unfixed. Read before proposing a cleanup someone already rejected. |

Then, when you first need to ship something, read
[Doing the work](#doing-the-work) below rather than guessing at the commands.

---

## Read this before trusting any document

The corpus spans more than a year and several changes of direction. Three rules
keep you out of the fiction:

**1. Two documents are superseded and say so.** Both carry a measured banner in
their first lines. They are the two a new engineer reaches for first, which is
why they were fixed rather than deleted:

- [08 — Database Design](08_Database_Design.md) — names 53 tables; **46 do not
  exist**. Its vocabulary (`agents`, `actions`, `approval_requests`) is the v1
  design, superseded by `digital_employees`, `action_definitions`, `human_tasks`.
- [09 — API and Integration Standards](09_API_and_Integration_Standards.md) —
  documents 16 REST endpoints under `/v1`. **There is no `/v1` surface.** The
  product is PostgREST plus the edge functions in `supabase/functions/`.

For real schema, query the database. For the real API surface, read the edge
functions. Never hand 08 or 09 to a partner.

**2. A dated document is a snapshot, not a standing claim.** The numbered record
(05–69) is largely point-in-time: audits, censuses, decisions. `46-census.md`
was true on the day it was written. Check the date in the heading, then verify
against production before acting on a number.

**3. Where the docs and production disagree, production wins.** Several docs
were written ahead of the build. `scripts/db-query.mjs` is how you check:

```bash
node scripts/db-query.mjs --sql "select count(*) from digital_employees"
```

---

## Doing the work

Operational how-to. These are the ones you will open repeatedly.

| Task | Document |
|---|---|
| Ship code to production | [DEPLOYMENT.md](DEPLOYMENT.md) — why there is no auto-deploy, and what is checked before shipping |
| Restore after a disaster | [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) — including an explicit *"what is still not proven"* section |
| Handle a security incident | [INCIDENT-RESPONSE-RUNBOOK.md](INCIDENT-RESPONSE-RUNBOOK.md) — starter template; roles need real names assigned |
| Turn on a DE's brain | [ACTIVATE-DE.md](ACTIVATE-DE.md) — five minutes |
| Embed the public widget | [WIDGET-EMBED.md](WIDGET-EMBED.md) |
| Find where a secret lives | [66 — dependencies, secrets & supply chain](66-dependencies-secrets.md) |
| Follow the design system | [design-system.md](design-system.md) — adoption is part of shipping, not a later pass |

**Migrations are not covered by DEPLOYMENT.md.** They are a separate step with
their own hard rules — claim the number with `npm run migrate:next`, never pick
one by hand, and commit before applying. The rules and the reasoning are in
[`CLAUDE.md`](../CLAUDE.md#migrations-claim-the-number-commit-before-you-apply).

---

## The governed record (05–69)

The numbered documents are the decision record. Several are founder-locked:
they record a decision that was made, and re-opening them is a decision in
itself, not a refinement.

**Foundations (05–12)** — the deep reference layer, ~10,000 lines. Domain model,
engineering standards, security, database, API, the workforce framework and its
operational and playbook models. *(08 and 09 superseded — see above.)*

**Strategy and positioning** — [13](13_Product_Strategy_and_Phase1_Mission.md),
[18](18_Positioning_Employ_Agents.md), [24](24-de-roadmap-of-record.md) *(roadmap
of record)*, [41](41-commercial-viability-and-role-coverage.md),
[42](42-voice-channel-build-vs-partner.md) *(decided)*.

**Audits and censuses** — what was actually true on a given date:
[15](15_Employee_File_Truth_Audit.md), [16](16_Module_Truth_Audits.md),
[31](31-employee-file-audit.md), [35](35-direct-write-census.md),
[46](46-census.md), [51](51-measurement-organs-audit.md),
[53](53-deferred-work-census.md).

**The 2026-08 full review (49–69)** — twenty workstreams, one per concern, with
[57](57-review-synthesis.md) as the synthesis and go/no-go. Start there rather
than reading all twenty. [68](68-documentation-accuracy.md) audits this corpus
and is the parent of the file you are reading.

**Debt and gaps** — [47](47-debt-map.md), [55](55-gap-register.md),
[17](17_Combined_Gap_Roadmap.md), [19](19_Build_Phase_Gap_Analysis.md).

**First-user evidence** — [54](54-first-user-feedback-hudson.md) is the closest
thing to a customer in the corpus. [69](69-voice-of-user.md) is the wider view.

---

## The customer manual

`docs/kb/` is **65 articles** across ten areas — getting-started,
digital-employees, tasks-approvals, knowledge, playbooks, connectors,
governance, company-data, performance-outcomes, settings-billing — plus
[`_STYLE.md`](kb/_STYLE.md), which is the house voice for all of them.

**It is live, not shelved.** Verified 2026-08-19: `platform_knowledge_docs`
holds **65** rows — an exact match — and `platform_knowledge_chunks` holds
**276** embedded chunks, so the Workspace Assistant answers from it in product.

Write customer-facing prose here, in that style, not in the numbered record.

---

## Known problems with this corpus

Named so nobody rediscovers them as if they were new. All from
[68](68-documentation-accuracy.md) unless stated.

- **14 stray `.md` files at the repo root**, outside `docs/` entirely — the
  `WEEK1_*`/`WEEK2_*` planning set, `DEPLOYMENT_READY.md`,
  `DEPLOYMENT_COMPLETE_VERIFICATION.md`, and two `SOPHIE_*` files naming a
  persona the product no longer uses.
- **[HIPAA-SECURITY-POLICY.md](HIPAA-SECURITY-POLICY.md) is the highest-risk
  document in the repo** — unmarked, and it asserts a HIPAA programme that does
  not exist. It should be deleted or stood up, not left ambiguous. Do not send
  it to anyone.
- **Overlapping go-live reports** — `GO_LIVE_EXECUTION_READY.md`,
  `GO_LIVE_READINESS_FINAL.md`, `GO_LIVE_STATUS_REPORT.md`,
  `DEPLOYMENT_EXECUTION_PLAN.md` and `BLOCKERS_WIRING_GUIDE.md` cover
  overlapping ground from different dates. Prefer the most recent, and prefer
  [57](57-review-synthesis.md) over all of them.
- **Staleness banners cover part of the corpus, not all of it.** Absence of a
  banner is not evidence of currency.

---

## The other half of the record

Not everything is in `docs/`. Two places hold context you will want:

- **Git history.** ~1,400 commits with genuinely explanatory messages. `git log`
  on a file is often faster than finding the doc that describes it.
- **The session memory** at `.claude/projects/D--Dream-Team-AI/memory/`, indexed
  by `MEMORY.md`. This is where the *why* lives — decisions, blockers, and
  traps found by failing. It is more current than most of `docs/` because it is
  written as work happens.

---

## Keeping this true

This file is an index. It goes stale the moment it starts describing content
instead of pointing at it — so keep it routing-only, and when you add a document
that a new engineer would need, add the line here in the same commit.

If you find a claim in this file that is wrong, the fix is to correct it, not to
add a caveat beside it.
