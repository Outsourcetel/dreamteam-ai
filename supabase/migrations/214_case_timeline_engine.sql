-- 214_case_timeline_engine.sql
-- ============================================================================
-- EXEC Phase 0.2 — the case engine: waits, follow-ups, reply-awareness.
--
-- A renewal or dunning motion isn't one action — it's a motion over WEEKS:
--   "send the 60-day notice → wait 5 days → no reply? send a follow-up →
--    log the activity → update the stage → wait for the renewal date."
-- The work engine (migration 156) already holds a case (de_objectives) and its
-- steps (de_work_items), and the de-work loop only re-plans a case whose
-- status='open' and next_wake_at is due. This adds the missing verb: PAUSE a
-- case and schedule a CONTINUATION — either at a fixed time, or awaiting a
-- reply with a deadline.
--
-- Mechanic (no new work engine — sits on the proven spine):
--   • schedule_case_continuation PARKS the case (status in_progress, next_wake_at
--     = fire_at) and records a de_case_events row. The de-work loop leaves a
--     parked case alone.
--   • run_case_timeline (5-min pg_cron, pure SQL) fires due continuations:
--     it re-OPENS the case (status open, next_wake_at now) with the follow-up
--     instruction attached, so the DE resumes exactly where the motion left off.
--   • A reply-await continuation resolves instead of firing if the awaited reply
--     is recorded (resolve_case_await) before its deadline — reply-awareness.
--
-- Nothing here acts on an external system; it only schedules WHEN the DE thinks
-- about a case again. All acts still route through the decision layer.
-- GLOBAL — every tenant.
-- ============================================================================

CREATE TABLE IF NOT EXISTS de_case_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  de_id         uuid NOT NULL REFERENCES digital_employees(id) ON DELETE CASCADE,
  objective_id  uuid NOT NULL REFERENCES de_objectives(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('wait','follow_up')),
  fire_at       timestamptz NOT NULL,
  -- When set, this is a reply-await: if resolve_case_await records the reply
  -- before fire_at, the event resolves silently; otherwise at fire_at it fires
  -- the follow-up (e.g. "no reply in 5 days — send a second reminder").
  awaiting_ref  text,
  instruction   text NOT NULL DEFAULT '',
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','fired','resolved','cancelled')),
  created_by    uuid REFERENCES auth.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz             -- when it fired / resolved / was cancelled
);
CREATE INDEX IF NOT EXISTS idx_de_case_events_due ON de_case_events(fire_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_de_case_events_obj ON de_case_events(objective_id, status);

ALTER TABLE de_case_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS de_case_events_tenant_read ON de_case_events;
CREATE POLICY de_case_events_tenant_read ON de_case_events
  FOR SELECT USING (tenant_id = public.auth_tenant_id());
-- Writes go through the RPCs below (service context + membership-checked), never
-- direct — so a scheduled continuation always matches a real case.

-- ── Schedule a wait / follow-up on a case ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.schedule_case_continuation(
  p_objective_id uuid,
  p_kind         text,
  p_fire_at      timestamptz,
  p_instruction  text DEFAULT '',
  p_awaiting_ref text DEFAULT NULL,
  p_payload      jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_de uuid; v_event uuid; v_is_service boolean := coalesce(auth.role(),'') = 'service_role';
BEGIN
  IF p_kind NOT IN ('wait','follow_up') THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_kind'); END IF;
  IF p_fire_at IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'fire_at_required'); END IF;

  SELECT tenant_id, de_id INTO v_tenant, v_de FROM de_objectives WHERE id = p_objective_id;
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'objective_not_found'); END IF;
  -- A JWT caller must be a member of the case's tenant; service role (de-work,
  -- playbook-execute) is trusted with an explicit objective it already resolved.
  IF NOT v_is_service AND v_tenant IS DISTINCT FROM public.auth_tenant_id() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_tenant_member');
  END IF;

  INSERT INTO de_case_events (tenant_id, de_id, objective_id, kind, fire_at, awaiting_ref, instruction, payload, created_by)
  VALUES (v_tenant, v_de, p_objective_id, p_kind, p_fire_at, p_awaiting_ref, left(coalesce(p_instruction,''), 2000), coalesce(p_payload,'{}'::jsonb), auth.uid())
  RETURNING id INTO v_event;

  -- Park the case: it sleeps until the continuation is due. de-work only
  -- re-plans status='open' cases, so an in_progress case is left alone.
  UPDATE de_objectives
     SET status = CASE WHEN status IN ('achieved','abandoned') THEN status ELSE 'in_progress' END,
         next_wake_at = p_fire_at,
         updated_at = now()
   WHERE id = p_objective_id;

  BEGIN
    PERFORM append_audit_event_internal(v_tenant,
      (SELECT coalesce(persona_name, name) FROM digital_employees WHERE id = v_de), 'de',
      'Case paused — ' || p_kind || (CASE WHEN p_awaiting_ref IS NOT NULL THEN ' awaiting reply' ELSE '' END)
        || ' until ' || to_char(p_fire_at, 'Mon DD HH24:MI') || ': ' || left(coalesce(p_instruction,''), 120),
      'playbook_step',
      jsonb_build_object('kind','case_continuation_scheduled','event_id',v_event,'objective_id',p_objective_id,'continuation_kind',p_kind,'fire_at',p_fire_at,'awaiting_ref',p_awaiting_ref));
  EXCEPTION WHEN OTHERS THEN NULL; END;

  RETURN jsonb_build_object('ok', true, 'event_id', v_event, 'fire_at', p_fire_at);
