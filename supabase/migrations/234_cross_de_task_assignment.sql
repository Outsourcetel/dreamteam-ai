-- 234_cross_de_task_assignment.sql
-- ============================================================================
-- Platform refinement — structured cross-DE TASK ASSIGNMENT.
--
-- The platform already has bounded DE-to-DE CONSULTATION (mig 111): one DE asks
-- another a scoped question, permitted only by an active de_consultation_grant.
-- That is Q&A, not delegation. This adds the missing piece the 9-DE vision
-- assumes — a DE (or a human on its behalf) can create a STRUCTURED, TRACKED
-- request for another DE (Marketing → SDR, Billing → Accounting, etc.):
--   • Structured — title, context, expected output, urgency, due date, source
--     records, and a status lifecycle.
--   • Permission-controlled — reuses the SAME de_consultation_grants allow-list
--     (no new permission model); a task can only go where a consult could.
--   • Tenant-safe — RLS + tenant checks on every path.
--   • Traceable + human-observable — audited (category 'de_consultation') and
--     readable by tenant members.
--   • Idempotent + bounded — dedupes an identical open request, blocks the
--     reverse-direction loop (A→B→A on the same subject), and caps open tasks
--     per requester→target pair. No endless agent loops, no circular delegation.
--   • Reuses the WORK ENGINE — an accepted task opens a de_objectives case on the
--     receiving DE, so it flows through the existing planner/worker/reviewer loop
--     rather than any parallel orchestration (docs §7.6 stays Phase-1 shaped).
--
-- SQL only. The de-work TOOL that lets a DE assign a task mid-motion is a
-- follow-up (like the continuity write-back tool); today the RPC is callable by
-- the work loop (service) and by a human via the UI. GLOBAL.
-- ============================================================================

CREATE TABLE IF NOT EXISTS de_task_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_de_id      uuid REFERENCES digital_employees(id) ON DELETE SET NULL,   -- null = assigned by a human
  to_de_id        uuid NOT NULL REFERENCES digital_employees(id) ON DELETE CASCADE,
  title           text NOT NULL,
  context         text,                       -- approved context shared with the receiver
  expected_output text,
  urgency         text NOT NULL DEFAULT 'normal' CHECK (urgency IN ('low','normal','high','urgent')),
  due_date        date,
  related_table   text,                        -- optional source record reference
  related_id      uuid,
  status          text NOT NULL DEFAULT 'requested'
                    CHECK (status IN ('requested','accepted','in_progress','completed','declined','failed')),
  result          text,
  objective_id    uuid REFERENCES de_objectives(id) ON DELETE SET NULL,  -- the case opened on the receiver
  created_by      uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  responded_at    timestamptz,
  completed_at    timestamptz,
  CHECK (from_de_id IS NULL OR from_de_id <> to_de_id)   -- no self-assignment
);
CREATE INDEX IF NOT EXISTS idx_de_task_requests_to ON de_task_requests(to_de_id, status);
CREATE INDEX IF NOT EXISTS idx_de_task_requests_tenant ON de_task_requests(tenant_id, created_at DESC);
ALTER TABLE de_task_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS de_task_requests_tenant_read ON de_task_requests;
CREATE POLICY de_task_requests_tenant_read ON de_task_requests
  FOR SELECT USING (tenant_id = public.auth_tenant_id());
