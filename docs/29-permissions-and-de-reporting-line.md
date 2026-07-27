# 29 — Permissions Model and the DE Reporting Line

**Status:** founder-approved 2026-07-27. Plan of record for tenant permissions.
**Supersedes:** the ad-hoc tier lists in `src/lib/navAccess.ts`.

---

## 1. The four decisions

Made by the founder on 2026-07-27, after the model below was proposed:

1. **Managers get Connected Systems** — full access, including connecting a
   system. Not the browse-only split that was proposed.
2. **Settings is tiered per tab**, not as one page.
3. **Owner outranks Admin** on exactly two things: billing and workspace
   deletion. Everything else they share.
4. **DE scoping is built now**, and a DE has a *reporting line*: a primary
   responsible user, a manager above them, and a C-level role above that.

---

## 2. What is actually true today

Measured, not assumed, on production 2026-07-27:

| Fact | Value |
|---|---|
| Tenant roles defined in the type system | **7** |
| Tenant roles actually assigned to anyone | **2** (`tenant_owner`, `tenant_admin`) |
| Digital employees | 116 |
| DEs with an `owner_id` set | **0** |
| RLS policies referencing `owner_id` | **0** |
| Tables carrying a `de_id` | **72** |
| Functions touching `digital_employees` | **175** |
| RLS policies on DE-scoped tables | **77** |

Two things follow. `digital_employees.owner_id` is a **stub** — a column that
was declared and never filled or enforced, so there is no ownership data to
migrate and nothing depending on its current meaning. And the five unused roles
(`tenant_manager`, `knowledge_manager`, `approver`, `tenant_user`, `read_only`)
are **free to define**, because nobody holds them yet. Both facts make this a
good moment to build the model: there is nothing live to break.

---

## 3. The model: two axes, not one ladder

The natural instinct is a single ladder of roles. That is wrong here, because
two genuinely different questions are being asked:

- **Which modules may you open?** — a property of your *role*.
- **Which digital employees may you touch?** — a property of your *assignment*.

Collapsing them produces roles like `manager_of_two_des`, then
`manager_of_three_des`. Keeping them separate means a role grants a shape of
access, and an assignment grants a set of subjects.

> **Axis 1 — Role → modules.** What is on your screen.
> **Axis 2 — Assignment → digital employees.** Whose work you can see and change.

---

## 4. Axis 1 — role to module

| Module | Owner | Admin | Manager | User | Read-only |
|---|---|---|---|---|---|
| Command Centre | ✅ | ✅ | ✅ | ✅ | view |
| Workforce / DEs | all | all | all | **assigned** | assigned, view |
| Support | ✅ | ✅ | ✅ | assigned | view |
| Browser Operator | ✅ | ✅ | ✅ | assigned | — |
| Knowledge | ✅ | ✅ | ✅ | ✅ | view |
| Playbook Builder | ✅ | ✅ | ✅ | view | view |
| Customers | ✅ | ✅ | ✅ | assigned | view |
| Approvals & Drafts | ✅ | ✅ | ✅ | **own DEs only** | — |
| Activity Log | all | all | all | **own actions + own DEs** | — |
| Governance | ✅ | ✅ | ✅ | — | — |
| Connected systems | ✅ | ✅ | ✅ *(decision 1)* | — | — |
| Company Setup | ✅ | ✅ | — | — | — |

### Settings, tiered per tab (decision 2)

| Tab | Owner | Admin | Manager |
|---|---|---|---|
| General (name, industry, vocabulary, tone) | ✅ | ✅ | ✅ |
| Usage & Budgets | ✅ | ✅ | view |
| Widget & API | ✅ | ✅ | — |
| Identity (domains, SSO, SCIM) | ✅ | ✅ | — |
| Data (export, deletion) | ✅ | export only | — |
| Billing | ✅ *(decision 3)* | — | — |
| Security | ✅ | ✅ | — |

**Owner-only, everywhere (decision 3):** change billing, and delete the
workspace. An Admin who can do both is an Owner with a different label.

---

## 5. Axis 2 — the DE reporting line (decision 4)

A digital employee has a chain of accountable humans, exactly as a human
employee has a line manager and a department head:

| Relation | Who they are | What it grants |
|---|---|---|
| `primary` | The person responsible for this DE day to day | Operate it, edit its knowledge, playbooks and guardrails |
| `manager` | Their line manager for this DE | Everything `primary` has, plus approve its escalations and change its trust dial |
| `executive` | The C-level accountable for it | Visibility across every DE they cover, plus final approval |

### Why an assignment table, not three columns

Three columns on `digital_employees` would be less work today and wrong within a
quarter:

- A DE needs **cover** — holidays, handovers, someone leaving. One person per
  relation cannot express that.
- A fourth relation will arrive (compliance reviewer, deputy). A row is cheaper
  than a migration.
