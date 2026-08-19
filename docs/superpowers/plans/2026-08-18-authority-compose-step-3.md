# Authority Risk Check — Compose into `decide_action_execution` (Step 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `decide_action_execution` consult `evaluate_authority` before it lets a digital employee act unattended — **alongside** the existing autonomy resolution, never instead of it.

**Architecture:** Same composition shape as step 2 (spec §3.6), applied to the employee path. `resolve_de_autonomy_chain` and the `require_approval_over_cents` guardrail keep answering "has this employee earned this?" unchanged; the risk check answers "does this particular action need more scrutiny?" and runs immediately before the only return that lets an action through unattended. With `authority_rules` empty it is provably a no-op.

**Tech Stack:** PostgreSQL (Supabase), plain SQL migration. No TypeScript, no UI.

## ⛔ PRECONDITION

Steps 1 and 2 must be applied. All five were applied 2026-08-18; verify anyway:

```bash
node scripts/db-query.mjs --sql "select (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='evaluate_authority') as evaluator_must_be_1, (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='set_authority_rule') as rpc_must_be_1"
```

Both must be `1`. If not, stop and tell the human partner.

## Global Constraints

- **Never pick a migration number yourself.** `npm run migrate:next -- <slug>` claims it atomically. Concurrent sessions claim numbers; a non-consecutive number is normal.
- **Commit the migration before applying it.** `db-query.mjs` refuses an untracked migration file.
- **Dry-run in an ALWAYS-ABORTING transaction before applying**, refusing to emit if a `commit;` survives.
- **Migrations use `begin;` … `commit;`.**
- **DELETE NOTHING.** `resolve_de_autonomy_chain`, the `require_approval_over_cents` guardrail, the spend caps and the destructive floor all stay exactly as they are (spec §6).
- **Probes matching SQL source must strip comments first** — `regexp_replace(prosrc, '--[^\n]*', '', 'g')` — or they match their own prose.
- **Count the comparisons, not just the findings.**
- **`<scratchpad>`** means this session's scratchpad directory, given to you in your dispatch. NOT `/tmp` — this is Windows and `/tmp` resolves to `D:/tmp`. Never write a dry-run file under `supabase/migrations/`.
- **`NNN`** means the number `migrate:next` printed for you.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## The three decisions this plan locks in

Established by reading the live function and its consumers before writing this:

**1. Where the check goes.** `decide_action_execution` ends:

```sql
  select * into v_autonomy from resolve_de_autonomy_chain(…, p_de_id, p_category);
  if coalesce(v_autonomy.enabled, false)
     and (p_amount_cents is null
          or (v_autonomy.max_amount_cents is not null and p_amount_cents <= v_autonomy.max_amount_cents)) then
    return jsonb_build_object('decision', 'auto_executed', …);
  end if;

  return jsonb_build_object('decision', 'human_gated_trust', …);
```

`auto_executed` is **the only return that lets an action through without a human**, so the risk check goes immediately before it. Everything else already ends at a human.

**2. How outcomes map — and why a new decision value is impossible.** `action_executions.decision` carries a CHECK enumerating exactly ten values, so a new one would **raise on insert** inside `record_action_execution`. The mapping therefore reuses existing vocabulary:

| `evaluate_authority` says | `decide_action_execution` returns | why |
|---|---|---|
| `allow` | *unchanged* — falls through to today's logic | the no-op case |
| `require_human` | `human_gated_trust` | the existing "a person must look at this" value |
| `require_second_approver` | `human_gated_trust` | an employee action has no second approver; gating to a human is the honest reading, and the reasoning says which rule asked |
| `deny` | **`access_denied`** | in the CHECK, semantically exact, and **never once used live** — so it cannot be confused with an existing meaning |

`guardrail_blocked` was considered and rejected: **5 functions branch on it**, and an authority denial is not a guardrail hit.

