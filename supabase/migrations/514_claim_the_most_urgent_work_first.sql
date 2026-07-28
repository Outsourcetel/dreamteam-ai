-- 514_claim_the_most_urgent_work_first.sql
-- ============================================================================
-- The workforce had no sense of urgency: claim_de_work_items ordered purely by
-- when a step was scheduled. Priority was ignored. Deadlines were ignored. Both
-- sit on the goal and neither reached the moment work is picked up.
--
-- That did not matter with 25 items. It matters at 142 queued draining at
-- roughly five an hour — about a day of backlog — while watchers keep adding.
-- A contract notice deadline eight days out sat behind a health check with no
-- deadline at all, purely because that arrived first.
--
-- ── FOUNDER RULING: SUPPORT KEEPS ARRIVAL ORDER ────────────────────────────
-- Support answering is a response queue, not a work queue: whoever has waited
-- longest must be served first, always. Expressed as config on the role rather
-- than a hardcoded archetype name (the standing genericity rule) — a role with
-- claim_order='arrival' sorts purely by arrival, exactly as today.
--
-- ── WHY priority IS DELIBERATELY NOT USED ──────────────────────────────────
-- That column holds TWO INCOMPATIBLE NUMBERING SYSTEMS. Health and sweep goals
-- carry a 1-5 scale (2, 3). Renewal goals carry the HORIZON DAYS of the
-- checkpoint that opened them — 30, 60, 90 — written by run_work_watchers.
-- Sorting ascending would put every routine daily sweep ahead of every contract
-- notice deadline. Fixing that column is separate work; sorting on it today
-- would bake the bug into the claim order.
--
-- ── HONEST SCOPE ───────────────────────────────────────────────────────────
-- Only 3 of this tenant's 20 open goals carry a real due_at. So this reorders
-- those three ahead of the rest and leaves everything else exactly as it was —
-- the tiebreak is still scheduled_for, so no deadline-less item changes
-- position relative to its peers. The value grows as more goals carry deadlines,
-- not today.
--
-- Reproduced from the LIVE definition (mig 377). PRESERVED byte-for-byte: the
-- FOR UPDATE SKIP LOCKED claim, the depends_on='done' gate, tenant_is_operational
-- (mig 430), the lifecycle and mission-pause guards, and the 100-row cap.
-- ============================================================================

alter table public.role_archetypes add column if not exists claim_order text not null default 'urgency';

do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'role_archetypes_claim_order_check') then
    alter table public.role_archetypes add constraint role_archetypes_claim_order_check
      check (claim_order = any (array['urgency', 'arrival']));
  end if;
end $c$;

comment on column public.role_archetypes.claim_order is
  'How this role picks its next piece of work. urgency = nearest real deadline first, then arrival. arrival = strictly first-in-first-out, for response queues where whoever waited longest must be served first (founder ruling for support).';

update public.role_archetypes set claim_order = 'arrival' where key = 'support_agent';

CREATE OR REPLACE FUNCTION public.claim_de_work_items(p_limit integer DEFAULT 10, p_worker text DEFAULT 'worker'::text, p_tenant_id uuid DEFAULT NULL::uuid)
 RETURNS SETOF de_work_items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  return query
  with due as (
    select w.id
    from de_work_items w
    join digital_employees de on de.id = w.de_id
      left join de_objectives o on o.id = w.objective_id
      left join role_archetypes ro on ro.key = de.archetype_key
    where w.status = 'queued'
      and w.scheduled_for <= now()
      and (p_tenant_id is null or w.tenant_id = p_tenant_id)
      and tenant_is_operational(w.tenant_id)
      -- WAVE-1 FIX (mig 249): an unavailable employee's items stay queued.
      and de.status = 'active'
      and de.lifecycle_status not in ('paused', 'retired', 'archived')
      -- T2.4: a paused/cancelled mission's fanned work stops claiming at once,
      -- for single AND team missions. NULL-safe: non-mission items (objective_id
      -- null, or objective without a mission) are unaffected.
      and not exists (
        select 1 from de_objectives o
        join de_missions m on m.id = o.mission_id
        where o.id = w.objective_id and m.status in ('paused', 'cancelled'))
      and (w.depends_on is null
           or exists (select 1 from de_work_items d where d.id = w.depends_on and d.status = 'done'))
    order by
      -- URGENCY FIRST, except where the founder ruled otherwise.
      --
      -- A role whose claim_order is 'arrival' sorts purely by when the work
      -- arrived — support answering is a response queue, and whoever has been
      -- waiting longest must be served first regardless of any deadline
      -- elsewhere. Its sort key IS scheduled_for, so it keeps exactly the
      -- behaviour it has today.
      --
      -- Every other role sorts by a REAL deadline first. Goals without one keep
      -- arrival order, because the tiebreak below is still scheduled_for — so
      -- nothing that lacks a deadline changes position relative to its peers.
      --
      -- NOTE ON priority: it is deliberately NOT used. That column holds two
      -- incompatible numbering systems — a 1-5 scale for health and sweep goals
      -- (2, 3) and the HORIZON DAYS of a checkpoint for renewal goals (30, 60,
      -- 90), written by run_work_watchers. Sorting on it ascending would put
      -- every routine daily sweep ahead of every contract notice deadline.
      -- Fixing that column is separate work; sorting on it now would encode the
      -- bug into the claim order.
      case when coalesce(ro.claim_order, 'urgency') = 'arrival'
           then w.scheduled_for
           else coalesce(o.due_at, 'infinity'::timestamptz) end asc,
      w.scheduled_for asc
    limit greatest(1, least(100, p_limit))
    for update skip locked
  )
  update de_work_items w
     set status = 'running', locked_at = now(), locked_by = p_worker,
         attempts = w.attempts + 1, updated_at = now()
    from due
   where w.id = due.id
  returning w.*;
end;
$function$
;

notify pgrst, 'reload schema';

do $a$
declare v_def text; n int;
begin
  v_def := pg_get_functiondef('public.claim_de_work_items(integer,text,uuid)'::regprocedure);
  if v_def not ilike '%claim_order%' then
    raise exception '514: the claim still ignores the role''s ordering rule';
  end if;
  if v_def not ilike '%due_at%' then
    raise exception '514: the claim still ignores deadlines';
  end if;
  -- priority MUST NOT be sorted on while it holds two numbering systems.
  if v_def ~* 'order by[^;]*o\.priority' then
    raise exception '514: sorting on priority would put daily sweeps ahead of contract deadlines';
  end if;
  -- The concurrency claim and the dependency gate are load-bearing.
  if v_def not ilike '%skip locked%' then raise exception '514: lost the concurrency claim'; end if;
  if v_def not ilike '%depends_on%' then raise exception '514: lost the dependency gate'; end if;
  if v_def not ilike '%tenant_is_operational%' then raise exception '514: lost the mig-430 dormancy guard'; end if;

  select count(*) into n from role_archetypes where key = 'support_agent' and claim_order = 'arrival';
  if n <> 1 then raise exception '514: support did not keep arrival order'; end if;

  select count(*) into n from role_archetypes where claim_order = 'urgency';
  raise notice '514: % role(s) claim by deadline, support keeps arrival order', n;
end $a$;
