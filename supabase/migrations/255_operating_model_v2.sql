-- ============================================================================
-- 255 — OPERATING MODEL v2 (docs/17 C3)
--
-- The operating-model audit's structural gap #1: an employee's "how I work"
-- was implicit across five tables, its next-step in three places. Migration
-- 248 composed the first read (identity, work sources, SOPs, plate counts);
-- this version completes it into the first-class object:
--
--   + current_focus      — the objective being pursued right now (+ wake)
--   + next_up            — the ordered when-list, SAME truth as the board
--                          (delegates to get_workforce_board — no 2nd calc)
--   + listens_live       — continuous inbox listening (outside the tick)
--   + rhythm             — what it has produced lately (done 7d,
--                          deliverables 7d, the last deliverable)
--
-- One RPC = one legible page: job, cadence, focus, order, output.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_de_operating_model(p_de_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_de record; v_out jsonb; v_board jsonb;
BEGIN
  v_tenant := public.auth_tenant_id();
  IF v_tenant IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_permitted');
  END IF;
  SELECT * INTO v_de FROM digital_employees
   WHERE id = p_de_id AND tenant_id = v_tenant;
  IF v_de.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  -- The board row for this DE — next_up/listens_live come from the exact
  -- same read the whole-workforce board renders.
  v_board := (public.get_workforce_board(p_de_id)->'board')->0;

  v_out := jsonb_build_object(
    'ok', true,
    'identity', jsonb_build_object(
      'de_id', v_de.id, 'name', v_de.name, 'persona_name', v_de.persona_name,
      'department', v_de.department, 'category', v_de.category,
      'trust_level', v_de.trust_level, 'status', v_de.status),
    'work_sources', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'label', w.label, 'description', w.description, 'kind', w.kind,
               'active', w.active, 'next_fire_at', w.next_fire_at,
               'last_run_at', w.last_run_at, 'last_match_count', w.last_match_count)
             ORDER BY w.active DESC, w.label)
        FROM work_watchers w
       WHERE w.tenant_id = v_tenant AND w.de_id = p_de_id), '[]'::jsonb),
    'playbooks', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'key', p.key, 'name', p.name, 'status', p.status,
               'version', p.version, 'steps', jsonb_array_length(p.steps),
               'trigger_type', p.trigger_type)
             ORDER BY p.name)
        FROM playbook_definitions p
       WHERE p.tenant_id = v_tenant AND p.de_id = p_de_id
         AND p.status = 'published'), '[]'::jsonb),
    'open_objectives', COALESCE((
      SELECT count(*) FROM de_objectives o
       WHERE o.tenant_id = v_tenant AND o.de_id = p_de_id
         AND o.status IN ('open','in_progress','blocked')), 0),
    'waiting_on_human', COALESCE((
      SELECT count(*) FROM human_tasks h
       WHERE h.tenant_id = v_tenant AND h.de_id = p_de_id
         AND h.status = 'pending'), 0),

    -- v2 additions ---------------------------------------------------------
    'current_focus', (
      SELECT jsonb_build_object(
               'title', o.title, 'status', o.status,
               'next_wake_at', o.next_wake_at, 'wake_count', o.wake_count,
               'mission_id', o.mission_id, 'due_at', o.due_at)
        FROM de_objectives o
       WHERE o.tenant_id = v_tenant AND o.de_id = p_de_id
         AND o.status = 'in_progress'
       ORDER BY o.updated_at DESC LIMIT 1),
    'next_up', COALESCE(v_board->'next_up', '[]'::jsonb),
    'listens_live', COALESCE(v_board->'listens_live', 'false'::jsonb),
    'rhythm', jsonb_build_object(
      'done_7d', COALESCE((
        SELECT count(*) FROM de_work_items t
         WHERE t.tenant_id = v_tenant AND t.de_id = p_de_id
           AND t.status = 'done'
           AND t.updated_at >= now() - interval '7 days'), 0),
      'deliverables_7d', COALESCE((
        SELECT count(*) FROM de_deliverables d
         WHERE d.tenant_id = v_tenant AND d.de_id = p_de_id
           AND d.created_at >= now() - interval '7 days'), 0),
      'last_deliverable', (
        SELECT jsonb_build_object('title', d.title, 'at', d.created_at)
          FROM de_deliverables d
         WHERE d.tenant_id = v_tenant AND d.de_id = p_de_id
         ORDER BY d.created_at DESC LIMIT 1))
  );
  RETURN v_out;
END $$;

REVOKE ALL ON FUNCTION public.get_de_operating_model(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_de_operating_model(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