-- No tenant write policy: writes go through the gated RPCs below (service or the
-- requester's own context), never free-form client inserts.
REVOKE ALL ON de_task_requests FROM public, anon;
GRANT SELECT ON de_task_requests TO authenticated;
GRANT ALL ON de_task_requests TO service_role;

-- ── request_de_task — create a bounded, permitted, idempotent assignment ─────
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

  IF p_from_de_id IS NOT NULL THEN
    SELECT coalesce(persona_name, name) INTO v_from_name FROM digital_employees WHERE id = p_from_de_id AND tenant_id = v_tenant;
    IF v_from_name IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'requester_not_in_tenant'); END IF;
    -- PERMISSION: a DE may assign only where it is allowed to consult (allow-list).
    IF NOT EXISTS (
      SELECT 1 FROM de_consultation_grants g
      WHERE g.tenant_id = v_tenant AND g.requester_de_id = p_from_de_id AND g.target_de_id = p_to_de_id AND g.active
    ) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'not_permitted',
        'detail', 'No active collaboration grant from the requesting employee to the target. A tenant admin configures these.');
    END IF;
    -- LOOP GUARD: refuse the reverse-direction task on the same subject.
    IF EXISTS (
      SELECT 1 FROM de_task_requests r
      WHERE r.tenant_id = v_tenant AND r.from_de_id = p_to_de_id AND r.to_de_id = p_from_de_id
        AND lower(r.title) = lower(v_title) AND r.status IN ('requested','accepted','in_progress')
    ) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'circular', 'detail', 'A reverse task on the same subject is already open.');
    END IF;
    -- BOUND: cap concurrent open tasks per requester→target pair.
    SELECT count(*) INTO v_open_pair FROM de_task_requests r
      WHERE r.tenant_id = v_tenant AND r.from_de_id = p_from_de_id AND r.to_de_id = p_to_de_id
        AND r.status IN ('requested','accepted','in_progress');
    IF v_open_pair >= 20 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'too_many_open', 'detail', 'Too many open tasks to this employee already.');
    END IF;
  ELSE
    v_from_name := 'You';  -- human-assigned
  END IF;

  -- IDEMPOTENCY: an identical open request (same from/to/title) is returned as-is.
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

  -- Open a case on the RECEIVER so it flows through the existing work engine.
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

-- ── respond_de_task — receiver (or a human) advances the task ────────────────
CREATE OR REPLACE FUNCTION public.respond_de_task(p_request_id uuid, p_status text, p_result text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r de_task_requests; v_to_name text; v_is_service boolean := coalesce(auth.role(),'') = 'service_role';
BEGIN
  IF p_status NOT IN ('accepted','in_progress','completed','declined','failed') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_status');
  END IF;
  SELECT * INTO r FROM de_task_requests WHERE id = p_request_id;
  IF r.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF NOT v_is_service AND r.tenant_id IS DISTINCT FROM public.auth_tenant_id() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_tenant_member');
  END IF;
  IF r.status IN ('completed','declined','failed') THEN
    RETURN jsonb_build_object('ok', true, 'already', r.status);
  END IF;

  SELECT coalesce(persona_name, name) INTO v_to_name FROM digital_employees WHERE id = r.to_de_id;
  UPDATE de_task_requests
     SET status = p_status,
         result = coalesce(left(p_result, 4000), result),
         responded_at = coalesce(responded_at, now()),
         completed_at = CASE WHEN p_status IN ('completed','declined','failed') THEN now() ELSE completed_at END
   WHERE id = p_request_id;

  -- Reflect terminal states onto the receiver's case so the work engine closes it.
  IF p_status IN ('completed','declined','failed') AND r.objective_id IS NOT NULL THEN
    UPDATE de_objectives SET status = CASE WHEN p_status = 'completed' THEN 'achieved' ELSE 'blocked' END
     WHERE id = r.objective_id;
  END IF;

  BEGIN PERFORM append_audit_event_internal(r.tenant_id, coalesce(v_to_name,'DE'), 'de',
    coalesce(v_to_name,'DE') || ' marked task "' || r.title || '" as ' || p_status, 'de_consultation',
    jsonb_build_object('kind','de_task_response','request_id',r.id,'status',p_status));
  EXCEPTION WHEN OTHERS THEN NULL; END;

  RETURN jsonb_build_object('ok', true, 'status', p_status);
END; $$;

REVOKE ALL ON FUNCTION public.request_de_task(uuid,uuid,text,text,text,text,date,text,uuid) FROM public, anon;
REVOKE ALL ON FUNCTION public.respond_de_task(uuid,text,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.request_de_task(uuid,uuid,text,text,text,text,date,text,uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.respond_de_task(uuid,text,text) TO authenticated, service_role;
