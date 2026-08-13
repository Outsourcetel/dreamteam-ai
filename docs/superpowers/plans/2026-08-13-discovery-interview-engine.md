# Discovery Interview — Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the machine that covers a fixed spine of business dimensions through a plain-English conversation, and prove it cannot be talked past.

**Architecture:** A seeded `discovery_dimensions` spine decides *what* must be covered; a `discovery-interview` edge function decides *how*, extracting structure from each answer and choosing the next question. Coverage is tracked per dimension in four states, so gaps are output rather than omissions. Proposals are recorded but not created — creation is Plan 3b.

**Tech Stack:** Postgres (Supabase), Deno edge functions, TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-12-discovery-interview-design.md` — read §12 START HERE first, then §3 (spine), §4 (architecture), §7 (park/failure), §9 (verification).

## Scope: §11 steps 3–4 only

This plan builds **the spine and the engine**. It deliberately stops before the surfaces.

- ✅ here: `discovery_dimensions` + seed · `discovery_sessions` + coverage ledger · `discovery_proposals` (written, not acted on) · the `discovery-interview` edge function · the sidetrack test · certify coverage.
- ❌ **Plan 3b** (§11 steps 5–6): the interview UI, the proposal screen with accept/decline/park controls, phase two, and creation through the validated writers.
- ❌ **Plan 4** (§11 step 7): retiring `CompanySetupPage`, `OnboardingArchitectPage`, `onboarding-assist`, Ada, `proposeTailoredSetup`.

Why stop here: the engine is the risky part and it is fully testable without a UI — the sidetrack test drives it through fixture transcripts. Shipping it proven, before anything renders, means the surfaces are built on something that already works.

## Controller assumptions — overrule any of these and the plan adjusts

These were asked and not answered; each is the safe default and none is hard to reverse.

1. **Spine guidance is DERIVED from the 93 existing `setup_questions`**, not invented. All 15 archetypes carry 4–8 well-authored questions with `question`, `help` (real examples) and `kind`. `billing_ar` already asks *"What credits or adjustments can be made without approval, and who approves above that?"* — that is dimension 10 in the product's own voice.
2. **The interview is NOT wired to first login in this plan.** No route change at all here; the engine is reached by test and by direct invocation. Plan 3b adds a route; Plan 4 flips the entry point.
3. **Nothing is proven against a real signup.** Any live drive uses a throwaway tenant, and creating one is a state-changing action to confirm with the founder at the time — not assumed by this plan.

## Global Constraints

- **Never pick a migration number.** Claim it only with `npm run migrate:next -- <slug>`. Commit before applying.
- **Every function gets EXECUTE revoked from `public`, `anon`, `authenticated`, granted explicitly, and asserted with `has_function_privilege` in BOTH directions.** Use the full signature form (`'public.fn(uuid)'`) — an unresolvable name ERRORs 42883 rather than returning false.
- **Every migration ends with a `do $$` block that RAISES.** ⚠ This repo has hit the check-that-cannot-fail trap **five times in three days**: a FK refusing before a CHECK, a NOT NULL refusing before a CHECK, a synchronous `ALTER … ADD CHECK` making a later count dead code, a probe using a precondition as a guard, and a test window too short to read what it asserted. **Make sure the thing you assert is the thing that would actually refuse you**, and if a block cannot fail, say so and fix it rather than shipping theatre.
- **The pairing rule.** Every check proved by the pair — it fires AND it does not fire. Report the count of comparisons, not only the findings.
- **⚠ The Workspace Assistant and its chatbot are untouched.** Nothing may read or write a `digital_employees` row with `is_workforce_assistant = true`.
- **Tests are read-only against production** via `tests/helpers/adminQuery.ts`. Never write from a test.
- **Nothing in this plan creates a digital employee, playbook, guardrail or connector.** Proposals are rows in `discovery_proposals`. Creation is Plan 3b, through the ordinary validated writers.
- Migration prose headers match the house voice — read `supabase/migrations/730_*.sql` first.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/<n>_a_spine_of_things_worth_asking.sql` (create) | `discovery_dimensions` + the 12 seeded rows |
| `supabase/migrations/<n>_an_interview_that_remembers_what_it_missed.sql` (create) | `discovery_sessions`, `discovery_proposals`, the coverage RPCs |
| `supabase/functions/discovery-interview/index.ts` (create) | the turn loop: extract → mark → choose next |
| `tests/discovery-spine.test.ts` (create) | spine shape, capability-gap derivation, coverage state machine |
| `tests/discovery-sidetrack.test.ts` (create) | **the test this plan exists to pass** |
| `scripts/certify.mjs` (modify) | a `discovery-spine` section |

