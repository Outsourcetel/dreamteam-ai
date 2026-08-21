-- 831_a_role_declares_what_proves_it.sql
-- ============================================================================
-- Task 4 of 7, trust-promotion program (plan: 2026-08-21-trust-promotion).
--
-- WHY: mig 819 taught trust_evidence_for to fold a system-corroborated
-- REFUSAL into the human-sample counter. The founder's next ruling: a
-- system-corroborated CORRECTNESS should count too -- but what counts as
-- "corroborated" is not one universal list. A Billing role and a Support
-- role mean different things by "the system can confirm this was done
-- right" (an invoice that reconciles, vs. a ticket that never reopens).
-- So the ROLE ARCHETYPE declares its own signals, per action category, and
-- the platform only ever READS the declaration -- it never branches on
-- which role it is looking at. Task 5 does the counting; this task only
-- lands the declaration and a reader, so it can be reviewed on its own
-- before any counting logic depends on it.
--
-- ── SCOPE, DELIBERATELY NARROW ─────────────────────────────────────────────
-- This migration adds one column and one read-only function. It does NOT
-- touch trust_evidence_for (819's counter stays the only counter -- two
-- counters measuring the same thing is a divergence this repo has already
-- paid to unpick once) and it does NOT populate trust_signals for any real
-- role. Every one of the 15 active role_archetypes rows keeps trust_signals
-- NULL after this runs -- measured before writing this, and confirmed the
-- empty state is the correct, expected, production reality right now, not a
-- gap to quietly fill in. Seeding a real role here would make the reader
-- "look alive" while lying about what has actually been decided about it.
--
-- ── digital_employees.archetype_key IS the join column ─────────────────────
-- Confirmed against information_schema.columns before writing this (not
-- assumed from the brief): digital_employees.archetype_key is text,
-- nullable, no FK -- a soft reference to role_archetypes.key, matching what
-- the brief specified verbatim. Also confirmed by reading
-- instantiate_role_archetype_internal's actual body: its INSERT column list
-- includes archetype_key and sets it to the archetype's own key, so every
-- employee hired through that path already carries a resolvable role. That
-- function does NOT need to change for this task -- trust_signals lives on
-- the CATALOG (role_archetypes) and is read at query time through the join,
-- never copied onto the employee at hire time.
--
-- ── WHY declared_trust_signals NEVER RETURNS SQL NULL (original finding,
--    kept for the record -- superseded in shape, not in substance, by FIX
--    ROUND 1 below) ─────────────────────────────────────────────────────────
-- The brief's own acceptance test requires "never null" so a caller does not
-- have to null-check. The brief's draft SQL --
--   select coalesce(a.trust_signals -> p.action_category, '[]'::jsonb)
--   from trust_policies p join digital_employees d ... join role_archetypes a ...
--   where p.id = p_policy_id
-- -- coalesces the COLUMN correctly (a role whose trust_signals IS NULL, or
-- which has nothing for this category, becomes '[]'), but a `language sql`
-- function returns bare SQL NULL when its final SELECT matches ZERO ROWS --
-- and that coalesce never runs at all in that case, because there is no row
-- for it to run against. Three real, current shapes hit exactly that: a
-- tenant-scoped policy (trust_policies.de_id IS NULL -- the column allows
-- it, though 0 of today's 58 rows currently use it), a policy whose employee
-- has archetype_key IS NULL (9 of today's 58 -- hired before archetypes
-- existed, or through a path that never set one), and simply a p_policy_id
-- that does not exist at all. All three would come back bare NULL under the
-- brief's literal draft. Proved below against real rows of the
-- archetype_key-IS-NULL shape, not only a synthetic one -- PROBE 3.
--
-- ── FIX ROUND 1 (coordinator review: 2 Important, 1 Minor) ──────────────────
--
-- IMPORTANT 1 -- "always an array" was not actually guaranteed. The original
-- coalesce caught SQL NULL, but `->` returns a jsonb VALUE, and a jsonb value
-- can be the JSON null literal or any scalar -- neither is SQL NULL, so
-- coalesce never touches them:
--   {"cat": null}          -> `->` returns a jsonb null (typeof 'null')
--   {"cat": "not-a-list"}  -> `->` returns a jsonb string (typeof 'string')
-- A Task 5 caller doing `jsonb_array_length(declared_trust_signals(p))` --
-- exactly what the brief's own probe draft does -- would get
-- `ERROR 22023: cannot get array length of a scalar`, not 0. Nothing writes
-- this column today, so the gap is unreachable now and becomes permanent the
-- moment this migration lands (the ledger keys on filename AND checksum).
--
-- Fixed two ways, both wanted:
--
-- 1. THE READER NOW GUARANTEES ITS OWN CONTRACT. Rewritten around a single
--    `jsonb_typeof(...) = 'array'` guard rather than coalesce: the lookup is
--    wrapped in a no-FROM scalar subquery (so it always evaluates to exactly
--    one row, NULL or not, regardless of whether the join matched anything --
--    the same trick the coalesce version used), and the outer CASE returns
--    the looked-up value ONLY when its jsonb_typeof is genuinely 'array';
--    every other shape -- SQL NULL, jsonb null, a string, a number, a
--    boolean, a nested object -- returns '[]'::jsonb. One mechanism now
--    covers "no row matched" AND "value present but not a list", which is
--    the property Task 5 actually needs. Proved in both directions below --
--    PROBE 2b (a well-shaped declaration returns its array) and PROBE 2c
--    (each malformed shape returns [] rather than raising).
--
-- 2. THE COLUMN NOW CONSTRAINS ITS TOP-LEVEL SHAPE, following the sibling
--    precedent the review found on this same table family:
--    trust_policies_ladder_is_array is
--    `CHECK ((ladder IS NULL) OR (jsonb_typeof(ladder) = 'array'))` (mig
--    458). trust_signals is a DIFFERENT shape one level up -- a map from
--    action_category to a list, not itself a list -- so its top-level
--    constraint is the object analogue:
--    `CHECK (trust_signals IS NULL OR jsonb_typeof(trust_signals) = 'object')`.
--    This is deliberately NOT the full guarantee ("every value under every
--    key is an array") -- a CHECK constraint cannot express that. Confirmed
--    empirically while writing this, not assumed: attempting
--    `CHECK (NOT EXISTS (SELECT 1 FROM jsonb_each(trust_signals) x WHERE
--    jsonb_typeof(x.value) <> 'array'))` against a scratch table raises
--    `ERROR 0A000: cannot use subquery in check constraint`, live, on this
--    database. So the CHECK carries the half it can (top-level shape); the
--    reader's jsonb_typeof guard above carries the other half (per-category
--    shape), exactly as instructed -- no trigger invented to paper over the
--    gap. PROBE 1b proves the CHECK exists AND can actually fire (a
--    deliberate top-level-array insert is attempted and must be rejected);
--    PROBE 2c proves per-category malformed values -- which the CHECK
--    cannot see -- are still caught by the reader.
--
-- IMPORTANT 2 -- switched to SECURITY INVOKER (was DEFINER). The review's
-- reasoning, independently re-checked while applying it:
--
--   - At today's grant set, DEFINER buys nothing. The only grantee,
--     service_role, has rolbypassrls -- confirmed via pg_roles -- and so
--     does the function's owner (postgres). INVOKER behaves identically to
--     DEFINER for every caller that can execute this function today.
--   - What differs is what happens when a later task widens the grant.
--     Under DEFINER this function would become a cross-tenant reader BY
--     CONSTRUCTION -- a policy id passed as a parameter is an assertion, not
--     authorisation, the exact family migrations 662-664 closed. Under
--     INVOKER, live RLS constrains it for free. Checked directly against
--     pg_policies rather than taken on faith: trust_policies carries
--     `trust_policies_tenant_read` -- SELECT, role {public} (i.e. applies to
--     any caller without a more specific policy), qual
--     `tenant_id = auth_tenant_id()` -- so a foreign policy id resolves zero
--     rows and this function's own zero-rows guard (IMPORTANT 1) already
--     turns that into '[]', not an error and not another tenant's data.
--     trust_policies ALSO carries `trust_policies_proposer_read`, qual
--     `true` (unrestricted) -- worth checking closely rather than trusting
--     the name, and it turned out to matter: it is scoped `TO
--     trust_pattern_proposer` only (confirmed via pg_policies.roles), the
--     narrow system role the daily trust-widening sweep runs as (mig 828),
--     not `authenticated` or `public`. It does not undermine the tenant
--     boundary for any realistic future grantee of this function.
--   - The two siblings this file already cites for its grant shape --
--     evidence_is_production, connector_circuit_open -- are both
--     `prosecdef = false` (INVOKER). This function now matches their
--     security mode as well as their grant shape.
--
-- `set search_path = public` is dropped, not just left in place unexamined:
-- checked rather than assumed. Every table reference in this function's body
-- is already fully schema-qualified (public.trust_policies, etc.), and its
-- only other names -- `jsonb_typeof`, `case`, `->` -- are pg_catalog
-- built-ins, which are searched first regardless of the search_path GUC. So
-- there is no unqualified name in this body for search_path to pin, on
-- either DEFINER or INVOKER -- and neither sibling (evidence_is_production,
-- connector_circuit_open, both read via pg_get_functiondef before writing
-- this) sets it either. `security invoker` is written explicitly rather than
-- left as the implicit default (14 other functions in this repo do the
-- same) specifically so a future reader sees a deliberate choice here, not
-- an omission to "restore".
--
-- MINOR 3 -- a zero-denominator sweep no longer counts as a check. PROBE 4
-- used to increment v_checks unconditionally, so a fresh or restored
-- database with 0 trust_policies rows would report "N checks, 0 findings"
-- for a sweep that compared nothing. Fixed to only count PROBE 4 when
-- v_sweep_total > 0, with a dedicated VACUITY notice on the zero case --
-- matching mig 830's bar in this same program: a named vacuity notice, two
-- distinct success lines (full run vs. reduced run), and an inline warning
-- that db-query.mjs does not surface RAISE NOTICE, so neither line is
-- visible on a real apply.
--
-- ── NEVER HARDCODE A DEPARTMENT ─────────────────────────────────────────────
-- Nothing in this file names Billing, Support, or any other role by business
-- meaning, and the function has no branch on any role's identity at all --
-- it reads one jsonb column through one join, keyed only by whatever
-- action_category the CALLER already carries. The synthetic fixtures in the
-- proof below use a 'zz_probe_831_' prefix precisely so nothing here could
-- ever be mistaken for a real declaration; all are inserted and deleted
-- inside this same transaction and leave no trace after commit.
-- ============================================================================

begin;

-- ── the declaration ─────────────────────────────────────────────────────────
alter table public.role_archetypes
  add column if not exists trust_signals jsonb;

comment on column public.role_archetypes.trust_signals is
  'What the system can check, without a human clicking, to corroborate that this role got a piece of work right. Per action category. Read by trust_evidence_for as the positive counterpart to mig 819 corroborated refusals. The platform never names a department -- roles declare, the platform reads.';

-- Top-level shape only -- see FIX ROUND 1 / IMPORTANT 1 in the header for
-- why a CHECK cannot reach any deeper than this, and what carries the rest.
do $cols$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.role_archetypes'::regclass
       and conname = 'role_archetypes_trust_signals_is_object'
  ) then
    alter table public.role_archetypes add constraint role_archetypes_trust_signals_is_object
      check (trust_signals is null or jsonb_typeof(trust_signals) = 'object');
  end if;
