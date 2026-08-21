# Trust Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a digital employee earn a looser limit — evidence accrues from human approvals *or* system-corroborated correctness, each role declares its own signals and its own ladder, and a human approves every step.

**Architecture:** Two JSONB columns on `role_archetypes` (`trust_signals`, `trust_ladder`) inherited at hire by the existing writer. `trust_evidence_for` gains a positive corroboration source beside migration 819's corroborated refusals. Eligibility gets its own route to a promotion request, separate from the widening detector's pattern search. `apply_trust_promotion` stays the only writer of `current_level`.

**Tech Stack:** PostgreSQL (Supabase) migrations, plain SQL. React/TypeScript for the evidence card. No new dependencies.

## Global Constraints

Copied from `CLAUDE.md` and `docs/superpowers/specs/2026-08-21-trust-promotion-design.md`. Every task's requirements implicitly include these.

- **Never pick a migration number yourself.** Run `npm run migrate:next -- <slug>`. It claims the number on production atomically. `ls | tail -1` is wrong. Claim at the start of the task that needs it, never in advance.
- **Commit the migration before applying it**, and get it onto `origin/main` — `db-query.mjs` refuses an untracked file and refuses one not byte-identical on `origin/main`.
- **Dry-run every migration in an ALWAYS-ABORTING transaction before applying.** Build it so a clean run is as loud as a failing one, and refuse to emit if a `commit;` survives.
- **Assert the absence of a violation, never the presence of an example.** `if exists (bad thing) then raise` — not `if not exists (good thing)`. Migrations must be replayable against an empty database. Run `npm run audit:replayable`.
- **Appending a bare literal to a `text[]` with `||` is banned.** Use `array_append`.
- **No `auth.uid() is not null and` prefix in any SECURITY DEFINER body** — under `service_role` it SKIPS the check instead of failing it. Run `node scripts/secdef-authority-prefix.mjs`.
- **Default EXECUTE grants must be closed explicitly:** `revoke all … from public, anon, authenticated;` then grant deliberately.
- **A tenant id passed as a parameter is an assertion, not authorisation.** Verify it.
- **Strip comments before matching source** — `regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g')` — or a probe matches its own prose.
- **Count the comparisons, not the findings.** Every probe states its denominator. Zero findings from zero comparisons looks identical to a clean result.
- **Read signatures with `pg_get_function_arguments`, never `pg_get_function_identity_arguments`** — the latter omits parameter defaults and has broken two migrations with `42P13`.
- **Never hardcode a department.** Roles declare; the platform reads.
- **Never read or write a `digital_employees` row where `is_workforce_assistant = true`.**
- **A parallel session ships several migrations an hour.** Do not touch files you did not create.

## Prerequisite — not a task, a decision that must precede Task 3

`evaluate_authority` (migs 768–772, 783) is already called by `decide_action_execution` and `decide_human_task` with **zero rules**, so it allows everything. Its cutover moves `de_autonomy.max_amount_cents` into `authority_rules`, and `trust_apply_level` is what writes that column — **so the ladder feeds the evaluator.** The authority design mentions the trust ladder zero times.

**Before Task 3 begins, agree with the authority workstream where a granted limit lives.** If it moves to `authority_rules`, Task 3's ladder must write there instead of into `de_autonomy`. Building Task 3 first and reconciling later means two writers for one limit, which is the divergence migration 755 already had to unpick once.