**3. Callers are safe.** **8 functions gate on `= 'auto_executed'`** — including all four `propose_*_writeback` paths — so anything else means "do not execute". `access_denied` therefore behaves correctly without touching a single caller. Only 1 function mentions `access_denied` at all.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/NNN_a_second_question_before_an_employee_acts.sql` | `decide_action_execution` gains the risk check |
| `supabase/tests/authority/compose-decide-action-execution.sql` | Durable probe suite |

---

### Task 1: Compose the risk check into `decide_action_execution`

**Files:**
- Create: `supabase/migrations/NNN_a_second_question_before_an_employee_acts.sql`
- Create: `supabase/tests/authority/compose-decide-action-execution.sql`
- Modify: `supabase/tests/authority/README.md` (append the run command)

**Interfaces:**
- Consumes: `public.evaluate_authority(p_tenant_id uuid, p_actor_kind text, p_actor_id uuid, p_category text, p_measures jsonb) returns jsonb` → `{"outcome":"allow|require_human|require_second_approver|deny","reasons":[…]}`; `public.set_authority_rule(p_actor_kind text, p_dimension text, p_comparator text, p_threshold numeric, p_outcome text, p_category text default null, p_actor_id uuid default null, p_actor_role text default null) returns uuid`; `public.decide_action_execution(p_tenant_id uuid, p_action_label text, p_category text, p_destructive boolean, p_de_id uuid, p_amount_cents bigint, p_action_type text, p_content text) returns jsonb`.
- Produces: nothing later tasks consume — this is the last task in step 3.

- [ ] **Step 1: Claim the migration number**

```bash
npm run migrate:next -- a_second_question_before_an_employee_acts
```

- [ ] **Step 2: Pull the live definition and confirm the anchors**

```bash
node scripts/db-query.mjs --sql "select pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='decide_action_execution'" > <scratchpad>/dae_live.json
```

Then confirm both anchors are present before writing anything:

```bash
node -e '
const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[0].def;
console.log("autonomy anchor:", d.includes("if coalesce(v_autonomy.enabled, false)"));
console.log("declare anchor:", /\n\s*v_autonomy\s+record\s*;/.test(d));
' <scratchpad>/dae_live.json
```

Both must print `true`. If either is `false`, STOP — the function has changed since this plan was written; report it rather than guessing.

- [ ] **Step 3: Write the failing probe**

Create `supabase/tests/authority/compose-decide-action-execution.sql`:

```sql
-- Composition probes for step 3. Run as ONE aborting transaction; see the
-- README in this directory for the command.
--
-- d1 is load-bearing, and d5 is what stops the rest passing vacuously: d2-d4
-- call decide_action_execution, but if the composition never happened they
-- would simply return today's answers and d2/d3 would FAIL — so d5 checks the
-- source directly, the same lesson step 2's c5 recorded.

create temp table dae_results(name text, outcome text, detail text) on commit drop;

do $d$
declare
  v_tenant uuid; v_de uuid; v_user uuid;
  v_gate jsonb; v_n int := 0; v_changed int := 0; v_before text; v_after text;