end
$cols$;

-- ── the reader ───────────────────────────────────────────────────────────────
create or replace function public.declared_trust_signals(p_policy_id uuid)
returns jsonb
language sql
stable
security invoker
as $function$
  select case
           when jsonb_typeof(v.signals) = 'array' then v.signals
           else '[]'::jsonb
         end
  from (
    select (
      select a.trust_signals -> p.action_category
      from public.trust_policies p
      join public.digital_employees d on d.id = p.de_id
      join public.role_archetypes a on a.key = d.archetype_key
      where p.id = p_policy_id
    ) as signals
  ) v;
$function$;

revoke all on function public.declared_trust_signals(uuid) from public, anon, authenticated;
-- Not tenant-scoped data: role_archetypes carries no tenant_id column at
-- all, and this function returns only the archetype's own declared list --
-- the identical value for every tenant's policy on that role+category. A
-- policy id belonging to a different tenant discloses nothing beyond that
-- already-global catalog fact, so no caller-side tenant check is added here.
-- (It also now runs as INVOKER, so a foreign policy id is additionally
-- bounded by live RLS the moment this function's grant ever widens beyond
-- service_role -- see FIX ROUND 1 / IMPORTANT 2.) Granted to the same
-- minimal set as its siblings (evidence_is_production, connector_circuit_
-- open): a system-only reader, not a user-facing RPC.
grant execute on function public.declared_trust_signals(uuid) to service_role;

