-- 654_a_wait_nobody_was_asked_about.sql
-- ============================================================================
-- reconcile_blocked_goals runs every 30 minutes — 48 times a day — and has
-- cleared NOTHING. Its first arm abstains on any waiting step:
--
--   IF g.n_waiting > 0 OR g.n_items = 0 THEN v_left := v_left + 1; CONTINUE;
--
-- and all 18 blocked objectives have exactly one item at 'waiting_human'. So a
-- single stuck step pins a goal blocked with no time limit, and the watchdog
-- built to notice that reports it as "genuinely blocked" forever.
--
-- ⚠ THE FIX IS NOT TO OVERRIDE THE WAIT. If a person has been asked and has not
-- answered, blocked is the TRUTH and this function must keep saying so — the
-- whole product rests on a human seam that software does not get to pave over.
--
-- The defect is narrower and worse: a step can wait on a human WHO WAS NEVER
-- ASKED. The escalation insert can fail (RLS, constraint), or its task can be
-- decided/closed/expired while the step stays parked. Then nobody can ever
-- answer it — the question does not exist — and the step waits until the heat
-- death of the workspace. That is a LOST MESSAGE, not a pending decision, and
-- recovering it is not second-guessing anyone.
--
-- So, two new arms, in this order:
--   · ORPHANED WAIT — every waiting step has NO pending human task. Requeue
--     them; the objective goes back to in_progress and the work resumes.
--   · AGED WAIT — a task DOES exist and has gone unanswered past the ceiling.
--     Flag for attention. Do NOT auto-resolve: a person still owes an answer,
--     and silently proceeding would be the failure this project exists to avoid.
-- Everything else falls through to the untouched original logic.
-- ============================================================================

begin;

create or replace function public.reconcile_blocked_goals(p_tenant_id uuid default null::uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
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
         SET attention_flag = 'wait_unanswered',
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
$function$;

revoke all on function public.reconcile_blocked_goals(uuid) from public, anon, authenticated;

-- ── Prove the arms exist and that the human seam was NOT paved over. ──────
do $$
declare v_def text; v_res jsonb;
begin
  v_def := pg_get_functiondef('public.reconcile_blocked_goals(uuid)'::regprocedure);

  if v_def not ilike '%n_waiting_asked%' then
    raise exception '654: the orphaned-wait arm is missing';
  end if;
  if v_def not ilike '%wait_unanswered%' then
    raise exception '654: the aged-wait flag is missing';
  end if;
  -- The safety property: an aged wait must FLAG, never resolve. If the word
  -- 'achieved' or 'abandoned' ever appears inside that arm, the watchdog has
  -- started deciding for the human.
  if substring(v_def from position('wait_unanswered' in v_def) for 400) ilike '%achieved%'
     or substring(v_def from position('wait_unanswered' in v_def) for 400) ilike '%abandoned%' then
    raise exception '654: the aged-wait arm resolves the goal — a watchdog must not answer for a person';
  end if;

  -- Run it read-mostly and confirm the shape. Any objective it touches was
  -- parked on a question nobody could answer.
  select public.reconcile_blocked_goals() into v_res;
  if coalesce(v_res->>'ok','') <> 'true' then
    raise exception '654: the reconciler did not run cleanly: %', v_res;
  end if;
  raise notice '654: %', v_res::text;
end $$;

commit;
