# HEADLINE
The worksheet is ready and the hour is smaller than advertised: only 92 digital employees are actually active in non-suspended tenants (not 116), and 91 of them have nobody named. The real work is ~15 minutes in outsourcetel-hq (9 employees doing real work today, two people to choose from), because 60 of the remaining rows are demo tenants with exactly one human each — a mechanical one-click "primary = the admin" that can be done in bulk. Two blockers found: the legacy "outsourcetel" tenant has zero human members, so its 11 DEs cannot be assigned to anyone until someone is invited (or the tenant is suspended); and your own hr@outsourcetel.com login cannot be named on any DE because the assignment function requires the person to be a member of that workspace — in outsourcetel-hq you must pick "Outsourcetel Owner" or "Ali Subhani".

# STATS
92 active DEs across 14 non-suspended tenants checked (24 excluded: 19 in 2 suspended tenants, 5 disabled/retired); 1 assigned, 91 unassigned; 10 priority rows with real activity; 11 DEs unassignable (tenant has no humans); 14 assignable humans; 2 blockers, 1 docs-figure correction (live is 91/92, not 113/116), 1 duplicate-DE flag

# Assignment Drive Worksheet — who answers for each digital employee

**Prepared 2026-07-27 from live database reads only (no changes made).**
Wave-2 scoping is live: until a person is named, anyone below manager who signs in sees an almost-empty workforce. This sheet is everything needed to close that in one sitting.

## The numbers (live, verified today)

| Measure | Count |
|---|---|
| Digital employees in the database (all tenants, all states) | 116 |
| **Active DEs in non-suspended tenants — the ones this drive covers** | **92** |
| Excluded: DEs in the 2 suspended tenants (kinetic, acme-telecom) | 19 |
| Excluded: disabled/retired DEs in live tenants | 5 |
| Already assigned | 1 (Technical Support, outsourcetel-hq — fully staffed today at 07:58 UTC) |
| **Unassigned** | **91** |
| Priority rows (real recorded activity) | 10 unassigned (9 in outsourcetel-hq, 1 in acs) |
| Currently unassignable (tenant has no human members) | 11 (the legacy `outsourcetel` tenant) |

> Correction to docs/31: the audit said "113 of 116 DEs have nobody named." Live truth: **115 of 116** DEs have nobody named (the 3 assignment rows that exist are one DE × three relations, all created 2026-07-27 07:58 UTC). The docs figure appears to have counted the 3 rows as 3 DEs. In active terms it is 91 of 92.

## How to do it (verified click path)

Open the employee → **Record** tab → **"Responsible people"** panel (it is the first panel; it shows the amber "Nobody assigned" pill). Pick a person and relation from the dropdown — the dropdown lists that tenant's members. You have manager rights everywhere via remote access (verified in the function source: remote-access sessions pass the permission gate for 12 hours after you enter a tenant).

**Three relations:** `primary` (day-to-day owner — the one that matters for visibility), `manager`, `executive`. Primary alone is enough for the drive; add manager/executive where it is true.

## Two things to know before you start

1. **You cannot name yourself.** The function requires the named person to be a member of the DE's workspace, and your hr@outsourcetel.com login is a platform account with no tenant membership. In outsourcetel-hq the eligible people are **Outsourcetel Owner** and **Ali Subhani** — nobody else, anywhere, until you invite them.
2. **The legacy `outsourcetel` tenant is blocked.** It has 11 active DEs and **zero human members** — every assignment attempt will be rejected ("that person does not belong to this workspace"). Decision needed: invite someone (even yourself as a member), or suspend the tenant (all 11 DEs are idle/designed shells except the Workforce Assistant, which has 1 conversation from 07-26).

---

# THE WORKSHEET

★ = priority (real recorded activity). Activity = live counts from `de_conversations` / `de_work_items` today.

## 1. outsourcetel-hq — YOUR REAL TENANT (do this one first, ~15 min)

**People available:** Outsourcetel Owner (tenant_owner) · Ali Subhani (tenant_user)
user_ids for bulk: Owner `84471299-b9e7-4577-8427-9076d3175024` · Ali `1cbd3aec-de94-4710-9eb3-7b6fba456f0b`

