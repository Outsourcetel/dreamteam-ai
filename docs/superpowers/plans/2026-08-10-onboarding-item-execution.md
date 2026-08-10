# Onboarding Item Execution (2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an onboarding checklist item name a verb, so the Onboarding DE performs it through the existing approval gate and the item completes from the receipt.

**Architecture:** A binding (`action_key` + `params`) is added to template **item definitions**, which live only on `onboarding_template_versions.items` — the runtime already re-looks these up by key, so no `items_state` migration or backfill is needed. The employee resolves the verb for its tenant, fills params from the project's account and a new `onboarding_projects.requirements` jsonb, and proposes through connector-hub `execute_action` → `decide_action_execution`. A SQL function completes the item when a matching execution lands. UI adds two components to the existing onboarding page.

**Tech Stack:** Postgres (Supabase, prod ref `rfsvmhcqeiyrxivbmpel`), Deno edge functions, React 18 + TypeScript + Vite, vitest.

Spec: [`docs/superpowers/specs/2026-08-10-onboarding-item-execution-design.md`](../specs/2026-08-10-onboarding-item-execution-design.md)

## Global Constraints

- **Claim migration numbers with `npm run migrate:next -- <slug>`.** Never `ls | tail -1`. 19 duplicates exist because of that habit; a 20th fails `certify › migration-numbering`.
- **Commit a migration before applying it.** `scripts/db-query.mjs` refuses an untracked file under `supabase/migrations/`.
- **Apply with `node scripts/db-query.mjs <file>` (prod) / `scripts/dev-query.mjs` (dev).** `exec_sql` is gone; `deploy.mjs`'s migration path is dead.
- **Every new SQL function: `revoke execute ... from public, anon, authenticated` and assert `has_function_privilege` afterwards.** A REVOKE is not a description of the result.
- **`subject_kind` is `CHECK IN ('de','specialist')`.** Linkage rides `dedupe_key = 'onboarding:<project_id>:<item_key>'`.
- **Item status universe:** `pending | in_progress | done | blocked | signed_off`. `update_onboarding_item_as_de` rejects `signed_off` and accepts the other four.
- **No second decision path.** Proposals go through connector-hub `execute_action`.
- **Every new certify probe needs a matching mutation case**, and its SQL must alias its output column `violation`.
- **Never `npm test`.** Offline: `npm run test:unit`. Credentialed: `npx vitest run tests/<file>.test.ts`.
- **A new test file must be added to the `test:unit` list in `package.json`** or no gate runs it.
- **Tests may not value-import `src/lib/onboardingApi.ts`** — it reaches `src/lib/env.ts`, which throws at module load without `VITE_SUPABASE_URL`. Use `import type` only.
- **`src/design/primitives` is a FILE**, not a directory. There is no `<Select>`/`<Input>` component — use `SELECT_CLS` / `INPUT_CLS` + `Field`.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/NNN_*.sql` (new, ×3) | requirements column + validation; completion-from-receipt; nothing else |
| `supabase/functions/de-work/index.ts` (modify) | resolve binding, fill params, propose, escalate naming missing fields |
| `scripts/certify.mjs` (modify) | one new Ring-0 probe |
| `scripts/certify-mutation-test.mjs` (modify) | its fires/silent pair |
| `src/lib/onboardingTypes.ts` (new) | binding types + pure param-resolution logic, **no runtime imports** so it is testable |
| `src/lib/onboardingApi.ts` (modify) | thread `action_key`/`params`/`requirements` through |
| `src/pages/tenant/entity/onboarding/VerbBinding.tsx` (new) | the picker + three-way field table |
| `src/pages/tenant/entity/onboarding/ProjectRequirements.tsx` (new) | the generated requirements card |
| `src/pages/tenant/entity/CustomerOnboardingLive.tsx` (modify) | import and place the two components |
| `tests/onboarding-binding.test.ts` (new) | pure logic + structural SQL assertions |

**Phase boundary:** Tasks 1–5 deliver the success metric (`action_executions.origin_kind = 'de'`) with bindings authored by SQL. Tasks 6–8 make it authorable in the browser. Each phase is shippable alone.

---

### Task 1: Requirements column + binding validation

**Files:**
- Create: `supabase/migrations/NNN_a_checklist_item_that_can_act.sql` (claim with `migrate:next`)
- Test: in-migration `do $$` assertions

**Interfaces:**
- Produces: `onboarding_projects.requirements jsonb not null default '{}'`; `validate_onboarding_items(jsonb)` rejecting malformed bindings.

- [ ] **Step 1: Claim the number**

```bash
npm run migrate:next -- a_checklist_item_that_can_act
```

- [ ] **Step 2: Read the current validator before changing it**

```bash
node scripts/db-query.mjs --sql "select pg_get_functiondef('public.validate_onboarding_items(jsonb)'::regprocedure)"
```
Copy its existing body verbatim into the migration; the new rules are **appended**, nothing existing is removed.

- [ ] **Step 3: Write the migration**

```sql
begin;

