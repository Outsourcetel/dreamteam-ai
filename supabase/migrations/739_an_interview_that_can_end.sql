-- 739_an_interview_that_can_end.sql
-- ==========================================================================
-- WHY: an interview that parks can never finish, and there was no way to say
-- so out loud.
--
-- Task 2 (737) gave discovery_sessions five statuses — running, proposed,
-- accepted, parked, abandoned — and Task 3 built the turn loop on top. But
-- nothing has ever moved a session out of 'running': `authenticated` holds no
-- UPDATE on the table (deliberately — the interview is driven server-side),
-- and the engine only ever writes coverage and transcript. Three things
-- followed from that, and all three are wrong:
--
--   1. `done` is UNREACHABLE for any interview that parks a dimension.
--      stillOwed() counts 'parked' as still owed — correctly, because parked
--      means "ask me later" — so a customer who parks even one topic can
--      never empty the owed set, and `done` never goes true. The spec (§7)
--      says the whole interview may park and that abandonment mid-interview
--      is "a legitimate end state, not an error". The plan (Task 3 Step 6)
--      says `done` is true when nothing is owed OR THE CALLER STOPS. There
--      was no caller-stops path. This migration is it.
--
--   2. discovery-interview's own 409 `session_not_running` guard was
--      unreachable code — it reads a status no code path could produce. A
--      guard that can never fire looks exactly like a guard that works.
--
--   3. The spec's data-model sketch (§8) lists `resume_hint` on
--      discovery_sessions and it was never built, so a parked interview
--      recorded nothing about where it stopped. Park is only acceptable with
--      a visible home — §7 says that in as many words, against this
--      product's own history of 19 undecided proposals sitting in a pile.
--
-- THE COVERAGE LEDGER IS NOT REWRITTEN. Ending a session is a statement about
-- the CONVERSATION, never about what was heard in it. end_discovery_session
-- touches `status`, `resume_hint` and `updated_at` and nothing else — proven
-- below by snapshotting the coverage jsonb before the call and asserting it
-- comes back identical, not by reading the function's source and believing
-- it. A parked interview resumes to exactly the gaps it had.
--
-- ONCE ENDED, STICKY. Only a 'running' session can be ended. Re-ending into
-- the SAME state is an idempotent no-op (a retried request must not become an
-- error), but 'parked' -> 'abandoned' is refused: reclassifying a finished
-- interview is a decision for a human surface, not a side effect of a retry.
--
-- WHY THE TENANT IS A PARAMETER. This is SECURITY DEFINER and service_role-
-- only, and the tenant id is used ONLY as an extra constraint the row must
-- satisfy — never as the thing that grants access. A bare session_id is not
-- its own authorisation: if a future caller loses its tenant filter, this
-- function still refuses to end another workspace's interview. That is the
-- opposite direction from the cross-tenant hole this codebase has had to
-- re-fence more than once (a SECDEF function TRUSTING a caller's tenant id to
-- decide what it may see); here the parameter can only ever narrow.
--
-- ⚠ NOT AN END STATE: 'proposed' and 'accepted'. Both are legal values of the
-- status column and neither is reachable from here — they mean a session
-- produced proposals and a human acted on them, which is Plan 3b's surface.
-- The probe below deliberately tries 'accepted' precisely BECAUSE the column
-- CHECK would happily accept it: that makes the FUNCTION the only thing that
-- can refuse it, which is the whole point of the assertion. Refusing a value
-- the table would have rejected anyway would have been theatre.
-- ==========================================================================

begin;

-- ---------------------------------------------------------------------------
-- resume_hint — where a parked interview left off, or why an abandoned one
-- stopped. Spec §8 named this column; nothing built it until now.
-- ---------------------------------------------------------------------------
alter table public.discovery_sessions
  add column if not exists resume_hint text;

comment on column public.discovery_sessions.resume_hint is
  'Set when a session is ended via end_discovery_session: for parked, where to pick the conversation back up; '
  'for abandoned, why it stopped. Never written by the turn loop -- coverage and transcript are its only writes.';

