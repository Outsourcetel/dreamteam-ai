-- 221_connected_systems_desk.sql
-- ============================================================================
-- DEEPEN — the Connected Systems desk. Today a role's desk is hardcoded per
-- entity_kind (customer_account → one snapshot). Real businesses configure the
-- SAME role differently: one Renewal DE just reads a CRM amount; another reads
-- system A, writes system B, then comes back and VERIFIES in system C. This
-- makes the desk CONFIGURABLE per DE, and adds the missing read → write → verify
-- primitives so a DE can confirm its own writes landed.
--
-- v1 bindings are INTERNAL tables (customer_accounts, opportunities); the same
-- config swaps source_table → an external CRM/ERP connector once creds land, and
-- the read/verify RPCs route there instead. write stays the proven gated
-- write-back registries (account/opportunity). GLOBAL — every tenant.
--
-- Proven at the DATA layer this build (reads, verify, gate). The de-work tools
-- that let a DE CHOOSE read/verify mid-motion are wired but need the LLM to
-- exercise — blocked on Anthropic credits, so unverified-autonomous for now.
-- ============================================================================

-- 1. Per-DE system registry (the configurable desk) --------------------------
CREATE TABLE IF NOT EXISTS de_connected_systems (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  de_id         uuid NOT NULL REFERENCES digital_employees(id) ON DELETE CASCADE,
  system_key    text NOT NULL,              -- e.g. 'accounts', 'pipeline', 'billing'
  label         text NOT NULL,
  binding_kind  text NOT NULL DEFAULT 'internal_table' CHECK (binding_kind IN ('internal_table','connector')),
  source_table  text,                        -- internal_table binding: the table
  id_column     text NOT NULL DEFAULT 'id',
  read_fields   jsonb NOT NULL DEFAULT '[]'::jsonb,   -- which columns a read returns
  write_registry text,                       -- 'account' | 'opportunity' | null (which gated write-back path)
  can_read      boolean NOT NULL DEFAULT true,
  can_write     boolean NOT NULL DEFAULT false,
  can_verify    boolean NOT NULL DEFAULT true,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (de_id, system_key)
);
ALTER TABLE de_connected_systems ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS de_connected_systems_tenant_read ON de_connected_systems;
CREATE POLICY de_connected_systems_tenant_read ON de_connected_systems
  FOR SELECT USING (tenant_id = public.auth_tenant_id());
DROP POLICY IF EXISTS de_connected_systems_admin_write ON de_connected_systems;
CREATE POLICY de_connected_systems_admin_write ON de_connected_systems
  FOR ALL USING (tenant_id = public.auth_tenant_id() AND public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin']))
  WITH CHECK (tenant_id = public.auth_tenant_id() AND public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin']));

-- The verify audit trail — proof the DE came back and checked its own work.
CREATE TABLE IF NOT EXISTS de_system_verifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  de_id         uuid REFERENCES digital_employees(id) ON DELETE SET NULL,
  objective_id  uuid REFERENCES de_objectives(id) ON DELETE SET NULL,
  system_key    text NOT NULL,
  entity_ref    text NOT NULL,
  expectation   jsonb NOT NULL,
  actual        jsonb NOT NULL,
  matched       boolean NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_de_system_verifications_de ON de_system_verifications(de_id, created_at DESC);
ALTER TABLE de_system_verifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS de_system_verifications_tenant_read ON de_system_verifications;
CREATE POLICY de_system_verifications_tenant_read ON de_system_verifications
  FOR SELECT USING (tenant_id = public.auth_tenant_id());

-- 2. get_de_systems — the DE's desk config (for de-work tools + briefing) -----
CREATE OR REPLACE FUNCTION public.get_de_systems(p_de_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'system_key', system_key, 'label', label, 'source_table', source_table,
    'read_fields', read_fields, 'can_read', can_read, 'can_write', can_write,
    'can_verify', can_verify, 'write_registry', write_registry) ORDER BY system_key), '[]'::jsonb)
  FROM de_connected_systems WHERE de_id = p_de_id AND active;
$$;

-- 3. read_de_system — a GROUNDED read of registered fields (v1 internal) ------
-- Generalizes the hardcoded account/opportunity snapshot: returns exactly the
-- columns the desk config allows, for any registered internal system.
CREATE OR REPLACE FUNCTION public.read_de_system(p_de_id uuid, p_system_key text, p_entity_ref text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s de_connected_systems; v_tenant uuid; v_sql text; v_row jsonb;
  v_is_service boolean := coalesce(auth.role(),'') = 'service_role';
BEGIN
  SELECT tenant_id INTO v_tenant FROM digital_employees WHERE id = p_de_id;
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'de_not_found'); END IF;
  IF NOT v_is_service AND v_tenant IS DISTINCT FROM public.auth_tenant_id() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_tenant_member');
  END IF;

  SELECT * INTO s FROM de_connected_systems WHERE de_id = p_de_id AND system_key = p_system_key AND active;
  IF s.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'system_not_configured'); END IF;
  IF NOT s.can_read THEN RETURN jsonb_build_object('ok', false, 'error', 'read_not_allowed'); END IF;
  IF s.binding_kind <> 'internal_table' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'connector_read_pending_creds', 'system_key', p_system_key);
  END IF;

  -- Whitelist: source_table + read_fields come from admin-written config, never
  -- from the caller; the entity_ref is bound as a parameter (no interpolation).
  IF NOT (s.source_table = ANY (ARRAY['customer_accounts','opportunities','account_activities','opportunity_activities'])) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unsupported_source_table');
  END IF;

  v_sql := format(
    'SELECT to_jsonb(t) - (SELECT coalesce(array_agg(k),ARRAY[]::text[]) FROM (SELECT key AS k FROM jsonb_each(to_jsonb(t)) WHERE key <> ALL (SELECT jsonb_array_elements_text($3))) x) FROM %I t WHERE t.%I = $1::uuid AND t.tenant_id = $2',
    s.source_table, s.id_column);
  EXECUTE v_sql INTO v_row USING p_entity_ref, v_tenant, s.read_fields;
  IF v_row IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'record_not_found'); END IF;
  RETURN jsonb_build_object('ok', true, 'system_key', p_system_key, 'record', v_row);