alter table public.onboarding_projects
  add column if not exists requirements jsonb not null default '{}'::jsonb;

comment on column public.onboarding_projects.requirements is
  'Answers to @ask parameters, keyed "<action_key>.<param>". Two verbs can both '
  'take a "territory" meaning different things; a flat key would feed one verb '
  'the other''s answer.';

-- validate_onboarding_items: PASTE THE EXISTING BODY, then append these rules
-- before its success return. Each returns a human-readable error string.
--   (a) action_key present  => owner_type must be 'de'
--   (b) action_key must name an ACTIVE action_definition
--   (c) every params value must be '@account', '@ask', or a scalar literal
--   (d) every REQUIRED param of that verb must appear as a key in params
--       (named, NOT answered — '@ask' satisfies this)
--   (e) params may not name a parameter the verb does not have

commit;
```

- [ ] **Step 4: Prove both halves in the migration**

```sql
do $$
declare
  v_ok   jsonb := '[{"key":"x","label":"X","phase":"config","owner_type":"de",
                     "requires_signoff":false,"action_key":"configure_customer_setup",
                     "params":{"external_ref":"@account","territory":"@ask"}}]'::jsonb;
  v_bad  jsonb := '[{"key":"x","label":"X","phase":"config","owner_type":"human",
                     "requires_signoff":false,"action_key":"configure_customer_setup",
                     "params":{"external_ref":"@account"}}]'::jsonb;
  v_r jsonb;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='onboarding_projects'
                    and column_name='requirements') then
    raise exception 'NNN: requirements column did not land';
  end if;

  -- HALF ONE: a well-formed binding is ACCEPTED. A validator that rejects
  -- everything passes the half below and makes the feature unusable.
  v_r := public.validate_onboarding_items(v_ok);
  if coalesce(jsonb_array_length(v_r->'errors'), 0) <> 0 then
    raise exception 'NNN: a valid binding was rejected: %', v_r;
  end if;

  -- HALF TWO: a binding on a human-owned item is REJECTED.
  v_r := public.validate_onboarding_items(v_bad);
  if coalesce(jsonb_array_length(v_r->'errors'), 0) = 0 then
    raise exception 'NNN: a binding on a human-owned item was accepted';
  end if;

  -- Rule (d): a REQUIRED parameter left unnamed is rejected at publish time,
  -- not discovered at 2am. configure_customer_setup requires external_ref.
  v_r := public.validate_onboarding_items(
    '[{"key":"x","label":"X","phase":"config","owner_type":"de",
       "requires_signoff":false,"action_key":"configure_customer_setup",
       "params":{"territory":"@ask"}}]'::jsonb);
  if coalesce(jsonb_array_length(v_r->'errors'), 0) = 0 then
    raise exception 'NNN: a binding missing a REQUIRED param was accepted';
  end if;

  -- Rule (e): a parameter the verb does not have is rejected — a typo must not
  -- sail through and be silently dropped at execution time.
  v_r := public.validate_onboarding_items(
    '[{"key":"x","label":"X","phase":"config","owner_type":"de",
       "requires_signoff":false,"action_key":"configure_customer_setup",
       "params":{"external_ref":"@account","terrirory":"@ask"}}]'::jsonb);
  if coalesce(jsonb_array_length(v_r->'errors'), 0) = 0 then
    raise exception 'NNN: a binding naming a nonexistent parameter was accepted';
  end if;

  raise notice 'NNN: bindings validate, all four directions';
