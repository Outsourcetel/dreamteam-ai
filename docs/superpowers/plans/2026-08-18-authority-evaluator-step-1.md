# Authority Evaluator (Step 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the authority evaluator and its rules table, **inert** — nothing in production calls them — so the judgement layer can be proven in isolation before any gate is cut over to it.

**Architecture:** Three tables and one function. A typed dimension registry makes illegal rules unrepresentable (composite foreign key on `(dimension, comparator)`); a trigger refuses any rule whose dimension has no live reader; `evaluate_authority` collects applicable rules, treats a missing measure as escalation, and returns the strictest outcome plus every rule that fired.

**Tech Stack:** PostgreSQL (Supabase), plain SQL migrations. No TypeScript in this step — nothing calls the evaluator yet.

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-08-18-generalized-authority-model-design.md` and this repo's `CLAUDE.md`. Every task's requirements implicitly include these.

- **Never pick a migration number yourself.** Run `npm run migrate:next -- <slug>`. It claims the number atomically against production. `ls | tail -1` is wrong.
- **Commit the migration before applying it.** `scripts/db-query.mjs` refuses an untracked migration file.
- **Dry-run every migration in an ALWAYS-ABORTING transaction before applying.** Build it so a clean run is as loud as a failing one, and refuse to emit if a `commit;` survives.
- **Migrations use `begin;` … `commit;`** — the repo convention. The dry-run builder converts the trailing `commit;` to `rollback;`.
- **Default EXECUTE grants must be closed explicitly**: `revoke all … from public; revoke all … from anon;` then grant deliberately. (migs 610 + 630.)
- **A tenant id passed as a parameter is an assertion, not authorisation.** Verify it.
- **Probes must strip comments before matching source** — `regexp_replace(prosrc, '--[^\n]*', '', 'g')` — or they match their own prose. This bit three times on 2026-08-18.
- **Count the comparisons, not just the findings.** Zero differences from zero comparisons looks identical to a clean result.
- **Fail closed:** a rule whose dimension is absent from the supplied measures returns `require_human`, reason `unmeasured`.
- **Strictest wins:** `deny` > `require_second_approver` > `require_human` > `allow`.
- **Inert:** no existing function may call `evaluate_authority` in this step.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/NNN_a_registry_of_things_authority_can_measure.sql` | `authority_dimensions` + `authority_dimension_comparators`, seeded |
| `supabase/migrations/NNN_a_rule_that_cannot_name_an_unreadable_measure.sql` | `authority_rules` + the reader-exists trigger |
| `supabase/migrations/NNN_one_evaluator_strictest_wins_absence_escalates.sql` | `evaluate_authority` |
| `scripts/certify.mjs` (modify) | probe: exactly one evaluator; no rule names a reader-less dimension |

Migration numbers are claimed at execution time, so the filenames above carry `NNN`. Use the number `migrate:next` prints.

---

### Task 1: The dimension registry

**Files:**
- Create: `supabase/migrations/NNN_a_registry_of_things_authority_can_measure.sql`
- Test: dry-run probe block appended to that migration by the builder (no separate test file — this repo tests SQL by aborting-transaction probes)

**Interfaces:**
- Consumes: nothing
- Produces: table `public.authority_dimensions(dimension text pk, value_type text, reader_fn text null, is_active boolean)`, table `public.authority_dimension_comparators(dimension text, comparator text, primary key (dimension, comparator))`

- [ ] **Step 1: Claim the migration number**

```bash
npm run migrate:next -- a_registry_of_things_authority_can_measure
```

Use the printed filename for every step below.

- [ ] **Step 2: Write the failing probe**

Create `/tmp/probe-registry.sql` (scratchpad path is fine; it is not committed):

```sql

select
  (select count(*) from authority_dimensions)                                  as dims_must_be_5,
  (select count(*) from authority_dimensions where reader_fn is not null)      as with_reader_must_be_2,
  (select count(*) from authority_dimension_comparators)                       as comparator_pairs_must_be_9,
  (select value_type from authority_dimensions where dimension='reversible')   as reversible_type_must_be_boolean,
  (select count(*) from authority_dimension_comparators
     where dimension='reversible' and comparator='is')                         as reversible_is_allowed_must_be_1,
  (select count(*) from authority_dimension_comparators
     where dimension='reversible' and comparator='>=')                         as reversible_ge_must_be_0;
rollback;
```