- It keeps `digital_employees` narrow, and keeps *who is responsible* in one
  place instead of spread across the record.

```
de_assignments
  id           uuid pk
  tenant_id    uuid  not null           -- RLS scope, never trusted from client
  de_id        uuid  not null           -- → digital_employees
  user_id      uuid  not null           -- → profiles
  relation     text  not null           -- primary | manager | executive
  assigned_by  uuid
  created_at   timestamptz
  unique (de_id, user_id, relation)
```

`digital_employees.owner_id` is **retired, not repurposed** — it is unset on all
116 rows, and leaving a second source of truth for "who owns this" is how the
two drift apart.

### The access rule, in one place

```
can_access_de(p_de_id) :=
     caller is tenant_owner / tenant_admin / tenant_manager   -- see everything
  OR exists an assignment for (caller, p_de_id)               -- see your own
```

One function. Every policy and RPC delegates to it rather than restating the
rule — the lesson from the knowledge ACL, where the same predicate written in
two places is a bug waiting for its first user.

---

## 6. The enforcement principle

> **The navigation tier is not the security boundary. The database is.**

Tonight proved this twice. Connected systems was open in the nav and closed in
the database (`set_connector_secret` → owner/admin), so nothing leaked — the
defect was only that we showed a page whose button would fail. Had the nav been
the only gate, it would have been a real hole.

So for every capability in this document:

1. The **database** enforces it — RLS policy or an explicit check in a
   `SECURITY DEFINER` function.
2. The **navigation** merely hides what you cannot reach, so the product does
   not offer people doors that will not open.

Never the second without the first.

### ⚠ Decision 1 changes a credential boundary

Giving managers Connected Systems means adding `tenant_manager` to:

```sql
set_connector_secret → auth_has_tenant_role(['tenant_owner','tenant_admin'])
```

That is the function that stores credentials for a customer's systems of
record. Widening it is a deliberate, founder-approved trade — managers are
trusted staff — and it is recorded here so it is never mistaken for a nav
change that happened to touch the database.

---

## 7. Build phases

Ordered so that nothing ships broken and each phase is useful alone.

### Phase 1 — make the matrix real (days)

- Define all seven roles explicitly in `navAccess.ts`.
- **Flip the default from allow to deny.** A page with no declared tier must be
  denied, not shared with everyone. Both bugs found on 2026-07-27 —
  `systems_connectors` and `ops_activity` open to every role — were *defaults
  nobody chose*. This is the fix for that entire class.
- Per-tab tiering inside Settings.
- Add `tenant_manager` to `set_connector_secret` (§6).

### Phase 2 — the assignment model (about a week)

- `de_assignments` table, RLS, and the `can_access_de()` helper.
- Assignment UI on the Employee File — a "Responsible people" panel showing
  primary / manager / executive with the ability to set each.
- Enforce on the **DE record itself**: roster, Employee File, and the DE's own
  read RPCs.

**Nothing changes for anyone live.** Owner, Admin and Manager keep seeing every
DE. Scoping only bites `tenant_user`, and no one holds that role today — so
Phase 2 ships dark and becomes real the first time somebody is assigned.

### Phase 3 — the sweep (weeks, and the honest part)

72 tables carry a `de_id` and 175 functions touch digital employees. Scoping is
not finished until each has been examined. Sequenced by exposure:

1. **Work surfaces** — approvals, drafts, conversations, tasks, missions.
2. **Records** — performance, execution log, experience, skills, decisions.
3. **Configuration** — guardrails, playbooks, escalation rules, trust dials.
4. **Everything else**, with a census proving nothing was missed.

Each wave: policy first, then the RPCs, then the UI. A table is only "done" when
a scoped user provably cannot read another DE's row.

---

## 8. Open questions

Not blocking Phase 1, but they need answers before Phase 3 finishes.

1. **Does a scoped user see aggregate numbers?** The Command Centre shows
   workspace-wide counts. Does a `tenant_user` see totals across all DEs, or
   only their own? *Recommendation: only their own — otherwise the totals leak
   the shape of what they cannot see.*
2. **Unassigned DEs.** If a DE has no assignments, who is responsible?
   *Recommendation: it appears for Owner/Admin/Manager only, and the Workforce
   page flags it — an unowned digital employee is a governance gap, not a
   default state.*
3. **Does `executive` differ from `manager` in practice?** Both see everything
   they cover. If the only difference is final approval, that is a guardrail
   setting rather than a distinct relation. Worth confirming with a real org
   chart before building three tiers where two would do.
4. **Customers and Knowledge scoping.** Both are marked "assigned" in §4, but
   neither hangs off a DE directly. Does a user see customers their DEs serve,
   or all customers? *Recommendation: defer — scope DEs first, and let real
   usage say whether customer scoping is wanted.*
