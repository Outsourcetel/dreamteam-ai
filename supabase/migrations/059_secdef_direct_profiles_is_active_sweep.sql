-- Migration 059: is_active enforcement sweep for SECURITY DEFINER RPCs that
-- check tenant/role membership via a DIRECT `select ... from profiles where
-- user_id = auth.uid()` query, instead of routing through auth_tenant_id()
-- or is_platform_admin(). Those two choke-points were fixed in migrations
-- 056 and 058 respectively -- but any function that never calls them (i.e.
-- does its own independent profiles lookup) does NOT automatically inherit
-- the fix. A deactivated user's still-valid JWT could still successfully
-- call any of the functions below prior to this migration.
--
-- Enumerated live via pg_proc / pg_get_functiondef / information_schema, not
-- by grepping migration files (many bodies were superseded by later
-- CREATE OR REPLACE statements). Every function below was confirmed, at the
-- time of this migration, to be:
--   1. SECURITY DEFINER,
--   2. GRANTed EXECUTE to `authenticated` (service_role-only functions are
--      out of scope -- service_role calls aren't subject to a human
--      account's is_active state),
--   3. Resolving the CALLING user's tenant/role by querying public.profiles
--      directly, rather than via auth_tenant_id()/is_platform_admin().
--
-- Fix shape: extend each existing profiles lookup to also fetch is_active,
-- and reject when it's false -- BEFORE any other existing check (tenant
-- match, role, self-approval, etc.), which are otherwise preserved exactly
-- as they were. GRANT/REVOKE structure is untouched; only function bodies
-- change (CREATE OR REPLACE FUNCTION).
--
-- Functions confirmed to already route through auth_tenant_id() /
-- is_platform_admin() (and therefore NOT touched here): detect_exceptions,
-- ingest_document, resolve_exception, approve_subtenant_request,
-- reject_subtenant_request, revoke_platform_invite, invite_platform_team_member,
-- list_platform_invites, end_platform_remote_access, platform_config_set,
-- platform_config_has_key, set_tenant_feature_override.
-- my_account_status() is deliberately left unchanged -- it's the
-- self-status probe a deactivated user's own client relies on to detect
-- deactivation in the first place.
-- =====================================================================


-- ── append_audit_event ──────────────────────────────────────────────
create or replace function public.append_audit_event(p_tenant_id uuid, p_actor text, p_actor_type text, p_action text, p_category text, p_detail jsonb DEFAULT '{}'::jsonb)
 returns audit_events
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_prev text;
  v_now  timestamptz := clock_timestamp();
  v_hash text;
  v_row  audit_events;
  v_is_active boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    select coalesce(is_active, true) into v_is_active from profiles where user_id = auth.uid() and tenant_id = p_tenant_id;
    if v_is_active is null or not v_is_active then
      raise exception 'not a member of this tenant';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('audit_' || p_tenant_id::text));

  select hash into v_prev
  from audit_events
  where tenant_id = p_tenant_id
  order by created_at desc, id desc
  limit 1;
  v_prev := coalesce(v_prev, '');

  v_hash := encode(digest(
    v_prev || p_tenant_id::text || coalesce(p_action, '') ||
    coalesce(p_detail::text, '{}') || v_now::text,
    'sha256'), 'hex');

  insert into audit_events (tenant_id, actor, actor_type, action, category, detail, prev_hash, hash, created_at)
  values (
    p_tenant_id,
    coalesce(nullif(p_actor, ''), 'system'),
    coalesce(nullif(p_actor_type, ''), 'system'),
    p_action,
    p_category,
    coalesce(p_detail, '{}'::jsonb),
    v_prev,
    v_hash,
    v_now
  )
  returning * into v_row;
  return v_row;
end;
$function$;