- [ ] **Step 3: Run it to make sure it fails**

```bash
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[2],"begin;\n"+fs.readFileSync(process.argv[1],"utf8"))' /tmp/probe-registry.sql /tmp/dry-registry.sql
node scripts/db-query.mjs /tmp/dry-registry.sql
```

Expected: FAIL with `relation "authority_dimensions" does not exist`.

- [ ] **Step 4: Write the migration**

```sql
-- ==========================================================================
-- WHY: docs/54 item 2. A dimension that can be written into a rule but has no
-- reader is exactly max_discount_pct — configurable, enforced by asking a
-- model nicely, zero readers. The registry exists so that combination is
-- unrepresentable rather than merely discouraged.
--
-- value_type + the comparator table together make `reversible >= 5`
-- impossible to store, via a composite foreign key rather than a trigger:
-- declarative, and it cannot be forgotten by a later writer.
-- ==========================================================================

begin;

create table if not exists public.authority_dimensions (
  dimension   text primary key,
  value_type  text    not null check (value_type in ('integer','boolean')),
  -- NULL means "no reader exists yet". A rule may not name such a dimension
  -- (enforced in the next migration). Stored as a signature so it can be
  -- checked with to_regprocedure, never as a boolean somebody sets by hand —
  -- a stored marker of truth is not truth.
  reader_fn   text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.authority_dimension_comparators (
  dimension  text not null references public.authority_dimensions(dimension) on delete cascade,
  comparator text not null,
  primary key (dimension, comparator)
);

insert into public.authority_dimensions (dimension, value_type, reader_fn) values
  ('amount_cents',  'integer', 'public.decide_action_execution(uuid,text,text,boolean,uuid,bigint,text,text)'),
  ('confidence',    'integer', 'public.decide_action_execution(uuid,text,text,boolean,uuid,bigint,text,text)'),
  ('subject_count', 'integer', null),
  ('reversible',    'boolean', null),
  ('rate_per_hour', 'integer', null)
on conflict (dimension) do nothing;

insert into public.authority_dimension_comparators (dimension, comparator) values
  ('amount_cents',  '>'),  ('amount_cents',  '>='),
  ('subject_count', '>'),  ('subject_count', '>='),
  ('rate_per_hour', '>'),  ('rate_per_hour', '>='),
  ('confidence',    '<'),  ('confidence',    '<='),
  ('reversible',    'is')
on conflict do nothing;

alter table public.authority_dimensions            enable row level security;
alter table public.authority_dimension_comparators enable row level security;

-- Platform vocabulary, not tenant data: readable by any signed-in user so a
-- rule editor can offer the legal choices, writable by nobody through the API.
drop policy if exists authority_dimensions_read on public.authority_dimensions;
create policy authority_dimensions_read on public.authority_dimensions
  for select using (auth_tenant_id() is not null);
drop policy if exists authority_dimension_comparators_read on public.authority_dimension_comparators;
create policy authority_dimension_comparators_read on public.authority_dimension_comparators
  for select using (auth_tenant_id() is not null);

revoke all on table public.authority_dimensions            from public, anon;
revoke all on table public.authority_dimension_comparators from public, anon;
grant select on table public.authority_dimensions            to authenticated;
grant select on table public.authority_dimension_comparators to authenticated;

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
' supabase/migrations/NNN_a_registry_of_things_authority_can_measure.sql /tmp/probe-registry.sql /tmp/dry-registry.sql
node scripts/db-query.mjs /tmp/dry-registry.sql
```

Expected, exactly:
`dims_must_be_5: 5`, `with_reader_must_be_2: 2`, `comparator_pairs_must_be_9: 9`,
`reversible_type_must_be_boolean: boolean`, `reversible_is_allowed_must_be_1: 1`,
`reversible_ge_must_be_0: 0`.

- [ ] **Step 6: Confirm the rollback left nothing behind**

