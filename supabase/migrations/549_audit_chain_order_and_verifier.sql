-- 549: the audit chain says "TAMPERED" when it is not, and is blind when it is.
--
-- WHAT WAS WRONG
-- verify_audit_chain walked audit_events in `order by created_at asc, id asc`
-- and required each row's prev_hash to equal the previous row's hash. But
-- created_at is `clock_timestamp()` captured BEFORE `pg_advisory_xact_lock`,
-- so it does not reflect insert order. Proof from production: a row stamped
-- 2026-08-02T09:00:00.540487 chains onto a parent stamped 09:00:00.573781 —
-- a child OLDER than its own parent. It took its timestamp, blocked on the
-- lock while another transaction inserted, then chained on correctly but with
-- a stale stamp.
--
-- The same stale ordering fed head selection (`order by created_at desc`), so
-- the NEXT writer picked the highest-timestamped row rather than the true tip
-- and chained onto a parent that already had a child — a fork. Two exist in
-- outsourcetel-hq (2026-07-28, 2026-08-02). The 07-28 one is worse than a race:
-- parent and child share created_at to the microsecond, i.e. two audit writes
-- in ONE transaction. The advisory lock cannot help there — it is already held.
--
-- WHY IT MATTERED
-- verify_audit_chain returns on the FIRST mismatch, so from 2026-07-28 onward
-- it always reported broken_at on that row. Genuine tampering after that date
-- would never have been reached. The control both cried wolf and was blind —
-- and the Audit Trail screen shows the founder "Chain BROKEN … This should be
-- impossible unless the database was tampered with directly."
--
-- THE LOG ITSELF IS SOUND — measured, not assumed. Across all 52,746 rows:
-- 0 content-hash mismatches, 0 dangling prev_hash, 0 duplicate hashes, exactly
-- one genesis row per tenant, and every one of outsourcetel-hq's 13,035 rows
-- reachable from genesis. The structure is a TREE with three leaves, not a
-- corrupted line.
--
-- WHAT THIS MIGRATION DOES NOT DO: rewrite history. Re-linking a fork means
-- recomputing the hash of every row after it — thousands of rows — and a
-- rewrite is indistinguishable from the tampering the chain exists to detect.
-- `audit_events_no_update_delete` forbids UPDATE outright, and rightly. The
-- two forks are recorded as known anomalies instead; any NEW one fails hard.
--
-- THE FIX
--   1. audit_chain_state — the per-tenant head, read and written under the
--      existing advisory lock. Forks become structurally impossible, including
--      the two-writes-one-transaction case.
--   2. verify_audit_chain rewritten to check what actually matters and makes
--      no ordering assumption at all:
--        content      — every row's hash equals the digest of its own contents
--        genesis      — exactly one root
--        reachability — the walk from genesis reaches every row (catches
--                       deletions and orphans, which the old walk could not)
--        linearity    — no unregistered fork
--   3. audit_chain_anomalies — baselines exactly the forks that exist today,
--      pinned to their parent hash AND the full set of child ids, so adding or
--      removing a row at a known fork still fails.
begin;

-- ── 1. head tracking ────────────────────────────────────────────────────────
create table if not exists public.audit_chain_state (
  tenant_id     uuid primary key references public.tenants(id) on delete cascade,
  head_hash     text        not null,
  head_event_id uuid,
  events        bigint      not null default 0,
  updated_at    timestamptz not null default now()
);
alter table public.audit_chain_state enable row level security;
revoke all on public.audit_chain_state from anon, authenticated;

create table if not exists public.audit_chain_anomalies (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  parent_hash     text not null,
  child_event_ids uuid[] not null,
  kind            text not null,
  note            text not null,
  registered_at   timestamptz not null default now(),
  unique (tenant_id, parent_hash)
);
alter table public.audit_chain_anomalies enable row level security;
revoke all on public.audit_chain_anomalies from anon, authenticated;

-- The reachability walk and the tip probe both join on prev_hash; without this
-- they degrade to a sequential scan per step on a 39k-row tenant.
create index if not exists audit_events_prev_hash_idx
  on public.audit_events (tenant_id, prev_hash);