-- ── proof ─────────────────────────────────────────────────────────────────
do $verify$
declare
  v_checks integer := 0;
  v_bad    text[]  := '{}';

  -- synthetic fixtures, prefixed so nothing here can ever read as a real
  -- declaration; all created and deleted inside this one transaction.
  v_role_no_key        text  := 'zz_probe_831_no_signals';
  v_role_with_key      text  := 'zz_probe_831_with_signals';
  v_role_malformed_key text  := 'zz_probe_831_malformed';
  v_category           text  := 'zz_probe_831_category';
  v_cat_null           text  := 'zz_probe_831_cat_null';
  v_cat_scalar         text  := 'zz_probe_831_cat_scalar';
  v_cat_object         text  := 'zz_probe_831_cat_object';
  v_signals            jsonb := jsonb_build_array('zz_probe_signal_alpha', 'zz_probe_signal_beta');

  v_tenant_id      uuid;
  v_tenant_arm_ran boolean := false;

  v_de_no_id        uuid;
  v_de_with_id      uuid;
  v_de_malformed_id uuid;
  v_pol_no_id       uuid;
  v_pol_with_id     uuid;
  v_pol_null_id     uuid;
  v_pol_scalar_id   uuid;
  v_pol_object_id   uuid;

  v_result jsonb;

  v_real_no_role_policy uuid;

  v_sweep_total   integer := 0;
  v_sweep_bad     integer := 0;
  v_sweep_example uuid;
  v_row           record;
