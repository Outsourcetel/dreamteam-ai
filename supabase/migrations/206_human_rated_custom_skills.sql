-- 206: let workspace-defined skills be rated by a person — honestly labelled
--
-- WHY
-- Migration 205 let a workspace define its own skills, but assess_de_skills()
-- computes only the five built-ins from fixed telemetry signals and never
-- consults skill_catalog. A custom skill therefore never got a de_skills row
-- and never appeared anywhere — the definition existed and did nothing.
--
-- The fix is NOT to pretend the platform can assess it. There is no signal
-- for "porting a phone number"; inventing a number would be worse than
-- showing none. Same call as the KPI computed/manual split in 205: a
-- workspace-defined skill is rated by a person, and says so.
--
-- The product's core promise is preserved exactly: proficiency on a BUILT-IN
-- skill is still evidence-only and can never be self-reported. This function
-- refuses to touch them.

CREATE OR REPLACE FUNCTION public.set_de_skill_proficiency(
  p_de_id uuid, p_skill_key text, p_proficiency int, p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_tenant uuid := auth_tenant_id();
  v_is_custom boolean;
  v_rater text;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin']) THEN
    RAISE EXCEPTION 'insufficient_role';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM digital_employees WHERE id = p_de_id AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'de_not_found';
  END IF;

  SELECT (tenant_id IS NOT NULL) INTO v_is_custom
    FROM skill_catalog
   WHERE skill_key = p_skill_key AND (tenant_id IS NULL OR tenant_id = v_tenant);
  IF v_is_custom IS NULL THEN RAISE EXCEPTION 'unknown_skill: %', p_skill_key; END IF;

  -- The guarantee that makes built-in proficiency trustworthy.
  IF NOT v_is_custom THEN
    RAISE EXCEPTION 'builtin_skill_is_evidence_assessed: % cannot be set by hand', p_skill_key;
  END IF;

  IF p_proficiency IS NOT NULL AND (p_proficiency < 1 OR p_proficiency > 5) THEN
    RAISE EXCEPTION 'proficiency must be between 1 and 5';
  END IF;

  SELECT coalesce(full_name, 'a workspace admin') INTO v_rater FROM profiles WHERE user_id = auth.uid();

  INSERT INTO de_skills (tenant_id, de_id, skill_key, proficiency, sample_size, signal_value, detail, assessed_at)
  VALUES (
    v_tenant, p_de_id, p_skill_key, p_proficiency, 0, NULL,
    CASE WHEN p_proficiency IS NULL
      THEN 'Not rated yet — this skill is rated by a person, not measured automatically.'
      ELSE format('Rated %s by %s%s', p_proficiency, v_rater,
                  CASE WHEN coalesce(p_note,'') <> '' THEN ' — ' || p_note ELSE '' END)
    END,
    now()
  )
  ON CONFLICT (de_id, skill_key) DO UPDATE
    SET proficiency = excluded.proficiency,
        detail      = excluded.detail,
        assessed_at = now();

  RETURN jsonb_build_object('ok', true, 'skill_key', p_skill_key, 'proficiency', p_proficiency);
END$$;

-- Needed by the upsert above; harmless if the pair is already unique.
CREATE UNIQUE INDEX IF NOT EXISTS de_skills_de_skill_key ON de_skills (de_id, skill_key);

-- Lists every skill in scope for a DE — built-ins with their assessment, and
-- workspace skills whether or not anyone has rated them yet. Without this the
-- panel can only show skills that already have a de_skills row, which is why
-- a freshly-defined skill was invisible.
CREATE OR REPLACE FUNCTION public.list_de_skills(p_de_id uuid)
RETURNS json
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT coalesce(json_agg(row_to_json(x) ORDER BY x.is_custom, x.sort_order, x.name), '[]'::json)
  FROM (
    SELECT c.skill_key, c.name, c.category, c.description, c.signal_label,
           c.sort_order, (c.tenant_id IS NOT NULL) AS is_custom,
           s.proficiency, coalesce(s.sample_size, 0) AS sample_size,
           s.signal_value,
           coalesce(s.detail, CASE WHEN c.tenant_id IS NOT NULL
             THEN 'Not rated yet — this skill is rated by a person, not measured automatically.'
             ELSE 'Not yet assessed.' END) AS detail
      FROM skill_catalog c
      LEFT JOIN de_skills s ON s.skill_key = c.skill_key AND s.de_id = p_de_id
     WHERE c.tenant_id IS NULL
        OR c.tenant_id = (SELECT tenant_id FROM digital_employees WHERE id = p_de_id)
  ) x;
$$;

REVOKE ALL ON FUNCTION public.set_de_skill_proficiency(uuid, text, int, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_de_skill_proficiency(uuid, text, int, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_de_skills(uuid) TO authenticated, service_role;
