# Authority Risk Check — Compose into `decide_human_task` (Step 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a workspace write an authority rule, and make `decide_human_task` consult it — **alongside** the existing entitlement check, never instead of it.

**Architecture:** Two questions, both required (spec §3.6). `has_approval_authority` keeps answering *"may you sign this at all?"* and is not modified. `evaluate_authority` answers *"does this action need more scrutiny?"* and is added after it. With `authority_rules` empty the composition is provably a no-op, so this ships dark and only begins to matter when someone writes a rule.

**Tech Stack:** PostgreSQL (Supabase), plain SQL migrations. No TypeScript — no UI in this step.

## ⛔ PRECONDITION — do not start until this is true

**Step 1's migrations (768, 770, 772) must be APPLIED to production.** They are committed but unapplied as of 2026-08-18. Verify first:

```bash
node scripts/db-query.mjs --sql "select count(*) as must_be_1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='evaluate_authority'"
```

If that returns `0`, stop and tell the human partner. Everything below calls it.

## Global Constraints

Copied from the spec and this repo's `CLAUDE.md`. Every task's requirements implicitly include these.

- **Never pick a migration number yourself.** `npm run migrate:next -- <slug>` claims it atomically against production. Concurrent sessions claim numbers; a non-consecutive number is normal.
- **Commit the migration before applying it.** `scripts/db-query.mjs` refuses an untracked migration file.
- **Dry-run every migration in an ALWAYS-ABORTING transaction before applying.** Refuse to emit if a `commit;` survives.
- **Migrations use `begin;` … `commit;`** — repo convention. The dry-run builder converts the trailing `commit;` to `rollback;`.
- **Close default EXECUTE grants explicitly**: `revoke all … from public; … from anon;` then grant deliberately (migs 610 + 630).
- **A tenant id passed as a parameter is an assertion to verify, never authorisation.** An `actor_id` supplied by a caller is likewise an assertion.
- **Probes matching SQL source must strip comments first** — `regexp_replace(prosrc, '--[^\n]*', '', 'g')` — or they match their own prose.
- **DELETE NOTHING.** `has_approval_authority`, `task_approval_facts`, `resolve_de_autonomy_chain` and the `require_approval_over_cents` guardrail all stay exactly as they are (spec §6).
- **Count the comparisons, not just the findings.** Zero differences from zero comparisons looks identical to a clean result.
- **`<scratchpad>`** in every command below means this session's scratchpad directory, given to you in your dispatch. It is **not** `/tmp` — this is Windows and `/tmp` resolves to `D:/tmp`, which will surprise you. Never write a dry-run file under `supabase/migrations/`: that path is what makes `db-query.mjs` treat a file as a real migration and refuse it unless committed.
- **`NNN`** in a filename means the number `npm run migrate:next` printed for you. Use it everywhere in that task.

## Scope decisions taken while planning

- **No `measures` column on `human_tasks` in this step.** The spec's §3.2 persists measures for audit, but step 2 has only one measure to offer — `amount_cents` — and `task_approval_facts` already derives it. Adding a column that duplicates an existing derivation buys nothing until richer measures exist. It arrives with step 4, alongside the paths that emit them.
- **The 19 SQL writers of `human_tasks` are NOT touched.** Populating measures across them is step 4's subsystem (spec §8 step 4: "the paths that emit it"), and it is far larger than this step.
- **No UI.** Rules are writable through the RPC; a screen is a later, separate piece.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/NNN_a_workspace_can_write_an_authority_rule.sql` | `set_authority_rule` RPC — the only write path to `authority_rules` |
| `supabase/migrations/NNN_a_second_question_before_a_signature.sql` | `decide_human_task` gains the risk check, composed after entitlement |
| `supabase/tests/authority/compose-decide-human-task.sql` | Durable probe suite for the composition |

Migration numbers are claimed at execution time, so the filenames carry `NNN`.

---

### Task 1: The rule-writing RPC

**Files:**
- Create: `supabase/migrations/NNN_a_workspace_can_write_an_authority_rule.sql`

**Interfaces:**
- Consumes: `authority_rules` (step 1, mig 770) — columns `tenant_id, actor_kind, actor_id, actor_role, category, dimension, comparator, threshold, outcome, is_active, created_by`; its `authority_rules_actor_shape` CHECK; its composite FK to `authority_dimension_comparators`; and its `authority_rule_requires_a_reader` trigger.
- Produces: `public.set_authority_rule(p_actor_kind text, p_dimension text, p_comparator text, p_threshold numeric, p_outcome text, p_category text default null, p_actor_id uuid default null, p_actor_role text default null) returns uuid`

- [ ] **Step 1: Claim the migration number**

```bash
npm run migrate:next -- a_workspace_can_write_an_authority_rule
```

- [ ] **Step 2: Write the failing probe**

Create `<scratchpad>/probe-set-rule.sql` (scratchpad path, NOT `/tmp` — this is Windows and `/tmp` becomes `D:/tmp`):

```sql

