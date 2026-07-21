-- 241_browser_operator.sql
-- ============================================================================
-- Browser Operator — the human-facing surface + browser specialisation on top
-- of the mig-182 computer-use governance (which is substrate-agnostic: a
-- browser runtime registers exactly like a desktop one, and the hard gate —
-- approval + active runtime + audit — already applies verbatim).
--
-- This adds only what a BROWSER agent + a usable UI need, without loosening any
-- gate:
--   • engine (browser_dom | browser_vision | desktop) — DOM-first is the default
--     (cheaper/faster/reliable on web apps); vision is the fallback.
--   • credential_policy (none | vault_injected | human_login) — the model NEVER
--     sees raw credentials; a login-helper types vault secrets or a human logs
--     in. Enforced by the runtime contract.
--   • runtime kind/engine + a last_seen heartbeat, so the UI can show an honest
--     "browser connected?" status and stale runtimes auto-deactivate (a runtime
--     that stops heart-beating can no longer hold a claim → the mig-182 trigger
--     refuses execution).
--   • register/heartbeat RPCs for the worker, a tenant-admin propose RPC (so a
--     human can launch a governed task from the UI, not only a DE), and a
--     read RPC that powers the monitor UI.
--
-- Every new task still flows: propose → human approval gate → claim (active
-- runtime only) → run → audit. Additive, tenant-safe, GLOBAL.
-- ============================================================================

-- 1. Browser specialisation on the task + runtime ----------------------------
ALTER TABLE computer_use_tasks
  ADD COLUMN IF NOT EXISTS engine            text NOT NULL DEFAULT 'browser_dom'
    CHECK (engine IN ('browser_dom','browser_vision','desktop')),
  ADD COLUMN IF NOT EXISTS credential_policy text NOT NULL DEFAULT 'none'
    CHECK (credential_policy IN ('none','vault_injected','human_login')),
  ADD COLUMN IF NOT EXISTS title             text;

ALTER TABLE computer_use_runtimes
  ADD COLUMN IF NOT EXISTS kind      text NOT NULL DEFAULT 'browser' CHECK (kind IN ('browser','desktop')),
  ADD COLUMN IF NOT EXISTS engine    text NOT NULL DEFAULT 'browser_dom',
  ADD COLUMN IF NOT EXISTS last_seen timestamptz;

