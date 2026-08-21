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
-- ── WHY declared_trust_signals NEVER RETURNS SQL NULL ───────────────────────
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
-- brief's literal draft -- exactly the outcome the acceptance test exists to
-- catch. Fixed by wrapping the whole lookup in a second, OUTER coalesce, so
-- "no row matched" and "row matched, value absent" collapse to the same
-- '[]'::jsonb. Proved below against real rows of the archetype_key-IS-NULL
-- shape, not only a synthetic one -- PROBE 3.
--
-- ── NEVER HARDCODE A DEPARTMENT ─────────────────────────────────────────────
-- Nothing in this file names Billing, Support, or any other role by business
-- meaning, and the function has no branch on any role's identity at all --
-- it reads one jsonb column through one join, keyed only by whatever
-- action_category the CALLER already carries. The synthetic fixtures in the
-- proof below use a 'zz_probe_831_' prefix precisely so nothing here could
-- ever be mistaken for a real declaration; both are inserted and deleted
-- inside this same transaction and leave no trace after commit.
-- ============================================================================

begin;

-- ── the declaration ─────────────────────────────────────────────────────────
alter table public.role_archetypes
  add column if not exists trust_signals jsonb;

comment on column public.role_archetypes.trust_signals is
  'What the system can check, without a human clicking, to corroborate that this role got a piece of work right. Per action category. Read by trust_evidence_for as the positive counterpart to mig 819 corroborated refusals. The platform never names a department -- roles declare, the platform reads.';