set local request.jwt.claims = '{"sub":"503c42a6-fd8b-415b-80d9-4e6af9e53a17","role":"authenticated"}';

create temp table r(c text, outcome text) on commit drop;
do $t$
declare v uuid; v_tenant uuid := '64fd1ff0-91c9-4700-b65e-9e3df3fd1963'; v_de uuid; v_other_de uuid; begin
  select id into v_de       from digital_employees where tenant_id = v_tenant limit 1;
  select id into v_other_de from digital_employees where tenant_id <> v_tenant limit 1;

  begin v := set_authority_rule('all','amount_cents','>',50000,'require_human','erp_financials');
    insert into r values ('1 valid all-rule', case when v is null then 'NULL' else 'OK' end);
  exception when others then insert into r values ('1 valid all-rule','ERR: '||sqlerrm); end;

  begin v := set_authority_rule('role','amount_cents','>',1000,'deny',null,null,'tenant_admin');
    insert into r values ('2 valid role-rule', case when v is null then 'NULL' else 'OK' end);
  exception when others then insert into r values ('2 valid role-rule','ERR: '||sqlerrm); end;

  begin v := set_authority_rule('de','amount_cents','>',1000,'require_human',null,v_de);
    insert into r values ('3 valid de-rule', case when v is null then 'NULL' else 'OK' end);
  exception when others then insert into r values ('3 valid de-rule','ERR: '||sqlerrm); end;

  begin v := set_authority_rule('de','amount_cents','>',1000,'require_human',null,v_other_de);
    insert into r values ('4 foreign de MUST reject','ACCEPTED (BAD)');
  exception when others then insert into r values ('4 foreign de MUST reject','rejected: '||split_part(sqlerrm,':',1)); end;

  begin v := set_authority_rule('role','amount_cents','>',1000,'require_human',null,gen_random_uuid(),null);
    insert into r values ('5 role without actor_role MUST reject','ACCEPTED (BAD)');
  exception when others then insert into r values ('5 role without actor_role MUST reject','rejected: '||split_part(sqlerrm,':',1)); end;

  begin v := set_authority_rule('all','subject_count','>',10,'require_human');
    insert into r values ('6 reader-less dimension MUST reject','ACCEPTED (BAD)');
  exception when others then insert into r values ('6 reader-less dimension MUST reject','rejected: '||split_part(sqlerrm,':',1)); end;

  begin v := set_authority_rule('all','amount_cents','<',5,'require_human');
    insert into r values ('7 illegal comparator MUST reject','ACCEPTED (BAD)');
  exception when others then insert into r values ('7 illegal comparator MUST reject','rejected'); end;

  begin v := set_authority_rule('all','amount_cents','>',5,'set_on_fire');
    insert into r values ('8 unknown outcome MUST reject','ACCEPTED (BAD)');
  exception when others then insert into r values ('8 unknown outcome MUST reject','rejected'); end;
end $t$;

select jsonb_agg(jsonb_build_object('case',c,'outcome',outcome) order by c) as suite,
       (select count(*) from authority_rules) as rows_written_must_be_3 from r;