-- ── 2. the true tip ─────────────────────────────────────────────────────────
-- Callers MUST already hold pg_advisory_xact_lock('audit_'||tenant). The
-- recorded head is trusted but verified: one index probe asks whether anything
-- has already chained onto it. If something has, the record is stale and using
-- it would fork the chain, so the real tip is recomputed. That makes the state
-- table an optimisation rather than a new source of truth.
create or replace function public.audit_chain_tip(p_tenant_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare v_head text;
begin
  select head_hash into v_head from audit_chain_state where tenant_id = p_tenant_id;

  if v_head is null
     or (v_head <> '' and exists (select 1 from audit_events c
                                   where c.tenant_id = p_tenant_id and c.prev_hash = v_head)) then
    select e.hash into v_head
      from audit_events e
     where e.tenant_id = p_tenant_id
       and not exists (select 1 from audit_events c
                        where c.tenant_id = p_tenant_id and c.prev_hash = e.hash)
     order by e.created_at desc, e.id desc
     limit 1;
  end if;

  return coalesce(v_head, '');
end $fn$;
revoke all on function public.audit_chain_tip(uuid) from public, anon, authenticated;

-- Seed one row per tenant from the real tip as it stands today.
insert into public.audit_chain_state (tenant_id, head_hash, head_event_id, events, updated_at)
select t.id, coalesce(tip.hash, ''), tip.id, coalesce(n.c, 0), now()
  from tenants t
  left join lateral (
    select e.hash, e.id from audit_events e
     where e.tenant_id = t.id
       and not exists (select 1 from audit_events c where c.tenant_id = t.id and c.prev_hash = e.hash)
     order by e.created_at desc, e.id desc limit 1) tip on true
  left join lateral (select count(*) c from audit_events e where e.tenant_id = t.id) n on true
on conflict (tenant_id) do update
  set head_hash = excluded.head_hash, head_event_id = excluded.head_event_id,
      events = excluded.events, updated_at = excluded.updated_at;

-- ── 3. baseline the forks that already exist ────────────────────────────────
-- Detected, never hardcoded, and pinned to the full child set so that adding a
-- third child or removing one still fails verification.
insert into public.audit_chain_anomalies (tenant_id, parent_hash, child_event_ids, kind, note)
select e.tenant_id, e.prev_hash, array_agg(e.id order by e.id), 'concurrency_fork',
       'Pre-existing at migration 549. Two rows chained onto the same parent because '
       || 'created_at was captured before the advisory lock, so head selection by '
       || 'created_at picked a row that was not the tip. Content hashes verify and every '
       || 'row is reachable from genesis: no data was altered or lost. Not repaired '
       || 'because re-linking would require rewriting every subsequent hash, and '
       || 'audit_events is immutable by design.'
  from audit_events e
 where coalesce(e.prev_hash, '') <> ''
 group by e.tenant_id, e.prev_hash
having count(*) > 1
on conflict (tenant_id, parent_hash) do nothing;

-- The mig-305 head probe (an external monitor records the head and later checks
-- it only ever advanced — the insider-write tripwire) had the SAME defect: it
-- reported the highest-timestamped row rather than the tip, so it could report
-- a head the chain had already moved past. Same shape, same fix; the jsonb
-- contract and membership guard are unchanged.
create or replace function public.audit_chain_head(p_tenant_id uuid)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public', 'extensions'
as $fn$
DECLARE
  v_head    text;
  v_at      timestamptz;
  v_count   bigint;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' AND NOT EXISTS (
    SELECT 1 FROM profiles WHERE user_id = auth.uid() AND tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'not a member of this tenant';
  END IF;

  v_head := public.audit_chain_tip(p_tenant_id);          -- mig 549: the true tip
  SELECT created_at INTO v_at FROM audit_events
   WHERE tenant_id = p_tenant_id AND hash = v_head LIMIT 1;
  SELECT count(*) INTO v_count FROM audit_events WHERE tenant_id = p_tenant_id;

  RETURN jsonb_build_object(
    'head_hash', coalesce(v_head, ''),
    'head_at',   v_at,
    'count',     coalesce(v_count, 0)
  );
END;
$fn$;

-- ── 4. the verifier ─────────────────────────────────────────────────────────
create or replace function public.verify_audit_chain_internal(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $fn$
declare
  v_total     bigint;
  v_reachable bigint;
  v_genesis   bigint;
  v_bad       uuid;
  v_forks     int := 0;
  v_known     int := 0;
  r           record;
  v_reg       public.audit_chain_anomalies;
begin
  select count(*) into v_total from audit_events where tenant_id = p_tenant_id;
  if v_total = 0 then
    return jsonb_build_object('intact', true, 'checked', 0, 'broken_at', null,
      'reason', null, 'forks', 0, 'known_anomalies', 0);
  end if;

  -- CONTENT. Order-independent, and the check that actually catches an edit:
  -- each row's hash must be the digest of its own stored contents.
  select e.id into v_bad
    from audit_events e
   where e.tenant_id = p_tenant_id
     and e.hash <> encode(digest(
           coalesce(e.prev_hash, '') || e.tenant_id::text || coalesce(e.action, '') ||
           coalesce(e.detail::text, '{}') || e.created_at::text, 'sha256'), 'hex')
   limit 1;
  if v_bad is not null then
    return jsonb_build_object('intact', false, 'checked', v_total, 'broken_at', v_bad,
      'reason', 'content_hash_mismatch', 'forks', 0, 'known_anomalies', 0);
  end if;

  -- GENESIS: exactly one root.
  select count(*) into v_genesis
    from audit_events where tenant_id = p_tenant_id and coalesce(prev_hash, '') = '';
  if v_genesis <> 1 then
    return jsonb_build_object('intact', false, 'checked', v_total, 'broken_at', null,
      'reason', format('expected exactly one genesis row, found %s', v_genesis),
      'forks', 0, 'known_anomalies', 0);
  end if;

  -- REACHABILITY: follow the linkage from genesis. Every row must be reached.
  -- Each row stores exactly one prev_hash, so no row can be visited twice; a
  -- shortfall means a row was deleted mid-chain or never linked in. The old
  -- verifier could not detect either.
  with recursive w as (
    select e.id, e.hash from audit_events e
     where e.tenant_id = p_tenant_id and coalesce(e.prev_hash, '') = ''
    union all
    select e.id, e.hash from audit_events e
      join w on e.prev_hash = w.hash
     where e.tenant_id = p_tenant_id)
  select count(*) into v_reachable from w;

  if v_reachable <> v_total then
    return jsonb_build_object('intact', false, 'checked', v_reachable, 'broken_at', null,
      'reason', format('%s of %s rows unreachable from genesis', v_total - v_reachable, v_total),
      'forks', 0, 'known_anomalies', 0);
  end if;

  -- LINEARITY: a parent with two children is a fork. Known ones are reported;
  -- an unknown one, or a known one whose membership changed, fails.
  for r in
    select e.prev_hash as parent, array_agg(e.id order by e.id) as kids
      from audit_events e
     where e.tenant_id = p_tenant_id and coalesce(e.prev_hash, '') <> ''
     group by e.prev_hash having count(*) > 1
  loop
    v_forks := v_forks + 1;
    select * into v_reg from audit_chain_anomalies
     where tenant_id = p_tenant_id and parent_hash = r.parent;

    if v_reg.id is null then
      return jsonb_build_object('intact', false, 'checked', v_total, 'broken_at', r.kids[1],
        'reason', 'unregistered fork: two records share a parent',
        'forks', v_forks, 'known_anomalies', v_known);
    end if;

    if v_reg.child_event_ids <> r.kids then
      return jsonb_build_object('intact', false, 'checked', v_total, 'broken_at', r.kids[1],
        'reason', 'records at a known fork changed since it was recorded',
        'forks', v_forks, 'known_anomalies', v_known);
    end if;
    v_known := v_known + 1;
  end loop;

  -- A registered anomaly whose fork no longer exists means rows went missing.
  if (select count(*) from audit_chain_anomalies where tenant_id = p_tenant_id) <> v_known then
    return jsonb_build_object('intact', false, 'checked', v_total, 'broken_at', null,
      'reason', 'a recorded anomaly no longer matches the log',
      'forks', v_forks, 'known_anomalies', v_known);
  end if;

  return jsonb_build_object('intact', true, 'checked', v_total, 'broken_at', null,
    'reason', null, 'forks', v_forks, 'known_anomalies', v_known);
end $fn$;
revoke all on function public.verify_audit_chain_internal(uuid) from public, anon, authenticated;

-- Public entry point: membership guard unchanged (mig 475 shape), logic delegated.
create or replace function public.verify_audit_chain(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $fn$
declare v_is_active boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    select coalesce(is_active, true) into v_is_active
      from profiles where user_id = auth.uid() and tenant_id = p_tenant_id;
    if v_is_active is null or not v_is_active then
      raise exception 'not a member of this tenant';
    end if;
  end if;
  return public.verify_audit_chain_internal(p_tenant_id);
end $fn$;

-- ── 5. the writers ──────────────────────────────────────────────────────────
-- Both sinks change identically: take the timestamp AFTER the lock (so it
-- reflects insert order), take the head from audit_chain_tip (so it is the
-- true tip, not the highest timestamp), and record the new head.
create or replace function public.append_audit_event(p_tenant_id uuid, p_actor text, p_actor_type text, p_action text, p_category text, p_detail jsonb DEFAULT '{}'::jsonb)
returns audit_events
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $fn$
DECLARE
  v_prev  text;
  v_now   timestamptz;
  v_hash  text;
  v_row   audit_events;
  v_actor text := coalesce(nullif(p_actor, ''), 'system');
  v_type  text := coalesce(nullif(p_actor_type, ''), 'system');
  v_detail jsonb := coalesce(p_detail, '{}'::jsonb);
  v_block_de uuid;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    IF NOT EXISTS (
      SELECT 1 FROM profiles WHERE user_id = auth.uid() AND tenant_id = p_tenant_id
    ) THEN
      RAISE EXCEPTION 'not a member of this tenant';
    END IF;
    -- Server-attested identity: whoever holds this JWT is a USER; what
    -- they claimed to be is preserved in detail for transparency.
    IF v_actor IS DISTINCT FROM '' AND (p_actor IS DISTINCT FROM null) THEN
      v_detail := v_detail || jsonb_build_object('claimed_actor', p_actor, 'claimed_actor_type', p_actor_type);
    END IF;
    SELECT coalesce(nullif(trim(full_name), ''), 'user') INTO v_actor
    FROM profiles WHERE user_id = auth.uid() AND tenant_id = p_tenant_id LIMIT 1;
    -- MUST be one of the audit_events actor_type CHECK values
    -- ('de','human','system'). A JWT caller is a human; using 'user' here
    -- silently broke every user-initiated audit write until it was caught
    -- by the Wave 1 end-to-end test.
    v_type := 'human';
    v_detail := v_detail || jsonb_build_object('_user_submitted', true, '_submitted_by', auth.uid());
  END IF;

  -- Per-employee attribution (trust program docs/31 Q7, item 4): a guardrail
  -- block written by an employee actor is stamped with that employee's id so
  -- employee-scoped trust policies can count an honest, per-employee block
  -- record. The actor string every writer passes is the employee's effective
  -- display name (persona name when set, else record name); the stamp is
  -- only applied when that name resolves to EXACTLY ONE employee in the
  -- tenant — ambiguous or unknown names are left unstamped rather than
  -- guessed. Writers that already provide detail.de_id win untouched. The
  -- stamp happens before the hash below, so the tamper-evident chain covers
  -- it and verify_audit_chain still passes.
  IF p_category = 'guardrail_block' AND v_type = 'de' AND NOT (v_detail ? 'de_id') THEN
    SELECT min(id) INTO v_block_de
    FROM digital_employees
    WHERE tenant_id = p_tenant_id
      AND coalesce(nullif(persona_name, ''), name) = v_actor
    HAVING count(*) = 1;
    IF v_block_de IS NOT NULL THEN
      v_detail := v_detail || jsonb_build_object('de_id', v_block_de);
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('audit_' || p_tenant_id::text));

  -- mig 549: both AFTER the lock. Taking the clock first is what let a row be
  -- stamped earlier than its own parent; taking the head by timestamp is what
  -- then forked the chain.
  v_now  := clock_timestamp();
  v_prev := public.audit_chain_tip(p_tenant_id);

  v_hash := encode(digest(
    v_prev || p_tenant_id::text || coalesce(p_action, '') ||
    coalesce(v_detail::text, '{}') || v_now::text,
    'sha256'), 'hex');

  INSERT INTO audit_events (tenant_id, actor, actor_type, action, category, detail, prev_hash, hash, created_at)
  VALUES (p_tenant_id, v_actor, v_type, p_action, p_category, v_detail, v_prev, v_hash, v_now)
  RETURNING * INTO v_row;

  INSERT INTO audit_chain_state AS s (tenant_id, head_hash, head_event_id, events, updated_at)
  VALUES (p_tenant_id, v_row.hash, v_row.id, 1, v_now)
  ON CONFLICT (tenant_id) DO UPDATE
    SET head_hash = excluded.head_hash, head_event_id = excluded.head_event_id,
        events = s.events + 1, updated_at = excluded.updated_at;

  RETURN v_row;
END;
$fn$;

create or replace function public.append_audit_event_internal(p_tenant_id uuid, p_actor text, p_actor_type text, p_action text, p_category text, p_detail jsonb DEFAULT '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $fn$
declare
  v_prev text;
  v_now  timestamptz;
  v_hash text;
  v_id   uuid;
  v_detail jsonb := coalesce(p_detail, '{}'::jsonb);
  v_block_de uuid;
begin
  -- Same per-employee stamp as append_audit_event (see that function's
  -- comment); kept in both sinks so the audited record does not depend on
  -- which write path a future guardrail writer picks.
  if p_category = 'guardrail_block' and p_actor_type = 'de' and not (v_detail ? 'de_id') then
    select min(id) into v_block_de
    from digital_employees
    where tenant_id = p_tenant_id
      and coalesce(nullif(persona_name, ''), name) = coalesce(nullif(p_actor, ''), 'system')
    having count(*) = 1;
    if v_block_de is not null then
      v_detail := v_detail || jsonb_build_object('de_id', v_block_de);
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('audit_' || p_tenant_id::text));

  v_now  := clock_timestamp();                       -- mig 549: after the lock
  v_prev := public.audit_chain_tip(p_tenant_id);    -- mig 549: the true tip

  v_hash := encode(digest(v_prev || p_tenant_id::text || coalesce(p_action, '') ||
                          v_detail::text || v_now::text, 'sha256'), 'hex');

  insert into audit_events (tenant_id, actor, actor_type, action, category, detail, prev_hash, hash, created_at)
  values (p_tenant_id, p_actor, p_actor_type, p_action, p_category, v_detail, v_prev, v_hash, v_now)
  returning id into v_id;

  insert into audit_chain_state as s (tenant_id, head_hash, head_event_id, events, updated_at)
  values (p_tenant_id, v_hash, v_id, 1, v_now)
  on conflict (tenant_id) do update
    set head_hash = excluded.head_hash, head_event_id = excluded.head_event_id,
        events = s.events + 1, updated_at = excluded.updated_at;
end $fn$;

-- ── 6. prove it, in both directions ─────────────────────────────────────────
do $do$
declare
  v_t         uuid := '5bb802e1-8e92-4eef-9a7a-ac348785d43f';  -- the affected tenant
  r           record;
  v_res       jsonb;
  v_detected  boolean;
  v_a         text;
  v_b         text;
  v_parent    text;
begin
  -- POSITIVE: every tenant now verifies.
  for r in select id, name from tenants loop
    v_res := public.verify_audit_chain_internal(r.id);
    if not (v_res->>'intact')::boolean then
      raise exception '549: % still fails verification: % (broken_at %)',
        r.name, v_res->>'reason', v_res->>'broken_at';
    end if;
  end loop;

  v_res := public.verify_audit_chain_internal(v_t);
  if (v_res->>'checked')::bigint < 13000 then
    raise exception '549: expected the full log to be checked, got %', v_res->>'checked';
  end if;
  if (v_res->>'known_anomalies')::int <> 2 then
    raise exception '549: expected 2 recorded anomalies, got %', v_res->>'known_anomalies';
  end if;

  -- NEGATIVE 1 — a row whose hash does not match its contents must be caught.
  -- Each probe runs in a sub-block and ends by raising, which rolls the insert
  -- back to the block's implicit savepoint. audit_events forbids DELETE, so
  -- this is the only way to test destructively without leaving residue.
  begin
    insert into audit_events (tenant_id, actor, actor_type, action, category, detail, prev_hash, hash, created_at)
    values (v_t, 'probe', 'system', 'probe: forged content', 'config_change', '{}'::jsonb,
            public.audit_chain_tip(v_t), repeat('0', 64), clock_timestamp());
    v_detected := not (public.verify_audit_chain_internal(v_t)->>'intact')::boolean;
    raise exception using errcode = '22000', message = '__probe_rollback__';
  exception when sqlstate '22000' then
    if sqlerrm <> '__probe_rollback__' then raise; end if;
  end;
  if not v_detected then raise exception '549: verifier is blind to a forged content hash'; end if;

  -- NEGATIVE 2 — an orphan (chains onto a hash that does not exist).
  begin
    insert into audit_events (tenant_id, actor, actor_type, action, category, detail, prev_hash, hash, created_at)
    select v_t, 'probe', 'system', 'probe: orphan', 'config_change', '{}'::jsonb, repeat('f', 64),
           encode(digest(repeat('f', 64) || v_t::text || 'probe: orphan' || '{}' || n::text, 'sha256'), 'hex'), n
      from (select clock_timestamp() as n) x;
    v_detected := not (public.verify_audit_chain_internal(v_t)->>'intact')::boolean;
    raise exception using errcode = '22000', message = '__probe_rollback__';
  exception when sqlstate '22000' then
    if sqlerrm <> '__probe_rollback__' then raise; end if;
  end;
  if not v_detected then raise exception '549: verifier is blind to an orphaned record'; end if;

  -- NEGATIVE 3 — a NEW fork on an unregistered parent must still fail. This is
  -- the exact defect being fixed; the baseline must not have made it invisible.
  select e.prev_hash into v_parent
    from audit_events e
   where e.tenant_id = v_t and coalesce(e.prev_hash,'') <> ''
     and not exists (select 1 from audit_chain_anomalies a
                      where a.tenant_id = v_t and a.parent_hash = e.prev_hash)
   limit 1;
  -- Without this the probe would insert prev_hash = NULL, which reads as a
  -- second genesis row: the verifier would fail for the WRONG reason and the
  -- assertion would pass while testing nothing.
  if v_parent is null then
    raise exception '549: could not build a new-fork probe — no unregistered parent found';
  end if;
  begin
    insert into audit_events (tenant_id, actor, actor_type, action, category, detail, prev_hash, hash, created_at)
    select v_t, 'probe', 'system', 'probe: fork', 'config_change', '{}'::jsonb, v_parent,
           encode(digest(v_parent || v_t::text || 'probe: fork' || '{}' || n::text, 'sha256'), 'hex'), n
      from (select clock_timestamp() as n) x;
    v_detected := not (public.verify_audit_chain_internal(v_t)->>'intact')::boolean;
    raise exception using errcode = '22000', message = '__probe_rollback__';
  exception when sqlstate '22000' then
    if sqlerrm <> '__probe_rollback__' then raise; end if;
  end;
  if not v_detected then raise exception '549: verifier is blind to a new fork'; end if;

  -- BEHAVIOUR — two appends in ONE transaction, which is precisely what caused
  -- the 2026-07-28 fork. The second must chain onto the first.
  begin
    perform public.append_audit_event_internal(v_t, 'probe', 'system', 'probe: same-txn A', 'config_change', '{}'::jsonb);
    select head_hash into v_a from audit_chain_state where tenant_id = v_t;
    perform public.append_audit_event_internal(v_t, 'probe', 'system', 'probe: same-txn B', 'config_change', '{}'::jsonb);
    select prev_hash into v_b from audit_events
      where tenant_id = v_t and action = 'probe: same-txn B' limit 1;
    v_detected := (v_a = v_b) and (public.verify_audit_chain_internal(v_t)->>'intact')::boolean;
    raise exception using errcode = '22000', message = '__probe_rollback__';
  exception when sqlstate '22000' then
    if sqlerrm <> '__probe_rollback__' then raise; end if;
  end;
  if not v_detected then
    raise exception '549: two appends in one transaction still fork the chain';
  end if;

  raise notice '549: chain verifies for every tenant; forged content, orphans and new forks all still detected';
end $do$;

commit;