```bash
node scripts/db-query.mjs --sql "select count(*) as must_be_0 from information_schema.tables where table_schema='public' and table_name='authority_dimensions'"
```

Expected: `0`.

- [ ] **Step 7: Commit, then apply**

```bash
git add supabase/migrations/NNN_a_registry_of_things_authority_can_measure.sql
git commit -m "feat(authority): a registry of things authority can measure"
node scripts/db-query.mjs supabase/migrations/NNN_a_registry_of_things_authority_can_measure.sql
```

- [ ] **Step 8: Verify live by re-query, not by the ledger line**

```bash
node scripts/db-query.mjs --sql "select (select count(*) from authority_dimensions) as dims, (select count(*) from authority_dimension_comparators) as pairs"
```

Expected: `dims: 5`, `pairs: 9`.

---

### Task 2: Rules that cannot name an unreadable measure

**Files:**
- Create: `supabase/migrations/NNN_a_rule_that_cannot_name_an_unreadable_measure.sql`

**Interfaces:**
- Consumes: `authority_dimensions`, `authority_dimension_comparators` (Task 1)
- Produces: table `public.authority_rules(id uuid, tenant_id uuid, actor_kind text, actor_id uuid, actor_role text, category text, dimension text, comparator text, threshold numeric, outcome text, is_active boolean, created_by uuid, created_at timestamptz, updated_at timestamptz)`; trigger function `public.authority_rule_requires_a_reader()`
  - `actor_kind='role'` populates **`actor_role` (text)**, not `actor_id`. Every other non-`all` kind populates `actor_id` (uuid). Task 3's evaluator reads both.

- [ ] **Step 1: Claim the number**

```bash
npm run migrate:next -- a_rule_that_cannot_name_an_unreadable_measure
```

- [ ] **Step 2: Write the failing probe**

Create `/tmp/probe-rules.sql`:

```sql

create temp table r(c text, outcome text) on commit drop;
do $t$
declare v_t uuid; begin
  select id into v_t from tenants limit 1;

  begin
    insert into authority_rules (tenant_id, actor_kind, category, dimension, comparator, threshold, outcome)
    values (v_t, 'all', 'erp_financials', 'amount_cents', '>', 50000, 'require_human');
    insert into r values ('1 valid amount rule','ACCEPTED');
  exception when others then insert into r values ('1 valid amount rule','REJECTED: '||sqlerrm); end;

  begin
    insert into authority_rules (tenant_id, actor_kind, category, dimension, comparator, threshold, outcome)
    values (v_t, 'all', null, 'reversible', '>=', 5, 'require_human');
    insert into r values ('2 reversible >= MUST reject','ACCEPTED (BAD)');
  exception when others then insert into r values ('2 reversible >= MUST reject','rejected'); end;

  begin
    insert into authority_rules (tenant_id, actor_kind, category, dimension, comparator, threshold, outcome)
    values (v_t, 'all', null, 'subject_count', '>', 10, 'require_human');
    insert into r values ('3 reader-less dimension MUST reject','ACCEPTED (BAD)');
  exception when others then insert into r values ('3 reader-less dimension MUST reject','rejected: '||split_part(sqlerrm,':',1)); end;

  begin
    insert into authority_rules (tenant_id, actor_kind, category, dimension, comparator, threshold, outcome)
    values (v_t, 'all', null, 'not_a_dimension', '>', 1, 'require_human');
    insert into r values ('4 unknown dimension MUST reject','ACCEPTED (BAD)');
  exception when others then insert into r values ('4 unknown dimension MUST reject','rejected'); end;

  begin
    insert into authority_rules (tenant_id, actor_kind, category, dimension, comparator, threshold, outcome)
    values (v_t, 'all', null, 'amount_cents', '>', 1, 'set_on_fire');
    insert into r values ('5 unknown outcome MUST reject','ACCEPTED (BAD)');
  exception when others then insert into r values ('5 unknown outcome MUST reject','rejected'); end;
end $t$;

select jsonb_agg(jsonb_build_object('case',c,'outcome',outcome) order by c) as suite,
       (select count(*) from authority_rules) as rows_written_must_be_1 from r;
rollback;
```

- [ ] **Step 3: Run it to make sure it fails**

