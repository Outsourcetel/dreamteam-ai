-- ============================================================================
-- 447 — DE scoping, pre-start Group C: nine config/identity readers
--
-- Matrix ref: docs/32-pre-start-reports/02-permission-matrix.md P2-13.
-- All nine were TENANT-ONLY: any workspace member could read any DE's
-- certification state, lifecycle readiness, trust evidence, gate status,
-- role context, KPI applicability, autonomy resolution, specialist roster
-- and consult graph. Under docs/29 default-DENY each must also require
-- can_access_de (owner/admin/manager/platform/service_role pass; everyone
-- else needs a de_assignments row).
--
-- Verified live 2026-07-27 before drafting (no Wave-2 431-441 overlap):
-- none of the nine contained the guard token; each has exactly one arity.
-- Bodies below are reproduced from live pg_get_functiondef, not from old
-- migration files.
--
-- Caller analysis (mandatory, done against repo + live pg_proc + cron.job
-- + pg_views + pg_policy):
--   * supabase/functions/: ZERO callers of any of the nine (grep across all
--     edge functions incl. de-work, de-answer, playbook-execute, eval-run,
--     specialist-consult).
--   * cron.job: zero. pg_views: zero. RLS policies: zero.
--   * SQL-level: exactly ONE — advance_de_lifecycle() calls
--     compute_de_lifecycle_readiness(). advance_de_lifecycle is gated to
--     tenant_owner/tenant_admin, and the inner call runs under the caller's
--     JWT claims, so the guard passes unconditionally for every caller that
--     can reach it. No behaviour change on that path.
--   * src/ callers (all user-context browser clients):
--       de_certification_status        deWorkbenchApi.ts:256
--       compute_de_lifecycle_readiness LiveWorkforceDEs.tsx:2659
--       compute_trust_evidence         trustApi.ts:87 (per-card try/catch)
--       get_de_gate_status             EmployeeFilePage.tsx:706
--       get_de_role_context            employeeRecordApi.ts:107
--       get_kpi_metrics_for_de         roleConfigApi.ts:30
--       resolve_my_de_autonomy         autonomyApi.ts:78 (try/catch + banner)
--       list_de_specialists            LiveWorkforceDEs.tsx:1716
--       list_consultable_for_de        LiveWorkforceDEs.tsx:1717
--
-- Refusal shapes (readers filter / stay in their own error contract; the
-- two whose contract is raise-based raise the greppable Wave-2 code):
--   de_certification_status        -> {'state':'unknown'}   (its not-found shape)
--   compute_de_lifecycle_readiness -> {'error':'not_found'} (its not-found shape)
--   get_de_gate_status             -> {'ok':false,'error':'de_not_found'}
--   get_de_role_context            -> {'ok':false,'error':'de_not_found'}
--   get_kpi_metrics_for_de         -> '[]'
--   list_de_specialists            -> empty set (row filter)
--   list_consultable_for_de        -> '[]'     (row filter, both UNION branches)
--   compute_trust_evidence         -> RAISE not_responsible_for_de (null-tolerant:
--                                     p_de_id may legitimately be null = workspace policy)
--   resolve_my_de_autonomy         -> RAISE not_responsible_for_de (null-tolerant:
--                                     p_de_id DEFAULT NULL = tenant-wide dial)
--
-- No signature changes -> no DROPs needed; single arity asserted below.
-- CREATE OR REPLACE preserves each function's existing ACL; grants asserted.
-- list_consultable_for_de keeps its pre-existing PUBLIC+anon EXECUTE (fails
-- closed: null tenant + guard false). Revoking is the P3-16 housekeeping
-- sweep, deliberately NOT bundled into a scoping migration (docs/30 rule).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. de_certification_status — guard after the existing tenant/platform check.
--    NOTE the pre-existing check is skipped entirely on a null auth.uid();
--    the new guard does NOT copy that bypass (service contexts pass it by
--    role name), so a hypothetical future anon grant now fails closed too.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.de_certification_status(p_de_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid;
  v_current text;
  v_fresh boolean;
  v_has_pass boolean;
  v_disp role_certifications;   -- the cert to DISPLAY (prefer a fresh one)
  v_any  role_certifications;
begin
  select tenant_id into v_tenant from digital_employees where id = p_de_id;
  if v_tenant is null then return jsonb_build_object('state', 'unknown'); end if;
  if auth.uid() is not null and not exists (
      select 1 from profiles p where p.user_id = auth.uid()
      and (p.layer = 'platform' or p.tenant_id = v_tenant)) then
    raise exception 'not authorized';
  end if;
  if not public.can_access_de(p_de_id) then
    return jsonb_build_object('state', 'unknown');
  end if;

  v_current := public.de_config_fingerprint(p_de_id);

  -- Freshness is decided the SAME way the go-live gate decides it: does ANY
  -- passing cert match the current config fingerprint? (Not "is the newest
  -- passing cert fresh" — two passing certs can share a timestamp.)
  v_fresh := exists (
    select 1 from role_certifications
     where de_id = p_de_id and status = 'passed'
       and config_fingerprint is not distinct from v_current);
  v_has_pass := exists (
    select 1 from role_certifications where de_id = p_de_id and status = 'passed');

  -- Display cert: the matching fresh one if present, else the newest passing.
  select * into v_disp from role_certifications
    where de_id = p_de_id and status = 'passed'
    order by (config_fingerprint is not distinct from v_current) desc,
             evaluated_at desc nulls last, created_at desc limit 1;
  select * into v_any from role_certifications
    where de_id = p_de_id
    order by evaluated_at desc nulls last, created_at desc limit 1;

  return jsonb_build_object(
    'state', case
      when not v_has_pass and v_any.id is null then 'uncertified'
      when not v_has_pass then 'failed'
      when v_fresh then 'certified'
      else 'stale'
    end,
    'fresh', v_fresh,
    'latest_passed', case when v_disp.id is null then null else jsonb_build_object(
      'id', v_disp.id, 'score_pct', v_disp.score_pct, 'threshold_pct', v_disp.threshold_pct,
      'evaluated_at', v_disp.evaluated_at, 'archetype_key', v_disp.archetype_key,
      'certified_fingerprint', v_disp.config_fingerprint) end,
    'current_fingerprint', v_current,
    'latest_status', v_any.status
  );
end;
$function$;

-- ----------------------------------------------------------------------------
-- 2. compute_de_lifecycle_readiness — guard INSIDE the human branch, so the
--    body's explicit trusted-server-context contract (null auth.role() and
--    service_role pass untouched) is preserved exactly. The one SQL-level
--    caller, advance_de_lifecycle, is owner/admin-gated and unaffected.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compute_de_lifecycle_readiness(p_de_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_de digital_employees;
  v_tenant uuid;
  v_identity boolean;
  v_grants boolean;
  v_knowledge boolean;
  v_policies boolean;
  v_embedded boolean;
  v_qa_passed boolean;
  v_certified boolean;
  v_channel boolean;
  v_executed boolean;
begin
  select * into v_de from digital_employees where id = p_de_id;
  if v_de.id is null then return jsonb_build_object('error', 'not_found'); end if;
  v_tenant := v_de.tenant_id;

  -- Humans must belong to the workspace; trusted server contexts pass.
  if auth.role() is not null and auth.role() <> 'service_role' then
    if auth_tenant_id() is distinct from v_tenant then
      raise exception 'not a member of this workspace';
    end if;
    if not public.can_access_de(p_de_id) then
      return jsonb_build_object('error', 'not_found');
    end if;
  end if;

  v_identity := coalesce(v_de.name, '') <> '' and coalesce(v_de.description, '') <> ''
    and (coalesce(v_de.department, '') <> '' or coalesce(v_de.workspace, '') <> '')
    and coalesce(array_length(v_de.responsibilities, 1), 0) >= 1;

  v_grants := exists (select 1 from data_access_grants
    where tenant_id = v_tenant and subject_kind = 'de' and subject_id = p_de_id);

  v_knowledge := exists (select 1 from knowledge_docs d
    where d.tenant_id = v_tenant
      and (d.visibility = 'tenant'
           or exists (select 1 from knowledge_doc_scopes s
                      where s.doc_id = d.id and s.subject_kind = 'de' and s.subject_id = p_de_id)));

  v_policies := exists (select 1 from guardrail_rules where tenant_id = v_tenant and active);

  v_embedded := exists (select 1 from knowledge_doc_chunks c
    join knowledge_docs d on d.id = c.doc_id
    where d.tenant_id = v_tenant and c.embedding is not null
      and (d.visibility = 'tenant'
           or exists (select 1 from knowledge_doc_scopes s
                      where s.doc_id = d.id and s.subject_kind = 'de' and s.subject_id = p_de_id)));

  v_qa_passed := coalesce((select r.status = 'passed' from eval_runs r
    where r.tenant_id = v_tenant
    order by coalesce(r.finished_at, r.started_at) desc limit 1), false);

  v_certified := exists (select 1 from de_lifecycle_events
    where tenant_id = v_tenant and de_id = p_de_id and to_stage = 'certified' and actor_id is not null);

  v_channel := exists (select 1 from data_access_grants g
      where g.tenant_id = v_tenant and g.subject_kind = 'de' and g.subject_id = p_de_id
        and access_permission_level(g.permission) >= access_permission_level('search'))
    or exists (select 1 from widget_keys where tenant_id = v_tenant and active);

  v_executed := exists (select 1 from evidence_runs where tenant_id = v_tenant and de_id = p_de_id);

  return jsonb_build_object(
    'stage', v_de.lifecycle_status,
    'status', v_de.status,
    'criteria', jsonb_build_object(
      'configured', jsonb_build_object(
        'identity_complete', v_identity,
        'detail', 'Name, description, a department or workspace, and at least one responsibility.'),
      'trained', jsonb_build_object(
        'control_fabric_grant', v_grants,
        'knowledge_in_scope', v_knowledge,
        'active_guardrails', v_policies,
        'detail', 'At least one system-access grant, knowledge this employee can see, and active workspace guardrails.'),
      'tested', jsonb_build_object(
        'knowledge_embedded', v_embedded,
        'detail', 'The knowledge in scope is actually searchable (embedded), so answers can cite it.'),
      'certified', jsonb_build_object(
        'golden_qa_passed', v_qa_passed,
        'scope', 'workspace',
        'detail', 'The latest golden Q&A run passed. (Suite is workspace-level today — per-employee suites arrive with Skills, DE-C1.)'),
      'published', jsonb_build_object(
        'certified_by_human', v_certified,
        'detail', 'A named workspace owner/admin recorded certification.'),
      'assigned', jsonb_build_object(
        'has_work_channel', v_channel,
        'detail', 'A searchable system grant (inbox) or an active site widget key.'),
      'active', jsonb_build_object(
        'first_live_execution', v_executed,
        'detail', 'At least one real evidence run attributed to this employee.')
    )
  );
end;
$function$;

-- ----------------------------------------------------------------------------
-- 3. compute_trust_evidence — null-tolerant RAISE guard after the existing
--    membership checks. p_de_id null = workspace-level policy, which stays
--    workspace-visible (mirrors the migration-386 policy shape). Machine
--    callers cannot reach this function today (profiles lookup on auth.uid()
--    raises first) — unchanged.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compute_trust_evidence(p_de_id uuid, p_action_category text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_tenant uuid;
  v_is_active boolean;
  v_policy trust_policies;
begin
  select tenant_id, coalesce(is_active, true) into v_tenant, v_is_active from profiles where user_id = auth.uid() limit 1;
  if v_tenant is null then
    raise exception 'not a member of any tenant';
  end if;
  if not v_is_active then
    raise exception 'account is deactivated';
  end if;
  if p_de_id is not null and not public.can_access_de(p_de_id) then
    raise exception 'not_responsible_for_de';
  end if;

  select * into v_policy
  from trust_policies
  where tenant_id = v_tenant
    and action_category = p_action_category
    and (p_de_id is null or de_id is null or de_id = p_de_id)
  order by (de_id is not null and de_id = p_de_id) desc, (de_id is null) asc
  limit 1;
  if not found then
    raise exception 'no trust policy for category %', p_action_category;
  end if;

  return trust_evidence_for(v_policy);
end;
$function$;

-- ----------------------------------------------------------------------------
-- 4. get_de_gate_status — denial reports as de_not_found, identical to
--    nonexistence (the mig-392 single-lookup-gate model).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_de_gate_status(p_de_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_tenant uuid;
  v_g record;
begin
  v_tenant := public.auth_tenant_id();
  if v_tenant is null then return jsonb_build_object('ok', false, 'error', 'not_permitted'); end if;
  if not exists (select 1 from digital_employees where id = p_de_id and tenant_id = v_tenant) then
    return jsonb_build_object('ok', false, 'error', 'de_not_found');
  end if;
  if not public.can_access_de(p_de_id) then
    return jsonb_build_object('ok', false, 'error', 'de_not_found');
  end if;
  select * into v_g from public.de_records_gate(v_tenant, p_de_id);
  return jsonb_build_object('ok', true, 'gated', v_g.gated, 'reasons', to_jsonb(v_g.reasons));
end;
$function$;

-- ----------------------------------------------------------------------------
-- 5. get_de_role_context — denial reports as de_not_found, same model.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_de_role_context(p_de_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_tenant uuid; v_de record; v_arch record; v_domains jsonb;
begin
  v_tenant := public.auth_tenant_id();
  if v_tenant is null then return jsonb_build_object('ok', false, 'error', 'not_permitted'); end if;
  select id, category, department, is_specialist, specialist_key
    into v_de from digital_employees where id = p_de_id and tenant_id = v_tenant;
  if not found then return jsonb_build_object('ok', false, 'error', 'de_not_found'); end if;
  if not public.can_access_de(p_de_id) then
    return jsonb_build_object('ok', false, 'error', 'de_not_found');
  end if;

  -- Domains it operates = the system categories it's actually granted.
  select coalesce(jsonb_agg(distinct g.resource_category), '[]'::jsonb) into v_domains
    from data_access_grants g
   where g.tenant_id = v_tenant and g.subject_kind = 'de' and g.subject_id = p_de_id
     and g.resource_category is not null;

  -- Certified archetype (if any) supplies the canonical role name + domain.
  select ra.key, ra.name, ra.domain, ra.required_connector_categories
    into v_arch
    from role_certifications rc
    join role_archetypes ra on ra.key = rc.archetype_key
   where rc.tenant_id = v_tenant and rc.de_id = p_de_id and rc.archetype_key is not null
   order by rc.evaluated_at desc nulls last limit 1;

  return jsonb_build_object(
    'ok', true,
    'department', v_de.department,
    'category', v_de.category,
    'is_specialist', v_de.is_specialist,
    'domains', v_domains,
    'archetype_key', v_arch.key,
    'archetype_name', v_arch.name,
    'archetype_domain', v_arch.domain,
    'archetype_categories', coalesce(to_jsonb(v_arch.required_connector_categories), '[]'::jsonb)
  );
end $function$;

-- ----------------------------------------------------------------------------
-- 6. get_kpi_metrics_for_de — denial returns '[]', identical to nonexistence.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_kpi_metrics_for_de(p_de_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_tenant uuid; v_cats text[];
begin
  v_tenant := public.auth_tenant_id();
  if v_tenant is null then return '[]'::json; end if;
  if not exists (select 1 from digital_employees where id = p_de_id and tenant_id = v_tenant) then return '[]'::json; end if;
  if not public.can_access_de(p_de_id) then return '[]'::json; end if;
  select coalesce(array_agg(distinct resource_category), '{}') into v_cats
    from data_access_grants where tenant_id = v_tenant and subject_kind = 'de' and subject_id = p_de_id and resource_category is not null;
  return (
    select coalesce(json_agg(row_to_json(x) order by x.applicable desc, x.sort_order, x.label), '[]'::json) from (
      select metric_key, label, description, direction, unit, source, source_config, domains, sort_order,
             (tenant_id is not null) as is_custom,
             (domains is null or domains && v_cats) as applicable
        from kpi_metric_catalog
       where tenant_id is null or tenant_id = v_tenant
    ) x
  );
end $function$;

-- ----------------------------------------------------------------------------
-- 7. resolve_my_de_autonomy — null-tolerant RAISE guard (p_de_id DEFAULT NULL
--    resolves the tenant-wide dial, which stays workspace-visible).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_my_de_autonomy(p_action_type text, p_de_id uuid DEFAULT NULL::uuid, p_source_category text DEFAULT NULL::text)
 RETURNS TABLE(enabled boolean, max_amount_cents bigint, min_confidence integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_tenant uuid;
begin
  v_tenant := auth_tenant_id();
  if v_tenant is null then
    raise exception 'not a member of any tenant';
  end if;
  if p_de_id is not null and not public.can_access_de(p_de_id) then
    raise exception 'not_responsible_for_de';
  end if;
  return query select * from resolve_de_autonomy(v_tenant, p_action_type, p_de_id, p_source_category);
end;
$function$;

-- ----------------------------------------------------------------------------
-- 8. list_de_specialists — row filter on the WHERE (pure AND chain, no OR to
--    bracket). Denial = empty set, the reader shape.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_de_specialists(p_de_id uuid)
 RETURNS TABLE(rank smallint, specialist_id uuid, specialist_key text, specialist_name text, specialist_status text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_tenant uuid;
begin
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  return query
  select a.rank, d.id, coalesce(d.specialist_key, 'specialist'), coalesce(d.persona_name, d.name), d.status
  from de_specialist_assignments a
  join digital_employees d on d.id = a.specialist_de_id
  where a.tenant_id = v_tenant and a.de_id = p_de_id
    and public.can_access_de(p_de_id)
  order by a.rank;
end; $function$;

-- ----------------------------------------------------------------------------
-- 9. list_consultable_for_de — one guard per UNION branch (2 total). Both
--    WHERE clauses are pure AND chains, no OR to bracket. Pre-existing
--    PUBLIC+anon EXECUTE is untouched here (fails closed: null tenant AND
--    guard false) — revoke belongs to the P3-16 sweep.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_consultable_for_de(p_de_id uuid)
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT coalesce(json_agg(row_to_json(x) ORDER BY x.is_specialist DESC, x.name), '[]'::json)
  FROM (
    -- Absorbed specialists this DE is assigned to consult.
    SELECT d.id AS target_de_id, d.name, true AS is_specialist,
           a.rank AS rank, 'assignment' AS grant_kind
      FROM de_specialist_assignments a
      JOIN digital_employees d ON d.id = a.specialist_de_id
     WHERE a.de_id = p_de_id AND a.tenant_id = auth_tenant_id()
       AND public.can_access_de(p_de_id)
       AND d.lifecycle_status NOT IN ('retired','archived')
    UNION ALL
    -- Peer DEs this DE has a consultation grant with.
    SELECT d.id, d.name, false, NULL::int, 'grant'
      FROM de_consultation_grants g
      JOIN digital_employees d ON d.id = g.target_de_id
     WHERE g.requester_de_id = p_de_id AND g.tenant_id = auth_tenant_id() AND g.active
       AND public.can_access_de(p_de_id)
       AND d.lifecycle_status NOT IN ('retired','archived')
  ) x;
$function$;

-- ============================================================================
-- ASSERTIONS — the change LANDED, the old gates SURVIVED, nothing widened.
-- Token counting depends on the invariant: occurrences of the guard token in
-- pg_get_functiondef == real guard calls. No in-body comment above contains
-- the token (the mig 414/428 trap).
-- ============================================================================
DO $assert$
declare
  v_def text;
  v_n int;
  r record;
begin
  -- (a) exactly one arity per function — no accidental overload left behind.
  for r in
    select t.fname, count(p.oid) as cnt
      from (values ('de_certification_status'),('compute_de_lifecycle_readiness'),
                   ('compute_trust_evidence'),('get_de_gate_status'),
                   ('get_de_role_context'),('get_kpi_metrics_for_de'),
                   ('resolve_my_de_autonomy'),('list_de_specialists'),
                   ('list_consultable_for_de')) t(fname)
      left join pg_proc p
             on p.proname = t.fname
            and p.pronamespace = 'public'::regnamespace
      group by t.fname
  loop
    if r.cnt <> 1 then
      raise exception 'ASSERT FAIL: % has % pg_proc rows, expected 1', r.fname, r.cnt;
    end if;
  end loop;

  -- (b) guard token count per body: exactly 1 everywhere except
  --     list_consultable_for_de, which needs one per UNION branch (2).
  for r in
    select t.fname, t.expected
      from (values ('de_certification_status', 1),('compute_de_lifecycle_readiness', 1),
                   ('compute_trust_evidence', 1),('get_de_gate_status', 1),
                   ('get_de_role_context', 1),('get_kpi_metrics_for_de', 1),
                   ('resolve_my_de_autonomy', 1),('list_de_specialists', 1),
                   ('list_consultable_for_de', 2)) t(fname, expected)
  loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p
     where p.proname = r.fname and p.pronamespace = 'public'::regnamespace;
    v_n := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
    if v_n <> r.expected then
      raise exception 'ASSERT FAIL: % contains % guard tokens, expected %', r.fname, v_n, r.expected;
    end if;
  end loop;

  -- (c) the pre-existing gates survived each rewrite (single-line tokens,
  --     immune to the CRLF trap). Losing one of these would fail open while
  --     reading like an improvement.
  for r in
    select * from (values
      ('de_certification_status',        'p.layer = ''platform'''),
      ('de_certification_status',        'not authorized'),
      ('compute_de_lifecycle_readiness', 'auth.role() <> ''service_role'''),
      ('compute_de_lifecycle_readiness', 'not a member of this workspace'),
      ('compute_trust_evidence',         'not a member of any tenant'),
      ('compute_trust_evidence',         'account is deactivated'),
      ('get_de_gate_status',             'not_permitted'),
      ('get_de_gate_status',             'de_records_gate'),
      ('get_de_role_context',            'not_permitted'),
      ('get_de_role_context',            'de_not_found'),
      ('get_kpi_metrics_for_de',         'auth_tenant_id()'),
      ('get_kpi_metrics_for_de',         'kpi_metric_catalog'),
      ('resolve_my_de_autonomy',         'not a member of any tenant'),
      ('resolve_my_de_autonomy',         'resolve_de_autonomy(v_tenant'),
      ('list_de_specialists',            'not a member of any tenant'),
      ('list_de_specialists',            'a.tenant_id = v_tenant')
    ) t(fname, needle)
  loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p
     where p.proname = r.fname and p.pronamespace = 'public'::regnamespace;
    if position(r.needle in v_def) = 0 then
      raise exception 'ASSERT FAIL: % lost its pre-existing gate token [%]', r.fname, r.needle;
    end if;
  end loop;

  -- (c2) list_consultable_for_de must still pin BOTH branches to the caller
  --      tenant (2 occurrences of the tenant helper).
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p
   where p.proname = 'list_consultable_for_de' and p.pronamespace = 'public'::regnamespace;
  v_n := (length(v_def) - length(replace(v_def, 'auth_tenant_id()', ''))) / length('auth_tenant_id()');
  if v_n <> 2 then
    raise exception 'ASSERT FAIL: list_consultable_for_de has % tenant pins, expected 2', v_n;
  end if;

  -- (d) grants: CREATE OR REPLACE must have preserved the ACLs.
  --     authenticated keeps EXECUTE on all nine; anon holds EXECUTE on NONE
  --     of the eight (list_consultable_for_de keeps its pre-existing anon
  --     grant — fails closed — pending the P3-16 sweep).
  for r in
    select t.fname,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_ok,
           has_function_privilege('anon',          p.oid, 'EXECUTE') as anon_x
      from (values ('de_certification_status'),('compute_de_lifecycle_readiness'),
                   ('compute_trust_evidence'),('get_de_gate_status'),
                   ('get_de_role_context'),('get_kpi_metrics_for_de'),
                   ('resolve_my_de_autonomy'),('list_de_specialists'),
                   ('list_consultable_for_de')) t(fname)
      join pg_proc p
        on p.proname = t.fname and p.pronamespace = 'public'::regnamespace
  loop
    if not r.auth_ok then
      raise exception 'ASSERT FAIL: authenticated lost EXECUTE on %', r.fname;
    end if;
    if r.anon_x and r.fname <> 'list_consultable_for_de' then
      raise exception 'ASSERT FAIL: anon unexpectedly holds EXECUTE on %', r.fname;
    end if;
  end loop;

  -- (e) runtime smoke: each body still executes in contract for the
  --     migration runner (postgres has no workspace identity, so the correct
  --     answers are the functions' own denial shapes / auth gates firing —
  --     this proves nothing about scoped visibility, per docs/30).
  if (public.de_certification_status(gen_random_uuid()))->>'state' is distinct from 'unknown' then
    raise exception 'ASSERT FAIL: de_certification_status smoke (unknown de) broke';
  end if;
  if (public.compute_de_lifecycle_readiness(gen_random_uuid()))->>'error' is distinct from 'not_found' then
    raise exception 'ASSERT FAIL: compute_de_lifecycle_readiness smoke (unknown de) broke';
  end if;
  if (public.get_de_gate_status(gen_random_uuid()))->>'error' is distinct from 'not_permitted' then
    raise exception 'ASSERT FAIL: get_de_gate_status smoke (no identity) broke';
  end if;
  if (public.get_de_role_context(gen_random_uuid()))->>'error' is distinct from 'not_permitted' then
    raise exception 'ASSERT FAIL: get_de_role_context smoke (no identity) broke';
  end if;
  if (public.get_kpi_metrics_for_de(gen_random_uuid()))::text is distinct from '[]' then
    raise exception 'ASSERT FAIL: get_kpi_metrics_for_de smoke (no identity) broke';
  end if;
  if (public.list_consultable_for_de(gen_random_uuid()))::text is distinct from '[]' then
    raise exception 'ASSERT FAIL: list_consultable_for_de smoke (no identity) broke';
  end if;
  begin
    perform public.compute_trust_evidence(null::uuid, 'external_reply');
    raise exception 'ASSERT FAIL: compute_trust_evidence did not fire its tenant gate for postgres';
  exception
    when others then
      if sqlerrm not like '%not a member of any tenant%' then raise; end if;
  end;
  begin
    perform * from public.resolve_my_de_autonomy('external_reply', null::uuid, null::text);
    raise exception 'ASSERT FAIL: resolve_my_de_autonomy did not fire its tenant gate for postgres';
  exception
    when others then
      if sqlerrm not like '%not a member of any tenant%' then raise; end if;
  end;
  begin
    perform * from public.list_de_specialists(gen_random_uuid());
    raise exception 'ASSERT FAIL: list_de_specialists did not fire its tenant gate for postgres';
  exception
    when others then
      if sqlerrm not like '%not a member of any tenant%' then raise; end if;
  end;

  raise notice 'Group C: 9 functions scoped, 10 guards, all gates verified.';
end;
$assert$;

NOTIFY pgrst, 'reload schema';
