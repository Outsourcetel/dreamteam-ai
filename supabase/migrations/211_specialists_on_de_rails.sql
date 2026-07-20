-- 211_specialists_on_de_rails.sql
-- ============================================================================
-- Retire specialist_profiles as a source of truth — step 1 of 2 (NO DROPS here).
--
-- Specialists were hard-absorbed into digital_employees (migration 208,
-- is_specialist=true, specialist_key). This migration makes EVERY remaining
-- reader resolve specialists from digital_employees, and repoints all data that
-- still keyed a specialist by its old specialist_profiles id onto the DE id.
--
-- Design: subject_kind='specialist' STAYS a first-class concept (it drives the
-- poller rule "a real DE owns an inbox before a specialist does"), but it is now
-- backed 100% by digital_employees. A 'specialist' subject_id is the is_specialist
-- DE's id from here on. specialist_de_id becomes the live link on the 4 data
-- tables + the assignment table; the old profile_id/specialist_id columns are made
-- nullable here and DROPPED in migration 212 once nothing writes them.
--
-- After this migration NOTHING in the database reads specialist_profiles.
-- Everything is idempotent + guarded so re-running is safe.
-- GLOBAL — every tenant.
-- ============================================================================

-- ── 1. Repoint data: subject_id profile_id → de_id (subject_kind stays 'specialist')
-- All rows verified mapped in specialist_de_map (0 unmapped) before writing.
UPDATE data_access_grants g SET subject_id = m.de_id
  FROM specialist_de_map m
 WHERE g.subject_kind = 'specialist' AND g.subject_id = m.specialist_id;

UPDATE knowledge_doc_scopes s SET subject_id = m.de_id
  FROM specialist_de_map m
 WHERE s.subject_kind = 'specialist' AND s.subject_id = m.specialist_id;

UPDATE de_experience e SET subject_id = m.de_id
  FROM specialist_de_map m
 WHERE e.subject_kind = 'specialist' AND e.subject_id = m.specialist_id;

UPDATE action_executions a SET subject_id = m.de_id
  FROM specialist_de_map m
 WHERE a.subject_kind = 'specialist' AND a.subject_id = m.specialist_id;

-- ── 2. Loosen the old FK columns so edge fns/functions can stop writing them.
-- specialist_de_id is already backfilled (0 nulls) on every row that had data.
ALTER TABLE de_specialist_assignments ALTER COLUMN specialist_id DROP NOT NULL;
ALTER TABLE spec_consultations       ALTER COLUMN profile_id    DROP NOT NULL;
ALTER TABLE scribe_requests          ALTER COLUMN profile_id    DROP NOT NULL;
ALTER TABLE specialist_sources       ALTER COLUMN profile_id    DROP NOT NULL;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Function rewrites — every reference to specialist_profiles replaced with
--    digital_employees (a 'specialist' subject_id is now the is_specialist DE id).
-- ════════════════════════════════════════════════════════════════════════════

-- install_technical_specialist → ensure a Technical Specialist DE exists.
CREATE OR REPLACE FUNCTION public.install_technical_specialist()
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_tenant uuid; v_is_active boolean; v_id uuid;
begin
  select tenant_id, coalesce(is_active, true) into v_tenant, v_is_active from profiles where user_id = auth.uid();
  if v_tenant is null then
    if coalesce(auth.role(), '') = 'service_role' then raise exception 'service role must use direct inserts with an explicit tenant'; end if;
    return jsonb_build_object('error', 'no_tenant');
  end if;
  if not v_is_active then raise exception 'account is deactivated'; end if;

  select id into v_id from digital_employees
    where tenant_id = v_tenant and is_specialist = true and specialist_key = 'technical' limit 1;
  if v_id is not null then return jsonb_build_object('profile_id', v_id, 'already_installed', true); end if;

  insert into digital_employees (tenant_id, name, persona_name, category, is_specialist, specialist_key, description, charter, lifecycle_status, status)
  values (v_tenant, 'Technical Specialist', 'Technical Specialist', 'Internal', true, 'technical',
    'Consulted for API, integration, architecture, and debugging questions that exceed a primary Digital Employee''s depth.',
    jsonb_build_object('mission', 'You are the Technical Specialist — consulted for deep technical questions. Answer ONLY from configured sources; cite every source; escalate when the sources do not support an answer.'),
    'active', 'active')
  returning id into v_id;

  perform append_audit_event(v_tenant, 'You', 'human',
    'Technical Specialist installed (as a Digital Employee) — charter seeded, sources not yet configured',
    'config_change', jsonb_build_object('kind', 'specialist_de', 'de_id', v_id, 'specialist_key', 'technical'));
  return jsonb_build_object('profile_id', v_id, 'already_installed', false);
end; $function$;

