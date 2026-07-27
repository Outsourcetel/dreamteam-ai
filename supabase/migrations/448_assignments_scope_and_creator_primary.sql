-- 448 — GROUP D (docs/32 permission matrix, P2-14 + owner_id retirement step 1)
--
-- Two changes, one group:
--
--   D1. list_de_assignments(p_de_id uuid)
--       Adds public.can_access_de(p_de_id) to the WHERE. Reading WHO answers
--       for a DE follows the DE axis: manager+ pass on the role branch of the
--       guard, scoped users need a de_assignments row for that DE. The live
--       WHERE (read from pg_get_functiondef 2026-07-27, this session) is a
--       pure conjunction — `a.de_id = p_de_id AND a.tenant_id =
--       auth_tenant_id()` — there is NO OR anywhere in the predicate, so
--       appending AND is precedence-safe (hard rule 1 checked, not assumed).
--       Reader ⇒ filter shape (empty set), matching group-A discipline.
--       ACL verified live: {postgres,authenticated,service_role} only — no
--       PUBLIC, no anon. The REVOKE below is defensive + asserted, not a fix.
--       Caller analysis (full grep of src/ + supabase/functions/):
--         - src/components/de/ResponsiblePeoplePanel.tsx:62 — ONLY caller;
--           browser user-context. Manager+ unaffected (role branch). A scoped
--           user sees the panel populated only for DEs they are assigned to.
--         - No edge-function caller; and service_role already got an empty
--           set here (auth_tenant_id() is NULL for it), so no admin path can
--           newly go empty.
--
--   D2. create_digital_employee(...)
--       Stops writing the dead column on digital_employees (0/116 rows set,
--       docs/29 verdict: retire, not repurpose; column itself is NOT dropped
--       here). Instead, after the DE insert, records the creator as the DE's
--       'primary' responsible person in de_assignments, mirroring
--       set_de_assignment's live write shape (mig 429) including its
--       access_control audit event ('governance' is not a legal category —
--       audit_events CHECK).
--       Caller analysis (full grep of src/ + supabase/functions/ + pg_proc
--       prosrc scan):
--         - src/lib/digitalEmployeesApi.ts:120 (used by CompanySetupPage.tsx:105
--           and LiveWorkforceDEs.tsx:276) — browser user-context, owner/admin
--           only (function's own gate). v_user is non-null on every path that
--           reaches the insert (the service_role branch raises before it), and
--           the gate already proved profiles membership, so the de_assignments
--           tenant/FK writes cannot fail for a legal caller. RETURNS
--           digital_employees is unchanged; callers read the returned row.
--         - connector-hub dt_create_digital_employee (index.ts:2362) does a
--           DIRECT table insert, never this RPC — unaffected.
--         - provision_onboarding_architect and onboarding-assist mention the
--           name only inside LLM prompt TEXT, not as calls — unaffected.
--         - provision_starter_de_internal is a different function (direct
--           insert, NULL owner) — deliberately untouched per the worklist.
--         - No plpgsql body calls this function (prosrc scan: only the prompt
--           text above matches).
--
-- Both bodies reproduced from live pg_get_functiondef (2026-07-27), not from
-- old migration files. Signatures unchanged — no DROP needed; arity asserted.

-- ============================================================================
-- D1. list_de_assignments — scope the reporting-line read to the DE axis
-- ============================================================================

CREATE OR REPLACE FUNCTION public.list_de_assignments(p_de_id uuid)
 RETURNS TABLE(id uuid, user_id uuid, relation text, full_name text, email text, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT a.id, a.user_id, a.relation,
         p.full_name,
         (SELECT u.email FROM auth.users u WHERE u.id = a.user_id),
         a.created_at
    FROM de_assignments a
    LEFT JOIN profiles p ON p.user_id = a.user_id
   WHERE a.de_id = p_de_id
     AND a.tenant_id = auth_tenant_id()
     AND public.can_access_de(p_de_id)
   ORDER BY CASE a.relation WHEN 'primary' THEN 1 WHEN 'manager' THEN 2 ELSE 3 END,
            p.full_name;
$function$;

-- Defensive: verified not granted today; keep it that way (names + emails).
REVOKE ALL ON ROUTINE public.list_de_assignments(uuid) FROM PUBLIC, anon;

-- ============================================================================
-- D2. create_digital_employee — creator becomes 'primary'; dead column untouched
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_digital_employee(p_name text, p_description text DEFAULT ''::text, p_category text DEFAULT 'Customer'::text, p_department text DEFAULT ''::text, p_persona_name text DEFAULT NULL::text, p_trust_level text DEFAULT 'supervised'::text, p_confidence_threshold integer DEFAULT 75, p_required_approval boolean DEFAULT false)
 RETURNS digital_employees
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_tenant uuid;
  v_role   text;
  v_is_active boolean;
  v_user   uuid := auth.uid();
  v_row    digital_employees;
  v_assignment_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    select tenant_id, role, coalesce(is_active, true) into v_tenant, v_role, v_is_active from profiles where user_id = v_user;
    if v_tenant is null then
      raise exception 'not a member of any tenant';
    end if;
    if not v_is_active then
      raise exception 'account is deactivated';
    end if;
    if v_role not in ('tenant_owner', 'tenant_admin') then
      raise exception 'only workspace owners/admins can create a new Digital Employee';
    end if;
  else
    raise exception 'service-role callers must pass a tenant explicitly — use the seed do-block pattern for migration-time creation';
  end if;

  if trim(coalesce(p_name, '')) = '' then
    raise exception 'a Digital Employee needs a name';
  end if;
  if p_trust_level not in ('supervised', 'established', 'trusted', 'autonomous') then
    raise exception 'trust_level must be one of: supervised, established, trusted, autonomous';
  end if;
  if p_confidence_threshold < 0 or p_confidence_threshold > 100 then
    raise exception 'confidence_threshold must be between 0 and 100';
  end if;

  insert into digital_employees (
    tenant_id, name, persona_name, description, category, department,
    status, lifecycle_status, trust_level, confidence_threshold, required_approval, created_by
  ) values (
    v_tenant, trim(p_name), nullif(trim(coalesce(p_persona_name, '')), ''), coalesce(p_description, ''),
    coalesce(p_category, 'Customer'), coalesce(p_department, ''),
    'active', 'designed', p_trust_level, p_confidence_threshold, coalesce(p_required_approval, false), v_user
  )
  returning * into v_row;

  perform append_audit_event(
    v_tenant, coalesce((select full_name from profiles where user_id = v_user), 'you'), 'human',
    format('New Digital Employee created — %s%s (%s / %s)', v_row.name,
      case when v_row.persona_name is not null then format(' ("%s")', v_row.persona_name) else '' end,
      v_row.category, coalesce(nullif(v_row.department, ''), 'unassigned department')),
    'config_change',
    jsonb_build_object('kind', 'digital_employee_created', 'de_id', v_row.id, 'name', v_row.name,
      'persona_name', v_row.persona_name, 'category', v_row.category, 'department', v_row.department,
      'trust_level', v_row.trust_level, 'created_by', v_user)
  );

  -- The creator becomes this employee's primary responsible person on the
  -- assignment axis (docs/29: the DE line lives in de_assignments). Write
  -- shape mirrors set_de_assignment, mig 429: upsert on the natural key,
  -- then the governance record AFTER the write. category access_control and
  -- actor_type human are the only values the audit_events CHECK allows here.
  insert into de_assignments (tenant_id, de_id, user_id, relation, assigned_by)
  values (v_tenant, v_row.id, v_user, 'primary', v_user)
  on conflict (de_id, user_id, relation) do update set assigned_by = excluded.assigned_by
  returning id into v_assignment_id;

  perform append_audit_event(
    v_tenant,
    coalesce((select full_name from profiles where user_id = v_user), 'A manager'),
    'human',
    format('Assigned %s as primary for a digital employee',
           coalesce((select full_name from profiles where user_id = v_user), 'a teammate')),
    'access_control',
    jsonb_build_object('kind', 'de_assignment_set', 'de_id', v_row.id,
                       'user_id', v_user, 'relation', 'primary',
                       'assignment_id', v_assignment_id, 'was_new', true,
                       'assigned_by', v_user));

  return v_row;
end;
$function$;

-- ============================================================================
-- Asserts — the change LANDED, and nothing load-bearing was lost in transit
-- ============================================================================

DO $$
DECLARE
  v_def text;
  v_cnt int;
  v_arity int;
  v_bad boolean;
BEGIN
  ------------------------------------------------------------------
  -- D1 asserts
  ------------------------------------------------------------------
  SELECT count(*) INTO v_arity
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'list_de_assignments';
  IF v_arity <> 1 THEN
    RAISE EXCEPTION 'list_de_assignments: expected exactly 1 overload, found %', v_arity;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'list_de_assignments';

  -- Guard token count must be EXACTLY 1 (one real call, zero comment
  -- contamination — the token is reserved in in-body comments, migs 414/428).
  v_cnt := (length(v_def) - length(replace(v_def, 'can_access_de', ''))) / length('can_access_de');
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'list_de_assignments: guard token count = %, expected exactly 1', v_cnt;
  END IF;

  -- The tenant pin must have survived the rewrite (guard is additive, not a swap).
  IF position('auth_tenant_id' IN v_def) = 0 THEN
    RAISE EXCEPTION 'list_de_assignments: tenant pin lost in rewrite';
  END IF;

  -- No anon and no PUBLIC execute (names + emails behind it).
  IF has_function_privilege('anon', 'public.list_de_assignments(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'list_de_assignments: anon still holds EXECUTE';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL unnest(p.proacl) a
    WHERE n.nspname = 'public' AND p.proname = 'list_de_assignments'
      AND a::text LIKE '=%'
  ) INTO v_bad;
  IF v_bad THEN
    RAISE EXCEPTION 'list_de_assignments: PUBLIC still holds a grant';
  END IF;

  -- authenticated must still be able to execute (the panel is user-context).
  IF NOT has_function_privilege('authenticated', 'public.list_de_assignments(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'list_de_assignments: authenticated lost EXECUTE';
  END IF;

  ------------------------------------------------------------------
  -- D2 asserts
  ------------------------------------------------------------------
  SELECT count(*) INTO v_arity
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_digital_employee';
  IF v_arity <> 1 THEN
    RAISE EXCEPTION 'create_digital_employee: expected exactly 1 overload, found %', v_arity;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_digital_employee';

  -- The dead column must be GONE from the body — call, comment, anywhere.
  IF position('owner_id' IN v_def) > 0 THEN
    RAISE EXCEPTION 'create_digital_employee: still references the dead column';
  END IF;

  -- The assignment write and its governance record must be present.
  IF position('insert into de_assignments' IN v_def) = 0 THEN
    RAISE EXCEPTION 'create_digital_employee: de_assignments insert missing';
  END IF;
  IF position('de_assignment_set' IN v_def) = 0 THEN
    RAISE EXCEPTION 'create_digital_employee: mig-429-shaped audit event missing';
  END IF;
  IF position('access_control' IN v_def) = 0 THEN
    RAISE EXCEPTION 'create_digital_employee: audit event category is not access_control';
  END IF;

  -- Load-bearing survivors: role gate, service-role refusal, created_by.
  IF position('tenant_owner' IN v_def) = 0 OR position('tenant_admin' IN v_def) = 0 THEN
    RAISE EXCEPTION 'create_digital_employee: owner/admin role gate lost in rewrite';
  END IF;
  IF position('service_role' IN v_def) = 0 THEN
    RAISE EXCEPTION 'create_digital_employee: service-role branch lost in rewrite';
  END IF;
  IF position('created_by' IN v_def) = 0 THEN
    RAISE EXCEPTION 'create_digital_employee: created_by lost in rewrite';
  END IF;

  -- Order: the assignment insert must come AFTER the DE insert.
  IF position('insert into de_assignments' IN v_def) < position('insert into digital_employees' IN v_def) THEN
    RAISE EXCEPTION 'create_digital_employee: assignment insert precedes the DE insert';
  END IF;

  -- anon must not be able to execute a DE-creating function.
  IF has_function_privilege('anon', 'public.create_digital_employee(text,text,text,text,text,text,integer,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'create_digital_employee: anon holds EXECUTE';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
