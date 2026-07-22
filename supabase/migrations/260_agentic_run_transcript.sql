-- ============================================================================
-- 260 — AUTONOMOUS-RUN TRANSCRIPT (Tier-2 surfacing)
--
-- Tier-2 audit, honestly narrowed: of the four candidates, three were ALREADY
-- surfaced (decision trace → Workbench "Reasoning"; KPIs → DeKpisPanel;
-- skills → DeSkillsPanel via list_de_skills). The ONE genuine gap is the
-- agentic reasoning transcript: agentic_step_runs (the multi-step tool-use
-- loop, with goal/status/iterations/cost) and agentic_step_messages (the
-- turn-by-turn transcript). No reader existed. This lets the Employee File's
-- Record tab show "watch it reason through a task."
--
-- Two tenant-gated readers: the run list, and the transcript for one run
-- (re-checks the run belongs to the caller's tenant before returning turns).
-- ============================================================================

-- Housekeeping: mig 259's get_de_skills is superseded — skills were already
-- surfaced by DeSkillsPanel via list_de_skills; the duplicate Record-tab
-- matrix was removed, so drop its orphaned reader.
drop function if exists public.get_de_skills(uuid);

create or replace function public.get_de_agentic_runs(p_de_id uuid, p_limit integer default 15)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare v_tenant uuid; v_out jsonb;
begin
  v_tenant := public.auth_tenant_id();
  if v_tenant is null then return jsonb_build_object('ok', false, 'error', 'not_permitted'); end if;
  if not exists (select 1 from digital_employees where id = p_de_id and tenant_id = v_tenant) then
    return jsonb_build_object('ok', false, 'error', 'de_not_found');
  end if;
  p_limit := greatest(1, least(50, coalesce(p_limit, 15)));
  select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) into v_out from (
    select r.id, r.goal, r.status, r.iteration_count,
           coalesce(r.cost_used_cents, 0) as cost_used_cents,
           r.tokens_used, r.created_at, r.completed_at
      from agentic_step_runs r
     where r.tenant_id = v_tenant and r.de_id = p_de_id
     order by r.created_at desc
     limit p_limit
  ) x;
  return jsonb_build_object('ok', true, 'runs', v_out);
end $function$;
revoke all on function public.get_de_agentic_runs(uuid, integer) from public, anon;
grant execute on function public.get_de_agentic_runs(uuid, integer) to authenticated, service_role;

create or replace function public.get_agentic_run_messages(p_run_id uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare v_tenant uuid; v_out jsonb;
begin
  v_tenant := public.auth_tenant_id();
  if v_tenant is null then return jsonb_build_object('ok', false, 'error', 'not_permitted'); end if;
  -- The run must belong to the caller's tenant, or no turns are returned.
  if not exists (select 1 from agentic_step_runs r where r.id = p_run_id and r.tenant_id = v_tenant) then
    return jsonb_build_object('ok', false, 'error', 'run_not_found');
  end if;
  select coalesce(jsonb_agg(row_to_json(x) order by x.turn_index), '[]'::jsonb) into v_out from (
    select m.id, m.turn_index, m.role, m.content, m.created_at
      from agentic_step_messages m
     where m.agentic_step_run_id = p_run_id
     order by m.turn_index
  ) x;
  return jsonb_build_object('ok', true, 'messages', v_out);
end $function$;
revoke all on function public.get_agentic_run_messages(uuid) from public, anon;
grant execute on function public.get_agentic_run_messages(uuid) to authenticated, service_role;

NOTIFY pgrst, 'reload schema';