-- ── apply_knowledge_revision ────────────────────────────────────────
create or replace function public.apply_knowledge_revision(p_request_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_user          uuid := auth.uid();
  v_caller_tenant uuid;
  v_is_active     boolean;
  v_req           record;
  v_new_doc_id    uuid;
  v_actor_name    text;
begin
  select * into v_req from knowledge_revision_requests where id = p_request_id;
  if v_req.id is null then
    return jsonb_build_object('ok', false, 'error', 'request_not_found');
  end if;
  if v_req.status <> 'pending_approval' then
    return jsonb_build_object('ok', false, 'error', 'not_pending', 'status', v_req.status);
  end if;

  if v_user is not null then
    select tenant_id, coalesce(is_active, true) into v_caller_tenant, v_is_active from profiles where user_id = v_user;
    if v_caller_tenant is null or v_caller_tenant <> v_req.tenant_id then
      return jsonb_build_object('ok', false, 'error', 'not_tenant_member');
    end if;
    if not v_is_active then
      return jsonb_build_object('ok', false, 'error', 'not_tenant_member');
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    return jsonb_build_object('ok', false, 'error', 'not_tenant_member');
  end if;

  select coalesce(full_name, 'A reviewer') into v_actor_name from profiles where user_id = v_user;
  v_actor_name := coalesce(v_actor_name, 'A reviewer');

  insert into knowledge_docs (
    tenant_id, title, content, source, tags, previous_version_id, is_current, visibility
  )
  select
    v_req.tenant_id, v_req.proposed_title, v_req.proposed_body_md, 'paste',
    coalesce((select tags from knowledge_docs where id = v_req.source_doc_id), '{}'),
    v_req.source_doc_id, true,
    coalesce((select visibility from knowledge_docs where id = v_req.source_doc_id), 'tenant')
  returning id into v_new_doc_id;

  if v_req.source_doc_id is not null then
    update knowledge_docs set is_current = false where id = v_req.source_doc_id;
  end if;

  update knowledge_revision_requests
    set status = 'applied', decided_by = v_user, decided_at = now(), applied_doc_id = v_new_doc_id
    where id = p_request_id;

  perform append_audit_event(
    v_req.tenant_id, v_actor_name, case when v_user is null then 'system' else 'human' end,
    v_actor_name || ' approved and applied a knowledge revision — "' || v_req.proposed_title || '"',
    'knowledge_revision',
    jsonb_build_object('kind', 'knowledge_revision_applied', 'revision_request_id', p_request_id,
      'new_doc_id', v_new_doc_id, 'previous_doc_id', v_req.source_doc_id)
  );

  return jsonb_build_object('ok', true, 'new_doc_id', v_new_doc_id, 'previous_doc_id', v_req.source_doc_id);
end;
$function$;


-- ── apply_trust_promotion ───────────────────────────────────────────
create or replace function public.apply_trust_promotion(p_task_id uuid, p_decision text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_policy   trust_policies;
  v_evidence jsonb;
  v_new      integer;
  v_label    text;
  v_is_active boolean;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected';
  end if;

  select * into v_policy from trust_policies where pending_task_id = p_task_id;
  if not found then
    return jsonb_build_object('applied', false, 'reason', 'no_pending_policy');
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    select coalesce(is_active, true) into v_is_active from profiles where user_id = auth.uid() and tenant_id = v_policy.tenant_id;
    if v_is_active is null or not v_is_active then
      raise exception 'not a member of this tenant';
    end if;
  end if;

  v_label := replace(v_policy.action_category, '_', ' ');

  if p_decision = 'rejected' then
    update trust_policies
    set pending_task_id = null, pending_evidence = null, requested_by = null, requested_at = null
    where id = v_policy.id;
    perform append_audit_event(
      v_policy.tenant_id, 'You', 'human',
      format('Trust promotion rejected — %s stays at level %s', v_label, v_policy.current_level),
      'config_change',
      jsonb_build_object('kind', 'trust_promotion_rejected', 'policy_id', v_policy.id,
        'action_category', v_policy.action_category, 'level', v_policy.current_level,
        'task_id', p_task_id, 'decided_by', auth.uid())
    );
    return jsonb_build_object('applied', false, 'reason', 'rejected');
  end if;

  -- Self-approval block: the requester cannot approve their own promotion.
  if auth.uid() is not null and v_policy.requested_by is not null and auth.uid() = v_policy.requested_by then
    perform append_audit_event(
      v_policy.tenant_id, 'Trust engine', 'system',
      format('Trust promotion blocked — requester cannot approve their own request (%s)', v_label),
      'config_change',
      jsonb_build_object('kind', 'trust_promotion_blocked_self_approval', 'policy_id', v_policy.id,
        'action_category', v_policy.action_category, 'task_id', p_task_id, 'user_id', auth.uid())
    );
    raise exception 'the requester cannot approve their own promotion — a different teammate must approve';
  end if;

  -- Stale-check: evidence could have regressed since the request.
  v_evidence := trust_evidence_for(v_policy);
  if not coalesce((v_evidence->>'eligible')::boolean, false) then
    update trust_policies
    set pending_task_id = null, pending_evidence = null, requested_by = null, requested_at = null
    where id = v_policy.id;
    perform append_audit_event(
      v_policy.tenant_id, 'Trust engine', 'system',
      format('Trust promotion rejected as stale — %s evidence regressed since the request', v_label),
      'config_change',
      jsonb_build_object('kind', 'trust_promotion_stale', 'policy_id', v_policy.id,
        'action_category', v_policy.action_category, 'task_id', p_task_id,
        'evidence_at_request', v_policy.pending_evidence, 'evidence_at_apply', v_evidence)
    );
    raise exception 'evidence regressed since the request — promotion rejected as stale';
  end if;

  v_new := least(v_policy.current_level + 1, 3);
  perform trust_apply_level(v_policy.tenant_id, v_policy.action_category, v_new, auth.uid(), v_policy.source_category);

  update trust_policies
  set current_level = v_new,
      pending_task_id = null, pending_evidence = null, requested_by = null, requested_at = null
  where id = v_policy.id;

  perform append_audit_event(
    v_policy.tenant_id, 'You', 'human',
    format('Trust promoted — %s level %s → %s (evidence re-verified at apply time; still capped by guardrails)',
      v_label, v_policy.current_level, v_new),
    'config_change',
    jsonb_build_object('kind', 'trust_promoted', 'policy_id', v_policy.id,
      'action_category', v_policy.action_category, 'from_level', v_policy.current_level,
      'to_level', v_new, 'task_id', p_task_id, 'approved_by', auth.uid(),
      'requested_by', v_policy.requested_by, 'evidence', v_evidence,
      'dial_settings', trust_level_settings(v_policy.action_category, v_new),
      'composition', 'autonomy_narrows_within_guardrails')
  );

  return jsonb_build_object('applied', true, 'new_level', v_new);
end;
$function$;


-- ── close_opportunity_lost ──────────────────────────────────────────
create or replace function public.close_opportunity_lost(p_opp uuid, p_reason text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_opp    opportunities;
  v_tenant uuid;
  v_is_active boolean;
begin
  select tenant_id, coalesce(is_active, true) into v_tenant, v_is_active from profiles where user_id = auth.uid() limit 1;
  if v_tenant is null then raise exception 'no tenant for caller'; end if;
  if not v_is_active then raise exception 'account is deactivated'; end if;
  if coalesce(trim(p_reason), '') = '' then
    return jsonb_build_object('error', 'lost_reason_required');
  end if;
  select * into v_opp from opportunities where id = p_opp and tenant_id = v_tenant;
  if not found then return jsonb_build_object('error', 'opportunity_not_found'); end if;
  if v_opp.stage in ('won', 'lost') then return jsonb_build_object('error', 'already_closed'); end if;

  perform set_config('dreamteam.opp_close', 'on', true);
  update opportunities set stage = 'lost', lost_reason = trim(p_reason) where id = v_opp.id;
  perform set_config('dreamteam.opp_close', '', true);

  return jsonb_build_object('closed', true);
end;
$function$;


-- ── close_opportunity_won ───────────────────────────────────────────
create or replace function public.close_opportunity_won(p_opp uuid, p_account_id uuid DEFAULT NULL::uuid, p_create_onboarding boolean DEFAULT false, p_template_version uuid DEFAULT NULL::uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_opp       opportunities;
  v_tenant    uuid;
  v_is_active boolean;
  v_acct_id   uuid;
  v_acct_name text;
  v_proj      jsonb;
  v_proj_id   uuid;
begin
  select tenant_id, coalesce(is_active, true) into v_tenant, v_is_active from profiles where user_id = auth.uid() limit 1;
  if v_tenant is null then raise exception 'no tenant for caller'; end if;
  if not v_is_active then raise exception 'account is deactivated'; end if;

  select * into v_opp from opportunities where id = p_opp and tenant_id = v_tenant;
  if not found then return jsonb_build_object('error', 'opportunity_not_found'); end if;
  if v_opp.stage in ('won', 'lost') then return jsonb_build_object('error', 'already_closed'); end if;

  -- account: explicit link > existing link > create from company_name.
  v_acct_id := coalesce(p_account_id, v_opp.account_id);
  if v_acct_id is not null then
    select name into v_acct_name from customer_accounts where id = v_acct_id and tenant_id = v_tenant;
    if v_acct_name is null then return jsonb_build_object('error', 'account_not_found'); end if;
  else
    v_acct_name := coalesce(nullif(trim(v_opp.company_name), ''), v_opp.name);
    -- ARR v1: deal amount used as annual contract value verbatim (documented).
    insert into customer_accounts (tenant_id, name, arr_cents, health_score, status, notes)
    values (v_tenant, v_acct_name, coalesce(v_opp.amount_cents, 0), 70, 'active',
            format('Created from won opportunity "%s"', v_opp.name))
    returning id into v_acct_id;
    insert into activity_events (tenant_id, account_id, actor, actor_type, event_type, text)
    values (v_tenant, v_acct_id, 'You', 'human', 'config_change',
            format('Account created from won opportunity — %s', v_acct_name));
  end if;

  -- close it (transaction-local flag lets the guard trigger accept 'won')
  perform set_config('dreamteam.opp_close', 'on', true);
  update opportunities set stage = 'won', account_id = v_acct_id where id = v_opp.id;
  perform set_config('dreamteam.opp_close', '', true);

  perform append_audit_event_internal(
    v_tenant, 'You', 'human',
    format('Won → lifecycle handoff — %s: account "%s"%s', v_opp.name, v_acct_name,
           case when p_create_onboarding then ' + onboarding kickoff' else '' end),
    'config_change',
    jsonb_build_object('kind', 'opportunity_won_handoff', 'opportunity_id', v_opp.id,
                       'account_id', v_acct_id, 'created_account', v_opp.account_id is null and p_account_id is null,
                       'create_onboarding', p_create_onboarding));

  if p_create_onboarding and p_template_version is not null then
    v_proj := create_onboarding_project(v_acct_id, p_template_version, null, null);
    v_proj_id := (v_proj->>'project_id')::uuid;
    if v_proj->>'error' is not null then
      return jsonb_build_object('account_id', v_acct_id, 'onboarding_error', v_proj->>'error');
    end if;
  end if;

  return jsonb_build_object('account_id', v_acct_id, 'project_id', v_proj_id);
end;
$function$;


-- ── compute_account_health ──────────────────────────────────────────
create or replace function public.compute_account_health(p_account uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_tenant uuid;
  v_is_active boolean;
begin
  select tenant_id into v_tenant from customer_accounts where id = p_account;
  if v_tenant is null then
    return jsonb_build_object('error', 'account_not_found');
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    select coalesce(is_active, true) into v_is_active from profiles where user_id = auth.uid() and tenant_id = v_tenant;
    if v_is_active is null or not v_is_active then
      raise exception 'not a member of this tenant';
    end if;
  end if;
  return compute_account_health_core(p_account);
end;
$function$;


-- ── compute_tenant_health ───────────────────────────────────────────
create or replace function public.compute_tenant_health(p_force boolean DEFAULT true)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_tenant uuid;
  v_is_active boolean;
  v_last   timestamptz;
  v_n      integer := 0;
  v_flips  integer := 0;
  v_acct   record;
  v_res    jsonb;
begin
  select tenant_id, coalesce(is_active, true) into v_tenant, v_is_active from profiles where user_id = auth.uid() limit 1;
  if v_tenant is null then
    raise exception 'no tenant for caller';
  end if;
  if not v_is_active then
    raise exception 'account is deactivated';
  end if;

  -- ensure the config row exists (defaults) so freshness can be tracked
  insert into health_score_config (tenant_id) values (v_tenant)
  on conflict (tenant_id) do nothing;

  select last_computed_at into v_last from health_score_config where tenant_id = v_tenant;
  if not p_force and v_last is not null and v_last > now() - interval '1 hour' then
    return jsonb_build_object('computed', 0, 'skipped', true, 'last_computed_at', v_last);
  end if;

  for v_acct in select id from customer_accounts where tenant_id = v_tenant and status <> 'churned' loop
    v_res := compute_account_health_core(v_acct.id);
    v_n := v_n + 1;
    if coalesce((v_res->>'status_changed')::boolean, false) then v_flips := v_flips + 1; end if;
  end loop;

  update health_score_config set last_computed_at = now() where tenant_id = v_tenant;
  return jsonb_build_object('computed', v_n, 'status_flips', v_flips, 'skipped', false);
end;
$function$;


-- ── compute_trust_evidence ──────────────────────────────────────────
create or replace function public.compute_trust_evidence(p_de_id uuid, p_action_category text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
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

  select * into v_policy
  from trust_policies
  where tenant_id = v_tenant
    and action_category = p_action_category
    and (p_de_id is null or de_id is null or de_id = p_de_id)
  limit 1;
  if not found then
    raise exception 'no trust policy for category %', p_action_category;
  end if;

  return trust_evidence_for(v_policy);
end;
$function$;


-- ── count_pending_knowledge_gaps ────────────────────────────────────
create or replace function public.count_pending_knowledge_gaps(p_tenant_id uuid)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_count int;
begin
  if auth.uid() is not null and p_tenant_id not in
     (select tenant_id from profiles where user_id = auth.uid() and coalesce(is_active, true) = true) then
    raise exception 'tenant access denied';
  end if;

  select count(*) into v_count
  from knowledge_revision_requests
  where tenant_id = p_tenant_id
    and status = 'pending_approval';

  return coalesce(v_count, 0);
end;
$function$;


-- ── create_digital_employee ─────────────────────────────────────────
create or replace function public.create_digital_employee(p_name text, p_description text DEFAULT ''::text, p_category text DEFAULT 'Customer'::text, p_department text DEFAULT ''::text, p_persona_name text DEFAULT NULL::text, p_trust_level text DEFAULT 'supervised'::text, p_confidence_threshold integer DEFAULT 75, p_required_approval boolean DEFAULT false)
 returns digital_employees
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_tenant uuid;
  v_role   text;
  v_is_active boolean;
  v_user   uuid := auth.uid();
  v_row    digital_employees;
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
  if p_trust_level not in ('supervised', 'semi_autonomous', 'autonomous') then
    raise exception 'trust_level must be one of: supervised, semi_autonomous, autonomous';
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

  return v_row;
end;
$function$;


-- ── create_onboarding_project ───────────────────────────────────────
create or replace function public.create_onboarding_project(p_account_id uuid, p_version_id uuid, p_name text DEFAULT NULL::text, p_target date DEFAULT NULL::date)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_tenant  uuid;
  v_is_active boolean;
  v_acct    customer_accounts;
  v_ver     onboarding_template_versions;
  v_state   jsonb;
  v_proj_id uuid;
  v_name    text;
begin
  select tenant_id, coalesce(is_active, true) into v_tenant, v_is_active from profiles where user_id = auth.uid() limit 1;
  if v_tenant is null then raise exception 'no tenant for caller'; end if;
  if not v_is_active then raise exception 'account is deactivated'; end if;

  select * into v_acct from customer_accounts where id = p_account_id and tenant_id = v_tenant;
  if not found then return jsonb_build_object('error', 'account_not_found'); end if;

  select * into v_ver from onboarding_template_versions where id = p_version_id and tenant_id = v_tenant;
  if not found then return jsonb_build_object('error', 'template_version_not_found'); end if;

  select jsonb_agg(jsonb_build_object(
    'key', i->>'key', 'status', 'pending', 'assignee', null, 'note', ''))
    into v_state
  from jsonb_array_elements(v_ver.items) i;

  v_name := coalesce(nullif(trim(p_name), ''), format('%s — %s', v_acct.name, v_ver.name));

  insert into onboarding_projects (tenant_id, account_id, template_version_id, name, target_golive, items_state, created_by)
  values (v_tenant, p_account_id, p_version_id, v_name, p_target, coalesce(v_state, '[]'::jsonb), auth.uid())
  returning id into v_proj_id;

  perform append_audit_event_internal(
    v_tenant, 'You', 'human',
    format('Onboarding project created — %s (%s v%s, %s items)', v_name, v_ver.name, v_ver.version, jsonb_array_length(v_ver.items)),
    'config_change',
    jsonb_build_object('kind', 'onboarding_project_create', 'project_id', v_proj_id,
                       'account_id', p_account_id, 'version_id', p_version_id));

  insert into activity_events (tenant_id, account_id, actor, actor_type, event_type, text)
  values (v_tenant, p_account_id, 'You', 'human', 'config_change',
          format('Onboarding started — %s', v_acct.name));

  return jsonb_build_object('project_id', v_proj_id);
end;
$function$;


-- ── get_identity_inventory ──────────────────────────────────────────
create or replace function public.get_identity_inventory(p_tenant_id uuid)
 returns TABLE(subject_kind text, subject_id uuid, subject_name text, subject_label text, subject_role text, subject_status text, connector_id uuid, connector_name text, connector_provider text, connector_category text, connector_status text, connector_last_ok_at timestamp with time zone, connector_last_error_at timestamp with time zone, connector_consecutive_failures integer, has_stored_credential boolean, permission text, permission_via text, trust_current_level integer, trust_target_level integer, autonomy_enabled boolean, possible_actions jsonb)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_caller_tenant uuid;
  v_is_service    boolean := coalesce(auth.role(), '') = 'service_role';
  v_is_active     boolean;
begin
  -- ── EXPLICIT TENANT-MEMBERSHIP CHECK (not a bare parameter trust) ──
  if not v_is_service then
    select tenant_id, coalesce(is_active, true) into v_caller_tenant, v_is_active from profiles where user_id = auth.uid();
    if v_caller_tenant is null then
      raise exception 'not authenticated or no tenant membership';
    end if;
    if not v_is_active then
      raise exception 'account is deactivated';
    end if;
    if v_caller_tenant is distinct from p_tenant_id then
      raise exception 'not a member of this tenant';
    end if;
  end if;
  -- service_role callers pass p_tenant_id straight through (internal/
  -- trusted context only — same posture as resolve_access).

  return query
  with subjects as (
    select 'de'::text as subject_kind, d.id as subject_id, d.name as subject_name,
           coalesce(d.persona_name, d.name) as subject_label,
           coalesce(nullif(d.department, ''), d.category) as subject_role,
           d.status as subject_status
    from digital_employees d
    where d.tenant_id = p_tenant_id
    union all
    select 'specialist'::text, s.id, s.name, s.name, s.key, s.status
    from specialist_profiles s
    where s.tenant_id = p_tenant_id
  ),
  -- Every grant this subject holds, resolved against real connectors
  -- (category grants fan out to every connected system of that
  -- category; connector-specific grants target exactly one).
  grants_resolved as (
    -- category-level grants -> every connector of that category
    select g.subject_kind, g.subject_id, c.id as connector_id, g.permission, 'category'::text as via,
           g.resource_category as eff_category
    from data_access_grants g
    join connectors c on c.tenant_id = g.tenant_id and c.category = g.resource_category
    where g.tenant_id = p_tenant_id and g.resource_kind = 'category'
    union all
    -- connector-specific grants -> that one connector (wins over
    -- category — de-duplicated below by preferring 'connector' rows)
    select g.subject_kind, g.subject_id, g.resource_id as connector_id, g.permission, 'connector'::text as via,
           c.category as eff_category
    from data_access_grants g
    join connectors c on c.id = g.resource_id and c.tenant_id = p_tenant_id
    where g.tenant_id = p_tenant_id and g.resource_kind = 'connector'
  ),
  -- Collapse to one row per subject×connector: connector-specific
  -- beats category (mirrors resolve_access's resolution order).
  grants_final as (
    select distinct on (gr.subject_kind, gr.subject_id, gr.connector_id)
      gr.subject_kind, gr.subject_id, gr.connector_id, gr.permission, gr.via, gr.eff_category
    from grants_resolved gr
    order by gr.subject_kind, gr.subject_id, gr.connector_id,
             (gr.via = 'connector') desc
  ),
  secrets as (
    select cs.connector_id as secret_connector_id, true as has_secret from connector_secrets cs
  ),
  trust as (
    select tp.de_id, tp.source_category, tp.current_level, tp.target_level
    from trust_policies tp
    where tp.tenant_id = p_tenant_id and tp.action_category = 'action_execute'
  ),
  autonomy as (
    select da.source_category, da.enabled
    from de_autonomy da
    where da.tenant_id = p_tenant_id and da.action_type = 'action_execute'
  ),
  actions_by_category as (
    select ad.category,
           jsonb_agg(jsonb_build_object(
             'action_key', ad.action_key, 'label', ad.label,
             'destructive', coalesce((ad.risk->>'destructive')::boolean, true)
           ) order by ad.label) as actions
    from action_definitions ad
    where ad.status = 'active' and (ad.scope = 'platform' or ad.tenant_id = p_tenant_id)
    group by ad.category
  )
  select
    s.subject_kind, s.subject_id, s.subject_name, s.subject_label, s.subject_role, s.subject_status,
    c.id, c.display_name, c.provider, c.category, c.status,
    c.last_ok_at, c.last_error_at, c.consecutive_failures,
    coalesce(sec.has_secret, false),
    gf.permission, gf.via,
    -- trust: prefer a per-DE row scoped to this exact category, else
    -- a per-DE tenant-wide (source_category null) row. Specialists
    -- have no per-subject trust_policies row today (action_execute
    -- trust is DE-scoped) — reported as null, not fabricated.
    coalesce(
      (select tr.current_level from trust tr where tr.de_id = s.subject_id and tr.source_category = c.category),
      (select tr.current_level from trust tr where tr.de_id = s.subject_id and tr.source_category is null and s.subject_kind = 'de')
    ),
    coalesce(
      (select tr.target_level from trust tr where tr.de_id = s.subject_id and tr.source_category = c.category),
      (select tr.target_level from trust tr where tr.de_id = s.subject_id and tr.source_category is null and s.subject_kind = 'de')
    ),
    coalesce(
      (select au.enabled from autonomy au where au.source_category = c.category),
      (select au.enabled from autonomy au where au.source_category is null)
    ),
    coalesce(abc.actions, '[]'::jsonb)
  from subjects s
  left join grants_final gf on gf.subject_kind = s.subject_kind and gf.subject_id = s.subject_id
  left join connectors c on c.id = gf.connector_id
  left join secrets sec on sec.secret_connector_id = c.id
  left join actions_by_category abc on abc.category = c.category
  order by s.subject_kind, s.subject_name, c.category, c.display_name;
end;
$function$;


-- ── hybrid_match_knowledge ──────────────────────────────────────────
create or replace function public.hybrid_match_knowledge(p_tenant_id uuid, p_query_text text, p_account_id uuid DEFAULT NULL::uuid, p_query_embedding vector DEFAULT NULL::vector, p_match_count integer DEFAULT 5, p_subject_kind text DEFAULT NULL::text, p_subject_id uuid DEFAULT NULL::uuid, p_max_distance double precision DEFAULT 0.25)
 returns TABLE(id uuid, doc_id uuid, doc_title text, content text, account_id uuid, visibility text, lexical_rank integer, semantic_rank integer, distance double precision, score double precision)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if auth.uid() is not null and p_tenant_id not in
     (select tenant_id from profiles where user_id = auth.uid() and coalesce(is_active, true) = true) then
    raise exception 'tenant access denied';
  end if;

  return query
  with visible_docs as (
    select d.id, d.title, d.visibility, d.search_tsv
    from knowledge_docs d
    where d.tenant_id = p_tenant_id
      and d.is_current
      and (
        d.visibility = 'tenant'
        or (p_subject_kind is not null and p_subject_id is not null and exists (
              select 1 from knowledge_doc_scopes s
              where s.doc_id = d.id
                and s.subject_kind = p_subject_kind
                and s.subject_id = p_subject_id))
      )
  ),
  lexical as (
    select
      vd.id as doc_id,
      (row_number() over (order by ts_rank(vd.search_tsv, websearch_to_tsquery('english', p_query_text)) desc))::int as lexical_rank
    from visible_docs vd
    where p_query_text is not null
      and length(trim(p_query_text)) > 0
      and vd.search_tsv @@ websearch_to_tsquery('english', p_query_text)
  ),
  semantic as (
    select
      c.id as chunk_id,
      c.doc_id,
      c.content,
      c.account_id,
      (c.embedding <=> p_query_embedding)::float as distance,
      (row_number() over (order by (c.embedding <=> p_query_embedding) asc))::int as semantic_rank
    from knowledge_doc_chunks c
    join visible_docs vd on vd.id = c.doc_id
    where c.tenant_id = p_tenant_id
      and c.embedding is not null
      and p_query_embedding is not null
      and (c.account_id is null or (p_account_id is not null and c.account_id = p_account_id))
      -- Relevance floor: without this, the nearest neighbor is always
      -- returned even for a totally unrelated question when the tenant's
      -- KB is small (confirmed live: a single-doc KB matched "what's the
      -- weather in Tokyo" at distance 0.29 with no cutoff). Paraphrases of
      -- an actually-covered question measured 0.068-0.199 in the same live
      -- test; an unrelated question measured 0.29+. p_max_distance=0.25
      -- sits between those, calibrated from that real gap, not a guess.
      and (c.embedding <=> p_query_embedding) <= p_max_distance
  ),
  -- Every candidate chunk: prefer real chunk rows from `semantic`; for
  -- docs that only matched lexically (no embedded chunk beat the cut,
  -- or no embedding available at all) fall back to the doc's own
  -- content as a single pseudo-chunk so a purely-lexical hit is never
  -- silently dropped from the fused result.
  candidates as (
    select
      s.chunk_id as id, s.doc_id, s.content, s.account_id, s.distance, s.semantic_rank
    from semantic s
    union
    select
      gen_random_uuid() as id, vd.id as doc_id,
      (select d2.content from knowledge_docs d2 where d2.id = vd.id) as content,
      null::uuid as account_id, null::float as distance, null::int as semantic_rank
    from visible_docs vd
    join lexical l on l.doc_id = vd.id
    where not exists (select 1 from semantic s2 where s2.doc_id = vd.id)
  )
  select
    c.id, c.doc_id, vd.title as doc_title, c.content, c.account_id, vd.visibility,
    l.lexical_rank, c.semantic_rank, c.distance,
    (coalesce(1.0 / (60 + l.lexical_rank), 0.0) + coalesce(1.0 / (60 + c.semantic_rank), 0.0))::double precision as score
  from candidates c
  join visible_docs vd on vd.id = c.doc_id
  left join lexical l on l.doc_id = c.doc_id
  where l.lexical_rank is not null or c.semantic_rank is not null
  order by
    (c.account_id is not null and c.account_id = p_account_id) desc, -- account overlay first, same as match_doc_chunks
    score desc
  limit p_match_count;
end;
$function$;


-- ── increment_metric ────────────────────────────────────────────────
create or replace function public.increment_metric(p_metric text, p_delta bigint DEFAULT 1)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant uuid;
  v_is_active boolean;
begin
  select tenant_id, coalesce(is_active, true) into v_tenant, v_is_active from profiles where user_id = auth.uid() limit 1;
  if v_tenant is null then raise exception 'no tenant for caller'; end if;
  if not v_is_active then raise exception 'account is deactivated'; end if;
  insert into usage_metrics (tenant_id, day, metric, value)
    values (v_tenant, current_date, p_metric, p_delta)
    on conflict (tenant_id, day, metric)
    do update set value = usage_metrics.value + excluded.value;
end;
$function$;


-- ── install_starter_onboarding_template ─────────────────────────────
create or replace function public.install_starter_onboarding_template()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_tenant uuid;
  v_is_active boolean;
  v_tpl_id uuid;
  v_pub    jsonb;
  v_items  jsonb := '[
    {"key":"kickoff_call","label":"Kickoff call held","phase":"kickoff","owner_type":"human","requires_signoff":false,"description":"Intro call: goals, timeline, points of contact."},
    {"key":"data_export_received","label":"Data export received from customer","phase":"data","owner_type":"either","requires_signoff":false,"description":"Customer sends their employee/location export (CSV or spreadsheet)."},
    {"key":"employees_imported","label":"Employees imported","phase":"data","owner_type":"de","requires_signoff":false,"description":"Employee records loaded and normalized in the platform."},
    {"key":"locations_configured","label":"Locations configured","phase":"config","owner_type":"de","requires_signoff":false,"description":"Sites, time zones, and operating hours set up."},
    {"key":"settings_review","label":"Account settings reviewed","phase":"config","owner_type":"human","requires_signoff":true,"description":"Human sign-off on core account configuration."},
    {"key":"leave_rules_configured","label":"Leave rules configured","phase":"config","owner_type":"either","requires_signoff":true,"description":"Accrual, carryover, and approval chains — needs human sign-off."},
    {"key":"test_scenario_run","label":"Test scenario run","phase":"validation","owner_type":"de","requires_signoff":false,"description":"End-to-end test with sample data."},
    {"key":"uat_approved","label":"UAT approved by customer","phase":"validation","owner_type":"human","requires_signoff":true,"description":"Customer confirms acceptance testing passed."},
    {"key":"training_session","label":"Training session delivered","phase":"golive","owner_type":"human","requires_signoff":false,"description":"Admin + end-user training completed."},
    {"key":"go_live","label":"Go-live","phase":"golive","owner_type":"human","requires_signoff":true,"description":"Production cutover — final human sign-off."}
  ]'::jsonb;
begin
  select tenant_id, coalesce(is_active, true) into v_tenant, v_is_active from profiles where user_id = auth.uid() limit 1;
  if v_tenant is null then
    raise exception 'no tenant for caller';
  end if;
  if not v_is_active then
    raise exception 'account is deactivated';
  end if;

  select id into v_tpl_id from onboarding_templates
    where tenant_id = v_tenant and name = 'SaaS onboarding — starter' limit 1;
  if v_tpl_id is not null then
    return jsonb_build_object('template_id', v_tpl_id, 'already_installed', true);
  end if;

  insert into onboarding_templates (tenant_id, name, description, items)
  values (v_tenant, 'SaaS onboarding — starter',
          '10-step implementation checklist: kickoff → data → config → validation → go-live. Sign-off gates on settings, leave rules, UAT, and go-live.',
          v_items)
  returning id into v_tpl_id;

  v_pub := publish_onboarding_template(v_tpl_id);
  return jsonb_build_object('template_id', v_tpl_id, 'already_installed', false) || v_pub;
end;
$function$;


-- ── install_technical_specialist ────────────────────────────────────
create or replace function public.install_technical_specialist()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant uuid;
  v_is_active boolean;
  v_id     uuid;
begin
  select tenant_id, coalesce(is_active, true) into v_tenant, v_is_active from profiles where user_id = auth.uid();
  if v_tenant is null then
    if coalesce(auth.role(), '') = 'service_role' then
      raise exception 'service role must use direct inserts with an explicit tenant';
    end if;
    return jsonb_build_object('error', 'no_tenant');
  end if;
  if not v_is_active then
    raise exception 'account is deactivated';
  end if;

  select id into v_id from specialist_profiles
    where tenant_id = v_tenant and key = 'technical';
  if v_id is not null then
    return jsonb_build_object('profile_id', v_id, 'already_installed', true);
  end if;

  insert into specialist_profiles (tenant_id, key, name, charter)
  values (
    v_tenant, 'technical', 'Technical Specialist',
    'You are the Technical Specialist — consulted for API, integration, architecture, and debugging questions that exceed a primary Digital Employee''s depth. Answer ONLY from the configured sources (knowledge documents, connected systems, registered references). Cite every source you use. If the sources do not support an answer, say so plainly and escalate — never guess. Escalate to a human whenever confidence falls below the floor.'
  )
  returning id into v_id;

  perform append_audit_event(
    v_tenant, 'You', 'human',
    'Technical Specialist installed — charter seeded, sources not yet configured',
    'config_change',
    jsonb_build_object('kind', 'specialist_profile', 'profile_id', v_id, 'key', 'technical')
  );

  return jsonb_build_object('profile_id', v_id, 'already_installed', false);
end;
$function$;


-- ── match_cached_answer ─────────────────────────────────────────────
create or replace function public.match_cached_answer(p_tenant_id uuid, p_account_id uuid, p_query_embedding vector, p_max_distance double precision DEFAULT 0.15)
 returns TABLE(id uuid, answer text, confidence integer, sources jsonb, distance double precision)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if auth.uid() is not null and p_tenant_id not in
     (select tenant_id from profiles where user_id = auth.uid() and coalesce(is_active, true) = true) then
    raise exception 'tenant access denied';
  end if;
  return query
  select a.id, a.answer, a.confidence, a.sources,
         (a.question_embedding <=> p_query_embedding)::float as distance
  from answer_cache a
  where a.tenant_id = p_tenant_id
    and a.invalidated = false
    and a.question_embedding is not null
    and (a.account_id is null or (p_account_id is not null and a.account_id = p_account_id))
    and (a.question_embedding <=> p_query_embedding) < p_max_distance
  order by
    (a.account_id is not null and a.account_id = p_account_id) desc,
    a.question_embedding <=> p_query_embedding
  limit 1;
end;
$function$;


-- ── match_doc_chunks ────────────────────────────────────────────────
create or replace function public.match_doc_chunks(p_tenant_id uuid, p_account_id uuid, p_query_embedding vector, p_match_count integer DEFAULT 5, p_subject_kind text DEFAULT NULL::text, p_subject_id uuid DEFAULT NULL::uuid)
 returns TABLE(id uuid, doc_id uuid, content text, account_id uuid, distance double precision, visibility text)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if auth.uid() is not null and p_tenant_id not in
     (select tenant_id from profiles where user_id = auth.uid() and coalesce(is_active, true) = true) then
    raise exception 'tenant access denied';
  end if;
  return query
  select c.id, c.doc_id, c.content, c.account_id,
         (c.embedding <=> p_query_embedding)::float as distance,
         d.visibility
  from knowledge_doc_chunks c
  join knowledge_docs d on d.id = c.doc_id
  where c.tenant_id = p_tenant_id
    and c.embedding is not null
    and d.is_current
    and (c.account_id is null or (p_account_id is not null and c.account_id = p_account_id))
    and (
      d.visibility = 'tenant'
      or (p_subject_kind is not null and p_subject_id is not null and exists (
            select 1 from knowledge_doc_scopes s
            where s.doc_id = d.id
              and s.subject_kind = p_subject_kind
              and s.subject_id = p_subject_id))
    )
  order by
    (c.account_id is not null and c.account_id = p_account_id) desc, -- account overlay first
    c.embedding <=> p_query_embedding
  limit p_match_count;
end;
$function$;


-- ── publish_adapter_template ────────────────────────────────────────
create or replace function public.publish_adapter_template(p_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if coalesce(auth.role(), '') <> 'service_role' and not exists (
    select 1 from adapter_templates t
    join profiles p on p.tenant_id = t.tenant_id
    where t.id = p_id and t.scope = 'tenant' and p.user_id = auth.uid() and coalesce(p.is_active, true) = true
  ) then
    raise exception 'not a member of this template''s workspace';
  end if;
  update adapter_templates set status = 'published' where id = p_id;
end;
$function$;


-- ── publish_onboarding_template ─────────────────────────────────────
create or replace function public.publish_onboarding_template(p_template_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_tpl     onboarding_templates;
  v_errors  text[];
  v_version integer;
  v_vid     uuid;
begin
  select * into v_tpl from onboarding_templates where id = p_template_id;
  if not found then
    return jsonb_build_object('error', 'template_not_found');
  end if;
  if not exists (
    select 1 from profiles where user_id = auth.uid() and tenant_id = v_tpl.tenant_id and coalesce(is_active, true) = true
  ) then
    raise exception 'not a member of this tenant';
  end if;

  v_errors := validate_onboarding_items(v_tpl.items);
  if array_length(v_errors, 1) is not null then
    return jsonb_build_object('errors', to_jsonb(v_errors));
  end if;

  v_version := v_tpl.version + 1;
  insert into onboarding_template_versions (template_id, tenant_id, version, name, description, items, published_by)
  values (v_tpl.id, v_tpl.tenant_id, v_version, v_tpl.name, v_tpl.description, v_tpl.items, auth.uid())
  returning id into v_vid;

  update onboarding_templates
    set version = v_version, status = 'published'
    where id = v_tpl.id;

  perform append_audit_event_internal(
    v_tpl.tenant_id, 'You', 'human',
    format('Onboarding template published — %s v%s (%s items)', v_tpl.name, v_version, jsonb_array_length(v_tpl.items)),
    'config_change',
    jsonb_build_object('kind', 'onboarding_template_publish', 'template_id', v_tpl.id,
                       'version_id', v_vid, 'version', v_version,
                       'item_count', jsonb_array_length(v_tpl.items)));

  return jsonb_build_object('version_id', v_vid, 'version', v_version);
end;
$function$;


-- ── purge_connector_secret ──────────────────────────────────────────
create or replace function public.purge_connector_secret(p_connector_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if coalesce(auth.role(), '') <> 'service_role' and not exists (
    select 1
    from connectors c
    join profiles p on p.tenant_id = c.tenant_id
    where c.id = p_connector_id and p.user_id = auth.uid() and coalesce(p.is_active, true) = true
  ) then
    raise exception 'not a member of this connector''s tenant';
  end if;

  delete from connector_secrets where connector_id = p_connector_id;
end;
$function$;


-- ── reject_knowledge_revision ───────────────────────────────────────
create or replace function public.reject_knowledge_revision(p_request_id uuid, p_reason text DEFAULT ''::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_user          uuid := auth.uid();
  v_caller_tenant uuid;
  v_is_active     boolean;
  v_req           record;
  v_actor_name    text;
begin
  select * into v_req from knowledge_revision_requests where id = p_request_id;
  if v_req.id is null then
    return jsonb_build_object('ok', false, 'error', 'request_not_found');
  end if;
  if v_req.status <> 'pending_approval' then
    return jsonb_build_object('ok', false, 'error', 'not_pending', 'status', v_req.status);
  end if;

  if v_user is not null then
    select tenant_id, coalesce(is_active, true) into v_caller_tenant, v_is_active from profiles where user_id = v_user;
    if v_caller_tenant is null or v_caller_tenant <> v_req.tenant_id then
      return jsonb_build_object('ok', false, 'error', 'not_tenant_member');
    end if;
    if not v_is_active then
      return jsonb_build_object('ok', false, 'error', 'not_tenant_member');
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    return jsonb_build_object('ok', false, 'error', 'not_tenant_member');
  end if;

  select coalesce(full_name, 'A reviewer') into v_actor_name from profiles where user_id = v_user;
  v_actor_name := coalesce(v_actor_name, 'A reviewer');

  update knowledge_revision_requests
    set status = 'rejected', decided_by = v_user, decided_at = now()
    where id = p_request_id;

  perform append_audit_event(
    v_req.tenant_id, v_actor_name, case when v_user is null then 'system' else 'human' end,
    v_actor_name || ' rejected a proposed knowledge revision — "' || v_req.proposed_title || '"'
      || case when coalesce(p_reason, '') <> '' then ' (' || p_reason || ')' else '' end,
    'knowledge_revision',
    jsonb_build_object('kind', 'knowledge_revision_rejected', 'revision_request_id', p_request_id, 'reason', coalesce(p_reason, ''))
  );

  return jsonb_build_object('ok', true);
end;
$function$;


-- ── request_subtenant ───────────────────────────────────────────────
create or replace function public.request_subtenant(p_parent_tenant_id uuid, p_name text, p_industry text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_user       uuid := auth.uid();
  v_role       text;
  v_caller_tenant uuid;
  v_is_active  boolean;
  v_parent     tenants;
  v_is_platform boolean := is_platform_admin();
  v_slug       text;
  v_base_slug  text;
  v_suffix     int := 0;
  v_tenant     tenants;
  v_request_id uuid;
  v_demo_tenant_id constant uuid := 'a0000000-0000-0000-0000-000000000001';
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  if coalesce(btrim(p_name), '') = '' then
    raise exception 'proposed tenant name is required';
  end if;

  if p_parent_tenant_id is null then
    -- Only platform admins may create a fresh top-level tenant this way.
    if not v_is_platform then
      raise exception 'only a platform admin may create a new top-level tenant';
    end if;
  else
    if p_parent_tenant_id = v_demo_tenant_id then
      raise exception 'the demo tenant cannot be used as a parent tenant';
    end if;

    select * into v_parent from tenants where id = p_parent_tenant_id;
    if not found then
      raise exception 'parent tenant not found';
    end if;

    select role, tenant_id, coalesce(is_active, true) into v_role, v_caller_tenant, v_is_active from profiles where user_id = v_user;

    if not v_is_platform then
      if v_caller_tenant is distinct from p_parent_tenant_id or v_role not in ('tenant_owner', 'tenant_admin') then
        raise exception 'only an owner or admin of the parent tenant may request a sub-tenant';
      end if;
      if not v_is_active then
        raise exception 'account is deactivated';
      end if;
    end if;
  end if;

  if v_is_platform or (p_parent_tenant_id is not null and v_parent.allow_self_serve_subtenants) then
    v_base_slug := lower(regexp_replace(btrim(p_name), '[^a-zA-Z0-9]+', '-', 'g'));
    v_base_slug := trim(both '-' from v_base_slug);
    if coalesce(v_base_slug, '') = '' then
      v_base_slug := 'org';
    end if;
    v_slug := v_base_slug;
    while exists (select 1 from tenants where slug = v_slug) loop
      v_suffix := v_suffix + 1;
      v_slug := v_base_slug || '-' || v_suffix::text;
    end loop;

    insert into tenants (name, slug, industry, plan, status, settings, parent_tenant_id)
    values (btrim(p_name), v_slug, nullif(btrim(coalesce(p_industry, '')), ''), 'starter', 'trial', '{}'::jsonb, p_parent_tenant_id)
    returning * into v_tenant;

    insert into tenant_provisioning_requests
      (requested_by_user_id, proposed_parent_tenant_id, proposed_name, proposed_industry, status, reviewed_by, decided_at, created_tenant_id)
    values
      (v_user, p_parent_tenant_id, btrim(p_name), p_industry, 'approved', v_user, now(), v_tenant.id)
    returning id into v_request_id;

    -- Audit under the PARENT tenant's own trail, but ONLY when the caller
    -- is a genuine member of it -- append_audit_event's guard requires
    -- service_role or tenant membership, and a platform admin taking this
    -- same immediate-creation branch is typically NOT a member of the
    -- parent (or of the brand-new child, which never has the caller as a
    -- member either). When there's no parent (fresh top-level tenant) or
    -- the caller has no membership there (platform admin path), the
    -- tenant_provisioning_requests row itself (status/reviewed_by/decided_at)
    -- is the durable record, matching how platform-only actions elsewhere
    -- in this codebase (e.g. platform_config_set, migration 038) are
    -- recorded without a tenant-scoped audit event.
    if p_parent_tenant_id is not null and exists (
      select 1 from profiles where user_id = v_user and tenant_id = p_parent_tenant_id
    ) then
      perform append_audit_event(
        p_parent_tenant_id, coalesce((select full_name from profiles where user_id = v_user), 'owner'), 'human',
        format('Sub-tenant "%s" self-serve created (new tenant id %s)', v_tenant.name, v_tenant.id),
        'config_change',
        jsonb_build_object('kind', 'tenant_provisioned_self_serve', 'tenant_id', v_tenant.id,
          'parent_tenant_id', p_parent_tenant_id, 'request_id', v_request_id, 'user_id', v_user)
      );
    end if;

    return jsonb_build_object('ok', true, 'path', 'self_serve', 'tenant_id', v_tenant.id, 'slug', v_tenant.slug, 'request_id', v_request_id);
  end if;

  -- Approval-required path: platform reviews, not the parent tenant.
  insert into tenant_provisioning_requests
    (requested_by_user_id, proposed_parent_tenant_id, proposed_name, proposed_industry, status)
  values
    (v_user, p_parent_tenant_id, btrim(p_name), p_industry, 'pending')
  returning id into v_request_id;

  -- Same membership consideration as above: only audit under the parent
  -- tenant's trail when there is one and the caller is a member of it. In
  -- practice this branch is only reached when the caller was already
  -- verified above to be owner/admin of p_parent_tenant_id, but the
  -- explicit re-check costs nothing and keeps this call safe against
  -- future edits to the branch above it.
  if p_parent_tenant_id is not null and exists (
    select 1 from profiles where user_id = v_user and tenant_id = p_parent_tenant_id
  ) then
    perform append_audit_event(
      p_parent_tenant_id, coalesce((select full_name from profiles where user_id = v_user), 'requester'), 'human',
      format('Sub-tenant creation requested — "%s" — routed to platform for approval', btrim(p_name)),
      'config_change',
      jsonb_build_object('kind', 'tenant_provisioning_requested', 'request_id', v_request_id,
        'proposed_parent_tenant_id', p_parent_tenant_id, 'proposed_name', btrim(p_name), 'user_id', v_user)
    );
  end if;

  return jsonb_build_object('ok', true, 'path', 'pending_platform_approval', 'request_id', v_request_id);
end;
$function$;


-- ── resolve_action_execution_for_task ───────────────────────────────
create or replace function public.resolve_action_execution_for_task(p_task_id uuid)
 returns action_executions
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE
  v_task_tenant uuid;
  v_row action_executions;
BEGIN
  SELECT tenant_id INTO v_task_tenant FROM human_tasks WHERE id = p_task_id;
  IF v_task_tenant IS NULL THEN
    RETURN NULL;
  END IF;
  IF auth.uid() IS NOT NULL AND v_task_tenant NOT IN (SELECT tenant_id FROM profiles WHERE user_id = auth.uid() AND coalesce(is_active, true) = true) AND NOT is_platform_admin() THEN
    RAISE EXCEPTION 'tenant access denied';
  END IF;
  SELECT ae.* INTO v_row FROM action_executions ae
    WHERE ae.task_id = p_task_id AND ae.tenant_id = v_task_tenant
    ORDER BY ae.created_at DESC LIMIT 1;
  RETURN v_row;
END;
$function$;


-- ── resolve_onboarding_signoff ──────────────────────────────────────
create or replace function public.resolve_onboarding_signoff(p_task_id uuid, p_decision text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_task      human_tasks;
  v_proj      onboarding_projects;
  v_ver       onboarding_template_versions;
  v_def       jsonb;
  v_item      jsonb;
  v_idx       integer := -1;
  v_i         integer := 0;
  v_key       text;
  v_completed boolean := false;
begin
  if p_decision not in ('approved', 'rejected') then
    return jsonb_build_object('error', 'invalid_decision');
  end if;

  select * into v_task from human_tasks where id = p_task_id;
  if not found or v_task.related_table <> 'onboarding_projects' or v_task.related_id is null then
    return jsonb_build_object('error', 'not_an_onboarding_task');
  end if;
  if not exists (
    select 1 from profiles where user_id = auth.uid() and tenant_id = v_task.tenant_id and coalesce(is_active, true) = true
  ) then
    raise exception 'not a member of this tenant';
  end if;

  select * into v_proj from onboarding_projects where id = v_task.related_id::uuid;
  if not found then return jsonb_build_object('error', 'project_not_found'); end if;

  for v_item in select * from jsonb_array_elements(v_proj.items_state) loop
    if v_item->>'signoff_task_id' = p_task_id::text then v_idx := v_i; exit; end if;
    v_i := v_i + 1;
  end loop;
  if v_idx < 0 then return jsonb_build_object('error', 'item_for_task_not_found'); end if;
  v_key := v_item->>'key';

  if v_item->>'status' = 'signed_off' then
    return jsonb_build_object('error', 'already_signed_off');
  end if;

  select * into v_ver from onboarding_template_versions where id = v_proj.template_version_id;
  select d into v_def from jsonb_array_elements(v_ver.items) d where d->>'key' = v_key limit 1;

  if p_decision = 'approved' then
    v_item := v_item || jsonb_build_object('status', 'signed_off', 'signed_off_by', auth.uid(), 'signed_off_at', now());
  else
    v_item := v_item || jsonb_build_object('status', 'in_progress',
      'note', trim(coalesce(v_item->>'note', '') || ' · Sign-off rejected — rework needed.', ' ·'),
      'signoff_task_id', null);
  end if;

  update onboarding_projects
    set items_state = jsonb_set(items_state, array[v_idx::text], v_item)
    where id = v_proj.id;

  perform append_audit_event_internal(
    v_task.tenant_id, 'You', 'human',
    format('Onboarding sign-off %s — %s (%s)', p_decision, coalesce(v_def->>'label', v_key), v_proj.name),
    'approval',
    jsonb_build_object('kind', 'onboarding_signoff', 'project_id', v_proj.id,
                       'item_key', v_key, 'task_id', p_task_id, 'decision', p_decision));

  if p_decision = 'approved' then
    v_completed := onboarding_check_complete(v_proj.id);
  end if;

  return jsonb_build_object('project_id', v_proj.id, 'item_key', v_key,
                            'decision', p_decision, 'completed', v_completed);
end;
$function$;


-- ── resume_playbook_on_task ─────────────────────────────────────────
create or replace function public.resume_playbook_on_task(p_task_id uuid, p_decision text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_run     playbook_runs;
  v_steps   jsonb;
  v_acct    text;
  v_inv     record;
  v_now     text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  i         integer;
  v_step    jsonb;
  v_key     text;
  v_params  jsonb;
  v_ctx     jsonb;
  v_text    text;
  v_tbl     text;
  v_set     text;
  v_detail  text;
  v_gate_key text;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected';
  end if;

  select * into v_run
  from playbook_runs
  where waiting_task_id = p_task_id
    and status = 'waiting_approval'
  limit 1;

  if not found then
    return jsonb_build_object('resumed', false, 'reason', 'no_waiting_run');
  end if;

  if coalesce(auth.role(), '') <> 'service_role' and not exists (
    select 1 from profiles where user_id = auth.uid() and tenant_id = v_run.tenant_id and coalesce(is_active, true) = true
  ) then
    raise exception 'not a member of this tenant';
  end if;

  v_steps := v_run.steps;
  v_ctx   := coalesce(v_run.context, '{}'::jsonb);
  v_acct  := coalesce(nullif(v_ctx->>'account_name', ''),
             coalesce(nullif(split_part(v_steps->0->>'detail', ' · ', 1), ''), 'account'));

  -- ══════════════════════════════════════════════════════════
  -- LEGACY PATH: renewal_v1 (no definition) — unchanged behavior
  -- ══════════════════════════════════════════════════════════
  if v_run.definition_id is null then
    if p_decision = 'rejected' then
      v_steps := jsonb_set(v_steps, '{3,status}', '"cancelled"');
      v_steps := jsonb_set(v_steps, '{3,at}', to_jsonb(v_now));
      v_steps := jsonb_set(v_steps, '{3,detail}', '"Rejected by human reviewer"');
      for i in 4 .. jsonb_array_length(v_steps) - 1 loop
        if v_steps->i->>'status' = 'pending' then
          v_steps := jsonb_set(v_steps, array[i::text, 'status'], '"cancelled"');
        end if;
      end loop;
      update playbook_runs
        set status = 'cancelled', current_step = 3, steps = v_steps, waiting_task_id = null
        where id = v_run.id;
      perform append_audit_event(
        v_run.tenant_id, 'Renewal DE', 'de',
        format('Renewal playbook [%s] — run cancelled (approval rejected)', v_acct),
        'playbook_step',
        jsonb_build_object('run_id', v_run.id, 'task_id', p_task_id, 'resumed_by', 'resume_playbook_on_task')
      );
      return jsonb_build_object('resumed', true, 'run_id', v_run.id, 'status', 'cancelled');
    end if;

    v_steps := jsonb_set(v_steps, '{3,status}', '"done"');
    v_steps := jsonb_set(v_steps, '{3,at}', to_jsonb(v_now));
    v_steps := jsonb_set(v_steps, '{3,detail}', '"Approved by human reviewer"');
    perform append_audit_event(
      v_run.tenant_id, 'Renewal DE', 'de',
      format('Renewal playbook [%s] — step "Human approval" done: Approved by human reviewer', v_acct),
      'playbook_step',
      jsonb_build_object('run_id', v_run.id, 'step_key', 'human_approval', 'step_status', 'done', 'task_id', p_task_id)
    );

    select id, amount_cents into v_inv
    from renewal_invoices
    where tenant_id = v_run.tenant_id and account_id = v_run.account_id
    order by created_at desc
    limit 1;

    if v_inv.id is not null then
      update renewal_invoices set status = 'sent', cadence_stage = 1 where id = v_inv.id;
      v_steps := jsonb_set(v_steps, '{4,status}', '"done"');
      v_steps := jsonb_set(v_steps, '{4,at}', to_jsonb(v_now));
      v_steps := jsonb_set(v_steps, '{4,detail}',
        to_jsonb(format('Invoice $%s sent · cadence Day-0 started', to_char(round(v_inv.amount_cents / 100.0), 'FM999,999,999'))));
      perform append_audit_event(
        v_run.tenant_id, 'Renewal DE', 'de',
        format('Renewal playbook [%s] — step "Send invoice" done: %s', v_acct, v_steps->4->>'detail'),
        'playbook_step',
        jsonb_build_object('run_id', v_run.id, 'step_key', 'mark_sent', 'step_status', 'done', 'invoice_id', v_inv.id)
      );
      insert into activity_events (tenant_id, actor, actor_type, event_type, text)
      values (v_run.tenant_id, 'Renewal DE', 'de', 'resolved',
        format('Renewal playbook sent invoice — %s ($%s), dunning cadence started',
          v_acct, to_char(round(v_inv.amount_cents / 100.0), 'FM999,999,999')));
    else
      v_steps := jsonb_set(v_steps, '{4,status}', '"skipped"');
      v_steps := jsonb_set(v_steps, '{4,at}', to_jsonb(v_now));
      v_steps := jsonb_set(v_steps, '{4,detail}', '"Invoice not found for cadence update"');
    end if;

    v_steps := jsonb_set(v_steps, '{5,status}', '"done"');
    v_steps := jsonb_set(v_steps, '{5,at}', to_jsonb(v_now));
    v_steps := jsonb_set(v_steps, '{5,detail}', '"Run completed"');

    update playbook_runs
      set status = 'completed', current_step = 5, steps = v_steps, waiting_task_id = null
      where id = v_run.id;

    perform append_audit_event(
      v_run.tenant_id, 'Renewal DE', 'de',
      format('Renewal playbook [%s] — run completed end-to-end', v_acct),
      'playbook_step',
      jsonb_build_object('run_id', v_run.id, 'invoice_id', v_inv.id, 'amount_cents', v_inv.amount_cents, 'resumed_by', 'resume_playbook_on_task')
    );

    return jsonb_build_object('resumed', true, 'run_id', v_run.id, 'status', 'completed');
  end if;

  -- ══════════════════════════════════════════════════════════
  -- DEFINITION PATH: SQL advances guardrail_check / update_record /
  -- log_activity / complete natively. ANY other step (connector_action,
  -- instruction, decision, checklist, wait, sub_playbook, consult) parks
  -- the run in 'resume_pending' — the HTTP executor finishes it.
  -- ══════════════════════════════════════════════════════════
  i := v_run.current_step;  -- index of the gate step (human_approval or checklist)
  v_gate_key := coalesce(v_steps->i->>'key', 'human_approval');

  if p_decision = 'rejected' then
    v_steps := jsonb_set(v_steps, array[i::text, 'status'], '"cancelled"');
    v_steps := jsonb_set(v_steps, array[i::text, 'at'], to_jsonb(v_now));
    v_steps := jsonb_set(v_steps, array[i::text, 'detail'],
      (case when v_gate_key = 'checklist' then '"Checklist rejected by human reviewer"' else '"Rejected by human reviewer"' end)::jsonb);
    for i in v_run.current_step + 1 .. jsonb_array_length(v_steps) - 1 loop
      if v_steps->i->>'status' = 'pending' then
        v_steps := jsonb_set(v_steps, array[i::text, 'status'], '"cancelled"');
      end if;
    end loop;
    update playbook_runs
      set status = 'cancelled', steps = v_steps, waiting_task_id = null
      where id = v_run.id;
    perform append_audit_event(
      v_run.tenant_id, 'Playbook DE', 'de',
      format('Playbook [%s] — run cancelled (%s rejected)', v_acct,
        case when v_gate_key = 'checklist' then 'checklist' else 'approval' end),
      'playbook_step',
      jsonb_build_object('run_id', v_run.id, 'task_id', p_task_id, 'definition_id', v_run.definition_id, 'resumed_by', 'resume_playbook_on_task')
    );
    return jsonb_build_object('resumed', true, 'run_id', v_run.id, 'status', 'cancelled');
  end if;

  -- Approved: gate step done. If the gate approved an invoice, send it.
  v_steps := jsonb_set(v_steps, array[i::text, 'status'], '"done"');
  v_steps := jsonb_set(v_steps, array[i::text, 'at'], to_jsonb(v_now));
  v_steps := jsonb_set(v_steps, array[i::text, 'detail'],
    (case when v_gate_key = 'checklist' then '"Checklist completed — all items confirmed by a human"' else '"Approved by human reviewer"' end)::jsonb);
  perform append_audit_event(
    v_run.tenant_id, 'Playbook DE', 'de',
    format('Playbook [%s] — step "%s" done: %s', v_acct,
      case when v_gate_key = 'checklist' then 'Checklist' else 'Human approval' end,
      case when v_gate_key = 'checklist' then 'all items confirmed' else 'approved' end),
    'playbook_step',
    jsonb_build_object('run_id', v_run.id, 'step_key', v_gate_key, 'step_status', 'done', 'task_id', p_task_id, 'definition_id', v_run.definition_id)
  );
  if v_gate_key = 'human_approval' and (v_ctx->>'invoice_id') is not null then
    update renewal_invoices set status = 'sent', cadence_stage = 1
      where id = (v_ctx->>'invoice_id')::uuid and status = 'awaiting_approval';
  end if;

  -- Walk the remaining steps.
  i := v_run.current_step + 1;
  while i <= jsonb_array_length(v_steps) - 1 loop
    v_step   := v_steps->i;
    v_key    := v_step->>'key';
    v_params := coalesce(v_step->'params', '{}'::jsonb);

    if v_key = 'guardrail_check' then
      v_detail := format('Re-checked invoice threshold post-approval — amount $%s (approved by human)',
        to_char(round(coalesce((v_ctx->>'invoice_amount_cents')::bigint, 0) / 100.0), 'FM999,999,999'));
      v_steps := jsonb_set(v_steps, array[i::text, 'status'], '"done"');
      v_steps := jsonb_set(v_steps, array[i::text, 'at'], to_jsonb(v_now));
      v_steps := jsonb_set(v_steps, array[i::text, 'detail'], to_jsonb(v_detail));
      perform append_audit_event(
        v_run.tenant_id, 'Playbook DE', 'de',
        format('Playbook [%s] — step "Guardrail check" done: %s', v_acct, v_detail),
        'guardrail_check',
        jsonb_build_object('run_id', v_run.id, 'step_index', i, 'definition_id', v_run.definition_id, 'result', 'passed_post_approval')
      );

    elsif v_key = 'update_record' then
      v_tbl := v_params->>'table';
      v_set := v_params#>>'{set,status}';
      v_detail := null;
      if v_tbl = 'renewal_invoices' and v_set in ('sent', 'paid') and (v_ctx->>'invoice_id') is not null then
        update renewal_invoices set status = v_set where id = (v_ctx->>'invoice_id')::uuid;
        v_detail := format('renewal_invoices.status → %s', v_set);
      elsif v_tbl = 'support_tickets' and v_set in ('open', 'pending', 'resolved', 'escalated') and (v_ctx->>'ticket_id') is not null then
        update support_tickets set status = v_set where id = (v_ctx->>'ticket_id')::uuid and tenant_id = v_run.tenant_id;
        v_detail := format('support_tickets.status → %s', v_set);
      end if;
      if v_detail is null then
        v_steps := jsonb_set(v_steps, array[i::text, 'status'], '"skipped"');
        v_steps := jsonb_set(v_steps, array[i::text, 'detail'], '"skipped: no target record in run context"');
      else
        v_steps := jsonb_set(v_steps, array[i::text, 'status'], '"done"');
        v_steps := jsonb_set(v_steps, array[i::text, 'detail'], to_jsonb(v_detail));
      end if;
      v_steps := jsonb_set(v_steps, array[i::text, 'at'], to_jsonb(v_now));
      perform append_audit_event(
        v_run.tenant_id, 'Playbook DE', 'de',
        format('Playbook [%s] — step "Update record" %s', v_acct, coalesce(v_detail, 'skipped: no target record')),
        'playbook_step',
        jsonb_build_object('run_id', v_run.id, 'step_index', i, 'definition_id', v_run.definition_id)
      );

    elsif v_key = 'log_activity' then
      v_text := coalesce(v_params->>'text_template', 'Playbook step executed');
      v_text := replace(v_text, '{{account.name}}', coalesce(v_ctx->>'account_name', 'account'));
      v_text := replace(v_text, '{{invoice.amount}}',
        '$' || to_char(round(coalesce((v_ctx->>'invoice_amount_cents')::bigint, 0) / 100.0), 'FM999,999,999'));
      v_text := replace(v_text, '{{run.id}}', v_run.id::text);
      insert into activity_events (tenant_id, actor, actor_type, event_type, text)
      values (v_run.tenant_id, 'Playbook DE', 'de', 'resolved', v_text);
      v_steps := jsonb_set(v_steps, array[i::text, 'status'], '"done"');
      v_steps := jsonb_set(v_steps, array[i::text, 'at'], to_jsonb(v_now));
      v_steps := jsonb_set(v_steps, array[i::text, 'detail'], to_jsonb(v_text));
      perform append_audit_event(
        v_run.tenant_id, 'Playbook DE', 'de',
        format('Playbook [%s] — step "Log activity" done: %s', v_acct, v_text),
        'playbook_step',
        jsonb_build_object('run_id', v_run.id, 'step_index', i, 'definition_id', v_run.definition_id)
      );

    elsif v_key = 'complete' then
      v_steps := jsonb_set(v_steps, array[i::text, 'status'], '"done"');
      v_steps := jsonb_set(v_steps, array[i::text, 'at'], to_jsonb(v_now));
      v_steps := jsonb_set(v_steps, array[i::text, 'detail'], '"Run completed"');
      update playbook_runs
        set status = 'completed', current_step = i, steps = v_steps, waiting_task_id = null, context = v_ctx
        where id = v_run.id;
      perform append_audit_event(
        v_run.tenant_id, 'Playbook DE', 'de',
        format('Playbook [%s] — run completed end-to-end', v_acct),
        'playbook_step',
        jsonb_build_object('run_id', v_run.id, 'definition_id', v_run.definition_id, 'resumed_by', 'resume_playbook_on_task')
      );
      return jsonb_build_object('resumed', true, 'run_id', v_run.id, 'status', 'completed');

    else
      -- Needs the HTTP executor (connector_action, instruction, decision,
      -- checklist, wait, sub_playbook, consult_specialist, …) — park the
      -- run; the edge function's 'advance' action finishes it.
      update playbook_runs
        set status = 'resume_pending', current_step = i, steps = v_steps, waiting_task_id = null, context = v_ctx
        where id = v_run.id;
      perform append_audit_event(
        v_run.tenant_id, 'Playbook DE', 'de',
        format('Playbook [%s] — approved; parked at "%s" step for HTTP advance', v_acct, v_key),
        'playbook_step',
        jsonb_build_object('run_id', v_run.id, 'step_index', i, 'step_key', v_key, 'definition_id', v_run.definition_id, 'resumed_by', 'resume_playbook_on_task')
      );
      return jsonb_build_object('resumed', true, 'run_id', v_run.id, 'status', 'resume_pending', 'needs_http', true);
    end if;

    i := i + 1;
  end loop;

  -- No explicit complete step (validation requires one, but be safe).
  update playbook_runs
    set status = 'completed', current_step = jsonb_array_length(v_steps) - 1, steps = v_steps, waiting_task_id = null, context = v_ctx
    where id = v_run.id;
  return jsonb_build_object('resumed', true, 'run_id', v_run.id, 'status', 'completed');
end;
$function$;


-- ── revoke_access_grant ─────────────────────────────────────────────
create or replace function public.revoke_access_grant(p_subject_kind text, p_subject_id uuid, p_resource_kind text, p_resource_id uuid, p_resource_category text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant uuid;
  v_user   uuid := auth.uid();
  v_role   text;
  v_is_active boolean;
  v_before text;
  v_subject_label text;
  v_resource_label text;
begin
  if v_user is not null then
    select tenant_id, role, coalesce(is_active, true) into v_tenant, v_role, v_is_active from profiles where user_id = v_user;
    if v_tenant is null then
      return jsonb_build_object('ok', false, 'error', 'no_tenant');
    end if;
    if not v_is_active then
      return jsonb_build_object('ok', false, 'error', 'admin_role_required');
    end if;
    if v_role not in ('tenant_owner', 'tenant_admin') then
      return jsonb_build_object('ok', false, 'error', 'admin_role_required');
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    return jsonb_build_object('ok', false, 'error', 'admin_role_required');
  else
    if p_subject_kind = 'de' then
      select tenant_id into v_tenant from digital_employees where id = p_subject_id;
    else
      select tenant_id into v_tenant from specialist_profiles where id = p_subject_id;
    end if;
    if v_tenant is null then
      return jsonb_build_object('ok', false, 'error', 'subject_not_found');
    end if;
  end if;

  if p_subject_kind = 'de' then
    select name into v_subject_label from digital_employees where id = p_subject_id and tenant_id = v_tenant;
  else
    select name into v_subject_label from specialist_profiles where id = p_subject_id and tenant_id = v_tenant;
  end if;
  v_resource_label := case when p_resource_kind = 'connector'
    then coalesce((select display_name from connectors where id = p_resource_id and tenant_id = v_tenant), 'connector')
    else 'all ' || p_resource_category || ' systems' end;

  delete from data_access_grants
   where tenant_id = v_tenant and subject_kind = p_subject_kind and subject_id = p_subject_id
     and resource_kind = p_resource_kind
     and coalesce(resource_id::text, resource_category) = coalesce(p_resource_id::text, p_resource_category)
  returning permission into v_before;

  if v_before is null then
    return jsonb_build_object('ok', true, 'removed', false, 'note', 'no grant existed — already default-deny');
  end if;

  perform append_audit_event(
    v_tenant,
    coalesce((select full_name from profiles where user_id = v_user), 'service'),
    case when v_user is null then 'system' else 'human' end,
    'Data access grant REVOKED — ' || coalesce(v_subject_label, 'subject') || ' on ' || v_resource_label
      || ': ' || v_before || ' → none (default-deny)',
    'access_control',
    jsonb_build_object('kind', 'access_grant_changed',
      'subject_kind', p_subject_kind, 'subject_id', p_subject_id, 'subject_label', v_subject_label,
      'resource_kind', p_resource_kind, 'resource_id', p_resource_id,
      'resource_category', p_resource_category, 'resource_label', v_resource_label,
      'before', v_before, 'after', null)
  );

  return jsonb_build_object('ok', true, 'removed', true, 'before', v_before);
end;
$function$;


-- ── save_adapter_template ───────────────────────────────────────────
create or replace function public.save_adapter_template(p_name text, p_description text, p_category text, p_definition jsonb, p_id uuid DEFAULT NULL::uuid, p_tenant_id uuid DEFAULT NULL::uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant uuid;
  v_is_active boolean;
  v_id uuid;
  v_op record;
  v_legal jsonb := '{
    "crm":            ["search_accounts","get_account","search_conversations","search_opportunities"],
    "helpdesk":       ["search_tickets","get_ticket","search_articles"],
    "knowledge_base": ["search_articles","get_article"],
    "erp_financials": ["search_invoices","get_invoice"],
    "billing":        ["get_subscription","search_invoices"],
    "payroll_hcm":    ["get_employee","search_time_off"],
    "pos":            ["search_orders","get_order"],
    "product_system": ["get_record","search_records"],
    "other":          ["get_record","search_records"]
  }'::jsonb;  -- mirrors categoryContracts.ts CATEGORY_OPS (keep in sync)
  v_auth_type text;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    v_tenant := p_tenant_id;
  else
    select tenant_id, coalesce(is_active, true) into v_tenant, v_is_active from profiles where user_id = auth.uid();
    if v_tenant is not null and not v_is_active then
      raise exception 'account is deactivated';
    end if;
  end if;
  if v_tenant is null then
    raise exception 'no tenant — sign in as a workspace member (or pass p_tenant_id with the service role)';
  end if;

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'template needs a name';
  end if;
  if not (v_legal ? p_category) then
    raise exception 'unknown category "%"', p_category;
  end if;

  -- structural definition checks
  v_auth_type := p_definition #>> '{auth,type}';
  if v_auth_type is null or v_auth_type not in ('api_key_header','bearer','basic','oauth2_client_credentials','none') then
    raise exception 'definition.auth.type must be one of api_key_header, bearer, basic, oauth2_client_credentials, none';
  end if;
  if v_auth_type = 'api_key_header' and coalesce(p_definition #>> '{auth,header_name}', '') = '' then
    raise exception 'API-key auth needs auth.header_name (which header carries the key)';
  end if;
  if v_auth_type = 'oauth2_client_credentials' and coalesce(p_definition #>> '{auth,token_url}', '') = '' then
    raise exception 'OAuth2 client-credentials auth needs auth.token_url';
  end if;
  if coalesce(p_definition ->> 'base_url_template', '') !~ '^https?://' then
    raise exception 'definition.base_url_template must be a full URL starting with https://';
  end if;
  if p_definition -> 'ops' is null or p_definition -> 'ops' = '{}'::jsonb then
    raise exception 'bind at least one operation (definition.ops is empty)';
  end if;
  for v_op in select key, value from jsonb_each(p_definition -> 'ops') loop
    if not (v_legal -> p_category) ? v_op.key then
      raise exception '"%" is not a legal operation for the % category — legal ops: %',
        v_op.key, p_category, (select string_agg(x, ', ') from jsonb_array_elements_text(v_legal -> p_category) x);
    end if;
    if v_op.value #> '{response,items_path}' is null then
      raise exception 'operation "%": response.items_path is required — where in the response do the results live? Use "" if the response root is the list', v_op.key;
    end if;
    if coalesce(v_op.value #>> '{response,id_path}', '') = '' then
      raise exception 'operation "%": response.id_path is required (which field is the record id?)', v_op.key;
    end if;
    if coalesce(v_op.value #>> '{response,title_path}', '') = '' then
      raise exception 'operation "%": response.title_path is required (which field is the title?)', v_op.key;
    end if;
    if coalesce(v_op.value ->> 'method', '') not in ('GET','POST') then
      raise exception 'operation "%": method must be GET or POST', v_op.key;
    end if;
    if coalesce(v_op.value ->> 'path_template', '') !~ '^/' then
      raise exception 'operation "%": path_template must start with "/"', v_op.key;
    end if;
  end loop;
  if coalesce(p_definition #>> '{test_op,op}', '') = '' then
    raise exception 'definition.test_op is required — which operation proves the connection works?';
  end if;
  if p_definition -> 'ops' -> (p_definition #>> '{test_op,op}') is null then
    raise exception 'test_op "%" is not one of the bound operations', p_definition #>> '{test_op,op}';
  end if;

  if p_id is not null then
    update adapter_templates
      set name = trim(p_name), description = coalesce(p_description, ''),
          category = p_category, definition = p_definition
      where id = p_id and scope = 'tenant' and tenant_id = v_tenant
      returning id into v_id;
    if v_id is null then
      raise exception 'template not found in your workspace (platform templates cannot be edited — save a copy instead)';
    end if;
  else
    insert into adapter_templates (scope, tenant_id, name, description, category, definition, created_by)
    values ('tenant', v_tenant, trim(p_name), coalesce(p_description, ''), p_category, p_definition, auth.uid())
    returning id into v_id;
  end if;
  return v_id;
end;
$function$;


-- ── search_knowledge (p_tenant_id, p_query, p_audience, p_limit) ────
create or replace function public.search_knowledge(p_tenant_id uuid, p_query text, p_audience text DEFAULT NULL::text, p_limit integer DEFAULT 5)
 returns TABLE(id uuid, title text, summary text, body text, audience text, category text, tags text[], rank real)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT ka.id, ka.title, ka.summary, ka.body, ka.audience, ka.category, ka.tags,
         ts_rank(ka.search_tsv, websearch_to_tsquery('english', p_query)) AS rank
  FROM public.knowledge_articles ka
  WHERE ka.tenant_id = p_tenant_id
    AND (auth.uid() IS NULL OR p_tenant_id IN (SELECT tenant_id FROM public.profiles WHERE user_id = auth.uid() AND coalesce(is_active, true) = true))
    AND ka.status = 'published'
    AND (p_audience IS NULL OR ka.audience = p_audience OR ka.audience = 'all')
    AND ka.search_tsv @@ websearch_to_tsquery('english', p_query)
  ORDER BY rank DESC
  LIMIT GREATEST(p_limit, 1);
$function$;


-- ── search_knowledge (p_tenant_id, p_query, p_limit) ────────────────
create or replace function public.search_knowledge(p_tenant_id uuid, p_query text, p_limit integer DEFAULT 5)
 returns TABLE(id uuid, title text, body text, similarity double precision)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF auth.uid() IS NOT NULL AND p_tenant_id NOT IN (SELECT tenant_id FROM profiles WHERE user_id = auth.uid() AND coalesce(is_active, true) = true) THEN
    RAISE EXCEPTION 'tenant access denied';
  END IF;
  RETURN QUERY
  SELECT ka.id, ka.title, ka.body,
    ts_rank(
      to_tsvector('english', coalesce(ka.title,'') || ' ' || coalesce(ka.body,'')),
      plainto_tsquery('english', p_query)
    )::float AS similarity
  FROM knowledge_articles ka
  WHERE ka.tenant_id = p_tenant_id
    AND ka.status = 'published'
    AND to_tsvector('english', coalesce(ka.title,'') || ' ' || coalesce(ka.body,''))
        @@ plainto_tsquery('english', p_query)
  ORDER BY similarity DESC
  LIMIT p_limit;
END;
$function$;


-- ── seed_trust_policies ─────────────────────────────────────────────
create or replace function public.seed_trust_policies()
 returns SETOF trust_policies
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_tenant uuid;
  v_is_active boolean;
  v_de     uuid;
begin
  select tenant_id, coalesce(is_active, true) into v_tenant, v_is_active from profiles where user_id = auth.uid() limit 1;
  if v_tenant is null then
    raise exception 'no tenant for the current session';
  end if;
  if not v_is_active then
    raise exception 'account is deactivated';
  end if;
  if v_tenant = 'a0000000-0000-0000-0000-000000000001'::uuid then
    raise exception 'demo tenant uses the demo story — earned trust is a live-tenant feature';
  end if;

  select id into v_de from digital_employees where tenant_id = v_tenant order by created_at limit 1;

  insert into trust_policies (tenant_id, de_id, action_category, criteria)
  values
    (v_tenant, v_de, 'invoice_auto_send', '{"window_days":30,"min_eval_pass_rate":0.9,"min_eval_samples":25,"min_human_approval_rate":0.9,"min_human_samples":5,"max_guardrail_blocks":0}'::jsonb),
    (v_tenant, v_de, 'answer_dock',       '{"window_days":30,"min_eval_pass_rate":0.9,"min_eval_samples":25,"min_human_approval_rate":0.9,"min_human_samples":0,"max_guardrail_blocks":0}'::jsonb),
    (v_tenant, v_de, 'answer_widget',     '{"window_days":30,"min_eval_pass_rate":0.95,"min_eval_samples":40,"min_human_approval_rate":0.9,"min_human_samples":0,"max_guardrail_blocks":0}'::jsonb)
  on conflict (tenant_id, action_category) do nothing;

  return query select * from trust_policies where tenant_id = v_tenant order by action_category;
end;
$function$;


-- ── set_access_grant ────────────────────────────────────────────────
create or replace function public.set_access_grant(p_subject_kind text, p_subject_id uuid, p_resource_kind text, p_resource_id uuid, p_resource_category text, p_permission text, p_note text DEFAULT ''::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant   uuid;
  v_user     uuid := auth.uid();
  v_role     text;
  v_is_active boolean;
  v_before   text;
  v_grant_id uuid;
  v_subject_label text;
  v_resource_label text;
begin
  -- Tenant + role guard. A genuine service_role connection (edge
  -- functions, which pin tenant themselves) is the ONLY caller trusted
  -- without a JWT -- an anon-key call with no bearer token must be
  -- rejected here, not treated as a trusted service caller, or anyone
  -- could grant/change any tenant's access rules by guessing a subject id.
  if v_user is not null then
    select tenant_id, role, coalesce(is_active, true) into v_tenant, v_role, v_is_active from profiles where user_id = v_user;
    if v_tenant is null then
      return jsonb_build_object('ok', false, 'error', 'no_tenant');
    end if;
    if not v_is_active then
      return jsonb_build_object('ok', false, 'error', 'admin_role_required',
        'detail', 'Only workspace owners/admins can change data access rules.');
    end if;
    if v_role not in ('tenant_owner', 'tenant_admin') then
      return jsonb_build_object('ok', false, 'error', 'admin_role_required',
        'detail', 'Only workspace owners/admins can change data access rules.');
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    return jsonb_build_object('ok', false, 'error', 'admin_role_required',
      'detail', 'Only workspace owners/admins can change data access rules.');
  else
    -- service role: derive tenant from the subject row
    if p_subject_kind = 'de' then
      select tenant_id into v_tenant from digital_employees where id = p_subject_id;
    else
      select tenant_id into v_tenant from specialist_profiles where id = p_subject_id;
    end if;
    if v_tenant is null then
      return jsonb_build_object('ok', false, 'error', 'subject_not_found');
    end if;
  end if;

  -- Validate subject belongs to the tenant
  if p_subject_kind = 'de' then
    select name into v_subject_label from digital_employees where id = p_subject_id and tenant_id = v_tenant;
  elsif p_subject_kind = 'specialist' then
    select name into v_subject_label from specialist_profiles where id = p_subject_id and tenant_id = v_tenant;
  else
    return jsonb_build_object('ok', false, 'error', 'bad_subject_kind');
  end if;
  if v_subject_label is null then
    return jsonb_build_object('ok', false, 'error', 'subject_not_in_tenant');
  end if;

  -- Validate resource
  if p_resource_kind = 'connector' then
    select display_name into v_resource_label from connectors where id = p_resource_id and tenant_id = v_tenant;
    if v_resource_label is null then
      return jsonb_build_object('ok', false, 'error', 'connector_not_in_tenant');
    end if;
  elsif p_resource_kind = 'category' then
    v_resource_label := 'all ' || p_resource_category || ' systems';
  else
    return jsonb_build_object('ok', false, 'error', 'bad_resource_kind');
  end if;

  if access_permission_level(p_permission) = 0 then
    return jsonb_build_object('ok', false, 'error', 'bad_permission');
  end if;

  select permission into v_before from data_access_grants
   where tenant_id = v_tenant and subject_kind = p_subject_kind and subject_id = p_subject_id
     and resource_kind = p_resource_kind
     and coalesce(resource_id::text, resource_category) = coalesce(p_resource_id::text, p_resource_category);

  insert into data_access_grants
    (tenant_id, subject_kind, subject_id, resource_kind, resource_id, resource_category, permission, granted_by, note)
  values
    (v_tenant, p_subject_kind, p_subject_id, p_resource_kind,
     case when p_resource_kind = 'connector' then p_resource_id else null end,
     case when p_resource_kind = 'category' then p_resource_category else null end,
     p_permission, v_user, coalesce(p_note, ''))
  on conflict (tenant_id, subject_kind, subject_id, resource_kind,
               coalesce(resource_id::text, resource_category))
  do update set permission = excluded.permission, granted_by = excluded.granted_by,
                note = excluded.note, updated_at = now()
  returning id into v_grant_id;

  perform append_audit_event(
    v_tenant,
    coalesce((select full_name from profiles where user_id = v_user), 'service'),
    case when v_user is null then 'system' else 'human' end,
    'Data access grant changed — ' || v_subject_label || ' on ' || v_resource_label
      || ': ' || coalesce(v_before, 'none') || ' → ' || p_permission
      || case when coalesce(p_note, '') <> '' then ' (' || p_note || ')' else '' end,
    'access_control',
    jsonb_build_object('kind', 'access_grant_changed', 'grant_id', v_grant_id,
      'subject_kind', p_subject_kind, 'subject_id', p_subject_id, 'subject_label', v_subject_label,
      'resource_kind', p_resource_kind, 'resource_id', p_resource_id,
      'resource_category', p_resource_category, 'resource_label', v_resource_label,
      'before', v_before, 'after', p_permission)
  );

  return jsonb_build_object('ok', true, 'grant_id', v_grant_id, 'before', v_before, 'after', p_permission);
end;
$function$;


-- ── set_connector_secret ────────────────────────────────────────────
create or replace function public.set_connector_secret(p_connector_id uuid, p_secret text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if coalesce(auth.role(), '') <> 'service_role' and not exists (
    select 1
    from connectors c
    join profiles p on p.tenant_id = c.tenant_id
    where c.id = p_connector_id and p.user_id = auth.uid() and coalesce(p.is_active, true) = true
  ) then
    raise exception 'not a member of this connector''s tenant';
  end if;

  insert into connector_secrets (connector_id, secret)
  values (p_connector_id, p_secret)
  on conflict (connector_id) do update
    set secret = excluded.secret, updated_at = now();
end;
$function$;


-- ── set_doc_scope ───────────────────────────────────────────────────
create or replace function public.set_doc_scope(p_doc_id uuid, p_subjects jsonb DEFAULT '[]'::jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_user        uuid := auth.uid();
  v_caller_tenant uuid;
  v_is_active   boolean;
  v_doc_tenant  uuid;
  v_doc_title   text;
  v_before      text;
  v_after       text;
  v_subj        jsonb;
  v_kind        text;
  v_sid         uuid;
  v_label       text;
  v_labels      text[] := '{}';
  v_count       integer := 0;
begin
  select tenant_id, title, visibility into v_doc_tenant, v_doc_title, v_before
    from knowledge_docs where id = p_doc_id;
  if v_doc_tenant is null then
    return jsonb_build_object('ok', false, 'error', 'doc_not_found');
  end if;

  -- Membership guard (JWT path); ONLY a genuine service_role connection
  -- is trusted without a JWT (same test append_audit_event uses) — an
  -- anon-key call with no bearer token must be rejected, not treated
  -- as trusted, or anyone could rescope any tenant's documents.
  if v_user is not null then
    select tenant_id, coalesce(is_active, true) into v_caller_tenant, v_is_active from profiles where user_id = v_user;
    if v_caller_tenant is null or v_caller_tenant <> v_doc_tenant then
      return jsonb_build_object('ok', false, 'error', 'not_tenant_member',
        'detail', 'Only members of this workspace can change who uses a document.');
    end if;
    if not v_is_active then
      return jsonb_build_object('ok', false, 'error', 'not_tenant_member',
        'detail', 'Only members of this workspace can change who uses a document.');
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    return jsonb_build_object('ok', false, 'error', 'not_tenant_member',
      'detail', 'Only members of this workspace can change who uses a document.');
  end if;

  if p_subjects is null or jsonb_typeof(p_subjects) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'bad_subjects',
      'detail', 'p_subjects must be a JSON array of {kind, id}.');
  end if;

  -- Validate every subject belongs to the doc's tenant BEFORE writing.
  for v_subj in select * from jsonb_array_elements(p_subjects) loop
    v_kind := v_subj->>'kind';
    begin
      v_sid := (v_subj->>'id')::uuid;
    exception when others then
      return jsonb_build_object('ok', false, 'error', 'bad_subject_id');
    end;
    if v_kind = 'de' then
      select name into v_label from digital_employees where id = v_sid and tenant_id = v_doc_tenant;
    elsif v_kind = 'specialist' then
      select name into v_label from specialist_profiles where id = v_sid and tenant_id = v_doc_tenant;
    else
      return jsonb_build_object('ok', false, 'error', 'bad_subject_kind');
    end if;
    if v_label is null then
      return jsonb_build_object('ok', false, 'error', 'subject_not_in_tenant',
        'detail', v_kind || ' ' || v_sid || ' is not in this workspace.');
    end if;
    v_labels := array_append(v_labels, v_label || ' (' || v_kind || ')');
    v_count := v_count + 1;
  end loop;

  -- Replace scopes atomically.
  delete from knowledge_doc_scopes where doc_id = p_doc_id;
  for v_subj in select * from jsonb_array_elements(p_subjects) loop
    insert into knowledge_doc_scopes (tenant_id, doc_id, subject_kind, subject_id)
    values (v_doc_tenant, p_doc_id, v_subj->>'kind', (v_subj->>'id')::uuid)
    on conflict (doc_id, subject_kind, subject_id) do nothing;
  end loop;

  -- Visibility flips automatically; ALWAYS update the row so the
  -- answer-cache invalidation trigger (013) fires on any scope change.
  v_after := case when v_count > 0 then 'scoped' else 'tenant' end;
  update knowledge_docs set visibility = v_after where id = p_doc_id;

  -- Best-effort audit: append_audit_event requires either tenant
  -- membership on the JWT path or a genuine service_role connection;
  -- SQL-console/migration-context calls (auth.uid() null, role not
  -- service_role) are a legitimate trusted caller here (mirrors the
  -- seed_default_grants pattern in migration 029) but would otherwise
  -- raise — so this write must never fail because the audit line did.
  begin
    perform append_audit_event(
      v_doc_tenant,
      coalesce((select full_name from profiles where user_id = v_user), 'service'),
      case when v_user is null then 'system' else 'human' end,
      'Knowledge scope changed — "' || v_doc_title || '": ' || v_before || ' → ' || v_after
        || case when v_count > 0 then ' (only ' || array_to_string(v_labels, ', ') || ' will use this document)'
                else ' (all digital employees will use this document)' end,
      'access_control',
      jsonb_build_object('kind', 'knowledge_scope_changed', 'doc_id', p_doc_id,
        'doc_title', v_doc_title, 'before', v_before, 'after', v_after,
        'subjects', p_subjects, 'subject_labels', v_labels)
    );
  exception when others then null;
  end;

  return jsonb_build_object('ok', true, 'visibility', v_after, 'subjects', v_count);
end;
$function$;


-- ── set_onboarding_project_status ───────────────────────────────────
create or replace function public.set_onboarding_project_status(p_project_id uuid, p_status text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_proj onboarding_projects;
begin
  if p_status not in ('active', 'on_hold', 'cancelled') then
    return jsonb_build_object('error', 'invalid_status');
  end if;
  select * into v_proj from onboarding_projects where id = p_project_id;
  if not found then return jsonb_build_object('error', 'project_not_found'); end if;
  if not exists (
    select 1 from profiles where user_id = auth.uid() and tenant_id = v_proj.tenant_id and coalesce(is_active, true) = true
  ) then
    raise exception 'not a member of this tenant';
  end if;
  if v_proj.status = 'completed' then
    return jsonb_build_object('error', 'project_completed');
  end if;
  if v_proj.status = p_status then
    return jsonb_build_object('status', p_status);
  end if;

  update onboarding_projects set status = p_status where id = p_project_id;

  perform append_audit_event_internal(
    v_proj.tenant_id, 'You', 'human',
    format('Onboarding project %s — %s', case p_status when 'cancelled' then 'cancelled'
           when 'on_hold' then 'put on hold' else 'reactivated' end, v_proj.name),
    'config_change',
    jsonb_build_object('kind', 'onboarding_project_' || p_status, 'project_id', p_project_id,
                       'old_status', v_proj.status, 'new_status', p_status));

  return jsonb_build_object('status', p_status);
end;
$function$;


-- ── set_specialist_source_secret ────────────────────────────────────
create or replace function public.set_specialist_source_secret(p_source_id uuid, p_secret text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if coalesce(auth.role(), '') <> 'service_role' and not exists (
    select 1
    from specialist_sources s
    join specialist_profiles sp on sp.id = s.profile_id
    join profiles p on p.tenant_id = sp.tenant_id
    where s.id = p_source_id and p.user_id = auth.uid() and coalesce(p.is_active, true) = true
  ) then
    raise exception 'not a member of this source''s tenant';
  end if;

  insert into specialist_source_secrets (source_id, secret)
  values (p_source_id, p_secret)
  on conflict (source_id) do update
    set secret = excluded.secret, updated_at = now();
end;
$function$;


-- ── set_work_item_framing ───────────────────────────────────────────
create or replace function public.set_work_item_framing(p_category text, p_template text)
 returns work_item_framing
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant uuid;
  v_role   text;
  v_is_active boolean;
  v_row    work_item_framing;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    select tenant_id, role, coalesce(is_active, true) into v_tenant, v_role, v_is_active from profiles where user_id = auth.uid();
    if v_tenant is null then
      raise exception 'not a member of any tenant';
    end if;
    if not v_is_active then
      raise exception 'account is deactivated';
    end if;
    if v_role not in ('tenant_owner', 'tenant_admin') then
      raise exception 'only workspace owners/admins can customize work-item framing';
    end if;
  else
    raise exception 'service-role callers must pass a tenant via the platform-seed path, not this RPC';
  end if;

  if trim(coalesce(p_template, '')) = '' then
    raise exception 'template must not be empty';
  end if;
  if position('{title}' in p_template) = 0 then
    raise exception 'template must include a {title} placeholder';
  end if;

  insert into work_item_framing (scope, tenant_id, category, template, created_by)
  values ('tenant', v_tenant, p_category, p_template, auth.uid())
  on conflict (scope, coalesce(tenant_id::text, ''), category) do update set
    template = excluded.template, updated_at = now()
  returning * into v_row;

  perform append_audit_event(
    v_tenant, coalesce((select full_name from profiles where user_id = auth.uid()), 'you'), 'human',
    format('Work-item framing customized for %s: "%s"', p_category, left(p_template, 140)),
    'config_change',
    jsonb_build_object('kind', 'work_item_framing_changed', 'category', p_category, 'template', p_template)
  );

  return v_row;
end;
$function$;


-- ── submit_evidence_feedback ────────────────────────────────────────
create or replace function public.submit_evidence_feedback(p_evidence_run_id uuid, p_verdict text, p_notes text DEFAULT ''::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_user           uuid := auth.uid();
  v_tenant         uuid;
  v_caller_tenant  uuid;
  v_is_active      boolean;
  v_run            record;
  v_feedback_id    uuid;
  v_revision_id    uuid;
  v_task_id        uuid;
  v_source_doc_id  uuid;
  v_current_title  text;
  v_current_body   text;
  v_gap_lines      text := '';
  v_step           jsonb;
  v_citation       jsonb;
  v_proposed_title text;
  v_proposed_body  text;
  v_reviewer_name  text;
begin
  if p_verdict not in ('accurate', 'needs_improvement', 'inaccurate') then
    return jsonb_build_object('ok', false, 'error', 'bad_verdict');
  end if;

  select * into v_run from evidence_runs where id = p_evidence_run_id;
  if v_run.id is null then
    return jsonb_build_object('ok', false, 'error', 'evidence_run_not_found');
  end if;
  v_tenant := v_run.tenant_id;

  -- Membership guard (JWT path); a genuine service_role connection is
  -- also trusted (same test append_audit_event / set_doc_scope use).
  if v_user is not null then
    select tenant_id, coalesce(is_active, true) into v_caller_tenant, v_is_active from profiles where user_id = v_user;
    if v_caller_tenant is null or v_caller_tenant <> v_tenant then
      return jsonb_build_object('ok', false, 'error', 'not_tenant_member');
    end if;
    if not v_is_active then
      return jsonb_build_object('ok', false, 'error', 'not_tenant_member');
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    return jsonb_build_object('ok', false, 'error', 'not_tenant_member');
  end if;

  select full_name into v_reviewer_name from profiles where user_id = v_user;
  v_reviewer_name := coalesce(v_reviewer_name, 'A reviewer');

  insert into evidence_feedback (tenant_id, evidence_run_id, reviewer_user_id, verdict, notes)
  values (v_tenant, p_evidence_run_id, v_user, p_verdict, coalesce(p_notes, ''))
  returning id into v_feedback_id;

  perform append_audit_event(
    v_tenant, v_reviewer_name, case when v_user is null then 'system' else 'human' end,
    v_reviewer_name || ' marked evidence run evidence as "' || p_verdict || '"'
      || case when coalesce(p_notes, '') <> '' then ' — "' || p_notes || '"' else '' end,
    'evidence_step',
    jsonb_build_object('kind', 'evidence_feedback_submitted', 'evidence_run_id', p_evidence_run_id,
      'feedback_id', v_feedback_id, 'verdict', p_verdict, 'notes', coalesce(p_notes, ''))
  );

  if p_verdict = 'accurate' then
    return jsonb_build_object('ok', true, 'feedback_id', v_feedback_id, 'revision_request_id', null, 'task_id', null);
  end if;

  -- ── Build the template-composed proposed revision ──
  -- Try to find an existing knowledge doc this evidence run cited, so
  -- the revision proposes an edit rather than always a fresh doc.
  select (c->>'ref')::uuid into v_source_doc_id
  from jsonb_array_elements(v_run.steps) s,
       jsonb_array_elements(s->'citations') c
  where s->>'kind' = 'knowledge_search' and c->>'system' = 'DreamTeam knowledge'
  limit 1;

  if v_source_doc_id is not null then
    select title, content into v_current_title, v_current_body
      from knowledge_docs where id = v_source_doc_id and tenant_id = v_tenant and is_current;
  end if;

  -- Gap lines: every non-"ok" or human-flagged step, plain-language.
  for v_step in select * from jsonb_array_elements(v_run.steps) loop
    if (v_step->>'outcome') in ('failed', 'skipped_not_connected', 'denied_no_access') then
      v_gap_lines := v_gap_lines || '- ' || coalesce(v_step->>'summary', v_step->>'kind') || E'\n';
    end if;
  end loop;

  v_proposed_title := coalesce(v_current_title, 'Follow-up: ' || left(v_run.inquiry, 80));
  v_proposed_body := coalesce(v_current_body, '') || E'\n\n'
    || '## Reviewer feedback (' || p_verdict || ')' || E'\n'
    || coalesce(nullif(p_notes, ''), '(no note provided)') || E'\n\n'
    || '## Evidence gaps noted at review time' || E'\n'
    || case when v_gap_lines = '' then '(no gaps recorded in the evidence trail)' || E'\n' else v_gap_lines end
    || E'\n## Source inquiry' || E'\n' || v_run.inquiry;

  insert into knowledge_revision_requests (
    tenant_id, source_doc_id, evidence_run_id, feedback_id,
    proposed_title, proposed_body_md, status, created_by
  ) values (
    v_tenant, v_source_doc_id, p_evidence_run_id, v_feedback_id,
    v_proposed_title, v_proposed_body, 'pending_approval', v_user
  ) returning id into v_revision_id;

  insert into human_tasks (
    tenant_id, type, title, detail, source, related_table, related_id, status
  ) values (
    v_tenant, 'knowledge_revision',
    'Review proposed knowledge update: ' || v_proposed_title,
    'Evidence run flagged "' || p_verdict || '" — a knowledge revision has been drafted for review.',
    'system', 'knowledge_revision_requests', v_revision_id, 'pending'
  ) returning id into v_task_id;

  perform append_audit_event(
    v_tenant, v_reviewer_name, case when v_user is null then 'system' else 'human' end,
    'Knowledge revision proposed from evidence feedback — "' || v_proposed_title || '"',
    'knowledge_revision',
    jsonb_build_object('kind', 'knowledge_revision_requested', 'revision_request_id', v_revision_id,
      'evidence_run_id', p_evidence_run_id, 'feedback_id', v_feedback_id, 'task_id', v_task_id,
      'source_doc_id', v_source_doc_id)
  );

  return jsonb_build_object('ok', true, 'feedback_id', v_feedback_id,
    'revision_request_id', v_revision_id, 'task_id', v_task_id);
end;
$function$;


-- ── update_onboarding_item ──────────────────────────────────────────
create or replace function public.update_onboarding_item(p_project_id uuid, p_key text, p_status text DEFAULT NULL::text, p_assignee text DEFAULT NULL::text, p_note text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_proj      onboarding_projects;
  v_ver       onboarding_template_versions;
  v_def       jsonb;
  v_item      jsonb;
  v_idx       integer := -1;
  v_i         integer := 0;
  v_old       text;
  v_task_id   uuid;
  v_acct_name text;
  v_completed boolean := false;
  v_signoff   boolean;
begin
  select * into v_proj from onboarding_projects where id = p_project_id;
  if not found then return jsonb_build_object('error', 'project_not_found'); end if;
  if not exists (
    select 1 from profiles where user_id = auth.uid() and tenant_id = v_proj.tenant_id and coalesce(is_active, true) = true
  ) then
    raise exception 'not a member of this tenant';
  end if;
  if v_proj.status <> 'active' then
    return jsonb_build_object('error', 'project_not_active');
  end if;
  if p_status is not null and p_status not in ('pending', 'in_progress', 'done', 'blocked') then
    return jsonb_build_object('error', 'invalid_status');
  end if;

  select * into v_ver from onboarding_template_versions where id = v_proj.template_version_id;
  select d into v_def from jsonb_array_elements(v_ver.items) d where d->>'key' = p_key limit 1;
  if v_def is null then return jsonb_build_object('error', 'item_not_found'); end if;
  v_signoff := coalesce((v_def->>'requires_signoff')::boolean, false);

  for v_item in select * from jsonb_array_elements(v_proj.items_state) loop
    if v_item->>'key' = p_key then v_idx := v_i; exit; end if;
    v_i := v_i + 1;
  end loop;
  if v_idx < 0 then return jsonb_build_object('error', 'item_state_missing'); end if;
  v_old := v_item->>'status';

  if v_old = 'signed_off' then
    return jsonb_build_object('error', 'item_already_signed_off');
  end if;

  if p_assignee is not null then v_item := v_item || jsonb_build_object('assignee', nullif(trim(p_assignee), '')); end if;
  if p_note is not null then v_item := v_item || jsonb_build_object('note', p_note); end if;

  if p_status is not null and p_status <> v_old then
    v_item := v_item || jsonb_build_object('status', p_status);
    if p_status = 'done' then
      v_item := v_item || jsonb_build_object('done_at', now());
      if v_signoff then
        insert into human_tasks (tenant_id, type, title, detail, source, related_table, related_id)
        values (v_proj.tenant_id, 'review_gate',
                format('Onboarding sign-off — %s · %s', v_def->>'label', v_proj.name),
                format('Item "%s" is marked done and needs a human sign-off before the project can complete.', v_def->>'label'),
                'system', 'onboarding_projects', p_project_id)
        returning id into v_task_id;
        v_item := v_item || jsonb_build_object('signoff_task_id', v_task_id);
      end if;
    end if;

    select name into v_acct_name from customer_accounts where id = v_proj.account_id;
    insert into activity_events (tenant_id, account_id, actor, actor_type, event_type, text)
    values (v_proj.tenant_id, v_proj.account_id, 'You', 'human',
            case when p_status = 'blocked' then 'escalated' else 'config_change' end,
            format('Onboarding — %s: %s → %s%s (%s)', v_def->>'label', v_old, p_status,
                   case when v_task_id is not null then ' · awaiting sign-off' else '' end,
                   coalesce(v_acct_name, v_proj.name)));
  end if;

  update onboarding_projects
    set items_state = jsonb_set(items_state, array[v_idx::text], v_item)
    where id = p_project_id;

  -- non-signoff items can complete the project directly
  if p_status = 'done' and not v_signoff then
    v_completed := onboarding_check_complete(p_project_id);
  end if;

  select to_jsonb(p.*) into v_item from onboarding_projects p where p.id = p_project_id;
  return jsonb_build_object('project', v_item, 'signoff_task_id', v_task_id, 'completed', v_completed);
end;
$function$;


-- ── upsert_action_definition ────────────────────────────────────────
create or replace function public.upsert_action_definition(p_id uuid, p_scope text, p_tenant_id uuid, p_category text, p_action_key text, p_label text, p_description text, p_provider text, p_template_id uuid, p_param_schema jsonb, p_risk jsonb, p_execution jsonb)
 returns action_definitions
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_row action_definitions;
  v_user uuid := auth.uid();
  v_role text;
  v_is_active boolean;
  v_tenant_check uuid;
begin
  if p_scope not in ('platform', 'tenant') then
    raise exception 'scope must be platform or tenant';
  end if;
  if p_scope = 'tenant' and p_tenant_id is null then
    raise exception 'tenant scope requires tenant_id';
  end if;
  if p_scope = 'platform' and p_tenant_id is not null then
    raise exception 'platform scope must not carry a tenant_id';
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    if p_scope = 'platform' then
      raise exception 'only the platform (service role) can define platform-scope actions';
    end if;
    select tenant_id, role, coalesce(is_active, true) into v_tenant_check, v_role, v_is_active from profiles where user_id = v_user;
    if v_tenant_check is distinct from p_tenant_id then
      raise exception 'not a member of this tenant';
    end if;
    if not v_is_active then
      raise exception 'account is deactivated';
    end if;
    if v_role not in ('tenant_owner', 'tenant_admin') then
      raise exception 'only workspace owners/admins can register actions';
    end if;
  end if;

  if p_provider = 'template' and p_template_id is null then
    raise exception 'template provider requires template_id';
  end if;
  if not (p_risk ? 'destructive') or not (p_risk ? 'idempotent') then
    raise exception 'risk must include destructive and idempotent booleans';
  end if;

  insert into action_definitions (
    id, scope, tenant_id, category, action_key, label, description,
    provider, template_id, param_schema, risk, execution, created_by
  ) values (
    coalesce(p_id, gen_random_uuid()), p_scope, p_tenant_id, p_category, p_action_key, p_label, p_description,
    p_provider, p_template_id, coalesce(p_param_schema, '[]'::jsonb), p_risk, coalesce(p_execution, '{}'::jsonb), v_user
  )
  on conflict (id) do update set
    category = excluded.category, action_key = excluded.action_key,
    label = excluded.label, description = excluded.description,
    provider = excluded.provider, template_id = excluded.template_id,
    param_schema = excluded.param_schema, risk = excluded.risk,
    execution = excluded.execution, updated_at = now()
  returning * into v_row;

  return v_row;
end;
$function$;


-- ── verify_audit_chain ──────────────────────────────────────────────
create or replace function public.verify_audit_chain(p_tenant_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  r          record;
  v_prev     text := '';
  v_expected text;
  v_checked  integer := 0;
  v_is_active boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    select coalesce(is_active, true) into v_is_active from profiles where user_id = auth.uid() and tenant_id = p_tenant_id;
    if v_is_active is null or not v_is_active then
      raise exception 'not a member of this tenant';
    end if;
  end if;

  for r in
    select * from audit_events
    where tenant_id = p_tenant_id
    order by created_at asc, id asc
  loop
    v_expected := encode(digest(
      v_prev || r.tenant_id::text || coalesce(r.action, '') ||
      coalesce(r.detail::text, '{}') || r.created_at::text,
      'sha256'), 'hex');
    if r.prev_hash <> v_prev or r.hash <> v_expected then
      return jsonb_build_object('intact', false, 'checked', v_checked, 'broken_at', r.id);
    end if;
    v_prev := r.hash;
    v_checked := v_checked + 1;
  end loop;

  return jsonb_build_object('intact', true, 'checked', v_checked, 'broken_at', null);
end;
$function$;


-- ── visible_knowledge_docs ──────────────────────────────────────────
create or replace function public.visible_knowledge_docs(p_tenant_id uuid, p_subject_kind text DEFAULT NULL::text, p_subject_id uuid DEFAULT NULL::uuid)
 returns TABLE(id uuid, title text, content text, tags text[], visibility text)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if auth.uid() is not null and p_tenant_id not in
     (select tenant_id from profiles where user_id = auth.uid() and coalesce(is_active, true) = true) then
    raise exception 'tenant access denied';
  end if;
  return query
  select d.id, d.title, d.content, d.tags, d.visibility
  from knowledge_docs d
  where d.tenant_id = p_tenant_id
    and d.is_current
    and (
      d.visibility = 'tenant'
      or (p_subject_kind is not null and p_subject_id is not null and exists (
            select 1 from knowledge_doc_scopes s
            where s.doc_id = d.id
              and s.subject_kind = p_subject_kind
              and s.subject_id = p_subject_id))
    );
end;
$function$;


-- ── caller_has_tenant_relationship (shared helper: fixes is_ancestor_of,
--    tenant_ancestors, tenant_descendants, which all call this rather
--    than doing their own profiles lookup) ──────────────────────────
create or replace function public.caller_has_tenant_relationship(p_tenant_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select
    is_platform_admin()
    or exists (
      select 1 from profiles pr where pr.user_id = auth.uid() and pr.tenant_id = p_tenant_id and coalesce(pr.is_active, true) = true
    )
    or exists (
      -- caller's own tenant is an ancestor of p_tenant_id => opt-in rollup
      -- visibility for a parent looking at a descendant.
      select 1
      from profiles pr
      join tenant_ancestry ta on ta.tenant_id = p_tenant_id and ta.ancestor_id = pr.tenant_id
      where pr.user_id = auth.uid() and coalesce(pr.is_active, true) = true
    );
$function$;


-- ── is_feature_enabled ──────────────────────────────────────────────
create or replace function public.is_feature_enabled(p_tenant_id uuid, p_feature_key text)
 returns boolean
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_override boolean;
  v_default  boolean;
begin
  if not (
    is_platform_admin()
    or exists (select 1 from profiles pr where pr.user_id = auth.uid() and pr.tenant_id = p_tenant_id and coalesce(pr.is_active, true) = true)
  ) then
    raise exception 'not authorized to check feature flags for this tenant';
  end if;

  select enabled into v_override from tenant_feature_overrides
  where tenant_id = p_tenant_id and feature_key = p_feature_key;
  if found then
    return v_override;
  end if;

  select default_enabled into v_default from feature_registry where key = p_feature_key;
  if not found then
    raise exception 'unknown feature key: %', p_feature_key;
  end if;
  return v_default;
end;
$function$;
