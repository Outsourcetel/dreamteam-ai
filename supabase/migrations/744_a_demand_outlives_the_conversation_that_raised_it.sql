-- 744_a_demand_outlives_the_conversation_that_raised_it.sql
-- ==========================================================================
-- WHY: the one signal telling us what customers need and we cannot build was
-- a VIEW over live session rows, so tidying up a workspace erased it.
--
-- The founder's requirement, verbatim (2026-08-15): *"the same flag to us at
-- platform level so we know what customer asked for that need our attention
-- to build or evaluate."*
--
-- `discovery_capability_demand` was:
--
--     FROM discovery_capability_gaps g
--     CROSS JOIN LATERAL unnest(g.planned_archetypes)
--     JOIN discovery_sessions s ON (s.coverage -> g.dimension_key ->> 'state') = 'heard'
--
-- — every number computed from `discovery_sessions.coverage` at read time.
-- PROVEN, not theorised: clearing three review-lab sessions on 2026-08-15 took
-- it from 4 rows to 0, losing planned_hr, planned_legal, planned_procurement
-- and planned_qa along with the dimension each was surfaced by.
--
-- Nothing was corrupted — a view holds no data of its own. That IS the defect.
-- The evidence had exactly the lifetime of the conversation that produced it,
-- so it disappears when:
--   · a workspace's sessions are cleaned up (what happened);
--   · a tenant is OFFBOARDED — precisely the customer whose unmet need is most
--     worth knowing about, and the one case where the row must outlive
--     everything around it;
--   · a session is abandoned and later swept.
--
-- ⚠ THE WRONG FIX IS TO STOP DELETING SESSIONS. The lifetime of the evidence
-- and the lifetime of the conversation are different questions, and conflating
-- them turns every tidy-up into a data-loss event. This migration separates
-- them: the conversation stays disposable, the demand does not.
--
-- ==========================================================================
-- WHAT IS AND IS NOT DERIVED
--
-- `discovery_capability_gaps` stays a view and should. It is the CATALOGUE —
-- which active dimensions name a `planned_` archetype — i.e. a statement about
-- what THIS PRODUCT cannot staff today. That is correctly recomputed: build
-- the capability, drop the `planned_` key, and the gap should vanish on its
-- own.
--
-- Demand is the opposite kind of fact. "A customer asked for this on this day"
-- is history. History is stored, never recomputed.
--
-- ==========================================================================
-- WHY THE LOG CARRIES NO FOREIGN KEYS, AND WHY THAT IS THE POINT
--
-- `tenant_id`, `session_id` and `dimension_key` are plain columns. A foreign
-- key to `tenants`, `discovery_sessions` or `discovery_dimensions` would
-- reintroduce exactly the coupling this migration exists to break — an ON
-- DELETE CASCADE would delete the demand, and an ON DELETE RESTRICT would make
-- the demand block the cleanup, which is worse.
--
-- The consequence is that these ids can dangle, ON PURPOSE. So the labels are
-- DENORMALISED at write time: a tenant uuid is meaningless once the tenant row
-- is gone, and a dimension key tells you nothing once the dimension is
-- retired. `tenant_label` and `dimension_title` are snapshots of what those
-- things were called when the customer asked.
--
-- Probe 3 below asserts the ABSENCE of any foreign key on this table. That is
-- deliberate: it is the only way a design decision this counter-intuitive
-- survives the next person who notices the "missing" constraint and helpfully
-- adds it.
--
-- ==========================================================================
-- WHY A TRIGGER AND NOT A WRITE IN THE EDGE FUNCTION
--
-- Three functions write `discovery_sessions.coverage`: record_dimension_state,
-- start_discovery_session and end_discovery_session. A capture that lives in
-- the edge function is one an future writer can forget, and this repository's
-- own law is that a measure must be emitted by the path it measures, not by a
-- caller who remembers to. The trigger fires for every writer that exists now
-- and every one added later.
-- ==========================================================================

create table if not exists public.discovery_capability_demand_log (
  id              uuid primary key default gen_random_uuid(),
  -- ⚠ NO FOREIGN KEYS ON THE NEXT THREE. See the header. Probe 3 pins it.
  tenant_id       uuid        not null,
  session_id      uuid        not null,
  dimension_key   text        not null,
  -- Denormalised because the ids above are allowed to dangle.
  tenant_label    text        not null,
  dimension_title text        not null,
  capability      text        not null,
  -- What the customer actually said. This is the whole value of the record for
  -- deciding whether to build the thing — a count tells you how often, this
  -- tells you what for.
  evidence        text,
  surfaced_at     timestamptz not null default now()
);

