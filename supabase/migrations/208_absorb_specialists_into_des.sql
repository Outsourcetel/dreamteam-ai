-- ════════════════════════════════════════════════════════════════
-- 208: ABSORB SPECIALISTS INTO DIGITAL EMPLOYEES (Wave 4)
-- ════════════════════════════════════════════════════════════════
-- Founder decision: full merge now, no capability loss. A Specialist
-- stops being a separate citizen — every specialist becomes a digital
-- employee, so there is ONE roster, ONE profile surface, ONE consult
-- path. The specialist's distinctive assets (deep-research sources,
-- media, scribe requests, evidence runs, consultations) are NOT lost:
-- they are repointed to the absorbing DE.
--
-- SAFETY POSTURE:
--   This repoints six live FK-dependent tables. To keep it reversible
--   on a system that has surprised us this session, the old columns
--   (specialist_id / profile_id) are LEFT IN PLACE and a permanent
--   mapping table records every specialist→DE pair. specialist_profiles
--   is not dropped here — a later migration retires it once this is
--   proven stable. Nothing is deleted.
--
--   Idempotent: a specialist already in the map is not absorbed twice.
-- ════════════════════════════════════════════════════════════════

-- ── DE gains a specialist facet ─────────────────────────────────
-- category is CHECK-constrained to Customer/Internal, so an absorbed
-- specialist is an Internal employee flagged as a specialist rather than
-- a new category value.
ALTER TABLE digital_employees ADD COLUMN IF NOT EXISTS is_specialist boolean NOT NULL DEFAULT false;
ALTER TABLE digital_employees ADD COLUMN IF NOT EXISTS specialist_key text;

