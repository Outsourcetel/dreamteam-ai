-- ════════════════════════════════════════════════════════════════
-- 207: OBJECTIVES + EXCEPTIONS BECOME EDITABLE; MEMORY BECOMES READABLE
-- ════════════════════════════════════════════════════════════════
-- Founder feedback on the DE workbench: memory is an undifferentiated
-- wall of rows, and objectives and exceptions can be looked at but not
-- acted on.
--
-- That was literally true — deWorkbenchApi.ts only ever SELECTed from
-- de_memory, de_objectives and de_exceptions. There was no write path at
-- all, so an objective could only be created by the DE's own planner and
-- an exception could sit "pending" forever with no way to answer it.
-- This adds the missing verbs, plus a grouped read for memory.
-- ════════════════════════════════════════════════════════════════

-- ── 1. Objectives a person can set and change ───────────────────
CREATE OR REPLACE FUNCTION public.upsert_de_objective(
  p_de_id       uuid,
  p_title       text,
  p_id          uuid    DEFAULT NULL,
  p_description text    DEFAULT NULL,
  p_priority    int     DEFAULT 3,
  p_due_at      timestamptz DEFAULT NULL,
  p_status      text    DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_tenant uuid := auth_tenant_id(); v_id uuid; v_de_name text;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin']) THEN
    RAISE EXCEPTION 'insufficient_role';
  END IF;
  SELECT name INTO v_de_name FROM digital_employees
   WHERE id = p_de_id AND tenant_id = v_tenant;
  IF v_de_name IS NULL THEN RAISE EXCEPTION 'de_not_found'; END IF;
  IF coalesce(trim(p_title), '') = '' THEN RAISE EXCEPTION 'an objective needs a title'; END IF;
  IF p_priority IS NOT NULL AND (p_priority < 1 OR p_priority > 5) THEN
    RAISE EXCEPTION 'priority must be between 1 and 5';
  END IF;

  IF p_id IS NULL THEN
    -- description is NOT NULL on this table; default it to the title rather
    -- than forcing the caller to type boilerplate.
    INSERT INTO de_objectives (tenant_id, de_id, title, description, priority, due_at, status, created_by)
    VALUES (v_tenant, p_de_id, trim(p_title), coalesce(p_description, trim(p_title)),
            coalesce(p_priority, 3), p_due_at, coalesce(p_status, 'open'), auth.uid())
    RETURNING id INTO v_id;
  ELSE
    UPDATE de_objectives SET
      title       = trim(p_title),
      description = coalesce(p_description, description),
      priority    = coalesce(p_priority, priority),
      due_at      = p_due_at,
      status      = coalesce(p_status, status),
      updated_at  = now()
    WHERE id = p_id AND tenant_id = v_tenant AND de_id = p_de_id
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'objective_not_found'; END IF;
  END IF;

  PERFORM append_audit_event(
    v_tenant, 'Workspace', 'human',
    format('%s objective %s — "%s"', v_de_name,
           CASE WHEN p_id IS NULL THEN 'created' ELSE 'updated' END, trim(p_title)),
    'config_change',
    jsonb_build_object('de_id', p_de_id, 'objective_id', v_id, 'status', coalesce(p_status, 'open'))
  );
  RETURN v_id;
END$$;

-- ── 2. Answering an exception ───────────────────────────────────
-- An exception is the DE saying "this situation isn't covered — here is
-- what I propose". Approving or rejecting it is a judgment call that only
-- a person should make, which is why there is no auto path here.
CREATE OR REPLACE FUNCTION public.decide_de_exception(
  p_exception_id uuid,
  p_decision     text,               -- 'approved' | 'rejected'
  p_outcome      text DEFAULT NULL,  -- what actually happened / why
  p_learned      boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_tenant uuid := auth_tenant_id(); v_row de_exceptions; v_de_name text;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin']) THEN
    RAISE EXCEPTION 'insufficient_role';
  END IF;
  IF p_decision NOT IN ('approved','rejected') THEN
    RAISE EXCEPTION 'decision must be approved or rejected';
  END IF;

  SELECT * INTO v_row FROM de_exceptions WHERE id = p_exception_id AND tenant_id = v_tenant;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'exception_not_found'; END IF;
  IF v_row.status <> 'pending' THEN RAISE EXCEPTION 'already_decided: %', v_row.status; END IF;

  SELECT name INTO v_de_name FROM digital_employees WHERE id = v_row.de_id;

  UPDATE de_exceptions SET
    status     = p_decision,
    outcome    = p_outcome,
    learned    = coalesce(p_learned, false),
    decided_by = auth.uid(),
    decided_at = now()
  WHERE id = p_exception_id;

  PERFORM append_audit_event(
    v_tenant, 'Workspace', 'human',
    format('%s exception %s — %s', coalesce(v_de_name, 'An employee'), p_decision,
           left(v_row.situation, 120)),
    'decision',
    jsonb_build_object('exception_id', p_exception_id, 'de_id', v_row.de_id,
                       'decision', p_decision, 'learned', coalesce(p_learned, false))
  );
  RETURN jsonb_build_object('ok', true, 'status', p_decision);
END$$;

-- ── 3. Memory, grouped instead of a flat wall ───────────────────
-- Returns one row per (subject_kind, subject_ref) with a count, the most
-- recent entries, and the highest salience in the group — so the workbench
-- can show "Acme Corp — 12 things remembered" and expand on demand.
CREATE OR REPLACE FUNCTION public.list_de_memory_grouped(p_de_id uuid, p_limit int DEFAULT 50)
RETURNS json
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT coalesce(json_agg(row_to_json(g) ORDER BY g.top_salience DESC, g.item_count DESC), '[]'::json)
  FROM (
    SELECT
      m.subject_kind,
      m.subject_ref,
      count(*)                       AS item_count,
      max(m.salience)                AS top_salience,
      max(m.created_at)::text        AS newest_at,
      -- The entries themselves, most salient first, capped so one noisy
      -- subject cannot dominate the payload.
      (SELECT json_agg(row_to_json(e))
         FROM (
           SELECT i.id, i.kind, i.content, i.salience, i.source, i.created_at::text
             FROM de_memory i
            WHERE i.de_id = m.de_id
              AND i.subject_kind IS NOT DISTINCT FROM m.subject_kind
              AND i.subject_ref  IS NOT DISTINCT FROM m.subject_ref
              AND (i.expires_at IS NULL OR i.expires_at > now())
            ORDER BY i.salience DESC, i.created_at DESC
            LIMIT 25
         ) e
      ) AS items
    FROM de_memory m
    WHERE m.de_id = p_de_id
      AND m.tenant_id = auth_tenant_id()
      AND (m.expires_at IS NULL OR m.expires_at > now())
    GROUP BY m.de_id, m.subject_kind, m.subject_ref
    LIMIT greatest(1, least(p_limit, 200))
  ) g;
$$;

-- Forgetting something a DE remembered is a legitimate correction — a
-- wrong memory otherwise keeps influencing answers with no way to stop it.
CREATE OR REPLACE FUNCTION public.forget_de_memory(p_memory_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_tenant uuid := auth_tenant_id(); v_row de_memory;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin']) THEN
    RAISE EXCEPTION 'insufficient_role';
  END IF;
  SELECT * INTO v_row FROM de_memory WHERE id = p_memory_id AND tenant_id = v_tenant;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'memory_not_found'; END IF;

  DELETE FROM de_memory WHERE id = p_memory_id;

  PERFORM append_audit_event(
    v_tenant, 'Workspace', 'human',
    format('Memory removed — %s', left(v_row.content, 120)), 'config_change',
    jsonb_build_object('de_id', v_row.de_id, 'kind', v_row.kind, 'subject_ref', v_row.subject_ref)
  );
  RETURN jsonb_build_object('ok', true);
END$$;

REVOKE ALL ON FUNCTION public.upsert_de_objective(uuid, text, uuid, text, int, timestamptz, text) FROM public, anon;
REVOKE ALL ON FUNCTION public.decide_de_exception(uuid, text, text, boolean) FROM public, anon;
REVOKE ALL ON FUNCTION public.forget_de_memory(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.upsert_de_objective(uuid, text, uuid, text, int, timestamptz, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.decide_de_exception(uuid, text, text, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.forget_de_memory(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_de_memory_grouped(uuid, int) TO authenticated, service_role;
