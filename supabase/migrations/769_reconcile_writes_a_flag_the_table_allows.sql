-- 769_reconcile_writes_a_flag_the_table_allows.sql
-- ============================================================================
-- B-11 (docs/54 · register B-11): the 30-minute job that reconciles blocked
-- goals has failed on EVERY run since 2026-08-05 — 245 failures in 7 days,
-- 48 in the last 24 hours — and while it was down NO blocked objective could
-- become unblocked. That is a large part of why 0 of 48 objectives have ever
-- reached 'achieved' (docs/55).
--
-- ── The defect, in one line ────────────────────────────────────────────────
--   ERROR: new row for relation "de_objectives" violates check constraint
--          "de_objectives_attention_flag_check"
--
--   the CHECK allows:   stalled | waiting_too_long | wake_spin | steps_failed
--   the function wrote: 'wait_unanswered'
--
-- ── Why this fix and not the other one ─────────────────────────────────────
-- The obvious alternative is to widen the CHECK. That is wrong. The function
-- invented a SYNONYM for a value the schema already defines: its own comment
-- reads "AGED WAIT: a real question, unanswered too long", which is precisely
-- what 'waiting_too_long' means. Widening would leave two values carrying one
-- meaning — the same two-lists-that-must-agree defect, one row longer.
--
-- Enumerated before changing anything:
--   * readers of 'wait_unanswered'  -> ZERO  (src/, supabase/functions/, scripts/, tests/)
--   * writers of 'wait_unanswered'  -> ONE   (this function)
--   * 'waiting_too_long' is already the typed value in src/lib/deWorkbenchApi.ts
--     (type AttentionFlag) and is already rendered by EmployeeFilePage.tsx as
--     "Waiting on you since <date>".
--
-- The CHECK, the TypeScript type and the UI already agreed with each other.
-- The function was the only outlier, so the function is what moves.
--
-- Nothing else in the body is touched: this is the live definition with one
-- string changed, so the diff is exactly the defect and nothing more.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reconcile_blocked_goals(p_tenant_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  g record;
  v_resumed int := 0; v_finished int := 0; v_dropped int := 0; v_left int := 0; v_broken int := 0;
  v_orphaned int := 0; v_aged int := 0;
  -- How long a real, asked question may go unanswered before it is worth
  -- flagging. Deliberately generous: this is a nudge, never an override.
  c_aged_days constant int := 7;
BEGIN
  PERFORM set_config('app.allow_task_decision', 'on', true);  -- mig 487 sanctioned path

  FOR g IN
    SELECT o.id, o.tenant_id,
           count(w.id)                                             AS n_items,
           count(*) FILTER (WHERE w.status = 'waiting_human')       AS n_waiting,
           count(*) FILTER (WHERE w.status IN ('queued','running')) AS n_live,
           count(*) FILTER (WHERE w.status = 'done')                AS n_done,
           count(*) FILTER (WHERE w.status = 'failed')              AS n_failed,
           -- Of the waiting steps, how many have a REAL open question attached?
           count(*) FILTER (
             WHERE w.status = 'waiting_human'
               AND EXISTS (SELECT 1 FROM human_tasks ht
                            WHERE ht.status = 'pending'
                              AND ((ht.related_table = 'de_work_items' AND ht.related_id = w.id)
                                OR (ht.related_table = 'de_objectives'  AND ht.related_id = o.id)))
           ) AS n_waiting_asked,
           max(w.updated_at) FILTER (WHERE w.status = 'waiting_human') AS newest_wait
      FROM de_objectives o
      LEFT JOIN de_work_items w ON w.objective_id = o.id
     WHERE o.status = 'blocked'
       AND (p_tenant_id IS NULL OR o.tenant_id = p_tenant_id)
       AND tenant_is_operational(o.tenant_id)
     GROUP BY o.id, o.tenant_id
  LOOP
    -- ── ORPHANED WAIT: parked on a question that does not exist. ──────────
    IF g.n_waiting > 0 AND g.n_waiting_asked = 0 THEN
      UPDATE de_work_items
         SET status = 'queued', scheduled_for = now(), attempts = 0,
             last_error = null, updated_at = now()
       WHERE objective_id = g.id AND status = 'waiting_human';
      UPDATE de_objectives
         SET status = 'in_progress', next_wake_at = least(coalesce(next_wake_at, now()), now()),
             attention_flag = null, updated_at = now()
       WHERE id = g.id;
      v_orphaned := v_orphaned + 1;
      CONTINUE;
    END IF;

    -- ── AGED WAIT: a real question, unanswered too long. Flag, never resolve. ──
    IF g.n_waiting > 0 AND g.newest_wait < now() - make_interval(days => c_aged_days) THEN
      UPDATE de_objectives
         SET attention_flag = 'waiting_too_long',
             attention_since = coalesce(attention_since, g.newest_wait), updated_at = now()
       WHERE id = g.id;
      v_aged := v_aged + 1;
      v_left := v_left + 1;
      CONTINUE;
    END IF;

    IF g.n_waiting > 0 OR g.n_items = 0 THEN
      v_left := v_left + 1;
      CONTINUE;
    END IF;

    IF g.n_live > 0 THEN
      UPDATE de_objectives SET status = 'in_progress', updated_at = now() WHERE id = g.id;
      UPDATE human_tasks
         SET status = 'rejected', disposition = 'cancelled',
             decision_note = 'Closed automatically: nothing is blocking this goal any more — its remaining steps are queued and will run. No human ruling was made.',
             decided_at = now(), updated_at = now()
       WHERE related_table = 'de_objectives' AND related_id = g.id AND status = 'pending';
      v_resumed := v_resumed + 1;

    ELSIF g.n_failed > 0 THEN
      UPDATE de_objectives
         SET attention_flag = 'steps_failed',
             attention_since = coalesce(attention_since, now()), updated_at = now()
       WHERE id = g.id;
      v_broken := v_broken + 1;

    ELSIF g.n_done > 0 THEN
      UPDATE de_objectives SET status = 'achieved', updated_at = now() WHERE id = g.id;
      v_finished := v_finished + 1;

    ELSE
      UPDATE de_objectives SET status = 'abandoned', updated_at = now() WHERE id = g.id;
      v_dropped := v_dropped + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'resumed', v_resumed, 'finished', v_finished,
    'dropped', v_dropped, 'broken', v_broken, 'genuinely_blocked', v_left,
    'orphaned_waits_requeued', v_orphaned, 'aged_waits_flagged', v_aged);
END;
$function$

;