begin
  -- ── d1: with NO rules, the decision for every (tenant, employee) pair must
  -- ──     be exactly what it is today. Captured BEFORE any rule is written.
  for v_tenant, v_de in
    select d.tenant_id, d.id from digital_employees d
     where d.lifecycle_status in ('assigned','active','improving','paused')
     limit 40
  loop
    v_n := v_n + 1;
    v_gate := decide_action_execution(v_tenant, 'probe action', 'crm', false, v_de, null, 'action_execute', null);
    if coalesce(v_gate->>'decision','') not in ('auto_executed','human_gated_trust','human_gated_destructive','guardrail_blocked','human_gated_paused') then
      v_changed := v_changed + 1;
    end if;
  end loop;
  insert into dae_results values
    ('d1_no_rules_yields_only_todays_decisions',
     case when v_changed = 0 then 'pass' else 'FAIL' end,
     format('called decide_action_execution for %s live employees; %s returned a decision outside today''s vocabulary', v_n, v_changed));

  insert into dae_results values
    ('d1b_denominator_is_not_zero', case when v_n > 0 then 'pass' else 'FAIL' end,
     format('%s employees exercised', v_n));

  -- ── Seed an admin session so set_authority_rule's role check passes. The
  -- ── claim names a REAL profile; no auth identity is forged.
  select d.tenant_id, d.id into v_tenant, v_de
    from digital_employees d
    join profiles p on p.tenant_id = d.tenant_id and coalesce(p.is_active,true)
                   and p.role in ('tenant_owner','tenant_admin')
   where d.lifecycle_status in ('assigned','active','improving','paused')
   limit 1;
  select p.user_id into v_user from profiles p
   where p.tenant_id = v_tenant and coalesce(p.is_active,true)
     and p.role in ('tenant_owner','tenant_admin') limit 1;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_user, 'role','authenticated')::text, true);

  -- Baseline this employee WITHOUT a rule, so d2/d3 are measured against its
  -- own prior answer rather than an assumption about what it would be.
  v_before := decide_action_execution(v_tenant,'probe action','crm',false,v_de,50000,'action_execute',null)->>'decision';
  insert into dae_results values
    ('d2a_baseline_captured', case when v_before is not null then 'pass' else 'FAIL' end, v_before);

  -- ── d2: a `deny` rule must produce access_denied ────────────────────────
  perform set_authority_rule('de','amount_cents','>',1,'deny','crm',v_de);
  v_after := decide_action_execution(v_tenant,'probe action','crm',false,v_de,50000,'action_execute',null)->>'decision';
  insert into dae_results values
    ('d2_deny_rule_yields_access_denied',
     case when v_after = 'access_denied' then 'pass' else 'FAIL' end,
     format('was %s, now %s', v_before, v_after));

  -- ── d3: a require_human rule must NOT auto-execute ──────────────────────
  delete from authority_rules where tenant_id = v_tenant;
  perform set_authority_rule('de','amount_cents','>',1,'require_human','crm',v_de);
  v_after := decide_action_execution(v_tenant,'probe action','crm',false,v_de,50000,'action_execute',null)->>'decision';
  insert into dae_results values
    ('d3_require_human_never_auto_executes',
     case when v_after <> 'auto_executed' then 'pass' else 'FAIL' end,
     format('decision is %s', v_after));

  -- ── d4: a rule for a DIFFERENT category must not fire ───────────────────
  delete from authority_rules where tenant_id = v_tenant;
  perform set_authority_rule('de','amount_cents','>',1,'deny','erp_financials',v_de);
  v_after := decide_action_execution(v_tenant,'probe action','crm',false,v_de,50000,'action_execute',null)->>'decision';
  insert into dae_results values
    ('d4_other_category_rule_does_not_fire',
     case when v_after = v_before then 'pass' else 'FAIL' end,
     format('baseline %s, with an erp_financials rule %s', v_before, v_after));

  -- ── d5: the composition actually happened, and nothing was deleted ──────
  insert into dae_results values
    ('d5_function_calls_the_evaluator',
     case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                        where n.nspname='public' and p.proname='decide_action_execution'
                          and regexp_replace(p.prosrc,'--[^\n]*','','g') ~ 'evaluate_authority')
          then 'pass' else 'FAIL' end,
     'comment-stripped source references evaluate_authority');

  insert into dae_results values
    ('d6_autonomy_chain_still_called',
     case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                        where n.nspname='public' and p.proname='decide_action_execution'
                          and regexp_replace(p.prosrc,'--[^\n]*','','g') ~ 'resolve_de_autonomy_chain')
          then 'pass' else 'FAIL' end,
     'the earned-trust resolution was not replaced');

  delete from authority_rules where tenant_id = v_tenant;
end $d$;

select jsonb_agg(jsonb_build_object('name',name,'outcome',outcome,'detail',detail) order by name) as dae_suite
  from dae_results;
rollback;
```

- [ ] **Step 4: Run it against the CURRENT function to see which assertions fail**

```bash
{ echo 'begin;'; cat supabase/tests/authority/compose-decide-action-execution.sql; } > <scratchpad>/dry-dae-before.sql
node scripts/db-query.mjs <scratchpad>/dry-dae-before.sql
```

Expected **before** the migration: `d1`, `d1b`, `d2a`, `d4`, `d6` pass; **`d2`, `d3` and `d5` FAIL**. Record this output in your report — it is the proof the suite discriminates. If `d2`/`d3`/`d5` already pass, the composition already exists and you should STOP and report it.

- [ ] **Step 5: Generate the composed body**

Write `<scratchpad>/mk-dae.mjs`:

```javascript
import { readFileSync, writeFileSync } from 'node:fs';
const CR = String.fromCharCode(13);
const def = JSON.parse(readFileSync(process.argv[2], 'utf8'))[0].def.split(CR).join('');

