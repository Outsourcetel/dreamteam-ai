-- ============================================================================
-- 254 — THE WORKFORCE BOARD (docs/17 C2)
--
-- One read answering the founder's question the operating-model audit proved
-- unanswerable: "what is my whole workforce doing NOW, what happens NEXT,
-- and where am I the bottleneck?" — for EVERY employee, not just the ones
-- with a live work row this second.
--
-- Also market-validated: conducting.ai sells this exact board as a static
-- Figma ("AI-Native Company Design"); ours renders from live telemetry.
--
-- get_workforce_board(p_de_id default null):
--   * per DE — now (running item), next_up (top 3 across ALL four arrival
--     channels, each with a WHEN), blocked (waiting-on-you + blocked
--     objectives), open_objectives, done_today.
--   * p_de_id scopes to one employee (the Employee File "Next up" panel
--     reads the same truth as the board — no second codepath).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_workforce_board(p_de_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
      AND COALESCE(d.lifecycle_status, 'active') NOT IN ('retired')
      AND (p_de_id IS NULL OR d.id = p_de_id)
  ) rows;

  RETURN jsonb_build_object('ok', true, 'board', v_out);
END $$;

REVOKE ALL ON FUNCTION public.get_workforce_board(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_workforce_board(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
