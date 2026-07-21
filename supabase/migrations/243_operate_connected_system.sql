-- 243_operate_connected_system.sql
-- ============================================================================
-- THE BRIDGE — a Digital Employee OPERATES a connected app through its web UI.
--
-- The vision: once any app is connected (QuickBooks, Xero, Zuora, Salesforce…),
-- a DE — directed by its PLAYBOOK, in plain English ("go manage overdue invoices
-- in QuickBooks and write back what you did") — can OPERATE that app's UI when
-- there's no API for the job, under the exact same guardrails as everything else.
--
-- This composes what already exists, adding only the bridge:
--   • de_connected_systems (mig 221) gains an OPERATE binding: can_operate + the
--     connector it belongs to + the domain it lives on + an optional UI-login
--     secret. So "this DE may drive app X's UI on domain Y, logging in with Z".
--   • create_browser_operation() turns a (DE, system, plain-English instruction)
--     into a GOVERNED Browser Operator task (mig 182/241): allowlisted to the
--     app's domain, human-approved, step-bounded, credential-safe, audited. The
--     DE's de-work brain calls this mid-playbook; the Steel worker executes it;
--     the outcome flows back to the DE's case.
--   • get_browser_login() lets the worker fetch the UI-login secret for a domain
--     (the model never sees it — the worker types it). Vault-decrypted.
--
-- The DE can only ASK to operate; a human still approves, and the mig-182 gate
-- refuses execution without approval + an active runtime. Additive, GLOBAL.
-- ============================================================================

-- 1. Operate binding on the per-DE system desk --------------------------------
ALTER TABLE de_connected_systems
  ADD COLUMN IF NOT EXISTS can_operate     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS connector_id    uuid REFERENCES connectors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS operate_domain  text,                 -- overrides the connector's base_url host
  ADD COLUMN IF NOT EXISTS login_secret_id uuid;                 -- Vault secret_id for the UI login (null → human logs in)

-- Resolve the domain a system is operated on (explicit override, else the
-- connector's base_url host).
CREATE OR REPLACE FUNCTION public.operate_domain_of(p_system de_connected_systems)
RETURNS text LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE v_url text;
BEGIN
  IF nullif(btrim(coalesce(p_system.operate_domain,'')),'') IS NOT NULL THEN
    RETURN lower(regexp_replace(regexp_replace(p_system.operate_domain, '^https?://', ''), '/.*$', ''));
  END IF;
  SELECT base_url INTO v_url FROM connectors WHERE id = p_system.connector_id;
  IF v_url IS NULL THEN RETURN NULL; END IF;
  RETURN lower(regexp_replace(regexp_replace(v_url, '^https?://', ''), '/.*$', ''));
END; $$;

-- 2. The bridge: (DE, system, plain-English instruction) → governed browser task
CREATE OR REPLACE FUNCTION public.create_browser_operation(
  p_de_id uuid, p_system_key text, p_instruction text, p_max_steps integer DEFAULT 20
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s de_connected_systems; v_tenant uuid; v_domain text; v_cred text; v_task uuid; v_ht uuid;
  v_de_name text; v_goal text; v_title text;
  v_is_service boolean := coalesce(auth.role(),'') = 'service_role';
BEGIN
  SELECT tenant_id INTO v_tenant FROM digital_employees WHERE id = p_de_id;
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'de_not_found'); END IF;
  -- de-work (service) or a tenant admin acting for the DE.
  IF NOT v_is_service AND NOT (v_tenant = public.auth_tenant_id()
       AND public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin','tenant_manager'])) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_permitted');
  END IF;
  IF NOT public.is_feature_enabled_internal(v_tenant, 'computer_use') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'browser_operator_disabled');
  END IF;

  SELECT * INTO s FROM de_connected_systems
    WHERE de_id = p_de_id AND system_key = p_system_key AND active AND can_operate;
  IF s.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'system_not_operable'); END IF;

  v_domain := public.operate_domain_of(s);
  IF v_domain IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_operate_domain'); END IF;
  IF nullif(btrim(coalesce(p_instruction,'')),'') IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'instruction_required'); END IF;

  SELECT coalesce(persona_name, name, 'DE') INTO v_de_name FROM digital_employees WHERE id = p_de_id;
  v_title := format('Operate %s', coalesce(s.label, p_system_key));
  v_goal  := format(E'In %s (%s): %s\n\nWork within this app only. When finished, report the outcome as JSON: what you changed/found and any IDs. Do not perform irreversible actions (payments, deletions, sending) — hand those to a human.',
                    coalesce(s.label, p_system_key), v_domain, btrim(p_instruction));

  INSERT INTO computer_use_tasks (tenant_id, de_id, goal, allowed_domains, max_steps, engine, credential_policy, title)
  VALUES (v_tenant, p_de_id, v_goal, ARRAY[v_domain], greatest(1, least(50, coalesce(p_max_steps,20))),
          'browser_dom',
          CASE WHEN s.login_secret_id IS NOT NULL THEN 'vault_injected' ELSE 'human_login' END,
          v_title)
  RETURNING id INTO v_task;

  INSERT INTO human_tasks (tenant_id, type, source, title, detail, related_table, related_id)
  VALUES (v_tenant, 'approval_gate', 'de',
    format('%s wants to operate %s', v_de_name, coalesce(s.label, p_system_key)),
    format(E'%s wants to run this in %s (%s):\n\n%s\n\nIt stays on %s, is limited to %s steps, never performs payments/deletions without you, and records every step.',
           v_de_name, coalesce(s.label, p_system_key), v_domain, btrim(p_instruction), v_domain, greatest(1, least(50, coalesce(p_max_steps,20)))),
    'computer_use_tasks', v_task)
  RETURNING id INTO v_ht;
  UPDATE computer_use_tasks SET human_task_id = v_ht, updated_at = now() WHERE id = v_task;

  BEGIN PERFORM append_audit_event_internal(v_tenant, v_de_name, 'de',
    format('%s requested a browser operation in %s', v_de_name, coalesce(s.label, p_system_key)), 'de_consultation',
    jsonb_build_object('kind','browser_operation_requested','task_id',v_task,'system_key',p_system_key,'domain',v_domain));
  EXCEPTION WHEN OTHERS THEN NULL; END;

  RETURN jsonb_build_object('ok', true, 'task_id', v_task, 'domain', v_domain,
    'credential_policy', CASE WHEN s.login_secret_id IS NOT NULL THEN 'vault_injected' ELSE 'human_login' END,
    'status', 'pending_approval');
