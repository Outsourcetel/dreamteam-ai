-- 244_operate_binding_config.sql
-- ============================================================================
-- THE MISSING KNOB — configure, without SQL, which connected systems a DE may
-- OPERATE through its web UI, on which domain, and with which stored login.
--
-- mig 243 added the operate binding (can_operate / operate_domain / connector_id
-- / login_secret_id on de_connected_systems) and the bridge that turns a DE's
-- plain-English instruction into a governed Browser Operator task. But nothing
-- in the app could SET that binding — it was raw-SQL only. This adds the admin
-- RPCs the config UI calls, and surfaces `can_operate` + the resolved domain to
-- the DE's brain (via get_de_systems) so an operable system is actually
-- discoverable mid-playbook.
--
-- Everything here is admin-gated (tenant_owner/tenant_admin), tenant-scoped, and
-- the UI-login secret is written to Vault (the model never sees it — the worker
-- types it, mig 243 get_browser_login). Additive, GLOBAL — every tenant.
-- ============================================================================

-- 1. Surface operability to the DE brain -------------------------------------
-- get_de_systems now includes can_operate + the resolved operate domain, so the
-- de-work briefing can list operable systems and the DE knows valid system_keys
-- for operate_in_system (mig 243). Backward-compatible: only adds fields.
CREATE OR REPLACE FUNCTION public.get_de_systems(p_de_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'system_key', t.system_key, 'label', t.label, 'source_table', t.source_table,
    'read_fields', t.read_fields, 'can_read', t.can_read, 'can_write', t.can_write,
    'can_verify', t.can_verify, 'can_operate', t.can_operate,
    'operate_domain', public.operate_domain_of(t),
    'write_registry', t.write_registry) ORDER BY t.system_key), '[]'::jsonb)
  FROM de_connected_systems t WHERE t.de_id = p_de_id AND t.active;
$$;

-- Shared admin gate for this file's write RPCs: caller is service_role, or a
-- tenant_owner/tenant_admin of the given tenant.
CREATE OR REPLACE FUNCTION public.can_admin_tenant_internal(p_tenant uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(auth.role(),'') = 'service_role'
      OR (p_tenant = public.auth_tenant_id()
          AND public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin']));
$$;

-- Normalise a host: strip scheme + path, lower-case. Empty → NULL.
CREATE OR REPLACE FUNCTION public.normalize_operate_domain(p_domain text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT nullif(lower(regexp_replace(regexp_replace(coalesce(p_domain,''), '^https?://', ''), '/.*$', '')), '');
$$;

-- 2. Read the operate config for a DE (admin) --------------------------------
CREATE OR REPLACE FUNCTION public.list_de_operate_config(p_de_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_de_name text;
BEGIN
  SELECT tenant_id, coalesce(persona_name, name) INTO v_tenant, v_de_name
    FROM digital_employees WHERE id = p_de_id;
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'de_not_found'); END IF;
  IF NOT public.can_admin_tenant_internal(v_tenant) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_permitted');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'de', jsonb_build_object('id', p_de_id, 'name', coalesce(v_de_name, 'DE')),
    'feature_enabled', public.is_feature_enabled_internal(v_tenant, 'computer_use'),
    'systems', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', t.id, 'system_key', t.system_key, 'label', t.label,
        'binding_kind', t.binding_kind, 'can_operate', t.can_operate,
        'can_read', t.can_read, 'can_write', t.can_write, 'active', t.active,
        'operate_domain', t.operate_domain,
        'resolved_domain', public.operate_domain_of(t),
        'connector_id', t.connector_id,
        'connector_name', (SELECT nullif(c.display_name,'') FROM connectors c WHERE c.id = t.connector_id),
        'has_login', (t.login_secret_id IS NOT NULL),
        'operate_only', (t.binding_kind = 'connector' AND t.source_table IS NULL)
      ) ORDER BY t.system_key), '[]'::jsonb)
      FROM de_connected_systems t WHERE t.de_id = p_de_id
    ),
    'connectors', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', coalesce(nullif(c.display_name,''), c.provider), 'base_url', c.base_url
      ) ORDER BY coalesce(nullif(c.display_name,''), c.provider)), '[]'::jsonb)
      FROM connectors c WHERE c.tenant_id = v_tenant
    )
  );
