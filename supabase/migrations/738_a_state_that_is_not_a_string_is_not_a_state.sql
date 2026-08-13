-- 738_a_state_that_is_not_a_string_is_not_a_state.sql
-- ==========================================================================
-- WHY: fix round 1 on the review of 737 (applied, untouched — this repo
-- never edits an applied migration). Four findings, all independently
-- reproduced against production before being fixed here, not just reasoned
-- about. Full trail, including a false claim in the prior report that is
-- corrected in place rather than quietly dropped, is in
-- .superpowers/sdd/2026-08-13-discovery-interview-engine/task-2-report.md.
--
-- FINDING 1 — the subquery-CHECK fix from 737 was itself incomplete.
-- jsonb_path_exists compares mismatched JSON types as "unknown", and
-- "unknown" excludes an item from a `?()` filter exactly like "false" does
-- — so a coverage entry whose state is a NUMBER or BOOLEAN was silently
-- treated as "nothing bad here" and slipped straight through. Reproduced
-- live, read-only, before writing anything: {"state":42} and
-- {"state":true} both passed the deployed constraint; {"state":"bad"}
-- correctly did not. The fix adds an explicit `@.type() != "string"`
-- branch ahead of the value comparison, which ALSO closes a JSON-null hole
-- present even in the brief's ORIGINAL (illegal) subquery form — {"state":
-- null} passed under both 737's constraint and the brief's own version,
-- since `->>'state'` and jsonpath's untyped `!=` both treat a JSON null as
-- absence rather than as a fifth, wrong value. Not something the review
-- asked for; found while fixing the thing it did ask for, and worth taking
-- since it was the same shape of gap.
--
-- Not fully closed: a JSON ARRAY whose sole element happens to be a valid
-- state string, e.g. {"state":["heard"]}, still passes. This is lax-mode
-- jsonpath's automatic array-unwrapping — `@.type()` and the `!=`
-- comparisons both silently unwrap a singleton array to its element before
-- evaluating, so ["heard"] behaves identically to "heard". `strict` mode
-- disables that unwrapping and was tested — it closes the array case, but
-- turns the ALREADY-DISCLOSED missing-state-key case (e.g. {} with no
-- "state" member at all — reachable only via a raw write bypassing
-- record_dimension_state, same as before) from a silent, harmless accept
-- into a raw, uncatchable-as-check_violation runtime error
-- (`2203A: JSON object does not contain key "state"`), which would make
-- EVERY future write touching a differently-shaped coverage object fail
-- with an opaque error instead of a clean rejection. That is a worse
-- trade, not a better one, so lax mode stays and the array case is
-- disclosed rather than chased. Both directions were proven empirically
-- against disposable scratch data before this paragraph was written.
--
-- The validator is now its own IMMUTABLE function,
-- discovery_coverage_states_valid(jsonb), rather than inline in the CHECK.
-- This is a deliberate change from 737's shape, made possible by finding
-- 3 below: the old vitest test needed the four state words to live in the
-- CHECK's own text (pg_get_constraintdef), which an inline expression gave
-- it and a function call would not — but that test is being replaced with
-- a behavioural one in this same commit, so the constraint it was pinning
-- no longer applies, and a named function is what makes real behavioural
-- testing possible: vitest (read-only) can call it directly, on live
-- production, with adversarial inputs — not duplicate its logic, not
-- regex-scrape a catalog string.
--
-- Extracting the logic into a function surfaced a THIRD thing that would
-- have shipped broken if untested: a CHECK constraint that calls a
-- function requires the INSERTING ROLE to hold EXECUTE on that function —
-- proven on a disposable throwaway function+table pair by granting a role
-- table-INSERT but not function-EXECUTE and watching the insert fail with
-- `permission denied for function`, not a check_violation. Forgetting
-- `grant execute ... to service_role` below would have broken every write
-- to discovery_sessions in production while still passing a naive test,
-- because this migration's own verification runs as the migration's
-- (owner/superuser) connection, which bypasses grants entirely regardless
-- of what was actually granted to service_role. The verification block
-- below does not make that mistake: it exercises the write AS service_role
-- specifically, via SET LOCAL ROLE, not as whatever ran the migration.
--
-- FINDING 2 — record_dimension_state's own state check,
-- `if p_state not in (...)`, never fires for p_state = NULL: SQL's
-- three-valued logic makes `NULL not in (...)` evaluate to NULL, not TRUE,
-- so the IF is skipped and a NULL state reached the UPDATE, stopped only
-- by the table CHECK — by luck, not by design, and with a raw
-- check_violation instead of this function's own message. Fixed with an
-- explicit `if p_state is null` guard, checked separately and first,
-- because that is precisely the case `not in` cannot see.
--
-- FINDING 3 — the vitest assertion for the coverage CHECK tested the
-- constraint's TEXT (pg_get_constraintdef contains the four words), not
-- its behaviour. Finding 1 is the proof that text and behaviour can
-- diverge: 737's deployed constraint contained all four words AND accepted
-- {"state":42}. Replaced with a behavioural test that calls
-- discovery_coverage_states_valid(jsonb) directly, read-only, against
-- literal adversarial inputs — genuine behaviour of the live function, not
-- a copy of its logic and not its source text.
--
-- SMALL FIX — discovery_capability_demand's first_surfaced_at /
-- last_surfaced_at read the SESSION's created_at (when the interview
-- started) rather than the specific coverage entry's own recorded_at (when
-- THAT dimension was actually marked heard) — mislabelled provenance for a
-- signal whose whole value is telling a reader when something happened.
-- One clause changed on each of two lines; nothing else about the view.
-- ==========================================================================

