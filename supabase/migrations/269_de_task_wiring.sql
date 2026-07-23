-- ═══════════════════════════════════════════════════════════════
-- 269 — T1.2: wire the dormant cross-DE delegation engine (docs/22)
--
-- request_de_task (mig 234) opens a real de_objectives case on the receiver,
-- but nothing ever called it (no de-work tool, no UI) and nothing closes the
-- de_task_requests status loop. This migration makes it safe to surface:
--   (A) reflect a delegated objective's terminal state back onto its
--       de_task_requests row — otherwise the UI shows "requested" forever for
--       work the receiver already finished (autonomous loop never calls
--       respond_de_task). No recursion: respond_de_task sets the REQUEST
--       terminal BEFORE the objective, so this trigger's open-filter excludes it.
--   (B) admin-gate the HUMAN assign path (parity with de_consultation_grants
--       RLS, mig 111) — assigning autonomous, budget-spending work should meet
--       the same bar as configuring collaboration. The DE mid-motion path
--       (p_from_de_id set, service_role) is unaffected.
--   (C) SQL single-hop backstop — a task opened FROM a de_task case cannot
--       re-delegate onward, even if a future caller invokes the RPC directly.
-- ═══════════════════════════════════════════════════════════════

-- ── (A) close the status loop ──
CREATE OR REPLACE FUNCTION public.sync_de_task_from_objective()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.entity_kind = 'de_task'
     AND NEW.status IN ('achieved','blocked') THEN
    UPDATE de_task_requests
       SET status       = CASE WHEN NEW.status = 'achieved' THEN 'completed' ELSE 'failed' END,
           completed_at = coalesce(completed_at, now()),
           responded_at = coalesce(responded_at, now())
     WHERE objective_id = NEW.id
       AND status IN ('requested','accepted','in_progress');
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_sync_de_task_from_objective ON de_objectives;
CREATE TRIGGER trg_sync_de_task_from_objective
  AFTER UPDATE OF status ON de_objectives
  FOR EACH ROW EXECUTE FUNCTION public.sync_de_task_from_objective();

