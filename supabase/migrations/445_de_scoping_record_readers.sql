-- 445 — DE scoping wave 3 GROUP A: the four Record-tab readers.
--   get_de_experience, get_de_execution_log, get_de_agentic_runs,
--   get_agentic_run_messages  (docs/32 P1-10, docs/31's original ask).
--
-- These are the most sensitive readers on the Employee File Record tab:
-- reasoning transcripts, execution telemetry, the experience ledger. All four
-- were TENANT-ONLY: any workspace member could read any employee's record.
--
-- Fix: splice public.can_access_de(...) INTO the existing DE/run existence
-- check each body already performs, so a scoped user who is not responsible
-- for the employee receives the same envelope as for an unknown id
-- ({ok:false, error:'de_not_found'|'run_not_found'}) — the proven mig-392/393
-- denial shape, and it does not confirm the row exists.
--
-- Verified before drafting (2026-07-27, live pg_get_functiondef):
--   * none of the four contained the guard (Wave-2 migs 431-441 did not
--     touch them);
--   * no OR anywhere in the four WHERE predicates — no precedence hazard;
--   * agentic_step_runs.de_id is NOT NULL — plain guard form, no
--     null-tolerance needed;
--   * anon holds NO EXECUTE on any of the four; authenticated does;
--   * callers: exactly four, all in src/lib/employeeRecordApi.ts (browser,
--     user JWT). Zero edge-function callers, zero database-internal callers,
--     zero service-role paths (each body already returns not_permitted on a
--     null auth_tenant_id(), so no machine caller can have existed).
--
-- Bodies reproduced from live pg_get_functiondef, NOT from migs 259/260.
-- In-body comments deliberately avoid the guard token (mig 442/428/414
-- lesson): the assert below requires token occurrences == real guard calls.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. get_de_experience — the lived-experience ledger
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_de_experience(p_de_id uuid, p_limit integer DEFAULT 40)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_tenant uuid; v_out jsonb;
begin
  v_tenant := public.auth_tenant_id();
  if v_tenant is null then return jsonb_build_object('ok', false, 'error', 'not_permitted'); end if;
  -- The employee must exist in the caller's tenant AND the caller must be
  -- responsible for it (owner/admin/manager pass; else needs an assignment).
  if not exists (select 1 from digital_employees where id = p_de_id and tenant_id = v_tenant and public.can_access_de(p_de_id)) then
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

-- ─────────────────────────────────────────────────────────────────────────
-- 2. get_de_execution_log — per-run telemetry (model, confidence, spans)
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_de_execution_log(p_de_id uuid, p_limit integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_tenant uuid; v_out jsonb;
begin
  v_tenant := public.auth_tenant_id();
  if v_tenant is null then return jsonb_build_object('ok', false, 'error', 'not_permitted'); end if;
  -- The employee must exist in the caller's tenant AND the caller must be
  -- responsible for it (owner/admin/manager pass; else needs an assignment).
  if not exists (select 1 from digital_employees where id = p_de_id and tenant_id = v_tenant and public.can_access_de(p_de_id)) then
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

-- ─────────────────────────────────────────────────────────────────────────
-- 3. get_de_agentic_runs — autonomous runs + cost
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_de_agentic_runs(p_de_id uuid, p_limit integer DEFAULT 15)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_tenant uuid; v_out jsonb;
begin
  v_tenant := public.auth_tenant_id();
  if v_tenant is null then return jsonb_build_object('ok', false, 'error', 'not_permitted'); end if;
  -- The employee must exist in the caller's tenant AND the caller must be
  -- responsible for it (owner/admin/manager pass; else needs an assignment).
  if not exists (select 1 from digital_employees where id = p_de_id and tenant_id = v_tenant and public.can_access_de(p_de_id)) then
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

-- ─────────────────────────────────────────────────────────────────────────
-- 4. get_agentic_run_messages — FULL reasoning transcript of a run.
--    The de_id lives on agentic_step_runs (NOT NULL) — scoped on that,
--    inside the existing run-existence check.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_agentic_run_messages(p_run_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_tenant uuid; v_out jsonb;
begin
  v_tenant := public.auth_tenant_id();
  if v_tenant is null then return jsonb_build_object('ok', false, 'error', 'not_permitted'); end if;
  -- The run must belong to the caller's tenant and to an employee the caller
  -- is responsible for, or no turns are returned.
  if not exists (select 1 from agentic_step_runs r where r.id = p_run_id and r.tenant_id = v_tenant and public.can_access_de(r.de_id)) then
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

-- ─────────────────────────────────────────────────────────────────────────
-- Assertions: the change LANDED and nothing load-bearing was lost.
-- Runs in the same implicit transaction — any RAISE rolls the whole file back.
-- ─────────────────────────────────────────────────────────────────────────
do $assert$
declare
  v_def text;
  v_n   int;
  r     record;
begin
  for r in
    select * from (values
      ('get_de_experience',        'public.get_de_experience(uuid,integer)',       'de_not_found'),
      ('get_de_execution_log',     'public.get_de_execution_log(uuid,integer)',    'de_not_found'),
      ('get_de_agentic_runs',      'public.get_de_agentic_runs(uuid,integer)',     'de_not_found'),
      ('get_agentic_run_messages', 'public.get_agentic_run_messages(uuid)',        'run_not_found')
    ) as t(fname, fsig, ferr)
  loop
    -- exactly one arity per name (no signature changed, no stray overload)
    select count(*) into v_n
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = r.fname;
    if v_n <> 1 then
      raise exception 'ASSERT FAIL %: expected exactly 1 function in pg_proc, found %', r.fname, v_n;
    end if;

    v_def := pg_get_functiondef(r.fsig::regprocedure);

    -- the guard landed EXACTLY once: token occurrences == real calls
    -- (no in-body comment may contain the token — mig 442/428/414 class)
    v_n := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
    if v_n <> 1 then
      raise exception 'ASSERT FAIL %: expected exactly 1 guard occurrence, found %', r.fname, v_n;
    end if;

    -- the guard sits in the pre-check, BEFORE the data aggregation
    if position('can_access_de' in v_def) > position('jsonb_agg' in v_def)
       or position('jsonb_agg' in v_def) = 0 then
      raise exception 'ASSERT FAIL %: guard is not positioned before the data read', r.fname;
    end if;

    -- the tenant pin and null-tenant refusal survived the rewrite
    if position('auth_tenant_id' in v_def) = 0
       or v_def not like '%tenant_id = v_tenant%'
       or position('not_permitted' in v_def) = 0 then
      raise exception 'ASSERT FAIL %: tenant check did not survive the rewrite', r.fname;
    end if;

    -- the existence-denial envelope survived (denial stays indistinguishable
    -- from an unknown id)
    if position(r.ferr in v_def) = 0 then
      raise exception 'ASSERT FAIL %: envelope error token "%" missing', r.fname, r.ferr;
    end if;

    -- attributes survived: SECURITY DEFINER + pinned search_path + STABLE
    if v_def not like '%SECURITY DEFINER%'
       or v_def not like '%search_path%'
       or v_def not like '%STABLE%' then
      raise exception 'ASSERT FAIL %: definer/search_path/stable attributes did not survive', r.fname;
    end if;

    -- grants unchanged: authenticated keeps EXECUTE, anon still has NONE
    if not has_function_privilege('authenticated', r.fsig::regprocedure, 'execute') then
      raise exception 'ASSERT FAIL %: authenticated lost EXECUTE', r.fname;
    end if;
    if has_function_privilege('anon', r.fsig::regprocedure, 'execute') then
      raise exception 'ASSERT FAIL %: anon unexpectedly holds EXECUTE', r.fname;
    end if;
  end loop;

  -- the guard function itself is present at the expected single arity
  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'can_access_de';
  if v_n <> 1 then
    raise exception 'ASSERT FAIL: expected exactly 1 public.can_access_de, found %', v_n;
  end if;
end $assert$;

notify pgrst, 'reload schema';
