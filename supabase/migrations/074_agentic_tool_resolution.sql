-- ============================================================
-- Migration 074: get_agentic_tools_for_de — resolves the tool list an
-- agentic step is allowed to see, BEFORE the model ever runs.
--
-- Deliberately mirrors what execute_action itself checks (resolve_access,
-- needed='write_back', same as the real connector-hub write path at
-- connector-hub/index.ts:1581) rather than inventing a parallel
-- permission concept. A tool this function omits is not a tool Claude
-- can even attempt — the loop physically cannot call something the DE
-- wasn't granted, the same default-deny posture every other action
-- path on this platform already enforces. This is retrieval logic
-- only: pure, deterministic, fully testable today with zero LLM key
-- (feed it a tenant + DE, inspect the returned tool array against known
-- data_access_grants rows).
-- ============================================================
create or replace function public.get_agentic_tools_for_de(p_tenant_id uuid, p_de_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_tools jsonb := '[]'::jsonb;
  v_conn record;
  v_def record;
  v_verdict jsonb;
  v_properties jsonb;
  v_required jsonb;
  v_param record;
  v_type text;
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

        v_tools := v_tools || jsonb_build_array(jsonb_build_object(
          'name', v_conn.category || '__' || v_def.action_key,
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

revoke all on function public.get_agentic_tools_for_de(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_agentic_tools_for_de(uuid, uuid) to service_role;