begin;

-- ---------------------------------------------------------------------------
-- discovery_coverage_states_valid — the CHECK's logic, now a named,
-- IMMUTABLE, callable function so vitest can exercise real behaviour
-- read-only. `@.type() != "string"` is checked before the value comparison
-- so a number, boolean, null, or object state is refused regardless of
-- what it equals; see the WHY block above for the one case (a singleton
-- array) this deliberately does not chase, and why.
-- ---------------------------------------------------------------------------
create or replace function public.discovery_coverage_states_valid(p_coverage jsonb)
returns boolean
language sql
immutable
as $function$
  select not jsonb_path_exists(p_coverage,
    '$.*.state ? (@.type() != "string" || (@ != "heard" && @ != "parked" && @ != "skipped" && @ != "not_heard"))');
$function$;

-- Required, not decorative: a CHECK constraint referencing this function
-- runs under the INSERTING role's own privileges, and service_role is the
-- only role that ever writes discovery_sessions. Proven empirically (see
-- WHY) that omitting this grant fails every write with
-- "permission denied for function", not a check_violation.
revoke all on function public.discovery_coverage_states_valid(jsonb) from public, anon, authenticated;
grant execute on function public.discovery_coverage_states_valid(jsonb) to service_role;

alter table public.discovery_sessions drop constraint if exists discovery_sessions_coverage_states;
alter table public.discovery_sessions add constraint discovery_sessions_coverage_states
  check (public.discovery_coverage_states_valid(coverage));