comment on table public.discovery_capability_demand_log is
  'Append-only history of a customer surfacing a need this product cannot staff. Deliberately carries NO foreign keys: the row must outlive the session, the dimension and the tenant that produced it. See migration 744.';

-- One row per (session, capability, dimension). Coverage is rewritten on every
-- interview turn, so without this the trigger would append a duplicate per turn.
create unique index if not exists discovery_capability_demand_log_once
  on public.discovery_capability_demand_log (session_id, capability, dimension_key);

create index if not exists discovery_capability_demand_log_capability_idx
  on public.discovery_capability_demand_log (capability, surfaced_at desc);

-- ── the capture ──────────────────────────────────────────────────────────
create or replace function public.capture_capability_demand()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_label text;
begin
  -- Coverage is rewritten every turn; only look when it actually moved.
  if tg_op = 'UPDATE' and new.coverage is not distinct from old.coverage then
    return new;
  end if;

  select coalesce(nullif(btrim(t.name), ''), nullif(btrim(t.slug), ''), new.tenant_id::text)
    into v_label
    from tenants t where t.id = new.tenant_id;
  v_label := coalesce(v_label, new.tenant_id::text);

  insert into discovery_capability_demand_log
    (tenant_id, session_id, dimension_key, tenant_label, dimension_title, capability, evidence)
  select new.tenant_id, new.id, g.dimension_key, v_label, g.title, cap.a,
         left(nullif(btrim(coalesce(new.coverage -> g.dimension_key ->> 'evidence', '')), ''), 500)
    from discovery_capability_gaps g
    cross join lateral unnest(g.planned_archetypes) cap(a)
   where (new.coverage -> g.dimension_key ->> 'state') = 'heard'
  on conflict (session_id, capability, dimension_key) do nothing;

  return new;
end;
$fn$;

comment on function public.capture_capability_demand() is
  'Writes discovery_capability_demand_log when a dimension naming a planned_ archetype is marked heard. On the trigger rather than in a caller so no writer of coverage can forget it.';

drop trigger if exists discovery_sessions_capture_demand on public.discovery_sessions;
create trigger discovery_sessions_capture_demand
  after insert or update of coverage on public.discovery_sessions
  for each row execute function public.capture_capability_demand();

-- ── backfill from whatever sessions still exist ──────────────────────────
-- Zero rows on this database today (the review lab was cleared before this
-- migration was written), and correct anywhere it is not.
insert into public.discovery_capability_demand_log
  (tenant_id, session_id, dimension_key, tenant_label, dimension_title, capability, evidence, surfaced_at)
select s.tenant_id, s.id, g.dimension_key,
       coalesce(nullif(btrim(t.name), ''), nullif(btrim(t.slug), ''), s.tenant_id::text),
       g.title, cap.a,
       left(nullif(btrim(coalesce(s.coverage -> g.dimension_key ->> 'evidence', '')), ''), 500),
       coalesce((s.coverage -> g.dimension_key ->> 'recorded_at')::timestamptz, s.created_at)
  from discovery_sessions s
  join discovery_capability_gaps g
    on (s.coverage -> g.dimension_key ->> 'state') = 'heard'
  cross join lateral unnest(g.planned_archetypes) cap(a)
  left join tenants t on t.id = s.tenant_id
on conflict (session_id, capability, dimension_key) do nothing;

-- ── the view now reads history, not live sessions ────────────────────────
-- Same column names, order and types, so `create or replace` is legal and no
-- reader changes. Counts stay integer.
create or replace view public.discovery_capability_demand as
  select l.capability,
         l.dimension_key,
         l.dimension_title,
         count(distinct l.tenant_id)::integer  as tenants_surfaced,
         count(distinct l.session_id)::integer as sessions_surfaced,
         min(l.surfaced_at)                    as first_surfaced_at,
         max(l.surfaced_at)                    as last_surfaced_at
    from public.discovery_capability_demand_log l
   group by l.capability, l.dimension_key, l.dimension_title;