end $$;
```

⚠ Match the real return shape of `validate_onboarding_items` (read in Step 2) — if it returns `text[]` or raises rather than returning `{errors:[]}`, adapt these assertions to it. Do not change the function's return contract; `publish_onboarding_template` depends on it.

- [ ] **Step 5: Commit, then apply dev → prod**

```bash
git add supabase/migrations/NNN_a_checklist_item_that_can_act.sql
git commit -m "feat(onboarding): a checklist item can name a verb (mig NNN)"
node scripts/dev-query.mjs supabase/migrations/NNN_a_checklist_item_that_can_act.sql
node scripts/db-query.mjs supabase/migrations/NNN_a_checklist_item_that_can_act.sql
```
Expected: `[]` then `ledger: NNN_... recorded`. A raised assertion means nothing applied — the whole file is one transaction.

---

### Task 2: The Ring-0 probe

**Files:**
- Modify: `scripts/certify.mjs` (PROBES array, after `role-restricted-actions-stay-restricted`)
- Modify: `scripts/certify-mutation-test.mjs` (CASES array)

**Interfaces:**
- Consumes: the item shape from Task 1.
- Produces: probe `onboarding-bindings-are-runnable`.

⚠ **Write it against the raw template rows, not the offer list.** `get_agentic_tools_for_de` filters through `de_may_use_action`, so a probe reading the offer list cannot see a binding the gate refuses — the same vacuity `role-restricted-actions-stay-restricted` documents about itself.

- [ ] **Step 1: Add the probe**

```js
  {
    name: 'onboarding-bindings-are-runnable',
    why: 'a checklist item that names a verb nobody can run is a promise that breaks at 2am, in front of a customer — and the template author never finds out',
    sql: `select t.slug || ' / ' || v.name || ' / ' || (i->>'key')
                 || ' → ' || (i->>'action_key') as violation
            from onboarding_template_versions v
            join tenants t on t.id = v.tenant_id
            cross join lateral jsonb_array_elements(v.items) i
           where i ? 'action_key'
             and not exists (
               select 1 from action_definitions ad
                where ad.action_key = i->>'action_key'
                  and ad.status = 'active'
                  and (ad.tenant_id is null or ad.tenant_id = v.tenant_id))`,
  },
```

- [ ] **Step 2: Add the mutation pair**

```js
  {
    name: 'onboarding-bindings-are-runnable',
    fires: `select 1 where exists (select 1 from (values ('no_such_verb')) v(k)
              where not exists (select 1 from action_definitions ad
                                 where ad.action_key = v.k and ad.status='active'))`,
    silent: `select 1 where exists (select 1 from (values ('configure_customer_setup')) v(k)
              where not exists (select 1 from action_definitions ad
                                 where ad.action_key = v.k and ad.status='active'))`,
  },
```

- [ ] **Step 3: Run both and read the output**

```bash
node scripts/certify.mjs --fast 2>&1 | grep -A3 onboarding-bindings
npm run -s certify:mutation 2>&1 | grep onboarding-bindings
```
Expected: probe PASS (no bindings exist yet, so zero rows); mutation `violation→1 rows, clean→0 rows`.

- [ ] **Step 4: Commit**

```bash
git add scripts/certify.mjs scripts/certify-mutation-test.mjs
git commit -m "test(certify): a bound onboarding item must name a runnable verb"
```

---

### Task 3: Completion from the receipt

**Files:**
- Create: `supabase/migrations/NNN_an_item_completes_when_the_work_lands.sql`

**Interfaces:**
- Produces: `complete_onboarding_item_from_execution(uuid)` — service-role only — plus an `AFTER INSERT OR UPDATE` trigger on `action_executions`.

- [ ] **Step 1: Claim the number**

```bash
npm run migrate:next -- an_item_completes_when_the_work_lands
```

- [ ] **Step 2: Write the function and trigger**

```sql
begin;