```bash
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[2],"begin;\n"+fs.readFileSync(process.argv[1],"utf8"))' /tmp/probe-rules.sql /tmp/dry-rules.sql
node scripts/db-query.mjs /tmp/dry-rules.sql
```

Expected: FAIL with `relation "authority_rules" does not exist`.

- [ ] **Step 4: Write the migration**

```sql
-- ==========================================================================
-- WHY: docs/54 item 2. Three classes of illegal rule are made unrepresentable
-- rather than merely validated:
--   · a comparator that does not fit the dimension's type — composite FK to
--     authority_dimension_comparators, so `reversible >= 5` cannot be stored
--   · a dimension nobody can read — the trigger below, which checks the
--     registry's reader_fn with to_regprocedure. `applied_at`-style stored
--     markers lie; asking the catalog does not.
--   · an outcome outside the ladder — a CHECK
-- ==========================================================================

begin;

create table if not exists public.authority_rules (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  -- who it binds. 'all' means everyone in the workspace.
  actor_kind  text not null check (actor_kind in ('all','role','user','org_unit','de')),
  -- ⚠ TWO columns, not one. A role is TEXT ('tenant_owner'); a user, org unit
  -- and digital employee are uuids. approval_authority already keeps them
  -- apart for this reason, and step 2's differential compares against it — a
  -- single actor_id uuid could not hold a role at all.
  actor_id    uuid,
  actor_role  text,
  -- NULL category = every category
  category    text,
  dimension   text not null,
  comparator  text not null,
  -- booleans are stored as 1/0 so one column serves both value_types
  threshold   numeric not null,
  outcome     text not null check (outcome in ('require_human','require_second_approver','deny')),
  is_active   boolean not null default true,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Exactly the right column for the kind, and nothing else. 'all' names
  -- nobody; 'role' names text; the rest name a uuid.
  constraint authority_rules_actor_shape
    check (
      (actor_kind = 'all'  and actor_id is null     and actor_role is null)
   or (actor_kind = 'role' and actor_id is null     and actor_role is not null)
   or (actor_kind in ('user','org_unit','de') and actor_id is not null and actor_role is null)
    ),
  -- The composite FK is the whole point: an illegal pairing cannot be stored.
  constraint authority_rules_dimension_comparator_fk
    foreign key (dimension, comparator)
    references public.authority_dimension_comparators (dimension, comparator)
);

create index if not exists authority_rules_lookup
  on public.authority_rules (tenant_id, is_active, category);

create or replace function public.authority_rule_requires_a_reader()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare v_reader text; v_active boolean;
begin
  select reader_fn, is_active into v_reader, v_active
    from public.authority_dimensions where dimension = new.dimension;
  if not coalesce(v_active, false) then
    raise exception 'dimension_not_active: % is not a measure this platform offers', new.dimension;
  end if;
  if v_reader is null then
    raise exception 'dimension_has_no_reader: nothing reads % yet, so a rule about it would be decoration — the reader ships before the rule becomes declarable', new.dimension;
  end if;
  -- Ask the catalog, never a stored boolean.
  if to_regprocedure(v_reader) is null then
    raise exception 'dimension_reader_missing: % names %, which does not exist', new.dimension, v_reader;
  end if;
  return new;
end
$fn$;

drop trigger if exists authority_rules_require_reader on public.authority_rules;
create trigger authority_rules_require_reader
  before insert or update on public.authority_rules
  for each row execute function public.authority_rule_requires_a_reader();

alter table public.authority_rules enable row level security;

drop policy if exists authority_rules_read on public.authority_rules;
create policy authority_rules_read on public.authority_rules
  for select using (tenant_id = public.auth_tenant_id());

-- No write policy: rules are written through an RPC that arrives with the
-- cutover in step 2. A permissive write policy plus a grant would be a second
-- path to the same state.
revoke all on table public.authority_rules from public, anon;
grant select on table public.authority_rules to authenticated;

revoke all on function public.authority_rule_requires_a_reader() from public, anon, authenticated;

commit;
```

- [ ] **Step 5: Dry-run**

