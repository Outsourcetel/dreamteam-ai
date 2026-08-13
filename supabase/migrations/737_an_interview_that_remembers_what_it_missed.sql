-- 737_an_interview_that_remembers_what_it_missed.sql
-- ==========================================================================
-- WHY: Task 1 (733-736) built the SPINE — 14 seeded dimensions deciding WHAT
-- a discovery interview must cover, and discovery_capability_gaps, deriving
-- which of those dimensions name a role this product cannot staff yet. This
-- is Task 2: the MEMORY. A conversation needs somewhere to record, per
-- dimension, whether it was actually heard, parked for later, told to skip,
-- or never reached — and somewhere to put what the conversation proposes
-- building as a result. Nothing here talks to a customer; that is the
-- conversation engine, later work this ledger is built to support.
--
-- FOUR STATES, NOT THREE. 'parked' ("ask me later", still owed a question)
-- and 'skipped' ("not relevant to this business", not owed one) are
-- routinely the same bit in systems like this, and collapsing them breaks
-- two different real conversations: nagging someone who deliberately
-- declined a topic, and burying one they meant to come back to. The CHECK
-- constraint, and record_dimension_state's own validation, both refuse to
-- treat them as interchangeable — proven below by actually persisting both
-- and reading back two DIFFERENT stored values, not just by grepping the
-- function source for both words.
--
-- SEEDED, NOT GROWN. start_discovery_session writes every ACTIVE dimension
-- key into coverage as not_heard in the same statement that creates the
-- session. A dimension the interview never reaches must read identically to
-- a dimension the ledger forgot to mention — the only way to guarantee that
-- is for the key to already be there, at not_heard, from turn zero, so a
-- missing key and an unaddressed dimension can never be confused.
--
-- PROPOSALS, DELIBERATELY UNCOUPLED. discovery_proposals carries no
-- human_task_id, no action_execution_id — checked by both the vitest suite
-- (information_schema, against the live schema) and, structurally, by this
-- migration never adding either column. The Onboarding Architect's
-- proposals went into action_executions, the same queue as day-to-day
-- operational approvals, and 19 of 26 are still sitting there undecided.
-- Setup approval is a different decision, made by a different person, on a
-- different timescale, and belongs in the setup flow — not mixed into the
-- queue an ops team is already drowning in.
--
-- THE SECOND HALF OF THE FOUNDER RULING. Task 1 shipped the first half: a
-- customer who describes work this product cannot staff yet is told, in the
-- same breath, that it will be built around what they described
-- (discovery_capability_gaps.customer_message). The second half — flagging
-- the PLATFORM so real demand is visible across tenants, not just
-- acknowledged to the one customer who asked — needed sessions to exist,
-- which is why it waited for this task. discovery_capability_demand below
-- is that flag: a plain derived VIEW, not a stored counter, not a cron job,
-- not an alert. It joins discovery_capability_gaps (which dimensions name an
-- unbuilt role) against discovery_sessions.coverage (which of those
-- dimensions a REAL interview actually marked heard) and reports nothing
-- else. A capability nobody has ever actually surfaced does not appear —
-- there is nothing to flag yet. Grain is (capability, dimension), one row
-- per planned_ role per dimension that named it, because a future dimension
-- naming the SAME planned_ role a second time should show up as its own
-- provenance, not silently merge into one count. Only the 'heard' state
-- counts as a real ask: 'skipped' is a customer explicitly saying this does
-- not apply to them, the opposite of demand, and 'parked'/'not_heard' are
-- not yet evidence of anything. service_role only — this aggregates across
-- EVERY tenant by design, which is exactly the shape of cross-tenant read an
-- ordinary tenant-scoped `authenticated` session must never be able to run
-- (the cross-tenant perimeter this codebase has had to re-fence more than
-- once).
-- A future Platform Console page over this needs its own
-- resolve_platform_capability-gated wrapper function, the same way
-- audit_tenant_provisioning wraps audit_tenant_feature_parity — not a
-- broadened grant on the view itself.
--
-- THE TRAP THIS MIGRATION IS WRITTEN AGAINST. Every check below is written
-- to name, in its own failure message, the exact data that would turn it
-- red — a FK or NOT NULL that would fire before the CHECK under test is
-- deliberately avoided (728's lesson: probe with a REAL tenant, and give a
-- malformed row exactly one way to fail); the parked/skipped proof reads
-- back an ACTUAL persisted value rather than trusting the function's source
-- text; the demand view is proven to discriminate in three directions at
-- once (heard-gap present, skipped-gap absent, heard-non-gap absent) and to
-- start genuinely empty, which only holds if its join is INNER, not LEFT.
-- Every probe writes through a real INSERT and is undone by raising a
-- sentinel SQLSTATE inside its own sub-block — never a bare ROLLBACK, and
-- never left to commit — and the very last checks in this file recount both
-- new tables from scratch and refuse to commit if either holds a single row.
-- ==========================================================================