---

## Task 1: A spine of things worth asking

**Files:**
- Create: `supabase/migrations/<claimed>_a_spine_of_things_worth_asking.sql`
- Test: `tests/discovery-spine.test.ts`

**Interfaces:**
- Consumes: `public.role_archetypes(key, setup_questions jsonb, required_connector_categories text[])` — 15 rows, existing.
- Produces: `public.discovery_dimensions(key text PK, ordinal int, title text, guidance text, serves_archetypes text[], produces text[], required boolean, active boolean)` and a view `public.discovery_capability_gaps(dimension_key, title, serves_archetypes)` listing dimensions whose archetypes are all absent.

- [ ] **Step 1: Read the raw material before writing any guidance**

```bash
node scripts/db-query.mjs --sql "select key, jsonb_pretty(setup_questions) from public.role_archetypes order by key;"
```

Read all 15. You are deriving twelve pieces of guidance from ~93 authored questions, not inventing them. The `help` fields carry real examples (`'e.g. Zuora, Stripe, NetSuite, QuickBooks'`) — that concreteness is what makes guidance usable, so carry it through rather than abstracting it away.

- [ ] **Step 2: Write the failing test**

Create `tests/discovery-spine.test.ts`:

```typescript
// ============================================================
// THE SPINE — public.discovery_dimensions
//
// A fixed list of what must be KNOWN about a business, so a short interview
// can still be a complete one. The founder's requirement, verbatim: "I don't
// want to lose the depth of the interview or getting side tracked because
// customer got focused on one thing and forgot other critical pieces."
//
// The spine is DATA, not code, so that adding procurement later is an INSERT
// plus an archetype rather than a redeploy of the interview.
//
// Read-only: runQuery() refuses anything that is not a lone SELECT/WITH.
// ============================================================
import { describe, it, expect } from 'vitest';
import { runQuery, adminTokenAvailable } from './helpers/adminQuery';

const run = adminTokenAvailable() ? describe : describe.skip;

const EXPECTED = [
  'what_we_do', 'how_customers_reach_us', 'money_in', 'money_out',
  'winning_business', 'after_the_sale', 'repetitive_work', 'systems_of_record',
  'must_never_happen', 'who_signs_off', 'who_is_who', 'what_good_looks_like',
];

run('the spine', () => {
  it('carries exactly the twelve dimensions, in order', async () => {
    const rows = await runQuery<{ key: string; ordinal: number }>(
      'select key, ordinal from public.discovery_dimensions where active order by ordinal');
    expect(rows.map((r) => r.key)).toEqual(EXPECTED);
    expect(rows.map((r) => r.ordinal)).toEqual(rows.map((_, i) => i + 1));
  });

  it('gives every dimension guidance a model could act on', async () => {
    const thin = await runQuery<{ key: string; n: number }>(
      "select key, length(guidance) as n from public.discovery_dimensions where active and length(coalesce(guidance,'')) < 120");
    expect(thin.map((r) => r.key), 'dimensions with guidance too thin to be useful').toEqual([]);
  });

  it('names, for each dimension, what it produces', async () => {
    const empty = await runQuery<{ key: string }>(
      "select key from public.discovery_dimensions where active and coalesce(array_length(produces,1),0) = 0");
    expect(empty.map((r) => r.key), 'dimensions that produce nothing are questions asked out of curiosity').toEqual([]);
  });

  it('only claims archetypes that actually exist', async () => {
    // A dimension pointing at a role key that is not in role_archetypes would
    // silently never staff, and would never be reported as a gap either.
    const bad = await runQuery<{ dimension_key: string; missing: string }>(`
      select d.key as dimension_key, a as missing
        from public.discovery_dimensions d
        cross join lateral unnest(d.serves_archetypes) a
       where d.active and not exists (select 1 from public.role_archetypes r where r.key = a)`);
    expect(bad, 'dimensions referencing non-existent archetypes').toEqual([]);
  });

  it('derives capability gaps rather than hand-maintaining them', async () => {
    // Today procurement, legal and QA have no archetype. The view must say so
    // WITHOUT anyone writing that fact down, or it goes stale the day one ships.
    const gaps = await runQuery<{ dimension_key: string }>(
      'select dimension_key from public.discovery_capability_gaps');
    // Dimensions with no serves_archetypes at all are not gaps — they produce
    // config, not roles. A gap is: names archetypes, none of which exist.
    const named = await runQuery<{ n: number }>(
      "select count(*)::int as n from public.discovery_dimensions where active and coalesce(array_length(serves_archetypes,1),0) > 0");
    expect(named[0].n).toBeGreaterThan(0);
    console.log(`capability gaps today: ${gaps.map((g) => g.dimension_key).join(', ') || '(none)'}`);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails for the right reason**

Run: `npx vitest run tests/discovery-spine.test.ts`
Expected: FAIL with `relation "public.discovery_dimensions" does not exist`. If it fails because `adminTokenAvailable()` is false, stop — a skipped suite is not a passing one.

- [ ] **Step 4: Claim the number and write the migration**

Run: `npm run migrate:next -- a_spine_of_things_worth_asking`

```sql
create table if not exists public.discovery_dimensions (
  key               text primary key,
  ordinal           int  not null,
  title             text not null,
  guidance          text not null,
  serves_archetypes text[] not null default '{}',
  produces          text[] not null default '{}',
  required          boolean not null default true,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  constraint discovery_dimensions_ordinal_unique unique (ordinal)
);