create or replace function public.complete_onboarding_item_from_execution()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_project uuid;
  v_key     text;
begin
  -- Only a real, completed execution advances anything.
  if new.decision not in ('auto_executed', 'executed_after_approval') then
    return null;
  end if;
  if new.dedupe_key is null or new.dedupe_key not like 'onboarding:%' then
    return null;
  end if;

  v_project := nullif(split_part(new.dedupe_key, ':', 2), '')::uuid;
  v_key     := nullif(split_part(new.dedupe_key, ':', 3), '');
  if v_project is null or v_key is null then return null; end if;

  -- Tenant-scoped by construction: the id arrives inside a text key.
  update onboarding_projects p
     set items_state = (
           select jsonb_agg(case when i->>'key' = v_key
                                 then i || jsonb_build_object(
                                        'status',  'done',
                                        'done_at', now(),
                                        'note',    coalesce(new.receipt, 'applied'))
                                 else i end)
             from jsonb_array_elements(p.items_state) i)
   where p.id = v_project
     and p.tenant_id = new.tenant_id;

  return null;
exception when others then
  -- A malformed key must not roll back an execution that already reached a
  -- customer's system.
  return null;
end;
$function$;

revoke execute on function public.complete_onboarding_item_from_execution() from public, anon, authenticated;

drop trigger if exists trg_onboarding_item_completes on public.action_executions;
create trigger trg_onboarding_item_completes
  after insert or update of decision on public.action_executions
  for each row execute function public.complete_onboarding_item_from_execution();

commit;
```

⚠ `onboarding_projects_progress` fires `BEFORE UPDATE OF items_state`, so `progress_pct` recalculates automatically. It counts only `done`/`signed_off` — `in_progress` deliberately contributes 0.

- [ ] **Step 3: Prove it in a rolled-back transaction**

```sql
do $$
declare v_p uuid; v_before text; v_after text; v_t uuid; v_def uuid;
begin
  select id, tenant_id into v_p, v_t from onboarding_projects
   where name ilike '%grant%' limit 1;
  if v_p is null then
    raise notice 'NNN: no project to test against — proof SKIPPED, not passed';
    return;
  end if;
  select id into v_def from action_definitions where action_key='configure_customer_setup' limit 1;

  select i->>'status' into v_before from onboarding_projects p,
    lateral jsonb_array_elements(p.items_state) i
   where p.id=v_p and i->>'key'='locations_configured';

  insert into action_executions (tenant_id, action_definition_id, mode, params,
                                 decision, destructive, idempotent, dedupe_key,
                                 request_summary, receipt)
  values (v_t, v_def, 'execute', '{}'::jsonb, 'executed_after_approval', true, false,
          'onboarding:' || v_p || ':locations_configured',
          'PROOF ONLY — rolled back', 'proof receipt');

  select i->>'status' into v_after from onboarding_projects p,
    lateral jsonb_array_elements(p.items_state) i
   where p.id=v_p and i->>'key'='locations_configured';

  raise exception 'PROOF (rolled back): % -> %  VERDICT: %', v_before, v_after,
    case when v_after='done' and v_before<>'done'
         then 'FIRES — the receipt completed the item'
         else 'DID NOT FIRE' end;