begin;

-- ---------------------------------------------------------------------------
-- discovery_sessions — the coverage ledger for one interview.
-- ---------------------------------------------------------------------------
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
  -- The brief's literal shape for this constraint used
  -- `not exists (select 1 from jsonb_each(coverage) e where ...)` — Postgres
  -- refuses that outright (0A000: cannot use subquery in check constraint),
  -- even though the subquery only ever touches the row's own column. Proven
  -- live against production before writing this: the CREATE TABLE failed
  -- exactly there, nothing landed. jsonb_path_exists is the subquery-free
  -- equivalent — a single function call over a jsonpath literal, which IS
  -- allowed — and it keeps all four state words in the constraint's own
  -- text (checked below and by the vitest suite via pg_get_constraintdef,
  -- which is why this isn't hidden behind a helper function instead).
  constraint discovery_sessions_coverage_states check (
    not jsonb_path_exists(coverage,
      '$.*.state ? (@ != "heard" && @ != "parked" && @ != "skipped" && @ != "not_heard")')
  )
);

create index if not exists discovery_sessions_tenant_idx on public.discovery_sessions(tenant_id);

alter table public.discovery_sessions enable row level security;
drop policy if exists discovery_sessions_tenant_read on public.discovery_sessions;
create policy discovery_sessions_tenant_read on public.discovery_sessions
  for select to authenticated using (tenant_id = public.auth_tenant_id());

-- Members read their own workspace's sessions; nobody writes through the
-- table from the browser. The interview is driven server-side (service
-- role) — no INSERT/UPDATE/DELETE policy for authenticated is deliberate,
-- matching playbook_gaps (712).
revoke all on public.discovery_sessions from public, anon;
revoke insert, update, delete on public.discovery_sessions from authenticated;
grant select on public.discovery_sessions to authenticated, service_role;
grant insert, update, delete on public.discovery_sessions to service_role;

drop trigger if exists discovery_sessions_updated_at on public.discovery_sessions;
create trigger discovery_sessions_updated_at
  before update on public.discovery_sessions
  for each row execute function update_updated_at();

-- ---------------------------------------------------------------------------
-- discovery_proposals — what a session proposes building. Deliberately no
-- human_task_id, no action_execution_id: see WHY above.
-- ---------------------------------------------------------------------------
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

create index if not exists discovery_proposals_tenant_idx on public.discovery_proposals(tenant_id);
create index if not exists discovery_proposals_session_idx on public.discovery_proposals(session_id);

alter table public.discovery_proposals enable row level security;
drop policy if exists discovery_proposals_tenant_read on public.discovery_proposals;
create policy discovery_proposals_tenant_read on public.discovery_proposals
  for select to authenticated using (tenant_id = public.auth_tenant_id());

revoke all on public.discovery_proposals from public, anon;
revoke insert, update, delete on public.discovery_proposals from authenticated;
grant select on public.discovery_proposals to authenticated, service_role;
grant insert, update, delete on public.discovery_proposals to service_role;

