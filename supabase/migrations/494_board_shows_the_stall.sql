-- 494_board_shows_the_stall.sql
-- ============================================================================
-- docs/37 Move 0, block 1c (server half): the stall signal reaches a screen.
--
-- de_stall_sweep_internal has been flagging objectives every 15 minutes since
-- migration 485 -- 17 carry attention_flag right now -- and NOTHING in the
-- product reads the column. The signal also lands in ops_alerts, but
-- list_ops_alerts raises for anyone who is not a platform admin, and ops_alerts
-- has no tenant_id at all, so it can never become a tenant surface. Half a
-- detector is its own kind of dishonesty: the machine knows, the human does not.
--
-- Three keys added to every board row, immediately before open_objectives:
--   needs_attention         -- how many of this employee's goals are flagged
--   attention_oldest_since  -- so the chip shows an AGE, never a bare count
--   attention_kinds         -- which flags, so the label can be specific
-- One predicate, already covered by de_objectives_lookup_idx.
--
-- Recreated from the LIVE definition (mig 377), single-hit anchor (mig 430),
-- CRLF preserved. The can_access_de row gate is carried through untouched --
-- the board must keep honouring the two-axes assignment model (docs/29).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_workforce_board(p_de_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_tenant uuid; v_out jsonb;
BEGIN
  v_tenant := public.auth_tenant_id();
  IF v_tenant IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_permitted');
  END IF;

  SELECT COALESCE(jsonb_agg(row_json ORDER BY dept, pname), '[]'::jsonb)
    INTO v_out
  FROM (
    SELECT
      COALESCE(d.department, 'zz') AS dept,
      COALESCE(d.persona_name, d.name) AS pname,
      jsonb_build_object(
        'de_id', d.id,
        'name', d.name,
        'persona_name', d.persona_name,
        'department', d.department,
        'trust_level', d.trust_level,
        'lifecycle_status', COALESCE(d.lifecycle_status, 'active'),

        -- NOW: the item being executed this moment (claimed by the tick).
        'now', (
          SELECT jsonb_build_object('title', w.title, 'since', w.locked_at)
            FROM de_work_items w
           WHERE w.tenant_id = v_tenant AND w.de_id = d.id
             AND w.status = 'running'
           ORDER BY w.locked_at DESC NULLS LAST LIMIT 1),

        -- NEXT UP: top 3 across every arrival channel, unified + ordered by
        -- WHEN. Undated queue items sort last within the horizon.
        'next_up', COALESCE((
          SELECT jsonb_agg(n ORDER BY (n->>'when') ASC NULLS LAST)
            FROM (
              SELECT n FROM (
                (SELECT jsonb_build_object(
                         'kind', 'work_item', 'title', q.title,
                         'when', COALESCE(q.scheduled_for, q.created_at)) AS n
                   FROM de_work_items q
                  WHERE q.tenant_id = v_tenant AND q.de_id = d.id AND q.status = 'queued'
                  ORDER BY COALESCE(q.scheduled_for, q.created_at) ASC LIMIT 3)
                UNION ALL
                (SELECT jsonb_build_object(
                         'kind', 'case_wait', 'title', COALESCE(NULLIF(c.instruction, ''), 'follow up on a waiting case'),
                         'when', c.fire_at)
                   FROM de_case_events c
                  WHERE c.tenant_id = v_tenant AND c.de_id = d.id AND c.status = 'pending'
                  ORDER BY c.fire_at ASC LIMIT 3)
                UNION ALL
                (SELECT jsonb_build_object(
                         'kind', 'watcher', 'title', v.label,
                         'when', v.next_fire_at)
                   FROM work_watchers v
                  WHERE v.tenant_id = v_tenant AND v.de_id = d.id
                    AND v.active AND v.kind <> 'inbox' AND v.next_fire_at IS NOT NULL
                  ORDER BY v.next_fire_at ASC LIMIT 2)
                UNION ALL
                (SELECT jsonb_build_object(
                         'kind', 'objective_wake', 'title', 'check on: ' || o.title,
                         'when', o.next_wake_at)
                   FROM de_objectives o
                  WHERE o.tenant_id = v_tenant AND o.de_id = d.id
                    AND o.status = 'in_progress' AND o.next_wake_at IS NOT NULL
                  ORDER BY o.next_wake_at ASC LIMIT 2)
              ) uni
              ORDER BY (n->>'when') ASC NULLS LAST LIMIT 3
            ) nx), '[]'::jsonb),

        -- Continuous listening (no timestamp, always on): the live inbox.
        'listens_live', EXISTS (
          SELECT 1 FROM work_watchers lv
           WHERE lv.tenant_id = v_tenant AND lv.de_id = d.id
             AND lv.active AND lv.kind = 'inbox'),

        -- BLOCKED: where the founder is the bottleneck.
        'waiting_on_you', (
          SELECT count(*) FROM human_tasks h
           WHERE h.tenant_id = v_tenant AND h.de_id = d.id AND h.status = 'pending'),
        'blocked_objectives', (
          SELECT count(*) FROM de_objectives b
           WHERE b.tenant_id = v_tenant AND b.de_id = d.id AND b.status = 'blocked'),

        'needs_attention', (
          SELECT count(*) FROM de_objectives n
           WHERE n.tenant_id = v_tenant AND n.de_id = d.id
             AND n.attention_flag IS NOT NULL
             AND n.status IN ('open', 'in_progress', 'blocked')),
        'attention_oldest_since', (
          SELECT min(n.attention_since) FROM de_objectives n
           WHERE n.tenant_id = v_tenant AND n.de_id = d.id
             AND n.attention_flag IS NOT NULL
             AND n.status IN ('open', 'in_progress', 'blocked')),
        'attention_kinds', COALESCE((
          SELECT jsonb_agg(DISTINCT n.attention_flag) FROM de_objectives n
           WHERE n.tenant_id = v_tenant AND n.de_id = d.id
             AND n.attention_flag IS NOT NULL
             AND n.status IN ('open', 'in_progress', 'blocked')), '[]'::jsonb),
        
        'open_objectives', (
          SELECT count(*) FROM de_objectives o2
           WHERE o2.tenant_id = v_tenant AND o2.de_id = d.id
             AND o2.status IN ('open', 'in_progress')),
        'done_today', (
          SELECT count(*) FROM de_work_items t
           WHERE t.tenant_id = v_tenant AND t.de_id = d.id
             AND t.status = 'done' AND t.updated_at >= date_trunc('day', now()))
      ) AS row_json
    FROM digital_employees d
    WHERE d.tenant_id = v_tenant
      -- DE scoping (mig 385/387): every subquery below is correlated to d.id,
      -- so filtering the employee filters its work, its queue and its counts.
      AND public.can_access_de(d.id)
      AND COALESCE(d.lifecycle_status, 'active') NOT IN ('retired')
      AND (p_de_id IS NULL OR d.id = p_de_id)
  ) rows;

  RETURN jsonb_build_object('ok', true, 'board', v_out);
END $function$
;

notify pgrst, 'reload schema';

do $a$
declare v_def text; n int;
begin
  v_def := pg_get_functiondef('public.get_workforce_board(uuid)'::regprocedure);
  if v_def not ilike '%needs_attention%' then raise exception '494: needs_attention did not land'; end if;
  if v_def not ilike '%attention_oldest_since%' then raise exception '494: attention_oldest_since did not land'; end if;
  if v_def not ilike '%attention_kinds%' then raise exception '494: attention_kinds did not land'; end if;
  -- The assignment gate must survive the recreate, or the board would start
  -- showing employees the viewer is not assigned to (docs/29).
  if v_def not ilike '%can_access_de%' then raise exception '494: lost the DE assignment gate'; end if;
  select count(*) into n from de_objectives
   where attention_flag is not null and status in ('open','in_progress','blocked');
  if n = 0 then
    raise notice '494: board widened, but nothing is flagged right now';
  else
    raise notice '494: board now carries the stall signal for % flagged objective(s)', n;
  end if;
end $a$;