end $$;
```
Run against **dev** first. Expected: `VERDICT: FIRES`.

- [ ] **Step 4: Gate the rule itself — this is the load-bearing one**

The spec's central claim is that an item completes **only** from a receipt. A
rule with no gate is a comment. Add to `scripts/certify.mjs` PROBES:

```js
  {
    name: 'bound-onboarding-items-complete-from-evidence',
    why: 'a bound item marked done with no execution behind it is work recorded that nobody approved and no system accepted — the stored-marker-read-as-truth trap this repo has paid for repeatedly',
    sql: `select p.name || ' / ' || (i->>'key') as violation
            from onboarding_projects p
            cross join lateral jsonb_array_elements(p.items_state) i
            join onboarding_template_versions v on v.id = p.template_version_id
            cross join lateral jsonb_array_elements(v.items) d
           where d->>'key' = i->>'key'
             and d ? 'action_key'
             and i->>'status' = 'done'
             and not exists (
               select 1 from action_executions ae
                where ae.dedupe_key = 'onboarding:' || p.id || ':' || (i->>'key')
                  and ae.decision in ('auto_executed','executed_after_approval'))`,
  },
```

and its pair to `scripts/certify-mutation-test.mjs`:

```js
  {
    name: 'bound-onboarding-items-complete-from-evidence',
    fires: `select 1 where exists (select 1 from (values ('done', false)) v(st, has_exec)
              where v.st = 'done' and not v.has_exec)`,
    silent: `select 1 where exists (select 1 from (values ('done', true)) v(st, has_exec)
              where v.st = 'done' and not v.has_exec)`,
  },
```

Run both:
```bash
node scripts/certify.mjs --fast 2>&1 | grep -A3 complete-from-evidence
npm run -s certify:mutation 2>&1 | grep complete-from-evidence
```
Expected: probe PASS; mutation `violation→1 rows, clean→0 rows`.

- [ ] **Step 5: Commit and apply**

```bash
git add supabase/migrations/NNN_an_item_completes_when_the_work_lands.sql scripts/certify.mjs scripts/certify-mutation-test.mjs
git commit -m "feat(onboarding): an item completes when the work lands, not when the employee says so"
node scripts/dev-query.mjs supabase/migrations/NNN_an_item_completes_when_the_work_lands.sql
node scripts/db-query.mjs supabase/migrations/NNN_an_item_completes_when_the_work_lands.sql
```

---

### Task 4: Pure param resolution + its test

**Files:**
- Create: `src/lib/onboardingTypes.ts`
- Create: `tests/onboarding-binding.test.ts`
- Modify: `package.json` (`test:unit` file list)

**Interfaces:**
- Produces: `resolveParams(binding, ctx)` → `{ params, missing }`, consumed by Tasks 5 and 7.

⚠ This file must import **nothing at runtime** — no `src/supabase`, no `env.ts`. That is what makes it testable in a credential-free clone.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { resolveParams } from '../src/lib/onboardingTypes';

describe('resolveParams', () => {
  const binding = {
    action_key: 'configure_customer_setup',
    params: { external_ref: '@account', territory: '@ask', payment_terms: 'Net 30' },
  };

  it('fills @account, @ask and literals', () => {
    const r = resolveParams(binding, {
      accountExternalRef: 'Grant Plastics Ltd.',
      requirements: { 'configure_customer_setup.territory': 'United Kingdom' },
    });
    expect(r.missing).toEqual([]);
    expect(r.params).toEqual({
      external_ref: 'Grant Plastics Ltd.',
      territory: 'United Kingdom',
      payment_terms: 'Net 30',
    });
  });

  it('names every unanswered @ask instead of guessing', () => {
    const r = resolveParams(binding, {
      accountExternalRef: 'Grant Plastics Ltd.', requirements: {},
    });
    expect(r.missing).toEqual(['territory']);
    expect(r.params.territory).toBeUndefined();
  });

  it('does not read another verb\'s answer for the same param name', () => {
    const r = resolveParams(binding, {
      accountExternalRef: 'X',
      requirements: { 'some_other_verb.territory': 'Wrong' },
    });
    expect(r.missing).toEqual(['territory']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run tests/onboarding-binding.test.ts
```
Expected: FAIL — cannot resolve `../src/lib/onboardingTypes`.

- [ ] **Step 3: Implement**