END; $$;
REVOKE ALL ON FUNCTION public.list_de_operate_config(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_de_operate_config(uuid) TO authenticated, service_role;

-- 3. Create/update an operate binding (admin) --------------------------------
-- p_system_id null → create a new operate-only binding (external app, no
-- internal read desk). Non-null → update the operate fields of an existing
-- binding (may be a seeded internal read desk that we also make operable).
CREATE OR REPLACE FUNCTION public.upsert_de_operate_binding(
  p_de_id uuid, p_system_id uuid, p_system_key text, p_label text,
  p_can_operate boolean, p_operate_domain text DEFAULT NULL, p_connector_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid; v_key text; v_label text; v_domain text; v_id uuid;
  v_conn_tenant uuid; v_has_conn_url boolean := false;
BEGIN
  SELECT tenant_id INTO v_tenant FROM digital_employees WHERE id = p_de_id;
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'de_not_found'); END IF;
  IF NOT public.can_admin_tenant_internal(v_tenant) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_permitted');
  END IF;

  v_domain := public.normalize_operate_domain(p_operate_domain);

  -- A linked connector must belong to this tenant; note whether it yields a host.
  IF p_connector_id IS NOT NULL THEN
    SELECT tenant_id, (public.normalize_operate_domain(base_url) IS NOT NULL)
      INTO v_conn_tenant, v_has_conn_url FROM connectors WHERE id = p_connector_id;
    IF v_conn_tenant IS NULL OR v_conn_tenant <> v_tenant THEN
      RETURN jsonb_build_object('ok', false, 'error', 'connector_not_in_tenant');
    END IF;
  END IF;

  -- Operable systems MUST resolve to a domain (else the bridge can't allowlist).
  IF p_can_operate AND v_domain IS NULL AND NOT v_has_conn_url THEN
    RETURN jsonb_build_object('ok', false, 'error', 'operate_domain_required');
  END IF;

  IF p_system_id IS NOT NULL THEN
    -- Update the operate fields on an existing binding (keep its read config).
    UPDATE de_connected_systems
       SET label          = coalesce(nullif(btrim(p_label),''), label),
           can_operate    = p_can_operate,
           operate_domain = v_domain,
           connector_id   = p_connector_id,
           active         = true
     WHERE id = p_system_id AND de_id = p_de_id AND tenant_id = v_tenant
     RETURNING id INTO v_id;
    IF v_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'binding_not_found'); END IF;
  ELSE
    -- Create a new operate-only binding.
    v_key := nullif(btrim(p_system_key), '');
    IF v_key IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'system_key_required'); END IF;
    v_label := coalesce(nullif(btrim(p_label),''), v_key);
    IF EXISTS (SELECT 1 FROM de_connected_systems WHERE de_id = p_de_id AND system_key = v_key) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'system_key_exists');
    END IF;
    INSERT INTO de_connected_systems (
      tenant_id, de_id, system_key, label, binding_kind, source_table,
      can_read, can_write, can_verify, can_operate, operate_domain, connector_id, active
    ) VALUES (
      v_tenant, p_de_id, v_key, v_label, 'connector', NULL,
      false, false, false, p_can_operate, v_domain, p_connector_id, true
    ) RETURNING id INTO v_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'system_id', v_id,
    'resolved_domain', public.operate_domain_of((SELECT t FROM de_connected_systems t WHERE t.id = v_id)));
END; $$;
REVOKE ALL ON FUNCTION public.upsert_de_operate_binding(uuid,uuid,text,text,boolean,text,uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.upsert_de_operate_binding(uuid,uuid,text,text,boolean,text,uuid) TO authenticated, service_role;

-- 4. Store / clear the UI-login secret (admin; Vault) ------------------------
-- Secret convention (matches mig 243 get_browser_login): JSON
-- {"username":"…","password":"…"} or a bare password. Model-blind.
CREATE OR REPLACE FUNCTION public.set_de_operate_login(p_system_id uuid, p_secret text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_existing uuid; v_new uuid;
BEGIN
  SELECT tenant_id, login_secret_id INTO v_tenant, v_existing
    FROM de_connected_systems WHERE id = p_system_id;
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'binding_not_found'); END IF;
  IF NOT public.can_admin_tenant_internal(v_tenant) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_permitted');
  END IF;
  IF nullif(btrim(coalesce(p_secret,'')),'') IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'secret_required');
  END IF;

  IF v_existing IS NOT NULL THEN
    PERFORM vault.update_secret(v_existing, p_secret);
  ELSE
    v_new := vault.create_secret(p_secret, 'de_operate_login:' || p_system_id, 'DE Browser Operator UI login (mig 244)');
    UPDATE de_connected_systems SET login_secret_id = v_new WHERE id = p_system_id;
  END IF;
  RETURN jsonb_build_object('ok', true);
END; $$;
REVOKE ALL ON FUNCTION public.set_de_operate_login(uuid,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_de_operate_login(uuid,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.clear_de_operate_login(p_system_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_secret uuid;
BEGIN
  SELECT tenant_id, login_secret_id INTO v_tenant, v_secret
    FROM de_connected_systems WHERE id = p_system_id;
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'binding_not_found'); END IF;
  IF NOT public.can_admin_tenant_internal(v_tenant) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_permitted');
  END IF;
  UPDATE de_connected_systems SET login_secret_id = NULL WHERE id = p_system_id;
  IF v_secret IS NOT NULL THEN DELETE FROM vault.secrets WHERE id = v_secret; END IF;
  RETURN jsonb_build_object('ok', true);
END; $$;
REVOKE ALL ON FUNCTION public.clear_de_operate_login(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.clear_de_operate_login(uuid) TO authenticated, service_role;

-- 5. Delete an operate-only binding (admin) ----------------------------------
-- Only removes bindings this feature created (operate-only: connector kind with
-- no internal read desk). Seeded read/verify desks are never deleted here — turn
-- their can_operate off via upsert instead. Also purges any login secret.
CREATE OR REPLACE FUNCTION public.delete_de_operate_binding(p_system_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_secret uuid; v_operate_only boolean;
BEGIN
  SELECT tenant_id, login_secret_id, (binding_kind = 'connector' AND source_table IS NULL)
    INTO v_tenant, v_secret, v_operate_only
    FROM de_connected_systems WHERE id = p_system_id;
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'binding_not_found'); END IF;
  IF NOT public.can_admin_tenant_internal(v_tenant) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_permitted');
  END IF;
  IF NOT v_operate_only THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_operate_only');
  END IF;
  DELETE FROM de_connected_systems WHERE id = p_system_id;
  IF v_secret IS NOT NULL THEN DELETE FROM vault.secrets WHERE id = v_secret; END IF;
  RETURN jsonb_build_object('ok', true);
END; $$;
REVOKE ALL ON FUNCTION public.delete_de_operate_binding(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.delete_de_operate_binding(uuid) TO authenticated, service_role;