| | DE | Role | Activity | Current | Primary | Manager | Executive |
|---|---|---|---|---|---|---|---|
| ★ | Technical Support | Support | 169 conversations, last 07-26 | **DONE** — P: Owner, M: Ali Subhani, E: Owner | — | — | — |
| ★ | Finance DE | Finance | 34 conversations, last 07-23 | none | ____ | ____ | ____ |
| ★ | Billing & Invoicing DE | Billing & Invoicing Advisor | 29 work items, last **today** | none | ____ | ____ | ____ |
| ★ | Accounting DE | Accounting Process Advisor | 27 work items, last **today** | none | ____ | ____ | ____ |
| ★ | Onboarding DE | Onboarding Advisor | 25 work items, last **today** | none | ____ | ____ | ____ |
| ★ | Renewal DE | Renewal & Expansion Advisor | 25 work items, last 07-22 | none | ____ | ____ | ____ |
| ★ | Account Success DE | Account Success | 8 work items + 1 conversation | none | ____ | ____ | ____ |
| ★ | Website & Growth DE | Website & Growth Advisor | 5 conversations, last 07-20 | none | ____ | ____ | ____ |
| ★ | Business Development DE | Business Development Advisor | 1 conversation, 07-20 | none | ____ | ____ | ____ |
| ★ | Workforce Assistant | Global assistant | 3 conversations, last 07-26 | none | ____ | ____ | ____ |

DE ids (bulk, same order): Technical Support `7c6a2668-1587-4d7a-a1eb-01da95e0a672` · Finance `f8c63e39-8ec6-4500-8d7f-8d55df9a3ad9` · Billing & Invoicing `39d80a3c-5369-479d-823f-f24ad8546344` · Accounting `4a82ad79-a0a1-4a63-b617-cb9ce1708503` · Onboarding `43313f2e-1c2d-4ff4-8b18-b35f5158e65d` · Renewal `40d688eb-016d-4f74-8049-1ab2f660182d` · Account Success `74c2fbb1-1d2c-4099-9d7d-3225b8e09049` · Website & Growth `c765e29a-8dc2-468e-890b-28ecb889342d` · Business Development `af160ba4-70e1-47f3-9abd-1b6aacae83f8` · Workforce Assistant `41760a97-ad5d-4eee-9562-6f9178c02121`

## 2. acs — TRIAL TENANT (real outside signup)

**People available:** only the trial owner — no display name set, recognizable by email `notion0832@gmail.com` (user_id `ec11aacd-47e4-41b9-b5bb-ac7eccb18503`). Primary can only be this person.

| | DE | Role | Activity | Current | Primary |
|---|---|---|---|---|---|
| ★ | Billing Support | Billing | 4 conversations, last 07-24 | none | ____ |
| | Account Success DE | Account Success | — | none | ____ |
| | Finance DE | Finance | — | none | ____ |
| | Technical Specialist | Specialist | — | none | ____ |
| | DreamTeam Onboarding Architect | Onboarding | — | none | ____ |
| | Workforce Assistant | Global assistant | — | none | ____ |

## 3. harbor-peak-consulting — TRIAL TENANT

**People available:** only Dana Okafor, tenant_owner (user_id `c5b529b4-aab6-4fc6-99e1-0b05aad75bad`).

| DE | Role | Activity | Current | Primary |
|---|---|---|---|---|
| Account Success DE | Account Success | — | none | ____ |
| Finance DE | Finance | — | none | ____ |
| Technical Specialist | Specialist | — | none | ____ |
| DreamTeam Onboarding Architect | Onboarding | — | none | ____ |
| Workforce Assistant | Global assistant | — | none | ____ |

## 4. outsourcetel — BLOCKED (decide: invite someone, or suspend the tenant)

**People available: NONE.** Assignments are impossible here until a human is invited. 11 active DEs, 10 with zero activity ever; several look like legacy shells. Note: there are TWO DEs named "Onboarding Specialist" (`b18210f7…` idle, `962ac692…` active) — a duplicate worth cleaning up whenever this tenant is touched.

DEs: Billing Specialist · Compliance Officer · Finance Analyst · Knowledge Curator · Onboarding Specialist (×2) · QA Reviewer · Revenue Representative · Support Specialist · Training Coach · Workforce Assistant (1 conversation, 07-26).

## 5–14. The ten demo tenants — MECHANICAL (recommend the bulk path below)

Each has **exactly one human** (its demo admin) and the same 6 DEs. The only possible assignment is primary = that admin, so this is 60 identical decisions — one approval, not sixty clicks. The Demo Support DEs each carry 17–27 conversations, all clustered 07-18/19: that is the demo battery, not customer traffic, so none are flagged priority.