const ANCHOR = `  if coalesce(v_autonomy.enabled, false)`;
const ADDED = `  -- ── THE SECOND QUESTION (spec §3.6), on the employee path ────────────
  -- Everything above answered "has this employee EARNED this?" — guardrails,
  -- the destructive floor, the amount threshold, the spend caps and the
  -- earned-trust chain. All of it is unchanged. This asks the other question:
  -- "does this particular action need more scrutiny?"
  --
  -- It sits immediately before the auto_executed return because that is THE
  -- ONLY return in this function that lets an action through without a human.
  -- Every other path already ends at a person.
  --
  -- ⚠ THE MAPPING IS CONSTRAINED, NOT CHOSEN. action_executions.decision
  -- carries a CHECK of ten values, so a new one would RAISE on insert inside
  -- record_action_execution. deny therefore becomes 'access_denied' — in the
  -- CHECK, semantically exact, and never once used live, so it cannot be
  -- confused with an existing meaning. 'guardrail_blocked' was rejected: five
  -- functions branch on it, and an authority denial is not a guardrail hit.
  -- Callers are safe either way — eight functions gate on = 'auto_executed',
  -- so anything else means "do not execute".
  --
  -- With authority_rules EMPTY this is exactly a no-op.
  v_risk := evaluate_authority(
    p_tenant_id,
    case when p_de_id is null then 'all' else 'de' end,
    p_de_id,
    p_category,
    case when p_amount_cents is null then '{}'::jsonb
         else jsonb_build_object('amount_cents', p_amount_cents) end);

  if v_risk->>'outcome' = 'deny' then
    return jsonb_build_object('decision', 'access_denied',
      'guardrail_rule_id', null, 'guardrail_rule', null, 'trust_level', null,
      'reasoning', format('Refused: a workspace authority rule denies this. %s',
        coalesce(v_risk->'reasons'->0->>'why', 'No reason was recorded.')));
  end if;

  if v_risk->>'outcome' in ('require_human','require_second_approver') then
    return jsonb_build_object('decision', 'human_gated_trust',
      'guardrail_rule_id', null, 'guardrail_rule', null, 'trust_level', null,
      'reasoning', format('Needs approval: a workspace authority rule asks for a person here. %s',
        coalesce(v_risk->'reasons'->0->>'why', 'No reason was recorded.')));
  end if;

` + ANCHOR;

if (!def.includes(ANCHOR)) { console.error('REFUSED: autonomy anchor missing'); process.exit(1); }
let out = def.replace(ANCHOR, ADDED);

if (!/\n\s*v_autonomy\s+record\s*;/.test(out)) { console.error('REFUSED: v_autonomy declaration missing'); process.exit(1); }
out = out.replace(/(\n\s*v_autonomy\s+record\s*;)/, '$1\n  v_risk jsonb;');