-- ── (B)+(C) redefine request_de_task with the human-path admin gate and the
--     single-hop backstop. Same signature as mig 234 → clean replace. ──
CREATE OR REPLACE FUNCTION public.request_de_task(
  p_from_de_id uuid, p_to_de_id uuid, p_title text,
  p_context text DEFAULT NULL, p_expected_output text DEFAULT NULL,
  p_urgency text DEFAULT 'normal', p_due_date date DEFAULT NULL,
  p_related_table text DEFAULT NULL, p_related_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid; v_to_tenant uuid; v_from_name text; v_to_name text;
  v_existing uuid; v_open_pair int; v_req uuid; v_obj uuid; v_title text;
  v_is_service boolean := coalesce(auth.role(),'') = 'service_role';
BEGIN
  v_title := left(btrim(coalesce(p_title,'')), 200);
  IF v_title = '' THEN RETURN jsonb_build_object('ok', false, 'error', 'title_required'); END IF;
  IF p_to_de_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'to_de_required'); END IF;
  IF p_from_de_id IS NOT NULL AND p_from_de_id = p_to_de_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_self_assignment');
  END IF;

  SELECT tenant_id, coalesce(persona_name, name) INTO v_to_tenant, v_to_name FROM digital_employees WHERE id = p_to_de_id;
  IF v_to_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'target_not_found'); END IF;
  v_tenant := v_to_tenant;
  IF NOT v_is_service AND v_tenant IS DISTINCT FROM public.auth_tenant_id() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_tenant_member');
  END IF;

  -- (B) HUMAN path is admin-only.
  IF p_from_de_id IS NULL AND NOT v_is_service
     AND NOT public.auth_has_tenant_role(array['tenant_owner','tenant_admin']) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_permitted',
      'detail', 'Only workspace owners/admins can assign tasks to an employee.');
  END IF;

  -- (C) SINGLE-HOP backstop: a task opened FROM a de_task case cannot re-delegate.
  IF p_from_de_id IS NOT NULL AND p_related_table = 'de_objectives' AND p_related_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM de_objectives o WHERE o.id = p_related_id AND o.entity_kind = 'de_task') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'chain_too_deep',
      'detail', 'A delegated task cannot itself be delegated onward.');
  END IF;

  IF p_from_de_id IS NOT NULL THEN
    SELECT coalesce(persona_name, name) INTO v_from_name FROM digital_employees WHERE id = p_from_de_id AND tenant_id = v_tenant;
    IF v_from_name IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'requester_not_in_tenant'); END IF;
    IF NOT EXISTS (SELECT 1 FROM de_consultation_grants g
      WHERE g.tenant_id = v_tenant AND g.requester_de_id = p_from_de_id AND g.target_de_id = p_to_de_id AND g.active) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'not_permitted',
        'detail', 'No active collaboration grant from the requesting employee to the target. A tenant admin configures these.');
    END IF;
    IF EXISTS (SELECT 1 FROM de_task_requests r
      WHERE r.tenant_id = v_tenant AND r.from_de_id = p_to_de_id AND r.to_de_id = p_from_de_id
        AND lower(r.title) = lower(v_title) AND r.status IN ('requested','accepted','in_progress')) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'circular', 'detail', 'A reverse task on the same subject is already open.');
    END IF;
    SELECT count(*) INTO v_open_pair FROM de_task_requests r
      WHERE r.tenant_id = v_tenant AND r.from_de_id = p_from_de_id AND r.to_de_id = p_to_de_id
        AND r.status IN ('requested','accepted','in_progress');
    IF v_open_pair >= 20 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'too_many_open', 'detail', 'Too many open tasks to this employee already.');
    END IF;
  ELSE
    v_from_name := 'You';
  END IF;

  SELECT id INTO v_existing FROM de_task_requests r
    WHERE r.tenant_id = v_tenant AND r.to_de_id = p_to_de_id
      AND coalesce(r.from_de_id::text,'human') = coalesce(p_from_de_id::text,'human')
      AND lower(r.title) = lower(v_title) AND r.status IN ('requested','accepted','in_progress')
    ORDER BY r.created_at DESC LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'deduped', true, 'request_id', v_existing);
  END IF;

  INSERT INTO de_task_requests (tenant_id, from_de_id, to_de_id, title, context, expected_output, urgency, due_date, related_table, related_id, created_by)
  VALUES (v_tenant, p_from_de_id, p_to_de_id, v_title, left(p_context, 4000), left(p_expected_output, 2000),
          CASE WHEN p_urgency IN ('low','normal','high','urgent') THEN p_urgency ELSE 'normal' END,
          p_due_date, p_related_table, p_related_id, auth.uid())
  RETURNING id INTO v_req;

  INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, due_at, plan)
  VALUES (v_tenant, p_to_de_id, left('Task from ' || coalesce(v_from_name,'a colleague') || ': ' || v_title, 200),
          'Assigned by ' || coalesce(v_from_name,'a colleague') || '. ' || coalesce(left(p_context,1000),'')
            || coalesce(E'\nExpected: ' || left(p_expected_output,500), ''),
          'de_task', v_req::text, 'open',
          CASE p_urgency WHEN 'urgent' THEN 5 WHEN 'high' THEN 30 ELSE 60 END,
          p_due_date::timestamptz,
          jsonb_build_object('source','cross_de_task','request_id',v_req,'from_de_id',p_from_de_id,'urgency',p_urgency))
  RETURNING id INTO v_obj;
  UPDATE de_task_requests SET objective_id = v_obj WHERE id = v_req;

  BEGIN PERFORM append_audit_event_internal(v_tenant, coalesce(v_from_name,'You'), CASE WHEN p_from_de_id IS NULL THEN 'human' ELSE 'de' END,
    coalesce(v_from_name,'You') || ' assigned a task to ' || v_to_name || ' — "' || v_title || '"', 'de_consultation',
    jsonb_build_object('kind','de_task_assigned','request_id',v_req,'from_de_id',p_from_de_id,'to_de_id',p_to_de_id,'objective_id',v_obj));
  EXCEPTION WHEN OTHERS THEN NULL; END;

  RETURN jsonb_build_object('ok', true, 'request_id', v_req, 'objective_id', v_obj);
END; $$;
REVOKE ALL ON FUNCTION public.request_de_task(uuid,uuid,text,text,text,text,date,text,uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.request_de_task(uuid,uuid,text,text,text,text,date,text,uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