END; $$;

-- ── Record that an awaited reply arrived — resolve the await, wake the case ──
CREATE OR REPLACE FUNCTION public.resolve_case_await(
  p_tenant_id uuid, p_objective_id uuid, p_awaiting_ref text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer := 0;
BEGIN
  UPDATE de_case_events
     SET status = 'resolved', decided_at = now()
   WHERE tenant_id = p_tenant_id AND objective_id = p_objective_id
     AND status = 'pending' AND awaiting_ref IS NOT NULL AND awaiting_ref = p_awaiting_ref;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  IF v_n > 0 THEN
    -- The reply came — wake the case now so the DE processes it.
    UPDATE de_objectives SET status = 'open', next_wake_at = now(), updated_at = now()
     WHERE id = p_objective_id AND tenant_id = p_tenant_id AND status NOT IN ('achieved','abandoned');
  END IF;
  RETURN jsonb_build_object('ok', true, 'resolved', v_n);
END; $$;

-- ── The tick — fire due continuations, resume their cases (pure SQL) ─────────
CREATE OR REPLACE FUNCTION public.run_case_timeline(p_tenant_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE e de_case_events; v_fired integer := 0;
BEGIN
  FOR e IN
    SELECT * FROM de_case_events
    WHERE status = 'pending' AND fire_at <= now()
      AND (p_tenant_id IS NULL OR tenant_id = p_tenant_id)
    ORDER BY fire_at LIMIT 500
  LOOP
    UPDATE de_case_events SET status = 'fired', decided_at = now() WHERE id = e.id;

    -- Re-open the case with the continuation instruction attached, so de-work
    -- resumes the motion where it paused.
    UPDATE de_objectives
       SET status = CASE WHEN status IN ('achieved','abandoned') THEN status ELSE 'open' END,
           next_wake_at = now(),
           description = coalesce(description,'') || E'\n\n[Follow-up ' || to_char(now(),'Mon DD') || ']: '
             || coalesce(nullif(e.instruction,''),
                  CASE WHEN e.awaiting_ref IS NOT NULL THEN 'No reply received by the deadline — continue the motion.' ELSE 'Scheduled continuation — continue the motion.' END),
           updated_at = now()
     WHERE id = e.objective_id;

    BEGIN
      PERFORM append_audit_event_internal(e.tenant_id,
        (SELECT coalesce(persona_name, name) FROM digital_employees WHERE id = e.de_id), 'de',
        'Case resumed — ' || e.kind || (CASE WHEN e.awaiting_ref IS NOT NULL THEN ' (no reply by deadline)' ELSE '' END)
          || ': ' || left(coalesce(e.instruction,'continue the motion'), 120),
        'playbook_step',
        jsonb_build_object('kind','case_continuation_fired','event_id',e.id,'objective_id',e.objective_id,'continuation_kind',e.kind));
    EXCEPTION WHEN OTHERS THEN NULL; END;

    v_fired := v_fired + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'fired', v_fired);
END; $$;

-- ── Cancel a scheduled continuation (a human closes the case early) ──────────
CREATE OR REPLACE FUNCTION public.cancel_case_continuation(p_event_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM de_case_events WHERE id = p_event_id AND status = 'pending';
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found_or_decided'); END IF;
  IF coalesce(auth.role(),'') <> 'service_role' AND v_tenant IS DISTINCT FROM public.auth_tenant_id() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_tenant_member');
  END IF;
  UPDATE de_case_events SET status = 'cancelled', decided_at = now() WHERE id = p_event_id;
  RETURN jsonb_build_object('ok', true);
END; $$;

REVOKE ALL ON FUNCTION public.schedule_case_continuation(uuid,text,timestamptz,text,text,jsonb) FROM public;
REVOKE ALL ON FUNCTION public.resolve_case_await(uuid,uuid,text) FROM public;
REVOKE ALL ON FUNCTION public.run_case_timeline(uuid) FROM public;
REVOKE ALL ON FUNCTION public.cancel_case_continuation(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.schedule_case_continuation(uuid,text,timestamptz,text,text,jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_case_await(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.run_case_timeline(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_case_continuation(uuid) TO authenticated, service_role;

-- ── The tick — every 5 minutes, pure SQL, upserts by job name (idempotent) ──
SELECT cron.schedule('case-timeline-tick', '*/5 * * * *', 'select public.run_case_timeline()');
