-- 520_the_claim_locks_only_what_it_claims.sql
-- ============================================================================
-- P0. THE ENTIRE WORKFORCE STOPPED WORKING FOR 40 MINUTES AND LOOKED HEALTHY.
--
-- Migration 514 added two LEFT JOINs (de_objectives, role_archetypes) to the
-- CTE inside claim_de_work_items so the claim could order by deadline and by
-- the role's claim_order. That CTE ends in FOR UPDATE SKIP LOCKED, and Postgres
-- refuses:
--
--   0A000: FOR UPDATE cannot be applied to the nullable side of an outer join
--
-- So claim_de_work_items has raised on EVERY call since 514 was applied at
-- 08:11:56 on 2026-07-28. The last work item this tenant completed finished at
-- 08:11:00 — fifty-six seconds before. Nothing has been worked since.
--
-- ── WHY IT LOOKED FINE ─────────────────────────────────────────────────────
-- de-work calls the RPC as `const { data } = await admin.rpc(...)` and never
-- destructures `error`. A raise therefore yields data = null, items = [], and
-- the function returns HTTP 200 with {"worked":0}. The cron reported success 8
-- times an hour. A BROKEN CLAIM IS INDISTINGUISHABLE FROM AN EMPTY QUEUE at
-- every surface anyone was looking at. The companion commit makes de-work read
-- the error and report it, so the next breakage is loud.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- FOR UPDATE OF w — lock only de_work_items, the one table actually being
-- claimed. The joined rows are read for ordering and were never meant to be
-- locked. w and digital_employees are inner-joined, so w is never on a nullable
-- side and the restriction does not apply.
--
-- ── HOW I MISSED IT ────────────────────────────────────────────────────────
-- 514's proof was a hand-written SELECT that reproduced the ORDER BY and showed
-- the queue leading with the right accounts. It reproduced the ordering and not
-- the locking clause — the one thing that broke. Reproducing a function's logic
-- proves the logic; it does not prove the function. The assert below therefore
-- CALLS claim_de_work_items for real and releases what it claims.
-- ============================================================================

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
    for update of w skip locked
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

DO $a$
DECLARE v_ids uuid[]; n int; v_def text;
BEGIN
  v_def := pg_get_functiondef('public.claim_de_work_items(integer,text,uuid)'::regprocedure);
  IF v_def NOT ILIKE '%for update of w skip locked%' THEN
    RAISE EXCEPTION '520: the claim still locks the nullable side of its outer joins';
  END IF;
  -- The mig-514 behaviour must survive the recreate, or this is a revert.
  IF v_def NOT ILIKE '%claim_order%' THEN RAISE EXCEPTION '520: lost the role ordering rule'; END IF;
  IF v_def NOT ILIKE '%due_at%'      THEN RAISE EXCEPTION '520: lost deadline ordering'; END IF;
  IF v_def NOT ILIKE '%depends_on%'  THEN RAISE EXCEPTION '520: lost the dependency gate'; END IF;
  IF v_def NOT ILIKE '%tenant_is_operational%' THEN RAISE EXCEPTION '520: lost the mig-430 dormancy guard'; END IF;

  -- ── CALL IT. Do not reproduce it. ─────────────────────────────────────────
  -- Reproducing the query is exactly how 514 shipped broken: a SELECT that
  -- mirrored the ORDER BY could not fail the way the real function fails,
  -- because the real function has the FOR UPDATE clause and the mirror did not.
  -- A raise here aborts the migration.
  SELECT array_agg(id) INTO v_ids FROM claim_de_work_items(3, 'migration-520-selftest', NULL);
  n := coalesce(array_length(v_ids, 1), 0);
  IF n = 0 THEN
    RAISE EXCEPTION '520: the claim runs but returns nothing — work is still stalled';
  END IF;

  -- This was a probe, not a shift. Put them straight back, including the
  -- attempt counter the claim incremented, so no item is penalised for it.
  UPDATE de_work_items
     SET status = 'queued', locked_at = NULL, locked_by = NULL,
         attempts = greatest(0, attempts - 1)
   WHERE id = ANY(v_ids);

  RAISE NOTICE '520: claim_de_work_items returned % item(s); all released unchanged', n;
END $a$;