-- 2. Runtime lifecycle (service-role only) — register + heartbeat + reap ------
CREATE OR REPLACE FUNCTION public.register_computer_use_runtime(
  p_name text, p_endpoint text, p_kind text DEFAULT 'browser', p_engine text DEFAULT 'browser_dom'
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' THEN RAISE EXCEPTION 'register_computer_use_runtime is service-role only'; END IF;
  -- Upsert by name so a restarting worker keeps its identity.
  SELECT id INTO v_id FROM computer_use_runtimes WHERE name = p_name LIMIT 1;
  IF v_id IS NULL THEN
    INSERT INTO computer_use_runtimes (name, endpoint, kind, engine, active, last_seen)
      VALUES (p_name, p_endpoint, coalesce(p_kind,'browser'), coalesce(p_engine,'browser_dom'), true, now())
      RETURNING id INTO v_id;
  ELSE
    UPDATE computer_use_runtimes SET endpoint = p_endpoint, kind = coalesce(p_kind,'browser'),
      engine = coalesce(p_engine,'browser_dom'), active = true, last_seen = now() WHERE id = v_id;
  END IF;
  RETURN v_id;
END; $$;
REVOKE ALL ON FUNCTION public.register_computer_use_runtime(text,text,text,text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_computer_use_runtime(text,text,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.heartbeat_computer_use_runtime(p_runtime_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' THEN RAISE EXCEPTION 'heartbeat is service-role only'; END IF;
  UPDATE computer_use_runtimes SET last_seen = now(), active = true WHERE id = p_runtime_id;
END; $$;
REVOKE ALL ON FUNCTION public.heartbeat_computer_use_runtime(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_computer_use_runtime(uuid) TO service_role;

-- Reap runtimes that stopped heart-beating (>5 min) — a dead worker can then no
-- longer hold a claim, so the mig-182 gate refuses to run its tasks. Cron'd.
CREATE OR REPLACE FUNCTION public.reap_stale_computer_use_runtimes()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  UPDATE computer_use_runtimes SET active = false
    WHERE active AND (last_seen IS NULL OR last_seen < now() - interval '5 minutes');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END; $$;
REVOKE ALL ON FUNCTION public.reap_stale_computer_use_runtimes() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.reap_stale_computer_use_runtimes() TO service_role;
SELECT cron.schedule('reap-stale-cu-runtimes', '*/5 * * * *', 'select public.reap_stale_computer_use_runtimes()');

-- 3. Human-initiated propose (tenant admin) — same gate as the DE path --------
-- A human can launch a governed browser task from the UI. It STILL enters as
-- pending_approval with a human_task, so the approval + audit story is identical
-- to a DE-proposed one (the launcher can then approve it in their inbox).
CREATE OR REPLACE FUNCTION public.propose_browser_task(
  p_tenant_id uuid, p_de_id uuid, p_goal text, p_allowed_domains text[],
  p_max_steps integer DEFAULT 15, p_engine text DEFAULT 'browser_dom',
  p_credential_policy text DEFAULT 'none', p_title text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_task uuid; v_ht uuid; v_name text;
BEGIN
  IF NOT (public.auth_tenant_id() = p_tenant_id
          AND public.auth_has_tenant_role(ARRAY['tenant_owner','tenant_admin','tenant_manager'])) THEN
    RAISE EXCEPTION 'not permitted — tenant admin required';
  END IF;
  IF NOT public.is_feature_enabled_internal(p_tenant_id, 'computer_use') THEN
    RAISE EXCEPTION 'Browser Operator is not enabled for this workspace (default OFF)';
  END IF;
  IF coalesce(array_length(p_allowed_domains,1),0) < 1 THEN RAISE EXCEPTION 'at least one allowed site is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM digital_employees WHERE id = p_de_id AND tenant_id = p_tenant_id) THEN
    RAISE EXCEPTION 'de not in tenant';
  END IF;

  INSERT INTO computer_use_tasks (tenant_id, de_id, goal, allowed_domains, max_steps, engine, credential_policy, title)
  VALUES (p_tenant_id, p_de_id, p_goal, p_allowed_domains, greatest(1, least(50, coalesce(p_max_steps,15))),
          CASE WHEN p_engine IN ('browser_dom','browser_vision','desktop') THEN p_engine ELSE 'browser_dom' END,
          CASE WHEN p_credential_policy IN ('none','vault_injected','human_login') THEN p_credential_policy ELSE 'none' END,
          nullif(btrim(coalesce(p_title,'')),''))
  RETURNING id INTO v_task;

  SELECT coalesce(persona_name, name, 'DE') INTO v_name FROM digital_employees WHERE id = p_de_id;
  INSERT INTO human_tasks (tenant_id, type, source, title, detail, related_table, related_id)
  VALUES (p_tenant_id, 'approval_gate', 'human',
    format('Browser task for %s', v_name),
    format(E'Approve %s to operate a browser for this task. Nothing runs without approval + a connected browser runtime, and every step is audited.\n\nGoal: %s\nAllowed sites: %s\nStep budget: %s\nCredentials: %s',
           v_name, p_goal, array_to_string(p_allowed_domains, ', '), greatest(1, least(50, coalesce(p_max_steps,15))), coalesce(p_credential_policy,'none')),
    'computer_use_tasks', v_task)
  RETURNING id INTO v_ht;
  UPDATE computer_use_tasks SET human_task_id = v_ht, updated_at = now() WHERE id = v_task;
  RETURN v_task;
END; $$;
REVOKE ALL ON FUNCTION public.propose_browser_task(uuid,uuid,text,text[],integer,text,text,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.propose_browser_task(uuid,uuid,text,text[],integer,text,text,text) TO authenticated, service_role;

-- 4. Read model for the monitor UI -------------------------------------------
CREATE OR REPLACE FUNCTION public.list_browser_operator(p_tenant_id uuid, p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tasks jsonb; v_runtimes jsonb; v_enabled boolean;
BEGIN
  IF p_tenant_id IS DISTINCT FROM public.auth_tenant_id()
     AND NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = auth.uid() AND layer = 'platform') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_tenant_member');
  END IF;
  v_enabled := public.is_feature_enabled_internal(p_tenant_id, 'computer_use');

  SELECT coalesce(jsonb_agg(row_to_json(t) ORDER BY t.created_at DESC), '[]'::jsonb) INTO v_tasks FROM (
    SELECT c.id, c.de_id, coalesce(d.persona_name, d.name) AS de_name, c.title, c.goal, c.allowed_domains,
           c.max_steps, c.engine, c.credential_policy, c.status, c.human_task_id, h.status AS approval_status,
           c.runtime_id, r.name AS runtime_name, jsonb_array_length(c.audit) AS steps, c.result, c.created_at, c.updated_at
    FROM computer_use_tasks c
    LEFT JOIN digital_employees d ON d.id = c.de_id
    LEFT JOIN human_tasks h ON h.id = c.human_task_id
    LEFT JOIN computer_use_runtimes r ON r.id = c.runtime_id
    WHERE c.tenant_id = p_tenant_id
    ORDER BY c.created_at DESC LIMIT greatest(1, least(200, coalesce(p_limit,50)))
  ) t;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'kind', kind, 'engine', engine,
           'active', (active AND last_seen IS NOT NULL AND last_seen > now() - interval '5 minutes'), 'last_seen', last_seen)), '[]'::jsonb)
    INTO v_runtimes FROM computer_use_runtimes;

  RETURN jsonb_build_object('ok', true, 'enabled', v_enabled, 'tasks', v_tasks, 'runtimes', v_runtimes);
END; $$;
REVOKE ALL ON FUNCTION public.list_browser_operator(uuid,integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_browser_operator(uuid,integer) TO authenticated, service_role;

-- Full step-by-step audit for one task (the "replay").
CREATE OR REPLACE FUNCTION public.get_browser_task(p_task_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb;
BEGIN
  SELECT to_jsonb(c) - 'constraints' INTO v FROM computer_use_tasks c WHERE c.id = p_task_id
    AND (c.tenant_id = public.auth_tenant_id() OR EXISTS (SELECT 1 FROM profiles WHERE user_id = auth.uid() AND layer = 'platform'));
  IF v IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  RETURN jsonb_build_object('ok', true, 'task', v);
END; $$;
REVOKE ALL ON FUNCTION public.get_browser_task(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_browser_task(uuid) TO authenticated, service_role;
