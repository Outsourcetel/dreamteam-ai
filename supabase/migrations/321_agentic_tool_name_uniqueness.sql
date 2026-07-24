-- 321_agentic_tool_name_uniqueness.sql
-- ============================================================================
-- SAFETY FIX — an approved action could fire against the WRONG external system.
--
-- get_agentic_tools_for_de (mig 125, latest def) emits a DE's tool catalog with
--   'name' = category || '__' || action_key
-- which carries NO connector discriminator. A tenant with two connectors in the
-- same category (two helpdesks, two CRMs, two billing systems) matches the same
-- category-scoped action_definitions for BOTH, so the identical tool name is
-- emitted twice — once per connector, each with a different connector_id.
-- Consequences, both live:
--   • de-work builds `new Map(tools.map(t => [t.name, {connector_id, action_key}]))`
--     — duplicate keys SILENTLY COLLAPSE, last connector wins. A model calling that
--     tool (even a human-approved one) can execute against the wrong system.
--   • The duplicate name is also emitted twice into the Anthropic tools array.
--
-- Also hardens the name for the Anthropic contract ^[a-zA-Z0-9_-]{1,64}$: sanitizes
-- any other character (a learned/OpenAPI action_key legitimately contains dots) and
-- bounds the length, so one malformed definition can't 400 the whole request and
-- take a tenant's entire workforce down.
--
-- The name is OPAQUE to callers — de-work and agentic-step-execute both resolve
-- connector_id/action_key by looking the name up in the SAME emitted list — so
-- changing its shape round-trips safely. Reproduced VERBATIM from mig 125; the ONLY
-- change is the name construction (+ two declared vars). GLOBAL.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_agentic_tools_for_de(p_tenant_id uuid, p_de_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $$
declare
  v_tools jsonb := '[]'::jsonb;
  v_conn record;
  v_def record;
  v_verdict jsonb;
  v_properties jsonb;
  v_required jsonb;
  v_param record;
  v_type text;
  v_name text;     -- sanitized, connector-unique tool name
  v_suffix text;   -- per-connector discriminator
begin
  for v_conn in
    select id, category, display_name, provider
    from connectors
    where tenant_id = p_tenant_id and status = 'connected'
  loop
    for v_def in
      select *
      from action_definitions
      where status = 'active'
        and provider <> 'internal'
        and category = v_conn.category
        and (scope = 'platform' or (scope = 'tenant' and tenant_id = p_tenant_id))
    loop
      select resolve_access(p_tenant_id, 'de', p_de_id, v_conn.id, 'write_back') into v_verdict;
      if coalesce((v_verdict->>'allowed')::boolean, false) then
        v_properties := '{}'::jsonb;
        v_required := '[]'::jsonb;

        for v_param in
          select * from jsonb_to_recordset(v_def.param_schema)
            as x(name text, type text, required boolean, help text)
        loop
          v_type := case v_param.type when 'number' then 'number' when 'boolean' then 'boolean' else 'string' end;
          v_properties := v_properties || jsonb_build_object(
            v_param.name, jsonb_build_object('type', v_type, 'description', coalesce(v_param.help, ''))
          );
          if coalesce(v_param.required, false) then
            v_required := v_required || to_jsonb(v_param.name);
          end if;
        end loop;

        -- Connector-unique + charset-safe + length-bounded (Anthropic: ^[a-zA-Z0-9_-]{1,64}$).
        v_suffix := '__' || left(replace(v_conn.id::text, '-', ''), 6);
        v_name := regexp_replace(v_conn.category || '__' || v_def.action_key, '[^a-zA-Z0-9_-]', '_', 'g');
        v_name := left(v_name, 64 - length(v_suffix)) || v_suffix;

        v_tools := v_tools || jsonb_build_array(jsonb_build_object(
          'name', v_name,
          'description', v_def.label || '. ' || v_def.description
                         || ' (system: ' || coalesce(nullif(v_conn.display_name, ''), v_conn.provider) || ')',
          'input_schema', jsonb_build_object(
            'type', 'object', 'properties', v_properties, 'required', v_required
          ),
          'connector_id', v_conn.id,
          'action_key', v_def.action_key,
          'destructive', coalesce((v_def.risk->>'destructive')::boolean, true)
        ));
      end if;
    end loop;
  end loop;

  return v_tools;
end;
$$;
REVOKE ALL ON FUNCTION public.get_agentic_tools_for_de(uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_agentic_tools_for_de(uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