-- ---------------------------------------------------------------------------
-- end_discovery_session — the caller-stops path. Moves a running session to a
-- terminal state, records why, and leaves the coverage ledger exactly as the
-- interview left it.
-- ---------------------------------------------------------------------------
create or replace function public.end_discovery_session(
  p_session_id  uuid,
  p_tenant_id   uuid,
  p_status      text,
  p_resume_hint text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_status    text;
  v_tenant    uuid;
begin
  if p_status is null or p_status not in ('parked', 'abandoned') then
    raise exception 'end_discovery_session: % is not an end state — must be ''parked'' (the customer means to come back) or ''abandoned'' (they do not)', coalesce(p_status, 'NULL');
  end if;
  if p_session_id is null or p_tenant_id is null then
    raise exception 'end_discovery_session: both a session and a tenant are required';
  end if;

  select status, tenant_id into v_status, v_tenant
    from public.discovery_sessions
   where id = p_session_id;

  if v_status is null then
    raise exception 'end_discovery_session: unknown discovery session %', p_session_id;
  end if;
  if v_tenant is distinct from p_tenant_id then
    raise exception 'end_discovery_session: session % does not belong to tenant % — a session id is not its own authorisation', p_session_id, p_tenant_id;
  end if;
  if v_status <> 'running' and v_status <> p_status then
    raise exception 'end_discovery_session: session % is already ''%'' — only a running interview can be ended, and a finished one is not reclassified by a retry', p_session_id, v_status;
  end if;

  -- STATUS, HINT, CLOCK. Not coverage. Not transcript. A session that ends
  -- keeps every word of what it heard, and every gap it never closed.
  update public.discovery_sessions
     set status      = p_status,
         resume_hint = coalesce(p_resume_hint, resume_hint),
         updated_at  = now()
   where id = p_session_id;

  return jsonb_build_object(
    'session_id',      p_session_id,
    'status',          p_status,
    'previous_status', v_status,
    'resume_hint',     (select resume_hint from public.discovery_sessions where id = p_session_id)
  );
end;
$function$;

revoke all on function public.end_discovery_session(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.end_discovery_session(uuid, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Verification. Every assertion names, in its own failure message, the data
-- that would turn it red. Probes write through real INSERTs and real function
-- calls and are undone by raising a sentinel SQLSTATE inside their own
-- sub-block; the last check recounts discovery_sessions against a baseline
-- taken before any of them ran, rather than against a hardcoded zero, so it
-- keeps working the day this product has real interviews in it.
-- ---------------------------------------------------------------------------
do $$
declare
  v_tenant           uuid;
  v_other_tenant     uuid;
  v_active_dims      int;
  v_sessions_before  int;
  v_sessions_after   int;

  v_sid              uuid;
  v_cov_before       jsonb;
  v_cov_after        jsonb;
  v_status_after     text;
  v_hint_after       text;
  v_result           jsonb;

  v_abandon_status   text;
  v_idempotent_ok    boolean := false;

  v_rejected_status  boolean := false;
  v_rejected_reend   boolean := false;
  v_rejected_unknown boolean := false;
  v_rejected_tenant  boolean := false;

  v_bad              text[] := '{}';
begin
  select id into v_tenant from public.tenants order by created_at limit 1;
  if v_tenant is null then
    raise exception '739: no tenant exists to probe with — cannot prove any of this';
  end if;
  select id into v_other_tenant from public.tenants where id <> v_tenant limit 1;

  select count(*) into v_active_dims from public.discovery_dimensions where active;
  if v_active_dims = 0 then
    raise exception '739: no active discovery dimensions — start_discovery_session would seed an empty ledger and the coverage-untouched probe would prove nothing';
  end if;
  if not exists (select 1 from public.discovery_dimensions where key = 'money_out' and active) then
    raise exception '739 vacuity guard: money_out is not an active dimension — probe 1 could not put a real ''heard'' on the ledger, so "coverage unchanged" would be a statement about an empty object';
  end if;

  -- Vacuity guard: if the column CHECK did not accept both end states, every
  -- probe below would fail for that reason instead of the one under test.
  if (select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = 'public.discovery_sessions'::regclass
         and conname = 'discovery_sessions_status_check') !~ 'parked'
     or (select pg_get_constraintdef(oid) from pg_constraint
          where conrelid = 'public.discovery_sessions'::regclass
            and conname = 'discovery_sessions_status_check') !~ 'abandoned' then
    raise exception '739 vacuity guard: discovery_sessions.status CHECK no longer admits parked/abandoned — the end states this function moves to do not exist';
  end if;

  select count(*) into v_sessions_before from public.discovery_sessions;

  ------------------------------------------------------------------------
  -- 1. PARK. A running session with real coverage on it moves to 'parked',
  --    records its resume hint, reports its previous status — and its
  --    coverage jsonb comes back BYTE-IDENTICAL. Red if: the function
  --    touches coverage at all (a jsonb_set slipped into the update, a
  --    "reset what was parked" helpfulness), fails to move the status, or
  --    drops the hint.
  ------------------------------------------------------------------------
  begin
    v_sid := public.start_discovery_session(v_tenant);
    perform public.record_dimension_state(v_sid, 'money_out', 'heard', 'probe: pays 14 vendors monthly out of Xero');
    select coverage into v_cov_before from public.discovery_sessions where id = v_sid;

    v_result := public.end_discovery_session(v_sid, v_tenant, 'parked', 'probe: mid-way through the money questions');

    select status, coverage, resume_hint into v_status_after, v_cov_after, v_hint_after
      from public.discovery_sessions where id = v_sid;

    -- 2. IDEMPOTENT RE-END into the SAME state: a retried request is not an
    --    error. Red if: this raises, which would turn a duplicate click into
    --    a 500 the customer cannot get past.
    begin
      perform public.end_discovery_session(v_sid, v_tenant, 'parked', null);
      v_idempotent_ok := true;
    exception
      when others then v_idempotent_ok := false;
    end;

    -- 3. RE-END into a DIFFERENT state is refused. Red if: a finished
    --    interview can be silently reclassified by any later caller.
    --
    -- ⚠ NOT ASSERTED, and deliberately so: "the refusal did not write before
    -- it raised". A PL/pgSQL block with an EXCEPTION clause is a
    -- subtransaction — catching the exception rolls back everything the
    -- failed call did, so a read of `status` after the catch reports the
    -- pre-call value whether the function wrote first or not. That assertion
    -- could not fail, which makes it theatre, and it is also asserting a
    -- property that cannot be observed by any caller for the same reason.
    begin
      perform public.end_discovery_session(v_sid, v_tenant, 'abandoned', null);
    exception
      when sqlstate 'P0001' then v_rejected_reend := true;
    end;

    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> '__undo_probe__' then raise; end if;
  end;

  if v_status_after is distinct from 'parked' then
    raise exception '739: end_discovery_session(..., ''parked'') left the session at % — the caller-stops path does not stop anything', coalesce(v_status_after, 'NULL');
  end if;
  if v_cov_after is distinct from v_cov_before then
    raise exception '739: ending a session CHANGED its coverage ledger — parking must never rewrite what was heard (before: % / after: %)', v_cov_before, v_cov_after;
  end if;
  if (v_cov_before -> 'money_out' ->> 'state') is distinct from 'heard' then
    raise exception '739: the coverage-untouched probe is vacuous — money_out was not actually heard before the call, so an identical ledger proves nothing';
  end if;
  if v_hint_after is distinct from 'probe: mid-way through the money questions' then
    raise exception '739: resume_hint was not recorded (got %) — a parked interview with no note of where it stopped is the invisible pile spec §7 refuses', coalesce(v_hint_after, 'NULL');
  end if;
  if (v_result ->> 'previous_status') is distinct from 'running' then
    raise exception '739: end_discovery_session reported previous_status % rather than running', coalesce(v_result ->> 'previous_status', 'NULL');
  end if;
  if not v_idempotent_ok then
    raise exception '739: re-ending an already-parked session into the SAME state raised — a retried request must be a no-op, not an error';
  end if;
  if not v_rejected_reend then
    raise exception '739: a parked session was re-ended as ''abandoned'' — a finished interview must not be reclassified by a later call';
  end if;

  ------------------------------------------------------------------------
  -- 4. ABANDON is the other real end state, and it is reached the same way.
  --    Red if: only 'parked' was ever wired up.
  ------------------------------------------------------------------------
  begin
    v_sid := public.start_discovery_session(v_tenant);
    perform public.end_discovery_session(v_sid, v_tenant, 'abandoned', 'probe: customer stopped replying');
    select status into v_abandon_status from public.discovery_sessions where id = v_sid;
    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> '__undo_probe__' then raise; end if;
  end;

  if v_abandon_status is distinct from 'abandoned' then
    raise exception '739: end_discovery_session(..., ''abandoned'') left the session at %', coalesce(v_abandon_status, 'NULL');
  end if;

  ------------------------------------------------------------------------
  -- 5. REFUSALS. Each of these must fail for the reason under test:
  --      * 'accepted' — a value the column CHECK ACCEPTS, so only the
  --        function can refuse it. If it did not, the update would succeed
  --        and this probe would silently pass on a broken function.
  --      * an unknown session id.
  --      * the right session, the wrong tenant.
  ------------------------------------------------------------------------
  begin
    v_sid := public.start_discovery_session(v_tenant);

    begin
      perform public.end_discovery_session(v_sid, v_tenant, 'accepted', null);
    exception
      when sqlstate 'P0001' then v_rejected_status := true;
    end;

    begin
      perform public.end_discovery_session(gen_random_uuid(), v_tenant, 'parked', null);
    exception
      when sqlstate 'P0001' then v_rejected_unknown := true;
    end;

    begin
      perform public.end_discovery_session(v_sid, coalesce(v_other_tenant, gen_random_uuid()), 'parked', null);
    exception
      when sqlstate 'P0001' then v_rejected_tenant := true;
    end;

    raise exception using errcode = 'P0001', message = '__undo_probe__';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> '__undo_probe__' then raise; end if;
  end;

  if not v_rejected_status then
    raise exception '739: end_discovery_session accepted ''accepted'' as an end state — proposed/accepted belong to the proposal surface, not to a caller stopping an interview';
  end if;
  if not v_rejected_unknown then
    raise exception '739: end_discovery_session accepted an unknown session id without raising';
  end if;
  if not v_rejected_tenant then
    raise exception '739: end_discovery_session ended a session belonging to ANOTHER tenant — the session id was treated as its own authorisation';
  end if;

  ------------------------------------------------------------------------
  -- 6. Perimeter, both directions. Full signature form: an unresolvable name
  --    ERRORs 42883 rather than quietly returning false.
  ------------------------------------------------------------------------
  if has_function_privilege('anon', 'public.end_discovery_session(uuid, uuid, text, text)', 'execute') then v_bad := array_append(v_bad, 'anon can execute end_discovery_session'); end if;
  if has_function_privilege('authenticated', 'public.end_discovery_session(uuid, uuid, text, text)', 'execute') then v_bad := array_append(v_bad, 'authenticated can execute end_discovery_session'); end if;
  if not has_function_privilege('service_role', 'public.end_discovery_session(uuid, uuid, text, text)', 'execute') then v_bad := array_append(v_bad, 'service_role CANNOT execute end_discovery_session'); end if;
  if has_table_privilege('authenticated', 'public.discovery_sessions', 'UPDATE') then v_bad := array_append(v_bad, 'authenticated can UPDATE discovery_sessions — status must only move through end_discovery_session'); end if;
  if coalesce(array_length(v_bad, 1), 0) > 0 then
    raise exception '739: % perimeter assertion(s) failed: %', array_length(v_bad, 1), array_to_string(v_bad, ' | ');
  end if;

  ------------------------------------------------------------------------
  -- 7. No probe row survives. Compared against the baseline taken before any
  --    probe ran, not against a hardcoded zero. Red if: any rollback above
  --    is broken.
  ------------------------------------------------------------------------
  select count(*) into v_sessions_after from public.discovery_sessions;
  if v_sessions_after <> v_sessions_before then
    raise exception '739: discovery_sessions went from % row(s) to % — a rollback in this block is broken', v_sessions_before, v_sessions_after;
  end if;

  raise notice '739: all checks passed — park and abandon both reachable, coverage byte-identical across an end, re-end refused, wrong tenant refused (%), perimeter clean, % session row(s) before and after',
    case when v_other_tenant is null then 'synthetic tenant id, only one tenant exists' else 'a real second tenant' end,
    v_sessions_before;
end $$;

commit;