Tasks 1, 2, 4 and 5 do not touch that seam and may proceed regardless.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/NNN_eligibility_can_ask_for_itself.sql` | Task 1 — route eligibility to a request |
| `supabase/migrations/NNN_an_approver_who_is_not_the_requester.sql` | Task 2 — make the self-approval bar real |
| `supabase/migrations/NNN_a_role_declares_what_a_step_grants.sql` | Task 3 — `role_archetypes.trust_ladder`, inheritance, no-ladder-no-promotion |
| `supabase/migrations/NNN_a_role_declares_what_proves_it.sql` | Task 4 — `role_archetypes.trust_signals`, inheritance |
| `supabase/migrations/NNN_a_success_the_system_can_verify.sql` | Task 5 — corroborated correctness in `trust_evidence_for` |
| `src/pages/tenant/…/TrustPromotionCard.tsx` (exact path resolved in Task 6) | Task 6 — evidence on the card, thinness stated |
| `tests/trust-promotion.test.ts` | Client-side pins for Tasks 3–6 |

---

### Task 1: Eligibility can ask for itself

**Files:**
- Create: `supabase/migrations/NNN_eligibility_can_ask_for_itself.sql` (claim in Step 1)

**Interfaces:**
- Consumes: `public.trust_evidence_for(trust_policies) → jsonb`, `public.request_trust_promotion(...)` — read both signatures with `pg_get_function_arguments` in Step 2 before writing anything.
- Produces: `public.request_eligible_promotions(p_tenant_id uuid default null) → jsonb` returning `{"examined": int, "requested": int, "skipped_existing": int, "thin": int}`.

**Why this task exists.** Measured 2026-08-21: 2 policies report `eligible: true` and `detect_trust_widening_patterns` returns **0 candidates** for the same tenant. Eligibility and proposability are different tests. The detector answers *"has this employee repeatedly done this and been approved?"*; the criteria answer *"does it meet its bar?"*. Nothing bridges them, so an eligible policy is never asked about.

**Founder decision, settled:** an eligible policy raises a request **even with no approved-action history**, and the request must carry how thin the evidence is. Do not add a history threshold.

- [ ] **Step 1: Claim the migration number**

```bash
npm run migrate:next -- eligibility_can_ask_for_itself
```

Use the printed filename for every step below.

- [ ] **Step 2: Record the exact signatures you are building against**

```bash
node scripts/db-query.mjs --sql "select proname, pg_get_function_arguments(oid) as args, pg_get_function_result(oid) as result from pg_proc where proname in ('request_trust_promotion','trust_evidence_for') and pronamespace='public'::regnamespace order by proname"
```

Paste the output into the migration header. If `request_trust_promotion` does not exist or its shape differs from what Step 4 assumes, STOP and report — do not invent a caller.

- [ ] **Step 3: Write the failing probe**

Append to the migration, inside its verification block. It must fail before Step 4's function exists.

```sql
-- PROBE 1 -- an eligible policy with no open task gets a request raised.
-- Denominator stated: how many were examined, not only how many fired.
declare
  v_res jsonb;
  v_eligible_before int;
begin
  select count(*) into v_eligible_before
  from public.trust_policies p
  where (public.trust_evidence_for(p)->>'eligible')::boolean
    and p.pending_task_id is null;

  v_checks := v_checks + 1;
  if v_eligible_before = 0 then
    v_bad := array_append(v_bad,
      'no eligible policy without an open task exists, so this probe compared nothing -- seed one before asserting');
  end if;

  v_res := public.request_eligible_promotions(null);

  v_checks := v_checks + 1;
  if coalesce((v_res->>'requested')::int, -1) <> v_eligible_before then
    v_bad := array_append(v_bad, format(
      'requested %s of %s eligible policies', v_res->>'requested', v_eligible_before));
  end if;
