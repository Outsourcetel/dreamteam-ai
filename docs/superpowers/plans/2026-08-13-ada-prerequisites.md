# Ada Prerequisites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it safe to retire Ada later, by moving the one thing only she creates into baseline provisioning, and by fixing the certify check that would otherwise start passing vacuously the moment she is gone.

**Architecture:** Two independent changes. The `platform_admin` self-connector moves out of `provision_onboarding_architect` and into `provision_tenant_baseline_internal`, where admin plumbing belongs. Separately, `workspace-admin-has-an-owner` currently treats that connector's existence as a *precondition* for checking anything; it becomes an *assertion*, so a missing connector is a violation rather than an excuse to skip.

**Tech Stack:** Postgres (Supabase), Node (certify), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-12-discovery-interview-design.md` §4 "Moved, and each is a defect if forgotten". This is Plan 2 of 3; it does NOT retire Ada — that is Plan 3, step 7.

**Deliberately NOT in this plan** (so nobody thinks they were forgotten). Spec §4 lists five things that must move before Ada goes. This plan does the two that must land *first*, because they protect the estate whether or not Ada is ever retired:
- ✅ here: the `platform_admin` connector moves into provisioning (Task 1)
- ✅ here: the vacuously-passing certify check (Task 2)

The other three only bite at the moment of retirement and belong with it, in Plan 3 step 7: `onboarding-assist/index.ts:57` matching Ada by literal name and returning 409 without her; `GettingStartedGuide.tsx:37` excluding her by name and calling her "the hero of step 1"; and `proposeTailoredSetup` (`hireApi.ts:215`), the regex-not-LLM tailoring the interview supersedes. Retiring Ada while `onboarding-assist` still lives would break that path, which is why they ship together.

**A discovery that simplifies Plan 3, recorded here:** `feature_registry` already carries an `onboarding_architect` key (`default_enabled = true`), and `provision_onboarding_architect` reads it and returns `{skipped: flag_off}` when false. So retiring Ada is a one-row UPDATE on the same reversible mechanism used for the starter employees — not a trigger deletion. Plan 3 should use it.

## Global Constraints

- **Never pick a migration number.** Claim it only with `npm run migrate:next -- <slug>`.
- **Commit the migration before applying it.** `scripts/db-query.mjs` refuses an untracked migration.
- **Every function keeps its EXECUTE grants asserted in BOTH directions.** `create or replace` preserves grants, so a REVOKE is a request, not a description of where you ended up.
- **Every migration ends with a `do $$ … $$` block that raises** if the change did not take effect. ⚠ Beware the trap this repo has hit four times in two days: a check whose failure mode is intercepted by an earlier constraint (a FK, a NOT NULL, or a synchronous `ALTER … ADD CHECK`) proves nothing. Make sure the thing you assert is the thing that would actually refuse you.
- **The pairing rule.** Every check is proved by the pair — it fires AND it does not fire.
- **⚠ The Workspace Assistant and its chatbot are untouched.** Nothing may read or write a `digital_employees` row with `is_workforce_assistant = true`. Note this plan *reads about* the Workspace Assistant in a certify SQL predicate — that is a read of `digital_employees` metadata by the GATE, which already exists and is unchanged. Do not modify the assistant, its charter, its tools, or its row.
- **Ada is NOT retired in this plan.** `provision_onboarding_architect` keeps working exactly as it does today, minus the connector insert.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/<n>_admin_plumbing_is_not_an_employees_job.sql` (create) | move the self-connector into baseline provisioning; leave Ada otherwise intact |
| `scripts/certify.mjs` (modify, ~line 390) | `workspace-admin-has-an-owner` stops treating the connector as a precondition |
| `tests/admin-plumbing.test.ts` (create) | read-only assertions that the connector is baseline-provided and the gate is not vacuous |

---

## Task 1: Admin plumbing is not an employee's job

**Files:**
- Create: `supabase/migrations/<claimed>_admin_plumbing_is_not_an_employees_job.sql`
- Test: `tests/admin-plumbing.test.ts`

**Interfaces:**
- Consumes: `public.provision_tenant_baseline_internal(uuid)`, `public.provision_onboarding_architect(uuid)` — both exist.
- Produces: a new `public.provision_platform_admin_connector_internal(p_tenant_id uuid) returns uuid`, called by the baseline. Idempotent, returns the connector id.

- [ ] **Step 1: Read both live function bodies before changing either**