```bash
node -e '
const fs=require("fs");
let m=fs.readFileSync(process.argv[1],"utf8");
m=m.replace(/^commit;\s*$/m, fs.readFileSync(process.argv[2],"utf8"));
if(/^\s*commit\s*;/mi.test(m)){console.error("REFUSED: commit survived");process.exit(1);}
fs.writeFileSync(process.argv[3],m);
' supabase/migrations/NNN_a_rule_that_cannot_name_an_unreadable_measure.sql /tmp/probe-rules.sql /tmp/dry-rules.sql
node scripts/db-query.mjs /tmp/dry-rules.sql
```

Expected: case 1 `ACCEPTED`; cases 2–5 all `rejected`; `rows_written_must_be_1: 1`.

**If every case rejects, the suite is a wall, not a test — case 1 passing is what proves the table works at all.**

- [ ] **Step 6: Confirm rollback**

```bash
node scripts/db-query.mjs --sql "select count(*) as must_be_0 from information_schema.tables where table_schema='public' and table_name='authority_rules'"
```

Expected: `0`.

- [ ] **Step 7: Commit, apply, verify**

```bash
git add supabase/migrations/NNN_a_rule_that_cannot_name_an_unreadable_measure.sql
git commit -m "feat(authority): a rule that cannot name an unreadable measure"
node scripts/db-query.mjs supabase/migrations/NNN_a_rule_that_cannot_name_an_unreadable_measure.sql
node scripts/db-query.mjs --sql "select count(*) as tbl from information_schema.tables where table_schema='public' and table_name='authority_rules'"
```

Expected: `tbl: 1`.

---

### Task 3: The evaluator

**Files:**
- Create: `supabase/migrations/NNN_one_evaluator_strictest_wins_absence_escalates.sql`

**Interfaces:**
- Consumes: `authority_rules` (Task 2), `authority_dimensions` (Task 1)
- Produces: `public.evaluate_authority(p_tenant_id uuid, p_actor_kind text, p_actor_id uuid, p_category text, p_measures jsonb) returns jsonb` — returns `{"outcome": "allow|require_human|require_second_approver|deny", "reasons": [ {"dimension","comparator","threshold","outcome","why"} ]}`

- [ ] **Step 1: Claim the number**

```bash
npm run migrate:next -- one_evaluator_strictest_wins_absence_escalates
```

- [ ] **Step 2: Write the failing probe**

Create `/tmp/probe-eval.sql`:

```sql

do $seed$
declare v_t uuid; begin
  select id into v_t from tenants limit 1;
  insert into authority_rules (tenant_id, actor_kind, category, dimension, comparator, threshold, outcome)
  values (v_t,'all','erp_financials','amount_cents','>',50000,'require_human'),
         (v_t,'all','erp_financials','confidence','<',60,'deny'),
         (v_t,'all',null,'amount_cents','>',900000,'require_second_approver');
end $seed$;

select
  -- no rules apply to this category at all -> allow (permissive default kept)
  (select r->>'outcome' from (select evaluate_authority((select id from tenants limit 1),'all',null,'nothing_matches',
     '{"amount_cents":10}'::jsonb) r) x)                                      as no_rules_must_be_allow,
  -- under every threshold -> allow
  (select r->>'outcome' from (select evaluate_authority((select id from tenants limit 1),'all',null,'erp_financials',
     '{"amount_cents":100,"confidence":95}'::jsonb) r) x)                     as under_all_must_be_allow,
  -- over the amount rule -> require_human
  (select r->>'outcome' from (select evaluate_authority((select id from tenants limit 1),'all',null,'erp_financials',
     '{"amount_cents":60000,"confidence":95}'::jsonb) r) x)                   as over_amount_must_be_require_human,
  -- STRICTEST WINS: amount says require_human, confidence says deny -> deny
  (select r->>'outcome' from (select evaluate_authority((select id from tenants limit 1),'all',null,'erp_financials',
     '{"amount_cents":60000,"confidence":10}'::jsonb) r) x)                   as strictest_must_be_deny,
  -- FAIL CLOSED: the confidence rule needs a measure that is absent
  (select r->>'outcome' from (select evaluate_authority((select id from tenants limit 1),'all',null,'erp_financials',
     '{"amount_cents":100}'::jsonb) r) x)                                     as missing_measure_must_be_require_human,
  (select r->'reasons'->0->>'why' from (select evaluate_authority((select id from tenants limit 1),'all',null,'erp_financials',
     '{"amount_cents":100}'::jsonb) r) x)                                     as missing_reason_must_say_unmeasured,
  -- an inactive rule does not fire
  (select count(*) from authority_rules)                                      as seeded_rules_must_be_3;
rollback;
```

