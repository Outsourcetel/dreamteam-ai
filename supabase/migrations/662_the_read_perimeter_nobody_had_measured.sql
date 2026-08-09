-- 662_the_read_perimeter_nobody_had_measured.sql
-- ============================================================================
-- R0.8 — "No signed-in user of tenant A can READ tenant B's data through any
-- RPC" — was the last Ring-0 invariant in docs/45 still marked UNPROVEN.
-- It is now FALSIFIED. This migration closes what the audit found.
--
-- THE SHAPE OF THE DEFECT. Every function here is SECURITY DEFINER, which means
-- it runs as the owner and RLS does not apply to it. That is fine and necessary
-- — right up until such a function ALSO holds EXECUTE for `authenticated` and
-- takes a tenant id (or an entity id) straight from its caller without ever
-- asking whether the caller belongs to that tenant. Then the parameter IS the
-- authorisation, and PostgREST exposes it to every signed-in session on the
-- internet. RLS on the underlying table is irrelevant; the function bypasses it.
--
-- WHAT WAS MEASURED (production, read-only):
--     629  routines reachable by `authenticated`
--     464  …of those, SECURITY DEFINER
--     364  …taking a uuid argument
--      69  …with NO caller-tenant derivation in the body  ← the candidate set
--
-- All 69 bodies were read. 41 were genuinely safe, 1 was left unresolved, and
-- 27 were judged to leak. Twelve of the 27 were then handed to independent
-- adversarial reviewers whose brief was to REFUTE the claim. All twelve
-- refutations failed. The worst of them return another tenant's playbook text,
-- its open invoices with customer names and amounts, its whole org tree, and —
-- in one case — perform a cross-tenant WRITE.
--
-- THE FIX, AND WHY IT IS THIS ONE. Every call site of all 27 was enumerated:
-- `admin.rpc(...)` in edge functions (service_role) or another SECURITY DEFINER
-- function (which runs as postgres). NOT ONE is called from the browser. So the
-- grant to `authenticated` was never used by anything — it was the Supabase
-- default nobody revoked. Least privilege costs nothing here.
--
-- ⚠ REVOKING IS ONLY SAFE BECAUSE NOTHING EVALUATES THESE AS THE CALLER.
-- A function used inside an RLS policy runs with the INVOKER's rights, so
-- revoking it from `authenticated` would make the whole table unreadable. That
-- was checked authoritatively via pg_depend, not by grepping — with
-- auth_tenant_id as a negative control, which correctly reported 292 dependent
-- policies. All 28 routines here: zero policy, view, index, trigger, constraint
-- or default dependents.
--
-- ⚠ ORDER MATTERS — THIS IS THE LESSON OF MIGRATION 658. `revoke ... from
-- public` also strips a role that held EXECUTE *through* PUBLIC rather than by
-- name. In 658 that silently broke the contact form I had just fixed. So
-- service_role is granted EXPLICITLY first, then the revoke runs, and then both
-- facts are asserted with has_function_privilege. A REVOKE statement is not a
-- description of the resulting privileges.
--
-- THE ONE EXCEPTION. list_consultable_for_de IS called from the browser
-- (src/pages/tenant/EmployeeFileSections.tsx:1022). It cannot be revoked, so it
-- gets the guard instead: can_access_de(p_de_id), the helper already used for
-- exactly this question. It RAISES rather than returning an empty list — a
-- refusal that looks like "no colleagues" is a refusal reported as success.
-- ============================================================================

begin;

-- Resolve a readable "name(argname argtype, …)" signature to an oid. Exists
-- only for the length of this migration; dropped at the bottom.
create or replace function public._662_oid(p_sig text)
returns oid
language plpgsql
as $fn$
declare
  v oid;
begin
  select p.oid into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' = p_sig;
  if v is null then
    raise exception '662: no such routine in public: %  (typo, or it was already dropped)', p_sig;
  end if;
  return v;
end;
$fn$;

-- ── The 27: server-side only, so the browser grant goes away ───────────────
do $$
declare
  v_sigs text[] := array[
    -- HIGH — another tenant's operating content, verbatim
    'get_de_briefing(p_de_id uuid)',
    'get_de_briefing_for_objective(p_de_id uuid, p_objective text)',
    'dunning_position(p_tenant_id uuid)',
    'list_org_tree_core(p_tenant_id uuid)',
    'run_dunning_sweep(p_tenant_id uuid, p_limit integer)',
    'preview_watcher_spec(p_kind text, p_config jsonb, p_tenant_id uuid)',
    -- HIGH — and it WRITES to another tenant's rows
    'link_agreements_to_accounts(p_tenant_id uuid)',
    -- MEDIUM — configuration, posture, aggregates and identities
    'decide_action_execution(p_tenant_id uuid, p_action_label text, p_category text, p_destructive boolean, p_de_id uuid, p_amount_cents bigint, p_action_type text, p_content text)',
    'resolve_de_escalation(p_tenant_id uuid, p_de_id uuid)',
    'de_eval_quality(p_tenant_id uuid, p_de_id uuid, p_days integer)',
    'dunning_de_for(p_tenant_id uuid)',
    'task_approval_facts(p_task_id uuid)',
    'analytics_action_volume(p_tenant_id uuid, p_days integer)',
    'has_approval_authority(p_user_id uuid, p_tenant_id uuid, p_category text, p_amount_cents bigint)',
    'knowledge_space_level_for(p_user uuid, p_space_id uuid)',
    'knowledge_effective_level_for(p_user uuid, p_doc_id uuid)',
    -- LOW — single facts, existence bits and fingerprints
    'resolve_de_archetype(p_de_id uuid)',
    'resolve_de_model_for_task(p_de_id uuid, p_task_class text)',
    'dunning_action_for(p_tenant_id uuid, p_action_key text, p_execution_key text)',
    'de_config_fingerprint(p_de_id uuid)',
    'check_action_idempotency(p_tenant_id uuid, p_action_definition_id uuid, p_dedupe_key text)',
    'check_de_budget(p_de_id uuid)',
    'classify_support_text(p_tenant_id uuid, p_text text)',
    'can_consult_multihop(p_tenant_id uuid, p_requester_de uuid, p_target_de uuid, p_path uuid[], p_max_depth integer)',
    'knowledge_group_max_level(p_group_id uuid)',
    'knowledge_collection_ancestry(p_collection_id uuid)',
    -- the one left UNRESOLVED by the audit: revoked on the same evidence
    -- (no browser caller, no policy dependent), so the open question becomes
    -- academic rather than exploitable.
    'knowledge_grant_matches_user(g knowledge_access_grants, p_user uuid)'
  ];
  v_sig text;
  v_oid oid;