```ts
export interface ItemBinding { action_key: string; params: Record<string, string> }
export interface ResolveCtx {
  accountExternalRef: string | null;
  requirements: Record<string, string>;
}
export interface Resolved { params: Record<string, string>; missing: string[] }

/** Fills a binding's params. '@account' comes from the project's customer,
 *  '@ask' from the recorded requirements keyed '<action_key>.<param>', and
 *  anything else is a literal. Unanswered '@ask' values are NAMED, never
 *  guessed — the whole point is an escalation a person can act on. */
export function resolveParams(b: ItemBinding, ctx: ResolveCtx): Resolved {
  const params: Record<string, string> = {};
  const missing: string[] = [];
  for (const [name, spec] of Object.entries(b.params ?? {})) {
    if (spec === '@account') {
      if (ctx.accountExternalRef) params[name] = ctx.accountExternalRef;
      else missing.push(name);
    } else if (spec === '@ask') {
      const v = ctx.requirements?.[`${b.action_key}.${name}`];
      if (v !== undefined && v !== '') params[name] = v;
      else missing.push(name);
    } else {
      params[name] = spec;
    }
  }
  return { params, missing };
}
```

- [ ] **Step 4: Run it green**

```bash
npx vitest run tests/onboarding-binding.test.ts
```
Expected: 3 passed.

- [ ] **Step 5: Put it in the automation, or no gate runs it**

In `package.json`, append `tests/onboarding-binding.test.ts` to the explicit file list of `test:unit`. Then:

```bash
npm run -s test:unit
```
Expected: the new file appears in the run.

- [ ] **Step 6: Commit**

```bash
git add src/lib/onboardingTypes.ts tests/onboarding-binding.test.ts package.json
git commit -m "feat(onboarding): resolve a binding's params, naming what is missing"
```

---

### Task 5: The employee proposes

**Files:**
- Modify: `supabase/functions/de-work/index.ts`

**Interfaces:**
- Consumes: `resolveParams` logic (reimplemented inline — the edge runtime cannot import from `src/`; keep the two copies contract-identical, which is what `certify › contract-parity` exists to guard).
- Produces: employee-origin `action_executions` rows.

- [ ] **Step 1: Read the existing execute-an-action tool end to end**

```bash
grep -n "execute_action" supabase/functions/de-work/index.ts
```
Copy that tool's declaration → handler → fetch shape. **Do not invent a second path.**

- [ ] **Step 2: Extend the onboarding case facts**

Where `ENTITY_DESKS.onboarding_project` builds its facts (≈ line 981), include for each item: `key`, `label`, `owner_type`, `status`, and — when the template item has one — `action_key` plus the resolved `missing` list. The employee must see *which fields are missing*, not merely that something is.

- [ ] **Step 3: Add the tool**

`perform_onboarding_item(project_id, item_key)`:
1. load the project + its template version items; find the item by key
2. refuse unless `owner_type = 'de'` and `action_key` present
3. `resolveParams`; if `missing.length` → raise an escalation whose title names the item and whose detail lists the missing fields, then return
4. otherwise call the same `execute_action` path as the existing tool, with
   `dedupe_key = 'onboarding:' + project_id + ':' + item_key`

   ⚠ **PLAN AMENDMENT (found during Task 3, verified in the source).** This step
   as originally written **cannot work**. `connector-hub/index.ts:7108` computes
   the key unconditionally and accepts no caller value:

   ```js
   const dedupeKey = def.risk.idempotent ? null : `${def.id}:${JSON.stringify(validated.values)}`;
   ```

   So no caller can produce `onboarding:<project>:<item>`, and Task 3's trigger —
   already shipped — would never fire on real work. This is the migration-661
   failure class (a matcher keyed to a shape nothing writes), one notch worse:
   not a second uncounted route, but **no route at all**.

   Task 5 must therefore ALSO make connector-hub honour an explicit
   caller-supplied key: take `payload.dedupe_key` when present, else fall back to
   today's computation. Existing callers pass nothing and are unaffected —
   verify that by enumerating them rather than assuming.

   ⚠ Note what this changes: `dedupe_key` drives idempotency via
   `check_action_idempotency`. An item-scoped key means **one configure per item**,
   which is the intent — but it also means a retry with corrected parameters
   collides with the failed attempt. Task 5 must decide that deliberately and say
   which it chose: either include an attempt counter in the key, or scope the
   dedupe to successful executions only.