- [ ] **Step 3: Run it to make sure it fails**

```bash
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[2],"begin;\n"+fs.readFileSync(process.argv[1],"utf8"))' /tmp/probe-eval.sql /tmp/dry-eval.sql
node scripts/db-query.mjs /tmp/dry-eval.sql
```

Expected: FAIL with `function evaluate_authority(...) does not exist`.

- [ ] **Step 4: Write the migration**

```sql
-- ==========================================================================
-- WHY: docs/54 item 2. ONE evaluator, so a person and a digital employee are
-- judged by the same function against the same measures. Two paths measuring
-- separately diverge — mig 755 had to unpick exactly that between
-- list_de_trust_surface and decide_action_execution.
--
-- ⛔ ABSENCE ESCALATES. The clause this replaces reads
--     `p_amount_cents is null or (...)`
-- which is why 115 declared money limits bind on 0.6% of approvals: a missing
-- measure was treated as permission. Here a rule whose dimension is absent
-- from p_measures returns require_human, reason 'unmeasured'.
--
-- STRICTEST WINS: deny > require_second_approver > require_human > allow. A
-- rule can only ever tighten, so a customer may add one without auditing the
-- rest — and a narrow rule can never silently cancel a broad one, which is
-- the shape that produced docs/54 item 18/9.
--
-- INERT. Nothing calls this yet; the cutover is step 2 of the spec.
-- ==========================================================================

begin;

create or replace function public.evaluate_authority(
  p_tenant_id  uuid,
  p_actor_kind text,
  p_actor_id   uuid,
  p_category   text,
  p_measures   jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare
  r            record;
  v_rank       int;
  v_worst      int := 0;                  -- 0 allow, 1 human, 2 second, 3 deny
  v_reasons    jsonb := '[]'::jsonb;
  v_measures   jsonb := coalesce(p_measures, '{}'::jsonb);
  v_val        numeric;
  v_present    boolean;
  v_trips      boolean;
begin
  if p_tenant_id is null then
    return jsonb_build_object('outcome','require_human',
      'reasons', jsonb_build_array(jsonb_build_object('why','no workspace in context')));
  end if;

  for r in
    select ar.dimension, ar.comparator, ar.threshold, ar.outcome, ad.value_type
      from authority_rules ar
      join authority_dimensions ad on ad.dimension = ar.dimension
     where ar.tenant_id = p_tenant_id
       and ar.is_active
       and (ar.category is null or ar.category = p_category)
       and (
         ar.actor_kind = 'all'
         or (ar.actor_kind = p_actor_kind and ar.actor_id = p_actor_id)
         -- ⚠ A PERSON IS ALSO REACHED BY THEIR ROLE AND THEIR ORG UNIT, and
         -- by any unit ABOVE the one they belong to. This mirrors
         -- has_approval_authority exactly, because step 2 proves the cutover
         -- with a differential against it — an evaluator that only matched
         -- exact actor ids would fail that differential on every role-scoped
         -- and unit-scoped row, which is 151 rows today.
         or (p_actor_kind = 'user' and ar.actor_kind = 'role' and exists (
               select 1 from profiles pr
                where pr.user_id = p_actor_id and pr.tenant_id = p_tenant_id
                  and coalesce(pr.is_active, true)
                  and pr.role = ar.actor_role))
         or (p_actor_kind = 'user' and ar.actor_kind = 'org_unit' and exists (
               with recursive below as (
                 select ar.actor_id as id
                 union
                 select u.id from org_units u join below b on u.parent_id = b.id where u.is_active
               )
               select 1 from org_unit_members m
                where m.user_id = p_actor_id and m.is_active
                  and m.org_unit_id in (select id from below)))
       )
  loop
    v_present := v_measures ? r.dimension;

    if not v_present then
      -- ⛔ absence escalates. Never `or` past it.
      v_rank := 1;
      v_reasons := v_reasons || jsonb_build_object(
        'dimension', r.dimension, 'comparator', r.comparator, 'threshold', r.threshold,
        'outcome', 'require_human',
        'why', format('unmeasured: this action did not report %s, and a rule depends on it', r.dimension));
    else
      if r.value_type = 'boolean' then
        v_val := case when coalesce((v_measures->>r.dimension)::boolean, false) then 1 else 0 end;
      else
        v_val := (v_measures->>r.dimension)::numeric;
      end if;

      v_trips := case r.comparator
        when '>'  then v_val >  r.threshold
        when '>=' then v_val >= r.threshold
        when '<'  then v_val <  r.threshold
        when '<=' then v_val <= r.threshold
        when 'is' then v_val =  r.threshold
        else false
      end;

      if not v_trips then continue; end if;

      v_rank := case r.outcome
        when 'deny' then 3 when 'require_second_approver' then 2 else 1 end;
      v_reasons := v_reasons || jsonb_build_object(
        'dimension', r.dimension, 'comparator', r.comparator, 'threshold', r.threshold,
        'outcome', r.outcome,
        'why', format('%s %s %s', r.dimension, r.comparator, r.threshold));
    end if;

    if v_rank > v_worst then v_worst := v_rank; end if;
  end loop;

  return jsonb_build_object(
    'outcome', case v_worst when 3 then 'deny' when 2 then 'require_second_approver'
                            when 1 then 'require_human' else 'allow' end,
    'reasons', v_reasons);
end
$fn$;

-- Internal judgement. The gates call it in step 2; nothing on the browser
-- perimeter ever does. Default EXECUTE (migs 610 + 630) closed explicitly.
revoke all on function public.evaluate_authority(uuid, text, uuid, text, jsonb) from public;
revoke all on function public.evaluate_authority(uuid, text, uuid, text, jsonb) from anon;
revoke all on function public.evaluate_authority(uuid, text, uuid, text, jsonb) from authenticated;
grant execute on function public.evaluate_authority(uuid, text, uuid, text, jsonb) to service_role;

commit;
```