begin
  -- ══ PROBE 1 -- unconditional, needs no fixture, runs on an empty database
  -- too: a p_policy_id that matches NOTHING must still come back as a proper
  -- empty array, never SQL NULL.
  v_checks := v_checks + 1;
  v_result := public.declared_trust_signals(gen_random_uuid());
  if coalesce(jsonb_typeof(v_result), 'sql-null') <> 'array' or v_result <> '[]'::jsonb then
    v_bad := array_append(v_bad, format(
      'PROBE 1: declared_trust_signals(<nonexistent policy>) returned %s (typeof=%s), expected [] -- callers must not have to null-check',
      coalesce(v_result::text, 'SQL NULL'), coalesce(jsonb_typeof(v_result), 'null')));
  end if;

  -- ══ PROBE 1b -- unconditional, no fixture needed (role_archetypes has no
  -- tenant scoping at all): role_archetypes_trust_signals_is_object does not
  -- merely exist -- it can actually fire on a genuine top-level violation. A
  -- gate that cannot fail is theatre; this is the CHECK's half of FIX
  -- ROUND 1 / IMPORTANT 1 proving it is load-bearing, not decorative.
  v_checks := v_checks + 1;
  begin
    insert into public.role_archetypes (key, name, domain, trust_signals)
      values ('zz_probe_831_bad_top_level', 'zz probe 831 (bad top level)', 'zz_probe_831', '[]'::jsonb);
    -- reached only if the constraint failed to reject a top-level ARRAY.
    delete from public.role_archetypes where key = 'zz_probe_831_bad_top_level';
    v_bad := array_append(v_bad, 'PROBE 1b: role_archetypes_trust_signals_is_object did NOT reject a top-level jsonb array -- the gate cannot fail');
  exception
    when check_violation then
      null; -- expected: the constraint correctly refused a top-level array.
  end;

  -- ══ PROBE 2 / 2c -- synthetic no-signals / with-signals / malformed-value
  -- fixtures. Needs one existing tenant to hang throwaway employees off of;
  -- on a truly empty database (0 tenants) both are skipped and SAID SO,
  -- never silently treated as a pass.
  select id into v_tenant_id from public.tenants order by created_at limit 1;

  if v_tenant_id is null then
    raise notice '831 VACUITY -- no tenant exists on this database. PROBE 2 (synthetic no-signals/with-signals pair) and PROBE 2c (malformed per-category shapes) make ZERO comparisons on this dataset -- true and honest on an empty database, not a manufactured pass. PROBE 1, 1b, and (data permitting) 3 and 4 are unaffected -- none of them need a tenant.';
  else
    v_tenant_arm_ran := true;

    insert into public.role_archetypes (key, name, domain, trust_signals)
      values (v_role_no_key, 'zz probe 831 (no signals)', 'zz_probe_831', null);
    insert into public.role_archetypes (key, name, domain, trust_signals)
      values (v_role_with_key, 'zz probe 831 (with signals)', 'zz_probe_831',
              jsonb_build_object(v_category, v_signals));
    -- PROBE 2c's fixture: one role, three categories, each a shape the
    -- top-level CHECK cannot see through -- a jsonb null, a scalar string,
    -- and a nested object. The two named directly in the review:
    --   {"cat": null}          -> jsonb null
    --   {"cat": "not-a-list"}  -> jsonb string
    -- plus a nested object as a third, related malformed shape.
    insert into public.role_archetypes (key, name, domain, trust_signals)
      values (v_role_malformed_key, 'zz probe 831 (malformed)', 'zz_probe_831',
              jsonb_build_object(
                v_cat_null,   null::jsonb,
                v_cat_scalar, to_jsonb('not-a-list'::text),
                v_cat_object, jsonb_build_object('nested', 'object')
              ));

    insert into public.digital_employees (tenant_id, name, archetype_key)
      values (v_tenant_id, 'zz probe 831 DE (no signals)', v_role_no_key)
      returning id into v_de_no_id;
    insert into public.digital_employees (tenant_id, name, archetype_key)
      values (v_tenant_id, 'zz probe 831 DE (with signals)', v_role_with_key)
      returning id into v_de_with_id;
    insert into public.digital_employees (tenant_id, name, archetype_key)
      values (v_tenant_id, 'zz probe 831 DE (malformed)', v_role_malformed_key)
      returning id into v_de_malformed_id;

    insert into public.trust_policies (tenant_id, de_id, action_category)
      values (v_tenant_id, v_de_no_id, v_category)
      returning id into v_pol_no_id;
    insert into public.trust_policies (tenant_id, de_id, action_category)
      values (v_tenant_id, v_de_with_id, v_category)
      returning id into v_pol_with_id;
    insert into public.trust_policies (tenant_id, de_id, action_category)
      values (v_tenant_id, v_de_malformed_id, v_cat_null)
      returning id into v_pol_null_id;
    insert into public.trust_policies (tenant_id, de_id, action_category)
      values (v_tenant_id, v_de_malformed_id, v_cat_scalar)
      returning id into v_pol_scalar_id;
    insert into public.trust_policies (tenant_id, de_id, action_category)
      values (v_tenant_id, v_de_malformed_id, v_cat_object)
      returning id into v_pol_object_id;

    -- (a) a role that declares nothing for this category -- the state every
    -- real role is in today -- returns a proper empty array, never null.
    v_checks := v_checks + 1;
    v_result := public.declared_trust_signals(v_pol_no_id);
    if coalesce(jsonb_typeof(v_result), 'sql-null') <> 'array' or v_result <> '[]'::jsonb then
      v_bad := array_append(v_bad, format(
        'PROBE 2a: declared_trust_signals returned %s for a role with no signals, expected []',
        coalesce(v_result::text, 'SQL NULL')));
    end if;

    -- (b) ⛔ THE CONTROL. If this one also comes back empty, arm (a) proves
    -- nothing -- it would mean the function returns [] unconditionally
    -- rather than because it correctly read an absent declaration.
    v_checks := v_checks + 1;
    v_result := public.declared_trust_signals(v_pol_with_id);
    if v_result is null or jsonb_typeof(v_result) <> 'array' or jsonb_array_length(v_result) = 0 then
      v_bad := array_append(v_bad, format(
        'PROBE 2b: CONTROL FAILED -- a role WITH declared signals returned %s, so PROBE 2a above proves nothing',
        coalesce(v_result::text, 'SQL NULL')));
    elsif v_result <> v_signals then
      v_bad := array_append(v_bad, format(
        'PROBE 2b: declared_trust_signals returned %s for the with-signals policy, expected exactly %s -- it is not reading the matching category key',
        v_result::text, v_signals::text));
    end if;

    -- (c) PROBE 2c -- each malformed per-category VALUE returns [] rather
    -- than raising. This is the reader's half of FIX ROUND 1 / IMPORTANT 1;
    -- the CHECK constraint (PROBE 1b) cannot see this deep (no subqueries
    -- allowed in a CHECK -- confirmed empirically, see header), so this is
    -- the only place these three shapes are ever caught.
    v_checks := v_checks + 1;
    v_result := public.declared_trust_signals(v_pol_null_id);
    if coalesce(jsonb_typeof(v_result), 'sql-null') <> 'array' or v_result <> '[]'::jsonb then
      v_bad := array_append(v_bad, format(
        'PROBE 2c (jsonb null value): declared_trust_signals returned %s, expected []',
        coalesce(v_result::text, 'SQL NULL')));
    end if;

    v_checks := v_checks + 1;
    v_result := public.declared_trust_signals(v_pol_scalar_id);
    if coalesce(jsonb_typeof(v_result), 'sql-null') <> 'array' or v_result <> '[]'::jsonb then
      v_bad := array_append(v_bad, format(
        'PROBE 2c (scalar string value): declared_trust_signals returned %s, expected []',
        coalesce(v_result::text, 'SQL NULL')));
    end if;

    v_checks := v_checks + 1;
    v_result := public.declared_trust_signals(v_pol_object_id);
    if coalesce(jsonb_typeof(v_result), 'sql-null') <> 'array' or v_result <> '[]'::jsonb then
      v_bad := array_append(v_bad, format(
        'PROBE 2c (nested object value): declared_trust_signals returned %s, expected []',
        coalesce(v_result::text, 'SQL NULL')));
    end if;

    -- cleanup -- leaves zero trace once this transaction commits.
    delete from public.trust_policies
     where id in (v_pol_no_id, v_pol_with_id, v_pol_null_id, v_pol_scalar_id, v_pol_object_id);
    delete from public.digital_employees
     where id in (v_de_no_id, v_de_with_id, v_de_malformed_id);
    delete from public.role_archetypes
     where key in (v_role_no_key, v_role_with_key, v_role_malformed_key);
  end if;

  -- ══ PROBE 3 -- real data, no fixture. A policy whose employee has
  -- archetype_key IS NULL is a live example of the join failing at the
  -- SECOND hop (digital_employees -> role_archetypes). Measured before
  -- writing this: 9 of 58 live trust_policies rows shaped exactly this way.
  -- Discovered by query, never hardcoded; if the shape no longer exists on
  -- this database, say so and move on rather than fail.
  select p.id into v_real_no_role_policy
  from public.trust_policies p
  join public.digital_employees d on d.id = p.de_id
  where d.archetype_key is null
  order by p.id
  limit 1;

  if v_real_no_role_policy is null then
    raise notice '831 PROBE 3: no live trust_policies row currently points at an employee with archetype_key IS NULL -- the real-data join-fails arm is unexercised here.';
  else
    v_checks := v_checks + 1;
    v_result := public.declared_trust_signals(v_real_no_role_policy);
    if coalesce(jsonb_typeof(v_result), 'sql-null') <> 'array' or v_result <> '[]'::jsonb then
      v_bad := array_append(v_bad, format(
        'PROBE 3: declared_trust_signals(%s) [real policy, employee has no archetype] returned %s, expected []',
        v_real_no_role_policy, coalesce(v_result::text, 'SQL NULL')));
    end if;
  end if;

  -- ══ PROBE 4 -- real data, full sweep. Every trust_policies row that
  -- exists right now must resolve without raising and without ever
  -- returning SQL NULL. Only counted as a check when it actually compared
  -- something (MINOR 3 above) -- a sweep of 0 rows is not a check.
  for v_row in select id from public.trust_policies loop
    v_sweep_total := v_sweep_total + 1;
    v_result := public.declared_trust_signals(v_row.id);
    if v_result is null or jsonb_typeof(v_result) <> 'array' then
      v_sweep_bad := v_sweep_bad + 1;
      if v_sweep_example is null then v_sweep_example := v_row.id; end if;
    end if;
  end loop;

  if v_sweep_total > 0 then
    v_checks := v_checks + 1;
    if v_sweep_bad > 0 then
      v_bad := array_append(v_bad, format(
        'PROBE 4: %s of %s live trust_policies rows returned something other than a jsonb array (e.g. policy %s)',
        v_sweep_bad, v_sweep_total, v_sweep_example));
    end if;
  else
    raise notice '831 VACUITY -- PROBE 4 found 0 trust_policies rows on this database to sweep. Zero rows compared, so this does not count toward the checks total below.';
  end if;

  if array_length(v_bad, 1) > 0 then
    raise exception 'VERIFICATION FAILED (% of % checks): %', array_length(v_bad, 1), v_checks, array_to_string(v_bad, ' | ');
  end if;

  if v_tenant_arm_ran then
    raise notice '831: % checks compared, 0 findings -- FULL RUN (tenant found; PROBE 2/2c exercised). PROBE 3 (real no-archetype policy) %. PROBE 4 swept % live trust_policies rows, % anomalies. NOTE: db-query.mjs does not surface RAISE NOTICE -- this line is invisible on a real apply.',
      v_checks,
      case when v_real_no_role_policy is null then 'SKIPPED -- no such row exists right now' else format('exercised on policy %s', v_real_no_role_policy) end,
      v_sweep_total, v_sweep_bad;
  else
    raise notice '831: % checks compared, 0 findings -- REDUCED RUN, no tenant on this database (see VACUITY notice above): PROBE 1/1b only from the unconditional arms, PROBE 2/2c skipped. PROBE 3 (real no-archetype policy) %. PROBE 4 swept % live trust_policies rows, % anomalies. NOTE: db-query.mjs does not surface RAISE NOTICE -- this line is invisible on a real apply.',
      v_checks,
      case when v_real_no_role_policy is null then 'SKIPPED -- no such row exists right now' else format('exercised on policy %s', v_real_no_role_policy) end,
      v_sweep_total, v_sweep_bad;
  end if;
end
$verify$;

commit;