5. on a gated response, call `update_onboarding_item_as_de(project_id, de_id, item_key, 'in_progress', <summary>)`
6. **never** write `'done'` — Task 3's trigger owns that
7. **bound retry.** Before proposing, count prior executions on this dedupe key
   whose decision is `failed`, `guardrail_blocked`, `access_denied` or
   `rejected`. At **two or more**, do not propose again: escalate once naming
   the item and the last reason, and leave the item `blocked`. Unbounded retry
   is how this repo built a queue that amplifies itself — an item that has
   failed the same way twice is a question for a person, not a third attempt.

- [ ] **Step 4: Typecheck the function**

```bash
npx deno check supabase/functions/de-work/index.ts
```
Expected: no new errors. Then confirm the ratchet did not rise:
```bash
node scripts/certify.mjs --fast 2>&1 | grep edge-typecheck
```

- [ ] **Step 5: Commit and deploy**

```bash
git add supabase/functions/de-work/index.ts
git commit -m "feat(de-work): the employee performs a bound checklist item"
node scripts/deploy.mjs --no-migrations --fn de-work
```

⚠ Deploy from an up-to-date tree. Deploying a shared edge function from a stale checkout reverts a parallel session's work.

---

### Task 6: `VerbBinding` — the picker

**Files:**
- Create: `src/pages/tenant/entity/onboarding/VerbBinding.tsx`
- Modify: `src/lib/onboardingApi.ts` (add `action_key?: string; params?: Record<string,string>` to `TemplateItem`)

- [ ] **Step 1: Extend the type**

```ts
export interface TemplateItem {
  key: string; label: string; phase: OnboardingPhase;
  owner_type: OnboardingOwnerType; requires_signoff: boolean;
  description?: string; verify?: VerifyConfig;
  /** mig NNN — the verb this item performs, resolved per tenant at run time. */
  action_key?: string;
  /** param name → '@account' | '@ask' | literal */
  params?: Record<string, string>;
}
```

- [ ] **Step 2: Build the component**

Props: `{ item: TemplateItem; onChange: (next: TemplateItem) => void }`. Render nothing unless `item.owner_type === 'de'`.

- verb list from `listActionDefinitions()` in **`src/lib/connectorApi.ts`** — not the `playbookBuilderApi` one. There are two exports with that name and different shapes; connectorApi's carries `provider`, `execution` and `param_schema`.
- a `<select className={SELECT_CLS}>` of `label` values
- on choose: one row per `param_schema` entry, each a `<select>` of *We already know this* (`@account`) / *Ask when we set the customer up* (`@ask`) / *Always use…* (literal + `<input className={INPUT_CLS}>`), wrapped in `<Field label={p.name} hint={p.help} />`
- default: `external_ref` → `@account`, every other required param → `@ask`

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/pages/tenant/entity/onboarding/VerbBinding.tsx src/lib/onboardingApi.ts
git commit -m "feat(onboarding): pick the verb an item performs, by name"
```

---

### Task 7: `ProjectRequirements` — the generated card

**Files:**
- Create: `src/pages/tenant/entity/onboarding/ProjectRequirements.tsx`
- Modify: `src/lib/onboardingApi.ts` (`requirements` on `OnboardingProject`; `saveRequirements()`)

- [ ] **Step 1: Add the API**

```ts
export interface OnboardingProject { /* …existing… */ requirements: Record<string, string>; }