END; $$;

-- 4. verify_de_system — re-read + compare to an expectation, record the check -
-- The missing "come back and verify" primitive: after a write, the DE confirms
-- the record now matches what it intended, and the check is audited.
CREATE OR REPLACE FUNCTION public.verify_de_system(
  p_de_id uuid, p_system_key text, p_entity_ref text, p_expectation jsonb, p_objective_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_read jsonb; v_actual jsonb; v_matched boolean := true; v_diffs jsonb := '[]'::jsonb;
  k text; v_exp text; v_act text; v_tenant uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM digital_employees WHERE id = p_de_id;
  v_read := public.read_de_system(p_de_id, p_system_key, p_entity_ref);
  IF (v_read->>'ok') <> 'true' THEN RETURN v_read; END IF;
  v_actual := v_read->'record';

  FOR k IN SELECT jsonb_object_keys(p_expectation) LOOP
    v_exp := p_expectation->>k;
    v_act := v_actual->>k;
    IF v_exp IS DISTINCT FROM v_act THEN
      v_matched := false;
      v_diffs := v_diffs || jsonb_build_object('field', k, 'expected', v_exp, 'actual', v_act);
    END IF;
  END LOOP;

  INSERT INTO de_system_verifications (tenant_id, de_id, objective_id, system_key, entity_ref, expectation, actual, matched)
  VALUES (v_tenant, p_de_id, p_objective_id, p_system_key, p_entity_ref, p_expectation, v_actual, v_matched);

  RETURN jsonb_build_object('ok', true, 'matched', v_matched, 'diffs', v_diffs, 'actual', v_actual);
END; $$;

REVOKE ALL ON FUNCTION public.read_de_system(uuid,text,text) FROM public, anon;
REVOKE ALL ON FUNCTION public.verify_de_system(uuid,text,text,jsonb,uuid) FROM public, anon;
REVOKE ALL ON FUNCTION public.get_de_systems(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.read_de_system(uuid,text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.verify_de_system(uuid,text,text,jsonb,uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_de_systems(uuid) TO authenticated, service_role;

-- 5. Archetype kits carry system templates; installer stamps them ------------
ALTER TABLE role_archetypes ADD COLUMN IF NOT EXISTS system_templates jsonb;

CREATE OR REPLACE FUNCTION public.install_role_systems(p_de_id uuid, p_archetype_key text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a role_archetypes; v_tenant uuid; s jsonb; v_n int := 0;
BEGIN
  SELECT tenant_id INTO v_tenant FROM digital_employees WHERE id = p_de_id;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'unknown DE %', p_de_id; END IF;
  SELECT * INTO a FROM role_archetypes WHERE key = p_archetype_key;
  IF a.system_templates IS NULL THEN RETURN 0; END IF;
  FOR s IN SELECT * FROM jsonb_array_elements(a.system_templates) LOOP
    INSERT INTO de_connected_systems (tenant_id, de_id, system_key, label, binding_kind, source_table, id_column,
      read_fields, write_registry, can_read, can_write, can_verify)
    VALUES (v_tenant, p_de_id, s->>'system_key', s->>'label', coalesce(s->>'binding_kind','internal_table'),
      s->>'source_table', coalesce(s->>'id_column','id'), coalesce(s->'read_fields','[]'::jsonb), s->>'write_registry',
      coalesce((s->>'can_read')::boolean, true), coalesce((s->>'can_write')::boolean, false), coalesce((s->>'can_verify')::boolean, true))
    ON CONFLICT (de_id, system_key) DO UPDATE SET
      label = excluded.label, source_table = excluded.source_table, read_fields = excluded.read_fields,
      write_registry = excluded.write_registry, can_read = excluded.can_read, can_write = excluded.can_write,
      can_verify = excluded.can_verify, active = true;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END; $$;
REVOKE ALL ON FUNCTION public.install_role_systems(uuid,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.install_role_systems(uuid,text) TO authenticated, service_role;

-- 6. Seed system templates on the account-desk + pipeline-desk archetypes -----
UPDATE role_archetypes SET system_templates = jsonb_build_array(
  jsonb_build_object('system_key','accounts','label','Customer accounts','source_table','customer_accounts',
    'read_fields', jsonb_build_array('name','health_score','arr_cents','status','renewal_date','tier'),
    'write_registry','account','can_read',true,'can_write',true,'can_verify',true)
) WHERE key IN ('renewal_manager','cs_manager');

UPDATE role_archetypes SET system_templates = jsonb_build_array(
  jsonb_build_object('system_key','pipeline','label','Opportunity pipeline','source_table','opportunities',
    'read_fields', jsonb_build_array('name','company_name','stage','amount_cents','close_date','owner'),
    'write_registry','opportunity','can_read',true,'can_write',true,'can_verify',true)
) WHERE key = 'sdr';

-- 7. Install the desks on the existing Renewal + CS DEs -----------------------
SELECT public.install_role_systems(d.id, CASE WHEN d.name ILIKE '%renewal%' THEN 'renewal_manager' ELSE 'cs_manager' END)
FROM digital_employees d
WHERE d.tenant_id = (SELECT id FROM tenants WHERE slug = 'outsourcetel-hq')
  AND (d.name ILIKE '%renewal%' OR d.name ILIKE '%account success%');