- [ ] **Step 5: Dry-run**

```bash
node -e '
const fs=require("fs");
let m=fs.readFileSync(process.argv[1],"utf8");
m=m.replace(/^commit;\s*$/m, fs.readFileSync(process.argv[2],"utf8"));
if(/^\s*commit\s*;/mi.test(m)){console.error("REFUSED: commit survived");process.exit(1);}
fs.writeFileSync(process.argv[3],m);
' supabase/migrations/NNN_one_evaluator_strictest_wins_absence_escalates.sql /tmp/probe-eval.sql /tmp/dry-eval.sql
node scripts/db-query.mjs /tmp/dry-eval.sql
```

Expected, exactly:

| probe | value |
|---|---|
| `no_rules_must_be_allow` | `allow` |
| `under_all_must_be_allow` | `allow` |
| `over_amount_must_be_require_human` | `require_human` |
| `strictest_must_be_deny` | `deny` |
| `missing_measure_must_be_require_human` | `require_human` |
| `missing_reason_must_say_unmeasured` | starts `unmeasured:` |
| `seeded_rules_must_be_3` | `3` |

The two `allow` rows matter as much as the blocks: an evaluator that only ever escalates is a wall, not a gate.

- [ ] **Step 6: Confirm rollback**

```bash
node scripts/db-query.mjs --sql "select count(*) as must_be_0 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='evaluate_authority'"
```

Expected: `0`.

- [ ] **Step 7: Commit, apply, verify**

```bash
git add supabase/migrations/NNN_one_evaluator_strictest_wins_absence_escalates.sql
git commit -m "feat(authority): one evaluator — strictest wins, absence escalates"
node scripts/db-query.mjs supabase/migrations/NNN_one_evaluator_strictest_wins_absence_escalates.sql
node scripts/db-query.mjs --sql "select (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='evaluate_authority') as fn, has_function_privilege('authenticated','public.evaluate_authority(uuid,text,uuid,text,jsonb)','EXECUTE') as authed_must_be_false"
```