```bash
node scripts/db-query.mjs --sql "select pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and p.proname in ('provision_onboarding_architect','provision_tenant_baseline_internal');"
```

You are reproducing both bodies with surgical edits. Copy them verbatim except for the change described. Do not reformat, do not "improve" unrelated lines — a diff that touches more than it must cannot be reviewed.

In `provision_onboarding_architect` the block to remove is exactly:

```sql
  -- Self-connector (idempotent)
  select id into v_conn from connectors
    where tenant_id = p_tenant_id and provider = 'dreamteam' limit 1;
  if v_conn is null then
    insert into connectors (tenant_id, provider, base_url, category, status, display_name)
    values (p_tenant_id, 'dreamteam', 'https://dreamteam.internal', 'platform_admin', 'connected', 'DreamTeam AI (self)')
    returning id into v_conn;
  end if;
```

⚠ `v_conn` is used later in that function (it binds the DE to the connector). Do **not** delete the variable — replace the block with a call to the new function so `v_conn` is still populated:
`v_conn := provision_platform_admin_connector_internal(p_tenant_id);`

- [ ] **Step 2: Write the failing test**

Create `tests/admin-plumbing.test.ts`:

```typescript
// ============================================================
// ADMIN PLUMBING IS NOT AN EMPLOYEE'S JOB
//
// The platform_admin self-connector is what makes a workspace administrable.
// Until now it was created as a side effect of provisioning the Onboarding
// Architect — so retiring that employee would have silently removed a
// workspace's ability to administer itself, AND made the certify check that
// watches for exactly that condition start passing vacuously.
//
// Read-only: runQuery() refuses anything that is not a lone SELECT/WITH.
// ============================================================
import { describe, it, expect } from 'vitest';
import { runQuery, adminTokenAvailable } from './helpers/adminQuery';

const run = adminTokenAvailable() ? describe : describe.skip;

run('the platform_admin connector is baseline plumbing', () => {
  it('is created by the baseline, not by the architect', async () => {
    const [{ baseline_has, architect_has }] = await runQuery<{ baseline_has: boolean; architect_has: boolean }>(`
      select
        (select pg_get_functiondef(p.oid) ilike '%provision_platform_admin_connector_internal%'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname='public' and p.proname='provision_tenant_baseline_internal') as baseline_has,
        (select pg_get_functiondef(p.oid) ilike '%insert into connectors%'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname='public' and p.proname='provision_onboarding_architect') as architect_has`);
    expect(baseline_has, 'baseline provisioning must create the platform_admin connector').toBe(true);
    expect(architect_has, 'the architect must no longer insert connectors directly').toBe(false);
  });

  it('the helper is idempotent by construction', async () => {
    // It must find-then-insert, never insert blindly: provisioning re-runs.
    const [{ def }] = await runQuery<{ def: string }>(`
      select pg_get_functiondef(p.oid) as def from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.proname='provision_platform_admin_connector_internal'`);
    expect(def).toMatch(/select\s+id\s+into/i);
  });

  it('every active workspace that has an assistant also has the connector', async () => {
    const rows = await runQuery<{ slug: string }>(`
      select t.slug from tenants t
       where t.status='active'
         and exists (select 1 from digital_employees d
                      where d.tenant_id=t.id and coalesce(d.is_workforce_assistant,false))
         and not exists (select 1 from connectors c
                          where c.tenant_id=t.id and c.category='platform_admin' and c.status='connected')`);
    expect(rows.map((r) => r.slug), 'workspaces with an assistant but no admin connector').toEqual([]);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails for the right reason**

Run: `npx vitest run tests/admin-plumbing.test.ts`
Expected: the first two tests FAIL (`provision_platform_admin_connector_internal` does not exist yet; the architect still inserts). Note whether the third passes or fails today and record the actual tenant list — that is real data about the estate, not a pass/fail detail.

- [ ] **Step 4: Claim the number and write the migration**

Run: `npm run migrate:next -- admin_plumbing_is_not_an_employees_job`

Header in the house voice (read `supabase/migrations/727_a_catalog_of_systems_we_know.sql` first). It must say: the connector is what makes a workspace administrable; it was created as a side effect of hiring an employee; that employee is being retired; and admin plumbing belongs in provisioning.

The new function:

```sql
create or replace function public.provision_platform_admin_connector_internal(p_tenant_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_conn uuid;
begin
  select id into v_conn from connectors
   where tenant_id = p_tenant_id and provider = 'dreamteam' limit 1;
  if v_conn is null then
    insert into connectors (tenant_id, provider, base_url, category, status, display_name)
    values (p_tenant_id, 'dreamteam', 'https://dreamteam.internal', 'platform_admin', 'connected', 'DreamTeam AI (self)')
    returning id into v_conn;
  end if;
  return v_conn;
end;
$function$;

revoke execute on function public.provision_platform_admin_connector_internal(uuid) from public, anon, authenticated;
grant  execute on function public.provision_platform_admin_connector_internal(uuid) to service_role;
```

Then `create or replace` both existing functions with the surgical edits from Step 1. In `provision_tenant_baseline_internal`, add the call near the other provisioning steps — it must run for every tenant, not inside a conditional branch.

- [ ] **Step 5: Verification block that can actually fail**

```sql
do $$
declare v_missing int; v_arch_inserts boolean; v_base_calls boolean;
begin
  select pg_get_functiondef(p.oid) ilike '%provision_platform_admin_connector_internal%'
    into v_base_calls from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='provision_tenant_baseline_internal';
  if not coalesce(v_base_calls,false) then
    raise exception '<n>: baseline provisioning does not call the connector helper';
  end if;

  select pg_get_functiondef(p.oid) ilike '%insert into connectors%'
    into v_arch_inserts from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='provision_onboarding_architect';
  if coalesce(v_arch_inserts,false) then
    raise exception '<n>: the architect still inserts connectors directly';
  end if;

  -- Idempotence, proved by calling it twice on a real tenant rather than asserted.
  -- Pick a tenant that already HAS one, so no row is created either time.
  perform provision_platform_admin_connector_internal(t.id)
     from tenants t
     join connectors c on c.tenant_id = t.id and c.category = 'platform_admin'
    limit 1;
  select count(*) into v_missing
    from (select tenant_id from connectors where provider='dreamteam'
           group by tenant_id having count(*) > 1) x;
  if v_missing > 0 then
    raise exception '<n>: % tenant(s) now hold more than one dreamteam connector — the helper is not idempotent', v_missing;
  end if;
end $$;
```

- [ ] **Step 6: Commit, then apply, then re-run the test**

```bash
git add supabase/migrations/*_admin_plumbing_is_not_an_employees_job.sql tests/admin-plumbing.test.ts
git commit -m "fix(provisioning): admin plumbing is not an employee's job"
node scripts/db-query.mjs supabase/migrations/<n>_admin_plumbing_is_not_an_employees_job.sql
npx vitest run tests/admin-plumbing.test.ts
```

Expected: migration recorded; first two tests now pass. Report the third test's real result.

---

## Task 2: The gate stops excusing itself

**Files:**
- Modify: `scripts/certify.mjs` (~line 390, probe `workspace-admin-has-an-owner`)
- Test: `tests/admin-plumbing.test.ts` (append)

**Interfaces:**
- Consumes: the probe's existing SQL and `public.get_agentic_tools_for_de(uuid, uuid)`.
- Produces: no new exports. The probe's SQL changes shape only.

- [ ] **Step 1: Understand precisely why it is vacuous**

The probe's `why` reads: *"restricting the admin verbs to one role is only safe if that role can actually reach them; without this, closing the hole silently leaves a workspace administrable by nobody."*

Its SQL flags a tenant only when **all three** hold: it has a connected `platform_admin` connector, it has a workspace assistant, and that assistant cannot reach any `requires_role='workforce_assistant'` action.

The first condition is the bug. Delete the connector and the tenant stops being examined — so the exact failure the probe exists to catch (a workspace nobody can administer) makes the probe go quiet. **The connector's presence is being used as a precondition when it is part of what should be asserted.**

- [ ] **Step 2: Measure the blast radius before changing anything**

```bash
node scripts/db-query.mjs --sql "select t.slug from public.tenants t where t.status='active' and exists (select 1 from digital_employees d where d.tenant_id=t.id and coalesce(d.is_workforce_assistant,false)) and not exists (select 1 from digital_employees de cross join lateral jsonb_array_elements(public.get_agentic_tools_for_de(de.tenant_id, de.id)) x join action_definitions ad on ad.id=(x->>'action_definition_id')::uuid where de.tenant_id=t.id and coalesce(de.is_workforce_assistant,false) and ad.requires_role='workforce_assistant');"
```

At the time of writing this returns **`outsourcetel`** — a legacy tenant already recorded as a decommission candidate. **Record what it actually returns when you run it.** Do not proceed to Step 4 until you have done Step 3.

- [ ] **Step 3: Find out WHY each flagged tenant fails, and decide honestly**

For each slug returned, determine which of these is true:
1. it has no `platform_admin` connector;
2. it has one but the assistant is offered no `workforce_assistant` action;
3. something else.

```bash
node scripts/db-query.mjs --sql "select t.slug, (select count(*) from connectors c where c.tenant_id=t.id and c.category='platform_admin' and c.status='connected') as admin_conns, (select count(*) from digital_employees d where d.tenant_id=t.id and coalesce(d.is_workforce_assistant,false)) as assistants, t.status from public.tenants t where t.slug = '<slug>';"
```

Then choose ONE, and write the reason into the code:
- **Fix the tenant** if it is live and genuinely should be administrable.
- **Exempt it by name** if it is legacy/decommissioning — a single named slug with a comment saying why and what would remove the exemption. ⚠ Never a blanket `and t.slug not in (...)` with no explanation, and never widen it to silence a class.
- **Leave it flagged** if it is a real defect someone should fix — then certify is red for a true reason, which is the correct outcome, and you say so in your report.

- [ ] **Step 4: Change the probe**

Remove the connector `exists(...)` precondition so a missing connector is a violation rather than a skip. The tenant is examined whenever it is active and has an assistant:

```javascript
    sql: `select t.slug as violation
            from tenants t
           where t.status = 'active'
             and exists (select 1 from digital_employees d
                          where d.tenant_id = t.id and coalesce(d.is_workforce_assistant, false))
             and not exists (
               select 1 from digital_employees de
               cross join lateral jsonb_array_elements(
                 public.get_agentic_tools_for_de(de.tenant_id, de.id)) x
               join action_definitions ad on ad.id = (x->>'action_definition_id')::uuid
              where de.tenant_id = t.id
                and coalesce(de.is_workforce_assistant, false)
                and ad.requires_role = 'workforce_assistant')`,
```

Update the probe's `why` to say what it now asserts — that a workspace with an assistant must actually be administrable, **whatever the reason it is not**, including a missing connector. The old wording described the old shape.

If Step 3 chose "exempt by name", add the single slug with its reason as a comment directly above.

- [ ] **Step 5: Prove the probe is no longer vacuous**

This is the point of the task. The old probe could be silenced by deleting a row; the new one cannot.

Append to `tests/admin-plumbing.test.ts`:

```typescript
run('the admin gate cannot be silenced by removing the connector', () => {
  it('examines a workspace with an assistant regardless of its connectors', async () => {
    // The old probe required a connected platform_admin connector before it
    // would look at a tenant at all — so deleting that connector made the
    // check go quiet on exactly the workspace it was meant to protect.
    // Assert on the shipped probe text: the connector must not appear as a
    // precondition alongside the tenant-status filter.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('scripts/certify.mjs', 'utf8');
    const start = src.indexOf("name: 'workspace-admin-has-an-owner'");
    expect(start, 'probe not found').toBeGreaterThan(-1);
    const probe = src.slice(start, start + 1600);
    expect(probe).toContain('is_workforce_assistant');
    expect(probe).not.toMatch(/exists\s*\(\s*select 1 from connectors/);
  });
});
```

- [ ] **Step 6: Run certify and report honestly**

```bash
npx vitest run tests/admin-plumbing.test.ts
npm run certify:fast
```

Report the probe's real result. **If it is red, that is a finding, not a failure of this task** — say which tenants and why, and which of Step 3's three routes you chose. Do not make it green by weakening the assertion.

- [ ] **Step 7: Commit**

```bash
git add scripts/certify.mjs tests/admin-plumbing.test.ts
git commit -m "test(certify): the admin gate stops excusing itself"
```

---

## Done when

- `npx vitest run tests/admin-plumbing.test.ts` passes, and the third test's result is reported as real data either way.
- The migration is committed, applied, and its verification block was seen to be capable of failing.
- `provision_onboarding_architect` no longer inserts connectors, and `provision_tenant_baseline_internal` creates one for every tenant.
- The certify probe examines every active tenant that has an assistant, and any tenant it flags is either fixed, exempted by name with a written reason, or reported as a genuine open defect.
- No `digital_employees` row with `is_workforce_assistant = true` was modified.