-- revoke_access_grant — specialist subject resolved from digital_employees.
CREATE OR REPLACE FUNCTION public.revoke_access_grant(p_subject_kind text, p_subject_id uuid, p_resource_kind text, p_resource_id uuid, p_resource_category text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_tenant uuid; v_user uuid := auth.uid(); v_role text; v_is_active boolean; v_before text; v_subject_label text; v_resource_label text;
begin
  if v_user is not null then
    select tenant_id, role, coalesce(is_active, true) into v_tenant, v_role, v_is_active from profiles where user_id = v_user;
    if v_tenant is null then return jsonb_build_object('ok', false, 'error', 'no_tenant'); end if;
    if not v_is_active then return jsonb_build_object('ok', false, 'error', 'admin_role_required'); end if;
    if v_role not in ('tenant_owner', 'tenant_admin') then return jsonb_build_object('ok', false, 'error', 'admin_role_required'); end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    return jsonb_build_object('ok', false, 'error', 'admin_role_required');
  else
    -- specialist subjects are digital_employees now (subject_id = DE id)
    select tenant_id into v_tenant from digital_employees where id = p_subject_id;
    if v_tenant is null then return jsonb_build_object('ok', false, 'error', 'subject_not_found'); end if;
  end if;

  select name into v_subject_label from digital_employees where id = p_subject_id and tenant_id = v_tenant;
  v_resource_label := case when p_resource_kind = 'connector'
    then coalesce((select display_name from connectors where id = p_resource_id and tenant_id = v_tenant), 'connector')
    else 'all ' || p_resource_category || ' systems' end;

  delete from data_access_grants
   where tenant_id = v_tenant and subject_kind = p_subject_kind and subject_id = p_subject_id
     and resource_kind = p_resource_kind
     and coalesce(resource_id::text, resource_category) = coalesce(p_resource_id::text, p_resource_category)
  returning permission into v_before;

  if v_before is null then return jsonb_build_object('ok', true, 'removed', false, 'note', 'no grant existed — already default-deny'); end if;

  perform append_audit_event(v_tenant,
    coalesce((select full_name from profiles where user_id = v_user), 'service'),
    case when v_user is null then 'system' else 'human' end,
    'Data access grant REVOKED — ' || coalesce(v_subject_label, 'subject') || ' on ' || v_resource_label || ': ' || v_before || ' → none (default-deny)',
    'access_control',
    jsonb_build_object('kind', 'access_grant_changed', 'subject_kind', p_subject_kind, 'subject_id', p_subject_id, 'subject_label', v_subject_label,
      'resource_kind', p_resource_kind, 'resource_id', p_resource_id, 'resource_category', p_resource_category, 'resource_label', v_resource_label, 'before', v_before, 'after', null));
  return jsonb_build_object('ok', true, 'removed', true, 'before', v_before);
end; $function$;

-- seed_default_grants — specialist subject resolved from digital_employees.
CREATE OR REPLACE FUNCTION public.seed_default_grants(p_subject_kind text, p_subject_id uuid, p_domain text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_tenant uuid; v_label text; v_pairs text[][]; v_pair text[]; v_seeded integer := 0;
begin
  if p_subject_kind in ('de', 'specialist') then
    select tenant_id, name into v_tenant, v_label from digital_employees where id = p_subject_id;
  else
    return jsonb_build_object('ok', false, 'error', 'bad_subject_kind');
  end if;
  if v_tenant is null then return jsonb_build_object('ok', false, 'error', 'subject_not_found'); end if;

  v_pairs := case p_domain
    when 'support'   then array[['helpdesk','read'], ['knowledge_base','read'], ['product_system','read']]
    when 'technical' then array[['helpdesk','read'], ['knowledge_base','read'], ['product_system','read'], ['crm','read']]
    when 'sales'     then array[['crm','read'], ['knowledge_base','read']]
    when 'finance'   then array[['erp_financials','read'], ['billing','read'], ['crm','search']]
    else null end;
  if v_pairs is null then return jsonb_build_object('ok', false, 'error', 'unknown_domain', 'detail', 'domain must be one of: support, technical, sales, finance'); end if;

  foreach v_pair slice 1 in array v_pairs loop
    insert into data_access_grants (tenant_id, subject_kind, subject_id, resource_kind, resource_category, permission, granted_by, note)
    values (v_tenant, p_subject_kind, p_subject_id, 'category', v_pair[1], v_pair[2], null, 'seeded default (' || p_domain || ') — editable like any grant')
    on conflict (tenant_id, subject_kind, subject_id, resource_kind, coalesce(resource_id::text, resource_category)) do nothing;
    if found then v_seeded := v_seeded + 1; end if;
  end loop;

  begin
  perform append_audit_event(v_tenant, 'DreamTeam', 'system',
    'Default data-access grants seeded for ' || coalesce(v_label, 'subject') || ' (' || p_domain || ' domain): ' || v_seeded || ' category grant(s). No financial, billing or payroll access is ever granted by default.',
    'access_control', jsonb_build_object('kind', 'access_grant_changed', 'seeded', v_seeded, 'subject_kind', p_subject_kind, 'subject_id', p_subject_id, 'subject_label', v_label, 'domain', p_domain));
  exception when others then null; end;
  return jsonb_build_object('ok', true, 'seeded', v_seeded, 'domain', p_domain);
end; $function$;

-- set_doc_scope — specialist subject validated against digital_employees.
CREATE OR REPLACE FUNCTION public.set_doc_scope(p_doc_id uuid, p_subjects jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_user uuid := auth.uid(); v_caller_tenant uuid; v_is_active boolean; v_doc_tenant uuid; v_doc_title text; v_before text; v_after text;
  v_subj jsonb; v_kind text; v_sid uuid; v_label text; v_labels text[] := '{}'; v_count integer := 0;
begin
  select tenant_id, title, visibility into v_doc_tenant, v_doc_title, v_before from knowledge_docs where id = p_doc_id;
  if v_doc_tenant is null then return jsonb_build_object('ok', false, 'error', 'doc_not_found'); end if;

  if v_user is not null then
    select tenant_id, coalesce(is_active, true) into v_caller_tenant, v_is_active from profiles where user_id = v_user;
    if v_caller_tenant is null or v_caller_tenant <> v_doc_tenant then return jsonb_build_object('ok', false, 'error', 'not_tenant_member', 'detail', 'Only members of this workspace can change who uses a document.'); end if;
    if not v_is_active then return jsonb_build_object('ok', false, 'error', 'not_tenant_member', 'detail', 'Only members of this workspace can change who uses a document.'); end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    return jsonb_build_object('ok', false, 'error', 'not_tenant_member', 'detail', 'Only members of this workspace can change who uses a document.');
  end if;

  if p_subjects is null or jsonb_typeof(p_subjects) <> 'array' then return jsonb_build_object('ok', false, 'error', 'bad_subjects', 'detail', 'p_subjects must be a JSON array of {kind, id}.'); end if;

  for v_subj in select * from jsonb_array_elements(p_subjects) loop
    v_kind := v_subj->>'kind';
    begin v_sid := (v_subj->>'id')::uuid; exception when others then return jsonb_build_object('ok', false, 'error', 'bad_subject_id'); end;
    if v_kind in ('de', 'specialist') then
      select name into v_label from digital_employees where id = v_sid and tenant_id = v_doc_tenant;
    else
      return jsonb_build_object('ok', false, 'error', 'bad_subject_kind');
    end if;
    if v_label is null then return jsonb_build_object('ok', false, 'error', 'subject_not_in_tenant', 'detail', v_kind || ' ' || v_sid || ' is not in this workspace.'); end if;
    v_labels := array_append(v_labels, v_label || ' (' || v_kind || ')');
    v_count := v_count + 1;
  end loop;

  delete from knowledge_doc_scopes where doc_id = p_doc_id;
  for v_subj in select * from jsonb_array_elements(p_subjects) loop
    insert into knowledge_doc_scopes (tenant_id, doc_id, subject_kind, subject_id)
    values (v_doc_tenant, p_doc_id, v_subj->>'kind', (v_subj->>'id')::uuid)
    on conflict (doc_id, subject_kind, subject_id) do nothing;
  end loop;

  v_after := case when v_count > 0 then 'scoped' else 'tenant' end;
  update knowledge_docs set visibility = v_after where id = p_doc_id;

  begin
    perform append_audit_event(v_doc_tenant,
      coalesce((select full_name from profiles where user_id = v_user), 'service'),
      case when v_user is null then 'system' else 'human' end,
      'Knowledge scope changed — "' || v_doc_title || '": ' || v_before || ' → ' || v_after ||
        case when v_count > 0 then ' (only ' || array_to_string(v_labels, ', ') || ' will use this document)' else ' (all digital employees will use this document)' end,
      'access_control', jsonb_build_object('kind', 'knowledge_scope_changed', 'doc_id', p_doc_id, 'doc_title', v_doc_title, 'before', v_before, 'after', v_after, 'subjects', p_subjects, 'subject_labels', v_labels));
  exception when others then null; end;
  return jsonb_build_object('ok', true, 'visibility', v_after, 'subjects', v_count);
end; $function$;

-- poll_support_inbox_targets — subject name from digital_employees only.
CREATE OR REPLACE FUNCTION public.poll_support_inbox_targets(p_tenant_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(tenant_id uuid, connector_id uuid, connector_provider text, connector_display_name text, subject_kind text, subject_id uuid, subject_name text, last_seen_external_ref text, last_seen_timestamp timestamp with time zone)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
  select c.tenant_id, c.id, c.provider, c.display_name, g.subject_kind, g.subject_id,
    coalesce(de.name, 'DE'), w.last_seen_external_ref, w.last_seen_timestamp
  from connectors c
  join data_access_grants g on g.tenant_id = c.tenant_id
   and ((g.resource_kind = 'connector' and g.resource_id = c.id) or (g.resource_kind = 'category' and g.resource_category = c.category))
   and access_permission_level(g.permission) >= access_permission_level('search')
  left join digital_employees de on de.id = g.subject_id
  left join inbox_watch_state w on w.tenant_id = c.tenant_id and w.connector_id = c.id
  where c.category = 'helpdesk' and c.status <> 'disconnected'
    and (p_tenant_id is null or c.tenant_id = p_tenant_id)
    and is_feature_enabled_internal(c.tenant_id, 'proactive_triage');
$function$;

-- apply_entity_amendment — specialist amendment updates the DE charter (jsonb).
CREATE OR REPLACE FUNCTION public.apply_entity_amendment(p_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_am workforce_entity_amendments; v_cfg jsonb; begin
  select * into v_am from workforce_entity_amendments where id = p_id;
  if not found then raise exception 'amendment not found'; end if;
  if v_am.status = 'applied' then return jsonb_build_object('ok', true, 'already', true); end if;
  v_cfg := v_am.proposed_config;

  if v_am.entity_kind = 'de' then
    update digital_employees set
      persona_name = coalesce(v_cfg->>'persona_name', persona_name),
      description = coalesce(v_cfg->>'description', description),
      purpose_statement = coalesce(v_cfg->>'purpose_statement', purpose_statement)
    where id = v_am.entity_id and tenant_id = v_am.tenant_id;
  else
    -- specialist entities are digital_employees now; charter is jsonb {mission}
    update digital_employees
      set charter = jsonb_set(coalesce(charter, '{}'::jsonb), '{mission}', to_jsonb(coalesce(v_cfg->>'charter', charter->>'mission')))
      where id = v_am.entity_id and tenant_id = v_am.tenant_id and is_specialist = true;
  end if;

  update workforce_entity_amendments set status = 'applied' where id = p_id;
  begin perform append_audit_event(v_am.tenant_id, 'Practice Engine', 'de',
      format('%s amendment applied — improved config landed', v_am.entity_kind),
      'config_change', jsonb_build_object('kind','entity_amendment_applied','amendment_id',p_id,'entity_kind',v_am.entity_kind,'entity_id',v_am.entity_id));
  exception when others then null; end;
  return jsonb_build_object('ok', true, 'entity_id', v_am.entity_id);
end; $function$;

-- set_access_grant — specialist subject resolved from digital_employees.
CREATE OR REPLACE FUNCTION public.set_access_grant(p_subject_kind text, p_subject_id uuid, p_resource_kind text, p_resource_id uuid, p_resource_category text, p_permission text, p_note text DEFAULT ''::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_tenant uuid; v_user uuid := auth.uid(); v_role text; v_is_active boolean; v_before text; v_grant_id uuid; v_subject_label text; v_resource_label text;
begin
  if v_user is not null then
    select tenant_id, role, coalesce(is_active, true) into v_tenant, v_role, v_is_active from profiles where user_id = v_user;
    if v_tenant is null then return jsonb_build_object('ok', false, 'error', 'no_tenant'); end if;
    if not v_is_active then return jsonb_build_object('ok', false, 'error', 'admin_role_required', 'detail', 'Only workspace owners/admins can change data access rules.'); end if;
    if v_role not in ('tenant_owner', 'tenant_admin') then return jsonb_build_object('ok', false, 'error', 'admin_role_required', 'detail', 'Only workspace owners/admins can change data access rules.'); end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    return jsonb_build_object('ok', false, 'error', 'admin_role_required', 'detail', 'Only workspace owners/admins can change data access rules.');
  else
    select tenant_id into v_tenant from digital_employees where id = p_subject_id;
    if v_tenant is null then return jsonb_build_object('ok', false, 'error', 'subject_not_found'); end if;
  end if;

  if p_subject_kind in ('de', 'specialist') then
    select name into v_subject_label from digital_employees where id = p_subject_id and tenant_id = v_tenant;
  else
    return jsonb_build_object('ok', false, 'error', 'bad_subject_kind');
  end if;
  if v_subject_label is null then return jsonb_build_object('ok', false, 'error', 'subject_not_in_tenant'); end if;

  if p_resource_kind = 'connector' then
    select display_name into v_resource_label from connectors where id = p_resource_id and tenant_id = v_tenant;
    if v_resource_label is null then return jsonb_build_object('ok', false, 'error', 'connector_not_in_tenant'); end if;
  elsif p_resource_kind = 'category' then
    v_resource_label := 'all ' || p_resource_category || ' systems';
  else
    return jsonb_build_object('ok', false, 'error', 'bad_resource_kind');
  end if;

  if access_permission_level(p_permission) = 0 then return jsonb_build_object('ok', false, 'error', 'bad_permission'); end if;

  select permission into v_before from data_access_grants
   where tenant_id = v_tenant and subject_kind = p_subject_kind and subject_id = p_subject_id and resource_kind = p_resource_kind
     and coalesce(resource_id::text, resource_category) = coalesce(p_resource_id::text, p_resource_category);

  insert into data_access_grants (tenant_id, subject_kind, subject_id, resource_kind, resource_id, resource_category, permission, granted_by, note)
  values (v_tenant, p_subject_kind, p_subject_id, p_resource_kind,
     case when p_resource_kind = 'connector' then p_resource_id else null end,
     case when p_resource_kind = 'category' then p_resource_category else null end,
     p_permission, v_user, coalesce(p_note, ''))
  on conflict (tenant_id, subject_kind, subject_id, resource_kind, coalesce(resource_id::text, resource_category))
  do update set permission = excluded.permission, granted_by = excluded.granted_by, note = excluded.note, updated_at = now()
  returning id into v_grant_id;

  perform append_audit_event(v_tenant,
    coalesce((select full_name from profiles where user_id = v_user), 'service'),
    case when v_user is null then 'system' else 'human' end,
    'Data access grant changed — ' || v_subject_label || ' on ' || v_resource_label || ': ' || coalesce(v_before, 'none') || ' → ' || p_permission ||
      case when coalesce(p_note, '') <> '' then ' (' || p_note || ')' else '' end,
    'access_control', jsonb_build_object('kind', 'access_grant_changed', 'grant_id', v_grant_id, 'subject_kind', p_subject_kind, 'subject_id', p_subject_id, 'subject_label', v_subject_label,
      'resource_kind', p_resource_kind, 'resource_id', p_resource_id, 'resource_category', p_resource_category, 'resource_label', v_resource_label, 'before', v_before, 'after', p_permission));
  return jsonb_build_object('ok', true, 'grant_id', v_grant_id, 'before', v_before, 'after', p_permission);
end; $function$;

-- get_identity_inventory — is_specialist DEs surface as subject_kind='specialist'
-- (no more specialist_profiles union; digital_employees is the sole source).
CREATE OR REPLACE FUNCTION public.get_identity_inventory(p_tenant_id uuid)
 RETURNS TABLE(subject_kind text, subject_id uuid, subject_name text, subject_label text, subject_role text, subject_status text, connector_id uuid, connector_name text, connector_provider text, connector_category text, connector_status text, connector_last_ok_at timestamp with time zone, connector_last_error_at timestamp with time zone, connector_consecutive_failures integer, has_stored_credential boolean, permission text, permission_via text, trust_current_level integer, trust_target_level integer, autonomy_enabled boolean, possible_actions jsonb)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_caller_tenant uuid; v_is_service boolean := coalesce(auth.role(), '') = 'service_role'; v_is_active boolean;
begin
  if not v_is_service then
    select coalesce(is_active, true) into v_is_active from profiles where user_id = auth.uid();
    if v_is_active is false then raise exception 'account is deactivated'; end if;
    v_caller_tenant := auth_tenant_id();
    if v_caller_tenant is null then raise exception 'not authenticated or no tenant membership'; end if;
    if v_caller_tenant is distinct from p_tenant_id then raise exception 'not a member of this tenant'; end if;
  end if;
  if not is_feature_enabled_internal(p_tenant_id, 'identity_credential_inventory') then return; end if;

  return query
  with subjects as (
    select case when d.is_specialist then 'specialist' else 'de' end as subject_kind, d.id as subject_id, d.name as subject_name,
           coalesce(d.persona_name, d.name) as subject_label,
           case when d.is_specialist then coalesce(d.specialist_key, 'specialist') else coalesce(nullif(d.department, ''), d.category) end as subject_role,
           d.status as subject_status
    from digital_employees d where d.tenant_id = p_tenant_id
  ),
  grants_resolved as (
    select g.subject_kind, g.subject_id, c.id as connector_id, g.permission, 'category'::text as via, g.resource_category as eff_category
    from data_access_grants g join connectors c on c.tenant_id = g.tenant_id and c.category = g.resource_category
    where g.tenant_id = p_tenant_id and g.resource_kind = 'category'
    union all
    select g.subject_kind, g.subject_id, g.resource_id as connector_id, g.permission, 'connector'::text as via, c.category as eff_category
    from data_access_grants g join connectors c on c.id = g.resource_id and c.tenant_id = p_tenant_id
    where g.tenant_id = p_tenant_id and g.resource_kind = 'connector'
  ),
  grants_final as (
    select distinct on (gr.subject_kind, gr.subject_id, gr.connector_id) gr.subject_kind, gr.subject_id, gr.connector_id, gr.permission, gr.via, gr.eff_category
    from grants_resolved gr order by gr.subject_kind, gr.subject_id, gr.connector_id, (gr.via = 'connector') desc
  ),
  secrets as (select cs.connector_id as secret_connector_id, true as has_secret from connector_secrets cs),
  trust as (select tp.de_id, tp.source_category, tp.current_level, tp.target_level from trust_policies tp where tp.tenant_id = p_tenant_id and tp.action_category = 'action_execute'),
  autonomy as (select da.source_category, da.enabled from de_autonomy da where da.tenant_id = p_tenant_id and da.action_type = 'action_execute'),
  actions_by_category as (
    select ad.category, jsonb_agg(jsonb_build_object('action_key', ad.action_key, 'label', ad.label, 'destructive', coalesce((ad.risk->>'destructive')::boolean, true)) order by ad.label) as actions
    from action_definitions ad where ad.status = 'active' and (ad.scope = 'platform' or ad.tenant_id = p_tenant_id) group by ad.category
  )
  select s.subject_kind, s.subject_id, s.subject_name, s.subject_label, s.subject_role, s.subject_status,
    c.id, c.display_name, c.provider, c.category, c.status, c.last_ok_at, c.last_error_at, c.consecutive_failures,
    coalesce(sec.has_secret, false), gf.permission, gf.via,
    coalesce((select tr.current_level from trust tr where tr.de_id = s.subject_id and tr.source_category = c.category),
             (select tr.current_level from trust tr where tr.de_id = s.subject_id and tr.source_category is null)),
    coalesce((select tr.target_level from trust tr where tr.de_id = s.subject_id and tr.source_category = c.category),
             (select tr.target_level from trust tr where tr.de_id = s.subject_id and tr.source_category is null)),
    coalesce((select au.enabled from autonomy au where au.source_category = c.category), (select au.enabled from autonomy au where au.source_category is null)),
    coalesce(abc.actions, '[]'::jsonb)
  from subjects s
  left join grants_final gf on gf.subject_kind = s.subject_kind and gf.subject_id = s.subject_id
  left join connectors c on c.id = gf.connector_id
  left join secrets sec on sec.secret_connector_id = c.id
  left join actions_by_category abc on abc.category = c.category
  order by s.subject_kind, s.subject_name, c.category, c.display_name;
end; $function$;

-- set_specialist_source_secret — membership via specialist_de_id → digital_employees.
CREATE OR REPLACE FUNCTION public.set_specialist_source_secret(p_source_id uuid, p_secret text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_existing uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not exists (
    select 1 from specialist_sources s
    join digital_employees d on d.id = s.specialist_de_id
    join profiles p on p.tenant_id = d.tenant_id
    where s.id = p_source_id and p.user_id = auth.uid() and coalesce(p.is_active, true) = true
  ) then
    raise exception 'not a member of this source''s tenant';
  end if;

  select secret_id into v_existing from specialist_source_secrets where source_id = p_source_id;
  if v_existing is not null then
    perform vault.update_secret(v_existing, p_secret);
    update specialist_source_secrets set updated_at = now() where source_id = p_source_id;
  else
    insert into specialist_source_secrets (source_id, secret_id, updated_at)
    values (p_source_id, vault.create_secret(p_secret, 'specialist_source_secret:' || p_source_id, 'Set via set_specialist_source_secret'), now());
  end if;
end; $function$;

-- list_de_specialists — via specialist_de_id → digital_employees.
CREATE OR REPLACE FUNCTION public.list_de_specialists(p_de_id uuid)
 RETURNS TABLE(rank smallint, specialist_id uuid, specialist_key text, specialist_name text, specialist_status text)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
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
  order by a.rank;
end; $function$;

-- resolve_de_specialist_internal — via specialist_de_id → digital_employees.
CREATE OR REPLACE FUNCTION public.resolve_de_specialist_internal(p_tenant_id uuid, p_de_id uuid)
 RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select d.specialist_key
  from de_specialist_assignments a
  join digital_employees d on d.id = a.specialist_de_id
  where a.tenant_id = p_tenant_id and a.de_id = p_de_id and d.status = 'active'
  order by a.rank limit 1;
$function$;

-- set_de_specialist — assign an is_specialist DE as a DE's specialist (writes specialist_de_id).
CREATE OR REPLACE FUNCTION public.set_de_specialist(p_de_id uuid, p_rank smallint, p_specialist_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_tenant uuid; v_de digital_employees; v_sp digital_employees;
begin
  if p_rank not in (1, 2) then raise exception 'rank must be 1 (primary) or 2 (secondary)'; end if;
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then raise exception 'only workspace owners/admins can assign specialists'; end if;

  select * into v_de from digital_employees where id = p_de_id and tenant_id = v_tenant;
  if v_de.id is null then raise exception 'employee not found in this workspace'; end if;

  if p_specialist_id is null then
    delete from de_specialist_assignments where tenant_id = v_tenant and de_id = p_de_id and rank = p_rank;
    perform append_audit_event_internal(v_tenant, 'You', 'human',
      format('%s''s %s specialist cleared', v_de.name, case when p_rank = 1 then 'primary' else 'secondary' end),
      'config_change', jsonb_build_object('kind', 'de_specialist_cleared', 'de_id', p_de_id, 'rank', p_rank));
    return jsonb_build_object('ok', true, 'cleared', true);
  end if;

  select * into v_sp from digital_employees where id = p_specialist_id and tenant_id = v_tenant and is_specialist = true;
  if v_sp.id is null then raise exception 'specialist not found in this workspace'; end if;

  delete from de_specialist_assignments where tenant_id = v_tenant and de_id = p_de_id and specialist_de_id = p_specialist_id and rank <> p_rank;

  insert into de_specialist_assignments (tenant_id, de_id, specialist_de_id, rank, created_by)
  values (v_tenant, p_de_id, p_specialist_id, p_rank, auth.uid())
  on conflict (tenant_id, de_id, rank)
  do update set specialist_de_id = excluded.specialist_de_id, created_by = excluded.created_by, created_at = now();

  perform append_audit_event_internal(v_tenant, 'You', 'human',
    format('%s assigned as %s''s %s specialist', coalesce(v_sp.persona_name, v_sp.name), v_de.name, case when p_rank = 1 then 'primary' else 'secondary' end),
    'config_change', jsonb_build_object('kind', 'de_specialist_assigned', 'de_id', p_de_id, 'specialist_de_id', p_specialist_id, 'rank', p_rank));
  return jsonb_build_object('ok', true, 'specialist', coalesce(v_sp.persona_name, v_sp.name), 'rank', p_rank);
end; $function$;

-- provision_tenant_baseline_internal — seeds a Technical Specialist DE (not a profile).
CREATE OR REPLACE FUNCTION public.provision_tenant_baseline_internal(p_tenant_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
declare v_demo_tenant_id constant uuid := 'a0000000-0000-0000-0000-000000000001';
  v_tpl_id uuid; v_seeded_guardrails int := 0; v_seeded_template boolean := false; v_seeded_specialist boolean := false;
begin
  if p_tenant_id is null or p_tenant_id = v_demo_tenant_id then return jsonb_build_object('ok', false, 'error', 'refusing to provision null or the demo tenant'); end if;
  if not exists (select 1 from tenants where id = p_tenant_id) then return jsonb_build_object('ok', false, 'error', 'tenant not found'); end if;

  perform reconcile_tenant_feature(p_tenant_id, fr.key, true) from feature_registry fr where fr.default_enabled = true;

  insert into guardrail_rules (tenant_id, rule, rule_type, pattern, severity, applies_to, active)
  select p_tenant_id, r.rule, r.rule_type, r.pattern, r.severity, 'all', true
  from (values
    ('Explicit escalation demand', 'frustration_signal', 'speak to a manager|speak with a manager|this is unacceptable|totally unacceptable', 'warning'),
    ('Repeated-contact frustration', 'frustration_signal', 'third time i|already told you|i''ve asked this before|keep asking', 'warning'),
    ('Churn/cancellation threat', 'frustration_signal', 'cancel(l)?ing my (subscription|account|plan)|switching to a competitor|find another (provider|vendor)', 'warning'),
    ('Strong negative sentiment', 'frustration_signal', 'worst support|completely useless|waste of (my )?time|ridiculous that', 'warning'),
    ('No unilateral refund promises', 'blocked_phrase', 'refund', 'blocking'),
    ('No legal-threat language in outputs — route to a human', 'blocked_phrase', 'legal action|lawsuit|sue you|attorney|court|legally liable|garnish|seize your assets', 'blocking')
  ) as r(rule, rule_type, pattern, severity)
  where not exists (select 1 from guardrail_rules g where g.tenant_id = p_tenant_id and g.rule = r.rule);
  get diagnostics v_seeded_guardrails = row_count;

  if not exists (select 1 from guardrail_rules g where g.tenant_id = p_tenant_id and g.rule_type = 'require_approval_over_cents') then
    insert into guardrail_rules (tenant_id, rule, rule_type, threshold, severity, applies_to, active)
    values (p_tenant_id, 'Actions over $10,000 always require human approval', 'require_approval_over_cents', 1000000, 'blocking', 'all', true);
    v_seeded_guardrails := v_seeded_guardrails + 1;
  end if;

  if not exists (select 1 from onboarding_templates t where t.tenant_id = p_tenant_id and t.name = 'SaaS onboarding — starter') then
    insert into onboarding_templates (tenant_id, name, description, items)
    values (p_tenant_id, 'SaaS onboarding — starter',
      '10-step implementation checklist: kickoff → data → config → validation → go-live. Sign-off gates on settings, leave rules, UAT, and go-live.',
      '[{"key":"kickoff_call","label":"Kickoff call held","phase":"kickoff","owner_type":"human","requires_signoff":false,"description":"Intro call: goals, timeline, points of contact."},{"key":"data_export_received","label":"Data export received from customer","phase":"data","owner_type":"either","requires_signoff":false,"description":"Customer sends their employee/location export (CSV or spreadsheet)."},{"key":"employees_imported","label":"Employees imported","phase":"data","owner_type":"de","requires_signoff":false,"description":"Employee records loaded and normalized in the platform."},{"key":"locations_configured","label":"Locations configured","phase":"config","owner_type":"de","requires_signoff":false,"description":"Sites, time zones, and operating hours set up."},{"key":"settings_review","label":"Account settings reviewed","phase":"config","owner_type":"human","requires_signoff":true,"description":"Human sign-off on core account configuration."},{"key":"leave_rules_configured","label":"Leave rules configured","phase":"config","owner_type":"either","requires_signoff":true,"description":"Accrual, carryover, and approval chains — needs human sign-off."},{"key":"test_scenario_run","label":"Test scenario run","phase":"validation","owner_type":"de","requires_signoff":false,"description":"End-to-end test with sample data."},{"key":"uat_approved","label":"UAT approved by customer","phase":"validation","owner_type":"human","requires_signoff":true,"description":"Customer confirms acceptance testing passed."},{"key":"training_session","label":"Training session delivered","phase":"golive","owner_type":"human","requires_signoff":false,"description":"Admin + end-user training completed."},{"key":"go_live","label":"Go-live","phase":"golive","owner_type":"human","requires_signoff":true,"description":"Production cutover — final human sign-off."}]'::jsonb)
    returning id into v_tpl_id;
    insert into onboarding_template_versions (template_id, tenant_id, version, name, description, items, published_by)
    select v_tpl_id, p_tenant_id, 1, t.name, t.description, t.items, null from onboarding_templates t where t.id = v_tpl_id;
    update onboarding_templates set version = 1, status = 'published' where id = v_tpl_id;
    v_seeded_template := true;
  end if;

  -- Starter Technical Specialist — now a Digital Employee (is_specialist).
  if not exists (select 1 from digital_employees d where d.tenant_id = p_tenant_id and d.is_specialist = true and d.specialist_key = 'technical') then
    insert into digital_employees (tenant_id, name, persona_name, category, is_specialist, specialist_key, description, charter, lifecycle_status, status)
    values (p_tenant_id, 'Technical Specialist', 'Technical Specialist', 'Internal', true, 'technical',
      'Read-only consult desk for deep technical questions.',
      jsonb_build_object('mission', 'Answer only from configured sources; cite everything; escalate when unsure.'), 'active', 'active');
    v_seeded_specialist := true;
  end if;

  if v_seeded_guardrails > 0 or v_seeded_template or v_seeded_specialist then
    perform append_audit_event_internal(p_tenant_id, 'DreamTeam', 'system',
      format('Workspace baseline provisioned — %s starter guardrail(s)%s%s. Connectors are the remaining setup step (they need your own system credentials).',
        v_seeded_guardrails, case when v_seeded_template then ', starter onboarding template' else '' end, case when v_seeded_specialist then ', Technical Specialist' else '' end),
      'config_change', jsonb_build_object('kind', 'tenant_baseline_provisioned', 'guardrails_seeded', v_seeded_guardrails, 'template_seeded', v_seeded_template, 'specialist_seeded', v_seeded_specialist));
  end if;
  return jsonb_build_object('ok', true, 'guardrails_seeded', v_seeded_guardrails, 'template_seeded', v_seeded_template, 'specialist_seeded', v_seeded_specialist);
end; $function$;

-- audit_tenant_provisioning — count is_specialist DEs, not specialist_profiles.
CREATE OR REPLACE FUNCTION public.audit_tenant_provisioning()
 RETURNS TABLE(tenant_id uuid, tenant_name text, tenant_status text, des bigint, playbooks bigint, guardrails bigint, onboarding_templates bigint, specialists bigint, trust_policies bigint, autonomy_rows bigint, connectors bigint, baseline_complete boolean)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  if not resolve_platform_capability(auth.uid(), 'tenants.manage') then raise exception 'only a platform team member with tenant management access may audit tenant provisioning'; end if;
  return query
  select t.id, t.name, t.status,
    (select count(*) from digital_employees d where d.tenant_id = t.id and d.lifecycle_status <> 'retired' and not d.is_specialist),
    (select count(*) from playbook_definitions p where p.tenant_id = t.id),
    (select count(*) from guardrail_rules g where g.tenant_id = t.id and g.active),
    (select count(*) from onboarding_template_versions v where v.tenant_id = t.id),
    (select count(*) from digital_employees d where d.tenant_id = t.id and d.is_specialist = true and d.status = 'active'),
    (select count(*) from trust_policies tp where tp.tenant_id = t.id),
    (select count(*) from de_autonomy da where da.tenant_id = t.id),
    (select count(*) from connectors c where c.tenant_id = t.id),
    (select count(*) from digital_employees d where d.tenant_id = t.id and d.lifecycle_status <> 'retired' and not d.is_specialist) >= 2
      and (select count(*) from playbook_definitions p where p.tenant_id = t.id) >= 2
      and (select count(*) from guardrail_rules g where g.tenant_id = t.id and g.active) >= 7
      and (select count(*) from onboarding_template_versions v where v.tenant_id = t.id) >= 1
  from tenants t
  where t.id <> 'a0000000-0000-0000-0000-000000000001' and t.name not like '[TEST DEBRIS%'
  order by t.created_at desc;
end; $function$;

-- poll_de_work_sources_targets — subject name + specialist detection from digital_employees.
CREATE OR REPLACE FUNCTION public.poll_de_work_sources_targets(p_tenant_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(tenant_id uuid, connector_id uuid, connector_provider text, connector_display_name text, category text, subject_kind text, subject_id uuid, subject_name text, last_seen_external_ref text, last_seen_timestamp timestamp with time zone)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select c.tenant_id, c.id, c.provider, c.display_name, c.category, g.subject_kind, g.subject_id,
    coalesce(sub.name, 'DE'), w.last_seen_external_ref, w.last_seen_timestamp
  from connectors c
  join data_access_grants g on g.tenant_id = c.tenant_id
   and ((g.resource_kind = 'connector' and g.resource_id = c.id) or (g.resource_kind = 'category' and g.resource_category = c.category))
   and access_permission_level(g.permission) >= access_permission_level('search')
  left join digital_employees sub on sub.id = g.subject_id
  left join digital_employees de on de.id = g.subject_id and g.subject_kind = 'de'
  left join inbox_watch_state w on w.tenant_id = c.tenant_id and w.connector_id = c.id
  where c.status <> 'disconnected'
    and (p_tenant_id is null or c.tenant_id = p_tenant_id)
    and (g.subject_kind <> 'de'
         or (de.lifecycle_status in ('assigned', 'active', 'improving') and de.status = 'active' and de_is_available(de.availability)))
    and not (
      g.subject_kind = 'de'
      and exists (
        select 1 from workforce_team_members me
        join workforce_teams t on t.id = me.team_id and t.status = 'active'
        join workforce_team_members peer on peer.team_id = me.team_id and peer.fallback_rank < me.fallback_rank
        join digital_employees pde on pde.id = peer.de_id
        where me.de_id = g.subject_id and t.tenant_id = c.tenant_id
          and pde.lifecycle_status in ('assigned', 'active', 'improving') and pde.status = 'active' and de_is_available(pde.availability)
          and exists (select 1 from data_access_grants pg where pg.tenant_id = c.tenant_id and pg.subject_kind = 'de' and pg.subject_id = pde.id
              and ((pg.resource_kind = 'connector' and pg.resource_id = c.id) or (pg.resource_kind = 'category' and pg.resource_category = c.category))
              and access_permission_level(pg.permission) >= access_permission_level('search'))
      )
    )
    and not (
      g.subject_kind = 'specialist'
      and exists (
        select 1 from data_access_grants g2 join digital_employees de2 on de2.id = g2.subject_id
        where g2.tenant_id = c.tenant_id and g2.subject_kind = 'de'
          and de2.lifecycle_status in ('assigned', 'active', 'improving') and de2.status = 'active' and de_is_available(de2.availability)
          and ((g2.resource_kind = 'connector' and g2.resource_id = c.id) or (g2.resource_kind = 'category' and g2.resource_category = c.category))
          and access_permission_level(g2.permission) >= access_permission_level('search')
      )
    );
$function$;