-- ── the reader ───────────────────────────────────────────────────────────────
create or replace function public.declared_trust_signals(p_policy_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
  select coalesce(
    (
      select coalesce(a.trust_signals -> p.action_category, '[]'::jsonb)
      from public.trust_policies p
      join public.digital_employees d on d.id = p.de_id
      join public.role_archetypes a on a.key = d.archetype_key
      where p.id = p_policy_id
    ),
    '[]'::jsonb
  );
$function$;

revoke all on function public.declared_trust_signals(uuid) from public, anon, authenticated;
-- Not tenant-scoped data: role_archetypes carries no tenant_id column at
-- all, and this function returns only the archetype's own declared list --
-- the identical value for every tenant's policy on that role+category. A
-- policy id belonging to a different tenant discloses nothing beyond that
-- already-global catalog fact, so no caller-side tenant check is added here.
-- Granted to the same minimal set as its siblings (evidence_is_production,
-- connector_circuit_open): a system-only reader, not a user-facing RPC.
grant execute on function public.declared_trust_signals(uuid) to service_role;

-- ── proof ─────────────────────────────────────────────────────────────────
do $verify$
declare
  v_checks integer := 0;
  v_bad    text[]  := '{}';

  -- synthetic-pair fixture, PROBE 2. Prefixed so nothing here can ever read
  -- as a real declaration; created and deleted inside this one transaction.
  v_role_no_key   text  := 'zz_probe_831_no_signals';
  v_role_with_key text  := 'zz_probe_831_with_signals';
  v_category      text  := 'zz_probe_831_category';
  v_signals       jsonb := jsonb_build_array('zz_probe_signal_alpha', 'zz_probe_signal_beta');

  v_tenant_id   uuid;
  v_de_no_id    uuid;
  v_de_with_id  uuid;
  v_pol_no_id   uuid;
  v_pol_with_id uuid;

  v_result jsonb;

  v_real_no_role_policy uuid;

  v_sweep_total   integer := 0;
  v_sweep_bad     integer := 0;
  v_sweep_example uuid;
  v_row           record;
begin
  -- ══ PROBE 1 -- unconditional, needs no fixture, runs on an empty database
  -- too: a p_policy_id that matches NOTHING must still come back as a proper
  -- empty array, never SQL NULL. This is exactly the shape the brief's draft
  -- SQL misses (see header).
  v_checks := v_checks + 1;
  v_result := public.declared_trust_signals(gen_random_uuid());
  if coalesce(jsonb_typeof(v_result), 'sql-null') <> 'array' or v_result <> '[]'::jsonb then
    v_bad := array_append(v_bad, format(
      'PROBE 1: declared_trust_signals(<nonexistent policy>) returned %s (typeof=%s), expected [] -- callers must not have to null-check',
      coalesce(v_result::text, 'SQL NULL'), coalesce(jsonb_typeof(v_result), 'null')));
  end if;

  -- ══ PROBE 2 -- synthetic no-signals/with-signals pair. Needs one existing
  -- tenant to hang a throwaway employee off of; on a truly empty database
  -- (0 tenants) this is skipped and SAID SO, never silently treated as a
  -- pass.
  select id into v_tenant_id from public.tenants order by created_at limit 1;

  if v_tenant_id is null then
    raise notice '831 PROBE 2: no tenant exists on this database -- the synthetic no-signals/with-signals pair is unexercised here.';
  else
    insert into public.role_archetypes (key, name, domain, trust_signals)
      values (v_role_no_key, 'zz probe 831 (no signals)', 'zz_probe_831', null);
    insert into public.role_archetypes (key, name, domain, trust_signals)
      values (v_role_with_key, 'zz probe 831 (with signals)', 'zz_probe_831',
              jsonb_build_object(v_category, v_signals));

    insert into public.digital_employees (tenant_id, name, archetype_key)
      values (v_tenant_id, 'zz probe 831 DE (no signals)', v_role_no_key)
      returning id into v_de_no_id;
    insert into public.digital_employees (tenant_id, name, archetype_key)
      values (v_tenant_id, 'zz probe 831 DE (with signals)', v_role_with_key)
      returning id into v_de_with_id;

    insert into public.trust_policies (tenant_id, de_id, action_category)
      values (v_tenant_id, v_de_no_id, v_category)
      returning id into v_pol_no_id;
    insert into public.trust_policies (tenant_id, de_id, action_category)
      values (v_tenant_id, v_de_with_id, v_category)
      returning id into v_pol_with_id;

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

    -- cleanup -- leaves zero trace once this transaction commits.
    delete from public.trust_policies where id in (v_pol_no_id, v_pol_with_id);
    delete from public.digital_employees where id in (v_de_no_id, v_de_with_id);
    delete from public.role_archetypes where key in (v_role_no_key, v_role_with_key);
  end if;

  -- ══ PROBE 3 -- real data, no fixture. A policy whose employee has
  -- archetype_key IS NULL is a live example of the join failing at the
  -- SECOND hop (digital_employees -> role_archetypes), the other half of
  -- the outer-coalesce fix from the header. Measured before writing this: 9
  -- of 58 live trust_policies rows shaped exactly this way. Discovered by
  -- query, never hardcoded; if the shape no longer exists on this database,
  -- say so and move on rather than fail.
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
  -- returning SQL NULL. Denominator is stated below, not implied.
  for v_row in select id from public.trust_policies loop
    v_sweep_total := v_sweep_total + 1;
    v_result := public.declared_trust_signals(v_row.id);
    if v_result is null or jsonb_typeof(v_result) <> 'array' then
      v_sweep_bad := v_sweep_bad + 1;
      if v_sweep_example is null then v_sweep_example := v_row.id; end if;
    end if;
  end loop;
  v_checks := v_checks + 1;
  if v_sweep_bad > 0 then
    v_bad := array_append(v_bad, format(
      'PROBE 4: %s of %s live trust_policies rows returned something other than a jsonb array (e.g. policy %s)',
      v_sweep_bad, v_sweep_total, v_sweep_example));
  end if;

  if array_length(v_bad, 1) > 0 then
    raise exception 'VERIFICATION FAILED (% of % checks): %', array_length(v_bad, 1), v_checks, array_to_string(v_bad, ' | ');
  end if;

  raise notice '831: % checks, 0 findings. PROBE 2 (synthetic pair) %. PROBE 3 (real no-archetype policy) %. PROBE 4 swept % live trust_policies rows, % anomalies.',
    v_checks,
    case when v_tenant_id is null then 'SKIPPED -- no tenant on this database' else 'exercised' end,
    case when v_real_no_role_policy is null then 'SKIPPED -- no such row exists right now' else format('exercised on policy %s', v_real_no_role_policy) end,
    v_sweep_total, v_sweep_bad;
end
$verify$;

commit;
