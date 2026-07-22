-- 248_mission_delegation.sql
-- ============================================================================
-- MISSION DELEGATION (docs/14, founder-approved 2026-07-22): a one-sentence
-- order to a DE compiles into a previewable plan, fans out into the EXISTING
-- objective→case→work-item rails after founder plan-approval, and stays
-- watchable/stoppable. Founder decisions baked in: plan gate ALWAYS,
-- approvals one-by-one, budget = SOFT warning (tenant AI budget stays the
-- only hard stop). GLOBAL — all tenants. Plus two audit-gap fixes:
--   * human_tasks.de_id  → approvals attributable per employee (gap Q5)
--   * get_de_operating_model(de_id) → the composed "how I operate" read
--     (gap #1) used by the mission compiler and the Employee File panel.
-- ============================================================================

-- ── 1. The mission itself ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS de_missions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  de_id          uuid NOT NULL REFERENCES digital_employees(id) ON DELETE CASCADE,
  directive_text text NOT NULL,
  status         text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','compiling','awaiting_approval',
                                   'approved','running','paused','done',
                                   'cancelled','failed')),
  shape          text CHECK (shape IN ('batch','project','standing')),
  compiled_plan  jsonb,          -- interpretation, scope_query, scope_preview,
                                 -- procedure, gates, estimate, dedup
  scope_edits    jsonb,          -- founder's unticks/changes at approval time
  est_cost_usd   numeric,
  spent_usd      numeric NOT NULL DEFAULT 0,
  warn_sent      boolean NOT NULL DEFAULT false,   -- soft-budget warning fired
  error          text,
  report         jsonb,
  created_by     uuid,
  approved_by    uuid,
  approved_at    timestamptz,
  finished_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS de_missions_lookup_idx
  ON de_missions (tenant_id, de_id, status, created_at DESC);

ALTER TABLE de_missions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS de_missions_read ON de_missions;
CREATE POLICY de_missions_read ON de_missions
  FOR SELECT USING (tenant_id = public.auth_tenant_id());
-- Writes go through the de-mission edge function (service role) and the
-- guarded RPCs below — no direct client INSERT/UPDATE policies.

-- ── 2. Fan-out + approval attribution ─────────────────────────────────────
ALTER TABLE de_objectives ADD COLUMN IF NOT EXISTS mission_id uuid
  REFERENCES de_missions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS de_objectives_mission_idx
  ON de_objectives (mission_id) WHERE mission_id IS NOT NULL;

ALTER TABLE human_tasks ADD COLUMN IF NOT EXISTS de_id uuid
  REFERENCES digital_employees(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS human_tasks_de_idx
  ON human_tasks (tenant_id, de_id, status) WHERE de_id IS NOT NULL;

-- ── 3. Create a mission (founder-side, guarded) ───────────────────────────
CREATE OR REPLACE FUNCTION public.create_de_mission(p_de_id uuid, p_directive text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_id uuid;
BEGIN
  v_tenant := public.auth_tenant_id();
  IF v_tenant IS NULL OR NOT public.auth_has_tenant_role(
       ARRAY['tenant_owner','tenant_admin','tenant_manager']) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_permitted');
  END IF;
  IF length(btrim(coalesce(p_directive,''))) < 8 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'directive_too_short');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM digital_employees
                 WHERE id = p_de_id AND tenant_id = v_tenant AND status = 'active') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unknown_or_inactive_de');
  END IF;
  INSERT INTO de_missions (tenant_id, de_id, directive_text, created_by)
  VALUES (v_tenant, p_de_id, btrim(p_directive), auth.uid())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'mission_id', v_id);
END $$;
REVOKE ALL ON FUNCTION public.create_de_mission(uuid, text) FROM anon;

-- ── 4. Pause / resume / cancel (founder-side, guarded; cancel stops queued
--       fan-out but NEVER touches items already at a human gate) ───────────
CREATE OR REPLACE FUNCTION public.set_de_mission_state(p_mission_id uuid, p_action text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_status text; v_next text;
BEGIN
  v_tenant := public.auth_tenant_id();
  IF v_tenant IS NULL OR NOT public.auth_has_tenant_role(
       ARRAY['tenant_owner','tenant_admin','tenant_manager']) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_permitted');
  END IF;
  SELECT status INTO v_status FROM de_missions
   WHERE id = p_mission_id AND tenant_id = v_tenant FOR UPDATE;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  v_next := CASE
    WHEN p_action = 'pause'  AND v_status IN ('approved','running') THEN 'paused'
    WHEN p_action = 'resume' AND v_status = 'paused'                THEN 'running'
    WHEN p_action = 'cancel' AND v_status IN ('draft','awaiting_approval',
                                              'approved','running','paused')
                                                                    THEN 'cancelled'
    ELSE NULL END;
  IF v_next IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_transition',
                              'from', v_status, 'action', p_action);
  END IF;
  UPDATE de_missions SET status = v_next, updated_at = now(),
         finished_at = CASE WHEN v_next = 'cancelled' THEN now() ELSE finished_at END
   WHERE id = p_mission_id;
  IF v_next = 'cancelled' THEN
    -- stop everything still queued; leave in-flight/gated work untouched
    UPDATE de_work_items w SET status = 'cancelled', updated_at = now()
      FROM de_objectives o
     WHERE w.objective_id = o.id AND o.mission_id = p_mission_id
       AND w.tenant_id = v_tenant AND w.status = 'queued';
    UPDATE de_objectives SET status = 'abandoned', updated_at = now()
     WHERE mission_id = p_mission_id AND status IN ('open','in_progress','blocked');
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', v_next);
END $$;
REVOKE ALL ON FUNCTION public.set_de_mission_state(uuid, text) FROM anon;

-- ── 5. The operating-model composed read (audit gap #1) ───────────────────
-- No new state: composes what already exists so the mission compiler and the
-- Employee File "How I operate" panel read the same truth.
CREATE OR REPLACE FUNCTION public.get_de_operating_model(p_de_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_de record; v_out jsonb;
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
         AND h.status = 'pending'), 0)
  );
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.get_de_operating_model(uuid) FROM anon;

NOTIFY pgrst, 'reload schema';
