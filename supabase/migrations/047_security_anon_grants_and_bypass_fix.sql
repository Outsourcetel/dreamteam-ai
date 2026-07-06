-- Follow-up to the 2026-07-06 adversarial isolation audit (038-041), found
-- during a live product-demo walkthrough with the founder.
--
-- FINDING 1 (cross-tenant READ leak): match_doc_chunks and both
-- search_knowledge overloads guard tenant access with the pattern
--   IF auth.uid() IS NOT NULL AND p_tenant_id NOT IN (...) THEN RAISE
-- (or the equivalent `auth.uid() IS NULL OR p_tenant_id IN (...)` inside a
-- WHERE clause). Both forms short-circuit to "allowed" when auth.uid() IS
-- NULL -- i.e. a genuinely anonymous call with no JWT at all bypasses the
-- tenant check entirely and can pass ANY p_tenant_id. Confirmed exploitable
-- live: these three functions had a direct EXECUTE grant to `anon`.
--
-- FINDING 2 (cross-tenant WRITE / privilege escalation, more severe --
-- found during independent verification of the read-leak report, not in
-- the original report itself): set_access_grant and revoke_access_grant
-- -- the two functions that ARE the entire Data Access Grants security
-- model -- have an `if v_user is not null then <role-checked path> else
-- <derive tenant from subject, NO service_role check> end if` shape. The
-- ELSE branch (auth.uid() IS NULL, i.e. an anonymous caller) never checks
-- auth.role() = 'service_role' the way the correctly-patched sibling
-- functions (set_doc_scope, submit_evidence_feedback, apply_knowledge_revision,
-- reject_knowledge_revision) already do. Anyone with just the public anon
-- key and a known/guessed digital_employees or specialist_profiles id could
-- grant or revoke that subject's access to ANY category or connector in
-- its tenant -- e.g. silently widening a Support DE's access to Finance
-- systems in a company that never asked for it. This is fixed with actual
-- logic changes, not just a grant revoke.
--
-- FINDING 3 (defense-in-depth hygiene): apply_knowledge_revision,
-- reject_knowledge_revision, set_doc_scope, submit_evidence_feedback,
-- purge_connector_secret, set_connector_secret, platform_config_set are
-- ALL correctly guarded internally, but none of them need to be callable
-- by the `anon` role at all -- only `authenticated` (real logged-in users)
-- and `service_role` (internal/edge-function use) ever legitimately call
-- them. Revoking anon here costs nothing and shrinks the attack surface.
--
-- Reminder learned earlier today (migrations 040-043): REVOKE ... FROM
-- anon, authenticated alone does NOT remove a grant that also exists to
-- the PUBLIC pseudo-role on this project -- every revoke below is
-- explicit about all three.

-- ---------------------------------------------------------------
-- Finding 1: grant hygiene only (internal guard logic is otherwise
-- correct for the "has a real JWT" case; the fix is closing the
-- anonymous/no-JWT door at the grant level).
-- ---------------------------------------------------------------
revoke all on function match_doc_chunks(uuid, uuid, vector, integer, text, uuid) from public, anon, authenticated;
grant execute on function match_doc_chunks(uuid, uuid, vector, integer, text, uuid) to authenticated, service_role;

revoke all on function search_knowledge(uuid, text, integer) from public, anon, authenticated;
grant execute on function search_knowledge(uuid, text, integer) to authenticated, service_role;

revoke all on function search_knowledge(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function search_knowledge(uuid, text, text, integer) to authenticated, service_role;

-- ---------------------------------------------------------------
-- Finding 2: real logic fix -- add the missing service_role check to the
-- anonymous-caller branch, matching the pattern already proven correct
-- elsewhere in this codebase (set_doc_scope / submit_evidence_feedback).
-- ---------------------------------------------------------------
create or replace function public.set_access_grant(p_subject_kind text, p_subject_id uuid, p_resource_kind text, p_resource_id uuid, p_resource_category text, p_permission text, p_note text default ''::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant   uuid;
  v_user     uuid := auth.uid();
  v_role     text;
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
    select tenant_id, role into v_tenant, v_role from profiles where user_id = v_user;
    if v_tenant is null then
      return jsonb_build_object('ok', false, 'error', 'no_tenant');
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
  v_before text;
  v_subject_label text;
  v_resource_label text;
begin
  if v_user is not null then
    select tenant_id, role into v_tenant, v_role from profiles where user_id = v_user;
    if v_tenant is null then
      return jsonb_build_object('ok', false, 'error', 'no_tenant');
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

-- These two changed signature-compatible bodies (CREATE OR REPLACE with the
-- same identity arguments) keep their existing grants, but tighten them
-- explicitly anyway for clarity and defense-in-depth:
revoke all on function set_access_grant(text, uuid, text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function set_access_grant(text, uuid, text, uuid, text, text, text) to authenticated, service_role;

revoke all on function revoke_access_grant(text, uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function revoke_access_grant(text, uuid, text, uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------
-- Finding 3: defense-in-depth grant hygiene -- internally correct, but
-- anon never needs direct access to any of these.
-- ---------------------------------------------------------------
revoke all on function apply_knowledge_revision(uuid) from public, anon, authenticated;
grant execute on function apply_knowledge_revision(uuid) to authenticated, service_role;

revoke all on function reject_knowledge_revision(uuid, text) from public, anon, authenticated;
grant execute on function reject_knowledge_revision(uuid, text) to authenticated, service_role;

revoke all on function set_doc_scope(uuid, jsonb) from public, anon, authenticated;
grant execute on function set_doc_scope(uuid, jsonb) to authenticated, service_role;

revoke all on function submit_evidence_feedback(uuid, text, text) from public, anon, authenticated;
grant execute on function submit_evidence_feedback(uuid, text, text) to authenticated, service_role;

revoke all on function purge_connector_secret(uuid) from public, anon, authenticated;
grant execute on function purge_connector_secret(uuid) to authenticated, service_role;

revoke all on function set_connector_secret(uuid, text) from public, anon, authenticated;
grant execute on function set_connector_secret(uuid, text) to authenticated, service_role;

revoke all on function platform_config_set(jsonb) from public, anon, authenticated;
grant execute on function platform_config_set(jsonb) to authenticated, service_role;