Expected: `fn: 1`, `authed_must_be_false: false`.

---

### Task 4: The certify probe

**Files:**
- Modify: `scripts/certify.mjs` — add one entry to the `PROBES` array (the array beginning at the `landed-reads-use-the-shared-predicate` entry, around line 240)

**Interfaces:**
- Consumes: `evaluate_authority` (Task 3), `authority_rules` (Task 2), `authority_dimensions` (Task 1)
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Add the probe**

Insert into the `PROBES` array in `scripts/certify.mjs`:

```js
  {
    name: 'authority-has-one-evaluator-and-no-decorative-dimension',
    why: 'two paths measuring separately diverge — mig 755 had to unpick exactly that between list_de_trust_surface and decide_action_execution. And a dimension that can be written into a rule with nothing reading it is max_discount_pct again: configurable, zero readers, enforced by asking a model nicely. Both arms report their denominator, because zero findings from zero comparisons looks exactly like a clean result',
    sql: `
      with evaluators as (
        select p.proname
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and regexp_replace(p.prosrc, '--[^\\n]*', '', 'g') ~ 'strictest|v_worst'
           and p.proname <> 'evaluate_authority'
      ),
      readerless as (
        select distinct ar.dimension
          from authority_rules ar
          join authority_dimensions ad on ad.dimension = ar.dimension
         where ar.is_active
           and (ad.reader_fn is null or to_regprocedure(ad.reader_fn) is null)
      )
      select 'a SECOND authority evaluator exists: ' || proname as violation, null::text as note
        from evaluators
      union all
      select 'an active rule names a dimension nothing reads: ' || dimension, null
        from readerless
      union all
      select null, format('compared %s rules across %s dimensions against %s registered readers',
                          (select count(*) from authority_rules where is_active),
                          (select count(distinct dimension) from authority_rules where is_active),
                          (select count(*) from authority_dimensions where reader_fn is not null))
    `,
  },
```

- [ ] **Step 2: Run certify's probe section and confirm it passes**

```bash
node scripts/certify.mjs --fast
```

Expected: the probe reports its note (`compared 0 rules across 0 dimensions against 2 registered readers`) and raises no violation.

- [ ] **Step 3: Prove the probe can fail**

Run this to create a second evaluator inside an aborting transaction and confirm the probe's first arm fires:

```bash
node scripts/db-query.mjs --sql "
begin;
create or replace function public.fake_second_evaluator() returns int language plpgsql as \$\$
declare v_worst int := 0; begin return v_worst; end \$\$;
select count(*) as second_evaluators_must_be_1
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public'
   and regexp_replace(p.prosrc,'--[^\n]*','','g') ~ 'strictest|v_worst'
   and p.proname <> 'evaluate_authority';
rollback;"
```

Expected: `second_evaluators_must_be_1: 1` — the probe's detection query finds it. **A probe never shown to fire has not been tested.**

- [ ] **Step 4: Commit**

```bash
git add scripts/certify.mjs
git commit -m "test(certify): authority has one evaluator and no decorative dimension"
```

---

## Done when

- `authority_dimensions` (5 rows), `authority_dimension_comparators` (9 rows), `authority_rules` and `evaluate_authority` are live on production and verified by re-query.
- `evaluate_authority` is executable by `service_role` only.
- **Nothing calls it.** Confirm: `node scripts/db-query.mjs --sql "select count(*) as callers_must_be_0 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname <> 'evaluate_authority' and regexp_replace(p.prosrc,'--[^\n]*','','g') ~ 'evaluate_authority'"` → `0`.
- The certify probe passes and has been shown capable of firing.

## Explicitly NOT in this step

- Any change to `decide_human_task` or `decide_action_execution` — that is step 2.
- The rule-writing RPC and any UI — they arrive with the cutover, so no browser surface is added here and the pinned EXECUTE allowlist does not move.
- Translating the 151 `approval_authority` rows — step 2, behind a differential.
- `subject_count`, `reversible` and `rate_per_hour` readers — step 4. They are registered with `reader_fn = null` on purpose, and the Task 2 trigger refuses rules about them until a reader exists.