-- ── perimeter ────────────────────────────────────────────────────────────
-- APPEND-ONLY, and platform-only. The trigger is SECURITY DEFINER owned by
-- postgres, so it inserts regardless of these grants; nothing else may write
-- at all, and NOBODY may UPDATE or DELETE — including service_role, because a
-- history somebody can edit is not a history. Only a migration can ever
-- change what is here.
revoke all on table public.discovery_capability_demand_log from public, anon, authenticated;
grant select on table public.discovery_capability_demand_log to service_role;
revoke all on function public.capture_capability_demand() from public, anon, authenticated;

-- The demand view was already postgres + service_role only. Re-assert, because
-- `create or replace view` preserves grants and a silent widening here would
-- expose one tenant's stated needs to every other.
revoke all on table public.discovery_capability_demand from public, anon, authenticated;
grant select on table public.discovery_capability_demand to service_role;

alter table public.discovery_capability_demand_log enable row level security;
-- No policy, deliberately: RLS with no policy denies everyone except the table
-- owner and anything running SECURITY DEFINER as it. There is no tenant-facing
-- read of this table by design — a workspace sees its own unmet need through
-- discovery_capability_gaps' customer_message, never the cross-tenant tally.

-- ==========================================================================
-- VERIFICATION
--
-- The claim worth proving is NOT "a row appears". It is "the row is still
-- there after everything that used to erase it is gone". Probe 2 is the
-- migration; the rest stop it being an over-capture.
-- ==========================================================================
do $$
declare
  v_tenant     uuid;
  v_session    uuid;
  v_gap_dim    text;
  v_gap_cap    text;
  v_plain_dim  text;
  v_before     bigint;
  v_after      bigint;
  v_rows       integer;
  v_dupes      integer;
  v_view_rows  integer;
  v_fkeys      integer;
  v_bad        text[] := '{}';
