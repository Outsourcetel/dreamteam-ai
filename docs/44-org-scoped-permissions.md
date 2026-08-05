# 44 — Org-scoped permissions: what to restructure, and what to leave alone

**Status:** proposal, awaiting founder decision
**Date:** 2026-08-05
**Follows:** [29 — Permissions and DE reporting line](29-permissions-and-de-reporting-line.md) (founder-locked 2026-07-27), migrations 587–590 (org tree + work routing)

---

## The short version

You asked whether we need org/department-level permissions. **Not as a third
axis, no.** The two axes you locked in July are sound and I would not rip them
up. But the review turned up something more important than the question asked:

> **The gap is not who can SEE work. It is who is ENTITLED TO DECIDE it —
> and today, nobody checks.**

A person who can see an approval can approve it, whatever it is and whatever it
is worth. That is the thing worth fixing, and the org tree we built this week is
what makes it fixable.

---

## 1. What you actually have today (measured, not assumed)

Two axes, and they work. The disagreement between them noted in July was closed
on 28 July and re-proven with two live users.

**Axis 1 — role → modules. "Which doors."**
`src/lib/navAccess.ts`. Seven tenant roles, every page declares a tier, and a
page that declares nothing is DENIED. This is nav only; it hides menu items and
is explicitly not the security boundary.

**Axis 2 — assignment → digital employees. "Which rooms."**
`de_assignments(de_id, user_id, relation)` with one predicate, `can_access_de()`,
which every check delegates to. **73 database functions and 28 row-security
policies call it.** That single-predicate discipline is the most valuable thing
in the current design, and the whole proposal below leans on it.

Proven as behaviour: Sarah Mitchell (assigned to one of fifteen employees) saw
exactly one; Ali Subhani, same role but a *manager* relation, saw the same one.
Role scopes what you see; relation opens the door.

### Live usage

| | |
|---|---|
| People across all workspaces | 21 (6 owners, 11 admins, **2** `tenant_user`) |
| Digital employees | 117 |
| `de_assignments` rows | **4** |
| Functions delegating to `can_access_de` | 73 |
| Policies delegating to `can_access_de` | 28 |

---

## 2. What the review actually found

### 2.1 Authority is not checked at all

`decide_human_task` — the one sanctioned path for approving anything — checks
four things: are you signed in, is the task in your workspace, if the task names
a digital employee can you access it, and is it still pending.

It does **not** check what is being approved, or what it is worth.

The same check governs a PKR 45,000 credit hold, a £5 refund, a change to a
guardrail that protects the whole workspace, and a promotion of an employee to
higher autonomy. There is no concept of a limit, a threshold, or a second pair
of eyes.

### 2.2 Three-quarters of approvals are decidable by anyone in the workspace

The digital-employee check only applies when the task names one.

| Pending approvals | 320 |
|---|---|
| Attributed to a digital employee | 82 |
| **Not attributed — decidable by any workspace member** | **238 (74.4%)** |

The unattributed 238 include 113 escalations, 58 inquiry reviews and 48
checklists. This is the shipped, deliberate behaviour from Wave 1 — an
unattributed item is workspace-visible — and it is defensible for *visibility*.
It is much harder to defend for *authority*.

### 2.3 Ownership confers nothing

This week we gave all 318 pending approvals a named owner. That field —
`human_tasks.assigned_user_id` — is read by **zero database functions and zero
security policies**. It is a label, not a permission. Anyone who can see an item
can still decide someone else's item.

*(Related and worth fixing immediately regardless of this proposal: the
approvals queue page does not display the owner at all yet. The routing is real;
it is only visible on the new Organisation page.)*

### 2.4 The per-employee ACL will not scale

`de_assignments` is a hand-maintained row per (person, digital employee). Four
rows today. For a 200-person customer running 50 digital employees, expressing
"the Manchester finance team looks after these eight" means maintaining a
10,000-cell matrix by hand. It is the right mechanism for a reporting line. It
is the wrong mechanism for a department.

### 2.5 There are three department fields and none of them join

| Field | State |
|---|---|
| `profiles.department` | free text — **0 of 21** match a real department row |
| `digital_employees.department` | free text — 34 blank; "Finance" and "Finance Operations"; "Support", "customer_support" and "Customer Success" all in use |
| `departments` table | 8 rows, all belonging to a workspace **with no humans in it** |