writeFileSync(process.argv[3], out);
console.log('composed body generated from the LIVE definition; both anchors matched');
console.log('  v_risk occurrences:', (out.match(/v_risk/g) || []).length);
```

Run it:

```bash
node <scratchpad>/mk-dae.mjs <scratchpad>/dae_live.json <scratchpad>/dae-body.sql
```

Expected: `both anchors matched`, and `v_risk occurrences: 6`.

- [ ] **Step 6: Assemble the migration**

```bash
{ echo '-- WHY: spec §3.6 — two questions, both required, now on the employee path.'
  echo '-- Everything that answered "has this employee EARNED this?" is UNCHANGED:'
  echo '-- guardrails, the destructive floor, the amount threshold, the spend caps and'
  echo '-- resolve_de_autonomy_chain. This adds the risk question immediately before'
  echo '-- the auto_executed return — the only return that lets an action through'
  echo '-- without a human.'
  echo '--'
  echo '-- Body generated from the live pg_get_functiondef with two anchored edits; the'
  echo '-- generator REFUSES if either anchor is missing, so a concurrent edit cannot'
  echo '-- be silently overwritten.'
  echo ''
  echo 'begin;'
  cat <scratchpad>/dae-body.sql
  echo ';'
  echo ''
  echo 'commit;'
} > supabase/migrations/NNN_a_second_question_before_an_employee_acts.sql
```

- [ ] **Step 7: Dry-run the migration with the probe suite**

```bash
node -e '
const fs=require("fs");
let m=fs.readFileSync(process.argv[1],"utf8");
m=m.replace(/^commit;\s*$/m, "\n"+fs.readFileSync(process.argv[2],"utf8"));
if(/^\s*commit\s*;/mi.test(m)){console.error("REFUSED: commit survived");process.exit(1);}
fs.writeFileSync(process.argv[3],m);
' supabase/migrations/NNN_a_second_question_before_an_employee_acts.sql supabase/tests/authority/compose-decide-action-execution.sql <scratchpad>/dry-dae.sql
node scripts/db-query.mjs <scratchpad>/dry-dae.sql
```

Expected — **every** row `pass`, with a non-zero denominator:

| assertion | must be |
|---|---|
| `d1_no_rules_yields_only_todays_decisions` | pass, `0 returned a decision outside today's vocabulary` |
| `d1b_denominator_is_not_zero` | pass, count **> 0** |
| `d2a_baseline_captured` | pass |
| `d2_deny_rule_yields_access_denied` | pass |
| `d3_require_human_never_auto_executes` | pass |
| `d4_other_category_rule_does_not_fire` | pass |
| `d5_function_calls_the_evaluator` | pass |
| `d6_autonomy_chain_still_called` | pass |

If `d1` passes but `d1b` reports 0, the suite proved nothing — fix the fixture, do not accept it.

- [ ] **Step 8: Confirm the rollback left production unchanged**

```bash
node scripts/db-query.mjs --sql "select count(*) as must_be_0 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='decide_action_execution' and regexp_replace(p.prosrc,'--[^\n]*','','g') ~ 'evaluate_authority'"
```

Expected: `0`.

- [ ] **Step 9: Append the run command to the tests README**

Add to `supabase/tests/authority/README.md`:

```markdown
## compose-decide-action-execution.sql (step 3)

Requires 768, 770, 772, 783, 784 and step 3's migration. Run as one aborting
transaction (concatenate the step-3 migration if it is not yet applied):

    { echo 'begin;'; cat supabase/tests/authority/compose-decide-action-execution.sql; } \
      > <scratchpad>/dry-dae.sql && node scripts/db-query.mjs <scratchpad>/dry-dae.sql

d1 is load-bearing: with authority_rules empty, every live employee must still
get a decision from today's vocabulary. d1b exists because d1 passes vacuously
on zero employees. d5 exists because d2-d4 call decide_action_execution and
would report today's answers if the composition never happened. d6 proves the
earned-trust resolution was not replaced.
```

- [ ] **Step 10: Commit, then STOP and ask before applying**

```bash
git add supabase/migrations/NNN_a_second_question_before_an_employee_acts.sql supabase/tests/authority/compose-decide-action-execution.sql supabase/tests/authority/README.md
git commit -m "feat(authority): a second question before an employee acts"
```

Do **not** apply. Report to the human partner; production applies are theirs.

---

## Done when

- The migration and its probe suite are committed, dry-run clean, **not applied**.
- The suite passes with a non-zero denominator on `d1b`, and your report records the **before** run from Step 4 showing `d2`/`d3`/`d5` failing — the proof it discriminates.
- `git diff --stat` shows only the one migration and the two test files.
- `resolve_de_autonomy_chain`, the `require_approval_over_cents` guardrail, the spend caps and the destructive floor are all still present and unmodified.

## Explicitly NOT in this step

- **The `measures` column and the 19 `human_tasks` writers** — step 4. This step passes `{"amount_cents": …}` from the parameter `decide_action_execution` already receives, and `{}` when it is null.
- **`subject_count`, `reversible`, `rate_per_hour`** — step 4 ships their readers first; until then mig 770's trigger refuses any rule naming them.
- **Any UI.**
- **Re-pinning `execute-allowlist.json`** — this step adds no new `authenticated`-executable routine, so the pinned surface does not move. Confirm that rather than assume it.