end;
```

- [ ] **Step 4: Run the dry run to verify it fails**

```bash
node scripts/db-query.mjs --file <aborting copy>
```

Expected: FAIL with `function public.request_eligible_promotions(unknown) does not exist`.

- [ ] **Step 5: Write the function**

```sql
create or replace function public.request_eligible_promotions(p_tenant_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_examined int := 0;
  v_requested int := 0;
  v_skipped int := 0;
  v_thin int := 0;
  v_p public.trust_policies;
  v_ev jsonb;
begin
  for v_p in
    select * from public.trust_policies
    where status = 'active'
      and (p_tenant_id is null or tenant_id = p_tenant_id)
  loop
    v_examined := v_examined + 1;
    v_ev := public.trust_evidence_for(v_p);

    if not coalesce((v_ev->>'eligible')::boolean, false) then
      continue;
    end if;

    if v_p.pending_task_id is not null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- ⚠ THIN EVIDENCE IS RAISED, NOT SUPPRESSED (founder ruling 2026-08-21).
    -- A policy whose criteria require no human samples is eligible on an empty
    -- record. That request is still raised, and pending_evidence carries the
    -- count so the card can say so. Suppressing it here would re-create the
    -- deadlock this function exists to break.
    if coalesce((v_ev->>'corroborated_refusals')::int, 0) = 0
       and coalesce((v_ev->'criteria'->0->>'actual')::numeric, 0) = 0 then
      v_thin := v_thin + 1;
    end if;

    perform public.request_trust_promotion(v_p.id, v_ev);
    v_requested := v_requested + 1;
  end loop;

  return jsonb_build_object(
    'examined', v_examined, 'requested', v_requested,
    'skipped_existing', v_skipped, 'thin', v_thin);
end;
$function$;

revoke all on function public.request_eligible_promotions(uuid) from public, anon, authenticated;
```

⚠ Step 2's output decides `request_trust_promotion`'s real argument list. If it does not take `(uuid, jsonb)`, adjust the `perform` line to match and say so in the header.

- [ ] **Step 6: Run the dry run to verify it passes**

Expected: the verification block reports `0 findings` and a non-zero denominator.

- [ ] **Step 7: Invert the probe**

Change `v_eligible_before` to `v_eligible_before + 1` in the comparison. Re-run. Expected: FAIL naming the mismatch. Restore.

- [ ] **Step 8: Commit, push, apply**

```bash
git add supabase/migrations/NNN_eligibility_can_ask_for_itself.sql
git commit -m "feat(trust): eligibility can ask for itself"
git push origin main
node scripts/db-query.mjs --file supabase/migrations/NNN_eligibility_can_ask_for_itself.sql
```

---

### Task 2: An approver who is not the requester

**Files:**
- Create: `supabase/migrations/NNN_an_approver_who_is_not_the_requester.sql` (claim in Step 1)

**Interfaces:**
- Consumes: `public.apply_trust_promotion(...)` — read its full signature with `pg_get_function_arguments` first.
- Produces: no new function. `apply_trust_promotion` keeps its signature exactly; only the guard changes.

**Why this task exists.** `apply_trust_promotion` guards with `if v_policy.requested_by is not null and auth.uid() = v_policy.requested_by then raise`. `raise_trust_widening_proposals` sets `requested_by = NULL`. Measured: every eligible policy reads `requested_by IS NULL`. The bar short-circuits and any approver qualifies. Task 1's new path must not repeat this.

- [ ] **Step 1: Claim the migration number**

```bash
npm run migrate:next -- an_approver_who_is_not_the_requester
```

- [ ] **Step 2: Write the failing probe**

```sql
-- PROBE 1 -- a self-approval is refused. Control first: a DIFFERENT approver
-- must succeed, or a refusal proves only that the function is broken.
v_checks := v_checks + 1;
begin
  perform set_config('request.jwt.claim.sub', v_requester::text, true);
  execute 'set local role authenticated';
  perform public.apply_trust_promotion(v_policy_id, 'approved', null);
  execute 'reset role';
  v_bad := array_append(v_bad, 'self-approval SUCCEEDED -- the requester approved their own promotion');
exception when others then
  execute 'reset role';
  if sqlerrm not ilike '%approver%' and sqlerrm not ilike '%requester%' then
    v_bad := array_append(v_bad, format('refused for the WRONG reason: %s', sqlerrm));
  end if;
end;

-- CONTROL -- a different person approving the same policy must WORK.
v_checks := v_checks + 1;
begin
  perform set_config('request.jwt.claim.sub', v_other_user::text, true);
  execute 'set local role authenticated';
  perform public.apply_trust_promotion(v_policy_id_2, 'approved', null);
  execute 'reset role';
exception when others then
  execute 'reset role';
  v_bad := array_append(v_bad, format(
    'CONTROL FAILED: a non-requester could not approve either (%s) -- the probe above proves nothing', sqlerrm));
end;
```

- [ ] **Step 3: Run the dry run, then invert the guard to prove the probe reaches it**

Expected: **PASS, 0 findings** — and that is the honest result. The guard is
sound; what was missing is a human-requested promotion to point it at. A task that
cannot fail is theatre, so the proof here is the INVERSION: comment out the
`self_approval_refused` raise, re-run, and the probe must report
`self-approval SUCCEEDED`. If it still passes with the guard removed, the probe
is not reaching the guard and the whole task proves nothing. Restore the raise
before committing.

- [ ] **Step 4: Do NOT stamp a requester on the automatic path**

⚠ **CORRECTED 2026-08-21, after Task 1's review and before Task 2 was built.
An earlier draft of this task instructed both writers to stamp a sentinel
`00000000-0000-0000-0000-000000000000` into `requested_by`. That instruction was
wrong twice over and must not be reintroduced.**

*It achieves nothing.* The guard compares `auth.uid() = requested_by`. A real
approver's uid is never equal to the sentinel, so after stamping it the guard
still refuses nobody — the identical outcome to NULL, reached by a longer route.

*And it destroys a live discriminator.* `scripts/trust-proposer-boundary.mjs:79`
states the semantic in its own words: **"requested_by IS NULL is the system
marker — `request_trust_promotion` always stamps the human requester."** That
column is how the Ring-0 probe `trust-proposer-cannot-decide` separates
system-raised proposals from human-requested ones; arms 9, 10 and 11 select on
it. Measured 2026-08-21: the population is **1 of 1** — every pending proposal
today is system-raised. Stamping a sentinel takes that population to zero, and
the probe's denominator arm rules zero a legal state, so certify would stay
green while comparing nothing. That is the theatre this repo has paid for twice.

`NULL` is the correct encoding of "no human asked for this." Leave it. Neither
`request_eligible_promotions` nor `raise_trust_widening_proposals` writes
`requested_by`.

- [ ] **Step 5: Leave the guard as it is — and prove it fires**

The original draft of this step read `requested_by is not null` as the fail-open
prefix migration 749 closed 29 of. **It is not that shape.** In 749 the null
test lets a caller who *should* be checked escape the check. Here null means
*there is no human requester*, which is a true state and not an escape: a
machine-raised request has no self for a self-approval guard to catch.

So `apply_trust_promotion`'s guard is **already correct for the path it governs**
and this task changes no logic. What has never been done is demonstrating it —
the guard has never refused anything, because no human-requested promotion has
ever existed. Steps 2, 3 and 6 stand unchanged and are now the whole task: drive
a real human-requested promotion, watch the self-approval refuse, and watch the
control approver succeed.

⚠ **What this task does NOT solve, stated so it is not lost.** Nothing restrains
*who* may approve a **system-raised** promotion. That is segregation of duties,
not self-approval, and it belongs to the authority seam in Task 3 — which is
blocked pending agreement with the parallel session. Do not invent an approver
rule here.


- [ ] **Step 6: Run the dry run to verify it passes**

Expected: `0 findings`, both the refusal and the control reported.

- [ ] **Step 7: Commit, push, apply**

```bash
git add supabase/migrations/NNN_an_approver_who_is_not_the_requester.sql
git commit -m "fix(trust): an approver who is not the requester"
git push origin main
node scripts/db-query.mjs --file supabase/migrations/NNN_an_approver_who_is_not_the_requester.sql
```

---

### Task 3: A role declares what a step grants

⚠ **Blocked on the Prerequisite above.** Do not start until the authority seam is agreed.

**Files:**
- Create: `supabase/migrations/NNN_a_role_declares_what_a_step_grants.sql` (claim in Step 1)
- Test: `tests/trust-promotion.test.ts` (create in Step 6)

**Interfaces:**
- Consumes: `role_archetypes` (key text PK, `autonomy_templates` jsonb), `instantiate_role_archetype_internal`, `trust_policies.ladder` jsonb, `validate_trust_ladder`, `set_trust_ladder`.
- Produces: `role_archetypes.trust_ladder jsonb`; `trust_policies.ladder` populated at hire; `public.promotion_is_possible(p_policy_id uuid) → jsonb` returning `{"possible": bool, "why": text}`.

**Why this task exists.** `trust_level_settings` returns, for `action_execute`, `enabled: true, max_amount_cents: null, min_confidence: null` at **every** level — levels 1, 2 and 3 are identical and unlimited. Both currently-eligible policies are `action_execute`, so approving their first step would remove a limit rather than loosen one. `trust_policies.ladder` is the per-policy override and is NULL on all 66.

- [ ] **Step 1: Claim the migration number**

```bash
npm run migrate:next -- a_role_declares_what_a_step_grants
```

- [ ] **Step 2: Write the failing probe**

```sql
-- PROBE 1 -- a policy with no ladder cannot be promoted, and the refusal says why.
v_checks := v_checks + 1;
select public.promotion_is_possible(v_no_ladder_policy) into v_res;
if coalesce((v_res->>'possible')::boolean, true) then
  v_bad := array_append(v_bad,
    'a policy whose role declares no ladder reported promotion possible -- that is the unlimited-by-default hole');
end if;

-- CONTROL -- a policy WITH a ladder must report possible, or the arm above
-- passes because nothing is ever possible.
v_checks := v_checks + 1;
select public.promotion_is_possible(v_with_ladder_policy) into v_res;
if not coalesce((v_res->>'possible')::boolean, false) then
  v_bad := array_append(v_bad, format(
    'CONTROL FAILED: a policy with a declared ladder also reported impossible (%s)', v_res->>'why'));
end if;
```

- [ ] **Step 3: Run the dry run to verify it fails**

Expected: FAIL with `function public.promotion_is_possible(uuid) does not exist`.

- [ ] **Step 4: Add the column and the inheritance**

```sql
alter table public.role_archetypes
  add column if not exists trust_ladder jsonb;

comment on column public.role_archetypes.trust_ladder is
  'What each trust step GRANTS for this role, per action category. Inherited into trust_policies.ladder at hire by instantiate_role_archetype_internal, alongside autonomy_templates. A role with no trust_ladder cannot have its employees promoted -- see promotion_is_possible. This is deliberate: trust_level_settings grants action_execute unlimited at every level, so a central default is not safe to fall back on.';
```

Then extend `instantiate_role_archetype_internal` to copy `a.trust_ladder` into the `trust_policies.ladder` of the rows it creates. Read its current body first with `pg_get_functiondef` and preserve everything else verbatim.

- [ ] **Step 5: Write `promotion_is_possible`**

```sql
create or replace function public.promotion_is_possible(p_policy_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_p public.trust_policies;
begin
  select * into v_p from public.trust_policies where id = p_policy_id;
  if v_p.id is null then
    return jsonb_build_object('possible', false, 'why', 'no such policy');
  end if;
  if v_p.ladder is null or jsonb_typeof(v_p.ladder) <> 'object' then
    return jsonb_build_object('possible', false,
      'why', 'this role has not declared what a trust step grants, so there is nothing to promote to');
  end if;
  if v_p.current_level >= least(3, coalesce(v_p.max_level, 3)) then
    return jsonb_build_object('possible', false, 'why', 'already at its ceiling');
  end if;
  return jsonb_build_object('possible', true, 'why', 'a ladder is declared and the ceiling is not reached');
end;
$function$;

revoke all on function public.promotion_is_possible(uuid) from public, anon, authenticated;
grant execute on function public.promotion_is_possible(uuid) to authenticated;
```

- [ ] **Step 6: Gate Task 1's function on it**

In `request_eligible_promotions`, before `perform public.request_trust_promotion(...)`:

```sql
if not coalesce((public.promotion_is_possible(v_p.id)->>'possible')::boolean, false) then
  continue;
end if;
```

- [ ] **Step 7: Run the dry run, then invert**

Delete the `v_p.ladder is null` arm, re-run, expect the probe RED. Restore.

- [ ] **Step 8: Commit, push, apply**

```bash
git add supabase/migrations/NNN_a_role_declares_what_a_step_grants.sql
git commit -m "feat(trust): a role declares what a step grants"
git push origin main
node scripts/db-query.mjs --file supabase/migrations/NNN_a_role_declares_what_a_step_grants.sql
```

---

### Task 4: A role declares what proves it

**Files:**
- Create: `supabase/migrations/NNN_a_role_declares_what_proves_it.sql` (claim in Step 1)

**Interfaces:**
- Consumes: `role_archetypes`, `instantiate_role_archetype_internal`.
- Produces: `role_archetypes.trust_signals jsonb`; `public.declared_trust_signals(p_policy_id uuid) → jsonb` returning the signal list for a policy's role and category, `'[]'::jsonb` when none.

**Why this task exists.** Task 5 needs a per-role definition of what corroborates correctness. Splitting it from Task 5 lets the declaration land and be reviewed before any counting logic depends on it.

- [ ] **Step 1: Claim the migration number**

```bash
npm run migrate:next -- a_role_declares_what_proves_it
```

- [ ] **Step 2: Write the failing probe**

```sql
-- PROBE 1 -- a policy whose role declares signals returns them; one that does
-- not returns an empty array, never null.
v_checks := v_checks + 1;
if jsonb_typeof(public.declared_trust_signals(v_no_signals_policy)) <> 'array' then
  v_bad := array_append(v_bad, 'declared_trust_signals returned a non-array for a role with no signals -- callers must not have to null-check');
end if;

v_checks := v_checks + 1;
if jsonb_array_length(public.declared_trust_signals(v_with_signals_policy)) = 0 then
  v_bad := array_append(v_bad, 'CONTROL FAILED: a role WITH declared signals returned none, so the arm above proves nothing');
end if;
```

- [ ] **Step 3: Run the dry run to verify it fails**

Expected: FAIL with `function public.declared_trust_signals(uuid) does not exist`.

- [ ] **Step 4: Add the column**

```sql
alter table public.role_archetypes
  add column if not exists trust_signals jsonb;

comment on column public.role_archetypes.trust_signals is
  'What the system can check, without a human clicking, to corroborate that this role got a piece of work right. Per action category. Read by trust_evidence_for as the positive counterpart to mig 819 corroborated refusals. The platform never names a department -- roles declare, the platform reads.';
```

- [ ] **Step 5: Write `declared_trust_signals`**

```sql
create or replace function public.declared_trust_signals(p_policy_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
  select coalesce(a.trust_signals -> p.action_category, '[]'::jsonb)
  from public.trust_policies p
  join public.digital_employees d on d.id = p.de_id
  join public.role_archetypes a on a.key = d.archetype_key
  where p.id = p_policy_id;
$function$;

revoke all on function public.declared_trust_signals(uuid) from public, anon, authenticated;
```

⚠ Confirm `digital_employees.archetype_key` is the real join column before writing this — read `information_schema.columns` for that table in Step 1. If the link is named differently, use the real name and note it in the header.

- [ ] **Step 6: Run the dry run to verify it passes, then invert**

Change `coalesce(..., '[]'::jsonb)` to drop the coalesce, re-run, expect the non-array arm RED. Restore.

- [ ] **Step 7: Commit, push, apply**

```bash
git add supabase/migrations/NNN_a_role_declares_what_proves_it.sql
git commit -m "feat(trust): a role declares what proves it"
git push origin main
node scripts/db-query.mjs --file supabase/migrations/NNN_a_role_declares_what_proves_it.sql
```

---

### Task 5: A success the system can verify

**Files:**
- Create: `supabase/migrations/NNN_a_success_the_system_can_verify.sql` (claim in Step 1)

**Interfaces:**
- Consumes: `public.declared_trust_signals(uuid)` from Task 4, `public.trust_evidence_for(trust_policies)`.
- Produces: `trust_evidence_for`'s payload gains `corroborated_successes int` beside the existing `corroborated_refusals`.

**Why this task exists.** Migration 819 counts corroborated refusals and folds them into the human sample count. This adds the positive half, per founder decision 1.

⚠ **Read the spec's boxed warning in §3.2 before writing this.** Machine evidence already satisfies a counter named `min_human_samples`. Fold corroborated successes into the *same* counter — do not add a second machine-only counter, and do not introduce a `min_decided_by_human` floor. The ruling was OR, not AND.

- [ ] **Step 1: Claim the migration number**

```bash
npm run migrate:next -- a_success_the_system_can_verify
```

- [ ] **Step 2: Read the current body verbatim**

```bash
node scripts/db-query.mjs --sql "select pg_get_functiondef('public.trust_evidence_for(public.trust_policies)'::regprocedure)"
```

Preserve every existing arm. This function is the single source of eligibility for the whole feature; a dropped arm is a silently lowered bar.

- [ ] **Step 3: Write the failing probe**

```sql
-- PROBE 1 -- a corroborated success raises the human sample count, and the
-- payload says how many. Both directions, so the arm cannot pass vacuously.
v_checks := v_checks + 1;
select (public.trust_evidence_for(p)->>'corroborated_successes')::int
  into v_before from public.trust_policies p where p.id = v_policy_id;
if v_before is null then
  v_bad := array_append(v_bad, 'corroborated_successes is absent from the evidence payload');
end if;

-- seed one corroborating fact the role declared, then re-read
v_checks := v_checks + 1;
select (public.trust_evidence_for(p)->>'corroborated_successes')::int
  into v_after from public.trust_policies p where p.id = v_policy_id;
if v_after <> v_before + 1 then
  v_bad := array_append(v_bad, format('corroborated_successes went %s -> %s, expected +1', v_before, v_after));
end if;
```

- [ ] **Step 4: Run the dry run to verify it fails**

Expected: FAIL with `corroborated_successes is absent from the evidence payload`.

- [ ] **Step 5: Add the counting arm**

Inside `trust_evidence_for`, beside the `v_h_corrob` declaration and its counting query, add `v_h_success bigint := 0;` and a query that counts, over the same `v_since` window, occurrences matching `public.declared_trust_signals(p_policy.id)`. Fold it into the human total exactly as `v_h_corrob` is folded, and add `'corroborated_successes', v_h_success` to the returned payload beside `'corroborated_refusals'`.

⚠ The shape of a signal is decided here and becomes an interface. Define it in the migration header — at minimum: which table it reads, which column identifies the subject, and which predicate makes it a success. A signal a role can declare but the platform cannot evaluate is the `max_discount_pct` failure again.

- [ ] **Step 6: Run the dry run to verify it passes, then invert**

Force `v_h_success := 0` unconditionally, re-run, expect the `+1` arm RED. Restore.

- [ ] **Step 7: Commit, push, apply**

```bash
git add supabase/migrations/NNN_a_success_the_system_can_verify.sql
git commit -m "feat(trust): a success the system can verify"
git push origin main
node scripts/db-query.mjs --file supabase/migrations/NNN_a_success_the_system_can_verify.sql
```

---

### Task 6: The evidence is on the card, and thin evidence says so

**Files:**
- Modify: the trust promotion review surface — resolve the exact path in Step 1
- Test: `tests/trust-promotion.test.ts`

**Interfaces:**
- Consumes: `human_tasks` rows of `type = 'trust_promotion'`, `trust_policies.pending_evidence`, `public.list_trust_readiness(...)`.
- Produces: no new API. Rendering only.

**Why this task exists.** The evidence lives inside a function nobody surfaces, so approving a promotion is an investigation rather than a click — which is why the one open request has gone unanswered. Founder ruling: a thin-evidence request is raised, **and the card must state that it is thin**.

- [ ] **Step 1: Find the surface**

```bash
grep -rn "trust_promotion" src/ --include=*.tsx --include=*.ts | head -20
```

Record the file that renders a `trust_promotion` task. If none renders it, that is the finding — report it before writing UI.

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { trustPromotionCardCopy } from '../src/lib/trustPromotionPresentation';

describe('a trust promotion card states what the evidence actually is', () => {
  it('says plainly when the evidence is thin — RED if a no-history request looks the same as an earned one', () => {
    const copy = trustPromotionCardCopy({
      employeeName: 'Billing DE',
      category: 'action_execute',
      currentLevel: 0,
      targetLevel: 1,
      // ⚠ The decided-human count is NOT a top-level key. The live payload
      // carries it inside `criteria[]` under key 'human_samples' — verified
      // against production 2026-08-21. An earlier draft of this plan invented
      // `human_decided`, which no task produces.
      evidence: { corroborated_successes: 0, corroborated_refusals: 0,
                  pending_reviews: 208,
                  criteria: [{ key: 'human_samples', actual: 0, required: 3, met: false }] },
    });
    expect(copy.detail).toMatch(/no approved actions/i);
    expect(copy.detail).toMatch(/208/);
  });

  it('does NOT say thin when there is real evidence — RED if every card cries thin', () => {
    const copy = trustPromotionCardCopy({
      employeeName: 'Billing DE',
      category: 'action_execute',
      currentLevel: 0,
      targetLevel: 1,
      evidence: { corroborated_successes: 12, corroborated_refusals: 3,
                  pending_reviews: 0,
                  criteria: [{ key: 'human_samples', actual: 5, required: 3, met: true }] },
    });
    expect(copy.detail).not.toMatch(/no approved actions/i);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
npx vitest run tests/trust-promotion.test.ts
```

Expected: FAIL — module `trustPromotionPresentation` not found.

- [ ] **Step 4: Write the presentation module**

Create `src/lib/trustPromotionPresentation.ts` exporting `trustPromotionCardCopy(input)` returning `{ title, detail, meta }`. The detail must name: the employee, what the step grants (from the policy's ladder), the counts behind the decision, and — when `corroborated_successes + corroborated_refusals + human_decided === 0` — a sentence naming that there are no approved actions to date and how many reviews are waiting.

- [ ] **Step 5: Run to verify it passes**

```bash
npx vitest run tests/trust-promotion.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 6: Render it on the surface found in Step 1**

- [ ] **Step 7: Full suite and commit**

```bash
npm run typecheck
npx vitest run
git add src/lib/trustPromotionPresentation.ts tests/trust-promotion.test.ts <the surface file>
git commit -m "feat(trust): the evidence is on the card, and thin evidence says so"
git push origin main
```

⚠ Baseline: `npx vitest run` currently shows 4 files failing because `.env.test` holds an anon key issued 2026-07-07 that returns 401 after a platform key rotation. That is pre-existing and not yours. `tests/setup.ts` names it explicitly when it fires.

---

### Task 7: The first three roles declare a ladder

⚠ **Blocked on the founder.** This task cannot start until they name the roles and the steps. Do not invent them — §8 of the spec is explicit that this decision is made once and binds every employee ever hired into that role.

**Files:**
- Create: `supabase/migrations/NNN_three_roles_say_what_a_step_means.sql` (claim in Step 2)

**Interfaces:**
- Consumes: `role_archetypes.trust_ladder` and `trust_signals` (Tasks 3 and 4), `public.promotion_is_possible(uuid)`.
- Produces: no new function. Data only.

**Why this task exists — the plan does not work without it.** Tasks 1–6 build the machinery and Task 3 makes a role with no declared ladder unpromotable. Every role has `trust_ladder IS NULL`. So after Task 6, `promotion_is_possible` returns false everywhere, `request_eligible_promotions` requests nothing, and the promoted count stays **0 of 66** — the plan passes every test and fails its own success measure. This task is what makes the feature real.

- [ ] **Step 1: Ask the founder, and stop until answered**

Present the roles that have eligible policies today and ask, per role:

- what each of levels 1, 2 and 3 grants for its categories — an amount, a confidence floor, or a named scope
- which signals the system can check to corroborate its work

Report the current defaults so the answer is informed, not invented:

```bash
node scripts/db-query.mjs --sql "select p.action_category, count(*) as policies, count(distinct p.de_id) as employees, max(p.max_level) as ceiling from public.trust_policies p group by 1 order by 2 desc"
node scripts/db-query.mjs --sql "select pg_get_functiondef('public.trust_level_settings(integer,text)'::regprocedure)"
```

⚠ Note for the founder verbatim: `action_execute` currently grants `enabled, uncapped, no confidence floor` at **every** level, so for that category "level 1" today means unlimited.

- [ ] **Step 2: Claim the migration number**

```bash
npm run migrate:next -- three_roles_say_what_a_step_means
```

- [ ] **Step 3: Write the failing probe**

```sql
-- PROBE 1 -- the named roles declare a ladder, and their employees' policies
-- inherited it. Denominator stated so a zero cannot pass as clean.
v_checks := v_checks + 1;
select count(*) into v_declared from public.role_archetypes where trust_ladder is not null;
if v_declared < 3 then
  v_bad := array_append(v_bad, format('%s role(s) declare a ladder, expected at least 3', v_declared));
end if;

v_checks := v_checks + 1;
select count(*) into v_possible
from public.trust_policies p
where (public.promotion_is_possible(p.id)->>'possible')::boolean;
if v_possible = 0 then
  v_bad := array_append(v_bad,
    'no policy anywhere can be promoted -- the ladders were declared on roles nobody is hired into');
end if;
```

- [ ] **Step 4: Run the dry run to verify it fails**

Expected: FAIL with `0 role(s) declare a ladder, expected at least 3`.

- [ ] **Step 5: Write the declarations the founder gave**

One `update public.role_archetypes set trust_ladder = ..., trust_signals = ... where key = '...'` per named role, with the founder's words quoted in the migration header beside each.

⚠ Existing employees already have `trust_policies` rows created before Task 3's inheritance existed. Backfill their `ladder` from the role in the same migration, and state the row count you changed.

- [ ] **Step 6: Run the dry run to verify it passes, then invert**

Null one role's `trust_ladder`, re-run, expect the count arm RED. Restore.

- [ ] **Step 7: Commit, push, apply**

```bash
git add supabase/migrations/NNN_three_roles_say_what_a_step_means.sql
git commit -m "feat(trust): three roles say what a step means"
git push origin main
node scripts/db-query.mjs --file supabase/migrations/NNN_three_roles_say_what_a_step_means.sql
```

---

## Verification across the whole plan

After Task 6, run once and record verbatim:

```bash
npm run typecheck
npx vitest run
node scripts/migration-append-check.mjs
node scripts/secdef-authority-prefix.mjs
npm run audit:replayable
node scripts/db-query.mjs --sql "select count(*) filter (where current_level > 0) as promoted, count(*) as total from public.trust_policies"
```

The last one is the only number that matters: **it has been 0 of 66 since the feature shipped.** If it is still 0 after this plan, the plan did not work, whatever the tests say.