export async function saveRequirements(
  projectId: string, requirements: Record<string, string>,
): Promise<void> {
  const { error } = await supabase
    .from('onboarding_projects')
    .update({ requirements })
    .eq('id', projectId);
  if (error) throw new Error(error.message);
}
```
Add `requirements` to the `select(...)` column lists of `listProjects`, `getProject`, `getProjectForAccount`.

- [ ] **Step 2: Build the card**

`<PanelCard title={`${accountName} — what we need to set them up`}>`. Collect every `@ask` across the version's bound items, dedupe by `<action_key>.<param>`, and render one `<Field label hint={help}><input className={INPUT_CLS}/></Field>` each, using the verb's own `param_schema.help` as the hint. Save calls `saveRequirements`.

Show an `<EmptyState>` when no item is bound — for most workspaces today that is the honest state.

- [ ] **Step 3: Place both components**

In `CustomerOnboardingLive.tsx`: `<VerbBinding>` inside the template-editor item row; `<ProjectRequirements>` above the checklist in the project view.

⚠ That file hand-rolls its own `inputCls`/`btnPrimary` strings and imports only `Modal`. The two new components use Design System primitives and **will look slightly different**. That is the correct direction of travel; note it in the commit rather than matching the local non-conformant style.

- [ ] **Step 4: Typecheck and build**

```bash
npx tsc --noEmit -p tsconfig.json && npm run -s build
```
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add src/pages/tenant/entity/onboarding/ProjectRequirements.tsx src/lib/onboardingApi.ts src/pages/tenant/entity/CustomerOnboardingLive.tsx
git commit -m "feat(onboarding): ask for what the verb needs, in the verb's own words"
```

---

### Task 8: Prove it live — the only measure that counts

**Files:** none. This is an execution, not a code change.

`action_executions.origin_kind = 'de'` is **0 of 186**. Until it is not, nothing above is proven.

- [ ] **Step 1: Bind an item on the real template**

Set `locations_configured` on outsourcetel-hq's template to `configure_customer_setup` with `external_ref: '@account'`, `territory: '@ask'`, `default_price_list: '@ask'`. Publish.

- [ ] **Step 2: Wake the employee and confirm the improved escalation**

Expected: an escalation naming **Territory** and **Price list** for Grant Plastics — not "cannot find recorded requirements". This is itself a deliverable.

- [ ] **Step 3: Fill the requirements**

`territory = United Kingdom`, `default_price_list = Standard Selling`.

- [ ] **Step 4: Wake again; confirm a gated proposal**

```bash
node scripts/db-query.mjs --sql "select decision, origin_kind, dedupe_key from action_executions where dedupe_key like 'onboarding:%' order by created_at desc limit 3"
```
Expected: `human_gated_destructive`, `origin_kind = 'de'`.

- [ ] **Step 5: Approve it, then verify the item completed from the receipt**

```bash
node scripts/db-query.mjs --sql "select i->>'key', i->>'status', left(i->>'note',60) from onboarding_projects p, lateral jsonb_array_elements(p.items_state) i where p.name ilike '%grant%' and i->>'key'='locations_configured'"
```
Expected: `done`, note carrying the receipt.

- [ ] **Step 6: Wake once more and confirm idempotency**

Expected: no second execution — the dedupe key already exists.

- [ ] **Step 7: Full certify, then record the result**

```bash
npm run -s certify
```
Expected: all sections green. Update `docs/45-certification-scoreboard.md` with the first employee-origin execution and its date.

---

## Notes for whoever executes this

- **`npm run test:unit` and `npx vitest run <file>` only.** `npm test` sweeps 12 files, 7 of which hard-throw without credentials.
- **No test can prove the write path.** `tests/helpers/adminQuery.ts` refuses anything that is not a lone `SELECT`/`WITH`. Task 3's completion rule is proven by its in-migration rolled-back block and by Task 8 — not by vitest. Say so rather than implying coverage that does not exist.
- **No edge function in this repo has ever been tested behaviourally.** Task 5's logic is guarded only by `deno check` and by Task 8.
- **Dev is ~102 routines behind production** and its migration ledger is empty. Apply to dev first anyway — it catches syntax and shape errors — but a dev assertion that skips for want of data is *skipped, not passed*, and must say so out loud.