alter table public.discovery_dimensions enable row level security;
drop policy if exists discovery_dimensions_read on public.discovery_dimensions;
create policy discovery_dimensions_read on public.discovery_dimensions
  for select to authenticated using (true);

revoke all on public.discovery_dimensions from public, anon;
revoke insert, update, delete on public.discovery_dimensions from authenticated;
grant select on public.discovery_dimensions to authenticated, service_role;
grant insert, update, delete on public.discovery_dimensions to service_role;
```

Then the 12 seeded rows, guidance derived from Step 1. Here is dimension 3 fully worked, so the shape and the *level* of the guidance are unambiguous — the other eleven follow this pattern:

```sql
insert into public.discovery_dimensions
  (key, ordinal, title, guidance, serves_archetypes, produces) values
('money_in', 3, 'How money comes in',
 'Find out how this business actually gets paid, end to end: what it bills for, on what '
 || 'cadence, and through which system. Concrete beats abstract — "we invoice monthly out of '
 || 'Xero, net 30" is covered; "we have customers" is not. Cover what happens when an invoice '
 || 'goes unpaid, and who chases it today. If they mention subscriptions or renewals, that '
 || 'counts here too. Mark heard only when you could tell a colleague how the money arrives.',
 array['billing_ar','accounting','renewal_manager'],
 array['billing_ar role','collections role','overdue-invoice procedure','billing connector']),
