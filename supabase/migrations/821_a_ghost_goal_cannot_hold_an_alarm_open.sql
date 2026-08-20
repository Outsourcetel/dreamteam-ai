-- 821_a_ghost_goal_cannot_hold_an_alarm_open.sql
-- ==========================================================================
-- WHY: Workstream E close-out, found proving mig 820. After 820 healed all
-- 45 asked-and-waiting goals and the resolver ran, 37 wake-spin alerts
-- stayed open — every one referencing an objective row that NO LONGER
-- EXISTS. resolve_cleared_ops_alerts' wake_spin arm is EXISTS-shaped: it
-- resolves when it can find the goal in a cleared state, so a deleted goal
-- (the most-cleared state there is) can never satisfy it. An alarm channel
-- that accretes immortal ghosts is the C-8 lamp problem compounding.
-- Function GENERATED from live (mig-377 rule); one surgical clause.
-- ==========================================================================

begin;

CREATE OR REPLACE FUNCTION public.resolve_cleared_ops_alerts(p_heartbeat jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE n_dispatch int := 0; n_spin int := 0; n_workforce int := 0; n int := 0; k text;
BEGIN
  -- ── dispatch_failure: older than the re-check interval is history ────────
  UPDATE ops_alerts SET resolved_at = now()
   WHERE kind = 'dispatch_failure' AND resolved_at IS NULL
     AND created_at < now() - interval '2 hours';
  GET DIAGNOSTICS n_dispatch = ROW_COUNT;

  -- ── wake_spin: the goal stopped spinning, one way or another ─────────────
  UPDATE ops_alerts a SET resolved_at = now()
   WHERE a.kind = 'de_objective_wake_spin' AND a.resolved_at IS NULL
     AND (
       -- mig 821: a GHOST cannot hold an alarm open. The EXISTS shape below
       -- silently required the goal row to still exist, so an alert about a
       -- DELETED goal — the most-cleared condition there is — was immortal:
       -- 37 of them, measured live, surviving every heartbeat since July.
       NOT EXISTS (SELECT 1 FROM de_objectives og
                    WHERE og.id = (a.detail->>'objective_id')::uuid)
       OR EXISTS (
       SELECT 1 FROM de_objectives o
        WHERE o.id = (a.detail->>'objective_id')::uuid
          AND (o.status NOT IN ('open', 'in_progress', 'blocked')
            OR o.attention_flag IS DISTINCT FROM 'wake_spin'
            OR EXISTS (SELECT 1 FROM de_work_items w
                        WHERE w.objective_id = o.id AND w.updated_at > a.created_at))));
  GET DIAGNOSTICS n_spin = ROW_COUNT;

  -- ── workforce_*: cleared when the heartbeat says the bucket is empty ─────
  IF p_heartbeat IS NOT NULL THEN
    FOREACH k IN ARRAY ARRAY['claim_broken', 'stalled', 'deadlocked'] LOOP
      IF jsonb_array_length(coalesce(p_heartbeat->k, '[]'::jsonb)) = 0 THEN
        UPDATE ops_alerts SET resolved_at = now()
         WHERE resolved_at IS NULL
           AND kind = CASE k WHEN 'claim_broken' THEN 'workforce_claim_broken'
                             WHEN 'stalled'      THEN 'workforce_stalled'
                             ELSE                     'workforce_deadlocked' END;
        GET DIAGNOSTICS n = ROW_COUNT;
        n_workforce := n_workforce + n;
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('ok', true, 'dispatch_failure', n_dispatch,
    'wake_spin', n_spin, 'workforce', n_workforce);
END $function$
;

do $$
begin
  if position('GHOST' in pg_get_functiondef('public.resolve_cleared_ops_alerts(jsonb)'::regprocedure)) = 0 then
    raise exception 'resolve_cleared_ops_alerts lost the ghost clause';
  end if;
end $$;

commit;