| Tenant | The one person (= Primary for all 6 DEs) | user_id |
|---|---|---|
| fashion-nova | Fashion Nova Demo Admin | `70938f7b-5d19-44d2-9732-e01ea8cf3b0d` |
| first-community-cu | First Community Credit Union Demo Admin | `a1fa0a31-53b3-470c-9cf7-5acc50da3499` |
| great-expressions | Great Expressions Dental Centers Demo Admin | `103ec6b3-f3d4-4c11-b9c6-daca603d26ae` |
| gusto | Gusto HR and Payroll Demo Admin | `722a84d1-f0d3-40bf-8593-62a930174553` |
| masterclass | MasterClass Learning Demo Admin | `503c42a6-fd8b-415b-80d9-4e6af9e53a17` |
| mynd | Mynd Property Management Demo Admin | `ff2755c4-6975-4489-b21e-8e739c64dcfa` |
| ontrac | OnTrac Delivery Demo Admin | `fd004594-3302-43cb-975b-b348f20fdd34` |
| root-insurance | Root Insurance Demo Admin | `e6d8b918-7585-4ca2-8791-711e98d1a9ae` |
| sonic | Sonic Internet Demo Admin | `bdc7344d-2814-4815-8f21-db53a66d78ac` |
| staypineapple | Staypineapple Hotels Demo Admin | `e47bf10a-6497-4901-8a25-28d6150af02e` |

Each tenant's 6 DEs: Account Success DE · Finance DE · [Brand] Demo Support · Technical Specialist · DreamTeam Onboarding Architect · Workforce Assistant. (Full DE UUIDs are in the database; the bulk script below does not need them typed out.)

---

## The exact call (for the bulk path, once you approve the mapping)

The UI's own call, one row at a time (verified at `src/components/de/ResponsiblePeoplePanel.tsx:85`):

```sql
select set_de_assignment(
  p_de_id    => '<digital employee uuid>',
  p_user_id  => '<person uuid>',
  p_relation => 'primary'   -- or 'manager' / 'executive'
);
```

Guarantees baked into the function (read from live source): caller must be manager+ in the DE's tenant (remote access counts, 12-hour window); both the DE and the person must belong to that tenant; re-running is safe (upsert on de+person+relation); multiple people may hold the same relation. **Caveat for later wiring:** it writes **no audit event** — docs/31 commitment #3 wants that fixed before the Owner column dies.

Bulk demo-tenant fill (single statement a migration could run, mirroring the function's own guards — **needs your go-ahead, nothing has been executed**):

```sql
insert into de_assignments (tenant_id, de_id, user_id, relation, assigned_by)
select de.tenant_id, de.id, p.user_id, 'primary', p.user_id
from digital_employees de
join profiles p on p.tenant_id = de.tenant_id          -- the tenant's only member
join tenants t  on t.id = de.tenant_id
where t.slug in ('fashion-nova','first-community-cu','great-expressions','gusto',
                 'masterclass','mynd','ontrac','root-insurance','sonic','staypineapple')
  and de.status <> 'disabled'
on conflict (de_id, user_id, relation) do nothing;
```

## Suggested order of the hour

1. **outsourcetel-hq** — 9 rows, real work, two candidate people. (~15 min in the UI)
2. **Approve the bulk demo fill** — clears 60 rows in one shot. (~1 min decision)
3. **acs + harbor-peak** — 11 rows, primary = the only owner in each; UI or a two-line variant of the bulk script. (~10 min)
4. **Decide `outsourcetel`** — invite a member or suspend it; 11 rows blocked until then.

---

## Method and honesty

- Everything above is from **live read-only SELECTs run 2026-07-27** against production (tenants, digital_employees, de_assignments, profiles, auth.users, de_conversations, de_work_items) plus repo source for the click path and function guards. No writes, no deploys.
- **Proven-live:** all counts, the one existing assignment (timestamps included), the membership guard and remote-access pass in `set_de_assignment` (read from the live function body, not the repo).
- **Inferred, not proven:** the demo-support conversations being battery-generated (inferred from the 07-18/19 date clustering and "Demo Support" naming); whether anyone below manager has actually signed in yet (`profiles.last_seen_at` is NULL for all 20 users — nothing writes it, so this signal cannot answer the question).
- **Unverifiable:** why docs/31 says 113/116 — assignment history is not kept, but the 3 existing rows were created today and are one DE, so the live figure (91/92 active unassigned) supersedes it.
- Scope choices: trial tenants (acs, harbor-peak) were treated as active since only *suspended* tenants were excluded; "active DE" = `status <> 'disabled'` (includes idle/designed employees, since they are visible in the workforce and assignable).
- Activity sources checked and rejected as signals: the `conversations` support table (3 rows, none linked to a DE) and `tasks_this_month` on the DE record (seeded demo values, not live counts).