```

`serves_archetypes` maps a dimension to the archetype keys that serve it — verify each against `role_archetypes` as you write it, because Step 5 will refuse an orphan. Four dimensions produce **configuration rather than roles** and take `'{}'`: `must_never_happen`, `who_signs_off`, `who_is_who`, `what_good_looks_like`. That empty array is meaningful — it is what stops them being reported as capability gaps.

⚠ Guidance must say **what "covered" means for this dimension**, not merely name the topic. The test refuses anything under 120 characters precisely to stop a one-line restatement of the title.

The gap view, derived not stored:

```sql
create or replace view public.discovery_capability_gaps as
  select d.key as dimension_key, d.title, d.serves_archetypes
    from public.discovery_dimensions d
   where d.active
     and coalesce(array_length(d.serves_archetypes, 1), 0) > 0
     and not exists (
       select 1 from public.role_archetypes r
        where r.key = any(d.serves_archetypes));

revoke all on public.discovery_capability_gaps from public, anon;
grant select on public.discovery_capability_gaps to authenticated, service_role;
```

- [ ] **Step 5: A verification block that can actually fail**

```sql
do $$
declare v_n int; v_thin int; v_orphan int;
begin
  select count(*) into v_n from public.discovery_dimensions where active;
  if v_n <> 12 then raise exception '<n>: expected 12 active dimensions, found %', v_n; end if;

  select count(*) into v_thin from public.discovery_dimensions
   where active and length(coalesce(guidance,'')) < 120;
  if v_thin > 0 then raise exception '<n>: % dimension(s) have guidance too thin to act on', v_thin; end if;

  -- An archetype key that does not exist would never staff AND never be
  -- reported as a gap — the worst of both. Catch it at apply time.
  select count(*) into v_orphan
    from public.discovery_dimensions d
    cross join lateral unnest(d.serves_archetypes) a
   where d.active and not exists (select 1 from public.role_archetypes r where r.key = a);
  if v_orphan > 0 then raise exception '<n>: % dimension→archetype reference(s) point at nothing', v_orphan; end if;

  -- Prove the gap view DERIVES rather than reporting a stored fact. Both
  -- directions, because a view that reports everything and a view that reports
  -- nothing both pass a one-sided check.
  --
  -- The probe inserts, measures into variables, then unconditionally raises a
  -- sentinel to undo the insert. Verdicts are read from the variables AFTER
  -- the block, never from inside it — that keeps the control flow readable and
  -- means a genuine error still propagates rather than being swallowed by a
  -- handler trying to be clever.
  declare v_seen boolean := null; v_real boolean := null;
  begin
    begin
      insert into public.discovery_dimensions (key, ordinal, title, guidance, serves_archetypes, produces)
      values ('__probe_gap',  9998, 'probe', repeat('x', 130), array['__no_such_archetype'], array['nothing']),
             ('__probe_real', 9999, 'probe', repeat('x', 130), array['support_agent'],       array['nothing']);

      select exists (select 1 from public.discovery_capability_gaps where dimension_key = '__probe_gap')  into v_seen;
      select exists (select 1 from public.discovery_capability_gaps where dimension_key = '__probe_real') into v_real;

      raise exception using errcode = 'P0001', message = '__undo_probe__';
    exception
      when sqlstate 'P0001' then
        if sqlerrm <> '__undo_probe__' then raise; end if;   -- a real P0001 still propagates
    end;

    if v_seen is not true then
      raise exception '<n>: the gap view did NOT report a dimension whose archetypes do not exist';
    end if;
    if v_real is not false then
      raise exception '<n>: the gap view reported a dimension whose archetype DOES exist — it is not deriving, it is matching everything';
    end if;
  end;