END; $$;
REVOKE ALL ON FUNCTION public.create_browser_operation(uuid,text,text,integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.create_browser_operation(uuid,text,text,integer) TO authenticated, service_role;

-- 3. UI-login secret for the worker (Vault-decrypted; service-role only). The
-- model never sees this — the worker types it into the login form.
CREATE OR REPLACE FUNCTION public.get_browser_login(p_tenant_id uuid, p_domain text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s de_connected_systems; v_secret text; v_dom text;
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' THEN RAISE EXCEPTION 'service-role only'; END IF;
  v_dom := lower(regexp_replace(regexp_replace(coalesce(p_domain,''), '^https?://', ''), '/.*$', ''));
  FOR s IN SELECT * FROM de_connected_systems WHERE tenant_id = p_tenant_id AND can_operate AND login_secret_id IS NOT NULL LOOP
    IF public.operate_domain_of(s) = v_dom THEN
      SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE id = s.login_secret_id LIMIT 1;
      IF v_secret IS NOT NULL THEN
        -- Secret convention: JSON {"username":"…","password":"…"} or a bare password.
        RETURN jsonb_build_object('ok', true, 'secret', v_secret);
      END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', false, 'error', 'no_login_secret');
END; $$;
REVOKE ALL ON FUNCTION public.get_browser_login(uuid,text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_browser_login(uuid,text) TO service_role;