-- ── The permanent, auditable map ────────────────────────────────
CREATE TABLE IF NOT EXISTS specialist_de_map (
  specialist_id uuid PRIMARY KEY REFERENCES specialist_profiles(id) ON DELETE CASCADE,
  de_id         uuid NOT NULL REFERENCES digital_employees(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL,
  absorbed_at   timestamptz NOT NULL DEFAULT now()
);

-- ── Absorb each specialist as a DE ──────────────────────────────
WITH new_des AS (
  INSERT INTO digital_employees (
    tenant_id, name, description, charter, category, is_specialist, specialist_key,
    lifecycle_status, status, purpose_statement, created_by
  )
  SELECT
    s.tenant_id,
    s.name,
    -- A short human description from the charter's first line.
    coalesce(nullif(split_part(s.charter, E'\n', 1), ''), s.name || ' — specialist advisor'),
    -- DE.charter is jsonb (structured); the specialist's charter is free text.
    -- Store it losslessly under a key rather than dropping it.
    jsonb_build_object('mission', s.charter),
    'Internal',
    true,
    s.key,
    CASE WHEN s.status = 'active' THEN 'active' ELSE 'paused' END,
    'active',
    'Deep-domain specialist advisor consulted by other employees.',
    -- Attribute to a tenant owner where one exists; nullable otherwise.
    (SELECT p.user_id FROM profiles p
      WHERE p.tenant_id = s.tenant_id AND p.role = 'tenant_owner' AND coalesce(p.is_active, true)
      ORDER BY p.created_at LIMIT 1)
  FROM specialist_profiles s
  WHERE NOT EXISTS (SELECT 1 FROM specialist_de_map m WHERE m.specialist_id = s.id)
  RETURNING id AS de_id, specialist_key, tenant_id
)
INSERT INTO specialist_de_map (specialist_id, de_id, tenant_id)
SELECT s.id, n.de_id, n.tenant_id
FROM new_des n
JOIN specialist_profiles s ON s.key = n.specialist_key AND s.tenant_id = n.tenant_id;
-- (The join key is (key, tenant_id), which is unique per tenant.)

-- ── Repoint the six dependents. Old columns are kept for rollback. ──
ALTER TABLE de_specialist_assignments ADD COLUMN IF NOT EXISTS specialist_de_id uuid REFERENCES digital_employees(id) ON DELETE CASCADE;
ALTER TABLE evidence_runs            ADD COLUMN IF NOT EXISTS specialist_de_id uuid REFERENCES digital_employees(id) ON DELETE CASCADE;
ALTER TABLE media_assets             ADD COLUMN IF NOT EXISTS specialist_de_id uuid REFERENCES digital_employees(id) ON DELETE CASCADE;
ALTER TABLE scribe_requests          ADD COLUMN IF NOT EXISTS specialist_de_id uuid REFERENCES digital_employees(id) ON DELETE CASCADE;
ALTER TABLE spec_consultations       ADD COLUMN IF NOT EXISTS specialist_de_id uuid REFERENCES digital_employees(id) ON DELETE CASCADE;
ALTER TABLE specialist_sources       ADD COLUMN IF NOT EXISTS specialist_de_id uuid REFERENCES digital_employees(id) ON DELETE CASCADE;

UPDATE de_specialist_assignments t SET specialist_de_id = m.de_id
  FROM specialist_de_map m WHERE t.specialist_id = m.specialist_id AND t.specialist_de_id IS NULL;
UPDATE evidence_runs t SET specialist_de_id = m.de_id
  FROM specialist_de_map m WHERE t.specialist_id = m.specialist_id AND t.specialist_de_id IS NULL;
UPDATE media_assets t SET specialist_de_id = m.de_id
  FROM specialist_de_map m WHERE t.profile_id = m.specialist_id AND t.specialist_de_id IS NULL;
UPDATE scribe_requests t SET specialist_de_id = m.de_id
  FROM specialist_de_map m WHERE t.profile_id = m.specialist_id AND t.specialist_de_id IS NULL;
UPDATE spec_consultations t SET specialist_de_id = m.de_id
  FROM specialist_de_map m WHERE t.profile_id = m.specialist_id AND t.specialist_de_id IS NULL;
UPDATE specialist_sources t SET specialist_de_id = m.de_id
  FROM specialist_de_map m WHERE t.profile_id = m.specialist_id AND t.specialist_de_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_specialist_sources_de ON specialist_sources(specialist_de_id);
CREATE INDEX IF NOT EXISTS idx_media_assets_de ON media_assets(specialist_de_id);
CREATE INDEX IF NOT EXISTS idx_evidence_runs_specialist_de ON evidence_runs(specialist_de_id);
CREATE INDEX IF NOT EXISTS idx_assignments_specialist_de ON de_specialist_assignments(specialist_de_id);

-- ── Resolve a specialist DE from either an old specialist id or a DE id.
-- Lets edge functions and RPCs accept either during the transition. ──
CREATE OR REPLACE FUNCTION public.resolve_specialist_de(p_ref uuid)
RETURNS uuid LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT coalesce(
    (SELECT de_id FROM specialist_de_map WHERE specialist_id = p_ref),  -- was a specialist id
    (SELECT id FROM digital_employees WHERE id = p_ref AND is_specialist)  -- already a specialist DE
  );
$$;
GRANT EXECUTE ON FUNCTION public.resolve_specialist_de(uuid) TO authenticated, service_role;

-- ── Unified consult surface: DE→DE and DE→specialist in one list. ──
-- Returns every entity a given DE may consult, whether that target is a
-- peer DE (de_consultation_grants) or an absorbed specialist
-- (de_specialist_assignments). One path, as promised.
CREATE OR REPLACE FUNCTION public.list_consultable_for_de(p_de_id uuid)
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(json_agg(row_to_json(x) ORDER BY x.is_specialist DESC, x.name), '[]'::json)
  FROM (
    -- Absorbed specialists this DE is assigned to consult.
    SELECT d.id AS target_de_id, d.name, true AS is_specialist,
           a.rank AS rank, 'assignment' AS grant_kind
      FROM de_specialist_assignments a
      JOIN digital_employees d ON d.id = a.specialist_de_id
     WHERE a.de_id = p_de_id AND a.tenant_id = auth_tenant_id()
       AND d.lifecycle_status NOT IN ('retired','archived')
    UNION ALL
    -- Peer DEs this DE has a consultation grant with.
    SELECT d.id, d.name, false, NULL::int, 'grant'
      FROM de_consultation_grants g
      JOIN digital_employees d ON d.id = g.target_de_id
     WHERE g.requester_de_id = p_de_id AND g.tenant_id = auth_tenant_id() AND g.active
       AND d.lifecycle_status NOT IN ('retired','archived')
  ) x;
$$;
GRANT EXECUTE ON FUNCTION public.list_consultable_for_de(uuid) TO authenticated, service_role;