end $$;
```

⚠ Note the probe deliberately raises to undo itself. Confirm afterwards that no `__probe_gap` row survives — if one does, the exception handling is wrong.

- [ ] **Step 6: Commit, apply, re-run the test**

```bash
git add supabase/migrations/*_a_spine_of_things_worth_asking.sql tests/discovery-spine.test.ts
git commit -m "feat(discovery): a spine of things worth asking"
node scripts/db-query.mjs supabase/migrations/<n>_a_spine_of_things_worth_asking.sql
node scripts/db-query.mjs --sql "select count(*) as leftover from public.discovery_dimensions where key like '__probe%';"
npx vitest run tests/discovery-spine.test.ts
```

Expected: migration recorded, `leftover: 0`, 5 tests passing, and the console line naming today's capability gaps.

---

## Task 2: An interview that remembers what it missed

**Files:**
- Create: `supabase/migrations/<claimed>_an_interview_that_remembers_what_it_missed.sql`
- Test: `tests/discovery-spine.test.ts` (append)

**Interfaces:**
- Consumes: `public.discovery_dimensions` (Task 1), `public.tenants`.
- Produces:
  - `public.discovery_sessions(id uuid PK, tenant_id uuid, status text, coverage jsonb, transcript jsonb, created_by uuid, created_at, updated_at)`
  - `public.discovery_proposals(id uuid PK, session_id uuid, tenant_id uuid, kind text, payload jsonb, rationale text, source_dimension text, state text, decided_by uuid, decided_at, created_object_id uuid)`
  - `public.start_discovery_session(p_tenant_id uuid) returns uuid` — service_role only.
  - `public.record_dimension_state(p_session_id uuid, p_dimension text, p_state text, p_evidence text) returns void` — service_role only.

- [ ] **Step 1: Write the failing test — park and skip must be different**

Append to `tests/discovery-spine.test.ts`:

```typescript
run('the coverage ledger', () => {
  it('accepts exactly the four states, and no others', async () => {
    const [{ def }] = await runQuery<{ def: string }>(`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'public.discovery_sessions'::regclass
         and conname = 'discovery_sessions_coverage_states'`);
    for (const s of ['heard', 'parked', 'skipped', 'not_heard']) expect(def).toContain(s);
  });

  it('treats parked and skipped as different things', async () => {
    // This is the whole point. Collapsing them either nags people who declined
    // or bins what they meant to return to. The DB must distinguish them
    // before any UI can.
    const [{ def }] = await runQuery<{ def: string }>(`
      select pg_get_functiondef(p.oid) as def from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'record_dimension_state'`);
    expect(def).toContain('parked');
    expect(def).toContain('skipped');
    expect(def).not.toMatch(/parked['"\s]*[,|]?\s*['"]?\s*=\s*['"]?skipped/i);
  });

  it('starts a session with every dimension not_heard, not absent', async () => {
    // A missing key and an unaddressed dimension are indistinguishable to a
    // reader. The ledger must be complete from the first turn.
    const [{ def }] = await runQuery<{ def: string }>(`
      select pg_get_functiondef(p.oid) as def from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'start_discovery_session'`);
    expect(def).toContain('not_heard');
    expect(def).toContain('discovery_dimensions');
  });

  it('keeps proposals out of the human task queue', async () => {
    // Ada's proposals went into action_executions, the same queue as
    // operational approvals, and 19 of 26 are still undecided. Setup approval
    // belongs in the setup flow.
    const rows = await runQuery<{ n: number }>(`
      select count(*)::int as n from information_schema.columns
       where table_schema='public' and table_name='discovery_proposals'
         and column_name in ('human_task_id','action_execution_id')`);
    expect(rows[0].n, 'proposals must not be coupled to the ops queue').toBe(0);
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `npx vitest run tests/discovery-spine.test.ts -t "coverage ledger"`
Expected: FAIL — `discovery_sessions` does not exist.

- [ ] **Step 3: Claim the number and write the migration**

Run: `npm run migrate:next -- an_interview_that_remembers_what_it_missed`

Key shapes:

```sql
create table if not exists public.discovery_sessions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id),
  status      text not null default 'running'
              check (status in ('running','proposed','accepted','parked','abandoned')),
  coverage    jsonb not null default '{}'::jsonb,
  transcript  jsonb not null default '[]'::jsonb,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint discovery_sessions_coverage_states check (
    not exists (
      select 1 from jsonb_each(coverage) e
       where e.value->>'state' not in ('heard','parked','skipped','not_heard'))
  )
);

create table if not exists public.discovery_proposals (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid not null references public.discovery_sessions(id) on delete cascade,
  tenant_id         uuid not null references public.tenants(id),
  kind              text not null check (kind in
                      ('employee','procedure','connector','guardrail','trust_rule','conversation_type')),
  payload           jsonb not null,
  rationale         text,
  source_dimension  text references public.discovery_dimensions(key),
  state             text not null default 'pending'
                    check (state in ('pending','accepted','declined','parked')),
  decided_by        uuid,
  decided_at        timestamptz,
  created_object_id uuid,
  created_at        timestamptz not null default now()
);
```

RLS tenant-scoped on both; `authenticated` may SELECT its own tenant's rows and nothing else; all writes `service_role`. `start_discovery_session` seeds `coverage` from `discovery_dimensions` so every key is present as `not_heard` from the first turn. `record_dimension_state` validates the state against the same four values and refuses an unknown dimension key.

- [ ] **Step 4: Verification block**

Assert: the four states are accepted and a fifth is refused (insert-and-catch with a real tenant, catching ONLY `check_violation`); `start_discovery_session` produces a coverage map whose key count equals the active dimension count; both tables refuse `authenticated` writes; and `has_function_privilege` in both directions for both new functions. Run the probe inside a block that raises to undo itself, and verify no probe rows survive.

- [ ] **Step 5: Commit, apply, verify**

```bash
git add supabase/migrations/*_an_interview_that_remembers_what_it_missed.sql tests/discovery-spine.test.ts
git commit -m "feat(discovery): an interview that remembers what it missed"
node scripts/db-query.mjs supabase/migrations/<n>_an_interview_that_remembers_what_it_missed.sql
node scripts/db-query.mjs --sql "select count(*) as leftover from public.discovery_sessions;"
npx vitest run tests/discovery-spine.test.ts
```

Expected: 9 tests passing; `leftover: 0` (no probe session survived).

---

## Task 3: The engine, and the test it exists to pass

**Files:**
- Create: `supabase/functions/discovery-interview/index.ts`
- Create: `tests/discovery-sidetrack.test.ts`

**Interfaces:**
- Consumes: `discovery_dimensions`, `discovery_sessions`, `start_discovery_session`, `record_dimension_state`, `_shared/llm.ts` (the pattern `entity-draft` uses — read it first; it defaults to `claude-sonnet-5`).
- Produces: `POST /discovery-interview` accepting `{ action: 'start', tenant_id }` → `{ session_id, question }`, and `{ action: 'answer', session_id, text }` → `{ question | null, coverage, done }`. An exported pure function `coverageAfter(dimensions, transcript, extraction)` so the spine logic is testable without invoking a model.

- [ ] **Step 1: Read the existing patterns before writing**

Read `supabase/functions/entity-draft/index.ts` (how it calls the model and shapes output), `supabase/functions/compile-trust-plan/index.ts` (**the best-built precedent** — it validates against a live validator with one reject-and-retry and returns an honest `unmapped` rather than a plausible draft), and `supabase/functions/_shared/llm.ts`.

- [ ] **Step 2: Write THE test — the one this plan exists to pass**

Create `tests/discovery-sidetrack.test.ts`:

```typescript
// ============================================================
// THE SIDETRACK TEST
//
// The founder's requirement, verbatim: "I don't want to lose the depth of the
// interview or getting side tracked because customer got focused on one thing
// and forgot other critical pieces."
//
// A customer who talks about nothing but support tickets must still finish with
// money-in, must-never-happen and who-signs-off marked not_heard, and those
// gaps must be reported. IF THIS TEST CANNOT FAIL, THIS FEATURE DOES NOT WORK.
//
// It drives the PURE coverage function with fixture extractions, so it proves
// the spine logic without spending a model call or depending on model mood.
// ============================================================
import { describe, it, expect } from 'vitest';
import { coverageAfter } from '../supabase/functions/discovery-interview/index.ts';

const DIMS = [
  'what_we_do', 'how_customers_reach_us', 'money_in', 'money_out',
  'winning_business', 'after_the_sale', 'repetitive_work', 'systems_of_record',
  'must_never_happen', 'who_signs_off', 'who_is_who', 'what_good_looks_like',
].map((key, i) => ({ key, ordinal: i + 1, required: true }));

describe('the sidetrack test', () => {
  it('reports what a support-obsessed conversation never covered', () => {
    const cov = coverageAfter(DIMS, [], [
      { dimension: 'what_we_do', state: 'heard', evidence: 'we make scheduling software' },
      { dimension: 'how_customers_reach_us', state: 'heard', evidence: 'email and a chat widget' },
      { dimension: 'repetitive_work', state: 'heard', evidence: 'password resets, endlessly' },
    ]);
    for (const k of ['money_in', 'must_never_happen', 'who_signs_off']) {
      expect(cov[k].state, `${k} must remain not_heard`).toBe('not_heard');
    }
  });

  it('never drops a dimension from the ledger', () => {
    // A missing key reads identically to an unaddressed one.
    const cov = coverageAfter(DIMS, [], [{ dimension: 'money_in', state: 'heard', evidence: 'x' }]);
    expect(Object.keys(cov).sort()).toEqual(DIMS.map((d) => d.key).sort());
  });

  it('brings a parked dimension back, and leaves a skipped one alone', () => {
    const cov = coverageAfter(DIMS, [], [
      { dimension: 'money_out', state: 'parked', evidence: 'ask me later' },
      { dimension: 'winning_business', state: 'skipped', evidence: 'we do not sell' },
    ]);
    expect(cov.money_out.state).toBe('parked');
    expect(cov.winning_business.state).toBe('skipped');
    // The behavioural difference: only parked is still owed a question.
    const owed = Object.entries(cov).filter(([, v]) => v.state === 'not_heard' || v.state === 'parked');
    expect(owed.map(([k]) => k)).toContain('money_out');
    expect(owed.map(([k]) => k)).not.toContain('winning_business');
  });

  it('refuses an extraction naming a dimension that does not exist', () => {
    // The model returns free-form JSON. A typo must not silently create a
    // thirteenth dimension nobody asked for.
    expect(() => coverageAfter(DIMS, [], [
      { dimension: 'moneyin', state: 'heard', evidence: 'typo' },
    ])).toThrow(/unknown dimension/i);
  });

  it('counts what it compared', () => {
    const cov = coverageAfter(DIMS, [], []);
    expect(Object.keys(cov)).toHaveLength(12);
    console.log(`sidetrack fixtures compared against ${DIMS.length} dimensions`);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `npx vitest run tests/discovery-sidetrack.test.ts`
Expected: FAIL — the module does not exist. **Do not proceed until you have seen this fail for that reason**, because a test that never failed proves nothing.

- [ ] **Step 4: Implement `coverageAfter` first, alone**

Write only the pure function and make the five tests pass. It takes the dimension list, the prior coverage, and the extraction array; returns a complete coverage map. It must throw on an unknown dimension key rather than tolerate it, and must never omit a key.

- [ ] **Step 5: Run and confirm all five pass**

Run: `npx vitest run tests/discovery-sidetrack.test.ts`
Expected: 5 passing, plus the comparison-count line.

- [ ] **Step 6: Build the turn loop around it**

The edge function: `start` creates a session via `start_discovery_session` and asks an opening question; `answer` sends the transcript plus the still-owed dimensions to the model, gets back `{ extraction[], next_question, done }`, passes the extraction through `coverageAfter` (which is the gate — the model proposes, the function disposes, exactly as `de-mission`'s `validateScope` does), persists via `record_dimension_state`, and returns the next question.

**Constraints on the loop, each for a reason:**
- The model may ask ONE follow-up when an answer is thin, but the next question must always target a dimension that is `not_heard` or `parked`. It cannot leave the spine.
- `done` is true only when no dimension is `not_heard` or `parked`, or the caller stops. **The model does not get to declare the interview finished.**
- A model turn that returns unparseable JSON costs one question, not the session — retry once, then mark nothing and re-ask.
- Never write a `digital_employees`, `guardrail_rules`, `playbook_definitions` or `connectors` row. Proposals go to `discovery_proposals` with `state='pending'`.

- [ ] **Step 7: Typecheck, edge-typecheck, commit**

```bash
npm run typecheck
npx vitest run tests/discovery-sidetrack.test.ts tests/discovery-spine.test.ts
git add supabase/functions/discovery-interview/index.ts tests/discovery-sidetrack.test.ts
git commit -m "feat(discovery): an interview that cannot be talked past"
```

Report the real counts. Note this task does **not** deploy the function — deployment is Plan 3b, with the UI that calls it.

---

## Task 4: Prove the spine can fail

**Files:**
- Modify: `scripts/certify.mjs`
- Modify: `scripts/certify-mutation-test.mjs`

**Interfaces:** Consumes everything above. Produces a `discovery-spine` certify section.

- [ ] **Step 1: Read a neighbouring section and its mutation entry**

Read the `provider-catalog` section in `certify.mjs` and its entries in `certify-mutation-test.mjs` — that pair is the shape to copy, including how it reports comparison counts and how its fixtures prove it fires.

- [ ] **Step 2: Add the section**

Assert, reporting counts not just findings: 12 active dimensions with unique ordinals 1–12 · no dimension references a non-existent archetype · every dimension has guidance ≥120 chars and a non-empty `produces` · no `discovery_sessions` row holds a coverage value outside the four states · `authenticated` can SELECT `discovery_dimensions` and cannot write it. Emit the number of dimensions and sessions examined — **zero examined must itself be a violation**, per the rule this repo keeps relearning.

- [ ] **Step 3: Register mutation fixtures**

At least four, following the neighbour's shape: a dimension pointing at a non-existent archetype; a dimension with thin guidance; a duplicate ordinal; a coverage value outside the four states. Each must be shown to fire, and the clean state to stay silent.

- [ ] **Step 4: Run both and report real numbers**

```bash
npm run certify:mutation
npm run certify:fast
```

⚠ `certify:fast` is currently NOT CERTIFIED for **pre-existing** reasons — `ring0-probes` (2 `no-pending-approval` + 1 `onboarding-bindings`) and `migration-ledger` (ORPHANED 715/717). Do not try to fix those. Report **your section's** result specifically, and confirm the other two sections' findings are byte-identical to before your change.

- [ ] **Step 5: Commit**

```bash
git add scripts/certify.mjs scripts/certify-mutation-test.mjs
git commit -m "test(certify): the spine cannot quietly shrink"
```

---

## Done when

- `npx vitest run tests/discovery-spine.test.ts tests/discovery-sidetrack.test.ts` passes, with the comparison counts printed.
- **The sidetrack test was seen to fail before `coverageAfter` existed**, and passes now.
- Both migrations are committed, applied, and their verification blocks were shown capable of failing; no probe rows survive in either table.
- The `discovery-spine` certify section is green with counts, and each of its four mutation fixtures was seen to go red.
- No `digital_employees` row with `is_workforce_assistant = true` was read or written, and **no employee, playbook, guardrail or connector was created by anything in this plan.**