begin
  select count(*) into v_before from public.discovery_capability_demand_log;

  select id into v_tenant from tenants
   where id <> 'a0000000-0000-0000-0000-000000000001' and name not like '[TEST DEBRIS%'
   order by created_at limit 1;
  if v_tenant is null then raise exception '744: no tenant to probe with'; end if;

  -- A dimension that DOES name a planned_ archetype, and one that does not.
  -- Both from live data: if the seed changes, this migration's probes must
  -- follow it rather than silently testing nothing.
  select g.dimension_key, g.planned_archetypes[1] into v_gap_dim, v_gap_cap
    from public.discovery_capability_gaps g order by g.dimension_key limit 1;
  select d.key into v_plain_dim
    from discovery_dimensions d
   where d.active and not exists (select 1 from unnest(d.serves_archetypes) a where a ~ '^planned_')
   order by d.key limit 1;
  if v_gap_dim is null or v_gap_cap is null then
    raise exception '744 vacuity guard: no dimension names a planned_ archetype, so there is no demand to capture and every probe below would pass over nothing';
  end if;
  if v_plain_dim is null then
    raise exception '744 vacuity guard: EVERY active dimension names a planned_ archetype — probe 4 could not tell capture-when-owed from capture-always';
  end if;

  begin
    insert into discovery_sessions (tenant_id) values (v_tenant) returning id into v_session;

    -- ---- PROBE 1: marking a gap-bearing dimension heard captures it -------
    update discovery_sessions
       set coverage = jsonb_build_object(
             v_gap_dim,   jsonb_build_object('state','heard','evidence','we need somebody on this and have nobody'),
             v_plain_dim, jsonb_build_object('state','heard','evidence','this one we already staff'))
     where id = v_session;

    select count(*) into v_rows from public.discovery_capability_demand_log
     where session_id = v_session and capability = v_gap_cap and dimension_key = v_gap_dim;
    if v_rows <> 1 then
      v_bad := v_bad || format('marking %L heard produced %s log row(s) for %L, expected 1 — the trigger is not capturing', v_gap_dim, v_rows, v_gap_cap);
    end if;

    -- ---- PROBE 4 (here, while the session exists): NOT an over-capture ----
    -- A dimension with no planned_ archetype must contribute nothing. Without
    -- this, a trigger that logged every heard dimension would pass probe 1.
    if exists (select 1 from public.discovery_capability_demand_log
                where session_id = v_session and dimension_key = v_plain_dim) then
      v_bad := v_bad || format('a dimension with no planned_ archetype (%L) produced a demand row — the capture is not restricted to real gaps', v_plain_dim);
    end if;

    -- ---- PROBE 5: idempotent across turns --------------------------------
    -- Coverage is rewritten every turn. Re-writing the same state must not
    -- append a second row, or a long interview inflates its own demand.
    -- Rewritten the way a real turn rewrites it — the evidence sharpens as the
    -- customer says more, the state stays 'heard'. A synthetic marker key would
    -- have tested a shape production never produces.
    update discovery_sessions
       set coverage = jsonb_set(coverage, array[v_gap_dim, 'evidence'],
                                to_jsonb('we need somebody on this and have nobody, and it is getting worse'::text))
     where id = v_session;
    update discovery_sessions
       set coverage = jsonb_set(coverage, array[v_gap_dim, 'evidence'],
                                to_jsonb('we need somebody on this, nobody owns it, third time it has bitten us'::text))
     where id = v_session;
    select count(*) into v_dupes from public.discovery_capability_demand_log
     where session_id = v_session and capability = v_gap_cap and dimension_key = v_gap_dim;
    if v_dupes <> 1 then
      v_bad := v_bad || format('after three coverage writes the log holds %s row(s) for one capability — repeated turns inflate the demand count', v_dupes);
    end if;

    -- ---- PROBE 2: THE MIGRATION. Delete the session; the demand survives --
    delete from discovery_sessions where id = v_session;
    select count(*) into v_rows from public.discovery_capability_demand_log
     where session_id = v_session and capability = v_gap_cap;
    if v_rows <> 1 then
      v_bad := v_bad || 'the demand row did NOT survive deletion of its session — this migration has achieved nothing, which is the whole and only point of it';
    end if;

    -- ---- PROBE 6: and the VIEW still reports it --------------------------
    -- The row surviving is not enough if the view still joins to sessions.
    select count(*) into v_view_rows from public.discovery_capability_demand
     where capability = v_gap_cap and dimension_key = v_gap_dim;
    if v_view_rows < 1 then
      v_bad := v_bad || 'the log kept the row but discovery_capability_demand does not report it — the view is still reading live sessions';
    end if;

    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception when others then
    if sqlerrm <> '__undo_probe__' then raise; end if;
  end;

  -- ---- PROBE 3: the ABSENCE of foreign keys is the design ---------------
  -- Not a stylistic assertion. Any FK here re-couples the demand to something
  -- that gets deleted, which is the defect. This is what stops a future reader
  -- "fixing" the missing constraint.
  select count(*) into v_fkeys from pg_constraint
   where conrelid = 'public.discovery_capability_demand_log'::regclass and contype = 'f';
  if v_fkeys <> 0 then
    v_bad := v_bad || format('%s foreign key(s) exist on discovery_capability_demand_log — a demand that cascades away with its session, dimension or tenant is the bug this migration was written to remove', v_fkeys);
  end if;

  -- ---- rollback integrity ----------------------------------------------
  select count(*) into v_after from public.discovery_capability_demand_log;
  if v_before <> v_after then
    v_bad := v_bad || format('the log went from %s to %s row(s) — the probe did not roll back and this migration has left test demand in production', v_before, v_after);
  end if;

  -- ---- perimeter --------------------------------------------------------
  if has_table_privilege('authenticated', 'public.discovery_capability_demand_log', 'SELECT')
     or has_table_privilege('authenticated', 'public.discovery_capability_demand', 'SELECT') then
    v_bad := v_bad || 'authenticated can read the demand log or its view — this is a CROSS-TENANT tally of what customers cannot get, and one workspace must never see another''s';
  end if;
  if has_table_privilege('service_role', 'public.discovery_capability_demand_log', 'UPDATE')
     or has_table_privilege('service_role', 'public.discovery_capability_demand_log', 'DELETE') then
    v_bad := v_bad || 'service_role can UPDATE or DELETE the demand log — a history somebody can edit is not a history';
  end if;
  if not has_table_privilege('service_role', 'public.discovery_capability_demand_log', 'SELECT') then
    v_bad := v_bad || 'service_role cannot read the demand log — the platform signal is unreadable by the platform';
  end if;

  if array_length(v_bad, 1) > 0 then
    raise exception '744: % check(s) failed: %', array_length(v_bad, 1), array_to_string(v_bad, ' | ');
  end if;

  raise notice '744: all checks passed — a demand captured from a heard gap dimension survived the deletion of its session and is still reported by the view; a non-gap dimension captured nothing; three coverage writes produced one row; no foreign keys; % row(s) before and after',
    v_after;
end $$;