rollback;
```

- [ ] **Step 3: Run it to make sure it fails**

```bash
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[2],"begin;\n"+fs.readFileSync(process.argv[1],"utf8"))' <scratchpad>/probe-set-rule.sql <scratchpad>/dry-set-rule.sql
node scripts/db-query.mjs <scratchpad>/dry-set-rule.sql
```

Expected: FAIL with `function set_authority_rule(...) does not exist`.

- [ ] **Step 4: Write the migration**

```sql
-- ==========================================================================
-- WHY: authority_rules (mig 770) shipped with NO write policy, deliberately —
-- writes go through this RPC so there is exactly one path to that state. A
-- permissive write policy plus a table grant would be a second path to the
-- same rows, which this repo has paid for before.
--
-- The RPC deliberately does NOT re-implement the guarantees 770 already
-- enforces in the schema. The composite FK still rejects an illegal
-- (dimension, comparator) pairing, and the trigger still rejects a dimension
-- with no live reader and a threshold that could never fire. This function
-- adds only what a CHECK cannot see: WHO is asking, and whether the actor
-- they named is theirs.
-- ==========================================================================

begin;

create or replace function public.set_authority_rule(
  p_actor_kind text,
  p_dimension  text,
  p_comparator text,
  p_threshold  numeric,
  p_outcome    text,
  p_category   text  default null,
  p_actor_id   uuid  default null,
  p_actor_role text  default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare
  v_tenant uuid := auth_tenant_id();
  v_id     uuid;
begin
  if v_tenant is null then raise exception 'not_authenticated'; end if;
  if not auth_has_tenant_role(array['tenant_owner','tenant_admin']) then
    raise exception 'insufficient_role';
  end if;

  -- The shape CHECK in 770 would catch these, but its message names a
  -- constraint. These name the mistake.
  if p_actor_kind = 'role' and coalesce(btrim(p_actor_role), '') = '' then
    raise exception 'actor_role_required: a rule scoped to a role must name the role';
  end if;
  if p_actor_kind in ('user','org_unit','de') and p_actor_id is null then
    raise exception 'actor_id_required: a rule scoped to % must name which one', p_actor_kind;
  end if;

  -- ⛔ AN ACTOR ID SUPPLIED BY A CALLER IS AN ASSERTION, NOT AUTHORISATION.
  -- Without these, an owner could scope a rule onto another workspace's
  -- employee or org unit — the tenant-id-param trap, one level down.
  if p_actor_kind = 'user' and not exists (
       select 1 from profiles where user_id = p_actor_id and tenant_id = v_tenant) then
    raise exception 'actor_not_in_workspace: no profile for that user here';
  end if;
  if p_actor_kind = 'de' and not exists (
       select 1 from digital_employees where id = p_actor_id and tenant_id = v_tenant) then
    raise exception 'actor_not_in_workspace: no digital employee with that id here';
  end if;
  if p_actor_kind = 'org_unit' and not exists (
       select 1 from org_units where id = p_actor_id and tenant_id = v_tenant) then
    raise exception 'actor_not_in_workspace: no org unit with that id here';
  end if;

  insert into authority_rules
    (tenant_id, actor_kind, actor_id, actor_role, category,
     dimension, comparator, threshold, outcome, created_by)
  values
    (v_tenant, p_actor_kind,
     case when p_actor_kind in ('user','org_unit','de') then p_actor_id end,
     case when p_actor_kind = 'role' then btrim(p_actor_role) end,
     nullif(btrim(coalesce(p_category, '')), ''),
     p_dimension, p_comparator, p_threshold, p_outcome, auth.uid())
  returning id into v_id;

  return v_id;
end
$fn$;

revoke all on function public.set_authority_rule(text,text,text,numeric,text,text,uuid,text) from public;
revoke all on function public.set_authority_rule(text,text,text,numeric,text,text,uuid,text) from anon;
grant execute on function public.set_authority_rule(text,text,text,numeric,text,text,uuid,text) to authenticated;

commit;
```

- [ ] **Step 5: Dry-run it in an aborting transaction**

```bash
node -e '
const fs=require("fs");
let m=fs.readFileSync(process.argv[1],"utf8");
m=m.replace(/^commit;\s*$/m, fs.readFileSync(process.argv[2],"utf8"));
if(/^\s*commit\s*;/mi.test(m)){console.error("REFUSED: commit survived");process.exit(1);}
fs.writeFileSync(process.argv[3],m);
' supabase/migrations/NNN_a_workspace_can_write_an_authority_rule.sql <scratchpad>/probe-set-rule.sql <scratchpad>/dry-set-rule.sql
node scripts/db-query.mjs <scratchpad>/dry-set-rule.sql
```

Expected: cases 1-3 `OK`; cases 4-8 all `rejected`; `rows_written_must_be_3: 3`.

**Cases 1-3 passing matter as much as the rejections.** A suite where everything rejects proves only that the RPC refuses everything — it would not prove a rule can be written at all.

- [ ] **Step 6: Confirm the rollback left nothing behind**

```bash
node scripts/db-query.mjs --sql "select count(*) as fn_must_be_0 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='set_authority_rule'"
```

Expected: `0`.

- [ ] **Step 7: Commit, then STOP and ask before applying**

```bash
git add supabase/migrations/NNN_a_workspace_can_write_an_authority_rule.sql
git commit -m "feat(authority): a workspace can write an authority rule"
```

Do **not** apply. Report the filename to the human partner; production applies are theirs.

- [ ] **Step 8: Note the EXECUTE-perimeter change in your report**

`set_authority_rule` is granted to `authenticated`, so it is a NEW entry on the surface `supabase/baseline/execute-allowlist.json` pins. certify will show it as unpinned until re-pinned after apply. Say so in the report; do not re-pin it yourself.

---

### Task 2: Compose the risk check into `decide_human_task`

**Files:**
- Create: `supabase/migrations/NNN_a_second_question_before_a_signature.sql`
- Create: `supabase/tests/authority/compose-decide-human-task.sql`

**Interfaces:**
- Consumes: `public.evaluate_authority(p_tenant_id uuid, p_actor_kind text, p_actor_id uuid, p_category text, p_measures jsonb) returns jsonb` returning `{"outcome": "allow|require_human|require_second_approver|deny", "reasons":[…]}`; `public.task_approval_facts(p_task_id uuid) returns table(category text, amount_cents bigint)`; `public.set_authority_rule(...)` from Task 1.
- Produces: nothing later tasks consume — this is the last task in step 2.

- [ ] **Step 1: Claim the migration number**

```bash
npm run migrate:next -- a_second_question_before_a_signature
```

- [ ] **Step 2: Read the function you are about to change**

```bash
node scripts/db-query.mjs --sql "select pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='decide_human_task'" > <scratchpad>/dht.json
```

You will regenerate the body from this live definition with ONE inserted block — do not retype the function.

The block you are inserting goes immediately after the existing entitlement refusal and before the second-approver block. The surrounding code reads exactly:

```sql
  IF p_decision = 'approved' THEN
    SELECT category, amount_cents INTO v_cat, v_amt FROM task_approval_facts(p_task_id);
    v_auth := has_approval_authority(auth.uid(), v_tenant, v_cat, v_amt);

    IF NOT coalesce((v_auth->>'allowed')::boolean, true) THEN
      RAISE EXCEPTION 'not_authorised_to_approve: %', v_auth->>'reason';
    END IF;
```

- [ ] **Step 3: Write the failing probe**

Create `supabase/tests/authority/compose-decide-human-task.sql`:

```sql
-- Composition probes for step 2. Run as ONE aborting transaction; see the
-- README in this directory for the exact command.
--
-- The load-bearing assertion is c1. ⚠ BE PRECISE ABOUT WHAT IT PROVES: it does
-- NOT re-run decide_human_task end to end and diff the answers — that would
-- mean approving real tasks. It proves the ADDED check returns `allow` for
-- every (tenant, user) pair drawn from the live approval_authority rows. Since
-- the added check can only refuse on `deny` and can only OR into needs_second
-- on `require_second_approver`, an `allow` on every pair means the composed
-- outcome is unchanged. That is a compositional argument resting on the shape
-- of the inserted block, not an end-to-end differential — say so in the report
-- rather than claiming byte-identity you did not measure.

create temp table compose_results(name text, outcome text, detail text) on commit drop;

do $c$
declare
  v_tenant uuid; v_user uuid; v_task uuid; v_cat text; v_amt bigint;
  v_before jsonb; v_after jsonb; v_n int := 0; v_diff int := 0; v_fired int := 0;
begin
  -- ── c1: with NO rules, the composed answer must equal the entitlement
  -- ──     answer for EVERY existing approval-authority row's workspace.
  for v_tenant, v_user in
    select distinct a.tenant_id, p.user_id
      from approval_authority a
      join profiles p on p.tenant_id = a.tenant_id and coalesce(p.is_active,true)
     where a.is_active
  loop
    v_n := v_n + 1;
    v_before := has_approval_authority(v_user, v_tenant, 'erp_financials', 50000::bigint);
    v_after  := evaluate_authority(v_tenant, 'user', v_user, 'erp_financials',
                                   jsonb_build_object('amount_cents', 50000));
    -- With no rules the risk answer must be `allow`, i.e. it changes nothing.
    if coalesce(v_after->>'outcome','allow') <> 'allow' then
      v_diff := v_diff + 1;
    end if;
  end loop;
  insert into compose_results values
    ('c1_added_check_is_allow_for_every_live_pair',
     case when v_diff = 0 then 'pass' else 'FAIL' end,
     format('compared %s (tenant,user) pairs drawn from live approval_authority rows; %s returned something other than allow', v_n, v_diff));

  -- ⚠ A denominator of 0 would make the line above pass vacuously.
  insert into compose_results values
    ('c1b_denominator_is_not_zero', case when v_n > 0 then 'pass' else 'FAIL' end,
     format('%s pairs compared', v_n));

  -- ── c2: a `deny` rule REFUSES an approval that entitlement would allow ──
  select a.tenant_id into v_tenant from approval_authority a where a.is_active limit 1;
  select p.user_id into v_user from profiles p
    where p.tenant_id = v_tenant and coalesce(p.is_active,true)
      and p.role in ('tenant_owner','tenant_admin') limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role','authenticated')::text, true);

  perform set_authority_rule('all','amount_cents','>',1,'deny','erp_financials');
  v_after := evaluate_authority(v_tenant,'user',v_user,'erp_financials',
                                jsonb_build_object('amount_cents', 50000));
  insert into compose_results values
    ('c2_deny_rule_denies',
     case when v_after->>'outcome' = 'deny' then 'pass' else 'FAIL' end,
     v_after->>'outcome');

  -- ── c3: a require_second_approver rule reaches the needs_second path ──
  delete from authority_rules where tenant_id = v_tenant;
  perform set_authority_rule('all','amount_cents','>',1,'require_second_approver','erp_financials');
  v_after := evaluate_authority(v_tenant,'user',v_user,'erp_financials',
                                jsonb_build_object('amount_cents', 50000));
  insert into compose_results values
    ('c3_second_approver_reachable',
     case when v_after->>'outcome' = 'require_second_approver' then 'pass' else 'FAIL' end,
     v_after->>'outcome');

  -- ── c4: require_human is ALREADY SATISFIED on this path — a human is
  -- ──     approving — so it must NOT refuse.
  delete from authority_rules where tenant_id = v_tenant;
  perform set_authority_rule('all','amount_cents','>',1,'require_human','erp_financials');
  v_after := evaluate_authority(v_tenant,'user',v_user,'erp_financials',
                                jsonb_build_object('amount_cents', 50000));
  insert into compose_results values
    ('c4_require_human_is_satisfied_here',
     case when v_after->>'outcome' = 'require_human' then 'pass' else 'FAIL' end,
     'evaluator says require_human; decide_human_task must treat it as satisfied');
end $c$;

select jsonb_agg(jsonb_build_object('name',name,'outcome',outcome,'detail',detail) order by name) as compose_suite
  from compose_results;
rollback;
```

- [ ] **Step 4: Run it to make sure it fails**

```bash
{ echo 'begin;'; cat supabase/tests/authority/compose-decide-human-task.sql; } > <scratchpad>/dry-compose.sql
node scripts/db-query.mjs <scratchpad>/dry-compose.sql
```

Expected: FAIL with `function set_authority_rule(...) does not exist` (Task 1's migration is committed but unapplied). If Task 1 HAS been applied by the human partner, expect instead a clean run where c2/c3/c4 pass and c1 passes — that is fine; the composition itself is still unbuilt and Step 6 is what proves it.

- [ ] **Step 5: Write the migration**

Generate the body from the live definition with exactly one inserted block. Write this generator to `<scratchpad>/mk-compose.mjs` and run it:

```javascript
import { readFileSync, writeFileSync } from 'node:fs';
const CR = String.fromCharCode(13);
const def = JSON.parse(readFileSync(process.argv[2], 'utf8'))[0].def.split(CR).join('');

const ANCHOR = `    IF NOT coalesce((v_auth->>'allowed')::boolean, true) THEN
      RAISE EXCEPTION 'not_authorised_to_approve: %', v_auth->>'reason';
    END IF;
`;
const ADDED = ANCHOR + `
    -- ── THE SECOND QUESTION (spec §3.6) ──────────────────────────────────
    -- Entitlement above answered "may you sign this at all?" — a property of
    -- a PERSON, deny-by-default, because the absence of a grant means nobody
    -- gave you that authority. This asks "does this action need more
    -- scrutiny?" — a property of an ACTION, escalate-only, because the
    -- absence of a restriction means nobody said it was dangerous.
    -- Composed, never merged: the two models have OPPOSITE polarity, and
    -- replacing one with the other would flip deny to allow for every
    -- workspace that has declared authority.
    --
    -- With authority_rules EMPTY this is exactly a no-op, which is the point:
    -- it ships dark and begins to matter only when someone writes a rule.
    v_risk := evaluate_authority(v_tenant, 'user', auth.uid(), v_cat,
                                 case when v_amt is null then '{}'::jsonb
                                      else jsonb_build_object('amount_cents', v_amt) end);

    IF v_risk->>'outcome' = 'deny' THEN
      RAISE EXCEPTION 'not_authorised_to_approve: %',
        coalesce(v_risk->'reasons'->0->>'why', 'a workspace rule denies this');
    END IF;

    -- ⚠ require_human is ALREADY SATISFIED on this path — a human IS
    -- approving. Treating it as a refusal would make every unmeasured rule
    -- block every approval. The outcomes that bite here are `deny` above and
    -- `require_second_approver`, which is OR-ed into the existing needs_second
    -- below rather than replacing it: a second pair of eyes required by
    -- EITHER the grant model or a risk rule is still a second pair of eyes.
`;

if (!def.includes(ANCHOR)) {
  console.error('REFUSED: decide_human_task is not the shape this migration was written against.');
  process.exit(1);
}
let out = def.replace(ANCHOR, ADDED);

// Declare the new variable alongside the existing v_auth.
const DECL = 'v_auth';
if (!out.includes(DECL)) { console.error('REFUSED: v_auth declaration not found'); process.exit(1); }
out = out.replace(/(\n\s*v_auth\s+jsonb\s*;)/, '$1\n  v_risk jsonb;');

// OR the risk outcome into the existing second-approver condition.
const SEC = `IF coalesce((v_auth->>'needs_second')::boolean, false)`;
if (!out.includes(SEC)) { console.error('REFUSED: needs_second condition not found'); process.exit(1); }
out = out.replace(SEC,
  `IF (coalesce((v_auth->>'needs_second')::boolean, false)
        OR v_risk->>'outcome' = 'require_second_approver')`);

writeFileSync(process.argv[3], out);
console.log('composed body generated from the LIVE definition; all three anchors matched');
```

Then wrap it as a migration:

```bash
{ echo '-- WHY: spec §3.6 — two questions, both required. Entitlement (has_approval_authority,'
  echo '-- a GRANT model, deny-by-default) is UNCHANGED. This adds the risk question'
  echo '-- (evaluate_authority, a RESTRICTION model, escalate-only) AFTER it. Nothing is'
  echo '-- deleted. With authority_rules empty the composition is provably a no-op.'
  echo '--'
  echo '-- Body generated from the live pg_get_functiondef with three anchored edits; the'
  echo '-- generator REFUSES if any anchor is missing, so a concurrent edit cannot be'
  echo '-- silently overwritten.'
  echo ''
  echo 'begin;'
  cat <scratchpad>/composed-body.sql
  echo ';'
  echo 'commit;'
} > supabase/migrations/NNN_a_second_question_before_a_signature.sql
```

- [ ] **Step 6: Dry-run the migration with the probe suite**

```bash
node -e '
const fs=require("fs");
let m=fs.readFileSync(process.argv[1],"utf8");
m=m.replace(/^commit;\s*$/m, "\n"+fs.readFileSync(process.argv[2],"utf8"));
if(/^\s*commit\s*;/mi.test(m)){console.error("REFUSED: commit survived");process.exit(1);}
fs.writeFileSync(process.argv[3],m);
' supabase/migrations/NNN_a_second_question_before_a_signature.sql supabase/tests/authority/compose-decide-human-task.sql <scratchpad>/dry-compose2.sql
node scripts/db-query.mjs <scratchpad>/dry-compose2.sql
```

Expected — every row `pass`, and `c1b`'s detail showing a **non-zero** pair count:

| assertion | must be |
|---|---|
| `c1_added_check_is_allow_for_every_live_pair` | pass, `0 returned something other than allow` |
| `c1b_denominator_is_not_zero` | pass, a count **> 0** |
| `c2_deny_rule_denies` | pass |
| `c3_second_approver_reachable` | pass |
| `c4_require_human_is_satisfied_here` | pass |

If `c1` passes but `c1b` reports 0 pairs, the suite proved nothing — fix the fixture, do not accept it.

- [ ] **Step 7: Confirm the rollback left production unchanged**

```bash
node scripts/db-query.mjs --sql "select count(*) as must_be_0 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='decide_human_task' and regexp_replace(p.prosrc,'--[^\n]*','','g') ~ 'evaluate_authority'"
```

Expected: `0` — production's `decide_human_task` still does not call the evaluator.

- [ ] **Step 8: Append the run command to the tests README**

Add to `supabase/tests/authority/README.md`:

```markdown
## compose-decide-human-task.sql (step 2)

Requires migrations 768, 770, 772 and step 2's two migrations to be APPLIED.
Run as one aborting transaction:

    { echo 'begin;'; cat supabase/tests/authority/compose-decide-human-task.sql; } \
      > <scratchpad>/dry-compose.sql && node scripts/db-query.mjs <scratchpad>/dry-compose.sql

c1 is the load-bearing one: with authority_rules empty, every existing approval
answer must be unchanged. c1b exists because c1 passes vacuously on zero pairs.
```

- [ ] **Step 9: Commit, then STOP and ask before applying**

```bash
git add supabase/migrations/NNN_a_second_question_before_a_signature.sql supabase/tests/authority/compose-decide-human-task.sql supabase/tests/authority/README.md
git commit -m "feat(authority): a second question before a signature"
```

Do **not** apply. Report to the human partner; production applies are theirs.

---

## Done when

- `set_authority_rule` and the composed `decide_human_task` are committed, each dry-run clean in an aborting transaction, **neither applied**.
- The composition suite passes with a non-zero denominator on c1b.
- `has_approval_authority`, `task_approval_facts`, `resolve_de_autonomy_chain` and `require_approval_over_cents` are **untouched** — confirm with `git diff --stat`, which must show only the two new migration files and the two test files.

## Explicitly NOT in this step

- **The `measures` column and the 19 `human_tasks` writers** — step 4. This step passes `{"amount_cents": …}` built from the existing `task_approval_facts` derivation, and `{}` when there is no amount, which is the honest signal.
- **`decide_action_execution`** — step 3, same composition shape.
- **Any UI** for writing rules.
- **Re-pinning `execute-allowlist.json`** for `set_authority_rule` — a deliberate perimeter change the human partner makes after applying.