`digital_employees.location` and `cost_center` are empty strings on all 117
rows. Nothing can be scoped by location today because nothing records one.

---

## 3. Proposal — two moves, not a third axis

### Move A — give axis 2 a second source: org membership *(small)*

Keep `de_assignments` for the reporting line. Add one more way to qualify.

`can_access_de()` currently reads, in plain English: *service role, or platform
admin, or you are an owner/admin/manager, or you are personally assigned to this
employee.* Add a fifth clause:

> **…or this digital employee belongs to an org unit you are a member of.**

For that to work, digital employees must sit in the org tree — so replace the
free-text `digital_employees.department` with a real `org_unit_id`.

**One tree for humans and digital employees.** A department is a department
whether the worker is a person or software. This is the restructure you asked
about, and it is a small one: one migration, one predicate. **73 functions and
28 policies inherit it for free**, because they all delegate.

It also retires two of the three broken department fields.

**Ships dark.** Nobody's access changes until a digital employee is placed in a
unit. Existing assignments keep working untouched.

### Move B — add the axis that genuinely does not exist: approval authority *(the real value)*

A new, small table saying who may sign what:

```
approval_authority(
  tenant_id,
  org_unit_id | role,      -- who holds it
  category,                -- money, customer contact, employee change, …
  max_amount_cents,        -- null = unlimited
  requires_second_approver -- above this, two people
)
```

`decide_human_task` gains one check: does this person hold authority for this
task's category at this value? If not, it refuses — and because the org tree
exists, it can say *who to send it to* and escalate up the branch.

This closes the loop with what shipped this week:

- **Routing** puts the item on a named desk *(built)*
- **Authority** decides whether that desk may sign it *(this proposal)*
- **The tree** says where it goes when they may not *(built)*

Note the platform already reads `amount_cents` in its money gates, so the value
of an action is available where it is needed.

---

## 4. What I would *not* do

**Don't add location/branch permissions yet.** No workspace has more than one
location and the location field is empty on every digital employee. Move A makes
location scoping a *data* question later rather than an *architecture* question —
once units exist, a branch is just a unit.

**Don't touch `navAccess.ts`.** Default-deny works, the tiers are founder-locked,
and it is not the security boundary anyway.

**Don't retire `de_assignments`.** It expresses something org membership cannot:
*primary / manager / executive* on a specific employee — a reporting line, not a
department. Keep both. They answer different questions.

**Don't collapse the axes.** That was the July decision and it remains right;
collapsing them produces role names like `manager_of_two_des`.

---

## 5. Sequencing and the one real risk

| Phase | What | Size | Risk |
|---|---|---|---|
| **A** | `org_unit_id` on digital employees, backfill where the text matches, fifth clause in `can_access_de` | small | very low — ships dark, additive |
| **B** | `approval_authority` + gate in `decide_human_task` + escalate up the tree | medium | **see below** |
| **C** | Branch/location scoping | falls out of A | none — data, not code |

**The risk in Phase B is real and worth stating plainly.** Adding an authority
check changes who can approve. Done carelessly it blocks people who could
approve yesterday and freezes a queue we have just spent a week unblocking.

Recommended default: **authority starts permissive and is tightened per
workspace.** Out of the box, everyone who can see an item may still decide it —
exactly today's behaviour — and a workspace opts into limits deliberately. The
mechanism ships; the restriction is a choice each customer makes.

---

## 6. Decisions I need from you

1. **Move A — one tree for humans and digital employees?** My recommendation:
   yes. Small, additive, retires two broken fields, and everything inherits it.

2. **Move B — build approval authority now, or after the collections email
   step?** My recommendation: after. Collections currently writes an internal
   note rather than emailing the customer, which is the more visible gap.

3. **Should an unattributed approval stay decidable by the whole workspace?**
   238 of 320 pending items are in this state. It is right for visibility. For
   authority I would narrow it — but that is a policy call, not a technical one.

4. **Second-approver threshold — do you want one at all?** It is cheap to build
   alongside Move B and expensive to retrofit afterwards.
