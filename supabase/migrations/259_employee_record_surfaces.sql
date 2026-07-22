-- ============================================================================
-- 259 — THE LIVING EMPLOYMENT RECORD (Tier-1 surfacing pass)
--
-- Audit finding: the Employee File is a thin dossier sitting on top of four
-- rich, populated, INVISIBLE datasets. The record-writers have been filling
-- them for weeks; nothing reads them:
--   de_experience (60 rows)  — traced things the employee has DONE, each with
--                              provenance to the evidence run / action.
--   de_skills     (555 rows) — evidence-assessed competency per employee,
--                              backed by sample sizes (daily skill cron).
--   otel_spans    (283 rows) — real execution telemetry per run: model served
--                              (shows the Bedrock failover!), latency, tokens,
--                              confidence, whether it escalated.
--
-- These are the accumulated employment record — the docs/18 M1 moat — made
-- literal. Three SECURITY DEFINER, tenant-gated readers so the Employee File
-- can finally tell the story. Aggregate/own-tenant only; every row already
-- carries a tenant_id and these re-check auth_tenant_id().
-- ============================================================================

-- ── The lived-experience ledger ──
create or replace function public.get_de_experience(p_de_id uuid, p_limit integer default 40)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare v_tenant uuid; v_out jsonb;
begin
  v_tenant := public.auth_tenant_id();
  if v_tenant is null then return jsonb_build_object('ok', false, 'error', 'not_permitted'); end if;
  if not exists (select 1 from digital_employees where id = p_de_id and tenant_id = v_tenant) then
    return jsonb_build_object('ok', false, 'error', 'de_not_found');
  end if;
  p_limit := greatest(1, least(200, coalesce(p_limit, 40)));
  select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) into v_out from (
    select e.id, e.category, e.fact_summary, e.external_ref, e.created_at,
           (e.source_action_execution_id is not null) as from_action,
           (e.source_evidence_run_id is not null) as from_evidence
      from de_experience e
     where e.tenant_id = v_tenant
       and e.subject_kind in ('de', 'specialist')
       and e.subject_id = p_de_id
     order by e.created_at desc
     limit p_limit
  ) x;
  return jsonb_build_object('ok', true, 'experience', v_out);
end $function$;
revoke all on function public.get_de_experience(uuid, integer) from public, anon;
grant execute on function public.get_de_experience(uuid, integer) to authenticated, service_role;

-- ── The evidence-earned skills matrix ──
create or replace function public.get_de_skills(p_de_id uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare v_tenant uuid; v_out jsonb;
begin
  v_tenant := public.auth_tenant_id();
  if v_tenant is null then return jsonb_build_object('ok', false, 'error', 'not_permitted'); end if;
  if not exists (select 1 from digital_employees where id = p_de_id and tenant_id = v_tenant) then
    return jsonb_build_object('ok', false, 'error', 'de_not_found');
  end if;
  -- Latest assessment per skill_key (the cron reassesses over time).
  select coalesce(jsonb_agg(row_to_json(x) order by x.skill_key), '[]'::jsonb) into v_out from (
    select distinct on (s.skill_key)
           s.skill_key, s.proficiency, s.sample_size, s.signal_value, s.detail, s.assessed_at
      from de_skills s
     where s.tenant_id = v_tenant and s.de_id = p_de_id
     order by s.skill_key, s.assessed_at desc nulls last
  ) x;
  return jsonb_build_object('ok', true, 'skills', v_out);
end $function$;
revoke all on function public.get_de_skills(uuid) from public, anon;
grant execute on function public.get_de_skills(uuid) to authenticated, service_role;

-- ── The execution log (otel run telemetry) ──
-- One row per trace: what work, how long, which MODEL served it (the Bedrock
-- failover, per answer), tokens, confidence, and whether it escalated.
create or replace function public.get_de_execution_log(p_de_id uuid, p_limit integer default 25)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare v_tenant uuid; v_out jsonb;
begin
  v_tenant := public.auth_tenant_id();
  if v_tenant is null then return jsonb_build_object('ok', false, 'error', 'not_permitted'); end if;
  if not exists (select 1 from digital_employees where id = p_de_id and tenant_id = v_tenant) then
    return jsonb_build_object('ok', false, 'error', 'de_not_found');
  end if;
  p_limit := greatest(1, least(100, coalesce(p_limit, 25)));
  select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) into v_out from (
    select s.name,
           round(extract(epoch from (s.ended_at - s.started_at)) * 1000)::int as duration_ms,
           s.started_at,
           s.attributes->>'gen_ai.request.model' as model,
           s.attributes->>'gen_ai.system' as provider,
           (s.attributes->>'gen_ai.usage.input_tokens')::int as input_tokens,
           (s.attributes->>'gen_ai.usage.output_tokens')::int as output_tokens,
           (s.attributes->>'dreamteam.confidence')::int as confidence,
           (s.attributes->>'dreamteam.escalated')::boolean as escalated,
           s.attributes->>'dreamteam.status' as work_status,
           (s.attributes->>'dreamteam.turns')::int as turns
      from otel_spans s
     where s.tenant_id = v_tenant
       and s.attributes->>'dreamteam.de_id' = p_de_id::text
       and s.parent_span_id is null   -- root span = one row per run
     order by s.started_at desc
     limit p_limit
  ) x;
  return jsonb_build_object('ok', true, 'runs', v_out);
end $function$;
revoke all on function public.get_de_execution_log(uuid, integer) from public, anon;
grant execute on function public.get_de_execution_log(uuid, integer) to authenticated, service_role;

NOTIFY pgrst, 'reload schema';