begin
  if array_length(v_sigs, 1) <> 27 then
    raise exception '662: expected 27 signatures, got % — the list was edited without updating the count',
      array_length(v_sigs, 1);
  end if;

  foreach v_sig in array v_sigs loop
    -- Resolve by the EXACT identity string. (A ::regprocedure cast cannot be
    -- used here: it rejects parameter names, and dropping them would make this
    -- list unreadable.) A typo must be loud, never a silently skipped revoke.
    v_oid := public._662_oid(v_sig);

    -- EXPLICIT first (mig 658): so the revoke below cannot take the server's
    -- own access away with it.
    execute format('grant execute on function public.%s to service_role', v_sig);
    execute format('revoke execute on function public.%s from public, anon, authenticated', v_sig);
  end loop;

  -- ── Assert the RESULT, not the statement ────────────────────────────────
  foreach v_sig in array v_sigs loop
    v_oid := public._662_oid(v_sig);
    if has_function_privilege('authenticated', v_oid, 'EXECUTE') then
      raise exception '662: authenticated STILL holds EXECUTE on % — the revoke did not take', v_sig;
    end if;
    if has_function_privilege('anon', v_oid, 'EXECUTE') then
      raise exception '662: anon STILL holds EXECUTE on %', v_sig;
    end if;
    if not has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception '662: service_role LOST EXECUTE on % — the platform would break', v_sig;
    end if;
  end loop;

  raise notice '662: 27 routines closed to the browser; service_role retained on all 27';
end $$;

-- ── The exception: browser-called, so it gets a guard instead ─────────────
-- Unchanged query. What is new is the first four lines, and plpgsql so that a
-- denial can RAISE. can_access_de already allows service_role, platform admins,
-- tenant owner/admin/manager, direct assignees and org-unit supervisors — the
-- same set that can open the Employee File this list appears on.
create or replace function public.list_consultable_for_de(p_de_id uuid)
returns json
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_out json;
begin
  if not public.can_access_de(p_de_id) then
    raise exception 'not authorized for this digital employee'
      using errcode = '42501';
  end if;

  select coalesce(json_agg(row_to_json(x) order by x.name), '[]'::json)
    into v_out
  from (
    select d.id as target_de_id,
           coalesce(d.persona_name, d.name) as name,
           'grant'::text as grant_kind
    from de_consultation_grants g
    join digital_employees d on d.id = g.target_de_id
    where g.requester_de_id = p_de_id
      and g.active
      and d.status = 'active'
      and coalesce(d.lifecycle_status, '') not in ('retired', 'archived')
  ) x;

  return v_out;
end;
$function$;

grant execute on function public.list_consultable_for_de(uuid) to authenticated, service_role;
revoke execute on function public.list_consultable_for_de(uuid) from public, anon;

do $$
declare
  v_def text := pg_get_functiondef('public.list_consultable_for_de(uuid)'::regprocedure);
begin
  if v_def not ilike '%can_access_de%' then
    raise exception '662: the guard did not land on list_consultable_for_de';
  end if;
  if v_def not ilike '%raise exception%' then
    raise exception '662: a denial must raise, not return an empty list';
  end if;
  -- It must STILL be reachable, or the Employee File page loses the section.
  if not has_function_privilege('authenticated', 'public.list_consultable_for_de(uuid)'::regprocedure, 'EXECUTE') then
    raise exception '662: list_consultable_for_de is now unreachable from the UI that calls it';
  end if;
  if has_function_privilege('anon', 'public.list_consultable_for_de(uuid)'::regprocedure, 'EXECUTE') then
    raise exception '662: anon can read the consultation roster';
  end if;
  raise notice '662: list_consultable_for_de guarded, still reachable by authenticated';
end $$;

-- ── The class, not just the instances ─────────────────────────────────────
-- What remains of the candidate set after this migration. The audit cleared
-- these 41 by reading every body; this notice records the number so that a
-- later drift is visible in the migration log rather than only in certify.
do $$
declare
  v_left int;
begin
  select count(*) into v_left
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind in ('f','p')
     and p.prosecdef
     and has_function_privilege('authenticated', p.oid, 'EXECUTE')
     and pg_get_function_identity_arguments(p.oid) like '%uuid%'
     and p.prosrc not ilike '%auth_tenant_id%' and p.prosrc not ilike '%auth.uid%'
     and p.prosrc not ilike '%can_access_de%' and p.prosrc not ilike '%is_platform_admin%';
  raise notice '662: % routines remain in the candidate shape (all 41 read and cleared by the audit; certify pins this set)', v_left;
end $$;

drop function public._662_oid(text);

commit;