-- ---------------------------------------------------------------------------
-- start_discovery_session — seeds coverage from EVERY active dimension as
-- not_heard, in the same insert that creates the row, so a dimension the
-- interview never reaches is indistinguishable from nothing at all only in
-- the sense that both mean "not covered yet" — never in the sense of the KEY
-- being absent.
-- ---------------------------------------------------------------------------
create or replace function public.start_discovery_session(p_tenant_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_session_id uuid;
  v_coverage   jsonb;
begin
  if p_tenant_id is null then
    raise exception 'start_discovery_session requires a tenant';
  end if;
  if not exists (select 1 from public.tenants where id = p_tenant_id) then
    raise exception 'unknown tenant: %', p_tenant_id;
  end if;

  select coalesce(
           jsonb_object_agg(d.key, jsonb_build_object('state', 'not_heard', 'evidence', null)),
           '{}'::jsonb
         )
    into v_coverage
    from public.discovery_dimensions d
   where d.active;

  insert into public.discovery_sessions (tenant_id, status, coverage, created_by)
  values (p_tenant_id, 'running', v_coverage, auth.uid())
  returning id into v_session_id;

  return v_session_id;
end;
$function$;

revoke all on function public.start_discovery_session(uuid) from public, anon, authenticated;
grant execute on function public.start_discovery_session(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- record_dimension_state — the one place coverage changes after session
-- start. Validates the state against the same four values the table CHECK
-- enforces (belt and braces: a caller gets told WHICH thing it got wrong),
-- refuses an unknown or inactive dimension key, and writes 'parked' and
-- 'skipped' exactly as given — neither is ever rewritten into the other.
-- ---------------------------------------------------------------------------
create or replace function public.record_dimension_state(p_session_id uuid, p_dimension text, p_state text, p_evidence text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
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

revoke all on function public.record_dimension_state(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.record_dimension_state(uuid, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- discovery_capability_demand — the platform half of the founder ruling.
-- Derived, not stored: one row per (capability, dimension) that a REAL
-- session actually marked 'heard'. A capability nobody has surfaced yet
-- simply does not appear — this is a signal, not a catalogue. service_role
-- only: this is a cross-tenant read by construction, never a per-tenant one.
-- ---------------------------------------------------------------------------
create or replace view public.discovery_capability_demand as
  select
    cap.capability,
    g.dimension_key,
    g.title                           as dimension_title,
    count(distinct s.tenant_id)::int  as tenants_surfaced,
    count(distinct s.id)::int         as sessions_surfaced,
    min(s.created_at)                 as first_surfaced_at,
    max(s.created_at)                 as last_surfaced_at
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
  'tenant by design.';

revoke all on public.discovery_capability_demand from public, anon, authenticated;
grant select on public.discovery_capability_demand to service_role;

-- ---------------------------------------------------------------------------
-- Verification. Every assertion below states, in its own failure message,
-- the data that would turn it red. All probes write through a real INSERT
-- (or a real function call) and are undone by raising a sentinel SQLSTATE
-- inside their own sub-block before the migration reaches COMMIT.
-- ---------------------------------------------------------------------------
do $$
declare
  v_tenant             uuid;
  v_active_dims        int;

  v_session_id         uuid;
  v_coverage_keys      int;
  v_all_not_heard      boolean;

  v_rt_session         uuid;
  v_park_state         text;
  v_skip_state         text;
  v_rejected_dim       boolean := false;
  v_rejected_state     boolean := false;

  v_prop_kind_rejected boolean := false;

  v_demand_before      int;
  v_seen_heard_gap     boolean;
  v_seen_skipped_gap   boolean;
  v_seen_nongap        boolean;

  v_bad                text[] := '{}';
  v_n_wp               int;
  v_leftover           int;
begin
  select id into v_tenant from public.tenants limit 1;
  if v_tenant is null then
    raise exception '737: no tenant exists to probe with — cannot prove any of this';
  end if;

  select count(*) into v_active_dims from public.discovery_dimensions where active;
  if v_active_dims = 0 then
    raise exception '737: no active discovery dimensions — start_discovery_session has nothing to seed from';
  end if;

  if not exists (select 1 from public.discovery_dimensions where key = 'money_out' and active)
     or not exists (select 1 from public.discovery_dimensions where key = 'the_workforce_itself' and active)
     or not exists (select 1 from public.discovery_dimensions where key = 'what_we_do' and active) then
    raise exception '737 vacuity guard: money_out / the_workforce_itself / what_we_do are not all active — the probes below would prove nothing';
  end if;

  ------------------------------------------------------------------------
  -- 1. start_discovery_session seeds every active dimension as not_heard.
  --    Red if: the coverage key count is not exactly the active dimension
  --    count, or any seeded entry is not 'not_heard'.
  ------------------------------------------------------------------------
  begin
    v_session_id := public.start_discovery_session(v_tenant);

    select count(*), bool_and(e.value->>'state' = 'not_heard')
      into v_coverage_keys, v_all_not_heard
      from public.discovery_sessions s, jsonb_each(s.coverage) e
     where s.id = v_session_id;

    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> '__undo_probe__' then raise; end if;
  end;

  if v_coverage_keys <> v_active_dims then
    raise exception '737: start_discovery_session seeded % coverage key(s), expected % (active dimension count)', v_coverage_keys, v_active_dims;
  end if;
  if not coalesce(v_all_not_heard, false) then
    raise exception '737: start_discovery_session left at least one dimension NOT marked not_heard at session start';
  end if;

  ------------------------------------------------------------------------
  -- 2. The four real coverage states are accepted together in one row.
  --    Red if: discovery_sessions_coverage_states refuses any of the four
  --    actual values (check_violation on a well-formed row).
  ------------------------------------------------------------------------
  begin
    insert into public.discovery_sessions (tenant_id, status, coverage)
    values (v_tenant, 'running', jsonb_build_object(
      'd1', jsonb_build_object('state', 'heard'),
      'd2', jsonb_build_object('state', 'parked'),
      'd3', jsonb_build_object('state', 'skipped'),
      'd4', jsonb_build_object('state', 'not_heard')
    ));
    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception
    when check_violation then
      raise exception '737: a row carrying all four real coverage states (heard/parked/skipped/not_heard) was refused by the CHECK';
    when sqlstate 'P0001' then
      if sqlerrm <> '__undo_probe__' then raise; end if;
  end;

  ------------------------------------------------------------------------
  -- 3. A fifth state is refused. A REAL tenant_id, so the FK cannot be the
  --    reason — only the CHECK may refuse this row (728's fix for a probe
  --    that could never fail). Red if: the insert succeeds at all, or fails
  --    for any reason OTHER than check_violation.
  ------------------------------------------------------------------------
  begin
    insert into public.discovery_sessions (tenant_id, status, coverage)
    values (v_tenant, 'running', jsonb_build_object('d1', jsonb_build_object('state', 'maybe_later')));
    raise exception '737: discovery_sessions_coverage_states accepted a fifth state (''maybe_later'') it should have refused';
  exception
    when check_violation then null;  -- the only acceptable outcome
  end;

  ------------------------------------------------------------------------
  -- 4. record_dimension_state persists 'parked' and 'skipped' as genuinely
  --    DIFFERENT stored values (not just that its source text mentions
  --    both — this reads back what was actually written), refuses an
  --    unknown dimension, and refuses a state outside the four. Red if:
  --    either value is missing, wrong, or equal to the other; or either
  --    rejection silently succeeds instead of raising.
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
    exception
      when sqlstate 'P0001' then v_rejected_dim := true;
    end;

    begin
      perform public.record_dimension_state(v_rt_session, 'money_out', 'maybe_later', null);
    exception
      when sqlstate 'P0001' then v_rejected_state := true;
    end;

    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> '__undo_probe__' then raise; end if;
  end;

  if v_park_state is distinct from 'parked' then
    raise exception '737: record_dimension_state(..., ''parked'', ...) did not persist "parked" (got %)', coalesce(v_park_state, 'NULL');
  end if;
  if v_skip_state is distinct from 'skipped' then
    raise exception '737: record_dimension_state(..., ''skipped'', ...) did not persist "skipped" (got %)', coalesce(v_skip_state, 'NULL');
  end if;
  if v_park_state = v_skip_state then
    raise exception '737: parked and skipped collapsed to the same stored value — the exact defect this task exists to prevent';
  end if;
  if not v_rejected_dim then
    raise exception '737: record_dimension_state accepted an unknown dimension key (''__no_such_dimension__'')';
  end if;
  if not v_rejected_state then
    raise exception '737: record_dimension_state accepted a state (''maybe_later'') outside the four';
  end if;

  ------------------------------------------------------------------------
  -- 5. discovery_proposals refuses a kind outside the six named ones. A
  --    well-formed 'employee' proposal is inserted first (its own proof:
  --    reaching the next statement without error IS the assertion — an
  --    explicit post-hoc null-check here would be unreachable dead code,
  --    since a failed insert aborts the block before any such check could
  --    run). Red if: the bad-kind insert succeeds, or fails for a reason
  --    other than check_violation.
  ------------------------------------------------------------------------
  begin
    insert into public.discovery_sessions (tenant_id, status, coverage)
    values (v_tenant, 'running', '{}'::jsonb)
    returning id into v_rt_session;

    insert into public.discovery_proposals (session_id, tenant_id, kind, payload, source_dimension, state)
    values (v_rt_session, v_tenant, 'employee', '{"title":"probe"}'::jsonb, 'money_out', 'pending');

    begin
      insert into public.discovery_proposals (session_id, tenant_id, kind, payload, source_dimension, state)
      values (v_rt_session, v_tenant, 'sandwich', '{}'::jsonb, 'money_out', 'pending');
      raise exception '737: discovery_proposals accepted an invalid kind (''sandwich'') it should have refused';
    exception
      when check_violation then v_prop_kind_rejected := true;
    end;

    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> '__undo_probe__' then raise; end if;
  end;

  if not v_prop_kind_rejected then
    raise exception '737: discovery_proposals kind CHECK did not fire as expected';
  end if;

  ------------------------------------------------------------------------
  -- 6. discovery_capability_demand. Three cases in one probe session:
  --      * money_out actually HEARD (a real capability gap)  -> must appear
  --      * the_workforce_itself SKIPPED (also a gap, but declined)
  --                                                            -> must NOT
  --      * what_we_do HEARD (real archetypes, not a gap at all) -> must NOT
  --    Red if: the skipped-gap case appears (state filter loosened from
  --    'heard' to anything else), the non-gap case appears (joined
  --    discovery_dimensions instead of discovery_capability_gaps), or the
  --    heard-gap case is absent (join predicate broken). The pre-probe
  --    zero-count check is red if the view lists capabilities with no
  --    session evidence at all — which only happens if its join is LEFT,
  --    not INNER.
  ------------------------------------------------------------------------
  if not exists (select 1 from public.discovery_capability_gaps where dimension_key = 'money_out')
     or not exists (select 1 from public.discovery_capability_gaps where dimension_key = 'the_workforce_itself')
     or exists (select 1 from public.discovery_capability_gaps where dimension_key = 'what_we_do') then
    raise exception '737 vacuity guard: the demand-view probe''s assumptions about which dimensions are/are not capability gaps no longer hold';
  end if;

  select count(*) into v_demand_before from public.discovery_capability_demand;
  if v_demand_before <> 0 then
    raise exception '737: discovery_capability_demand reports % row(s) before any discovery session exists — it is listing gaps, not evidence', v_demand_before;
  end if;

  begin
    insert into public.discovery_sessions (tenant_id, status, coverage)
    values (v_tenant, 'running', jsonb_build_object(
      'money_out',            jsonb_build_object('state', 'heard',   'evidence', 'probe: real gap, actually heard'),
      'the_workforce_itself', jsonb_build_object('state', 'skipped', 'evidence', 'probe: real gap, but skipped'),
      'what_we_do',           jsonb_build_object('state', 'heard',   'evidence', 'probe: heard, but not a capability gap')
    ));

    select exists (
      select 1 from public.discovery_capability_demand
       where dimension_key = 'money_out' and capability = 'planned_legal'
    ) into v_seen_heard_gap;

    select exists (
      select 1 from public.discovery_capability_demand where dimension_key = 'the_workforce_itself'
    ) into v_seen_skipped_gap;

    select exists (
      select 1 from public.discovery_capability_demand where dimension_key = 'what_we_do'
    ) into v_seen_nongap;

    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> '__undo_probe__' then raise; end if;
  end;

  if v_seen_heard_gap is not true then
    raise exception '737: discovery_capability_demand did NOT report a gap dimension that was actually heard (money_out / planned_legal)';
  end if;
  if v_seen_skipped_gap is not false then
    raise exception '737: discovery_capability_demand reported a SKIPPED dimension as demand — skipped means not relevant, the opposite of a real ask';
  end if;
  if v_seen_nongap is not false then
    raise exception '737: discovery_capability_demand reported a dimension with no capability gap (what_we_do) as unbuilt-capability demand';
  end if;

  ------------------------------------------------------------------------
  -- 7. Perimeter, both tables + the view + both functions, both directions.
  --    Red if: any grant/policy above was written backwards.
  ------------------------------------------------------------------------
  if not (select relrowsecurity from pg_class where oid = 'public.discovery_sessions'::regclass) then
    raise exception '737: RLS not enabled on discovery_sessions';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.discovery_proposals'::regclass) then
    raise exception '737: RLS not enabled on discovery_proposals';
  end if;

  select count(*) into v_n_wp from pg_policy
   where polrelid in ('public.discovery_sessions'::regclass, 'public.discovery_proposals'::regclass)
     and polcmd in ('a','w','d','*');
  if v_n_wp > 0 then
    raise exception '737: % write polic(ies) exist on the discovery tables — authenticated must have none', v_n_wp;
  end if;

  if has_table_privilege('authenticated', 'public.discovery_sessions', 'INSERT') then v_bad := array_append(v_bad, 'authenticated can INSERT discovery_sessions'); end if;
  if has_table_privilege('authenticated', 'public.discovery_sessions', 'UPDATE') then v_bad := array_append(v_bad, 'authenticated can UPDATE discovery_sessions'); end if;
  if has_table_privilege('authenticated', 'public.discovery_sessions', 'DELETE') then v_bad := array_append(v_bad, 'authenticated can DELETE discovery_sessions'); end if;
  if not has_table_privilege('authenticated', 'public.discovery_sessions', 'SELECT') then v_bad := array_append(v_bad, 'authenticated CANNOT SELECT discovery_sessions'); end if;
  if not has_table_privilege('service_role', 'public.discovery_sessions', 'INSERT') then v_bad := array_append(v_bad, 'service_role CANNOT INSERT discovery_sessions'); end if;

  if has_table_privilege('authenticated', 'public.discovery_proposals', 'INSERT') then v_bad := array_append(v_bad, 'authenticated can INSERT discovery_proposals'); end if;
  if has_table_privilege('authenticated', 'public.discovery_proposals', 'UPDATE') then v_bad := array_append(v_bad, 'authenticated can UPDATE discovery_proposals'); end if;
  if has_table_privilege('authenticated', 'public.discovery_proposals', 'DELETE') then v_bad := array_append(v_bad, 'authenticated can DELETE discovery_proposals'); end if;
  if not has_table_privilege('authenticated', 'public.discovery_proposals', 'SELECT') then v_bad := array_append(v_bad, 'authenticated CANNOT SELECT discovery_proposals'); end if;
  if not has_table_privilege('service_role', 'public.discovery_proposals', 'INSERT') then v_bad := array_append(v_bad, 'service_role CANNOT INSERT discovery_proposals'); end if;

  if has_table_privilege('anon', 'public.discovery_capability_demand', 'SELECT') then v_bad := array_append(v_bad, 'anon can SELECT discovery_capability_demand'); end if;
  if has_table_privilege('authenticated', 'public.discovery_capability_demand', 'SELECT') then v_bad := array_append(v_bad, 'authenticated can SELECT discovery_capability_demand — cross-tenant leak'); end if;
  if not has_table_privilege('service_role', 'public.discovery_capability_demand', 'SELECT') then v_bad := array_append(v_bad, 'service_role CANNOT SELECT discovery_capability_demand'); end if;

  if has_function_privilege('anon', 'public.start_discovery_session(uuid)', 'execute') then v_bad := array_append(v_bad, 'anon can execute start_discovery_session'); end if;
  if has_function_privilege('authenticated', 'public.start_discovery_session(uuid)', 'execute') then v_bad := array_append(v_bad, 'authenticated can execute start_discovery_session'); end if;
  if not has_function_privilege('service_role', 'public.start_discovery_session(uuid)', 'execute') then v_bad := array_append(v_bad, 'service_role CANNOT execute start_discovery_session'); end if;

  if has_function_privilege('anon', 'public.record_dimension_state(uuid, text, text, text)', 'execute') then v_bad := array_append(v_bad, 'anon can execute record_dimension_state'); end if;
  if has_function_privilege('authenticated', 'public.record_dimension_state(uuid, text, text, text)', 'execute') then v_bad := array_append(v_bad, 'authenticated can execute record_dimension_state'); end if;
  if not has_function_privilege('service_role', 'public.record_dimension_state(uuid, text, text, text)', 'execute') then v_bad := array_append(v_bad, 'service_role CANNOT execute record_dimension_state'); end if;

  if coalesce(array_length(v_bad, 1), 0) > 0 then
    raise exception '737: % perimeter assertion(s) failed: %', array_length(v_bad, 1), array_to_string(v_bad, ' | ');
  end if;

  ------------------------------------------------------------------------
  -- 8. No probe row survives. Red if: any rollback above is broken.
  ------------------------------------------------------------------------
  select count(*) into v_leftover from public.discovery_sessions;
  if v_leftover <> 0 then
    raise exception '737: % probe row(s) survived in discovery_sessions — a rollback in this block is broken', v_leftover;
  end if;

  select count(*) into v_leftover from public.discovery_proposals;
  if v_leftover <> 0 then
    raise exception '737: % probe row(s) survived in discovery_proposals — a rollback in this block is broken', v_leftover;
  end if;

  raise notice '737: all checks passed — % active dimension(s) seeded per session; parked/skipped persist as distinct values; demand view discriminates heard/skipped/non-gap correctly; perimeter clean; no probe rows survive', v_active_dims;
end $$;

commit;