-- ---------------------------------------------------------------------------
-- record_dimension_state — reproduced from the live pg_get_functiondef with
-- exactly one addition: an explicit NULL guard, checked separately from
-- and before the membership test, because `p_state not in (...)` is
-- precisely the expression that cannot see a NULL (three-valued logic:
-- NULL not in (...) evaluates to NULL, not TRUE, so the existing IF never
-- fires for it). Everything else — the dimension check, the session check,
-- the parked/skipped write itself — is untouched.
-- ---------------------------------------------------------------------------
create or replace function public.record_dimension_state(p_session_id uuid, p_dimension text, p_state text, p_evidence text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- Separate from, and before, the membership check below: `NULL not in
  -- (...)` is NULL, not TRUE, so `if p_state not in (...)` silently never
  -- fires for a NULL state and it would otherwise reach the UPDATE, caught
  -- only by luck when the table CHECK rejects the resulting JSON null —
  -- with a raw check_violation instead of this function's own message.
  if p_state is null then
    raise exception 'record_dimension_state: state is required, got NULL';
  end if;

  if p_state not in ('heard', 'parked', 'skipped', 'not_heard') then
    raise exception 'record_dimension_state: unknown state % — must be one of heard, parked, skipped, not_heard', p_state;
  end if;

  if not exists (select 1 from public.discovery_dimensions where key = p_dimension and active) then
    raise exception 'record_dimension_state: unknown or inactive dimension %', p_dimension;
  end if;

  if not exists (select 1 from public.discovery_sessions where id = p_session_id) then
    raise exception 'record_dimension_state: unknown discovery session %', p_session_id;
  end if;

  -- 'parked' (ask again later, still owed a question) and 'skipped' (not
  -- relevant to this business, not owed one) are two different real
  -- conversations. Whatever state was asked for is the state stored — never
  -- normalised toward the other.
  update public.discovery_sessions
     set coverage = jsonb_set(
           coalesce(coverage, '{}'::jsonb),
           array[p_dimension],
           jsonb_build_object('state', p_state, 'evidence', p_evidence, 'recorded_at', now()),
           true
         ),
         updated_at = now()
   where id = p_session_id;
end;
$function$;

-- Re-asserted rather than trusted to survive CREATE OR REPLACE across a
-- rebuilt environment (723's lesson).
revoke all on function public.record_dimension_state(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.record_dimension_state(uuid, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- discovery_capability_demand — same shape as 737, two source expressions
-- changed: first_surfaced_at / last_surfaced_at now read the coverage
-- entry's own recorded_at (set by record_dimension_state, present on every
-- row this view can ever return, since only 'heard' entries qualify and
-- 'heard' is only ever reached through record_dimension_state) instead of
-- the session's created_at.
-- ---------------------------------------------------------------------------
create or replace view public.discovery_capability_demand as
  select
    cap.capability,
    g.dimension_key,
    g.title                           as dimension_title,
    count(distinct s.tenant_id)::int  as tenants_surfaced,
    count(distinct s.id)::int         as sessions_surfaced,
    min((s.coverage -> g.dimension_key ->> 'recorded_at')::timestamptz) as first_surfaced_at,
    max((s.coverage -> g.dimension_key ->> 'recorded_at')::timestamptz) as last_surfaced_at
    from public.discovery_capability_gaps g
    cross join lateral (
      select a as capability from unnest(g.planned_archetypes) a
    ) cap
    join public.discovery_sessions s
      on (s.coverage -> g.dimension_key ->> 'state') = 'heard'
   group by cap.capability, g.dimension_key, g.title;

comment on view public.discovery_capability_demand is
  'Platform demand signal, derived live from discovery_sessions x discovery_capability_gaps. '
  'One row per (capability, dimension) actually marked heard in at least one real session -- '
  'never stored, never a job, never an alert. service_role only: it aggregates across every '
  'tenant by design. first/last_surfaced_at read the coverage entry''s own recorded_at, not '
  'the session''s created_at (738).';

revoke all on public.discovery_capability_demand from public, anon, authenticated;
grant select on public.discovery_capability_demand to service_role;

-- ---------------------------------------------------------------------------
-- Verification. Every assertion states, in its own failure message, the
-- data that would turn it red. The coverage-state probes run AS
-- service_role specifically (SET LOCAL ROLE), not as this migration's own
-- privileged connection, because the owner/superuser connection bypasses
-- the exact EXECUTE grant this fix depends on and would prove nothing
-- about whether production can actually write this table.
-- ---------------------------------------------------------------------------
do $$
declare
  v_tenant   uuid;

  -- coverage-state type/value probe, run as service_role
  v_svc_accept_ok      boolean := false;
  v_accept_err         text;
  v_svc_reject_string  boolean := false;
  v_svc_reject_number  boolean := false;
  v_svc_reject_boolean boolean := false;
  v_svc_reject_null    boolean := false;

  -- record_dimension_state regression + null-guard probe
  v_rt_session      uuid;
  v_park_state      text;
  v_skip_state      text;
  v_rejected_dim    boolean := false;
  v_rejected_state  boolean := false;
  v_null_sqlstate   text;
  v_null_message    text;

  -- demand-view regression + provenance probe
  v_seen_heard_gap2   boolean;
  v_seen_skipped_gap2 boolean;
  v_seen_nongap2      boolean;
  v_first             timestamptz;
  v_last              timestamptz;

  v_bad      text[] := '{}';
  v_leftover int;
begin
  select id into v_tenant from public.tenants limit 1;
  if v_tenant is null then
    raise exception '738: no tenant exists to probe with — cannot prove any of this';
  end if;

  if not exists (select 1 from public.discovery_capability_gaps where dimension_key = 'money_out')
     or not exists (select 1 from public.discovery_capability_gaps where dimension_key = 'the_workforce_itself')
     or exists (select 1 from public.discovery_capability_gaps where dimension_key = 'what_we_do') then
    raise exception '738 vacuity guard: the demand-view probe''s assumptions about which dimensions are/are not capability gaps no longer hold';
  end if;

  ------------------------------------------------------------------------
  -- 1. Coverage-state validation, exercised AS service_role. Red if: a
  --    valid four-state row is refused (CHECK too strict, or the EXECUTE
  --    grant on the validator function is missing); a bad string, number,
  --    boolean, or JSON-null state is accepted (the exact type hole this
  --    migration exists to close, plus the bonus null case).
  ------------------------------------------------------------------------
  begin
    set local role service_role;

    begin
      insert into public.discovery_sessions (tenant_id, status, coverage)
      values (v_tenant, 'running', jsonb_build_object(
        'd1', jsonb_build_object('state', 'heard'),
        'd2', jsonb_build_object('state', 'parked'),
        'd3', jsonb_build_object('state', 'skipped'),
        'd4', jsonb_build_object('state', 'not_heard')
      ));
      v_svc_accept_ok := true;
    exception when others then
      v_accept_err := sqlstate || ': ' || sqlerrm;
    end;

    begin
      insert into public.discovery_sessions (tenant_id, status, coverage)
      values (v_tenant, 'running', jsonb_build_object('d1', jsonb_build_object('state', 'maybe_later')));
    exception when check_violation then v_svc_reject_string := true;
    end;

    begin
      insert into public.discovery_sessions (tenant_id, status, coverage)
      values (v_tenant, 'running', jsonb_build_object('d1', jsonb_build_object('state', 42)));
    exception when check_violation then v_svc_reject_number := true;
    end;

    begin
      insert into public.discovery_sessions (tenant_id, status, coverage)
      values (v_tenant, 'running', jsonb_build_object('d1', jsonb_build_object('state', true)));
    exception when check_violation then v_svc_reject_boolean := true;
    end;

    begin
      insert into public.discovery_sessions (tenant_id, status, coverage)
      values (v_tenant, 'running', jsonb_build_object('d1', jsonb_build_object('state', null)));
    exception when check_violation then v_svc_reject_null := true;
    end;

    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> '__undo_probe__' then raise; end if;
  end;
  reset role;

  if not v_svc_accept_ok then
    raise exception '738: service_role could not insert a row carrying all four valid coverage states — %', coalesce(v_accept_err, '(no error captured)');
  end if;
  if not v_svc_reject_string then
    raise exception '738: discovery_coverage_states_valid accepted a fifth STRING state (''maybe_later'') it should have refused';
  end if;
  if not v_svc_reject_number then
    raise exception '738: discovery_coverage_states_valid accepted a NUMERIC state (42) it should have refused — the type hole this migration exists to close';
  end if;
  if not v_svc_reject_boolean then
    raise exception '738: discovery_coverage_states_valid accepted a BOOLEAN state (true) it should have refused — the type hole this migration exists to close';
  end if;
  if not v_svc_reject_null then
    raise exception '738: discovery_coverage_states_valid accepted a JSON-null state it should have refused';
  end if;

  ------------------------------------------------------------------------
  -- 2. Perimeter on the new validator function, both directions. Red if:
  --    the grant above was written backwards.
  ------------------------------------------------------------------------
  if has_function_privilege('anon', 'public.discovery_coverage_states_valid(jsonb)', 'execute') then
    v_bad := array_append(v_bad, 'anon can execute discovery_coverage_states_valid');
  end if;
  if has_function_privilege('authenticated', 'public.discovery_coverage_states_valid(jsonb)', 'execute') then
    v_bad := array_append(v_bad, 'authenticated can execute discovery_coverage_states_valid');
  end if;
  if not has_function_privilege('service_role', 'public.discovery_coverage_states_valid(jsonb)', 'execute') then
    v_bad := array_append(v_bad, 'service_role CANNOT execute discovery_coverage_states_valid — every write to discovery_sessions would break');
  end if;
  if coalesce(array_length(v_bad, 1), 0) > 0 then
    raise exception '738: % perimeter assertion(s) failed: %', array_length(v_bad, 1), array_to_string(v_bad, ' | ');
  end if;

  ------------------------------------------------------------------------
  -- 3. record_dimension_state: no regression on parked/skipped or the two
  --    existing rejections, plus the new NULL guard. Red if: parked/skipped
  --    stop persisting distinctly; either existing rejection stops firing;
  --    a NULL state is accepted outright; or it IS rejected but only by
  --    falling through to the table CHECK (sqlstate 23514) instead of the
  --    function's own guard (sqlstate P0001) — the exact "by luck, not by
  --    design" gap this fix closes.
  ------------------------------------------------------------------------
  begin
    insert into public.discovery_sessions (tenant_id, status, coverage)
    values (v_tenant, 'running', '{}'::jsonb)
    returning id into v_rt_session;

    perform public.record_dimension_state(v_rt_session, 'money_out', 'parked', 'probe: ask again later');
    perform public.record_dimension_state(v_rt_session, 'the_workforce_itself', 'skipped', 'probe: not relevant to this business');

    select coverage->'money_out'->>'state', coverage->'the_workforce_itself'->>'state'
      into v_park_state, v_skip_state
      from public.discovery_sessions where id = v_rt_session;

    begin
      perform public.record_dimension_state(v_rt_session, '__no_such_dimension__', 'heard', null);
    exception when sqlstate 'P0001' then v_rejected_dim := true;
    end;

    begin
      perform public.record_dimension_state(v_rt_session, 'money_out', 'maybe_later', null);
    exception when sqlstate 'P0001' then v_rejected_state := true;
    end;

    begin
      perform public.record_dimension_state(v_rt_session, 'money_out', null, null);
    exception when others then
      v_null_sqlstate := sqlstate;
      v_null_message  := sqlerrm;
    end;

    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> '__undo_probe__' then raise; end if;
  end;

  if v_park_state is distinct from 'parked' then
    raise exception '738: regression — record_dimension_state no longer persists "parked" (got %)', coalesce(v_park_state, 'NULL');
  end if;
  if v_skip_state is distinct from 'skipped' then
    raise exception '738: regression — record_dimension_state no longer persists "skipped" (got %)', coalesce(v_skip_state, 'NULL');
  end if;
  if v_park_state = v_skip_state then
    raise exception '738: regression — parked and skipped collapsed to the same stored value';
  end if;
  if not v_rejected_dim then
    raise exception '738: regression — record_dimension_state accepted an unknown dimension key';
  end if;
  if not v_rejected_state then
    raise exception '738: regression — record_dimension_state accepted a state outside the four';
  end if;

  if v_null_sqlstate is null then
    raise exception '738: record_dimension_state accepted a NULL state without raising anything';
  end if;
  if v_null_sqlstate <> 'P0001' then
    raise exception '738: record_dimension_state(NULL state) raised % (%) instead of its own guard — it fell through to the table CHECK or something else instead of catching NULL itself', v_null_sqlstate, v_null_message;
  end if;
  if v_null_message !~* 'null' then
    raise exception '738: record_dimension_state''s NULL-state error does not mention NULL, so the caller still cannot tell what went wrong — got: %', v_null_message;
  end if;

  ------------------------------------------------------------------------
  -- 4. discovery_capability_demand: no regression on the three-way
  --    discrimination, plus the provenance fix. created_at is deliberately
  --    set to 1999 and recorded_at to 2020 so the two candidate sources
  --    are unmistakably distinguishable — same-transaction now() would
  --    make them read identically (Postgres's now() is constant for the
  --    whole transaction), which is exactly why this probe uses literal,
  --    divergent timestamps instead of timing. Red if: the discrimination
  --    regressed, or first/last_surfaced_at read 1999 (still created_at)
  --    instead of 2020 (recorded_at).
  ------------------------------------------------------------------------
  begin
    insert into public.discovery_sessions (tenant_id, status, coverage, created_at)
    values (
      v_tenant, 'running',
      jsonb_build_object(
        'money_out',            jsonb_build_object('state', 'heard',   'evidence', 'probe', 'recorded_at', '2020-06-15T00:00:00Z'),
        'the_workforce_itself', jsonb_build_object('state', 'skipped', 'evidence', 'probe', 'recorded_at', '2020-06-15T00:00:00Z'),
        'what_we_do',           jsonb_build_object('state', 'heard',   'evidence', 'probe', 'recorded_at', '2020-06-15T00:00:00Z')
      ),
      '1999-01-01T00:00:00Z'::timestamptz
    );

    select exists (select 1 from public.discovery_capability_demand where dimension_key = 'money_out' and capability = 'planned_legal') into v_seen_heard_gap2;
    select exists (select 1 from public.discovery_capability_demand where dimension_key = 'the_workforce_itself') into v_seen_skipped_gap2;
    select exists (select 1 from public.discovery_capability_demand where dimension_key = 'what_we_do') into v_seen_nongap2;

    select first_surfaced_at, last_surfaced_at into v_first, v_last
      from public.discovery_capability_demand
     where dimension_key = 'money_out' and capability = 'planned_legal';

    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> '__undo_probe__' then raise; end if;
  end;

  if v_seen_heard_gap2 is not true then
    raise exception '738: regression — discovery_capability_demand no longer reports a heard gap dimension';
  end if;
  if v_seen_skipped_gap2 is not false then
    raise exception '738: regression — discovery_capability_demand now reports a skipped dimension as demand';
  end if;
  if v_seen_nongap2 is not false then
    raise exception '738: regression — discovery_capability_demand now reports a non-gap dimension as demand';
  end if;
  if v_first is null or date_part('year', v_first) <> 2020 then
    raise exception '738: first_surfaced_at is not sourced from the coverage entry''s recorded_at (got %, the session''s created_at was 1999-01-01)', v_first;
  end if;
  if v_last is null or date_part('year', v_last) <> 2020 then
    raise exception '738: last_surfaced_at is not sourced from the coverage entry''s recorded_at (got %, the session''s created_at was 1999-01-01)', v_last;
  end if;

  ------------------------------------------------------------------------
  -- 5. No probe row survives. Red if: any rollback above is broken.
  ------------------------------------------------------------------------
  select count(*) into v_leftover from public.discovery_sessions;
  if v_leftover <> 0 then
    raise exception '738: % probe row(s) survived in discovery_sessions — a rollback in this block is broken', v_leftover;
  end if;

  select count(*) into v_leftover from public.discovery_proposals;
  if v_leftover <> 0 then
    raise exception '738: % probe row(s) survived in discovery_proposals — a rollback in this block is broken', v_leftover;
  end if;

  raise notice '738: all checks passed — coverage states reject non-string types under service_role''s real grant; record_dimension_state''s own NULL guard fires before the table CHECK; demand view provenance reads recorded_at; no probe rows survive';
end $$;

commit;
