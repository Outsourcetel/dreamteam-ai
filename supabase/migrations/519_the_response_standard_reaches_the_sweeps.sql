-- 519_the_response_standard_reaches_the_sweeps.sql
-- ============================================================================
-- Migration 518 taught the three remaining watcher branches to stamp a
-- deadline, but — like 515 before it — that only affects cases opened AFTER it.
-- The occurrence dedupe means an already-open case is never re-minted, so this
-- tenant's recurring sweeps kept no deadline at all.
--
-- Same treatment 516 gave the state-condition cases, now generalised: due_at is
-- derived from each case's OWN opening time and its OWN watcher's declared
-- window, through the one helper that computes every deadline. Nothing is
-- stamped where no standard has been declared — response_window_due_at returns
-- NULL there, and the WHERE clause skips it.
--
-- Only touches goals still open with no deadline. A date set by hand stands.
-- ============================================================================

UPDATE public.de_objectives o
   SET due_at = public.response_window_due_at(w.config, o.created_at),
       updated_at = now()
  FROM public.work_watchers w
 WHERE o.due_at IS NULL
   AND o.status IN ('open', 'in_progress')
   AND o.plan ? 'watcher_id'
   AND w.id = (o.plan->>'watcher_id')::uuid
   AND public.response_window_due_at(w.config, o.created_at) IS NOT NULL;

DO $a$
DECLARE n_open int; n_due int; n_orphan int;
BEGIN
  SELECT count(*), count(due_at) INTO n_open, n_due
    FROM de_objectives
   WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'outsourcetel-hq')
     AND status IN ('open', 'in_progress');

  -- Would this pass if the update were a no-op? No: coverage was 17 of 21
  -- before, and every remaining gap has a watcher carrying a window.
  IF n_due < n_open THEN
    SELECT count(*) INTO n_orphan
      FROM de_objectives o
     WHERE o.tenant_id = (SELECT id FROM tenants WHERE slug = 'outsourcetel-hq')
       AND o.status IN ('open', 'in_progress') AND o.due_at IS NULL
       AND EXISTS (SELECT 1 FROM work_watchers w
                    WHERE w.id = (o.plan->>'watcher_id')::uuid
                      AND public.response_window_due_at(w.config, o.created_at) IS NOT NULL);
    IF n_orphan > 0 THEN
      RAISE EXCEPTION '519: % goal(s) have a declared window but still no deadline', n_orphan;
    END IF;
  END IF;

  RAISE NOTICE '519: % of % open goals carry a deadline', n_due, n_open;
END $a$;
